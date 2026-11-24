import { IntentFailure, IntentProgress, IntentStatus, ProtocolVerificationError, RotationSubject, type IAgentChannel, type Intent, type Rotate, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlatformTrust } from '../../enrolment/platform-trust.js'
import { HiveKeyRotationMismatchError, type HiveSigning } from '../../identity/hive-signing.js'
import type { EnvironmentIntentForwarder } from './environment-intent-forwarder.js'

/**
 * "Rotate S" (C3.4). The trust root: the intent itself verified under the current root (and was rechecked just before
 * this), so its new key is adopted, kept with the intent that proves it; an intent not signed by the current root never
 * reaches here. The hive key: a new key announced under the current one, swapped only after the platform's verified
 * acknowledgement names it (HiveSigning.Rotate). The ingress certificate: the console renews it (forwarded).
 */
export class RotateHandler
{
    public constructor(
        private readonly trust: PlatformTrust,
        private readonly signing: HiveSigning,
        private readonly channel: IAgentChannel,
        private readonly forwarder: EnvironmentIntentForwarder)
    {
    }

    public async Apply(intent: VerifiedMessage<Intent>, action: Rotate): Promise<IntentStatus>
    {
        const id = intent.Body.IntentId
        switch (action.Subject)
        {
            case RotationSubject.TrustRoot:
            {
                const root = action.NewTrustRoot
                if (root === null || intent.Envelope.KeyId !== this.trust.Root.KeyId)
                {
                    return IntentStatus.FailedWith(id, IntentFailure.RotationRefused)
                }
                if (!root.Equals(this.trust.Root))
                {
                    await this.trust.Adopt(root, intent.Envelope)
                }
                return IntentStatus.Of(id, IntentProgress.Applied)
            }
            case RotationSubject.HiveKey:
                try
                {
                    await this.signing.Rotate(this.channel, this.trust.Verifier())
                    return IntentStatus.Of(id, IntentProgress.Applied)
                }
                catch (error)
                {
                    // An acknowledgement that does not verify or names another key is refused for good; a lost one (no
                    // answer, the platform unreachable) leaves the intent applying: the same rotation is sent again next tick.
                    return error instanceof ProtocolVerificationError || error instanceof HiveKeyRotationMismatchError
                        ? IntentStatus.FailedWith(id, IntentFailure.RotationRefused)
                        : IntentStatus.Of(id, IntentProgress.Applying)
                }
            case RotationSubject.IngressCertificate:
                return this.forwarder.Forward(id, action)
        }
    }
}
