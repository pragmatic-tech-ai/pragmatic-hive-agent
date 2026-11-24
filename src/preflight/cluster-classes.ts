import type { KubeApiClient } from '@pragmatic-tech-ai/pragmatic-kube'

type ClassItem = { metadata?: { name?: unknown; annotations?: Record<string, unknown> }; spec?: { controller?: unknown } }

/** One StorageClass or IngressClass as the checks read it. */
export type ClusterClass = { Name: string; IsDefault: boolean; Controller: string | undefined }

/** Lists a cluster-scoped class kind with its default marker (the `is-default-class` annotations). */
export class ClusterClasses
{
    public static readonly StorageClassesPath = '/apis/storage.k8s.io/v1/storageclasses'
    public static readonly IngressClassesPath = '/apis/networking.k8s.io/v1/ingressclasses'
    public static readonly StorageDefaultAnnotations: readonly string[] = ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']
    public static readonly IngressDefaultAnnotations: readonly string[] = ['ingressclass.kubernetes.io/is-default-class']
    private static readonly TrueValue = 'true'
    private static readonly NoneWord = 'none'
    private static readonly Separator = ', '

    private constructor()
    {
    }

    public static async List(client: KubeApiClient, path: string, defaultAnnotations: readonly string[]): Promise<ClusterClass[]>
    {
        const items = await client.List(path) as ClassItem[]
        return items.flatMap(item =>
        {
            const name = item.metadata?.name
            if (typeof name !== 'string')
            {
                return []
            }
            const annotations = item.metadata?.annotations ?? {}
            const isDefault = defaultAnnotations.some(key => annotations[key] === ClusterClasses.TrueValue)
            const controller = typeof item.spec?.controller === 'string' ? item.spec.controller : undefined
            return [{ Name: name, IsDefault: isDefault, Controller: controller }]
        })
    }

    /** The class names as a sentence fragment (`a, b`), or `none` when the cluster has none. */
    public static Names(classes: readonly ClusterClass[]): string
    {
        return classes.length === 0 ? ClusterClasses.NoneWord : classes.map(c => c.Name).join(ClusterClasses.Separator)
    }
}
