import {
    EnvelopeVerifier, InMemoryNonceLedger, KeyDirectory, Participant, SystemProtocolClock, type HiveLevel, type IProtocolClock, type SignedEnvelope, type SigningPublicKey,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { EnrolmentRecord, EnrolmentState } from './enrolment-state.js'

/**
 * The enrolled hive's trust in the platform (C3.4): the trust root every platform message must verify under, and the
 * verifier for messages to this hive. A trust-root rotation intent, verified under the current root, moves it to the new
 * root (kept with the intent that proves it, EnrolmentState); nothing else changes it at run time.
 */
export class PlatformTrust
{
    private readonly clock: IProtocolClock
    private readonly nonces: InMemoryNonceLedger
    private verifier: EnvelopeVerifier

    public constructor(private record: EnrolmentRecord, private readonly state: EnrolmentState, clock?: IProtocolClock)
    {
        this.clock = clock ?? new SystemProtocolClock()
        this.nonces = new InMemoryNonceLedger(this.clock)
        this.verifier = this.Build()
    }

    public get Record(): EnrolmentRecord
    {
        return this.record
    }

    /** The hive's own level (what it was connected as): IntentAdmissionDecider reads it. */
    public get Level(): HiveLevel
    {
        return this.record.Level
    }

    public get Root(): SigningPublicKey
    {
        return this.record.TrustRoot
    }

    /** The verifier for platform messages addressed to this hive, under the current root. */
    public Verifier(): EnvelopeVerifier
    {
        return this.verifier
    }

    /** Adopts `root`, proved by `rotation` (an intent that verified under the current root); stored before it is used. */
    public async Adopt(root: SigningPublicKey, rotation: SignedEnvelope): Promise<void>
    {
        const record = this.record.Rotated(root, rotation)
        await this.state.Write(record)
        this.record = record
        this.verifier = this.Build()
    }

    private Build(): EnvelopeVerifier
    {
        return new EnvelopeVerifier({ Self: Participant.Hive(this.record.HiveId), Keys: new KeyDirectory().Add(Participant.Platform, this.record.TrustRoot), Nonces: this.nonces, Clock: this.clock })
    }
}
