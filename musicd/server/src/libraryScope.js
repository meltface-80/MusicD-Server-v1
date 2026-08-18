// Library scope (#30.9)
// =====================
// Owns the user-configurable list of folders to scan. Stored as JSON in
// settings.library_scope. Empty list means "scan nothing"; nonexistent
// key means "first boot of v30.9 — auto-seed with /music for backward
// compat with existing installs".
//
// Scope semantics:
//   • A path is "in scope" if it is, or is a descendant of, any path in
//     the active list.
//   • Overlapping entries are normalised on add: if you add /music/Albums
//     while /music/Albums/Bowie is in the list, the Bowie entry is
//     removed (now redundant). If you try to add /music/Albums/Bowie
//     when /music/Albums is already in the list, the add is a no-op.
//   • Paths are stored as absolute paths under /music (the in-container
//     path). They're always normalised: no trailing slash, no relative
//     components.
//
// Soft-delete model: removing a folder doesn't touch the database in
// terms of row deletion. Instead, every track/album with a path under
// the removed folder gets `excluded = 1`. The scanner's update of this
// flag is the public side-effect of the on/off toggle. Re-adding a
// folder unsets the flag — preserving favourites, play counts, and
// metadata for the rows that reappear.
//
// The watcher (chokidar) and the scan-walk both consult this module to
// decide what's in scope. Changes to the scope must trigger a watcher
// reconfiguration — chokidar can't add/remove paths cleanly mid-watch
// so we restart it. See scanner.js applyScopeChange().

const path = require('path');
const db = require('./db');

const MUSIC_ROOT = '/music';
const SETTINGS_KEY = 'library_scope';
const LEGACY_DEFAULT = [MUSIC_ROOT]; // back-compat for existing installs

// Cache of the parsed array, invalidated on any setScope() call. The
// scanner reads scope on every file event so keeping this in memory
// matters for big libraries.
let _cache = null;

/**
 * Normalise a scope path to its canonical form. Paths must be absolute
 * and rooted under MUSIC_ROOT. Trailing slashes stripped, relative
 * components resolved.
 *
 * Returns null for invalid paths (outside MUSIC_ROOT, non-absolute,
 * etc.) — callers should reject or surface as an error.
 */
function normalisePath(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // path.resolve handles trailing slashes and '..' but doesn't enforce
  // an absolute root. We reject anything that isn't absolute up front.
  if (!trimmed.startsWith('/')) return null;
  const normalised = path.normalize(trimmed).replace(/\/+$/, '') || '/';
  // Confine to MUSIC_ROOT. The escape check is "must be MUSIC_ROOT or
  // a descendant of it" — startsWith(MUSIC_ROOT + '/') catches the
  // descendant case, the equality case catches MUSIC_ROOT itself.
  if (normalised !== MUSIC_ROOT && !normalised.startsWith(MUSIC_ROOT + '/')) {
    return null;
  }
  return normalised;
}

/**
 * True if `child` is `parent` or a descendant of `parent`. Used both for
 * scope membership testing (is this file's path covered?) and for
 * overlap detection during add.
 */
function isUnder(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent + '/');
}

/**
 * Read the current scope list from the database. Returns an array of
 * absolute paths. Self-seeds on first read after upgrade.
 *
 * The auto-seed logic: if the settings row is missing entirely, we
 * write LEGACY_DEFAULT (i.e., [/music]) so existing installs upgrading
 * to v30.9 don't see their library suddenly empty. If the row exists
 * but contains an empty array, we respect it — the user explicitly
 * cleared their scope.
 */
function getScope() {
  if (_cache !== null) return _cache;
  const database = db.get();
  const row = database.prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTINGS_KEY);
  if (!row) {
    // First read — seed with legacy default.
    setScope(LEGACY_DEFAULT);
    return _cache;
  }
  try {
    const parsed = JSON.parse(row.value);
    _cache = Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : [];
  } catch (e) {
    console.warn('library_scope: malformed JSON, treating as empty:', e.message);
    _cache = [];
  }
  return _cache;
}

/**
 * Write the scope list to the database, replacing any existing value.
 * No normalisation here — caller is responsible for cleaning the input.
 * (Because callers like addToScope/removeFromScope have already done
 * the work and we don't want to redo it on every write.)
 */
function setScope(list) {
  const database = db.get();
  const json = JSON.stringify(list || []);
  database.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTINGS_KEY, json);
  _cache = list.slice();
}

/**
 * Add a path to scope. Normalises the input, deduplicates, removes
 * redundant children. Returns the resulting scope list, or throws if
 * the input is invalid.
 *
 * If the path is already covered by an existing entry, this is a
 * no-op (returns the unchanged list). Returns metadata so callers can
 * distinguish add vs no-op vs replaced-children for UI feedback.
 */
function addToScope(rawPath) {
  const target = normalisePath(rawPath);
  if (!target) throw new Error('Invalid path');
  const current = getScope();
  // Already covered by an existing entry? No-op.
  for (const entry of current) {
    if (isUnder(target, entry)) {
      return { scope: current, status: 'already_covered', covering: entry };
    }
  }
  // Remove children of target that are now redundant.
  const survivors = current.filter(entry => !isUnder(entry, target));
  const removed = current.length - survivors.length;
  survivors.push(target);
  // Stable sort for predictable UI display
  survivors.sort();
  setScope(survivors);
  return { scope: survivors, status: 'added', supersededChildren: removed };
}

/**
 * Remove a path from scope. The path must match an entry exactly —
 * we don't auto-remove descendants, since the user may not realise
 * a deeper folder is in their scope.
 *
 * Returns the resulting scope list. If the path wasn't found, status
 * is 'not_found' but the list is returned unchanged (callers can
 * decide whether to treat that as an error).
 */
function removeFromScope(rawPath) {
  const target = normalisePath(rawPath);
  if (!target) throw new Error('Invalid path');
  const current = getScope();
  const survivors = current.filter(entry => entry !== target);
  if (survivors.length === current.length) {
    return { scope: current, status: 'not_found' };
  }
  setScope(survivors);
  return { scope: survivors, status: 'removed' };
}

/**
 * Decide whether a track file path falls under the active scope.
 * Used by the scanner on every file walk and every chokidar event.
 *
 * Cheap: linear scan of the scope list (which is typically tiny —
 * single digits in practice) doing a startsWith check on each.
 */
function isPathInScope(filePath) {
  if (!filePath) return false;
  const scope = getScope();
  for (const entry of scope) {
    if (isUnder(filePath, entry)) return true;
  }
  return false;
}

module.exports = {
  MUSIC_ROOT,
  getScope,
  setScope,
  addToScope,
  removeFromScope,
  isPathInScope,
  normalisePath,
};
