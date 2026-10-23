import { createServer } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { deleteFile, downloadFile, isFileId, prepareStorage, storageDescription, storageReachable, uploadFile } from "./storage.js";

const port = Number(process.env.FILE_SERVER_PORT || 8790);
const maxUploadBytes = Math.max(1, Number(process.env.FILE_SERVER_MAX_UPLOAD_MB) || 100) * 1024 * 1024;
// Same Keycloak settings as the form builder API: tokens issued to the form
// builder client are accepted here unchanged.
// KEYCLOAK_URL is how this server reaches Keycloak (token signing keys);
// KEYCLOAK_PUBLIC_URL is how browsers reach it (token issuer).
const keycloakUrl = String(process.env.KEYCLOAK_URL || "http://localhost:8080").replace(/\/+$/, "");
const keycloakPublicUrl = String(process.env.KEYCLOAK_PUBLIC_URL || keycloakUrl).replace(/\/+$/, "");
const keycloakRealm = process.env.KEYCLOAK_REALM || "icph";
const keycloakClientId = process.env.KEYCLOAK_CLIENT_ID || "icph-form-builder";
const keycloakIssuer = `${keycloakPublicUrl}/realms/${keycloakRealm}`;
const keycloakKeys = createRemoteJWKSet(new URL(`${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/certs`));
const ADMIN_ROLE = "icph-admin";
const FIELD_AGENT_ROLE = "icph-field-agent";
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-expose-headers": "content-disposition"
};

function jsonResponse(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders,
    ...extraHeaders
  });
  res.end(body);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function bearerTokenFromRequest(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function authenticateRequest(req) {
  const token = bearerTokenFromRequest(req);
  if (!token) {
    console.warn(`[auth] ${req.method} ${req.url}: no bearer token`);
    return null;
  }
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, keycloakKeys, { issuer: keycloakIssuer, algorithms: ["RS256"] }));
  } catch (error) {
    // A key-fetch failure is an outage, not a bad token: report it as such.
    const code = String(error?.code || "");
    if (!code.startsWith("ERR_J") || code === "ERR_JWKS_TIMEOUT" || code === "ERR_JOSE_GENERIC") {
      console.error(`[auth] could not fetch signing keys from ${keycloakUrl} (realm ${keycloakRealm}):`, error);
      throw httpError(503, "The login service is unavailable. Try again shortly.");
    }
    console.warn(`[auth] ${req.method} ${req.url}: token rejected (${code}: ${error.message})`);
    return null;
  }
  if (claims.azp !== keycloakClientId) {
    console.warn(`[auth] ${req.method} ${req.url}: token azp "${claims.azp}" is not client "${keycloakClientId}"`);
    return null;
  }
  return {
    id: String(claims.sub || ""),
    username: String(claims.preferred_username || ""),
    roles: Array.isArray(claims.realm_access?.roles) ? claims.realm_access.roles : []
  };
}

async function requireRole(req, ...roles) {
  const user = await authenticateRequest(req);
  if (!user) throw httpError(401, "Login required.");
  req.user = user;
  if (!roles.some((role) => user.roles.includes(role))) {
    console.warn(`[auth] ${req.method} ${req.url}: user "${user.username}" has roles [${user.roles.join(", ")}], needs one of [${roles.join(", ")}]`);
    throw httpError(403, "Your account does not have access to this.");
  }
  return user;
}

function cleanFileName(value) {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(String(value || "").replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  return (base && base !== "." && base !== ".." ? base : "upload").slice(0, 255);
}

function cleanContentType(value) {
  const type = String(value || "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : "application/octet-stream";
}

function contentDisposition(fileName) {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// POST /files?name=<original file name>
// The request body is the raw file; Content-Type is the file's type.
async function handleUpload(req, res, url) {
  const user = await requireRole(req, FIELD_AGENT_ROLE, ADMIN_ROLE);
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
    throw httpError(413, `File exceeds the ${Math.round(maxUploadBytes / (1024 * 1024))} MB limit.`);
  }
  const file = await uploadFile(req, {
    fileName: cleanFileName(url.searchParams.get("name")),
    contentType: cleanContentType(req.headers["content-type"]),
    uploadedBy: user.id,
    maxBytes: maxUploadBytes
  });
  console.log(`[files] stored ${file.id} (${file.sizeBytes} bytes, ${file.contentType}) for user=${user.username}`);
  return jsonResponse(res, 201, { ok: true, file });
}

async function handleDownload(req, res, id) {
  await requireRole(req, FIELD_AGENT_ROLE, ADMIN_ROLE);
  const file = await downloadFile(id);
  res.writeHead(200, {
    ...corsHeaders,
    "content-type": file.contentType,
    ...(Number.isFinite(file.sizeBytes) ? { "content-length": String(file.sizeBytes) } : {}),
    "content-disposition": contentDisposition(file.fileName),
    // Uploaded content is untrusted: never let a browser run it as a page.
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    // A file id always refers to the same bytes.
    "cache-control": "private, max-age=3600"
  });
  pipeline(file.stream, res, (error) => {
    if (error) console.error(`[files] download of ${id} interrupted:`, error.message);
  });
}

async function handleDelete(req, res, id) {
  const user = await requireRole(req, ADMIN_ROLE);
  await deleteFile(id);
  console.log(`[files] deleted ${id} by user=${user.username}`);
  return jsonResponse(res, 200, { ok: true, id });
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const who = req.user ? ` user=${req.user.username}` : "";
    console.log(`[http] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - startedAt} ms)${who}`);
  });
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && pathname === "/health") {
      if (!(await storageReachable())) throw httpError(503, "Storage container not found.");
      return jsonResponse(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/files") return await handleUpload(req, res, url);
    const fileMatch = pathname.match(/^\/files\/([^/]+)$/);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]);
      if (!isFileId(id)) throw httpError(404, "File not found.");
      if (req.method === "GET") return await handleDownload(req, res, id);
      if (req.method === "DELETE") return await handleDelete(req, res, id);
    }
    throw httpError(404, "Not found.");
  } catch (error) {
    // Only errors raised here on purpose carry a status for the client; anything
    // else (including Azure SDK errors, which have their own statusCode) is a 500.
    const status = error.expose ? error.statusCode : 500;
    if (!error.expose) console.error(`[http] ${req.method} ${req.url} failed:`, error);
    if (res.headersSent) return res.destroy();
    // The rest of a rejected upload is not read; close instead of draining it.
    return jsonResponse(res, status, { ok: false, error: error.expose ? error.message : "Internal error." }, req.method === "POST" ? { connection: "close" } : {});
  }
});

// Large files over slow mobile connections can take longer than Node's default 5 minutes.
server.requestTimeout = 30 * 60 * 1000;

await prepareStorage();
server.listen(port, "0.0.0.0", () => {
  console.log(`[files] listening on :${port}, storing in ${storageDescription()}, max upload ${maxUploadBytes / (1024 * 1024)} MB`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
