import { lookup } from 'node:dns/promises'
import { PreflightResults, type IPreflightCheck, type PreflightResult } from './preflight-check.js'
import { ConsoleAddress } from './preflight-settings.js'

/** Whether a host name resolves from inside the cluster. */
export interface IHostResolver
{
    Resolves(host: string): Promise<boolean>
}

/** The cluster's resolver (`node:dns/promises` lookup, as the pods will resolve). */
export class NodeHostResolver implements IHostResolver
{
    public async Resolves(host: string): Promise<boolean>
    {
        try
        {
            await lookup(host)
            return true
        }
        catch
        {
            return false
        }
    }
}

/**
 * On its own domain, the console's host (and the realm sign-in service's) resolves. A hive subdomain is published by the
 * platform when the hive enrols, so there it is a warning that nothing resolves yet.
 */
export class DnsNameCheck implements IPreflightCheck
{
    public static readonly CheckName = 'dns-name'
    private static readonly ResolvesSuffix = ' resolve'
    private static readonly ResolvesOneSuffix = ' resolves'
    private static readonly AndWord = ' and '
    private static readonly UnresolvedPrefix = 'does not resolve: '
    private static readonly Separator = ', '
    private static readonly PublishedAtEnrolment = 'the hive subdomain is published at enrolment; until then nothing resolves it'
    private static readonly EnrolFix = 'Enrol the hive (the platform publishes its subdomain), or install with --set console.address=own-domain and a host you own.'
    private static readonly RecordFix = 'Create DNS records (A or CNAME) for the console, the sign-in service and a wildcard for the environments (*.<baseDomain>), pointing at the ingress controller\'s external address, then install again.'

    public readonly Name = DnsNameCheck.CheckName

    public constructor(private readonly hosts: readonly string[], private readonly address: ConsoleAddress, private readonly resolver: IHostResolver = new NodeHostResolver())
    {
    }

    public async Run(): Promise<PreflightResult>
    {
        const D = DnsNameCheck
        if (this.address !== ConsoleAddress.OwnDomain)
        {
            return PreflightResults.Warn(D.CheckName, D.PublishedAtEnrolment, D.EnrolFix)
        }
        const unresolved: string[] = []
        for (const host of this.hosts)
        {
            if (!await this.resolver.Resolves(host))
            {
                unresolved.push(host)
            }
        }
        return unresolved.length === 0
            ? PreflightResults.Pass(D.CheckName, this.hosts.join(D.AndWord) + (this.hosts.length === 1 ? D.ResolvesOneSuffix : D.ResolvesSuffix))
            : PreflightResults.Fail(D.CheckName, D.UnresolvedPrefix + unresolved.join(D.Separator), D.RecordFix)
    }
}
