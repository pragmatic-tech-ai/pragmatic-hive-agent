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
    public static readonly Digest = 'sha256:a0d2be70a51c6636e07510ad6db18799591ab07be826d35896bd6e96ec330f0c'
    public static readonly Readers = [['..', 'agent-main.ts'], ['..', 'agent-settings.ts']].map(path => join(HiveAgentComponentFixture.Here, ...path))
    /** Platform-owned: injected by the hive manifests, never tenant-configurable (the descriptor leaves them out). */
    public static readonly Undeclared: readonly string[] = ['PRAGMATIC_AGENT_REGISTRY_URL', 'PRAGMATIC_AGENT_HIVE_ID', 'PRAGMATIC_AGENT_TOKEN', 'PRAGMATIC_AGENT_TOKEN_FILE']
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
