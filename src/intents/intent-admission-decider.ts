import { IntentAdmission, type HiveLevel, type Intent, type IntentApplyMode } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** Where the hive's own level is read (the enrolment: what the customer connected the hive as). */
export interface IHiveLevelSource
{
    readonly Level: HiveLevel
}

/**
 * Whether the agent applies a verified intent at once or keeps it for an admin's approval (C Ledger protocol 8): only
 * when both the hive's level and the intent's are Delegated is it applied directly; otherwise it waits. The stricter
 * level always wins, so a platform that thinks a hive is Delegated cannot skip an approval. Standalone and Hosted take
 * no intents (IntentNotAcceptedError).
 */
export class IntentAdmissionDecider
{
    public constructor(private readonly hive: IHiveLevelSource)
    {
    }

    public ModeFor(intent: Intent): IntentApplyMode
    {
        return new IntentAdmission(this.hive.Level).ModeFor(intent)
    }
}
