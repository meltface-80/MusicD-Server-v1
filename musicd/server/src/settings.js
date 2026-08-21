// src/settings.js — typed accessor for the `settings` key/value table.
//
// v1.1.33.0. Most of this server reads settings with a one-off
// `SELECT value FROM settings WHERE key = ?` inlined at the call site
// (loudness.js, scrobbler.js, bioFetch.js, remoteUpdater.js all carry
// their own copy). That was fine while every consumer read one or two
// keys. The streaming-service clients read and write a dozen each —
// tokens, refresh tokens, expiry stamps, country codes, quality
// preferences — and a token write that silently no-ops signs the user
// out for reasons nobody can trace. So they share one accessor.
//
// Everything in the table is TEXT. get() hands back the string; the
// three coercing readers below (getNum / getBool / getJson) exist
// because a token expiry compared as a string is a bug waiting for a
// leading zero, and `'0'` is truthy.
//
// Writes of null / undefined / '' all store the empty string rather
// than a SQL NULL, so a cleared credential reads back as '' from
// every accessor and `if (!settings.get(k))` is a reliable
// "not configured" test. Callers that pass null (the ported Tidal
// client's logout does) get that same behaviour without special-casing.

'use strict';

const db = require('./db');

// Reads before db.init() are not an error — module-init code in the
// service clients can ask for a token before the database is open.
// Answer "not configured" rather than throwing, which would take the
// whole request down for what is a normal startup ordering.
function _dbOrNull() {
  try {
    return db.isReady() ? db.get() : null;
  } catch (e) {
    return null;
  }
}

// get(key, fallback) → string. Returns `fallback` (default '') when
// the key is absent, or stored as NULL by an older write path.
function get(key, fallback = '') {
  const dbh = _dbOrNull();
  if (!dbh) return fallback;
  try {
    const row = dbh.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row || row.value === null || row.value === undefined) return fallback;
    return String(row.value);
  } catch (e) {
    console.warn(`[settings] read of "${key}" failed: ${e.message}`);
    return fallback;
  }
}

// getNum(key, fallback) → number. Non-numeric and empty values give
// the fallback, so a corrupted expiry stamp reads as "expired" rather
// than as NaN (which compares false against everything and would make
// a stale token look fresh forever).
function getNum(key, fallback = 0) {
  const raw = get(key, '');
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// getBool(key, fallback) → boolean. '1' / 'true' / 'yes' / 'on' are
// true; '0' / 'false' / '' are false.
function getBool(key, fallback = false) {
  const raw = get(key, '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// getJson(key, fallback) → parsed value, or `fallback` when absent or
// unparseable. Never throws: a hand-edited settings row should not be
// able to crash a route.
function getJson(key, fallback = null) {
  const raw = get(key, '');
  if (raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[settings] "${key}" is not valid JSON, using fallback`);
    return fallback;
  }
}

// set(key, value). null / undefined store ''. Objects are JSON-encoded.
// Returns true when the write landed, false when the database was not
// open — callers that must know (the auth flows) check it.
function set(key, value) {
  const dbh = _dbOrNull();
  if (!dbh) {
    console.warn(`[settings] write of "${key}" dropped — database not ready`);
    return false;
  }
  let stored;
  if (value === null || value === undefined) stored = '';
  else if (typeof value === 'object') stored = JSON.stringify(value);
  else stored = String(value);
  try {
    dbh.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, stored);
    return true;
  } catch (e) {
    console.warn(`[settings] write of "${key}" failed: ${e.message}`);
    return false;
  }
}

// setMany(obj) — one transaction for a batch of related keys. The auth
// flows use it so a half-written credential set cannot survive a crash
// between two set() calls: either the whole token response lands or
// none of it does.
function setMany(obj) {
  const dbh = _dbOrNull();
  if (!dbh) {
    console.warn('[settings] batch write dropped — database not ready');
    return false;
  }
  const stmt = dbh.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const tx = dbh.transaction((entries) => {
    for (const [k, v] of entries) {
      let stored;
      if (v === null || v === undefined) stored = '';
      else if (typeof v === 'object') stored = JSON.stringify(v);
      else stored = String(v);
      stmt.run(k, stored);
    }
  });
  try {
    tx(Object.entries(obj));
    return true;
  } catch (e) {
    console.warn(`[settings] batch write failed: ${e.message}`);
    return false;
  }
}

module.exports = { get, getNum, getBool, getJson, set, setMany };
