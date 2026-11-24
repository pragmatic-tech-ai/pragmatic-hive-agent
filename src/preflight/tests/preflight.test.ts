import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Preflight } from '../preflight.js'
import { PreflightCli, type IPreflightOutput } from '../preflight-cli.js'
import { PreflightOutcome, PreflightResults, type IPreflightCheck, type PreflightResult } from '../preflight-check.js'
import { ConsoleAddress, PreflightSettings, TlsMode } from '../preflight-settings.js'
import type { IHostResolver } from '../dns-name-check.js'
import { ClusterFixtures, FakeKubeTransport } from './fake-kube.js'

class RecordingOutput implements IPreflightOutput
{
    public readonly Lines: string[] = []

    public Line(text: string): void
    {
        this.Lines.push(text)
    }
}

class FixedResolver implements IHostResolver
{
    public constructor(private readonly known: readonly string[])
    {
    }

    public Resolves(host: string): Promise<boolean>
    {
        return Promise.resolve(this.known.includes(host))
    }
}

class FixedCheck implements IPreflightCheck
{
    public constructor(public readonly Name: string, private readonly result: PreflightResult | Error)
    {
    }

    public Run(): Promise<PreflightResult>
    {
        return this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result)
    }
}

class PreflightFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly CertPem = readFileSync(join(PreflightFixture.Here, 'fixtures', 'console.crt.pem'))
    public static readonly Hosts = ['console.example.com', 'idp-console.example.com', 'pragmatic-preflight-probe.example.com']

    public static Env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv
    {
        return {
            PRAGMATIC_PREFLIGHT_NAMESPACE: 'pragmatic-system',
            PRAGMATIC_PREFLIGHT_CONSOLE_HOST: 'console.example.com',
            PRAGMATIC_PREFLIGHT_IDP_HOST: 'idp-console.example.com',
            PRAGMATIC_PREFLIGHT_BASE_DOMAIN: 'example.com',
            PRAGMATIC_PREFLIGHT_TENANT_ID: 'acme',
            PRAGMATIC_PREFLIGHT_HIVE_ID: 'acme-hive',
            PRAGMATIC_PREFLIGHT_CONSOLE_ADDRESS: 'own-domain',
            PRAGMATIC_PREFLIGHT_TLS_MODE: 'secret',
            PRAGMATIC_PREFLIGHT_TLS_SECRET: 'console-tls',
            ...overrides,
        }
    }

    /** A conformant cluster: 1.30, a default StorageClass, a default ingress-nginx class and the console's TLS Secret. */
    public static Cluster(overrides: Record<string, unknown> = {}): Record<string, unknown>
    {
        return {
            [ClusterFixtures.VersionPath]: ClusterFixtures.Version('1', '30'),
            [ClusterFixtures.StorageClasses]: ClusterFixtures.StorageList({ name: 'standard', default: true }),
            [ClusterFixtures.IngressClasses]: ClusterFixtures.IngressList({ name: 'nginx', default: true }),
            '/api/v1/namespaces/pragmatic-system/secrets/console-tls': {
                data: { 'tls.crt': PreflightFixture.CertPem.toString('base64'), 'tls.key': Buffer.from('key').toString('base64') },
            },
            ...overrides,
        }
    }
}

describe('Preflight', () =>
{
    it('Run reports every check even after a failure', async () =>
    {
        const results = await new Preflight([
            new FixedCheck('first', PreflightResults.Fail('first', 'broken', 'fix it')),
            new FixedCheck('second', new Error('API refused')),
            new FixedCheck('third', PreflightResults.Pass('third', 'fine')),
        ]).Run()
        assert.deepEqual(results.map(r => [r.Check, r.Outcome]), [['first', PreflightOutcome.Fail], ['second', PreflightOutcome.Fail], ['third', PreflightOutcome.Pass]])
        assert.match(results[1].Message, /API refused/)
        assert.notEqual(results[1].Fix, '')
    })
})

describe('PreflightCli', () =>
{
    it('passes on a conformant cluster and exits 0', async () =>
    {
        const output = new RecordingOutput()
        const code = await PreflightCli.Run(PreflightFixture.Env(), output, new FakeKubeTransport(PreflightFixture.Cluster()), new FixedResolver(PreflightFixture.Hosts))
        assert.equal(code, 0, output.Lines.join('\n'))
        for (const name of ['cluster-version', 'storage-class', 'ingress-class', 'dns-name', 'tls', 'engine-identity'])
        {
            assert.ok(output.Lines.some(line => line.startsWith('pass') && line.includes(' ' + name + ': ')), name)
        }
        assert.match(output.Lines.at(-1) ?? '', /preflight passed/)
    })

    it('the CLI exits 1 on any Fail and prints each check name', async () =>
    {
        const output = new RecordingOutput()
        const cluster = PreflightFixture.Cluster({ [ClusterFixtures.StorageClasses]: ClusterFixtures.StorageList({ name: 'standard' }) })
        const code = await PreflightCli.Run(PreflightFixture.Env(), output, new FakeKubeTransport(cluster), new FixedResolver(PreflightFixture.Hosts))
        assert.equal(code, 1)
        for (const name of ['cluster-version', 'storage-class', 'ingress-class', 'dns-name', 'tls'])
        {
            assert.ok(output.Lines.some(line => line.includes(' ' + name + ': ')), name)
        }
        const failed = output.Lines.findIndex(line => line.startsWith('fail') && line.includes('storage-class'))
        assert.ok(failed >= 0)
        assert.match(output.Lines[failed + 1], /^ {2}fix: .*is-default-class/)
        assert.match(output.Lines.at(-1) ?? '', /1 check\(s\) failed; nothing was installed/)
    })

    it('refuses unknown settings and a run outside a cluster', async () =>
    {
        const bad = new RecordingOutput()
        assert.equal(await PreflightCli.Run(PreflightFixture.Env({ PRAGMATIC_PREFLIGHT_TLS_MODE: 'acme' }), bad, new FakeKubeTransport({})), 1)
        assert.match(bad.Lines[0], /PRAGMATIC_PREFLIGHT_TLS_MODE has an unknown value: acme/)
        const outside = new RecordingOutput()
        assert.equal(await PreflightCli.Run(PreflightFixture.Env({ KUBERNETES_SERVICE_HOST: '' }), outside), 1)
        assert.match(outside.Lines[0], /no in-cluster service account/)
    })
})

describe('PreflightSettings', () =>
{
    it('reads the chart variables, defaulting the address and TLS mode', () =>
    {
        const settings = PreflightSettings.From({ PRAGMATIC_PREFLIGHT_NAMESPACE: 'ns', PRAGMATIC_PREFLIGHT_CONSOLE_HOST: 'c.example.com' })
        assert.equal(settings.Address, ConsoleAddress.OwnDomain)
        assert.equal(settings.Tls, TlsMode.Secret)
        assert.deepEqual(settings.Hosts, ['c.example.com'])
        const full = PreflightSettings.From({ PRAGMATIC_PREFLIGHT_NAMESPACE: 'ns', PRAGMATIC_PREFLIGHT_CONSOLE_HOST: 'c.example.com', PRAGMATIC_PREFLIGHT_IDP_HOST: 'idp-t.example.com', PRAGMATIC_PREFLIGHT_BASE_DOMAIN: 'example.com' })
        assert.deepEqual(full.Hosts, ['c.example.com', 'idp-t.example.com', 'pragmatic-preflight-probe.example.com'], 'environments stand for themselves by a probe name')
        assert.throws(() => PreflightSettings.From({ PRAGMATIC_PREFLIGHT_NAMESPACE: 'ns' }), /PRAGMATIC_PREFLIGHT_CONSOLE_HOST/)
    })
})
