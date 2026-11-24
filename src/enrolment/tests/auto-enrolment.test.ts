import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    AgentChannelFailure, AgentChannelUnavailableError, AgentExchangeRefusal, ConsoleAddress, HiveLevel, Participant, SigningKeyPair,
    type IAgentChannel, type SignedEnvelope,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeAgentChannel, FakeClock, FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import type { ITickDelay } from '../../tick-loop.js'
import { AutoEnrolment, AutoEnrolmentOutcome, EnrolmentCodeSecretUnusableError, type IAutoEnrolmentLog } from '../auto-enrolment.js'
import { EnrolmentState } from '../enrolment-state.js'
import { HiveEnrolment } from '../hive-enrolment.js'

/** Records the events and failures, never a code. */
class RecordingLog implements IAutoEnrolmentLog
{
    public readonly Events: string[] = []
    public readonly Failures: number[] = []

    public Event(event: string, code?: string): void
    {
        this.Events.push(code === undefined ? event : event + ':' + code)
    }

    public Failed(_error: unknown, backoffMs: number): void
    {
        this.Failures.push(backoffMs)
    }
}

/** A channel that refuses with a platform code, or is unreachable (null code), counting the calls. */
class RefusingChannel implements IAgentChannel
{
    public Calls = 0

    public constructor(private readonly code: AgentExchangeRefusal | null)
    {
    }

    public Exchange(_request: SignedEnvelope): Promise<SignedEnvelope | null>
    {
        this.Calls += 1
        return Promise.reject(this.code === null
            ? new AgentChannelUnavailableError(AgentChannelFailure.Unreachable)
            : new AgentChannelUnavailableError(AgentChannelFailure.Refused, 403, this.code))
    }
}

/** Records the waits; runs a step between waits (the host agent writing the Secret later, say). */
class ScriptedDelay implements ITickDelay
{
    public readonly Waits: number[] = []

    public constructor(private readonly between: (wait: number) => void = () => undefined)
    {
    }

    public async Wait(ms: number): Promise<void>
    {
        this.Waits.push(ms)
        if (this.Waits.length > 20)
        {
            throw new Error('too many waits')
        }
        this.between(ms)
    }
}

class AutoWorld
{
    public static readonly Namespace = 'pragmatic-system'
    public static readonly Tenant = 'acme'
    public static readonly Version = '0.1.0-early.20'
    public static readonly Address = ConsoleAddress.RelayedHiveSubdomain('acme-k3xq')
    public static readonly SecretKey = FakeHiveKube.Key(AutoWorld.Namespace, AutoEnrolment.SecretName)
    public static readonly Timing = { PollMs: 1000, MaxBackoffMs: 8000 }

    public readonly Clock = new FakeClock()
    public readonly Platform = new FakePlatform(this.Clock)
    public readonly Kube = new FakeHiveKube()
    public readonly Log = new RecordingLog()
    public readonly Key = SigningKeyPair.Generate()
    public readonly State = new EnrolmentState(this.Kube, AutoWorld.Namespace, this.Platform.TrustRoot)

    public Enrolment(channel: IAgentChannel = new FakeAgentChannel(this.Platform)): HiveEnrolment
    {
        return new HiveEnrolment({ Key: this.Key, Channel: channel, State: this.State, PinnedTrustRoot: this.Platform.TrustRoot, Tenant: AutoWorld.Tenant, EngineVersion: AutoWorld.Version, Clock: this.Clock })
    }

    public Auto(enrolment: HiveEnrolment): AutoEnrolment
    {
        return new AutoEnrolment(this.Kube, AutoWorld.Namespace, enrolment, AutoWorld.Address, this.Log)
    }

    public WriteCode(code: string): void
    {
        this.Kube.Secrets.set(AutoWorld.SecretKey, { [AutoEnrolment.CodeKey]: code })
    }
}

describe('AutoEnrolment', () =>
{
    it('auto-enrols from the code Secret at level hosted and deletes it', async () =>
    {
        const world = new AutoWorld()
        world.WriteCode(world.Platform.IssueHiveCode(AutoWorld.Tenant, HiveLevel.Hosted))
        const enrolment = world.Enrolment()
        assert.equal(await world.Auto(enrolment).Attempt(), AutoEnrolmentOutcome.Enrolled)
        assert.equal(enrolment.Enrolled?.Level, HiveLevel.Hosted)
        assert.equal(world.Platform.Record(Participant.Hive(enrolment.Enrolled!.HiveId))?.Level, HiveLevel.Hosted)
        assert.equal((await world.State.Read())?.HiveId, enrolment.Enrolled?.HiveId)
        assert.equal(world.Kube.Secrets.has(AutoWorld.SecretKey), false)
        assert.deepEqual(world.Log.Events, ['auto-enrolled'])
    })

    it('waits for the Secret: no code is no-code, and the loop enrols once the host agent writes it', async () =>
    {
        const world = new AutoWorld()
        const code = world.Platform.IssueHiveCode(AutoWorld.Tenant, HiveLevel.Hosted)
        const delay = new ScriptedDelay(() => world.WriteCode(code))
        const outcome = await world.Auto(world.Enrolment()).UntilEnrolled(AutoWorld.Timing, delay)
        assert.equal(outcome, AutoEnrolmentOutcome.Enrolled)
        assert.deepEqual(delay.Waits, [AutoWorld.Timing.PollMs])
        assert.equal(world.Kube.Secrets.has(AutoWorld.SecretKey), false)
    })

    it('an enrolled agent deletes a leftover code Secret and never sends it', async () =>
    {
        const world = new AutoWorld()
        const enrolment = world.Enrolment()
        await enrolment.Enrol({ Code: world.Platform.IssueHiveCode(AutoWorld.Tenant, HiveLevel.Hosted), Level: HiveLevel.Hosted, ConsoleAddress: AutoWorld.Address })
        world.WriteCode('pe1-AAAAAAAAAAAAAAAAAAAAAAAAAA')
        const channel = new RefusingChannel(AgentExchangeRefusal.InvalidCode)
        const restarted = new HiveEnrolment({ Key: world.Key, Channel: channel, State: world.State, PinnedTrustRoot: world.Platform.TrustRoot, Tenant: AutoWorld.Tenant, EngineVersion: AutoWorld.Version, Clock: world.Clock }, await world.State.Read())
        assert.equal(await world.Auto(restarted).UntilEnrolled(AutoWorld.Timing, new ScriptedDelay()), AutoEnrolmentOutcome.AlreadyEnrolled)
        assert.equal(channel.Calls, 0)
        assert.equal(world.Kube.Secrets.has(AutoWorld.SecretKey), false)
    })

    it('an unreachable platform is retried with the same code; the Secret stays until enrolled', async () =>
    {
        const world = new AutoWorld()
        world.WriteCode(world.Platform.IssueHiveCode(AutoWorld.Tenant, HiveLevel.Hosted))
        const channel = new RefusingChannel(null)
        const auto = world.Auto(world.Enrolment(channel))
        assert.equal(await auto.Attempt(), AutoEnrolmentOutcome.Retry)
        assert.equal(await auto.Attempt(), AutoEnrolmentOutcome.Retry)
        assert.equal(channel.Calls, 2)
        assert.equal(world.Kube.Secrets.has(AutoWorld.SecretKey), true)
        assert.deepEqual(world.Log.Events, ['auto-enrolment-retry:unavailable', 'auto-enrolment-retry:unavailable'])
    })

    it('a code refused for good is kept and never sent again; a new code in the Secret is tried', async () =>
    {
        const world = new AutoWorld()
        world.WriteCode('pe1-AAAAAAAAAAAAAAAAAAAAAAAAAA')
        const channel = new RefusingChannel(AgentExchangeRefusal.InvalidCode)
        const auto = world.Auto(world.Enrolment(channel))
        assert.equal(await auto.Attempt(), AutoEnrolmentOutcome.Refused)
        assert.equal(await auto.Attempt(), AutoEnrolmentOutcome.Refused)
        assert.equal(channel.Calls, 1)
        assert.equal(world.Kube.Secrets.has(AutoWorld.SecretKey), true)
        world.WriteCode('pe1-BBBBBBBBBBBBBBBBBBBBBBBBBB')
        assert.equal(await auto.Attempt(), AutoEnrolmentOutcome.Refused)
        assert.equal(channel.Calls, 2)
        assert.deepEqual(world.Log.Events, ['auto-enrolment-refused:invalid-code', 'auto-enrolment-refused:invalid-code'])
    })

    it('the loop waits the longest backoff after a refusal, then enrols with the new code the host agent writes', async () =>
    {
        const world = new AutoWorld()
        world.WriteCode('pe1-AAAAAAAAAAAAAAAAAAAAAAAAAA')
        const platform = new FakeAgentChannel(world.Platform)
        const refusing = new RefusingChannel(AgentExchangeRefusal.Mismatch)
        let refuse = true
        const switching: IAgentChannel = { Exchange: request => refuse ? refusing.Exchange(request) : platform.Exchange(request) }
        const delay = new ScriptedDelay(() =>
        {
            refuse = false
            world.WriteCode(world.Platform.IssueHiveCode(AutoWorld.Tenant, HiveLevel.Hosted))
        })
        assert.equal(await world.Auto(world.Enrolment(switching)).UntilEnrolled(AutoWorld.Timing, delay), AutoEnrolmentOutcome.Enrolled)
        assert.deepEqual(delay.Waits, [AutoWorld.Timing.MaxBackoffMs])
        assert.deepEqual(world.Log.Events, ['auto-enrolment-refused:mismatch', 'auto-enrolled'])
    })

    it('an empty code Secret is an error, not a refusal, and is backed off', async () =>
    {
        const world = new AutoWorld()
        world.Kube.Secrets.set(AutoWorld.SecretKey, { [AutoEnrolment.CodeKey]: '  ' })
        const auto = world.Auto(world.Enrolment())
        await assert.rejects(auto.Attempt(), EnrolmentCodeSecretUnusableError)
        let waits = 0
        const delay = new ScriptedDelay(() =>
        {
            waits += 1
            if (waits === 3)
            {
                world.WriteCode(world.Platform.IssueHiveCode(AutoWorld.Tenant, HiveLevel.Hosted))
            }
        })
        assert.equal(await auto.UntilEnrolled(AutoWorld.Timing, delay), AutoEnrolmentOutcome.Enrolled)
        assert.deepEqual(delay.Waits, [2000, 4000, 8000])
        assert.deepEqual(world.Log.Failures, [2000, 4000, 8000])
    })
})
