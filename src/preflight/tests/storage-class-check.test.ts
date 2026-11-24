import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StorageClassCheck } from '../storage-class-check.js'
import { PreflightOutcome } from '../preflight-check.js'
import { ClusterFixtures, FakeKubeTransport } from './fake-kube.js'

class StorageFixture
{
    public static Client(...classes: Array<{ name: string; default?: boolean }>): ReturnType<typeof FakeKubeTransport.Client>
    {
        return FakeKubeTransport.Client({ [ClusterFixtures.StorageClasses]: ClusterFixtures.StorageList(...classes) })
    }
}

describe('StorageClassCheck', () =>
{
    it('passes the default class when none is named', async () =>
    {
        const result = await new StorageClassCheck(StorageFixture.Client({ name: 'fast' }, { name: 'standard', default: true }), undefined).Run()
        assert.equal(result.Outcome, PreflightOutcome.Pass)
        assert.match(result.Message, /default StorageClass is standard/)
    })

    it('fails without a default class, naming the classes and the fix', async () =>
    {
        const result = await new StorageClassCheck(StorageFixture.Client({ name: 'fast' }), undefined).Run()
        assert.equal(result.Outcome, PreflightOutcome.Fail)
        assert.match(result.Message, /no default StorageClass.*has: fast/)
        assert.match(result.Fix, /is-default-class=true.*storage\.className/)
    })

    it('passes a named class that exists and fails one that does not', async () =>
    {
        assert.equal((await new StorageClassCheck(StorageFixture.Client({ name: 'fast' }), 'fast').Run()).Outcome, PreflightOutcome.Pass)
        const missing = await new StorageClassCheck(StorageFixture.Client(), 'fast').Run()
        assert.equal(missing.Outcome, PreflightOutcome.Fail)
        assert.match(missing.Message, /StorageClass fast does not exist \(the cluster has: none\)/)
    })
})
