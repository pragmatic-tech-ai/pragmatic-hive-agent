import { ComponentReadyFile, SecretVariable } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'

/**
 * What the agent runs on, read from its environment after the start step laid its applied configuration over it
 * (`ComponentStartConfiguration`): the channel, the hive, the bearer token (from `PRAGMATIC_AGENT_TOKEN_FILE`, where a
 * configured secret is written, else the injected variable) and the poll timing.
 */
export class AgentSettings
{
    public static readonly RegistryUrlEnv = 'PRAGMATIC_AGENT_REGISTRY_URL'
    public static readonly HiveIdEnv = 'PRAGMATIC_AGENT_HIVE_ID'
    public static readonly TokenEnv = 'PRAGMATIC_AGENT_TOKEN'
    public static readonly PollIntervalEnv = 'PRAGMATIC_AGENT_POLL_INTERVAL_MS'
    public static readonly MaxBackoffEnv = 'PRAGMATIC_AGENT_MAX_BACKOFF_MS'
    public static readonly DefaultPollIntervalMs = 30000
    public static readonly DefaultMaxBackoffMs = 300000
    private static readonly MissingEnvPrefix = 'missing required environment variable '
    private static readonly TrailingSlash = /\/+$/
    private static readonly Empty = ''

    private constructor(
        public readonly RegistryUrl: string,
        public readonly HiveId: string,
        public readonly Token: string,
        public readonly PollMs: number,
        public readonly MaxBackoffMs: number,
    )
    {
        Object.freeze(this)
    }

    /**
     * The settings, read after the start step; once they read, the agent marks itself ready (the file its readiness probe
     * tests for), so a configuration that stops it starting never counts as a finished surge roll.
     */
    public static Started(env: NodeJS.ProcessEnv, ready: ComponentReadyFile = new ComponentReadyFile()): AgentSettings
    {
        const settings = AgentSettings.From(env)
        ready.Mark()
        return settings
    }

    public static From(env: NodeJS.ProcessEnv): AgentSettings
    {
        const S = AgentSettings
        return new AgentSettings(
            S.Required(env, S.RegistryUrlEnv).replace(S.TrailingSlash, S.Empty),
            S.Required(env, S.HiveIdEnv),
            S.Present(SecretVariable.Read(env, S.TokenEnv), S.TokenEnv),
            S.PositiveInt(env, S.PollIntervalEnv, S.DefaultPollIntervalMs),
            S.PositiveInt(env, S.MaxBackoffEnv, S.DefaultMaxBackoffMs),
        )
    }

    /** The poll interval the environment sets (or the default): also how often an unenrolled agent re-reads its token. */
    public static PollMsOf(env: NodeJS.ProcessEnv): number
    {
        return AgentSettings.PositiveInt(env, AgentSettings.PollIntervalEnv, AgentSettings.DefaultPollIntervalMs)
    }

    /** The longest wait after failed ticks the environment sets (or the default). */
    public static MaxBackoffMsOf(env: NodeJS.ProcessEnv): number
    {
        return AgentSettings.PositiveInt(env, AgentSettings.MaxBackoffEnv, AgentSettings.DefaultMaxBackoffMs)
    }

    private static Required(env: NodeJS.ProcessEnv, key: string): string
    {
        return AgentSettings.Present(env[key], key)
    }

    private static Present(value: string | undefined, key: string): string
    {
        if (value === undefined || value === AgentSettings.Empty)
        {
            throw new Error(AgentSettings.MissingEnvPrefix + key)
        }
        return value
    }

    private static PositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number
    {
        const parsed = Number(env[key])
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }
}
