CREATE TABLE user_notifications (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  event_type  text NOT NULL,
  title       text NOT NULL,
  message     text NOT NULL,
  details     json NOT NULL DEFAULT '{}',
  subject_id  text NOT NULL DEFAULT '',
  batch_id    text NOT NULL DEFAULT '',
  dedupe_key  text UNIQUE,
  item_count  integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);

CREATE INDEX user_notifications_unread_idx
  ON user_notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX user_notifications_history_idx
  ON user_notifications (user_id, created_at DESC);
CREATE UNIQUE INDEX user_notifications_batch_key
  ON user_notifications (user_id, event_type, subject_id, batch_id)
  WHERE batch_id <> '';

CREATE TABLE notification_dedupe_keys (
  user_id         text NOT NULL,
  dedupe_key      text NOT NULL,
  notification_id text NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, dedupe_key)
);
