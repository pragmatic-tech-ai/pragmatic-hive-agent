import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { Components } from '../src/release-components.js'
import { ComponentGolden } from '../src/tests/component-golden.js'

/** The descriptor the image carries, pinned to pragmatic-server's golden (admin/control-plane/descriptors/digests.json). */
class DescriptorGoldenFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly App = ReleaseApp.HiveAgent
    public static readonly Golden = join(DescriptorGoldenFixture.Here, '..', 'src', 'tests', 'fixtures', 'pragmatic-hive-agent.component.json')
    /** pragmatic-server@2a2e8138's pin for pragmatic-hive-agent. */
    public static readonly PinnedDigest = 'sha256:8a59fe48b0e4d9f3fe7445a637d176d31a2b2009822de18dc1f17d4227267eff'
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
