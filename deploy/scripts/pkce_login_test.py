import base64, hashlib, os, re, urllib.parse, urllib.request
import http.cookiejar

BASE = "http://localhost:8090/realms/agentdox"
REDIRECT = "http://localhost:5173/"
CLIENT = "agentdox-web"

# PKCE
verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()

cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
auth_url = (f"{BASE}/protocol/openid-connect/auth?response_type=code&client_id={CLIENT}"
            f"&redirect_uri={urllib.parse.quote(REDIRECT, safe='')}&scope=openid%20agentdox"
            f"&code_challenge={challenge}&code_challenge_method=S256&state=agentdox")
html = op.open(auth_url).read().decode()
if "invalid_scope" in html:
    print("FAIL: invalid_scope still present"); raise SystemExit(1)

# parse login form
m = re.search(r'action="([^"]+)"', html)
if not m: print("FAIL: no login form (maybe already redirected?)"); raise SystemExit(1)
action = m.group(1).replace("&amp;", "&")
# hidden inputs (execution / session_code)
hiddens = {h: v for h, v in re.findall(r'name="([^"]+)"\s+value="([^"]*)"', html)}
hiddens["username"] = "alice"
hiddens["password"] = "demo123"
data = urllib.parse.urlencode(hiddens).encode()
req = urllib.request.Request(action, data=data)
resp = op.open(req)  # follows nothing; returns the redirect (or login page on failure)
loc = resp.geturl()
if "code=" not in loc:
    print("FAIL: login did not yield a code ->", loc[:120]); raise SystemExit(1)
code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)["code"][0]
print("got authorization code -> exchanging")
tok = urllib.parse.urlencode({
    "grant_type": "authorization_code", "client_id": CLIENT, "code": code,
    "redirect_uri": REDIRECT, "code_verifier": verifier}).encode()
tr = urllib.request.urlopen(urllib.request.Request(f"{BASE}/protocol/openid-connect/token", data=tok))
j = json = __import__("json").loads(tr.read())
import base64 as b64, json as _json
if "access_token" not in j:
    print("FAIL: token exchange:", j); raise SystemExit(1)
p = _json.loads(b64.urlsafe_b64decode(j["access_token"].split(".")[1] + "=="))
print("SUCCESS: browser PKCE login works")
print("  iss    =", p.get("iss"))
print("  scopes =", p.get("agentdox:scopes"))
