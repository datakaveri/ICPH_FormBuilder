# ICPH Form Builder And Mapper Workspace

This repository contains one user-facing web app and one lean mapper backend:

- `form-builder/`: React form builder, local form filling, terminology review,
  and FHIR handoff UI.
- `agentic-entity-mapper/`: backend-only Python scripts for MetaForm
  preprocessing and FHIR bundle generation.
- `ODK/`: lightweight XLSForm conversion tooling used by the app.

## Quick Start With Docker

Docker is the recommended way to run the ICPH app on a new machine. The image
builds the Node app plus both Python environments expected by the server:

- `ODK/.venv-xlsform` for `pyxform` and `xls2xform`
- `agentic-entity-mapper/.venv` for mapper/preprocessing scripts

First get the project onto your laptop. Either option is fine:

- Clone the repository with Git.
- Download the repository as a ZIP from GitHub, then unzip it and rename the
  unzipped folder to `ICPH`.

After that, open the main project folder named `ICPH`. This is the folder that
contains `docker-compose.yml`.

If you are using Git, the commands look like this:

```bash
git clone https://github.com/nikipatil281/ICPH_health.git ICPH
cd ICPH
docker compose up --build
```

If you downloaded the repository as a ZIP from GitHub, unzip it first, rename
the unzipped folder to `ICPH`, open that folder in Terminal, and then run:

```bash
docker compose up --build
```

If Docker says `no configuration file provided: not found`, you are probably
one folder too high or too low. Move into the main `ICPH` project folder, the
one that contains `docker-compose.yml`, and run the Docker command again.

If Docker says it `failed to connect to the docker API` or asks whether the
Docker daemon is running, open Docker Desktop first and wait until it says
Docker is running. Then run the Docker command again from the main `ICPH`
folder.

## Add Client Terminology Assets

You may receive a separate file named:

```text
ICPH_SchemaTerminologies.zip
```

Place that ZIP file inside:

```text
ICPH/agentic-entity-mapper/
```

Then unzip it there. After unzipping, you should see a folder named:

```text
SchemaTerminologies
```

inside:

```text
ICPH/agentic-entity-mapper/
```

The ZIP file name can stay as `ICPH_SchemaTerminologies.zip`; the folder created
after unzipping must be named `SchemaTerminologies`.

Once that folder is in place, return to the main `ICPH` folder and start the app:

```bash
docker compose up --build
```

Open the app:

```text
http://localhost:5173
```

The API is exposed at:

```text
http://localhost:8787
```

The admin workspace is password-gated. The default local password is:

```text
ICPH2026
```

For any shared or deployed environment, set a different password before
starting:

```bash
ICPH_ADMIN_PASSWORD='replace-this' docker compose up --build
```

Generated form workspaces and submissions are persisted on the host at:

```text
output/forms/
```

Stop the containers with:

```bash
docker compose down
```

By default, the browser calls the API on the same hostname as the web app, port
`8787`. If you need to override that, set the API URL explicitly:

```bash
VITE_FORM_BUILDER_API='http://your-hostname:8787' docker compose up --build
```

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

## Local Development Without Docker

Use this path only if you want to run the Node app and Python tooling directly
on your machine.

### Required Runtime Environments

Two Python environments are required.

#### ODK XLSForm Environment

Required for:

- XLSForm import/inspection
- XLSForm export
- XForm XML generation through `xls2xform`

Expected paths:

```text
ODK/.venv-xlsform/bin/python
ODK/.venv-xlsform/bin/xls2xform
```

#### ICPH Mapper Environment

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
cd agentic-entity-mapper
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Create the XLSForm conversion environment from the repository root:

```bash
python3 -m venv ODK/.venv-xlsform
ODK/.venv-xlsform/bin/python -m pip install --upgrade pip
ODK/.venv-xlsform/bin/python -m pip install -r ODK/tools/requirements-xlsform.txt
```

Install the Node app dependencies:

```bash
cd form-builder
npm install
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

Optional terminology lookup assets:

```text
agentic-entity-mapper/SchemaTerminologies/artifacts/shared/
agentic-entity-mapper/SchemaTerminologies/terminologies/loinc/
```

These lookup assets are intentionally not tracked in this client repository.
Without them, the app still runs and admins can skip terminology mapping or add
reviewed mappings manually. Add the lookup folders only if a deployment needs
automatic SNOMED CT, ICD-10, LOINC, or RxNorm suggestions.

Generated form workspaces:

```text
output/forms/
```

Each workspace contains draft JSON, checkpoints, attachments, XLSForm, XML,
submitted entries, mapper CSV, and generated FHIR bundles.

## Run Form Builder

```bash
cd form-builder
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

## Refresh ICPH Schema Metadata

Run this after changing or adding a schema DOCX:

```bash
cd agentic-entity-mapper
./.venv/bin/python preprocess_icph_metaforms.py
```

To force a full rebuild:

```bash
./.venv/bin/python preprocess_icph_metaforms.py --force
```

## Smoke Checks

```bash
cd form-builder
node --check server/index.js
npm run build
```

```bash
cd agentic-entity-mapper
./.venv/bin/python -m py_compile generic_form_fhir_agent.py preprocess_icph_metaforms.py
./.venv/bin/python -m unittest discover tests
```
