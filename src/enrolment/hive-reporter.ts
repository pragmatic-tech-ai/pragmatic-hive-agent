import {
    ComponentReport, ComponentState, EnvelopeSigner, EnvironmentReadiness, EnvironmentStatus, HiveReport, MessageKind, Participant, ProtocolNames, SystemProtocolClock,
    type IAgentChannel, type IProtocolClock, type SigningKeyPair,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
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

/** What a failed report tick logs (its error's name only). */
export interface IReportLog
{
    Failed(error: unknown, backoffMs: number): void
}

export interface HiveReporterOptions
{
    Key: SigningKeyPair
    Enrolment: EnrolmentRecord
    Channel: IAgentChannel
    Kube: IHiveKube
    Environments: IEnvironmentLister
    /** The install's hive name (the label the engine's environments carry). */
    InstallHive: string
    EngineVersion: string
    Workloads: readonly ReportedWorkload[]
    Log: IReportLog
    Clock?: IProtocolClock
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
    private readonly clock: IProtocolClock
    private readonly signer: EnvelopeSigner

    public constructor(private readonly options: HiveReporterOptions)
    {
        this.clock = options.Clock ?? new SystemProtocolClock()
        this.signer = new EnvelopeSigner(options.Key, Participant.Hive(options.Enrolment.HiveId), this.clock)
    }

    public async Tick(): Promise<void>
    {
        await this.options.Channel.Exchange(this.signer.Sign(MessageKind.HiveReport, Participant.Platform, await this.Report()))
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
        return HiveReport.Create({ EngineVersion: o.EngineVersion, Components: components, Environments: environments, Intents: [] })
    }

    /** An image's tag when it is a version (`…:1.2.3`), else none: the report carries no free text. */
    private static VersionOf(image: string | undefined): string | null
    {
        const tag = image?.split(HiveReporter.DigestSeparator)[0]?.split(HiveReporter.TagSeparator).at(-1)
        return tag !== undefined && ProtocolNames.Version.test(tag) ? tag : null
    }
}
