# ICPH Form Builder And Mapper Workspace

This workspace has one user-facing UI and one mapper backend:

- `form-builder/`: the ICPH form-building, data-entry, and mapper-handoff UI.
- `agentic-entity-mapper/`: backend-only entity mapping and FHIR generation.

Older mapper copies are no longer active targets.

## Active Flow

1. Build or open an ICPH form in `form-builder`.
2. Fill and submit entries in the form-builder UI.
3. Click the mapper handoff action in form-builder.
4. `form-builder/server/index.js` writes a mapper CSV under the form output.
5. The server runs `form-builder/scripts/run_icph_mapper.py` with `cwd` set to
   `agentic-entity-mapper/`.
6. The runner imports `agentic-entity-mapper/icph_csv_agent.py`, validates the
   CSV against the ICPH_MetaForms schema chunks, and writes FHIR bundles.

## Key Paths

Schema source:

```text
agentic-entity-mapper/SchemaTerminologies/schemas/ICPH_MetaForms/originalDocx/
```

Processed schema chunks:

```text
agentic-entity-mapper/SchemaTerminologies/schemas/ICPH_MetaForms/processedMD/
```

Sample CSV inputs:

```text
input/
```

Generated ICPH mapper outputs:

```text
output/icph_fhir_bundles/
```

Generated form-builder workspaces:

```text
output/forms/
```

## Run Form Builder

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/form-builder
npm run dev
```

Open:

```text
http://localhost:5173
```

The form-builder API runs on:

```text
http://localhost:8787
```

## Mapper Backend Setup

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/agentic-entity-mapper
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Form-builder does not need the mapper HTTP API to be running; it calls the
mapper by executing the Python runner directly.

## Refresh ICPH Schema

Run this after changing or adding a schema DOCX:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/agentic-entity-mapper
./.venv/bin/python preprocess_icph_metaforms.py
```

To force a full rebuild:

```bash
./.venv/bin/python preprocess_icph_metaforms.py --force
```

## Smoke Test Mapper Handoff

This uses the same script path that form-builder calls:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/agentic-entity-mapper
./.venv/bin/python ../form-builder/scripts/run_icph_mapper.py \
  ../input/5docx-form1-enrolment_personal_details.csv \
  /tmp/icph_mapper_result.json
```

Expected output includes `"ok": true` and a nonzero `bundle_count`.
