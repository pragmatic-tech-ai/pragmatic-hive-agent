import { KubeConfigMap, KubeConflictError, KubeContainer, KubeLease, KubeReplicas, KubeWorkload, TokenReviewResult, type IHiveKube, type KubeWorkloadKind } from '../hive-kube.js'

/** A token the fake TokenReview knows: who it authenticates as, for which audiences. */
export class FakeToken
{
    public constructor(public readonly Username: string, public readonly Audiences: readonly string[])
    {
    }
}

/**
 * A workload in the fake, rolling as a Deployment with maxSurge 1 and maxUnavailable 0 does: a changed template that
 * never readies leaves one new, unready pod beside the old ready ones (status.replicas = desired + 1, one updated), so
 * the old pods keep serving and the roll never completes; a template put back to the original one is the old pods again.
 */
export class FakeWorkload
{
    public Generation = 1
    public ObservedGeneration = 1
    /** Every replica of the running template is ready (false: the pods are broken, whatever the template). */
    public Ready = true
    /** A template other than the original one never readies (the new pod fails). */
    public NeverReadies = false
    public readonly Patches: object[] = []
    public RestartedAt: string | undefined
    private readonly original: string

    public constructor(public readonly Containers: KubeContainer[], public readonly InitContainers: KubeContainer[] = [], public readonly Replicas: number = 1)
    {
        this.original = this.Template()
    }

    public Snapshot(): KubeWorkload
    {
        const d = this.Replicas
        const stuck = this.NeverReadies && this.Template() !== this.original
        const ready = this.Ready ? d : 0
        const replicas = stuck ? new KubeReplicas(d, d + 1, 1, ready, ready) : new KubeReplicas(d, d, d, ready, ready)
        return new KubeWorkload([...this.Containers], [...this.InitContainers], this.Generation, this.ObservedGeneration, replicas)
    }

    private Template(): string
    {
        return JSON.stringify([this.Containers, this.InitContainers])
    }
}

/** IHiveKube in memory: Secrets, ConfigMaps (with versions), known tokens and workload readiness. */
export class FakeHiveKube implements IHiveKube
{
    public readonly Secrets = new Map<string, Record<string, string>>()
    public readonly ConfigMaps = new Map<string, KubeConfigMap>()
    public readonly Tokens = new Map<string, FakeToken>()
    public readonly Workloads = new Map<string, boolean>()
    public readonly Reviewed: string[] = []
    public readonly Objects = new Map<string, FakeWorkload>()
    /** Every patch in order, as `<kind>/<name>`. */
    public readonly PatchLog: string[] = []
    public SecretCreates = 0
    private version = 0

    public static Key(namespace: string, name: string): string
    {
        return namespace + '/' + name
    }

    public async GetSecretData(namespace: string, name: string): Promise<Readonly<Record<string, string>> | undefined>
    {
        return this.Secrets.get(FakeHiveKube.Key(namespace, name))
    }

    public async CreateSecret(namespace: string, name: string, data: Readonly<Record<string, string>>): Promise<boolean>
    {
        const key = FakeHiveKube.Key(namespace, name)
        if (this.Secrets.has(key))
        {
            return false
        }
        this.SecretCreates += 1
        this.Secrets.set(key, { ...data })
        return true
    }

    public async DeleteSecret(namespace: string, name: string): Promise<void>
    {
        this.Secrets.delete(FakeHiveKube.Key(namespace, name))
    }

    public async GetConfigMap(namespace: string, name: string): Promise<KubeConfigMap | undefined>
    {
        return this.ConfigMaps.get(FakeHiveKube.Key(namespace, name))
    }

    public async PutConfigMap(namespace: string, name: string, data: Readonly<Record<string, string>>, _labels: Readonly<Record<string, string>>, resourceVersion: string | undefined): Promise<string>
    {
        const key = FakeHiveKube.Key(namespace, name)
        const current = this.ConfigMaps.get(key)
        if ((current === undefined) !== (resourceVersion === undefined) || (current !== undefined && current.ResourceVersion !== resourceVersion))
        {
            throw new KubeConflictError()
        }
        this.version += 1
        this.ConfigMaps.set(key, new KubeConfigMap({ ...data }, String(this.version)))
        return String(this.version)
    }

    public readonly Leases = new Map<string, KubeLease>()

    public async GetLease(namespace: string, name: string): Promise<KubeLease | undefined>
    {
        return this.Leases.get(FakeHiveKube.Key(namespace, name))
    }

    public async PutLease(namespace: string, name: string, lease: KubeLease): Promise<void>
    {
        const key = FakeHiveKube.Key(namespace, name)
        const current = this.Leases.get(key)
        if ((current === undefined) !== (lease.ResourceVersion === undefined) || (current !== undefined && current.ResourceVersion !== lease.ResourceVersion))
        {
            throw new KubeConflictError()
        }
        this.version += 1
        this.Leases.set(key, new KubeLease(lease.Holder, lease.RenewedAt, lease.DurationSeconds, String(this.version)))
    }

    public async ReviewToken(token: string, audience: string): Promise<TokenReviewResult>
    {
        this.Reviewed.push(audience)
        const known = this.Tokens.get(token)
        if (known === undefined || !known.Audiences.includes(audience))
        {
            return TokenReviewResult.Refused
        }
        return new TokenReviewResult(true, known.Username, known.Audiences.filter(entry => entry === audience))
    }

    public async WorkloadReady(namespace: string, kind: KubeWorkloadKind, name: string): Promise<boolean | undefined>
    {
        const object = this.Workload(namespace, kind, name)
        if (object !== undefined)
        {
            return object.Snapshot().Ready
        }
        return this.Workloads.get(FakeHiveKube.Key(namespace, kind + '/' + name))
    }

    public AddWorkload(namespace: string, kind: KubeWorkloadKind, name: string, image: string, container: string = 'main', initContainers: KubeContainer[] = []): FakeWorkload
    {
        const workload = new FakeWorkload([new KubeContainer(container, image)], initContainers)
        this.Objects.set(FakeHiveKube.Key(namespace, kind + '/' + name), workload)
        return workload
    }

    public Workload(namespace: string, kind: KubeWorkloadKind, name: string): FakeWorkload | undefined
    {
        return this.Objects.get(FakeHiveKube.Key(namespace, kind + '/' + name))
    }

    public async GetWorkload(namespace: string, kind: KubeWorkloadKind, name: string): Promise<KubeWorkload | undefined>
    {
        return this.Workload(namespace, kind, name)?.Snapshot()
    }

    public async PatchWorkload(namespace: string, kind: KubeWorkloadKind, name: string, patch: object): Promise<void>
    {
        const workload = this.Workload(namespace, kind, name)
        if (workload === undefined)
        {
            throw new Error('kubernetes API request failed with status 404')
        }
        this.PatchLog.push(kind + '/' + name)
        workload.Patches.push(patch)
        const template = (patch as { spec?: { template?: { metadata?: { annotations?: Record<string, string> }, spec?: { containers?: { name: string, image: string }[], initContainers?: { name: string, image: string }[] } } } }).spec?.template
        for (const [list, changes] of [[workload.Containers, template?.spec?.containers ?? []], [workload.InitContainers, template?.spec?.initContainers ?? []]] as const)
        {
            for (const change of changes)
            {
                const index = list.findIndex(container => container.Name === change.name)
                if (index >= 0)
                {
                    list[index] = new KubeContainer(change.name, change.image)
                }
            }
        }
        const restarted = template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt']
        if (restarted !== undefined)
        {
            workload.RestartedAt = restarted
        }
        workload.Generation += 1
        workload.ObservedGeneration = workload.Generation
    }

    public async ReplaceSecret(namespace: string, name: string, data: Readonly<Record<string, string>>): Promise<void>
    {
        this.Secrets.set(FakeHiveKube.Key(namespace, name), { ...data })
    }
}
