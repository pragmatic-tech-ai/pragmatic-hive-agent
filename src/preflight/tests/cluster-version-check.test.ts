import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ClusterVersionCheck } from '../cluster-version-check.js'
import { PreflightOutcome } from '../preflight-check.js'
import { ClusterFixtures, FakeKubeTransport } from './fake-kube.js'

class VersionFixture
{
    public static async Outcome(major: string, minor: string): Promise<{ Outcome: PreflightOutcome; Message: string; Fix: string }>
    {
        return await new ClusterVersionCheck(FakeKubeTransport.Client({ [ClusterFixtures.VersionPath]: ClusterFixtures.Version(major, minor) })).Run()
    }
}

describe('ClusterVersionCheck', () =>
{
    it('passes 1.29, 1.31 and a managed 1.30+', async () =>
    {
        assert.equal((await VersionFixture.Outcome('1', '29')).Outcome, PreflightOutcome.Pass)
        assert.equal((await VersionFixture.Outcome('1', '31')).Outcome, PreflightOutcome.Pass)
        const managed = await VersionFixture.Outcome('1', '30+')
        assert.equal(managed.Outcome, PreflightOutcome.Pass)
        assert.match(managed.Message, /Kubernetes 1\.30/)
    })

    it('fails 1.28 with the upgrade fix', async () =>
    {
        const result = await VersionFixture.Outcome('1', '28')
        assert.equal(result.Outcome, PreflightOutcome.Fail)
        assert.match(result.Message, /1\.28; the engine needs 1\.29 or later/)
        assert.match(result.Fix, /Upgrade the cluster/)
    })

    it('fails when the version is unreadable', async () =>
    {
        const result = await new ClusterVersionCheck(FakeKubeTransport.Client({ [ClusterFixtures.VersionPath]: {} })).Run()
        assert.equal(result.Outcome, PreflightOutcome.Fail)
    })
})
