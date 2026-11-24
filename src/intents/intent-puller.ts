import {
    ComponentAtVersion, Intent, IntentApplyMode, IntentChoice, IntentDecisionRefusal, IntentFailure, IntentNotAcceptedError, IntentProgress, KeptIntentListing,
    IntentStatus, MessageKind, ProtocolVerificationError, Pull, PullBatch, VerificationFailure,
    type IAgentChannel, type IntentDecisionCall, type KeptIntentView, type VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlatformTrust } from '../enrolment/platform-trust.js'
import type { HiveSigning } from '../identity/hive-signing.js'
import type { ITickTarget } from '../tick-loop.js'
import { ApprovalSigner } from './approval-signer.js'
import { EngineWorkloads } from './engine-workloads.js'
import type { IntentAdmissionDecider } from './intent-admission-decider.js'
import type { IApplyContext, IIntentExecutor } from './intent-executor-contract.js'
import { KeptIntent, type IntentStore } from './intent-store.js'

/** Why the agent did not take the console's decision: the code the console shows a fixed message for. */
export class IntentDecisionRefusedError extends Error
{
    private static readonly ErrorName = 'IntentDecisionRefusedError'
    private static readonly Prefix = 'intent decision refused: '

    public constructor(public readonly Code: IntentDecisionRefusal)
    {
        super(IntentDecisionRefusedError.Prefix + Code)
        this.name = IntentDecisionRefusedError.ErrorName
    }
}

/** What the intent loop logs: events and codes only, never an intent's content. */
export interface IIntentLog
{
    Event(event: string, code?: string): void
    Failed(error: unknown, backoffMs: number): void
}

/** What the console's intent routes ask of the agent (the internal API). */
export interface IIntentDesk
{
    Listing(): KeptIntentListing
    Decide(intentId: string, call: IntentDecisionCall): Promise<KeptIntentView>
}

export interface IntentPullerOptions
{
    Channel: IAgentChannel
    Store: IntentStore
    Decider: IntentAdmissionDecider
    Executor: IIntentExecutor
    Signing: HiveSigning
    Trust: PlatformTrust
    Log: IIntentLog
    /** Sends a report now: before the agent's own upgrade rolls, so the platform has seen `applying`. */
    ReportNow?: () => Promise<void>
    /** At most this many full batches per tick (then the next tick goes on). */
    MaxBatches?: number
}

/**
 * The hive's side of pull-only management (C3.4): every tick it pulls the intents after its cursor (each batch and
 * each intent verified under the trust root, as addressed to this hive), keeps them (IntentStore), lets the stricter
 * level decide (IntentAdmissionDecider) whether one applies at once or waits for an admin's approval in the console,
 * marks waiting intents past their expiry expired, and applies what is due (the agent's own upgrade last, reported
 * before it rolls). The console's decision names the exact intent by digest; it is signed by the hive key and sent to
 * the platform, and an approval applies at once. Every kept intent is rechecked (signature, issuer, expiry) before it
 * is decided on and again before it is applied. Ticks and decisions run one at a time.
 */
export class IntentPuller implements ITickTarget, IIntentDesk
{
    public static readonly DefaultMaxBatches = 10
    private static readonly SkippedEvent = 'intent-skipped'
    private static readonly AdmittedEvent = 'intent-admitted'
    private static readonly AppliedEvent = 'intent-settled'
    private static readonly DecidedEvent = 'intent-decided'
    private static readonly ApplyErrorEvent = 'intent-apply-error'
    private static readonly UnknownError = 'Error'
    private readonly approvals: ApprovalSigner
    private serial: Promise<unknown> = Promise.resolve()

    public constructor(private readonly options: IntentPullerOptions)
    {
        this.approvals = new ApprovalSigner(options.Signing)
    }

    public Tick(): Promise<void>
    {
        return this.Serial(() => this.Run())
    }

    public TickFailed(error: unknown, backoffMs: number): void
    {
        this.options.Log.Failed(error, backoffMs)
    }

    public Listing(): KeptIntentListing
    {
        return KeptIntentListing.Of([...this.options.Store.All()].reverse().slice(0, KeptIntentListing.MaxIntents).map(intent => intent.View()))
    }

    public async Decide(intentId: string, call: IntentDecisionCall): Promise<KeptIntentView>
    {
        const view = await this.Serial(() => this.TakeDecision(intentId, call))
        if (call.Decision === IntentChoice.Approve)
        {
            // Pull and apply at once after an approval (not awaited: the console has its answer).
            void this.Tick().catch(error => this.TickFailed(error, 0))
        }
        return view
    }

    private async Run(): Promise<void>
    {
        await this.Pull()
        this.ExpireWaiting()
        await this.options.Store.Save()
        await this.ApplyDue()
    }

    private async Pull(): Promise<void>
    {
        const o = this.options
        const max = o.MaxBatches ?? IntentPuller.DefaultMaxBatches
        for (let n = 0; n < max; n++)
        {
            const reply = await o.Channel.Exchange(o.Signing.Sign(MessageKind.Pull, Pull.Create(o.Store.Cursor)))
            if (reply === null)
            {
                return
            }
            const verifier = o.Trust.Verifier()
            const batch = (await verifier.Verify(reply, MessageKind.PullBatch, PullBatch)).Body
            for (const item of batch.Items)
            {
                let intent: VerifiedMessage<Intent>
                try
                {
                    intent = await verifier.Verify(item, MessageKind.Intent, Intent)
                }
                catch (error)
                {
                    // Not for this hive, not under its root, expired, or an item already taken (its nonce): never kept.
                    o.Log.Event(IntentPuller.SkippedEvent, error instanceof ProtocolVerificationError ? error.Failure : IntentPuller.UnknownError)
                    continue
                }
                this.Admit(intent)
            }
            o.Store.SetCursor(batch.Cursor)
            await o.Store.Save()
            if (batch.Items.length < Pull.MaxItems)
            {
                return
            }
        }
    }

    /** Keeps a newly verified intent: applied at once or waiting, by the stricter level. The same intent again is ignored. */
    private Admit(intent: VerifiedMessage<Intent>): void
    {
        const store = this.options.Store
        const kept = store.Get(intent.Body.IntentId)
        if (kept !== undefined && kept.Digest === intent.Digest)
        {
            return
        }
        // A different digest under a kept id is a new intent: it replaces the kept one with its own status, so an approval
        // given to the old one (bound to its digest) can never apply it.
        const fresh = new KeptIntent(intent.Envelope, intent.Body, IntentStatus.Of(intent.Body.IntentId, IntentProgress.AwaitingApproval))
        let progress: IntentProgress
        try
        {
            progress = this.options.Decider.ModeFor(intent.Body) === IntentApplyMode.ApplyDirectly ? IntentProgress.Applying : IntentProgress.AwaitingApproval
        }
        catch (error)
        {
            if (error instanceof IntentNotAcceptedError)
            {
                store.Put(fresh.Failed(IntentFailure.PrecheckRefused))
                return
            }
            throw error
        }
        store.Put(fresh.With(progress))
        this.options.Log.Event(IntentPuller.AdmittedEvent, progress)
    }

    private ExpireWaiting(): void
    {
        const store = this.options.Store
        const now = this.options.Signing.Clock.Now().getTime()
        for (const kept of store.All())
        {
            if (kept.Progress === IntentProgress.AwaitingApproval && kept.Envelope.ExpiresAt.getTime() <= now)
            {
                store.Put(kept.With(IntentProgress.Expired))
            }
        }
    }

    /** Applies every intent that is due, in order, the agent's own upgrade last. */
    private async ApplyDue(): Promise<void>
    {
        const due = this.options.Store.All().filter(kept => kept.Progress === IntentProgress.Applying)
        const ordered = [...due.filter(kept => !IntentPuller.IsSelfUpgrade(kept)), ...due.filter(kept => IntentPuller.IsSelfUpgrade(kept))]
        for (const kept of ordered)
        {
            await this.ApplyOne(kept)
        }
    }

    private async ApplyOne(kept: KeptIntent): Promise<void>
    {
        const o = this.options
        const verified = await this.Recheck(kept)
        if (verified === undefined)
        {
            await o.Store.Save()
            return
        }
        if (IntentPuller.IsSelfUpgrade(kept) && o.ReportNow !== undefined)
        {
            await o.ReportNow()
        }
        let current = kept
        const context: IApplyContext = {
            PreviousImage: kept.PreviousImage,
            NotePrevious: async image =>
            {
                current = current.WithPrevious(image)
                o.Store.Put(current)
                await o.Store.Save()
            },
        }
        let status: IntentStatus
        try
        {
            status = await o.Executor.Apply(verified, context)
        }
        catch (error)
        {
            o.Log.Event(IntentPuller.ApplyErrorEvent, error instanceof Error ? error.name : IntentPuller.UnknownError)
            status = IntentStatus.FailedWith(kept.IntentId, IntentFailure.ApplyFailed)
        }
        o.Store.Put(current.WithStatus(status))
        await o.Store.Save()
        o.Log.Event(IntentPuller.AppliedEvent, status.Failure ?? status.Progress)
    }

    /** The kept intent verified again (not its nonce); an expired one is marked expired, any other failure failed. */
    private async Recheck(kept: KeptIntent): Promise<VerifiedMessage<Intent> | undefined>
    {
        const store = this.options.Store
        try
        {
            const verified = await this.options.Trust.Verifier().Recheck(kept.Envelope, MessageKind.Intent, Intent)
            if (verified.Body.IntentId !== kept.IntentId)
            {
                store.Put(kept.Failed(IntentFailure.RecheckFailed))
                return undefined
            }
            return verified
        }
        catch (error)
        {
            const expired = error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.Expired
            store.Put(expired ? kept.With(IntentProgress.Expired) : kept.Failed(IntentFailure.RecheckFailed))
            return undefined
        }
    }

    private async TakeDecision(intentId: string, call: IntentDecisionCall): Promise<KeptIntentView>
    {
        const o = this.options
        const R = IntentDecisionRefusal
        const kept = o.Store.Get(intentId)
        if (kept === undefined)
        {
            throw new IntentDecisionRefusedError(R.UnknownIntent)
        }
        if (kept.Digest !== call.IntentDigest)
        {
            throw new IntentDecisionRefusedError(R.DigestMismatch)
        }
        if (kept.Progress === IntentProgress.Expired)
        {
            throw new IntentDecisionRefusedError(R.Expired)
        }
        if (kept.Progress !== IntentProgress.AwaitingApproval)
        {
            throw new IntentDecisionRefusedError(R.NotAwaiting)
        }
        const verified = await this.Recheck(kept)
        if (verified === undefined)
        {
            await o.Store.Save()
            throw new IntentDecisionRefusedError(o.Store.Get(intentId)?.Progress === IntentProgress.Expired ? R.Expired : R.NotAwaiting)
        }
        try
        {
            await o.Channel.Exchange(this.approvals.Sign(verified, call.Decision, call.Approver))
        }
        catch
        {
            throw new IntentDecisionRefusedError(R.Unavailable)
        }
        const decided = kept.With(call.Decision === IntentChoice.Approve ? IntentProgress.Applying : IntentProgress.Rejected)
        o.Store.Put(decided)
        await o.Store.Save()
        o.Log.Event(IntentPuller.DecidedEvent, call.Decision)
        return decided.View()
    }

    private Serial<T>(work: () => Promise<T>): Promise<T>
    {
        const next = this.serial.then(work, work)
        this.serial = next.catch(() => undefined)
        return next
    }

    private static IsSelfUpgrade(kept: KeptIntent): boolean
    {
        const action = kept.Intent.Action
        return action instanceof ComponentAtVersion && EngineWorkloads.IsAgent(action.Component)
    }
}
