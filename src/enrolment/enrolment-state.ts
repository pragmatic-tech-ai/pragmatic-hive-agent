import {
    HiveLevels, Intent, IntentActionKind, MessageKind, Participant, ProtocolNames, RotationSubject, SignedEnvelope, SigningPublicKey, type HiveLevel,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
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
        public readonly TrustRoot: SigningPublicKey,
        /** The trust-root rotation intents (C3.4) that lead from the pinned root to `TrustRoot`, oldest first. */
        public readonly Rotations: readonly SignedEnvelope[] = [])
    {
    }

    /** The same enrolment under a new trust root, adopted by the verified rotation intent `rotation`. */
    public Rotated(root: SigningPublicKey, rotation: SignedEnvelope): EnrolmentRecord
    {
        return new EnrolmentRecord(this.HiveId, this.Tenant, this.Level, this.ChannelUrl, root, [...this.Rotations, rotation])
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
    private static readonly Key = { HiveId: 'hiveId', Tenant: 'tenant', Level: 'level', ChannelUrl: 'channelUrl', TrustRootKeyId: 'trustRootKeyId', TrustRoot: 'trustRoot', Rotations: 'trustRootRotations' } as const
    private static readonly Base64Url = 'base64url'

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
        // The pinned root wins unless the stored root was reached from it by trust-root rotation intents (C3.4), each
        // signed by the root before it and addressed to this hive: a chart upgrade that rotates agent.trustRoot.publicKey
        // moves the enrolled hive to the new root, and an edited ConfigMap can never make the agent trust another key.
        const rotations = EnrolmentState.RotationsOf(data[K.Rotations])
        if (!root.Equals(this.pinnedTrustRoot) && rotations !== undefined && EnrolmentState.Leads(this.pinnedTrustRoot, rotations, hiveId)?.Equals(root) === true)
        {
            return new EnrolmentRecord(hiveId, tenant, level, channelUrl, root, rotations)
        }
        const record = new EnrolmentRecord(hiveId, tenant, level, channelUrl, this.pinnedTrustRoot)
        if (!root.Equals(this.pinnedTrustRoot) || (rotations?.length ?? 0) > 0)
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
            [K.Rotations]: JSON.stringify(record.Rotations.map(rotation => rotation.Encode())),
        }, HiveIdentity.Labels, existing?.ResourceVersion)
    }

    /**
     * The root `rotations` lead to from `pinned`, or undefined when any link is broken: each must be a platform intent to
     * this hive, signed under the root before it, rotating the trust root (its new key is the next root).
     */
    public static Leads(pinned: SigningPublicKey, rotations: readonly SignedEnvelope[], hiveId: string): SigningPublicKey | undefined
    {
        let root = pinned
        for (const rotation of rotations)
        {
            if (rotation.Kind !== MessageKind.Intent || !rotation.Issuer.Equals(Participant.Platform) || !rotation.Audience.Equals(Participant.Hive(hiveId))
                || rotation.KeyId !== root.KeyId || !root.Verify(rotation.SigningInput(), Buffer.from(rotation.Signature, EnrolmentState.Base64Url)))
            {
                return undefined
            }
            let intent: Intent
            try
            {
                intent = Intent.Parse(rotation.Body)
            }
            catch
            {
                return undefined
            }
            const action = intent.Action
            if (action.Kind !== IntentActionKind.Rotate || action.Subject !== RotationSubject.TrustRoot || action.NewTrustRoot === null)
            {
                return undefined
            }
            root = action.NewTrustRoot
        }
        return root
    }

    private static RotationsOf(raw: string | undefined): SignedEnvelope[] | undefined
    {
        if (raw === undefined || raw === '')
        {
            return []
        }
        try
        {
            const texts = JSON.parse(raw) as unknown
            return Array.isArray(texts) ? texts.map(text => SignedEnvelope.Decode(String(text))) : undefined
        }
        catch
        {
            return undefined
        }
    }
}
