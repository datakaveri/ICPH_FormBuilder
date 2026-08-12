# SchemaTerminologies

This directory holds the schema and optional terminology assets used by the
lean ICPH form-builder workflow.

Tracked in this client repository:

- `schemas/fhir/r4/fhir.schema.json`: FHIR R4 JSON schema used by the mapper.
- `schemas/ICPH_MetaForms/originalDocx/`: place DOCX MetaForms here before
  preprocessing.
- `schemas/ICPH_MetaForms/processedMD/`: generated Markdown/chunks are written
  here by `preprocess_icph_metaforms.py`.

Large terminology lookup/source assets are intentionally not tracked. If a
deployment needs automatic terminology suggestions, provide these optional
folders out of band:

```text
artifacts/shared/snomed_ct/<version>/lookups/snomed_ct_lookup.csv
artifacts/shared/icd10/<version>/lookups/icd10_lookup.csv
artifacts/shared/rxnorm/<version>/lookups/rxnorm_metadata.json
terminologies/loinc/<version>/LoincTable/Loinc.csv
```

Without those optional files, the app still runs. Terminology extraction reports
missing-lookup warnings, and admins can either leave everything unmapped or add
approved mappings manually in the Terminology tab.

To refresh MetaForm metadata after adding DOCX files:

```bash
cd agentic-entity-mapper
./.venv/bin/python preprocess_icph_metaforms.py
```

To rebuild all processed MetaForm outputs:

```bash
./.venv/bin/python preprocess_icph_metaforms.py --force
```
