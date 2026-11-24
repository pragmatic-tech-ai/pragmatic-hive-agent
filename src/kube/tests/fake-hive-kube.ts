import { KubeConfigMap, KubeContainer, KubeWorkload, TokenReviewResult, type IHiveKube, type KubeWorkloadKind } from '../hive-kube.js'

/** A token the fake TokenReview knows: who it authenticates as, for which audiences. */
export class FakeToken
{
    public constructor(public readonly Username: string, public readonly Audiences: readonly string[])
    {
    }
}

/** A workload in the fake: its template containers, generation and whether a changed template ever becomes ready. */
export class FakeWorkload
{
    public Generation = 1
    public ObservedGeneration = 1
    /** Every replica of the running template is ready. */
    public Ready = true
    /** A changed template never readies (the new pod fails); the previous pods stay ready. */
    public NeverReadies = false
    public readonly Patches: object[] = []
    public RestartedAt: string | undefined

    public constructor(public readonly Containers: KubeContainer[], public readonly Replicas: number = 1)
    {
    }

    public Snapshot(): KubeWorkload
    {
        const changed = this.Generation > 1
        const updated = this.NeverReadies && changed ? 0 : this.Replicas
        const ready = this.Ready ? (this.NeverReadies && changed ? 0 : this.Replicas) : 0
        return new KubeWorkload([...this.Containers], this.Generation, this.ObservedGeneration, this.Replicas, updated, ready)
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

    public async PutConfigMap(namespace: string, name: string, data: Readonly<Record<string, string>>, _labels: Readonly<Record<string, string>>, resourceVersion: string | undefined): Promise<void>
    {
        const key = FakeHiveKube.Key(namespace, name)
        const current = this.ConfigMaps.get(key)
        if ((current === undefined) !== (resourceVersion === undefined) || (current !== undefined && current.ResourceVersion !== resourceVersion))
        {
            throw new Error('kubernetes API request failed with status 409')
        }
        this.version += 1
        this.ConfigMaps.set(key, new KubeConfigMap({ ...data }, String(this.version)))
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

    public AddWorkload(namespace: string, kind: KubeWorkloadKind, name: string, image: string, container: string = 'main'): FakeWorkload
    {
        const workload = new FakeWorkload([new KubeContainer(container, image)])
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
        const template = (patch as { spec?: { template?: { metadata?: { annotations?: Record<string, string> }, spec?: { containers?: { name: string, image: string }[] } } } }).spec?.template
        for (const change of template?.spec?.containers ?? [])
        {
            const index = workload.Containers.findIndex(container => container.Name === change.name)
            if (index >= 0)
            {
                workload.Containers[index] = new KubeContainer(change.name, change.image)
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
