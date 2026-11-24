import { readFileSync } from 'node:fs'
import {
    ConsoleIntentCall, ConsoleIntentLink, ConsoleIntentOutcome, ConsoleIntentRefusal, IntentFailure, IntentProgress, IntentStatus, type IntentAction,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** How the forwarder posts (global fetch; a test's fake). */
export type ConsoleFetch = (url: string, init: { method: string, headers: Record<string, string>, body?: string, signal: AbortSignal }) => Promise<{ status: number, text(): Promise<string> }>

/**
 * The environment intents and the ingress-certificate rotation go to the engine's console (C3.4 ruling "who applies
 * what": the console owns its hive's environments), over its internal endpoint `POST /internal/environment-intents`
 * on port 7211 with the agent's projected service-account token for audience `pragmatic-tenant-admin` (re-read on every
 * call: the kubelet rotates it). The console's outcome becomes the intent's status. When the console cannot be reached
 * or answers `unavailable` the intent stays `applying` and is forwarded again on the next tick until it expires (the
 * console is idempotent per intent id); a console that refuses the agent itself, or the call's shape, or answers what is
 * not ours, fails it `console-unavailable` / `precheck-refused` for good. Without a console URL (a chart before C3.4)
 * every forwarded intent fails `console-unavailable`.
 */
export class EnvironmentIntentForwarder
{
    public static readonly DefaultTokenFile = '/var/run/secrets/pragmatic-tenant-admin/token'
    private static readonly Post = 'POST'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly JsonType = 'application/json'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly Utf8 = 'utf8'
    private static readonly StatusOk = 200
    private static readonly MaxReplyBytes = 16_384
    private static readonly TrailingSlashes = /\/+$/
    private static readonly NoText = ''

    public constructor(
        private readonly consoleUrl: string | undefined,
        private readonly tokenFile: string = EnvironmentIntentForwarder.DefaultTokenFile,
        private readonly fetcher: ConsoleFetch = (url, init) => fetch(url, init),
        private readonly timeoutMs: number = ConsoleIntentLink.TimeoutMs)
    {
    }

    public async Forward(intentId: string, action: IntentAction): Promise<IntentStatus>
    {
        const F = EnvironmentIntentForwarder
        if (this.consoleUrl === undefined)
        {
            return IntentStatus.FailedWith(intentId, IntentFailure.ConsoleUnavailable)
        }
        let token: string
        try
        {
            token = readFileSync(this.tokenFile, F.Utf8).trim()
        }
        catch
        {
            return IntentStatus.FailedWith(intentId, IntentFailure.ConsoleUnavailable)
        }
        let status: number
        let text: string
        try
        {
            const reply = await this.fetcher(this.consoleUrl.replace(F.TrailingSlashes, F.NoText) + ConsoleIntentLink.Path, {
                method: F.Post,
                headers: { [F.AuthorizationHeader]: F.BearerPrefix + token, [F.ContentTypeHeader]: F.JsonType },
                body: JSON.stringify(ConsoleIntentCall.Create(intentId, action).ToJson()),
                signal: AbortSignal.timeout(this.timeoutMs),
            })
            status = reply.status
            text = await reply.text()
        }
        catch
        {
            return IntentStatus.Of(intentId, IntentProgress.Applying)
        }
        if (text.length > F.MaxReplyBytes)
        {
            return IntentStatus.FailedWith(intentId, IntentFailure.ConsoleUnavailable)
        }
        let body: unknown
        try
        {
            body = JSON.parse(text)
        }
        catch
        {
            return status >= 500 ? IntentStatus.Of(intentId, IntentProgress.Applying) : IntentStatus.FailedWith(intentId, IntentFailure.ConsoleUnavailable)
        }
        if (status === F.StatusOk)
        {
            try
            {
                return ConsoleIntentOutcome.Parse(body).StatusOf(intentId)
            }
            catch
            {
                return IntentStatus.FailedWith(intentId, IntentFailure.ConsoleUnavailable)
            }
        }
        switch (ConsoleIntentLink.CodeOf(body))
        {
            case ConsoleIntentRefusal.Unavailable:
                return IntentStatus.Of(intentId, IntentProgress.Applying)
            case ConsoleIntentRefusal.Malformed:
                return IntentStatus.FailedWith(intentId, IntentFailure.PrecheckRefused)
            default:
                return status >= 500 ? IntentStatus.Of(intentId, IntentProgress.Applying) : IntentStatus.FailedWith(intentId, IntentFailure.ConsoleUnavailable)
        }
    }
}
