const CACHE_NAME = "icph-app-shell-v1";
const PRECACHE_URLS = __ICPH_PRECACHE_URLS__;
const DATABASE_NAME = "icph-offline-v1";
const DATABASE_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("formPackages")) database.createObjectStore("formPackages", { keyPath: "accessCode" });
      if (!database.objectStoreNames.contains("offlineDrafts")) database.createObjectStore("offlineDrafts", { keyPath: "id" });
      if (!database.objectStoreNames.contains("submissionQueue")) database.createObjectStore("submissionQueue", { keyPath: "id" });
      if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(storeName, mode, action) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("Offline storage transaction was aborted."));
    };
  }));
}

async function syncQueuedSubmissions() {
  const [apiBaseSetting, encryptionKey, encryptedItems] = await Promise.all([
    storeRequest("meta", "readonly", (store) => store.get("apiBase")),
    storeRequest("meta", "readonly", (store) => store.get("deviceKey")),
    storeRequest("submissionQueue", "readonly", (store) => store.getAll())
  ]);
  const apiBase = apiBaseSetting?.value;
  if (!apiBase || !encryptionKey?.value) return;
  for (const item of encryptedItems.sort((left, right) => left.createdAt - right.createdAt)) {
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: item.iv },
        encryptionKey.value,
        item.ciphertext
      );
      const record = JSON.parse(new TextDecoder().decode(plaintext));
      const response = await fetch(`${apiBase}${record.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...record.payload, clientSubmissionId: item.id })
      });
      if (!response.ok) continue;
      await storeRequest("submissionQueue", "readwrite", (store) => store.delete(item.id));
    } catch {
      return;
    }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("icph-app-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "icph:configure" || !event.data.apiBase) return;
  event.waitUntil(storeRequest("meta", "readwrite", (store) => store.put({ key: "apiBase", value: event.data.apiBase })));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.match("/")) || (await caches.match("/index.html")) || Response.error()));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});

self.addEventListener("sync", (event) => {
  if (event.tag === "icph-submit-queue") event.waitUntil(syncQueuedSubmissions());
});
