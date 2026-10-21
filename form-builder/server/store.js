// SQL for everything the form builder persists. Callers pass and receive the
// same plain objects the API serves; see migrations/001_init.sql for the schema.
import { query } from "./db.js";

const json = (value) => JSON.stringify(value);
const iso = (value) => (value instanceof Date ? value.toISOString() : value || null);

// ---- folders ---------------------------------------------------------------

function folderFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    primaryIdentifierVariable: row.primary_identifier_variable,
    participantIdentifierMode: row.participant_identifier_mode,
    participantIdentifierVariable: row.participant_identifier_variable,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export async function listFolders() {
  return (await query("SELECT * FROM folders ORDER BY created_at, id")).rows.map(folderFromRow);
}

export async function insertFolder(id, name) {
  const result = await query("INSERT INTO folders (id, name) VALUES ($1, $2) RETURNING *", [id, name]);
  return folderFromRow(result.rows[0]);
}

export async function updateFolderIdentifiers(id, { primaryIdentifierVariable, participantIdentifierMode, participantIdentifierVariable }) {
  await query(
    `UPDATE folders SET
       primary_identifier_variable = coalesce($2, primary_identifier_variable),
       participant_identifier_mode = coalesce($3, participant_identifier_mode),
       participant_identifier_variable = coalesce($4, participant_identifier_variable),
       updated_at = now()
     WHERE id = $1`,
    [id, primaryIdentifierVariable ?? null, participantIdentifierMode ?? null, participantIdentifierVariable ?? null]
  );
}

export async function deleteFolder(id) {
  await query("DELETE FROM folders WHERE id = $1", [id]);
}

// ---- forms -----------------------------------------------------------------

const formSummaryColumns = `
  f.workspace_id, f.draft, f.updated_at,
  f.xml IS NOT NULL AS has_xml,
  f.xlsx IS NOT NULL AS has_xlsx,
  f.terminology IS NOT NULL AS has_terminology,
  f.terminology->>'status' AS terminology_status,
  f.terminology->>'entityCount' AS terminology_entity_count,
  (SELECT count(*)::int FROM entries e WHERE e.workspace_id = f.workspace_id) AS entry_count,
  (SELECT count(*)::int FROM fhir_bundles b WHERE b.workspace_id = f.workspace_id) AS fhir_bundle_count,
  ARRAY(SELECT a.file_name FROM form_attachments a WHERE a.workspace_id = f.workspace_id) AS attachment_names`;

export async function formSummary(workspaceId) {
  return (await query(`SELECT ${formSummaryColumns} FROM forms f WHERE f.workspace_id = $1`, [workspaceId])).rows[0] || null;
}

export async function formSummaries() {
  return (await query(`SELECT ${formSummaryColumns} FROM forms f`)).rows;
}

export async function formExists(workspaceId) {
  return (await query("SELECT 1 FROM forms WHERE workspace_id = $1", [workspaceId])).rowCount > 0;
}

export async function formHasXml(workspaceId) {
  return (await query("SELECT 1 FROM forms WHERE workspace_id = $1 AND xml IS NOT NULL", [workspaceId])).rowCount > 0;
}

// Holds the form for the rest of the transaction so writers to it run one at a time.
export async function lockForm(workspaceId) {
  await query("SELECT 1 FROM forms WHERE workspace_id = $1 FOR NO KEY UPDATE", [workspaceId]);
}

export async function insertForm({ workspaceId, versionBaseId, versionNumber, folderId, draft, xlsxName = null, xlsx = null }) {
  await query(
    `INSERT INTO forms (workspace_id, version_base_id, version_number, folder_id, draft, xlsx_name, xlsx)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [workspaceId, versionBaseId, versionNumber, folderId, json(draft), xlsxName, xlsx]
  );
}

export async function getDraft(workspaceId) {
  return (await query("SELECT draft FROM forms WHERE workspace_id = $1", [workspaceId])).rows[0]?.draft || null;
}

export async function saveDraft(workspaceId, draft, { folderId, respondentAccessCode }) {
  await query(
    "UPDATE forms SET draft = $2, folder_id = $3, respondent_access_code = $4, updated_at = now() WHERE workspace_id = $1",
    [workspaceId, json(draft), folderId, respondentAccessCode]
  );
}

export async function deleteForm(workspaceId) {
  await query("DELETE FROM forms WHERE workspace_id = $1", [workspaceId]);
}

export async function maxVersionNumber(versionBaseId) {
  return (await query("SELECT coalesce(max(version_number), 0)::int AS max FROM forms WHERE version_base_id = $1", [versionBaseId])).rows[0].max;
}

// A locked form keeps its code but cannot be opened with it.
export async function findOpenFormByAccessCode(code) {
  const result = await query(
    `SELECT workspace_id, draft FROM forms
     WHERE respondent_access_code = $1 AND coalesce((draft->>'collectionLocked')::boolean, false) = false`,
    [code]
  );
  return result.rows[0] || null;
}

export async function accessCodeOwner(code) {
  return (await query("SELECT workspace_id FROM forms WHERE respondent_access_code = $1", [code])).rows[0]?.workspace_id || null;
}

export async function setFormXlsx(workspaceId, fileName, data) {
  await query("UPDATE forms SET xlsx_name = $2, xlsx = $3, updated_at = now() WHERE workspace_id = $1", [workspaceId, fileName, data]);
}

export async function getFormXlsx(workspaceId) {
  const row = (await query("SELECT xlsx_name, xlsx FROM forms WHERE workspace_id = $1 AND xlsx IS NOT NULL", [workspaceId])).rows[0];
  return row ? { fileName: row.xlsx_name, data: row.xlsx } : null;
}

export async function setFormXml(workspaceId, fileName, xml) {
  await query("UPDATE forms SET xml_name = $2, xml = $3, updated_at = now() WHERE workspace_id = $1", [workspaceId, fileName, xml]);
}

export async function getFormXml(workspaceId) {
  return (await query("SELECT xml FROM forms WHERE workspace_id = $1", [workspaceId])).rows[0]?.xml || null;
}

export async function getTerminology(workspaceId) {
  return (await query("SELECT terminology FROM forms WHERE workspace_id = $1", [workspaceId])).rows[0]?.terminology || null;
}

export async function setTerminology(workspaceId, terminology) {
  await query("UPDATE forms SET terminology = $2 WHERE workspace_id = $1", [workspaceId, json(terminology)]);
}

export async function insertFormCheckpoint(workspaceId, draft) {
  await query("INSERT INTO form_checkpoints (workspace_id, draft) VALUES ($1, $2)", [workspaceId, json(draft)]);
}

// ---- form attachments ------------------------------------------------------

export async function listFormAttachments(workspaceId) {
  const result = await query(
    "SELECT file_name, octet_length(data) AS size_bytes, updated_at FROM form_attachments WHERE workspace_id = $1",
    [workspaceId]
  );
  return result.rows.map((row) => ({ fileName: row.file_name, sizeBytes: row.size_bytes, updatedAt: iso(row.updated_at) }));
}

export async function readFormAttachments(workspaceId) {
  const result = await query("SELECT file_name, data FROM form_attachments WHERE workspace_id = $1", [workspaceId]);
  return result.rows.map((row) => ({ fileName: row.file_name, data: row.data }));
}

export async function getFormAttachment(workspaceId, fileName) {
  return (await query("SELECT data FROM form_attachments WHERE workspace_id = $1 AND file_name = $2", [workspaceId, fileName])).rows[0]?.data || null;
}

export async function putFormAttachment(workspaceId, fileName, data) {
  await query(
    `INSERT INTO form_attachments (workspace_id, file_name, data) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, file_name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [workspaceId, fileName, data]
  );
}

export async function deleteFormAttachment(workspaceId, fileName) {
  await query("DELETE FROM form_attachments WHERE workspace_id = $1 AND file_name = $2", [workspaceId, fileName]);
}

export async function copyFormAttachments(fromWorkspaceId, toWorkspaceId) {
  await query(
    `INSERT INTO form_attachments (workspace_id, file_name, data, updated_at)
     SELECT $2, file_name, data, updated_at FROM form_attachments WHERE workspace_id = $1`,
    [fromWorkspaceId, toWorkspaceId]
  );
}

// ---- entries ---------------------------------------------------------------

export async function listEntries(workspaceId) {
  return (await query("SELECT data FROM entries WHERE workspace_id = $1 ORDER BY seq", [workspaceId])).rows.map((row) => row.data);
}

export async function insertEntry(workspaceId, entry) {
  await query(
    "INSERT INTO entries (workspace_id, id, client_submission_id, user_id, data, submitted_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [workspaceId, entry.id, entry.clientSubmissionId || null, entry.userId, json(entry), entry.submittedAt]
  );
}

export async function updateEntry(workspaceId, entry) {
  await query(
    "UPDATE entries SET client_submission_id = $3, data = $4 WHERE workspace_id = $1 AND id = $2",
    [workspaceId, entry.id, entry.clientSubmissionId || null, json(entry)]
  );
}

export async function deleteEntries(workspaceId, ids) {
  await query("DELETE FROM entries WHERE workspace_id = $1 AND id = ANY($2::text[])", [workspaceId, ids]);
}

export async function putEntryAttachment(workspaceId, entryId, { fileName, contentType, data }) {
  await query(
    `INSERT INTO entry_attachments (workspace_id, entry_id, file_name, content_type, data) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, entry_id, file_name) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data`,
    [workspaceId, entryId, fileName, contentType, data]
  );
}

export async function getEntryAttachment(workspaceId, entryId, fileName) {
  const row = (await query(
    "SELECT content_type, data FROM entry_attachments WHERE workspace_id = $1 AND entry_id = $2 AND file_name = $3",
    [workspaceId, entryId, fileName]
  )).rows[0];
  return row ? { contentType: row.content_type, data: row.data } : null;
}

// ---- respondent checkpoints ------------------------------------------------

export async function listRespondentCheckpoints(workspaceId) {
  return (await query("SELECT data FROM respondent_checkpoints WHERE workspace_id = $1 ORDER BY saved_at", [workspaceId])).rows.map((row) => row.data);
}

export async function getRespondentCheckpoint(workspaceId, identifierKey) {
  return (await query(
    "SELECT data FROM respondent_checkpoints WHERE workspace_id = $1 AND identifier_key = $2",
    [workspaceId, identifierKey]
  )).rows[0]?.data || null;
}

export async function putRespondentCheckpoint(workspaceId, identifierKey, checkpoint) {
  await query(
    `INSERT INTO respondent_checkpoints (workspace_id, identifier_key, data, saved_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, identifier_key) DO UPDATE SET data = EXCLUDED.data, saved_at = EXCLUDED.saved_at`,
    [workspaceId, identifierKey, json(checkpoint), checkpoint.savedAt]
  );
}

export async function deleteRespondentCheckpoint(workspaceId, identifierKey) {
  await query("DELETE FROM respondent_checkpoints WHERE workspace_id = $1 AND identifier_key = $2", [workspaceId, identifierKey]);
}

// ---- participant registry and MetaForm primaries ---------------------------

export async function listParticipantRegistry() {
  return (await query("SELECT data FROM participant_registry ORDER BY assigned_at, id")).rows.map((row) => row.data);
}

export async function putParticipantAssignment(record) {
  await query(
    `INSERT INTO participant_registry (id, workspace_id, barcode, data, assigned_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, barcode = EXCLUDED.barcode,
       data = EXCLUDED.data, assigned_at = EXCLUDED.assigned_at`,
    [record.id, record.workspaceId, record.barcode, json(record), record.assignedAt]
  );
}

export async function listMetaFormPrimaries() {
  const rows = (await query("SELECT file_name, variable FROM meta_form_primaries")).rows;
  return Object.fromEntries(rows.map((row) => [row.file_name, row.variable]));
}

export async function insertMetaFormPrimary(fileName, variable) {
  await query("INSERT INTO meta_form_primaries (file_name, variable) VALUES ($1, $2) ON CONFLICT (file_name) DO NOTHING", [fileName, variable]);
}

export async function deleteMetaFormPrimary(fileName) {
  await query("DELETE FROM meta_form_primaries WHERE file_name = $1", [fileName]);
}

// ---- MetaForm documents ----------------------------------------------------

function metaFormFromRow(row) {
  return {
    fileName: row.file_name,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    chunks: row.chunks,
    formCount: row.form_count,
    variableCount: row.variable_count,
    chunkCount: row.chunk_count,
    uploadedAt: iso(row.uploaded_at),
    processedAt: iso(row.processed_at)
  };
}

// Everything but the DOCX and Markdown, which only processing needs.
export async function listMetaForms() {
  const result = await query(
    `SELECT file_name, sha256, octet_length(docx) AS size_bytes, chunks, form_count, variable_count,
       chunk_count, uploaded_at, processed_at
     FROM meta_forms ORDER BY file_name`
  );
  return result.rows.map(metaFormFromRow);
}

export async function metaFormExists(fileName) {
  return (await query("SELECT 1 FROM meta_forms WHERE file_name = $1", [fileName])).rowCount > 0;
}

export async function getMetaFormChunks(fileName) {
  return (await query("SELECT chunks FROM meta_forms WHERE file_name = $1", [fileName])).rows[0]?.chunks || null;
}

// The DOCX of each named document, or of every document when fileNames is null.
export async function listMetaFormDocx(fileNames = null) {
  const result = await query(
    "SELECT file_name, docx FROM meta_forms WHERE $1::text[] IS NULL OR file_name = ANY($1) ORDER BY file_name",
    [fileNames]
  );
  return result.rows.map((row) => ({ fileName: row.file_name, data: row.docx }));
}

// Unprocessed, or processed without finding any forms.
export async function listUnprocessedMetaFormNames() {
  const result = await query("SELECT file_name FROM meta_forms WHERE processed_at IS NULL OR chunk_count = 0 ORDER BY file_name");
  return result.rows.map((row) => row.file_name);
}

export async function metaFormTotals() {
  const row = (await query("SELECT count(*)::int AS documents, coalesce(sum(chunk_count), 0)::int AS chunks FROM meta_forms")).rows[0];
  return { documentCount: row.documents, chunkCount: row.chunks };
}

// Returns false when a document with that name already exists.
export async function insertMetaForm({ fileName, docx, sha256, processed = null }) {
  const result = await query(
    `INSERT INTO meta_forms (file_name, docx, sha256, markdown, chunks, form_count, variable_count, chunk_count, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (file_name) DO NOTHING`,
    [
      fileName, docx, sha256,
      processed?.markdown ?? null, processed ? json(processed.chunks) : null,
      processed?.formCount || 0, processed?.variableCount || 0, processed?.chunks.length || 0,
      processed?.processedAt || null
    ]
  );
  return result.rowCount > 0;
}

export async function setMetaFormProcessed(fileName, { markdown, chunks, formCount, variableCount }) {
  await query(
    `UPDATE meta_forms SET markdown = $2, chunks = $3, form_count = $4, variable_count = $5, chunk_count = $6,
       processed_at = now()
     WHERE file_name = $1`,
    [fileName, markdown, json(chunks), formCount, variableCount, chunks.length]
  );
}

export async function deleteMetaForm(fileName) {
  await query("DELETE FROM meta_forms WHERE file_name = $1", [fileName]);
}

// ---- one-time tasks --------------------------------------------------------

export async function taskCompleted(name) {
  return (await query("SELECT 1 FROM completed_tasks WHERE name = $1", [name])).rowCount > 0;
}

export async function markTaskCompleted(name) {
  await query("INSERT INTO completed_tasks (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
}

// ---- FHIR bundles ----------------------------------------------------------

export async function listFhirBundles(workspaceId) {
  const result = await query("SELECT file_name, bundle FROM fhir_bundles WHERE workspace_id = $1 ORDER BY file_name", [workspaceId]);
  return result.rows.map((row) => ({ fileName: row.file_name, bundle: row.bundle }));
}

export async function putFhirBundle(workspaceId, fileName, bundle) {
  await query(
    `INSERT INTO fhir_bundles (workspace_id, file_name, bundle) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, file_name) DO UPDATE SET bundle = EXCLUDED.bundle, created_at = now()`,
    [workspaceId, fileName, json(bundle)]
  );
}
