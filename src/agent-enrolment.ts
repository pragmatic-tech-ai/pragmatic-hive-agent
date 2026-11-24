import { existsSync, readFileSync } from 'node:fs'
import { ComponentReadyFile } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { AgentSettings } from './agent-settings.js'

/** Waits between two looks at the token file. */
export interface IEnrolmentWait
{
    Wait(ms: number): Promise<void>
}

/** A timer wait. */
export class TimerEnrolmentWait implements IEnrolmentWait
{
    public Wait(ms: number): Promise<void>
    {
        return new Promise<void>(resolve => setTimeout(resolve, ms))
    }
}

/**
 * Whether the hive is enrolled: the agent holds its channel token (the injected variable, or a non-empty file at
 * `PRAGMATIC_AGENT_TOKEN_FILE`). A chart install of level `connected` mounts the token Secret optionally, so before
 * enrolment the file is absent; the agent then waits idle and ready (it has nothing to roll) and starts once it appears.
 */
export class AgentEnrolment
{
    private static readonly Utf8 = 'utf8'
    private static readonly FileSuffix = '_FILE'

    public constructor(private readonly wait: IEnrolmentWait = new TimerEnrolmentWait(), private readonly ready: ComponentReadyFile = new ComponentReadyFile())
    {
    }

    public static IsEnrolled(env: NodeJS.ProcessEnv): boolean
    {
        const file = env[AgentSettings.TokenEnv + AgentEnrolment.FileSuffix]
        if (file !== undefined && file !== '')
        {
            return existsSync(file) && readFileSync(file, AgentEnrolment.Utf8).trim() !== ''
        }
        const token = env[AgentSettings.TokenEnv]
        return token !== undefined && token !== ''
    }

    /** Marks the agent ready, then re-reads the token every poll interval until the hive is enrolled. */
    public async AwaitEnrolled(env: NodeJS.ProcessEnv): Promise<void>
    {
        this.ready.Mark()
        const poll = AgentSettings.PollMsOf(env)
        while (!AgentEnrolment.IsEnrolled(env))
        {
            await this.wait.Wait(poll)
        }
    }
}
