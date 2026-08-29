# Wiring a coding agent to agentdox

agentdox is designed to be adopted by whatever coding agent you use (Claude Code, Cursor,
any MCP client, Hermes, …). This guide shows the canonical wiring: **provision a project,
then use memory / docs / sessions / context scoped to it.** The pattern is identical across
agents — only the glue file differs.

## How it fits together

- A **Project** is a workspace whose `slug` *is* the scope namespace. Memory, docs, and
  sessions keyed by that scope belong to the project.
- Agents **provision themselves**: on connect, call `project_ensure {slug, name}`. The first
  claim of a new project returns a scoped PAT (`{slug}:admin`, shown once) to use as the
  bearer credential. Re-`ensure` is idempotent (returns the project, no new token).
- Three surfaces, all backed by the same store:
  - **MCP** (stdio) — embeds agentdox directly against the SQLite file. Easiest for Claude/Cursor.
  - **REST + SDK** — `@agentdox/sdk` (`client.projects/memory/docs/sessions/context`).
  - **REST + HTTP** — curl / any language, with `Authorization: Bearer <pat>`.
- **Credentials**: OIDC access token, a PAT (scoped per project, or one wildcard token shared
  across every project — see below), or the project-scoped PAT returned by provisioning.

## Provision the project

```bash
# REST
curl -X POST http://localhost:3003/projects \
  -H "Authorization: Bearer $AGENTDOX_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slug":"ashlands","name":"Ashlands"}'
# -> { "project": {...}, "token": "<scoped-pat-shown-once>", "expiresAt": ... }

# SDK
const client = new AgentDoxClient('http://localhost:3003', undefined, token);
const { project, token: projectPat } = await client.projects.ensure({ slug: 'ashlands', name: 'Ashlands' });

# MCP
#  project_ensure { "slug": "ashlands", "name": "Ashlands" }
```

## Retrieval, in one paragraph

Search is hybrid: BM25 over FTS5 fused with vector similarity, over **passages** of documents
rather than whole files. Two things follow for an agent. `docs_passages` (MCP) /
`GET /docs/passages` (REST) gives back the section that matched, which is almost always what you
want over `docs_search`; and if results look thin, `index_stats` / `GET /index/stats` tells you
whether the scope is actually indexed and whether the embedding provider is reachable, rather
than leaving you to guess. Embeddings are optional — unset, retrieval is lexical-only and still
works. See [`architecture/rag.md`](architecture/rag.md).

## MCP config (Claude Code / Cursor)

**HTTP transport (recommended)** — the agent talks to the running agentdox REST API over HTTP,
so it shares the **same live store** as the web UI, with scope RBAC enforced from the bearer token.
Put this in the agent repo's `.mcp.json`:

```json
{
  "mcpServers": {
    "agentdox": {
      "type": "http",
      "url": "http://localhost:3003/mcp",
      "headers": { "Authorization": "Bearer ${AGENTDOX_PROJECT_TOKEN}" }
    }
  }
}
```

Set `AGENTDOX_PROJECT_TOKEN` in the agent's environment to a token that grants **write/admin on
your project scope** (get one from the web UI's Projects view, or `POST /projects` provisioning,
or mint a PAT via the admin API). `${VAR}` is substituted from the env by Claude Code and Cursor.

### One token across every project (single-operator setups)

Per-project tokens mean a fresh mint *and* a fresh environment variable for every repo you add.
If one person owns every project, mint **one wildcard PAT** instead and let the *project folder*
supply the scope:

```bash
curl -X POST http://localhost:3003/auth/tokens   -H "Authorization: Bearer $AGENTDOX_ADMIN_TOKEN"   -H 'content-type: application/json'   -d '{"name":"global-agent","grants":{"*":"admin"}}'
```

`.mcp.json` then becomes **identical in every repo** (`Bearer ${AGENTDOX_TOKEN}`, with
`AGENTDOX_TOKEN` set once in the user environment), and the only per-repo file is
`.env.agentdox`:

```ini
AGENTDOX_URL=http://localhost:3003
AGENTDOX_SCOPE=ashlands          # the one value derived from this project folder
AGENTDOX_TOKEN=<the global pat>
```

Adding a project is then: make the folder, set `AGENTDOX_SCOPE`, call `project_ensure`. No new
credential, no shell restart.

Know what you trade away:

- **`{"*":"admin"}` is instance admin, not just data access.** The `adminOnly` guard keys off
  `grants['*'] === 'admin'`, so this token can also mint and revoke tokens and delete any
  project. Fine for a single local operator; do not use it multi-tenant, and never hand it to a
  third-party agent.
- **Scope mistakes stop being caught.** A scoped token answers 403 when an agent writes another
  project's slug; a wildcard token accepts it silently and files the data in the wrong
  namespace. Scope discipline moves entirely into the agent's protocol.
- **`write` is not sufficient.** `PATCH`/`DELETE` on memory, docs, and sessions require `admin`
  *on the scope*, so a `{"*":"write"}` token cannot update the entries it just created.

**stdio (local-only, separate store):** a local MCP server that embeds agentdox directly against a
host SQLite file. It is *not* shared with a Docker-hosted web UI:

```json
{
  "mcpServers": {
    "agentdox": {
      "command": "node",
      "args": ["E:/projects/agentdox/packages/mcp/dist/cli.js"],
      "env": { "AGENTDOX_DB": "E:/projects/agentdox/data/agentdox.db" }
    }
  }
}
```

> **Shared store:** do **not** bind-mount the SQLite file to the host and open it from two OSes —
> Windows host + Linux container writers on one WAL file corrupt it (`database disk image is
> malformed`). Keep the server's DB in its volume and use the **HTTP transport** above for agents;
> that is how agents and the web UI share one store, safely.

## CLAUDE.md snippet (drop into the agent's project-root memory file)

```markdown
## agentdox (shared context/memory — MANDATORY to keep updated)
- agentdox is this repo's memory + docs system; your project slug is `ashlands` (scope writes to it).
- Keeping agentdox current is part of completing any task, not optional. Before finishing a task,
  make sure the memory and docs you touched are up to date and nothing is stale.
- On startup, run `project_ensure` (slug `ashlands`) before doing memory/docs work.
- **Onboard on connect:** read `context_brief` (scope = project slug) when first starting — it holds the
  project's historic on-ramp (overview, repo layout & tooling, code style, build/test, asset
  conventions, gotchas, decision log). Don't rediscover what's already recorded.
- **Record decisions as they're made:** append decisions & conventions via `context_brief_record`
  (title, decision, rationale) so the brief accumulates the project's real history for the next agent.
- Memory: `memory_add`/**`memory_update`** compact high-signal facts; when a fact changes, update the
  existing entry (never leave stale/contradictory facts). Record user preferences/corrections.
- Docs: `docs_write`/**`docs_update`** — keep architecture, decisions, conventions current as reality
  changes; writing once is not enough.
- Sessions: `session_start`/`session_append` — start a session per topic and append each
  message **in real time** as it happens (not a batch summary), so live history feeds context.
- Context: **must** `context_assemble` (with a query) before re-asking the user about anything
  already in memory/docs/history.
```

## SDK quick reference

```ts
import { AgentDoxClient } from '@agentdox/sdk';

const client = new AgentDoxClient('http://localhost:3003', undefined, process.env.AGENTDOX_TOKEN);

await client.projects.ensure({ slug: 'ashlands', name: 'Ashlands' });
await client.memory.create({ content: 'player digs in 3/4 top-down, hard edges', category: 'ashlands', importance: 0.9 });
const docs = await client.docs.list({ scope: 'ashlands' });
const ctx = await client.context.assemble({ scope: 'ashlands', query: 'movement rules' });
const s = await client.sessions.create({ scope: 'ashlands', title: 'movement fix' });
await client.sessions.append(s.id, { role: 'assistant', content: '…' });
```

## Principles

1. **Keep it current (mandatory).** Updating memory and docs is part of completing any task.
   Refresh facts when they change; don't leave stale or contradictory entries. "Written once" is
   not "up to date."
2. **Scope everything.** category/scope == project slug. Never write outside your project.
3. **Memory is high-signal.** Compact, dedupe, edit the existing entry rather than piling on.
4. **Docs are versioned and maintained.** Write decisions/architecture as markdown and update them
   as reality changes; history is preserved automatically.
5. **Assemble on demand.** `context_assemble` (with a query) replaces asking the user to repeat
   prior work.
