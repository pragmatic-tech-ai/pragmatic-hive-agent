import { AgentChannelUnavailableError, AgentExchangeRefusal, MessageKind, ProtocolVerificationError, type IAgentChannel, type IMessageBody } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveKube } from '../kube/hive-kube.js'
import { HiveIdentity } from './hive-identity.js'
import type { HiveSigning } from './hive-signing.js'

/**
 * A hive key rotation interrupted after the new key was announced (C3.4): at start, with a pending key beside the
 * current one, the agent sends its first report under the current key; when the platform no longer verifies it (it
 * switched to the new key and the acknowledgement was lost), the report goes again under the pending key and, accepted,
 * that key becomes the hive key. When the current key still works, the pending one is dropped.
 */
export class HiveKeyRecovery
{
    public constructor(private readonly signing: HiveSigning, private readonly kube: IHiveKube, private readonly namespace: string)
    {
    }

    /** Settles a pending key with one report body; true when a pending key was found and settled. */
    public async Settle(channel: IAgentChannel, report: IMessageBody): Promise<boolean>
    {
        const pending = await HiveIdentity.Pending(this.kube, this.namespace)
        if (pending === undefined)
        {
            return false
        }
        try
        {
            await channel.Exchange(this.signing.Sign(MessageKind.HiveReport, report))
            await this.signing.Adopt(this.signing.Key)
            return true
        }
        catch (error)
        {
            if (!HiveKeyRecovery.NotVerified(error))
            {
                throw error
            }
        }
        await channel.Exchange(this.signing.SignWith(pending, MessageKind.HiveReport, report))
        await this.signing.Adopt(pending)
        return true
    }

    /** The platform did not verify the message (over HTTP its refusal code; in process, the verifier's error). */
    private static NotVerified(error: unknown): boolean
    {
        return (error instanceof AgentChannelUnavailableError && error.Code === AgentExchangeRefusal.NotVerified) || error instanceof ProtocolVerificationError
    }
}
