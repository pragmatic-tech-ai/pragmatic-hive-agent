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

/** The replica counts of a workload's status and spec. */
export class KubeReplicas
{
    public constructor(
        /** spec.replicas: what the workload should run. */
        public readonly Desired: number,
        /** status.replicas: every pod it runs, old and new (a surge counts both). */
        public readonly Current: number,
        public readonly Updated: number,
        public readonly Ready: number,
        public readonly Available: number)
    {
    }
}

/** A Deployment's or StatefulSet's pod template containers and rollout status. */
export class KubeWorkload
{
    public constructor(
        public readonly Containers: readonly KubeContainer[],
        public readonly InitContainers: readonly KubeContainer[],
        public readonly Generation: number,
        public readonly ObservedGeneration: number,
        public readonly Replicas: KubeReplicas)
    {
    }

    /**
     * Whether the controller has rolled the current template out, by `kubectl rollout status`'s rule: observed, every
     * desired replica updated, no old replica left (under maxSurge the old pod still counts, so a stuck surge never reads
     * as rolled out) and every updated one available.
     */
    public get RolledOut(): boolean
    {
        const r = this.Replicas
        return this.ObservedGeneration >= this.Generation && r.Updated === r.Desired && r.Current === r.Updated && r.Available >= r.Updated
    }

    /** Whether every desired replica is ready (whatever template). */
    public get Ready(): boolean
    {
        return this.Replicas.Desired > 0 && this.Replicas.Ready >= this.Replicas.Desired
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
    /** Creates the ConfigMap (no version) or replaces the version given; answers the new version. KubeConflictError when the
     *  version is not the current one. */
    PutConfigMap(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>, resourceVersion: string | undefined): Promise<string>
    /** The Lease, or undefined (C3.4: one agent pod applies intents at a time). */
    GetLease(namespace: string, name: string): Promise<KubeLease | undefined>
    /** Creates (no version) or replaces the Lease; KubeConflictError when another holder wrote it first. */
    PutLease(namespace: string, name: string, lease: KubeLease, labels: Readonly<Record<string, string>>): Promise<void>
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

/** A coordination.k8s.io Lease: who holds it, when they renewed it, for how long; its version. */
export class KubeLease
{
    private static readonly NoHolder = ''
    private static readonly MsPerSecond = 1000

    public constructor(public readonly Holder: string, public readonly RenewedAt: Date, public readonly DurationSeconds: number, public readonly ResourceVersion: string | undefined)
    {
    }

    /** Whether the holder's renewal has run out at `now`. */
    public ExpiredAt(now: Date): boolean
    {
        return this.Holder === KubeLease.NoHolder || this.RenewedAt.getTime() + this.DurationSeconds * KubeLease.MsPerSecond <= now.getTime()
    }
}

/** A write that named a resourceVersion that is no longer the current one (HTTP 409). */
export class KubeConflictError extends Error
{
    private static readonly ErrorName = 'KubeConflictError'
    private static readonly Text = 'kubernetes API request failed with status 409'

    public constructor()
    {
        super(KubeConflictError.Text)
        this.name = KubeConflictError.ErrorName
    }
}

export enum KubeWorkloadKind
{
    Deployment = 'deployments',
    StatefulSet = 'statefulsets',
}

interface IContainerBody
{
    name?: string
    image?: string
}

interface IObjectBody
{
    metadata?: { resourceVersion?: string; generation?: number }
    data?: Record<string, string>
    spec?: {
        replicas?: number; template?: { spec?: { containers?: IContainerBody[]; initContainers?: IContainerBody[] } }
        holderIdentity?: string; renewTime?: string; leaseDurationSeconds?: number
    }
    status?: { replicas?: number; readyReplicas?: number; updatedReplicas?: number; availableReplicas?: number; observedGeneration?: number; authenticated?: boolean; audiences?: string[]; user?: { username?: string } }
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
    private static readonly LeasePath = '/apis/coordination.k8s.io/v1/namespaces/{ns}/leases'
    private static readonly LeaseApi = 'coordination.k8s.io/v1'
    private static readonly LeaseKind = 'Lease'
    /** A Lease's renewTime is a MicroTime: six fractional digits. */
    private static readonly MillisPattern = /(\.\d{3})Z$/
    private static readonly MicrosSuffix = '$1000Z'
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

    public async PutConfigMap(namespace: string, name: string, data: Readonly<Record<string, string>>, labels: Readonly<Record<string, string>>, resourceVersion: string | undefined): Promise<string>
    {
        const K = InClusterHiveKube
        const metadata = resourceVersion === undefined ? { name, namespace, labels } : { name, namespace, labels, resourceVersion }
        const body = JSON.stringify({ apiVersion: K.V1, kind: K.ConfigMapKind, metadata, data })
        const response = resourceVersion === undefined
            ? await this.Send(K.Post, K.Collection(K.ConfigMapPath, namespace), body, K.Json)
            : await this.Send(K.Put, K.Named(K.ConfigMapPath, namespace, name), body, K.Json)
        K.RequireOk(response.status)
        return (JSON.parse(response.body) as IObjectBody).metadata?.resourceVersion ?? K.NoText
    }

    public async GetLease(namespace: string, name: string): Promise<KubeLease | undefined>
    {
        const K = InClusterHiveKube
        const body = await this.GetObject(K.Named(K.LeasePath, namespace, name))
        if (body === undefined)
        {
            return undefined
        }
        const renewed = new Date(body.spec?.renewTime ?? 0)
        return new KubeLease(body.spec?.holderIdentity ?? K.NoText, Number.isNaN(renewed.getTime()) ? new Date(0) : renewed, body.spec?.leaseDurationSeconds ?? 0, body.metadata?.resourceVersion)
    }

    public async PutLease(namespace: string, name: string, lease: KubeLease, labels: Readonly<Record<string, string>>): Promise<void>
    {
        const K = InClusterHiveKube
        const metadata = lease.ResourceVersion === undefined ? { name, namespace, labels } : { name, namespace, labels, resourceVersion: lease.ResourceVersion }
        const body = JSON.stringify({
            apiVersion: K.LeaseApi, kind: K.LeaseKind, metadata,
            spec: { holderIdentity: lease.Holder, renewTime: lease.RenewedAt.toISOString().replace(K.MillisPattern, K.MicrosSuffix), leaseDurationSeconds: lease.DurationSeconds },
        })
        const response = lease.ResourceVersion === undefined
            ? await this.Send(K.Post, K.Collection(K.LeasePath, namespace), body, K.Json)
            : await this.Send(K.Put, K.Named(K.LeasePath, namespace, name), body, K.Json)
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
        const read = (list: IContainerBody[] | undefined): KubeContainer[] => (list ?? []).map(container => new KubeContainer(container.name ?? K.NoText, container.image ?? K.NoText))
        const status = body.status ?? {}
        const replicas = new KubeReplicas(body.spec?.replicas ?? 1, status.replicas ?? 0, status.updatedReplicas ?? 0, status.readyReplicas ?? 0, status.availableReplicas ?? 0)
        return new KubeWorkload(read(body.spec?.template?.spec?.containers), read(body.spec?.template?.spec?.initContainers), body.metadata?.generation ?? 0, status.observedGeneration ?? 0, replicas)
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
        if (status === InClusterHiveKube.Conflict)
        {
            throw new KubeConflictError()
        }
        if (status < InClusterHiveKube.StatusOkMin || status > InClusterHiveKube.StatusOkMax)
        {
            throw new Error(InClusterHiveKube.KubeFailurePrefix + status)
        }
    }
}
