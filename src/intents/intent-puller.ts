import {
    ComponentAtVersion, Intent, IntentApplyMode, IntentChoice, IntentDecision, IntentDecisionKind, IntentDecisionRefusal, IntentFailure, IntentNotAcceptedError,
    IntentProgress, IntentStatus, KeptIntentListing, MessageKind, ProtocolVerificationError, Pull, PullBatch, Rotate, RotationSubject, VerificationFailure,
    type IAgentChannel, type IntentDecisionCall, type KeptIntentView, type VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlatformTrust } from '../enrolment/platform-trust.js'
import { HiveSigning } from '../identity/hive-signing.js'
import type { ITickTarget } from '../tick-loop.js'
import { ApprovalSigner } from './approval-signer.js'
import { EngineWorkloads } from './engine-workloads.js'
import type { IntentAdmissionDecider } from './intent-admission-decider.js'
import type { IApplyContext, IIntentExecutor } from './intent-executor-contract.js'
import type { IntentLease } from './intent-lease.js'
import { IntentStoreFullError, KeptIntent, type IntentStore } from './intent-store.js'

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
    /** One pod applies at a time (absent in tests of one pod). */
    Lease?: IntentLease
    /** Sends a report now: before the agent's own upgrade rolls, so the platform has seen `applying`. */
    ReportNow?: () => Promise<void>
    /** At most this many full batches per tick (then the next tick goes on). */
    MaxBatches?: number
    /** How often the lease is renewed while one apply runs (a roll may take minutes). */
    LeaseRenewMs?: number
}

/** The apply context over the kept intent as it is now (what NotePrevious recorded is what a revert reads). */
class KeptApplyContext implements IApplyContext
{
    public constructor(private kept: KeptIntent, private readonly store: IntentStore)
    {
    }

    public get Kept(): KeptIntent
    {
        return this.kept
    }

    public get PreviousImage(): string | null
    {
        return this.kept.PreviousImage
    }

    public async NotePrevious(image: string): Promise<void>
    {
        this.kept = this.kept.WithPrevious(image)
        this.store.Put(this.kept)
        await this.store.Save()
    }
}

/**
 * The hive's side of pull-only management (C3.4): every tick (by the pod holding the lease) it merges what other writers
 * kept, pulls the intents after its cursor (each batch and each intent verified under the trust root, as addressed to
 * this hive), keeps them (IntentStore), lets the stricter level decide (IntentAdmissionDecider) whether one applies at
 * once or waits for an admin's approval, marks waiting intents past their expiry expired, and applies what is due. An
 * intent applies only when Delegated mode allows it or a stored approval verifies under the hive key for its exact digest
 * (a status edited in the ConfigMap approves nothing). The agent's own upgrade waits for the rest of its batch and is
 * reported before it rolls. Every kept intent is rechecked before it is decided on and again before it is applied; one
 * that expired mid-roll is put back first. A pull the platform refuses under the current key while a rotated key is
 * pending proves the pending key and pulls again; a failed pull never stops the expiry and apply steps. Decisions run on
 * their own queue, beside a tick (a roll may take minutes); their writes merge with the tick's.
 */
export class IntentPuller implements ITickTarget, IIntentDesk
{
    public static readonly DefaultMaxBatches = 10
    /** A third of the lease's duration. */
    public static readonly DefaultLeaseRenewMs = 30_000
    private static readonly LeaseErrorEvent = 'intent-lease-error'
    private static readonly SkippedEvent = 'intent-skipped'
    private static readonly AdmittedEvent = 'intent-admitted'
    private static readonly SettledEvent = 'intent-settled'
    private static readonly DecidedEvent = 'intent-decided'
    private static readonly RefusedEvent = 'intent-store-full'
    private static readonly NotApprovedEvent = 'intent-not-approved'
    private static readonly OtherDigestEvent = 'intent-refused-other-digest'
    private static readonly ApplyErrorEvent = 'intent-apply-error'
    private static readonly UnknownError = 'Error'
    private static readonly Base64Url = 'base64url'
    private readonly approvals: ApprovalSigner
    private ticks: Promise<unknown> = Promise.resolve()
    private decisions: Promise<unknown> = Promise.resolve()

    public constructor(private readonly options: IntentPullerOptions)
    {
        this.approvals = new ApprovalSigner(options.Signing)
    }

    public Tick(): Promise<void>
    {
        const next = this.ticks.then(() => this.Run(), () => this.Run())
        this.ticks = next.catch(() => undefined)
        return next
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
        const next = this.decisions.then(() => this.TakeDecision(intentId, call), () => this.TakeDecision(intentId, call))
        this.decisions = next.catch(() => undefined)
        const view = await next
        if (call.Decision === IntentChoice.Approve)
        {
            // Pull and apply at once after an approval (not awaited: the console has its answer).
            void this.Tick().catch(error => this.TickFailed(error, 0))
        }
        return view
    }

    private async Run(): Promise<void>
    {
        const o = this.options
        if (o.Lease !== undefined && !await o.Lease.Acquire())
        {
            return
        }
        await o.Store.Refresh()
        let failure: unknown
        try
        {
            await this.PullProving()
        }
        catch (error)
        {
            failure = error
        }
        this.ExpireWaiting()
        await o.Store.Save()
        await this.ApplyDue()
        if (failure !== undefined)
        {
            throw failure
        }
    }

    /** Pulls; a pull refused under the current key while a rotated key is pending proves that key, then pulls again. */
    private async PullProving(): Promise<void>
    {
        try
        {
            await this.Pull()
        }
        catch (error)
        {
            if (!HiveSigning.NotVerified(error) || !await this.options.Signing.ProvePending(this.options.Channel, this.options.Store.Cursor))
            {
                throw error
            }
            // The rotation that announced the pending key has taken effect: it is applied, never announced again.
            for (const kept of this.options.Store.All())
            {
                if (kept.Progress === IntentProgress.Applying && IntentPuller.IsHiveKeyRotation(kept))
                {
                    this.options.Store.Put(kept.With(IntentProgress.Applied))
                }
            }
            await this.Pull()
        }
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
            const admitted: string[] = []
            for (const item of batch.Items)
            {
                // After a restore the platform also answers open intents this hive keeps already, whatever their
                // sequence: a kept id is skipped before verification would claim its nonce again (the same envelope
                // resent), and a kept id under another digest is refused, the kept intent left as it is.
                const keptId = IntentPuller.IntentIdOf(item.Body)
                const kept = keptId === undefined ? undefined : o.Store.Get(keptId)
                if (kept !== undefined)
                {
                    if (kept.Digest !== item.Digest)
                    {
                        o.Log.Event(IntentPuller.OtherDigestEvent)
                    }
                    continue
                }
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
                if (this.Admit(intent, batch.Cursor))
                {
                    admitted.push(intent.Body.IntentId)
                }
            }
            o.Store.SetCursor(batch.Cursor)
            try
            {
                await o.Store.Save()
            }
            catch (error)
            {
                if (!(error instanceof IntentStoreFullError))
                {
                    throw error
                }
                // No room for this batch: it is refused (reported failed), the cursor moves on, the loop never wedges.
                o.Store.Refuse(admitted)
                o.Log.Event(IntentPuller.RefusedEvent, String(admitted.length))
                await o.Store.Save()
            }
            if (batch.Items.length < Pull.MaxItems)
            {
                return
            }
        }
    }

    /** Keeps a newly verified intent: applied at once or waiting, by the stricter level. The same intent again is ignored. */
    private Admit(intent: VerifiedMessage<Intent>, batch: number): boolean
    {
        const store = this.options.Store
        if (store.Get(intent.Body.IntentId) !== undefined)
        {
            return false
        }
        const fresh = new KeptIntent(intent.Envelope, intent.Body, IntentStatus.Of(intent.Body.IntentId, IntentProgress.AwaitingApproval), null, null, batch)
        const mode = this.ModeOf(intent.Body)
        store.Put(mode === undefined ? fresh.Failed(IntentFailure.PrecheckRefused) : fresh.With(mode === IntentApplyMode.ApplyDirectly ? IntentProgress.Applying : IntentProgress.AwaitingApproval))
        this.options.Log.Event(IntentPuller.AdmittedEvent, store.Get(intent.Body.IntentId)?.Progress)
        return true
    }

    private ModeOf(intent: Intent): IntentApplyMode | undefined
    {
        try
        {
            return this.options.Decider.ModeFor(intent)
        }
        catch (error)
        {
            if (error instanceof IntentNotAcceptedError)
            {
                return undefined
            }
            throw error
        }
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

    /** Applies every intent that is due, in order; the agent's own upgrade last, and only once the rest of its batch is settled. */
    private async ApplyDue(): Promise<void>
    {
        const all = this.options.Store.All()
        const due = all.filter(kept => kept.Progress === IntentProgress.Applying)
        const others = due.filter(kept => !IntentPuller.IsSelfUpgrade(kept))
        for (const kept of others)
        {
            await this.ApplyOne(kept)
        }
        for (const kept of due.filter(candidate => IntentPuller.IsSelfUpgrade(candidate)))
        {
            const waiting = this.options.Store.All().some(other => other.IntentId !== kept.IntentId && other.Batch === kept.Batch && !other.Settled && !IntentPuller.IsSelfUpgrade(other))
            if (!waiting)
            {
                await this.ApplyOne(kept)
            }
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
        if (!this.Authorized(kept))
        {
            // Applying without Delegated mode or a valid approval (an edited ConfigMap): back to waiting for one.
            o.Store.Put(kept.Demote())
            o.Log.Event(IntentPuller.NotApprovedEvent)
            await o.Store.Save()
            return
        }
        if (IntentPuller.IsSelfUpgrade(kept) && o.ReportNow !== undefined)
        {
            await o.ReportNow()
        }
        const context = new KeptApplyContext(kept, o.Store)
        // A roll may outlast the lease: it is renewed while this apply runs.
        const lease = o.Lease
        const renewal = lease === undefined ? undefined : setInterval(() =>
        {
            void lease.Acquire().catch(error => o.Log.Event(IntentPuller.LeaseErrorEvent, error instanceof Error ? error.name : IntentPuller.UnknownError))
        }, o.LeaseRenewMs ?? IntentPuller.DefaultLeaseRenewMs)
        renewal?.unref()
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
        finally
        {
            clearInterval(renewal)
        }
        o.Store.Put(context.Kept.WithStatus(status))
        await o.Store.Save()
        o.Log.Event(IntentPuller.SettledEvent, status.Failure ?? status.Progress)
    }

    /** Delegated mode, or the hive's own approval of exactly this intent (its digest), signed by the hive key. */
    private Authorized(kept: KeptIntent): boolean
    {
        if (this.ModeOf(kept.Intent) === IntentApplyMode.ApplyDirectly)
        {
            return true
        }
        const decision = kept.Decision
        const signing = this.options.Signing
        if (decision === null || decision.Kind !== MessageKind.IntentDecision || !decision.Issuer.Equals(signing.Self) || decision.KeyId !== signing.Key.KeyId
            || !signing.Key.PublicKey.Verify(decision.SigningInput(), Buffer.from(decision.Signature, IntentPuller.Base64Url)))
        {
            return false
        }
        try
        {
            const body = IntentDecision.Parse(decision.Body)
            return body.Decision === IntentDecisionKind.Approved && body.Answers(kept.Envelope, kept.Intent)
        }
        catch
        {
            return false
        }
    }

    /** The kept intent verified again (not its nonce); an expired one is put back (mid-roll) and marked expired, any other failure failed. */
    private async Recheck(kept: KeptIntent): Promise<VerifiedMessage<Intent> | undefined>
    {
        const o = this.options
        try
        {
            const verified = await o.Trust.Verifier().Recheck(kept.Envelope, MessageKind.Intent, Intent)
            if (verified.Body.IntentId !== kept.IntentId)
            {
                o.Store.Put(kept.Failed(IntentFailure.RecheckFailed))
                return undefined
            }
            return verified
        }
        catch (error)
        {
            if (kept.PreviousImage !== null)
            {
                await o.Executor.Revert(kept.Intent, kept.PreviousImage)
            }
            const expired = error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.Expired
            o.Store.Put(expired ? kept.With(IntentProgress.Expired) : kept.Failed(IntentFailure.RecheckFailed))
            return undefined
        }
    }

    private async TakeDecision(intentId: string, call: IntentDecisionCall): Promise<KeptIntentView>
    {
        const o = this.options
        const R = IntentDecisionRefusal
        await o.Store.Refresh()
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
        // Expired by its own date: refused even inside the verifier's clock-skew window.
        if (kept.Envelope.ExpiresAt.getTime() <= o.Signing.Clock.Now().getTime())
        {
            o.Store.Put(kept.With(IntentProgress.Expired))
            await o.Store.Save()
            throw new IntentDecisionRefusedError(R.Expired)
        }
        const verified = await this.Recheck(kept)
        if (verified === undefined)
        {
            await o.Store.Save()
            throw new IntentDecisionRefusedError(o.Store.Get(intentId)?.Progress === IntentProgress.Expired ? R.Expired : R.NotAwaiting)
        }
        const decision = this.approvals.Sign(verified, call.Decision, call.Approver)
        try
        {
            await o.Channel.Exchange(decision)
        }
        catch
        {
            throw new IntentDecisionRefusedError(R.Unavailable)
        }
        // What a tick or another pod did meanwhile (an expiry above all) wins over this decision.
        await o.Store.Refresh()
        const current = o.Store.Get(intentId)
        if (current === undefined || current.Digest !== kept.Digest || current.Progress !== IntentProgress.AwaitingApproval)
        {
            return (current ?? kept).View()
        }
        const decided = current.WithDecision(decision).With(call.Decision === IntentChoice.Approve ? IntentProgress.Applying : IntentProgress.Rejected)
        o.Store.Put(decided)
        await o.Store.Save()
        o.Log.Event(IntentPuller.DecidedEvent, call.Decision)
        return decided.View()
    }

    /** The intent id an item's body names (unverified: only to recognise a kept one), or undefined. */
    private static IntentIdOf(body: Readonly<Record<string, unknown>>): string | undefined
    {
        try
        {
            return Intent.Parse(body).IntentId
        }
        catch
        {
            return undefined
        }
    }

    private static IsHiveKeyRotation(kept: KeptIntent): boolean
    {
        const action = kept.Intent.Action
        return action instanceof Rotate && action.Subject === RotationSubject.HiveKey
    }

    private static IsSelfUpgrade(kept: KeptIntent): boolean
    {
        const action = kept.Intent.Action
        return action instanceof ComponentAtVersion && EngineWorkloads.IsAgent(action.Component)
    }
}
