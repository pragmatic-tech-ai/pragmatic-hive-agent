import { MessageKind, type IAgentChannel, type IMessageBody } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveKube } from '../kube/hive-kube.js'
import { HiveIdentity } from './hive-identity.js'
import { HiveSigning } from './hive-signing.js'

/**
 * A hive key rotation interrupted after the new key was announced (C3.4): at start, with a pending key beside the
 * current one, the agent sends its first report under the current key; when the platform no longer verifies it (it
 * switched to the new key and the acknowledgement was lost), the pending key is proved and adopted (HiveSigning
 * ProvePending) and the report sent under it. When the current key still works the pending one stays: the rotation intent
 * that announced it is still applying and sends the same key again.
 */
export class HiveKeyRecovery
{
    public constructor(private readonly signing: HiveSigning, private readonly kube: IHiveKube, private readonly namespace: string)
    {
    }

    /** True when a pending key was found to be the one the platform knows, and adopted. */
    public async Settle(channel: IAgentChannel, report: IMessageBody, cursor: number): Promise<boolean>
    {
        if (await HiveIdentity.Pending(this.kube, this.namespace) === undefined)
        {
            return false
        }
        try
        {
            await channel.Exchange(this.signing.Sign(MessageKind.HiveReport, report))
            return false
        }
        catch (error)
        {
            if (!HiveSigning.NotVerified(error))
            {
                throw error
            }
        }
        if (!await this.signing.ProvePending(channel, cursor))
        {
            return false
        }
        await channel.Exchange(this.signing.Sign(MessageKind.HiveReport, report))
        return true
    }
}
