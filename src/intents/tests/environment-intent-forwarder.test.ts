import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleIntentLink, ConsoleIntentOutcome, ConsoleIntentRefusal, CreateEnvironment, EnvironmentPurpose, IntentFailure, IntentProgress } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { EnvironmentIntentForwarder, type ConsoleFetch } from '../handlers/environment-intent-forwarder.js'

class ConsoleCall
{
    public constructor(public readonly Url: string, public readonly Headers: Record<string, string>, public readonly Body: string)
    {
    }
}

class FakeConsole
{
    public readonly Calls: ConsoleCall[] = []
    public Status = 200
    public Body: unknown = ConsoleIntentOutcome.Applied.ToJson()
    public Fails = false

    public readonly Fetch: ConsoleFetch = async (url, init) =>
    {
        this.Calls.push(new ConsoleCall(url, init.headers, init.body ?? ''))
        if (this.Fails)
        {
            throw new TypeError('fetch failed')
        }
        return { status: this.Status, text: async () => JSON.stringify(this.Body) }
    }
}

class ForwarderWorld
{
    public static readonly Url = 'http://pragmatic-tenant-admin-acme-internal.pragmatic-system.svc:7211'
    public readonly Dir = mkdtempSync(join(tmpdir(), 'forwarder-'))
    public readonly TokenFile = join(this.Dir, 'token')
    public readonly Console = new FakeConsole()
    public readonly Forwarder: EnvironmentIntentForwarder

    public constructor()
    {
        writeFileSync(this.TokenFile, 'agent-projected-token\n')
        this.Forwarder = new EnvironmentIntentForwarder(ForwarderWorld.Url, this.TokenFile, this.Console.Fetch)
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

describe('EnvironmentIntentForwarder', () =>
{
    it('environment intents reach the console, and the console\'s refusal code becomes the progress code', async () =>
    {
        const world = new ForwarderWorld()
        try
        {
            const action = new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null)
            const applied = await world.Forwarder.Forward('in1', action)
            assert.equal(applied.Progress, IntentProgress.Applied)
            const [call] = world.Console.Calls
            assert.equal(call?.Url, ForwarderWorld.Url + ConsoleIntentLink.Path)
            assert.equal(call?.Headers['authorization'], 'Bearer agent-projected-token')
            assert.deepEqual(JSON.parse(call!.Body), { IntentId: 'in1', Action: action.ToJson() })

            world.Console.Body = ConsoleIntentOutcome.FailedWith(IntentFailure.EnvironmentExists).ToJson()
            const exists = await world.Forwarder.Forward('in1', action)
            assert.equal(exists.Progress, IntentProgress.Failed)
            assert.equal(exists.Failure, IntentFailure.EnvironmentExists)

            world.Console.Status = 403
            world.Console.Body = ConsoleIntentLink.RefusalBody(ConsoleIntentRefusal.NotAgent)
            assert.equal((await world.Forwarder.Forward('in1', action)).Failure, IntentFailure.ConsoleUnavailable)
            world.Console.Status = 400
            world.Console.Body = ConsoleIntentLink.RefusalBody(ConsoleIntentRefusal.Malformed)
            assert.equal((await world.Forwarder.Forward('in1', action)).Failure, IntentFailure.PrecheckRefused)
        }
        finally
        {
            world.Dispose()
        }
    })

    it('an unreachable or busy console leaves the intent applying, to be forwarded again', async () =>
    {
        const world = new ForwarderWorld()
        try
        {
            const action = new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null)
            world.Console.Fails = true
            assert.equal((await world.Forwarder.Forward('in1', action)).Progress, IntentProgress.Applying)
            world.Console.Fails = false
            world.Console.Status = 503
            world.Console.Body = ConsoleIntentLink.RefusalBody(ConsoleIntentRefusal.Unavailable)
            assert.equal((await world.Forwarder.Forward('in1', action)).Progress, IntentProgress.Applying)
            world.Console.Status = 200
            world.Console.Body = { Progress: 'applied', Failure: null, Note: 'free text' }
            assert.equal((await world.Forwarder.Forward('in1', action)).Failure, IntentFailure.ConsoleUnavailable)
        }
        finally
        {
            world.Dispose()
        }
    })

    it('without a console endpoint or a token file the console cannot be asked', async () =>
    {
        const action = new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null)
        assert.equal((await new EnvironmentIntentForwarder(undefined).Forward('in1', action)).Failure, IntentFailure.ConsoleUnavailable)
        assert.equal((await new EnvironmentIntentForwarder(ForwarderWorld.Url, '/nonexistent/token', new FakeConsole().Fetch).Forward('in1', action)).Failure, IntentFailure.ConsoleUnavailable)
    })
})
