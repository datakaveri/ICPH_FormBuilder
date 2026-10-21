import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { logTablePrivileges, migrate, query, withTransaction } from "./db.js";
import * as store from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const icphRoot = path.resolve(appRoot, "..");
const DEFAULT_FOLDER_BARCODE_VARIABLE = "participant_barcode";
const odkVenvBin = path.join(icphRoot, "ODK", ".venv-xlsform", "bin");
const pythonBin = path.join(odkVenvBin, "python");
const xls2xformBin = path.join(odkVenvBin, "xls2xform");
const exporterPath = path.join(appRoot, "scripts", "export_xlsform.py");
const importerPath = path.join(appRoot, "scripts", "import_xlsform.py");
const inspectorPath = path.join(appRoot, "scripts", "inspect_xlsform.py");
const folderResponseExporterPath = path.join(appRoot, "scripts", "export_folder_responses.py");
const terminologyExtractorPath = path.join(appRoot, "scripts", "extract_form_terminology.py");
const mapperRoot = path.join(icphRoot, "agentic-entity-mapper");
const mapperPythonBin = path.join(mapperRoot, ".venv", "bin", "python");
const mapperRunnerPath = path.join(appRoot, "scripts", "run_icph_mapper.py");
// MetaForms are stored in Postgres. They used to be files here; see importLegacyMetaForms.
const legacyMetaFormsRoot = path.join(mapperRoot, "SchemaTerminologies", "schemas", "ICPH_MetaForms");
const schemaPreprocessorPath = path.join(mapperRoot, "preprocess_icph_metaforms.py");
const schemaManifestName = "icph_metaforms_manifest.json";
const port = Number(process.env.ICPH_FORM_BUILDER_API_PORT || 8787);
// KEYCLOAK_URL is how this server reaches Keycloak (token signing keys);
// KEYCLOAK_PUBLIC_URL is how browsers reach it (login pages, token issuer).
const keycloakUrl = String(process.env.KEYCLOAK_URL || "http://localhost:8080").replace(/\/+$/, "");
const keycloakPublicUrl = String(process.env.KEYCLOAK_PUBLIC_URL || keycloakUrl).replace(/\/+$/, "");
const keycloakRealm = process.env.KEYCLOAK_REALM || "icph";
const keycloakClientId = process.env.KEYCLOAK_CLIENT_ID || "icph-form-builder";
const keycloakIssuer = `${keycloakPublicUrl}/realms/${keycloakRealm}`;
const keycloakKeys = createRemoteJWKSet(new URL(`${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/certs`));
const ADMIN_ROLE = "icph-admin";
const FIELD_AGENT_ROLE = "icph-field-agent";
const activeSubmissionRequests = new Map();
// Running terminology extractions by workspace: the child process and the scratch file it reports progress in.
const terminologyRuns = new Map();
const accessCodeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const structuralQuestionTypes = new Set(["begin_group", "end_group", "begin_repeat", "end_repeat", "begin group", "end group", "begin repeat", "end repeat"]);
const nonPrimaryIdentifierTypes = new Set([
  ...structuralQuestionTypes,
  "note",
  "calculate",
  "hidden",
  "csv-external",
  "timer",
  "audit",
  "start",
  "end",
  "today",
  "deviceid",
  "username",
  "phonenumber",
  "email",
  "background-audio"
]);
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
};

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders
  });
  res.end(body);
}

function binaryResponse(res, status, body, contentType = "application/octet-stream") {
  res.writeHead(status, {
    "content-type": contentType,
    ...corsHeaders
  });
  res.end(body);
}

async function requestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 160 * 1024 * 1024) {
      const error = new Error("Request body exceeds the 160 MB server limit.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function slugify(value) {
  return String(value || "untitled-form")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled-form";
}

function fieldName(value, fallback = "field") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safe = cleaned || fallback;
  return /^\d/.test(safe) ? `q_${safe}` : safe.slice(0, 64);
}

function timestampId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function isoStamp() {
  return new Date().toISOString();
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
      const unavailable = new Error("The login service is unavailable. Try again shortly.");
      unavailable.statusCode = 503;
      throw unavailable;
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
  if (!user) {
    const error = new Error("Login required.");
    error.statusCode = 401;
    throw error;
  }
  req.user = user;
  if (!roles.some((role) => user.roles.includes(role))) {
    console.warn(`[auth] ${req.method} ${req.url}: user "${user.username}" has roles [${user.roles.join(", ")}], needs one of [${roles.join(", ")}]`);
    const error = new Error("Your account does not have access to this.");
    error.statusCode = 403;
    throw error;
  }
  return user;
}

function cleanRespondentAccessCode(value) {
  const code = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{1,10}$/.test(code)) {
    const error = new Error("Enter a respondent form code with up to 10 letters or numbers.");
    error.statusCode = 400;
    throw error;
  }
  return code;
}

function randomRespondentAccessCode() {
  const bytes = randomBytes(5);
  let code = "";
  for (const byte of bytes) code += accessCodeAlphabet[byte % accessCodeAlphabet.length];
  return code;
}

function cleanSchemaDocName(fileName) {
  const base = path.basename(String(fileName || "metadata.docx")).replace(/[^0-9A-Za-z._-]+/g, "_");
  const ext = path.extname(base).toLowerCase();
  if (ext !== ".docx") throw new Error("Only DOCX schema metadata documents are supported right now.");
  return base || "metadata.docx";
}

function cleanXlsxName(fileName) {
  const base = path.basename(String(fileName || "imported-form.xlsx")).replace(/[^0-9A-Za-z._-]+/g, "_");
  const ext = path.extname(base).toLowerCase();
  if (ext !== ".xlsx") throw new Error("Only XLSX XLSForm uploads are supported.");
  return base || "imported-form.xlsx";
}

function cleanAttachmentName(fileName) {
  const base = path.basename(String(fileName || "attachment")).replace(/[^0-9A-Za-z._ -]+/g, "_").trim();
  if (!base || base === "." || base === "..") throw new Error("Attachment filename is required.");
  return base;
}

function cleanWorkspaceId(workspaceId) {
  const text = String(workspaceId || "").trim().replace(/[\\/]+$/, "");
  const base = path.basename(text).replace(/[^0-9A-Za-z._-]+/g, "_").trim();
  if (!base || base === "." || base === "..") throw new Error("workspaceId is required.");
  return base;
}

function splitWorkspaceVersion(workspaceId) {
  const cleanId = cleanWorkspaceId(workspaceId);
  const match = cleanId.match(/^(.*)_v(\d+)$/i);
  return {
    baseId: match ? match[1] : cleanId,
    versionNumber: match ? Number(match[2]) : 1
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function formBuildSnapshot(form = {}) {
  return {
    title: form.title || "",
    formId: form.formId || "",
    defaultLanguage: form.defaultLanguage || "",
    style: form.style || "",
    settingsExtraColumns: form.settingsExtraColumns || {},
    publicKey: form.publicKey || "",
    submissionUrl: form.submissionUrl || "",
    allowChoiceDuplicates: form.allowChoiceDuplicates || "",
    primaryIdentifierVariable: form.primaryIdentifierVariable || "",
    terminologyUseLlm: false,
    multilingualEnabled: Boolean(form.multilingualEnabled),
    multilingualLanguage: form.multilingualLanguage || "",
    entities: form.entities || [],
    questions: form.questions || []
  };
}

function normalizeResponseSettings(source = {}) {
  return {
    allowResponseEdits: Boolean(source.allowResponseEdits),
    limitOneResponsePerIdentifier: source.limitOneResponsePerIdentifier !== false,
    participantIdentifierVariable: String(source.participantIdentifierVariable || "").trim()
  };
}

function formHasVersionChanges(form = {}) {
  if (!form.previousVersionWorkspaceId || !form.versionBaseline) return true;
  return stableStringify(formBuildSnapshot(form)) !== stableStringify(form.versionBaseline);
}

function describeVersionChanges(form = {}) {
  const baseline = form.versionBaseline || {};
  const beforeQuestions = new Map((baseline.questions || []).map((question) => [question.name || question.id, question]));
  const afterQuestions = new Map((form.questions || []).map((question) => [question.name || question.id, question]));
  const changes = [];
  for (const [key, question] of afterQuestions) {
    if (!beforeQuestions.has(key)) {
      changes.push(`Added question ${question.name || key}`);
    } else if (stableStringify(question) !== stableStringify(beforeQuestions.get(key))) {
      changes.push(`Changed question ${question.name || key}`);
    }
  }
  for (const [key, question] of beforeQuestions) {
    if (!afterQuestions.has(key)) changes.push(`Removed question ${question.name || key}`);
  }
  const beforeSettings = { ...baseline };
  const afterSettings = { ...formBuildSnapshot(form) };
  delete beforeSettings.questions;
  delete afterSettings.questions;
  if (stableStringify(beforeSettings) !== stableStringify(afterSettings)) changes.unshift("Changed form settings");
  return changes;
}

function instanceNameForPrimaryIdentifier(primaryIdentifierVariable) {
  const variable = String(primaryIdentifierVariable || "").trim();
  if (!variable) return "";
  return `concat(\${${variable}}, ' - ', format-date-time(now(), '%Y-%m-%d %H:%M:%S'))`;
}

function escapeXmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function normalizedQuestionType(question = {}) {
  return String(question.type || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function timerFieldNames(question = {}) {
  const base = fieldName(question?.name || question?.id || "timer", "timer");
  return {
    start: `${base}_start`,
    end: `${base}_end`,
    duration: `${base}_duration_seconds`
  };
}

function dataHeadersForDraft(draft = {}) {
  const seen = new Set();
  const headers = [];
  const add = (name) => {
    const clean = String(name || "").trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    headers.push(clean);
  };
  for (const question of draft.questions || []) {
    const type = normalizedQuestionType(question);
    if (type === "timer") {
      const fields = timerFieldNames(question);
      add(fields.start);
      add(fields.end);
      add(fields.duration);
      continue;
    }
    if (
      structuralQuestionTypes.has(type) ||
      ["note", "csv-external", "timer", "audit", "background-audio"].includes(type)
    ) {
      continue;
    }
    add(question?.name);
  }
  return headers;
}

function primaryIdentifierProblem(questions = [], variable = "") {
  const selected = String(variable || "").trim();
  if (!selected) return "";
  let repeatDepth = 0;
  for (const question of questions || []) {
    const type = normalizedQuestionType(question);
    if (type === "end_repeat") repeatDepth = Math.max(0, repeatDepth - 1);
    const name = String(question?.name || "").trim();
    if (name === selected) {
      if (structuralQuestionTypes.has(type)) return `Primary identifier "${selected}" is a group/repeat structure row. Choose an answer question outside the repeat instead.`;
      if (nonPrimaryIdentifierTypes.has(type)) return `Primary identifier "${selected}" uses type "${question.type}", which cannot identify respondents. Choose a respondent answer question instead.`;
      if (repeatDepth > 0) return `Primary identifier "${selected}" is inside a repeat. Choose an identifier question outside repeat sections so each submission has one stable respondent code.`;
      return "";
    }
    if (type === "begin_repeat") repeatDepth += 1;
  }
  return `Primary identifier variable "${selected}" is not present in this form.`;
}

function withStartGeopointInputs(draft, xml) {
  const startQuestions = (draft.questions || []).filter((question) => normalizedQuestionType(question) === "start-geopoint" && String(question.name || "").trim());
  if (!startQuestions.length) return xml;
  let additions = "";
  for (const question of startQuestions) {
    const name = String(question.name || "").trim();
    if (new RegExp(`<input\\s+[^>]*ref=["']/data/${name}["']`).test(xml)) continue;
    const label = escapeXmlText(question.label || name);
    const hint = String(question.hint || "").trim() ? `<hint>${escapeXmlText(question.hint)}</hint>` : "";
    const appearance = String(question.appearance || "").trim() ? ` appearance="${escapeXmlAttribute(question.appearance)}"` : "";
    additions += `<input ref="/data/${escapeXmlAttribute(name)}"${appearance}><label>${label}</label>${hint}</input>`;
  }
  if (!additions) return xml;
  if (xml.includes("</h:body>")) return xml.replace("</h:body>", `${additions}</h:body>`);
  if (xml.includes("</body>")) return xml.replace("</body>", `${additions}</body>`);
  return xml;
}

function contentTypeFor(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (ext === ".csv") return "text/csv; charset=utf-8";
  if (ext === ".geojson" || ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

async function uniqueSchemaDocName(fileName) {
  const cleanName = cleanSchemaDocName(fileName);
  const ext = path.extname(cleanName);
  const stem = path.basename(cleanName, ext);
  let candidate = cleanName;
  let index = 1;
  while (await store.metaFormExists(candidate)) {
    candidate = `${stem}_${timestampId()}${index > 1 ? `_${index}` : ""}${ext}`;
    index += 1;
  }
  return candidate;
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function parseJsonLines(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// The preprocessor's manifest entry for a document, with its Markdown and chunks
// read from wherever it wrote them.
async function readPreprocessedMetaForm(info) {
  return {
    markdown: await readFile(path.resolve(mapperRoot, info.markdown_path), "utf8"),
    chunks: parseJsonLines(await readFile(path.resolve(mapperRoot, info.chunks_path), "utf8")),
    formCount: info.form_count || 0,
    variableCount: info.variable_count || 0
  };
}

// Subprocesses (XLSForm tools, terminology extractor, FHIR mapper) work on files.
// They get a scratch directory; results are read back into the database.
async function withScratchDir(work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "icph-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function draftAccessCode(draft) {
  return String(draft?.respondentAccessCode || draft?.publicAccessCode || "").trim().toUpperCase() || null;
}

async function saveDraft(workspaceId, draft) {
  try {
    await store.saveDraft(workspaceId, draft, {
      folderId: String(draft?.folderId || "").trim() || null,
      respondentAccessCode: draftAccessCode(draft)
    });
  } catch (error) {
    if (error.code === "23505" && error.constraint === "forms_respondent_access_code_key") {
      const conflict = new Error("That respondent code is already used by another published form.");
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
}

function withFormLock(workspaceId, work) {
  return withTransaction(async () => {
    await store.lockForm(cleanWorkspaceId(workspaceId));
    return work();
  });
}

async function requireWorkspace(workspaceId) {
  const cleanId = cleanWorkspaceId(workspaceId);
  if (!(await store.formExists(cleanId))) {
    throw new Error(`Form workspace not found: ${cleanId}`);
  }
  return { cleanId };
}

// Groups a MetaForm's chunks into the forms it describes, with their variables.
function metaFormFormOptions(chunks) {
  const byForm = new Map();
  for (const chunk of chunks || []) {
    const formIndex = Number(chunk.form_index || 0);
    if (!formIndex) continue;
    if (!byForm.has(formIndex)) {
      byForm.set(formIndex, {
        formIndex,
        title: chunk.form_title || `Form ${formIndex}`,
        variableCount: 0,
        variables: []
      });
    }
    const formOption = byForm.get(formIndex);
    if (chunk.chunk_type === "form") {
      formOption.title = chunk.form_title || formOption.title;
      formOption.variableCount = Array.isArray(chunk.variables) ? chunk.variables.length : formOption.variableCount;
    }
    if (chunk.chunk_type === "variable" && chunk.variable) {
      formOption.variables.push({
        name: chunk.variable,
        label: chunk.question || "",
        formatOptions: chunk.format_options || "",
        instructions: chunk.instructions || ""
      });
    }
  }
  return [...byForm.values()].sort((a, b) => a.formIndex - b.formIndex);
}

async function listSchemaDocuments() {
  const [metaForms, metaFormPrimaries] = await Promise.all([store.listMetaForms(), readMetaFormPrimaries()]);
  const documents = metaForms.map((item) => ({
    fileName: item.fileName,
    status: item.processedAt && item.chunkCount ? "Processed" : "Needs processing",
    sourceSizeBytes: item.sizeBytes,
    updatedAt: item.uploadedAt,
    processedAt: item.processedAt,
    formCount: item.formCount,
    primaryIdentifierVariable: metaFormPrimaries[item.fileName] || null,
    formOptions: metaFormFormOptions(item.chunks),
    variableCount: item.variableCount,
    chunkCount: item.chunkCount,
    sha256: item.sha256
  }));
  const processedTimes = documents.map((item) => item.processedAt).filter(Boolean).sort();
  return {
    ok: true,
    documents,
    aggregateChunkCount: documents.reduce((sum, item) => sum + item.chunkCount, 0),
    processedAt: processedTimes.at(-1) || null
  };
}

async function uploadSchemaDocument(payload) {
  const fileName = await uniqueSchemaDocName(payload.filename);
  const data = Buffer.from(String(payload.dataBase64 || ""), "base64");
  if (!data.length) throw new Error("Uploaded schema document is empty.");
  if (!(await store.insertMetaForm({ fileName, docx: data, sha256: sha256Hex(data) }))) {
    throw new Error(`A MetaForm named ${fileName} already exists.`);
  }
  return { ok: true, fileName, ...(await listSchemaDocuments()) };
}

// Processes the named document, or every one that needs it (all of them with force).
// The preprocessor works on files, so it runs on scratch copies of the DOCX files.
async function processSchemaDocuments(payload = {}) {
  const requested = String(payload.fileName || "").trim();
  const fileNames = requested ? [cleanSchemaDocName(requested)] : payload.force ? null : await store.listUnprocessedMetaFormNames();
  const docs = fileNames?.length === 0 ? [] : await store.listMetaFormDocx(fileNames);
  if (requested && !docs.length) throw new Error(`MetaForm not found: ${requested}`);
  const result = !docs.length
    ? { code: 0, stdout: "No MetaForms need processing.\n", stderr: "" }
    : await withScratchDir(async (dir) => {
      const inputDir = path.join(dir, "originalDocx");
      const outputDir = path.join(dir, "processedMD");
      await mkdir(inputDir);
      for (const doc of docs) await writeFile(path.join(inputDir, path.basename(doc.fileName)), doc.data);
      const command = existsSync(mapperPythonBin) ? mapperPythonBin : pythonBin;
      const run = await runCommand(command, [schemaPreprocessorPath, "--input-dir", inputDir, "--output-dir", outputDir], { cwd: mapperRoot });
      if (run.code !== 0) return run;
      const manifest = JSON.parse(await readFile(path.join(outputDir, schemaManifestName), "utf8"));
      for (const doc of docs) {
        const info = manifest.documents?.[path.basename(doc.fileName)];
        if (info) await store.setMetaFormProcessed(doc.fileName, await readPreprocessedMetaForm(info));
      }
      return run;
    });
  return {
    ...(await listSchemaDocuments()),
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function deleteSchemaDocument(fileName) {
  const cleanName = cleanSchemaDocName(fileName);
  const linkedWorkspaceIds = (await listForms()).forms
    .filter((item) => item.metaFormLink?.fileName === cleanName)
    .map((item) => item.workspaceId);

  await store.deleteMetaForm(cleanName);

  for (const workspaceId of linkedWorkspaceIds) await deleteForm(workspaceId);

  return { ok: true, deleted: { fileName: cleanName }, deletedWorkspaceIds: linkedWorkspaceIds, ...(await listSchemaDocuments()) };
}

// MetaForms used to be stored as files under SchemaTerminologies. Copies any found
// there into the database on the first start after the move; the folder is ignored after that.
async function importLegacyMetaForms() {
  const taskName = "import-legacy-meta-forms";
  if (await store.taskCompleted(taskName)) return;
  const originalDir = path.join(legacyMetaFormsRoot, "originalDocx");
  const processedDir = path.join(legacyMetaFormsRoot, "processedMD");
  let names = [];
  try {
    names = (await readdir(originalDir)).filter((name) => name.toLowerCase().endsWith(".docx") && !name.startsWith("~$"));
  } catch {}
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(path.join(processedDir, schemaManifestName), "utf8")).documents || {};
  } catch {}

  let imported = 0;
  let failed = 0;
  for (const name of names) {
    try {
      const docx = await readFile(path.join(originalDir, name));
      const sha256 = sha256Hex(docx);
      const info = manifest[name];
      let processed = null;
      // Processed output for an older version of the file is left behind; it can be reprocessed.
      if (info?.sha256 === sha256 && info.markdown_path && info.chunks_path) {
        try {
          processed = { ...(await readPreprocessedMetaForm(info)), processedAt: info.processed_at || null };
        } catch {}
      }
      if (await store.insertMetaForm({ fileName: name, docx, sha256, processed })) imported += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Could not import MetaForm ${name}: ${error.message || error}`);
    }
  }
  if (imported) console.log(`Imported ${imported} MetaForm document(s) from ${originalDir} into the database.`);
  // Tried again on the next start if any file could not be read.
  if (!failed) await store.markTaskCompleted(taskName);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd || appRoot, env: { ...process.env, ...(options.env || {}) } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

async function folderPrimaryDetails(folderId) {
  const cleanId = String(folderId || "").trim();
  if (!cleanId) return null;
  const folders = await readFolders();
  const folder = folders.find((item) => item.id === cleanId);
  if (!folder) throw new Error("Folder not found.");
  const storedVariable = String(folder.primaryIdentifierVariable || "").trim();
  if (storedVariable) {
    const forms = await listForms();
    const source = forms.forms.find((item) => item.folderId === cleanId && item.hasXml && item.primaryIdentifierVariable === storedVariable);
    if (source) {
      try {
        const loaded = await loadDraft(source.workspaceId);
        const question = (loaded.draft.questions || []).find((item) => item.name === storedVariable);
        return { variable: storedVariable, question };
      } catch {}
    }
    return { variable: storedVariable, question: null };
  }
  const forms = await listForms();
  const source = forms.forms.find((item) => item.folderId === cleanId && item.hasXml && item.primaryIdentifierVariable);
  if (!source) return null;
  const variable = String(source.primaryIdentifierVariable || "").trim();
  try {
    const loaded = await loadDraft(source.workspaceId);
    const question = (loaded.draft.questions || []).find((item) => item.name === variable);
    return { variable, question };
  } catch {
    return { variable, question: null };
  }
}

function publishedFolderForms(forms = [], folderId = "") {
  const groups = new Map();
  for (const form of forms.filter((item) => (
    item.folderId === folderId
    && item.hasXml
    && item.respondentAccessCode
    && !item.collectionLocked
  ))) {
    const key = form.versionBaseId
      || form.formId
      || form.title
      || String(form.workspaceId || "").replace(/_v\d+$/i, "");
    const group = groups.get(key) || [];
    group.push(form);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((versions) => versions.slice().sort((a, b) => Number(a.versionNumber || 1) - Number(b.versionNumber || 1)).at(-1))
    .filter(Boolean);
}

function folderAnswerValue(answers = {}, name = "", repeatIndex = null) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return "";
  if (repeatIndex !== null) return entryValue(repeatAnswerValue(answers, cleanName, repeatIndex));
  const prefix = `${cleanName}__repeat_`;
  const repeated = Object.keys(answers)
    .filter((key) => key.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((key) => answers[key]);
  return repeated.length ? entryValue(repeated) : entryValue(answers[cleanName]);
}

function folderQuestionKey(index, form) {
  return `form_${index + 1}_${slugify(form.title || form.formId || form.workspaceId)}`;
}

function mergeFolderCell(row, key, value) {
  const next = String(value ?? "").trim();
  if (!next) return;
  const current = String(row[key] ?? "").trim();
  if (!current) {
    row[key] = next;
    return;
  }
  const values = current.split(" | ");
  if (!values.includes(next)) row[key] = `${current} | ${next}`;
}

async function exportFolderResponses(folderId) {
  const cleanId = String(folderId || "").trim();
  const folders = await readFolders();
  const folder = folders.find((item) => item.id === cleanId);
  if (!folder) {
    const error = new Error("Folder not found.");
    error.statusCode = 404;
    throw error;
  }
  const allForms = (await listForms()).forms || [];
  const selectedForms = publishedFolderForms(allForms, cleanId);
  if (!selectedForms.length) throw new Error("This folder has no published and unlocked forms to export.");
  const registry = await readParticipantRegistry();
  const descriptors = [];
  for (const form of selectedForms) {
    const loaded = await loadDraft(form.workspaceId);
    const entries = await readEntries(form.workspaceId);
    const draft = loaded.draft || {};
    const demographic = draft.questions?.some((question) => question.type === "begin_repeat" && question.demographicData);
    descriptors.push({ form, draft, entries, demographic, formKey: folderQuestionKey(descriptors.length, form) });
  }

  const columns = [
    { key: "participant_identifier", label: "Participant identifier" },
    { key: "barcode", label: "Participant barcode" },
    { key: "household_identifier", label: "Household identifier" },
    { key: "demographic_member_identifier", label: "Demographic member identifier" }
  ];
  for (const descriptor of descriptors) {
    for (const header of dataHeadersForDraft(descriptor.draft)) {
      columns.push({
        key: `${descriptor.formKey}::${header}`,
        label: `${descriptor.form.title || descriptor.form.formId} · ${header}`
      });
    }
  }

  const rows = new Map();
  function rowFor(identityKey, identity = {}) {
    let row = rows.get(identityKey);
    if (!row) {
      row = {
        participant_identifier: identity.participantIdentifier || "",
        barcode: identity.barcode || "",
        household_identifier: identity.householdIdentifier || "",
        demographic_member_identifier: identity.memberIdentifier || ""
      };
      rows.set(identityKey, row);
    }
    mergeFolderCell(row, "participant_identifier", identity.participantIdentifier);
    mergeFolderCell(row, "barcode", identity.barcode);
    mergeFolderCell(row, "household_identifier", identity.householdIdentifier);
    mergeFolderCell(row, "demographic_member_identifier", identity.memberIdentifier);
    return row;
  }

  for (const descriptor of descriptors) {
    const headers = dataHeadersForDraft(descriptor.draft);
    if (descriptor.demographic) {
      const members = demographicParticipantRows(descriptor.draft, descriptor.entries, registry);
      for (const member of members) {
        const participantIdentifier = member.barcode || member.memberIdentifier || member.householdIdentifier || `${member.entryId}:${member.repeatIndex}`;
        const identityKey = member.barcode || `${member.householdIdentifier}::${member.memberIdentifier || `${member.entryId}:${member.repeatIndex}`}`;
        const row = rowFor(identityKey, {
          participantIdentifier,
          barcode: member.barcode,
          householdIdentifier: member.householdIdentifier,
          memberIdentifier: member.memberIdentifier
        });
        for (const header of headers) {
          const childValue = Object.prototype.hasOwnProperty.call(member.displayAnswers || {}, header)
            ? entryValue(member.displayAnswers[header])
            : folderAnswerValue(descriptor.entries.find((entry) => entry.id === member.entryId)?.answers || {}, header);
          mergeFolderCell(row, `${descriptor.formKey}::${header}`, childValue);
        }
      }
      continue;
    }

    const participantVariable = descriptor.draft.participantIdentifierVariable || descriptor.draft.primaryIdentifierVariable || "";
    for (const entry of descriptor.entries) {
      const answers = entry.answers || {};
      const participantIdentifier = folderAnswerValue(answers, participantVariable) || entry.instanceName || entry.id;
      const row = rowFor(`${participantIdentifier}`.toLowerCase(), { participantIdentifier });
      for (const header of headers) mergeFolderCell(row, `${descriptor.formKey}::${header}`, folderAnswerValue(answers, header));
    }
  }

  return withScratchDir(async (dir) => {
    const inputPath = path.join(dir, "responses.json");
    const outputPath = path.join(dir, "responses.xlsx");
    await writeFile(inputPath, JSON.stringify({ columns, rows: [...rows.values()] }), "utf8");
    const result = await runCommand(pythonBin, [folderResponseExporterPath, inputPath, outputPath]);
    if (result.code !== 0 || !existsSync(outputPath)) {
      throw new Error(result.stderr.trim() || "Could not create the folder response workbook.");
    }
    return {
      fileName: `${slugify(folder.name)}_responses.xlsx`,
      data: await readFile(outputPath),
      formCount: descriptors.length,
      rowCount: rows.size
    };
  });
}

async function claimFolderPrimaryIdentifier(folderId, variable) {
  const cleanId = String(folderId || "").trim();
  const cleanVariable = String(variable || "").trim();
  if (!cleanId || !cleanVariable) return;
  const folders = await readFolders();
  const index = folders.findIndex((item) => item.id === cleanId);
  if (index < 0) throw new Error("Folder not found.");
  const folder = folders[index];
  if (folder.participantIdentifierMode === "barcode") {
    const barcodeVariable = String(folder.participantIdentifierVariable || DEFAULT_FOLDER_BARCODE_VARIABLE).trim();
    if (cleanVariable !== barcodeVariable) {
      throw new Error(`Forms in this folder must use the shared barcode identifier variable "${barcodeVariable}".`);
    }
    return;
  }
  const existing = String(folder.primaryIdentifierVariable || "").trim();
  if (existing && existing !== cleanVariable) {
    throw new Error(`Forms in this folder must use the shared primary identifier variable "${existing}".`);
  }
  if (!existing) await store.updateFolderIdentifiers(cleanId, { primaryIdentifierVariable: cleanVariable });
}

function sharedBarcodeQuestion(variable) {
  return {
    id: `folder_barcode_${slugify(variable)}_${timestampId()}`,
    type: "barcode",
    name: variable,
    label: "Participant barcode",
    hint: "Scan the barcode assigned to this participant.",
    required: true,
    identifierLocked: true,
    folderSharedIdentifier: "barcode"
  };
}

async function syncFolderBarcodeQuestions(folderId, variable, sourceWorkspaceId = "") {
  const forms = (await listForms()).forms.filter((item) => item.folderId === folderId);
  for (const item of forms) {
    if (item.workspaceId === sourceWorkspaceId) continue;
    const loaded = await loadDraft(item.workspaceId);
    const entries = await readEntries(item.workspaceId);
    if (entries.length) continue;
    const questions = loaded.draft.questions || [];
    const existing = questions.find((question) => question.name === variable && question.type === "barcode");
    if (existing?.identifierLocked && loaded.draft.participantIdentifierVariable === variable && loaded.draft.primaryIdentifierVariable === variable) continue;
    const withoutParentIdentifier = questions.filter((question) => question.name !== loaded.draft.primaryIdentifierVariable || question.name === variable);
    const nextQuestions = existing
      ? withoutParentIdentifier.map((question) => question.id === existing.id ? { ...question, identifierLocked: true, folderSharedIdentifier: "barcode", required: true } : question)
      : (() => {
          const next = [...withoutParentIdentifier];
          next.unshift(sharedBarcodeQuestion(variable));
          return next;
        })();
    const nextDraft = {
      ...loaded.draft,
      questions: nextQuestions,
      primaryIdentifierVariable: variable,
      participantIdentifierVariable: variable,
      updatedAt: isoStamp()
    };
    if (item.hasXml) await exportForm({ workspaceId: item.workspaceId, form: nextDraft });
    else await saveDraft(item.workspaceId, nextDraft);
  }
}

async function enableFolderBarcodeParticipantMode(folderId, requestedVariable = "") {
  const cleanId = String(folderId || "").trim();
  if (!cleanId) return;
  const cleanVariable = String(requestedVariable || DEFAULT_FOLDER_BARCODE_VARIABLE).trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(cleanVariable)) throw new Error("Barcode question variable must start with a letter or underscore and contain only letters, numbers, or underscores.");
  const folders = await readFolders();
  const index = folders.findIndex((item) => item.id === cleanId);
  if (index < 0) throw new Error("Folder not found.");
  const existingVariable = String(folders[index].participantIdentifierVariable || "").trim();
  if (existingVariable && existingVariable !== cleanVariable) throw new Error(`This folder already uses "${existingVariable}" as its barcode variable.`);
  await store.updateFolderIdentifiers(cleanId, {
    participantIdentifierMode: "barcode",
    participantIdentifierVariable: existingVariable || cleanVariable
  });
  await syncFolderBarcodeQuestions(cleanId, existingVariable || cleanVariable);
}

function readMetaFormPrimaries() {
  return store.listMetaFormPrimaries();
}

async function claimMetaFormPrimary(fileName, variable) {
  const cleanName = String(fileName || "").trim();
  const cleanVariable = String(variable || "").trim();
  if (!cleanName || !cleanVariable) return;
  const primaries = await readMetaFormPrimaries();
  const existing = String(primaries[cleanName] || "").trim();
  if (existing && existing !== cleanVariable) {
    throw new Error(`Forms linked to this MetaForm must use the shared primary identifier variable "${existing}".`);
  }
  if (!existing) await store.insertMetaFormPrimary(cleanName, cleanVariable);
}

async function releaseSharedIdentifiersForForm(draft) {
  const forms = await listForms();
  if (draft?.folderId && !forms.forms.some((item) => item.folderId === draft.folderId)) {
    const folders = await readFolders();
    const folderIndex = folders.findIndex((item) => item.id === draft.folderId);
    if (folderIndex >= 0 && (folders[folderIndex].primaryIdentifierVariable || folders[folderIndex].participantIdentifierMode)) {
      await store.updateFolderIdentifiers(draft.folderId, {
        primaryIdentifierVariable: "",
        participantIdentifierMode: "",
        participantIdentifierVariable: ""
      });
    }
  }
  const metaFileName = String(draft?.metaFormLink?.fileName || "").trim();
  if (metaFileName && !forms.forms.some((item) => item.metaFormLink?.fileName === metaFileName)) {
    await store.deleteMetaFormPrimary(metaFileName);
  }
}

async function createForm(payload) {
  const title = String(payload.title || "Untitled ICPH Form").trim();
  const formId = slugify(payload.formId || title).replace(/-/g, "_");
  const versionBaseId = `${timestampId()}_${slugify(title)}`;
  const workspaceId = `${versionBaseId}_v1`;
  const metaFormLink = normalizeMetaFormLink(payload);
  const linkedPrimary = metaFormLink ? await existingMetaFormPrimary(metaFormLink.fileName) : null;
  const folderId = String(payload.folderId || "").trim() || null;
  const folderPrimary = folderId ? await folderPrimaryDetails(folderId) : null;
  const folderRecord = folderId ? (await readFolders()).find((item) => item.id === folderId) : null;
  if (metaFormLink) {
    if (!metaFormLink.formIndex) throw new Error("Choose which form in the linked MetaForm you are building.");
    if (!payload.primaryIdentifierAcknowledged) {
      throw new Error("Acknowledge that this primary identifier is common to every XLSForm linked to this MetaForm.");
    }
  }
  const requestedPrimaryIdentifier = String(payload.primaryIdentifierVariable || "").trim();
  if (folderPrimary?.variable && requestedPrimaryIdentifier && requestedPrimaryIdentifier !== folderPrimary.variable) {
    throw new Error(`Forms in this folder must use the shared primary identifier variable "${folderPrimary.variable}".`);
  }
  const primaryIdentifierVariable = String(linkedPrimary?.variable || requestedPrimaryIdentifier || folderPrimary?.variable || "").trim();
  const variableDetails = metaFormLink && primaryIdentifierVariable
    ? await metaFormVariableDetails(metaFormLink.fileName, metaFormLink.formIndex, primaryIdentifierVariable)
    : null;
  if (metaFormLink && !linkedPrimary && !variableDetails) {
    throw new Error(`Primary identifier variable "${primaryIdentifierVariable}" was not found in the selected MetaForm form.`);
  }
  const questions = [];
  const folderBarcodeVariable = folderRecord?.participantIdentifierMode === "barcode"
    ? String(folderRecord.participantIdentifierVariable || DEFAULT_FOLDER_BARCODE_VARIABLE).trim()
    : "";
  if (folderBarcodeVariable) {
    questions.push(sharedBarcodeQuestion(folderBarcodeVariable));
  } else if (metaFormLink && primaryIdentifierVariable) {
    questions.push(copiedPrimaryQuestion(linkedPrimary?.question || variableDetailsToQuestion(variableDetails, primaryIdentifierVariable), primaryIdentifierVariable));
  } else if (folderPrimary?.variable) {
    questions.push(copiedPrimaryQuestion(folderPrimary.question, folderPrimary.variable));
  }
  const effectivePrimaryIdentifierVariable = folderBarcodeVariable || primaryIdentifierVariable;
  const draft = {
    title,
    formId,
    version: payload.version || "1",
    versionNumber: 1,
    versionBaseId,
    folderId,
    metaFormLink,
    primaryIdentifierVariable: effectivePrimaryIdentifierVariable,
    participantIdentifierVariable: folderBarcodeVariable || "",
    terminologyUseLlm: false,
    instanceName: effectivePrimaryIdentifierVariable ? instanceNameForPrimaryIdentifier(effectivePrimaryIdentifierVariable) : "",
    defaultLanguage: "english",
    questions,
    createdAt: isoStamp(),
    updatedAt: isoStamp()
  };
  await store.insertForm({ workspaceId, versionBaseId, versionNumber: 1, folderId, draft });
  return { workspaceId, draft };
}

function readFolders() {
  return store.listFolders();
}

function readParticipantRegistry() {
  return store.listParticipantRegistry();
}

async function createFolder(payload) {
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("Folder name is required.");
  const folders = await readFolders();
  if (folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("A folder with that name already exists.");
  }
  const folder = await store.insertFolder(`${timestampId()}_${slugify(name)}`, name);
  return { ok: true, folder, folders: [...folders, folder] };
}

async function deleteFolder(folderId) {
  const cleanId = String(folderId || "").trim();
  if (!cleanId) throw new Error("Folder id is required.");
  const folders = await readFolders();
  const folder = folders.find((item) => item.id === cleanId);
  if (!folder) throw new Error("Folder not found.");

  const forms = await listForms();
  const deletedWorkspaceIds = forms.forms
    .filter((item) => item.folderId === cleanId)
    .map((item) => item.workspaceId);
  for (const workspaceId of deletedWorkspaceIds) await deleteForm(workspaceId);

  await store.deleteFolder(cleanId);
  return { ok: true, deletedFolder: folder, deletedWorkspaceIds, folders: await readFolders() };
}

async function loadDraft(workspaceId) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const meta = await workspaceMeta(cleanId);
  const draft = { ...(await store.getDraft(cleanId)), terminologyUseLlm: false };
  return { workspaceId: cleanId, draft, ...meta };
}

async function findWorkspaceByRespondentCode(value) {
  const code = cleanRespondentAccessCode(value);
  const found = await store.findOpenFormByAccessCode(code);
  if (!found) {
    const error = new Error("No published form matches that respondent code.");
    error.statusCode = 404;
    throw error;
  }
  return { code, workspaceId: found.workspace_id, draft: found.draft };
}

async function generateUniqueRespondentAccessCode(workspaceId) {
  const currentWorkspaceId = cleanWorkspaceId(workspaceId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = randomRespondentAccessCode();
    const owner = await store.accessCodeOwner(code);
    if (!owner || owner === currentWorkspaceId) return code;
  }
  throw new Error("Could not generate a unique respondent form code.");
}

async function ensureUniqueRespondentAccessCode(code, workspaceId) {
  const cleanCode = cleanRespondentAccessCode(code);
  const owner = await store.accessCodeOwner(cleanCode);
  if (owner && owner !== cleanWorkspaceId(workspaceId)) {
    const error = new Error("That respondent code is already used by another published form.");
    error.statusCode = 409;
    throw error;
  }
  return cleanCode;
}

async function loadPublicForm(value) {
  const found = await findWorkspaceByRespondentCode(value);
  const meta = await workspaceMeta(found.workspaceId);
  if (!meta.hasXml) {
    const error = new Error("That respondent code is not ready for form filling yet.");
    error.statusCode = 404;
    throw error;
  }
  return {
    ok: true,
    accessCode: found.code,
    title: found.draft?.title || meta.title,
    formId: found.draft?.formId || meta.formId,
    hasXml: meta.hasXml,
    draft: found.draft
  };
}

async function listPublicForms() {
  const all = await listForms();
  const forms = [];
  for (const item of all.forms || []) {
    if (!item.hasXml || !item.respondentAccessCode || item.collectionLocked) continue;
    const draft = (await loadDraft(item.workspaceId)).draft;
    const entries = await readEntries(item.workspaceId);
    const checkpoints = await readRespondentCheckpoints(item.workspaceId);
    forms.push({
      workspaceId: item.workspaceId,
      title: item.title,
      formId: item.formId,
      respondentAccessCode: item.respondentAccessCode,
      primaryIdentifierVariable: item.primaryIdentifierVariable,
      participantIdentifierVariable: item.participantIdentifierVariable || item.primaryIdentifierVariable,
      entryCount: entries.length,
      checkpointCount: checkpoints.length,
      checkpoints: checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        primaryIdentifierVariable: checkpoint.primaryIdentifierVariable,
        primaryIdentifierValue: checkpoint.primaryIdentifierValue,
        savedAt: checkpoint.savedAt
      })),
      updatedAt: item.updatedAt,
      publishedAt: item.publishedAt,
      responseSettings: item.responseSettings,
      displayFields: dataHeadersForDraft(draft).map((name) => {
        const question = (draft.questions || []).find((item) => item.name === name);
        return { name, label: question?.label || name };
      }),
      entries
    });
  }
  return { ok: true, forms };
}

async function loadPublicFormEntries(value) {
  const found = await findWorkspaceByRespondentCode(value);
  return {
    ok: true,
    accessCode: found.code,
    workspaceId: found.workspaceId,
    title: found.draft?.title || found.workspaceId,
    entries: await readEntries(found.workspaceId)
  };
}

async function loadPublicFormXml(value) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await loadFormXml(found.workspaceId);
  return { ok: true, accessCode: found.code, xml: data.xml };
}

async function loadPublicAttachment(value, fileName) {
  const found = await findWorkspaceByRespondentCode(value);
  return loadAttachment(found.workspaceId, fileName);
}

async function loadPublicAttachmentList(value) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await listAttachments(found.workspaceId);
  return { ok: true, accessCode: found.code, attachments: data.attachments };
}

async function submitPublicEntry(value, payload, user) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await submitEntry(found.workspaceId, payload, user);
  return { ok: true, accessCode: found.code, entry: data.entry };
}

async function deletePublicEntries(value, payload) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await deleteEntries(found.workspaceId, payload);
  return { ok: true, accessCode: found.code, ...data };
}

async function loadPublicCheckpoint(value, payload) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await loadRespondentCheckpoint(found.workspaceId, payload);
  return { ok: true, accessCode: found.code, ...data };
}

async function savePublicCheckpoint(value, payload) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await saveRespondentCheckpoint(found.workspaceId, payload);
  return { ok: true, accessCode: found.code, ...data };
}

async function submitPublicOdkEntry(value, payload, user) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await submitOdkEntry(found.workspaceId, payload, user);
  return { ok: true, accessCode: found.code, entry: data.entry };
}

async function loadFormXml(workspaceId) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const xml = await store.getFormXml(cleanId);
  if (!xml) throw new Error("Published XML not found for this form.");
  return { ok: true, workspaceId: cleanId, xml };
}

async function loadFormXlsx(workspaceId) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const workbook = await store.getFormXlsx(cleanId);
  if (!workbook) throw new Error("Generated ODK XLS not found for this form.");
  return { ok: true, workspaceId: cleanId, fileName: workbook.fileName, data: workbook.data };
}

async function listAttachments(workspaceId) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const attachments = (await store.listFormAttachments(cleanId))
    .sort((a, b) => a.fileName.localeCompare(b.fileName))
    .map((attachment) => ({
      ...attachment,
      url: `/api/forms/${encodeURIComponent(cleanId)}/attachments/${encodeURIComponent(attachment.fileName)}`
    }));
  return { ok: true, workspaceId: cleanId, attachments };
}

async function uploadAttachment(workspaceId, payload) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const fileName = cleanAttachmentName(payload.filename);
  const data = Buffer.from(String(payload.dataBase64 || ""), "base64");
  if (!data.length) throw new Error("Uploaded attachment is empty.");
  await store.putFormAttachment(cleanId, fileName, data);
  return { ok: true, workspaceId: cleanId, fileName, ...(await listAttachments(cleanId)), ...(await workspaceMeta(cleanId)) };
}

async function deleteAttachment(workspaceId, fileName) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const cleanName = cleanAttachmentName(fileName);
  await store.deleteFormAttachment(cleanId, cleanName);
  return { ok: true, workspaceId: cleanId, deleted: cleanName, ...(await listAttachments(cleanId)), ...(await workspaceMeta(cleanId)) };
}

async function loadAttachment(workspaceId, fileName) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const cleanName = cleanAttachmentName(fileName);
  const data = await store.getFormAttachment(cleanId, cleanName);
  if (!data) throw new Error(`Attachment not found: ${cleanName}`);
  return { fileName: cleanName, contentType: contentTypeFor(cleanName), data };
}

function latestSnomedLookupPath() {
  const lookupRoot = path.join(mapperRoot, "SchemaTerminologies", "artifacts", "shared", "snomed_ct");
  if (!existsSync(lookupRoot)) return null;
  try {
    const versions = readdirSync(lookupRoot)
      .filter((name) => existsSync(path.join(lookupRoot, name, "lookups", "snomed_ct_lookup.csv")))
      .sort((a, b) => a.localeCompare(b));
    const latest = versions.at(-1);
    return latest ? path.join(lookupRoot, latest, "lookups", "snomed_ct_lookup.csv") : null;
  } catch {
    return null;
  }
}

function latestSharedLookupPath(vocabulary, fileName) {
  const lookupRoot = path.join(mapperRoot, "SchemaTerminologies", "artifacts", "shared", vocabulary);
  if (!existsSync(lookupRoot)) return null;
  try {
    const versions = readdirSync(lookupRoot)
      .filter((name) => existsSync(path.join(lookupRoot, name, "lookups", fileName)))
      .sort((a, b) => a.localeCompare(b));
    const latest = versions.at(-1);
    return latest ? path.join(lookupRoot, latest, "lookups", fileName) : null;
  } catch {
    return null;
  }
}

function latestLoincPath() {
  const loincRoot = path.join(mapperRoot, "SchemaTerminologies", "terminologies", "loinc");
  if (!existsSync(loincRoot)) return null;
  try {
    const versions = readdirSync(loincRoot)
      .map((name) => path.join(loincRoot, name, "LoincTable", "Loinc.csv"))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => a.localeCompare(b));
    return versions.at(-1) || null;
  } catch {
    return null;
  }
}

function latestRxNormMetadataPath() {
  const sharedRoot = path.join(mapperRoot, "SchemaTerminologies", "artifacts", "shared", "rxnorm");
  if (existsSync(sharedRoot)) {
    try {
      const sharedMatches = readdirSync(sharedRoot)
        .map((name) => path.join(sharedRoot, name, "lookups", "rxnorm_metadata.json"))
        .filter((candidate) => existsSync(candidate))
        .sort((a, b) => a.localeCompare(b));
      const latestShared = sharedMatches.at(-1);
      if (latestShared) return latestShared;
    } catch {
      // Fall back to the legacy dense-index location below.
    }
  }

  const rxnormRoot = path.join(mapperRoot, "SchemaTerminologies", "artifacts");
  if (!existsSync(rxnormRoot)) return null;
  const matches = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, name.name);
      if (name.isDirectory()) {
        visit(fullPath);
      } else if (name.name === "rxnorm_metadata.json" && fullPath.includes(`${path.sep}rxnorm${path.sep}`)) {
        matches.push(fullPath);
      }
    }
  };
  try {
    visit(rxnormRoot);
    return matches.sort((a, b) => a.localeCompare(b)).at(-1) || null;
  } catch {
    return null;
  }
}

async function fileSummary(filePath) {
  if (!filePath) return { ok: false, path: null, exists: false };
  try {
    const info = await stat(filePath);
    return {
      ok: true,
      path: filePath,
      exists: true,
      sizeBytes: info.size,
      updatedAt: info.mtime.toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      exists: false,
      error: error.message || String(error)
    };
  }
}

async function terminologyAssetsStatus() {
  const metaForms = await store.metaFormTotals();
  const assets = {
    snomed: await fileSummary(latestSnomedLookupPath()),
    icd10: await fileSummary(latestSharedLookupPath("icd10", "icd10_lookup.csv")),
    loinc: await fileSummary(latestLoincPath()),
    rxnorm: await fileSummary(latestRxNormMetadataPath()),
    metaFormChunks: { ok: metaForms.chunkCount > 0, ...metaForms }
  };
  const missing = Object.entries(assets)
    .filter(([, value]) => !value.ok)
    .map(([key]) => key);
  return {
    ok: missing.length === 0,
    mapperRoot,
    schemaTerminologiesRoot: path.join(mapperRoot, "SchemaTerminologies"),
    assets,
    missing
  };
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^()]*\)\s*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTokens(value) {
  const stop = new Set(["a", "an", "and", "as", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with"]);
  return [...new Set(normalizeSearchText(value).split(/\s+/).filter((token) => token.length >= 3 && !stop.has(token)))];
}

function snomedSemanticTag(fsn) {
  const match = String(fsn || "").match(/\(([^()]+)\)\s*$/);
  return match ? match[1].toLowerCase() : "";
}

const VOCABULARY_CONFIG = {
  snomed: {
    key: "snomed",
    label: "SNOMED CT",
    systemUri: "http://snomed.info/sct",
    csvPath: latestSnomedLookupPath,
    fromCsv(values, headerIndex) {
      return {
        code: values[headerIndex.code] || "",
        display: values[headerIndex.display] || "",
        fsn: values[headerIndex.fsn] || "",
        preferredTerm: values[headerIndex.preferred_term] || values[headerIndex.display] || "",
        status: values[headerIndex.status] || "",
        systemUri: values[headerIndex.system_uri] || "http://snomed.info/sct"
      };
    }
  },
  icd10: {
    key: "icd10",
    label: "ICD-10",
    systemUri: "http://hl7.org/fhir/sid/icd-10-cm",
    csvPath: () => latestSharedLookupPath("icd10", "icd10_lookup.csv"),
    fromCsv(values, headerIndex) {
      return {
        code: values[headerIndex.code] || "",
        display: values[headerIndex.display] || "",
        fsn: values[headerIndex.display] || "",
        preferredTerm: values[headerIndex.display] || "",
        status: values[headerIndex.status] || "",
        aliases: values[headerIndex.aliases] || "",
        systemUri: values[headerIndex.system_uri] || "http://hl7.org/fhir/sid/icd-10-cm"
      };
    }
  },
  loinc: {
    key: "loinc",
    label: "LOINC",
    systemUri: "http://loinc.org",
    csvPath: latestLoincPath,
    fromCsv(values, headerIndex) {
      const code = values[headerIndex.LOINC_NUM] || values[headerIndex.loinc_num] || "";
      const longName = values[headerIndex.LONG_COMMON_NAME] || "";
      const shortName = values[headerIndex.SHORTNAME] || "";
      const component = values[headerIndex.COMPONENT] || "";
      return {
        code,
        display: longName || shortName || component,
        fsn: longName || `${component} ${values[headerIndex.PROPERTY] || ""} ${values[headerIndex.SYSTEM] || ""}`.trim(),
        preferredTerm: shortName || longName || component,
        status: values[headerIndex.STATUS] || "",
        systemUri: "http://loinc.org"
      };
    }
  }
};

const vocabularySearchPromises = new Map();

async function loadCsvVocabularyIndex(config) {
  const lookupPath = config.csvPath();
  if (!lookupPath) throw new Error(`Local ${config.label} lookup was not found.`);
    const text = await readFile(lookupPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines.shift() || "");
    const headerIndex = Object.fromEntries(headers.map((name, index) => [name, index]));
    const rows = [];
    const tokenIndex = new Map();
    const exactIndex = new Map();

    for (const line of lines) {
      const values = parseCsvLine(line);
      const row = config.fromCsv(values, headerIndex);
      if (!row.code) continue;
      row.vocabulary = config.key;
      row.vocabularyLabel = config.label;
      row.searchText = normalizeSearchText(`${row.display} ${row.preferredTerm} ${row.fsn} ${row.aliases || ""}`);
      row.tokens = searchTokens(row.searchText);
      const rowIndex = rows.push(row) - 1;
      for (const value of [row.display, row.preferredTerm, row.fsn]) {
        const key = normalizeSearchText(value);
        if (key && !exactIndex.has(key)) exactIndex.set(key, rowIndex);
      }
      for (const token of row.tokens) {
        if (!tokenIndex.has(token)) tokenIndex.set(token, []);
        tokenIndex.get(token).push(rowIndex);
      }
    }
    return { rows, tokenIndex, exactIndex, lookupPath };
}

async function loadRxNormSearchIndex(config) {
  const lookupPath = latestRxNormMetadataPath();
  if (!lookupPath) throw new Error("Local RxNorm lookup metadata was not found.");
  const data = JSON.parse(await readFile(lookupPath, "utf8"));
  const sourceRows = Array.isArray(data.rows) ? data.rows : [];
  const rows = [];
  const tokenIndex = new Map();
  const exactIndex = new Map();

  for (const source of sourceRows) {
    const row = {
      code: String(source.code || ""),
      display: String(source.display || source.indexed_term || ""),
      fsn: String(source.display || source.indexed_term || ""),
      preferredTerm: String(source.display || source.indexed_term || ""),
      status: String(source.status || ""),
      systemUri: String(source.system_uri || config.systemUri),
      vocabulary: config.key,
      vocabularyLabel: config.label
    };
    if (!row.code) continue;
    row.searchText = normalizeSearchText(`${row.display} ${row.preferredTerm} ${row.fsn}`);
    row.tokens = searchTokens(row.searchText);
    const rowIndex = rows.push(row) - 1;
    for (const value of [row.display, row.preferredTerm, row.fsn]) {
      const key = normalizeSearchText(value);
      if (key && !exactIndex.has(key)) exactIndex.set(key, rowIndex);
    }
    for (const token of row.tokens) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(rowIndex);
    }
  }
  return { rows, tokenIndex, exactIndex, lookupPath };
}

async function loadVocabularySearchIndex(vocabulary) {
  const key = normalizeVocabularyKey(vocabulary);
  if (vocabularySearchPromises.has(key)) return vocabularySearchPromises.get(key);
  const config = key === "rxnorm"
    ? { key: "rxnorm", label: "RxNorm", systemUri: "http://rxnorm.info/rxcui" }
    : VOCABULARY_CONFIG[key];
  if (!config) throw new Error(`Unsupported vocabulary: ${vocabulary}`);
  const promise = key === "rxnorm" ? loadRxNormSearchIndex(config) : loadCsvVocabularyIndex(config);
  vocabularySearchPromises.set(key, promise);
  return promise;
}

function normalizeVocabularyKey(value) {
  const text = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (text.includes("loinc")) return "loinc";
  if (text.includes("rxnorm") || text.includes("rxcui")) return "rxnorm";
  if (text.includes("icd")) return "icd10";
  return "snomed";
}

function scoreVocabularyRow(row, query, queryKey, tokens, exactCode) {
  const rowKeys = [row.display, row.preferredTerm, row.fsn].map(normalizeSearchText).filter(Boolean);
  let score = 0;
  if (exactCode && row.code === exactCode) score += 2000;
  if (rowKeys.includes(queryKey)) score += 1000;
  if (rowKeys.some((key) => key.startsWith(queryKey) || queryKey.startsWith(key))) score += 160;
  if (row.searchText.includes(queryKey)) score += 130;
  const rowTokenSet = new Set(row.tokens);
  const overlap = tokens.filter((token) => rowTokenSet.has(token)).length;
  const coverage = tokens.length ? overlap / tokens.length : 0;
  score += overlap * 35 + coverage * 80;
  const preferredKey = normalizeSearchText(row.preferredTerm || row.display);
  if (preferredKey && preferredKey.includes(queryKey)) score += 40;
  const semanticTag = snomedSemanticTag(row.fsn);
  if (["procedure", "finding", "disorder", "situation", "event", "observable entity", "body structure", "substance"].includes(semanticTag)) {
    score += 35;
  }
  if (["physical object", "organism", "environment", "geographic location"].includes(semanticTag)) {
    score -= 55;
  }
  if (String(row.status || "").toLowerCase() === "active") score += 10;
  score -= Math.abs((preferredKey || row.searchText).length - queryKey.length) * (tokens.length === 1 ? 0.75 : 0.12);
  return score;
}

async function searchVocabularyTerms(query, options = {}) {
  const cleanQuery = String(query || "").trim();
  const vocabulary = normalizeVocabularyKey(options.vocabulary || "snomed");
  if (!cleanQuery) return { ok: true, vocabulary, query: cleanQuery, results: [] };
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 50);
  const exactCode = String(options.selectedCode || "").trim();
  const { rows, tokenIndex, exactIndex } = await loadVocabularySearchIndex(vocabulary);
  const queryKey = normalizeSearchText(cleanQuery);
  const tokens = searchTokens(cleanQuery);
  const candidateIds = new Set();

  if (exactIndex.has(queryKey)) candidateIds.add(exactIndex.get(queryKey));
  for (const token of tokens) {
    const postings = tokenIndex.get(token) || [];
    if (postings.length > 50000) continue;
    for (const rowIndex of postings) candidateIds.add(rowIndex);
  }

  if (exactCode) {
    const selectedIndex = rows.findIndex((row) => row.code === exactCode);
    if (selectedIndex >= 0) candidateIds.add(selectedIndex);
  }

  const scored = [...candidateIds]
    .map((rowIndex) => {
      const row = rows[rowIndex];
      return { row, score: scoreVocabularyRow(row, cleanQuery, queryKey, tokens, exactCode) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }, index) => ({
      rank: index + 1,
      code: row.code,
      display: row.preferredTerm || row.display || row.fsn,
      fsn: row.fsn,
      preferredTerm: row.preferredTerm,
      status: row.status,
      systemUri: row.systemUri,
      vocabulary: row.vocabulary || vocabulary,
      vocabularyLabel: row.vocabularyLabel || VOCABULARY_CONFIG[vocabulary]?.label || "Vocabulary",
      score: Number(score.toFixed(2)),
      selected: Boolean(exactCode && row.code === exactCode)
    }));

  return { ok: true, vocabulary, query: cleanQuery, results: scored };
}

async function searchSnomedTerms(query, options = {}) {
  return searchVocabularyTerms(query, { ...options, vocabulary: "snomed" });
}

function defaultTerminologyStatus(workspaceId, status = "not_started") {
  return {
    ok: true,
    workspaceId,
    status,
    startedAt: null,
    completedAt: null,
    questionCount: 0,
    processedQuestionCount: 0,
    entityCount: 0,
    questions: [],
    warnings: []
  };
}

async function loadTerminology(workspaceId) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const run = terminologyRuns.get(cleanId);
  if (run) {
    // The extractor rewrites its result file as it works; that is the live progress.
    try {
      const progress = JSON.parse(await readFile(run.resultPath, "utf8"));
      return { ok: progress.ok !== false, workspaceId: cleanId, ...progress };
    } catch {}
  }
  let data = await store.getTerminology(cleanId);
  if (!data) return defaultTerminologyStatus(cleanId);
  if (data.status === "running" && !run) {
    // The server restarted while the extractor was running.
    data = { ...data, ok: false, status: "error", completedAt: isoStamp(), error: "Terminology extraction was interrupted. Run it again." };
    await store.setTerminology(cleanId, data);
  }
  return { ok: data.ok !== false, workspaceId: cleanId, ...data };
}

async function startTerminologyExtraction(workspaceId, options = {}) {
  const { cleanId } = await requireWorkspace(workspaceId);
  if (await store.formHasXml(cleanId)) {
    throw new Error("Terminology review is locked after publishing. Create a new version to change mappings.");
  }
  const draft = { ...(await store.getDraft(cleanId)), terminologyUseLlm: false, updatedAt: isoStamp() };
  await saveDraft(cleanId, draft);
  const questionIds = Array.isArray(options.questionIds)
    ? [...new Set(options.questionIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];

  if (!options.force) {
    const existing = await loadTerminology(cleanId);
    if (existing.status === "running") {
      return { ...existing, ok: true, workspaceId: cleanId, started: false, reason: "already_running" };
    }
  }
  terminologyRuns.get(cleanId)?.child.kill();

  const initial = {
    ok: true,
    status: "running",
    startedAt: isoStamp(),
    completedAt: null,
    formTitle: "",
    formId: "",
    questionCount: 0,
    processedQuestionCount: 0,
    entityCount: 0,
    questions: [],
    warnings: [],
    rerunQuestionIds: questionIds
  };
  const failure = (message) => ({ ...initial, ok: false, status: "error", completedAt: isoStamp(), error: message });
  await store.setTerminology(cleanId, initial);

  if (!existsSync(mapperPythonBin)) {
    const failed = failure(`Mapper Python environment not found: ${mapperPythonBin}`);
    await store.setTerminology(cleanId, failed);
    return { workspaceId: cleanId, started: false, ...failed };
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "icph-terminology-"));
  const draftPath = path.join(dir, "form.json");
  const resultPath = path.join(dir, "question_entities.json");
  await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  await writeFile(resultPath, JSON.stringify(initial, null, 2) + "\n", "utf8");

  const child = spawn(
    mapperPythonBin,
    [
      terminologyExtractorPath,
      draftPath,
      resultPath,
      "--mapper-root",
      mapperRoot,
      ...(questionIds.length ? ["--question-ids", questionIds.join(","), "--merge-existing"] : [])
    ],
    { cwd: mapperRoot, env: { ...process.env, PYTHONUNBUFFERED: "1" }, stdio: "ignore" }
  );
  terminologyRuns.set(cleanId, { child, resultPath });
  const finish = async (problem) => {
    // A forced re-run replaces this run; only the current one records its result.
    if (terminologyRuns.get(cleanId)?.child === child) {
      let result = null;
      try {
        result = JSON.parse(await readFile(resultPath, "utf8"));
      } catch {}
      const final = result && result.status !== "running" ? result : failure(problem || "Terminology extraction stopped before it finished.");
      try {
        await store.setTerminology(cleanId, final);
      } catch (error) {
        console.error(`Could not save terminology result for ${cleanId}: ${error.message || error}`);
      }
      terminologyRuns.delete(cleanId);
    }
    await rm(dir, { recursive: true, force: true });
  };
  child.once("error", (error) => finish(`Could not start terminology extraction: ${error.message || String(error)}`));
  child.once("close", (code) => finish(code === 0 ? "" : `Terminology extraction exited with code ${code}.`));
  return { ok: true, workspaceId: cleanId, started: true, status: "running" };
}

async function saveTerminologyReview(workspaceId, payload) {
  const { cleanId } = await requireWorkspace(workspaceId);
  if (await store.formHasXml(cleanId)) {
    throw new Error("Terminology review is locked after publishing. Create a new version to change mappings.");
  }
  const terminology = payload?.terminology;
  if (!terminology || typeof terminology !== "object") throw new Error("Terminology review payload is required.");
  if (!(await store.getTerminology(cleanId)) && terminology.status !== "skipped_unmapped") {
    throw new Error("Run terminology extraction before saving vocabulary review.");
  }
  const body = {
    ...terminology,
    ok: terminology.ok !== false,
    workspaceId: cleanId,
    reviewUpdatedAt: isoStamp()
  };
  delete body.terminologyPath;
  await store.setTerminology(cleanId, body);
  return { ...body, ok: true, workspaceId: cleanId };
}

async function createFormVersion(workspaceId) {
  const loaded = await loadDraft(workspaceId);
  const sourceId = loaded.workspaceId;
  const sourceDraft = loaded.draft;
  const split = splitWorkspaceVersion(sourceDraft.versionBaseId || sourceId);
  const versionBaseId = sourceDraft.versionBaseId || split.baseId;
  const nextVersionNumber = Math.max(
    await store.maxVersionNumber(versionBaseId),
    splitWorkspaceVersion(sourceId).versionNumber
  ) + 1;
  const nextWorkspaceId = `${versionBaseId}_v${nextVersionNumber}`;
  const now = isoStamp();
  const nextDraft = {
    ...sourceDraft,
    version: String(nextVersionNumber),
    versionNumber: nextVersionNumber,
    versionBaseId,
    previousVersionWorkspaceId: sourceId,
    previousVersionNumber: sourceDraft.versionNumber || splitWorkspaceVersion(sourceId).versionNumber,
    versionBaseline: formBuildSnapshot(sourceDraft),
    versionChangeSummary: [],
    createdAt: now,
    updatedAt: now
  };
  delete nextDraft.buildFinishedAt;
  delete nextDraft.publishedAt;
  delete nextDraft.respondentAccessCode;
  delete nextDraft.publicAccessCode;
  delete nextDraft.respondentCodeMode;
  await withTransaction(async () => {
    await store.insertForm({
      workspaceId: nextWorkspaceId,
      versionBaseId,
      versionNumber: nextVersionNumber,
      folderId: String(nextDraft.folderId || "").trim() || null,
      draft: nextDraft
    });
    await store.copyFormAttachments(sourceId, nextWorkspaceId);
    const sourceTerminology = await store.getTerminology(sourceId);
    if (sourceTerminology) {
      await store.setTerminology(nextWorkspaceId, {
        ...sourceTerminology,
        workspaceId: nextWorkspaceId,
        copiedFromWorkspaceId: sourceId,
        copiedAt: now
      });
    }
  });
  return loadDraft(nextWorkspaceId);
}

async function updateResponseSettings(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  if (!loaded.hasXml) {
    throw new Error("Participant identifier settings can be changed after the form is published.");
  }
  const responseSettings = normalizeResponseSettings(payload || {});
  if (responseSettings.participantIdentifierVariable) {
    const question = (loaded.draft.questions || []).find((item) => item.name === responseSettings.participantIdentifierVariable);
    if (!question) throw new Error("Choose a participant identifier question that exists in this form.");
    if (question.name !== loaded.draft.primaryIdentifierVariable && question.type !== "barcode") {
      throw new Error("Choose the form primary identifier or a barcode question.");
    }
  }
  const draft = {
    ...loaded.draft,
    ...responseSettings,
    updatedAt: isoStamp()
  };
  await saveDraft(loaded.workspaceId, draft);
  return { ok: true, workspaceId: loaded.workspaceId, draft, ...(await workspaceMeta(loaded.workspaceId)) };
}

async function updateCollectionAccess(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const draft = {
    ...loaded.draft,
    collectionLocked: Boolean(payload?.collectionLocked),
    updatedAt: isoStamp()
  };
  await saveDraft(loaded.workspaceId, draft);
  return { ok: true, workspaceId: loaded.workspaceId, draft, ...(await workspaceMeta(loaded.workspaceId)) };
}

async function updateTerminologySettings(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  if (loaded.hasXml) {
    throw new Error("Terminology settings are locked after publishing. Create a new version to change them.");
  }
  const draft = {
    ...loaded.draft,
    terminologyUseLlm: false,
    updatedAt: isoStamp()
  };
  await saveDraft(loaded.workspaceId, draft);
  return { ok: true, workspaceId: loaded.workspaceId, draft, ...(await workspaceMeta(loaded.workspaceId)) };
}

async function checkpointForm(payload) {
  const { cleanId: workspaceId } = await requireWorkspace(payload.workspaceId);
  const draft = { ...payload.form, terminologyUseLlm: false, updatedAt: isoStamp() };
  await withTransaction(async () => {
    await saveDraft(workspaceId, draft);
    await store.insertFormCheckpoint(workspaceId, draft);
  });
  return { ok: true, workspaceId, draft, ...(await workspaceMeta(workspaceId)) };
}

async function exportForm(payload) {
  const { cleanId: workspaceId } = await requireWorkspace(payload.workspaceId);
  const draft = { ...payload.form, terminologyUseLlm: false, updatedAt: isoStamp() };
  const existingMeta = await workspaceMeta(workspaceId);
  const firstPublish = !existingMeta.hasXml;
  const folderId = String(draft.folderId || "").trim();
  const folderPrimary = folderId ? await folderPrimaryDetails(folderId) : null;
  const folder = folderId ? (await readFolders()).find((item) => item.id === folderId) : null;
  const participantRegistry = folder?.participantIdentifierMode === "barcode" ? await readParticipantRegistry() : [];
  const isBarcodeAssignmentSource = participantRegistry.some((item) => item.workspaceId === workspaceId);
  const folderBarcodeModeForForm = folder?.participantIdentifierMode === "barcode" && !isBarcodeAssignmentSource;
  if (folderPrimary?.variable && draft.primaryIdentifierVariable && draft.primaryIdentifierVariable !== folderPrimary.variable && !folderBarcodeModeForForm) {
    throw new Error(`Forms in this folder must use the shared primary identifier variable "${folderPrimary.variable}".`);
  }
  if (firstPublish && folderId && !folderPrimary?.variable && !draft.primaryIdentifierAcknowledged) {
    throw new Error("Acknowledge that this primary identifier is common to every form created in this folder.");
  }
  if (!existingMeta.hasXml && draft.previousVersionWorkspaceId && !formHasVersionChanges(draft)) {
    throw new Error("Edit at least one Build item before publishing a new version.");
  }
  if (draft.previousVersionWorkspaceId) {
    draft.versionChangeSummary = describeVersionChanges(draft);
  }
  if (folderBarcodeModeForForm) {
    const barcodeQuestion = (draft.questions || []).find((item) => item?.type === "barcode" && String(item.name || "").trim());
    if (!barcodeQuestion) {
      throw new Error("This folder now uses assigned participant barcodes. Add a Barcode question before publishing this form.");
    }
    draft.primaryIdentifierVariable = barcodeQuestion.name;
    draft.participantIdentifierVariable = barcodeQuestion.name;
  }
  if (draft.primaryIdentifierVariable) {
    const identifierIssue = primaryIdentifierProblem(draft.questions || [], draft.primaryIdentifierVariable);
    if (identifierIssue) throw new Error(identifierIssue);
    draft.instanceName = instanceNameForPrimaryIdentifier(draft.primaryIdentifierVariable);
  }
  if (!draft.participantIdentifierVariable) {
    draft.participantIdentifierVariable = draft.primaryIdentifierVariable || "";
  }
  delete draft.primaryIdentifierAcknowledged;
  const requestedRespondentAccessCode = draft.respondentAccessCode || draft.publicAccessCode || "";
  const respondentAccessCode = firstPublish
    ? requestedRespondentAccessCode
      ? await ensureUniqueRespondentAccessCode(requestedRespondentAccessCode, workspaceId)
      : await generateUniqueRespondentAccessCode(workspaceId)
    : draft.respondentAccessCode || draft.publicAccessCode || null;
  if (firstPublish) {
    delete draft.respondentAccessCode;
    delete draft.publicAccessCode;
    delete draft.publishedAt;
  } else if (respondentAccessCode) {
    draft.respondentAccessCode = respondentAccessCode;
  }
  const baseName = slugify(draft.formId || draft.title);

  await saveDraft(workspaceId, draft);
  const built = await withScratchDir(async (dir) => {
    const draftPath = path.join(dir, "form.json");
    const xlsDir = path.join(dir, "xlsform");
    const xlsxPath = path.join(xlsDir, `${baseName}.xlsx`);
    const xmlPath = path.join(dir, `${baseName}.xml`);
    await mkdir(xlsDir);
    await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
    const exportResult = await runCommand(pythonBin, [exporterPath, draftPath, xlsxPath]);
    const attachments = await store.readFormAttachments(workspaceId);
    if (exportResult.code !== 0) return { exportResult, attachmentCount: attachments.length };
    const xlsx = await readFile(xlsxPath);
    // xls2xform looks for media and CSV lists beside the workbook.
    for (const attachment of attachments) {
      await writeFile(path.join(xlsDir, attachment.fileName), attachment.data);
    }
    let xmlResult = { code: 1, stdout: "", stderr: "xls2xform not found" };
    if (existsSync(xls2xformBin)) {
      xmlResult = await runCommand(xls2xformBin, [xlsxPath, xmlPath]);
    }
    const xml = xmlResult.code === 0 && existsSync(xmlPath)
      ? withStartGeopointInputs(draft, await readFile(xmlPath, "utf8"))
      : null;
    return { exportResult, xmlResult, xlsx, xml, attachmentCount: attachments.length };
  });
  const { exportResult } = built;
  if (exportResult.code !== 0) {
    return {
      ok: false,
      stage: "xlsx",
      stdout: exportResult.stdout,
      stderr: exportResult.stderr
    };
  }

  const { xmlResult } = built;
  const xmlOk = built.xml !== null;
  await withTransaction(async () => {
    await store.setFormXlsx(workspaceId, `${baseName}.xlsx`, built.xlsx);
    if (xmlOk) await store.setFormXml(workspaceId, `${baseName}.xml`, built.xml);
    if (firstPublish && xmlOk) {
      if (folderId && draft.primaryIdentifierVariable) {
        await claimFolderPrimaryIdentifier(folderId, draft.primaryIdentifierVariable);
      }
      if (draft.metaFormLink?.fileName && draft.primaryIdentifierVariable) {
        await claimMetaFormPrimary(draft.metaFormLink.fileName, draft.primaryIdentifierVariable);
      }
      draft.respondentAccessCode = respondentAccessCode;
      draft.respondentCodeMode = draft.respondentCodeMode === "custom" ? "custom" : "random";
      draft.publishedAt = draft.publishedAt || isoStamp();
      await saveDraft(workspaceId, draft);
    }
  });
  const terminology = xmlOk && (await store.getTerminology(workspaceId))
    ? await loadTerminology(workspaceId)
    : null;

  return {
    ok: xmlOk,
    stage: xmlOk ? "complete" : "xml",
    attachmentCount: built.attachmentCount,
    terminology,
    draft,
    stdout: `${exportResult.stdout}\n${xmlResult.stdout}`.trim(),
    stderr: `${exportResult.stderr}\n${xmlResult.stderr}`.trim(),
    ...(await workspaceMeta(workspaceId))
  };
}

async function inspectXlsx(payload) {
  const originalName = cleanXlsxName(payload.filename);
  const data = String(payload.dataBase64 || "");
  if (!data) throw new Error("Missing XLSX upload data.");

  return withScratchDir(async (dir) => {
    const tempPath = path.join(dir, originalName);
    await writeFile(tempPath, Buffer.from(data, "base64"));
    const inspectResult = await runCommand(pythonBin, [inspectorPath, tempPath]);
    if (inspectResult.code !== 0) {
      return {
        ok: false,
        stage: "inspect",
        stdout: inspectResult.stdout,
        stderr: inspectResult.stderr || "Could not inspect XLSForm."
      };
    }
    const inspected = JSON.parse(inspectResult.stdout || "{}");
    return { ok: true, filename: originalName, ...inspected };
  });
}

function normalizeMetaFormLink(payload) {
  const linkedMetaFormFileName = String(
    payload.linkedMetaFormFileName ||
    payload.linkedMetaForm?.fileName ||
    ""
  ).trim();
  if (!linkedMetaFormFileName) return null;
  return {
    fileName: linkedMetaFormFileName,
    formIndex: payload.metaFormFormIndex ? Number(payload.metaFormFormIndex) : null,
    formTitle: String(payload.metaFormFormTitle || "").trim(),
    linkedAt: isoStamp()
  };
}

async function existingMetaFormPrimary(fileName) {
  const cleanName = String(fileName || "").trim();
  if (!cleanName) return null;
  const persistedPrimaries = await readMetaFormPrimaries();
  const persistedVariable = String(persistedPrimaries[cleanName] || "").trim();
  if (persistedVariable) {
    const forms = await listForms();
    const source = forms.forms.find((item) => item.metaFormLink?.fileName === cleanName && item.primaryIdentifierVariable === persistedVariable);
    let question = null;
    if (source) {
      try {
        const loaded = await loadDraft(source.workspaceId);
        question = (loaded.draft.questions || []).find((item) => item.name === persistedVariable) || null;
      } catch {}
    }
    return { variable: persistedVariable, question };
  }
  const published = (await listForms()).forms.find((item) => (
    item.metaFormLink?.fileName === cleanName && item.hasXml && String(item.primaryIdentifierVariable || "").trim()
  ));
  if (!published) return null;
  const draft = await store.getDraft(published.workspaceId);
  const variable = String(published.primaryIdentifierVariable).trim();
  const question = (draft?.questions || []).find((item) => item.name === variable) || null;
  return { variable, question, workspaceId: published.workspaceId, title: draft?.title || published.workspaceId };
}

async function metaFormVariableDetails(fileName, formIndex, variable) {
  const cleanName = String(fileName || "").trim();
  const targetFormIndex = Number(formIndex || 0);
  const targetVariable = String(variable || "").trim();
  if (!cleanName || !targetFormIndex || !targetVariable) return null;
  for (const chunk of (await store.getMetaFormChunks(cleanName)) || []) {
    if (chunk.chunk_type !== "variable") continue;
    if (Number(chunk.form_index || 0) !== targetFormIndex) continue;
    if (String(chunk.variable || "").trim() !== targetVariable) continue;
    return {
      name: targetVariable,
      label: chunk.question || targetVariable,
      formatOptions: chunk.format_options || "",
      instructions: chunk.instructions || "",
      formTitle: chunk.form_title || ""
    };
  }
  return null;
}

function variableDetailsToQuestion(details, variable) {
  const format = String(details?.formatOptions || "").toLowerCase();
  let type = "text";
  if (/date and time|datetime|hh:mm/.test(format)) type = "dateTime";
  else if (/date|dd-mm-yyyy/.test(format)) type = "date";
  else if (/decimal/.test(format)) type = "decimal";
  else if (/numeric|number|integer|range/.test(format)) type = "integer";
  return {
    type,
    name: variable,
    label: details?.label || variable,
    hint: details?.instructions || "",
    required: true
  };
}

function copiedPrimaryQuestion(sourceQuestion, variable) {
  const base = sourceQuestion && typeof sourceQuestion === "object"
    ? sourceQuestion
    : {
        type: "text",
        name: variable,
        label: `Primary identifier ${variable}`,
        hint: "",
        required: true
      };
  return {
    ...base,
    id: `meta_primary_${slugify(variable)}_${timestampId()}`,
    name: variable,
    required: base.required !== false
  };
}

async function importXlsx(payload) {
  const originalName = cleanXlsxName(payload.filename);
  const title = originalName.replace(/\.[^.]+$/, "");
  const versionBaseId = `${timestampId()}_${slugify(title)}`;
  const workspaceId = `${versionBaseId}_v1`;
  const data = String(payload.dataBase64 || "");
  if (!data) throw new Error("Missing XLSX upload data.");
  const xlsx = Buffer.from(data, "base64");

  const { importResult, draft } = await withScratchDir(async (dir) => {
    const xlsxPath = path.join(dir, originalName);
    const draftPath = path.join(dir, "form.json");
    await writeFile(xlsxPath, xlsx);
    const result = await runCommand(pythonBin, [importerPath, xlsxPath, draftPath]);
    return { importResult: result, draft: result.code === 0 ? JSON.parse(await readFile(draftPath, "utf8")) : null };
  });
  if (importResult.code !== 0) {
    return {
      ok: false,
      stage: "import",
      stdout: importResult.stdout,
      stderr: importResult.stderr
    };
  }
  const metaFormLink = normalizeMetaFormLink(payload);
  const linkedPrimary = metaFormLink ? await existingMetaFormPrimary(metaFormLink.fileName) : null;
  const folderId = String(payload.folderId || "").trim() || null;
  const folderPrimary = folderId ? await folderPrimaryDetails(folderId) : null;
  const folderRecord = folderId ? (await readFolders()).find((item) => item.id === folderId) : null;
  if (metaFormLink) {
    if (!metaFormLink.formIndex) throw new Error("Choose which form in the linked MetaForm this XLSForm represents.");
    if (!payload.primaryIdentifierAcknowledged) {
      throw new Error("Acknowledge that this primary identifier is common to every XLSForm linked to this MetaForm.");
    }
  }
  const variableNames = new Set((draft.questions || []).map((question) => question.name).filter(Boolean));
  const requestedPrimaryIdentifier = String(payload.primaryIdentifierVariable || "").trim();
  const folderBarcodeVariable = folderRecord?.participantIdentifierMode === "barcode"
    ? String(folderRecord.participantIdentifierVariable || DEFAULT_FOLDER_BARCODE_VARIABLE).trim()
    : "";
  if (folderPrimary?.variable && requestedPrimaryIdentifier && requestedPrimaryIdentifier !== folderPrimary.variable && !folderBarcodeVariable) {
    throw new Error(`Forms in this folder must use the shared primary identifier variable "${folderPrimary.variable}".`);
  }
  if (folderId && !folderPrimary?.variable && !folderBarcodeVariable && !payload.primaryIdentifierAcknowledged) {
    throw new Error("Acknowledge that this primary identifier is common to every form created in this folder.");
  }
  const primaryIdentifierVariable = String(folderBarcodeVariable || linkedPrimary?.variable || folderPrimary?.variable || requestedPrimaryIdentifier || "").trim();
  if (!primaryIdentifierVariable) throw new Error("Choose the primary identifier variable for this XLSForm.");
  if (!variableNames.has(primaryIdentifierVariable)) {
    if (folderBarcodeVariable) {
      draft.questions = [sharedBarcodeQuestion(folderBarcodeVariable), ...(draft.questions || [])];
      variableNames.add(folderBarcodeVariable);
    } else if ((linkedPrimary || folderPrimary) && payload.addMissingPrimaryIdentifier) {
      draft.questions = [copiedPrimaryQuestion(linkedPrimary?.question || folderPrimary?.question, primaryIdentifierVariable), ...(draft.questions || [])];
      variableNames.add(primaryIdentifierVariable);
    } else {
      throw new Error(`Primary identifier variable "${primaryIdentifierVariable}" is not present in the XLSForm survey name column.`);
    }
  }
  if (folderBarcodeVariable && !variableNames.has(folderBarcodeVariable)) {
    draft.questions = [
      ...(draft.questions || []).slice(0, 1),
      sharedBarcodeQuestion(folderBarcodeVariable),
      ...(draft.questions || []).slice(1)
    ];
    variableNames.add(folderBarcodeVariable);
  }
  if (folderBarcodeVariable) {
    draft.questions = (draft.questions || []).filter((question) => question.name !== primaryIdentifierVariable || question.name === folderBarcodeVariable);
  }
  const effectivePrimaryIdentifierVariable = folderBarcodeVariable || primaryIdentifierVariable;
	  const updatedDraft = {
	    ...draft,
		    importedFrom: originalName,
	    metaFormLink,
	    folderId,
	    primaryIdentifierVariable: effectivePrimaryIdentifierVariable,
	    participantIdentifierVariable: folderBarcodeVariable || "",
	    terminologyUseLlm: false,
	    instanceName: instanceNameForPrimaryIdentifier(primaryIdentifierVariable),
		    versionNumber: 1,
	    versionBaseId,
	    createdAt: isoStamp(),
	    updatedAt: isoStamp()
	  };
  await store.insertForm({ workspaceId, versionBaseId, versionNumber: 1, folderId, draft: updatedDraft, xlsxName: originalName, xlsx });

  return {
    ok: true,
    stage: "imported",
    workspaceId,
    attachmentCount: 0,
    draft: updatedDraft,
    stdout: importResult.stdout.trim(),
    stderr: importResult.stderr.trim(),
    ...(await workspaceMeta(workspaceId))
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function entryValue(value) {
  if (Array.isArray(value)) return value.join(" | ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value ?? "";
}

function formatEntryDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const pad = (item) => String(item).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}

function entryInstanceName(draft, answers, submittedAt) {
  const primaryIdentifier = String(
    draft?.primaryIdentifierVariable
    || ""
  ).trim();
  const primaryValue = String(entryValue(answers?.[primaryIdentifier]) || "").trim();
  if (primaryIdentifier && primaryValue) {
    return `${primaryValue} - ${formatEntryDateTime(submittedAt)}`;
  }
  return String(answers?.instanceName || "").trim();
}

function readEntries(workspaceId) {
  return store.listEntries(cleanWorkspaceId(workspaceId));
}

function cleanCheckpointIdentifier(value) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error("Enter the primary identifier value for this form.");
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function checkpointIdentifierKey(value) {
  return cleanCheckpointIdentifier(value).toLowerCase();
}

function readRespondentCheckpoints(workspaceId) {
  return store.listRespondentCheckpoints(cleanWorkspaceId(workspaceId));
}

async function loadRespondentCheckpoint(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const primaryIdentifierVariable = participantIdentifierForDraft(loaded.draft);
  if (!primaryIdentifierVariable) throw new Error("This form does not have a primary identifier variable.");
  const primaryIdentifierValue = cleanCheckpointIdentifier(payload.primaryIdentifierValue);
  const key = checkpointIdentifierKey(primaryIdentifierValue);
  const checkpoint = await store.getRespondentCheckpoint(loaded.workspaceId, key);
  return {
    workspaceId,
    primaryIdentifierVariable,
    primaryIdentifierValue,
    checkpoint
  };
}

async function deleteRespondentCheckpoint(workspaceId, primaryIdentifierValue) {
  if (!String(primaryIdentifierValue || "").trim()) return;
  await store.deleteRespondentCheckpoint(cleanWorkspaceId(workspaceId), checkpointIdentifierKey(primaryIdentifierValue));
}

async function saveRespondentCheckpoint(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const primaryIdentifierVariable = participantIdentifierForDraft(loaded.draft);
  if (!primaryIdentifierVariable) throw new Error("This form does not have a primary identifier variable.");
  const answers = payload.answers && typeof payload.answers === "object" ? payload.answers : {};
  const primaryIdentifierValue = cleanCheckpointIdentifier(
    payload.primaryIdentifierValue || answers[primaryIdentifierVariable]
  );
  const now = isoStamp();
  const key = checkpointIdentifierKey(primaryIdentifierValue);
  const previous = await store.getRespondentCheckpoint(loaded.workspaceId, key);
  const checkpoint = {
    id: previous?.id || `${timestampId()}_${Math.random().toString(36).slice(2, 8)}`,
    workspaceId,
    primaryIdentifierVariable,
    primaryIdentifierValue,
    primaryIdentifierKey: key,
    savedAt: now,
    answers: {
      ...answers,
      [primaryIdentifierVariable]: primaryIdentifierValue
    }
  };
  await store.putRespondentCheckpoint(loaded.workspaceId, key, checkpoint);
  return { workspaceId, primaryIdentifierVariable, primaryIdentifierValue, checkpoint };
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlLeafName(tagName) {
  return String(tagName || "").replace(/^.*:/, "");
}

function extractSimpleAnswersFromXml(instanceXml) {
  const answers = {};
  const text = String(instanceXml || "");
  const leafPattern = /<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  let match = null;
  while ((match = leafPattern.exec(text))) {
    const name = xmlLeafName(match[1]);
    if (!name || name === "instanceID" || name === "deprecatedID") continue;
    const value = decodeXmlEntities(match[2]).trim();
    if (answers[name] === undefined) {
      answers[name] = value;
    } else if (Array.isArray(answers[name])) {
      answers[name].push(value);
    } else {
      answers[name] = [answers[name], value];
    }
  }
  return answers;
}

function primaryIdentifierForDraft(draft) {
  return String(draft?.primaryIdentifierVariable || "").trim();
}

function participantIdentifierForDraft(draft) {
  return String(draft?.participantIdentifierVariable || draft?.primaryIdentifierVariable || "").trim();
}

function repeatAnswerValue(answers = {}, name, repeatIndex) {
  const indexed = answers[`${name}__repeat_${repeatIndex}`];
  if (indexed !== undefined && indexed !== null) return indexed;
  const values = answers[name];
  if (Array.isArray(values)) return values[repeatIndex - 1] ?? "";
  return repeatIndex === 1 ? values ?? "" : "";
}

function demographicParticipantRows(draft = {}, entries = [], registry = []) {
  const questions = draft.questions || [];
  const definitions = [];
  for (let index = 0; index < questions.length; index += 1) {
    const repeat = questions[index];
    if (repeat.type !== "begin_repeat" || !repeat.demographicData) continue;
    const endIndex = findRepeatEndForServer(questions, index);
    const children = questions.slice(index + 1, endIndex).filter((question) => question.name);
    const generatedQuestion = children.find((question) => question.demographicGeneratedId) || null;
    definitions.push({ repeat, children, generatedQuestion });
    index = endIndex;
  }
  const rows = [];
  for (const entry of entries) {
    for (const definition of definitions) {
      const observedCount = definition.children.reduce((max, question) => {
        const values = entry.answers?.[question.name];
        const indexed = Object.keys(entry.answers || {})
          .map((key) => key.match(new RegExp(`^${escapeRegExpServer(question.name)}__repeat_(\\d+)$`))?.[1])
          .filter(Boolean)
          .map(Number);
        return Math.max(max, Array.isArray(values) ? values.length : 0, ...indexed);
      }, 0);
      const configuredCount = /^\d+$/.test(String(definition.repeat.repeatCount || "").trim())
        ? Number(definition.repeat.repeatCount)
        : 0;
      const count = Math.max(1, observedCount, configuredCount);
      for (let repeatIndex = 1; repeatIndex <= count; repeatIndex += 1) {
        const id = `${entry.id}:${definition.repeat.name || "repeat"}:${repeatIndex}`;
        const assignment = registry.find((item) => item.id === id);
        rows.push({
          id,
          entryId: entry.id,
          submittedAt: entry.submittedAt,
          repeatName: definition.repeat.name || "repeat",
          repeatLabel: definition.repeat.label || definition.repeat.name || "Demographic member",
          repeatIndex,
          householdIdentifier: String(entryValue(entry.answers?.[draft.primaryIdentifierVariable]) || "").trim(),
          memberIdentifier: definition.generatedQuestion
            ? String(entryValue(repeatAnswerValue(entry.answers || {}, definition.generatedQuestion.name, repeatIndex)) || "").trim()
            : "",
          displayAnswers: Object.fromEntries(definition.children.map((question) => [
            question.name,
            repeatAnswerValue(entry.answers || {}, question.name, repeatIndex)
          ])),
          barcode: assignment?.barcode || "",
          assignedAt: assignment?.assignedAt || null
        });
      }
    }
  }
  return rows;
}

function escapeRegExpServer(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRepeatEndForServer(questions, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < questions.length; index += 1) {
    if (questions[index]?.type === "begin_repeat") depth += 1;
    if (questions[index]?.type === "end_repeat") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return questions.length;
}

async function listParticipantAssignments(workspaceId) {
  const loaded = await loadDraft(workspaceId);
  const entries = await readEntries(workspaceId);
  const registry = await readParticipantRegistry();
  const options = [];
  const questions = loaded.draft.questions || [];
  for (let index = 0; index < questions.length; index += 1) {
    if (questions[index]?.type !== "begin_repeat" || !questions[index]?.demographicData) continue;
    const endIndex = findRepeatEndForServer(questions, index);
    for (const question of questions.slice(index + 1, endIndex)) {
      if (question?.name && !structuralQuestionTypes.has(question.type) && !options.some((option) => option.name === question.name)) {
        options.push({ name: question.name, label: question.label || question.name });
      }
    }
    index = endIndex;
  }
  return {
    ok: true,
    workspaceId: loaded.workspaceId,
    rows: demographicParticipantRows(loaded.draft, entries, registry),
    options
  };
}

async function activateFolderBarcodeParticipantIdentifier(workspaceId, payload = {}) {
  const loaded = await loadDraft(workspaceId);
  const folderId = String(loaded.draft.folderId || "").trim();
  if (!folderId) throw new Error("This demographic form is not part of a folder.");
  const folderForms = (await listForms()).forms.filter((item) => item.folderId === folderId);
  const sourceWorkspaceIds = new Set(folderForms.map((item) => item.workspaceId));
  const registry = await readParticipantRegistry();
  if (!registry.some((item) => sourceWorkspaceIds.has(item.workspaceId))) {
    throw new Error("Assign at least one participant barcode before changing the participant identifier.");
  }
  const variable = String(payload.participantIdentifierVariable || "").trim();
  await enableFolderBarcodeParticipantMode(folderId, variable);
  return {
    ok: true,
    folderId,
    participantIdentifierVariable: (await readFolders()).find((folder) => folder.id === folderId)?.participantIdentifierVariable || DEFAULT_FOLDER_BARCODE_VARIABLE,
    rows: demographicParticipantRows(loaded.draft, await readEntries(workspaceId), registry)
  };
}

async function assignParticipantBarcode(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const entryId = String(payload?.entryId || "").trim();
  const repeatName = String(payload?.repeatName || "").trim();
  const repeatIndex = Number(payload?.repeatIndex);
  const barcode = String(payload?.barcode || "").trim();
  if (!entryId || !repeatName || !Number.isInteger(repeatIndex) || repeatIndex < 1) throw new Error("Choose a demographic participant before assigning a barcode.");
  if (!barcode) throw new Error("Scan or enter a barcode before assigning it.");
  const rows = demographicParticipantRows(loaded.draft, await readEntries(workspaceId), await readParticipantRegistry());
  const row = rows.find((item) => item.entryId === entryId && item.repeatName === repeatName && item.repeatIndex === repeatIndex);
  if (!row) throw new Error("That demographic participant could not be found.");
  const registry = await readParticipantRegistry();
  const duplicate = registry.find((item) => item.barcode.toLowerCase() === barcode.toLowerCase() && item.id !== row.id);
  if (duplicate) throw new Error(`Barcode ${barcode} is already assigned to another participant.`);
  const record = {
    id: row.id,
    barcode,
    workspaceId: loaded.workspaceId,
    formId: loaded.draft.formId || loaded.draft.title || loaded.workspaceId,
    entryId,
    repeatName,
    repeatIndex,
    householdIdentifier: row.householdIdentifier,
    memberIdentifier: row.memberIdentifier,
    assignedAt: isoStamp()
  };
  const next = [...registry.filter((item) => item.id !== row.id), record];
  await store.putParticipantAssignment(record);
  return { ok: true, assignment: record, rows: demographicParticipantRows(loaded.draft, await readEntries(workspaceId), next) };
}

async function assertAssignedParticipantBarcode(draft, barcode) {
  if (String(draft?.participantIdentifierVariable || "").trim()) {
    const question = (draft.questions || []).find((item) => item.name === draft.participantIdentifierVariable);
    if (question?.type === "barcode") {
      const records = await readParticipantRegistry();
      if (!records.some((item) => String(item.barcode || "").toLowerCase() === String(barcode || "").trim().toLowerCase())) {
        const error = new Error("This barcode has not been assigned to an eligible participant yet.");
        error.statusCode = 409;
        throw error;
      }
    }
  }
}

function mapperHeadersForDraft(draft) {
  return dataHeadersForDraft(draft);
}

function buildMapperCsv(workspaceId, draft, entries) {
  const headers = mapperHeadersForDraft(draft);
  const primaryIdentifierVariable = primaryIdentifierForDraft(draft);
  if (!primaryIdentifierVariable) {
    throw new Error("Choose a primary identifier variable before running FHIR creation.");
  }
  if (!headers.includes(primaryIdentifierVariable)) {
    throw new Error(`Primary identifier variable "${primaryIdentifierVariable}" is not present in this form.`);
  }
  for (const entry of entries) {
    if (!String(entryValue(entry.answers?.[primaryIdentifierVariable])).trim()) {
      throw new Error(`Every submitted entry must include the primary identifier "${primaryIdentifierVariable}" before FHIR creation.`);
    }
  }
  const rows = [headers.map(csvEscape).join(",")];
  for (const entry of entries) {
    rows.push(headers.map((header) => csvEscape(entryValue(entry.answers?.[header]))).join(","));
  }
  return {
    csvName: `${slugify(draft?.formId || draft?.title || workspaceId)}-generic-fhir.csv`,
    csv: rows.join("\n") + "\n",
    primaryIdentifierVariable
  };
}

function primaryIdentifierEntryKey(draft, answers = {}) {
  const primaryIdentifierVariable = participantIdentifierForDraft(draft);
  if (!primaryIdentifierVariable) return "";
  return String(entryValue(answers?.[primaryIdentifierVariable]) || "").trim().toLowerCase();
}

async function assertEntryMutationAllowed(draft, entries, answers, entryId = "") {
  const settings = normalizeResponseSettings(draft);
  const requestedEntryId = String(entryId || "").trim();
  if (requestedEntryId && !settings.allowResponseEdits) {
    const error = new Error("Responses cannot be changed after submission for this form.");
    error.statusCode = 403;
    throw error;
  }
  const primaryIdentifierVariable = participantIdentifierForDraft(draft);
  const primaryKey = primaryIdentifierEntryKey(draft, answers);
  const participantQuestion = (draft.questions || []).find((item) => item.name === primaryIdentifierVariable);
  if (participantQuestion?.type === "barcode" && !primaryKey) {
    const error = new Error(`Enter the barcode in ${primaryIdentifierVariable} before submitting.`);
    error.statusCode = 400;
    throw error;
  }
  await assertAssignedParticipantBarcode(draft, primaryKey);
  if (settings.limitOneResponsePerIdentifier && primaryIdentifierVariable && primaryKey) {
    const duplicate = entries.find((entry) =>
      String(entry.id || "") !== requestedEntryId &&
      primaryIdentifierEntryKey(draft, entry.answers || {}) === primaryKey
    );
    if (duplicate) {
      const error = new Error(`One ${primaryIdentifierVariable} can submit only one response for this form.`);
      error.statusCode = 409;
      throw error;
    }
  }
}

async function deleteEntries(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const ids = new Set((Array.isArray(payload?.entryIds) ? payload.entryIds : [payload?.entryId])
    .map((item) => String(item || "").trim())
    .filter(Boolean));
  if (!ids.size) {
    const error = new Error("Choose at least one entry to delete.");
    error.statusCode = 400;
    throw error;
  }
  const existing = await readEntries(loaded.workspaceId);
  const entries = existing.filter((entry) => !ids.has(String(entry.id || "")));
  if (entries.length === existing.length) {
    const error = new Error("No matching entries were found.");
    error.statusCode = 404;
    throw error;
  }
  await store.deleteEntries(loaded.workspaceId, [...ids]);
  return {
    ok: true,
    workspaceId: loaded.workspaceId,
    deletedCount: existing.length - entries.length,
    entries
  };
}

function runIdempotentSubmission(workspaceId, payload, submit) {
  const clientSubmissionId = String(payload.clientSubmissionId || "").trim().slice(0, 120);
  if (!clientSubmissionId) return submit();
  const key = `${cleanWorkspaceId(workspaceId)}:${clientSubmissionId}`;
  const active = activeSubmissionRequests.get(key);
  if (active) return active;
  const pending = submit().finally(() => {
    if (activeSubmissionRequests.get(key) === pending) activeSubmissionRequests.delete(key);
  });
  activeSubmissionRequests.set(key, pending);
  return pending;
}

function submitEntry(workspaceId, payload, user) {
  return runIdempotentSubmission(workspaceId, payload, () => withFormLock(workspaceId, () => submitEntryUnlocked(workspaceId, payload, user)));
}

async function submitEntryUnlocked(requestedWorkspaceId, payload, user) {
  const loaded = await loadDraft(requestedWorkspaceId);
  const workspaceId = loaded.workspaceId;
  const submittedAt = isoStamp();
  const answers = payload.answers || {};
  const primaryIdentifierVariable = participantIdentifierForDraft(loaded.draft);
  const existing = await readEntries(workspaceId);
  const clientSubmissionId = String(payload.clientSubmissionId || "").trim().slice(0, 120);
  const previousSubmission = clientSubmissionId && existing.find((item) => item.clientSubmissionId === clientSubmissionId);
  if (previousSubmission) return { ok: true, workspaceId, entry: previousSubmission, entries: existing, duplicateRetry: true };
  const requestedEntryId = String(payload.entryId || "").trim();
  await assertEntryMutationAllowed(loaded.draft, existing, answers, requestedEntryId);
  if (requestedEntryId) {
    const index = existing.findIndex((item) => String(item.id || "") === requestedEntryId);
    if (index < 0) {
      const error = new Error("Entry not found.");
      error.statusCode = 404;
      throw error;
    }
    const updatedAt = isoStamp();
    const entry = {
      ...existing[index],
      ...(clientSubmissionId ? { clientSubmissionId } : {}),
      updatedAt,
      updatedByUserId: user.id,
      instanceName: entryInstanceName(loaded.draft, answers, existing[index].submittedAt || submittedAt),
      answers
    };
    const entries = [...existing];
    entries[index] = entry;
    await store.updateEntry(workspaceId, entry);
    if (primaryIdentifierVariable && answers[primaryIdentifierVariable]) {
      await deleteRespondentCheckpoint(workspaceId, answers[primaryIdentifierVariable]);
    }
    return { ok: true, workspaceId, entry, entries, updated: true };
  }
  const entry = {
    id: `${timestampId()}_${Math.random().toString(36).slice(2, 8)}`,
    ...(clientSubmissionId ? { clientSubmissionId } : {}),
    userId: user.id,
    submittedAt,
    instanceName: entryInstanceName(loaded.draft, answers, submittedAt),
    answers
  };
  const entries = [...existing, entry];
  await store.insertEntry(workspaceId, entry);
  if (primaryIdentifierVariable && answers[primaryIdentifierVariable]) {
    await deleteRespondentCheckpoint(workspaceId, answers[primaryIdentifierVariable]);
  }
  return { ok: true, workspaceId, entry, entries };
}

function submitOdkEntry(workspaceId, payload, user) {
  return runIdempotentSubmission(workspaceId, payload, () => withFormLock(workspaceId, () => submitOdkEntryUnlocked(workspaceId, payload, user)));
}

async function submitOdkEntryUnlocked(requestedWorkspaceId, payload, user) {
  const loaded = await loadDraft(requestedWorkspaceId);
  const workspaceId = loaded.workspaceId;
  const instanceXml = String(payload.instanceXml || "").trim();
  if (!instanceXml) throw new Error("ODK submission XML is required.");
  const submittedAt = isoStamp();
  const answers = extractSimpleAnswersFromXml(instanceXml);
  const existing = await readEntries(workspaceId);
  const clientSubmissionId = String(payload.clientSubmissionId || "").trim().slice(0, 120);
  const previousSubmission = clientSubmissionId && existing.find((item) => item.clientSubmissionId === clientSubmissionId);
  if (previousSubmission) return { ok: true, workspaceId, entry: previousSubmission, entries: existing, duplicateRetry: true };
  const requestedEntryId = String(payload.entryId || "").trim();
  await assertEntryMutationAllowed(loaded.draft, existing, answers, requestedEntryId);
  const uploads = prepareSubmissionAttachments(payload.attachments);
  const uploadSummaries = uploads.map(({ fileName, contentType, data }) => ({ fileName, contentType, sizeBytes: data.length }));
  if (requestedEntryId) {
    const index = existing.findIndex((item) => String(item.id || "") === requestedEntryId);
    if (index < 0) {
      const error = new Error("Entry not found.");
      error.statusCode = 404;
      throw error;
    }
    const entry = {
      ...existing[index],
      ...(clientSubmissionId ? { clientSubmissionId } : {}),
      updatedAt: isoStamp(),
      updatedByUserId: user.id,
      source: "odk-web-forms",
      payloadType: payload?.payloadType || "monolithic",
      submissionMeta: payload?.submissionMeta || null,
      instanceXml,
      answers,
      instanceName: String(answers.instanceName || "").trim() || entryInstanceName(loaded.draft, answers, existing[index].submittedAt || submittedAt)
    };
    if (uploadSummaries.length) entry.attachments = [...(entry.attachments || []), ...uploadSummaries];
    const entries = [...existing];
    entries[index] = entry;
    await store.updateEntry(workspaceId, entry);
    for (const upload of uploads) await store.putEntryAttachment(workspaceId, entry.id, upload);
    return { ok: true, workspaceId, entry, entries, updated: true };
  }
  const entry = {
    id: `${timestampId()}_${Math.random().toString(36).slice(2, 8)}`,
    ...(clientSubmissionId ? { clientSubmissionId } : {}),
    userId: user.id,
    submittedAt,
    source: "odk-web-forms",
    payloadType: payload.payloadType || "monolithic",
    submissionMeta: payload.submissionMeta || null,
    instanceXml,
    answers,
    instanceName: String(answers.instanceName || "").trim() || entryInstanceName(loaded.draft, answers, submittedAt)
  };
  if (uploadSummaries.length) entry.attachments = uploadSummaries;
  const entries = [...existing, entry];
  await store.insertEntry(workspaceId, entry);
  for (const upload of uploads) await store.putEntryAttachment(workspaceId, entry.id, upload);
  return { ok: true, workspaceId, entry, entries };
}

function prepareSubmissionAttachments(attachments = []) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  const prepared = attachments.map((attachment) => {
    const fileName = cleanAttachmentName(attachment?.fileName || attachment?.filename);
    const data = Buffer.from(String(attachment?.dataBase64 || ""), "base64");
    return { fileName, data, contentType: String(attachment?.contentType || "application/octet-stream") };
  }).filter((attachment) => attachment.data.length);
  const totalBytes = prepared.reduce((total, attachment) => total + attachment.data.length, 0);
  if (totalBytes > 100 * 1024 * 1024) {
    const error = new Error("Submission attachments exceed the 100 MB total limit.");
    error.statusCode = 413;
    throw error;
  }
  return prepared;
}

async function loadSubmissionAttachment(workspaceId, entryId, fileName) {
  const cleanId = cleanWorkspaceId(workspaceId);
  const entryKey = String(entryId || "").trim();
  const entry = (await readEntries(cleanId)).find((item) => item.id === entryKey);
  if (!entry) {
    const error = new Error("Submission not found.");
    error.statusCode = 404;
    throw error;
  }
  const safeFileName = cleanAttachmentName(fileName);
  const saved = (entry.attachments || []).find((item) => item.fileName === safeFileName);
  if (!saved) {
    const error = new Error("Submission attachment not found.");
    error.statusCode = 404;
    throw error;
  }
  const stored = await store.getEntryAttachment(cleanId, entryKey, safeFileName);
  if (!stored) {
    const error = new Error("Submission attachment not found.");
    error.statusCode = 404;
    throw error;
  }
  return { data: stored.data, contentType: saved.contentType || stored.contentType };
}

function patientIdFromBundle(bundle, fallback) {
  const patientEntry = (bundle?.entry || []).find((entry) => entry?.resource?.resourceType === "Patient");
  const patient = patientEntry?.resource || {};
  const identifier = (patient.identifier || []).find((item) => item?.value);
  return identifier?.value || patient.id || fallback || "unknown";
}

async function listFhirBundles(workspaceId) {
  const { cleanId } = await requireWorkspace(workspaceId);
  return (await store.listFhirBundles(cleanId)).map(({ fileName, bundle }) => ({
    fileName,
    patientId: patientIdFromBundle(bundle, fileName.replace(/\.json$/, "")),
    entryCount: Array.isArray(bundle.entry) ? bundle.entry.length : 0,
    bundle
  }));
}

async function passToMapper(requestedWorkspaceId) {
  const loaded = await loadDraft(requestedWorkspaceId);
  const workspaceId = loaded.workspaceId;
  const entries = await readEntries(workspaceId);
  if (!entries.length) throw new Error("No filled form entries found. Submit at least one entry before passing to the entity mapper.");

  const mapperInput = buildMapperCsv(workspaceId, loaded.draft, entries);
  if (!existsSync(mapperPythonBin)) throw new Error(`Mapper Python environment not found: ${mapperPythonBin}`);
  const terminology = await store.getTerminology(workspaceId);

  const run = await withScratchDir(async (dir) => {
    const csvPath = path.join(dir, mapperInput.csvName);
    const draftPath = path.join(dir, "form.json");
    const terminologyPath = path.join(dir, "question_entities.json");
    // The mapper writes its bundles beside the result file.
    const bundleDir = path.join(dir, "fhir_bundles");
    const mapperResultPath = path.join(bundleDir, "mapper_result.json");
    await mkdir(bundleDir);
    await writeFile(csvPath, mapperInput.csv, "utf8");
    await writeFile(draftPath, JSON.stringify(loaded.draft, null, 2) + "\n", "utf8");
    const mapperArgs = [
      mapperRunnerPath,
      csvPath,
      mapperResultPath,
      "--primary-identifier",
      mapperInput.primaryIdentifierVariable,
      "--generic-form-draft",
      draftPath
    ];
    if (terminology) {
      await writeFile(terminologyPath, JSON.stringify(terminology, null, 2) + "\n", "utf8");
      mapperArgs.push("--terminology-review", terminologyPath);
    }
    const mapperResult = await runCommand(mapperPythonBin, mapperArgs, { cwd: mapperRoot });
    if (mapperResult.code !== 0) return { mapperResult };
    const result = JSON.parse(await readFile(mapperResultPath, "utf8"));
    const bundles = [];
    for (const bundleInfo of result.bundles || []) {
      const sourcePath = bundleInfo.bundle_path;
      if (!sourcePath || !existsSync(sourcePath)) continue;
      bundles.push({ fileName: path.basename(sourcePath), bundle: JSON.parse(await readFile(sourcePath, "utf8")) });
    }
    return { mapperResult, result, bundles };
  });
  const { mapperResult } = run;
  if (mapperResult.code !== 0) {
    return {
      ok: false,
      workspaceId,
      stdout: mapperResult.stdout,
      stderr: mapperResult.stderr || "ICPH entity mapper failed."
    };
  }

  await withTransaction(async () => {
    for (const { fileName, bundle } of run.bundles) await store.putFhirBundle(workspaceId, fileName, bundle);
  });

  const fhirBundles = await listFhirBundles(workspaceId);
  return {
    ok: true,
    workspaceId,
    result: run.result,
    fhirBundles,
    stdout: mapperResult.stdout,
    stderr: mapperResult.stderr,
    ...(await workspaceMeta(workspaceId))
  };
}

async function workspaceMeta(workspaceId) {
  const cleanId = cleanWorkspaceId(workspaceId);
  return formMeta(cleanId, await store.formSummary(cleanId), await readFolders());
}

async function formMeta(cleanId, row, folders) {
  let draft = row?.draft || null;
  const hasXml = Boolean(row?.has_xml);
  if (draft && !hasXml && (draft.respondentAccessCode || draft.publicAccessCode || draft.publishedAt)) {
    draft = { ...draft, updatedAt: isoStamp() };
    delete draft.respondentAccessCode;
    delete draft.publicAccessCode;
    delete draft.respondentCodeMode;
    delete draft.publishedAt;
    await saveDraft(cleanId, draft);
  }
  if (draft && hasXml && !draft.respondentAccessCode && !draft.publicAccessCode) {
    draft = {
      ...draft,
      respondentAccessCode: await generateUniqueRespondentAccessCode(cleanId),
      respondentCodeMode: draft.respondentCodeMode === "custom" ? "custom" : "random",
      publishedAt: draft.publishedAt || isoStamp(),
      updatedAt: draft.updatedAt || isoStamp()
    };
    await saveDraft(cleanId, draft);
  }
  const entryCount = row?.entry_count || 0;
  const fhirBundleCount = row?.fhir_bundle_count || 0;
  const attachmentNames = [...(row?.attachment_names || [])].sort((a, b) => a.localeCompare(b));
  const folder = draft?.folderId ? folders.find((item) => item.id === draft.folderId) : null;
  const versionInfo = splitWorkspaceVersion(draft?.versionBaseId || cleanId);
  let pipelineStage = "Building";
  if (fhirBundleCount) pipelineStage = "FHIR";
  else if (entryCount) pipelineStage = "Data collection";
  else if (hasXml) pipelineStage = "Publishing";
  else if (draft?.buildFinishedAt) pipelineStage = "Terminology";
  return {
    workspaceId: cleanId,
    title: draft?.title || cleanId,
    formId: draft?.formId || "",
    pipelineStage,
    questionCount: draft?.questions?.length || 0,
    entryCount,
    fhirBundleCount,
    hasXml,
    hasXlsx: Boolean(row?.has_xlsx),
    hasFhir: fhirBundleCount > 0,
    hasTerminology: Boolean(row?.has_terminology),
    terminologyStatus: row?.terminology_status || "not_started",
    terminologyEntityCount: Number(row?.terminology_entity_count) || 0,
    versionNumber: draft?.versionNumber || versionInfo.versionNumber,
    versionBaseId: draft?.versionBaseId || versionInfo.baseId,
    previousVersionWorkspaceId: draft?.previousVersionWorkspaceId || null,
    previousVersionNumber: draft?.previousVersionNumber || null,
    versionChangeSummary: draft?.versionChangeSummary || [],
    hasVersionChanges: formHasVersionChanges(draft || {}),
    attachmentCount: attachmentNames.length,
    attachmentNames,
    updatedAt: draft?.updatedAt || (row?.updated_at || new Date(0)).toISOString(),
    importedFrom: draft?.importedFrom || null,
    metaFormLink: draft?.metaFormLink || null,
    folderId: draft?.folderId || null,
    primaryIdentifierVariable: draft?.primaryIdentifierVariable || null,
    participantIdentifierVariable: draft?.participantIdentifierVariable || draft?.primaryIdentifierVariable || null,
    folderPrimaryIdentifierVariable: String(folder?.primaryIdentifierVariable || "").trim() || null,
    folderParticipantIdentifierVariable: String(folder?.participantIdentifierVariable || "").trim() || null,
    responseSettings: normalizeResponseSettings(draft || {}),
    collectionLocked: Boolean(draft?.collectionLocked),
    buildFinishedAt: draft?.buildFinishedAt || null,
    publishedAt: draft?.publishedAt || null,
    respondentAccessCode: draft?.respondentAccessCode || draft?.publicAccessCode || null
  };
}

async function listForms() {
  const folders = await readFolders();
  const forms = [];
  for (const row of await store.formSummaries()) {
    forms.push(await formMeta(row.workspace_id, row, folders));
  }
  forms.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { ok: true, forms };
}

async function deleteForm(workspaceId) {
  const cleanId = cleanWorkspaceId(workspaceId);
  const draft = await store.getDraft(cleanId);
  if (!draft) throw new Error(`Form workspace not found: ${cleanId}`);
  terminologyRuns.get(cleanId)?.child.kill();
  // Entries, attachments, checkpoints, FHIR bundles and barcode assignments go with the form.
  await store.deleteForm(cleanId);
  await releaseSharedIdentifiersForForm(draft);
  return { ok: true, workspaceId: cleanId };
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const who = req.user ? ` user=${req.user.username}` : "";
    console.log(`[http] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - startedAt} ms)${who}`);
  });
  if (req.method === "OPTIONS") return jsonResponse(res, 200, { ok: true });
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    if (req.method === "GET" && pathname === "/api/health") {
      await query("SELECT 1");
      return jsonResponse(res, 200, { ok: true });
    }
    if (req.method === "GET" && pathname === "/api/auth/config") {
      return jsonResponse(res, 200, { ok: true, url: keycloakPublicUrl, realm: keycloakRealm, clientId: keycloakClientId });
    }
    // Collection routes: filling in and reviewing published forms by form code.
    const collector = pathname.startsWith("/api/public/") ? await requireRole(req, FIELD_AGENT_ROLE, ADMIN_ROLE) : null;
    const publicFormMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)$/);
    const publicXmlMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/xml$/);
    const publicEntriesMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/entries$/);
    const publicCheckpointMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/checkpoint$/);
    const publicOdkSubmissionMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/odk-submissions$/);
    const publicAttachmentListMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/attachments$/);
    const publicAttachmentFileMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/attachments\/([^/]+)$/);
    const publicSubmissionAttachmentMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/entries\/([^/]+)\/attachments\/([^/]+)$/);
    if (req.method === "GET" && pathname === "/api/public/forms") {
      return jsonResponse(res, 200, await listPublicForms());
    }
    if (req.method === "GET" && publicFormMatch) {
      return jsonResponse(res, 200, await loadPublicForm(decodeURIComponent(publicFormMatch[1])));
    }
    if (req.method === "GET" && publicAttachmentListMatch) {
      return jsonResponse(res, 200, await loadPublicAttachmentList(decodeURIComponent(publicAttachmentListMatch[1])));
    }
    if (req.method === "GET" && publicSubmissionAttachmentMatch) {
      const attachment = await loadSubmissionAttachment(
        (await findWorkspaceByRespondentCode(decodeURIComponent(publicSubmissionAttachmentMatch[1]))).workspaceId,
        decodeURIComponent(publicSubmissionAttachmentMatch[2]),
        decodeURIComponent(publicSubmissionAttachmentMatch[3])
      );
      return binaryResponse(res, 200, attachment.data, attachment.contentType);
    }
    if (req.method === "GET" && publicXmlMatch) {
      return jsonResponse(res, 200, await loadPublicFormXml(decodeURIComponent(publicXmlMatch[1])));
    }
    if (req.method === "GET" && publicAttachmentFileMatch) {
      const attachment = await loadPublicAttachment(decodeURIComponent(publicAttachmentFileMatch[1]), decodeURIComponent(publicAttachmentFileMatch[2]));
      return binaryResponse(res, 200, attachment.data, attachment.contentType);
    }
    if (req.method === "POST" && publicEntriesMatch) {
      return jsonResponse(res, 200, await submitPublicEntry(decodeURIComponent(publicEntriesMatch[1]), await requestBody(req), collector));
    }
    if (req.method === "GET" && publicEntriesMatch) {
      return jsonResponse(res, 200, await loadPublicFormEntries(decodeURIComponent(publicEntriesMatch[1])));
    }
    if (req.method === "DELETE" && publicEntriesMatch) {
      return jsonResponse(res, 200, await deletePublicEntries(decodeURIComponent(publicEntriesMatch[1]), await requestBody(req)));
    }
    if (req.method === "POST" && publicCheckpointMatch) {
      return jsonResponse(res, 200, await savePublicCheckpoint(decodeURIComponent(publicCheckpointMatch[1]), await requestBody(req)));
    }
    if (req.method === "PUT" && publicCheckpointMatch) {
      return jsonResponse(res, 200, await loadPublicCheckpoint(decodeURIComponent(publicCheckpointMatch[1]), await requestBody(req)));
    }
    if (req.method === "POST" && publicOdkSubmissionMatch) {
      return jsonResponse(res, 200, await submitPublicOdkEntry(decodeURIComponent(publicOdkSubmissionMatch[1]), await requestBody(req), collector));
    }
    const admin = await requireRole(req, ADMIN_ROLE);
    if (req.method === "GET" && pathname === "/api/forms") {
      return jsonResponse(res, 200, await listForms());
    }
    if (req.method === "GET" && pathname === "/api/folders") {
      return jsonResponse(res, 200, { ok: true, folders: await readFolders() });
    }
    if (req.method === "POST" && pathname === "/api/folders") {
      return jsonResponse(res, 200, await createFolder(await requestBody(req)));
    }
    const folderExportMatch = pathname.match(/^\/api\/folders\/([^/]+)\/responses\.xlsx$/);
    if (req.method === "GET" && folderExportMatch) {
      const workbook = await exportFolderResponses(decodeURIComponent(folderExportMatch[1]));
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${workbook.fileName.replace(/"/g, "")}"`,
        ...corsHeaders
      });
      return res.end(workbook.data);
    }
    const folderMatch = pathname.match(/^\/api\/folders\/([^/]+)$/);
    if (req.method === "DELETE" && folderMatch) {
      return jsonResponse(res, 200, await deleteFolder(decodeURIComponent(folderMatch[1])));
    }
    if (req.method === "GET" && pathname === "/api/schema-documents") {
      return jsonResponse(res, 200, await listSchemaDocuments());
    }
    if (req.method === "GET" && pathname === "/api/terminology/snomed-search") {
      return jsonResponse(res, 200, await searchSnomedTerms(url.searchParams.get("query"), {
        limit: url.searchParams.get("limit"),
        selectedCode: url.searchParams.get("selectedCode")
      }));
    }
    if (req.method === "GET" && pathname === "/api/terminology/search") {
      return jsonResponse(res, 200, await searchVocabularyTerms(url.searchParams.get("query"), {
        vocabulary: url.searchParams.get("vocabulary"),
        limit: url.searchParams.get("limit"),
        selectedCode: url.searchParams.get("selectedCode")
      }));
    }
    if (req.method === "GET" && pathname === "/api/terminology/assets") {
      return jsonResponse(res, 200, await terminologyAssetsStatus());
    }
    if (req.method === "POST" && pathname === "/api/schema-documents/upload") {
      return jsonResponse(res, 200, await uploadSchemaDocument(await requestBody(req)));
    }
    if (req.method === "POST" && pathname === "/api/schema-documents/process") {
      return jsonResponse(res, 200, await processSchemaDocuments(await requestBody(req)));
    }
    const schemaDocMatch = pathname.match(/^\/api\/schema-documents\/([^/]+)$/);
    if (req.method === "DELETE" && schemaDocMatch) {
      return jsonResponse(res, 200, await deleteSchemaDocument(decodeURIComponent(schemaDocMatch[1])));
    }
    const formMatch = pathname.match(/^\/api\/forms\/([^/]+)$/);
    const entriesMatch = pathname.match(/^\/api\/forms\/([^/]+)\/entries$/);
    const submissionAttachmentMatch = pathname.match(/^\/api\/forms\/([^/]+)\/entries\/([^/]+)\/attachments\/([^/]+)$/);
    const participantsMatch = pathname.match(/^\/api\/forms\/([^/]+)\/participants$/);
    const participantAssignMatch = pathname.match(/^\/api\/forms\/([^/]+)\/participants\/assign$/);
    const participantActivateMatch = pathname.match(/^\/api\/forms\/([^/]+)\/participants\/activate$/);
    const fhirMatch = pathname.match(/^\/api\/forms\/([^/]+)\/fhir$/);
    const responseSettingsMatch = pathname.match(/^\/api\/forms\/([^/]+)\/response-settings$/);
    const accessMatch = pathname.match(/^\/api\/forms\/([^/]+)\/collection-access$/);
    const terminologySettingsMatch = pathname.match(/^\/api\/forms\/([^/]+)\/terminology-settings$/);
    const terminologyMatch = pathname.match(/^\/api\/forms\/([^/]+)\/terminology$/);
	    const terminologyReviewMatch = pathname.match(/^\/api\/forms\/([^/]+)\/terminology\/review$/);
	    const versionMatch = pathname.match(/^\/api\/forms\/([^/]+)\/versions$/);
	    const xmlMatch = pathname.match(/^\/api\/forms\/([^/]+)\/xml$/);
	    const xlsxMatch = pathname.match(/^\/api\/forms\/([^/]+)\/xlsx$/);
    const attachmentsMatch = pathname.match(/^\/api\/forms\/([^/]+)\/attachments$/);
    const attachmentFileMatch = pathname.match(/^\/api\/forms\/([^/]+)\/attachments\/([^/]+)$/);
    const odkSubmissionMatch = pathname.match(/^\/api\/forms\/([^/]+)\/odk-submissions$/);
    const mapperMatch = pathname.match(/^\/api\/forms\/([^/]+)\/pass-to-mapper$/);
    if (req.method === "GET" && formMatch) {
      return jsonResponse(res, 200, await loadDraft(decodeURIComponent(formMatch[1])));
    }
    if (req.method === "DELETE" && formMatch) {
      return jsonResponse(res, 200, await deleteForm(decodeURIComponent(formMatch[1])));
    }
    if (req.method === "GET" && entriesMatch) {
      return jsonResponse(res, 200, { ok: true, entries: await readEntries(decodeURIComponent(entriesMatch[1])) });
    }
    if (req.method === "GET" && submissionAttachmentMatch) {
      const attachment = await loadSubmissionAttachment(
        decodeURIComponent(submissionAttachmentMatch[1]),
        decodeURIComponent(submissionAttachmentMatch[2]),
        decodeURIComponent(submissionAttachmentMatch[3])
      );
      return binaryResponse(res, 200, attachment.data, attachment.contentType);
    }
    if (req.method === "GET" && participantsMatch) {
      return jsonResponse(res, 200, await listParticipantAssignments(decodeURIComponent(participantsMatch[1])));
    }
    if (req.method === "POST" && participantAssignMatch) {
      return jsonResponse(res, 200, await assignParticipantBarcode(decodeURIComponent(participantAssignMatch[1]), await requestBody(req)));
    }
    if (req.method === "POST" && participantActivateMatch) {
      return jsonResponse(res, 200, await activateFolderBarcodeParticipantIdentifier(decodeURIComponent(participantActivateMatch[1]), await requestBody(req)));
    }
    if (req.method === "GET" && fhirMatch) {
      return jsonResponse(res, 200, { ok: true, fhirBundles: await listFhirBundles(decodeURIComponent(fhirMatch[1])) });
    }
    if (req.method === "PUT" && responseSettingsMatch) {
      return jsonResponse(res, 200, await updateResponseSettings(decodeURIComponent(responseSettingsMatch[1]), await requestBody(req)));
    }
    if (req.method === "PUT" && accessMatch) {
      return jsonResponse(res, 200, await updateCollectionAccess(decodeURIComponent(accessMatch[1]), await requestBody(req)));
    }
    if (req.method === "PUT" && terminologySettingsMatch) {
      return jsonResponse(res, 200, await updateTerminologySettings(decodeURIComponent(terminologySettingsMatch[1]), await requestBody(req)));
    }
    if (req.method === "GET" && terminologyMatch) {
      return jsonResponse(res, 200, await loadTerminology(decodeURIComponent(terminologyMatch[1])));
    }
    if (req.method === "GET" && xmlMatch) {
      return jsonResponse(res, 200, await loadFormXml(decodeURIComponent(xmlMatch[1])));
    }
    if (req.method === "GET" && xlsxMatch) {
      const xlsx = await loadFormXlsx(decodeURIComponent(xlsxMatch[1]));
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${xlsx.fileName.replace(/"/g, "")}"`,
        ...corsHeaders
      });
      return res.end(xlsx.data);
    }
    if (req.method === "GET" && attachmentsMatch) {
      return jsonResponse(res, 200, await listAttachments(decodeURIComponent(attachmentsMatch[1])));
    }
    if (req.method === "GET" && attachmentFileMatch) {
      const attachment = await loadAttachment(decodeURIComponent(attachmentFileMatch[1]), decodeURIComponent(attachmentFileMatch[2]));
      return binaryResponse(res, 200, attachment.data, attachment.contentType);
    }
    if (req.method === "POST" && entriesMatch) {
      return jsonResponse(res, 200, await submitEntry(decodeURIComponent(entriesMatch[1]), await requestBody(req), admin));
    }
    if (req.method === "DELETE" && entriesMatch) {
      return jsonResponse(res, 200, await deleteEntries(decodeURIComponent(entriesMatch[1]), await requestBody(req)));
    }
    if (req.method === "POST" && attachmentsMatch) {
      return jsonResponse(res, 200, await uploadAttachment(decodeURIComponent(attachmentsMatch[1]), await requestBody(req)));
    }
    if (req.method === "DELETE" && attachmentFileMatch) {
      return jsonResponse(res, 200, await deleteAttachment(decodeURIComponent(attachmentFileMatch[1]), decodeURIComponent(attachmentFileMatch[2])));
    }
    if (req.method === "POST" && odkSubmissionMatch) {
      return jsonResponse(res, 200, await submitOdkEntry(decodeURIComponent(odkSubmissionMatch[1]), await requestBody(req), admin));
    }
    if (req.method === "POST" && mapperMatch) {
      return jsonResponse(res, 200, await passToMapper(decodeURIComponent(mapperMatch[1])));
    }
	    if (req.method === "POST" && terminologyMatch) {
	      const body = await requestBody(req);
	      return jsonResponse(res, 200, await startTerminologyExtraction(decodeURIComponent(terminologyMatch[1]), {
	        force: true,
	        questionIds: body.questionIds || body.selectedQuestionIds || [],
	      }));
	    }
	    if (req.method === "POST" && terminologyReviewMatch) {
	      return jsonResponse(res, 200, await saveTerminologyReview(decodeURIComponent(terminologyReviewMatch[1]), await requestBody(req)));
	    }
	    if (req.method === "POST" && versionMatch) {
	      return jsonResponse(res, 200, await createFormVersion(decodeURIComponent(versionMatch[1])));
	    }
    if (req.method === "POST" && pathname === "/api/forms/new") {
      return jsonResponse(res, 200, await createForm(await requestBody(req)));
    }
    if (req.method === "POST" && pathname === "/api/forms/save") {
      return jsonResponse(res, 200, await checkpointForm(await requestBody(req)));
    }
    if (req.method === "POST" && pathname === "/api/forms/export") {
      return jsonResponse(res, 200, await exportForm(await requestBody(req)));
    }
    if (req.method === "POST" && pathname === "/api/forms/inspect-xlsx") {
      return jsonResponse(res, 200, await inspectXlsx(await requestBody(req)));
    }
    if (req.method === "POST" && pathname === "/api/forms/import-xlsx") {
      return jsonResponse(res, 200, await importXlsx(await requestBody(req)));
    }
    jsonResponse(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const message = error.message || String(error);
    const status = error.statusCode || (/not found/i.test(message) ? 404 : 500);
    if (status >= 500) console.error(`[http] ${req.method} ${req.url} failed:`, error);
    else console.warn(`[http] ${req.method} ${req.url} -> ${status}: ${message}`);
    jsonResponse(res, status, { ok: false, error: message });
  }
});

await migrate();
await logTablePrivileges();
await importLegacyMetaForms();
server.listen(port, "0.0.0.0", () => {
  console.log(`ICPH form-builder API listening on http://localhost:${port}`);
});
