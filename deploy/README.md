# agentdox deployment

Docker compose stack for running agentdox with its own self-hosted OIDC IdP (Keycloak) —
for local testing on Docker Desktop, and as the GitOps target for your NAS.

```
agentdox            REST API   (auth: OIDC + PAT, scope RBAC)
keycloak            OIDC IdP   (realm `agentdox` auto-imported on first start)
caddy (optional)    ingress    (production/NAS only — TLS + public hostnames)
```

---

## 1. Local test on Docker Desktop

Prereqs: Docker Desktop running. From the repo root:

```bash
cp deploy/.env.example deploy/.env   # then edit AGENTDOX_ADMIN_TOKEN / KEYCLOAK_ADMIN_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Wait for healthy, then:

```bash
# Keycloak admin console (bootstrap creds from .env)
open http://localhost:8080       # admin / (your KEYCLOAK_ADMIN_PASSWORD)

# agentdox API
curl -s http://localhost:3003/health
# -> {"ok":true,"service":"agentdox","auth":true,"db":"/app/data/agentdox.db"}
```

> Realm import: the first Keycloak boot imports `deploy/keycloak/realm-export.json`,
> which creates client `agentdox-web`, client `agentdox-server` (secret
> `agentdox-server-dev-secret`), and demo user `drew / demo123` carrying the claim
> `agentdox:scopes = "demo:write ashlands:read"`.

### Test A — real OIDC token through agentdox (client credentials)

This validates a **real Keycloak-signed JWT** against the API's JWKS validation + scope RBAC.
Use the machine (client-credentials) flow with the service account's scopes. Must run
**inside the compose network** so the token `iss` matches the agentdox issuer
(`http://keycloak:8080/realms/agentdox`, not `localhost`):

```bash
docker cp deploy/oidc-smoke.mjs agentdox-server:/tmp/oidc-smoke.mjs
docker exec agentdox-server node /tmp/oidc-smoke.mjs
# token iss = http://keycloak:8080/realms/agentdox, agentdox:scopes = "demo:write ashlands:read"
# GET /memory?category=demo   -> 200 (write grant)
# POST /memory category=ashlands -> 403 (read-only)
# GET /memory (no token)      -> 401
```

> **Note (known quirk):** User **password grant** currently fails in the imported realm with
> `invalid_grant: "Account is not fully set up"` (`error=resolve_required_actions`,
> `userId=null`) for every user/client, even though users are enabled/verified with no
> required actions and `admin-cli` (master) works. Client-credentials works fine. The service
> account's scopes are set via the setup script. This password-grant issue is a realm-level
> Keycloak quirk still to be resolved (likely a direct-grant/realm recreation) before the
> web-UI human login can use it.

### Test B — Personal Access Tokens (no IdP needed)

```bash
ADMIN=$AGENTDOX_ADMIN_TOKEN   # from deploy/.env (bootstrapped at startup)

# mint a read-only demo token and use it
DEMO=$(curl -s -X POST -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"ci","grants":{"demo":"read"}}' http://localhost:3003/auth/tokens | python -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -H "Authorization: Bearer $DEMO" "http://localhost:3003/docs?scope=demo"   # 200
curl -s -X POST -H "Authorization: Bearer $DEMO" -H 'Content-Type: application/json' \
  -d '{"content":"x","category":"demo"}' http://localhost:3003/memory             # 403
```

---

## 2. Production / NAS (GitOps)

Two ways to run on the NAS — you likely want the reverse-proxy profile with real domains:

```bash
export DOMAIN=dox.example.com KEYCLOAK_HOSTNAME=auth.example.com
cp deploy/.env.example deploy/.env          # set AGENTDOX_OIDC_ISSUER=https://auth.example.com/realms/agentdox
docker compose -f deploy/docker-compose.yml -f deploy/compose.proxy.yml \
  --env-file deploy/.env up -d --build
```

- **Caddy** terminates TLS and routes `DOMAIN -> agentdox:3003`, `KEYCLOAK_HOSTNAME -> keycloak:8080`.
- **Keycloak** runs in production (`start --optimized`) with `KC_HOSTNAME` set so tokens carry
  the public `iss`, matching `AGENTDOX_OIDC_ISSUER`.
- Persistent data lives in named volumes (`agentdox-data`, `caddy-*`); Keycloak's own DB is its
  default dev DB — **for any real deployment, point Keycloak at an external DB** (Postgres) and
  rotate the client secrets / admin token.

### GitOps notes
- Keep code in git, and the deploy manifests under `deploy/`. The compose files are
  environment-parameterized via `deploy/.env` (never commit real `.env`; commit only
  `.env.example`).
- Recommended: a GitOps runner (Gitea Actions / Flux / ArgoCD) on the NAS issues
  `docker compose pull && docker compose up -d` on new commits/tags. Images should be built
  once and pushed to the NAS registry, then `pull`-only on the NAS.
- `deploy/Dockerfile` is multi-stage and reproducible; tag images with the commit SHA.

---

## Layout

```
deploy/
  Dockerfile            multi-stage build for the agentdox server image
  docker-compose.yml    local full-stack (agentdox + keycloak)
  compose.proxy.yml     production/NAS override (adds Caddy ingress, public hostnames)
  Caddyfile             reverse-proxy ingress config
  .env.example          environment template (copy to .env)
  keycloak/
    realm-export.json   realm `agentdox` with clients + demo user + scopes claim
  README.md             this file
```
