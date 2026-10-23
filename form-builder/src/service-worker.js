const CACHE_NAME = "icph-app-shell-v1";
const PRECACHE_URLS = __ICPH_PRECACHE_URLS__;

// The server answers with "Vary: Origin" and the page loads its scripts and
// styles with crossorigin, so the page's requests carry an Origin header the
// precache requests did not. A strict match would then miss every saved file.
function fromCache(request) {
  return caches.match(request, { ignoreVary: true });
}

// Every page of the app is the same index.html, saved as "/". It is opened
// from the cache without waiting on the network; a new release reaches it when
// the browser installs the updated worker, which saves the new page and files
// together, and shows from the next launch.
async function openApp(request) {
  return (await fromCache("/")) || fetch(request);
}

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

// Keycloak (/auth), the API (/api) and the file server (/files) share this
// domain but are not part of the app. Leave them to the network, or a click on
// "Log in" would get the cached app page instead of the Keycloak login.
const PASS_THROUGH_PREFIXES = ["/auth/", "/api/", "/files/"];

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (PASS_THROUGH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") {
    event.respondWith(openApp(request));
    return;
  }
  event.respondWith(fromCache(request).then((cached) => cached || fetch(request)));
});

// Sent by a page loaded with a hard reload, which bypasses the worker.
self.addEventListener("message", (event) => {
  if (event.data?.type === "icph:claim") event.waitUntil(self.clients.claim());
});

self.addEventListener("sync", (event) => {
  if (event.tag === "icph-submit-queue") event.waitUntil(requestPageSync());
});
