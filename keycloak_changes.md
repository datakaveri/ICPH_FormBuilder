# Keycloak changes for offline sign-in

The form builder now asks Keycloak for an **offline token** (the
`offline_access` scope) when a user signs in. An offline token outlives the
browser session, so a field agent stays signed in across reloads, hard
reloads and days without a connection.

For a local setup, `keycloak/setup.py` makes all of these changes; re-run it
with `docker compose run --rm keycloak-setup`. For any other Keycloak, make
them by hand in the `icph` realm. Check that the realm picker at the top left
of the admin console shows `icph`, not `master`.

## Required before deploying the new app version

### 1. Offer the `offline_access` scope on the client

**Clients → `icph-form-builder` → Client scopes tab**

- `offline_access` must be listed with assigned type **Optional**.
- If it is missing: **Add client scope → `offline_access` → Add → Optional**.

Without this, every sign-in fails, because the app always requests the scope.
New clients get it by default, so it is usually already there.

### 2. Give users the `offline_access` role

**Realm roles → `default-roles-icph` → Associated roles tab**

- `offline_access` must be in the list. It is there by default.

Optional: to allow offline sign-in for field agents only, remove
`offline_access` from `default-roles-icph` and add it under
**Realm roles → `icph-field-agent` → Associated roles**. Keycloak refuses
offline tokens to users without the role, so after moving it, check that an
admin can still sign in.

## Session lifetimes

**Realm settings → Sessions tab → "Offline session settings"**

| Setting | Value | Keycloak default |
|---|---|---|
| Offline Session Idle | 30 days | 30 days |
| Offline Session Max Limited | On | Off |
| Offline Session Max | 60 days | 60 days (applies only when the setting above is on) |

- **Offline Session Idle** is how long an offline token lasts unused. It must
  be longer than the app's `OFFLINE_SIGN_IN_DAYS` (see below).
- **Offline Session Max** forces a fresh password sign-in after 60 days,
  however often the app is used.

## Verify only (no change)

**Realm settings → Tokens tab → "Refresh tokens" section**

- **Revoke Refresh Token** must be **Off**, the default. When it is on, each
  refresh token works only once. Two tabs refreshing at the same moment, or a
  refresh reply lost on a poor connection, then signs the user out.
- If security policy requires it on, set **Refresh Token Max Reuse** to 1 or
  more.

**Clients → `icph-form-builder` → Settings → Web origins**

- Must list the app's origins (the same as `ICPH_APP_URLS`). This was already
  so. The app's sign-out now calls Keycloak's token revocation endpoint from
  the browser, and Keycloak allows that only from these origins.

## Unchanged

These realm settings are as before:

- Access token lifespan: 5 minutes.
- SSO Session Idle and SSO Session Max: 12 hours.

## Related app setting

The API reads `OFFLINE_SIGN_IN_DAYS` (default `7`, set in
`k8s/api/icph-form-builder-api.yaml`). It is not a Keycloak setting. Offline,
the app accepts a stored sign-in for this many days after Keycloak last
confirmed it, then locks until the device reconnects. Keep it below Offline
Session Idle.

## After the change

- **Existing sessions:** users who are already signed in keep their old,
  session-bound token until they next sign in. They get an offline token then.
- **Ending a user's offline sign-in:** **Users → the user → Sessions tab**
  lists offline sessions; sign them out there. Signing out in the app also
  revokes the offline token. If the user signs out while offline, the token
  is revoked the next time the app starts online.
- **Rolling back:** deploy the previous app version, which does not request
  `offline_access`. The Keycloak settings above can stay as they are; they
  have no effect on clients that do not request offline tokens.
