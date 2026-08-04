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
- **Credentials**: OIDC access token, a PAT, or the project-scoped PAT from provisioning.

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
## agentdox (shared context/memory)
- agentdox gives this repo durable memory + docs + conversation context, grouped by project.
- Your project slug is `ashlands` — ALWAYS scope writes to it (category/scope = ashlands).
- On startup, run `project_ensure` (slug `ashlands`) before doing memory/docs work.
- Memory: `memory_add` compact high-signal facts (prefer editing over adding dups).
- Docs: `docs_write`/`docs_read` versioned markdown (guides, decisions, architecture).
- Sessions: `session_start`/`session_append` record a working conversation.
- Context: `context_assemble` pulls relevant memory+docs+history into a prompt block — call it
  when you need prior decisions or constraints, don't ask the user to repeat them.
- Keep the user's stated preferences and corrections in memory so you don't re-ask.
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

1. **Scope everything.** category/scope == project slug. Never write outside your project.
2. **Memory is high-signal.** Compact, dedupe, prefer editing an existing entry to piling on.
3. **Docs are versioned.** Write decisions/architecture as markdown docs; history is preserved.
4. **Assemble on demand.** `context_assemble` replaces asking the user to repeat prior work.
