// SQL for everything the form builder persists. Callers pass and receive the
// same plain objects the API serves; see migrations/001_init.sql for the schema.
import { query, withTransaction } from "./db.js";

const json = (value) => JSON.stringify(value);
const iso = (value) => (value instanceof Date ? value.toISOString() : value || null);

// ---- folders ---------------------------------------------------------------

function folderFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id || "",
    primaryIdentifierVariable: row.primary_identifier_variable,
    participantIdentifierMode: row.participant_identifier_mode,
    participantIdentifierVariable: row.participant_identifier_variable,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export async function listFolders() {
  const folders = (await query("SELECT * FROM folders ORDER BY created_at, id")).rows.map(folderFromRow);
  if (!folders.length) return folders;
  const members = (await query("SELECT folder_id, user_id, username, access_role, added_at FROM folder_members ORDER BY lower(username)")).rows;
  const byFolder = new Map(folders.map((folder) => [folder.id, []]));
  for (const member of members) {
    byFolder.get(member.folder_id)?.push({
      userId: member.user_id,
      username: member.username,
      accessRole: member.access_role,
      addedAt: iso(member.added_at)
    });
  }
  return folders.map((folder) => ({ ...folder, members: byFolder.get(folder.id) || [] }));
}

export async function insertFolder(id, name, ownerUserId) {
  const result = await query(
    "INSERT INTO folders (id, name, project_code, owner_user_id) VALUES ($1, $2, $1, $3) RETURNING *",
    [id, name, ownerUserId]
  );
  return folderFromRow(result.rows[0]);
}

export async function folderAccess(folderId, userId) {
  return (await query(
    `SELECT 1 FROM folders f
      WHERE f.id = $1 AND (f.owner_user_id = $2 OR EXISTS (
        SELECT 1 FROM folder_members m WHERE m.folder_id = f.id AND m.user_id = $2 AND m.access_role = 'admin'
      ))`,
    [folderId, userId]
  )).rowCount > 0;
}

export async function folderOwner(folderId) {
  return (await query("SELECT owner_user_id FROM folders WHERE id = $1", [folderId])).rows[0]?.owner_user_id || "";
}

export async function addFolderMember(folderId, { userId, username, accessRole, addedBy }) {
  if (!userId || !username || !addedBy) {
    throw new Error("Sharing a project requires a valid user ID, username, and owner ID.");
  }
  if (!["admin", "field-agent"].includes(accessRole)) {
    throw new Error("Sharing a project requires a valid account role.");
  }
  await query(
    `INSERT INTO folder_members (folder_id, user_id, username, access_role, added_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (folder_id, user_id) DO UPDATE SET username = EXCLUDED.username, access_role = EXCLUDED.access_role`,
    [folderId, userId, username, accessRole, addedBy]
  );
  if (accessRole === "field-agent") {
    await query(
      `DELETE FROM field_agent_form_revocations r USING forms f
        WHERE r.workspace_id = f.workspace_id AND f.folder_id = $1 AND r.user_id = $2`,
      [folderId, userId]
    );
  }
}

export async function updateFolderMemberRole(folderId, userId, accessRole) {
  await query("UPDATE folder_members SET access_role = $3 WHERE folder_id = $1 AND user_id = $2", [folderId, userId, accessRole]);
}

export async function updateFolderMemberRolesForUser(userId, accessRole) {
  await query("UPDATE folder_members SET access_role = $2 WHERE user_id = $1 AND access_role <> $2", [userId, accessRole]);
}

export async function removeFolderMember(folderId, username) {
  await query("DELETE FROM folder_members WHERE folder_id = $1 AND lower(username) = lower($2)", [folderId, username]);
}

export async function revokeFolderFieldAgentAccess(folderId, userId, username, revokedBy) {
  return withTransaction(async () => {
    const forms = (await query(
      `SELECT f.workspace_id AS "workspaceId", f.respondent_access_code AS "accessCode",
              coalesce(f.draft->>'title', f.workspace_id) AS "formTitle"
         FROM forms f
        WHERE f.folder_id = $1 AND f.xml IS NOT NULL AND f.respondent_access_code IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM form_field_agents a WHERE a.workspace_id = f.workspace_id AND a.user_id = $2)`,
      [folderId, userId]
    )).rows;
    await query("DELETE FROM folder_members WHERE folder_id = $1 AND lower(username) = lower($2)", [folderId, username]);
    const revoked = [];
    for (const form of forms) {
      const stillHasFolderAccess = (await query(
        `SELECT 1 FROM forms f JOIN folder_members m ON m.folder_id = f.folder_id
          WHERE f.workspace_id = $1 AND m.user_id = $2 AND m.access_role = 'field-agent' LIMIT 1`,
        [form.workspaceId, userId]
      )).rowCount > 0;
      if (stillHasFolderAccess) continue;
      await query(
        `INSERT INTO field_agent_form_revocations (workspace_id, user_id, access_code, form_title, revoked_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET access_code = EXCLUDED.access_code,
           form_title = EXCLUDED.form_title, revoked_by = EXCLUDED.revoked_by,
           revoked_at = now(), sync_completed_at = NULL`,
        [form.workspaceId, userId, form.accessCode, form.formTitle, revokedBy]
      );
      revoked.push(form);
    }
    return revoked;
  });
}

export async function revokeFormFieldAgentAccess(workspaceId, userId, username, revokedBy) {
  return withTransaction(async () => {
    const row = (await query(
      `SELECT f.workspace_id AS "workspaceId", f.respondent_access_code AS "accessCode",
              coalesce(f.draft->>'title', f.workspace_id) AS "formTitle",
              EXISTS (SELECT 1 FROM folders d JOIN folder_members m ON m.folder_id = d.id
                       WHERE d.id = f.folder_id AND m.user_id = $2 AND m.access_role = 'field-agent') AS "hasFolderAccess"
         FROM forms f WHERE f.workspace_id = $1 AND f.xml IS NOT NULL AND f.respondent_access_code IS NOT NULL`,
      [workspaceId, userId]
    )).rows[0];
    await query("DELETE FROM form_field_agents WHERE workspace_id = $1 AND lower(username) = lower($2)", [workspaceId, username]);
    if (row && !row.hasFolderAccess) {
      await query(
        `INSERT INTO field_agent_form_revocations (workspace_id, user_id, access_code, form_title, revoked_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET access_code = EXCLUDED.access_code,
           form_title = EXCLUDED.form_title, revoked_by = EXCLUDED.revoked_by,
           revoked_at = now(), sync_completed_at = NULL`,
        [workspaceId, userId, row.accessCode, row.formTitle, revokedBy]
      );
      return [row];
    }
    return [];
  });
}

export async function pendingFormAccessRevocations(userId) {
  return (await query(
    `SELECT workspace_id AS "workspaceId", access_code AS "accessCode", form_title AS "formTitle",
            revoked_at AS "revokedAt", sync_completed_at AS "syncCompletedAt"
       FROM field_agent_form_revocations WHERE user_id = $1 ORDER BY revoked_at`,
    [userId]
  )).rows.map((row) => ({ ...row, revokedAt: iso(row.revokedAt), syncCompletedAt: iso(row.syncCompletedAt) }));
}

export async function hasPendingFormAccessRevocation(workspaceId, userId) {
  return (await query(
    `SELECT 1 FROM field_agent_form_revocations
      WHERE workspace_id = $1 AND user_id = $2 AND sync_completed_at IS NULL`,
    [workspaceId, userId]
  )).rowCount > 0;
}

export async function completeFormAccessRevocation(workspaceId, userId) {
  await query(
    `UPDATE field_agent_form_revocations SET sync_completed_at = now()
      WHERE workspace_id = $1 AND user_id = $2 AND sync_completed_at IS NULL`,
    [workspaceId, userId]
  );
}

export async function workspaceAccess(workspaceId, userId) {
  return (await query(
    `SELECT 1 FROM forms f
      WHERE f.workspace_id = $1 AND (
        (f.folder_id IS NULL AND f.owner_user_id = $2) OR
        (f.folder_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM folders d WHERE d.id = f.folder_id AND (
              d.owner_user_id = $2 OR EXISTS (
              SELECT 1 FROM folder_members m WHERE m.folder_id = d.id AND m.user_id = $2 AND m.access_role = 'admin'
            )
          )
        ))
      )`,
    [workspaceId, userId]
  )).rowCount > 0;
}

export async function fieldAgentWorkspaceAccess(workspaceId, userId) {
  return (await query(
    `SELECT 1 FROM forms f
      WHERE f.workspace_id = $1
        AND f.xml IS NOT NULL
        AND f.respondent_access_code IS NOT NULL
        AND coalesce((f.draft->>'collectionLocked')::boolean, false) = false
        AND (
          EXISTS (SELECT 1 FROM form_field_agents a WHERE a.workspace_id = f.workspace_id AND a.user_id = $2)
          OR EXISTS (
            SELECT 1 FROM folders d JOIN folder_members m ON m.folder_id = d.id
             WHERE d.id = f.folder_id AND m.user_id = $2 AND m.access_role = 'field-agent'
          )
        )`,
    [workspaceId, userId]
  )).rowCount > 0;
}

export async function folderFieldAgentAccess(workspaceId, userId) {
  return (await query(
    `SELECT 1 FROM forms f JOIN folder_members m ON m.folder_id = f.folder_id
      WHERE f.workspace_id = $1 AND m.user_id = $2 AND m.access_role = 'field-agent'`,
    [workspaceId, userId]
  )).rowCount > 0;
}

export async function listFormFieldAgents(workspaceId) {
  return (await query(
    `SELECT user_id AS "userId", username,
            CASE WHEN bool_or(access_type = 'folder') THEN 'folder' ELSE 'form' END AS "accessType",
            min(added_at) AS "addedAt"
       FROM (
         SELECT a.user_id, a.username, 'form'::text AS access_type, a.added_at
           FROM form_field_agents a WHERE a.workspace_id = $1
         UNION ALL
         SELECT m.user_id, m.username, 'folder'::text AS access_type, m.added_at
           FROM forms f JOIN folder_members m ON m.folder_id = f.folder_id
          WHERE f.workspace_id = $1 AND m.access_role = 'field-agent'
       ) grants
      GROUP BY user_id, username ORDER BY lower(username)`,
    [workspaceId]
  )).rows.map((row) => ({ ...row, addedAt: iso(row.addedAt) }));
}

export async function addFormFieldAgent(workspaceId, { userId, username, addedBy }) {
  if (!userId || !username || !addedBy) throw new Error("Sharing a form requires a valid field agent and owner.");
  await query(
    `INSERT INTO form_field_agents (workspace_id, user_id, username, added_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET username = EXCLUDED.username`,
    [workspaceId, userId, username, addedBy]
  );
  await query("DELETE FROM field_agent_form_revocations WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
}

export async function removeFormFieldAgent(workspaceId, username) {
  await query("DELETE FROM form_field_agents WHERE workspace_id = $1 AND lower(username) = lower($2)", [workspaceId, username]);
}

export async function workspaceAdminIds(workspaceId) {
  return (await query(
    `SELECT DISTINCT user_id FROM (
       SELECT owner_user_id AS user_id FROM forms WHERE workspace_id = $1
       UNION ALL
       SELECT m.user_id FROM forms f JOIN folder_members m ON m.folder_id = f.folder_id
        WHERE f.workspace_id = $1 AND m.access_role = 'admin'
     ) admins WHERE user_id IS NOT NULL`,
    [workspaceId]
  )).rows.map((row) => row.user_id);
}

export async function folderAdminIds(folderId) {
  return (await query(
    `SELECT user_id FROM (
       SELECT owner_user_id AS user_id FROM folders WHERE id = $1
       UNION
       SELECT user_id FROM folder_members WHERE folder_id = $1 AND access_role = 'admin'
     ) admins WHERE user_id IS NOT NULL`,
    [folderId]
  )).rows.map((row) => row.user_id);
}

export async function workspaceFieldAgentIds(workspaceId) {
  return (await query(
    `SELECT DISTINCT user_id FROM (
       SELECT user_id FROM form_field_agents WHERE workspace_id = $1
       UNION ALL
       SELECT m.user_id FROM forms f JOIN folder_members m ON m.folder_id = f.folder_id
        WHERE f.workspace_id = $1 AND m.access_role = 'field-agent'
     ) agents`,
    [workspaceId]
  )).rows.map((row) => row.user_id);
}

export async function addNotification({
  id, userId, eventType, title, message, details = {}, subjectId = '', batchId = '', dedupeKey = ''
}) {
  if (!userId) return null;
  return withTransaction(async () => {
    if (dedupeKey) {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${userId}:${dedupeKey}`]);
      const existing = (await query(
        `SELECT n.id, n.item_count AS "itemCount"
           FROM notification_dedupe_keys d JOIN user_notifications n ON n.id = d.notification_id
          WHERE d.user_id = $1 AND d.dedupe_key = $2`,
        [userId, dedupeKey]
      )).rows[0];
      if (existing) return existing;
    }
    const result = batchId
      ? await query(
        `INSERT INTO user_notifications (id, user_id, event_type, title, message, details, subject_id, batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, event_type, subject_id, batch_id) WHERE batch_id <> ''
         DO UPDATE SET item_count = user_notifications.item_count + 1,
           message = EXCLUDED.message, details = EXCLUDED.details, created_at = now(), read_at = NULL
         RETURNING id, item_count AS "itemCount"`,
        [id, userId, eventType, title, message, json(details), subjectId, batchId]
      )
      : await query(
        `INSERT INTO user_notifications (id, user_id, event_type, title, message, details, subject_id, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) RETURNING id, item_count AS "itemCount"`,
        [id, userId, eventType, title, message, json(details), subjectId]
      );
    const notification = result.rows[0];
    if (dedupeKey) await query(
      `INSERT INTO notification_dedupe_keys (user_id, dedupe_key, notification_id)
       VALUES ($1, $2, $3) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [userId, dedupeKey, notification.id]
    );
    return notification;
  });
}

export async function listNotifications(userId, limit = 100) {
  return (await query(
    `SELECT id, event_type AS "eventType", title, message, details,
            subject_id AS "subjectId", item_count AS "itemCount",
            created_at AS "createdAt", read_at AS "readAt"
       FROM user_notifications WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(Number(limit) || 100, 200))]
  )).rows;
}

export async function unreadNotificationCount(userId) {
  return Number((await query(
    "SELECT count(*)::int AS count FROM user_notifications WHERE user_id = $1 AND read_at IS NULL",
    [userId]
  )).rows[0]?.count || 0);
}

export async function markNotificationsRead(userId, ids = null) {
  if (Array.isArray(ids) && ids.length) {
    await query(
      "UPDATE user_notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::text[]) AND read_at IS NULL",
      [userId, ids]
    );
  } else {
    await query("UPDATE user_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [userId]);
  }
}

export async function claimLegacyOwnership(userId) {
  await query("UPDATE folders SET owner_user_id = $1 WHERE owner_user_id IS NULL", [userId]);
  await query("UPDATE forms SET owner_user_id = $1 WHERE owner_user_id IS NULL AND folder_id IS NULL", [userId]);
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
  f.workspace_id, f.folder_id, f.owner_user_id, f.draft, f.updated_at,
  f.deleted_at, f.deleted_by_user_id, f.deleted_by_username,
  f.xml IS NOT NULL AS has_xml,
  f.xlsx IS NOT NULL AS has_xlsx,
  f.terminology IS NOT NULL AS has_terminology,
  f.terminology->>'status' AS terminology_status,
  f.terminology->>'entityCount' AS terminology_entity_count,
  (SELECT count(*)::int FROM entries e WHERE e.workspace_id = f.workspace_id AND e.data->>'submissionStatus' IS DISTINCT FROM 'incomplete') AS entry_count,
  (SELECT count(*)::int FROM respondent_checkpoints c WHERE c.workspace_id = f.workspace_id) AS checkpoint_count,
  (SELECT count(*)::int FROM fhir_bundles b WHERE b.workspace_id = f.workspace_id) AS fhir_bundle_count,
  (SELECT count(*)::int FROM form_field_agents a WHERE a.workspace_id = f.workspace_id) AS field_agent_count,
  ARRAY(SELECT a.file_name FROM form_attachments a WHERE a.workspace_id = f.workspace_id) AS attachment_names,
  (SELECT max(a.updated_at) FROM form_attachments a WHERE a.workspace_id = f.workspace_id) AS attachments_updated_at`;

export async function formSummary(workspaceId) {
  return (await query(`SELECT ${formSummaryColumns} FROM forms f WHERE f.workspace_id = $1`, [workspaceId])).rows[0] || null;
}

export async function formSummaries() {
  return (await query(`SELECT ${formSummaryColumns} FROM forms f WHERE f.deleted_at IS NULL`)).rows;
}

export async function deletedFormSummaries(userId) {
  return (await query(
    `SELECT ${formSummaryColumns} FROM forms f
      WHERE f.deleted_at IS NOT NULL AND f.deleted_by_user_id = $1
      ORDER BY f.deleted_at DESC`,
    [userId]
  )).rows;
}

export async function findFormByRespondentCode(code, { includeDeleted = false } = {}) {
  const result = await query(
    `SELECT workspace_id, draft, deleted_at FROM forms
      WHERE respondent_access_code = $1 AND coalesce((draft->>'collectionLocked')::boolean, false) = false
        AND ($2::boolean OR deleted_at IS NULL)`,
    [code, includeDeleted]
  );
  return result.rows[0] || null;
}

export async function setFormDeleted(workspaceId, user) {
  return (await query(
    `UPDATE forms SET deleted_at = now(), deleted_by_user_id = $2,
       deleted_by_username = $3, updated_at = now()
      WHERE workspace_id = $1 AND deleted_at IS NULL
      RETURNING workspace_id`,
    [workspaceId, user.id, user.username]
  )).rowCount;
}

export async function restoreDeletedForm(workspaceId, userId) {
  return (await query(
    `UPDATE forms SET deleted_at = NULL, deleted_by_user_id = NULL,
       deleted_by_username = NULL,
       folder_id = CASE WHEN EXISTS (SELECT 1 FROM folders d WHERE d.id = forms.folder_id) THEN forms.folder_id ELSE NULL END,
       draft = CASE WHEN EXISTS (SELECT 1 FROM folders d WHERE d.id = forms.folder_id) THEN forms.draft ELSE (forms.draft::jsonb - 'folderId')::json END,
       updated_at = now()
      WHERE workspace_id = $1 AND deleted_at IS NOT NULL AND deleted_by_user_id = $2
      RETURNING workspace_id`,
    [workspaceId, userId]
  )).rowCount;
}

export async function permanentlyDeleteArchivedForm(workspaceId, userId) {
  return withTransaction(async () => {
    const deleted = (await query(
      `DELETE FROM forms WHERE workspace_id = $1 AND deleted_at IS NOT NULL AND deleted_by_user_id = $2
       RETURNING workspace_id, respondent_access_code, draft`,
      [workspaceId, userId]
    )).rows[0];
    if (!deleted) return 0;
    const accessCode = String(deleted.respondent_access_code || deleted.draft?.respondentAccessCode || deleted.draft?.publicAccessCode || "").trim().toUpperCase();
    if (accessCode) {
      await query(
        `INSERT INTO permanently_deleted_forms (respondent_access_code, workspace_id, form_title, deleted_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id) DO UPDATE SET respondent_access_code = EXCLUDED.respondent_access_code,
           form_title = EXCLUDED.form_title, deleted_by_user_id = EXCLUDED.deleted_by_user_id, deleted_at = now()`,
        [accessCode, deleted.workspace_id, deleted.draft?.title || deleted.workspace_id, userId]
      );
    }
    return 1;
  });
}

export async function findPermanentlyDeletedFormByAccessCode(accessCode) {
  return (await query(
    `SELECT respondent_access_code AS "respondentAccessCode", workspace_id AS "workspaceId",
            form_title AS "formTitle", deleted_at AS "deletedAt"
       FROM permanently_deleted_forms WHERE respondent_access_code = $1 ORDER BY deleted_at DESC LIMIT 1`,
    [String(accessCode || "").trim().toUpperCase()]
  )).rows[0] || null;
}

export async function findPermanentlyDeletedFormGeneration(accessCode, workspaceId) {
  return (await query(
    `SELECT respondent_access_code AS "respondentAccessCode", workspace_id AS "workspaceId",
            form_title AS "formTitle", deleted_at AS "deletedAt"
       FROM permanently_deleted_forms WHERE respondent_access_code = $1 AND workspace_id = $2`,
    [String(accessCode || "").trim().toUpperCase(), String(workspaceId || "")]
  )).rows[0] || null;
}

export async function getUserProfile(userId) {
  return (await query("SELECT username, display_name AS \"displayName\" FROM user_profiles WHERE user_id = $1", [userId])).rows[0] || null;
}

export async function saveUserProfile(userId, username, displayName) {
  return (await query(
    `INSERT INTO user_profiles (user_id, username, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username,
       display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING username, display_name AS \"displayName\"`,
    [userId, username, displayName]
  )).rows[0];
}

export async function formExists(workspaceId) {
  return (await query("SELECT 1 FROM forms WHERE workspace_id = $1", [workspaceId])).rowCount > 0;
}

export async function formDeleted(workspaceId) {
  return Boolean((await query("SELECT deleted_at FROM forms WHERE workspace_id = $1", [workspaceId])).rows[0]?.deleted_at);
}

export async function formHasXml(workspaceId) {
  return (await query("SELECT 1 FROM forms WHERE workspace_id = $1 AND xml IS NOT NULL", [workspaceId])).rowCount > 0;
}

// Holds the form for the rest of the transaction so writers to it run one at a time.
export async function lockForm(workspaceId) {
  await query("SELECT 1 FROM forms WHERE workspace_id = $1 FOR NO KEY UPDATE", [workspaceId]);
}

export async function insertForm({ workspaceId, versionBaseId, versionNumber, folderId, ownerUserId = null, draft, xlsxName = null, xlsx = null }) {
  await query(
    `INSERT INTO forms (workspace_id, version_base_id, version_number, folder_id, owner_user_id, draft, xlsx_name, xlsx)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [workspaceId, versionBaseId, versionNumber, folderId, ownerUserId, json(draft), xlsxName, xlsx]
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
  return findFormByRespondentCode(code);
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

export async function listEntries(workspaceId, userId = null) {
  const result = userId
    ? await query(`SELECT e.data, e.user_id, e.review_requested_at, e.review_requested_by,
                          p.username AS submitted_by_username, p.display_name AS submitted_by_name
                     FROM entries e LEFT JOIN user_profiles p ON p.user_id = e.user_id
                    WHERE e.workspace_id = $1 AND e.user_id = $2 AND e.data->>'submissionStatus' IS DISTINCT FROM 'incomplete' ORDER BY e.seq`, [workspaceId, userId])
    : await query(`SELECT e.data, e.user_id, e.review_requested_at, e.review_requested_by,
                          p.username AS submitted_by_username, p.display_name AS submitted_by_name
                     FROM entries e LEFT JOIN user_profiles p ON p.user_id = e.user_id
                    WHERE e.workspace_id = $1 AND e.data->>'submissionStatus' IS DISTINCT FROM 'incomplete' ORDER BY e.seq`, [workspaceId]);
  return result.rows.map((row) => ({
    ...row.data,
    userId: row.data.userId || row.user_id || "",
    submittedByUserId: row.data.submittedByUserId || row.user_id || row.data.userId || "",
    submittedByUsername: row.data.submittedByUsername || row.submitted_by_username || "",
    submittedByName: row.data.submittedByName || row.submitted_by_name || row.submitted_by_username || "",
    reviewRequestedAt: iso(row.review_requested_at),
    reviewRequestedBy: row.review_requested_by || ""
  }));
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

export async function getEntryIncludingIncomplete(workspaceId, entryId) {
  const row = (await query(
    `SELECT e.data, e.user_id, e.review_requested_at, e.review_requested_by,
            p.username AS submitted_by_username, p.display_name AS submitted_by_name
       FROM entries e LEFT JOIN user_profiles p ON p.user_id = e.user_id
      WHERE e.workspace_id = $1 AND e.id = $2`,
    [workspaceId, entryId]
  )).rows[0];
  if (!row) return null;
  return {
    ...row.data,
    userId: row.data.userId || row.user_id || "",
    submittedByUserId: row.data.submittedByUserId || row.user_id || row.data.userId || "",
    submittedByUsername: row.data.submittedByUsername || row.submitted_by_username || "",
    submittedByName: row.data.submittedByName || row.submitted_by_name || row.submitted_by_username || "",
    reviewRequestedAt: iso(row.review_requested_at),
    reviewRequestedBy: row.review_requested_by || ""
  };
}

export async function markEntrySubmitted(workspaceId, entry) {
  await query(
    "UPDATE entries SET client_submission_id = $3, user_id = $4, data = $5, submitted_at = $6 WHERE workspace_id = $1 AND id = $2",
    [workspaceId, entry.id, entry.clientSubmissionId || null, entry.userId || "", json(entry), entry.submittedAt]
  );
}

export async function deleteEntries(workspaceId, ids) {
  await query("DELETE FROM entries WHERE workspace_id = $1 AND id = ANY($2::text[])", [workspaceId, ids]);
}

export async function markEntriesForReview(workspaceId, ids, username, userId = null) {
  const result = await query(
    `UPDATE entries SET review_requested_at = now(), review_requested_by = $3
      WHERE workspace_id = $1 AND id = ANY($2::text[]) AND ($4::text IS NULL OR user_id = $4)`,
    [workspaceId, ids, username, userId]
  );
  return result.rowCount;
}

export async function clearEntryReview(workspaceId, entryId) {
  const result = await query(
    "UPDATE entries SET review_requested_at = NULL, review_requested_by = NULL WHERE workspace_id = $1 AND id = $2",
    [workspaceId, entryId]
  );
  return result.rowCount;
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

export async function listRespondentCheckpoints(workspaceId, userId = null) {
  const result = userId
    ? await query(`SELECT c.data, c.user_id, c.review_requested_at, c.review_requested_by,
        COALESCE(p.display_name, p.username, '') AS saved_by
      FROM respondent_checkpoints c LEFT JOIN user_profiles p ON p.user_id = c.user_id
      WHERE c.workspace_id = $1 AND c.user_id = $2 ORDER BY c.saved_at`, [workspaceId, userId])
    : await query(`SELECT c.data, c.user_id, c.review_requested_at, c.review_requested_by,
        COALESCE(p.display_name, p.username, '') AS saved_by
      FROM respondent_checkpoints c LEFT JOIN user_profiles p ON p.user_id = c.user_id
      WHERE c.workspace_id = $1 ORDER BY c.saved_at`, [workspaceId]);
  return result.rows.map((row) => ({
    ...row.data,
    userId: row.user_id,
    savedBy: row.saved_by,
    reviewRequestedAt: iso(row.review_requested_at),
    reviewRequestedBy: row.review_requested_by || ''
  }));
}

export async function getRespondentCheckpoint(workspaceId, identifierKey, userId = '') {
  return (await query(
    "SELECT data, review_requested_at, review_requested_by FROM respondent_checkpoints WHERE workspace_id = $1 AND identifier_key = $2 AND user_id = $3",
    [workspaceId, identifierKey, userId]
  )).rows[0]?.data || null;
}

export async function putRespondentCheckpoint(workspaceId, identifierKey, checkpoint) {
  await query(
    `INSERT INTO respondent_checkpoints (workspace_id, identifier_key, user_id, data, saved_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, identifier_key, user_id) DO UPDATE SET data = EXCLUDED.data, saved_at = EXCLUDED.saved_at`,
    [workspaceId, identifierKey, checkpoint.userId || '', json(checkpoint), checkpoint.savedAt]
  );
}

export async function deleteRespondentCheckpoint(workspaceId, identifierKey, userId = null) {
  if (userId === null) {
    await query("DELETE FROM respondent_checkpoints WHERE workspace_id = $1 AND identifier_key = $2", [workspaceId, identifierKey]);
    return;
  }
  await query("DELETE FROM respondent_checkpoints WHERE workspace_id = $1 AND identifier_key = $2 AND user_id = $3", [workspaceId, identifierKey, userId]);
}

export async function markRespondentCheckpointForReview(workspaceId, identifierKey, userId, username) {
  return (await query(
    `UPDATE respondent_checkpoints SET review_requested_at = now(), review_requested_by = $4
      WHERE workspace_id = $1 AND identifier_key = $2 AND user_id = $3`,
    [workspaceId, identifierKey, userId, username]
  )).rowCount;
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
