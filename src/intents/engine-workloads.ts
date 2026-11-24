import { KubeWorkloadKind } from '../kube/hive-kube.js'

/** One engine component's workload: where it runs, what kind it is, its name, the container that runs its image. */
export class EngineWorkload
{
    public constructor(public readonly Component: string, public readonly Namespace: string, public readonly Kind: KubeWorkloadKind, public readonly Name: string, public readonly Container: string | undefined)
    {
    }
}

/**
 * The engine's components the agent may move (C3.4): the console, the sign-in service, Postgres and the agent itself,
 * each by the workload the chart named. A component-at-version or repair naming anything else is refused at the
 * pre-check: the platform can never point the agent at an environment's or a customer's workload.
 */
export class EngineWorkloads
{
    public static readonly AgentComponent = 'pragmatic-hive-agent'
    public static readonly ConsoleComponent = 'pragmatic-tenant-admin'
    public static readonly IdpComponent = 'pragmatic-tenant-idp'
    public static readonly PostgresComponent = 'pragmatic-postgres'
    private readonly byComponent: ReadonlyMap<string, EngineWorkload>

    public constructor(workloads: readonly EngineWorkload[])
    {
        this.byComponent = new Map(workloads.map(workload => [workload.Component, workload]))
    }

    public Of(component: string): EngineWorkload | undefined
    {
        return this.byComponent.get(component)
    }

    public All(): readonly EngineWorkload[]
    {
        return [...this.byComponent.values()]
    }

    /** Whether `component` is the agent itself (its own upgrade goes last in a batch and is reported before the roll). */
    public static IsAgent(component: string): boolean
    {
        return component === EngineWorkloads.AgentComponent
    }
}
