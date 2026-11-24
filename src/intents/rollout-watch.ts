/** How long the agent waits for a workload to roll out, how often it looks, and how it waits (a timer; a test's clock). */
export interface RolloutWatchOptions
{
    TimeoutMs: number
    PollMs: number
    Sleep?: (ms: number) => Promise<void>
    Now?: () => number
}

/** Polls a condition until it holds or the deadline passes. */
export class RolloutWatch
{
    public static readonly DefaultTimeoutMs = 600_000
    public static readonly DefaultPollMs = 5_000
    private readonly sleep: (ms: number) => Promise<void>
    private readonly now: () => number

    public constructor(private readonly options: RolloutWatchOptions)
    {
        this.sleep = options.Sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
        this.now = options.Now ?? (() => Date.now())
    }

    /** True once `condition` holds; false when it still does not at the deadline. */
    public async Until(condition: () => Promise<boolean>): Promise<boolean>
    {
        const deadline = this.now() + this.options.TimeoutMs
        for (;;)
        {
            if (await condition())
            {
                return true
            }
            if (this.now() >= deadline)
            {
                return false
            }
            await this.sleep(this.options.PollMs)
        }
    }
}
