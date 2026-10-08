-- ICPH Form Builder schema.
--
-- Documents the app reads and writes whole (drafts, entries, terminology, FHIR
-- bundles) are stored as json rather than jsonb so key order survives a round
-- trip: XLSForm column order and FHIR bundle layout depend on it. The columns
-- beside them are the fields the server filters and enforces on.

CREATE TABLE folders (
  id                              text PRIMARY KEY,
  name                            text NOT NULL,
  primary_identifier_variable     text NOT NULL DEFAULT '',
  participant_identifier_mode     text NOT NULL DEFAULT '',
  participant_identifier_variable text NOT NULL DEFAULT '',
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX folders_name_key ON folders (lower(name));

CREATE TABLE forms (
  workspace_id           text PRIMARY KEY,
  version_base_id        text NOT NULL,
  version_number         integer NOT NULL DEFAULT 1,
  -- folder_id and respondent_access_code mirror the draft on every save.
  folder_id              text,
  respondent_access_code text,
  draft                  json NOT NULL,
  xlsx_name              text,
  xlsx                   bytea,
  xml_name               text,
  xml                    text,
  terminology            json,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX forms_respondent_access_code_key ON forms (respondent_access_code) WHERE respondent_access_code IS NOT NULL;
CREATE INDEX forms_folder_id_idx ON forms (folder_id);
CREATE INDEX forms_version_base_id_idx ON forms (version_base_id);

-- Draft snapshots taken on each Build save.
CREATE TABLE form_checkpoints (
  id           bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES forms (workspace_id) ON DELETE CASCADE,
  draft        json NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_checkpoints_workspace_idx ON form_checkpoints (workspace_id, id);

-- Form media and CSV lists uploaded by the form author.
CREATE TABLE form_attachments (
  workspace_id text NOT NULL REFERENCES forms (workspace_id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  data         bytea NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, file_name)
);

CREATE TABLE entries (
  workspace_id         text NOT NULL REFERENCES forms (workspace_id) ON DELETE CASCADE,
  id                   text NOT NULL,
  seq                  bigserial NOT NULL,
  client_submission_id text,
  data                 json NOT NULL,
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX entries_workspace_seq_idx ON entries (workspace_id, seq);
-- A retried submission from a device must not create a second entry.
CREATE UNIQUE INDEX entries_client_submission_key ON entries (workspace_id, client_submission_id) WHERE client_submission_id IS NOT NULL;

-- Files uploaded with a submission (photos, audio, signatures).
CREATE TABLE entry_attachments (
  workspace_id text NOT NULL,
  entry_id     text NOT NULL,
  file_name    text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  data         bytea NOT NULL,
  PRIMARY KEY (workspace_id, entry_id, file_name),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES entries (workspace_id, id) ON DELETE CASCADE
);

-- Partly filled responses a respondent can resume, one per identifier value.
CREATE TABLE respondent_checkpoints (
  workspace_id   text NOT NULL REFERENCES forms (workspace_id) ON DELETE CASCADE,
  identifier_key text NOT NULL,
  data           json NOT NULL,
  saved_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, identifier_key)
);

-- Barcodes assigned to demographic participants.
CREATE TABLE participant_registry (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES forms (workspace_id) ON DELETE CASCADE,
  barcode      text NOT NULL,
  data         json NOT NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX participant_registry_barcode_key ON participant_registry (lower(barcode));
CREATE INDEX participant_registry_workspace_idx ON participant_registry (workspace_id);

-- The primary identifier shared by every form linked to a MetaForm document.
CREATE TABLE meta_form_primaries (
  file_name text PRIMARY KEY,
  variable  text NOT NULL
);

CREATE TABLE fhir_bundles (
  workspace_id text NOT NULL REFERENCES forms (workspace_id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  bundle       json NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, file_name)
);
