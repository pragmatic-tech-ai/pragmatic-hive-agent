import { readFileSync } from 'node:fs'
import { EnvironmentReadiness, EnvironmentStatus, HiveReport, ProtocolNames } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AgentWiring } from '../agent-wiring.js'
import type { IServerDeployment } from '../k8s-api.js'
import type { ConsoleFetch } from '../intents/handlers/environment-intent-forwarder.js'

/** Where a report's environments come from. */
export interface IEnvironmentSource
{
    Environments(): Promise<EnvironmentStatus[]>
}

/** The hive's environment server Deployments, listed cluster-wide (a Hosted engine's agent only: it holds cluster-admin). */
export interface IEnvironmentLister
{
    ListServerDeployments(labelSelector: string): Promise<ReadonlyArray<IServerDeployment>>
}

/**
 * A Hosted engine's environments, from its environment server Deployments (C3.3): name, readiness, the image's version
 * tag. Only a Hosted agent (cluster-admin, managed by push) reads them this way; an Enrolled or Delegated agent has no
 * cluster-wide list (C3.4) and asks its console (ConsoleEnvironmentSource).
 */
export class DeploymentEnvironmentSource implements IEnvironmentSource
{
    private static readonly DigestSeparator = '@'
    private static readonly TagSeparator = ':'

    public constructor(private readonly lister: IEnvironmentLister, private readonly installHive: string)
    {
    }

    public async Environments(): Promise<EnvironmentStatus[]>
    {
        const deployments = await this.lister.ListServerDeployments(AgentWiring.LabelSelector(this.installHive))
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
            environments.push(new EnvironmentStatus(name, item.ready ? EnvironmentReadiness.Ready : EnvironmentReadiness.NotReady, DeploymentEnvironmentSource.VersionOf(item.runningImage)))
        }
        return environments
    }

    /** An image's tag when it is a version (`…:1.2.3`), else none: the report carries no free text. */
    private static VersionOf(image: string | undefined): string | null
    {
        const S = DeploymentEnvironmentSource
        const tag = image?.split(S.DigestSeparator)[0]?.split(S.TagSeparator).at(-1)
        return tag !== undefined && ProtocolNames.Version.test(tag) ? tag : null
    }
}

/**
 * An Enrolled or Delegated engine's environments, from its console (C3.4 review: no cluster-wide list of Deployments for
 * the agent). The console owns its hive's environments (it creates them, and knows each one's readiness and version), so
 * it is asked over the same internal endpoint the agent forwards environment intents to: `GET /internal/environments` on
 * 7211 with the agent's projected token for audience `pragmatic-tenant-admin`, answered `{ Environments: [{ Name,
 * Readiness, Version }] }` (the report's closed EnvironmentStatus). Reading the known environments' Deployments by name
 * instead would still need their names from somewhere, and would read their specs. While the console cannot answer,
 * the last list it gave is reported (none before the first).
 */
export class ConsoleEnvironmentSource implements IEnvironmentSource
{
    public static readonly Path = '/internal/environments'
    private static readonly Get = 'GET'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly Utf8 = 'utf8'
    private static readonly StatusOk = 200
    private static readonly MaxReplyBytes = 262_144
    private static readonly TimeoutMs = 10_000
    private static readonly EnvironmentsField = 'Environments'
    private static readonly EntryPath = 'environment'
    private static readonly TrailingSlashes = /\/+$/
    private static readonly NoText = ''
    private last: EnvironmentStatus[] = []

    public constructor(private readonly consoleUrl: string | undefined, private readonly tokenFile: string, private readonly fetcher: ConsoleFetch = (url, init) => fetch(url, init))
    {
    }

    public async Environments(): Promise<EnvironmentStatus[]>
    {
        const S = ConsoleEnvironmentSource
        if (this.consoleUrl === undefined)
        {
            return this.last
        }
        try
        {
            const token = readFileSync(this.tokenFile, S.Utf8).trim()
            const reply = await this.fetcher(this.consoleUrl.replace(S.TrailingSlashes, S.NoText) + S.Path, {
                method: S.Get, headers: { [S.AuthorizationHeader]: S.BearerPrefix + token }, signal: AbortSignal.timeout(S.TimeoutMs),
            })
            const text = await reply.text()
            if (reply.status !== S.StatusOk || text.length > S.MaxReplyBytes)
            {
                return this.last
            }
            const entries = (JSON.parse(text) as Record<string, unknown>)[S.EnvironmentsField]
            if (!Array.isArray(entries))
            {
                return this.last
            }
            const seen = new Set<string>()
            const environments: EnvironmentStatus[] = []
            for (const entry of entries.slice(0, HiveReport.MaxEnvironments))
            {
                const status = EnvironmentStatus.Parse(entry, S.EntryPath)
                if (!seen.has(status.Name))
                {
                    seen.add(status.Name)
                    environments.push(status)
                }
            }
            this.last = environments
        }
        catch
        {
            // Unreachable, not ours, or not the closed shape: the last answer stands.
        }
        return this.last
    }
}
