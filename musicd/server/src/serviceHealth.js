// Service health tracking (#v1.1.0.24)
// =====================================
//
// In-memory record of each external service's most recent call. Used
// by the Settings → Built-in Services UI to show a green/red/grey
// indicator per service.
//
// Why in-memory rather than DB:
//   - Health is a transient state. A failure 3 weeks ago isn't useful.
//     What we want is "did the last call work?". After a restart we
//     genuinely don't know -- showing grey until the next call lands
//     is the honest answer.
//   - Avoids DB writes on every external API call (some of these run
//     dozens of times during a library scan).
//
// Three states the UI renders:
//   ok    — most recent call succeeded
//   fail  — most recent call failed
//   idle  — no call in the last STALE_AFTER_MS, or service never called
//
// Modules call recordSuccess(name) / recordFailure(name, error) after
// each external request. The status object is read by the
// /api/health/services route.

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;  // 24 hours

// Static list of services we track. Locking these down rather than
// allowing arbitrary names means a typo'd recordSuccess() can't
// silently create a new entry.
const SERVICES = ['lastfm', 'fanart', 'audiodb', 'acoustid', 'musicbrainz'];

// Per-service state. Each entry:
//   { lastSuccessAt: number|null, lastFailureAt: number|null, lastError: string|null }
const _state = new Map();
for (const s of SERVICES) {
  _state.set(s, { lastSuccessAt: null, lastFailureAt: null, lastError: null });
}

function recordSuccess(name) {
  const entry = _state.get(name);
  if (!entry) {
    console.warn(`[serviceHealth] Unknown service '${name}' -- ignored`);
    return;
  }
  entry.lastSuccessAt = Date.now();
  // Keep lastError around as historical context even after recovery,
  // so the UI can show "last failed Xh ago" if useful. Cleared only
  // on explicit reset.
}

function recordFailure(name, error) {
  const entry = _state.get(name);
  if (!entry) {
    console.warn(`[serviceHealth] Unknown service '${name}' -- ignored`);
    return;
  }
  entry.lastFailureAt = Date.now();
  // Trim long error messages -- some upstream errors are 500-line
  // stack traces. The UI shows ~80 chars max anyway.
  entry.lastError = (typeof error === 'string'
    ? error
    : (error?.message || String(error || 'unknown error'))
  ).slice(0, 240);
}

function getStatus() {
  const now = Date.now();
  const out = {};
  for (const [name, entry] of _state.entries()) {
    const last = Math.max(entry.lastSuccessAt || 0, entry.lastFailureAt || 0);
    let status;
    if (!last) {
      status = 'idle';                  // never called
    } else if (now - last > STALE_AFTER_MS) {
      status = 'idle';                  // stale (>24h ago)
    } else if ((entry.lastSuccessAt || 0) >= (entry.lastFailureAt || 0)) {
      status = 'ok';
    } else {
      status = 'fail';
    }
    out[name] = {
      status,
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      lastError: entry.lastError,
    };
  }
  return out;
}

module.exports = {
  recordSuccess,
  recordFailure,
  getStatus,
  SERVICES,
};
