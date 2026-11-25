import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { Components } from '../src/release-components.js'
import { ComponentGolden } from '../src/tests/component-golden.js'

/** The descriptor the image carries, pinned (it moves with the declaration and the package version). */
class DescriptorGoldenFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly App = ReleaseApp.HiveAgent
    public static readonly Golden = join(DescriptorGoldenFixture.Here, '..', 'src', 'tests', 'fixtures', 'pragmatic-hive-agent.component.json')
    /** The same pin as src/tests/hive-agent-component.test.ts. */
    public static readonly PinnedDigest = 'sha256:33490daf623cc2b3bbd034287341d735ad4e83a79185610adb7c37e71f27a120'
    public static readonly PackageJson = join(DescriptorGoldenFixture.Here, '..', 'package.json')
    public static readonly Utf8 = 'utf8'

    public static PackageVersion(): string
    {
        return (JSON.parse(readFileSync(DescriptorGoldenFixture.PackageJson, DescriptorGoldenFixture.Utf8)) as { version: string }).version
    }
}

describe('release component descriptor', () =>
{
    const F = DescriptorGoldenFixture

    it('the descriptor the release module emits has exactly the pragmatic-server golden digest', () =>
    {
        ComponentGolden.Check(Components.Of(F.App), F.Golden, F.PinnedDigest)
    })

    it('the release module lists this one app', () =>
    {
        assert.deepEqual(Components.All().map(([app, descriptor]) => [app, descriptor.ContentDigest()]), [[F.App, F.PinnedDigest]])
    })

    it('the descriptor version is the package version', () =>
    {
        assert.equal(Components.Of(F.App).Version, F.PackageVersion())
    })
})
