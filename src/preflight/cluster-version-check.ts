import type { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { PreflightResults, type IPreflightCheck, type PreflightResult } from './preflight-check.js'

type VersionInfo = { major?: unknown; minor?: unknown }

/** The API server reports Kubernetes 1.30 or later (`GET /version`): the engine's admission fence is a v1 ValidatingAdmissionPolicy. */
export class ClusterVersionCheck implements IPreflightCheck
{
    public static readonly CheckName = 'cluster-version'
    public static readonly MinimumMajor = 1
    public static readonly MinimumMinor = 30
    private static readonly VersionPath = '/version'
    private static readonly Digits = /^(\d+)/
    private static readonly Dot = '.'
    private static readonly PassPrefix = 'Kubernetes '
    private static readonly TooOldPrefix = 'the cluster runs Kubernetes '
    private static readonly TooOldSuffix = '; the engine needs 1.30 or later'
    private static readonly Unreadable = 'the API server did not report its version'
    private static readonly UpgradeFix = 'Upgrade the cluster to Kubernetes 1.30 or later, then install again.'

    public readonly Name = ClusterVersionCheck.CheckName

    public constructor(private readonly client: KubeApiClient)
    {
    }

    public async Run(): Promise<PreflightResult>
    {
        const C = ClusterVersionCheck
        const info = await this.client.Get(C.VersionPath) as VersionInfo | undefined
        const major = C.NumberOf(info?.major)
        const minor = C.NumberOf(info?.minor)
        if (major === undefined || minor === undefined)
        {
            return PreflightResults.Fail(C.CheckName, C.Unreadable, C.UpgradeFix)
        }
        const version = major + C.Dot + minor
        if (major < C.MinimumMajor || (major === C.MinimumMajor && minor < C.MinimumMinor))
        {
            return PreflightResults.Fail(C.CheckName, C.TooOldPrefix + version + C.TooOldSuffix, C.UpgradeFix)
        }
        return PreflightResults.Pass(C.CheckName, C.PassPrefix + version)
    }

    /** `"30"` and managed clusters' `"30+"` both read 30. */
    private static NumberOf(raw: unknown): number | undefined
    {
        if (typeof raw !== 'string')
        {
            return undefined
        }
        const match = ClusterVersionCheck.Digits.exec(raw)
        return match === null ? undefined : Number(match[1])
    }
}
