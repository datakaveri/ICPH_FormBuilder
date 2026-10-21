-- Uploaded MetaForm documents and what the preprocessor extracted from them.
-- markdown and chunks stay null until the document has been processed.
CREATE TABLE meta_forms (
  file_name      text PRIMARY KEY,
  docx           bytea NOT NULL,
  sha256         text NOT NULL,
  markdown       text,
  chunks         json,
  form_count     integer NOT NULL DEFAULT 0,
  variable_count integer NOT NULL DEFAULT 0,
  chunk_count    integer NOT NULL DEFAULT 0,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz
);

-- One-time startup jobs that have finished, such as importing the MetaForms
-- that used to be stored as files.
CREATE TABLE completed_tasks (
  name         text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now()
);
