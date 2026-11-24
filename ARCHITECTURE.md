# pragmatic-hive-agent architecture

| File | Role |
|---|---|
| `src/bin/pragmatic-agentd.ts` | The entry: `AgentCommand.Run(argv)`. |
| `src/agent-command.ts` | `AgentCommand`: no argument runs the rollout agent; `preflight` runs the engine install's checks and exits 0/1. |
| `src/agent-main.ts` | `AgentMain`: reads the environment, waits idle while not enrolled (`AgentEnrolment`), wires the agent and runs the poll loop (doubling backoff on failed ticks, capped). |
| `src/agent-enrolment.ts` | `AgentEnrolment`: whether the hive is enrolled (its channel token present); an unenrolled agent (chart level `connected`) waits ready and idle, re-reading the token file each poll. |
| `src/preflight/` | The engine chart's preflight hook (`pragmatic-agentd preflight`, C3.2): `Preflight` runs every `IPreflightCheck` (`cluster-version` ≥ 1.30, `storage-class`, `ingress-class`, `dns-name` (console, sign-in service, the environments' wildcard), `tls`, `engine-identity` (a kept engine keeps its ids), `workload-identity-issuer` (azure or aws realm secrets: the cluster's service-account issuer is publicly fetchable, 2.5)) even after a failure; `PreflightSettings` reads the chart's `PRAGMATIC_PREFLIGHT_*`; `PreflightCli` prints one line per check with its fix and exits 1 on any Fail. |
| `src/rollout-agent.ts` | `RolloutAgent.Tick`: fetch the target, list the environments, patch the obsolete ones, report the snapshot. |
| `src/agent-wiring.ts` | `AgentWiring`: the channel URLs, the label selector, deployment to environment state. |
| `src/k8s-api.ts` | `InClusterK8sApi`: lists and patches deployments through `pragmatic-kube`'s `KubeHttpsTransport` (service account). |
| `src/bounded-fetch.ts` | `BoundedFetch`: a fetch and its body read under one timeout. |
| `src/hive-agent-component.ts` | `HiveAgentComponent`: the component descriptor (no port, no storage). |
| `src/release-components.ts` | `Components`: the descriptor source the image build reads (`pragmatic-component-descriptors --components dist/release-components.js`). |
| `closure.json` | What the image copies; `pragmatic-closure-check` keeps it, the Dockerfile and the code in step. |

Tests: `src/tests` (the agent, its wiring, the Kubernetes calls, the bounded fetch, the descriptor golden and its
readers), `tests/` (the release module's descriptor equals the pragmatic-server golden digest; no TODL, Mural or
todl-runtime dependency).
