import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const icphRoot = path.resolve(appRoot, "..");
const outputRoot = path.join(icphRoot, "output", "forms");
const odkVenvBin = path.join(icphRoot, "ODK", ".venv-xlsform", "bin");
const pythonBin = path.join(odkVenvBin, "python");
const xls2xformBin = path.join(odkVenvBin, "xls2xform");
const exporterPath = path.join(appRoot, "scripts", "export_xlsform.py");
const importerPath = path.join(appRoot, "scripts", "import_xlsform.py");
const inspectorPath = path.join(appRoot, "scripts", "inspect_xlsform.py");
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

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(body);
}

function binaryResponse(res, status, body, contentType = "application/octet-stream") {
  res.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type"
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

function timestampId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function isoStamp() {
  return new Date().toISOString();
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

function instanceNameForPrimaryIdentifier(primaryIdentifierVariable) {
  const variable = String(primaryIdentifierVariable || "").trim();
  if (!variable) return "";
  return `concat(\${${variable}}, ' - ', format-date-time(now(), '%Y-%m-%d %H:%M:%S'))`;
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

  await rm(sourcePath, { force: true });
  await rm(markdownPath, { force: true });
  await rm(chunksPath, { force: true });

  const manifest = await readSchemaManifest();
  manifest.documents = manifest.documents || {};
  delete manifest.documents[cleanName];
  await rebuildSchemaAggregate(manifest);
  await writeSchemaManifest(manifest);

  return { ok: true, deleted: { fileName: cleanName, sourcePath, markdownPath, chunksPath }, ...(await listSchemaDocuments()) };
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

async function createForm(payload) {
  const title = String(payload.title || "Untitled ICPH Form").trim();
  const formId = slugify(payload.formId || title).replace(/-/g, "_");
  const workspaceId = `${timestampId()}_${slugify(title)}`;
  const outputDir = await ensureWorkspace(workspaceId);
  const draft = {
    title,
    formId,
    version: payload.version || "1",
    instanceName: "",
    defaultLanguage: "english",
    questions: [],
    createdAt: isoStamp(),
    updatedAt: isoStamp()
  };
  const draftPath = path.join(outputDir, "drafts", "form.json");
  await writeFile(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  return { workspaceId, outputDir, draftPath, draft };
}

async function loadDraft(workspaceId) {
  const { cleanId, outputDir } = await requireWorkspace(workspaceId);
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const draft = JSON.parse(await readFile(draftPath, "utf8"));
  return { workspaceId: cleanId, outputDir, draftPath, draft, ...(await workspaceMeta(cleanId)) };
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

let snomedSearchPromise = null;

async function loadSnomedSearchIndex() {
  if (snomedSearchPromise) return snomedSearchPromise;
  snomedSearchPromise = (async () => {
    const lookupPath = latestSnomedLookupPath();
    if (!lookupPath) throw new Error("Local SNOMED lookup CSV was not found.");
    const text = await readFile(lookupPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines.shift() || "");
    const headerIndex = Object.fromEntries(headers.map((name, index) => [name, index]));
    const rows = [];
    const tokenIndex = new Map();
    const exactIndex = new Map();

    for (const line of lines) {
      const values = parseCsvLine(line);
      const row = {
        code: values[headerIndex.code] || "",
        display: values[headerIndex.display] || "",
        fsn: values[headerIndex.fsn] || "",
        preferredTerm: values[headerIndex.preferred_term] || values[headerIndex.display] || "",
        status: values[headerIndex.status] || "",
        systemUri: values[headerIndex.system_uri] || "http://snomed.info/sct"
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
  })();
  return snomedSearchPromise;
}

function scoreSnomedRow(row, query, queryKey, tokens, exactCode) {
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

async function searchSnomedTerms(query, options = {}) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return { ok: true, query: cleanQuery, results: [] };
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 50);
  const exactCode = String(options.selectedCode || "").trim();
  const { rows, tokenIndex, exactIndex } = await loadSnomedSearchIndex();
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
      return { row, score: scoreSnomedRow(row, cleanQuery, queryKey, tokens, exactCode) };
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
      score: Number(score.toFixed(2)),
      selected: Boolean(exactCode && row.code === exactCode)
    }));

  return { ok: true, query: cleanQuery, results: scored };
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
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const resultPath = terminologyResultPath(outputDir);
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
    [terminologyExtractorPath, draftPath, resultPath, "--mapper-root", mapperRoot],
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

async function checkpointForm(payload) {
  const { cleanId: workspaceId, outputDir } = await requireWorkspace(payload.workspaceId);
  const draft = { ...payload.form, updatedAt: isoStamp() };
  const draftPath = path.join(outputDir, "drafts", "form.json");
  const checkpointPath = path.join(outputDir, "drafts", "checkpoints", `${timestampId()}.json`);
  const body = JSON.stringify(draft, null, 2) + "\n";
  await writeFile(draftPath, body, "utf8");
  await writeFile(checkpointPath, body, "utf8");
  return { ok: true, workspaceId, outputDir, draftPath, checkpointPath, draft, ...(await workspaceMeta(workspaceId)) };
}

async function exportForm(payload) {
  const { cleanId: workspaceId, outputDir } = await requireWorkspace(payload.workspaceId);
  const draft = { ...payload.form, updatedAt: isoStamp() };
  const fieldNames = new Set((draft.questions || []).map((question) => question.name).filter(Boolean));
  if (draft.primaryIdentifierVariable && !fieldNames.has(draft.primaryIdentifierVariable)) {
    throw new Error(`Primary identifier variable "${draft.primaryIdentifierVariable}" is not present in this form.`);
  }
  if (draft.primaryIdentifierVariable) {
    draft.instanceName = instanceNameForPrimaryIdentifier(draft.primaryIdentifierVariable);
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
  let terminology = null;
  if (xmlResult.code === 0) {
    try {
      terminology = await startTerminologyExtraction(workspaceId, { force: true });
    } catch (error) {
      terminology = {
        ok: false,
        status: "error",
        error: `Terminology extraction did not start: ${error.message || String(error)}`
      };
    }
  }

  return {
    ok: xmlResult.code === 0,
    stage: xmlResult.code === 0 ? "complete" : "xml",
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
    linkedAt: isoStamp()
  };
}

async function importXlsx(payload) {
  const originalName = cleanXlsxName(payload.filename);
  const title = originalName.replace(/\.[^.]+$/, "");
  const workspaceId = `${timestampId()}_${slugify(title)}`;
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
  const variableNames = new Set((draft.questions || []).map((question) => question.name).filter(Boolean));
  const primaryIdentifierVariable = String(payload.primaryIdentifierVariable || "").trim();
  if (!primaryIdentifierVariable) throw new Error("Choose the primary identifier variable for this XLSForm.");
  if (!variableNames.has(primaryIdentifierVariable)) {
    throw new Error(`Primary identifier variable "${primaryIdentifierVariable}" is not present in the XLSForm survey name column.`);
  }
  const metaFormLink = normalizeMetaFormLink(payload);
  const updatedDraft = {
    ...draft,
    importedFrom: originalName,
    metaFormLink,
    primaryIdentifierVariable,
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

async function saveEntriesCsv(workspaceId, draft, entries) {
  const { outputDir } = await requireWorkspace(workspaceId);
  const csvPath = path.join(outputDir, "data", `${slugify(draft.formId || draft.title)}_entries.csv`);
  const headers = (draft.questions || [])
    .filter((question) => question.type !== "note")
    .map((question) => question.name);
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

function mapperHeadersForDraft(draft) {
  const seen = new Set();
  return (draft.questions || [])
    .filter((question) => question?.name && question.type !== "note")
    .map((question) => String(question.name).trim())
    .filter((name) => {
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
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

async function submitEntry(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const outputDir = loaded.outputDir;
  const submittedAt = isoStamp();
  const answers = payload.answers || {};
  const entry = {
    id: `${timestampId()}_${Math.random().toString(36).slice(2, 8)}`,
    submittedAt,
    instanceName: entryInstanceName(loaded.draft, answers, submittedAt),
    answers
  };
  const entriesPath = path.join(outputDir, "data", "entries.jsonl");
  const existing = await readEntries(workspaceId);
  const entries = [...existing, entry];
  await writeFile(entriesPath, entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  const csvPath = await saveEntriesCsv(workspaceId, loaded.draft, entries);
  return { ok: true, workspaceId, entry, entries, entriesPath, csvPath };
}

async function submitOdkEntry(workspaceId, payload) {
  const loaded = await loadDraft(workspaceId);
  const outputDir = loaded.outputDir;
  const instanceXml = String(payload.instanceXml || "").trim();
  if (!instanceXml) throw new Error("ODK submission XML is required.");
  const submittedAt = isoStamp();
  const answers = extractSimpleAnswersFromXml(instanceXml);
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
  const entriesPath = path.join(outputDir, "data", "entries.jsonl");
  const existing = await readEntries(workspaceId);
  const entries = [...existing, entry];
  await writeFile(entriesPath, entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  const instancePath = path.join(outputDir, "data", `${entry.id}.xml`);
  await writeFile(instancePath, instanceXml + "\n", "utf8");
  const csvPath = await saveEntriesCsv(workspaceId, loaded.draft, entries);
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
  let pipelineStage = "Building";
  if (xmlFiles.length) pipelineStage = "Publishing";
  if (entries.length) pipelineStage = "Data collection";
  if (fhirFiles.length) pipelineStage = "FHIR";
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
    attachmentCount: attachmentFiles.length,
    attachmentNames: attachmentFiles.sort((a, b) => a.localeCompare(b)),
    xmlPath: xmlFiles[0] ? path.join(xmlDir, xmlFiles[0]) : null,
    xlsxPath: xlsxFiles[0] ? path.join(xlsDir, xlsxFiles[0]) : null,
    fhirBundlePaths: fhirFiles.map((name) => path.join(outputDir, "fhir_bundles", name)),
    updatedAt: draft?.updatedAt || mtime.toISOString(),
    importedFrom: draft?.importedFrom || null,
    metaFormLink: draft?.metaFormLink || null,
    primaryIdentifierVariable: draft?.primaryIdentifierVariable || null,
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
  await rm(outputDir, { recursive: true, force: false });
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
    if (req.method === "GET" && pathname === "/api/forms") {
      return jsonResponse(res, 200, await listForms());
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
    const fhirMatch = pathname.match(/^\/api\/forms\/([^/]+)\/fhir$/);
    const terminologyMatch = pathname.match(/^\/api\/forms\/([^/]+)\/terminology$/);
    const xmlMatch = pathname.match(/^\/api\/forms\/([^/]+)\/xml$/);
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
    if (req.method === "GET" && fhirMatch) {
      return jsonResponse(res, 200, { ok: true, fhirBundles: await listFhirBundles(decodeURIComponent(fhirMatch[1])) });
    }
    if (req.method === "GET" && terminologyMatch) {
      return jsonResponse(res, 200, await loadTerminology(decodeURIComponent(terminologyMatch[1])));
    }
    if (req.method === "GET" && xmlMatch) {
      return jsonResponse(res, 200, await loadFormXml(decodeURIComponent(xmlMatch[1])));
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
      return jsonResponse(res, 200, await startTerminologyExtraction(decodeURIComponent(terminologyMatch[1]), { force: true }));
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
    const status = /not found/i.test(message) ? 404 : 500;
    jsonResponse(res, status, { ok: false, error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`ICPH form-builder API listening on http://localhost:${port}`);
  console.log(`Output root: ${outputRoot}`);
});
