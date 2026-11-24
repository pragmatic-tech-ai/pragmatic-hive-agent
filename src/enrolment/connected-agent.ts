import { HttpAgentChannel } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
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

/**
 * The agent of a chart install (level connected, C3.3): its key loaded or created in the cluster, its enrolment read;
 * the internal API serves the console from the start (enrol while not enrolled, the status always); once enrolled it
 * sends a signed HiveReport every poll interval over the channel the platform named at enrolment.
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
    private static readonly EnrolledEvent = 'enrolled'
    private static readonly ConsoleComponent = 'pragmatic-tenant-admin'
    private static readonly IdpComponent = 'pragmatic-tenant-idp'
    private static readonly PostgresComponent = 'pragmatic-postgres'

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
        await new AgentInternalApi(enrolment, new ConsoleCallerCheck(kube, settings.ConsoleUsername), log).Listen(settings.InternalPort)
        ready.Mark()
        logger.Info(C.StartedLine, { [C.EventKey]: C.StartedEvent })
        if (enrolment.Enrolled === undefined)
        {
            logger.Info(C.NotEnrolledLine, { [C.EventKey]: C.NotEnrolledEvent })
        }
        const record = await enrolment.WhenEnrolled()
        logger.Info(C.EnrolledLine, { [C.EventKey]: C.EnrolledEvent, [C.HiveKey]: record.HiveId })
        const reporter = new HiveReporter({
            Key: key, Enrolment: record, Channel: new HttpAgentChannel(record.ChannelUrl), Kube: kube, Environments: new InClusterK8sApi(),
            InstallHive: installHive, EngineVersion: settings.EngineVersion, Log: log,
            Workloads: [
                new ReportedWorkload(C.ConsoleComponent, settings.Namespace, KubeWorkloadKind.Deployment, settings.ConsoleDeployment),
                new ReportedWorkload(C.IdpComponent, settings.IdpNamespace, KubeWorkloadKind.Deployment, settings.IdpDeployment),
                new ReportedWorkload(C.PostgresComponent, settings.Namespace, KubeWorkloadKind.StatefulSet, settings.PostgresStatefulSet),
            ],
        })
        void TickLoop.For(settings, reporter).Run()
    }
}
