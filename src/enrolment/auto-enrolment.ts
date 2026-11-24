import { HiveEnrolmentRefusal, HiveLevel, type ConsoleAddress } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveKube } from '../kube/hive-kube.js'
import { TickLoop, type ITickDelay, type ITickTiming } from '../tick-loop.js'
import { HiveEnrolmentRefusedError, type HiveEnrolment } from './hive-enrolment.js'

/** How one AutoEnrolment attempt ended. */
export enum AutoEnrolmentOutcome
{
    /** Enrolled with the host agent's code; the code Secret is deleted. */
    Enrolled = 'enrolled',
    /** Already enrolled (a restart after enrolment): the code Secret, if any is left, is deleted. */
    AlreadyEnrolled = 'already-enrolled',
    /** No code Secret yet: the host agent has not written it. */
    NoCode = 'no-code',
    /** The platform could not be reached or answered `unavailable`: try again later with the same code. */
    Retry = 'retry',
    /**
     * The platform refused the code for good (used, unknown, expired, another tenant or level): the Secret is kept and
     * the same code is never sent again; a new code in the Secret (the host agent re-placing the hive) is tried.
     */
    Refused = 'refused',
}

/** What AutoEnrolment logs: events and codes only, never the code itself. */
export interface IAutoEnrolmentLog
{
    Event(event: string, code?: string): void
    /** An attempt failed with an error (a Kubernetes call): logged by its name, then retried after the backoff. */
    Failed(error: unknown, backoffMs: number): void
}

/** The code Secret is there but holds no code (edited by hand?). */
export class EnrolmentCodeSecretUnusableError extends Error
{
    private static readonly ErrorName = 'EnrolmentCodeSecretUnusableError'
    private static readonly Text = 'the Secret pragmatic-hive-enrolment-code holds no code'

    public constructor()
    {
        super(EnrolmentCodeSecretUnusableError.Text)
        this.name = EnrolmentCodeSecretUnusableError.ErrorName
    }
}

/**
 * A Hosted engine enrolling itself (C5.1): the platform's host agent writes the hive's one-time code into the Secret
 * `pragmatic-hive-enrolment-code` (key `code`) before it installs the chart, so the code never appears on a command line
 * or in chart values and the hive's key is still generated in the cluster. At start the agent enrols with it at level
 * hosted under the console address the placement named, then deletes the Secret; an enrolled agent deletes a leftover
 * one. A refusal for good keeps the Secret (the host agent then reports the placement failed) and that code is not sent
 * again; an unreachable platform is retried with the same code.
 */
export class AutoEnrolment
{
    public static readonly SecretName = 'pragmatic-hive-enrolment-code'
    public static readonly CodeKey = 'code'
    private static readonly RetryCodes: ReadonlySet<HiveEnrolmentRefusal> = new Set([HiveEnrolmentRefusal.Unavailable])
    private static readonly EnrolledEvent = 'auto-enrolled'
    private static readonly AlreadyEnrolledEvent = 'auto-enrolment-already-enrolled'
    private static readonly RetryEvent = 'auto-enrolment-retry'
    private static readonly RefusedEvent = 'auto-enrolment-refused'
    private static readonly Final: ReadonlySet<AutoEnrolmentOutcome> = new Set([AutoEnrolmentOutcome.Enrolled, AutoEnrolmentOutcome.AlreadyEnrolled])
    private refusedCode: string | undefined

    public constructor(
        private readonly kube: IHiveKube,
        private readonly namespace: string,
        private readonly enrolment: HiveEnrolment,
        private readonly consoleAddress: ConsoleAddress,
        private readonly log: IAutoEnrolmentLog)
    {
    }

    /**
     * Attempts until the hive is enrolled: no code yet or an unreachable platform waits the poll interval, a refused code
     * the longest backoff; a failed attempt (an error) doubles the wait up to the longest backoff, as the tick loop does.
     */
    public async UntilEnrolled(timing: ITickTiming, delay: ITickDelay): Promise<AutoEnrolmentOutcome>
    {
        let wait = timing.PollMs
        for (;;)
        {
            try
            {
                const outcome = await this.Attempt()
                if (AutoEnrolment.Final.has(outcome))
                {
                    return outcome
                }
                wait = outcome === AutoEnrolmentOutcome.Refused ? timing.MaxBackoffMs : timing.PollMs
            }
            catch (error)
            {
                wait = Math.min(wait * TickLoop.BackoffFactor, timing.MaxBackoffMs)
                this.log.Failed(error, wait)
            }
            await delay.Wait(wait)
        }
    }

    /** One attempt, as UntilEnrolled runs it. */
    public async Attempt(): Promise<AutoEnrolmentOutcome>
    {
        const A = AutoEnrolment
        const data = await this.kube.GetSecretData(this.namespace, A.SecretName)
        if (this.enrolment.Enrolled !== undefined)
        {
            if (data !== undefined)
            {
                await this.kube.DeleteSecret(this.namespace, A.SecretName)
            }
            this.log.Event(A.AlreadyEnrolledEvent)
            return AutoEnrolmentOutcome.AlreadyEnrolled
        }
        if (data === undefined)
        {
            return AutoEnrolmentOutcome.NoCode
        }
        const code = data[A.CodeKey]?.trim() ?? ''
        if (code === '')
        {
            throw new EnrolmentCodeSecretUnusableError()
        }
        if (code === this.refusedCode)
        {
            return AutoEnrolmentOutcome.Refused
        }
        try
        {
            await this.enrolment.Enrol({ Code: code, Level: HiveLevel.Hosted, ConsoleAddress: this.consoleAddress })
        }
        catch (error)
        {
            if (!(error instanceof HiveEnrolmentRefusedError))
            {
                throw error
            }
            if (error.Code === HiveEnrolmentRefusal.AlreadyEnrolled)
            {
                return this.Attempt()
            }
            const retry = A.RetryCodes.has(error.Code)
            if (!retry)
            {
                this.refusedCode = code
            }
            this.log.Event(retry ? A.RetryEvent : A.RefusedEvent, error.Code)
            return retry ? AutoEnrolmentOutcome.Retry : AutoEnrolmentOutcome.Refused
        }
        await this.kube.DeleteSecret(this.namespace, A.SecretName)
        this.log.Event(A.EnrolledEvent)
        return AutoEnrolmentOutcome.Enrolled
    }
}
