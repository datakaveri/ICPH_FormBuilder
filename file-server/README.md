# ICPH File Server

A small service that stores uploaded files in Azure Blob Storage. It accepts the
same Keycloak tokens as the form builder API.

- **In Azure**, it authenticates as a **user-assigned managed identity** through
  AKS Workload Identity. No storage keys or secrets are stored anywhere.
- **Locally**, it uses the [Azurite](https://github.com/Azure/Azurite) emulator
  through a connection string.

This is the starting point. The form builder does not call it yet.

## API

Every request needs `Authorization: Bearer <Keycloak access token>` from the
`icph-form-builder` client.

| Method | Path | Role | What it does |
|---|---|---|---|
| `POST` | `/files?name=<file name>` | field agent or admin | Upload. The request body is the raw file, and `Content-Type` is the file's type. Returns `201` with `{ ok, file: { id, fileName, contentType, sizeBytes, uploadedAt } }`. |
| `GET` | `/files/<id>` | field agent or admin | Download, with the original file name in `Content-Disposition`. |
| `DELETE` | `/files/<id>` | admin | Delete. |
| `GET` | `/health` | none | `200` when the blob container is reachable. |

- Uploads stream directly to Blob Storage; the whole file is never held in memory.
- The size limit is `FILE_SERVER_MAX_UPLOAD_MB` (default 100). Larger uploads get `413`; empty files get `400`.
- File ids are random UUIDs. Blobs are stored as `uploads/<id>`. The original name, the uploader's user id, and the upload time are kept in blob metadata.
- Downloads are sent with `nosniff` and a sandboxing CSP, so an uploaded HTML or SVG file can't run as a page.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `FILE_SERVER_PORT` | `8790` | |
| `FILE_SERVER_MAX_UPLOAD_MB` | `100` | |
| `AZURE_STORAGE_ACCOUNT_URL` | | Azure: `https://<account>.blob.core.windows.net`. Authenticated with `DefaultAzureCredential`. |
| `AZURE_STORAGE_CONNECTION_STRING` | | Local emulator only. Takes precedence over the account URL. |
| `AZURE_STORAGE_CONTAINER` | `icph-files` | Created automatically only in connection-string mode. In Azure it must already exist. |
| `KEYCLOAK_URL`, `KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID` | | Same meaning and values as for the form builder API. |

## Running locally

```bash
docker compose up -d --build file-server   # also starts azurite and keycloak
curl http://localhost:8790/health
```

Upload a file. Get a token by signing in to the form builder, opening DevTools →
Network, and copying the `Authorization` header from any `/api` request:

```bash
TOKEN='eyJ...'
curl -X POST "http://localhost:8790/files?name=photo.jpg" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg

curl -OJ "http://localhost:8790/files/<id>" -H "Authorization: Bearer $TOKEN"
```

From the browser:

```js
const res = await fetch(`http://localhost:8790/files?name=${encodeURIComponent(file.name)}`, {
  method: "POST",
  headers: { ...(await authHeaders()), "content-type": file.type || "application/octet-stream" },
  body: file
});
```

The image needs Node 22 or later (`@azure/identity` requires it). The Dockerfile uses Node 24.

## Azure setup (AKS + managed identity)

Run once per environment (dev, staging, prod), using a separate identity and container for each.
The person running these needs **Managed Identity Contributor** on the resource group and
**Owner**, **User Access Administrator**, or **Role Based Access Control Administrator** on the storage account.

```bash
RG=<resource-group>; CLUSTER=<aks-cluster>; ACCOUNT=<storage-account>
NAMESPACE=icph; SA=icph-file-server; CONTAINER=icph-files

# 1. Enable the OIDC issuer and Workload Identity on the cluster.
az aks update -g $RG -n $CLUSTER --enable-oidc-issuer --enable-workload-identity
ISSUER=$(az aks show -g $RG -n $CLUSTER --query oidcIssuerProfile.issuerUrl -o tsv)

# 2. Create the container. Keys are never used, so turn shared-key access off.
az storage container create --account-name $ACCOUNT -n $CONTAINER --auth-mode login
az storage account update -g $RG -n $ACCOUNT --allow-shared-key-access false

# 3. Create the identity and give it access to this container only.
az identity create -g $RG -n icph-file-server
CLIENT_ID=$(az identity show -g $RG -n icph-file-server --query clientId -o tsv)
PRINCIPAL_ID=$(az identity show -g $RG -n icph-file-server --query principalId -o tsv)
SCOPE="$(az storage account show -g $RG -n $ACCOUNT --query id -o tsv)/blobServices/default/containers/$CONTAINER"
az role assignment create --assignee-object-id $PRINCIPAL_ID --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" --scope "$SCOPE"

# 4. Trust the file server's Kubernetes ServiceAccount.
az identity federated-credential create -g $RG --identity-name icph-file-server --name icph-file-server \
  --issuer "$ISSUER" --subject "system:serviceaccount:$NAMESPACE:$SA" --audiences api://AzureADTokenExchange

echo "Put $CLIENT_ID in k8s/file-server/icph-file-server.yaml"
```

Then fill in the `CHANGE:` lines in [k8s/file-server/icph-file-server.yaml](../k8s/file-server/icph-file-server.yaml) and apply it.
Role assignments can take a few minutes to apply. Until they do, `/health` and uploads fail with a logged `AuthorizationPermissionMismatch`.

**Not on AKS?** If the cluster's OIDC issuer can be reached from the internet, the same
federated-credential setup works. Use that issuer URL and inject the token yourself.
If it can't be reached, use a service principal with a certificate: mount the certificate from a
Secret and set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_CERTIFICATE_PATH`.
`DefaultAzureCredential` reads them, so no code changes are needed.

## Not done yet

- **Access is not per form.** Any field agent or admin can download any file whose id they know. Ids are random, but they are not a permission. Next step: tie files to a workspace and entry, and check access with the form builder API.
- **Not used by the app yet.** File questions still store data URLs or bytea in Postgres.
- **No CI or routing.** The GHCR workflow builds only the form builder image, and ingress/httproute don't route `/files` yet.
