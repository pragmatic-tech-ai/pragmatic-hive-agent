/** How one preflight check ended. A Fail stops the install; Warn and Skip never do. */
export enum PreflightOutcome
{
    Pass = 'pass',
    Fail = 'fail',
    Warn = 'warn',
    Skip = 'skip',
}

/** One check's answer: its name, how it ended, a sentence on what it found, and the fix (empty unless it failed or warns). */
export type PreflightResult = { Check: string; Outcome: PreflightOutcome; Message: string; Fix: string }

/** One guardrail of the engine install, run by the preflight hook Job before any workload is created. */
export interface IPreflightCheck
{
    readonly Name: string
    Run(): Promise<PreflightResult>
}

/** Builds results, so every check words its outcome the same way. */
export class PreflightResults
{
    private static readonly NoFix = ''

    private constructor()
    {
    }

    public static Pass(check: string, message: string): PreflightResult
    {
        return { Check: check, Outcome: PreflightOutcome.Pass, Message: message, Fix: PreflightResults.NoFix }
    }

    public static Skip(check: string, message: string): PreflightResult
    {
        return { Check: check, Outcome: PreflightOutcome.Skip, Message: message, Fix: PreflightResults.NoFix }
    }

    public static Warn(check: string, message: string, fix: string): PreflightResult
    {
        return { Check: check, Outcome: PreflightOutcome.Warn, Message: message, Fix: fix }
    }

    public static Fail(check: string, message: string, fix: string): PreflightResult
    {
        return { Check: check, Outcome: PreflightOutcome.Fail, Message: message, Fix: fix }
    }
}
