import { InClusterK8sApi } from '../k8s-api.js'

/** A ConfigMap's data and the version an update must name. */
export class KubeConfigMap
{
    public constructor(public readonly Data: Readonly<Record<string, string>>, public readonly ResourceVersion: string)
    {
    }
}

/** One container of a workload's pod template: its name and image. */
export class KubeContainer
{
    public constructor(public readonly Name: string, public readonly Image: string)
    {
    }
}

/** A Deployment's or StatefulSet's pod template containers and rollout status. */
export class KubeWorkload
{
    public constructor(
        public readonly Containers: readonly KubeContainer[],
        public readonly Generation: number,
        public readonly ObservedGeneration: number,
        public readonly Replicas: number,
        public readonly UpdatedReplicas: number,
        public readonly ReadyReplicas: number)
    {
    }

    /** Whether the controller has rolled the current template out: observed, every replica updated and ready. */
    public get RolledOut(): boolean
    {
        return this.ObservedGeneration >= this.Generation && this.UpdatedReplicas >= this.Replicas && this.ReadyReplicas >= this.Replicas
    }

    /** Whether every replica is ready (whatever template). */
    public get Ready(): boolean
    {
        return this.Replicas > 0 && this.ReadyReplicas >= this.Replicas
    }

    /** The named container, or the first when no name is given. */
    public Container(name: string | undefined): KubeContainer | undefined
    {
        return name === undefined ? this.Containers[0] : this.Containers.find(container => container.Name === name)
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
    /** Deletes the Secret; done when it is gone, also when it was never there. */
    DeleteSecret(namespace: string, name: string): Promise<void>
    GetConfigMap(namespace: string, name: string): Promise<KubeConfigMap | undefined>
    /** Creates the ConfigMap (no version) or replaces the version given. */
    PutConfigMap(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>, resourceVersion: string | undefined): Promise<void>
    ReviewToken(token: string, audience: string): Promise<TokenReviewResult>
    /** Whether the Deployment (or StatefulSet) has every replica ready; undefined when it does not exist. */
    WorkloadReady(namespace: string, kind: KubeWorkloadKind, name: string): Promise<boolean | undefined>
    /** The workload's template containers and rollout status; undefined when it does not exist (C3.4). */
    GetWorkload(namespace: string, kind: KubeWorkloadKind, name: string): Promise<KubeWorkload | undefined>
    /** A strategic-merge patch of the workload (an image, a restart annotation). */
    PatchWorkload(namespace: string, kind: KubeWorkloadKind, name: string, patch: object): Promise<void>
    /** Replaces the Secret's data (its own identity Secret only, by the agent's Role). */
    ReplaceSecret(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>): Promise<void>
}

export enum KubeWorkloadKind
{
    Deployment = 'deployments',
    StatefulSet = 'statefulsets',
}

interface IObjectBody
{
    metadata?: { resourceVersion?: string; generation?: number }
    data?: Record<string, string>
    spec?: { replicas?: number; template?: { spec?: { containers?: { name?: string; image?: string }[] } } }
    status?: { replicas?: number; readyReplicas?: number; updatedReplicas?: number; observedGeneration?: number; authenticated?: boolean; audiences?: string[]; user?: { username?: string } }
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
    private static readonly Delete = 'DELETE'
    private static readonly Patch = 'PATCH'
    private static readonly StrategicMerge = 'application/strategic-merge-patch+json'
    private static readonly NoText = ''
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

    public async DeleteSecret(namespace: string, name: string): Promise<void>
    {
        const K = InClusterHiveKube
        const response = await this.Send(K.Delete, K.Named(K.SecretPath, namespace, name), undefined, K.Json)
        if (response.status === K.StatusNotFound)
        {
            return
        }
        K.RequireOk(response.status)
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
        const body = await this.GetObject(K.WorkloadOf(namespace, kind, name))
        if (body === undefined)
        {
            return undefined
        }
        const replicas = body.status?.replicas ?? 0
        return replicas > 0 && (body.status?.readyReplicas ?? 0) === replicas
    }

    public async GetWorkload(namespace: string, kind: KubeWorkloadKind, name: string): Promise<KubeWorkload | undefined>
    {
        const K = InClusterHiveKube
        const body = await this.GetObject(K.WorkloadOf(namespace, kind, name))
        if (body === undefined)
        {
            return undefined
        }
        const containers = (body.spec?.template?.spec?.containers ?? []).map(container => new KubeContainer(container.name ?? K.NoText, container.image ?? K.NoText))
        const status = body.status ?? {}
        return new KubeWorkload(containers, body.metadata?.generation ?? 0, status.observedGeneration ?? 0, body.spec?.replicas ?? 1, status.updatedReplicas ?? 0, status.readyReplicas ?? 0)
    }

    public async PatchWorkload(namespace: string, kind: KubeWorkloadKind, name: string, patch: object): Promise<void>
    {
        const K = InClusterHiveKube
        const response = await this.Send(K.Patch, K.WorkloadOf(namespace, kind, name), JSON.stringify(patch), K.StrategicMerge)
        K.RequireOk(response.status)
    }

    public async ReplaceSecret(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>): Promise<void>
    {
        const K = InClusterHiveKube
        const path = K.Named(K.SecretPath, namespace, name)
        const current = await this.GetObject(path)
        const encoded: Record<string, string> = {}
        for (const [key, value] of Object.entries(data))
        {
            encoded[key] = Buffer.from(value, K.Utf8).toString(K.Base64)
        }
        const metadata = { name, namespace, labels, resourceVersion: current?.metadata?.resourceVersion }
        const response = await this.Send(K.Put, path, JSON.stringify({ apiVersion: K.V1, kind: K.SecretKind, type: K.OpaqueType, metadata, data: encoded }), K.Json)
        K.RequireOk(response.status)
    }

    private static WorkloadOf(namespace: string, kind: KubeWorkloadKind, name: string): string
    {
        const K = InClusterHiveKube
        return K.WorkloadPath.replace(K.NsToken, encodeURIComponent(namespace)).replace(K.KindToken, kind).replace(K.NameToken, encodeURIComponent(name))
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
