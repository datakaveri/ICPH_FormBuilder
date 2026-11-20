ALTER TABLE forms
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_user_id text,
  ADD COLUMN deleted_by_username text;

CREATE INDEX forms_deleted_by_user_idx
  ON forms (deleted_by_user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE user_profiles (
  user_id      text PRIMARY KEY,
  username     text NOT NULL,
  display_name text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
