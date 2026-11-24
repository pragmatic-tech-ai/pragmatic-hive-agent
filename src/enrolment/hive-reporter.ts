import {
    ComponentReport, ComponentState, EnvironmentReadiness, EnvironmentStatus, HiveReport, MessageKind, ProtocolNames,
    type IAgentChannel, type IntentStatus,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { HiveSigning } from '../identity/hive-signing.js'
import { AgentWiring } from '../agent-wiring.js'
import { HiveAgentComponent } from '../hive-agent-component.js'
import type { IServerDeployment } from '../k8s-api.js'
import { KubeWorkloadKind, type IHiveKube } from '../kube/hive-kube.js'
import type { ITickTarget } from '../tick-loop.js'
import type { EnrolmentRecord } from './enrolment-state.js'

/** One engine workload the report states (its component name, where it runs, what kind of workload). */
export class ReportedWorkload
{
    public constructor(public readonly Component: string, public readonly Namespace: string, public readonly Kind: KubeWorkloadKind, public readonly Name: string)
    {
    }
}

/** Where the report's environments come from: the hive's environment server Deployments. */
export interface IEnvironmentLister
{
    ListServerDeployments(labelSelector: string): Promise<ReadonlyArray<IServerDeployment>>
}

/** Where the report's intent statuses come from (the kept intents, C3.4). */
export interface IIntentStatusSource
{
    Statuses(max: number): IntentStatus[]
}

/** What a failed report tick logs (its error's name only). */
export interface IReportLog
{
    Failed(error: unknown, backoffMs: number): void
}

export interface HiveReporterOptions
{
    /** The hive's signing identity (its key may rotate, C3.4). */
    Signing: HiveSigning
    Enrolment: EnrolmentRecord
    Channel: IAgentChannel
    Kube: IHiveKube
    Environments: IEnvironmentLister
    /** The install's hive name (the label the engine's environments carry). */
    InstallHive: string
    EngineVersion: string
    Workloads: readonly ReportedWorkload[]
    Log: IReportLog
    /** The kept intents' statuses; none before the intent loop runs (a Hosted engine has none). */
    Intents?: IIntentStatusSource
}

/**
 * The enrolled hive's signed HiveReport, sent every poll interval over the agent channel (C3.3): the engine version,
 * the agent itself and each engine workload (ready, degraded, absent), and each environment (name, readiness, the image
 * it runs as its version when that fits). Signed by the hive key as the enrolled hive id; only closed shapes travel.
 */
export class HiveReporter implements ITickTarget
{
    public static readonly AgentComponent = HiveAgentComponent.Name
    private static readonly DigestSeparator = '@'
    private static readonly TagSeparator = ':'

    public constructor(private readonly options: HiveReporterOptions)
    {
    }

    public async Tick(): Promise<void>
    {
        await this.options.Channel.Exchange(this.options.Signing.Sign(MessageKind.HiveReport, await this.Report()))
    }

    public TickFailed(error: unknown, backoffMs: number): void
    {
        this.options.Log.Failed(error, backoffMs)
    }

    public async Report(): Promise<HiveReport>
    {
        const o = this.options
        const components: ComponentReport[] = [new ComponentReport(HiveReporter.AgentComponent, ComponentState.Ready, o.EngineVersion)]
        for (const workload of o.Workloads)
        {
            const ready = await o.Kube.WorkloadReady(workload.Namespace, workload.Kind, workload.Name)
            const state = ready === undefined ? ComponentState.Absent : ready ? ComponentState.Ready : ComponentState.Degraded
            // The agent knows its own version (the release's); the others' it does not read, so it claims none.
            components.push(new ComponentReport(workload.Component, state, null))
        }
        const deployments = await o.Environments.ListServerDeployments(AgentWiring.LabelSelector(o.InstallHive))
        // One entry per environment name a report can carry (a DNS label, each once, at most the report's limit).
        const seen = new Set<string>()
        const environments: EnvironmentStatus[] = []
        for (const item of deployments)
        {
            const name = AgentWiring.EnvironmentName(item.namespace)
            if (!ProtocolNames.Label.test(name) || seen.has(name) || environments.length >= HiveReport.MaxEnvironments)
            {
                continue
            }
            seen.add(name)
            environments.push(new EnvironmentStatus(name, item.ready ? EnvironmentReadiness.Ready : EnvironmentReadiness.NotReady, HiveReporter.VersionOf(item.runningImage)))
        }
        return HiveReport.Create({ EngineVersion: o.EngineVersion, Components: components, Environments: environments, Intents: o.Intents?.Statuses(HiveReport.MaxIntents) ?? [] })
    }

    /** An image's tag when it is a version (`…:1.2.3`), else none: the report carries no free text. */
    private static VersionOf(image: string | undefined): string | null
    {
        const tag = image?.split(HiveReporter.DigestSeparator)[0]?.split(HiveReporter.TagSeparator).at(-1)
        return tag !== undefined && ProtocolNames.Version.test(tag) ? tag : null
    }
}
