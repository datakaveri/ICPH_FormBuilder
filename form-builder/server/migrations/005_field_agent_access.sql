-- Folder members keep their Keycloak role: admins share the whole folder,
-- while field agents may collect from the folder's published forms only.
ALTER TABLE folder_members
  ADD COLUMN IF NOT EXISTS access_role text NOT NULL DEFAULT 'admin';

ALTER TABLE folder_members
  ADD CONSTRAINT folder_members_access_role_check
  CHECK (access_role IN ('admin', 'field-agent'));

-- Additional form-level grants let an admin expose one published form without
-- sharing every published form in its folder.
CREATE TABLE IF NOT EXISTS form_field_agents (
  workspace_id text NOT NULL REFERENCES forms (workspace_id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  username     text NOT NULL,
  added_by     text NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS form_field_agents_user_idx
  ON form_field_agents (user_id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS form_field_agents_username_key
  ON form_field_agents (workspace_id, lower(username));
