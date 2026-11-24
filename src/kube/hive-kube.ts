import { InClusterK8sApi } from '../k8s-api.js'

/** A ConfigMap's data and the version an update must name. */
export class KubeConfigMap
{
    public constructor(public readonly Data: Readonly<Record<string, string>>, public readonly ResourceVersion: string)
    {
    }
}

/** What a TokenReview answered about a bearer. */
export class TokenReviewResult
{
    public static readonly Refused = new TokenReviewResult(false, null, [])

    public constructor(public readonly Authenticated: boolean, public readonly Username: string | null, public readonly Audiences: readonly string[])
    {
    }
}

/**
 * The few Kubernetes calls the enrolment needs (C3.3), each scoped by the agent's Role to its own objects: its identity
 * Secret, its enrolment ConfigMap, TokenReviews, and reading the engine's workloads for reports.
 */
export interface IHiveKube
{
    /** The Secret's data, decoded; undefined when it does not exist. */
    GetSecretData(namespace: string, name: string): Promise<Readonly<Record<string, string>> | undefined>
    /** Creates the Secret; false when one of that name exists already (another start raced this one). */
    CreateSecret(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>): Promise<boolean>
    GetConfigMap(namespace: string, name: string): Promise<KubeConfigMap | undefined>
    /** Creates the ConfigMap (no version) or replaces the version given. */
    PutConfigMap(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>, resourceVersion: string | undefined): Promise<void>
    ReviewToken(token: string, audience: string): Promise<TokenReviewResult>
    /** Whether the Deployment (or StatefulSet) has every replica ready; undefined when it does not exist. */
    WorkloadReady(namespace: string, kind: KubeWorkloadKind, name: string): Promise<boolean | undefined>
}

export enum KubeWorkloadKind
{
    Deployment = 'deployments',
    StatefulSet = 'statefulsets',
}

interface IObjectBody
{
    metadata?: { resourceVersion?: string }
    data?: Record<string, string>
    status?: { replicas?: number; readyReplicas?: number; authenticated?: boolean; audiences?: string[]; user?: { username?: string } }
}

/** IHiveKube over the in-cluster API (the agent's service account). */
export class InClusterHiveKube extends InClusterK8sApi implements IHiveKube
{
    private static readonly SecretPath = '/api/v1/namespaces/{ns}/secrets'
    private static readonly ConfigMapPath = '/api/v1/namespaces/{ns}/configmaps'
    private static readonly WorkloadPath = '/apis/apps/v1/namespaces/{ns}/{kind}/{name}'
    private static readonly TokenReviewPath = '/apis/authentication.k8s.io/v1/tokenreviews'
    private static readonly NsToken = '{ns}'
    private static readonly KindToken = '{kind}'
    private static readonly NameToken = '{name}'
    private static readonly PathSeparator = '/'
    private static readonly Get = 'GET'
    private static readonly Post = 'POST'
    private static readonly Put = 'PUT'
    private static readonly Json = 'application/json'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly V1 = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly ConfigMapKind = 'ConfigMap'
    private static readonly OpaqueType = 'Opaque'
    private static readonly TokenReviewApi = 'authentication.k8s.io/v1'
    private static readonly TokenReviewKind = 'TokenReview'
    private static readonly StatusNotFound = 404
    private static readonly Conflict = 409
    private static readonly StatusOkMin = 200
    private static readonly StatusOkMax = 299
    private static readonly KubeFailurePrefix = 'kubernetes API request failed with status '

    public async GetSecretData(namespace: string, name: string): Promise<Readonly<Record<string, string>> | undefined>
    {
        const body = await this.GetObject(InClusterHiveKube.Named(InClusterHiveKube.SecretPath, namespace, name))
        if (body === undefined)
        {
            return undefined
        }
        const decoded: Record<string, string> = {}
        for (const [key, value] of Object.entries(body.data ?? {}))
        {
            decoded[key] = Buffer.from(value, InClusterHiveKube.Base64).toString(InClusterHiveKube.Utf8)
        }
        return decoded
    }

    public async CreateSecret(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>): Promise<boolean>
    {
        const K = InClusterHiveKube
        const encoded: Record<string, string> = {}
        for (const [key, value] of Object.entries(data))
        {
            encoded[key] = Buffer.from(value, K.Utf8).toString(K.Base64)
        }
        const body = { apiVersion: K.V1, kind: K.SecretKind, type: K.OpaqueType, metadata: { name, namespace, labels }, data: encoded }
        const response = await this.Send(K.Post, K.Collection(K.SecretPath, namespace), JSON.stringify(body), K.Json)
        if (response.status === K.Conflict)
        {
            return false
        }
        K.RequireOk(response.status)
        return true
    }

    public async GetConfigMap(namespace: string, name: string): Promise<KubeConfigMap | undefined>
    {
        const body = await this.GetObject(InClusterHiveKube.Named(InClusterHiveKube.ConfigMapPath, namespace, name))
        return body === undefined ? undefined : new KubeConfigMap(body.data ?? {}, body.metadata?.resourceVersion ?? '')
    }

    public async PutConfigMap(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>, resourceVersion: string | undefined): Promise<void>
    {
        const K = InClusterHiveKube
        const metadata = resourceVersion === undefined ? { name, namespace, labels } : { name, namespace, labels, resourceVersion }
        const body = JSON.stringify({ apiVersion: K.V1, kind: K.ConfigMapKind, metadata, data })
        const response = resourceVersion === undefined
            ? await this.Send(K.Post, K.Collection(K.ConfigMapPath, namespace), body, K.Json)
            : await this.Send(K.Put, K.Named(K.ConfigMapPath, namespace, name), body, K.Json)
        K.RequireOk(response.status)
    }

    public async ReviewToken(token: string, audience: string): Promise<TokenReviewResult>
    {
        const K = InClusterHiveKube
        const body = JSON.stringify({ apiVersion: K.TokenReviewApi, kind: K.TokenReviewKind, spec: { token, audiences: [audience] } })
        const response = await this.Send(K.Post, K.TokenReviewPath, body, K.Json)
        K.RequireOk(response.status)
        const status = (JSON.parse(response.body) as IObjectBody).status
        if (status?.authenticated !== true)
        {
            return TokenReviewResult.Refused
        }
        return new TokenReviewResult(true, status.user?.username ?? null, status.audiences ?? [])
    }

    public async WorkloadReady(namespace: string, kind: KubeWorkloadKind, name: string): Promise<boolean | undefined>
    {
        const K = InClusterHiveKube
        const path = K.WorkloadPath.replace(K.NsToken, encodeURIComponent(namespace)).replace(K.KindToken, kind).replace(K.NameToken, encodeURIComponent(name))
        const body = await this.GetObject(path)
        if (body === undefined)
        {
            return undefined
        }
        const replicas = body.status?.replicas ?? 0
        return replicas > 0 && (body.status?.readyReplicas ?? 0) === replicas
    }

    private async GetObject(path: string): Promise<IObjectBody | undefined>
    {
        const K = InClusterHiveKube
        const response = await this.Send(K.Get, path, undefined, K.Json)
        if (response.status === K.StatusNotFound)
        {
            return undefined
        }
        K.RequireOk(response.status)
        return JSON.parse(response.body) as IObjectBody
    }

    private static Collection(template: string, namespace: string): string
    {
        return template.replace(InClusterHiveKube.NsToken, encodeURIComponent(namespace))
    }

    private static Named(template: string, namespace: string, name: string): string
    {
        return InClusterHiveKube.Collection(template, namespace) + InClusterHiveKube.PathSeparator + encodeURIComponent(name)
    }

    private static RequireOk(status: number): void
    {
        if (status < InClusterHiveKube.StatusOkMin || status > InClusterHiveKube.StatusOkMax)
        {
            throw new Error(InClusterHiveKube.KubeFailurePrefix + status)
        }
    }
}
