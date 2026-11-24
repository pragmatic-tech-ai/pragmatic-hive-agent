import { ComponentStartConfiguration } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { AgentSettings } from './agent-settings.js'
import { HiveAgentComponent } from './hive-agent-component.js'
import { InClusterK8sApi } from './k8s-api.js'
import { AgentWiring } from './agent-wiring.js'
import { BoundedFetch } from './bounded-fetch.js'
import { RolloutAgent, type IEnvironmentState, type IRolloutTarget, type ISnapshotEnvironment } from './rollout-agent.js'
import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'

class AgentMain
{
    private static readonly BackoffFactor = 2
    private static readonly RequestTimeoutMs = 10000

    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly PostMethod = 'POST'
    private static readonly NotFound = 404

    private static readonly RegistryFailurePrefix = 'registry request failed with status '
    private static readonly TickFailedPrefix = 'rollout tick failed: '
    private static readonly StartFailedPrefix = 'pragmatic-agentd failed to start: '
    private static readonly StartedLine = 'pragmatic-agentd started'
    private static readonly UnknownError = 'unknown error'
    private static readonly EnvironmentsKey = 'environments'
    private static readonly EventKey = 'event'
    private static readonly TickFailedEvent = 'tick-failed'
    private static readonly StartupEvent = 'startup'
    private static readonly StartFailedEvent = 'start-failed'
    private static readonly HiveKey = 'hiveId'
    private static readonly BackoffKey = 'backoffMs'

    private constructor()
    {
    }

    public static async Run(): Promise<void>
    {
        // First of all: the applied configuration (the mounted pragmatic-config-pragmatic-hive-agent) over the environment.
        await ComponentStartConfiguration.ApplyOrExit({ Declaration: HiveAgentComponent.Declaration, Env: process.env })
        const logger = StructuredLogger.ToStdout()
        const settings = AgentSettings.Started(process.env)
        const { RegistryUrl: registryUrl, HiveId: hiveId, Token: token, PollMs: pollMs, MaxBackoffMs: maxBackoffMs } = settings

        const k8s = new InClusterK8sApi()
        const selector = AgentWiring.LabelSelector(hiveId)
        const targetUrl = AgentWiring.TargetUrl(registryUrl, hiveId)
        const snapshotUrl = AgentWiring.SnapshotUrl(registryUrl, hiveId)
        const agent = new RolloutAgent({
            fetchTarget: () => AgentMain.FetchTarget(targetUrl, token),
            listEnvironments: async (): Promise<ReadonlyArray<IEnvironmentState>> => (await k8s.ListServerDeployments(selector)).map(item => AgentWiring.ToEnvironmentState(item)),
            patchImage: (namespace, deployment, container, image) => k8s.PatchDeploymentImage(namespace, deployment, container, image),
            reportSnapshot: environments => AgentMain.ReportSnapshot(snapshotUrl, token, environments),
        })
        logger.Info(AgentMain.StartedLine, { [AgentMain.EventKey]: AgentMain.StartupEvent, [AgentMain.HiveKey]: hiveId })
        void AgentMain.Loop(agent, logger, hiveId, pollMs, maxBackoffMs)
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(AgentMain.StartFailedPrefix + (error instanceof Error ? error.message : AgentMain.UnknownError), { [AgentMain.EventKey]: AgentMain.StartFailedEvent })
        process.exit(1)
    }

    private static async Loop(agent: RolloutAgent, logger: ILogger, hiveId: string, pollMs: number, maxBackoffMs: number): Promise<void>
    {
        let delay = pollMs
        for (;;)
        {
            try
            {
                await agent.Tick()
                delay = pollMs
            }
            catch (error)
            {
                // message only: never the token, headers or request bodies
                delay = Math.min(delay * AgentMain.BackoffFactor, maxBackoffMs)
                logger.Error(AgentMain.TickFailedPrefix + (error instanceof Error ? error.message : AgentMain.UnknownError), { [AgentMain.EventKey]: AgentMain.TickFailedEvent, [AgentMain.HiveKey]: hiveId, [AgentMain.BackoffKey]: delay })
            }
            await new Promise<void>(resolve => setTimeout(resolve, delay))
        }
    }

    private static async FetchTarget(url: string, token: string): Promise<IRolloutTarget | undefined>
    {
        return await AgentMain.TimedFetch(url, { headers: { [AgentMain.AuthorizationHeader]: AgentMain.BearerPrefix + token } }, async response =>
        {
            if (response.status === AgentMain.NotFound)
            {
                return undefined
            }
            if (!response.ok)
            {
                throw new Error(AgentMain.RegistryFailurePrefix + response.status)
            }
            return await response.json() as IRolloutTarget
        })
    }

    private static async ReportSnapshot(url: string, token: string, environments: ReadonlyArray<ISnapshotEnvironment>): Promise<void>
    {
        await AgentMain.TimedFetch(url, {
            method: AgentMain.PostMethod,
            headers: { [AgentMain.AuthorizationHeader]: AgentMain.BearerPrefix + token, [AgentMain.ContentTypeHeader]: AgentMain.JsonType },
            body: JSON.stringify({ [AgentMain.EnvironmentsKey]: environments }),
        }, async response =>
        {
            if (!response.ok)
            {
                throw new Error(AgentMain.RegistryFailurePrefix + response.status)
            }
        })
    }

    /** fetch + body read bounded together by RequestTimeoutMs (see BoundedFetch). */
    private static TimedFetch<T>(url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T>
    {
        return BoundedFetch.Run(url, init, AgentMain.RequestTimeoutMs, consume)
    }
}

AgentMain.Run().catch(AgentMain.Fail)
