CREATE TABLE permanently_deleted_forms (
  respondent_access_code text NOT NULL,
  workspace_id           text PRIMARY KEY,
  form_title             text NOT NULL,
  deleted_by_user_id     text NOT NULL,
  deleted_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX permanently_deleted_forms_code_idx
  ON permanently_deleted_forms (respondent_access_code, deleted_at DESC);
