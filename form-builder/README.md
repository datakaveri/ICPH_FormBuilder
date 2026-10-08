# ICPH Form Builder

Local React UI for creating XLSForm-compatible ICPH forms.

This is intentionally not a fork of ODK Build. It borrows the useful interaction pattern:

- question palette
- draggable survey list
- right-side property editor
- options editor
- validation panel
- preview panel

The source of truth is a small JSON form model that exports to XLSForm sheets:

- `survey`
- `choices`
- `settings`

## Run For Local Development

From the repository root:

```bash
cd form-builder
npm install
npm run dev
```

For local development without Docker, also create the Python environments
documented in the root `README.md`; XLSForm conversion, terminology extraction,
and FHIR handoff depend on them.

Open:

```text
http://localhost:5173
```

The React app calls the local API server at:

```text
http://localhost:8787
```

## Run With Docker

From the repository root:

```bash
docker compose up --build
```

Open:

```text
http://localhost:5173
```

The Docker image builds the frontend first and then serves the built app on
port `5173`. The compose setup stores forms and submissions in its `postgres`
service.

## Current Flow

The app opens on a home dashboard. It shows every form workspace, including the
current pipeline stage:

- `Building`: draft exists, XML has not been generated yet
- `Publishing`: XLSForm/XML exist and the form can be filled locally
- `Data collection`: one or more local entries have been submitted

From the dashboard you can:

- open a form workspace and continue editing
- create a new form
- import an existing XLSForm `.xlsx`
- open a published form in a new fill-form tab

Inside the builder you can:

- add and reorder questions
- edit question properties
- save a checkpoint
- export XLSForm `.xlsx` and XForm `.xml`

The fill-form tab stores each submission as a row in the `entries` table for
the same workspace.

## Workspace Contract

Clicking `Create New Form` creates a row in the `forms` table. A workspace is
that row plus the rows that reference it:

| Data | Table |
|---|---|
| Draft, generated XLSForm and XForm XML, terminology review | `forms` |
| Draft snapshot per save | `form_checkpoints` |
| Form media and CSV lists | `form_attachments` |
| Submissions | `entries` |
| Files uploaded with a submission | `entry_attachments` |
| Partly filled responses | `respondent_checkpoints` |
| FHIR bundles | `fhir_bundles` |

Folders, barcode assignments and MetaForm primary identifiers are in `folders`,
`participant_registry` and `meta_form_primaries`. The schema is in
`server/migrations/`; the server applies new migration files on start. Set
`DATABASE_URL` to point the API at a database.

## Test Exporter Directly

The app uses the ODK Python environment created by Docker or local setup:

```text
../ODK/.venv-xlsform
```

The server writes XLSX with:

```text
scripts/export_xlsform.py
```

## LLM-Assisted Terminology

LLM-assisted extraction is temporarily down. The toggle is disabled, and
terminology extraction continues to use the deterministic workflow.

Then converts XLSX to XML with:

```text
../ODK/.venv-xlsform/bin/xls2xform
```
