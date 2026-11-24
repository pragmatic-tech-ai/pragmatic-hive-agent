import { IntentFailure, IntentProgress, IntentStatus, type ComponentAtVersion } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveKube, KubeContainer, KubeWorkload } from '../../kube/hive-kube.js'
import type { EngineWorkload, EngineWorkloads } from '../engine-workloads.js'
import type { IApplyContext } from '../intent-executor-contract.js'
import type { RolloutWatch } from '../rollout-watch.js'

/**
 * "Component X at version V" (C3.4): every container and init container of the named engine component that runs its
 * release repository is patched to that repository at the intent's digest (the console's seed init container moves with
 * it), then the workload must roll out by `kubectl rollout status`'s rule. A component the engine does not have, a
 * workload that is not there, or an image outside the release registries is refused at the pre-check. A roll that never
 * completes is put back to the image it replaced (kept with the intent, so an agent restarted mid-roll still knows it)
 * and reported failed `not-ready`. The agent's Deployment rolls with maxSurge 1 / maxUnavailable 0, so its old pod serves
 * meanwhile; the console's is Recreate (one pod on a ReadWriteOnce claim), so the console is down while its new pod
 * starts, and after a revert until the old one is back.
 */
export class ComponentAtVersionHandler
{
    /** A release image: one of the release registries, the pragmatic-tech-ai organisation, a repository; tag or digest after. */
    public static readonly ReleaseRepository = /^((?:ghcr\.io|registry\.pragmatic-tech\.ai)\/pragmatic-tech-ai\/[a-z0-9][a-z0-9._/-]*)(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/
    private static readonly DigestSeparator = '@'
    private static readonly ByDigest = /@sha256:[a-f0-9]{64}$/

    public constructor(private readonly kube: IHiveKube, private readonly workloads: EngineWorkloads, private readonly watch: RolloutWatch)
    {
    }

    public async Apply(intentId: string, action: ComponentAtVersion, context: IApplyContext): Promise<IntentStatus>
    {
        const H = ComponentAtVersionHandler
        const found = await this.Find(action.Component)
        if (found === undefined)
        {
            return IntentStatus.FailedWith(intentId, IntentFailure.PrecheckRefused)
        }
        const { Workload: workload, Current: current, Repository: repository } = found
        const target = repository + H.DigestSeparator + action.ImageDigest
        const primary = current.Container(workload.Container) as KubeContainer
        if (H.Matching(current, repository).some(container => container.Image !== target))
        {
            if (primary.Image !== target)
            {
                await context.NotePrevious(primary.Image)
            }
            await this.kube.PatchWorkload(workload.Namespace, workload.Kind, workload.Name, H.ImagePatch(current, repository, target))
        }
        if (await this.watch.Until(async () => (await this.kube.GetWorkload(workload.Namespace, workload.Kind, workload.Name))?.RolledOut === true))
        {
            return IntentStatus.Of(intentId, IntentProgress.Applied)
        }
        await this.Revert(action, context.PreviousImage)
        return IntentStatus.FailedWith(intentId, IntentFailure.NotReady)
    }

    /** Puts the component's release containers back on `previous` (a roll that failed, or an intent that expired mid-roll). */
    public async Revert(action: ComponentAtVersion, previous: string | null): Promise<void>
    {
        const found = await this.Find(action.Component)
        // What a revert puts back is read from the ConfigMap: only an image of the same release repository, by digest.
        if (found === undefined || previous === null || !ComponentAtVersionHandler.ByDigest.test(previous) || ComponentAtVersionHandler.RepositoryOf(previous) !== found.Repository)
        {
            return
        }
        if (ComponentAtVersionHandler.Matching(found.Current, found.Repository).some(container => container.Image !== previous))
        {
            await this.kube.PatchWorkload(found.Workload.Namespace, found.Workload.Kind, found.Workload.Name, ComponentAtVersionHandler.ImagePatch(found.Current, found.Repository, previous))
        }
    }

    /** The release repository of an image reference, or null when the image is not a release image. */
    public static RepositoryOf(image: string): string | null
    {
        return ComponentAtVersionHandler.ReleaseRepository.exec(image)?.[1] ?? null
    }

    private async Find(component: string): Promise<{ Workload: EngineWorkload, Current: KubeWorkload, Repository: string } | undefined>
    {
        const workload = this.workloads.Of(component)
        const current = workload === undefined ? undefined : await this.kube.GetWorkload(workload.Namespace, workload.Kind, workload.Name)
        const primary = current?.Container(workload?.Container)
        const repository = primary === undefined ? null : ComponentAtVersionHandler.RepositoryOf(primary.Image)
        return workload === undefined || current === undefined || repository === null ? undefined : { Workload: workload, Current: current, Repository: repository }
    }

    private static Matching(workload: KubeWorkload, repository: string): KubeContainer[]
    {
        return [...workload.Containers, ...workload.InitContainers].filter(container => ComponentAtVersionHandler.RepositoryOf(container.Image) === repository)
    }

    /** Every container and init container running `repository`, to `image` (strategic merge by container name). */
    private static ImagePatch(workload: KubeWorkload, repository: string, image: string): object
    {
        const H = ComponentAtVersionHandler
        const of = (list: readonly KubeContainer[]): { name: string, image: string }[] => list.filter(container => H.RepositoryOf(container.Image) === repository).map(container => ({ name: container.Name, image }))
        const initContainers = of(workload.InitContainers)
        const spec = initContainers.length > 0 ? { containers: of(workload.Containers), initContainers } : { containers: of(workload.Containers) }
        return { spec: { template: { spec } } }
    }
}
