# agentdox

An **open-source, dynamic context, memory, and documentation framework for AI agents.**

Today an agent's memory and documentation are scattered: a few lines in a system prompt, a
markdown file nobody reads, a chat log that gets truncated. `agentdox` makes memory, docs, and
context **first-class, queryable, and assembled on demand** — so agents stop forgetting and stop
carrying dead weight in every prompt.

It runs as a small service backed by a single SQLite file, and exposes everything three ways: a
**REST API**, an **MCP server** (stdio *and* streamable HTTP), and a **Svelte web UI** — all over
one store, with per-project scoping and optional OIDC auth.

---

## Table of contents

- [Concepts](#concepts)
- [Features](#features)
- [Repo layout](#repo-layout)
- [Quick start (local, no auth)](#quick-start-local-no-auth)
- [Authentication & key generation](#authentication--key-generation)
- [Wiring a coding agent (MCP + skill)](#wiring-a-coding-agent-mcp--skill)
- [Oh My Pi memory backend](#oh-my-pi-memory-backend)
- [Retrieval & embeddings](#retrieval--embeddings)
- [The auto-model-router integration](#the-auto-model-router-integration)
- [Docker deployment](#docker-deployment)
- [Configuration reference](#configuration-reference)
- [API & tool surface](#api--tool-surface)
- [Testing](#testing)
- [License](#license)

---

## Concepts

- **Project** — a workspace whose `slug` **is** the scope namespace. Everything else is keyed by
  it. Agents provision their own project on connect (`project_ensure`), which is idempotent.
- **Memory** — durable, compact facts stored as small entries with a `category` (== scope), an
  optional `target`, `tags`, and an `importance` (0..1) that nudges ranking and eviction.
- **Docs** — versioned markdown documentation agents can read, write, search, and diff. Every
  save snapshots the previous revision (`GET /docs/:id/history`).
- **Sessions** — running conversation history. Assembled context draws on it, and older messages
  are *retrieved by relevance*, not just replayed by recency.
- **Context** — the **assembled** slice of memory + doc passages + relevant session messages,
  computed for a scope/query at request time. Dynamic = built when asked, not pre-baked.
- **Project brief** — a durable, cumulative on-ramp per scope (overview, repo layout, code style,
  build/test, conventions, gotchas, and an append-only decision log).

## Features

- **Hybrid retrieval, no vector database.** BM25 over SQLite FTS5 fused by reciprocal rank with
  cosine similarity over embeddings. Docs are chunked on markdown headings, so retrieval and
  assembly operate on **passages**, not whole files. Embeddings are optional and off by default.
  See [`docs/architecture/rag.md`](docs/architecture/rag.md).
- **Self-healing index.** Writes index themselves synchronously; the lexical index rebuilds on
  open if it finds content it doesn't cover (restored backup, direct SQLite import); vectors are
  backfilled by a background job so a stopped model server never blocks a write.
- **Per-scope RBAC.** `read` / `write` / `admin` roles per project namespace, plus a wildcard
  `*` grant. Enforced identically across REST and MCP.
- **Bring-your-own OIDC.** IdP-agnostic (Keycloak, Authentik, Zitadel, Okta, Auth0, Entra ID…).
  Humans log in with Authorization-Code + PKCE; machines use **Personal Access Tokens** or OIDC
  client credentials. See [`docs/architecture/authentication.md`](docs/architecture/authentication.md).
- **Three surfaces, one store.** REST API, MCP server (stdio for local single-user, streamable
  **HTTP** for a shared authenticated store), Svelte 5 web UI, and a typed TypeScript SDK.
- **Assembled context on a schedule.** An optional background job reassembles and persists a
  per-scope context baseline (`context_snapshots`); the web UI shows it and can refresh on demand.
- **Durable per-project brief** with an append-only decision log, editable in the UI and writable
  by agents.
- **Multi-tenancy roadmap.** Tenants above projects, deep-linkable routes, quotas — designed in
  [`docs/architecture/multi-tenancy.md`](docs/architecture/multi-tenancy.md).

## Repo layout

```
packages/
  types/   @agentdox/types   shared TypeScript types (domain model)
  core/    @agentdox/core    storage (SQLite) + memory/doc/context/session services + retrieval
  auth/    @agentdox/auth    OIDC + PAT verifiers, scope-grant RBAC
  server/  @agentdox/server  Fastify REST API (+ MCP-over-HTTP mount)
  sdk/     @agentdox/sdk     typed TypeScript client
  mcp/     @agentdox/mcp     MCP server (stdio cli + guarded factory)
  web/     @agentdox/web     Svelte 5 + Vite web app
  pi-extension/  agentdox-pi   Oh My Pi memory-backend extension (recall/retain/reflect)
docs/architecture/           design docs (rag, authentication, multi-tenancy)
deploy/                       Docker Compose stack (agentdox + Keycloak + Caddy)
```

Requires **Node >= 20** (uses the built-in `node:sqlite`). npm workspaces monorepo.

## Quick start (local, no auth)

Auth is **off by default** — a single local user with full access, no tokens needed.

```bash
npm install
npm run build:types && npm run build:core
npm run seed          # create data/agentdox.db + a little demo data

npm run dev:server    # REST API on http://localhost:3003
npm run dev:web       # web UI  on http://localhost:5173  (proxies /api -> :3003)
npm run mcp           # MCP server over stdio (embeds the local SQLite store)
```

The store is one SQLite file at `data/agentdox.db` (WAL mode). That's the whole database.

## Authentication & key generation

Enable bearer-token auth and bootstrap the first admin key:

```bash
# generate a strong admin token
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

AGENTDOX_AUTH_ENABLED=true \
AGENTDOX_ADMIN_TOKEN=<that-token> \
npm run dev:server
```

`AGENTDOX_ADMIN_TOKEN` is seeded once as a wildcard-admin PAT (`{"*":"admin"}`) so you can mint
everything else through the API. Keys come in three flavours:

1. **Bootstrap admin PAT** — the env token above. Use it only to mint scoped tokens.
2. **Scoped PATs** — minted by an admin, granting specific roles per scope (token shown once):

   ```bash
   curl -X POST http://localhost:3003/auth/tokens \
     -H "Authorization: Bearer $AGENTDOX_ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"name":"acme-agent","grants":{"acme":"admin"},"ttlMs":7776000000}'
   # -> { "id": "pat_…", "token": "<shown once>", "expiresAt": … }
   ```

   PATs are stored **SHA-256-hashed** (never in plaintext); revoke with
   `DELETE /auth/tokens/:id`, list with `GET /auth/tokens` (both admin-only).
3. **Project provisioning tokens** — `POST /projects` / `project_ensure` on a *new* slug returns a
   scoped `{slug}:admin` PAT (shown once), so an agent can bootstrap its own project workspace.

For **human login**, point agentdox at any OIDC issuer and map a space-delimited grant claim
(default claim `agentdox:scopes`, e.g. `acme:write demo:read`) onto scope roles. The
[Docker stack](#docker-deployment) provisions a ready-to-use Keycloak realm for this.

## Wiring a coding agent (MCP + skill)

Any MCP-capable agent (Claude Code, Cursor, Hermes, omp, …) talks to agentdox through standard
tools. Full guide: [`docs/agent-integration.md`](docs/agent-integration.md).

**1. MCP config** — put a `.mcp.json` at the agent repo root. The **HTTP transport** shares the
same live store as the web UI, with RBAC from the bearer token:

```json
{
  "mcpServers": {
    "agentdox": {
      "type": "http",
      "url": "http://localhost:3003/mcp",
      "headers": { "Authorization": "Bearer ${AGENTDOX_TOKEN}" }
    }
  }
}
```

Each bearer token gets one authenticated MCP session, bound to its principal. Prefer this when
the web UI and agents must see the same data. For a **local single-user** setup with no server,
use the **stdio** transport instead — it embeds agentdox directly against the SQLite file:

```json
{
  "mcpServers": {
    "agentdox": { "command": "node", "args": ["/abs/path/to/agentdox/packages/mcp/dist/cli.js"] }
  }
}
```

(Build first with `npm run build`; the same entry runs via `npm run mcp` or the `agentdox-mcp` bin.)

**2. Per-repo config** — `.env.agentdox` (gitignore it) carries the one project-specific value,
the scope, plus the shared endpoint/token:

```ini
AGENTDOX_URL=http://localhost:3003
AGENTDOX_SCOPE=acme            # the project slug for THIS repo
AGENTDOX_TOKEN=<bearer token>  # never commit; substituted into ${AGENTDOX_TOKEN} above
```

The scope is derived from the **folder**, not the token — one token can cover many projects, so
the slug is what keeps each repo's data separate.

**3. Skill loading** — the canonical interaction protocol ships as an agent **skill** at
[`.claude/skills/agentdox/SKILL.md`](.claude/skills/agentdox/SKILL.md): resolve the scope, read
the brief on connect, assemble context before asking the user anything, append sessions live, and
update memory/docs/brief before finishing. Harnesses discover **project-relative** skills, so copy
that file into each participating repo's `.claude/skills/agentdox/SKILL.md`. Claude Code also
finds a user-level copy at `~/.claude/skills/agentdox/SKILL.md`.

> MCP config is read once at harness startup, and `${VAR}` is expanded from the launching shell's
> environment — set `AGENTDOX_TOKEN` before starting the harness (or restart it), otherwise the
> tools resolve an empty token and calls 401.

## Oh My Pi memory backend

Beyond the MCP tools above, agentdox ships a first-class **[Oh My Pi](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) memory backend** as an extension ([`packages/pi-extension`](packages/pi-extension), published as `agentdox-pi`). It plugs agentdox into omp's session lifecycle so the agent uses it *without manual tool calls*:

- **Recall on session start** — injects the project brief plus relevant memory, doc passages, and recent conversation for the workspace scope into the first model turn as background context.
- **Automatic retention** — opens an agentdox session and appends completed turns, so a later session's recall can draw on this one by relevance.
- **`recall` / `retain` / `reflect` tools** — mirroring the ecosystem's memory tools, over the shared store.

Install from the marketplace and run with omp's native backend off:

```
/marketplace add drewappling/agentdox
/marketplace install agentdox-memory@agentdox
```

```yaml
# ~/.omp/agent/config.yml
memory:
  backend: off            # this extension is the memory layer
```

Config reuses agentdox's `.env.agentdox` convention (`AGENTDOX_URL`, `AGENTDOX_TOKEN`, `AGENTDOX_SCOPE`); scope defaults to the workspace folder slug. Unlike the local/file backends, this is a **shared, inspectable** store — the same data the web UI and other agents see. Full details: [`packages/pi-extension/README.md`](packages/pi-extension/README.md).

## Retrieval & embeddings

Search is hybrid and works with **no configuration** (lexical-only). To add the semantic arm,
point it at an embedding provider — `ollama` (local, free, private) or any OpenAI-compatible API:

```bash
AGENTDOX_EMBED_PROVIDER=ollama          # ollama | openai | none (default)
AGENTDOX_EMBED_MODEL=nomic-embed-text   # 768 dims; task prefixes applied per model family
AGENTDOX_EMBED_URL=http://localhost:11434
# AGENTDOX_EMBED_API_KEY=...            # openai-compatible providers only
```

Over a ten-query benchmark, vectors scored MRR 1.000 on natural-language questions but 0.529 on
exact identifiers (`OrderService.submit`); BM25 scored 0.800 and 0.600; fused, 0.825 and 0.800 —
each arm covering what the other fumbles. A provider that is down degrades to lexical-only and is
never an error. `GET /index/stats?scope=…` reports coverage and provider reachability;
`POST /index/rebuild` forces a full pass. Design and measurements:
[`docs/architecture/rag.md`](docs/architecture/rag.md).

## The auto-model-router integration

agentdox is the **shared memory and context backend** for
[**auto-model-router**](https://github.com/drewappling/auto-model-router) — a router that swaps the
underlying model per request for cost/capability. Model switches are where context normally dies:
each model starts blank. The router closes that gap by treating agentdox as the durable context
layer:

- **On a model switch**, the router calls `context_assemble {scope, query}` (MCP) /
  `POST /context/assemble` (REST) and injects the returned block — memory + doc passages + relevant
  session history — so the incoming model resumes with the same working context the previous one had.
- **Transcripts flow back** as agentdox **sessions** (`session_start` / `session_append`),
  model-attributed, so later assemblies can retrieve what any model said — by relevance, across the
  whole conversation, not just the recent tail.
- **Both share one store over HTTP.** The router and the web UI hit the same `/mcp` and REST
  endpoints with scoped bearer tokens, so what an agent writes is immediately visible to humans and
  to the next model.

Because assembly is scope-namespaced and RBAC-guarded, a single agentdox instance backs many
router-driven projects at once without cross-contamination. See the router repo for its side of the
bridge; the agentdox surfaces it depends on are `context_assemble`, the `session_*` tools, and the
`context_brief*` family.

## Docker deployment

`deploy/` contains a Compose stack: the agentdox server, a Keycloak IdP with a provisioned realm
(OIDC clients, a scope-claim mapper, a demo user), and an optional Caddy reverse proxy.

```bash
cd deploy
cp .env.example .env          # set AGENTDOX_ADMIN_TOKEN and secrets — do NOT ship the defaults
docker compose up -d
bash scripts/setup-keycloak.sh   # provision the realm/clients/user (idempotent)
```

The server listens on `:3003` and Keycloak on `:8090` by default. See
[`deploy/README.md`](deploy/README.md) for the proxy/NAS profile and the realm details. The DB
lives in an isolated named volume on purpose — do not bind-mount the SQLite file and share it with
host processes; use the REST/MCP HTTP transport for cross-process sharing.

## Configuration reference

Server (`packages/server`, read from the environment):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTDOX_PORT` | `3003` | REST API port |
| `AGENTDOX_AUTH_ENABLED` | `false` | Enforce bearer-token auth (else local single-user) |
| `AGENTDOX_ADMIN_TOKEN` | — | Bootstrap wildcard-admin PAT, seeded on start |
| `AGENTDOX_CORS_ORIGINS` | reflect any (dev) | Comma-separated allowlist for shared deployments |
| `AGENTDOX_OIDC_ISSUER` | — | OIDC issuer URL (enables the OIDC verifier) |
| `AGENTDOX_OIDC_DISCOVERY_URL` | issuer | Override discovery base (internal vs public URL) |
| `AGENTDOX_OIDC_JWKS_URI` | from discovery | Explicit JWKS URI (skips discovery) |
| `AGENTDOX_OIDC_AUDIENCE` | — | Required token audience, if set |
| `AGENTDOX_OIDC_SCOPE_CLAIM` | `agentdox:scopes` | Claim carrying `scope:role` grants |
| `AGENTDOX_CONTEXT_INTERVAL_SECONDS` | `900` | Auto-context baseline refresh cadence (`0` disables) |
| `AGENTDOX_CONTEXT_MAX_SCOPES` | `50` | Max scopes the scheduler refreshes per tick |
| `AGENTDOX_INDEX_AUTOBUILD` | `true` | Rebuild the lexical index on open when it's behind |
| `AGENTDOX_EMBED_PROVIDER` | `none` | `none` \| `ollama` \| `openai` |
| `AGENTDOX_EMBED_MODEL` | `nomic-embed-text` | Embedding model (`text-embedding-3-small` for openai) |
| `AGENTDOX_EMBED_DIMS` | `768` (`1536` openai) | Vector dimensions |
| `AGENTDOX_EMBED_URL` | provider default | Embedding endpoint base URL |
| `AGENTDOX_EMBED_API_KEY` | — | API key for openai-compatible providers |

Web (`packages/web`, Vite build/dev env): `VITE_API` (defaults to the `/api` dev proxy, or
same-origin in a production build), `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID` (`agentdox-web`).

## API & tool surface

**REST** (`packages/server`): `/health`; `/auth/tokens` (GET/POST/DELETE, admin);
`/index/{stats,rebuild}`; `/projects` (GET/POST, `/:slug` GET/DELETE); `/memory` (GET/POST,
`/search`, `/:id` GET/PATCH/DELETE); `/docs` (GET/POST, `/search`, `/passages`, `/slug/:slug`,
`/:id` GET/PATCH/DELETE, `/:id/history`); `/sessions` (GET/POST, `/:id` GET, `/:id/messages`,
`/:id/end`, DELETE); `/context/{assemble,snapshot,refresh}` and `/context/brief`
(GET/PUT, `/decision`, `/seed`); `/mcp` (streamable MCP transport).

**MCP tools** (`packages/mcp`, 20): `project_ensure`, `project_list`; `memory_add`,
`memory_search`, `memory_list`, `memory_update`, `memory_remove`; `docs_write`, `docs_read`,
`docs_search`, `docs_passages`, `docs_update`; `index_stats`, `index_rebuild`; `session_start`,
`session_append`; `context_assemble`, `context_brief`, `context_brief_record`,
`context_brief_seed`.

**SDK** (`packages/sdk`): `new AgentDoxClient(baseUrl, fetch?, token?)` with
`.projects`, `.memory`, `.docs`, `.sessions`, `.context`, `.index` mirroring the REST surface.

## Testing

```bash
npm run typecheck          # all workspaces
npm run test:auth          # OIDC/PAT/RBAC unit checks
npm run test:server-auth   # end-to-end HTTP auth + cross-scope isolation
npm run test:retrieval     # ranking regression fixture (vector checks skip with no provider)
```

End-to-end web tests use Playwright (`e2e/`); credentials and the IdP host are environment-overridable
(`E2E_USER`, `E2E_PASS`, `E2E_KEYCLOAK_HOST`).

## License

[MIT](LICENSE) © 2026 Drew Appling.
