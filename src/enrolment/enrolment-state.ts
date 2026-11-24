import { HiveLevels, ProtocolNames, SigningPublicKey, type HiveLevel } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HiveIdentity } from '../identity/hive-identity.js'
import type { IHiveKube } from '../kube/hive-kube.js'

/** What the hive is enrolled as: kept in the ConfigMap `pragmatic-hive-enrolment` (none of it is secret). */
export class EnrolmentRecord
{
    public constructor(
        public readonly HiveId: string,
        public readonly Tenant: string,
        public readonly Level: HiveLevel,
        public readonly ChannelUrl: string,
        public readonly TrustRoot: SigningPublicKey)
    {
    }

    public get TrustRootKeyId(): string
    {
        return this.TrustRoot.KeyId
    }
}

/** The enrolment ConfigMap is there but does not read as an enrolment (edited by hand?). */
export class EnrolmentStateUnreadableError extends Error
{
    private static readonly ErrorName = 'EnrolmentStateUnreadableError'
    private static readonly Text = 'the ConfigMap pragmatic-hive-enrolment does not read as an enrolment'

    public constructor()
    {
        super(EnrolmentStateUnreadableError.Text)
        this.name = EnrolmentStateUnreadableError.ErrorName
    }
}

/**
 * The hive's enrolment (C3.3), in the ConfigMap `pragmatic-hive-enrolment` of the agent's namespace: `hiveId`,
 * `tenant`, `level`, `channelUrl`, `trustRootKeyId` and the adopted `trustRoot` (public key). Written once, after the
 * platform's answer verified; read at every start, so an enrolled agent reports from its first tick. The root read is
 * always the one the engine is installed with: a stored other one (a rotation by chart upgrade, an edited ConfigMap) is
 * replaced by it.
 */
export class EnrolmentState
{
    public static readonly ConfigMapName = 'pragmatic-hive-enrolment'
    private static readonly Key = { HiveId: 'hiveId', Tenant: 'tenant', Level: 'level', ChannelUrl: 'channelUrl', TrustRootKeyId: 'trustRootKeyId', TrustRoot: 'trustRoot' } as const

    /** The trust root the engine was installed with: a stored enrolment under any other root is not this engine's. */
    public constructor(private readonly kube: IHiveKube, private readonly namespace: string, private readonly pinnedTrustRoot: SigningPublicKey)
    {
    }

    public async Read(): Promise<EnrolmentRecord | undefined>
    {
        const K = EnrolmentState.Key
        const map = await this.kube.GetConfigMap(this.namespace, EnrolmentState.ConfigMapName)
        if (map === undefined)
        {
            return undefined
        }
        const data = map.Data
        const level = data[K.Level] as HiveLevel | undefined
        const hiveId = data[K.HiveId] ?? ''
        const tenant = data[K.Tenant] ?? ''
        const channelUrl = data[K.ChannelUrl] ?? ''
        if (level === undefined || !HiveLevels.Enrolling.includes(level) || !ProtocolNames.Label.test(hiveId) || !ProtocolNames.Tenant.test(tenant) || !ProtocolNames.HttpsUrl.test(channelUrl))
        {
            throw new EnrolmentStateUnreadableError()
        }
        let root: SigningPublicKey
        try
        {
            root = SigningPublicKey.Parse(data[K.TrustRoot])
        }
        catch
        {
            throw new EnrolmentStateUnreadableError()
        }
        if (root.KeyId !== data[K.TrustRootKeyId])
        {
            throw new EnrolmentStateUnreadableError()
        }
        // The pinned root always wins: a chart upgrade that rotates agent.trustRoot.publicKey moves the enrolled hive to
        // the new root (kept from here on), and an edited ConfigMap can never make the agent trust another key.
        const record = new EnrolmentRecord(hiveId, tenant, level, channelUrl, this.pinnedTrustRoot)
        if (!root.Equals(this.pinnedTrustRoot))
        {
            await this.Write(record)
        }
        return record
    }

    public async Write(record: EnrolmentRecord): Promise<void>
    {
        const K = EnrolmentState.Key
        const existing = await this.kube.GetConfigMap(this.namespace, EnrolmentState.ConfigMapName)
        await this.kube.PutConfigMap(this.namespace, EnrolmentState.ConfigMapName, {
            [K.HiveId]: record.HiveId,
            [K.Tenant]: record.Tenant,
            [K.Level]: record.Level,
            [K.ChannelUrl]: record.ChannelUrl,
            [K.TrustRootKeyId]: record.TrustRootKeyId,
            [K.TrustRoot]: record.TrustRoot.ToJson(),
        }, HiveIdentity.Labels, existing?.ResourceVersion)
    }
}
