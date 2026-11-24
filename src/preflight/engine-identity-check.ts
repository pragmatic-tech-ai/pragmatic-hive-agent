import { KubeResourceCatalog, type KubeApiClient, type KubeTypeRef } from '@pragmatic-tech-ai/pragmatic-kube'
import { PreflightResults, type IPreflightCheck, type PreflightResult } from './preflight-check.js'

type SeedSecret = { data?: Record<string, string> }
type Seed = { tenant?: { id?: unknown }; hives?: Array<{ id?: unknown }> }

/**
 * A kept engine keeps its ids: when the namespace holds an engine's directory seed (`pragmatic-tenant-admin-seed`, kept on
 * uninstall), its tenant (the realm id its sign-in service's data is sealed under) and hive must be the ones installed.
 * Another tenant over kept data would start a sign-in service with new keys over a database sealed with the old ones.
 */
export class EngineIdentityCheck implements IPreflightCheck
{
    public static readonly CheckName = 'engine-identity'
    public static readonly SeedSecret = 'pragmatic-tenant-admin-seed'
    private static readonly SeedKey = 'seed.json'
    private static readonly SecretType: KubeTypeRef = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly NewEngine = 'no kept engine in this namespace: a new one is installed'
    private static readonly SameEnginePrefix = 'the kept engine is tenant '
    private static readonly HiveInfix = ', hive '
    private static readonly OtherPrefix = 'this namespace keeps the engine of tenant '
    private static readonly OtherInfix = '; the install names tenant '
    private static readonly Unreadable = 'the kept engine seed is unreadable'
    private static readonly OtherFix = 'Install with the kept engine\'s tenant.id and hive.id, or remove the kept engine first (its namespaces, claims and Secrets: runbook customer-cluster.md).'

    public readonly Name = EngineIdentityCheck.CheckName

    public constructor(private readonly client: KubeApiClient, private readonly namespace: string, private readonly tenantId: string, private readonly hiveId: string)
    {
    }

    public async Run(): Promise<PreflightResult>
    {
        const E = EngineIdentityCheck
        const kept = await this.client.Get(KubeResourceCatalog.PathOf(E.SecretType, this.namespace, E.SeedSecret)) as SeedSecret | undefined
        if (kept === undefined)
        {
            return PreflightResults.Pass(E.CheckName, E.NewEngine)
        }
        let seed: Seed
        try
        {
            seed = JSON.parse(Buffer.from(kept.data?.[E.SeedKey] ?? '', E.Base64).toString(E.Utf8)) as Seed
        }
        catch
        {
            return PreflightResults.Fail(E.CheckName, E.Unreadable, E.OtherFix)
        }
        const tenant = String(seed.tenant?.id)
        const hive = String(seed.hives?.[0]?.id)
        if (tenant !== this.tenantId || hive !== this.hiveId)
        {
            return PreflightResults.Fail(E.CheckName, E.OtherPrefix + tenant + E.HiveInfix + hive + E.OtherInfix + this.tenantId + E.HiveInfix + this.hiveId, E.OtherFix)
        }
        return PreflightResults.Pass(E.CheckName, E.SameEnginePrefix + tenant + E.HiveInfix + hive)
    }
}
