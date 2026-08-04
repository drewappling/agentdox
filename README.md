# agentdox

An **open-source, dynamic context, memory, and documentation framework for AI agents.**

Today, an agent's memory and documentation are scattered: a few lines in a system prompt,
a markdown file nobody reads, a chat log that gets truncated. `agentdox` makes memory,
docs, and context **first-class, queryable, and assembled on demand** — so agents stop
forgetting and stop carrying dead weight in every prompt.

## Core ideas

- **Memory** — durable facts, stored as small entries with categories/targets, retrieved
  by relevance or keyword. Compact, high-signal, evictable.
- **Docs** — versioned markdown documentation that agents can read, write, and search.
- **Context** — the *assembled* slice of memory + docs + relevant entries computed for a
  given agent/task at request time. Dynamic = built when asked, not pre-baked.
- **Sessions** — the running history a context assembly can draw on.

Everything is exposed three ways:
1. **REST API** — the spine, for the web UI and any HTTP client.
2. **MCP server** — a Model Context Protocol server so any MCP-capable agent (Claude,
   etc.) reads/writes memory and assembles context through standard tools.
3. **Web UI** — browse, edit, and inspect memory, docs, and assembled context visually.

## Repo layout

```
packages/
  types/   @agentdox/types   shared TypeScript types (domain model)
  core/    @agentdox/core    storage (SQLite) + memory/doc/context/session services
  server/  @agentdox/server  Fastify REST API
  sdk/     @agentdox/sdk     typed TypeScript client
  mcp/     @agentdox/mcp     MCP server (stdio)
  web/     @agentdox/web     Svelte 5 + Vite web app
```

## Getting started

```bash
npm install
npm run build:types && npm run build:core
npm run seed          # create an empty DB + demo data
npm run dev:server    # REST API on :3003
npm run dev:web       # web UI on :5173
npm run mcp           # MCP server (stdio)
```

## Authentication (OIDC)

agentdox is **IdP-agnostic — bring your own OpenID Connect provider** (Keycloak, Authentik,
Zitadel, Okta, Auth0, Entra ID…). Human login uses Authorization-Code + PKCE; machines use
client-credentials or **Personal Access Tokens**; scope `read`/`write`/`admin` RBAC is enforced
per project namespace. Full design & roadmap: [`docs/architecture/authentication.md`](docs/architecture/authentication.md).

Auth is **off by default** (local single-user). Enable + bootstrap an admin token:

```bash
AGENTDOX_AUTH_ENABLED=true \
AGENTDOX_ADMIN_TOKEN=<your-first-admin-token> \
npm run dev:server
```

Run the auth test suites: `npm run test:auth` and `npm run test:server-auth`.

## Status

Early scaffold — see [IDEA.md](./IDEA.md) for the original motivation.
