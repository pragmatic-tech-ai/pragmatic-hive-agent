# pragmatic-hive-agent

The hive agent (`pragmatic-agentd`, image `ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent`). It runs inside a hive's
cluster, polls the platform agent channel for the hive's rollout target, patches the environment server deployments it
labels to the target images, and reports a snapshot back. It listens on no port and stores nothing.

Split out of pragmatic-server (seed commit `chore: seed from pragmatic-server@2a2e8138`); image name, environment
variables and component descriptor are unchanged. It stays dependency-light: node built-ins, `pragmatic-kube`,
`pragmatic-observability` and `pragmatic-component`; no TODL, Mural or todl-runtime (`tests/package-deps.test.ts`).

## Configuration

`PRAGMATIC_AGENT_REGISTRY_URL`, `PRAGMATIC_AGENT_HIVE_ID`, `PRAGMATIC_AGENT_TOKEN` (required);
`PRAGMATIC_AGENT_POLL_INTERVAL_MS` (default 30000), `PRAGMATIC_AGENT_MAX_BACKOFF_MS` (default 300000). The Kubernetes
API is reached through the pod's service account.

At start the mounted `pragmatic-config-pragmatic-hive-agent` (the tenant admin console's applied configuration) is laid
over these variables; one the agent cannot start with exits 78 with the reason. Only the poll timing is configurable
there: the channel, the hive and the token are the platform's (`PRAGMATIC_AGENT_TOKEN_FILE` names the token's file when
it is mounted rather than injected).

## Development

Packages come from GitHub Packages (`@pragmatic-tech-ai` scope, `.npmrc` reads the token from `NODE_AUTH_TOKEN`).

    npm ci
    npm run build
    npm test
    npm run typecheck
    npx pragmatic-closure-check

The image is built from `Dockerfile` with `docker-bake.hcl` in two steps (the header of either file shows the commands).
CI and the image release (tag `v<version>`, equal to `package.json`'s version) run pragmatic-shared's reusable container
workflows. The build files are rendered by `pragmatic-container-template` (`@pragmatic-tech-ai/pragmatic-release-toolkit`):

    npx pragmatic-container-template render --app pragmatic-hive-agent --entry src/bin/pragmatic-agentd.ts --out .
