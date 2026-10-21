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

The defaults in `.env` start a local Keycloak for sign-in (see
[Sign-in](#sign-in)). Keep `.env` private; it is excluded from the Docker build
context.

## Add Client Terminology Assets

If you receive a separate `ICPH_SchemaTerminologies.zip`, place it in
`agentic-entity-mapper/` and unzip it there before starting the app. The
resulting folder must be named `SchemaTerminologies`.

The complete `agentic-entity-mapper/SchemaTerminologies/` directory is mounted
read-only from the host into the container. Terminology data stays on the host,
is not baked into the image, and is available without rebuilding.

Before starting, match the container user to your account so the app can read
the mounted folder without running as root:

```bash
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

Forms, checkpoints, attachments, submissions, MetaForm documents, terminology
reviews and FHIR bundles are stored in the `postgres` service (database `icph`, Docker volume
`postgres-data`). The app creates and migrates its schema on start from
`form-builder/server/migrations/`. Back it up with:

```bash
docker compose exec postgres pg_dump -U icph icph > icph-backup.sql
```

Terminology lookup data stays in `agentic-entity-mapper/SchemaTerminologies/`.
MetaForms uploaded before they moved to the database are imported from
`SchemaTerminologies/schemas/ICPH_MetaForms/` once, on the first start after the
upgrade; the folder is ignored after that.

Stop the containers with:

```bash
docker compose down
```

This stops and removes the containers but keeps the database volume. `docker compose down -v` also deletes the database
volume, and with it every form and submission.

The browser picks the API address from the page's own address. When the app is
opened on an explicit port (such as `http://localhost:5173`), it calls port
`8787` on the same host. When it is opened on a standard port, as behind a
reverse proxy that serves both paths on one HTTPS origin, it calls `/api` on
that same origin. The proxy should route `/` to port `5173` and `/api/` to port
`8787`. Set `VITE_FORM_BUILDER_API` in `.env` and rebuild only if the API lives
somewhere else.

```bash
docker compose up --build -d
```

The repository also publishes the production image to GHCR from the `main`
branch. To deploy the published image instead of building locally, set
`ICPH_IMAGE` if a specific tag is required, then pull and start it:

```bash
export ICPH_IMAGE=ghcr.io/datakaveri/icph-form-builder:latest
docker compose pull
docker compose up -d
```

Version tags are also published when a Git tag such as `v1.0.0` is pushed.
For a private GHCR package, authenticate the host first with `docker login
ghcr.io` using a credential that has package-read access.

## Active Flow

1. Build a form or import an XLSForm in `form-builder`.
2. Save checkpoints while editing. The canonical draft is the form's row in the
   `forms` table; each save also adds a row to `form_checkpoints`.
3. Run terminology extraction/review if desired. Results are stored with the
   form.
4. Publish the form. The server exports XLSForm `.xlsx` and XForm `.xml` and
   stores both with the form.
5. Fill the published form locally in the browser.
6. The server stores each submission as a row in `entries`.
7. Click the FHIR handoff action. The server writes a mapper CSV to a scratch
   directory and runs `form-builder/scripts/run_icph_mapper.py`.
8. The runner imports `agentic-entity-mapper/generic_form_fhir_agent.py`; the
   per-patient FHIR bundles it produces are stored in `fhir_bundles`.

The XLSForm tools, terminology extractor and FHIR mapper work on files, so the
server hands them a temporary directory and reads the results back into the
database. Nothing is kept on disk.

If reviewed terminology exists for the workspace, the FHIR handoff passes
it into the mapper. Admin-approved SNOMED CT, LOINC,
ICD-10, and RxNorm mappings are written into the generated FHIR as question
codings; unreviewed suggestions are ignored.

Terminology extraction defaults to deterministic rules and local lookup data.
LLM-assisted extraction is temporarily down and disabled in the UI. FHIR bundle
generation runs locally and does not call an LLM or require external model
access; it can use admin-approved terminology mappings when available.

## PWA and Offline Collection

The field agent experience is installable as a Progressive Web App on supported
Android browsers. The app shell is cached, and a published form is saved on a
device after it is opened successfully online. The cached copy includes its
XForm, form definition, choice lists, and uploaded form media. A signed-in
field agent can then reopen that form and submit while disconnected.

Completed submissions and checkpoints are written to encrypted IndexedDB
before upload. The app uploads them with the field agent's sign-in when
connectivity returns or the app is reopened; Android Background Sync prompts an
open app to do so. If the sign-in has expired by then, they stay queued on the
device until the field agent signs in again.
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
reverse proxy; the app then calls `/api` on its own origin. HTTPS is
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

MetaForm documents and their processed Markdown/chunks are stored in Postgres
(table `meta_forms`). The preprocessor runs on a scratch copy of the DOCX files.

Optional terminology lookup assets:

```text
agentic-entity-mapper/SchemaTerminologies/artifacts/shared/
agentic-entity-mapper/SchemaTerminologies/terminologies/loinc/
```

These lookup assets are intentionally not tracked in this client repository.
Without them, the app still runs and admins can skip terminology mapping or add
reviewed mappings manually. Add the lookup folders only if a deployment needs
automatic SNOMED CT, ICD-10, LOINC, or RxNorm suggestions.

Form workspaces live in Postgres. Each one holds its draft, checkpoints,
attachments, XLSForm, XML, submitted entries, and generated FHIR bundles.

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

### Sign-in

Admins and field agents sign in through Keycloak. Nothing can be filled in or
submitted without a sign-in: collecting a response by form code is part of the
field agent screens. Each entry records the Keycloak user ID (`sub`) of whoever
submitted it, in `entries.user_id`.

`docker compose up` starts a local Keycloak on `http://localhost:8080` and runs
`keycloak/setup.py`, which creates the `icph` realm, the `icph-form-builder`
client, the roles `icph-admin` and `icph-field-agent`, and two users:

| User | Password | Role |
|---|---|---|
| `admin` | `password` | `icph-admin` |
| `fieldagent` | `password` | `icph-field-agent` |

The login page uses the `icph` theme in `keycloak/themes/icph/login/`
(templates, `resources/css/custom.css`, logos in `resources/img/`). It is
mounted into the Keycloak container, so edits show on the next page reload.

For a deployed Keycloak, `keycloak/Dockerfile` builds a production-mode image
with the theme copied in (`docker build -t <image> keycloak`). It needs a
Postgres database and serves under `/auth`; set `KC_DB_URL`, `KC_DB_USERNAME`,
`KC_DB_PASSWORD`, `KC_HOSTNAME`, and `KC_BOOTSTRAP_ADMIN_USERNAME` /
`KC_BOOTSTRAP_ADMIN_PASSWORD` for the first start. Point the app at it with
`KEYCLOAK_URL` and `KEYCLOAK_PUBLIC_URL` ending in `/auth`.

The Keycloak console login is also `admin` / `password`. These are local
development defaults: Keycloak runs in `start-dev` mode and must not be exposed
as is. The init script is safe to re-run; it does not reset the password of a
user that already exists.

When running the app with `npm run dev`, start only the database and identity
services:

```bash
docker compose up -d postgres keycloak keycloak-setup
```

The API connects with `DATABASE_URL`, which defaults to the compose database
on `localhost:5432`.

The API reads `KEYCLOAK_URL` (how the server reaches Keycloak),
`KEYCLOAK_PUBLIC_URL` (how browsers reach it; also the token issuer),
`KEYCLOAK_REALM` and `KEYCLOAK_CLIENT_ID`. Set `ICPH_APP_URLS` to the origins
the app is opened from so Keycloak accepts the login redirect. Sign-in needs a
secure browser context: `localhost` or HTTPS.

When an admin moves a form to Publish, the API generates a 5-character
alphanumeric respondent form code. A signed-in field agent fills a published
form from the Field Agent screen, or by entering the code at:

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
