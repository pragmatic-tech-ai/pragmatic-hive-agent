/** Waits between two rollout ticks; the agent's is a timer, a test's records the waits. */
export interface ITickDelay
{
    Wait(ms: number): Promise<void>
}

/** What the loop runs: one tick (a check-in), and what to do when one fails with the backoff the loop chose. */
export interface ITickTarget
{
    Tick(): Promise<void>
    TickFailed(error: unknown, backoffMs: number): void
}

/** The timing the loop takes from the agent's settings. */
export interface ITickTiming
{
    readonly PollMs: number
    readonly MaxBackoffMs: number
}

/** The real wait: a timer. */
export class TimerTickDelay implements ITickDelay
{
    public Wait(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }
}

/**
 * The agent's cadence (its check-in: every tick reports the hive's snapshot, the platform's "last seen"): one tick,
 * then `PollMs` (the configured `pollIntervalMs`); a failed tick doubles the wait, up to `MaxBackoffMs`, and the next
 * good tick resets it to `PollMs`.
 */
export class TickLoop
{
    public static readonly BackoffFactor = 2

    private constructor(private readonly target: ITickTarget, private readonly pollMs: number, private readonly maxBackoffMs: number, private readonly delay: ITickDelay)
    {
    }

    /** The loop on the agent's settings: what AgentMain runs. */
    public static For(timing: ITickTiming, target: ITickTarget, delay: ITickDelay = new TimerTickDelay()): TickLoop
    {
        return new TickLoop(target, timing.PollMs, timing.MaxBackoffMs, delay)
    }

    /** Runs `ticks` ticks (forever by default), each followed by its wait. */
    public async Run(ticks: number = Number.POSITIVE_INFINITY): Promise<void>
    {
        let wait = this.pollMs
        for (let n = 0; n < ticks; n++)
        {
            try
            {
                await this.target.Tick()
                wait = this.pollMs
            }
            catch (error)
            {
                wait = Math.min(wait * TickLoop.BackoffFactor, this.maxBackoffMs)
                this.target.TickFailed(error, wait)
            }
            await this.delay.Wait(wait)
        }
    }
}
