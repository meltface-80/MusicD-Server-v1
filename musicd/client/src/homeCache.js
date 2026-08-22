// src/homeCache.js — what the Home screen looked like last time.
//
// v1.1.37.0. Reopening the PWA rebuilt the Home screen from nothing, and
// it showed. The sequence on a cold launch was:
//
//   1. the counters render 0 artists / 0 albums / 0 tracks
//   2. NO carousels render at all, because `prefs` starts null and the
//      screen will not guess which rows the user wants
//   3. the prefs call returns, the rows appear as empty skeletons
//   4. three more calls return and the rows fill in
//
// Four paints, three of them wrong, and two big layout jumps. That reads
// as "the whole page refreshed" — because it did.
//
// None of it is fixable by caching HTTP responses: the service worker
// deliberately never caches /api/* (stale library data is worse than a
// slow one), and iOS evicts a backgrounded PWA's web view, so a relaunch
// is a genuine cold start of the JavaScript.
//
// What IS fixable is having something true to draw immediately. This
// keeps the last good Home payload in localStorage; the screen seeds its
// state from it SYNCHRONOUSLY on the first render, then revalidates in
// the background and updates only what actually changed. Stale for a
// moment beats empty for a second, and new albums still appear — just
// without the screen being demolished first.
//
// Deliberately localStorage and not the service worker: this is one
// screen's view model, not a caching policy for the API. Widening the
// SW to serve stale /api/* would make every screen in the app lie.

const KEY = 'musicd.home.v1'

// A payload bigger than this is a bug somewhere upstream, not a Home
// screen. localStorage is a small, synchronous, shared budget — filling
// it would break the theme preference and the sort view alongside this.
const MAX_BYTES = 256 * 1024

// Read the last snapshot. Returns null when there is nothing usable,
// which every caller treats as "start empty" — the pre-v1.1.37.0
// behaviour, so a failure here costs nothing but the optimisation.
export function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch (e) {
    // Private mode, disabled storage, or a payload written by an older
    // shape that no longer parses. Silence is safe: the screen falls
    // back to fetching everything, which is what it did before this
    // module existed.
    return null
  }
}

// Merge a patch into the snapshot. Called after each successful fetch,
// so the stored view is whatever the screen last actually showed.
export function write(patch) {
  if (!patch || typeof patch !== 'object') return
  try {
    const next = { ...(read() || {}), ...patch, at: Date.now() }
    const json = JSON.stringify(next)
    if (json.length > MAX_BYTES) {
      // Do not persist, but do not clear what is already there either:
      // an oversized write is no reason to lose a good older snapshot.
      return
    }
    localStorage.setItem(KEY, json)
  } catch (e) {
    // Quota exceeded, or storage unavailable. The screen works without
    // the snapshot; there is nothing to tell the user and nothing to
    // retry.
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY)
  } catch (e) {
    // Same as above — nothing depends on the removal succeeding.
  }
}

// True when `next` says something different from `prev`.
//
// The screen calls this before setting state, because the common case on
// a relaunch is that NOTHING has changed: the same twelve albums come
// back in the same order. Setting state anyway re-renders every tile and
// makes the artwork blink, which is the exact flicker the snapshot
// exists to remove. A JSON compare of a twelve-item list is far cheaper
// than the render it avoids.
export function changed(prev, next) {
  if (prev === next) return false
  try {
    return JSON.stringify(prev) !== JSON.stringify(next)
  } catch (e) {
    // Circular or otherwise unstringifiable — assume it changed and let
    // React do the work rather than wrongly skipping an update.
    return true
  }
}
