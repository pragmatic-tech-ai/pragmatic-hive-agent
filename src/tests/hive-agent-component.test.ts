import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HiveAgentComponent } from '../hive-agent-component.js'
import { ComponentGolden } from './component-golden.js'
import { ComponentSources } from './component-sources.js'

class HiveAgentComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(HiveAgentComponentFixture.Here, 'fixtures', 'pragmatic-hive-agent.component.json')
    public static readonly Digest = 'sha256:ffa4b7783dd37bc8b0e92ef6c61bd80f482ae7d4a30ed0cd4cc73d44fd0cf30f'
    public static readonly Readers = [['..', 'agent-main.ts'], ['..', 'agent-settings.ts'], ['..', 'enrolment', 'connected-settings.ts']].map(path => join(HiveAgentComponentFixture.Here, ...path))
    /** Platform-owned: injected by the hive manifests, never tenant-configurable (the descriptor leaves them out). */
    public static readonly Undeclared: readonly string[] = [
        'PRAGMATIC_AGENT_REGISTRY_URL', 'PRAGMATIC_AGENT_HIVE_ID', 'PRAGMATIC_AGENT_TOKEN', 'PRAGMATIC_AGENT_TOKEN_FILE',
        // A connected agent's (the chart sets them, C3.3): its tenant, the release, the pinned trust root, where it runs,
        // the console that alone may call it and the engine workloads it reports on.
        'PRAGMATIC_AGENT_TENANT', 'PRAGMATIC_AGENT_ENGINE_VERSION', 'PRAGMATIC_AGENT_TRUST_ROOT_FILE', 'PRAGMATIC_AGENT_NAMESPACE',
        'PRAGMATIC_AGENT_CONSOLE_SERVICE_ACCOUNT', 'PRAGMATIC_AGENT_CONSOLE_DEPLOYMENT', 'PRAGMATIC_AGENT_IDP_NAMESPACE', 'PRAGMATIC_AGENT_IDP_DEPLOYMENT',
        'PRAGMATIC_AGENT_POSTGRES_STATEFULSET', 'PRAGMATIC_AGENT_INTERNAL_PORT',
        // A Hosted agent's (the chart sets them when the host agent places the hive, C5.1): hosted, and its relayed console.
        'PRAGMATIC_AGENT_HOSTED', 'PRAGMATIC_AGENT_CONSOLE_HOST', 'PRAGMATIC_AGENT_CONSOLE_ADDRESS',
        // Pull-only management's (the chart sets them, C3.4): the console's intent endpoint, the agent's token for it, its
        // own Deployment and how long a roll may take.
        'PRAGMATIC_AGENT_CONSOLE_INTENT_URL', 'PRAGMATIC_AGENT_CONSOLE_TOKEN_FILE', 'PRAGMATIC_AGENT_DEPLOYMENT', 'PRAGMATIC_AGENT_ROLLOUT_TIMEOUT_MS',
    ]
}

describe('HiveAgentComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(HiveAgentComponent.Descriptor(), HiveAgentComponentFixture.Golden, HiveAgentComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(HiveAgentComponent.Descriptor(), HiveAgentComponentFixture.Readers, HiveAgentComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(HiveAgentComponent.Descriptor().Name, 'pragmatic-hive-agent')
    })
})
