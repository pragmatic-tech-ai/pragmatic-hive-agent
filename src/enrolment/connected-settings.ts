import { readFileSync } from 'node:fs'
import { ConsoleAddress, ConsoleAddressOption, ProtocolNames, SigningPublicKey } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AgentSettings } from '../agent-settings.js'

/** A connected agent's setting is missing or not what it must be (names the setting, never a value). */
export class ConnectedSettingError extends Error
{
    private static readonly ErrorName = 'ConnectedSettingError'
    private static readonly Separator = ': '

    public constructor(setting: string, reason: string)
    {
        super(setting + ConnectedSettingError.Separator + reason)
        this.name = ConnectedSettingError.ErrorName
    }
}

/**
 * What a chart-installed (connected) agent enrols and reports with (C3.3), all platform-owned values the chart sets:
 * the tenant it was installed for, the engine version (the release), the platform's agent channel to enrol over, the
 * trust root it was installed with (the platform signing key's public half, pinned: an answer under any other root is
 * refused), its namespace, the console's service account (the only caller of its internal API) and the console's
 * Deployment and the sign-in service it reports on. A Hosted engine (C5.1, placed by the platform's host agent) also
 * names its console address (the host name under hives.pragmatic-tech.ai and its option): it enrols itself at level
 * hosted with the one-time code the host agent wrote (AutoEnrolment) and serves no internal API.
 */
export class ConnectedSettings
{
    public static readonly TenantEnv = 'PRAGMATIC_AGENT_TENANT'
    public static readonly EngineVersionEnv = 'PRAGMATIC_AGENT_ENGINE_VERSION'
    public static readonly TrustRootFileEnv = 'PRAGMATIC_AGENT_TRUST_ROOT_FILE'
    public static readonly NamespaceEnv = 'PRAGMATIC_AGENT_NAMESPACE'
    public static readonly ConsoleServiceAccountEnv = 'PRAGMATIC_AGENT_CONSOLE_SERVICE_ACCOUNT'
    public static readonly ConsoleDeploymentEnv = 'PRAGMATIC_AGENT_CONSOLE_DEPLOYMENT'
    public static readonly IdpNamespaceEnv = 'PRAGMATIC_AGENT_IDP_NAMESPACE'
    public static readonly IdpDeploymentEnv = 'PRAGMATIC_AGENT_IDP_DEPLOYMENT'
    public static readonly PostgresStatefulSetEnv = 'PRAGMATIC_AGENT_POSTGRES_STATEFULSET'
    public static readonly InternalPortEnv = 'PRAGMATIC_AGENT_INTERNAL_PORT'
    public static readonly HostedEnv = 'PRAGMATIC_AGENT_HOSTED'
    public static readonly ConsoleHostEnv = 'PRAGMATIC_AGENT_CONSOLE_HOST'
    public static readonly ConsoleAddressEnv = 'PRAGMATIC_AGENT_CONSOLE_ADDRESS'
    private static readonly HostedValue = 'true'
    private static readonly NotHostedValue = 'false'
    public static readonly DefaultNamespace = 'pragmatic-system'
    private static readonly Missing = 'is required for a connected agent'
    private static readonly BadValue = 'is not in the expected form'
    private static readonly Unreadable = 'names no readable Ed25519 public key'
    private static readonly Utf8 = 'utf8'
    private static readonly Name = /^[a-z0-9](?:[a-z0-9-]{0,251}[a-z0-9])?$/
    private static readonly MaxPort = 65535
    private static readonly ServiceAccountUserPrefix = 'system:serviceaccount:'
    private static readonly UserSeparator = ':'

    private constructor(
        public readonly ChannelUrl: string,
        public readonly Tenant: string,
        public readonly EngineVersion: string,
        public readonly TrustRoot: SigningPublicKey,
        public readonly Namespace: string,
        public readonly ConsoleServiceAccount: string,
        public readonly ConsoleDeployment: string,
        public readonly IdpNamespace: string,
        public readonly IdpDeployment: string,
        public readonly PostgresStatefulSet: string,
        public readonly InternalPort: number | undefined,
        public readonly PollMs: number,
        public readonly MaxBackoffMs: number,
        /** Set for a Hosted engine only: the console address it enrols with (AutoEnrolment). */
        public readonly HostedConsole: ConsoleAddress | undefined)
    {
        Object.freeze(this)
    }

    /** The console's service-account user name a TokenReview answers for it. */
    public get ConsoleUsername(): string
    {
        return ConnectedSettings.ServiceAccountUserPrefix + this.Namespace + ConnectedSettings.UserSeparator + this.ConsoleServiceAccount
    }

    public static From(env: NodeJS.ProcessEnv): ConnectedSettings
    {
        const C = ConnectedSettings
        const channelUrl = C.Required(env, AgentSettings.RegistryUrlEnv)
        if (!ProtocolNames.HttpsUrl.test(channelUrl))
        {
            throw new ConnectedSettingError(AgentSettings.RegistryUrlEnv, C.BadValue)
        }
        const namespace = env[C.NamespaceEnv]?.trim() || C.DefaultNamespace
        const port = env[C.InternalPortEnv]?.trim()
        return new ConnectedSettings(
            channelUrl,
            C.Matching(env, C.TenantEnv, ProtocolNames.Tenant),
            C.Matching(env, C.EngineVersionEnv, ProtocolNames.Version),
            C.TrustRootOf(C.Required(env, C.TrustRootFileEnv)),
            C.Checked(namespace, C.NamespaceEnv),
            C.Matching(env, C.ConsoleServiceAccountEnv, C.Name),
            C.Matching(env, C.ConsoleDeploymentEnv, C.Name),
            C.Matching(env, C.IdpNamespaceEnv, C.Name),
            C.Matching(env, C.IdpDeploymentEnv, C.Name),
            C.Matching(env, C.PostgresStatefulSetEnv, C.Name),
            port === undefined || port === '' ? undefined : C.PortOf(port),
            AgentSettings.PollMsOf(env),
            AgentSettings.MaxBackoffMsOf(env),
            C.HostedOf(env) ? C.ConsoleAddressOf(env) : undefined)
    }

    /** Whether this is a Hosted engine: `PRAGMATIC_AGENT_HOSTED` is `true`; unset or `false` is not; anything else refused. */
    private static HostedOf(env: NodeJS.ProcessEnv): boolean
    {
        const C = ConnectedSettings
        const value = env[C.HostedEnv]?.trim() ?? ''
        if (value === '' || value === C.NotHostedValue)
        {
            return false
        }
        if (value !== C.HostedValue)
        {
            throw new ConnectedSettingError(C.HostedEnv, C.BadValue)
        }
        return true
    }

    /** A Hosted engine's console address: its option and host name, as the platform's placement named them. */
    private static ConsoleAddressOf(env: NodeJS.ProcessEnv): ConsoleAddress
    {
        const C = ConnectedSettings
        const option = C.Required(env, C.ConsoleAddressEnv)
        const host = C.Required(env, C.ConsoleHostEnv)
        // The platform relays a Hosted hive's console by SNI (C5.2): the only option it places with.
        if (option !== ConsoleAddressOption.RelayedHiveSubdomain)
        {
            throw new ConnectedSettingError(C.ConsoleAddressEnv, C.BadValue)
        }
        try
        {
            return ConsoleAddress.Parse({ Option: option, HostName: host, IngressAddress: null })
        }
        catch
        {
            throw new ConnectedSettingError(C.ConsoleHostEnv, C.BadValue)
        }
    }

    /** Whether the environment names a connected agent's settings (the chart sets them; the push path does not). */
    public static IsConnected(env: NodeJS.ProcessEnv): boolean
    {
        return (env[ConnectedSettings.TrustRootFileEnv]?.trim() ?? '') !== ''
    }

    private static TrustRootOf(file: string): SigningPublicKey
    {
        try
        {
            return SigningPublicKey.FromPem(readFileSync(file, ConnectedSettings.Utf8))
        }
        catch
        {
            throw new ConnectedSettingError(ConnectedSettings.TrustRootFileEnv, ConnectedSettings.Unreadable)
        }
    }

    private static PortOf(raw: string): number
    {
        const port = Number(raw)
        if (!Number.isInteger(port) || port < 1 || port > ConnectedSettings.MaxPort)
        {
            throw new ConnectedSettingError(ConnectedSettings.InternalPortEnv, ConnectedSettings.BadValue)
        }
        return port
    }

    private static Matching(env: NodeJS.ProcessEnv, key: string, pattern: RegExp): string
    {
        const value = ConnectedSettings.Required(env, key)
        if (!pattern.test(value))
        {
            throw new ConnectedSettingError(key, ConnectedSettings.BadValue)
        }
        return value
    }

    private static Checked(value: string, key: string): string
    {
        if (!ConnectedSettings.Name.test(value))
        {
            throw new ConnectedSettingError(key, ConnectedSettings.BadValue)
        }
        return value
    }

    private static Required(env: NodeJS.ProcessEnv, key: string): string
    {
        const value = env[key]?.trim() ?? ''
        if (value === '')
        {
            throw new ConnectedSettingError(key, ConnectedSettings.Missing)
        }
        return value
    }
}
