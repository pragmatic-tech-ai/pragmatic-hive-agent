import {
    ComponentReport, ComponentState, HiveReport, MessageKind,
    type IAgentChannel, type IntentStatus,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { HiveSigning } from '../identity/hive-signing.js'
import { HiveAgentComponent } from '../hive-agent-component.js'
import { KubeWorkloadKind, type IHiveKube } from '../kube/hive-kube.js'
import type { ITickTarget } from '../tick-loop.js'
import type { EnrolmentRecord } from './enrolment-state.js'
import type { IEnvironmentSource } from './environment-sources.js'

/** One engine workload the report states (its component name, where it runs, what kind of workload). */
export class ReportedWorkload
{
    public constructor(public readonly Component: string, public readonly Namespace: string, public readonly Kind: KubeWorkloadKind, public readonly Name: string)
    {
    }
}


/** Where the report's intent statuses come from (the kept intents, C3.4). */
export interface IIntentStatusSource
{
    Statuses(max: number): IntentStatus[]
    /** The platform took a report carrying these. */
    MarkReported(statuses: readonly IntentStatus[]): Promise<void>
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
    /** The hive's environments: the console's (Enrolled, Delegated), the Deployments (Hosted). */
    Environments: IEnvironmentSource
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

    public constructor(private readonly options: HiveReporterOptions)
    {
    }

    public async Tick(): Promise<void>
    {
        const report = await this.Report()
        await this.options.Channel.Exchange(this.options.Signing.Sign(MessageKind.HiveReport, report))
        await this.options.Intents?.MarkReported(report.Intents)
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
        const environments = await o.Environments.Environments()
        return HiveReport.Create({ EngineVersion: o.EngineVersion, Components: components, Environments: environments, Intents: o.Intents?.Statuses(HiveReport.MaxIntents) ?? [] })
    }
}
