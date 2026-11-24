import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SigningKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import { HiveIdentity, HiveIdentityUnusableError } from '../hive-identity.js'

class IdentityCases
{
    public static readonly Namespace = 'pragmatic-system'
}

describe('HiveIdentity', () =>
{
    it('creates the key once and reuses it after restart', async () =>
    {
        const kube = new FakeHiveKube()
        const first = await HiveIdentity.LoadOrCreate(kube, IdentityCases.Namespace)
        const restarted = await HiveIdentity.LoadOrCreate(kube, IdentityCases.Namespace)
        assert.equal(kube.SecretCreates, 1)
        assert.equal(restarted.KeyId, first.KeyId)
        assert.ok(restarted.PublicKey.Equals(first.PublicKey))
        const stored = kube.Secrets.get(FakeHiveKube.Key(IdentityCases.Namespace, HiveIdentity.SecretName))
        assert.deepEqual(Object.keys(stored ?? {}), [HiveIdentity.KeyName])
        assert.match(stored?.[HiveIdentity.KeyName] ?? '', /BEGIN PRIVATE KEY/)
    })

    it('a start that lost the race to create the Secret uses the one that won', async () =>
    {
        const kube = new FakeHiveKube()
        const winner = SigningKeyPair.Generate()
        const original = kube.GetSecretData.bind(kube)
        let calls = 0
        kube.GetSecretData = async (namespace, name) =>
        {
            calls += 1
            if (calls === 1)
            {
                // Absent at the first look; another start creates it before this one does.
                await kube.CreateSecret(namespace, name, { [HiveIdentity.KeyName]: winner.PrivatePem() })
                return undefined
            }
            return original(namespace, name)
        }
        const key = await HiveIdentity.LoadOrCreate(kube, IdentityCases.Namespace)
        assert.equal(key.KeyId, winner.KeyId)
    })

    it('an identity Secret without a usable key is never silently replaced', async () =>
    {
        const kube = new FakeHiveKube()
        kube.Secrets.set(FakeHiveKube.Key(IdentityCases.Namespace, HiveIdentity.SecretName), { [HiveIdentity.KeyName]: 'not a key' })
        await assert.rejects(HiveIdentity.LoadOrCreate(kube, IdentityCases.Namespace), HiveIdentityUnusableError)
        kube.Secrets.set(FakeHiveKube.Key(IdentityCases.Namespace, HiveIdentity.SecretName), {})
        await assert.rejects(HiveIdentity.LoadOrCreate(kube, IdentityCases.Namespace), (error: unknown) => error instanceof HiveIdentityUnusableError && !String(error).includes('BEGIN'))
        assert.equal(kube.SecretCreates, 0)
    })
})
