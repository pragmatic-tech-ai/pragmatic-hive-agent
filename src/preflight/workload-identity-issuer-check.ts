import type { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { BoundedFetch } from '../bounded-fetch.js'
import { PreflightResults, type IPreflightCheck, type PreflightResult } from './preflight-check.js'

/** The realm secrets option the engine is installed with (chart value `realmSecrets.option`). */
export enum RealmSecretsChoice
{
    Custom = 'custom',
    Gcp = 'gcp',
    Azure = 'azure',
    Aws = 'aws',
}

/** A JSON document fetched from the public internet: its status and parsed body (undefined when it is not JSON). */
export type PublicDocument = { readonly Status: number; readonly Body: unknown }

/** Fetches a public document with the system's trust store only (never the cluster's CA). */
export interface IPublicFetch
{
    Json(url: string): Promise<PublicDocument>
}

/** `fetch` over the public internet, bounded by one deadline. */
export class HttpPublicFetch implements IPublicFetch
{
    private static readonly TimeoutMs = 10000
    private static readonly Accept = { accept: 'application/json' }
    private static readonly Get = 'GET'
    private static readonly NoRedirect: RequestRedirect = 'error'

    public async Json(url: string): Promise<PublicDocument>
    {
        return await BoundedFetch.Run(url, { method: HttpPublicFetch.Get, headers: HttpPublicFetch.Accept, redirect: HttpPublicFetch.NoRedirect }, HttpPublicFetch.TimeoutMs, async response =>
        {
            const text = await response.text()
            let body: unknown
            try
            {
                body = JSON.parse(text)
            }
            catch
            {
                body = undefined
            }
            return { Status: response.status, Body: body }
        })
    }
}

type Discovery = { issuer?: unknown; jwks_uri?: unknown }

/**
 * Azure and AWS fetch the cluster's service-account issuer discovery document from the public internet when a hive's
 * component exchanges its projected token (2.5); Google accepts an uploaded JWKS, and the custom home needs no workload
 * identity. So for azure and aws the issuer the API server names (`/.well-known/openid-configuration`) must be an https
 * URL on a public name whose discovery document, fetched with the public trust store only, names the same issuer and a
 * `jwks_uri` that answers with keys. A self-managed cluster on its default issuer (`https://kubernetes.default.svc`) fails
 * here, naming the issuer, before anything is installed.
 */
export class WorkloadIdentityIssuerCheck implements IPreflightCheck
{
    public static readonly CheckName = 'workload-identity-issuer'
    private static readonly DiscoveryPath = '/.well-known/openid-configuration'
    private static readonly Https = 'https:'
    private static readonly Slash = /\/+$/
    private static readonly InternalNames = /(^localhost$)|(\.localhost$)|(\.svc$)|(\.svc\.cluster\.local$)|(\.cluster\.local$)|(\.local$)|(\.internal$)|(^kubernetes(\.default)?$)/
    /** Loopback, private, link-local, carrier-grade NAT and unspecified IPv4; loopback, unique-local and link-local IPv6. */
    private static readonly PrivateAddresses = /^(0\.|10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1?\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe[89ab][0-9a-f]:)/i
    private static readonly Ok = 200
    private static readonly Empty = ''
    private static readonly CustomSkip = 'the custom realm secrets home is in this cluster: no workload identity'
    private static readonly GcpSkip = 'Google accepts the cluster\'s uploaded JWKS (the provider names it): no public issuer needed'
    private static readonly NoIssuer = 'the API server names no service-account issuer (/.well-known/openid-configuration)'
    private static readonly IssuerPrefix = 'the service-account issuer '
    private static readonly NotHttps = ' is not an https URL'
    private static readonly NotPublic = ' is not a public name'
    private static readonly Unfetchable = ' does not publish its discovery document publicly (status '
    private static readonly Mismatch = '\'s public discovery document names another issuer'
    private static readonly NoKeys = '\'s public jwks_uri answers no keys'
    private static readonly Close = ')'
    private static readonly Unreachable = ' could not be fetched publicly: '
    private static readonly PassInfix = ' is public; '
    private static readonly PassSuffix = ' can exchange this cluster\'s projected tokens'
    private static readonly Fix = 'Publish the cluster\'s service-account issuer on a public https URL (kube-apiserver --service-account-issuer and --service-account-jwks-uri, serving /.well-known/openid-configuration and the keys), or use a managed cluster (AKS, EKS) whose issuer is public; runbook customer-cluster.md, section workload identity.'

    public readonly Name = WorkloadIdentityIssuerCheck.CheckName

    public constructor(private readonly client: KubeApiClient, private readonly option: RealmSecretsChoice, private readonly fetcher: IPublicFetch = new HttpPublicFetch())
    {
    }

    public async Run(): Promise<PreflightResult>
    {
        const W = WorkloadIdentityIssuerCheck
        if (this.option === RealmSecretsChoice.Custom) return PreflightResults.Skip(W.CheckName, W.CustomSkip)
        if (this.option === RealmSecretsChoice.Gcp) return PreflightResults.Skip(W.CheckName, W.GcpSkip)
        const own = await this.client.Get(W.DiscoveryPath) as Discovery | undefined
        const issuer = typeof own?.issuer === 'string' ? own.issuer : undefined
        if (issuer === undefined) return PreflightResults.Fail(W.CheckName, W.NoIssuer, W.Fix)
        let url: URL
        try
        {
            url = new URL(issuer)
        }
        catch
        {
            return PreflightResults.Fail(W.CheckName, W.IssuerPrefix + issuer + W.NotHttps, W.Fix)
        }
        if (url.protocol !== W.Https) return PreflightResults.Fail(W.CheckName, W.IssuerPrefix + issuer + W.NotHttps, W.Fix)
        if (W.InternalNames.test(url.hostname) || W.PrivateAddresses.test(url.hostname)) return PreflightResults.Fail(W.CheckName, W.IssuerPrefix + issuer + W.NotPublic, W.Fix)
        try
        {
            const discovery = await this.fetcher.Json(issuer.replace(W.Slash, W.Empty) + W.DiscoveryPath)
            if (discovery.Status !== W.Ok) return PreflightResults.Fail(W.CheckName, W.IssuerPrefix + issuer + W.Unfetchable + discovery.Status + W.Close, W.Fix)
            const published = discovery.Body as Discovery | undefined
            if (published?.issuer !== issuer || typeof published.jwks_uri !== 'string') return PreflightResults.Fail(W.CheckName, W.IssuerPrefix + issuer + W.Mismatch, W.Fix)
            const keys = await this.fetcher.Json(published.jwks_uri)
            const list = (keys.Body as { keys?: unknown } | undefined)?.keys
            if (keys.Status !== W.Ok || !Array.isArray(list) || list.length === 0) return PreflightResults.Fail(W.CheckName, W.IssuerPrefix + issuer + W.NoKeys, W.Fix)
        }
        catch (error)
        {
            return PreflightResults.Fail(W.CheckName, W.IssuerPrefix + issuer + W.Unreachable + (error instanceof Error ? error.message : String(error)), W.Fix)
        }
        return PreflightResults.Pass(W.CheckName, W.IssuerPrefix + issuer + W.PassInfix + this.option + W.PassSuffix)
    }
}
