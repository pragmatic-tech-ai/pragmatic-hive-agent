import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InClusterHiveKube, KubeWorkloadKind } from '../hive-kube.js'

/** The in-cluster client with its transport replaced: records each request, answers from a queue. */
class RecordingHiveKube extends InClusterHiveKube
{
    public readonly Requests: { Method: string, Path: string, Body: string | undefined }[] = []

    public constructor(private readonly answers: { status: number, body: unknown }[])
    {
        super()
    }

    protected override Send(method: string, path: string, body: string | undefined): Promise<{ status: number; body: string }>
    {
        this.Requests.push({ Method: method, Path: path, Body: body })
        const answer = this.answers.shift() ?? { status: 500, body: {} }
        return Promise.resolve({ status: answer.status, body: JSON.stringify(answer.body) })
    }
}

describe('InClusterHiveKube', () =>
{
    it('reads and creates the identity Secret, base64 both ways; a 409 create is false', async () =>
    {
        const kube = new RecordingHiveKube([
            { status: 404, body: {} },
            { status: 201, body: {} },
            { status: 409, body: {} },
            { status: 200, body: { data: { 'hive-key.pem': Buffer.from('PEM').toString('base64') } } },
        ])
        assert.equal(await kube.GetSecretData('pragmatic-system', 'pragmatic-hive-identity'), undefined)
        assert.equal(await kube.CreateSecret('pragmatic-system', 'pragmatic-hive-identity', { 'hive-key.pem': 'PEM' }, { a: 'b' }), true)
        assert.equal(await kube.CreateSecret('pragmatic-system', 'pragmatic-hive-identity', { 'hive-key.pem': 'PEM' }, {}), false)
        assert.deepEqual(await kube.GetSecretData('pragmatic-system', 'pragmatic-hive-identity'), { 'hive-key.pem': 'PEM' })
        assert.equal(kube.Requests[0]?.Path, '/api/v1/namespaces/pragmatic-system/secrets/pragmatic-hive-identity')
        assert.equal(kube.Requests[1]?.Method, 'POST')
        assert.equal(kube.Requests[1]?.Path, '/api/v1/namespaces/pragmatic-system/secrets')
        const created = JSON.parse(kube.Requests[1]?.Body ?? '{}') as { kind: string, data: Record<string, string>, metadata: { name: string } }
        assert.equal(created.kind, 'Secret')
        assert.equal(created.metadata.name, 'pragmatic-hive-identity')
        assert.equal(created.data['hive-key.pem'], Buffer.from('PEM').toString('base64'))
    })

    it('creates a ConfigMap without a version and replaces it with one', async () =>
    {
        const kube = new RecordingHiveKube([{ status: 201, body: {} }, { status: 200, body: {} }, { status: 200, body: { data: { k: 'v' }, metadata: { resourceVersion: '7' } } }])
        await kube.PutConfigMap('pragmatic-system', 'pragmatic-hive-enrolment', { k: 'v' }, {}, undefined)
        await kube.PutConfigMap('pragmatic-system', 'pragmatic-hive-enrolment', { k: 'v' }, {}, '6')
        const read = await kube.GetConfigMap('pragmatic-system', 'pragmatic-hive-enrolment')
        assert.deepEqual([kube.Requests[0]?.Method, kube.Requests[0]?.Path], ['POST', '/api/v1/namespaces/pragmatic-system/configmaps'])
        assert.deepEqual([kube.Requests[1]?.Method, kube.Requests[1]?.Path], ['PUT', '/api/v1/namespaces/pragmatic-system/configmaps/pragmatic-hive-enrolment'])
        assert.equal((JSON.parse(kube.Requests[1]?.Body ?? '{}') as { metadata: { resourceVersion: string } }).metadata.resourceVersion, '6')
        assert.equal(read?.ResourceVersion, '7')
        assert.deepEqual(read?.Data, { k: 'v' })
    })

    it('a TokenReview asks for the audience and answers user and audiences only when authenticated', async () =>
    {
        const kube = new RecordingHiveKube([
            { status: 201, body: { status: { authenticated: true, user: { username: 'system:serviceaccount:ns:console' }, audiences: ['pragmatic-hive-agent'] } } },
            { status: 201, body: { status: { authenticated: false, user: { username: 'ignored' } } } },
        ])
        const ok = await kube.ReviewToken('tok', 'pragmatic-hive-agent')
        const refused = await kube.ReviewToken('tok', 'pragmatic-hive-agent')
        assert.deepEqual([ok.Authenticated, ok.Username, ok.Audiences], [true, 'system:serviceaccount:ns:console', ['pragmatic-hive-agent']])
        assert.deepEqual([refused.Authenticated, refused.Username], [false, null])
        assert.equal(kube.Requests[0]?.Path, '/apis/authentication.k8s.io/v1/tokenreviews')
        assert.deepEqual((JSON.parse(kube.Requests[0]?.Body ?? '{}') as { spec: unknown }).spec, { token: 'tok', audiences: ['pragmatic-hive-agent'] })
    })

    it('a workload is ready with every replica ready, absent on 404', async () =>
    {
        const kube = new RecordingHiveKube([{ status: 200, body: { status: { replicas: 1, readyReplicas: 1 } } }, { status: 200, body: { status: { replicas: 1 } } }, { status: 404, body: {} }])
        assert.equal(await kube.WorkloadReady('pragmatic-system', KubeWorkloadKind.StatefulSet, 'pragmatic-postgres'), true)
        assert.equal(await kube.WorkloadReady('pragmatic-system', KubeWorkloadKind.Deployment, 'x'), false)
        assert.equal(await kube.WorkloadReady('pragmatic-system', KubeWorkloadKind.Deployment, 'y'), undefined)
        assert.equal(kube.Requests[0]?.Path, '/apis/apps/v1/namespaces/pragmatic-system/statefulsets/pragmatic-postgres')
    })
})
