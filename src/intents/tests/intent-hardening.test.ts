import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    ComponentAtVersion, HiveLevel, HiveReport, Intent, IntentApplyMode, IntentChoice, IntentDecision, IntentDecisionCall, IntentDecisionKind, IntentDecisionRefusal, IntentFailure,
    IntentNotAcceptedError, IntentProgress, IntentStatus, MessageKind, RealmSubject, Rotate, RotationSubject, SigningKeyPair,
    type SignedEnvelope, type VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { HiveIdentity } from '../../identity/hive-identity.js'
import { HiveKeyRecovery } from '../../identity/hive-key-recovery.js'
import { KubeConfigMap, KubeReplicas, KubeWorkload, KubeWorkloadKind } from '../../kube/hive-kube.js'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import { ApprovalSigner } from '../approval-signer.js'
import { EngineWorkload, EngineWorkloads } from '../engine-workloads.js'
import { ComponentAtVersionHandler } from '../handlers/component-at-version-handler.js'
import { EnvironmentIntentForwarder } from '../handlers/environment-intent-forwarder.js'
import { RepairHandler } from '../handlers/repair-handler.js'
import { RotateHandler } from '../handlers/rotate-handler.js'
import { IntentAdmissionDecider } from '../intent-admission-decider.js'
import type { IApplyContext, IIntentExecutor } from '../intent-executor-contract.js'
import { IntentExecutor } from '../intent-executor.js'
import { IntentLease } from '../intent-lease.js'
import { IntentDecisionRefusedError, IntentPuller } from '../intent-puller.js'
import { IntentStore } from '../intent-store.js'
import { RolloutWatch } from '../rollout-watch.js'
import { IntentWorld } from './intent-world.js'

/** An executor bound after the pod exists (the real handlers need the pod's signing and trust). */
class LateExecutor implements IIntentExecutor
{
    public Target!: IIntentExecutor

    public Apply(intent: VerifiedMessage<Intent>, context: IApplyContext): Promise<IntentStatus>
    {
        return this.Target.Apply(intent, context)
    }

    public Revert(intent: Intent, previousImage: string): Promise<void>
    {
        return this.Target.Revert(intent, previousImage)
    }
}

/** A world whose pods run the real executor over the fake cluster's engine workloads. */
class RealWorld
{
    public static readonly Ns = 'pragmatic-system'
    public static readonly AgentDeployment = 'pragmatic-hive-acme-hive-agent'
    public static readonly ConsoleDeployment = 'pragmatic-tenant-admin-acme'
    public static readonly AgentOld = 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent@sha256:' + '2'.repeat(64)
    public static readonly ConsoleOld = 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@sha256:' + '1'.repeat(64)
    public static readonly NewDigest = 'sha256:' + 'f'.repeat(64)
    private static now = 0

    public static async Enrolled(level: HiveLevel = HiveLevel.Delegated): Promise<IntentWorld>
    {
        const late = new LateExecutor()
        const world = await IntentWorld.Enrolled(level)
        world.Executor = late
        await world.Restart()
        world.Kube.AddWorkload(RealWorld.Ns, KubeWorkloadKind.Deployment, RealWorld.AgentDeployment, RealWorld.AgentOld, 'agent')
        world.Kube.AddWorkload(RealWorld.Ns, KubeWorkloadKind.Deployment, RealWorld.ConsoleDeployment, RealWorld.ConsoleOld, 'tenant-admin', [{ Name: 'seed', Image: RealWorld.ConsoleOld }])
        late.Target = RealWorld.Executor(world)
        return world
    }

    public static Executor(world: IntentWorld): IntentExecutor
    {
        const workloads = new EngineWorkloads([
            new EngineWorkload(EngineWorkloads.AgentComponent, RealWorld.Ns, KubeWorkloadKind.Deployment, RealWorld.AgentDeployment, undefined),
            new EngineWorkload(EngineWorkloads.ConsoleComponent, RealWorld.Ns, KubeWorkloadKind.Deployment, RealWorld.ConsoleDeployment, undefined),
        ])
        const watch = new RolloutWatch({ TimeoutMs: 50, PollMs: 10, Sleep: async () => undefined, Now: () => RealWorld.now += 10 })
        const forwarder = new EnvironmentIntentForwarder(undefined)
        return new IntentExecutor(
            new ComponentAtVersionHandler(world.Kube, workloads, watch),
            new RotateHandler(world.Trust, world.Signing, world.Channel, forwarder, world.Store),
            new RepairHandler(world.Kube, workloads, watch, forwarder, world.Clock),
            forwarder)
    }

    public static Component(component: string): ComponentAtVersion
    {
        return new ComponentAtVersion(component, '0.2.0', RealWorld.NewDigest, 'sha256:' + 'b'.repeat(64), null)
    }

    public static Image(world: IntentWorld, name: string): string | undefined
    {
        return world.Kube.Workload(RealWorld.Ns, KubeWorkloadKind.Deployment, name)?.Containers[0]?.Image
    }

    public static async Edit(world: IntentWorld, change: (entries: Record<string, unknown>[]) => void): Promise<void>
    {
        const key = FakeHiveKube.Key(IntentWorld.Namespace, IntentStore.ConfigMapName)
        const map = world.Kube.ConfigMaps.get(key)!
        const entries = JSON.parse(map.Data['intents.json']!) as Record<string, unknown>[]
        change(entries)
        world.Kube.ConfigMaps.set(key, new KubeConfigMap({ ...map.Data, 'intents.json': JSON.stringify(entries) }, map.ResourceVersion))
    }
}

describe('KubeWorkload.RolledOut', () =>
{
    it('follows kubectl rollout status: a stuck surge (old pod still ready) is not rolled out', () =>
    {
        const stuck = new KubeWorkload([], [], 2, 2, new KubeReplicas(1, 2, 1, 1, 1))
        assert.equal(stuck.RolledOut, false, 'one updated pod beside the old ready one')
        assert.equal(new KubeWorkload([], [], 2, 1, new KubeReplicas(1, 1, 1, 1, 1)).RolledOut, false, 'not observed yet')
        assert.equal(new KubeWorkload([], [], 2, 2, new KubeReplicas(1, 1, 1, 1, 0)).RolledOut, false, 'updated but not available')
        assert.equal(new KubeWorkload([], [], 2, 2, new KubeReplicas(1, 1, 1, 1, 1)).RolledOut, true)
    })
})

describe('intent loop over the real executor (surge, revert, two pods)', () =>
{
    it('a new agent that never readies under a surge: the intent fails not-ready and the old image is put back', async () =>
    {
        const world = await RealWorld.Enrolled()
        world.Kube.Workload(RealWorld.Ns, KubeWorkloadKind.Deployment, RealWorld.AgentDeployment)!.NeverReadies = true
        world.Publish(RealWorld.Component(EngineWorkloads.AgentComponent))
        await world.Puller.Tick()
        const kept = world.Store.Get('intent-2')!
        assert.equal(kept.Status.Failure, IntentFailure.NotReady)
        assert.equal(kept.PreviousImage, RealWorld.AgentOld, 'the replaced image is kept with the intent')
        assert.equal(RealWorld.Image(world, RealWorld.AgentDeployment), RealWorld.AgentOld)
        assert.deepEqual(world.Kube.PatchLog, ['deployments/' + RealWorld.AgentDeployment, 'deployments/' + RealWorld.AgentDeployment])
    })

    it('a console upgrade moves its seed init container with it', async () =>
    {
        const world = await RealWorld.Enrolled()
        world.Publish(RealWorld.Component(EngineWorkloads.ConsoleComponent))
        await world.Puller.Tick()
        assert.equal(world.Progress('intent-2'), IntentProgress.Applied)
        const console = world.Kube.Workload(RealWorld.Ns, KubeWorkloadKind.Deployment, RealWorld.ConsoleDeployment)!
        const target = 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@' + RealWorld.NewDigest
        assert.equal(console.Containers[0]?.Image, target)
        assert.equal(console.InitContainers[0]?.Image, target)
    })

    it('two agent pods: only the lease holder applies; the other takes over once it is released', async () =>
    {
        const world = await RealWorld.Enrolled()
        const a = await world.Pod('pod-a', world.Executor)
        const b = await world.Pod('pod-b', world.Executor)
        world.Publish(RealWorld.Component(EngineWorkloads.ConsoleComponent))
        await a.Puller.Tick()
        await b.Puller.Tick()
        assert.equal(world.Kube.PatchLog.length, 1, 'only the holder applied')
        world.Publish(IntentWorld.CreateEnvironment())
        await b.Puller.Tick()
        await b.Store.Refresh()
        assert.equal(b.Store.Get('intent-3'), undefined, 'the other pod skipped its tick')
        await new IntentLease(world.Kube, IntentWorld.Namespace, 'pod-a', world.Clock).Release()
        await b.Puller.Tick()
        await a.Store.Refresh()
        assert.equal(a.Store.Get('intent-2')?.Progress, IntentProgress.Applied)
        assert.ok(a.Store.Get('intent-3') !== undefined, 'the store merges both pods\' writes')
    })

    it('a lost hive-key ack is settled within a tick: the old key\'s pull is refused, the pending key is proved and the intent applied', async () =>
    {
        const world = await RealWorld.Enrolled()
        await world.Kube.CreateSecret(IntentWorld.Namespace, HiveIdentity.SecretName, { [HiveIdentity.KeyName]: world.Key.PrivatePem() })
        const before = world.Signing.Key.KeyId
        const original = world.Channel.Exchange.bind(world.Channel)
        world.Channel.Exchange = async (request: SignedEnvelope) =>
        {
            const reply = await original(request)
            if (request.Kind === MessageKind.HiveKeyRotation)
            {
                throw new Error('connection reset')
            }
            return reply
        }
        world.Publish(new Rotate(RotationSubject.HiveKey, null))
        await world.Puller.Tick()
        assert.equal(world.Progress('intent-2'), IntentProgress.Applying)
        world.Channel.Exchange = original
        await world.Puller.Tick()
        assert.equal(world.Progress('intent-2'), IntentProgress.Applied)
        assert.notEqual(world.Signing.Key.KeyId, before)
        assert.ok(world.Platform.Record(world.Signing.Self)?.PublicKey.Equals(world.Signing.Key.PublicKey))
        assert.equal(await HiveIdentity.Pending(world.Kube, IntentWorld.Namespace), undefined)
    })
})

describe('approval bound at apply', () =>
{
    it('a status edited to applying without an approval applies nothing and waits again', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Enrolled)
        world.Publish()
        await world.Puller.Tick()
        await RealWorld.Edit(world, entries =>
        {
            (entries[0]!.Status as Record<string, unknown>).Progress = IntentProgress.Applying
        })
        await world.Restart()
        await world.Puller.Tick()
        assert.deepEqual(world.Recorded.Applied, [])
        assert.equal(world.Progress('intent-2'), IntentProgress.AwaitingApproval)
    })

    it('an approval moved onto another signed intent of the same id applies nothing', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Enrolled)
        const digest = world.Publish(IntentWorld.CreateEnvironment('staging'), undefined, undefined, 'intent-x')
        await world.Puller.Tick()
        world.Recorded.Answer = intent => IntentStatus.Of(intent.Body.IntentId, IntentProgress.Applying)
        await world.Puller.Decide('intent-x', IntentDecisionCall.Create(digest, IntentChoice.Approve, RealmSubject.Of('acme', 'u-1')))
        await world.Puller.Tick()
        const other = world.Platform.PublishIntent(world.HiveId, IntentWorld.CreateEnvironment('prod'), { IntentId: 'intent-x' })
        await RealWorld.Edit(world, entries =>
        {
            entries[0]!.Envelope = other.Encode()
        })
        await world.Restart()
        const applied = world.Recorded.Applied.length
        await world.Puller.Tick()
        assert.equal(world.Recorded.Applied.length, applied, 'the swapped intent did not apply')
        assert.equal(world.Progress('intent-x'), IntentProgress.AwaitingApproval)
    })
})

describe('the agent\'s own upgrade waits for its batch', () =>
{
    it('is deferred while another intent of the same pull awaits approval, applied once that settles', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        const digest = world.Publish(IntentWorld.CreateEnvironment(), HiveLevel.Enrolled)
        world.Publish(IntentWorld.Component(EngineWorkloads.AgentComponent), HiveLevel.Delegated)
        await world.Puller.Tick()
        assert.deepEqual(world.Recorded.Applied, [])
        await world.Puller.Decide('intent-2', IntentDecisionCall.Create(digest, IntentChoice.Reject, RealmSubject.Of('acme', 'u-1')))
        await world.Puller.Tick()
        assert.deepEqual(world.Recorded.Applied, ['intent-3'])
    })
})

describe('expiry and the store\'s limits', () =>
{
    it('a decision after the expiry is refused even inside the clock-skew window', async () =>
    {
        const world = await IntentWorld.Enrolled()
        const digest = world.Publish(IntentWorld.CreateEnvironment(), undefined, 86_400_000)
        await world.Puller.Tick()
        world.Clock.Advance(86_400_000 + 60_000)
        await assert.rejects(world.Puller.Decide('intent-2', IntentDecisionCall.Create(digest, IntentChoice.Approve, RealmSubject.Of('acme', 'u-1'))),
            (error: unknown) => error instanceof IntentDecisionRefusedError && error.Code === IntentDecisionRefusal.Expired)
        assert.equal(world.Progress('intent-2'), IntentProgress.Expired)
    })

    it('an intent that expires mid-roll is put back before it is marked expired', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        world.Recorded.Answer = async (intent, context) =>
        {
            await context.NotePrevious('ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@sha256:' + '1'.repeat(64))
            return IntentStatus.Of(intent.Body.IntentId, IntentProgress.Applying)
        }
        world.Publish(IntentWorld.Component(EngineWorkloads.ConsoleComponent), undefined, 86_400_000)
        await world.Puller.Tick()
        world.Clock.Advance(2 * 86_400_000)
        await world.Puller.Tick()
        assert.equal(world.Progress('intent-2'), IntentProgress.Expired)
        assert.deepEqual(world.Recorded.Reverted, ['intent-2@ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@sha256:' + '1'.repeat(64)])
    })

    it('a full store refuses the new batch with a code, moves the cursor on and does not wedge', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Enrolled)
        world.Publish()
        world.Publish(IntentWorld.CreateEnvironment('prod'))
        const tiny = new IntentStore(world.Kube, IntentWorld.Namespace, 600)
        await tiny.Load()
        const puller = new IntentPuller({
            Channel: world.Channel, Store: tiny, Decider: new IntentAdmissionDecider(world.Trust), Executor: world.Executor, Signing: world.Signing, Trust: world.Trust,
            Log: { Event: () => undefined, Failed: () => undefined },
        })
        await puller.Tick()
        assert.deepEqual(tiny.All(), [])
        assert.deepEqual(tiny.Statuses(10).map(status => [status.IntentId, status.Failure]), [['intent-2', IntentFailure.PrecheckRefused], ['intent-3', IntentFailure.PrecheckRefused]])
        assert.equal(tiny.Cursor, 2)
        await puller.Tick()
        await tiny.MarkReported(tiny.Statuses(10))
        assert.deepEqual(tiny.Statuses(10), [], 'refused ids are forgotten once reported')
    })

    it('only settled intents a report already carried are pruned; unsettled ones are reported first', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        for (let n = 0; n < 4; n++)
        {
            world.Publish(IntentWorld.CreateEnvironment('env-' + n))
        }
        world.Publish(IntentWorld.CreateEnvironment('waiting'), HiveLevel.Enrolled)
        await world.Puller.Tick()
        assert.equal(world.Store.Statuses(1)[0]?.Progress, IntentProgress.AwaitingApproval, 'unsettled first')
        const size = Buffer.byteLength(world.Store.All()[0]!.Envelope.Encode())
        const small = new IntentStore(world.Kube, IntentWorld.Namespace, 3 * size)
        await small.Load()
        await assert.rejects(small.Save(), /full/, 'nothing reported yet: nothing may be pruned')
        await small.MarkReported(small.Statuses(10)).catch(() => undefined)
        await small.Save()
        assert.ok(small.All().length < 5)
        assert.ok(small.All().some(kept => kept.Progress === IntentProgress.AwaitingApproval))
    })
})

describe('IntentAdmissionDecider', () =>
{
    it('the stricter level wins: only Delegated hive and Delegated intent apply directly; Standalone and Hosted take none', () =>
    {
        const intent = (level: HiveLevel): Intent => Intent.Create('in1', level, IntentWorld.CreateEnvironment())
        const table: Array<[HiveLevel, HiveLevel, IntentApplyMode]> = [
            [HiveLevel.Delegated, HiveLevel.Delegated, IntentApplyMode.ApplyDirectly],
            [HiveLevel.Delegated, HiveLevel.Enrolled, IntentApplyMode.AwaitApproval],
            [HiveLevel.Enrolled, HiveLevel.Delegated, IntentApplyMode.AwaitApproval],
            [HiveLevel.Enrolled, HiveLevel.Enrolled, IntentApplyMode.AwaitApproval],
        ]
        for (const [hive, issued, mode] of table)
        {
            assert.equal(new IntentAdmissionDecider({ Level: hive }).ModeFor(intent(issued)), mode, hive + '/' + issued)
        }
        for (const hive of [HiveLevel.Standalone, HiveLevel.Hosted])
        {
            assert.throws(() => new IntentAdmissionDecider({ Level: hive }).ModeFor(intent(HiveLevel.Delegated)), IntentNotAcceptedError)
        }
    })
})

describe('ApprovalSigner', () =>
{
    it('signs a decision with the intent\'s digest and the approver under the hive key, and no reason text', async () =>
    {
        const world = await IntentWorld.Enrolled()
        world.Publish()
        await world.Puller.Tick()
        const kept = world.Store.Get('intent-2')!
        const verified = await world.Trust.Verifier().Recheck(kept.Envelope, MessageKind.Intent, Intent)
        const approver = RealmSubject.Of('acme', 'u-7')
        for (const [choice, kind] of [[IntentChoice.Approve, IntentDecisionKind.Approved], [IntentChoice.Reject, IntentDecisionKind.Rejected]] as const)
        {
            const envelope = new ApprovalSigner(world.Signing).Sign(verified, choice, approver)
            assert.equal(envelope.Kind, MessageKind.IntentDecision)
            assert.equal(envelope.KeyId, world.Signing.Key.KeyId)
            assert.ok(world.Signing.Key.PublicKey.Verify(envelope.SigningInput(), Buffer.from(envelope.Signature, 'base64url')))
            const body = IntentDecision.Parse(envelope.Body)
            assert.equal(body.IntentDigest, kept.Digest)
            assert.equal(body.Decision, kind)
            assert.deepEqual(body.Approver.ToJson(), approver.ToJson())
            assert.deepEqual(Object.keys(envelope.Body).sort(), ['Approver', 'DecidedAt', 'Decision', 'IntentDigest', 'IntentId'])
        }
    })
})

describe('IntentLease and HiveKeyRecovery', () =>
{
    it('one holder at a time; an expired or released lease is taken over', async () =>
    {
        const kube = new FakeHiveKube()
        const clock = new FakeClock()
        const a = new IntentLease(kube, IntentWorld.Namespace, 'pod-a', clock)
        const b = new IntentLease(kube, IntentWorld.Namespace, 'pod-b', clock)
        assert.equal(await a.Acquire(), true)
        assert.equal(await b.Acquire(), false)
        assert.equal(await a.Acquire(), true, 'renewed')
        clock.Advance((IntentLease.DurationSeconds + 1) * 1000)
        assert.equal(await b.Acquire(), true, 'run out')
        assert.equal(await a.Acquire(), false)
        await b.Release()
        assert.equal(await a.Acquire(), true, 'released')
    })

    it('keeps the pending key while the current key still works (the rotation is still applying)', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        const next = SigningKeyPair.Generate()
        await world.Kube.CreateSecret(IntentWorld.Namespace, HiveIdentity.SecretName, { [HiveIdentity.KeyName]: world.Key.PrivatePem() })
        await HiveIdentity.WritePending(world.Kube, IntentWorld.Namespace, world.Key, next)
        const report = HiveReport.Create({ EngineVersion: '0.1.0', Components: [], Environments: [], Intents: [] })
        assert.equal(await new HiveKeyRecovery(world.Signing, world.Kube, IntentWorld.Namespace).Settle(world.Channel, report, world.Store.Cursor), false)
        assert.equal((await HiveIdentity.Pending(world.Kube, IntentWorld.Namespace))?.KeyId, next.KeyId)
        assert.equal(world.Signing.Key.KeyId, world.Key.KeyId)
    })
})
