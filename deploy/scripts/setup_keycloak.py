#!/usr/bin/env python3
"""Idempotent agentdox -> Keycloak realm bootstrap via the Admin REST API.

Creates/updates, not deletes:
  - realm agentdox
  - client scope 'agentdox' + 'agentdox-scopes' user-attribute claim mapper
  - clients agentdox-web (public) and agentdox-server (confidential, direct-grant + service account)
  - service-account scopes and demo user drew with agentdox:scopes + password

Env: BASE_URL, KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD, AGENTDOX_REALM,
     AGENTDOX_SERVER_CLIENT_SECRET, AGENTDOX_DEMO_PASSWORD
"""
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("BASE_URL", "http://localhost:8080").rstrip("/")
REALM = os.environ.get("AGENTDOX_REALM", "agentdox")
ADMIN = os.environ.get("KEYCLOAK_ADMIN", "admin")
ADMIN_PASS = os.environ["KEYCLOAK_ADMIN_PASSWORD"]
SRV_SECRET = os.environ.get("AGENTDOX_SERVER_CLIENT_SECRET", "agentdox-server-dev-secret")
DEMO_USER = os.environ.get("AGENTDOX_DEMO_USER", "drew")
DEMO_PASS = os.environ.get("AGENTDOX_DEMO_PASSWORD", "demo123")


def req(method, path, body=None, token=None, expect=(200, 201, 204)):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw.decode(errors="replace")
        return e.code, parsed


def token():
    body = urllib.parse.urlencode({
        "grant_type": "password", "client_id": "admin-cli",
        "username": ADMIN, "password": ADMIN_PASS,
    }).encode()
    r = urllib.request.Request(BASE + "/realms/master/protocol/openid-connect/token",
                               data=body, method="POST",
                               headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(r) as resp:
        return json.load(resp)["access_token"]


def find(path, key, value):
    _, arr = req("GET", path, token=TOK)
    if isinstance(arr, list):
        return next((x for x in arr if isinstance(x, dict) and x.get(key) == value), None)
    return None


MAPPER = {
    "name": "agentdox-scopes", "protocol": "openid-connect",
    "protocolMapper": "oidc-usermodel-attribute-mapper", "consentRequired": False,
    "config": {
        "user.attribute": "agentdox.scopes", "claim.name": "agentdox:scopes",
        "jsonType.label": "String", "id.token.claim": "true",
        "access.token.claim": "true", "userinfo.token.claim": "true",
    },
}

TOK = token()
A = f"/admin/realms/{REALM}"

# realm
_, realm = req("GET", A, token=TOK, expect=(200, 404))
if realm is None:
    req("POST", "/admin/realms", {"realm": REALM, "enabled": True,
                                  "registrationAllowed": False, "loginWithEmailAllowed": True}, token=TOK)
    print("[setup] realm created")
# allow arbitrary custom attributes (Keycloak 26 user-profile)
_, realm = req("GET", A, token=TOK)
attrs = realm.get("attributes") or {}
attrs["unmanagedAttributePolicy"] = "ENABLED"
realm["attributes"] = attrs
req("PUT", A, realm, token=TOK)

# client scope + mapper
scope = find(A + "/client-scopes", "name", "agentdox")
if scope is None:
    req("POST", A + "/client-scopes", {"name": "agentdox", "protocol": "openid-connect",
                                       "attributes": {"include.in.token.scope": "true"}}, token=TOK)
    scope = find(A + "/client-scopes", "name", "agentdox")
print("[setup] client scope agentdox =", scope["id"] if isinstance(scope, dict) else scope)
if not find(A + f"/client-scopes/{scope['id']}/protocol-mappers/models", "name", "agentdox-scopes"):
    req("POST", A + f"/client-scopes/{scope['id']}/protocol-mappers/models", MAPPER, token=TOK)

# Declare agentdox.scopes in the user profile so the custom attribute persists
# (Keycloak 26 drops undeclared custom attributes otherwise).
_, profile = req("GET", A + "/users/profile", token=TOK, expect=(200, 404))
profile = profile if isinstance(profile, dict) else {}
profile.setdefault("attributes", [])
if not any(a.get("name") == "agentdox.scopes" for a in profile["attributes"]):
    profile["attributes"].append({
        "name": "agentdox.scopes", "displayName": "agentdox scopes",
        "permissions": {"view": ["admin", "user"], "edit": ["admin", "user"]},
    })
    req("PUT", A + "/users/profile", profile, token=TOK)
    print("[setup] declared agentdox.scopes in user profile")

def ensure_client(name, body):
    c = find(A + "/clients", "clientId", name)
    if c is None:
        req("POST", A + "/clients", body, token=TOK)
        c = find(A + "/clients", "clientId", name)
    # ensure the mapper is on the client directly (belt + suspenders)
    if not find(A + f"/clients/{c['id']}/protocol-mappers/models", "name", "agentdox-scopes"):
        req("POST", A + f"/clients/{c['id']}/protocol-mappers/models", MAPPER, token=TOK)
    return c

web = ensure_client("agentdox-web", {
    "clientId": "agentdox-web", "enabled": True, "publicClient": True,
    "standardFlowEnabled": True, "directAccessGrantsEnabled": False,
    "serviceAccountsEnabled": False, "protocol": "openid-connect",
    "redirectUris": ["http://localhost:3003/*", "http://localhost:5173/*"],
    "webOrigins": ["+"]})
srv = ensure_client("agentdox-server", {
    "clientId": "agentdox-server", "enabled": True, "publicClient": False,
    "secret": SRV_SECRET, "standardFlowEnabled": False,
    "directAccessGrantsEnabled": True, "serviceAccountsEnabled": True,
    "protocol": "openid-connect"})
print("[setup] clients:", web["clientId"], "(", web["id"], "),", srv["clientId"])

# service-account scopes
_, sa = req("GET", A + f"/clients/{srv['id']}/service-account-user", token=TOK)
sa_body = dict(sa)
sa_attrs = dict(sa.get("attributes") or {})
sa_attrs["agentdox.scopes"] = ["demo:write ashlands:read"]
sa_body["attributes"] = sa_attrs
req("PUT", A + f"/users/{sa['id']}", sa_body, token=TOK)
print("[setup] service-account scopes set")

# demo user
user = find(A + f"/users?username={DEMO_USER}&exact=true", "username", DEMO_USER)
if user is None:
    req("POST", A + "/users", {"username": DEMO_USER, "enabled": True, "emailVerified": True,
                               "email": f"{DEMO_USER}@example.com",
                               "firstName": DEMO_USER.title(), "lastName": "User"}, token=TOK)
    user = find(A + f"/users?username={DEMO_USER}&exact=true", "username", DEMO_USER)
uid = user["id"]
u = req("GET", A + f"/users/{uid}", token=TOK)[1]
u["attributes"] = dict(u.get("attributes") or {})
u["attributes"]["agentdox.scopes"] = ["demo:write ashlands:read"]
req("PUT", A + f"/users/{uid}", u, token=TOK)
req("PUT", A + f"/users/{uid}/reset-password",
    {"type": "password", "value": DEMO_PASS, "temporary": False}, token=TOK)
print("[setup] demo user", DEMO_USER, "= ready")
print("[setup] done")
