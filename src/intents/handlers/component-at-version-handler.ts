import { IntentFailure, IntentProgress, IntentStatus, type ComponentAtVersion } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveKube } from '../../kube/hive-kube.js'
import type { EngineWorkloads } from '../engine-workloads.js'
import type { IApplyContext } from '../intent-executor-contract.js'
import type { RolloutWatch } from '../rollout-watch.js'

/**
 * "Component X at version V" (C3.4): patches only the named engine component's container image to the same repository
 * at the intent's digest, then waits for the workload to roll out. A component the engine does not have, a workload
 * that is not there, or an image outside the release registries is refused at the pre-check. A roll that never becomes
 * ready is put back to the image it replaced (kept with the intent, so an agent restarted mid-roll still knows it) and
 * reported failed `not-ready`; the Deployments keep `maxUnavailable: 0`, so the old pods serve meanwhile.
 */
export class ComponentAtVersionHandler
{
    /** A release image: one of the release registries, the pragmatic-tech-ai organisation, a repository; tag or digest after. */
    public static readonly ReleaseRepository = /^((?:ghcr\.io|registry\.pragmatic-tech\.ai)\/pragmatic-tech-ai\/[a-z0-9][a-z0-9._/-]*)(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/
    private static readonly DigestSeparator = '@'

    public constructor(private readonly kube: IHiveKube, private readonly workloads: EngineWorkloads, private readonly watch: RolloutWatch)
    {
    }

    public async Apply(intentId: string, action: ComponentAtVersion, context: IApplyContext): Promise<IntentStatus>
    {
        const H = ComponentAtVersionHandler
        const workload = this.workloads.Of(action.Component)
        const current = workload === undefined ? undefined : await this.kube.GetWorkload(workload.Namespace, workload.Kind, workload.Name)
        const container = current?.Container(workload?.Container)
        const repository = container === undefined ? null : H.RepositoryOf(container.Image)
        if (workload === undefined || current === undefined || container === undefined || repository === null)
        {
            return IntentStatus.FailedWith(intentId, IntentFailure.PrecheckRefused)
        }
        const target = repository + H.DigestSeparator + action.ImageDigest
        if (container.Image !== target)
        {
            await context.NotePrevious(container.Image)
            await this.kube.PatchWorkload(workload.Namespace, workload.Kind, workload.Name, H.ImagePatch(container.Name, target))
        }
        const rolled = await this.watch.Until(async () => (await this.kube.GetWorkload(workload.Namespace, workload.Kind, workload.Name))?.RolledOut === true)
        if (rolled)
        {
            return IntentStatus.Of(intentId, IntentProgress.Applied)
        }
        const previous = context.PreviousImage
        if (previous !== null && previous !== target)
        {
            await this.kube.PatchWorkload(workload.Namespace, workload.Kind, workload.Name, H.ImagePatch(container.Name, previous))
        }
        return IntentStatus.FailedWith(intentId, IntentFailure.NotReady)
    }

    /** The release repository of an image reference, or null when the image is not a release image. */
    public static RepositoryOf(image: string): string | null
    {
        return ComponentAtVersionHandler.ReleaseRepository.exec(image)?.[1] ?? null
    }

    private static ImagePatch(container: string, image: string): object
    {
        return { spec: { template: { spec: { containers: [{ name: container, image }] } } } }
    }
}
