import { AgentInternalLink } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveKube } from '../kube/hive-kube.js'

/**
 * Who may call the agent's internal API (C3.3): only the engine's console, proved by its projected service-account
 * token for the audience `pragmatic-hive-agent`. Each bearer is checked by a TokenReview: authenticated, for that
 * audience, as the console's service account (`system:serviceaccount:<namespace>:<console account>`). Any other pod's
 * token (the default audience, another account) is refused. The token is never logged or kept.
 */
export class ConsoleCallerCheck
{
    private static readonly BearerPattern = /^Bearer ([^\s]{1,8192})$/

    public constructor(private readonly kube: IHiveKube, private readonly consoleUsername: string)
    {
    }

    /** The bearer of an `authorization` header value, when it is one. */
    public static BearerOf(header: string | undefined): string | undefined
    {
        return ConsoleCallerCheck.BearerPattern.exec(header ?? '')?.[1]
    }

    public async IsConsole(authorization: string | undefined): Promise<boolean>
    {
        const token = ConsoleCallerCheck.BearerOf(authorization)
        if (token === undefined)
        {
            return false
        }
        const review = await this.kube.ReviewToken(token, AgentInternalLink.Audience)
        return review.Authenticated && review.Username === this.consoleUsername && review.Audiences.includes(AgentInternalLink.Audience)
    }
}
