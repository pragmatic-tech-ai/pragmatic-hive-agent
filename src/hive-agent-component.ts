import { AgentInternalLink } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component'

/**
 * The component descriptor of the hive agent image (pragmatic-agentd): what `AgentSettings` reads that a tenant may
 * configure. It polls the platform's agent channel and patches the hive's deployments, stores nothing, and (installed by
 * the chart, level connected) serves the engine console's internal enrolment API on 7210 (a Hosted engine, placed by the
 * host agent, enrols itself instead and serves none). The channel, the hive, the
 * agent's bearer token, the tenant, the pinned trust root and the console's account are the platform's (the chart and
 * the hive manifests inject them): an agent pointed elsewhere would hand its token and its cluster-wide patch on
 * Deployments to whoever answers, so they are left out of the descriptor and no tenant configuration can set them.
 */
export class HiveAgentComponent
{
    public static readonly Name = 'pragmatic-hive-agent'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.9'
    private static readonly InternalPortName = 'internal'

    /** The declaration: the descriptor, and the variable the start step overlays each configured setting onto. */
    public static readonly Declaration: ComponentDeclaration = {
        name: HiveAgentComponent.Name,
        version: HiveAgentComponent.Version,
        options: [
            {
                name: 'core',
                description: 'The rollout agent of one hive.',
                settings: [
                    { name: 'pollIntervalMs', type: SettingType.Integer, source: 'PRAGMATIC_AGENT_POLL_INTERVAL_MS', default: 30000, description: 'Interval between two rollout ticks, in milliseconds.' },
                    { name: 'maxBackoffMs', type: SettingType.Integer, source: 'PRAGMATIC_AGENT_MAX_BACKOFF_MS', default: 300000, description: 'Longest wait after failed ticks, in milliseconds.' },
                ],
            },
        ],
        roles: [],
        postgres: false,
        // The cluster-internal API the engine's console calls to enrol the hive (C3.3; AgentInternalLink.Port).
        ports: [{ name: HiveAgentComponent.InternalPortName, number: AgentInternalLink.Port }],
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(HiveAgentComponent.Declaration)
    }
}
