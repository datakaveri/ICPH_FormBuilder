# Local ODK Learning Notes

This folder is for learning the ODK flow locally:

1. Convert and validate an XLSForm Excel file.
2. Later, run your own local ODK Central instance.

## Phase 1: Convert XLSForm to XForm XML

ODK forms are commonly authored as Excel files using the XLSForm format. The form that ODK Central and ODK Collect ultimately use is an XForm XML file.

From this folder:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK
python3 -m venv .venv-xlsform
source .venv-xlsform/bin/activate
pip install --upgrade pip
pip install -r tools/requirements-xlsform.txt
chmod +x tools/convert_xlsform.sh
```

Convert the current XLSForm template:

```bash
./tools/convert_xlsform.sh "ODK XLSForm Template v2023.1.xlsx"
```

Expected output location:

```text
forms/converted/ODK XLSForm Template v2023.1.xml
```

If the XLSForm has errors, `xls2xform` prints validation messages instead of producing a clean XML file. Fix the spreadsheet, save it, and rerun the same command.

You can also pass an explicit output path:

```bash
./tools/convert_xlsform.sh "ODK XLSForm Template v2023.1.xlsx" forms/converted/test-form.xml
```

## Phase 2: Run Central Locally

The cloned Central repo is here:

```text
/Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK/central
```

Central is Docker-based. On this machine, use Colima plus the legacy `docker-compose` command.

### First-Time Install

```bash
brew install colima docker docker-compose docker-buildx
mkdir -p ~/.docker/cli-plugins
ln -sfn /opt/homebrew/opt/docker-buildx/bin/docker-buildx ~/.docker/cli-plugins/docker-buildx
```

Check that the tools are available:

```bash
colima version
docker --version
docker-compose --version
docker buildx version
```

### First-Time Central Setup

Start Colima:

```bash
colima start
```

The clone has a `server` submodule path. If `central/server` is empty, initialize submodules. This needs internet access because it downloads the Central backend repo:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK/central
git submodule update --init --recursive
```

This folder already has a local `.env` for testing:

```text
DOMAIN=local
SYSADMIN_EMAIL=you@example.com
SSL_TYPE=selfsign
HTTP_PORT=8080
HTTPS_PORT=8443
```

The file `central/files/allow-postgres14-upgrade` is also present. ODK's install docs currently require this file even for a fresh install.

Add the local hostname once if your browser cannot resolve `local`:

```bash
sudo sh -c 'printf "\n127.0.0.1 local\n" >> /etc/hosts'
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
```

Build and start Central from the `ODK` folder:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK
./tools/central-start.sh
```

On Apple Silicon, `central-start.sh` sets `DOCKER_DEFAULT_PLATFORM=linux/amd64` by default because at least one Central build image does not have an ARM64 manifest. This is normal for this local test setup; builds may be slower because Docker/Colima has to emulate AMD64.

Create the first local admin account after Central is running:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK/central
docker-compose exec service odk-cmd --email you@example.com user-create
docker-compose exec service odk-cmd --email you@example.com user-promote
```

Use a real email address if you want. The password must meet Central's minimum length requirement.

### Daily Start

Start Colima:

```bash
colima start
```

Start the Central Docker containers:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK
./tools/central-start.sh
```

Open Central:

```text
https://local:8443
```

If your browser cannot resolve `local`, add it to your hosts file:

```bash
sudo sh -c 'printf "\n127.0.0.1 local\n" >> /etc/hosts'
```

Because this uses a self-signed certificate, your browser will warn you. That is expected for local testing.

Check container status:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK
./tools/central-status.sh
```

Watch logs if something is still starting:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK
./tools/central-logs.sh
```

### Daily Stop

Stop the Central Docker containers:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK
./tools/central-stop.sh
```

Stop Colima after Docker containers are stopped:

```bash
colima stop
```

### Reset Local Central Data

Only run this when you intentionally want to wipe the local Central database and uploaded forms:

```bash
cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK/central
docker-compose down -v
```

## Uploading the XLSForm Later

Once local Central is running:

1. Create or log in as an admin user.
2. Create a Project.
3. Add a new Form.
4. Upload the `.xlsx` directly, or upload the generated `.xml` from `forms/converted`.

For learning, upload the `.xlsx` first. Central will convert it using its own pyxform service and show validation errors if the spreadsheet needs changes.
