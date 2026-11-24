import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingType } from '@pragmatic-tech-ai/pragmatic-component'
import { existsSync } from 'node:fs'
import { AppliedConfiguration, AppliedConfigurationEntries, ComponentReadyFile, ComponentStartConfiguration, type IStartProcess } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { AgentSettings } from '../agent-settings.js'
import { HiveAgentComponent } from '../hive-agent-component.js'
import { TickLoop, type ITickDelay, type ITickTarget } from '../tick-loop.js'

class AgentStart
{
    public static Env(path: string): NodeJS.ProcessEnv
    {
        return {
            PRAGMATIC_CONFIGURATION_FILE: path,
            PRAGMATIC_AGENT_REGISTRY_URL: 'https://channel.example/',
            PRAGMATIC_AGENT_HIVE_ID: 'h1',
            PRAGMATIC_AGENT_TOKEN: 'injected-token',
            PRAGMATIC_AGENT_POLL_INTERVAL_MS: '30000',
        }
    }

    public static async InFolder(body: (folder: string) => Promise<void>): Promise<void>
    {
        const folder = await mkdtemp(join(tmpdir(), 'agent-start-'))
        try
        {
            await body(folder)
        }
        finally
        {
            await rm(folder, { recursive: true, force: true })
        }
    }

    public static async Configuration(folder: string, core: Record<string, unknown>): Promise<string>
    {
        const d = HiveAgentComponent.Descriptor()
        const path = join(folder, 'configuration.json')
        await writeFile(path, new AppliedConfiguration('acme', d.Name, 1, d.Version, d.ContentDigest(), { options: { core } } as never).ToCanonicalJson())
        return path
    }
}

class ExitRecorder implements IStartProcess
{
    public Code: number | undefined
    public readonly stderr = { write: (): boolean => true }

    public exit(code: number): never
    {
        this.Code = code
        throw new Error('exit')
    }
}

describe('the agent reads its configuration at start', () =>
{
    const Core = { pollIntervalMs: 15000, maxBackoffMs: 60000 }

    it('a mounted configuration overrides the declared variable before the settings are read', async () =>
    {
        await AgentStart.InFolder(async folder =>
        {
            const env = AgentStart.Env(await AgentStart.Configuration(folder, Core))
            await ComponentStartConfiguration.Apply({ Declaration: HiveAgentComponent.Declaration, Env: env, Stores: ComponentStartConfiguration.Stores('', folder), SecretsDir: join(folder, 'run') })
            const settings = AgentSettings.From(env)
            assert.deepEqual([settings.PollMs, settings.MaxBackoffMs], [15000, 60000])
            assert.deepEqual([settings.RegistryUrl, settings.Token], ['https://channel.example', 'injected-token'], 'the channel and the token stay the platform\'s')
        })
    })

    it('no configuration starts as before', async () =>
    {
        const env = AgentStart.Env('/no/such/configuration.json')
        assert.equal((await ComponentStartConfiguration.ApplyOrExit({ Declaration: HiveAgentComponent.Declaration, Env: env })).Applied, false)
        const settings = AgentSettings.From(env)
        assert.deepEqual([settings.Token, settings.PollMs, settings.MaxBackoffMs], ['injected-token', 30000, 300000])
    })

    it('a configuration naming the channel, the hive or the token is refused: they are not the tenant\'s to set', async () =>
    {
        await AgentStart.InFolder(async folder =>
        {
            const process = new ExitRecorder()
            const env = AgentStart.Env(await AgentStart.Configuration(folder, { ...Core, registryUrl: 'https://attacker.example/' }))
            await assert.rejects(ComponentStartConfiguration.ApplyOrExit({ Declaration: HiveAgentComponent.Declaration, Env: env }, process))
            assert.equal(process.Code, 78)
            assert.equal(env.PRAGMATIC_AGENT_REGISTRY_URL, 'https://channel.example/')
        })
    })

    it('an invalid configuration exits with the start error code 78 and the reason', async () =>
    {
        await AgentStart.InFolder(async folder =>
        {
            const process = new ExitRecorder()
            const env = AgentStart.Env(await AgentStart.Configuration(folder, { ...Core, pollIntervalMs: 'often' }))
            await assert.rejects(ComponentStartConfiguration.ApplyOrExit({ Declaration: HiveAgentComponent.Declaration, Env: env }, process))
            assert.equal(process.Code, 78)
        })
    })

    it('every list setting reads the JSON array encoding', () =>
    {
        const lists = HiveAgentComponent.Descriptor().Options.flatMap(o => o.Settings).filter(s => s.Type === SettingType.List)
        assert.deepEqual(lists, [], 'the agent declares no list setting')
    })
})

describe('the agent after a release changed its descriptor (I1) and its readiness (I5)', () =>
{
    it('reads the entry prepared for its own descriptor beside a configuration applied for the previous one', async () =>
    {
        await AgentStart.InFolder(async folder =>
        {
            const own = HiveAgentComponent.Descriptor()
            const old = new AppliedConfiguration('acme', own.Name, 1, '0.1.1', `sha256:${'1'.repeat(64)}`, { options: { core: { pollIntervalMs: 20000 } } } as never)
            const entry = new AppliedConfiguration('acme', own.Name, 2, own.Version, own.ContentDigest(), { options: { core: { pollIntervalMs: 15000 } } } as never)
            const path = join(folder, 'configuration.json')
            await writeFile(path, old.ToCanonicalJson())
            await writeFile(join(folder, AppliedConfigurationEntries.KeyOf(entry.DescriptorDigest)), entry.ToCanonicalJson())
            const env = AgentStart.Env(path)
            const process = new ExitRecorder()
            const report = await ComponentStartConfiguration.ApplyOrExit({ Declaration: HiveAgentComponent.Declaration, Env: env }, process)
            assert.equal(process.Code, undefined)
            assert.equal(report.Applied, true)
            assert.equal(AgentSettings.From(env).PollMs, 15000, 'the prepared entry, not the file of the old descriptor')
        })
    })

    it('without an entry for its descriptor, a configuration applied for another one refuses the start (78)', async () =>
    {
        await AgentStart.InFolder(async folder =>
        {
            const own = HiveAgentComponent.Descriptor()
            const path = join(folder, 'configuration.json')
            await writeFile(path, new AppliedConfiguration('acme', own.Name, 1, '0.1.1', `sha256:${'1'.repeat(64)}`, { options: { core: { pollIntervalMs: 20000 } } } as never).ToCanonicalJson())
            const process = new ExitRecorder()
            await assert.rejects(ComponentStartConfiguration.ApplyOrExit({ Declaration: HiveAgentComponent.Declaration, Env: AgentStart.Env(path) }, process))
            assert.equal(process.Code, 78)
        })
    })

    it('marks itself ready only once its settings read', async () =>
    {
        await AgentStart.InFolder(async folder =>
        {
            const ready = join(folder, 'ready')
            assert.throws(() => AgentSettings.Started({}, new ComponentReadyFile(ready)), /PRAGMATIC_AGENT_REGISTRY_URL/)
            assert.equal(existsSync(ready), false, 'a start that fails is never ready')
            AgentSettings.Started(AgentStart.Env('/none'), new ComponentReadyFile(ready))
            assert.equal(existsSync(ready), true)
        })
    })
})

/** Records the loop's waits instead of sleeping. */
class RecordedWaits implements ITickDelay
{
    public readonly Waits: number[] = []

    public Wait(ms: number): Promise<void>
    {
        this.Waits.push(ms)
        return Promise.resolve()
    }
}

/** Ticks that succeed or fail in a given order (true: succeeds), recording the backoff of each failure. */
class ScriptedTicks implements ITickTarget
{
    public Ticks = 0
    public readonly Backoffs: number[] = []

    public constructor(private readonly outcomes: boolean[] = [])
    {
    }

    public async Tick(): Promise<void>
    {
        this.Ticks++
        if (this.outcomes.shift() === false)
        {
            throw new Error('channel down')
        }
    }

    public TickFailed(_error: unknown, backoffMs: number): void
    {
        this.Backoffs.push(backoffMs)
    }
}

describe('the check-in cadence comes from the configuration (C3.1 row 7)', () =>
{
    it('a configured pollIntervalMs of 15000 is the wait after every tick of the loop the agent builds from its settings', async () =>
    {
        await AgentStart.InFolder(async folder =>
        {
            const env = AgentStart.Env(await AgentStart.Configuration(folder, { pollIntervalMs: 15000, maxBackoffMs: 60000 }))
            await ComponentStartConfiguration.Apply({ Declaration: HiveAgentComponent.Declaration, Env: env, Stores: ComponentStartConfiguration.Stores('', folder), SecretsDir: join(folder, 'run') })
            const ready = new ComponentReadyFile(join(folder, 'ready'))
            const settings = AgentSettings.Started(env, ready)
            const waits = new RecordedWaits()
            const ticks = new ScriptedTicks()
            await TickLoop.For(settings, ticks, waits).Run(4)
            assert.equal(ticks.Ticks, 4)
            assert.deepEqual(waits.Waits, [15000, 15000, 15000, 15000])
            assert.deepEqual(ticks.Backoffs, [])
        })
    })

    it('a failed tick doubles the wait up to maxBackoffMs, and the next good tick is back on the configured cadence', async () =>
    {
        const waits = new RecordedWaits()
        const ticks = new ScriptedTicks([false, false, false, true, false])
        await TickLoop.For({ PollMs: 15000, MaxBackoffMs: 50000 }, ticks, waits).Run(5)
        assert.deepEqual(waits.Waits, [30000, 50000, 50000, 15000, 30000])
        assert.deepEqual(ticks.Backoffs, [30000, 50000, 50000, 30000])
    })
})
