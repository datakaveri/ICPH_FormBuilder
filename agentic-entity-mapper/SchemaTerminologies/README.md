# SchemaTerminologies handoff and rebuild notes

This folder is the shared terminology source for the entity-mapping pipeline and
the local evaluation workflow. Keep the complete `terminologies/`, `schemas/`,
and `artifacts/` directories together when copying it to another machine.

## RxNorm canonical-code bug fixed on 2026-06-22

The RxNorm source file is a BioPortal/UMLS-style TTL export. A single RxNorm
class can contain several embedded `RXCUI` properties, including historical or
source-linked identifiers. The old lookup builder repeatedly overwrote the
class identifier with those properties and retained the last value it saw.

For example, the canonical metformin class is `6809`, but its TTL block also
contains historical/source-linked values including `219495`. The old builder
therefore incorrectly wrote:

```text
219495,metformin
```

The corrected builder treats the identifier in the RxNorm class URI as the
canonical code and now writes:

```text
6809,metformin
```

The affected ingredient corrections were:

| Medication | Incorrect code | Canonical RxCUI |
|---|---:|---:|
| metformin | 219495 | 6809 |
| lisinopril | 209468 | 29046 |
| ibuprofen | 212111 | 5640 |
| amoxicillin | 216895 | 723 |
| isotretinoin | 582901 | 6064 |

The corrected shared lookup is:

```text
artifacts/shared/rxnorm/20AA_250902F/lookups/rxnorm_lookup.csv
```

All stack-specific RxNorm `lookups` paths are relative links to that shared
lookup. Do not replace them with independently generated CSVs.

## Refresh only RxNorm

RxNorm uses a lookup CSV in this pipeline; it does not have a FAISS, USearch, or
TurboVec vector index. A SNOMED or ICD-10 index rebuild is therefore **not**
required for this correction.

From the mapper checkout:

```bash
cd /path/to/workspace/agentic-entity-mapper

./.venv/bin/python -c \
'from schema_terminology_assets import build_rxnorm_lookup; print(build_rxnorm_lookup(force=True))'

./.venv/bin/python -c \
'import cache; print("cleared=", cache.clear_stage("rxnorm_entity"))'
```

Restart any running mapper/API process afterward. A running process may still
hold the previous RxNorm CSV in an in-memory dataframe even after the file and
persistent stage cache have been refreshed.

Important: use a `schema_terminology_assets.py` containing the canonical class
URI fix. An older copy of that Python file can recreate the incorrect lookup
when `force=True` is used.

## Checking existing index stacks

The following command is read-only and does not rebuild anything:

```bash
cd /path/to/workspace/agentic-entity-mapper
./.venv/bin/python -c \
'from schema_terminology_assets import describe_active_assets; print(*[f"{key}={value}" for key, value in describe_active_assets().items()], sep="\n")'
```

The available stack names are:

- `FaissBioSyn`
- `FaissSapBERT`
- `USearchBioSyn`
- `USearchSapBERT`
- `TurboVecBioSyn`
- `TurboVecSapBERT`

## Rebuilding vector indexes

Vector-index rebuilding is relevant only to the SNOMED CT and ICD-10 retrieval
assets. It is expensive, especially for SNOMED CT.

This checkout currently consumes the completed versioned index stacks in this
folder; it does not contain the long-running multi-backend index builder. When
updating SNOMED CT or ICD-10, use the maintained builder that produced this
layout, write the rebuilt files back into this same `SchemaTerminologies/`
tree, and then rerun the read-only active-asset check above. Do not recreate
legacy indexes under root-level `output/` or `Terminologies/` folders.

### Index rebuild caveats

- Do not use `--force` merely for the RxNorm correction. It unnecessarily
  rebuilds the selected SNOMED and ICD-10 vector indexes.
- Preserve `artifacts/models/`; the BioSyn/SapBERT model checkpoints are needed
  both to build indexes and embed runtime queries.
- Set `AGENTIC_ARTIFACT_STACK` to `FaissSapBERT` or `FaissBioSyn` consistently
  with the FAISS stack being evaluated in this checkout.
- The stack lookup directories are relative symlinks into `artifacts/shared/`.
  Copy the complete `SchemaTerminologies` folder so those links remain valid.
- Stop an interrupted rebuild cleanly and rerun the same command. Existing
  complete files are reused when `--force` is omitted.

## Evaluation handoff

The gold dataset is stored separately in `newEvaluation/`. Nine gold bundles
were updated for the five RxNorm corrections above. Share the updated
`newEvaluation/` folder together with this folder; otherwise teammates may use
the corrected lookup against an older, inconsistent gold set.

The current evaluator is configured to read the shared lookup artifacts in this
folder directly. If a teammate changes the checkout or folder name, update the
`paths` entries in `newEvaluation_validate/layered_eval/config.yaml` to the new
relative location. `SCHEMA_TERMINOLOGIES_DIR` controls the optional
`build_eval_lookups.py` compatibility builder, but it does not override paths
already specified explicitly in that evaluator config.
