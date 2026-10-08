import Keycloak from "keycloak-js";

export const ADMIN_ROLE = "icph-admin";
export const FIELD_AGENT_ROLE = "icph-field-agent";

const TOKENS_KEY = "icph_auth_tokens";
const CONFIG_KEY = "icph_auth_config";
let apiBase = "";
let keycloak = null;
let initPromise = null;

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

// Tokens are kept in localStorage so every tab shares one login and a field
// agent who reopens the app offline still reaches their saved forms.
function persistTokens() {
  writeStored(TOKENS_KEY, keycloak?.token
    ? { token: keycloak.token, refreshToken: keycloak.refreshToken, idToken: keycloak.idToken }
    : null);
}

async function loadAuthConfig() {
  try {
    const response = await fetch(`${apiBase}/api/auth/config`);
    if (!response.ok) throw new Error("Login configuration is unavailable.");
    const { url, realm, clientId } = await response.json();
    writeStored(CONFIG_KEY, { url, realm, clientId });
    return { url, realm, clientId };
  } catch (error) {
    const cached = readStored(CONFIG_KEY);
    if (cached) return cached;
    throw error;
  }
}

export function configureAuth(nextApiBase) {
  apiBase = nextApiBase;
}

export function authSession() {
  const claims = keycloak?.tokenParsed || {};
  return {
    authenticated: Boolean(keycloak?.token),
    username: claims.preferred_username || "",
    roles: claims.realm_access?.roles || []
  };
}

export function initAuth() {
  if (!initPromise) {
    initPromise = (async () => {
      keycloak = new Keycloak(await loadAuthConfig());
      keycloak.onAuthSuccess = persistTokens;
      keycloak.onAuthRefreshSuccess = persistTokens;
      keycloak.onAuthLogout = persistTokens;
      const stored = readStored(TOKENS_KEY);
      try {
        await keycloak.init({
          pkceMethod: "S256",
          checkLoginIframe: false,
          ...(stored?.token && stored?.refreshToken ? stored : {})
        });
      } catch {
        // Keycloak could not be reached to refresh the stored login. Keep it so
        // offline screens stay usable; the API still rejects an expired token.
      }
      persistTokens();
      return authSession();
    })();
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

export async function authHeaders() {
  // Respondents filling a form by code never have a login: skip Keycloak entirely.
  if (!initPromise && !readStored(TOKENS_KEY)) return {};
  try {
    await initAuth();
  } catch {
    return {};
  }
  if (!keycloak.token) return {};
  try {
    await keycloak.updateToken(30);
  } catch {}
  return keycloak.token ? { authorization: `Bearer ${keycloak.token}` } : {};
}

export async function login(returnPath = "/") {
  await initAuth();
  await keycloak.login({ redirectUri: `${window.location.origin}${returnPath}` });
}

export async function logout(returnPath = "/") {
  await initAuth();
  if (!navigator.onLine) {
    keycloak.clearToken();
    persistTokens();
    return;
  }
  writeStored(TOKENS_KEY, null);
  await keycloak.logout({ redirectUri: `${window.location.origin}${returnPath}` });
}

// Drop a login the API no longer accepts, without leaving the page.
export function forgetSession() {
  keycloak?.clearToken();
  writeStored(TOKENS_KEY, null);
}
