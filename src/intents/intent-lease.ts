import type { IProtocolClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HiveIdentity } from '../identity/hive-identity.js'
import { KubeConflictError, KubeLease, type IHiveKube } from '../kube/hive-kube.js'

/**
 * One agent pod applies intents at a time (C3.4): a coordination.k8s.io Lease `pragmatic-hive-agent-intents` in the
 * agent's namespace, held by the pod's name and renewed every tick. While the agent's own upgrade overlaps an old and a
 * new pod, the one that does not hold it skips its tick (decisions still go through: the store merges their writes).
 * A pod releases it when it stops (SIGTERM), so the next one takes over at once; a pod that dies holds it until it runs out.
 */
export class IntentLease
{
    public static readonly LeaseName = 'pragmatic-hive-agent-intents'
    public static readonly DurationSeconds = 90
    private static readonly Released = ''

    public constructor(private readonly kube: IHiveKube, private readonly namespace: string, private readonly holder: string, private readonly clock: IProtocolClock)
    {
    }

    /** Takes or renews the lease; false while another pod holds it. */
    public async Acquire(): Promise<boolean>
    {
        const L = IntentLease
        const now = this.clock.Now()
        const current = await this.kube.GetLease(this.namespace, L.LeaseName)
        if (current !== undefined && current.Holder !== this.holder && !current.ExpiredAt(now))
        {
            return false
        }
        try
        {
            await this.kube.PutLease(this.namespace, L.LeaseName, new KubeLease(this.holder, now, L.DurationSeconds, current?.ResourceVersion), HiveIdentity.Labels)
            return true
        }
        catch (error)
        {
            if (error instanceof KubeConflictError)
            {
                return false
            }
            throw error
        }
    }

    /** Lets the lease go (this pod is stopping), when it holds it. */
    public async Release(): Promise<void>
    {
        const L = IntentLease
        const current = await this.kube.GetLease(this.namespace, L.LeaseName)
        if (current === undefined || current.Holder !== this.holder)
        {
            return
        }
        try
        {
            await this.kube.PutLease(this.namespace, L.LeaseName, new KubeLease(L.Released, this.clock.Now(), L.DurationSeconds, current.ResourceVersion), HiveIdentity.Labels)
        }
        catch (error)
        {
            if (!(error instanceof KubeConflictError))
            {
                throw error
            }
        }
    }
}
