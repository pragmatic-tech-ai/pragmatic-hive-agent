import { ConsoleIntentCall, IntentActionKind, type Intent, type IntentStatus, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { ComponentAtVersionHandler } from './handlers/component-at-version-handler.js'
import type { EnvironmentIntentForwarder } from './handlers/environment-intent-forwarder.js'
import type { RepairHandler } from './handlers/repair-handler.js'
import type { RotateHandler } from './handlers/rotate-handler.js'
import type { IApplyContext, IIntentExecutor } from './intent-executor-contract.js'

/**
 * Applies one admitted intent by its action (C3.4): what the console owns (environments, an environment's repair, the
 * ingress certificate) is forwarded to it; the engine's components, rotations of the trust root and hive key, and
 * engine or component repairs the agent applies itself. No action reads anything from the hive's data.
 */
export class IntentExecutor implements IIntentExecutor
{
    public constructor(
        private readonly components: ComponentAtVersionHandler,
        private readonly rotations: RotateHandler,
        private readonly repairs: RepairHandler,
        private readonly forwarder: EnvironmentIntentForwarder)
    {
    }

    public async Apply(intent: VerifiedMessage<Intent>, context: IApplyContext): Promise<IntentStatus>
    {
        const id = intent.Body.IntentId
        const action = intent.Body.Action
        if (ConsoleIntentCall.Forwards(action))
        {
            return this.forwarder.Forward(id, action)
        }
        switch (action.Kind)
        {
            case IntentActionKind.ComponentAtVersion:
                return this.components.Apply(id, action, context)
            case IntentActionKind.Rotate:
                return this.rotations.Apply(intent, action)
            case IntentActionKind.Repair:
                return this.repairs.Apply(id, action)
            default:
                return this.forwarder.Forward(id, action)
        }
    }
}
