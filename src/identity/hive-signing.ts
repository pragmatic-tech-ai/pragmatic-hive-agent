import {
    EnvelopeSigner, HiveKeyRotation, HiveKeyRotationAck, MessageKind, Participant, SigningKeyPair, SystemProtocolClock,
    type EnvelopeVerifier, type IAgentChannel, type IMessageBody, type IProtocolClock, type SignedEnvelope,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveKube } from '../kube/hive-kube.js'
import { HiveIdentity } from './hive-identity.js'

/** A hive key rotation the platform did not acknowledge (no answer, or one naming another hive or key). */
export class HiveKeyRotationRefusedError extends Error
{
    private static readonly ErrorName = 'HiveKeyRotationRefusedError'
    private static readonly Text = 'the platform did not acknowledge the new hive key'

    public constructor()
    {
        super(HiveKeyRotationRefusedError.Text)
        this.name = HiveKeyRotationRefusedError.ErrorName
    }
}

/**
 * The enrolled hive's signing identity, shared by everything that signs as the hive (reports, pulls, decisions): the
 * current key and the hive id. A hive key rotation (C3.4) swaps the key for all of them at once, only after the
 * platform's verified acknowledgement names the new key; until then the new key waits beside the current one in the
 * identity Secret, so an agent that restarts mid-rotation still holds both (HiveKeyRecovery picks the one the platform
 * knows).
 */
export class HiveSigning
{
    private readonly clock: IProtocolClock

    public constructor(private key: SigningKeyPair, public readonly HiveId: string, private readonly kube: IHiveKube, private readonly namespace: string, clock?: IProtocolClock)
    {
        this.clock = clock ?? new SystemProtocolClock()
    }

    public get Key(): SigningKeyPair
    {
        return this.key
    }

    public get Self(): Participant
    {
        return Participant.Hive(this.HiveId)
    }

    public get Clock(): IProtocolClock
    {
        return this.clock
    }

    /** A message as the hive, to the platform, under the current key. */
    public Sign(kind: MessageKind, body: IMessageBody): SignedEnvelope
    {
        return new EnvelopeSigner(this.key, this.Self, this.clock).Sign(kind, Participant.Platform, body)
    }

    /** The same message under another key (the recovery probe). */
    public SignWith(key: SigningKeyPair, kind: MessageKind, body: IMessageBody): SignedEnvelope
    {
        return new EnvelopeSigner(key, this.Self, this.clock).Sign(kind, Participant.Platform, body)
    }

    /**
     * Rotates the hive key: the next key kept as pending first, the rotation sent under the current key, the platform's
     * answer verified (`verifier`: the trust root) and checked to name this hive and the new key; only then is the new
     * key the hive key, in the Secret and here.
     */
    public async Rotate(channel: IAgentChannel, verifier: EnvelopeVerifier): Promise<HiveKeyRotationAck>
    {
        const next = (await HiveIdentity.Pending(this.kube, this.namespace)) ?? SigningKeyPair.Generate()
        await HiveIdentity.WritePending(this.kube, this.namespace, this.key, next)
        const reply = await channel.Exchange(this.Sign(MessageKind.HiveKeyRotation, HiveKeyRotation.Create(this.HiveId, this.key.KeyId, next)))
        if (reply === null)
        {
            throw new HiveKeyRotationRefusedError()
        }
        const ack = (await verifier.Verify(reply, MessageKind.HiveKeyRotationAck, HiveKeyRotationAck)).Body
        if (ack.HiveId !== this.HiveId || ack.KeyId !== next.KeyId)
        {
            throw new HiveKeyRotationRefusedError()
        }
        await this.Adopt(next)
        return ack
    }

    /** Makes `key` the hive key (acknowledged by the platform, or found to be the one it knows). */
    public async Adopt(key: SigningKeyPair): Promise<void>
    {
        await HiveIdentity.Adopt(this.kube, this.namespace, key)
        this.key = key
    }
}
