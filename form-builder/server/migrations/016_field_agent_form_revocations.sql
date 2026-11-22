CREATE TABLE IF NOT EXISTS field_agent_form_revocations (
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  access_code text NOT NULL,
  form_title text NOT NULL DEFAULT '',
  revoked_by text NOT NULL DEFAULT '',
  revoked_at timestamptz NOT NULL DEFAULT now(),
  sync_completed_at timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS field_agent_form_revocations_user_pending_idx
  ON field_agent_form_revocations (user_id, revoked_at)
  WHERE sync_completed_at IS NULL;
