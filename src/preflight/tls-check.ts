import { X509Certificate } from 'node:crypto'
import { KubeResourceCatalog, type KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { PreflightResults, type IPreflightCheck, type PreflightResult } from './preflight-check.js'
import { TlsMode } from './preflight-settings.js'

type SecretShape = { data?: Record<string, unknown> }

/**
 * `tls.mode=secret`: `tls.secretName` exists in the install namespace with `tls.crt` and `tls.key`, and its certificate is
 * current and names every published host. `tls.mode=self-signed`: a warning (the bootstrap mints a development CA).
 */
export class TlsCheck implements IPreflightCheck
{
    public static readonly CheckName = 'tls'
    public static readonly CertKey = 'tls.crt'
    public static readonly KeyKey = 'tls.key'
    private static readonly SecretType = { apiVersion: 'v1', kind: 'Secret' }
    private static readonly Base64 = 'base64'
    private static readonly SelfSigned = 'tls.mode=self-signed: the install mints a development CA (Secret pragmatic-tls-dev-ca); browsers warn until it is trusted'
    private static readonly SelfSignedFix = 'For production, create a kubernetes.io/tls Secret for the console and install with --set tls.mode=secret --set tls.secretName=<name>.'
    private static readonly NoSecretName = 'tls.mode=secret but tls.secretName is not set'
    private static readonly SecretPrefix = 'Secret '
    private static readonly MissingSuffix = ' does not exist in namespace '
    private static readonly LacksInfix = ' lacks '
    private static readonly BadCert = ' holds no readable certificate in tls.crt'
    private static readonly ExpiredSuffix = ' holds a certificate that is not valid now (valid '
    private static readonly ToWord = ' to '
    private static readonly Close = ')'
    private static readonly NotForPrefix = ' holds a certificate that does not name '
    private static readonly OkSuffix = ' holds a current certificate for '
    private static readonly Separator = ', '
    private static readonly CreateFix = 'Create the Secret (kubectl create secret tls <name> --cert=<file> --key=<file> -n <namespace>) or install with --set tls.mode=self-signed.'
    private static readonly RenewFix = 'Put a current certificate naming every published host (the console, the realm sign-in service and *.<baseDomain> for the environments) in the Secret, then install again.'

    public readonly Name = TlsCheck.CheckName

    public constructor(
        private readonly client: KubeApiClient,
        private readonly namespace: string,
        private readonly mode: TlsMode,
        private readonly secretName: string | undefined,
        private readonly hosts: readonly string[],
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Run(): Promise<PreflightResult>
    {
        const T = TlsCheck
        if (this.mode === TlsMode.SelfSigned)
        {
            return PreflightResults.Warn(T.CheckName, T.SelfSigned, T.SelfSignedFix)
        }
        if (this.secretName === undefined)
        {
            return PreflightResults.Fail(T.CheckName, T.NoSecretName, T.CreateFix)
        }
        const named = T.SecretPrefix + this.secretName
        const secret = await this.client.Get(KubeResourceCatalog.PathOf(T.SecretType, this.namespace, this.secretName)) as SecretShape | undefined
        if (secret === undefined)
        {
            return PreflightResults.Fail(T.CheckName, named + T.MissingSuffix + this.namespace, T.CreateFix)
        }
        const data = secret.data ?? {}
        for (const key of [T.CertKey, T.KeyKey])
        {
            if (typeof data[key] !== 'string' || data[key] === '')
            {
                return PreflightResults.Fail(T.CheckName, named + T.LacksInfix + key, T.CreateFix)
            }
        }
        const certificate = T.CertificateOf(data[T.CertKey] as string)
        if (certificate === undefined)
        {
            return PreflightResults.Fail(T.CheckName, named + T.BadCert, T.RenewFix)
        }
        const now = this.now().getTime()
        if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo))
        {
            return PreflightResults.Fail(T.CheckName, named + T.ExpiredSuffix + certificate.validFrom + T.ToWord + certificate.validTo + T.Close, T.RenewFix)
        }
        const uncovered = this.hosts.filter(host => certificate.checkHost(host) === undefined)
        if (uncovered.length > 0)
        {
            return PreflightResults.Fail(T.CheckName, named + T.NotForPrefix + uncovered.join(T.Separator), T.RenewFix)
        }
        return PreflightResults.Pass(T.CheckName, named + T.OkSuffix + this.hosts.join(T.Separator))
    }

    private static CertificateOf(base64: string): X509Certificate | undefined
    {
        try
        {
            return new X509Certificate(Buffer.from(base64, TlsCheck.Base64))
        }
        catch
        {
            return undefined
        }
    }
}
