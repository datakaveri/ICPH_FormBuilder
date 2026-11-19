-- A folder is a collaborative workspace. Unfiled forms remain private to the
-- account that created them.
ALTER TABLE folders ADD COLUMN IF NOT EXISTS project_code text;
UPDATE folders SET project_code = id WHERE project_code IS NULL OR btrim(project_code) = '';
ALTER TABLE folders ALTER COLUMN project_code SET NOT NULL;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS owner_user_id text;
ALTER TABLE forms ADD COLUMN IF NOT EXISTS owner_user_id text;

DROP INDEX IF EXISTS folders_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS folders_owner_name_key
  ON folders (owner_user_id, lower(name));

CREATE TABLE IF NOT EXISTS folder_members (
  folder_id text NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  username text NOT NULL,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, user_id)
);
CREATE INDEX IF NOT EXISTS folder_members_user_idx ON folder_members (user_id, folder_id);
CREATE UNIQUE INDEX IF NOT EXISTS folder_members_username_key ON folder_members (folder_id, lower(username));
