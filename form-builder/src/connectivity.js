// navigator.onLine only says a network is attached, not that the server can be
// reached: with mobile data on but no signal it stays true while every request
// hangs. The first request that fails marks the server unreachable, so later
// calls skip the network at once instead of each waiting to fail.
const PROBE_INTERVAL_MS = 15000;
const PROBE_TIMEOUT_MS = 5000;
let apiBase = "";
let unreachable = false;
let probeTimer = null;
const listeners = new Set();

export function configureConnectivity(nextApiBase) {
  apiBase = nextApiBase;
}

export function isOnline() {
  return navigator.onLine && !unreachable;
}

export function onConnectivityChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let lastReported = typeof navigator === "undefined" ? true : navigator.onLine;

function notifyIfChanged() {
  const online = isOnline();
  if (online === lastReported) return;
  lastReported = online;
  listeners.forEach((listener) => listener(online));
}

function setUnreachable(next) {
  unreachable = next;
  if (unreachable && !probeTimer) probeTimer = setInterval(probe, PROBE_INTERVAL_MS);
  if (!unreachable && probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  notifyIfChanged();
}

export function reportNetworkFailure() {
  setUnreachable(true);
}

export function reportNetworkSuccess() {
  if (unreachable) setUnreachable(false);
}

// While marked unreachable, check now and then whether the server answers again.
async function probe() {
  if (!navigator.onLine) return;
  try {
    await fetch(`${apiBase}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    reportNetworkSuccess();
  } catch {}
}

if (typeof window !== "undefined") {
  // A new connection deserves a fresh try; losing it needs no request to know.
  window.addEventListener("online", () => setUnreachable(false));
  window.addEventListener("offline", notifyIfChanged);
}
