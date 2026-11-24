import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentInternalLink, HiveEnrolmentCall, HiveEnrolmentRefusal, ProtocolDecodeError } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HiveEnrolmentRefusedError, type HiveEnrolment } from '../enrolment/hive-enrolment.js'
import type { ConsoleCallerCheck } from './console-caller-check.js'

/** What the API logs: event names and codes only, never a token, a code or a body. */
export interface IInternalApiLog
{
    Event(event: string, code?: string): void
}

/**
 * The hive agent's cluster-internal API (C3.3) on port 7210, reached only by the engine's console (a NetworkPolicy
 * fences the port; ConsoleCallerCheck reviews each bearer): `POST /internal/enrol` `{ Code, Level, ConsoleAddress }`
 * enrols the hive and answers its HiveEnrolmentStatus, or `{ error, code }` with a HiveEnrolmentRefusal code; `GET
 * /internal/enrolment` answers the status. Once enrolled, enrolling again is `already-enrolled` and nothing else is
 * served. Every other path or method is 404 / 405.
 */
export class AgentInternalApi
{
    private static readonly Get = 'GET'
    private static readonly Post = 'POST'
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404
    private static readonly StatusMethodNotAllowed = 405
    private static readonly StatusTooLarge = 413
    private static readonly ContentType = 'Content-Type'
    private static readonly JsonType = 'application/json'
    private static readonly CacheControl = 'Cache-Control'
    private static readonly NoStore = 'no-store'
    private static readonly QuerySeparator = '?'
    private static readonly Utf8 = 'utf8'
    private static readonly NotFoundBody = { error: 'not-found' }
    private static readonly MethodBody = { error: 'method-not-allowed' }
    private static readonly TooLargeBody = { error: 'too-large' }
    private static readonly EnrolledEvent = 'enrolled'
    private static readonly RefusedEvent = 'enrolment-refused'
    private static readonly CallerRefusedEvent = 'caller-refused'
    private static readonly FailedEvent = 'internal-api-failed'
    private static readonly ErrorEvent = 'error'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly AnyAddress = '0.0.0.0'

    private server: Server | undefined

    public constructor(private readonly enrolment: HiveEnrolment, private readonly callers: ConsoleCallerCheck, private readonly log: IInternalApiLog)
    {
    }

    public Listen(port: number = AgentInternalLink.Port, bind: string = AgentInternalApi.AnyAddress): Promise<void>
    {
        const server = createServer((req, res) =>
        {
            void this.Serve(req, res)
        })
        return new Promise((resolve, reject) =>
        {
            server.once(AgentInternalApi.ErrorEvent, reject)
            server.listen(port, bind, () =>
            {
                server.off(AgentInternalApi.ErrorEvent, reject)
                this.server = server
                resolve()
            })
        })
    }

    public Address(): { address: string, port: number }
    {
        const address = this.server?.address() as AddressInfo
        return { address: address.address, port: address.port }
    }

    public async Close(): Promise<void>
    {
        const server = this.server
        this.server = undefined
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    }

    private async Serve(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const A = AgentInternalApi
        try
        {
            const path = (req.url ?? '').split(A.QuerySeparator)[0]
            const route = path === AgentInternalLink.EnrolPath ? A.Post : path === AgentInternalLink.EnrolmentPath ? A.Get : undefined
            if (route === undefined)
            {
                req.resume()
                A.Write(res, A.StatusNotFound, A.NotFoundBody)
                return
            }
            if (req.method !== route)
            {
                req.resume()
                A.Write(res, A.StatusMethodNotAllowed, A.MethodBody)
                return
            }
            if (!await this.callers.IsConsole(req.headers.authorization))
            {
                req.resume()
                this.log.Event(A.CallerRefusedEvent)
                A.Refuse(res, HiveEnrolmentRefusal.NotConsole)
                return
            }
            if (route === A.Get)
            {
                req.resume()
                A.Write(res, A.StatusOk, this.enrolment.Status().ToJson())
                return
            }
            await this.Enrol(req, res)
        }
        catch (error)
        {
            this.log.Event(A.FailedEvent, error instanceof Error ? error.name : undefined)
            if (!res.headersSent)
            {
                A.Refuse(res, HiveEnrolmentRefusal.Unavailable)
            }
        }
    }

    private async Enrol(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const A = AgentInternalApi
        if (this.enrolment.Enrolled !== undefined)
        {
            req.resume()
            A.Refuse(res, HiveEnrolmentRefusal.AlreadyEnrolled)
            return
        }
        const text = await A.ReadBody(req)
        if (text === undefined)
        {
            A.Write(res, A.StatusTooLarge, A.TooLargeBody)
            return
        }
        let call: HiveEnrolmentCall
        try
        {
            call = HiveEnrolmentCall.Parse(JSON.parse(text) as unknown)
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError || error instanceof SyntaxError)
            {
                A.Refuse(res, HiveEnrolmentRefusal.Malformed)
                return
            }
            throw error
        }
        try
        {
            await this.enrolment.Enrol({ Code: call.Code, Level: call.Level, ConsoleAddress: call.ConsoleAddress })
        }
        catch (error)
        {
            if (error instanceof HiveEnrolmentRefusedError)
            {
                this.log.Event(A.RefusedEvent, error.Code)
                A.Refuse(res, error.Code)
                return
            }
            throw error
        }
        this.log.Event(A.EnrolledEvent)
        A.Write(res, A.StatusOk, this.enrolment.Status().ToJson())
    }

    private static Refuse(res: ServerResponse, code: HiveEnrolmentRefusal): void
    {
        AgentInternalApi.Write(res, AgentInternalLink.StatusOf(code), AgentInternalLink.RefusalBody(code))
    }

    private static Write(res: ServerResponse, status: number, body: unknown): void
    {
        const A = AgentInternalApi
        res.writeHead(status, { [A.ContentType]: A.JsonType, [A.CacheControl]: A.NoStore })
        res.end(JSON.stringify(body))
    }

    /** The body under the API's limit, or undefined when it is over (the rest is drained). */
    private static ReadBody(req: IncomingMessage): Promise<string | undefined>
    {
        return new Promise((resolve, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let tooLarge = false
            req.on(AgentInternalApi.DataEvent, (chunk: Buffer) =>
            {
                size += chunk.length
                if (size > AgentInternalLink.BodyLimit)
                {
                    tooLarge = true
                    chunks.length = 0
                    return
                }
                if (!tooLarge)
                {
                    chunks.push(chunk)
                }
            })
            req.on(AgentInternalApi.EndEvent, () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString(AgentInternalApi.Utf8)))
            req.on(AgentInternalApi.ErrorEvent, reject)
        })
    }
}
