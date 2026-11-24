import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConsoleAddressOption, SigningKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { ConnectedSettingError, ConnectedSettings } from '../connected-settings.js'

class SettingsWorld
{
    public static Env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv
    {
        const folder = mkdtempSync(join(tmpdir(), 'connected-settings-'))
        const root = join(folder, 'platform.pub.pem')
        writeFileSync(root, SigningKeyPair.Generate().PublicKey.ToPem())
        return {
            PRAGMATIC_AGENT_REGISTRY_URL: 'https://agent.pragmatic-tech.ai',
            PRAGMATIC_AGENT_TENANT: 'acme',
            PRAGMATIC_AGENT_ENGINE_VERSION: '0.1.0-early.20',
            PRAGMATIC_AGENT_TRUST_ROOT_FILE: root,
            PRAGMATIC_AGENT_CONSOLE_SERVICE_ACCOUNT: 'pragmatic-tenant-admin-acme',
            PRAGMATIC_AGENT_CONSOLE_DEPLOYMENT: 'pragmatic-tenant-admin-acme',
            PRAGMATIC_AGENT_IDP_NAMESPACE: 'pragmatic-idp-acme',
            PRAGMATIC_AGENT_IDP_DEPLOYMENT: 'pragmatic-idp-acme',
            PRAGMATIC_AGENT_POSTGRES_STATEFULSET: 'pragmatic-postgres',
            ...extra,
        }
    }
}

describe('ConnectedSettings', () =>
{
    it('a connected (not hosted) engine names no hosted console', () =>
    {
        assert.equal(ConnectedSettings.From(SettingsWorld.Env()).HostedConsole, undefined)
        assert.equal(ConnectedSettings.From(SettingsWorld.Env({ PRAGMATIC_AGENT_HOSTED: 'false' })).HostedConsole, undefined)
    })

    it('a hosted engine reads its relayed console address', () =>
    {
        const settings = ConnectedSettings.From(SettingsWorld.Env({ PRAGMATIC_AGENT_HOSTED: 'true', PRAGMATIC_AGENT_CONSOLE_HOST: 'acme-k3xq.hives.pragmatic-tech.ai', PRAGMATIC_AGENT_CONSOLE_ADDRESS: 'relayed-hive-subdomain' }))
        assert.equal(settings.HostedConsole?.Option, ConsoleAddressOption.RelayedHiveSubdomain)
        assert.equal(settings.HostedConsole?.HostName, 'acme-k3xq.hives.pragmatic-tech.ai')
    })

    it('a hosted engine without a relayed hive subdomain, or with an odd hosted flag, is refused by setting name', () =>
    {
        const refuses = (extra: NodeJS.ProcessEnv, setting: string): void =>
        {
            assert.throws(() => ConnectedSettings.From(SettingsWorld.Env(extra)), (error: unknown) => error instanceof ConnectedSettingError && error.message.startsWith(setting))
        }
        refuses({ PRAGMATIC_AGENT_HOSTED: 'yes' }, 'PRAGMATIC_AGENT_HOSTED')
        refuses({ PRAGMATIC_AGENT_HOSTED: 'true', PRAGMATIC_AGENT_CONSOLE_HOST: 'acme-k3xq.hives.pragmatic-tech.ai' }, 'PRAGMATIC_AGENT_CONSOLE_ADDRESS')
        refuses({ PRAGMATIC_AGENT_HOSTED: 'true', PRAGMATIC_AGENT_CONSOLE_ADDRESS: 'relayed-hive-subdomain' }, 'PRAGMATIC_AGENT_CONSOLE_HOST')
        refuses({ PRAGMATIC_AGENT_HOSTED: 'true', PRAGMATIC_AGENT_CONSOLE_HOST: 'console.acme.example', PRAGMATIC_AGENT_CONSOLE_ADDRESS: 'own-domain' }, 'PRAGMATIC_AGENT_CONSOLE_ADDRESS')
        refuses({ PRAGMATIC_AGENT_HOSTED: 'true', PRAGMATIC_AGENT_CONSOLE_HOST: 'console.acme.example', PRAGMATIC_AGENT_CONSOLE_ADDRESS: 'relayed-hive-subdomain' }, 'PRAGMATIC_AGENT_CONSOLE_HOST')
    })
})
