import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentAtVersion, IntentFailure, IntentProgress } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { KubeWorkloadKind } from '../../kube/hive-kube.js'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import { EngineWorkload, EngineWorkloads } from '../engine-workloads.js'
import { ComponentAtVersionHandler } from '../handlers/component-at-version-handler.js'
import type { IApplyContext } from '../intent-executor-contract.js'
import { RolloutWatch } from '../rollout-watch.js'

class MemoryContext implements IApplyContext
{
    public PreviousImage: string | null = null

    public async NotePrevious(image: string): Promise<void>
    {
        this.PreviousImage = image
    }
}

class HandlerWorld
{
    public static readonly Ns = 'pragmatic-system'
    public static readonly Old = 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@sha256:' + '1'.repeat(64)
    public static readonly AgentOld = 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent@sha256:' + '2'.repeat(64)
    public static readonly PostgresOld = 'ghcr.io/pragmatic-tech-ai/pragmatic-postgres@sha256:' + '3'.repeat(64)
    public static readonly NewDigest = 'sha256:' + 'f'.repeat(64)

    public readonly Kube = new FakeHiveKube()
    public readonly Workloads = new EngineWorkloads([
        new EngineWorkload(EngineWorkloads.ConsoleComponent, HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-tenant-admin-acme', undefined),
        new EngineWorkload(EngineWorkloads.AgentComponent, HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-hive-acme-hive-agent', undefined),
        new EngineWorkload(EngineWorkloads.PostgresComponent, HandlerWorld.Ns, KubeWorkloadKind.StatefulSet, 'pragmatic-postgres', undefined),
    ])
    public readonly Handler = new ComponentAtVersionHandler(this.Kube, this.Workloads, new RolloutWatch({ TimeoutMs: 30, PollMs: 10, Sleep: async () => undefined, Now: () => this.now += 10 }))
    private now = 0

    public constructor()
    {
        this.Kube.AddWorkload(HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-tenant-admin-acme', HandlerWorld.Old, 'tenant-admin')
        this.Kube.AddWorkload(HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-hive-acme-hive-agent', HandlerWorld.AgentOld, 'agent')
        this.Kube.AddWorkload(HandlerWorld.Ns, KubeWorkloadKind.StatefulSet, 'pragmatic-postgres', HandlerWorld.PostgresOld, 'postgres')
    }

    public static Action(component: string): ComponentAtVersion
    {
        return new ComponentAtVersion(component, '0.2.0', HandlerWorld.NewDigest, 'sha256:' + 'b'.repeat(64), null)
    }
}

describe('ComponentAtVersionHandler', () =>
{
    it('component-at-version patches only the named deployment\'s image by digest', async () =>
    {
        const world = new HandlerWorld()
        const status = await world.Handler.Apply('in1', HandlerWorld.Action(EngineWorkloads.ConsoleComponent), new MemoryContext())
        assert.equal(status.Progress, IntentProgress.Applied)
        assert.deepEqual(world.Kube.PatchLog, ['deployments/pragmatic-tenant-admin-acme'])
        assert.equal(world.Kube.Workload(HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-tenant-admin-acme')?.Containers[0]?.Image, 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin@' + HandlerWorld.NewDigest)
        assert.equal(world.Kube.Workload(HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-hive-acme-hive-agent')?.Containers[0]?.Image, HandlerWorld.AgentOld)
        assert.equal(world.Kube.Workload(HandlerWorld.Ns, KubeWorkloadKind.StatefulSet, 'pragmatic-postgres')?.Containers[0]?.Image, HandlerWorld.PostgresOld)
    })

    it('already at the digest: nothing is patched, applied once rolled out', async () =>
    {
        const world = new HandlerWorld()
        world.Kube.Workload(HandlerWorld.Ns, KubeWorkloadKind.StatefulSet, 'pragmatic-postgres')!.Containers[0] = { Name: 'postgres', Image: 'ghcr.io/pragmatic-tech-ai/pragmatic-postgres@' + HandlerWorld.NewDigest }
        const status = await world.Handler.Apply('in1', HandlerWorld.Action(EngineWorkloads.PostgresComponent), new MemoryContext())
        assert.equal(status.Progress, IntentProgress.Applied)
        assert.deepEqual(world.Kube.PatchLog, [])
    })

    it('a new agent that never readies leaves the old one and the intent failed', async () =>
    {
        const world = new HandlerWorld()
        world.Kube.Workload(HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-hive-acme-hive-agent')!.NeverReadies = true
        const context = new MemoryContext()
        const status = await world.Handler.Apply('in1', HandlerWorld.Action(EngineWorkloads.AgentComponent), context)
        assert.equal(status.Progress, IntentProgress.Failed)
        assert.equal(status.Failure, IntentFailure.NotReady)
        assert.equal(context.PreviousImage, HandlerWorld.AgentOld)
        assert.equal(world.Kube.Workload(HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-hive-acme-hive-agent')?.Containers[0]?.Image, HandlerWorld.AgentOld)
        assert.deepEqual(world.Kube.PatchLog, ['deployments/pragmatic-hive-acme-hive-agent', 'deployments/pragmatic-hive-acme-hive-agent'])
    })

    it('a component the engine does not have, a missing workload or a foreign registry is refused at the pre-check', async () =>
    {
        const world = new HandlerWorld()
        assert.equal((await world.Handler.Apply('in1', HandlerWorld.Action('pragmatic-env-server'), new MemoryContext())).Failure, IntentFailure.PrecheckRefused)
        assert.equal((await world.Handler.Apply('in1', HandlerWorld.Action(EngineWorkloads.IdpComponent), new MemoryContext())).Failure, IntentFailure.PrecheckRefused)
        world.Kube.Workload(HandlerWorld.Ns, KubeWorkloadKind.Deployment, 'pragmatic-tenant-admin-acme')!.Containers[0] = { Name: 'tenant-admin', Image: 'docker.io/evil/tenant-admin:latest' }
        assert.equal((await world.Handler.Apply('in1', HandlerWorld.Action(EngineWorkloads.ConsoleComponent), new MemoryContext())).Failure, IntentFailure.PrecheckRefused)
        assert.deepEqual(world.Kube.PatchLog, [])
    })

    it('reads a release repository from tag and digest forms only', () =>
    {
        assert.equal(ComponentAtVersionHandler.RepositoryOf('registry.pragmatic-tech.ai/pragmatic-tech-ai/pragmatic-postgres:16.4@sha256:' + 'a'.repeat(64)), 'registry.pragmatic-tech.ai/pragmatic-tech-ai/pragmatic-postgres')
        assert.equal(ComponentAtVersionHandler.RepositoryOf('ghcr.io/other-org/pragmatic-postgres:16'), null)
        assert.equal(ComponentAtVersionHandler.RepositoryOf('evil.example/pragmatic-tech-ai/x@sha256:' + 'a'.repeat(64)), null)
    })
})
