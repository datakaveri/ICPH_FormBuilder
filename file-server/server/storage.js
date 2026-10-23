import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

// Production: AZURE_STORAGE_ACCOUNT_URL, authenticated by DefaultAzureCredential
// (managed identity through AKS Workload Identity, or a service principal from
// AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_CERTIFICATE_PATH).
// Local development: AZURE_STORAGE_CONNECTION_STRING pointing at Azurite.
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING || "";
const accountUrl = String(process.env.AZURE_STORAGE_ACCOUNT_URL || "").replace(/\/+$/, "");
const containerName = process.env.AZURE_STORAGE_CONTAINER || "icph-files";
const blobPrefix = "uploads/";
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createServiceClient() {
  if (connectionString) return BlobServiceClient.fromConnectionString(connectionString);
  if (accountUrl) return new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  throw new Error("Set AZURE_STORAGE_ACCOUNT_URL (Azure, managed identity) or AZURE_STORAGE_CONNECTION_STRING (local emulator).");
}

const container = createServiceClient().getContainerClient(containerName);

export function storageDescription() {
  return connectionString ? `container "${containerName}" via connection string` : `container "${containerName}" at ${accountUrl}`;
}

// In Azure the container is created ahead of time and the file server's identity
// only has a role on that container, so it cannot create it. The emulator starts empty.
export async function prepareStorage() {
  if (connectionString) await container.createIfNotExists();
}

export async function storageReachable() {
  return container.exists();
}

export function isFileId(value) {
  return FILE_ID_PATTERN.test(String(value || ""));
}

function blobFor(id) {
  return container.getBlockBlobClient(`${blobPrefix}${id}`);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

// Blob metadata must be ASCII, so text from users is stored URI-encoded.
function encodeMetadata(value) {
  return encodeURIComponent(String(value || ""));
}

function decodeMetadata(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

export async function uploadFile(source, { fileName, contentType, uploadedBy, maxBytes }) {
  const id = randomUUID();
  const blob = blobFor(id);
  const uploadedAt = new Date().toISOString();
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) return callback(httpError(413, `File exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`));
      callback(null, chunk);
    }
  });
  // Errors surface through uploadStream below; staged blocks that are never
  // committed are discarded by Azure, so a failed upload leaves no blob behind.
  // Not stream.pipeline: it would destroy the request, and with it the socket
  // the error response has to go out on.
  source.on("error", (error) => counter.destroy(error));
  source.pipe(counter);
  await blob.uploadStream(counter, 4 * 1024 * 1024, 4, {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: {
      originalname: encodeMetadata(fileName),
      uploadedby: encodeMetadata(uploadedBy),
      uploadedat: uploadedAt
    }
  });
  if (!sizeBytes) {
    await blob.deleteIfExists();
    throw httpError(400, "The file is empty.");
  }
  return { id, fileName, contentType, sizeBytes, uploadedAt };
}

export async function downloadFile(id) {
  try {
    const response = await blobFor(id).download();
    return {
      stream: response.readableStreamBody,
      contentType: response.contentType || "application/octet-stream",
      sizeBytes: response.contentLength,
      fileName: decodeMetadata(response.metadata?.originalname) || id
    };
  } catch (error) {
    if (error?.statusCode === 404) throw httpError(404, "File not found.");
    throw error;
  }
}

export async function deleteFile(id) {
  const result = await blobFor(id).deleteIfExists();
  if (!result.succeeded) throw httpError(404, "File not found.");
}
