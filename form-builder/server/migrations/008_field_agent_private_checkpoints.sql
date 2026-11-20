-- A shared published form may have separate partial responses for each field agent.
-- Empty user_id keeps existing, unattributed checkpoints visible to admins only.
ALTER TABLE respondent_checkpoints
  ADD COLUMN user_id text;

UPDATE respondent_checkpoints SET user_id = '' WHERE user_id IS NULL;

ALTER TABLE respondent_checkpoints
  ALTER COLUMN user_id SET DEFAULT '',
  ALTER COLUMN user_id SET NOT NULL,
  DROP CONSTRAINT respondent_checkpoints_pkey,
  ADD PRIMARY KEY (workspace_id, identifier_key, user_id),
  ADD COLUMN review_requested_at timestamptz,
  ADD COLUMN review_requested_by text;

CREATE INDEX respondent_checkpoints_user_idx
  ON respondent_checkpoints (user_id, workspace_id);
