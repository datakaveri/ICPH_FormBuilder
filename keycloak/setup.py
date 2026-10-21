#!/usr/bin/env python3
"""
ICPH Form Builder bootstrap for a local Keycloak (stdlib only, runs in python:3.12-alpine).

Creates:
  realm   icph (login theme: icph)
    - realm roles  icph-admin, icph-field-agent
                   (carried in the standard realm_access.roles claim)
    - client       icph-form-builder (public SPA, Authorization Code + PKCE,
                   offline_access scope for offline sign-in)
    - users        admin      -> icph-admin
                   fieldagent -> icph-field-agent
Safe to re-run (409 Conflict is treated as 'already exists').

This is a local development setup: the default passwords are not secrets.
"""
import json, os, sys, time, urllib.parse, urllib.request, urllib.error

KC = os.environ.get("KC_URL", "http://keycloak:8080").rstrip("/")
PUB = os.environ.get("KC_PUBLIC_URL", "http://localhost:8080").rstrip("/")
KC_ADMIN = os.environ.get("KC_ADMIN_USERNAME", "admin")
KC_ADMIN_PW = os.environ.get("KC_ADMIN_PASSWORD", "password")
REALM = os.environ.get("KC_REALM", "icph")
CLIENT_ID = os.environ.get("KC_CLIENT_ID", "icph-form-builder")
LOGIN_THEME = os.environ.get("KC_LOGIN_THEME", "icph")  # keycloak/themes/icph
# Browser-visible origins of the form builder, comma separated.
APP_URLS = [u.strip().rstrip("/") for u in os.environ.get("APP_URLS", "http://localhost:5173").split(",") if u.strip()]
ADMIN_ROLE, FIELD_AGENT_ROLE = "icph-admin", "icph-field-agent"
ROLES = [(ADMIN_ROLE, "Builds, publishes and reviews forms"),
         (FIELD_AGENT_ROLE, "Collects and reviews entries for published forms")]
# (username, password, first name, last name, role)
USERS = [(os.environ.get("APP_ADMIN_USERNAME", "admin"), os.environ.get("APP_ADMIN_PASSWORD", "password"),
          "ICPH", "Admin", ADMIN_ROLE),
         (os.environ.get("APP_FIELD_AGENT_USERNAME", "fieldagent"), os.environ.get("APP_FIELD_AGENT_PASSWORD", "password"),
          "Field", "Agent", FIELD_AGENT_ROLE)]

def http(method, url, body=None, ctype="application/json", token=None, ok=(200, 201, 204, 409)):
    data = None
    if body is not None:
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", ctype)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        if e.code in ok:
            return e.code, raw
        print(f"!! {method} {url} -> {e.code}: {raw[:500]}", flush=True)
        raise

def wait_for_kc():
    for _ in range(120):
        try:
            s, _ = http("GET", f"{KC}/realms/master/.well-known/openid-configuration")
            if s == 200:
                print("Keycloak is up.", flush=True)
                return
        except Exception:
            pass
        time.sleep(2)
    sys.exit("Keycloak did not come up in time")

def get_token():
    body = urllib.parse.urlencode({"grant_type": "password", "client_id": "admin-cli",
                                   "username": KC_ADMIN, "password": KC_ADMIN_PW})
    s, raw = http("POST", f"{KC}/realms/master/protocol/openid-connect/token",
                  body, "application/x-www-form-urlencoded")
    return json.loads(raw)["access_token"]

TOKEN = None
def api(method, path, body=None, ok=(200, 201, 204, 409)):
    return http(method, f"{KC}/admin{path}", body, "application/json", TOKEN, ok)

def jget(path):
    s, raw = api("GET", path)
    return json.loads(raw) if raw else None

def step(msg):
    print(f"--> {msg}", flush=True)

# --------------------------------------------------------------------------
wait_for_kc()
TOKEN = get_token()

# 1. realm -------------------------------------------------------------------
step(f"realm {REALM}")
api("POST", "/realms", {
    "realm": REALM, "enabled": True, "displayName": "ICPH Form Builder",
    "accessTokenLifespan": 300,
    # A working day, so a field agent who goes offline can resume without a new login.
    "ssoSessionIdleTimeout": 43200, "ssoSessionMaxLifespan": 43200,
})
# Applied separately so an existing realm picks these up too.
api("PUT", f"/realms/{REALM}", {
    "realm": REALM, "loginTheme": LOGIN_THEME,
    # The app asks for offline_access: its refresh token survives the browser
    # session, for 30 days without use and 60 days at most before a new login.
    "offlineSessionIdleTimeout": 30 * 86400,
    "offlineSessionMaxLifespanEnabled": True, "offlineSessionMaxLifespan": 60 * 86400,
})

# 2. roles (standard realm_access.roles claim, no custom mappers) ------------
step(f"realm roles {', '.join(r[0] for r in ROLES)}")
for name, description in ROLES:
    api("POST", f"/realms/{REALM}/roles", {"name": name, "description": description})

# 3. client ------------------------------------------------------------------
step(f"client {CLIENT_ID} (public SPA) for {', '.join(APP_URLS)}")
client = {
    "clientId": CLIENT_ID, "name": "ICPH Form Builder", "protocol": "openid-connect",
    "publicClient": True, "standardFlowEnabled": True, "directAccessGrantsEnabled": False,
    "rootUrl": APP_URLS[0], "baseUrl": "/",
    "redirectUris": [f"{u}/*" for u in APP_URLS],
    "webOrigins": APP_URLS,
    "attributes": {"pkce.code.challenge.method": "S256",
                   "post.logout.redirect.uris": "##".join(f"{u}/*" for u in APP_URLS)},
}
api("POST", f"/realms/{REALM}/clients", client)
existing = jget(f"/realms/{REALM}/clients?clientId={CLIENT_ID}")[0]
# Re-apply so a changed APP_URLS takes effect on an existing realm.
api("PUT", f"/realms/{REALM}/clients/{existing['id']}", {**existing, **client})
# The app requests the offline_access scope; Keycloak refuses it unless the
# client offers it (users get the offline_access role through default roles).
offline_scope = next(s for s in jget(f"/realms/{REALM}/client-scopes") if s["name"] == "offline_access")
api("PUT", f"/realms/{REALM}/clients/{existing['id']}/optional-client-scopes/{offline_scope['id']}")

# 4. users -------------------------------------------------------------------
for username, password, first, last, role_name in USERS:
    step(f"user {username} -> {role_name}")
    api("POST", f"/realms/{REALM}/users", {
        "username": username, "email": f"{username}@icph.local", "emailVerified": True,
        "firstName": first, "lastName": last, "enabled": True,
        "credentials": [{"type": "password", "value": password, "temporary": False}],
    })
    uid = jget(f"/realms/{REALM}/users?username={urllib.parse.quote(username)}&exact=true")[0]["id"]
    role = jget(f"/realms/{REALM}/roles/{role_name}")
    api("POST", f"/realms/{REALM}/users/{uid}/role-mappings/realm", [role])

print("\n=== ICPH Keycloak bootstrap complete ===", flush=True)
print(f"Keycloak console : {PUB}  ({KC_ADMIN} / {KC_ADMIN_PW})", flush=True)
print(f"Realm            : {REALM}  (issuer {PUB}/realms/{REALM})", flush=True)
for username, password, _first, _last, role_name in USERS:
    print(f"App user         : {username} / {password}  [{role_name}]", flush=True)
