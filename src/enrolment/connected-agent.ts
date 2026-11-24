import { HttpAgentChannel, SystemProtocolClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { ComponentReadyFile } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { InClusterK8sApi } from '../k8s-api.js'
import { HiveIdentity } from '../identity/hive-identity.js'
import { AgentInternalApi, type IInternalApiLog } from '../internal-api/agent-internal-api.js'
import { ConsoleCallerCheck } from '../internal-api/console-caller-check.js'
import { InClusterHiveKube, KubeWorkloadKind } from '../kube/hive-kube.js'
import { TickLoop } from '../tick-loop.js'
import { ConnectedSettings } from './connected-settings.js'
import { EnrolmentState } from './enrolment-state.js'
import { HiveEnrolment } from './hive-enrolment.js'
import { HiveReporter, ReportedWorkload, type IReportLog } from './hive-reporter.js'
import { AutoEnrolment, type IAutoEnrolmentLog } from './auto-enrolment.js'
import { TimerTickDelay } from '../tick-loop.js'
import { HiveSigning } from '../identity/hive-signing.js'
import { HiveKeyRecovery } from '../identity/hive-key-recovery.js'
import { IntentLoop } from '../intents/intent-loop.js'
import type { IntentPuller } from '../intents/intent-puller.js'
import type { IntentStore } from '../intents/intent-store.js'
import { PlatformTrust } from './platform-trust.js'
import { ConsoleEnvironmentSource, DeploymentEnvironmentSource } from './environment-sources.js'
import { IntentLease } from '../intents/intent-lease.js'

/** The connected agent's log lines: events and codes only. */
class ConnectedLog implements IInternalApiLog, IReportLog
{
    private static readonly EventKey = 'event'
    private static readonly CodeKey = 'code'
    private static readonly BackoffKey = 'backoffMs'
    private static readonly ErrorKey = 'error'
    private static readonly ApiLine = 'internal API: '
    private static readonly ReportFailedLine = 'report failed'
    private static readonly ReportFailedEvent = 'report-failed'
    private static readonly UnknownError = 'Error'

    public constructor(private readonly logger: ILogger)
    {
    }

    public Event(event: string, code?: string): void
    {
        const C = ConnectedLog
        this.logger.Info(C.ApiLine + event, code === undefined ? { [C.EventKey]: event } : { [C.EventKey]: event, [C.CodeKey]: code })
    }

    public Failed(error: unknown, backoffMs: number): void
    {
        const C = ConnectedLog
        this.logger.Error(C.ReportFailedLine, { [C.EventKey]: C.ReportFailedEvent, [C.ErrorKey]: error instanceof Error ? error.name : C.UnknownError, [C.BackoffKey]: backoffMs })
    }
}

/** A Hosted agent's self-enrolment log lines: events and codes only, never the code. */
class AutoEnrolmentLog implements IAutoEnrolmentLog
{
    private static readonly EventKey = 'event'
    private static readonly CodeKey = 'code'
    private static readonly BackoffKey = 'backoffMs'
    private static readonly ErrorKey = 'error'
    private static readonly EventLine = 'auto-enrolment: '
    private static readonly FailedLine = 'auto-enrolment attempt failed'
    private static readonly FailedEvent = 'auto-enrolment-failed'
    private static readonly UnknownError = 'Error'

    public constructor(private readonly logger: ILogger)
    {
    }

    public Event(event: string, code?: string): void
    {
        const A = AutoEnrolmentLog
        this.logger.Info(A.EventLine + event, code === undefined ? { [A.EventKey]: event } : { [A.EventKey]: event, [A.CodeKey]: code })
    }

    public Failed(error: unknown, backoffMs: number): void
    {
        const A = AutoEnrolmentLog
        this.logger.Error(A.FailedLine, { [A.EventKey]: A.FailedEvent, [A.ErrorKey]: error instanceof Error ? error.name : A.UnknownError, [A.BackoffKey]: backoffMs })
    }
}

/**
 * The agent of a chart install (level connected, C3.3): its key loaded or created in the cluster, its enrolment read;
 * the internal API serves the console from the start (enrol while not enrolled, the status always); once enrolled it
 * sends a signed HiveReport every poll interval over the channel the platform named at enrolment. A Hosted engine
 * (C5.1) serves no internal API: it enrols itself with the host agent's code (AutoEnrolment), then reports the same way.
 */
export class ConnectedAgent
{
    private static readonly StartedLine = 'pragmatic-agentd connected: internal API listening'
    private static readonly NotEnrolledLine = 'pragmatic-agentd is not enrolled: idle until the console connects this hive'
    private static readonly EnrolledLine = 'pragmatic-agentd is enrolled: reporting'
    private static readonly EventKey = 'event'
    private static readonly HiveKey = 'hiveId'
    private static readonly StartedEvent = 'connected-start'
    private static readonly NotEnrolledEvent = 'not-enrolled'
    private static readonly HostedLine = 'pragmatic-agentd hosted: enrolling with the host agent code'
    private static readonly HostedEvent = 'hosted-start'
    private static readonly EnrolledEvent = 'enrolled'
    private static readonly ConsoleComponent = 'pragmatic-tenant-admin'
    private static readonly IdpComponent = 'pragmatic-tenant-idp'
    private static readonly PostgresComponent = 'pragmatic-postgres'
    /** The pod's name (Kubernetes sets the hostname to it): the intent lease's holder. */
    private static readonly PodNameEnv = 'HOSTNAME'
    private static readonly Sigterm = 'SIGTERM'

    private constructor()
    {
    }

    public static async Run(env: NodeJS.ProcessEnv, logger: ILogger, installHive: string, ready: ComponentReadyFile = new ComponentReadyFile()): Promise<void>
    {
        const C = ConnectedAgent
        const settings = ConnectedSettings.From(env)
        const kube = new InClusterHiveKube()
        const key = await HiveIdentity.LoadOrCreate(kube, settings.Namespace)
        const state = new EnrolmentState(kube, settings.Namespace, settings.TrustRoot)
        const enrolment = new HiveEnrolment({
            Key: key, Channel: new HttpAgentChannel(settings.ChannelUrl), State: state, PinnedTrustRoot: settings.TrustRoot,
            Tenant: settings.Tenant, EngineVersion: settings.EngineVersion,
        }, await state.Read())
        const log = new ConnectedLog(logger)
        const hosted = settings.HostedConsole
        if (hosted !== undefined)
        {
            ready.Mark()
            logger.Info(C.HostedLine, { [C.EventKey]: C.HostedEvent })
            const auto = new AutoEnrolment(kube, settings.Namespace, enrolment, hosted, new AutoEnrolmentLog(logger))
            await auto.UntilEnrolled(settings, new TimerTickDelay())
        }
        let api: AgentInternalApi | undefined
        if (hosted === undefined)
        {
            api = new AgentInternalApi(enrolment, new ConsoleCallerCheck(kube, settings.ConsoleUsername), log)
            await api.Listen(settings.InternalPort)
            ready.Mark()
            logger.Info(C.StartedLine, { [C.EventKey]: C.StartedEvent })
            if (enrolment.Enrolled === undefined)
            {
                logger.Info(C.NotEnrolledLine, { [C.EventKey]: C.NotEnrolledEvent })
            }
        }
        const record = await enrolment.WhenEnrolled()
        logger.Info(C.EnrolledLine, { [C.EventKey]: C.EnrolledEvent, [C.HiveKey]: record.HiveId })
        const clock = new SystemProtocolClock()
        const channel = new HttpAgentChannel(record.ChannelUrl)
        const signing = new HiveSigning(key, record.HiveId, kube, settings.Namespace, clock)
        // Enrolled and Delegated hives are managed by pulled intents (C3.4); a Hosted one by push, so it runs no intent loop.
        const lease = new IntentLease(kube, settings.Namespace, env[C.PodNameEnv]?.trim() || record.HiveId, clock)
        const loop: { Puller: IntentPuller, Store: IntentStore } | undefined = hosted === undefined
            ? await IntentLoop.Compose({ Settings: settings, Kube: kube, Channel: channel, Signing: signing, Trust: new PlatformTrust(record, state, clock), Clock: clock, Logger: logger, ReportNow: (): Promise<void> => reporter.Tick(), Lease: lease })
            : undefined
        if (loop !== undefined)
        {
            // A stopping pod (the end of its own upgrade's overlap) lets the next one apply at once.
            process.once(C.Sigterm, () =>
            {
                void lease.Release().catch(() => undefined).finally(() => process.exit(0))
            })
        }
        const reporter: HiveReporter = new HiveReporter({
            Signing: signing, Intents: loop?.Store, Enrolment: record, Channel: channel, Kube: kube,
            Environments: hosted !== undefined ? new DeploymentEnvironmentSource(new InClusterK8sApi(), installHive) : new ConsoleEnvironmentSource(settings.ConsoleIntentUrl, settings.ConsoleTokenFile),
            EngineVersion: settings.EngineVersion, Log: log,
            Workloads: [
                new ReportedWorkload(C.ConsoleComponent, settings.Namespace, KubeWorkloadKind.Deployment, settings.ConsoleDeployment),
                new ReportedWorkload(C.IdpComponent, settings.IdpNamespace, KubeWorkloadKind.Deployment, settings.IdpDeployment),
                new ReportedWorkload(C.PostgresComponent, settings.Namespace, KubeWorkloadKind.StatefulSet, settings.PostgresStatefulSet),
            ],
        })
        try
        {
            await new HiveKeyRecovery(signing, kube, settings.Namespace).Settle(channel, await reporter.Report(), loop?.Store.Cursor ?? 0)
        }
        catch (error)
        {
            // An unreachable platform: the pending key stays and the next start settles it.
            log.Failed(error, 0)
        }
        void TickLoop.For(settings, reporter).Run()
        if (loop !== undefined && api !== undefined)
        {
            api.AttachIntents(loop.Puller)
            void TickLoop.For(settings, loop.Puller).Run()
        }
    }
}
