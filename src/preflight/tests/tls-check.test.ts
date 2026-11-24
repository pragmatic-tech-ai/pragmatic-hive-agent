import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TlsCheck } from '../tls-check.js'
import { PreflightOutcome } from '../preflight-check.js'
import { TlsMode } from '../preflight-settings.js'
import { FakeKubeTransport } from './fake-kube.js'

class TlsFixture
{
    public static readonly Path = '/api/v1/namespaces/pragmatic-system/secrets/console-tls'
    public static readonly Cert = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'console.crt.pem')).toString('base64')
    public static readonly Key = Buffer.from('not-a-real-key').toString('base64')
    public static readonly Hosts = ['console.example.com', 'idp-console.example.com']

    public static Now(): Date
    {
        return new Date('2027-06-01T00:00:00Z')
    }

    public static Check(data: Record<string, string> | undefined, hosts: readonly string[] = TlsFixture.Hosts, now: () => Date = TlsFixture.Now): TlsCheck
    {
        const client = FakeKubeTransport.Client(data === undefined ? {} : { [TlsFixture.Path]: { data } })
        return new TlsCheck(client, 'pragmatic-system', TlsMode.Secret, 'console-tls', hosts, now)
    }
}

describe('TlsCheck', () =>
{
    it('passes a Secret with a current certificate naming every host', async () =>
    {
        const result = await TlsFixture.Check({ 'tls.crt': TlsFixture.Cert, 'tls.key': TlsFixture.Key }).Run()
        assert.equal(result.Outcome, PreflightOutcome.Pass, result.Message)
    })

    it('fails a missing Secret, a missing key and a certificate for other hosts', async () =>
    {
        const missing = await TlsFixture.Check(undefined).Run()
        assert.equal(missing.Outcome, PreflightOutcome.Fail)
        assert.match(missing.Message, /Secret console-tls does not exist in namespace pragmatic-system/)
        assert.match(missing.Fix, /kubectl create secret tls/)
        const noKey = await TlsFixture.Check({ 'tls.crt': TlsFixture.Cert }).Run()
        assert.match(noKey.Message, /lacks tls\.key/)
        const other = await TlsFixture.Check({ 'tls.crt': TlsFixture.Cert, 'tls.key': TlsFixture.Key }, ['console.other.org']).Run()
        assert.equal(other.Outcome, PreflightOutcome.Fail)
        assert.match(other.Message, /does not name console\.other\.org/)
    })

    it('fails an expired certificate', async () =>
    {
        const result = await TlsFixture.Check({ 'tls.crt': TlsFixture.Cert, 'tls.key': TlsFixture.Key }, TlsFixture.Hosts, () => new Date('2040-01-01T00:00:00Z')).Run()
        assert.equal(result.Outcome, PreflightOutcome.Fail)
        assert.match(result.Message, /not valid now/)
    })

    it('warns for self-signed and fails secret mode without a name', async () =>
    {
        const client = FakeKubeTransport.Client({})
        assert.equal((await new TlsCheck(client, 'ns', TlsMode.SelfSigned, undefined, TlsFixture.Hosts).Run()).Outcome, PreflightOutcome.Warn)
        assert.equal((await new TlsCheck(client, 'ns', TlsMode.Secret, undefined, TlsFixture.Hosts).Run()).Outcome, PreflightOutcome.Fail)
    })
})
