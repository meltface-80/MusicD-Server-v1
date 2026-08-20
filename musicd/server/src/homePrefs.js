// Which Home-screen carousels are switched on (v1.1.21.0).
//
// Sibling of the news preferences in news.js, and deliberately NOT part of
// them, because the two groups mean different things:
//
//   news.js's four switches gate OUTSIDE requests. They are off on a fresh
//   install and turning the last one off stops a background timer, because
//   the cost of being wrong is unrequested traffic to Pitchfork, Qobuz and
//   Bandcamp.
//
//   These three gate rows that read this server's own database. There is no
//   timer, no upstream, and nothing to schedule — the cost of one being on is
//   one SQL query when the Home screen mounts. So they are ON by default: two
//   of them (Recently added, Recently played) have been on the Home screen
//   since #28.5 and an upgrade must not silently take them away.
//
// Keeping them in one blob with the news keys would have forced one default
// on both, and whichever default won would have been wrong for the other half.
const db = require('./db');

const HOME_PREF_KEYS = ['recentlyAdded', 'recentlyPlayed', 'randomAlbums'];
const HOME_PREFS_SETTING = 'home_carousels';

// Defaults live in one place so "on unless the user said otherwise" is a
// single fact rather than one repeated at every read site.
const DEFAULTS = Object.freeze({
  recentlyAdded:  true,
  recentlyPlayed: true,
  randomAlbums:   true,
});

function getHomePrefs() {
  const out = {};
  for (const k of HOME_PREF_KEYS) out[k] = DEFAULTS[k];
  try {
    const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(HOME_PREFS_SETTING);
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      // Only the keys this build knows, and only a real boolean. A blob from
      // a later build carrying extra keys must not reach in here, and a
      // truthy string must not read as "on".
      for (const k of HOME_PREF_KEYS) {
        if (parsed && typeof parsed[k] === 'boolean') out[k] = parsed[k];
      }
    }
  } catch (e) {
    // Unreadable or malformed. All-on is the safe reading HERE — the opposite
    // of the news module's all-off — because the failure costs the user a
    // local query, never a request they did not ask for, and an empty Home
    // screen after a corrupt settings row would look like data loss.
    console.warn('[home] could not read carousel preferences, using defaults:', e.message);
  }
  return out;
}

// A partial patch: only the keys present change. Two switches tapped in quick
// succession therefore cannot race into overwriting each other with a stale
// copy of the whole object.
function setHomePrefs(patch) {
  const next = getHomePrefs();
  for (const k of HOME_PREF_KEYS) {
    if (patch && typeof patch[k] === 'boolean') next[k] = patch[k];
  }
  db.get().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(HOME_PREFS_SETTING, JSON.stringify(next));
  return next;
}

module.exports = {
  HOME_PREF_KEYS,
  HOME_PREFS_SETTING,
  DEFAULTS,
  getHomePrefs,
  setHomePrefs,
};
