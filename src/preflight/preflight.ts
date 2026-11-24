import { PreflightResults, type IPreflightCheck, type PreflightResult } from './preflight-check.js'

/** Runs every check in order, each one even after an earlier one failed, so the operator sees all problems at once. */
export class Preflight
{
    private static readonly ErrorPrefix = 'the check itself failed: '
    private static readonly RetryFix = 'Re-run the install; if it fails again, read the preflight Job log (kubectl logs -n <namespace> job/pragmatic-engine-preflight).'

    public constructor(private readonly checks: readonly IPreflightCheck[])
    {
    }

    public async Run(): Promise<readonly PreflightResult[]>
    {
        const results: PreflightResult[] = []
        for (const check of this.checks)
        {
            results.push(await Preflight.RunOne(check))
        }
        return results
    }

    /** A check that throws (an API error, a refused request) is a Fail naming it, never an aborted preflight. */
    private static async RunOne(check: IPreflightCheck): Promise<PreflightResult>
    {
        try
        {
            return await check.Run()
        }
        catch (error)
        {
            return PreflightResults.Fail(check.Name, Preflight.ErrorPrefix + (error instanceof Error ? error.message : String(error)), Preflight.RetryFix)
        }
    }
}
