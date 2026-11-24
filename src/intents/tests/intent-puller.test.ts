import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    EnvelopeSigner, HiveLevel, HiveReport, IntentChoice, IntentDecision, IntentDecisionCall, IntentDecisionKind, IntentDecisionRefusal, IntentFailure, IntentProgress, IntentStatus,
    MessageKind, Participant, PullBatch, RealmSubject,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { KubeConfigMap } from '../../kube/hive-kube.js'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import { IntentDecisionRefusedError } from '../intent-puller.js'
import { IntentStore } from '../intent-store.js'
import { IntentWorld } from './intent-world.js'

class Decisions
{
    public static readonly Approver = RealmSubject.Of('acme', 'u-7')

    public static Approve(digest: string): IntentDecisionCall
    {
        return IntentDecisionCall.Create(digest, IntentChoice.Approve, Decisions.Approver)
    }

    public static Reject(digest: string): IntentDecisionCall
    {
        return IntentDecisionCall.Create(digest, IntentChoice.Reject, Decisions.Approver)
    }

    public static async CodeOf(work: Promise<unknown>): Promise<IntentDecisionRefusal>
    {
        try
        {
            await work
        }
        catch (error)
        {
            if (error instanceof IntentDecisionRefusedError)
            {
                return error.Code
            }
            throw error
        }
        throw new Error('expected a refusal')
    }

    /** Lets the background tick an approval starts run to its end. */
    public static async Settle(world: IntentWorld): Promise<void>
    {
        await world.Puller.Tick()
    }
}

describe('IntentPuller', () =>
{
    it('delegated + delegated intent applies at once', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        world.Publish(IntentWorld.CreateEnvironment(), HiveLevel.Delegated)
        await world.Puller.Tick()
        assert.deepEqual(world.Executor.Applied, ['intent-2'])
        assert.equal(world.Progress('intent-2'), IntentProgress.Applied)
        assert.equal(world.Platform.ReceivedOf(MessageKind.IntentDecision).length, 0)
    })

    it('enrolled hive or enrolled intent waits for approval', async () =>
    {
        const enrolled = await IntentWorld.Enrolled(HiveLevel.Enrolled)
        enrolled.Publish(IntentWorld.CreateEnvironment(), HiveLevel.Delegated)
        await enrolled.Puller.Tick()
        assert.deepEqual(enrolled.Executor.Applied, [])
        assert.equal(enrolled.Progress('intent-2'), IntentProgress.AwaitingApproval)

        const delegated = await IntentWorld.Enrolled(HiveLevel.Delegated)
        delegated.Publish(IntentWorld.CreateEnvironment(), HiveLevel.Enrolled)
        await delegated.Puller.Tick()
        assert.deepEqual(delegated.Executor.Applied, [])
        assert.equal(delegated.Progress('intent-2'), IntentProgress.AwaitingApproval)
        assert.equal(delegated.Puller.Listing().Intents[0]?.Decidable(delegated.Clock.Now()), true)
    })

    it('an approval is signed by the hive key with the intent\'s digest and the approver, then applies', async () =>
    {
        const world = await IntentWorld.Enrolled()
        const digest = world.Publish()
        await world.Puller.Tick()
        const view = await world.Puller.Decide('intent-2', Decisions.Approve(digest))
        assert.equal(view.Progress, IntentProgress.Applying)
        await Decisions.Settle(world)
        const [decision] = world.Platform.ReceivedOf<IntentDecision>(MessageKind.IntentDecision)
        assert.equal(decision?.Decision, IntentDecisionKind.Approved)
        assert.equal(decision?.IntentDigest, digest)
        assert.deepEqual(decision?.Approver.ToJson(), { Realm: 'acme', Subject: 'u-7' })
        assert.deepEqual(world.Executor.Applied, ['intent-2'])
        assert.equal(world.Progress('intent-2'), IntentProgress.Applied)
    })

    it('an approval for intent X does not apply a reissued X with another digest', async () =>
    {
        const world = await IntentWorld.Enrolled()
        const first = world.Publish(IntentWorld.CreateEnvironment(), undefined, undefined, 'intent-x')
        await world.Puller.Tick()
        const second = world.Publish(IntentWorld.CreateEnvironment('prod'), undefined, undefined, 'intent-x')
        await world.Puller.Tick()
        assert.notEqual(first, second)
        assert.equal(world.Store.Get('intent-x')?.Digest, second)
        assert.equal(await Decisions.CodeOf(world.Puller.Decide('intent-x', Decisions.Approve(first))), IntentDecisionRefusal.DigestMismatch)
        assert.deepEqual(world.Executor.Applied, [])
        assert.equal(world.Platform.ReceivedOf(MessageKind.IntentDecision).length, 0)
        await world.Puller.Decide('intent-x', Decisions.Approve(second))
        await Decisions.Settle(world)
        assert.deepEqual(world.Executor.Applied, ['intent-x'])
    })

    it('an expired intent cannot be approved; it shows expired', async () =>
    {
        const world = await IntentWorld.Enrolled()
        const digest = world.Publish(IntentWorld.CreateEnvironment(), undefined, 86_400_000)
        await world.Puller.Tick()
        world.Clock.Advance(2 * 86_400_000)
        assert.equal(await Decisions.CodeOf(world.Puller.Decide('intent-2', Decisions.Approve(digest))), IntentDecisionRefusal.Expired)
        assert.equal(world.Progress('intent-2'), IntentProgress.Expired)
        assert.equal(await Decisions.CodeOf(world.Puller.Decide('intent-2', Decisions.Approve(digest))), IntentDecisionRefusal.Expired)
        assert.equal(world.Puller.Listing().Intents[0]?.Progress, IntentProgress.Expired)
        assert.deepEqual(world.Executor.Applied, [])
    })

    it('a waiting intent past its expiry is marked expired by the next tick', async () =>
    {
        const world = await IntentWorld.Enrolled()
        world.Publish(IntentWorld.CreateEnvironment(), undefined, 86_400_000)
        await world.Puller.Tick()
        world.Clock.Advance(86_400_001)
        await world.Puller.Tick()
        assert.equal(world.Progress('intent-2'), IntentProgress.Expired)
    })

    it('a rejection carries no text and nothing is applied', async () =>
    {
        const world = await IntentWorld.Enrolled()
        const digest = world.Publish()
        await world.Puller.Tick()
        const view = await world.Puller.Decide('intent-2', Decisions.Reject(digest))
        assert.equal(view.Progress, IntentProgress.Rejected)
        const [decision] = world.Platform.ReceivedOf<IntentDecision>(MessageKind.IntentDecision)
        assert.deepEqual(Object.keys(decision!.ToJson()).sort(), ['Approver', 'DecidedAt', 'Decision', 'IntentDigest', 'IntentId'])
        assert.equal(decision?.Decision, IntentDecisionKind.Rejected)
        await world.Puller.Tick()
        assert.deepEqual(world.Executor.Applied, [])
        assert.equal(await Decisions.CodeOf(world.Puller.Decide('intent-2', Decisions.Approve(digest))), IntentDecisionRefusal.NotAwaiting)
        assert.equal(await Decisions.CodeOf(world.Puller.Decide('intent-9', Decisions.Approve(digest))), IntentDecisionRefusal.UnknownIntent)
    })

    it('kept intents survive an agent restart', async () =>
    {
        const world = await IntentWorld.Enrolled()
        const digest = world.Publish()
        await world.Puller.Tick()
        const cursor = world.Store.Cursor
        await world.Restart()
        assert.equal(world.Store.Cursor, cursor)
        assert.equal(world.Progress('intent-2'), IntentProgress.AwaitingApproval)
        await world.Puller.Tick()
        assert.equal(world.Store.All().length, 1)
        await world.Puller.Decide('intent-2', Decisions.Approve(digest))
        await Decisions.Settle(world)
        assert.equal(world.Progress('intent-2'), IntentProgress.Applied)
    })

    it('a tampered kept intent is refused at apply (Recheck)', async () =>
    {
        const world = await IntentWorld.Enrolled()
        const digest = world.Publish(IntentWorld.CreateEnvironment('staging'))
        await world.Puller.Tick()
        const key = FakeHiveKube.Key(IntentWorld.Namespace, IntentStore.ConfigMapName)
        const map = world.Kube.ConfigMaps.get(key)!
        const kept = JSON.parse(map.Data['intents.json']!) as { Envelope: string }[]
        kept[0]!.Envelope = kept[0]!.Envelope.replace('"staging"', '"stagin9"')
        world.Kube.ConfigMaps.set(key, new KubeConfigMap({ ...map.Data, 'intents.json': JSON.stringify(kept) }, map.ResourceVersion))
        await world.Restart()
        const tampered = world.Store.Get('intent-2')!
        assert.notEqual(tampered.Digest, digest)
        assert.equal(await Decisions.CodeOf(world.Puller.Decide('intent-2', Decisions.Approve(tampered.Digest))), IntentDecisionRefusal.NotAwaiting)
        assert.equal(world.Store.Get('intent-2')?.Status.Failure, IntentFailure.RecheckFailed)
        assert.deepEqual(world.Executor.Applied, [])
        assert.equal(world.Platform.ReceivedOf(MessageKind.IntentDecision).length, 0)
    })

    it('a tampered kept intent waiting to be applied fails its recheck at apply', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        world.Executor.Answer = intent => IntentStatus.Of(intent.Body.IntentId, IntentProgress.Applying)
        world.Publish(IntentWorld.CreateEnvironment('staging'))
        await world.Puller.Tick()
        const key = FakeHiveKube.Key(IntentWorld.Namespace, IntentStore.ConfigMapName)
        const map = world.Kube.ConfigMaps.get(key)!
        const kept = JSON.parse(map.Data['intents.json']!) as { Envelope: string }[]
        kept[0]!.Envelope = kept[0]!.Envelope.replace('"staging"', '"stagin9"')
        world.Kube.ConfigMaps.set(key, new KubeConfigMap({ ...map.Data, 'intents.json': JSON.stringify(kept) }, map.ResourceVersion))
        await world.Restart()
        await world.Puller.Tick()
        assert.deepEqual(world.Executor.Applied, ['intent-2'], 'applied once before the tampering, never after')
        assert.equal(world.Store.Get('intent-2')?.Status.Failure, IntentFailure.RecheckFailed)
    })

    it('an intent signed by another platform or addressed to another hive is never kept', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        const forged = new FakePlatform(world.Clock).PublishIntent(world.HiveId, IntentWorld.CreateEnvironment('forged'), { Level: HiveLevel.Delegated })
        const elsewhere = world.Platform.PublishIntent('hv0000000009', IntentWorld.CreateEnvironment('elsewhere'), { Level: HiveLevel.Delegated })
        const signer = new EnvelopeSigner(world.Platform.SigningKey, Participant.Platform, world.Clock)
        // A batch the platform signed, carrying items that are not this hive's (as a compromised relay could assemble).
        world.Channel.Exchange = async request => request.Kind === MessageKind.Pull
            ? signer.Sign(MessageKind.PullBatch, Participant.Hive(world.HiveId), PullBatch.Create([forged, elsewhere], 2))
            : null
        await world.Puller.Tick()
        assert.deepEqual(world.Store.All(), [])
        assert.deepEqual(world.Executor.Applied, [])
        assert.equal(world.Store.Cursor, 2)
    })

    it('the agent\'s own upgrade is applied last and reported before the roll', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        world.Publish(IntentWorld.Component('pragmatic-hive-agent'))
        world.Publish(IntentWorld.Component('pragmatic-tenant-admin'))
        world.Publish(IntentWorld.CreateEnvironment())
        await world.Puller.Tick()
        assert.deepEqual(world.Executor.Applied, ['intent-3', 'intent-4', 'intent-2'])
        assert.deepEqual(world.Reports, ['report after intent-3,intent-4'])
    })

    it('an intent that cannot finish now stays applying and is tried again', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        world.Executor.Answer = intent => IntentStatus.Of(intent.Body.IntentId, IntentProgress.Applying)
        world.Publish()
        await world.Puller.Tick()
        assert.equal(world.Progress('intent-2'), IntentProgress.Applying)
        world.Executor.Answer = intent => IntentStatus.FailedWith(intent.Body.IntentId, IntentFailure.EnvironmentExists)
        await world.Puller.Tick()
        assert.deepEqual(world.Executor.Applied, ['intent-2', 'intent-2'])
        assert.equal(world.Store.Get('intent-2')?.Status.Failure, IntentFailure.EnvironmentExists)
    })

    it('reports carry the kept intents\' statuses with their failure codes', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        world.Executor.Answer = intent => IntentStatus.FailedWith(intent.Body.IntentId, IntentFailure.NotReady)
        world.Publish()
        await world.Puller.Tick()
        const report = HiveReport.Create({ EngineVersion: '0.1.0', Components: [], Environments: [], Intents: world.Store.Statuses(HiveReport.MaxIntents) })
        assert.deepEqual(report.ToJson().Intents, [{ IntentId: 'intent-2', Progress: IntentProgress.Failed, Failure: IntentFailure.NotReady }])
    })

    it('a full store prunes the oldest settled intents first', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        for (let n = 0; n < 6; n++)
        {
            world.Publish(IntentWorld.CreateEnvironment('env-' + n))
        }
        await world.Puller.Tick()
        const small = new IntentStore(world.Kube, IntentWorld.Namespace, 2 * Buffer.byteLength(world.Store.All()[0]!.Envelope.Encode()) + 400)
        await small.Load()
        await small.Save()
        assert.ok(small.All().length < 6)
        assert.equal(small.All().at(-1)?.IntentId, 'intent-7')
    })
})
