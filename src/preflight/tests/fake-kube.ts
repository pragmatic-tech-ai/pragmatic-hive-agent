import { KubeApiClient, type IKubeTransport, type KubeContentType, type KubeMethod, type KubeResponse } from '@pragmatic-tech-ai/pragmatic-kube'

/** Answers GETs from a path table (404 for anything else) and records every path asked. */
export class FakeKubeTransport implements IKubeTransport
{
    public readonly Paths: string[] = []

    public constructor(private readonly answers: Record<string, unknown>, private readonly statuses: Record<string, number> = {})
    {
    }

    public static Client(answers: Record<string, unknown>, statuses: Record<string, number> = {}): KubeApiClient
    {
        return new KubeApiClient(new FakeKubeTransport(answers, statuses))
    }

    public Send(method: KubeMethod, path: string, _body: string | undefined, _type: KubeContentType): Promise<KubeResponse>
    {
        this.Paths.push(method + ' ' + path)
        const status = this.statuses[path]
        if (status !== undefined)
        {
            return Promise.resolve({ status, body: JSON.stringify({ message: 'refused' }) })
        }
        if (!(path in this.answers))
        {
            return Promise.resolve({ status: 404, body: '{}' })
        }
        return Promise.resolve({ status: 200, body: JSON.stringify(this.answers[path]) })
    }
}

/** Cluster objects as the API lists them. */
export class ClusterFixtures
{
    public static readonly VersionPath = '/version'
    public static readonly StorageClasses = '/apis/storage.k8s.io/v1/storageclasses'
    public static readonly IngressClasses = '/apis/networking.k8s.io/v1/ingressclasses'

    public static Version(major: string, minor: string): unknown
    {
        return { major, minor, gitVersion: 'v' + major + '.' + minor + '.0' }
    }

    public static StorageList(...classes: Array<{ name: string; default?: boolean }>): unknown
    {
        return {
            items: classes.map(c => ({
                metadata: { name: c.name, annotations: c.default === true ? { 'storageclass.kubernetes.io/is-default-class': 'true' } : {} },
                provisioner: 'rancher.io/local-path',
            })),
        }
    }

    public static IngressList(...classes: Array<{ name: string; default?: boolean; controller?: string }>): unknown
    {
        return {
            items: classes.map(c => ({
                metadata: { name: c.name, annotations: c.default === true ? { 'ingressclass.kubernetes.io/is-default-class': 'true' } : {} },
                spec: { controller: c.controller ?? 'k8s.io/ingress-nginx' },
            })),
        }
    }
}
