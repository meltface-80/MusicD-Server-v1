const Database = require('better-sqlite3');
const path = require('path');
const librarySort = require('./librarySort');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/musicd.db');
let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  db.pragma('foreign_keys = ON');

  // The album grid's Random sort orders by a seeded hash so the shuffle holds
  // still while the grid pages through it. SQLite has no hash builtin, so the
  // function is registered on the connection here. Without it the random sort
  // fails with "no such function: musicd_shuffle" rather than degrading, which
  // is the right way round — a silently unshuffled wall would look like a bug
  // in the sort itself.
  librarySort.registerSqlFunctions(db);

  // Drop legacy tables (clean removal of features cut from earlier versions)
  try { db.exec('DROP TABLE IF EXISTS peq_profiles'); } catch (e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      filename TEXT,
      title TEXT,
      artist TEXT,
      album_artist TEXT,
      album TEXT,
      year INTEGER,
      track_number INTEGER,
      disc_number INTEGER,
      duration REAL,
      bitrate INTEGER,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channels INTEGER,
      format TEXT,
      codec TEXT,
      file_size INTEGER,
      genre TEXT,
      added_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      album_artist TEXT,
      year INTEGER,
      cover_art BLOB,
      cover_art_mime TEXT,
      track_count INTEGER DEFAULT 0,
      total_duration REAL DEFAULT 0,
      primary_format TEXT,
      genre TEXT,
      added_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      added_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album, album_artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album_artist);
    CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(album_artist);
    CREATE INDEX IF NOT EXISTS idx_albums_genre ON albums(genre);
    CREATE INDEX IF NOT EXISTS idx_albums_added ON albums(added_at DESC);
    CREATE INDEX IF NOT EXISTS idx_albums_year ON albums(year);

    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
      title, artist, album, content=tracks, content_rowid=rowid,
      tokenize='unicode61'
    );

    -- Per-track loudness data (track + album ReplayGain)
    CREATE TABLE IF NOT EXISTS track_loudness (
      track_id              TEXT PRIMARY KEY,
      integrated_lufs       REAL,
      true_peak             REAL,
      album_integrated_lufs REAL,
      album_peak            REAL,
      lra                   REAL,
      analysed_at           INTEGER,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    -- App settings as key/value
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Per-renderer settings
    CREATE TABLE IF NOT EXISTS renderer_settings (
      renderer_id TEXT PRIMARY KEY,
      last_used_at INTEGER
    );

    -- Scrobble queue (#30.25). Failed scrobbles persisted here so a
    -- network blip during playback doesn't lose listening history.
    -- Retried in batches every minute by scrobbler.js. attempts is
    -- incremented on each failed flush; rows exceeding the retry cap
    -- get dropped to prevent unbounded growth.
    CREATE TABLE IF NOT EXISTS scrobble_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      artist       TEXT NOT NULL,
      album        TEXT,
      track        TEXT NOT NULL,
      album_artist TEXT,
      duration     INTEGER,
      played_at    INTEGER NOT NULL,
      attempts     INTEGER DEFAULT 0
    );

    -- Cached album bios (#30.23). Filled lazily when the user opens
    -- an album with a known MBID. Source is whichever provider gave
    -- us prose (wikipedia, lastfm, mb-annotation, audiodb). A row
    -- with fetch_status='no_match' means we tried all sources and
    -- got nothing -- don't keep trying. fetch_status='error' means
    -- a transient failure; we'll retry on next view.
    CREATE TABLE IF NOT EXISTS album_bio (
      album_id     TEXT PRIMARY KEY,
      source       TEXT,
      source_url   TEXT,
      content      TEXT,
      fetched_at   INTEGER,
      fetch_status TEXT,
      FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
    );

    -- Cached artist bios (#30.23). Keyed by artist name because that's
    -- how the artists table is keyed -- we don't have synthetic ids.
    --
    -- Limitation: tag inconsistencies ("The Beatles" vs "Beatles")
    -- produce separate cache rows, and if a name's mb_artist_id
    -- changes (e.g., re-run of artist logos), the cached bio could
    -- become wrong. Migrating to MBID-keyed storage would require
    -- changes to the artists table itself; tracked for a later
    -- release. For now: clear the row manually if you suspect drift.
    CREATE TABLE IF NOT EXISTS artist_bio (
      artist_name  TEXT PRIMARY KEY,
      source       TEXT,
      source_url   TEXT,
      content      TEXT,
      fetched_at   INTEGER,
      fetch_status TEXT
    );

    -- Multi-zone group memberships
    CREATE TABLE IF NOT EXISTS renderer_groups (
      group_id TEXT NOT NULL,
      renderer_id TEXT NOT NULL,
      protocol TEXT NOT NULL,
      PRIMARY KEY (group_id, renderer_id)
    );

    -- Per-track play history. Logged when a track starts on a renderer
    -- (see playerState.playTrackOnZone). We store track_id rather than a
    -- foreign key so deleted tracks don't break the history; the join in the
    -- /recent endpoint filters out rows whose track no longer exists.
    -- album_title/album_artist are denormalised so the Home → Recently Played
    -- list can group by album cheaply without re-joining via tracks.
    CREATE TABLE IF NOT EXISTS play_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id      TEXT NOT NULL,
      album_title   TEXT,
      album_artist  TEXT,
      played_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_play_history_album ON play_history(album_title, album_artist);

    -- v1.1.0.82 — Saved focus combinations. Each row is a named
    -- bundle of Focus picks the user wants to recall later. The
    -- picks are stored as a JSON blob (whatever the
    -- useFocusState() hook serialises) rather than normalised into
    -- per-section join tables — picks are read together, written
    -- together, and never queried against. JSON is the right
    -- shape.
    --
    -- name is unique per server (single-user assumption holds for
    -- now). Hard-cap of 20 rows enforced at the route layer; the
    -- DB schema doesn't need to know about it.
    --
    -- v1.1.25.0 — NOTHING READS THIS ANY MORE. The Focus library screen and
    -- the /api/library/focus/saved routes are gone; a focus combination worth
    -- keeping is a tag. The table stays because dropping it would destroy
    -- whatever anyone had saved and gain a schema line, and because an install
    -- that rolls back to an earlier version would find its rows still there.
    -- Do not add reads or writes to it: it is a tombstone, not an API.
    CREATE TABLE IF NOT EXISTS saved_focuses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      picks_json  TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Per-renderer DSP profile (#29.0).
    -- Each renderer can have its own EQ chain, convolution IRs, crossfeed.
    -- Sonos renderers will have rows but the stream endpoint refuses to
    -- apply DSP for them — the rows are still stored so if a user moves
    -- from Sonos to a UPnP/Squeezelite renderer the settings are remembered.
    --   peq_filters       JSON array of {type:'PK'|'LSC'|'HSC', fc, q, gain}
    --   peq_preamp_db     auto-calculated negative gain on save (clip prevention)
    --   conv_irs          JSON map { '44100': 'filename.wav', '48000': ... }
    --   crossfeed_profile 'cmoy' | 'meier' | 'jmeier' | NULL
    --   autoeq_model      last AutoEQ preset loaded (display only — actual
    --                     filters live in peq_filters)
    --
    -- Legacy columns (#29.6 — kept for backwards compatibility but no
    -- longer read or written by application code):
    --   headroom_enabled, headroom_db    — replaced by auto-preamp
    --   clipping_indicator              — predicted-clipping indicator removed
    CREATE TABLE IF NOT EXISTS renderer_dsp (
      renderer_id        TEXT PRIMARY KEY,
      master_enabled     INTEGER DEFAULT 1,
      peq_enabled        INTEGER DEFAULT 0,
      peq_filters        TEXT,
      peq_preamp_db      REAL DEFAULT 0,
      headroom_enabled   INTEGER DEFAULT 0,   -- legacy (#29.6)
      headroom_db        REAL DEFAULT 0,      -- legacy (#29.6)
      clipping_indicator INTEGER DEFAULT 0,   -- legacy (#29.6)
      conv_enabled       INTEGER DEFAULT 0,
      conv_irs           TEXT,
      conv_dry_db        REAL DEFAULT -120,
      conv_wet_db        REAL DEFAULT 0,
      crossfeed_enabled  INTEGER DEFAULT 0,
      crossfeed_profile  TEXT,
      autoeq_model       TEXT,
      updated_at         INTEGER DEFAULT (unixepoch())
    );

    -- Saved DSP profiles per renderer (#29.3).
    -- The renderer_dsp row above is the LIVE state — what the stream pipeline
    -- reads on every track. dsp_profiles holds named SNAPSHOTS that the user
    -- can save, switch between, and delete. Applying a profile = copy the
    -- payload back into renderer_dsp.
    --
    -- payload is the same JSON shape as renderer_dsp minus renderer_id +
    -- updated_at. We don't break out columns because the field set is
    -- liable to grow over future v29.x releases and a JSON blob keeps the
    -- migration story trivial.
    --
    -- (renderer_id, name) is unique so users can't accidentally create two
    -- profiles with the same name on one renderer.
    CREATE TABLE IF NOT EXISTS dsp_profiles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      renderer_id  TEXT NOT NULL,
      name         TEXT NOT NULL,
      payload      TEXT NOT NULL,
      is_active    INTEGER DEFAULT 0,
      created_at   INTEGER DEFAULT (unixepoch()),
      updated_at   INTEGER DEFAULT (unixepoch()),
      UNIQUE (renderer_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_dsp_profiles_renderer ON dsp_profiles(renderer_id);

    -- Music news cache (#30).
    -- Periodically populated from configured RSS feeds (Pitchfork only for
    -- v30; structure leaves room to add more sources). Items are deduped
    -- by URL — the URL is the canonical identity of an article. We hash it
    -- for the primary key to keep joins/lookups fast and to side-step
    -- length-related index issues if a feed produces unusually long URLs.
    --
    --   id           SHA-1 hex of url, truncated to 40 chars
    --   source       'pitchfork' | future sources
    --   section      'News' | 'Album Reviews' | 'The Pitch' | etc — the
    --                feed-specific category badge to show on the card
    --   title        article title (plain text, decoded)
    --   excerpt      first ~200 chars of description, HTML-stripped
    --   url          canonical article URL
    --   image_url    thumbnail/hero image, or null if none in the feed
    --   published_at unix seconds — pubDate from the RSS item
    --   fetched_at   unix seconds — when WE last saw it (for cleanup)
    --   kind         'article' (Pitchfork RSS, default) or 'release' (Qobuz
    --                album mention) — drives the client's two-row layout
    --                (#30.1)
    --   artist       artist name for release cards; null for articles (#30.1)
    CREATE TABLE IF NOT EXISTS news_items (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL,
      section       TEXT,
      title         TEXT NOT NULL,
      excerpt       TEXT,
      url           TEXT NOT NULL UNIQUE,
      image_url     TEXT,
      published_at  INTEGER NOT NULL,
      fetched_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      kind          TEXT DEFAULT 'article',
      artist        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_source    ON news_items(source);
    -- NOTE: idx_news_kind is created LATER, after the kind column migration
    -- has run. Putting it here breaks v30 → v30.1+ upgrades because the
    -- column doesn't exist on a v30 database when this exec block runs,
    -- and CREATE INDEX on a missing column throws and aborts the rest of
    -- the block.
  `);

  // Migrate v30 → v30.2: add kind + artist columns to existing news_items
  // tables. v30.1 attempted this with safeAddColumn but the ALTER was
  // failing silently (likely the NOT NULL clause — SQLite is fussy about
  // adding NOT NULL columns to non-empty tables in some edge cases). For
  // 30.2 we drop NOT NULL (we always populate kind from JS anyway, and the
  // DEFAULT 'article' takes care of any odd row that slips through) AND
  // log the ALTER attempt loudly so any future failures are visible.
  try {
    const cols = db.prepare(`PRAGMA table_info(news_items)`).all();
    const have = new Set(cols.map(c => c.name));
    if (!have.has('kind')) {
      console.log(`[db] migrating news_items: adding kind column`);
      db.exec(`ALTER TABLE news_items ADD COLUMN kind TEXT DEFAULT 'article'`);
      // Backfill: make any pre-existing rows explicit. The DEFAULT applies
      // only on INSERT; for already-present rows we set the value here.
      db.exec(`UPDATE news_items SET kind = 'article' WHERE kind IS NULL`);
    }
    if (!have.has('artist')) {
      console.log(`[db] migrating news_items: adding artist column`);
      db.exec(`ALTER TABLE news_items ADD COLUMN artist TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_news_kind ON news_items(kind)`);
  } catch (e) {
    // Log loudly. If this throws, listItems will fail with no-such-column
    // on the next request and we want to know WHY.
    console.error(`[db] news_items migration FAILED:`, e.message);
  }

  // FTS triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
      INSERT INTO tracks_fts(rowid, title, artist, album) VALUES (new.rowid, new.title, new.artist, new.album);
    END;
    CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album) VALUES ('delete', old.rowid, old.title, old.artist, old.album);
    END;
    CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album) VALUES ('delete', old.rowid, old.title, old.artist, old.album);
      INSERT INTO tracks_fts(rowid, title, artist, album) VALUES (new.rowid, new.title, new.artist, new.album);
    END;
  `);

  // Library scope (#30.9). When the user picks specific subfolders to scan
  // rather than the whole /music root, tracks/albums outside the scope are
  // soft-deleted rather than hard-deleted. The `excluded` flag drives this:
  // every library query filters WHERE excluded = 0, so excluded rows are
  // invisible in the UI but their metadata, favourites, and play counts
  // are preserved for instant restoration on re-include.
  //
  // Default is 0 (active). Migration: existing v30.8 installs already have
  // all-active rows, so the default just keeps them all visible. New
  // installs that explicitly remove a folder get rows flipped to 1.
  safeAddColumn('tracks', 'excluded', 'INTEGER DEFAULT 0');
  safeAddColumn('albums', 'excluded', 'INTEGER DEFAULT 0');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_excluded ON tracks(excluded) WHERE excluded = 1'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_albums_excluded ON albums(excluded) WHERE excluded = 1'); } catch (e) {}

  // Migrations for older DBs
  safeAddColumn('tracks', 'genre', 'TEXT');
  safeAddColumn('tracks', 'added_at', 'INTEGER DEFAULT 0');
  safeAddColumn('albums', 'track_count', 'INTEGER DEFAULT 0');
  safeAddColumn('albums', 'total_duration', 'REAL DEFAULT 0');
  safeAddColumn('albums', 'primary_format', 'TEXT');
  // v1.1.0.81 — denormalised audio-quality summary per album, mirroring
  // the primary_format pattern. Populated by rebuildAlbumStats from a
  // representative track (first by track number/title, same logic
  // primary_format uses). Used by the Focus filter (Bit depth, Sample
  // rate, Channel layout sub-sections) to avoid a per-row JOIN with
  // tracks on every album list query. NULL until the v81 boot
  // migration runs; the migration calls rebuildAlbumStats once when
  // it sees these columns are unpopulated. Stays in sync afterwards
  // because the scanner runs rebuildAlbumStats at the end of every
  // scan that adds or updates anything.
  //
  // Trade-off: an album with mixed-rate tracks (e.g. one 24/96
  // bonus track on an otherwise 16/44.1 album) gets categorised by
  // its first-track values, not by majority-vote. Same caveat
  // already applies to primary_format. If this becomes a real
  // problem we can switch to mode-based aggregation in a follow-up
  // without breaking the filter API.
  safeAddColumn('albums', 'primary_bit_depth',   'INTEGER');
  safeAddColumn('albums', 'primary_sample_rate', 'INTEGER');
  safeAddColumn('albums', 'primary_channels',    'INTEGER');
  safeAddColumn('albums', 'genre', 'TEXT');
  safeAddColumn('albums', 'added_at', 'INTEGER DEFAULT 0');
  // v1.1.0.91 — full release date (TEXT in YYYY-MM-DD format). Stored
  // alongside `year` for backwards-compat. Existing albums will have
  // NULL here until rescanned. Most tag schemes store a full date in
  // a DATE / RELEASEDATE / DATE / ORIGINALDATE field; the scanner
  // picks the best of those and writes the canonical YYYY-MM-DD form.
  // Display layer falls back to year if release_date is null.
  safeAddColumn('albums', 'release_date', 'TEXT');
  safeAddColumn('tracks', 'release_date', 'TEXT');

  // v1.1.0.92 — Album versioning by folder.
  //
  // The same album name in two different folders (e.g. Kind of Blue
  // 16/44.1 vs Kind of Blue 24/192 sitting in separate dirs) becomes
  // two album entities so each shows once and tracks don't appear
  // duplicated. The album folder is the parent directory of the
  // tracks (or the parent of CD1/CD2 dirs for multi-disc releases —
  // see albumFolderFor() in scanner.js).
  //
  // - albums.album_folder: the canonical album folder path. NULL on
  //   migration; populated on next scan. Two album rows can share
  //   title+artist if their folders differ.
  // - tracks.album_id: the album row this track belongs to. Lets
  //   queries do a clean JOIN instead of resolving by title+artist
  //   (which collides on dual-version libraries). NULL on migration;
  //   populated on next scan.
  // - tracks.album_folder: redundant copy of the album folder for
  //   the small number of read paths that don't need a JOIN. Saves
  //   the JOIN when listing tracks by album.
  safeAddColumn('albums', 'album_folder', 'TEXT');
  safeAddColumn('tracks', 'album_id', 'TEXT');
  safeAddColumn('tracks', 'album_folder', 'TEXT');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_albums_folder ON albums(album_folder)'); } catch (e) {}

  // v1.1.0.97 — album_type. One of:
  //   'main'        Full-length studio album (default)
  //   'ep'          Extended play (4-7 tracks, <30 min)
  //   'single'      1-3 tracks
  //   'soundtrack'  OST / soundtrack / score
  //   'deluxe'      Deluxe edition / bonus-tracks edition
  //   'limited'     Limited edition / special pressing
  //
  // Derived in priority order:
  //   1. MusicBrainz release-group secondary types (when matched)
  //   2. Title patterns ('(Deluxe Edition)', 'OST', 'Soundtrack', etc.)
  //   3. Folder name patterns
  //   4. Track count + duration heuristics
  //
  // NULL until next scan computes it. Stored as a single TEXT column
  // because albums have a single primary type — the taxonomy is
  // mutually exclusive in practice (a deluxe edition of a soundtrack
  // is rare enough that we'd rather pick 'soundtrack' as primary
  // than introduce a multi-tag column).
  safeAddColumn('albums', 'album_type', 'TEXT');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_albums_type ON albums(album_type)'); } catch (e) {}

  // v1.1.0.98 — album_type_locked: when set to 1, the user has
  // manually overridden the auto-detected type and recomputeAlbumTypes
  // must not clobber it. Set by POST /albums/:id/type. Cleared by
  // POST /albums/:id/type with body {auto: true} which also re-runs
  // the classifier inline so the user sees the auto value.
  safeAddColumn('albums', 'album_type_locked', 'INTEGER DEFAULT 0');

  // Favourited albums — set 1 when a user taps the heart on the album page.
  safeAddColumn('albums', 'is_favorite', 'INTEGER DEFAULT 0');
  safeAddColumn('albums', 'favorited_at', 'INTEGER');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_albums_favorite ON albums(is_favorite) WHERE is_favorite = 1'); } catch (e) {}

  // v1.1.0.58 — track-level favourites and user ratings. Tracks now
  // carry their own is_favorite (boolean) and user_rating (0-5 stars,
  // 0 means unrated). Independent of the album's favourite flag — a
  // user can favourite a single track from an album they don't
  // otherwise favourite. Ratings use whole stars; if half-stars are
  // wanted later the column can store 0-10 instead and the UI can
  // re-interpret without a schema change.
  safeAddColumn('tracks', 'is_favorite', 'INTEGER DEFAULT 0');
  safeAddColumn('tracks', 'favorited_at', 'INTEGER');
  safeAddColumn('tracks', 'user_rating', 'INTEGER DEFAULT 0');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_favorite ON tracks(is_favorite) WHERE is_favorite = 1'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_rating ON tracks(user_rating) WHERE user_rating > 0'); } catch (e) {}

  // v1.1.0.67 — Save for later. A built-in single-flag tag for
  // "come back to this." Conceptually equivalent to a special-cased
  // tag named "Saved" but kept as a column for two reasons:
  // (1) the UI surfaces it as a primary action separate from arbitrary
  //     user tags (it's the pinned bookmark icon, not a label), and
  // (2) the partial index pattern from is_favorite gives us a fast
  //     "show everything saved" lookup without a join.
  // Mirrors the favorites schema exactly.
  safeAddColumn('albums', 'is_saved_for_later', 'INTEGER DEFAULT 0');
  safeAddColumn('albums', 'saved_for_later_at', 'INTEGER');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_albums_saved ON albums(is_saved_for_later) WHERE is_saved_for_later = 1'); } catch (e) {}
  safeAddColumn('tracks', 'is_saved_for_later', 'INTEGER DEFAULT 0');
  safeAddColumn('tracks', 'saved_for_later_at', 'INTEGER');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_saved ON tracks(is_saved_for_later) WHERE is_saved_for_later = 1'); } catch (e) {}

  // v1.1.0.67 — User-defined tags. Many-to-many between tags and
  // (albums | tracks). Names are stored case-insensitively unique
  // (we lowercase on insert; display preserves the user's chosen
  // casing in the `name` column). Optional colour hex for the chip
  // (null = use the default --jp-text-2 fill). created_at is unix-ms
  // for sorting "recently created tags first" in the picker.
  //
  // The two link tables (album_tags, track_tags) carry no extra
  // metadata — just the pair. ON DELETE CASCADE handles tag deletion
  // and album/track scanner removals cleanly.
  // ── Playlists (v1.1.19.0) ──────────────────────────────────────────
  //
  // The "Add to Playlist" row has sat disabled in the track menu since v57
  // with a "v60" badge on it. This is the backing store it was waiting for.
  //
  // Track membership is keyed (playlist_id, track_id), so a track appears in
  // a playlist at most once and "add to playlist" is idempotent — tapping it
  // twice from a menu does not silently duplicate the row. The cost is that a
  // playlist cannot deliberately repeat a track; that is the rarer want, and
  // the menu action is the common one.
  //
  // `position` keeps the user's order independent of insertion time so the
  // list can be reordered later without rewriting added_at.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS playlists (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL,
        track_id    TEXT NOT NULL,
        position    INTEGER NOT NULL,
        added_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id)    REFERENCES tracks(id)    ON DELETE CASCADE
      )
    `);
    // Ordering a playlist's own rows, and finding which playlists hold a
    // track (used to tick the ones it is already in).
    db.exec('CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pos ON playlist_tracks(playlist_id, position)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id)');
  } catch (e) { console.error('[db] playlists create:', e.message); }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      )
    `);
  } catch (e) { console.error('[db] tags table create:', e.message); }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS album_tags (
        album_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        added_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
        PRIMARY KEY (album_id, tag_id),
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_album_tags_tag ON album_tags(tag_id)');
  } catch (e) { console.error('[db] album_tags create:', e.message); }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS track_tags (
        track_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        added_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
        PRIMARY KEY (track_id, tag_id),
        FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_track_tags_tag ON track_tags(tag_id)');
  } catch (e) { console.error('[db] track_tags create:', e.message); }

  // Artist logo / image enrichment columns
  safeAddColumn('artists', 'logo', 'BLOB');
  safeAddColumn('artists', 'logo_mime', 'TEXT');
  safeAddColumn('artists', 'logo_source', 'TEXT');   // 'fanart' | 'audiodb' | 'manual' | 'typographic'
  // mb_artist_id caches the MusicBrainz artist UUID resolved during a logo
  // fetch. Without this column, every artist's MBID has to be re-resolved
  // from MusicBrainz on every fetch run — and MB rate-limits us to 1 req/s.
  // (#30.7 — was previously dropped in a cleanup pass that didn't notice
  // artistLogos.js still depended on it.)
  safeAddColumn('artists', 'mb_artist_id', 'TEXT');
  safeAddColumn('artists', 'logo_fetched_at', 'INTEGER');

  // Drop legacy columns from earlier metadata-enrichment experiments.
  // Note: mb_release_group_id used to be dropped here, but #30.19
  // resurrects album-level metadata matching against MusicBrainz so
  // that column is now actively used (see metadataMatch.js). The
  // drop has been removed; the safeAddColumn below recreates it
  // fresh on installs that previously had it dropped.
  //
  // Same story for mb_release_id (#v1.1.0.20): the column existed
  // briefly as an enrichment field, was dropped, and is now back as
  // a tag-sourced fast-match input. The drop has been removed.
  dropColumnIfExists('albums', 'bio');
  dropColumnIfExists('albums', 'bio_source');
  dropColumnIfExists('albums', 'enriched_at');
  dropColumnIfExists('artists', 'bio');
  dropColumnIfExists('artists', 'bio_source');
  dropColumnIfExists('artists', 'image_url');
  dropColumnIfExists('artists', 'formed_year');
  dropColumnIfExists('artists', 'country');
  dropColumnIfExists('artists', 'enriched_at');

  // Drop legacy columns from cover-art-on-tracks experiments
  dropColumnIfExists('tracks', 'cover_art');
  dropColumnIfExists('tracks', 'cover_art_mime');

  // Drop the old renderer_overrides table (replaced by renderer_settings)
  try { db.exec('DROP TABLE IF EXISTS renderer_overrides'); } catch (e) {}

  // Migrate older track_loudness tables that lack album gain columns
  safeAddColumn('track_loudness', 'album_integrated_lufs', 'REAL');
  safeAddColumn('track_loudness', 'album_peak', 'REAL');

  // v1.1.0.76 — store the raw RG gain values from the file alongside
  // the derived LUFS values. Two reasons:
  //   (a) UI surfaces (Album Detail page) want to show the gain as
  //       it was tagged ("Track Gain: -8.83 dB"), which is what
  //       users see in foobar / dBpoweramp / other taggers.
  //   (b) Reconstructing the gain from `target_lufs - integrated_lufs`
  //       is only correct when the file's reference matches our
  //       assumed target (almost always -18, but not guaranteed).
  //       Storing the raw value avoids the round-trip.
  // reference_lufs comes from REPLAYGAIN_REFERENCE_LOUDNESS when the
  // file carries it. Null when absent — older / minimal taggers omit
  // this. When present, computeStreamGain uses it instead of the
  // assumed default for a more accurate measurement back-out.
  safeAddColumn('track_loudness', 'track_gain_db', 'REAL');
  safeAddColumn('track_loudness', 'album_gain_db', 'REAL');
  safeAddColumn('track_loudness', 'reference_lufs', 'REAL');

  // Per-renderer icon picker (#30.22). Stores the user's chosen icon
  // id for each renderer so the picker, sidebar, and now-playing bar
  // can all show the same custom icon. NULL means "use default" (the
  // protocol-based fallback). Icon ids are short string keys defined
  // in the client's renderer-icons set; if a saved id no longer
  // exists in the client (icon removed in a later release), the UI
  // falls back to the default rather than rendering nothing.
  safeAddColumn('renderer_settings', 'icon_id', 'TEXT');

  // v1.1.0.68 — User-defined display name for a renderer / zone.
  // Allows the user to rename "WiiM Pro Plus (kitchen)" to just
  // "Kitchen" without changing the underlying network identity.
  // Null/empty means "use the renderer's discovered name." Applied
  // when /audio/all loads device data, and when the renderer
  // registry hands rows to the Output sheet / mini bar / sidebar so
  // the rename propagates everywhere the name is shown.
  safeAddColumn('renderer_settings', 'custom_name', 'TEXT');

  // USB DAC per-renderer settings (#v1.1.0.0).
  // bypass_dsp: when set, the ALSA renderer skips the DSP filter
  //   chain entirely and writes raw samples to the DAC. Defaults to
  //   1 for ALSA renderers (the whole point of a USB DAC is bit-
  //   perfect); user can flip it off in Audio settings to apply DSP
  //   to the DAC output.
  // dsd_mode: how to handle DSD source files for DSD-capable DACs.
  //   Values: 'auto' (prefer native, then DoP, then PCM), 'pcm'
  //   (force decode), 'dop' (force DoP), 'native' (force native).
  //   Stored as text; defaults applied at read time so the column
  //   is null-safe for non-ALSA renderers.
  safeAddColumn('renderer_settings', 'bypass_dsp', 'INTEGER');
  safeAddColumn('renderer_settings', 'dsd_mode', 'TEXT');

  // Per-renderer volume persistence (#v1.1.0.6). Without this, every
  // restart and every renderer switch reset the volume to the in-memory
  // default. Stored 0-100, NULL means "no value yet -> use default".
  safeAddColumn('renderer_settings', 'volume', 'INTEGER');

  // Output mode (#v1.1.0.8). 'fixed' renderers force 100% volume on
  // selection and hide the volume slider in the player UI -- typical
  // for USB DACs feeding an integrated amp where the analogue stage
  // owns the volume. 'variable' is the default and shows the slider.
  safeAddColumn('renderer_settings', 'output_mode', "TEXT DEFAULT 'variable'");

  // Sonos: limit the stream to 16-bit (#v1.1.0.8). Some users find
  // their Sonos pipeline more reliable when fed strict 16-bit material;
  // when on, anything above 16-bit is dithered to 16-bit before being
  // sent. Only meaningful for Sonos renderers; ignored for everything
  // else even if set.
  safeAddColumn('renderer_settings', 'sonos_force_16bit', 'INTEGER');

  // Album metadata matching (#30.19)
  // -----------------------------------
  // For each album we attempt to find a matching release group on
  // MusicBrainz. The result is one of:
  //   - matched: high-confidence single result, mb_release_group_id set
  //   - uncertain: ambiguous (multiple candidates or low score), needs
  //     manual triage by the user from the Unmatched page
  //   - unmatched: no plausible candidate found
  //   - pending: not yet processed (default for new rows + after a reset)
  //   - error: query failed (network, rate limit) -- will be retried
  //
  // match_candidates stores the top 5 raw candidates as JSON so the
  // UI can show them without re-querying MB. Only populated for
  // status='uncertain' and 'matched' (the latter for transparency).
  safeAddColumn('albums', 'mb_release_group_id', 'TEXT');
  safeAddColumn('albums', 'match_status', 'TEXT DEFAULT \'pending\'');
  safeAddColumn('albums', 'match_confidence', 'INTEGER');
  safeAddColumn('albums', 'match_candidates', 'TEXT');
  safeAddColumn('albums', 'matched_at', 'INTEGER');

  // Tag-sourced metadata IDs (#v1.1.0.20). Many audiophile-quality
  // files (Roon-managed libraries, Picard-tagged collections, some
  // direct downloads) carry MBIDs in their metadata tags. When the
  // scanner sees one we trust it -- skip the MB search entirely and
  // mark the album as matched.
  //
  // mb_release_id is the release-level MBID (one specific release of
  // an album, e.g. "the 2009 remaster"). It's distinct from the
  // release-group ID which represents the album as a logical work.
  // The matcher works on release-groups, but if a tag only has the
  // release-level MBID we can do one MB lookup at scan time to
  // resolve release -> release-group, then store both.
  //
  // barcode + catalog_number are search-quality boosters: when the
  // matcher has to query MB, including these in the query narrows
  // results dramatically. Even when not present in tags they're
  // optional fields the user could fill in via the manual matching
  // UI (#v1.1.0.21).
  safeAddColumn('albums', 'mb_release_id', 'TEXT');
  safeAddColumn('albums', 'barcode', 'TEXT');
  safeAddColumn('albums', 'catalog_number', 'TEXT');
  // Track who decided the match (#v1.1.0.21). Values:
  //   'auto'   -- matcher's title/artist search hit confidence threshold
  //   'tag'    -- file tag carried an authoritative MBID
  //   'manual' -- user picked from candidates or searched manually
  // We use this to:
  //   (1) Prevent the matcher from re-checking manually-confirmed albums
  //       even if we later "reset all" -- manual decisions stick.
  //   (2) Show a small badge in the UI so the user can see whether a
  //       given album was their own decision or auto-matched.
  safeAddColumn('albums', 'matched_by', 'TEXT');
  // Index on match_status because we'll frequently scan WHERE
  // match_status='pending' to find work for the matcher.
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_albums_match_status ON albums(match_status)'); } catch (e) {}

  // Bio scan tracking (#v1.1.0.28). The bio fetcher used to be lazy
  // on-demand only -- a user opening an album triggered a fetch that
  // got cached. With the metadata scheduler we now want to fetch
  // bios proactively for everything, but only ONCE per album/artist:
  // bio_attempted_at marks "we tried" regardless of success, so the
  // scheduler doesn't keep retrying. bio_at marks "we have a cached
  // bio" (the bios table itself is the source of truth -- this is a
  // denormalised flag for fast WHERE filters).
  safeAddColumn('albums', 'bio_attempted_at', 'INTEGER');
  safeAddColumn('artists', 'bio_attempted_at', 'INTEGER');
  // Per-item exclusion from automated metadata jobs (#v1.1.0.28).
  // Set to 1 when the user has decided "stop trying to scan this".
  // Currently used only by the matcher (rejected matches), but the
  // scheduler honours it for all jobs so future "ignore this album"
  // toggles don't need new columns.
  safeAddColumn('albums', 'scheduled_excluded', 'INTEGER DEFAULT 0');

  // Clean orphan settings keys
  try { db.exec("DELETE FROM settings WHERE key IN ('vl_schedule_start', 'vl_schedule_end')"); } catch (e) {}

  // One-shot credential normalisation (#v1.1.0.2). Earlier versions
  // didn't strip surrounding quote characters or whitespace from
  // credential-like settings on save. Pasting an API key from
  // Last.fm's mobile site sometimes drags in straight or smart quote
  // chars that made Last.fm reject the (mangled) key with "Invalid
  // API key". The save path was fixed in v1.1.0.1 but existing rows
  // need a one-off normalisation. We do this every boot -- it's
  // idempotent (re-running on already-clean values is a no-op) and
  // cheap (5 short rows). Cleaner than a "have we run this?" sentinel
  // for so trivial an op.
  try {
    const credentialKeys = [
      'lastfm_api_key', 'lastfm_api_secret',
      'fanart_api_key', 'audiodb_api_key',
      'mb_contact',
    ];
    const trimRegex = /^[\s"'\u201C\u201D\u2018\u2019]+|[\s"'\u201C\u201D\u2018\u2019]+$/g;
    const stmt = db.prepare('SELECT key, value FROM settings WHERE key = ?');
    const upd  = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    let cleaned = 0;
    for (const k of credentialKeys) {
      const row = stmt.get(k);
      if (!row || typeof row.value !== 'string') continue;
      const trimmed = row.value.replace(trimRegex, '');
      if (trimmed !== row.value) {
        upd.run(trimmed, k);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[db] migrated: trimmed ${cleaned} credential setting(s)`);
  } catch (e) {
    console.warn('[db] credential-trim migration failed:', e.message);
  }

  // Invalidate any pre-baked-in-keys Last.fm session (#v1.1.0.23).
  // Session keys are tied to the api_key that issued them. When we
  // switched from per-user API keys to baked-in app credentials, all
  // existing session keys became invalid -- they were issued under
  // each user's own registered Last.fm app, not under musicd's. Wipe
  // them so the user is prompted to re-authenticate.
  //
  // Sentinel: lastfm_baked_in_keys_v1. We set it once after wiping.
  // If it's already set, we've migrated -- skip. This way fresh
  // installs (no session key to wipe) still get the sentinel set
  // immediately, and we never wipe twice.
  try {
    const sentinelStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const sentinel = sentinelStmt.get('lastfm_baked_in_keys_v1');
    if (!sentinel) {
      const wipe = db.prepare(`
        UPDATE settings SET value = '' WHERE key IN (
          'lastfm_session_key', 'lastfm_username', 'scrobble_enabled'
        )
      `);
      const result = wipe.run();
      const setSentinel = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      setSentinel.run('lastfm_baked_in_keys_v1', '1');
      if (result.changes > 0) {
        console.log('[db] migrated: cleared pre-v1.1.0.23 Last.fm session (re-auth required)');
      }
    }
  } catch (e) {
    console.warn('[db] lastfm-session migration failed:', e.message);
  }

  // v1.1.0.78 — matched_at unit normalisation.
  //
  // Up to and including v77, three of the five sites that wrote
  // matched_at used Date.now() (milliseconds), and two used
  // Math.floor(Date.now() / 1000) (seconds). The mixed units silently
  // broke the v77 auto-retry SQL ("matched_at < cutoff" with cutoff
  // in seconds was always false for ms-scale rows).
  //
  // v78 standardises every writer on seconds and migrates legacy rows.
  // The migration is safe and idempotent because:
  //   * Sniff: any value > 1e10 is millisecond-scale (unix seconds
  //     don't reach 1e10 until the year 2286). Anything <= 1e10 is
  //     already in seconds and we leave it alone.
  //   * Single UPDATE; no partial state if it fails.
  //   * NULL rows untouched.
  //
  // Logged so any anomaly is visible. Runs every boot — cheap query,
  // and the WHERE clause means it's a no-op once the migration is
  // complete.
  try {
    const r = db.prepare(`
      UPDATE albums
         SET matched_at = matched_at / 1000
       WHERE matched_at IS NOT NULL
         AND matched_at > 10000000000
    `).run();
    if (r.changes > 0) {
      console.log(`[db] migrated: normalised matched_at to seconds for ${r.changes} albums`);
    }
  } catch (e) {
    console.warn('[db] matched_at unit migration failed:', e.message);
  }

  console.log('✅ Database initialized');

  // Auto-rebuild album stats if missing
  const needsRebuild = db.prepare('SELECT COUNT(*) as c FROM albums WHERE track_count = 0').get();
  if (needsRebuild.c > 0) rebuildAlbumStats();

  // v1.1.0.81 — one-off backfill for the new audio-quality columns.
  // Triggers a rebuild if any album has primary_bit_depth NULL but
  // its tracks DO have bit_depth values (i.e. the column was just
  // added by safeAddColumn above and needs populating). After this
  // first run, rebuildAlbumStats keeps the columns current via the
  // scanner's end-of-scan call, so this WHERE clause is always
  // empty on subsequent boots — the migration is idempotent and
  // self-completing.
  //
  // We check both sides (album NULL AND tracks have value) so the
  // condition stays false for libraries scanned with old metadata
  // tools that never populated track-level bit_depth/sample_rate
  // either — there's nothing to backfill there, and re-running
  // rebuildAlbumStats wouldn't change anything.
  try {
    const audioQualityNeedsBackfill = db.prepare(`
      SELECT COUNT(*) as c FROM albums a
      WHERE a.primary_bit_depth IS NULL
        AND a.primary_sample_rate IS NULL
        AND EXISTS (
          SELECT 1 FROM tracks t
          WHERE t.album = a.title AND t.album_artist = a.album_artist
            AND (t.bit_depth IS NOT NULL OR t.sample_rate IS NOT NULL)
        )
      LIMIT 1
    `).get();
    if (audioQualityNeedsBackfill.c > 0) {
      console.log('[db] migrated: backfilling primary_bit_depth / primary_sample_rate / primary_channels from tracks');
      rebuildAlbumStats();
    }
  } catch (e) {
    console.warn('[db] audio-quality backfill check failed:', e.message);
  }

  // v1.1.0.97 — one-off backfill for album_type. If the column was
  // just added by safeAddColumn above, every album row has NULL.
  // We can't import scanner.js here (circular), so we do the
  // classification inline using the same heuristics. The function
  // body mirrors deriveAlbumType in scanner.js — kept in sync
  // manually. After first boot this WHERE clause finds 0 rows and
  // the work is skipped; on every subsequent scan, scanner.js calls
  // recomputeAlbumTypes with the full helper.
  try {
    const typeNeedsBackfill = db.prepare(`
      SELECT COUNT(*) as c FROM albums WHERE album_type IS NULL AND excluded = 0
    `).get();
    if (typeNeedsBackfill.c > 0) {
      console.log(`[db] migrated: backfilling album_type for ${typeNeedsBackfill.c} albums`);
      const rows = db.prepare(`
        SELECT id, title, album_folder, track_count, total_duration
        FROM albums WHERE album_type IS NULL AND excluded = 0
      `).all();
      const update = db.prepare('UPDATE albums SET album_type = ? WHERE id = ?');
      const tx = db.transaction(() => {
        for (const r of rows) {
          const type = _classifyAlbumInline(
            r.title || '', r.album_folder || '',
            r.track_count || 0, r.total_duration || 0
          );
          update.run(type, r.id);
        }
      });
      tx();
      console.log(`[db] album_type backfill complete`);
    }
  } catch (e) {
    console.warn('[db] album_type backfill failed:', e.message);
  }
}

// v1.1.0.97 — inline classifier used only by the boot-time backfill.
// Mirrors deriveAlbumType in scanner.js. We can't import scanner.js
// here because db.js is a dependency of scanner, so the import would
// be circular. The two functions must stay in sync — when one
// changes, update both.
const _SOUNDTRACK_RE = /(?:\b(?:OST|O\.S\.T\.|soundtrack|original\s+(?:motion\s+picture\s+)?soundtrack|original\s+score|score|film\s+score|game\s+soundtrack)\b)/i;
const _DELUXE_RE = /(?:\(deluxe(?:\s+edition)?\)|\[deluxe(?:\s+edition)?\]|\bdeluxe\s+edition\b|\(bonus\s+tracks?\)|\[bonus\s+tracks?\]|\banniversary\s+edition\b|\bextended\s+edition\b|\bexpanded\s+edition\b|\bsuper\s+deluxe\b)/i;
const _LIMITED_RE = /(?:\(limited(?:\s+edition)?\)|\[limited(?:\s+edition)?\]|\blimited\s+edition\b|\bspecial\s+edition\b|\bcollector(?:'s)?\s+edition\b)/i;
const _EP_RE = /(?:\s+-\s+ep\b|\s+ep$|\(ep\)|\[ep\])/i;
const _SINGLE_RE = /(?:\s+-\s+single\b|\s+single$|\(single\)|\[single\])/i;

function _classifyAlbumInline(title, folder, trackCount, totalDurationSec) {
  if (_SOUNDTRACK_RE.test(title) || _SOUNDTRACK_RE.test(folder)) return 'soundtrack';
  if (_DELUXE_RE.test(title) || _DELUXE_RE.test(folder)) return 'deluxe';
  if (_LIMITED_RE.test(title) || _LIMITED_RE.test(folder)) return 'limited';
  if (_EP_RE.test(title) || _EP_RE.test(folder)) return 'ep';
  if (_SINGLE_RE.test(title) || _SINGLE_RE.test(folder)) return 'single';
  if (trackCount > 0) {
    if (trackCount <= 3) return 'single';
    if (trackCount <= 7 && totalDurationSec > 0 && totalDurationSec < 30 * 60) return 'ep';
  }
  return 'main';
}

function safeAddColumn(table, column, definition) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[db] migrated: added ${table}.${column}`);
    }
  } catch (e) {
    // Don't crash the boot — log so future migration bugs surface visibly
    // instead of silently leaving the schema in a half-migrated state
    // (which is what bit us on the news_items v30.1→30.3 saga).
    console.warn(`[db] safeAddColumn ${table}.${column} failed:`, e.message);
  }
}

function dropColumnIfExists(table, column) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      console.log(`🧹 Dropped ${table}.${column}`);
    }
  } catch (e) {
    // SQLite < 3.35 doesn't support DROP COLUMN; just leave it. Log at
    // info level so we know which leftover legacy columns remain.
    console.warn(`[db] dropColumnIfExists ${table}.${column} skipped:`, e.message);
  }
}

function rebuildAlbumStats() {
  console.log('📊 Rebuilding album stats...');
  // v1.1.0.92 — subqueries now match on album_id when present, with
  // fallback to album+album_artist for tracks predating the
  // migration. Once a rescan has populated album_id on every track
  // the fallback becomes a no-op. The COALESCE pattern means we
  // count each track exactly once: tracks with album_id match by id,
  // tracks without album_id match by title+artist.
  //
  // The match clause `(t.album_id = albums.id OR (t.album_id IS NULL
  // AND t.album = albums.title AND t.album_artist = albums.album_artist))`
  // is identical in every subquery — extracted to a CTE would be
  // cleaner but SQLite's UPDATE doesn't support WITH clauses well.
  db.exec(`
    UPDATE albums SET
      track_count = (
        SELECT COUNT(*) FROM tracks t
        WHERE (t.album_id = albums.id
          OR (t.album_id IS NULL AND t.album = albums.title AND t.album_artist = albums.album_artist))
      ),
      total_duration = (
        SELECT COALESCE(SUM(duration), 0) FROM tracks t
        WHERE (t.album_id = albums.id
          OR (t.album_id IS NULL AND t.album = albums.title AND t.album_artist = albums.album_artist))
      ),
      primary_format = (
        SELECT format FROM tracks t
        WHERE (t.album_id = albums.id
          OR (t.album_id IS NULL AND t.album = albums.title AND t.album_artist = albums.album_artist))
        ORDER BY format LIMIT 1
      ),
      primary_bit_depth = (
        SELECT bit_depth FROM tracks t
        WHERE (t.album_id = albums.id
          OR (t.album_id IS NULL AND t.album = albums.title AND t.album_artist = albums.album_artist))
        ORDER BY format LIMIT 1
      ),
      primary_sample_rate = (
        SELECT sample_rate FROM tracks t
        WHERE (t.album_id = albums.id
          OR (t.album_id IS NULL AND t.album = albums.title AND t.album_artist = albums.album_artist))
        ORDER BY format LIMIT 1
      ),
      primary_channels = (
        SELECT channels FROM tracks t
        WHERE (t.album_id = albums.id
          OR (t.album_id IS NULL AND t.album = albums.title AND t.album_artist = albums.album_artist))
        ORDER BY format LIMIT 1
      ),
      genre = CASE WHEN genre IS NULL OR genre = '' THEN (
        SELECT t.genre FROM tracks t
        WHERE (t.album_id = albums.id
          OR (t.album_id IS NULL AND t.album = albums.title AND t.album_artist = albums.album_artist))
        AND t.genre IS NOT NULL AND t.genre != ''
        LIMIT 1
      ) ELSE genre END
  `);
  // Remove orphan albums (where all tracks have been deleted)
  const removed = db.prepare('DELETE FROM albums WHERE track_count = 0').run();
  if (removed.changes > 0) console.log(`🧹 Removed ${removed.changes} orphan albums`);
  console.log('✅ Album stats rebuilt');
}

function get() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function isReady() {
  return !!db;
}

function close() {
  if (db) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
    db.close();
  }
}

module.exports = { init, get, isReady, close, rebuildAlbumStats };
