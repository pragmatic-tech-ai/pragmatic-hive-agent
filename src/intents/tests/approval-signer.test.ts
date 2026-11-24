import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Intent, IntentChoice, IntentDecision, IntentDecisionKind, MessageKind, RealmSubject } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { ApprovalSigner } from '../approval-signer.js'
import { IntentWorld } from './intent-world.js'

describe('ApprovalSigner', () =>
{
    it('signs a decision with the intent\'s digest and the approver under the hive key, and no reason text', async () =>
    {
        const world = await IntentWorld.Enrolled()
        world.Publish()
        await world.Puller.Tick()
        const kept = world.Store.Get('intent-2')!
        const verified = await world.Trust.Verifier().Recheck(kept.Envelope, MessageKind.Intent, Intent)
        const approver = RealmSubject.Of('acme', 'u-7')
        for (const [choice, kind] of [[IntentChoice.Approve, IntentDecisionKind.Approved], [IntentChoice.Reject, IntentDecisionKind.Rejected]] as const)
        {
            const envelope = new ApprovalSigner(world.Signing).Sign(verified, choice, approver)
            assert.equal(envelope.Kind, MessageKind.IntentDecision)
            assert.equal(envelope.KeyId, world.Signing.Key.KeyId)
            assert.ok(world.Signing.Key.PublicKey.Verify(envelope.SigningInput(), Buffer.from(envelope.Signature, 'base64url')))
            const body = IntentDecision.Parse(envelope.Body)
            assert.equal(body.IntentDigest, kept.Digest)
            assert.equal(body.Decision, kind)
            assert.deepEqual(body.Approver.ToJson(), approver.ToJson())
            assert.deepEqual(Object.keys(envelope.Body).sort(), ['Approver', 'DecidedAt', 'Decision', 'IntentDigest', 'IntentId'])
        }
    })
})
