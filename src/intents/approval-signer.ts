import { IntentDecision, IntentDecisionKind, IntentChoice, MessageKind, type Intent, type RealmSubject, type SignedEnvelope, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { HiveSigning } from '../identity/hive-signing.js'

/**
 * The hive's answer to an intent awaiting approval (C3.4 ruling "approvals"): an IntentDecision signed by the hive key
 * inside the agent, on the console's instruction (the console never holds the key). It names the intent by id and by the
 * digest of the exact signed intent, and the approver's realm subject; a rejection carries no reason.
 */
export class ApprovalSigner
{
    private static readonly Kinds: ReadonlyMap<IntentChoice, IntentDecisionKind> = new Map([
        [IntentChoice.Approve, IntentDecisionKind.Approved],
        [IntentChoice.Reject, IntentDecisionKind.Rejected],
    ])

    public constructor(private readonly signing: HiveSigning)
    {
    }

    public Sign(intent: VerifiedMessage<Intent>, choice: IntentChoice, approver: RealmSubject): SignedEnvelope
    {
        const decision = IntentDecision.For(intent, ApprovalSigner.Kinds.get(choice) as IntentDecisionKind, approver, this.signing.Clock.Now())
        return this.signing.Sign(MessageKind.IntentDecision, decision)
    }
}
