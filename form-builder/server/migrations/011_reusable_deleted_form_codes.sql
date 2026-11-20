ALTER TABLE permanently_deleted_forms DROP CONSTRAINT permanently_deleted_forms_pkey;
ALTER TABLE permanently_deleted_forms ADD PRIMARY KEY (workspace_id);
CREATE INDEX IF NOT EXISTS permanently_deleted_forms_code_idx
  ON permanently_deleted_forms (respondent_access_code, deleted_at DESC);
