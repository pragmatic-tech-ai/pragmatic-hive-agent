import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    AgentChannelFailure, AgentChannelUnavailableError, AgentExchangeRefusal, ComponentState, ConsoleAddress, EnvironmentReadiness, HiveEnrolmentRefusal, HiveLevel,
    MessageKind, Participant, SignedEnvelope, SigningKeyPair, type HiveReport, type IAgentChannel,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeAgentChannel, FakeClock, FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import type { IServerDeployment } from '../../k8s-api.js'
import { KubeConfigMap, KubeWorkloadKind } from '../../kube/hive-kube.js'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import { EnrolmentState, EnrolmentStateUnreadableError } from '../enrolment-state.js'
import { HiveEnrolment, HiveEnrolmentRefusedError } from '../hive-enrolment.js'
import { HiveReporter, ReportedWorkload } from '../hive-reporter.js'

/** A channel that refuses every message with the platform's code (as HttpAgentChannel raises it). */
class RefusingChannel implements IAgentChannel
{
    public constructor(private readonly code: AgentExchangeRefusal | null, private readonly status: number = 403)
    {
    }

    public Exchange(_request: SignedEnvelope): Promise<SignedEnvelope | null>
    {
        return Promise.reject(new AgentChannelUnavailableError(AgentChannelFailure.Refused, this.status, this.code))
    }
}

class FixedEnvironments
{
    public constructor(private readonly items: IServerDeployment[])
    {
    }

    public async ListServerDeployments(): Promise<ReadonlyArray<IServerDeployment>>
    {
        return this.items
    }
}

class EnrolmentWorld
{
    public static readonly Namespace = 'pragmatic-system'
    public static readonly Tenant = 'acme'
    public static readonly Version = '0.1.0-early.18'
    public static readonly Address = ConsoleAddress.OwnDomain('console.acme.example')

    public readonly Clock = new FakeClock()
    public readonly Platform = new FakePlatform(this.Clock)
    public readonly Channel = new FakeAgentChannel(this.Platform)
    public readonly Kube = new FakeHiveKube()
    public readonly State = new EnrolmentState(this.Kube, EnrolmentWorld.Namespace, this.Platform.TrustRoot)
    public readonly Key = SigningKeyPair.Generate()

    public Enrolment(channel: IAgentChannel = this.Channel, pinned = this.Platform.TrustRoot): HiveEnrolment
    {
        return new HiveEnrolment({ Key: this.Key, Channel: channel, State: this.State, PinnedTrustRoot: pinned, Tenant: EnrolmentWorld.Tenant, EngineVersion: EnrolmentWorld.Version, Clock: this.Clock })
    }

    public Code(level: HiveLevel = HiveLevel.Enrolled): string
    {
        return this.Platform.IssueHiveCode(EnrolmentWorld.Tenant, level)
    }

    public static async CodeOf(work: Promise<unknown>): Promise<HiveEnrolmentRefusal>
    {
        try
        {
            await work
        }
        catch (error)
        {
            if (error instanceof HiveEnrolmentRefusedError)
            {
                return error.Code
            }
            throw error
        }
        throw new Error('expected a refusal')
    }
}

describe('HiveEnrolment', () =>
{
    it('enrolment against FakePlatform stores the state and the agent reports next tick', async () =>
    {
        const world = new EnrolmentWorld()
        const enrolment = world.Enrolment()
        const record = await enrolment.Enrol({ Code: world.Code(HiveLevel.Delegated), Level: HiveLevel.Delegated, ConsoleAddress: EnrolmentWorld.Address })
        assert.equal(record.Level, HiveLevel.Delegated)
        assert.equal(record.Tenant, EnrolmentWorld.Tenant)
        assert.ok(record.TrustRoot.Equals(world.Platform.TrustRoot))
        const stored = await world.State.Read()
        assert.equal(stored?.HiveId, record.HiveId)
        assert.equal(stored?.ChannelUrl, world.Platform.ChannelUrl)
        assert.equal(world.Platform.Record(Participant.Hive(record.HiveId))?.PublicKey.KeyId, world.Key.KeyId)
        assert.equal((await enrolment.WhenEnrolled()).HiveId, record.HiveId)
        const workload = new ReportedWorkload('pragmatic-tenant-admin', EnrolmentWorld.Namespace, KubeWorkloadKind.Deployment, 'pragmatic-tenant-admin-acme')
        world.Kube.Workloads.set(FakeHiveKube.Key(EnrolmentWorld.Namespace, KubeWorkloadKind.Deployment + '/pragmatic-tenant-admin-acme'), true)
        const reporter = new HiveReporter({
            Key: world.Key, Enrolment: record, Channel: world.Channel, Kube: world.Kube, InstallHive: 'acme-hive', EngineVersion: EnrolmentWorld.Version, Workloads: [workload],
            Environments: new FixedEnvironments([{ namespace: 'pragmatic-env-dev-one', deployment: 'server', container: 'server', runningImage: 'ghcr.io/x/env-server:0.1.4@sha256:abc', ready: true }]),
            Log: { Failed: () => undefined }, Clock: world.Clock,
        })
        await reporter.Tick()
        const reports = world.Platform.ReceivedOf<HiveReport>(MessageKind.HiveReport)
        assert.equal(reports.length, 1)
        assert.deepEqual(reports[0]!.Components.map(component => [component.Component, component.State, component.Version]), [['pragmatic-hive-agent', ComponentState.Ready, EnrolmentWorld.Version], ['pragmatic-tenant-admin', ComponentState.Ready, null]])
        assert.deepEqual(reports[0]!.Environments.map(environment => [environment.Name, environment.Readiness, environment.Version]), [['dev-one', EnvironmentReadiness.Ready, '0.1.4']])
    })

    it('a response signed by a foreign trust root is refused and nothing is stored', async () =>
    {
        const world = new EnrolmentWorld()
        const enrolment = world.Enrolment(world.Channel, SigningKeyPair.Generate().PublicKey)
        assert.equal(await EnrolmentWorld.CodeOf(enrolment.Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })), HiveEnrolmentRefusal.TrustRootMismatch)
        assert.equal(await world.State.Read(), undefined)
        assert.equal(enrolment.Enrolled, undefined)
    })

    it('a tampered response is refused and nothing is stored', async () =>
    {
        const world = new EnrolmentWorld()
        const tampering: IAgentChannel = {
            Exchange: async request =>
            {
                const reply = await world.Channel.Exchange(request)
                const json = JSON.parse(reply!.Encode()) as { Body: { HiveId: string } }
                json.Body.HiveId = 'hvzzzzzzzzzz'
                return SignedEnvelope.Decode(JSON.stringify(json))
            },
        }
        assert.equal(await EnrolmentWorld.CodeOf(world.Enrolment(tampering).Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })), HiveEnrolmentRefusal.Unavailable)
        assert.equal(await world.State.Read(), undefined)
    })

    it('a second connect while one is in flight is unavailable, not already-enrolled', async () =>
    {
        const world = new EnrolmentWorld()
        let release: () => void = () => undefined
        const slow: IAgentChannel = { Exchange: async request => { await new Promise<void>(resolve => { release = resolve }); return world.Channel.Exchange(request) } }
        const enrolment = world.Enrolment(slow)
        const first = enrolment.Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })
        assert.equal(await EnrolmentWorld.CodeOf(enrolment.Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })), HiveEnrolmentRefusal.Unavailable)
        release()
        await first
        assert.ok(enrolment.Enrolled !== undefined)
    })

    it('the pinned trust root always wins: a rotation by chart upgrade is adopted, an edited root never trusted', async () =>
    {
        const world = new EnrolmentWorld()
        const record = await world.Enrolment().Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })
        const rotated = SigningKeyPair.Generate().PublicKey
        const upgraded = await new EnrolmentState(world.Kube, EnrolmentWorld.Namespace, rotated).Read()
        assert.equal(upgraded?.HiveId, record.HiveId, 'still enrolled as the same hive')
        assert.ok(upgraded?.TrustRoot.Equals(rotated))
        const stored = world.Kube.ConfigMaps.get(FakeHiveKube.Key(EnrolmentWorld.Namespace, EnrolmentState.ConfigMapName))!
        assert.equal(stored.Data.trustRootKeyId, rotated.KeyId, 'the new root is kept')
        const foreign = SigningKeyPair.Generate().PublicKey
        world.Kube.ConfigMaps.set(FakeHiveKube.Key(EnrolmentWorld.Namespace, EnrolmentState.ConfigMapName), new KubeConfigMap({ ...stored.Data, trustRoot: foreign.ToJson(), trustRootKeyId: foreign.KeyId }, stored.ResourceVersion))
        assert.ok((await world.State.Read())?.TrustRoot.Equals(world.Platform.TrustRoot), 'an edited root is replaced by the pinned one')
        const broken = world.Kube.ConfigMaps.get(FakeHiveKube.Key(EnrolmentWorld.Namespace, EnrolmentState.ConfigMapName))!
        world.Kube.ConfigMaps.set(FakeHiveKube.Key(EnrolmentWorld.Namespace, EnrolmentState.ConfigMapName), new KubeConfigMap({ ...broken.Data, trustRootKeyId: 'not-its-id' }, broken.ResourceVersion))
        await assert.rejects(world.State.Read(), EnrolmentStateUnreadableError)
    })

    it('already enrolled → already-enrolled', async () =>
    {
        const world = new EnrolmentWorld()
        const enrolment = world.Enrolment()
        await enrolment.Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })
        assert.equal(await EnrolmentWorld.CodeOf(enrolment.Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })), HiveEnrolmentRefusal.AlreadyEnrolled)
        const restarted = world.Enrolment()
        const again = new HiveEnrolment({ Key: world.Key, Channel: world.Channel, State: world.State, PinnedTrustRoot: world.Platform.TrustRoot, Tenant: EnrolmentWorld.Tenant, EngineVersion: EnrolmentWorld.Version }, await world.State.Read())
        assert.equal(restarted.Enrolled, undefined)
        assert.equal(await EnrolmentWorld.CodeOf(again.Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })), HiveEnrolmentRefusal.AlreadyEnrolled)
        assert.equal(world.Platform.ReceivedOf(MessageKind.HiveEnrolmentRequest).length, 1)
    })

    it('the platform\'s refusal codes map to the console\'s; anything else is unavailable', async () =>
    {
        const world = new EnrolmentWorld()
        const cases: [AgentExchangeRefusal | null, HiveEnrolmentRefusal][] = [
            [AgentExchangeRefusal.InvalidCode, HiveEnrolmentRefusal.InvalidCode],
            [AgentExchangeRefusal.Mismatch, HiveEnrolmentRefusal.Mismatch],
            [AgentExchangeRefusal.KeyRegistered, HiveEnrolmentRefusal.KeyRegistered],
            [AgentExchangeRefusal.Replayed, HiveEnrolmentRefusal.Unavailable],
            [null, HiveEnrolmentRefusal.Unavailable],
        ]
        for (const [platform, expected] of cases)
        {
            const enrolment = world.Enrolment(new RefusingChannel(platform))
            assert.equal(await EnrolmentWorld.CodeOf(enrolment.Enrol({ Code: world.Code(), Level: HiveLevel.Enrolled, ConsoleAddress: EnrolmentWorld.Address })), expected)
        }
        assert.equal(await world.State.Read(), undefined)
    })
})
