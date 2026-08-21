// src/qobuz/liveFormat.js — q6.8
//
// A tiny in-memory cache that records the format Qobuz actually
// served for the most recent play of a given track. Set by the
// renderer adapter when it resolves a qobuz:// URL; read by
// signalPath / now-playing so the UI shows the real stream format
// instead of the DB-cached "maximum available" values.
//
// Keyed by local track id (e.g. 'qobuz-ba9d6da98ee6413c94c2302e').
// Values: { sampleRate: Hz, bitDepth: bits, mimeType, recordedAt }.
//
// Cache is intentionally short-lived and not persisted — it reflects
// "what is currently flowing" for a track, which only matters while
// that track is the active stream. Entries older than 6 hours are
// considered stale (signed URL expiry is ~1h; 6h is the outer bound).
//
// Not zone-scoped because Qobuz tracks play one-at-a-time per zone
// and the same track can't be playing at different formats on the
// same renderer simultaneously. If two zones play the same Qobuz
// track at different formats, last-write-wins. That's acceptable —
// the right zone is also the one writing most recently, since
// loadAndPlay is the call that records.

'use strict';

const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function record(trackId, info) {
  if (!trackId || !info) return;
  cache.set(String(trackId), {
    sampleRate: info.sampleRate || null,
    bitDepth:   info.bitDepth   || null,
    mimeType:   info.mimeType   || null,
    recordedAt: Date.now(),
  });
  // Expired entries are otherwise only removed when get() happens to
  // read them, so a long-running server accumulates one entry per
  // distinct track forever. Sweep opportunistically once we're big.
  if (cache.size > 500) {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [k, v] of cache) {
      if (v.recordedAt < cutoff) cache.delete(k);
    }
  }
}

function get(trackId) {
  if (!trackId) return null;
  const e = cache.get(String(trackId));
  if (!e) return null;
  if (Date.now() - e.recordedAt > MAX_AGE_MS) {
    cache.delete(String(trackId));
    return null;
  }
  return e;
}

function clear(trackId) {
  if (trackId) cache.delete(String(trackId));
  else cache.clear();
}

module.exports = { record, get, clear };
