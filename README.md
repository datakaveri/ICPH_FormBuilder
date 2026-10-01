# ICPH Form Builder And Mapper Workspace

This repository contains one user-facing web app and one lean mapper backend:

- `form-builder/`: React form builder, local form filling, terminology review,
  and FHIR handoff UI.
- `agentic-entity-mapper/`: backend-only Python scripts for MetaForm
  preprocessing and FHIR bundle generation.
- `ODK/`: lightweight XLSForm conversion tooling used by the app.

## Quick Start With Docker

Docker is the recommended way to run the ICPH app on a new machine. The image
builds the web app once, then starts the web app plus both Python environments
expected by the server:

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
git clone https://github.com/datakaveri/ICPH_FromBuilder.git ICPH
cd ICPH
cp .env.example .env
```

If you downloaded the repository as a ZIP from GitHub, unzip it first, rename
the unzipped folder to `ICPH`, open that folder in Terminal, and then run:

```bash
cp .env.example .env
```

Edit `.env` and replace the `ICPH_ADMIN_PASSWORD` placeholder with a private,
random secret of at least 16 characters. The production server refuses the
sample placeholder and the old default password. Keep `.env` private; it is
excluded from the Docker build context.

## Add Client Terminology Assets

If you receive a separate `ICPH_SchemaTerminologies.zip`, place it in
`agentic-entity-mapper/` and unzip it there before starting the app. The
resulting folder must be named `SchemaTerminologies`.

The complete `agentic-entity-mapper/SchemaTerminologies/` directory is mounted
from the host into the container. Terminology data and uploaded MetaForms stay
on the host, are not baked into the image, and are available without rebuilding.

Before starting, create the host data directory and match the container user to
your account so the app can write persisted data without running as root:

```bash
mkdir -p output
export ICPH_UID="$(id -u)"
export ICPH_GID="$(id -g)"
docker compose up --build -d
```

Follow startup logs with `docker compose logs -f icph` and stop following with
Ctrl-C. The containers continue running in the background.

If Docker says `no configuration file provided: not found`, you are probably
one folder too high or too low. Move into the main `ICPH` project folder, the
one that contains `docker-compose.yml`, and run the Docker command again.

If Docker says it `failed to connect to the docker API` or asks whether the
Docker daemon is running, open Docker Desktop first and wait until it says
Docker is running. Then run the Docker command again from the main `ICPH`
folder.

Open the app:

```text
http://localhost:5173
```

The API is exposed at:

```text
http://localhost:8787
```

The web and API ports are bound to the host loopback interface by default. For
shared hosting, put an HTTPS reverse proxy in front of ports `5173` and `8787`;
HTTPS is required for browser camera and geolocation permissions. Do not expose
the API directly to the public internet.

Generated form workspaces and submissions are persisted on the host at:

```text
output/forms/
```

Terminology data, uploaded MetaForm documents, and generated metadata persist in
`agentic-entity-mapper/SchemaTerminologies/`.

Stop the containers with:

```bash
docker compose down
```

This stops/removes the container but leaves both host data directories intact.
Do not delete `output/` or the MetaForm data directory when redeploying.

By default, the browser calls the API on the same hostname as the web app, port
`8787`. When using a reverse proxy that serves both paths on one HTTPS origin,
set `VITE_FORM_BUILDER_API` in `.env` to that origin (for example,
`https://forms.example.org`) and rebuild. The proxy should route `/` to port
`5173` and `/api/` to port `8787`.

```bash
docker compose up --build -d
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

Terminology extraction defaults to deterministic rules and local lookup data.
LLM-assisted extraction is temporarily down and disabled in the UI. FHIR bundle
generation runs locally and does not call an LLM or require external model
access; it can use admin-approved terminology mappings when available.

## PWA and Offline Collection

The respondent experience is installable as a Progressive Web App on supported
Android browsers. The app shell is cached, and a published form is saved on a
device after it is opened successfully online. The cached copy includes its
XForm, form definition, choice lists, and uploaded form media. Respondents can
then reopen that form and submit while disconnected.

Completed submissions and checkpoints are written to encrypted IndexedDB
before upload. The browser retries them when connectivity returns, when the app
is reopened, and through Android Background Sync where the browser supports it.
The server uses an idempotency key so a retry after an interrupted response
does not create a duplicate. ODK submission attachments are queued with their
instance XML. A visible sync count and a manual **Sync now** action are shown
while there are pending items.

Answer drafts and queued submissions use AES-GCM with a non-extractable,
per-browser key. This protects the stored database from casual inspection, but
it is not a substitute for device security: anyone who can run the app in that
browser profile can access its records. Use managed, screen-locked devices for
participant data, do not clear browser site data while items are waiting to
sync, and verify the pending-sync count is zero before retiring a device.
Browser storage can still be removed by the user or operating system, so it is
not a backup.

For AWS, serve the app and `/api/` on the **same HTTPS origin** through the
reverse proxy. Set `VITE_FORM_BUILDER_API` to that public HTTPS origin before
building the Docker image (for example, `https://forms.example.org`). HTTPS is
required for PWA installation and for camera, geolocation, and secure browser
storage APIs. Android camera/file permissions remain controlled by the browser
and the device. Forms must be opened online once on each device before they
can be filled offline.

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

For day-to-day development without Docker:

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

The frontend API URL can be changed for local development with:

```bash
VITE_FORM_BUILDER_API=http://localhost:8787 npm run client
```

To test the built frontend locally:

```bash
npm run build
npm run start
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
