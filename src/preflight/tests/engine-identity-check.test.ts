import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EngineIdentityCheck } from '../engine-identity-check.js'
import { PreflightOutcome } from '../preflight-check.js'
import { FakeKubeTransport } from './fake-kube.js'

class IdentityFixture
{
    public static readonly Path = '/api/v1/namespaces/pragmatic-system/secrets/pragmatic-tenant-admin-seed'

    public static Seed(tenant: string, hive: string): unknown
    {
        return { data: { 'seed.json': Buffer.from(JSON.stringify({ tenant: { id: tenant }, hives: [{ id: hive }] })).toString('base64') } }
    }

    public static Check(answers: Record<string, unknown>, tenant: string = 'acme', hive: string = 'acme-hive'): EngineIdentityCheck
    {
        return new EngineIdentityCheck(FakeKubeTransport.Client(answers), 'pragmatic-system', tenant, hive)
    }
}

describe('EngineIdentityCheck', () =>
{
    it('passes a new engine and the kept engine installed again', async () =>
    {
        assert.equal((await IdentityFixture.Check({}).Run()).Outcome, PreflightOutcome.Pass)
        const same = await IdentityFixture.Check({ [IdentityFixture.Path]: IdentityFixture.Seed('acme', 'acme-hive') }).Run()
        assert.equal(same.Outcome, PreflightOutcome.Pass)
        assert.match(same.Message, /tenant acme, hive acme-hive/)
    })

    it('fails another tenant or hive over a kept engine, naming both, with the fix', async () =>
    {
        const other = await IdentityFixture.Check({ [IdentityFixture.Path]: IdentityFixture.Seed('acme', 'acme-hive') }, 'other', 'other-hive').Run()
        assert.equal(other.Outcome, PreflightOutcome.Fail)
        assert.match(other.Message, /keeps the engine of tenant acme, hive acme-hive; the install names tenant other, hive other-hive/)
        assert.match(other.Fix, /remove the kept engine/)
        const unreadable = await IdentityFixture.Check({ [IdentityFixture.Path]: { data: { 'seed.json': 'not-base64-json' } } }).Run()
        assert.equal(unreadable.Outcome, PreflightOutcome.Fail)
    })
})
