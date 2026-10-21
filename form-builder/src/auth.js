import { decodeJwt } from "jose";
import Keycloak from "keycloak-js";
import { isOnline, onConnectivityChange } from "./connectivity.js";

export const ADMIN_ROLE = "icph-admin";
export const FIELD_AGENT_ROLE = "icph-field-agent";

const TOKENS_KEY = "icph_auth_tokens";
const CONFIG_KEY = "icph_auth_config";
// A refresh token from a sign-out made offline, revoked on the next online start.
const REVOKE_KEY = "icph_auth_pending_revoke";
const DAY_MS = 24 * 60 * 60 * 1000;
// Keycloak's requests have no timeout of their own. On a connection that hangs,
// stop waiting on them after this long and carry on with the login there is.
const KEYCLOAK_WAIT_MS = 3000;
let apiBase = "";
let keycloak = null;
let authConfig = null;
let initPromise = null;
let keycloakStarted = null;
// The saved login, used as-is while Keycloak has not been started.
let savedLogin = null;

function readStored(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
  } catch {}
}

function withinKeycloakWait(promise, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), KEYCLOAK_WAIT_MS))]);
}

function decodeToken(token) {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}

// Tokens are kept in localStorage so every tab shares one login and a field
// agent who reopens the app offline still reaches their saved forms.
function persistTokens() {
  writeStored(TOKENS_KEY, keycloak?.token
    ? { token: keycloak.token, refreshToken: keycloak.refreshToken, idToken: keycloak.idToken }
    : null);
}

// The saved login stands in until Keycloak has finished starting; after that
// only Keycloak's answer counts, including a login it rejected.
function currentToken() {
  return keycloak?.token || savedLogin?.token;
}

async function fetchAuthConfig() {
  const response = await fetch(`${apiBase}/api/auth/config`);
  if (!response.ok) throw new Error("Login configuration is unavailable.");
  const { url, realm, clientId, offlineSignInDays } = await response.json();
  writeStored(CONFIG_KEY, { url, realm, clientId, offlineSignInDays });
  return { url, realm, clientId, offlineSignInDays };
}

// The saved settings are used at once and refreshed for the next start.
async function loadAuthConfig() {
  const cached = readStored(CONFIG_KEY);
  if (!cached) return fetchAuthConfig();
  if (isOnline()) fetchAuthConfig().catch(() => {});
  return cached;
}

// Keycloak returns to the app with the login result in the URL fragment.
function isLoginCallback() {
  return /[#&]state=/.test(window.location.hash);
}

// Logging out of Keycloak ends the browser session but not an offline session,
// so its refresh token is revoked explicitly. Keycloak answers 200 even for a
// token that is already invalid.
async function revokeRefreshToken(refreshToken) {
  const { url, realm, clientId } = authConfig;
  const response = await fetch(`${url}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, token: refreshToken, token_type_hint: "refresh_token" })
  });
  if (!response.ok) throw new Error(`Token revocation failed (${response.status}).`);
}

// Starting Keycloak with a saved login always refreshes it over the network,
// so it is started only when online. Runs once; later calls share the result.
function startKeycloak() {
  if (!keycloakStarted) {
    const stored = readStored(TOKENS_KEY);
    keycloakStarted = (async () => {
      try {
        await keycloak.init({
          pkceMethod: "S256",
          checkLoginIframe: false,
          // An offline token outlives the browser session (Keycloak's Offline
          // Session Idle), so a field agent stays signed in across days offline.
          scope: "offline_access",
          ...(stored?.token && stored?.refreshToken ? stored : {})
        });
      } catch {
        // Keycloak could not be reached to refresh the stored login. Keep it so
        // offline screens stay usable; the API still rejects an expired token.
      }
      savedLogin = null;
      persistTokens();
      const pendingRevoke = readStored(REVOKE_KEY);
      if (pendingRevoke && isOnline()) {
        revokeRefreshToken(pendingRevoke).then(() => writeStored(REVOKE_KEY, null), () => {});
      }
      // Ask the browser not to evict the stored login and offline data.
      if (keycloak.token) navigator.storage?.persist?.().catch(() => {});
    })();
  }
  return keycloakStarted;
}

export function configureAuth(nextApiBase) {
  apiBase = nextApiBase;
}

export function authSession() {
  const token = currentToken();
  const claims = (keycloak?.token ? keycloak.tokenParsed : decodeToken(token)) || {};
  const hasLogin = Boolean(token);
  // The access token is reissued on every refresh, so its issue time is when
  // Keycloak last confirmed this login. An expired token keeps the user signed
  // in offline until that confirmation is older than the offline allowance.
  const verifiedAt = (claims.iat || 0) * 1000;
  const offline = hasLogin && (claims.exp || 0) * 1000 <= Date.now();
  const offlineDays = Number(authConfig?.offlineSignInDays) || 7;
  const needsReconnect = offline && Date.now() - verifiedAt > offlineDays * DAY_MS;
  return {
    authenticated: hasLogin && !needsReconnect,
    needsReconnect,
    offline,
    verifiedAt,
    username: claims.preferred_username || "",
    roles: claims.realm_access?.roles || []
  };
}

export function initAuth() {
  if (!initPromise) {
    initPromise = (async () => {
      authConfig = await loadAuthConfig();
      const { url, realm, clientId } = authConfig;
      keycloak = new Keycloak({ url, realm, clientId });
      keycloak.onAuthSuccess = persistTokens;
      keycloak.onAuthRefreshSuccess = persistTokens;
      keycloak.onAuthLogout = persistTokens;
      const stored = readStored(TOKENS_KEY);
      if (!stored?.token || isLoginCallback()) {
        // Nothing saved to show yet; without a saved login Keycloak starts
        // without the network unless it is finishing a sign-in.
        await startKeycloak();
        return authSession();
      }
      // Open with the saved login straight away and let Keycloak confirm it
      // in the background, now if online or else once the server is reachable.
      savedLogin = stored;
      if (isOnline()) {
        void startKeycloak();
      } else {
        const stopWatching = onConnectivityChange((online) => {
          if (!online) return;
          stopWatching();
          void startKeycloak();
        });
      }
      return authSession();
    })();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

// Try to confirm a stored login with Keycloak again, e.g. once back online.
export async function reconfirmSession() {
  await initAuth();
  if (!keycloakStarted) {
    await startKeycloak();
  } else if (keycloak.refreshToken) {
    try {
      await keycloak.updateToken(-1);
    } catch {}
  }
  return authSession();
}

export async function authHeaders() {
  // Respondents filling a form by code never have a login: skip Keycloak entirely.
  if (!initPromise && !readStored(TOKENS_KEY)) return {};
  try {
    await initAuth();
  } catch {
    return {};
  }
  if (isOnline()) {
    await withinKeycloakWait((async () => {
      await startKeycloak();
      if (keycloak.token) await keycloak.updateToken(30);
    })().catch(() => {}));
  }
  const token = currentToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function login(returnPath = "/") {
  // Keycloak's login page cannot load offline, and leaving the app would strand the user.
  if (!isOnline()) throw new Error("You are offline. Connect to the internet to sign in.");
  await initAuth();
  await startKeycloak();
  await keycloak.login({ redirectUri: `${window.location.origin}${returnPath}` });
}

export async function logout(returnPath = "/") {
  await initAuth();
  if (!isOnline()) {
    const refreshToken = keycloak.refreshToken || savedLogin?.refreshToken;
    if (refreshToken) writeStored(REVOKE_KEY, refreshToken);
    savedLogin = null;
    keycloak.clearToken();
    persistTokens();
    return;
  }
  await startKeycloak();
  const refreshToken = keycloak.refreshToken;
  writeStored(TOKENS_KEY, null);
  if (refreshToken) await revokeRefreshToken(refreshToken).catch(() => {});
  await keycloak.logout({ redirectUri: `${window.location.origin}${returnPath}` });
}

// The API rejected the token. Only Keycloak rejecting the refresh token ends
// the login (keycloak-js then clears it); if Keycloak cannot be reached, the
// user stays signed in. Returns whether the login has ended.
export async function confirmSessionEnded() {
  if (!keycloak) return true;
  return withinKeycloakWait((async () => {
    await startKeycloak();
    if (!keycloak.refreshToken) return true;
    try {
      await keycloak.updateToken(-1);
    } catch {}
    return !keycloak.token;
  })(), false);
}
