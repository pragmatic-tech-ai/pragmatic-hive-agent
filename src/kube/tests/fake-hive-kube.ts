import { KubeConfigMap, TokenReviewResult, type IHiveKube, type KubeWorkloadKind } from '../hive-kube.js'

/** A token the fake TokenReview knows: who it authenticates as, for which audiences. */
export class FakeToken
{
    public constructor(public readonly Username: string, public readonly Audiences: readonly string[])
    {
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
        return this.Workloads.get(FakeHiveKube.Key(namespace, kind + '/' + name))
    }
}
