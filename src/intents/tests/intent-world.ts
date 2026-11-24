import {
    ComponentAtVersion, ConsoleAddress, CreateEnvironment, EnvironmentPurpose, HiveLevel, IntentProgress, IntentStatus, SigningKeyPair,
    type Intent, type IntentAction, type VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeAgentChannel, FakeClock, FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { EnrolmentState, type EnrolmentRecord } from '../../enrolment/enrolment-state.js'
import { HiveEnrolment } from '../../enrolment/hive-enrolment.js'
import { PlatformTrust } from '../../enrolment/platform-trust.js'
import { HiveSigning } from '../../identity/hive-signing.js'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import { IntentAdmissionDecider } from '../intent-admission-decider.js'
import type { IApplyContext, IIntentExecutor } from '../intent-executor-contract.js'
import { IntentPuller } from '../intent-puller.js'
import { IntentStore } from '../intent-store.js'

/** An executor that records what it was asked to apply and answers a fixed status (applied by default). */
export class RecordingExecutor implements IIntentExecutor
{
    public readonly Applied: string[] = []
    public Answer: (intent: VerifiedMessage<Intent>) => IntentStatus = intent => IntentStatus.Of(intent.Body.IntentId, IntentProgress.Applied)

    public async Apply(intent: VerifiedMessage<Intent>, _context: IApplyContext): Promise<IntentStatus>
    {
        this.Applied.push(intent.Body.IntentId)
        return this.Answer(intent)
    }
}

/** A hive enrolled on the fake platform, with its intent loop over a fake cluster. */
export class IntentWorld
{
    public static readonly Namespace = 'pragmatic-system'
    public static readonly Tenant = 'acme'
    public static readonly Digest = 'sha256:' + 'a'.repeat(64)
    public static readonly Descriptor = 'sha256:' + 'b'.repeat(64)

    public readonly Clock = new FakeClock()
    public readonly Platform = new FakePlatform(this.Clock)
    public readonly Channel = new FakeAgentChannel(this.Platform)
    public readonly Kube = new FakeHiveKube()
    public readonly State = new EnrolmentState(this.Kube, IntentWorld.Namespace, this.Platform.TrustRoot)
    public readonly Key = SigningKeyPair.Generate()
    public readonly Executor = new RecordingExecutor()
    public readonly Events: string[] = []
    public readonly Reports: string[] = []
    public Record!: EnrolmentRecord
    public Signing!: HiveSigning
    public Trust!: PlatformTrust
    public Store!: IntentStore
    public Puller!: IntentPuller

    public static async Enrolled(level: HiveLevel = HiveLevel.Enrolled): Promise<IntentWorld>
    {
        const world = new IntentWorld()
        const enrolment = new HiveEnrolment({ Key: world.Key, Channel: world.Channel, State: world.State, PinnedTrustRoot: world.Platform.TrustRoot, Tenant: IntentWorld.Tenant, EngineVersion: '0.1.0', Clock: world.Clock })
        world.Record = await enrolment.Enrol({ Code: world.Platform.IssueHiveCode(IntentWorld.Tenant, level), Level: level, ConsoleAddress: ConsoleAddress.OwnDomain('console.acme.example') })
        await world.Restart()
        return world
    }

    public get HiveId(): string
    {
        return this.Record.HiveId
    }

    /** A new agent process over the same cluster: everything read back from the ConfigMaps and Secret. */
    public async Restart(): Promise<void>
    {
        this.Record = (await this.State.Read()) as EnrolmentRecord
        this.Signing = new HiveSigning(this.Signing?.Key ?? this.Key, this.Record.HiveId, this.Kube, IntentWorld.Namespace, this.Clock)
        this.Trust = new PlatformTrust(this.Record, this.State, this.Clock)
        this.Store = new IntentStore(this.Kube, IntentWorld.Namespace)
        await this.Store.Load()
        this.Puller = new IntentPuller({
            Channel: this.Channel, Store: this.Store, Decider: new IntentAdmissionDecider(this.Trust), Executor: this.Executor, Signing: this.Signing, Trust: this.Trust,
            Log: { Event: (event, code) => this.Events.push(event + ' ' + (code ?? '')), Failed: () => undefined },
            ReportNow: async () =>
            {
                this.Reports.push('report after ' + this.Executor.Applied.join(','))
            },
        })
    }

    public Publish(action: IntentAction = IntentWorld.CreateEnvironment(), level?: HiveLevel, lifetimeMs?: number, intentId?: string): string
    {
        const options: { Level?: HiveLevel, LifetimeMs?: number, IntentId?: string } = {}
        if (level !== undefined)
        {
            options.Level = level
        }
        if (lifetimeMs !== undefined)
        {
            options.LifetimeMs = lifetimeMs
        }
        if (intentId !== undefined)
        {
            options.IntentId = intentId
        }
        const envelope = this.Platform.PublishIntent(this.HiveId, action, options)
        return envelope.Digest
    }

    public Progress(intentId: string): IntentProgress | undefined
    {
        return this.Store.Get(intentId)?.Progress
    }

    public static CreateEnvironment(name: string = 'staging'): CreateEnvironment
    {
        return new CreateEnvironment(name, EnvironmentPurpose.Development, null)
    }

    public static Component(component: string): ComponentAtVersion
    {
        return new ComponentAtVersion(component, '0.2.0', IntentWorld.Digest, IntentWorld.Descriptor, null)
    }
}
