// Shared MusicBrainz rate limiter (#30.23)
// =========================================
//
// MusicBrainz allows 1 request per second per IP. Multiple modules
// in our codebase make MB requests:
//   - metadataMatch.js (the album matcher)
//   - bioFetch.js (the bio fetcher)
//   - artistLogos.js (artist MBID resolution, if it queries MB)
//
// Without coordination they could each be at 1 req/sec independently,
// breaching the limit when running in parallel. This module exposes
// a single shared "wait" function that all of them use; only one
// request can pass through at a time, with a 1.1-second floor between
// successful waits.
//
// Usage:
//   const mbThrottle = require('./mbThrottle');
//   await mbThrottle.wait();
//   const res = await axios.get(...);

const MIN_INTERVAL_MS = 1100;   // 1 req/sec, +100ms safety margin

let _lastRequestAt = 0;
let _queue = Promise.resolve();

/**
 * Wait until it's safe to make an MB request. Sleeps if needed.
 * Calls are serialised: if two waits happen concurrently, the second
 * waits for the first plus the interval.
 */
function wait() {
  // Chain onto the queue so calls are serialised even when made
  // concurrently. Each call computes its own sleep based on when
  // the previous one resolved.
  const next = _queue.then(async () => {
    const now = Date.now();
    const sleepFor = MIN_INTERVAL_MS - (now - _lastRequestAt);
    if (sleepFor > 0) await new Promise(r => setTimeout(r, sleepFor));
    _lastRequestAt = Date.now();
  });
  _queue = next;
  return next;
}

module.exports = { wait };
