# agentdox-pi

An [Oh My Pi](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) extension that makes
[agentdox](https://github.com/drewappling/agentdox) the coding agent's long-term memory — the same
way omp's built-in memory backends work, but backed by a shared, inspectable agentdox server.

- **Recall on session start** — assembles the project brief plus relevant memory, doc passages,
  and recent conversation for the workspace scope and injects it into the first model turn as
  background context.
- **Automatic retention** — opens an agentdox session and appends completed conversation turns to
  it, so a later session's recall can draw on this one (retrieved by relevance, not just recency).
- **Tools** — `recall` (search scoped memory), `retain` (store a durable fact), and `reflect`
  (assemble a context block to synthesize from).

It has **no runtime dependencies** — everything talks to the agentdox REST API over `fetch`, and a
server that is unreachable degrades to a no-op instead of breaking the session.

## Install

Requires a running agentdox server (see the [agentdox README](https://github.com/drewappling/agentdox)).

**Marketplace:**

```
/marketplace add drewappling/agentdox
/marketplace install agentdox-memory@agentdox
```

**Or as a plugin / local extension** — add the module path to omp's `extensions:` list:

```yaml
# ~/.omp/agent/config.yml
memory:
  backend: off            # this extension is the memory layer
extensions:
  - /path/to/agentdox/packages/pi-extension/src/index.ts
```

Run it with omp's native `memory.backend: off` — this extension provides the memory behavior and
the `recall`/`retain`/`reflect` tools itself.

## Configuration

Config is read from the environment, then a `.env.agentdox` file at the workspace root, then
defaults — the same convention agentdox uses elsewhere. The environment wins.

| Key | Default | Purpose |
| --- | --- | --- |
| `AGENTDOX_URL` | `http://localhost:3003` | agentdox server base URL |
| `AGENTDOX_TOKEN` | — | Bearer token (omit when the server runs with auth off) |
| `AGENTDOX_SCOPE` | folder-derived slug | Project scope for recall/retain |
| `AGENTDOX_MEMORY_AUTORECALL` | `true` | Recall + inject context on session start |
| `AGENTDOX_MEMORY_AUTORETAIN` | `true` | Retain conversation turns into an agentdox session |
| `AGENTDOX_MEMORY_RETAIN_EVERY_TURNS` | `3` | Minimum turns between retain flushes |
| `AGENTDOX_MEMORY_RECALL_LIMIT` | `8` | Max memory entries pulled into recall |
| `AGENTDOX_MEMORY_INJECT_TOKENS` | `5000` | Approx token budget for the injected block |

When `AGENTDOX_SCOPE` is unset it is derived from the workspace folder name (lowercased, slugified),
matching the agentdox skill's scope resolution.

## Commands

- `/agentdox` — show status (URL, scope, auth, reachability, recall/retain state).
- `/agentdox sync` — flush retained conversation turns to the agentdox session now.

## Scoping

Memory is per-project: everything is keyed by the resolved scope. Only the main interactive session
runs the recall/retain loop; subagents skip it to avoid duplication, but their `recall`/`retain`/
`reflect` tools still operate against the same store.

## License

[MIT](../../LICENSE)
