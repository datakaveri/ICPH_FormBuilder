# ICPH Entity Mapper

Lean mapper support for the local ICPH form-builder workflow.

The user-facing application lives in `../form-builder`. This directory now keeps
only the pieces that are called by that app:

| Path | Purpose |
| --- | --- |
| `generic_form_fhir_agent.py` | Converts a saved form draft plus submitted answer CSV into per-patient FHIR R4 bundles. |
| `preprocess_icph_metaforms.py` | Converts ICPH MetaForm DOCX files into Markdown plus JSONL chunks. |
| `SchemaTerminologies/` | Stores the tracked FHIR schema plus ICPH MetaForm source/processed metadata folders. |

The old clinical-text agent stack, standalone FastAPI backend, prompt files,
Docker/Kubernetes wrappers, and agent-specific tests were removed from this ICPH
copy because the current local app does not call them.

Dense Faiss/USearch/TurboVec indexes, local embedding model copies, and large
terminology source files are not tracked in this client repository. The
form-builder terminology UI can use optional lightweight lookup files for
SNOMED CT, ICD-10, RxNorm, and LOINC if they are added under
`SchemaTerminologies/`, but the app can also proceed without automatic
terminology suggestions.

## Integration With Form Builder

`../form-builder/server/index.js` points to this directory as:

```js
const mapperRoot = path.join(icphRoot, "agentic-entity-mapper");
```

When the user passes submitted form data to FHIR, form-builder writes a mapper
CSV and runs:

```bash
<mapper>/.venv/bin/python ../form-builder/scripts/run_icph_mapper.py <csv> <result-json>
```

The runner imports `generic_form_fhir_agent.py` with this directory as its
working directory.

The MetaForms document processor is called by form-builder when the user clicks
the process action for uploaded schema metadata:

```bash
<mapper>/.venv/bin/python preprocess_icph_metaforms.py
```

## FHIR Output

The retained mapper creates one FHIR `Bundle` per patient identifier. Each
bundle contains:

- one `Questionnaire` for the form definition
- one `Patient`
- one `Encounter` per submitted row
- one `QuestionnaireResponse` per submitted row

Choice answers preserve both the submitted code and the display label from the
form's choices, so numeric values such as `0`/`1` remain clinically readable in
the generated bundle.

If the form workspace has reviewed terminology output, form-builder passes that
JSON to the mapper with `--terminology-review`. Only admin-approved mappings are
used. These approved SNOMED CT, LOINC, ICD-10, and RxNorm codes are added as
FHIR codings on the relevant question definitions and as an approved-terminology
extension on response items. Suggestions that were not approved in the UI are
ignored.

Derived `Observation` resources are disabled by default. They can be enabled for
compatibility checks with:

```bash
ICPH_INCLUDE_DERIVED_OBSERVATIONS=1
```

## Dependencies

The FHIR generator uses only the Python standard library. The only package in
`requirements.txt` is for DOCX preprocessing. Docker creates this environment
automatically. For local development:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

## Checks

From this directory:

```bash
./.venv/bin/python -m py_compile generic_form_fhir_agent.py preprocess_icph_metaforms.py
./.venv/bin/python -m unittest discover tests
```

## Size Note

Most of this folder's disk usage is now expected to come from `.venv/`. Rebuild
the virtual environment if you need to shrink the remaining local footprint
further.
