// src/albumVersions.js — one album, several versions.
//
// v1.1.34.0. A library that has the original, the deluxe and the
// remaster of one record has three tiles for one album. This collapses
// them: one tile, with the others reachable from its page — the way
// Roon does it — behind a toggle in Settings → Library.
//
// TWO HALVES.
//
// The KEY (albums.version_key) says which rows belong together. It is
// computed by src/albumIdentity.js, the same module the MusicBrainz
// matcher normalises with — deliberately, because if the two disagreed
// then three copies could match one release group and still refuse to
// group, which looks exactly like this feature being broken.
//
// The PRIMARY is which of them the collapsed tile shows and plays. Best
// quality wins: bit depth, then sample rate, then track count, then a
// stable id tie-break so the choice never flickers between requests.
// The user asked for best quality; the ordering is expressed once, in
// PRIMARY_ORDER_SQL, and every query that needs it uses that constant
// rather than restating it.
//
// GROUPING IS A VIEW, NOT A MIGRATION. No rows are merged, moved or
// deleted. Turning the toggle off returns the library to exactly what
// it was, because nothing was ever changed — only queried differently.
// That matters: a "deduplicate" that edits the database is one bad
// heuristic away from losing a record the user actually wanted.

'use strict';

const db = require('./db');
const identity = require('./albumIdentity');
const log = require('./serviceLog').forModule('versions');

// Which version represents the group. Best quality first, then the most
// complete, then oldest-added as a stable tie-break so two identical
// rips do not swap places between page loads.
const PRIMARY_ORDER_SQL = `
  COALESCE(primary_bit_depth, 0)   DESC,
  COALESCE(primary_sample_rate, 0) DESC,
  COALESCE(track_count, 0)         DESC,
  COALESCE(added_at, 0)            ASC,
  id                               ASC`;

// ---------------------------------------------------------------------------
// Maintaining the key
// ---------------------------------------------------------------------------

// Recompute version_key for every album, or only those missing one.
// Cheap: one pass, one prepared UPDATE, all inside a transaction.
//
// Called after a scan (titles and artists can change) and after a
// matcher run (an album that gains an MBID moves from a title-based key
// to a release-group one, and must land in the same group as its
// siblings). Idempotent.
function rebuildVersionKeys({ onlyMissing = false } = {}) {
  const dbh = db.get();
  const where = onlyMissing ? 'WHERE version_key IS NULL' : '';
  const rows = dbh.prepare(`
    SELECT id, title, album_artist, album_folder, mb_release_group_id, version_key
    FROM albums ${where}
  `).all();

  const upd = dbh.prepare('UPDATE albums SET version_key = ? WHERE id = ?');
  let changed = 0;
  const tx = dbh.transaction(() => {
    for (const row of rows) {
      const key = identity.versionKeyFor(row, dbh);
      if (key !== row.version_key) {
        upd.run(key, row.id);
        changed += 1;
      }
    }
  });
  tx();
  if (changed > 0) log.info(`rebuilt version keys: ${changed} album(s) changed`);
  return { scanned: rows.length, changed };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isEnabled() {
  const settings = require('./settings');
  return settings.getBool('library_group_versions', false);
}

// The SQL that collapses a group to its primary row.
//
// Returns a fragment to be used as `AND albums.id IN (<this>)`, which is
// how it composes with the album list route's existing focus filters,
// tag filters and sort without any of them being rewritten. A window
// function picking rn = 1 would have to wrap that whole query; an IN
// clause slots into it.
//
// Albums with a NULL version_key are always included: no key means we
// could not identify the album, and an unidentifiable album must not be
// silently hidden behind some other row.
const PRIMARY_IDS_SQL = `
  SELECT id FROM albums WHERE version_key IS NULL
  UNION ALL
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY version_key
      ORDER BY ${PRIMARY_ORDER_SQL}
    ) AS rn
    FROM albums
    WHERE version_key IS NOT NULL AND excluded = 0
  ) WHERE rn = 1`;

// How many versions each visible album stands for. Read as a map rather
// than joined into the list query, because the list query is already
// carrying focus, tags and sort, and a correlated subquery per row on a
// 50,000-album library is the kind of thing that turns a 30 ms page into
// a 3 s one.
//
// Only counts albums that are IN the library (excluded = 0), so a Qobuz
// album you have merely browsed does not inflate the count on a local
// album it happens to share a title with.
function versionCounts(ids) {
  if (!ids || ids.length === 0) return {};
  const dbh = db.get();
  const placeholders = ids.map(() => '?').join(',');
  const rows = dbh.prepare(`
    SELECT a.id AS id, (
      SELECT COUNT(*) FROM albums b
      WHERE b.version_key = a.version_key AND b.excluded = 0
    ) AS n
    FROM albums a
    WHERE a.id IN (${placeholders}) AND a.version_key IS NOT NULL
  `).all(...ids);
  const out = {};
  for (const r of rows) if (r.n > 1) out[r.id] = r.n;
  return out;
}

// Every version of the album `albumId` belongs to, best first. Used by
// the album page's version list. Always returns at least the album
// itself, so the caller never has to special-case "no versions".
function versionsOf(albumId) {
  const dbh = db.get();
  const row = dbh.prepare(
    'SELECT id, version_key FROM albums WHERE id = ?'
  ).get(albumId);
  if (!row) return [];
  if (!row.version_key) {
    return dbh.prepare(`
      SELECT id, title, album_artist, year, release_date, track_count, total_duration,
             primary_format, primary_bit_depth, primary_sample_rate,
             COALESCE(is_favorite, 0) AS is_favorite,
             CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END AS has_art,
             CASE WHEN id LIKE 'qobuz:%' THEN 'qobuz'
                  WHEN id LIKE 'tidal:%' THEN 'tidal' ELSE NULL END AS service
      FROM albums WHERE id = ?
    `).all(albumId);
  }
  return dbh.prepare(`
    SELECT id, title, album_artist, year, release_date, track_count, total_duration,
           primary_format, primary_bit_depth, primary_sample_rate,
           COALESCE(is_favorite, 0) AS is_favorite,
           CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END AS has_art,
           CASE WHEN id LIKE 'qobuz:%' THEN 'qobuz'
                WHEN id LIKE 'tidal:%' THEN 'tidal' ELSE NULL END AS service
    FROM albums
    WHERE version_key = ? AND excluded = 0
    ORDER BY ${PRIMARY_ORDER_SQL}
  `).all(row.version_key);
}

module.exports = {
  PRIMARY_ORDER_SQL,
  PRIMARY_IDS_SQL,
  rebuildVersionKeys,
  isEnabled,
  versionCounts,
  versionsOf,
};
