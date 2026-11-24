import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    HiveLevel, HiveReport, Intent, IntentFailure, IntentProgress, MessageKind, Rotate, RotationSubject, SigningKeyPair,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { EnrolmentState } from '../../enrolment/enrolment-state.js'
import { HiveIdentity } from '../../identity/hive-identity.js'
import { HiveKeyRecovery } from '../../identity/hive-key-recovery.js'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import { EnvironmentIntentForwarder } from '../handlers/environment-intent-forwarder.js'
import { RotateHandler } from '../handlers/rotate-handler.js'
import { IntentWorld } from './intent-world.js'

class RotationCases
{
    public static Handler(world: IntentWorld): RotateHandler
    {
        return new RotateHandler(world.Trust, world.Signing, world.Channel, new EnvironmentIntentForwarder(undefined))
    }

    public static Report(): HiveReport
    {
        return HiveReport.Create({ EngineVersion: '0.1.0', Components: [], Environments: [], Intents: [] })
    }

    public static async WithIdentity(world: IntentWorld): Promise<void>
    {
        await world.Kube.CreateSecret(IntentWorld.Namespace, HiveIdentity.SecretName, { [HiveIdentity.KeyName]: world.Key.PrivatePem() })
    }
}

describe('RotateHandler', () =>
{
    it('a trust-root rotation signed by the current root is adopted, kept with its proof, and survives a restart', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        const next = SigningKeyPair.Generate()
        const envelope = world.Platform.PublishIntent(world.HiveId, new Rotate(RotationSubject.TrustRoot, next.PublicKey))
        const verified = await world.Trust.Verifier().Verify(envelope, MessageKind.Intent, Intent)
        const status = await RotationCases.Handler(world).Apply(verified, verified.Body.Action as Rotate)
        assert.equal(status.Progress, IntentProgress.Applied)
        assert.ok(world.Trust.Root.Equals(next.PublicKey))
        const restarted = await world.State.Read()
        assert.ok(restarted?.TrustRoot.Equals(next.PublicKey))
        assert.equal(restarted?.Rotations.length, 1)
    })

    it('a trust-root rotation not signed by the current root is refused', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        const rogue = new FakePlatform(world.Clock)
        const forged = rogue.PublishIntent(world.HiveId, new Rotate(RotationSubject.TrustRoot, rogue.TrustRoot))
        // It never verifies under the hive's root, so it is never kept or applied ...
        await assert.rejects(world.Trust.Verifier().Verify(forged, MessageKind.Intent, Intent))
        // ... and should one reach the handler anyway, its signing key is not the current root.
        const status = await RotationCases.Handler(world).Apply({ Envelope: forged, Body: Intent.Parse(forged.Body) } as never, new Rotate(RotationSubject.TrustRoot, rogue.TrustRoot))
        assert.equal(status.Failure, IntentFailure.RotationRefused)
        assert.ok(world.Trust.Root.Equals(world.Platform.TrustRoot))
    })

    it('an edited enrolment ConfigMap naming another root with a forged rotation chain falls back to the pinned root', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        const rogue = new FakePlatform(world.Clock)
        const forged = rogue.PublishIntent(world.HiveId, new Rotate(RotationSubject.TrustRoot, rogue.TrustRoot))
        await world.State.Write(world.Record.Rotated(rogue.TrustRoot, forged))
        const read = await new EnrolmentState(world.Kube, IntentWorld.Namespace, world.Platform.TrustRoot).Read()
        assert.ok(read?.TrustRoot.Equals(world.Platform.TrustRoot))
        assert.equal(read?.Rotations.length, 0)
    })

    it('hive key rotation swaps keys only after the platform\'s ack', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        await RotationCases.WithIdentity(world)
        const before = world.Signing.Key
        const rotate = new Rotate(RotationSubject.HiveKey, null)
        const envelope = world.Platform.PublishIntent(world.HiveId, rotate)
        const verified = await world.Trust.Verifier().Verify(envelope, MessageKind.Intent, Intent)

        const silent = new RotateHandler(world.Trust, world.Signing, { Exchange: async () => null }, new EnvironmentIntentForwarder(undefined))
        assert.equal((await silent.Apply(verified, rotate)).Failure, IntentFailure.RotationRefused)
        assert.equal(world.Signing.Key.KeyId, before.KeyId)
        const secret = world.Kube.Secrets.get(FakeHiveKube.Key(IntentWorld.Namespace, HiveIdentity.SecretName))!
        assert.equal(SigningKeyPair.FromPrivatePem(secret[HiveIdentity.KeyName]!).KeyId, before.KeyId)
        assert.ok(secret[HiveIdentity.PendingKeyName] !== undefined)

        assert.equal((await RotationCases.Handler(world).Apply(verified, rotate)).Progress, IntentProgress.Applied)
        assert.notEqual(world.Signing.Key.KeyId, before.KeyId)
        assert.ok(world.Platform.Record(world.Signing.Self)?.PublicKey.Equals(world.Signing.Key.PublicKey))
        const after = world.Kube.Secrets.get(FakeHiveKube.Key(IntentWorld.Namespace, HiveIdentity.SecretName))!
        assert.deepEqual(Object.keys(after), [HiveIdentity.KeyName])
        assert.equal(SigningKeyPair.FromPrivatePem(after[HiveIdentity.KeyName]!).KeyId, world.Signing.Key.KeyId)
        // The platform verifies the hive under the new key now.
        await world.Channel.Exchange(world.Signing.Sign(MessageKind.HiveReport, RotationCases.Report()))
    })

    it('a rotation acknowledged but not swapped (agent restarted) is settled by the next start', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        await RotationCases.WithIdentity(world)
        const before = world.Signing.Key
        // The platform switched to the pending key, the agent died before swapping its Secret.
        const original = world.Kube.ReplaceSecret.bind(world.Kube)
        let writes = 0
        world.Kube.ReplaceSecret = async (namespace: string, name: string, data: Readonly<Record<string, string>>) =>
        {
            writes += 1
            if (writes === 2)
            {
                throw new Error('agent stopped')
            }
            return original(namespace, name, data)
        }
        await assert.rejects(world.Signing.Rotate(world.Channel, world.Trust.Verifier()))
        world.Kube.ReplaceSecret = original
        assert.equal(world.Signing.Key.KeyId, before.KeyId)
        const settled = await new HiveKeyRecovery(world.Signing, world.Kube, IntentWorld.Namespace).Settle(world.Channel, RotationCases.Report())
        assert.equal(settled, true)
        assert.notEqual(world.Signing.Key.KeyId, before.KeyId)
        assert.ok(world.Platform.Record(world.Signing.Self)?.PublicKey.Equals(world.Signing.Key.PublicKey))
        assert.equal(await HiveIdentity.Pending(world.Kube, IntentWorld.Namespace), undefined)
    })

    it('the ingress certificate rotation is the console\'s', async () =>
    {
        const world = await IntentWorld.Enrolled(HiveLevel.Delegated)
        const rotate = new Rotate(RotationSubject.IngressCertificate, null)
        const envelope = world.Platform.PublishIntent(world.HiveId, rotate)
        const verified = await world.Trust.Verifier().Verify(envelope, MessageKind.Intent, Intent)
        // No console endpoint on this install: the console could not be asked.
        assert.equal((await RotationCases.Handler(world).Apply(verified, rotate)).Failure, IntentFailure.ConsoleUnavailable)
    })
})
