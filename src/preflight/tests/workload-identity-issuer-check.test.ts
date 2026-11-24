import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PreflightOutcome } from '../preflight-check.js'
import { PreflightSettings } from '../preflight-settings.js'
import { RealmSecretsChoice, WorkloadIdentityIssuerCheck, type IPublicFetch, type PublicDocument } from '../workload-identity-issuer-check.js'
import { FakeKubeTransport } from './fake-kube.js'

/** Public documents by URL (404 for anything else); records every URL asked; `failing` throws as a network error. */
class FakePublicFetch implements IPublicFetch
{
    public readonly Asked: string[] = []

    public constructor(private readonly documents: Record<string, PublicDocument>, private readonly failing: boolean = false)
    {
    }

    public async Json(url: string): Promise<PublicDocument>
    {
        this.Asked.push(url)
        if (this.failing) throw new Error('getaddrinfo ENOTFOUND')
        return this.documents[url] ?? { Status: 404, Body: undefined }
    }
}

class IssuerFixture
{
    public static readonly Issuer = 'https://oidc.example.com/hives/acme'
    public static readonly Jwks = 'https://oidc.example.com/hives/acme/keys'

    public static Public(): FakePublicFetch
    {
        const I = IssuerFixture
        return new FakePublicFetch({
            [I.Issuer + '/.well-known/openid-configuration']: { Status: 200, Body: { issuer: I.Issuer, jwks_uri: I.Jwks } },
            [I.Jwks]: { Status: 200, Body: { keys: [{ kty: 'RSA', kid: 'k1', n: 'AQAB', e: 'AQAB' }] } },
        })
    }

    public static async Run(option: RealmSecretsChoice, issuer: string | undefined, fetcher: FakePublicFetch = IssuerFixture.Public())
    {
        const answers = issuer === undefined ? {} : { '/.well-known/openid-configuration': { issuer, jwks_uri: issuer + '/openid/v1/jwks' } }
        return await new WorkloadIdentityIssuerCheck(FakeKubeTransport.Client(answers), option, fetcher).Run()
    }
}

describe('WorkloadIdentityIssuerCheck', () =>
{
    it('skips the custom home and gcp (an uploaded JWKS), fetching nothing', async () =>
    {
        const fetcher = IssuerFixture.Public()
        assert.equal((await IssuerFixture.Run(RealmSecretsChoice.Custom, undefined, fetcher)).Outcome, PreflightOutcome.Skip)
        assert.equal((await IssuerFixture.Run(RealmSecretsChoice.Gcp, 'https://kubernetes.default.svc.cluster.local', fetcher)).Outcome, PreflightOutcome.Skip)
        assert.deepEqual(fetcher.Asked, [])
    })

    it('passes azure and aws on a public issuer whose discovery document and keys answer publicly', async () =>
    {
        for (const option of [RealmSecretsChoice.Azure, RealmSecretsChoice.Aws])
        {
            const result = await IssuerFixture.Run(option, IssuerFixture.Issuer)
            assert.equal(result.Outcome, PreflightOutcome.Pass, result.Message)
            assert.match(result.Message, new RegExp(option))
        }
    })

    it('a self-managed cluster on its default issuer is refused naming the issuer, before any fetch', async () =>
    {
        const fetcher = IssuerFixture.Public()
        const result = await IssuerFixture.Run(RealmSecretsChoice.Azure, 'https://kubernetes.default.svc.cluster.local', fetcher)
        assert.equal(result.Outcome, PreflightOutcome.Fail)
        assert.match(result.Message, /https:\/\/kubernetes\.default\.svc\.cluster\.local is not a public name/)
        assert.match(result.Fix, /service-account-issuer/)
        assert.deepEqual(fetcher.Asked, [])
        assert.match((await IssuerFixture.Run(RealmSecretsChoice.Aws, 'https://10.0.0.1:6443')).Message, /not a public name/)
        assert.match((await IssuerFixture.Run(RealmSecretsChoice.Aws, 'http://oidc.example.com')).Message, /not an https URL/)
        for (const internal of ['https://kubernetes.default.svc.', 'https://issuer', 'https://[::ffff:a00:1]', 'https://100.64.0.1', 'https://100.127.255.1', 'https://0.0.0.0', 'https://[fe80::1]', 'https://api.localhost', 'https://[::1]'])
        {
            assert.match((await IssuerFixture.Run(RealmSecretsChoice.Aws, internal, fetcher)).Message, /not a public name/, internal)
        }
        assert.deepEqual(fetcher.Asked, [], 'never fetched')
        const internalKeys = new FakePublicFetch({ [IssuerFixture.Issuer + '/.well-known/openid-configuration']: { Status: 200, Body: { issuer: IssuerFixture.Issuer, jwks_uri: 'https://10.0.0.1:6443/openid/v1/jwks' } } })
        assert.match((await IssuerFixture.Run(RealmSecretsChoice.Azure, IssuerFixture.Issuer, internalKeys)).Message, /jwks_uri that is not a public https URL/)
        assert.deepEqual(internalKeys.Asked, [IssuerFixture.Issuer + '/.well-known/openid-configuration'], 'the internal keys are never fetched')
        assert.equal((await IssuerFixture.Run(RealmSecretsChoice.Aws, 'https://100.128.0.1')).Outcome, PreflightOutcome.Fail, 'a public address is fetched (and here not found)')
    })

    it('an issuer whose document is not public, names another issuer, has no keys or is unreachable fails', async () =>
    {
        const I = IssuerFixture
        assert.match((await I.Run(RealmSecretsChoice.Aws, 'https://private.example.com')).Message, /does not publish its discovery document publicly \(status 404\)/)
        const other = new FakePublicFetch({ [I.Issuer + '/.well-known/openid-configuration']: { Status: 200, Body: { issuer: 'https://elsewhere.example.com', jwks_uri: I.Jwks } } })
        assert.match((await I.Run(RealmSecretsChoice.Aws, I.Issuer, other)).Message, /names another issuer/)
        const empty = new FakePublicFetch({
            [I.Issuer + '/.well-known/openid-configuration']: { Status: 200, Body: { issuer: I.Issuer, jwks_uri: I.Jwks } },
            [I.Jwks]: { Status: 200, Body: { keys: [] } },
        })
        assert.match((await I.Run(RealmSecretsChoice.Azure, I.Issuer, empty)).Message, /answers no keys/)
        const down = await I.Run(RealmSecretsChoice.Azure, I.Issuer, new FakePublicFetch({}, true))
        assert.equal(down.Outcome, PreflightOutcome.Fail)
        assert.match(down.Message, /could not be fetched publicly/)
    })

    it('fails when the API server names no issuer', async () =>
    {
        assert.equal((await IssuerFixture.Run(RealmSecretsChoice.Aws, undefined)).Outcome, PreflightOutcome.Fail)
    })

    it('reads the option from the chart (custom by default) and refuses an unknown one', () =>
    {
        const base = { PRAGMATIC_PREFLIGHT_NAMESPACE: 'pragmatic-system', PRAGMATIC_PREFLIGHT_CONSOLE_HOST: 'c.example.com' }
        assert.equal(PreflightSettings.From(base).RealmSecrets, RealmSecretsChoice.Custom)
        assert.equal(PreflightSettings.From({ ...base, PRAGMATIC_PREFLIGHT_REALM_SECRETS_OPTION: 'aws' }).RealmSecrets, RealmSecretsChoice.Aws)
        assert.throws(() => PreflightSettings.From({ ...base, PRAGMATIC_PREFLIGHT_REALM_SECRETS_OPTION: 'vault' }), /unknown value/)
    })
})
