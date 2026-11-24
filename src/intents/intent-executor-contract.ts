import type { Intent, IntentStatus, VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** What an apply may remember across an agent restart: the image a component-at-version replaced. */
export interface IApplyContext
{
    readonly PreviousImage: string | null
    NotePrevious(image: string): Promise<void>
}

/**
 * Applies one verified, admitted intent and answers its status: applied, failed with a code, or `applying` when it
 * could not be finished now and is tried again on the next tick (while it has not expired).
 */
export interface IIntentExecutor
{
    Apply(intent: VerifiedMessage<Intent>, context: IApplyContext): Promise<IntentStatus>
}
