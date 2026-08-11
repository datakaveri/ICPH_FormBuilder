# ICPH Form Builder And Mapper Workspace

This workspace has one user-facing web app and one lean mapper backend:

- `form-builder/`: React form builder, local form filling, terminology review,
  and FHIR handoff UI.
- `agentic-entity-mapper/`: backend-only Python scripts for MetaForm
  preprocessing and FHIR bundle generation.
- `ODK/.venv-xlsform/`: XLSForm tooling used by the Node API for XLSX/XML
  import/export.

## Active Flow

1. Build a form or import an XLSForm in `form-builder`.
2. Save checkpoints while editing. The canonical draft is
   `output/forms/<workspace-id>/drafts/form.json`.
3. Run terminology extraction/review if desired. Results are written to
   `output/forms/<workspace-id>/terminology/question_entities.json`.
4. Publish the form. The server exports XLSForm `.xlsx` and XForm `.xml`.
5. Fill the published form locally in the browser.
6. The server stores entries under `output/forms/<workspace-id>/data`.
7. Click the FHIR handoff action. The server writes a mapper CSV and runs
   `form-builder/scripts/run_icph_mapper.py`.
8. The runner imports `agentic-entity-mapper/generic_form_fhir_agent.py` and
   writes per-patient FHIR bundles under
   `output/forms/<workspace-id>/fhir_bundles`.

If reviewed terminology exists for the workspace, the FHIR handoff passes
`question_entities.json` into the mapper. Admin-approved SNOMED CT, LOINC,
ICD-10, and RxNorm mappings are written into the generated FHIR as question
codings; unreviewed suggestions are ignored.

Terminology extraction is lightweight and rules/lookup-based; it is not an LLM
agent. Admins can manually add a missed entity from the Terminology tab. The UI
warns if any typed words are not present in the question text or options, but
the admin may still confirm and review that entity.

## Required Runtime Environments

Two Python environments are required.

### ODK XLSForm Environment

Required for:

- XLSForm import/inspection
- XLSForm export
- XForm XML generation through `xls2xform`

Expected paths:

```text
ODK/.venv-xlsform/bin/python
ODK/.venv-xlsform/bin/xls2xform
```

### ICPH Mapper Environment

Required for:

- terminology extraction from form questions
- schema metadata DOCX preprocessing through `markitdown`
- FHIR bundle creation through the generic mapper runner

Expected path:

```text
agentic-entity-mapper/.venv/bin/python
```

Do not delete `agentic-entity-mapper/.venv` unless the Node API is changed to
use another Python environment. The current `form-builder/server/index.js`
explicitly checks for this venv before terminology extraction and FHIR bundle
creation.

First-time setup:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/agentic-entity-mapper
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Key Paths

Schema source documents:

```text
agentic-entity-mapper/SchemaTerminologies/schemas/ICPH_MetaForms/originalDocx/
```

Processed schema Markdown/chunks:

```text
agentic-entity-mapper/SchemaTerminologies/schemas/ICPH_MetaForms/processedMD/
```

Terminology lookup assets:

```text
agentic-entity-mapper/SchemaTerminologies/artifacts/shared/
agentic-entity-mapper/SchemaTerminologies/terminologies/loinc/
```

Generated form workspaces:

```text
output/forms/
```

Each workspace contains draft JSON, checkpoints, attachments, XLSForm, XML,
submitted entries, mapper CSV, and generated FHIR bundles.

## Run Form Builder

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/form-builder
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

The admin workspace is password-gated. The default password is:

```text
ICPH2026
```

For deployments, set a different password before starting the API:

```bash
ICPH_ADMIN_PASSWORD='replace-this' npm run server
```

When an admin moves a form to Publish, the API generates a 5-character
alphanumeric respondent form code. Respondents can fill a published form from:

```text
http://localhost:5173/respondent
```

The form-builder API runs on:

```text
http://localhost:8787
```

The API port can be changed with:

```bash
ICPH_FORM_BUILDER_API_PORT=8787 npm run server
```

The frontend API URL can be changed at build/runtime with:

```bash
VITE_FORM_BUILDER_API=http://localhost:8787 npm run client
```

## Run With Docker

The ICPH form-builder and mapper app can be shared as a Docker image. The image
builds the Node app plus both Python environments expected by the server:

- `ODK/.venv-xlsform` for `pyxform` and `xls2xform`
- `agentic-entity-mapper/.venv` for mapper/preprocessing scripts

Build and start:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH
docker compose up --build
```

Open:

```text
http://localhost:5173
```

The API is exposed at:

```text
http://localhost:8787
```

Generated workspaces are persisted on the host in:

```text
output/forms/
```

For deployments, change the admin password before starting:

```bash
ICPH_ADMIN_PASSWORD='replace-this' docker compose up --build
```

If the browser will access the app from another machine, set the API URL to the
reachable host name:

```bash
VITE_FORM_BUILDER_API='http://your-hostname:8787' docker compose up --build
```

## Refresh ICPH Schema Metadata

Run this after changing or adding a schema DOCX:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/agentic-entity-mapper
./.venv/bin/python preprocess_icph_metaforms.py
```

To force a full rebuild:

```bash
./.venv/bin/python preprocess_icph_metaforms.py --force
```

## Smoke Checks

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/form-builder
node --check server/index.js
npm run build
```

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/agentic-entity-mapper
./.venv/bin/python -m py_compile generic_form_fhir_agent.py preprocess_icph_metaforms.py
./.venv/bin/python -m unittest discover tests
```
