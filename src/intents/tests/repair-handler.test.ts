import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IntentFailure, IntentProgress, Repair, RepairScope } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { KubeWorkloadKind } from '../../kube/hive-kube.js'
import { FakeHiveKube } from '../../kube/tests/fake-hive-kube.js'
import { EngineWorkload, EngineWorkloads } from '../engine-workloads.js'
import { EnvironmentIntentForwarder } from '../handlers/environment-intent-forwarder.js'
import { RepairHandler } from '../handlers/repair-handler.js'
import { RolloutWatch } from '../rollout-watch.js'

class RepairWorld
{
    public static readonly Ns = 'pragmatic-system'
    public readonly Kube = new FakeHiveKube()
    public readonly Handler: RepairHandler

    public constructor()
    {
        const image = 'ghcr.io/pragmatic-tech-ai/x@sha256:' + 'a'.repeat(64)
        this.Kube.AddWorkload(RepairWorld.Ns, KubeWorkloadKind.Deployment, 'console', image)
        this.Kube.AddWorkload(RepairWorld.Ns, KubeWorkloadKind.StatefulSet, 'pragmatic-postgres', image)
        let now = 0
        this.Handler = new RepairHandler(this.Kube, new EngineWorkloads([
            new EngineWorkload(EngineWorkloads.ConsoleComponent, RepairWorld.Ns, KubeWorkloadKind.Deployment, 'console', undefined),
            new EngineWorkload(EngineWorkloads.PostgresComponent, RepairWorld.Ns, KubeWorkloadKind.StatefulSet, 'pragmatic-postgres', undefined),
        ]), new RolloutWatch({ TimeoutMs: 30, PollMs: 10, Sleep: async () => undefined, Now: () => now += 10 }), new EnvironmentIntentForwarder(undefined), new FakeClock())
    }
}

describe('RepairHandler', () =>
{
    it('a component repair restarts its workload and waits for it', async () =>
    {
        const world = new RepairWorld()
        const status = await world.Handler.Apply('in1', new Repair(RepairScope.Component, EngineWorkloads.ConsoleComponent))
        assert.equal(status.Progress, IntentProgress.Applied)
        assert.deepEqual(world.Kube.PatchLog, ['deployments/console'])
        assert.ok(world.Kube.Workload(RepairWorld.Ns, KubeWorkloadKind.Deployment, 'console')?.RestartedAt !== undefined)
    })

    it('an engine repair restarts only what is not ready, and fails not-ready when it stays broken', async () =>
    {
        const world = new RepairWorld()
        assert.equal((await world.Handler.Apply('in1', new Repair(RepairScope.Engine, null))).Progress, IntentProgress.Applied)
        assert.deepEqual(world.Kube.PatchLog, [])
        const broken = world.Kube.Workload(RepairWorld.Ns, KubeWorkloadKind.Deployment, 'console')!
        broken.Ready = false
        const status = await world.Handler.Apply('in1', new Repair(RepairScope.Engine, null))
        assert.deepEqual(world.Kube.PatchLog, ['deployments/console'])
        assert.equal(status.Failure, IntentFailure.NotReady)
    })

    it('an unknown component is refused; an environment repair is the console\'s', async () =>
    {
        const world = new RepairWorld()
        assert.equal((await world.Handler.Apply('in1', new Repair(RepairScope.Component, 'pragmatic-env-server'))).Failure, IntentFailure.PrecheckRefused)
        assert.equal((await world.Handler.Apply('in1', new Repair(RepairScope.Environment, 'prod'))).Failure, IntentFailure.ConsoleUnavailable)
        assert.deepEqual(world.Kube.PatchLog, [])
    })
})
