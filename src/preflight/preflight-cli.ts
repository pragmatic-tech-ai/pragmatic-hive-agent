import { HttpsKubeTransport, InClusterServiceAccount, KubeApiClient, type IKubeTransport } from '@pragmatic-tech-ai/pragmatic-kube'
import { ClusterVersionCheck } from './cluster-version-check.js'
import { DnsNameCheck, NodeHostResolver, type IHostResolver } from './dns-name-check.js'
import { IngressClassCheck } from './ingress-class-check.js'
import { Preflight } from './preflight.js'
import { PreflightOutcome, type IPreflightCheck, type PreflightResult } from './preflight-check.js'
import { PreflightSettings } from './preflight-settings.js'
import { StorageClassCheck } from './storage-class-check.js'
import { TlsCheck } from './tls-check.js'

/** Where the CLI writes its lines (stdout in the Job; a recorder in tests). */
export interface IPreflightOutput
{
    Line(text: string): void
}

/** The Job's stdout. */
export class ConsolePreflightOutput implements IPreflightOutput
{
    public Line(text: string): void
    {
        console.log(text)
    }
}

/**
 * `pragmatic-agentd preflight`: the checks over the pod's service account and the chart's `PRAGMATIC_PREFLIGHT_*` settings,
 * one line per check (`<outcome> <check>: <message>`, then `  fix: <fix>` when there is one) and a summary; exit 0 when no
 * check failed, else 1, so the hook Job fails and Helm stops before any workload is created.
 */
export class PreflightCli
{
    public static readonly Command = 'preflight'
    private static readonly Space = ' '
    private static readonly Colon = ': '
    private static readonly FixPrefix = '  fix: '
    private static readonly OutsideCluster = 'fail cluster: no in-cluster service account (pragmatic-agentd preflight runs as the chart\'s preflight Job)'
    private static readonly SettingsFailedPrefix = 'fail settings: '
    private static readonly PassedSummary = 'preflight passed: the engine can be installed'
    private static readonly FailedPrefix = 'preflight failed: '
    private static readonly FailedSuffix = ' check(s) failed; nothing was installed'
    private static readonly OutcomeWidth = 4

    private constructor()
    {
    }

    /** The checks in the order they report. */
    public static Checks(client: KubeApiClient, settings: PreflightSettings, resolver: IHostResolver = new NodeHostResolver()): IPreflightCheck[]
    {
        return [
            new ClusterVersionCheck(client),
            new StorageClassCheck(client, settings.StorageClass),
            new IngressClassCheck(client, settings.IngressClass, settings.Address),
            new DnsNameCheck(settings.Hosts, settings.Address, resolver),
            new TlsCheck(client, settings.Namespace, settings.Tls, settings.TlsSecret, settings.Hosts),
        ]
    }

    /** Runs in the pod: `transport` and `resolver` replace the service account's and the cluster's (tests). */
    public static async Run(env: NodeJS.ProcessEnv, output: IPreflightOutput, transport?: IKubeTransport, resolver?: IHostResolver): Promise<number>
    {
        const P = PreflightCli
        let settings: PreflightSettings
        try
        {
            settings = PreflightSettings.From(env)
        }
        catch (error)
        {
            output.Line(P.SettingsFailedPrefix + (error instanceof Error ? error.message : String(error)))
            return 1
        }
        const kube = transport ?? P.InClusterTransport(env)
        if (kube === undefined)
        {
            output.Line(P.OutsideCluster)
            return 1
        }
        const results = await new Preflight(P.Checks(new KubeApiClient(kube), settings, resolver)).Run()
        for (const result of results)
        {
            P.Print(result, output)
        }
        const failed = results.filter(r => r.Outcome === PreflightOutcome.Fail).length
        output.Line(failed === 0 ? P.PassedSummary : P.FailedPrefix + failed + P.FailedSuffix)
        return failed === 0 ? 0 : 1
    }

    private static InClusterTransport(env: NodeJS.ProcessEnv): IKubeTransport | undefined
    {
        const account = InClusterServiceAccount.Detect(env)
        return account === undefined ? undefined : new HttpsKubeTransport(account)
    }

    private static Print(result: PreflightResult, output: IPreflightOutput): void
    {
        const P = PreflightCli
        output.Line(result.Outcome.padEnd(P.OutcomeWidth) + P.Space + result.Check + P.Colon + result.Message)
        if (result.Fix !== '')
        {
            output.Line(P.FixPrefix + result.Fix)
        }
    }
}
