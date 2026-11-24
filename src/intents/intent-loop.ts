import type { IAgentChannel, IProtocolClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { ConnectedSettings } from '../enrolment/connected-settings.js'
import type { PlatformTrust } from '../enrolment/platform-trust.js'
import type { HiveSigning } from '../identity/hive-signing.js'
import { KubeWorkloadKind, type IHiveKube } from '../kube/hive-kube.js'
import { EngineWorkload, EngineWorkloads } from './engine-workloads.js'
import { ComponentAtVersionHandler } from './handlers/component-at-version-handler.js'
import { EnvironmentIntentForwarder } from './handlers/environment-intent-forwarder.js'
import { RepairHandler } from './handlers/repair-handler.js'
import { RotateHandler } from './handlers/rotate-handler.js'
import { IntentAdmissionDecider } from './intent-admission-decider.js'
import { IntentExecutor } from './intent-executor.js'
import { IntentPuller, type IIntentLog } from './intent-puller.js'
import { IntentStore } from './intent-store.js'
import { RolloutWatch } from './rollout-watch.js'

/** The intent loop's log lines: events and codes only. */
class IntentLog implements IIntentLog
{
    private static readonly EventKey = 'event'
    private static readonly CodeKey = 'code'
    private static readonly BackoffKey = 'backoffMs'
    private static readonly ErrorKey = 'error'
    private static readonly EventLine = 'intents: '
    private static readonly FailedLine = 'intent tick failed'
    private static readonly FailedEvent = 'intent-tick-failed'
    private static readonly UnknownError = 'Error'

    public constructor(private readonly logger: ILogger)
    {
    }

    public Event(event: string, code?: string): void
    {
        const L = IntentLog
        this.logger.Info(L.EventLine + event, code === undefined ? { [L.EventKey]: event } : { [L.EventKey]: event, [L.CodeKey]: code })
    }

    public Failed(error: unknown, backoffMs: number): void
    {
        const L = IntentLog
        this.logger.Error(L.FailedLine, { [L.EventKey]: L.FailedEvent, [L.ErrorKey]: error instanceof Error ? error.name : L.UnknownError, [L.BackoffKey]: backoffMs })
    }
}

export interface IntentLoopParts
{
    Settings: ConnectedSettings
    Kube: IHiveKube
    Channel: IAgentChannel
    Signing: HiveSigning
    Trust: PlatformTrust
    Clock: IProtocolClock
    Logger: ILogger
    ReportNow: () => Promise<void>
}

/**
 * Composes the enrolled (Enrolled or Delegated) hive's intent loop (C3.4) from the chart's settings: the kept intents,
 * the engine's workloads by the names the chart gave them (the agent's own when the chart names it), the console's
 * internal endpoint for what the console owns, and the puller that runs them. A Hosted engine has none.
 */
export class IntentLoop
{
    private constructor()
    {
    }

    public static async Compose(parts: IntentLoopParts): Promise<{ Puller: IntentPuller, Store: IntentStore }>
    {
        const s = parts.Settings
        const W = EngineWorkloads
        const workloads = new EngineWorkloads([
            new EngineWorkload(W.ConsoleComponent, s.Namespace, KubeWorkloadKind.Deployment, s.ConsoleDeployment, undefined),
            new EngineWorkload(W.IdpComponent, s.IdpNamespace, KubeWorkloadKind.Deployment, s.IdpDeployment, undefined),
            new EngineWorkload(W.PostgresComponent, s.Namespace, KubeWorkloadKind.StatefulSet, s.PostgresStatefulSet, undefined),
            ...(s.AgentDeployment === undefined ? [] : [new EngineWorkload(W.AgentComponent, s.Namespace, KubeWorkloadKind.Deployment, s.AgentDeployment, undefined)]),
        ])
        const store = new IntentStore(parts.Kube, s.Namespace)
        await store.Load()
        const watch = new RolloutWatch({ TimeoutMs: s.RolloutTimeoutMs, PollMs: RolloutWatch.DefaultPollMs })
        const forwarder = new EnvironmentIntentForwarder(s.ConsoleIntentUrl, s.ConsoleTokenFile)
        const executor = new IntentExecutor(
            new ComponentAtVersionHandler(parts.Kube, workloads, watch),
            new RotateHandler(parts.Trust, parts.Signing, parts.Channel, forwarder),
            new RepairHandler(parts.Kube, workloads, watch, forwarder, parts.Clock),
            forwarder)
        const puller = new IntentPuller({
            Channel: parts.Channel, Store: store, Decider: new IntentAdmissionDecider(parts.Trust), Executor: executor,
            Signing: parts.Signing, Trust: parts.Trust, Log: new IntentLog(parts.Logger), ReportNow: parts.ReportNow,
        })
        return { Puller: puller, Store: store }
    }
}
