import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DnsNameCheck, type IHostResolver } from '../dns-name-check.js'
import { PreflightOutcome } from '../preflight-check.js'
import { ConsoleAddress } from '../preflight-settings.js'

class KnownHosts implements IHostResolver
{
    public readonly Asked: string[] = []

    public constructor(private readonly known: readonly string[])
    {
    }

    public Resolves(host: string): Promise<boolean>
    {
        this.Asked.push(host)
        return Promise.resolve(this.known.includes(host))
    }
}

class DnsFixture
{
    public static readonly Console = 'console.example.com'
    public static readonly Idp = 'idp-console.example.com'
    public static readonly Both = [DnsFixture.Console, DnsFixture.Idp]
}

describe('DnsNameCheck', () =>
{
    it('passes when every published host resolves on an own domain', async () =>
    {
        const result = await new DnsNameCheck(DnsFixture.Both, ConsoleAddress.OwnDomain, new KnownHosts(DnsFixture.Both)).Run()
        assert.equal(result.Outcome, PreflightOutcome.Pass)
    })

    it('fails naming the hosts that do not resolve, with the record fix', async () =>
    {
        const result = await new DnsNameCheck(DnsFixture.Both, ConsoleAddress.OwnDomain, new KnownHosts([DnsFixture.Console])).Run()
        assert.equal(result.Outcome, PreflightOutcome.Fail)
        assert.match(result.Message, /does not resolve: idp-console\.example\.com$/)
        assert.match(result.Fix, /DNS records/)
    })

    it('warns published at enrolment for a hive subdomain, resolved or relayed, without resolving', async () =>
    {
        for (const address of [ConsoleAddress.HiveSubdomain, ConsoleAddress.RelayedHiveSubdomain])
        {
            const resolver = new KnownHosts([])
            const result = await new DnsNameCheck(['c.hives.example.com'], address, resolver).Run()
            assert.equal(result.Outcome, PreflightOutcome.Warn)
            assert.match(result.Message, /published at enrolment/)
            assert.deepEqual(resolver.Asked, [])
        }
    })
})
