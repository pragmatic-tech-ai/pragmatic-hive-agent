import type { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'
import { ClusterClasses } from './cluster-classes.js'
import { PreflightResults, type IPreflightCheck, type PreflightResult } from './preflight-check.js'

/** `storage.className` names a StorageClass that exists; unset, the cluster has a default one (the Postgres claim needs it). */
export class StorageClassCheck implements IPreflightCheck
{
    public static readonly CheckName = 'storage-class'
    private static readonly NamedPrefix = 'StorageClass '
    private static readonly FoundSuffix = ' exists'
    private static readonly MissingSuffix = ' does not exist (the cluster has: '
    private static readonly Close = ')'
    private static readonly DefaultPrefix = 'the default StorageClass is '
    private static readonly NoDefault = 'the cluster has no default StorageClass and storage.className is not set (the cluster has: '
    private static readonly NamedFix = 'Set storage.className to one of the cluster\'s StorageClasses, or create the one named.'
    private static readonly DefaultFix = 'Mark a StorageClass as the default (kubectl annotate storageclass <name> storageclass.kubernetes.io/is-default-class=true) or install with --set storage.className=<name>.'

    public readonly Name = StorageClassCheck.CheckName

    public constructor(private readonly client: KubeApiClient, private readonly className: string | undefined)
    {
    }

    public async Run(): Promise<PreflightResult>
    {
        const S = StorageClassCheck
        const classes = await ClusterClasses.List(this.client, ClusterClasses.StorageClassesPath, ClusterClasses.StorageDefaultAnnotations)
        if (this.className !== undefined)
        {
            return classes.some(c => c.Name === this.className)
                ? PreflightResults.Pass(S.CheckName, S.NamedPrefix + this.className + S.FoundSuffix)
                : PreflightResults.Fail(S.CheckName, S.NamedPrefix + this.className + S.MissingSuffix + ClusterClasses.Names(classes) + S.Close, S.NamedFix)
        }
        const chosen = classes.find(c => c.IsDefault)
        return chosen !== undefined
            ? PreflightResults.Pass(S.CheckName, S.DefaultPrefix + chosen.Name)
            : PreflightResults.Fail(S.CheckName, S.NoDefault + ClusterClasses.Names(classes) + S.Close, S.DefaultFix)
    }
}
