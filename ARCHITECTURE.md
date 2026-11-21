# pragmatic-hive-agent architecture

| File | Role |
|---|---|
| `src/bin/pragmatic-agentd.ts` | The entry: imports `agent-main`. |
| `src/agent-main.ts` | `AgentMain`: reads the environment, wires the agent and runs the poll loop (doubling backoff on failed ticks, capped). |
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
