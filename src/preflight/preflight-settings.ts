/** How the console is reached (chart value `console.address`). */
export enum ConsoleAddress
{
    OwnDomain = 'own-domain',
    HiveSubdomain = 'hive-subdomain',
    RelayedHiveSubdomain = 'relayed-hive-subdomain',
}

/** Where the console's certificate comes from (chart value `tls.mode`). */
export enum TlsMode
{
    Secret = 'secret',
    SelfSigned = 'self-signed',
}

/** What the chart hands the preflight Job (`PRAGMATIC_PREFLIGHT_*`); every value is public. */
export class PreflightSettings
{
    public static readonly NamespaceEnv = 'PRAGMATIC_PREFLIGHT_NAMESPACE'
    public static readonly StorageClassEnv = 'PRAGMATIC_PREFLIGHT_STORAGE_CLASS'
    public static readonly IngressClassEnv = 'PRAGMATIC_PREFLIGHT_INGRESS_CLASS'
    public static readonly ConsoleHostEnv = 'PRAGMATIC_PREFLIGHT_CONSOLE_HOST'
    public static readonly IdpHostEnv = 'PRAGMATIC_PREFLIGHT_IDP_HOST'
    public static readonly BaseDomainEnv = 'PRAGMATIC_PREFLIGHT_BASE_DOMAIN'
    public static readonly ConsoleAddressEnv = 'PRAGMATIC_PREFLIGHT_CONSOLE_ADDRESS'
    public static readonly TlsSecretEnv = 'PRAGMATIC_PREFLIGHT_TLS_SECRET'
    public static readonly TlsModeEnv = 'PRAGMATIC_PREFLIGHT_TLS_MODE'
    private static readonly MissingPrefix = 'missing required environment variable '
    private static readonly BadValueInfix = ' has an unknown value: '
    private static readonly Empty = ''
    /** A name under the base domain no environment takes: what an environment host resolves and is certified like. */
    private static readonly ProbeLabel = 'pragmatic-preflight-probe.'

    private constructor(
        public readonly Namespace: string,
        public readonly StorageClass: string | undefined,
        public readonly IngressClass: string | undefined,
        public readonly ConsoleHost: string,
        public readonly IdpHost: string | undefined,
        public readonly BaseDomain: string | undefined,
        public readonly Address: ConsoleAddress,
        public readonly TlsSecret: string | undefined,
        public readonly Tls: TlsMode,
    )
    {
        Object.freeze(this)
    }

    /**
     * The hosts the engine publishes: the console's, the realm sign-in service's, and a probe name under the base domain
     * standing for every environment's host (`<environment>.<baseDomain>`), each when known.
     */
    public get Hosts(): readonly string[]
    {
        const hosts = [this.ConsoleHost]
        if (this.IdpHost !== undefined)
        {
            hosts.push(this.IdpHost)
        }
        if (this.BaseDomain !== undefined)
        {
            hosts.push(PreflightSettings.ProbeLabel + this.BaseDomain)
        }
        return hosts
    }

    public static From(env: NodeJS.ProcessEnv): PreflightSettings
    {
        const S = PreflightSettings
        return new PreflightSettings(
            S.Required(env, S.NamespaceEnv),
            S.Optional(env, S.StorageClassEnv),
            S.Optional(env, S.IngressClassEnv),
            S.Required(env, S.ConsoleHostEnv),
            S.Optional(env, S.IdpHostEnv),
            S.Optional(env, S.BaseDomainEnv),
            S.OneOf(env, S.ConsoleAddressEnv, Object.values(ConsoleAddress), ConsoleAddress.OwnDomain),
            S.Optional(env, S.TlsSecretEnv),
            S.OneOf(env, S.TlsModeEnv, Object.values(TlsMode), TlsMode.Secret),
        )
    }

    private static Optional(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]?.trim()
        return value === undefined || value === PreflightSettings.Empty ? undefined : value
    }

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = PreflightSettings.Optional(env, name)
        if (value === undefined)
        {
            throw new Error(PreflightSettings.MissingPrefix + name)
        }
        return value
    }

    private static OneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, values: readonly T[], fallback: T): T
    {
        const value = PreflightSettings.Optional(env, name)
        if (value === undefined)
        {
            return fallback
        }
        if (!values.includes(value as T))
        {
            throw new Error(name + PreflightSettings.BadValueInfix + value)
        }
        return value as T
    }
}
