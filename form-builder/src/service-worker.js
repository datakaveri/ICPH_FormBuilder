const CACHE_NAME = "icph-app-shell-v1";
const PRECACHE_URLS = __ICPH_PRECACHE_URLS__;

// Submissions carry the signed-in field agent's token, which only a page holds,
// so background sync hands the queue to an open page instead of posting it here.
async function requestPageSync() {
  const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const page of pages) page.postMessage({ type: "icph:sync-queue" });
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.match("/")) || (await caches.match("/index.html")) || Response.error()));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});

// Sent by a page loaded with a hard reload, which bypasses the worker.
self.addEventListener("message", (event) => {
  if (event.data?.type === "icph:claim") event.waitUntil(self.clients.claim());
});

self.addEventListener("sync", (event) => {
  if (event.tag === "icph-submit-queue") event.waitUntil(requestPageSync());
});
