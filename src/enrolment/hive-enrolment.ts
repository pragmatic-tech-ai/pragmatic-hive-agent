import {
    AgentChannelUnavailableError, AgentExchangeRefusal, EnrolmentHandshake, EnrolmentMismatch, EnrolmentMismatchError, EnvelopeSigner, HiveEnrolmentRefusal,
    HiveEnrolmentRequest, HiveEnrolmentStatus, InMemoryNonceLedger, MessageKind, Participant, ParticipantRole, ProtocolVerificationError, SystemProtocolClock,
    type ConsoleAddress, type HiveLevel, type IAgentChannel, type IProtocolClock, type SignedEnvelope, type SigningKeyPair, type SigningPublicKey,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { EnrolmentRecord, type EnrolmentState } from './enrolment-state.js'

/** Why the hive did not enrol: the code the console shows a fixed message for. */
export class HiveEnrolmentRefusedError extends Error
{
    private static readonly ErrorName = 'HiveEnrolmentRefusedError'
    private static readonly Prefix = 'enrolment refused: '

    public constructor(public readonly Code: HiveEnrolmentRefusal)
    {
        super(HiveEnrolmentRefusedError.Prefix + Code)
        this.name = HiveEnrolmentRefusedError.ErrorName
    }
}

/** What the console asks the agent to enrol as. */
export interface HiveEnrolmentAsk
{
    Code: string
    Level: HiveLevel
    ConsoleAddress: ConsoleAddress
}

export interface HiveEnrolmentOptions
{
    Key: SigningKeyPair
    Channel: IAgentChannel
    State: EnrolmentState
    PinnedTrustRoot: SigningPublicKey
    Tenant: string
    EngineVersion: string
    Clock?: IProtocolClock
}

/**
 * "Connect this hive" on the agent's side (C3.3): a HiveEnrolmentRequest self-signed by the hive key goes over the
 * agent channel; the answer is accepted only by EnrolmentHandshake (signed by the trust root it carries, which must be
 * the one the engine was installed with, addressed to this key, fresh, answering this request's nonce, for the tenant
 * and level asked); only then is the enrolment stored. A refusal maps to the console's fixed codes; nothing from the
 * platform's answer travels further. One enrolment at a time (another while one is in flight is `unavailable`); an
 * enrolled hive answers `already-enrolled`.
 */
export class HiveEnrolment
{
    private static readonly PlatformCodes: ReadonlyMap<AgentExchangeRefusal, HiveEnrolmentRefusal> = new Map([
        [AgentExchangeRefusal.InvalidCode, HiveEnrolmentRefusal.InvalidCode],
        [AgentExchangeRefusal.Mismatch, HiveEnrolmentRefusal.Mismatch],
        [AgentExchangeRefusal.KeyRegistered, HiveEnrolmentRefusal.KeyRegistered],
    ])
    private readonly clock: IProtocolClock
    private enrolled: EnrolmentRecord | undefined
    private busy = false
    private readonly waiting: ((record: EnrolmentRecord) => void)[] = []

    public constructor(private readonly options: HiveEnrolmentOptions, enrolled?: EnrolmentRecord)
    {
        this.clock = options.Clock ?? new SystemProtocolClock()
        this.enrolled = enrolled
    }

    public get Enrolled(): EnrolmentRecord | undefined
    {
        return this.enrolled
    }

    /** Resolves with the enrolment once the hive is enrolled (at once when it already is). */
    public WhenEnrolled(): Promise<EnrolmentRecord>
    {
        const record = this.enrolled
        return record !== undefined ? Promise.resolve(record) : new Promise(resolve => this.waiting.push(resolve))
    }

    public Status(): HiveEnrolmentStatus
    {
        const record = this.enrolled
        return record === undefined ? HiveEnrolmentStatus.NotEnrolled : HiveEnrolmentStatus.Of(record.HiveId, record.Tenant, record.Level)
    }

    public async Enrol(ask: HiveEnrolmentAsk): Promise<EnrolmentRecord>
    {
        if (this.enrolled !== undefined)
        {
            throw new HiveEnrolmentRefusedError(HiveEnrolmentRefusal.AlreadyEnrolled)
        }
        // Another connect is in flight: try again (it may still fail, so this hive is not connected yet).
        if (this.busy)
        {
            throw new HiveEnrolmentRefusedError(HiveEnrolmentRefusal.Unavailable)
        }
        this.busy = true
        try
        {
            const record = await this.Exchange(ask)
            await this.options.State.Write(record)
            this.enrolled = record
            for (const resolve of this.waiting.splice(0))
            {
                resolve(record)
            }
            return record
        }
        finally
        {
            this.busy = false
        }
    }

    private async Exchange(ask: HiveEnrolmentAsk): Promise<EnrolmentRecord>
    {
        const o = this.options
        const body = HiveEnrolmentRequest.Create({ EnrolmentCode: ask.Code, Tenant: o.Tenant, Level: ask.Level, PublicKey: o.Key.PublicKey, EngineVersion: o.EngineVersion, ConsoleAddress: ask.ConsoleAddress })
        const request = EnvelopeSigner.SelfSigned(o.Key, ParticipantRole.Hive, this.clock).Sign(MessageKind.HiveEnrolmentRequest, Participant.Platform, body)
        let response: SignedEnvelope | null
        try
        {
            response = await o.Channel.Exchange(request)
        }
        catch (error)
        {
            throw new HiveEnrolmentRefusedError(HiveEnrolment.CodeOf(error))
        }
        if (response === null)
        {
            throw new HiveEnrolmentRefusedError(HiveEnrolmentRefusal.Unavailable)
        }
        const handshake = new EnrolmentHandshake({ Clock: this.clock, Nonces: new InMemoryNonceLedger(this.clock), PinnedTrustRoot: o.PinnedTrustRoot })
        try
        {
            const verified = await handshake.AcceptHive(response, request)
            return new EnrolmentRecord(verified.Body.HiveId, verified.Body.Tenant, verified.Body.Level, verified.Body.ChannelUrl, verified.Body.TrustRoot)
        }
        catch (error)
        {
            if (error instanceof EnrolmentMismatchError && error.Reason === EnrolmentMismatch.UntrustedRoot)
            {
                throw new HiveEnrolmentRefusedError(HiveEnrolmentRefusal.TrustRootMismatch)
            }
            if (error instanceof EnrolmentMismatchError || error instanceof ProtocolVerificationError)
            {
                throw new HiveEnrolmentRefusedError(HiveEnrolmentRefusal.Unavailable)
            }
            throw error
        }
    }

    private static CodeOf(error: unknown): HiveEnrolmentRefusal
    {
        if (error instanceof AgentChannelUnavailableError && error.Code !== null)
        {
            return HiveEnrolment.PlatformCodes.get(error.Code) ?? HiveEnrolmentRefusal.Unavailable
        }
        return HiveEnrolmentRefusal.Unavailable
    }
}
