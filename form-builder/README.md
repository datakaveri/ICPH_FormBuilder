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

## Run

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/form-builder
npm install
npm run dev
```

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

The compose setup persists generated forms and submissions to `output/forms/`
on the host.

## Current Flow

The app opens on a home dashboard. It shows every form workspace under
`ICPH/output/forms`, including the current pipeline stage:

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

The fill-form tab writes local entries back into the same workspace:

```text
data/entries.jsonl
data/<form-id>_entries.csv
```

## Workspace Contract

Clicking `Create New Form` creates a dedicated folder under:

```text
/Users/NIKITA/Desktop/IISc_CDPG/ICPH/output/forms/
```

Each form workspace contains:

```text
drafts/form.json
drafts/checkpoints/<timestamp>.json
xlsform/<form-id>.xlsx
xml/<form-id>.xml
data/
fhir_bundles/
logs/
```

The `data/` and `fhir_bundles/` folders are placeholders for the next pipeline stages:

1. local form visualization/data entry
2. collected CSV export
3. agentic entity mapper FHIR generation

## Test Exporter Directly

The app uses the existing ODK Python environment:

```text
/Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK/.venv-xlsform
```

The server writes XLSX with:

```text
scripts/export_xlsform.py
```

Then converts XLSX to XML with:

```text
ICPH/ODK/.venv-xlsform/bin/xls2xform
```
