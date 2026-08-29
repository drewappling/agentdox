# agentdox — project memory & conventions

This file is loaded by coding agents (Claude Code, Cursor, omp) as project memory.

## agentdox — shared context/memory (**MANDATORY to keep updated**)

agentdox is this repo's memory + docs + live-conversation system — and this repo *is* agentdox,
so it is dogfooding itself. The project slug is **`agentdox`** — ALWAYS scope agentdox writes to
it. `.mcp.json` uses **`AGENTDOX_TOKEN`**, one global bearer token shared by every agentdox-wired
repo; the scope comes from *this folder* (`AGENTDOX_SCOPE` in `.env.agentdox`, gitignored), not
from the token. That token grants every scope, so a wrong slug is **not** rejected — it silently
writes into another project.

Keeping agentdox current is part of completing a task, not optional. Full protocol:
`.claude/skills/agentdox/SKILL.md`.

| What | Where |
| --- | --- |
| Token + URL + scope | `.env.agentdox` in this repo root (**gitignored** — never commit it) |
| What `.mcp.json` reads | the `AGENTDOX_TOKEN` **environment variable**, not the file |
| Persisted env value | Windows **User** environment (`[Environment]::GetEnvironmentVariable('AGENTDOX_TOKEN','User')`) |
| Server | `http://localhost:3003` — Docker container `agentdox-server` |
| Admin token (to re-mint the global PAT) | `deploy/.env` |

## Build & test

`npm run build:types && npm run build:core` · `npm run seed` · `npm run dev:server` (:3003) ·
`npm run dev:web` (:5173) · `npm run mcp` (stdio). Auth suites: `npm run test:auth`,
`npm run test:server-auth`. E2E: Playwright. The local stack runs in Docker
(`deploy/docker-compose.yml`: agentdox-server :3003, Keycloak :8090).

The durable project brief (`GET /context/brief?scope=agentdox`) carries repo layout, conventions,
gotchas, and the decision log — read it on connect rather than re-deriving it here.
