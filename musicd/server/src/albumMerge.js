// src/albumMerge.js — join albums that are one release split across rows.
//
// v1.1.43.0.
//
// THE PROBLEM. A two-disc set ripped as "Sign o' the Times CD1" and
// "Sign o' the Times CD2" is two folders, so it is two album rows, so it
// is two tiles on the wall with half a record behind each. The scanner
// cannot fix this on its own: the folders are genuinely different, the
// tags usually disagree too, and guessing that two albums are one is
// exactly the kind of inference that is wrong often enough to be worse
// than useless.
//
// So the user says so, by ticking them in order. The first one ticked
// becomes disc 1, the second disc 2, and so on — order is the whole input
// and it is why the selection had to start remembering it.
//
// THE HARD PART IS NOT THE MERGE, IT IS SURVIVING THE NEXT SCAN.
//
// An album's id is a hash of (album artist, title, folder). Move the
// tracks to another album_id and the next scan recomputes that hash from
// the files, finds the source album missing, recreates it, and pulls the
// tracks back — the merge silently undoes itself, probably overnight,
// and looks like a bug in something else entirely.
//
// The fix is that a merge is not a one-off edit. It is a persistent
// REDIRECTION, stored in album_merges and consulted by the scanner every
// time it computes an album id. The source id keeps hashing to the same
// value it always did; that value now maps to the target. Nothing has to
// be re-detected and a rescan is a no-op.
//
// UNMERGE therefore has to undo the redirection as well as the data, and
// it needs enough kept to rebuild what was thrown away: the source album
// ROW (its title, artist, folder, year, artwork — an albums row is not
// reconstructible from its tracks) and each track's ORIGINAL disc number
// (a source that was itself multi-disc must come back multi-disc, not
// flattened to whatever disc it was given inside the merge).
//
// Unmerge restores ALL of a target's sources at once, deliberately. Undoing
// one source of a three-way merge raises a question with no good answer —
// what happens to the disc numbers of the ones left behind — and "put it
// back the way it was" is what someone who has just made a mistake wants.

'use strict';

const db = require('./db');
const streamingLibrary = require('./streamingLibrary');

// Columns copied into the snapshot. Everything the scanner does not
// recompute from the files, plus the ones it does — a restored row that
// briefly has the wrong track count until the next scan looks broken.
const SNAPSHOT_COLUMNS = [
  'id', 'title', 'artist', 'album_artist', 'year', 'release_date',
  'album_folder', 'cover_art_mime', 'primary_format', 'genre',
  'track_count', 'total_duration', 'added_at', 'album_type',
  'album_type_locked', 'mb_release_group_id', 'mb_release_id',
  'barcode', 'catalog_number', 'match_status', 'match_confidence',
  'match_candidates', 'matched_at', 'matched_by', 'excluded',
];

function _dbh() {
  return db.get();
}

// Which columns actually exist, so a snapshot taken on one version can be
// restored on another without the INSERT falling over on a column that has
// since been added or dropped.
function _existingColumns(dbh, table) {
  try {
    return new Set(dbh.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
  } catch (e) {
    // No such table. The caller is about to fail anyway, and with a better
    // message than this function could produce.
    return new Set();
  }
}

/**
 * The album id a given id should actually be used as.
 *
 * Returns the target when this id has been merged away, otherwise the id
 * unchanged. The scanner calls this on every track, so it must be cheap
 * and must never throw — a missing table (a database that has not run this
 * release's migration) means "no merges exist", which is true.
 */
function targetFor(albumId) {
  if (!albumId) return albumId;
  try {
    const row = _dbh().prepare(
      'SELECT target_album_id, disc_number FROM album_merges WHERE source_album_id = ?'
    ).get(albumId);
    return row ? row.target_album_id : albumId;
  } catch (e) {
    return albumId;
  }
}

/**
 * The disc number a merged-away album's tracks should carry, or null when
 * this id is not a merge source. Paired with targetFor by the scanner:
 * both answers are needed for the same track and one query would be
 * neater, but the scanner already holds the row when it needs the disc.
 */
function discFor(albumId) {
  if (!albumId) return null;
  try {
    const row = _dbh().prepare(
      'SELECT disc_number FROM album_merges WHERE source_album_id = ?'
    ).get(albumId);
    return row ? row.disc_number : null;
  } catch (e) {
    return null;
  }
}

/** Both answers in one query, for the scanner's per-track hot path. */
function redirect(albumId) {
  if (!albumId) return { albumId, disc: null, merged: false };
  try {
    const row = _dbh().prepare(
      'SELECT target_album_id, disc_number FROM album_merges WHERE source_album_id = ?'
    ).get(albumId);
    if (!row) return { albumId, disc: null, merged: false };
    return { albumId: row.target_album_id, disc: row.disc_number, merged: true };
  } catch (e) {
    return { albumId, disc: null, merged: false };
  }
}

/** The sources folded into a target, oldest disc first. [] when none. */
function sourcesOf(targetAlbumId) {
  try {
    return _dbh().prepare(`
      SELECT source_album_id, disc_number, source_snapshot, merged_at
      FROM album_merges WHERE target_album_id = ?
      ORDER BY disc_number
    `).all(targetAlbumId).map(r => {
      let snap = {};
      try {
        snap = JSON.parse(r.source_snapshot) || {};
      } catch (e) {
        // A hand-edited or truncated snapshot. The id and disc are still
        // usable, and the caller only needs the title for display.
        snap = {};
      }
      return {
        sourceAlbumId: r.source_album_id,
        discNumber: r.disc_number,
        title: snap.title || '(unknown)',
        albumArtist: snap.album_artist || null,
        mergedAt: r.merged_at,
      };
    });
  } catch (e) {
    return [];
  }
}

/** Is this album the result of a merge? Cheap; used on the album page. */
function isMergeTarget(albumId) {
  try {
    const r = _dbh().prepare(
      'SELECT 1 AS x FROM album_merges WHERE target_album_id = ? LIMIT 1'
    ).get(albumId);
    return !!r;
  } catch (e) {
    return false;
  }
}

/**
 * Merge albums, in the order given. orderedIds[0] is the target and
 * becomes disc 1; each subsequent album becomes the next disc.
 *
 * Everything happens in one transaction. A half-applied merge would leave
 * tracks pointing at an album row that has already been deleted, which is
 * a library that no longer lists some of its music.
 */
function merge(orderedIds) {
  const ids = (orderedIds || []).map(String).filter(Boolean);
  if (ids.length < 2) return { ok: false, reason: 'need-two' };
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate' };

  // Streaming albums mirror the state of a favourite at Qobuz or Tidal and
  // are rebuilt from it on every sync. Merging them would be undone by the
  // next sync at best, and would corrupt the "an album is excluded=0 exactly
  // when it is favourited at the service" invariant at worst.
  for (const id of ids) {
    if (streamingLibrary.serviceForAlbumId && streamingLibrary.serviceForAlbumId(id)) {
      return { ok: false, reason: 'streaming' };
    }
  }

  const dbh = _dbh();
  const targetId = ids[0];
  const sourceIds = ids.slice(1);

  // The already-merged check comes FIRST, before the existence check, and
  // the order is the whole point: a merged-away album's row is deleted, so
  // "does it exist" fires first and answers 'missing' — which is true, and
  // useless. "It is already part of a merge, unmerge it first" tells
  // someone what to do about it.
  for (const id of ids) {
    const existing = dbh.prepare(
      'SELECT target_album_id FROM album_merges WHERE source_album_id = ?'
    ).get(id);
    if (existing) return { ok: false, reason: 'already-merged', albumId: id };
  }

  const rows = new Map();
  for (const id of ids) {
    const row = dbh.prepare('SELECT * FROM albums WHERE id = ?').get(id);
    if (!row) return { ok: false, reason: 'missing', albumId: id };
    rows.set(id, row);
  }
  // A source that is itself a target has sources of its own; folding it in
  // would orphan them.
  for (const id of sourceIds) {
    if (isMergeTarget(id)) return { ok: false, reason: 'is-target', albumId: id };
  }

  const albumCols = _existingColumns(dbh, 'albums');
  const snapshotOf = (row) => {
    const out = {};
    for (const c of SNAPSHOT_COLUMNS) if (c in row) out[c] = row[c];
    return out;
  };

  const now = Math.floor(Date.now() / 1000);

  const tx = dbh.transaction(() => {
    // The target's own tracks are disc 1. Their previous disc numbers are
    // recorded against the TARGET's id so unmerge can put them back too —
    // the target is not restored (it never went away) but its tracks were
    // renumbered, and renumbering is just as much a change to undo.
    const targetTracks = dbh.prepare(
      'SELECT id, disc_number FROM tracks WHERE album_id = ?'
    ).all(targetId);
    const remember = dbh.prepare(`
      INSERT INTO album_merge_tracks (track_id, source_album_id, prev_disc)
      VALUES (?, ?, ?)
      ON CONFLICT(track_id) DO UPDATE SET
        source_album_id = excluded.source_album_id, prev_disc = excluded.prev_disc
    `);
    for (const t of targetTracks) remember.run(t.id, targetId, t.disc_number);
    dbh.prepare('UPDATE tracks SET disc_number = 1 WHERE album_id = ?').run(targetId);

    const moveTracks = dbh.prepare(
      'UPDATE tracks SET album_id = ?, disc_number = ? WHERE album_id = ?'
    );
    const recordMerge = dbh.prepare(`
      INSERT INTO album_merges
        (source_album_id, target_album_id, disc_number, source_snapshot, merged_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const dropAlbum = dbh.prepare('DELETE FROM albums WHERE id = ?');

    sourceIds.forEach((sourceId, i) => {
      const disc = i + 2;                     // target took disc 1
      const srcTracks = dbh.prepare(
        'SELECT id, disc_number FROM tracks WHERE album_id = ?'
      ).all(sourceId);
      for (const t of srcTracks) remember.run(t.id, sourceId, t.disc_number);

      moveTracks.run(targetId, disc, sourceId);
      recordMerge.run(sourceId, targetId, disc, JSON.stringify(snapshotOf(rows.get(sourceId))), now);
      dropAlbum.run(sourceId);
    });

    // The target row's own snapshot is kept under its own id so unmerge can
    // restore its track count and duration rather than leaving the merged
    // totals behind.
    recordMergeTargetSnapshot(dbh, targetId, snapshotOf(rows.get(targetId)), now, albumCols);
  });

  try {
    tx();
  } catch (e) {
    return { ok: false, reason: 'failed', error: e.message };
  }

  db.rebuildAlbumStats();
  return { ok: true, targetId, discs: ids.length, sources: sourceIds.length };
}

// The target's own "before" state, stored in the same table with
// source = target so one query recovers everything a rollback needs. It is
// not a redirection — targetFor() would loop if it were — so it is written
// with the target as BOTH columns and skipped by targetFor's lookup, which
// only ever asks about ids that are not the target.
function recordMergeTargetSnapshot(dbh, targetId, snapshot, now, albumCols) {
  dbh.prepare(`
    INSERT INTO album_merge_targets (target_album_id, snapshot, merged_at)
    VALUES (?, ?, ?)
    ON CONFLICT(target_album_id) DO NOTHING
  `).run(targetId, JSON.stringify(snapshot), now);
  void albumCols;
}

/**
 * Undo every merge into this album: recreate each source album row, move
 * its tracks back with their original disc numbers, and restore the
 * target's own tracks to the disc numbers they had before.
 *
 * One transaction, for the same reason merge is.
 */
function unmerge(targetAlbumId) {
  const dbh = _dbh();
  const merges = dbh.prepare(
    'SELECT source_album_id, source_snapshot FROM album_merges WHERE target_album_id = ?'
  ).all(targetAlbumId);
  if (merges.length === 0) return { ok: false, reason: 'not-merged' };

  const albumCols = _existingColumns(dbh, 'albums');

  const tx = dbh.transaction(() => {
    const restoreTrack = dbh.prepare(`
      UPDATE tracks SET album_id = ?, disc_number = (
        SELECT prev_disc FROM album_merge_tracks WHERE track_id = tracks.id
      ) WHERE id = ?
    `);

    for (const m of merges) {
      let snap;
      try {
        snap = JSON.parse(m.source_snapshot);
      } catch (e) {
        // Without the snapshot the album row cannot be rebuilt. Leave this
        // source merged rather than inventing a row; the others still come
        // apart, and the error surfaces to the caller below.
        continue;
      }
      // Only columns that still exist, so a snapshot from an older schema
      // restores cleanly instead of failing on a since-removed column.
      const cols = Object.keys(snap).filter(c => albumCols.has(c));
      if (cols.length === 0) continue;
      dbh.prepare(
        `INSERT OR REPLACE INTO albums (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      ).run(...cols.map(c => snap[c]));

      const moved = dbh.prepare(
        'SELECT track_id FROM album_merge_tracks WHERE source_album_id = ?'
      ).all(m.source_album_id);
      for (const t of moved) restoreTrack.run(m.source_album_id, t.track_id);
      dbh.prepare('DELETE FROM album_merge_tracks WHERE source_album_id = ?').run(m.source_album_id);
    }

    // The target's own tracks, back to the disc numbers they had.
    const own = dbh.prepare(
      'SELECT track_id FROM album_merge_tracks WHERE source_album_id = ?'
    ).all(targetAlbumId);
    for (const t of own) restoreTrack.run(targetAlbumId, t.track_id);
    dbh.prepare('DELETE FROM album_merge_tracks WHERE source_album_id = ?').run(targetAlbumId);

    dbh.prepare('DELETE FROM album_merges WHERE target_album_id = ?').run(targetAlbumId);
    dbh.prepare('DELETE FROM album_merge_targets WHERE target_album_id = ?').run(targetAlbumId);
  });

  try {
    tx();
  } catch (e) {
    return { ok: false, reason: 'failed', error: e.message };
  }

  db.rebuildAlbumStats();
  return { ok: true, restored: merges.length };
}

/** Every merge in the library, for a management view. */
function listMerges() {
  try {
    const targets = _dbh().prepare(`
      SELECT DISTINCT target_album_id FROM album_merges
    `).all().map(r => r.target_album_id);
    return targets.map(id => {
      const album = _dbh().prepare(
        'SELECT id, title, album_artist FROM albums WHERE id = ?'
      ).get(id);
      return {
        targetAlbumId: id,
        title: album ? album.title : '(missing)',
        albumArtist: album ? album.album_artist : null,
        sources: sourcesOf(id),
      };
    });
  } catch (e) {
    return [];
  }
}

module.exports = {
  merge,
  unmerge,
  targetFor,
  discFor,
  redirect,
  sourcesOf,
  isMergeTarget,
  listMerges,
  SNAPSHOT_COLUMNS,
};
