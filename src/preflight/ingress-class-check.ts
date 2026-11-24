import type { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ClusterClasses, type ClusterClass } from './cluster-classes.js'
import { PreflightResults, type IPreflightCheck, type PreflightResult } from './preflight-check.js'
import { ConsoleAddress } from './preflight-settings.js'

/**
 * `ingress.className` names an IngressClass that exists; unset, the cluster has a default one. Skipped for a relayed console,
 * which the platform edge publishes. The engine's Ingresses carry ingress-nginx annotations (the realm sign-in service is
 * re-encrypted to its own certificate) and its sign-in throttles trust the controller's forwarded client address, so another
 * controller is a warning: both then need the operator's care.
 */
export class IngressClassCheck implements IPreflightCheck
{
    public static readonly CheckName = 'ingress-class'
    public static readonly NginxController = 'k8s.io/ingress-nginx'
    private static readonly RelayedSkip = 'the console is relayed through the platform edge; no IngressClass is needed'
    private static readonly NamedPrefix = 'IngressClass '
    private static readonly FoundSuffix = ' exists'
    private static readonly MissingSuffix = ' does not exist (the cluster has: '
    private static readonly Close = ')'
    private static readonly DefaultPrefix = 'the default IngressClass is '
    private static readonly NoDefault = 'the cluster has no default IngressClass and ingress.className is not set (the cluster has: '
    private static readonly OtherControllerInfix = ' is served by '
    private static readonly OtherControllerSuffix = ', not ingress-nginx'
    private static readonly NamedFix = 'Set ingress.className to one of the cluster\'s IngressClasses, or install the controller it names.'
    private static readonly DefaultFix = 'Install an ingress controller (ingress-nginx) and mark its IngressClass as the default (kubectl annotate ingressclass <name> ingressclass.kubernetes.io/is-default-class=true), or install with --set ingress.className=<name>.'
    private static readonly ForwardingFix = 'The engine\'s Ingresses use ingress-nginx annotations (backend-protocol HTTPS, proxy-ssl-*), and its sign-in throttles need the controller to forward the client address (use-forwarded-headers, proxy-real-ip-cidr behind another proxy). Use ingress-nginx, or configure the equivalent on this controller.'
    private static readonly ForwardingNote = '; behind another proxy the controller must forward the client address (use-forwarded-headers)'

    public readonly Name = IngressClassCheck.CheckName

    public constructor(private readonly client: KubeApiClient, private readonly className: string | undefined, private readonly address: ConsoleAddress)
    {
    }

    public async Run(): Promise<PreflightResult>
    {
        const I = IngressClassCheck
        if (this.address === ConsoleAddress.RelayedHiveSubdomain)
        {
            return PreflightResults.Skip(I.CheckName, I.RelayedSkip)
        }
        const classes = await ClusterClasses.List(this.client, ClusterClasses.IngressClassesPath, ClusterClasses.IngressDefaultAnnotations)
        if (this.className !== undefined)
        {
            const named = classes.find(c => c.Name === this.className)
            return named === undefined
                ? PreflightResults.Fail(I.CheckName, I.NamedPrefix + this.className + I.MissingSuffix + ClusterClasses.Names(classes) + I.Close, I.NamedFix)
                : I.Found(named, I.NamedPrefix + named.Name + I.FoundSuffix)
        }
        const chosen = classes.find(c => c.IsDefault)
        return chosen === undefined
            ? PreflightResults.Fail(I.CheckName, I.NoDefault + ClusterClasses.Names(classes) + I.Close, I.DefaultFix)
            : I.Found(chosen, I.DefaultPrefix + chosen.Name)
    }

    private static Found(found: ClusterClass, message: string): PreflightResult
    {
        const I = IngressClassCheck
        if (found.Controller !== I.NginxController)
        {
            return PreflightResults.Warn(I.CheckName, I.NamedPrefix + found.Name + I.OtherControllerInfix + String(found.Controller) + I.OtherControllerSuffix, I.ForwardingFix)
        }
        return PreflightResults.Pass(I.CheckName, message + I.ForwardingNote)
    }
}
