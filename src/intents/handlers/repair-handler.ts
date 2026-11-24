import { IntentFailure, IntentProgress, IntentStatus, RepairScope, type IProtocolClock, type Repair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveKube } from '../../kube/hive-kube.js'
import type { EngineWorkload, EngineWorkloads } from '../engine-workloads.js'
import type { RolloutWatch } from '../rollout-watch.js'
import type { EnvironmentIntentForwarder } from './environment-intent-forwarder.js'

/**
 * "Repair" (C3.4): desired against observed state. One component: a rollout restart of its workload, then wait for it
 * to roll out. The engine: every engine workload that is not ready is restarted (the ready ones are left alone, so a
 * repair never restarts Postgres needlessly), then all must be ready. An environment's repair is the console's
 * (forwarded).
 */
export class RepairHandler
{
    public static readonly RestartAnnotation = 'kubectl.kubernetes.io/restartedAt'

    public constructor(
        private readonly kube: IHiveKube,
        private readonly workloads: EngineWorkloads,
        private readonly watch: RolloutWatch,
        private readonly forwarder: EnvironmentIntentForwarder,
        private readonly clock: IProtocolClock)
    {
    }

    public async Apply(intentId: string, action: Repair): Promise<IntentStatus>
    {
        switch (action.Scope)
        {
            case RepairScope.Environment:
                return this.forwarder.Forward(intentId, action)
            case RepairScope.Component:
            {
                const workload = this.workloads.Of(action.Name ?? '')
                if (workload === undefined || await this.kube.GetWorkload(workload.Namespace, workload.Kind, workload.Name) === undefined)
                {
                    return IntentStatus.FailedWith(intentId, IntentFailure.PrecheckRefused)
                }
                return await this.Restart([workload]) ? IntentStatus.Of(intentId, IntentProgress.Applied) : IntentStatus.FailedWith(intentId, IntentFailure.NotReady)
            }
            case RepairScope.Engine:
            {
                const broken: EngineWorkload[] = []
                for (const workload of this.workloads.All())
                {
                    const observed = await this.kube.GetWorkload(workload.Namespace, workload.Kind, workload.Name)
                    if (observed !== undefined && !observed.Ready)
                    {
                        broken.push(workload)
                    }
                }
                return await this.Restart(broken) ? IntentStatus.Of(intentId, IntentProgress.Applied) : IntentStatus.FailedWith(intentId, IntentFailure.NotReady)
            }
        }
    }

    private async Restart(workloads: readonly EngineWorkload[]): Promise<boolean>
    {
        const stamp = this.clock.Now().toISOString()
        for (const workload of workloads)
        {
            await this.kube.PatchWorkload(workload.Namespace, workload.Kind, workload.Name, { spec: { template: { metadata: { annotations: { [RepairHandler.RestartAnnotation]: stamp } } } } })
        }
        for (const workload of workloads)
        {
            if (!await this.watch.Until(async () => (await this.kube.GetWorkload(workload.Namespace, workload.Kind, workload.Name))?.RolledOut === true))
            {
                return false
            }
        }
        return true
    }
}
