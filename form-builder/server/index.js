import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const icphRoot = path.resolve(appRoot, "..");
const outputRoot = path.join(icphRoot, "output", "forms");
const foldersPath = path.join(outputRoot, "folders.json");
const metaFormPrimariesPath = path.join(outputRoot, "meta-form-primaries.json");
const participantRegistryPath = path.join(outputRoot, "participant-registry.json");
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
const metaFormsRoot = path.join(mapperRoot, "SchemaTerminologies", "schemas", "ICPH_MetaForms");
const schemaOriginalDir = path.join(metaFormsRoot, "originalDocx");
const schemaProcessedDir = path.join(metaFormsRoot, "processedMD");
const schemaPreprocessorPath = path.join(mapperRoot, "preprocess_icph_metaforms.py");
const schemaManifestName = "icph_metaforms_manifest.json";
const schemaAggregateChunksName = "icph_metaform_chunks.jsonl";
const port = Number(process.env.ICPH_FORM_BUILDER_API_PORT || 8787);
const configuredAdminPassword = String(process.env.ICPH_ADMIN_PASSWORD || "");
if (
  process.env.NODE_ENV === "production"
  && (configuredAdminPassword.length < 16 || configuredAdminPassword === "ICPH2026" || /replace[_ -]?with/i.test(configuredAdminPassword))
) {
  throw new Error("Set ICPH_ADMIN_PASSWORD to a private secret of at least 16 characters before running in production.");
}
const adminPassword = configuredAdminPassword || "ICPH2026";
const adminTokens = new Map();
const adminTokenTtlMs = 12 * 60 * 60 * 1000;
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
  "access-control-allow-headers": "content-type,x-admin-token,x-admin-password,authorization"
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
  for await (const chunk of req) chunks.push(chunk);
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

function cleanupAdminTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of adminTokens) {
    if (!expiresAt || expiresAt <= now) adminTokens.delete(token);
  }
}

function createAdminToken() {
  cleanupAdminTokens();
  const token = randomBytes(24).toString("hex");
  adminTokens.set(token, Date.now() + adminTokenTtlMs);
  return token;
}

function adminTokenFromRequest(req) {
  const explicit = req.headers["x-admin-token"];
  if (explicit) return String(explicit).trim();
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isAdminRequest(req) {
  cleanupAdminTokens();
  const token = adminTokenFromRequest(req);
  const password = String(req.headers["x-admin-password"] || "");
  return Boolean((token && adminTokens.has(token)) || (password && password === adminPassword));
}

function assertAdmin(req) {
  if (isAdminRequest(req)) return;
  const error = new Error("Admin login required.");
  error.statusCode = 401;
  throw error;
}

async function loginAdmin(payload) {
  const password = String(payload?.password || "");
  if (password !== adminPassword) {
    const error = new Error("Incorrect admin password.");
    error.statusCode = 401;
    throw error;
  }
  return {
    ok: true,
    token: createAdminToken(),
    expiresInSeconds: Math.floor(adminTokenTtlMs / 1000)
  };
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

function safeSchemaStem(fileName) {
  const stem = path.basename(String(fileName || "document"), path.extname(String(fileName || "")));
  return stem.replace(/[^0-9A-Za-z._-]+/g, "_").replace(/^_+|_+$/g, "") || "document";
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

async function exposeStartGeopointsInXml(draft, xmlPath) {
  if (!existsSync(xmlPath)) return;
  const startQuestions = (draft.questions || []).filter((question) => normalizedQuestionType(question) === "start-geopoint" && String(question.name || "").trim());
  if (!startQuestions.length) return;
  let xml = await readFile(xmlPath, "utf8");
  let additions = "";
  for (const question of startQuestions) {
    const name = String(question.name || "").trim();
    if (new RegExp(`<input\\s+[^>]*ref=["']/data/${name}["']`).test(xml)) continue;
    const label = escapeXmlText(question.label || name);
    const hint = String(question.hint || "").trim() ? `<hint>${escapeXmlText(question.hint)}</hint>` : "";
    const appearance = String(question.appearance || "").trim() ? ` appearance="${escapeXmlAttribute(question.appearance)}"` : "";
    additions += `<input ref="/data/${escapeXmlAttribute(name)}"${appearance}><label>${label}</label>${hint}</input>`;
  }
  if (!additions) return;
  if (xml.includes("</h:body>")) {
    xml = xml.replace("</h:body>", `${additions}</h:body>`);
  } else if (xml.includes("</body>")) {
    xml = xml.replace("</body>", `${additions}</body>`);
  } else {
    return;
  }
  await writeFile(xmlPath, xml, "utf8");
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
  while (existsSync(path.join(schemaOriginalDir, candidate))) {
    candidate = `${stem}_${timestampId()}${index > 1 ? `_${index}` : ""}${ext}`;
    index += 1;
  }
  return candidate;
}

function mapperRelative(fullPath) {
  return path.relative(mapperRoot, fullPath);
}

async function readSchemaManifest() {
  const manifestPath = path.join(schemaProcessedDir, schemaManifestName);
  if (!existsSync(manifestPath)) return { processed_at: null, documents: {} };
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return { processed_at: null, documents: {} };
  }
}

async function writeSchemaManifest(manifest) {
  await mkdir(schemaProcessedDir, { recursive: true });
  manifest.processed_at = isoStamp().replace(/\.\d{3}Z$/, "Z");
  await writeFile(path.join(schemaProcessedDir, schemaManifestName), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

async function ensureWorkspace(workspaceId) {
  const cleanId = cleanWorkspaceId(workspaceId);
  const base = path.join(outputRoot, cleanId);
  const dirs = ["drafts", "drafts/checkpoints", "xlsform", "xml", "data", "fhir_bundles", "logs", "attachments"];
  await mkdir(base, { recursive: true });
  await Promise.all(dirs.map((dir) => mkdir(path.join(base, dir), { recursive: true })));
  return base;
}

async function requireWorkspace(workspaceId) {
  const cleanId = cleanWorkspaceId(workspaceId);
  const outputDir = path.join(outputRoot, cleanId);
  if (!existsSync(path.join(outputDir, "drafts", "form.json"))) {
    throw new Error(`Form workspace not found: ${cleanId}`);
  }
  return { cleanId, outputDir };
}

async function rebuildSchemaAggregate(manifest) {
  await mkdir(schemaProcessedDir, { recursive: true });
  const records = [];
  for (const info of Object.values(manifest.documents || {}).sort((a, b) => String(a.source_path || "").localeCompare(String(b.source_path || "")))) {
    if (!info.chunks_path) continue;
    const chunksPath = path.join(mapperRoot, info.chunks_path);
    if (!existsSync(chunksPath)) continue;
    const lines = (await readFile(chunksPath, "utf8")).split(/\r?\n/).filter(Boolean);
    records.push(...lines);
  }
  const aggregatePath = path.join(schemaProcessedDir, schemaAggregateChunksName);
  await writeFile(aggregatePath, records.length ? `${records.join("\n")}\n` : "", "utf8");
  manifest.aggregate_chunks_path = mapperRelative(aggregatePath);
  manifest.aggregate_chunk_count = records.length;
  return records.length;
}

async function listSchemaDocuments() {
  await mkdir(schemaOriginalDir, { recursive: true });
  await mkdir(schemaProcessedDir, { recursive: true });
  const manifest = await readSchemaManifest();
  const metaFormPrimaries = await readMetaFormPrimaries();
  const originalNames = new Set();
  try {
    for (const name of await readdir(schemaOriginalDir)) {
      if (name.toLowerCase().endsWith(".docx") && !name.startsWith("~$")) originalNames.add(name);
    }
  } catch {}
  for (const name of Object.keys(manifest.documents || {})) originalNames.add(name);

  const documents = [];
  for (const name of [...originalNames].sort((a, b) => a.localeCompare(b))) {
    const sourcePath = path.join(schemaOriginalDir, name);
    const stem = safeSchemaStem(name);
    const markdownPath = path.join(schemaProcessedDir, `${stem}.md`);
    const chunksPath = path.join(schemaProcessedDir, `${stem}.chunks.jsonl`);
    const info = manifest.documents?.[name] || {};
    const formOptions = [];
    if (info.chunks_path) {
      const manifestChunksPath = path.join(mapperRoot, info.chunks_path);
      if (existsSync(manifestChunksPath)) {
        try {
          const lines = (await readFile(manifestChunksPath, "utf8")).split(/\r?\n/).filter(Boolean);
          const byForm = new Map();
          for (const line of lines) {
            const chunk = JSON.parse(line);
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
          formOptions.push(...byForm.values());
        } catch {}
      }
    }
    let sourceStat = null;
    try {
      sourceStat = await stat(sourcePath);
    } catch {}
    documents.push({
      fileName: name,
      status: info.chunk_count && existsSync(markdownPath) && existsSync(chunksPath) ? "Processed" : sourceStat ? "Needs processing" : "Source missing",
      sourcePath: sourceStat ? sourcePath : null,
      markdownPath: existsSync(markdownPath) ? markdownPath : null,
      chunksPath: existsSync(chunksPath) ? chunksPath : null,
      sourceSizeBytes: sourceStat?.size || info.source_size_bytes || 0,
      updatedAt: sourceStat?.mtime?.toISOString?.() || info.processed_at || null,
      processedAt: info.processed_at || null,
      formCount: info.form_count || 0,
      primaryIdentifierVariable: metaFormPrimaries[name] || null,
      formOptions: formOptions.sort((a, b) => Number(a.formIndex || 0) - Number(b.formIndex || 0)),
      variableCount: info.variable_count || 0,
      chunkCount: info.chunk_count || 0,
      sha256: info.sha256 || null
    });
  }

  return {
    ok: true,
    documents,
    originalDir: schemaOriginalDir,
    processedDir: schemaProcessedDir,
    aggregateChunksPath: path.join(schemaProcessedDir, schemaAggregateChunksName),
    aggregateChunkCount: manifest.aggregate_chunk_count || 0,
    processedAt: manifest.processed_at || null
  };
}

async function uploadSchemaDocument(payload) {
  await mkdir(schemaOriginalDir, { recursive: true });
  const fileName = await uniqueSchemaDocName(payload.filename);
  const data = Buffer.from(String(payload.dataBase64 || ""), "base64");
  if (!data.length) throw new Error("Uploaded schema document is empty.");
  const sourcePath = path.join(schemaOriginalDir, fileName);
  await writeFile(sourcePath, data);
  return { ok: true, fileName, sourcePath, ...(await listSchemaDocuments()) };
}

async function processSchemaDocuments(payload = {}) {
  const command = existsSync(mapperPythonBin) ? mapperPythonBin : pythonBin;
  const args = [schemaPreprocessorPath];
  if (payload.force) args.push("--force");
  const result = await runCommand(command, args, { cwd: mapperRoot });
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
  const stem = safeSchemaStem(cleanName);
  const sourcePath = path.join(schemaOriginalDir, cleanName);
  const markdownPath = path.join(schemaProcessedDir, `${stem}.md`);
  const chunksPath = path.join(schemaProcessedDir, `${stem}.chunks.jsonl`);
  const linkedWorkspaceIds = (await listForms()).forms
    .filter((item) => item.metaFormLink?.fileName === cleanName)
    .map((item) => item.workspaceId);

  await rm(sourcePath, { force: true });
  await rm(markdownPath, { force: true });
  await rm(chunksPath, { force: true });

  const manifest = await readSchemaManifest();
  manifest.documents = manifest.documents || {};
  delete manifest.documents[cleanName];
  await rebuildSchemaAggregate(manifest);
  await writeSchemaManifest(manifest);

  for (const workspaceId of linkedWorkspaceIds) await deleteForm(workspaceId);

  return { ok: true, deleted: { fileName: cleanName, sourcePath, markdownPath, chunksPath }, deletedWorkspaceIds: linkedWorkspaceIds, ...(await listSchemaDocuments()) };
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

  const exportDir = path.join(outputRoot, "folder_exports");
  await mkdir(exportDir, { recursive: true });
  const stem = `${slugify(folder.name)}_${timestampId()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(exportDir, `${stem}.json`);
  const outputPath = path.join(exportDir, `${stem}.xlsx`);
  try {
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
  } finally {
    await rm(inputPath, { force: true });
    await rm(outputPath, { force: true });
  }
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
  if (!existing) {
    folders[index] = { ...folders[index], primaryIdentifierVariable: cleanVariable, updatedAt: isoStamp() };
    await writeFolders(folders);
  }
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
    else await writeFile(loaded.draftPath, JSON.stringify(nextDraft, null, 2) + "\n", "utf8");
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
  folders[index] = {
    ...folders[index],
    participantIdentifierMode: "barcode",
    participantIdentifierVariable: existingVariable || cleanVariable,
    updatedAt: isoStamp()
  };
  await writeFolders(folders);
  await syncFolderBarcodeQuestions(cleanId, existingVariable || cleanVariable);
}

async function readMetaFormPrimaries() {
  try {
    const parsed = JSON.parse(await readFile(metaFormPrimariesPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeMetaFormPrimaries(primaries) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(metaFormPrimariesPath, JSON.stringify(primaries, null, 2) + "\n", "utf8");
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
  if (!existing) {
    primaries[cleanName] = cleanVariable;
    await writeMetaFormPrimaries(primaries);
  }
}

async function releaseSharedIdentifiersForForm(draft) {
  const forms = await listForms();
  if (draft?.folderId && !forms.forms.some((item) => item.folderId === draft.folderId)) {
    const folders = await readFolders();
    const folderIndex = folders.findIndex((item) => item.id === draft.folderId);
    if (folderIndex >= 0 && (folders[folderIndex].primaryIdentifierVariable || folders[folderIndex].participantIdentifierMode)) {
      folders[folderIndex] = {
        ...folders[folderIndex],
        primaryIdentifierVariable: "",
        participantIdentifierMode: "",
        participantIdentifierVariable: "",
        updatedAt: isoStamp()
      };
      await writeFolders(folders);
    }
  }
  const metaFileName = String(draft?.metaFormLink?.fileName || "").trim();
  if (metaFileName && !forms.forms.some((item) => item.metaFormLink?.fileName === metaFileName)) {
    const primaries = await readMetaFormPrimaries();
    if (Object.prototype.hasOwnProperty.call(primaries, metaFileName)) {
      delete primaries[metaFileName];
      await writeMetaFormPrimaries(primaries);
    }
  }
}

async function createForm(payload) {
  const title = String(payload.title || "Untitled ICPH Form").trim();
  const formId = slugify(payload.formId || title).replace(/-/g, "_");
  const versionBaseId = `${timestampId()}_${slugify(title)}`;
  const workspaceId = `${versionBaseId}_v1`;
  const outputDir = await ensureWorkspace(workspaceId);
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
  const draftPath = path.join(outputDir, "drafts", "form.json");
  await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  return { workspaceId, outputDir, draftPath, draft };
}

async function readFolders() {
  try {
    const parsed = JSON.parse(await readFile(foldersPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeFolders(folders) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(foldersPath, JSON.stringify(folders, null, 2) + "\n", "utf8");
}

async function readParticipantRegistry() {
  try {
    const parsed = JSON.parse(await readFile(participantRegistryPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeParticipantRegistry(records) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(participantRegistryPath, JSON.stringify(records, null, 2) + "\n", "utf8");
}

async function createFolder(payload) {
  const name = String(payload.name || "").trim();
  if (!name) throw new Error("Folder name is required.");
  const folders = await readFolders();
  if (folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("A folder with that name already exists.");
  }
  const folder = { id: `${timestampId()}_${slugify(name)}`, name, primaryIdentifierVariable: "", createdAt: isoStamp(), updatedAt: isoStamp() };
  folders.push(folder);
  await writeFolders(folders);
  return { ok: true, folder, folders };
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

  await writeFolders(folders.filter((item) => item.id !== cleanId));
  return { ok: true, deletedFolder: folder, deletedWorkspaceIds, folders: await readFolders() };
}

async function loadDraft(workspaceId) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const draft = { ...JSON.parse(await readFile(draftPath, "utf8")), terminologyUseLlm: false };
  return { workspaceId: cleanId, outputDir, draftPath, draft, ...(await workspaceMeta(cleanId)) };
}

async function findWorkspaceByRespondentCode(value) {
  const code = cleanRespondentAccessCode(value);
  await mkdir(outputRoot, { recursive: true });
  const names = await readdir(outputRoot);
  for (const name of names) {
    const workspaceId = cleanWorkspaceId(name);
    const draftPath = path.join(outputRoot, workspaceId, "drafts", "form.json");
    if (!existsSync(draftPath)) continue;
    try {
      const draft = JSON.parse(await readFile(draftPath, "utf8"));
      if (draft.collectionLocked) continue;
      const respondentAccessCode = String(draft.respondentAccessCode || draft.publicAccessCode || "").trim().toUpperCase();
      if (respondentAccessCode === code) {
        return {
          code,
          workspaceId,
          outputDir: path.join(outputRoot, workspaceId),
          draftPath,
          draft
        };
      }
    } catch {}
  }
  const error = new Error("No published form matches that respondent code.");
  error.statusCode = 404;
  throw error;
}

async function generateUniqueRespondentAccessCode(workspaceId) {
  const currentWorkspaceId = cleanWorkspaceId(workspaceId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = randomRespondentAccessCode();
    try {
      const found = await findWorkspaceByRespondentCode(code);
      if (found.workspaceId === currentWorkspaceId) return code;
    } catch (error) {
      if (error.statusCode === 404) return code;
      throw error;
    }
  }
  throw new Error("Could not generate a unique respondent form code.");
}

async function ensureUniqueRespondentAccessCode(code, workspaceId) {
  const cleanCode = cleanRespondentAccessCode(code);
  const currentWorkspaceId = cleanWorkspaceId(workspaceId);
  try {
    const found = await findWorkspaceByRespondentCode(cleanCode);
    if (found.workspaceId !== currentWorkspaceId) {
      const error = new Error("That respondent code is already used by another published form.");
      error.statusCode = 409;
      throw error;
    }
  } catch (error) {
    if (error.statusCode !== 404) throw error;
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
    forms.push({
      workspaceId: item.workspaceId,
      title: item.title,
      formId: item.formId,
      respondentAccessCode: item.respondentAccessCode,
      primaryIdentifierVariable: item.primaryIdentifierVariable,
      participantIdentifierVariable: item.participantIdentifierVariable || item.primaryIdentifierVariable,
      entryCount: entries.length,
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

async function submitPublicEntry(value, payload) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await submitEntry(found.workspaceId, payload);
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

async function submitPublicOdkEntry(value, payload) {
  const found = await findWorkspaceByRespondentCode(value);
  const data = await submitOdkEntry(found.workspaceId, payload);
  return { ok: true, accessCode: found.code, entry: data.entry };
}

async function loadFormXml(workspaceId) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const meta = await workspaceMeta(cleanId);
  if (!meta.xmlPath || !existsSync(meta.xmlPath)) {
    throw new Error("Published XML not found for this form.");
  }
  return {
    ok: true,
    workspaceId: cleanId,
    xmlPath: meta.xmlPath,
    xml: await readFile(meta.xmlPath, "utf8")
  };
}

async function loadFormXlsx(workspaceId) {
  const { cleanId } = await requireWorkspace(workspaceId);
  const meta = await workspaceMeta(cleanId);
  if (!meta.xlsxPath || !existsSync(meta.xlsxPath)) {
    throw new Error("Generated ODK XLS not found for this form.");
  }
  return {
    ok: true,
    workspaceId: cleanId,
    xlsxPath: meta.xlsxPath,
    fileName: path.basename(meta.xlsxPath),
    data: await readFile(meta.xlsxPath)
  };
}

async function listAttachments(workspaceId) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  const attachmentDir = path.join(outputDir, "attachments");
  await mkdir(attachmentDir, { recursive: true });
  let names = [];
  try {
    names = await readdir(attachmentDir);
  } catch {}
  const attachments = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const attachmentPath = path.join(attachmentDir, name);
    try {
      const info = await stat(attachmentPath);
      if (!info.isFile()) continue;
      attachments.push({
        fileName: name,
        sizeBytes: info.size,
        updatedAt: info.mtime.toISOString(),
        url: `/api/forms/${encodeURIComponent(cleanId)}/attachments/${encodeURIComponent(name)}`
      });
    } catch {}
  }
  return { ok: true, workspaceId: cleanId, attachmentDir, attachments };
}

async function uploadAttachment(workspaceId, payload) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  const fileName = cleanAttachmentName(payload.filename);
  const data = Buffer.from(String(payload.dataBase64 || ""), "base64");
  if (!data.length) throw new Error("Uploaded attachment is empty.");
  const attachmentDir = path.join(outputDir, "attachments");
  await mkdir(attachmentDir, { recursive: true });
  const attachmentPath = path.join(attachmentDir, fileName);
  await writeFile(attachmentPath, data);
  const xlsDir = path.join(outputDir, "xlsform");
  await mkdir(xlsDir, { recursive: true });
  await writeFile(path.join(xlsDir, fileName), data);
  return { ok: true, workspaceId: cleanId, fileName, attachmentPath, ...(await listAttachments(cleanId)), ...(await workspaceMeta(cleanId)) };
}

async function deleteAttachment(workspaceId, fileName) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  const cleanName = cleanAttachmentName(fileName);
  await rm(path.join(outputDir, "attachments", cleanName), { force: true });
  await rm(path.join(outputDir, "xlsform", cleanName), { force: true });
  return { ok: true, workspaceId: cleanId, deleted: cleanName, ...(await listAttachments(cleanId)), ...(await workspaceMeta(cleanId)) };
}

async function loadAttachment(workspaceId, fileName) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const cleanName = cleanAttachmentName(fileName);
  const attachmentPath = path.join(outputDir, "attachments", cleanName);
  if (!existsSync(attachmentPath)) throw new Error(`Attachment not found: ${cleanName}`);
  return {
    fileName: cleanName,
    contentType: contentTypeFor(cleanName),
    data: await readFile(attachmentPath)
  };
}

async function syncAttachmentsToXlsDir(workspaceId, xlsxPath) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  const attachmentInfo = await listAttachments(cleanId);
  const xlsDir = path.dirname(xlsxPath);
  await mkdir(xlsDir, { recursive: true });
  for (const attachment of attachmentInfo.attachments) {
    await copyFile(
      path.join(outputDir, "attachments", attachment.fileName),
      path.join(xlsDir, attachment.fileName)
    );
  }
  return attachmentInfo.attachments.length;
}

function terminologyResultPath(outputDir) {
  return path.join(outputDir, "terminology", "question_entities.json");
}

async function workspaceHasPublishedXml(outputDir) {
  try {
    const files = await readdir(path.join(outputDir, "xml"));
    return files.some((name) => name.toLowerCase().endsWith(".xml"));
  } catch {
    return false;
  }
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
  const schemaOriginalExists = existsSync(schemaOriginalDir);
  const schemaProcessedExists = existsSync(schemaProcessedDir);
  const aggregateChunksPath = path.join(schemaProcessedDir, schemaAggregateChunksName);
  const assets = {
    snomed: await fileSummary(latestSnomedLookupPath()),
    icd10: await fileSummary(latestSharedLookupPath("icd10", "icd10_lookup.csv")),
    loinc: await fileSummary(latestLoincPath()),
    rxnorm: await fileSummary(latestRxNormMetadataPath()),
    schemaAggregateChunks: await fileSummary(aggregateChunksPath)
  };
  const missing = Object.entries(assets)
    .filter(([, value]) => !value.ok)
    .map(([key]) => key);
  return {
    ok: missing.length === 0,
    mapperRoot,
    schemaTerminologiesRoot: path.join(mapperRoot, "SchemaTerminologies"),
    schemaOriginalDir,
    schemaOriginalExists,
    schemaProcessedDir,
    schemaProcessedExists,
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

async function defaultTerminologyStatus(workspaceId, outputDir, status = "not_started") {
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
    warnings: [],
    terminologyPath: terminologyResultPath(outputDir)
  };
}

async function loadTerminology(workspaceId) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  const resultPath = terminologyResultPath(outputDir);
  if (!existsSync(resultPath)) return defaultTerminologyStatus(cleanId, outputDir);
  try {
    const data = JSON.parse(await readFile(resultPath, "utf8"));
    return { ok: data.ok !== false, workspaceId: cleanId, terminologyPath: resultPath, ...data };
  } catch (error) {
    return {
      ...(await defaultTerminologyStatus(cleanId, outputDir, "error")),
      ok: false,
      error: `Could not read terminology extraction output: ${error.message || String(error)}`
    };
  }
}

async function startTerminologyExtraction(workspaceId, options = {}) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  if (await workspaceHasPublishedXml(outputDir)) {
    throw new Error("Terminology review is locked after publishing. Create a new version to change mappings.");
  }
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const resultPath = terminologyResultPath(outputDir);
  const draft = JSON.parse(await readFile(draftPath, "utf8"));
  draft.terminologyUseLlm = false;
  draft.updatedAt = isoStamp();
  await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  const questionIds = Array.isArray(options.questionIds)
    ? [...new Set(options.questionIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
  await mkdir(path.dirname(resultPath), { recursive: true });

  if (!options.force && existsSync(resultPath)) {
    try {
      const existing = JSON.parse(await readFile(resultPath, "utf8"));
      if (existing.status === "running") {
        return { ok: true, workspaceId: cleanId, started: false, reason: "already_running", ...existing, terminologyPath: resultPath };
      }
    } catch {}
  }

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
	    rerunQuestionIds: questionIds,
	    terminologyPath: resultPath
	  };
  await writeFile(resultPath, JSON.stringify(initial, null, 2) + "\n", "utf8");

  if (!existsSync(mapperPythonBin)) {
    const failed = {
      ...initial,
      ok: false,
      status: "error",
      completedAt: isoStamp(),
      error: `Mapper Python environment not found: ${mapperPythonBin}`
    };
    await writeFile(resultPath, JSON.stringify(failed, null, 2) + "\n", "utf8");
    return { workspaceId: cleanId, started: false, ...failed };
  }

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
	    { cwd: mapperRoot, env: { ...process.env, PYTHONUNBUFFERED: "1" }, stdio: "ignore", detached: true }
	  );
  child.once("error", async (error) => {
    const failed = {
      ...initial,
      ok: false,
      status: "error",
      completedAt: isoStamp(),
      error: `Could not start terminology extraction: ${error.message || String(error)}`
    };
    try {
      await writeFile(resultPath, JSON.stringify(failed, null, 2) + "\n", "utf8");
    } catch {}
  });
  child.unref();
  return { ok: true, workspaceId: cleanId, started: true, status: "running", terminologyPath: resultPath };
}

async function saveTerminologyReview(workspaceId, payload) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  if (await workspaceHasPublishedXml(outputDir)) {
    throw new Error("Terminology review is locked after publishing. Create a new version to change mappings.");
  }
  const resultPath = terminologyResultPath(outputDir);
  const terminology = payload?.terminology;
  if (!terminology || typeof terminology !== "object") throw new Error("Terminology review payload is required.");
  if (!existsSync(resultPath) && terminology.status !== "skipped_unmapped") {
    throw new Error("Run terminology extraction before saving vocabulary review.");
  }
  const body = {
    ...terminology,
    ok: terminology.ok !== false,
    workspaceId: cleanId,
    reviewUpdatedAt: isoStamp(),
    terminologyPath: resultPath
  };
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(body, null, 2) + "\n", "utf8");
  return { ok: true, workspaceId: cleanId, terminologyPath: resultPath, ...body };
}

async function copyDirIfExists(source, target) {
  if (!existsSync(source)) return;
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function createFormVersion(workspaceId) {
  const loaded = await loadDraft(workspaceId);
  const sourceId = loaded.workspaceId;
  const sourceDraft = loaded.draft;
  const split = splitWorkspaceVersion(sourceDraft.versionBaseId || sourceId);
  const versionBaseId = sourceDraft.versionBaseId || split.baseId;
  await mkdir(outputRoot, { recursive: true });
  const existingNames = await readdir(outputRoot);
  const nextVersionNumber = existingNames.reduce((max, name) => {
    const match = name.match(new RegExp(`^${versionBaseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_v(\\d+)$`, "i"));
    return match ? Math.max(max, Number(match[1])) : max;
  }, splitWorkspaceVersion(sourceId).versionNumber) + 1;
  const nextWorkspaceId = `${versionBaseId}_v${nextVersionNumber}`;
  const outputDir = await ensureWorkspace(nextWorkspaceId);
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
  const draftPath = path.join(outputDir, "drafts", "form.json");
  await writeFile(draftPath, JSON.stringify(nextDraft, null, 2) + "\n", "utf8");
  await copyDirIfExists(path.join(loaded.outputDir, "attachments"), path.join(outputDir, "attachments"));
  const sourceTerminologyPath = terminologyResultPath(loaded.outputDir);
  if (existsSync(sourceTerminologyPath)) {
    const targetTerminologyPath = terminologyResultPath(outputDir);
    const copiedTerminology = JSON.parse(await readFile(sourceTerminologyPath, "utf8"));
    await mkdir(path.dirname(targetTerminologyPath), { recursive: true });
    await writeFile(
      targetTerminologyPath,
      JSON.stringify({
        ...copiedTerminology,
        workspaceId: nextWorkspaceId,
        terminologyPath: targetTerminologyPath,
        copiedFromWorkspaceId: sourceId,
        copiedAt: now
      }, null, 2) + "\n",
      "utf8"
    );
  }
  return loadDraft(nextWorkspaceId);
}

async function updateResponseSettings(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  if (!(await workspaceHasPublishedXml(loaded.outputDir))) {
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
  await writeFile(loaded.draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  return { ok: true, workspaceId: loaded.workspaceId, draft, ...(await workspaceMeta(loaded.workspaceId)) };
}

async function updateCollectionAccess(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const draft = {
    ...loaded.draft,
    collectionLocked: Boolean(payload?.collectionLocked),
    updatedAt: isoStamp()
  };
  await writeFile(loaded.draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  return { ok: true, workspaceId: loaded.workspaceId, draft, ...(await workspaceMeta(loaded.workspaceId)) };
}

async function updateTerminologySettings(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  if (await workspaceHasPublishedXml(loaded.outputDir)) {
    throw new Error("Terminology settings are locked after publishing. Create a new version to change them.");
  }
  const draft = {
    ...loaded.draft,
    terminologyUseLlm: false,
    updatedAt: isoStamp()
  };
  await writeFile(loaded.draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  return { ok: true, workspaceId: loaded.workspaceId, draft, ...(await workspaceMeta(loaded.workspaceId)) };
}

async function checkpointForm(payload) {
  const { cleanId: workspaceId, outputDir } = await requireWorkspace(payload.workspaceId);
  const draft = { ...payload.form, terminologyUseLlm: false, updatedAt: isoStamp() };
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const checkpointPath = path.join(outputDir, "drafts", "checkpoints", `${timestampId()}.json`);
  const body = JSON.stringify(draft, null, 2) + "\n";
  await writeFile(draftPath, body, "utf8");
  await writeFile(checkpointPath, body, "utf8");
  return { ok: true, workspaceId, outputDir, draftPath, checkpointPath, draft, ...(await workspaceMeta(workspaceId)) };
}

async function exportForm(payload) {
  const { cleanId: workspaceId, outputDir } = await requireWorkspace(payload.workspaceId);
  let draft = { ...payload.form, terminologyUseLlm: false, updatedAt: isoStamp() };
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
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const xlsxPath = path.join(outputDir, "xlsform", `${slugify(draft.formId || draft.title)}.xlsx`);
  const xmlPath = path.join(outputDir, "xml", `${slugify(draft.formId || draft.title)}.xml`);

  await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  const exportResult = await runCommand(pythonBin, [exporterPath, draftPath, xlsxPath]);
  const attachmentCount = await syncAttachmentsToXlsDir(workspaceId, xlsxPath);
  if (exportResult.code !== 0) {
    return {
      ok: false,
      stage: "xlsx",
      outputDir,
      draftPath,
      xlsxPath,
      xmlPath,
      stdout: exportResult.stdout,
      stderr: exportResult.stderr
    };
  }

  let xmlResult = { code: 1, stdout: "", stderr: "xls2xform not found" };
  if (existsSync(xls2xformBin)) {
    xmlResult = await runCommand(xls2xformBin, [xlsxPath, xmlPath]);
  }
  let xmlOk = xmlResult.code === 0 && existsSync(xmlPath);
  if (xmlOk) {
    await exposeStartGeopointsInXml(draft, xmlPath);
    xmlOk = existsSync(xmlPath);
  }
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
    await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  }
  const terminology = xmlOk && existsSync(terminologyResultPath(outputDir))
    ? await loadTerminology(workspaceId)
    : null;

  return {
    ok: xmlOk,
    stage: xmlOk ? "complete" : "xml",
    outputDir,
    draftPath,
    xlsxPath,
    xmlPath,
    attachmentCount,
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

  const tempDir = path.join(outputRoot, ".tmp_uploads");
  await mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${timestampId()}_${originalName}`);
  await writeFile(tempPath, Buffer.from(data, "base64"));

  try {
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
  } finally {
    await rm(tempPath, { force: true });
  }
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
  await mkdir(outputRoot, { recursive: true });
  let names = [];
  try {
    names = await readdir(outputRoot);
  } catch {}
  for (const name of names) {
    const draftPath = path.join(outputRoot, name, "drafts", "form.json");
    if (!existsSync(draftPath)) continue;
    try {
      const draft = JSON.parse(await readFile(draftPath, "utf8"));
      if (draft?.metaFormLink?.fileName !== cleanName) continue;
      let published = false;
      try {
        published = (await readdir(path.join(outputRoot, name, "xml"))).some((entry) => entry.endsWith(".xml"));
      } catch {}
      if (!published) continue;
      const variable = String(draft.primaryIdentifierVariable || "").trim();
      if (!variable) continue;
      const question = (draft.questions || []).find((item) => item.name === variable) || null;
      return { variable, question, workspaceId: name, title: draft.title || name };
    } catch {}
  }
  return null;
}

async function metaFormVariableDetails(fileName, formIndex, variable) {
  const cleanName = String(fileName || "").trim();
  const targetFormIndex = Number(formIndex || 0);
  const targetVariable = String(variable || "").trim();
  if (!cleanName || !targetFormIndex || !targetVariable) return null;
  const chunksPath = path.join(schemaProcessedDir, `${safeSchemaStem(cleanName)}.chunks.jsonl`);
  if (!existsSync(chunksPath)) return null;
  const lines = (await readFile(chunksPath, "utf8")).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const chunk = JSON.parse(line);
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
    } catch {}
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
  const outputDir = await ensureWorkspace(workspaceId);
  const xlsxPath = path.join(outputDir, "xlsform", originalName);
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const xmlPath = path.join(outputDir, "xml", `${slugify(title)}.xml`);
  const data = String(payload.dataBase64 || "");
  if (!data) throw new Error("Missing XLSX upload data.");
  await writeFile(xlsxPath, Buffer.from(data, "base64"));

  const importResult = await runCommand(pythonBin, [importerPath, xlsxPath, draftPath]);
  if (importResult.code !== 0) {
    return {
      ok: false,
      stage: "import",
      workspaceId,
      outputDir,
      xlsxPath,
      draftPath,
      xmlPath,
      stdout: importResult.stdout,
      stderr: importResult.stderr
    };
  }
  const draft = JSON.parse(await readFile(draftPath, "utf8"));
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
  await writeFile(draftPath, JSON.stringify(updatedDraft, null, 2) + "\n", "utf8");
  const attachmentCount = await syncAttachmentsToXlsDir(workspaceId, xlsxPath);

  return {
    ok: true,
    stage: "imported",
    workspaceId,
    outputDir,
    xlsxPath,
    draftPath,
    xmlPath,
    attachmentCount,
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

async function readEntries(workspaceId) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const entriesPath = path.join(outputDir, "data", "entries.jsonl");
  if (!existsSync(entriesPath)) return [];
  const text = await readFile(entriesPath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

async function readRespondentCheckpoints(workspaceId) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const checkpointsPath = path.join(outputDir, "data", "checkpoints.jsonl");
  if (!existsSync(checkpointsPath)) return [];
  const text = await readFile(checkpointsPath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeRespondentCheckpoints(workspaceId, checkpoints) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const checkpointsPath = path.join(outputDir, "data", "checkpoints.jsonl");
  await mkdir(path.dirname(checkpointsPath), { recursive: true });
  await writeFile(checkpointsPath, checkpoints.map((item) => JSON.stringify(item)).join("\n") + (checkpoints.length ? "\n" : ""), "utf8");
  return checkpointsPath;
}

async function loadRespondentCheckpoint(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const primaryIdentifierVariable = participantIdentifierForDraft(loaded.draft);
  if (!primaryIdentifierVariable) throw new Error("This form does not have a primary identifier variable.");
  const primaryIdentifierValue = cleanCheckpointIdentifier(payload.primaryIdentifierValue);
  const key = checkpointIdentifierKey(primaryIdentifierValue);
  const checkpoints = await readRespondentCheckpoints(workspaceId);
  const checkpoint = checkpoints.find((item) => item.primaryIdentifierKey === key) || null;
  return {
    workspaceId,
    primaryIdentifierVariable,
    primaryIdentifierValue,
    checkpoint
  };
}

async function deleteRespondentCheckpoint(workspaceId, primaryIdentifierValue) {
  if (!String(primaryIdentifierValue || "").trim()) return null;
  const key = checkpointIdentifierKey(primaryIdentifierValue);
  const checkpoints = await readRespondentCheckpoints(workspaceId);
  const next = checkpoints.filter((item) => item.primaryIdentifierKey !== key);
  if (next.length === checkpoints.length) return null;
  return writeRespondentCheckpoints(workspaceId, next);
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
  const checkpoints = await readRespondentCheckpoints(workspaceId);
  const previous = checkpoints.find((item) => item.primaryIdentifierKey === key);
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
  const next = [
    ...checkpoints.filter((item) => item.primaryIdentifierKey !== key),
    checkpoint
  ];
  const checkpointsPath = await writeRespondentCheckpoints(workspaceId, next);
  return { workspaceId, primaryIdentifierVariable, primaryIdentifierValue, checkpoint, checkpointsPath };
}

async function saveEntriesCsv(workspaceId, draft, entries) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const csvPath = path.join(outputDir, "data", `${slugify(draft.formId || draft.title)}_entries.csv`);
  const headers = dataHeadersForDraft(draft);
  const rows = [headers.map(csvEscape).join(",")];
  for (const entry of entries) {
    rows.push(headers.map((header) => csvEscape(entryValue(entry.answers?.[header]))).join(","));
  }
  await writeFile(csvPath, rows.join("\n") + "\n", "utf8");
  return csvPath;
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
  await writeParticipantRegistry(next);
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

async function saveMapperCsv(workspaceId, draft, entries) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const mapperDir = path.join(outputDir, "data", "mapper_input");
  await mkdir(mapperDir, { recursive: true });
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
  const csvName = `${slugify(draft?.formId || draft?.title || workspaceId)}-generic-fhir.csv`;
  const csvPath = path.join(mapperDir, csvName);
  const rows = [headers.map(csvEscape).join(",")];
  for (const entry of entries) {
    rows.push(headers.map((header) => csvEscape(entryValue(entry.answers?.[header]))).join(","));
  }
  await writeFile(csvPath, rows.join("\n") + "\n", "utf8");
  return {
    csvPath,
    mode: "generic_form_mapper",
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

async function writeEntries(workspaceId, draft, entries) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const entriesPath = path.join(outputDir, "data", "entries.jsonl");
  await mkdir(path.dirname(entriesPath), { recursive: true });
  await writeFile(entriesPath, entries.map((item) => JSON.stringify(item)).join("\n") + (entries.length ? "\n" : ""), "utf8");
  const csvPath = await saveEntriesCsv(workspaceId, draft, entries);
  return { entriesPath, csvPath };
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
  const existing = await readEntries(workspaceId);
  const entries = existing.filter((entry) => !ids.has(String(entry.id || "")));
  if (entries.length === existing.length) {
    const error = new Error("No matching entries were found.");
    error.statusCode = 404;
    throw error;
  }
  const { outputDir } = await requireWorkspace(workspaceId);
  for (const id of ids) {
    const instancePath = path.join(outputDir, "data", `${id}.xml`);
    if (existsSync(instancePath)) {
      await rm(instancePath, { force: true });
    }
  }
  const { entriesPath, csvPath } = await writeEntries(workspaceId, loaded.draft, entries);
  return {
    ok: true,
    workspaceId: loaded.workspaceId,
    deletedCount: existing.length - entries.length,
    entries,
    entriesPath,
    csvPath
  };
}

async function submitEntry(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const submittedAt = isoStamp();
  const answers = payload.answers || {};
  const primaryIdentifierVariable = participantIdentifierForDraft(loaded.draft);
  const existing = await readEntries(workspaceId);
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
      updatedAt,
      instanceName: entryInstanceName(loaded.draft, answers, existing[index].submittedAt || submittedAt),
      answers
    };
    const entries = [...existing];
    entries[index] = entry;
    const { entriesPath, csvPath } = await writeEntries(workspaceId, loaded.draft, entries);
    if (primaryIdentifierVariable && answers[primaryIdentifierVariable]) {
      await deleteRespondentCheckpoint(workspaceId, answers[primaryIdentifierVariable]);
    }
    return { ok: true, workspaceId, entry, entries, entriesPath, csvPath, updated: true };
  }
  const entry = {
    id: `${timestampId()}_${Math.random().toString(36).slice(2, 8)}`,
    submittedAt,
    instanceName: entryInstanceName(loaded.draft, answers, submittedAt),
    answers
  };
  const entries = [...existing, entry];
  const { entriesPath, csvPath } = await writeEntries(workspaceId, loaded.draft, entries);
  if (primaryIdentifierVariable && answers[primaryIdentifierVariable]) {
    await deleteRespondentCheckpoint(workspaceId, answers[primaryIdentifierVariable]);
  }
  return { ok: true, workspaceId, entry, entries, entriesPath, csvPath };
}

async function submitOdkEntry(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const outputDir = loaded.outputDir;
  const instanceXml = String(payload.instanceXml || "").trim();
  if (!instanceXml) throw new Error("ODK submission XML is required.");
  const submittedAt = isoStamp();
  const answers = extractSimpleAnswersFromXml(instanceXml);
  const existing = await readEntries(workspaceId);
  const requestedEntryId = String(payload.entryId || "").trim();
  await assertEntryMutationAllowed(loaded.draft, existing, answers, requestedEntryId);
  if (requestedEntryId) {
    const index = existing.findIndex((item) => String(item.id || "") === requestedEntryId);
    if (index < 0) {
      const error = new Error("Entry not found.");
      error.statusCode = 404;
      throw error;
    }
    const entry = {
      ...existing[index],
      updatedAt: isoStamp(),
      source: "odk-web-forms",
      payloadType: payload?.payloadType || "monolithic",
      submissionMeta: payload?.submissionMeta || null,
      instanceXml,
      answers,
      instanceName: String(answers.instanceName || "").trim() || entryInstanceName(loaded.draft, answers, existing[index].submittedAt || submittedAt)
    };
    const entries = [...existing];
    entries[index] = entry;
    const { entriesPath, csvPath } = await writeEntries(workspaceId, loaded.draft, entries);
    const instancePath = path.join(outputDir, "data", `${entry.id}.xml`);
    await writeFile(instancePath, instanceXml + "\n", "utf8");
    return { ok: true, workspaceId, entry, entries, entriesPath, instancePath, csvPath, updated: true };
  }
  const entry = {
    id: `${timestampId()}_${Math.random().toString(36).slice(2, 8)}`,
    submittedAt,
    source: "odk-web-forms",
    payloadType: payload.payloadType || "monolithic",
    submissionMeta: payload.submissionMeta || null,
    instanceXml,
    answers,
    instanceName: String(answers.instanceName || "").trim() || entryInstanceName(loaded.draft, answers, submittedAt)
  };
  const entries = [...existing, entry];
  const { entriesPath, csvPath } = await writeEntries(workspaceId, loaded.draft, entries);
  const instancePath = path.join(outputDir, "data", `${entry.id}.xml`);
  await writeFile(instancePath, instanceXml + "\n", "utf8");
  return { ok: true, workspaceId, entry, entries, entriesPath, instancePath, csvPath };
}

function patientIdFromBundle(bundle, fallback) {
  const patientEntry = (bundle?.entry || []).find((entry) => entry?.resource?.resourceType === "Patient");
  const patient = patientEntry?.resource || {};
  const identifier = (patient.identifier || []).find((item) => item?.value);
  return identifier?.value || patient.id || fallback || "unknown";
}

async function listFhirBundles(workspaceId) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const bundleDir = path.join(outputDir, "fhir_bundles");
  let names = [];
  try {
    names = (await readdir(bundleDir)).filter((name) => name.endsWith(".json") && name !== "mapper_result.json");
  } catch {}
  const bundles = [];
  for (const fileName of names.sort()) {
    const bundlePath = path.join(bundleDir, fileName);
    try {
      const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
      bundles.push({
        fileName,
        bundlePath,
        patientId: patientIdFromBundle(bundle, fileName.replace(/\.json$/, "")),
        entryCount: Array.isArray(bundle.entry) ? bundle.entry.length : 0,
        bundle,
      });
    } catch (error) {
      bundles.push({ fileName, bundlePath, patientId: fileName.replace(/\.json$/, ""), entryCount: 0, error: error.message });
    }
  }
  return bundles;
}

async function passToMapper(workspaceId) {
  const loaded = await loadDraft(workspaceId);
  const entries = await readEntries(workspaceId);
  if (!entries.length) throw new Error("No filled form entries found. Submit at least one entry before passing to the entity mapper.");

  const outputDir = loaded.outputDir;
  const bundleDir = path.join(outputDir, "fhir_bundles");
  await mkdir(bundleDir, { recursive: true });
  const mapperResultPath = path.join(bundleDir, "mapper_result.json");
  const terminologyPath = terminologyResultPath(outputDir);
  const mapperInput = await saveMapperCsv(workspaceId, loaded.draft, entries);

  if (!existsSync(mapperPythonBin)) throw new Error(`Mapper Python environment not found: ${mapperPythonBin}`);
  if (!mapperInput.primaryIdentifierVariable) {
    throw new Error("Choose a primary identifier variable before running the ICPH mapper.");
  }

  const mapperArgs = [
    mapperRunnerPath,
    mapperInput.csvPath,
    mapperResultPath,
    "--primary-identifier",
    mapperInput.primaryIdentifierVariable
  ];
  mapperArgs.push("--generic-form-draft", loaded.draftPath);
  if (existsSync(terminologyPath)) {
    mapperArgs.push("--terminology-review", terminologyPath);
  }

  const mapperResult = await runCommand(
    mapperPythonBin,
    mapperArgs,
    { cwd: mapperRoot }
  );
  if (mapperResult.code !== 0) {
    return {
      ok: false,
      workspaceId,
      csvPath: mapperInput.csvPath,
      stdout: mapperResult.stdout,
      stderr: mapperResult.stderr || "ICPH entity mapper failed."
    };
  }

  const result = JSON.parse(await readFile(mapperResultPath, "utf8"));
  for (const bundleInfo of result.bundles || []) {
    const sourcePath = bundleInfo.bundle_path;
    if (!sourcePath || !existsSync(sourcePath)) continue;
    const targetPath = path.join(bundleDir, path.basename(sourcePath));
    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
      await copyFile(sourcePath, targetPath);
    }
  }

  const fhirBundles = await listFhirBundles(workspaceId);
  return {
    ok: true,
    workspaceId,
    csvPath: mapperInput.csvPath,
    terminologyPath: existsSync(terminologyPath) ? terminologyPath : null,
    mapperResultPath,
    result,
    fhirBundles,
    stdout: mapperResult.stdout,
    stderr: mapperResult.stderr,
    ...(await workspaceMeta(workspaceId))
  };
}

async function workspaceMeta(workspaceId) {
  const cleanId = cleanWorkspaceId(workspaceId);
  const outputDir = path.join(outputRoot, cleanId);
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const xmlDir = path.join(outputDir, "xml");
  const xlsDir = path.join(outputDir, "xlsform");
  const attachmentDir = path.join(outputDir, "attachments");
  const terminologyPath = terminologyResultPath(outputDir);
  const entries = existsSync(path.join(outputDir, "data", "entries.jsonl")) ? await readEntries(cleanId) : [];
  let xmlFiles = [];
  let xlsxFiles = [];
  let fhirFiles = [];
  let attachmentFiles = [];
  try {
    xmlFiles = (await readdir(xmlDir)).filter((name) => name.endsWith(".xml"));
  } catch {}
  try {
    xlsxFiles = (await readdir(xlsDir)).filter((name) => name.endsWith(".xlsx"));
  } catch {}
  try {
    fhirFiles = (await readdir(path.join(outputDir, "fhir_bundles")))
      .filter((name) => name.endsWith(".json") && name !== "mapper_result.json");
  } catch {}
  try {
    const names = await readdir(attachmentDir);
    for (const name of names) {
      try {
        if ((await stat(path.join(attachmentDir, name))).isFile()) attachmentFiles.push(name);
      } catch {}
    }
  } catch {}
  let draft = null;
  if (existsSync(draftPath)) {
    try {
      draft = JSON.parse(await readFile(draftPath, "utf8"));
    } catch {}
  }
  if (draft && !xmlFiles.length && (draft.respondentAccessCode || draft.publicAccessCode || draft.publishedAt)) {
    delete draft.respondentAccessCode;
    delete draft.publicAccessCode;
    delete draft.respondentCodeMode;
    delete draft.publishedAt;
    draft.updatedAt = isoStamp();
    await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  }
  if (draft && xmlFiles.length && !draft.respondentAccessCode && !draft.publicAccessCode) {
    draft.respondentAccessCode = await generateUniqueRespondentAccessCode(cleanId);
    draft.respondentCodeMode = draft.respondentCodeMode === "custom" ? "custom" : "random";
    draft.publishedAt = draft.publishedAt || isoStamp();
    draft.updatedAt = draft.updatedAt || isoStamp();
    await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  }
  let terminology = null;
  if (existsSync(terminologyPath)) {
    try {
      terminology = JSON.parse(await readFile(terminologyPath, "utf8"));
    } catch {}
  }
  let mtime = new Date(0);
  try {
    mtime = (await stat(outputDir)).mtime;
  } catch {}
  const versionInfo = splitWorkspaceVersion(draft?.versionBaseId || cleanId);
  let pipelineStage = "Building";
  if (fhirFiles.length) pipelineStage = "FHIR";
  else if (entries.length) pipelineStage = "Data collection";
  else if (xmlFiles.length) pipelineStage = "Publishing";
  else if (draft?.buildFinishedAt) pipelineStage = "Terminology";
  return {
    workspaceId: cleanId,
    outputDir,
    title: draft?.title || workspaceId,
    formId: draft?.formId || "",
    pipelineStage,
    questionCount: draft?.questions?.length || 0,
    entryCount: entries.length,
    fhirBundleCount: fhirFiles.length,
    hasXml: xmlFiles.length > 0,
    hasXlsx: xlsxFiles.length > 0,
    hasFhir: fhirFiles.length > 0,
	    hasTerminology: Boolean(terminology),
	    terminologyStatus: terminology?.status || "not_started",
	    terminologyEntityCount: terminology?.entityCount || 0,
	    terminologyPath: existsSync(terminologyPath) ? terminologyPath : null,
	    buildFinishedAt: draft?.buildFinishedAt || null,
    versionNumber: draft?.versionNumber || versionInfo.versionNumber,
    versionBaseId: draft?.versionBaseId || versionInfo.baseId,
    previousVersionWorkspaceId: draft?.previousVersionWorkspaceId || null,
    previousVersionNumber: draft?.previousVersionNumber || null,
    versionChangeSummary: draft?.versionChangeSummary || [],
    hasVersionChanges: formHasVersionChanges(draft || {}),
    attachmentCount: attachmentFiles.length,
    attachmentNames: attachmentFiles.sort((a, b) => a.localeCompare(b)),
    xmlPath: xmlFiles[0] ? path.join(xmlDir, xmlFiles[0]) : null,
    xlsxPath: xlsxFiles[0] ? path.join(xlsDir, xlsxFiles[0]) : null,
    fhirBundlePaths: fhirFiles.map((name) => path.join(outputDir, "fhir_bundles", name)),
    updatedAt: draft?.updatedAt || mtime.toISOString(),
    importedFrom: draft?.importedFrom || null,
    metaFormLink: draft?.metaFormLink || null,
    folderId: draft?.folderId || null,
    primaryIdentifierVariable: draft?.primaryIdentifierVariable || null,
    participantIdentifierVariable: draft?.participantIdentifierVariable || draft?.primaryIdentifierVariable || null,
    folderPrimaryIdentifierVariable: draft?.folderId
      ? (String((await readFolders()).find((folder) => folder.id === draft.folderId)?.primaryIdentifierVariable || "").trim() || null)
      : null,
    folderParticipantIdentifierVariable: draft?.folderId
      ? (String((await readFolders()).find((folder) => folder.id === draft.folderId)?.participantIdentifierVariable || "").trim() || null)
      : null,
    responseSettings: normalizeResponseSettings(draft || {}),
    collectionLocked: Boolean(draft?.collectionLocked),
    buildFinishedAt: draft?.buildFinishedAt || null,
    publishedAt: draft?.publishedAt || null,
    respondentAccessCode: draft?.respondentAccessCode || draft?.publicAccessCode || null,
  };
}

async function listForms() {
  await mkdir(outputRoot, { recursive: true });
  const names = await readdir(outputRoot);
  const forms = [];
  for (const name of names) {
    const fullPath = path.join(outputRoot, name);
    try {
      if (!(await stat(fullPath)).isDirectory()) continue;
      if (!existsSync(path.join(fullPath, "drafts", "form.json"))) continue;
      forms.push(await workspaceMeta(name));
    } catch {}
  }
  forms.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { ok: true, forms, outputRoot };
}

async function deleteForm(workspaceId) {
  const cleanId = cleanWorkspaceId(workspaceId);
  const outputDir = path.resolve(outputRoot, cleanId);
  const safeRoot = path.resolve(outputRoot) + path.sep;
  if (!outputDir.startsWith(safeRoot)) {
    throw new Error("Refusing to delete a folder outside the ICPH forms output directory.");
  }
  if (!existsSync(path.join(outputDir, "drafts", "form.json"))) {
    throw new Error("Refusing to delete this folder because it does not look like a form workspace.");
  }
  let draft = null;
  try {
    draft = JSON.parse(await readFile(path.join(outputDir, "drafts", "form.json"), "utf8"));
  } catch {}
  await rm(outputDir, { recursive: true, force: false });
  const registry = await readParticipantRegistry();
  const remainingRegistry = registry.filter((item) => item.workspaceId !== cleanId);
  if (remainingRegistry.length !== registry.length) await writeParticipantRegistry(remainingRegistry);
  await releaseSharedIdentifiersForForm(draft);
  return { ok: true, workspaceId: cleanId, deletedPath: outputDir };
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return jsonResponse(res, 200, { ok: true });
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    if (req.method === "GET" && pathname === "/api/health") {
      return jsonResponse(res, 200, { ok: true, outputRoot });
    }
    if (req.method === "POST" && pathname === "/api/admin/login") {
      return jsonResponse(res, 200, await loginAdmin(await requestBody(req)));
    }
    if (req.method === "GET" && pathname === "/api/admin/session") {
      return jsonResponse(res, 200, { ok: true, authenticated: isAdminRequest(req) });
    }
    const publicFormMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)$/);
    const publicXmlMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/xml$/);
    const publicEntriesMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/entries$/);
    const publicCheckpointMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/checkpoint$/);
    const publicOdkSubmissionMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/odk-submissions$/);
    const publicAttachmentFileMatch = pathname.match(/^\/api\/public\/forms\/([^/]+)\/attachments\/([^/]+)$/);
    if (req.method === "GET" && pathname === "/api/public/forms") {
      return jsonResponse(res, 200, await listPublicForms());
    }
    if (req.method === "GET" && publicFormMatch) {
      return jsonResponse(res, 200, await loadPublicForm(decodeURIComponent(publicFormMatch[1])));
    }
    if (req.method === "GET" && publicXmlMatch) {
      return jsonResponse(res, 200, await loadPublicFormXml(decodeURIComponent(publicXmlMatch[1])));
    }
    if (req.method === "GET" && publicAttachmentFileMatch) {
      const attachment = await loadPublicAttachment(decodeURIComponent(publicAttachmentFileMatch[1]), decodeURIComponent(publicAttachmentFileMatch[2]));
      return binaryResponse(res, 200, attachment.data, attachment.contentType);
    }
    if (req.method === "POST" && publicEntriesMatch) {
      return jsonResponse(res, 200, await submitPublicEntry(decodeURIComponent(publicEntriesMatch[1]), await requestBody(req)));
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
      return jsonResponse(res, 200, await submitPublicOdkEntry(decodeURIComponent(publicOdkSubmissionMatch[1]), await requestBody(req)));
    }
    assertAdmin(req);
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
      return jsonResponse(res, 200, await submitEntry(decodeURIComponent(entriesMatch[1]), await requestBody(req)));
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
      return jsonResponse(res, 200, await submitOdkEntry(decodeURIComponent(odkSubmissionMatch[1]), await requestBody(req)));
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
    jsonResponse(res, status, { ok: false, error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`ICPH form-builder API listening on http://localhost:${port}`);
  console.log(`Output root: ${outputRoot}`);
});
