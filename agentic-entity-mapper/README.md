# Agentic Entity Mapper Backend

Backend-only medical entity mapping and FHIR R4 bundle generation for ICPH.
The user-facing ICPH interface lives in `../form-builder`; this repository now
provides the mapper services and scripts that the form-builder calls.

## Integration

`../form-builder/server/index.js` points to this directory as:

```js
const mapperRoot = path.join(icphRoot, "agentic-entity-mapper");
```

When a filled ICPH form is passed to the mapper, form-builder writes a mapper
CSV and runs:

```bash
<mapper>/.venv/bin/python ../form-builder/scripts/run_icph_mapper.py <csv> <result-json>
```

The runner executes with `cwd` set to this repository, so it imports
`icph_csv_agent.py` from the mapper backend without ambiguity.

## Main Components

| Path | Purpose |
| --- | --- |
| `react_api.py` | FastAPI backend endpoints for headless pipeline jobs, saved FHIR bundles, and ICPH CSV upload. |
| `pipeline_service.py` | UI-independent orchestration for the clinical text pipeline. |
| `generic_form_fhir_agent.py` | Form-builder/XLSForm draft plus submitted answer CSV to FHIR Questionnaire/QuestionnaireResponse bundles. |
| `icph_csv_agent.py` | Standalone legacy ICPH MetaForm CSV ingestion backed by processed ICPH_MetaForms schema chunks. |
| `preprocess_icph_metaforms.py` | Converts ICPH meta-form DOCX files into Markdown and JSONL schema chunks. |
| `*_agent.py` | Extraction, terminology enrichment, context, and FHIR agents. |
| `SchemaTerminologies/schemas/ICPH_MetaForms/` | ICPH MetaForm context used for protocol linking and standalone schema inspection, not form-builder FHIR creation. |
| `output/` and `cache/` | Generated runtime artifacts; intentionally ignored by Git. |

Large terminology/model assets under `SchemaTerminologies/` remain ignored by
Git. Lightweight FHIR and ICPH_MetaForms schemas can be tracked with the app.

## Setup

Use Python 3.11 for dependency compatibility.

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

## Running The Backend API

The form-builder uses the local script handoff and does not require this API to
be running. Start FastAPI only when you need direct API access:

```bash
./.venv/bin/python -m uvicorn react_api:app --reload
```

Health check:

```bash
curl http://127.0.0.1:8000/api/health
```

## Form-Builder FHIR Handoff

The form-builder FHIR path uses only the exported/submitted form data and its
saved draft JSON. MetaForms may be linked in the UI for context, provenance,
and future cross-form grouping, but they are not used to create FHIR bundles.

You can test the same backend path used by form-builder with:

```bash
./.venv/bin/python ../form-builder/scripts/run_icph_mapper.py \
  /path/to/mapper-input.csv \
  /tmp/icph_mapper_result.json \
  --primary-identifier participant_id \
  --generic-form-draft /path/to/form-builder/drafts/form.json
```

The generated bundles use FHIR R4 `Questionnaire` and `QuestionnaireResponse`
as the canonical form/answer representation. Derived `Observation` resources
are off by default and can be enabled only for compatibility by setting:

```bash
ICPH_INCLUDE_DERIVED_OBSERVATIONS=1
```
