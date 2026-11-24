import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import {
    AgentInternalLink, ConsoleAddress, CreateEnvironment, EnvironmentPurpose, HiveEnrolmentCall, HiveEnrolmentRefusal, HiveLevel, IntentChoice, IntentDecisionCall,
    IntentDecisionRefusal, IntentInternalLink, IntentProgress, IntentStatus, KeptIntentListing, KeptIntentView, MessageKind, RealmSubject, SigningKeyPair,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlatformTrust } from '../../enrolment/platform-trust.js'
import { HiveSigning } from '../../identity/hive-signing.js'
import { IntentAdmissionDecider } from '../../intents/intent-admission-decider.js'
import { IntentPuller } from '../../intents/intent-puller.js'
import { IntentStore } from '../../intents/intent-store.js'
import { FakeAgentChannel, FakeClock, FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { EnrolmentState } from '../../enrolment/enrolment-state.js'
import { HiveEnrolment } from '../../enrolment/hive-enrolment.js'
import { FakeHiveKube, FakeToken } from '../../kube/tests/fake-hive-kube.js'
import { AgentInternalApi } from '../agent-internal-api.js'
import { ConsoleCallerCheck } from '../console-caller-check.js'

class ApiReply
{
    public constructor(public readonly Status: number, public readonly Text: string)
    {
    }

    public get Json(): Record<string, unknown>
    {
        return JSON.parse(this.Text) as Record<string, unknown>
    }
}

class ApiWorld
{
    public static readonly Namespace = 'pragmatic-system'
    public static readonly Console = 'system:serviceaccount:pragmatic-system:pragmatic-tenant-admin-acme'
    public static readonly ConsoleToken = 'console-projected-token'
    public static readonly DefaultAudienceToken = 'console-default-audience-token'
    public static readonly OtherToken = 'other-pod-token'

    public readonly Clock = new FakeClock()
    public readonly Platform = new FakePlatform(this.Clock)
    public readonly Kube = new FakeHiveKube()
    public readonly Key = SigningKeyPair.Generate()
    public readonly Logs: string[] = []
    public readonly Enrolment: HiveEnrolment
    public readonly Api: AgentInternalApi

    public constructor()
    {
        this.Kube.Tokens.set(ApiWorld.ConsoleToken, new FakeToken(ApiWorld.Console, [AgentInternalLink.Audience]))
        this.Kube.Tokens.set(ApiWorld.DefaultAudienceToken, new FakeToken(ApiWorld.Console, ['https://kubernetes.default.svc']))
        this.Kube.Tokens.set(ApiWorld.OtherToken, new FakeToken('system:serviceaccount:pragmatic-env-dev:default', [AgentInternalLink.Audience]))
        this.Enrolment = new HiveEnrolment({
            Key: this.Key, Channel: new FakeAgentChannel(this.Platform), State: new EnrolmentState(this.Kube, ApiWorld.Namespace, this.Platform.TrustRoot), PinnedTrustRoot: this.Platform.TrustRoot,
            Tenant: 'acme', EngineVersion: '0.1.0-early.18', Clock: this.Clock,
        })
        this.Api = new AgentInternalApi(this.Enrolment, new ConsoleCallerCheck(this.Kube, ApiWorld.Console), { Event: (event, code) => this.Logs.push(event + ' ' + (code ?? '')) })
    }

    public Call(code: string = this.Platform.IssueHiveCode('acme', HiveLevel.Enrolled), level: HiveLevel = HiveLevel.Enrolled): string
    {
        return JSON.stringify(HiveEnrolmentCall.Create(code, level, ConsoleAddress.OwnDomain('console.acme.example')).ToJson())
    }

    public Send(method: string, path: string, token: string | undefined, body?: string): Promise<ApiReply>
    {
        const address = this.Api.Address()
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (token !== undefined)
        {
            headers.authorization = 'Bearer ' + token
        }
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: address.address, port: address.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', chunk => chunks.push(chunk as Buffer))
                res.on('end', () => resolve(new ApiReply(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'))))
            })
            req.on('error', reject)
            req.end(body)
        })
    }
}

describe('AgentInternalApi', () =>
{
    let world: ApiWorld

    afterEach(async () =>
    {
        await world.Api.Close()
    })

    const Start = async (): Promise<ApiWorld> =>
    {
        world = new ApiWorld()
        await world.Api.Listen(0, '127.0.0.1')
        return world
    }

    it('the console enrols the hive and reads its status', async () =>
    {
        const w = await Start()
        const before = await w.Send('GET', AgentInternalLink.EnrolmentPath, ApiWorld.ConsoleToken)
        assert.deepEqual(before.Json, { Enrolled: false, HiveId: null, Tenant: null, Level: null })
        const enrolled = await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, w.Call())
        assert.equal(enrolled.Status, 200, enrolled.Text)
        assert.equal(enrolled.Json.Enrolled, true)
        assert.equal(enrolled.Json.Tenant, 'acme')
        assert.equal(enrolled.Json.Level, HiveLevel.Enrolled)
        assert.deepEqual((await w.Send('GET', AgentInternalLink.EnrolmentPath, ApiWorld.ConsoleToken)).Json, enrolled.Json)
    })

    it('a token of another service account is 403', async () =>
    {
        const w = await Start()
        for (const token of [ApiWorld.OtherToken, ApiWorld.DefaultAudienceToken, 'unknown', undefined])
        {
            for (const [method, path] of [['POST', AgentInternalLink.EnrolPath], ['GET', AgentInternalLink.EnrolmentPath]] as const)
            {
                const reply = await w.Send(method, path, token, method === 'POST' ? w.Call() : undefined)
                assert.equal(reply.Status, 403)
                assert.equal(AgentInternalLink.CodeOf(reply.Json), HiveEnrolmentRefusal.NotConsole)
            }
        }
        assert.equal(w.Platform.ReceivedOf(MessageKind.HiveEnrolmentRequest).length, 0)
        assert.ok(w.Kube.Reviewed.every(audience => audience === AgentInternalLink.Audience))
    })

    it('the internal API is not served after enrolment except GET /internal/enrolment', async () =>
    {
        const w = await Start()
        assert.equal((await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, w.Call())).Status, 200)
        const again = await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, w.Call())
        assert.equal(again.Status, 409)
        assert.equal(AgentInternalLink.CodeOf(again.Json), HiveEnrolmentRefusal.AlreadyEnrolled)
        assert.equal((await w.Send('GET', AgentInternalLink.EnrolmentPath, ApiWorld.ConsoleToken)).Status, 200)
        assert.equal((await w.Send('GET', '/internal/other', ApiWorld.ConsoleToken)).Status, 404)
        assert.equal((await w.Send('GET', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken)).Status, 405)
    })

    it('a malformed call, a used code and Standalone are refused with their codes', async () =>
    {
        const w = await Start()
        assert.equal(AgentInternalLink.CodeOf((await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, '{"Code":1}')).Json), HiveEnrolmentRefusal.Malformed)
        assert.equal(AgentInternalLink.CodeOf((await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, 'not json')).Json), HiveEnrolmentRefusal.Malformed)
        const standalone = JSON.stringify({ ...JSON.parse(w.Call()) as object, Level: HiveLevel.Standalone })
        assert.equal(AgentInternalLink.CodeOf((await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, standalone)).Json), HiveEnrolmentRefusal.Malformed)
        assert.equal((await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, 'x'.repeat(AgentInternalLink.BodyLimit + 1))).Status, 413)
    })

    it('the private half is in no log line or response', async () =>
    {
        const w = await Start()
        const pem = w.Key.PrivatePem()
        const body = pem.split('\n')[1] as string
        const replies = [
            await w.Send('GET', AgentInternalLink.EnrolmentPath, ApiWorld.ConsoleToken),
            await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.OtherToken, w.Call()),
            await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, w.Call()),
            await w.Send('GET', AgentInternalLink.EnrolmentPath, ApiWorld.ConsoleToken),
        ]
        for (const text of [...replies.map(reply => reply.Text), ...w.Logs])
        {
            assert.ok(!text.includes(body), 'no key material')
            assert.ok(!text.includes(ApiWorld.ConsoleToken), 'no token')
        }
        const state = [...w.Kube.ConfigMaps.values()].map(map => JSON.stringify(map.Data)).join('')
        assert.ok(!state.includes(body), 'the enrolment ConfigMap holds no key material')
    })

    it('the intent routes need an enrolled hive and the console, list the kept intents and take a decision by digest', async () =>
    {
        const w = await Start()
        const notYet = await w.Send('GET', IntentInternalLink.IntentsPath, ApiWorld.ConsoleToken)
        assert.equal(notYet.Status, 409)
        assert.equal(IntentInternalLink.CodeOf(notYet.Json), IntentDecisionRefusal.NotEnrolled)
        assert.equal((await w.Send('POST', AgentInternalLink.EnrolPath, ApiWorld.ConsoleToken, w.Call())).Status, 200)
        const record = w.Enrolment.Enrolled!
        const signing = new HiveSigning(w.Key, record.HiveId, w.Kube, ApiWorld.Namespace, w.Clock)
        const trust = new PlatformTrust(record, new EnrolmentState(w.Kube, ApiWorld.Namespace, w.Platform.TrustRoot), w.Clock)
        const store = new IntentStore(w.Kube, ApiWorld.Namespace)
        const puller = new IntentPuller({
            Channel: new FakeAgentChannel(w.Platform), Store: store, Decider: new IntentAdmissionDecider(trust), Executor: { Apply: async intent => IntentStatus.Of(intent.Body.IntentId, IntentProgress.Applied) },
            Signing: signing, Trust: trust, Log: { Event: () => undefined, Failed: () => undefined },
        })
        w.Api.AttachIntents(puller)
        const digest = w.Platform.PublishIntent(record.HiveId, new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null)).Digest
        await puller.Tick()
        const listing = KeptIntentListing.Parse((await w.Send('GET', IntentInternalLink.IntentsPath, ApiWorld.ConsoleToken)).Json)
        assert.equal(listing.Intents[0]?.IntentDigest, digest)
        assert.equal(listing.Intents[0]?.Progress, IntentProgress.AwaitingApproval)
        const approver = RealmSubject.Of('acme', 'u-1')
        const path = IntentInternalLink.DecisionPath(listing.Intents[0]!.IntentId)
        const other = await w.Send('POST', path, ApiWorld.OtherToken, JSON.stringify(IntentDecisionCall.Create(digest, IntentChoice.Approve, approver).ToJson()))
        assert.equal(other.Status, 403)
        const stale = await w.Send('POST', path, ApiWorld.ConsoleToken, JSON.stringify(IntentDecisionCall.Create('sha256:' + '0'.repeat(64), IntentChoice.Approve, approver).ToJson()))
        assert.equal(IntentInternalLink.CodeOf(stale.Json), IntentDecisionRefusal.DigestMismatch)
        assert.equal(IntentInternalLink.CodeOf((await w.Send('POST', path, ApiWorld.ConsoleToken, '{"Decision":"approve","Reason":"x"}')).Json), IntentDecisionRefusal.Malformed)
        const decided = await w.Send('POST', path, ApiWorld.ConsoleToken, JSON.stringify(IntentDecisionCall.Create(digest, IntentChoice.Reject, approver).ToJson()))
        assert.equal(decided.Status, 200, decided.Text)
        assert.equal(KeptIntentView.Parse(decided.Json).Progress, IntentProgress.Rejected)
        assert.equal(w.Platform.ReceivedOf(MessageKind.IntentDecision).length, 1)
        assert.equal((await w.Send('GET', IntentInternalLink.DecisionPath('in1'), ApiWorld.ConsoleToken)).Status, 405)
    })
})
