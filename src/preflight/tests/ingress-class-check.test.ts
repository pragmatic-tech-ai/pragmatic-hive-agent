import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IngressClassCheck } from '../ingress-class-check.js'
import { PreflightOutcome } from '../preflight-check.js'
import { ConsoleAddress } from '../preflight-settings.js'
import { ClusterFixtures, FakeKubeTransport } from './fake-kube.js'

class IngressFixture
{
    public static Client(...classes: Array<{ name: string; default?: boolean; controller?: string }>): ReturnType<typeof FakeKubeTransport.Client>
    {
        return FakeKubeTransport.Client({ [ClusterFixtures.IngressClasses]: ClusterFixtures.IngressList(...classes) })
    }
}

describe('IngressClassCheck', () =>
{
    it('passes the default ingress-nginx class and names the forwarding requirement', async () =>
    {
        const result = await new IngressClassCheck(IngressFixture.Client({ name: 'nginx', default: true }), undefined, ConsoleAddress.OwnDomain).Run()
        assert.equal(result.Outcome, PreflightOutcome.Pass)
        assert.match(result.Message, /default IngressClass is nginx; .*use-forwarded-headers/)
    })

    it('fails without a default class and with a missing named one', async () =>
    {
        const none = await new IngressClassCheck(IngressFixture.Client({ name: 'nginx' }), undefined, ConsoleAddress.OwnDomain).Run()
        assert.equal(none.Outcome, PreflightOutcome.Fail)
        assert.match(none.Fix, /ingress\.className/)
        const named = await new IngressClassCheck(IngressFixture.Client({ name: 'nginx' }), 'traefik', ConsoleAddress.HiveSubdomain).Run()
        assert.equal(named.Outcome, PreflightOutcome.Fail)
        assert.match(named.Message, /IngressClass traefik does not exist \(the cluster has: nginx\)/)
    })

    it('warns for another controller', async () =>
    {
        const result = await new IngressClassCheck(IngressFixture.Client({ name: 'traefik', controller: 'traefik.io/ingress-controller' }), 'traefik', ConsoleAddress.OwnDomain).Run()
        assert.equal(result.Outcome, PreflightOutcome.Warn)
        assert.match(result.Fix, /ingress-nginx annotations/)
    })

    it('skips a relayed console without asking the cluster', async () =>
    {
        const transport = new FakeKubeTransport({})
        const { KubeApiClient } = await import('@pragmatic-tech-ai/pragmatic-kube')
        const result = await new IngressClassCheck(new KubeApiClient(transport), undefined, ConsoleAddress.RelayedHiveSubdomain).Run()
        assert.equal(result.Outcome, PreflightOutcome.Skip)
        assert.deepEqual(transport.Paths, [])
    })
})
