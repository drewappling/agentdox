#!/usr/bin/env bash
# agentdox -> Keycloak bootstrap via the Admin REST API.
# Idempotent: safe to re-run. Creates the realm, client scope + claim mapper,
# OIDC clients, and the demo user with the agentdox:scopes attribute.
#
# Usage:
#   BASE_URL=http://localhost:8080 \
#   KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=admin \
#   bash deploy/scripts/setup-keycloak.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
REALM="${AGENTDOX_REALM:-agentdox}"
ADMIN_USER="${KEYCLOAK_ADMIN:-admin}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:?set KEYCLOAK_ADMIN_PASSWORD}"
SERVER_CLIENT_SECRET="${AGENTDOX_SERVER_CLIENT_SECRET:-agentdox-server-dev-secret}"
DEMO_USER="${AGENTDOX_DEMO_USER:-drew}"
DEMO_PASS="${AGENTDOX_DEMO_PASSWORD:-demo123}"

j() { python -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }

echo "[setup] fetching admin token from master realm..."
TOKEN=$(curl -s -X POST "$BASE_URL/realms/master/protocol/openid-connect/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d "grant_type=password&client_id=admin-cli&username=$ADMIN_USER&password=$ADMIN_PASS" \
  | python -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))")
[ -n "$TOKEN" ] || { echo "ERROR: could not get admin token"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"
ADMIN="$BASE_URL/admin/realms"

mk_scope() { # $1=name, $2=scope-id flag
  local sid cur
  cur=$(curl -s -H "$AUTH" "$ADMIN/$REALM/client-scopes" | python -c "import sys,json;d=json.load(sys.stdin);print(next((s['id'] for s in d if s['name']=='$1'),''))")
  if [ -z "$cur" ]; then
    curl -s -o /dev/null -w "" -X POST -H "$AUTH" -H 'content-type: application/json' \
      -d "{\"name\":\"$1\",\"protocol\":\"openid-connect\",\"attributes\":{\"include.in.token.scope\":\"true\"}}" \
      "$ADMIN/$REALM/client-scopes"
    sid=$(curl -s -H "$AUTH" "$ADMIN/$REALM/client-scopes" | python -c "import sys,json;d=json.load(sys.stdin);print(next((s['id'] for s in d if s['name']=='$1'),''))")
  else
    sid="$cur"
  fi
  echo "$sid"
}

echo "[setup] ensuring realm '$REALM'..."
curl -s -o /dev/null -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"realm\":\"$REALM\",\"enabled\":true,\"registrationAllowed\":false,\"loginWithEmailAllowed\":true}" \
  "$BASE_URL/admin/realms"

echo "[setup] creating client scope 'agentdox' + claim mapper..."
SCOPE_ID=$(mk_scope "agentdox")
MAPPER=$(curl -s -H "$AUTH" "$ADMIN/$REALM/client-scopes/$SCOPE_ID/protocol-mappers/models" \
  | python -c "import sys,json;d=json.load(sys.stdin);print('y' if any(m.get('name')=='agentdox-scopes' for m in d) else 'n')")
if [ "$MAPPER" = "n" ]; then
  curl -s -o /dev/null -X POST -H "$AUTH" -H 'content-type: application/json' \
    -d '{"name":"agentdox-scopes","protocol":"openid-connect",
         "protocolMapper":"oidc-usermodel-attribute-mapper","consentRequired":false,
         "config":{"user.attribute":"agentdox.scopes","claim.name":"agentdox:scopes",
                   "jsonType.label":"String","id.token.claim":"true",
                   "access.token.claim":"true","userinfo.token.claim":"true"}}' \
    "$ADMIN/$REALM/client-scopes/$SCOPE_ID/protocol-mappers/models"
fi

mk_client() { # $1=clientId $2=json body
  local cid cur
  cur=$(curl -s -H "$AUTH" "$ADMIN/$REALM/clients" | python -c "import sys,json;d=json.load(sys.stdin);print(next((c['id'] for c in d if c['clientId']=='$1'),''))")
  if [ -z "$cur" ]; then
    curl -s -o /dev/null -X POST -H "$AUTH" -H 'content-type: application/json' -d "$2" "$ADMIN/$REALM/clients"
    cid=$(curl -s -H "$AUTH" "$ADMIN/$REALM/clients" | python -c "import sys,json;d=json.load(sys.stdin);print(next((c['id'] for c in d if c['clientId']=='$1'),''))")
  else
    cid="$cur"
  fi
  echo "$cid"
}

echo "[setup] creating clients..."
WEB_ID=$(mk_client "agentdox-web" "{\"clientId\":\"agentdox-web\",\"name\":\"agentdox Web UI\",\"enabled\":true,\"publicClient\":true,\"standardFlowEnabled\":true,\"directAccessGrantsEnabled\":false,\"serviceAccountsEnabled\":false,\"protocol\":\"openid-connect\",\"redirectUris\":[\"http://localhost:3003/*\",\"http://localhost:5173/*\",\"http://dox.localhost/*\"],\"webOrigins\":[\"+\"]}")
SRV_ID=$(mk_client "agentdox-server" "{\"clientId\":\"agentdox-server\",\"name\":\"agentdox API / server\",\"enabled\":true,\"publicClient\":false,\"secret\":\"$SERVER_CLIENT_SECRET\",\"standardFlowEnabled\":false,\"directAccessGrantsEnabled\":true,\"serviceAccountsEnabled\":true,\"protocol\":\"openid-connect\"}")
for CID in "$WEB_ID" "$SRV_ID"; do
  curl -s -o /dev/null -X PUT -H "$AUTH" -H 'content-type: application/json' \
    -d "[\"$SCOPE_ID\"]" "$ADMIN/$REALM/clients/$CID/default-client-scopes"
done

echo "[setup] creating demo user '$DEMO_USER'..."
cur=$(curl -s -H "$AUTH" "$ADMIN/$REALM/users?username=$DEMO_USER&exact=true" | python -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")
if [ -z "$cur" ]; then
  curl -s -o /dev/null -X POST -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"username\":\"$DEMO_USER\",\"enabled\":true,\"emailVerified\":true,\"email\":\"$DEMO_USER@example.com\",\"firstName\":\"Demo\"}" \
    "$ADMIN/$REALM/users"
  USER_ID=$(curl -s -H "$AUTH" "$ADMIN/$REALM/users?username=$DEMO_USER&exact=true" | python -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
else
  USER_ID="$cur"
fi

echo "[setup] setting '$DEMO_USER' scopes + password..."
curl -s -o /dev/null -X PUT -H "$AUTH" -H 'content-type: application/json' \
  -d '{"agentdox.scopes":["demo:write ashlands:read"]}' "$ADMIN/$REALM/users/$USER_ID"
curl -s -o /dev/null -X PUT -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"type\":\"password\",\"value\":\"$DEMO_PASS\",\"temporary\":false}" \
  "$ADMIN/$REALM/users/$USER_ID/reset-password"

echo "[setup] done. Realm '$REALM' ready."
