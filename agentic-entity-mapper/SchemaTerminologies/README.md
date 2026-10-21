# SchemaTerminologies

This directory holds the schema and optional terminology assets used by the
lean ICPH form-builder workflow.

Tracked in this client repository:

- `schemas/fhir/r4/fhir.schema.json`: FHIR R4 JSON schema used by the mapper.
- `schemas/ICPH_MetaForms/`: where MetaForms were stored before they moved to
  the form builder's database. Any DOCX files left in `originalDocx/` (with
  their output in `processedMD/`) are imported once on the next app start.
  Upload new MetaForms in the app.

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

For client handoff, the full folder may be supplied as
`ICPH_SchemaTerminologies.zip`. Place that ZIP in `agentic-entity-mapper/`,
rename or move this lightweight `SchemaTerminologies/` folder out of the way,
and unzip the file. The unzipped folder must be named exactly
`SchemaTerminologies`.

To run the MetaForm preprocessor by hand on a folder of DOCX files (the app
does this for you when you click Process):

```bash
cd agentic-entity-mapper
./.venv/bin/python preprocess_icph_metaforms.py --input-dir <docx-dir> --output-dir <out-dir>
```
