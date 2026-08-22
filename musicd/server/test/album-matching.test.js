// Album matching, and album versions (v1.1.34.0).
//
// These shipped together because they are one idea. Matching decides
// which MusicBrainz release group an album belongs to; version grouping
// asks which local rows belong to the same album. Get the first right
// and the second mostly falls out — which is why both read their
// normalisation from src/albumIdentity.js and neither has a copy.
//
// THE BUG THIS RELEASE FIXES WAS ARITHMETIC, and it is the first thing
// pinned below. The old weights gave an exact title 50 and an exact
// artist 30, against a "matched" threshold of 85. So an album whose
// title and artist were BOTH exactly right scored 80 and went to
// triage. It only ever cleared the bar on a year agreement or on
// MusicBrainz's own confidence — and a remaster is tagged with the
// remaster's year while its release group's date is the original's, so
// the albums most likely to need help were the ones guaranteed not to
// get it. "Air - Moon Safari (Remaster)" failed for that reason, three
// times over, once per copy.
//
// Four things are pinned here:
//
//   EXACT IS ENOUGH. Artist and title agreeing exactly matches on its
//   own, with no year and no help from MB's scorer.
//
//   A DECISIVE ANSWER IS NOT BLOCKED BY A RIVAL. The runner-up guard
//   used to be unconditional, so the studio album at 100 was sent to
//   triage because the live album of the same name scored 86. Beating
//   your nearest rival by 14 points is not ambiguity.
//
//   POOR TAGS ARE RECOVERABLE. An album with no album_artist is not
//   unmatchable: the tracks usually know, and the folder usually knows.
//
//   GROUPING IS A VIEW, NOT A MIGRATION. No row is merged, moved or
//   deleted, an unidentifiable album is never hidden behind another,
//   and the collapsed tile is the best-quality copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const readRaw = (...p) => fs.readFileSync(path.join(SERVER_SRC, ...p), 'utf8');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const readClient = (...p) => fs.readFileSync(path.join(CLIENT_SRC, ...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'musicd-matching-'));
process.env.DB_PATH = path.join(TMP, 'musicd.db');

const identity = require(path.join(SERVER_SRC, 'albumIdentity'));
const db = require(path.join(SERVER_SRC, 'db'));
const matcher = require(path.join(SERVER_SRC, 'metadataMatch'));

db.init();
const dbh = db.get();
const albumVersions = require(path.join(SERVER_SRC, 'albumVersions'));

// A MusicBrainz release group, in the shape the scorer reads.
const rg = (over = {}) => ({
  id: over.id || 'mbid-1',
  title: over.title || 'Moon Safari',
  'artist-credit': [{ name: over.artist || 'Air' }],
  'first-release-date': over.date === undefined ? '1998-01-16' : over.date,
  'primary-type': over.primaryType === undefined ? 'Album' : over.primaryType,
  'secondary-types': over.secondaryTypes || [],
  score: over.mbScore,
});

const MATCHED_AT = 85;

// ---------------------------------------------------------------------------
// 1. Exact title + exact artist is enough, on its own.
// ---------------------------------------------------------------------------

test('an exact title and an exact artist match without any other evidence', () => {
  // No year on the album, no score from MB. Under the old 50+30 weights
  // this was 80 against a threshold of 85 — a perfect match, refused.
  const score = matcher.scoreCandidate(
    { title: 'Moon Safari', album_artist: 'Air', year: null, track_count: 10 },
    rg(), {});
  assert.ok(score >= MATCHED_AT,
    `exact title + exact artist scored ${score}, below the ${MATCHED_AT} needed to ` +
    'match. This is the v1.1.34.0 bug: an album tagged perfectly could not ' +
    'be matched without a year agreement, and a remaster never has one.');
});

test('every edition of one album matches the same release group', () => {
  // The reported case, in full. A remaster and a deluxe edition are
  // tagged with the REISSUE year, so none of them gets the year bonus.
  const variants = [
    'Moon Safari',
    'Moon Safari (deluxe)',
    'Moon Safari (Remaster)',
    'Moon Safari (2018 Remaster)',
    'Moon Safari (Deluxe Edition)',
    'Moon Safari [Bonus Tracks]',
    'Moon Safari - Remastered',
  ];
  const failed = [];
  for (const title of variants) {
    const score = matcher.scoreCandidate(
      { title, album_artist: 'Air', year: 2018, track_count: 10 },
      rg(), {});
    if (score < MATCHED_AT) failed.push(`${title} (${score})`);
  }
  assert.deepEqual(failed, [],
    'these editions did not reach the match threshold: ' + failed.join(', '));
});

test('the year is a bonus and never a penalty', () => {
  const right = matcher.scoreCandidate(
    { title: 'Moon Safari', album_artist: 'Air', year: 1998, track_count: 10 }, rg(), {});
  const wrong = matcher.scoreCandidate(
    { title: 'Moon Safari', album_artist: 'Air', year: 2018, track_count: 10 }, rg(), {});
  assert.ok(right > wrong, 'a year agreement should still be worth something');
  assert.ok(wrong >= MATCHED_AT,
    'a reissue year must not drag an otherwise exact match below the threshold — ' +
    'that is the whole failure this release exists to fix');
});

// ---------------------------------------------------------------------------
// 2. A decisive answer is not blocked by a plausible rival.
// ---------------------------------------------------------------------------

test('a live album of the same name scores below the studio album', () => {
  const album = { title: 'Moon Safari', album_artist: 'Air', year: 1998, track_count: 10 };
  const studio = matcher.scoreCandidate(album, rg(), {});
  const live = matcher.scoreCandidate(album, rg({ id: 'mbid-live', secondaryTypes: ['Live'], date: '2001-01-01' }), {});
  assert.ok(live < studio,
    'MusicBrainz secondary types were fetched and stored since v30.19 and never ' +
    'scored, so a live record could tie with the studio one it shares a name with');
});

test('a decisive top answer matches even with a close-behind rival', () => {
  const album = { title: 'Moon Safari', album_artist: 'Air', year: 1998, track_count: 10 };
  const ranked = [
    { candidate: rg(), score: matcher.scoreCandidate(album, rg(), {}) },
    { candidate: rg({ id: 'mbid-live', secondaryTypes: ['Live'] }),
      score: matcher.scoreCandidate(album, rg({ id: 'mbid-live', secondaryTypes: ['Live'] }), {}) },
  ].sort((a, b) => b.score - a.score);

  assert.ok(ranked[0].score >= 95, 'precondition: the top answer is decisive');
  assert.ok(ranked[1].score > ranked[0].score - 15,
    'precondition: the runner-up is inside the old 15-point guard');

  const decided = matcher.decideMatch(ranked, {});
  assert.equal(decided.status, 'matched',
    'a 100-point answer was sent to triage because a rival scored 86. Beating ' +
    'your nearest rival by 14 points is not ambiguity, and the guard used to ' +
    'apply however strong the top answer was.');
  assert.equal(decided.mbid, 'mbid-1');
});

test('a genuinely ambiguous pair still goes to triage', () => {
  // Two plausible candidates, neither decisive. This is what the
  // runner-up guard is FOR, and relaxing it must not have removed it.
  const ranked = [
    { candidate: rg({ id: 'a' }), score: 86 },
    { candidate: rg({ id: 'b' }), score: 84 },
  ];
  const decided = matcher.decideMatch(ranked, {});
  assert.equal(decided.status, 'uncertain',
    'two near-equal, non-decisive candidates must still be triaged');
  assert.equal(decided.mbid, null);
});

test('inside one artist\'s own discography a clear leader is trusted lower', () => {
  // Browsed by artist MBID, so the artist axis is not in question and
  // the only open question is which of THEIR records this is.
  const ranked = [{ candidate: rg(), score: 79 }, { candidate: rg({ id: 'z' }), score: 40 }];
  assert.equal(matcher.decideMatch(ranked, {}).status, 'uncertain',
    'a 79 from an open search is not enough');
  assert.equal(matcher.decideMatch(ranked, { fromDiscography: true }).status, 'matched',
    'the same 79 from inside the artist\'s catalogue is a different question');
});

// ---------------------------------------------------------------------------
// 3. Poor tags are recoverable.
// ---------------------------------------------------------------------------

test('a missing album artist is recovered from the tracks', () => {
  dbh.prepare(`INSERT INTO albums (id, title, album_artist, album_folder, added_at)
               VALUES ('rec1', 'Premiers Symptomes', '', '/music/rec1', unixepoch())`).run();
  for (let i = 1; i <= 3; i++) {
    dbh.prepare(`INSERT INTO tracks (id, path, album_id, title, artist, album, added_at, updated_at)
                 VALUES (?, ?, 'rec1', ?, 'Air', 'Premiers Symptomes', unixepoch(), unixepoch())`)
      .run(`rec1-t${i}`, `/music/rec1/0${i}.flac`, `Track ${i}`);
  }
  const id = identity.effectiveIdentity(
    dbh.prepare('SELECT * FROM albums WHERE id = ?').get('rec1'), dbh);
  assert.equal(id.cleanArtist, 'Air');
  assert.equal(id.source.artist, 'tracks',
    'an album row with no album_artist is not unmatchable — the tracks know');
  assert.equal(id.unusable, false);
});

test('a placeholder artist counts as absent, not as an artist', () => {
  dbh.prepare(`INSERT INTO albums (id, title, album_artist, album_folder, added_at)
               VALUES ('rec2', 'The Virgin Suicides', 'Unknown Artist', '/music/Air - The Virgin Suicides (1999)', unixepoch())`).run();
  const id = identity.effectiveIdentity(
    dbh.prepare('SELECT * FROM albums WHERE id = ?').get('rec2'), dbh);
  assert.equal(id.cleanArtist, 'Air',
    'searching MusicBrainz for an artist called "Unknown Artist" finds nothing, ' +
    'so the placeholder has to be treated as missing and recovered');
  assert.equal(id.source.artist, 'folder');
  assert.equal(id.year, 1999, 'the folder carried the year too');
});

test('an album with nothing usable is reported unusable rather than searched for', () => {
  dbh.prepare(`INSERT INTO albums (id, title, album_artist, album_folder, added_at)
               VALUES ('rec3', 'Unknown Album', 'Various Artists', NULL, unixepoch())`).run();
  const id = identity.effectiveIdentity(
    dbh.prepare('SELECT * FROM albums WHERE id = ?').get('rec3'), dbh);
  assert.equal(id.unusable, true);
});

test('folder names are parsed, and never guessed at', () => {
  assert.deepEqual(identity.parseFolderName('/m/Air - Moon Safari (1998)'),
    { artist: 'Air', title: 'Moon Safari', year: 1998 });
  assert.deepEqual(identity.parseFolderName('/m/Air - 1998 - Moon Safari'),
    { artist: 'Air', title: 'Moon Safari', year: 1998 });
  assert.deepEqual(identity.parseFolderName('/m/1998 - Moon Safari'),
    { artist: null, title: 'Moon Safari', year: 1998 });
  // No separator: a title and NO artist. Splitting on a space here would
  // invent an artist called "Moon" from a folder called "Moon Safari".
  assert.deepEqual(identity.parseFolderName('/m/Moon Safari'),
    { artist: null, title: 'Moon Safari', year: null });
});

// ---------------------------------------------------------------------------
// 4. Version grouping.
// ---------------------------------------------------------------------------

function seedAlbum(id, title, artist, opts = {}) {
  dbh.prepare(`
    INSERT INTO albums (id, title, artist, album_artist, year, track_count,
                        primary_bit_depth, primary_sample_rate, added_at, excluded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, title, artist, artist, opts.year || 1998, opts.tracks || 10,
         opts.bits || 16, opts.rate || 44100, opts.added || 100);
  return id;
}

test('every edition of one album shares a version key', () => {
  const keys = [
    'Moon Safari', 'Moon Safari (Deluxe)', 'Moon Safari (Remaster)',
    'Moon Safari (2018 Remaster)', 'Moon Safari [Bonus Tracks]',
  ].map(t => identity.versionKeyFor({ title: t, album_artist: 'Air' }));
  assert.equal(new Set(keys).size, 1, 'all editions must produce one key: ' + keys.join(' | '));
});

test('a matched album keys on its release group, not its title', () => {
  const k = identity.versionKeyFor({ title: 'Moon Safari', album_artist: 'Air', mb_release_group_id: 'abc' });
  assert.equal(k, 'rg:abc',
    'once matched, the release group is authoritative — which is why better ' +
    'matching makes grouping more accurate rather than being a separate feature');
});

test('a same-titled album by another artist does NOT group', () => {
  const a = identity.versionKeyFor({ title: 'Moon Safari', album_artist: 'Air' });
  const b = identity.versionKeyFor({ title: 'Moon Safari', album_artist: 'Someone Else' });
  assert.notEqual(a, b);
});

test('an album with no readable title never groups, including with other unknowns', () => {
  assert.equal(identity.versionKeyFor({ title: '', album_artist: 'Air' }), null);
  assert.equal(identity.versionKeyFor({ title: 'Unknown Album', album_artist: '' }), null,
    'two albums whose titles we cannot read are not evidence of being the same album');
});

test('collapsing picks the best-quality copy and hides nothing else', () => {
  seedAlbum('v1', 'Moon Safari', 'Air', { bits: 16, rate: 44100, tracks: 10, added: 100 });
  seedAlbum('v2', 'Moon Safari (Deluxe)', 'Air', { bits: 16, rate: 44100, tracks: 14, added: 200 });
  seedAlbum('v3', 'Moon Safari (Remaster)', 'Air', { bits: 24, rate: 96000, tracks: 10, added: 300 });
  seedAlbum('v4', 'Talkie Walkie', 'Air', { added: 400 });
  seedAlbum('v5', 'Moon Safari', 'Someone Else', { added: 500 });
  // No usable identity: must stay visible on its own.
  dbh.prepare(`INSERT INTO albums (id, title, album_artist, added_at, excluded)
               VALUES ('v6', 'Unknown Album', '', 600, 0)`).run();
  albumVersions.rebuildVersionKeys();

  const visible = dbh.prepare(
    `SELECT id FROM albums WHERE id IN (${albumVersions.PRIMARY_IDS_SQL}) AND id LIKE 'v%' ORDER BY id`
  ).all().map(r => r.id);

  assert.deepEqual(visible, ['v3', 'v4', 'v5', 'v6'],
    'expected the 24/96 remaster to stand for the three Air copies, with the ' +
    'other artist, the other album and the unidentifiable row all still visible');
});

test('an unidentifiable album is never hidden behind another row', () => {
  const key = dbh.prepare("SELECT version_key FROM albums WHERE id = 'v6'").get();
  assert.equal(key.version_key, null);
  const visible = dbh.prepare(
    `SELECT id FROM albums WHERE id IN (${albumVersions.PRIMARY_IDS_SQL}) AND id = 'v6'`
  ).all();
  assert.equal(visible.length, 1,
    'a NULL version key must always survive collapsing — we do not know what ' +
    'the album is, so we cannot claim another row represents it');
});

test('the version count is absent, not 1, for an album standing alone', () => {
  const counts = albumVersions.versionCounts(['v3', 'v4']);
  assert.equal(counts.v3, 3, 'the collapsed tile stands for three copies');
  assert.equal(counts.v4, undefined,
    'a lone album must report no count at all, so the client never has to ' +
    'compare against 1 and never renders a "1 versions" badge');
});

test('the album page lists every version, best first', () => {
  const versions = albumVersions.versionsOf('v1').map(v => v.id);
  assert.deepEqual(versions, ['v3', 'v2', 'v1'],
    'ordered best-quality first, so the list agrees with which one the wall ' +
    'would have collapsed to');
  assert.deepEqual(albumVersions.versionsOf('v4').map(v => v.id), ['v4'],
    'an album with no siblings still returns itself');
});

test('grouping never edits the library', () => {
  const n = dbh.prepare("SELECT COUNT(*) c FROM albums WHERE id LIKE 'v%'").get().c;
  assert.equal(n, 6,
    'collapsing is a query, not a migration — all six rows must still exist. ' +
    'A "deduplicate" that deletes rows is one bad heuristic away from losing a ' +
    'record the user wanted.');
});

// ---------------------------------------------------------------------------
// 5. Wiring, and the detectors.
// ---------------------------------------------------------------------------

test('grouping is opt-in per surface AND gated on the setting', () => {
  const lib = code(readRaw('routes', 'library.js'));
  assert.ok(/wantVersions && albumVersions\.isEnabled\(\)/.test(lib),
    'both the caller asking and the user setting must agree before anything collapses');
  assert.ok(/groupVersions,/.test(lib),
    'the grouping flag must be in the album-list cache key, or toggling the ' +
    'setting appears to do nothing for the 30 seconds the list stays cached');

  const grid = code(readClient('components', 'AlbumGrid.jsx'));
  assert.ok(/!favoritesOnly && !savedOnly/.test(grid),
    'Favourites and Saved must NOT request collapsing: there the user picked a ' +
    'specific version and hiding it behind another copy loses the row they saved');
});

test('the version badge and service glyph are drawn once, by the shared tile', () => {
  // These used to be asserted per grid, because each grid had its own
  // tile. They delegate now, which is why the badge only had to be
  // written once — and why the next marker will not be missing from the
  // artist page the way the service glyph was in v1.1.33.0.
  const tile = code(readClient('components', 'AlbumTile.jsx'));
  assert.ok(/<VersionBadge count=\{album\.version_count\}/.test(tile),
    'the shared tile must render the version badge');
  assert.ok(/<ServiceBadge service=\{album\.service\}/.test(tile),
    'the shared tile must render the streaming service glyph');
});

test('the matcher and the version key share one normalisation', () => {
  const mm = code(readRaw('metadataMatch.js'));
  assert.ok(/require\('\.\/albumIdentity'\)/.test(mm),
    'the matcher must read its normalisation from albumIdentity, not keep a copy');
  assert.ok(!/^function normalise/m.test(mm) && !/^function cleanAlbumTitle/m.test(mm),
    'a second copy of the normalisation in metadataMatch.js is how three copies ' +
    'of one album match the same release group and still refuse to group');
});

// ---------------------------------------------------------------------------
// 6. Layout: one tile everywhere, and buttons that are actually side by side.
// ---------------------------------------------------------------------------

test('every album grid draws the same tile component', () => {
  // There were three copies of "an album tile" and they drifted: the
  // streaming glyph reached the wall and not the artist page, and the
  // service screens grew an optional quality line that made their tiles
  // taller than everyone else's, so the Qobuz grid came out ragged.
  // All four: the album wall, the artist page, the random wall and the
  // Qobuz / Tidal screens. RandomAlbumsScreen even had a local component
  // of the same name as the shared one.
  for (const f of ['AlbumGrid.jsx', 'ArtistAlbums.jsx', 'ServiceScreen.jsx', 'RandomAlbumsScreen.jsx']) {
    const s = code(readClient('components', f));
    assert.ok(/from '\.\/AlbumTile'/.test(s),
      `${f} must render the shared AlbumTile, not its own copy`);
    // NOT "has an IntersectionObserver" — AlbumGrid legitimately has one
    // for its infinite-scroll sentinel. The tell is a component drawing
    // its own cover: an artBox with an artEmpty placeholder inside it.
    assert.ok(!/artEmpty/.test(s),
      `${f} still draws its own album artwork — the cover, its placeholder ` +
      'and the overlays belong to AlbumTile now, and a second copy of them ' +
      'is exactly how these three drifted apart');
  }
});

test('the shared tile has a fixed structure, so every tile is the same height', () => {
  const tile = code(readClient('components', 'AlbumTile.jsx'));
  // Exactly two text lines, and the subtitle falls back to a space so a
  // tile with no artist is still as tall as one that has an artist.
  assert.ok(tile.includes("subtitle || artist || '\\u00a0'"),
    'the subtitle must always render something. A tile with no artist would ' +
    'otherwise be one line shorter than its neighbours and stretch the grid ' +
    'row — the ragged-Qobuz-grid bug. Written as the escape \\u00a0 rather ' +
    'than a literal non-breaking space so it is visible in the source.');
  // Everything optional is an overlay, which cannot change height.
  for (const overlay of ['ServiceBadge', 'VersionBadge', 'SelectionTick']) {
    assert.ok(new RegExp(overlay).test(tile), `${overlay} should be drawn by the shared tile`);
  }
  assert.ok(!/cardQuality/.test(tile),
    'a conditional quality line under the artist is exactly what made the ' +
    'Qobuz grid ragged — quality belongs on the album page');
});

test('the album page action buttons sit side by side at every width', () => {
  const detail = readRaw('..', '..', 'client', 'src', 'components', 'AlbumDetail.jsx');
  const row = /heroActions: \{([^}]*)\}/.exec(detail);
  assert.ok(row, 'heroActions style is gone');
  assert.ok(/justifyContent: 'flex-start'/.test(row[1]),
    'Play and Add Queue are inside heroInfo, which is flex:1 beside a fixed ' +
    '144px cover. space-between only looked correct on a phone, where there ' +
    'is no room to spread; on a tablet it threw the two buttons to opposite ' +
    'ends of a wide box.');
  assert.ok(!/justifyContent: 'space-between'/.test(row[1]),
    'space-between must be gone, not shadowed by a later key — a duplicate ' +
    'key in these style maps is an esbuild warning and the LAST value wins');
  assert.ok(/flexWrap: 'wrap'/.test(row[1]),
    'with the circled plus in this row a narrow phone needs to wrap rather ' +
    'than squash three controls');
});

// ---------------------------------------------------------------------------
// 7. The album page, decluttered (v1.1.35.0).
// ---------------------------------------------------------------------------

test('the album page no longer says things it has already said', () => {
  const d = code(readClient('components', 'AlbumDetail.jsx'));

  assert.ok(!/Not matched yet/.test(d),
    'the "Not matched yet" chip is gone. It appeared on every album that was ' +
    'not matched, which on a default install is EVERY album: the metadata ' +
    'scheduler defaults to off and the MusicBrainz matcher additionally ' +
    'refuses to run without mb_contact set, so matching has never been ' +
    'attempted. A permanent chip reporting that is noise, not information.');

  assert.ok(!/other cop(y|ies) in your library/.test(d),
    'the sentence under the versions button is gone — the button reads ' +
    '"2 versions", which already says it');

  assert.ok(!/>\s*Add Queue\s*</.test(d),
    'the Add Queue pill is gone; the Play chevron menu already offers ' +
    '"Add to Queue", and the duplicate was costing the row its width');
  assert.ok(/onAddToQueue=/.test(d),
    'the Play menu must still offer Add to Queue — removing the pill must ' +
    'not remove the function');

  assert.ok(/heroRgLabel}>RG</.test(d),
    'the ReplayGain label reads "RG": spelled out it was the longest and ' +
    'least interesting thing on the line');
});

test('the matched-only pill row is not rendered when it would be empty', () => {
  const d = code(readClient('components', 'AlbumDetail.jsx'));
  const at = d.indexOf('s.matchedPillRow');
  assert.notEqual(at, -1, 'the pill row is gone entirely');
  // Every child of that row is gated on the album being matched, so without
  // a guard on the row ITSELF an unmatched album renders an empty div
  // carrying 30px of vertical margin — a visible hole above the track list
  // on every album, since by default nothing is ever matched.
  const before = d.slice(Math.max(0, at - 200), at);
  assert.ok(/match_status === 'matched' && album\.mb_release_group_id && \(/.test(before),
    'the pill row must be guarded, or it leaves an empty margin-bearing div ' +
    'above the track list on every unmatched album');
});

test('the hero gives its detail lines the full page width', () => {
  const d = code(readClient('components', 'AlbumDetail.jsx'));
  assert.ok(/heroBelow/.test(d),
    'the format line, ReplayGain and the actions must sit in a full-width ' +
    'block, not in the ~200pt column left over beside a 144px cover — that ' +
    'column is what made the page read as cramped on a phone');
  // The RG label must not be able to wrap away from its own value.
  const rg = /heroRgRow: \{([^}]*)\}/.exec(readRaw('..', '..', 'client', 'src', 'components', 'AlbumDetail.jsx'));
  assert.ok(rg, 'heroRgRow style is gone');
  assert.ok(/flexWrap: 'nowrap'/.test(rg[1]),
    'the RG row must not wrap as a whole: it left the two-letter label ' +
    'stranded on a line by itself with the numbers underneath. The VALUE ' +
    'wraps inside its own box instead.');
});

test('the track list is inset by the same amount on both sides', () => {
  const raw = readRaw('..', '..', 'client', 'src', 'components', 'AlbumDetail.jsx');
  const grid = /const TRACK_GRID = '(\d+)px 1fr (\d+)px'/.exec(raw);
  assert.ok(grid, 'TRACK_GRID must be one shared constant — the header and the ' +
    'rows each having their own is how the "#" stops sitting over the numbers');

  const numCol = Number(grid[1]);
  assert.ok(numCol <= 22,
    `the track-number column is ${numCol}px. It was 32px with a further 10px ` +
    'of right padding, so a single-digit number floated ~22px in from the row ' +
    'edge while the duration finished 8px from the other one — the uneven ' +
    'gutter. It has to be about two digits wide, no more.');
  assert.ok(!/trackNum: \{[^}]*paddingRight/.test(raw),
    'trackNum must not re-add right padding — that padding is exactly what ' +
    'pushed the number away from its own edge');

  // Both the header and the rows must use the shared constant.
  assert.equal((raw.match(/gridTemplateColumns: TRACK_GRID/g) || []).length, 2,
    'the header and the track rows must both use TRACK_GRID');

  // And the spec line wraps rather than clipping its last chip.
  assert.ok(/trackSpec: \{[^}]*flexWrap: 'wrap'/.test(raw),
    'the per-track spec must wrap. It only just fitted a phone, and the ' +
    'ReplayGain chip is last, so any width it lost was taken out of the chip ' +
    'mid-word — "RG -8.(" with the rest cut off.');
});

// ---------------------------------------------------------------------------
// 8. The album hero (v1.1.36.0).
// ---------------------------------------------------------------------------

test('the hero column aligns to the artwork at both ends', () => {
  const raw = readRaw('..', '..', 'client', 'src', 'components', 'AlbumDetail.jsx');

  const hero = /  hero: \{([^}]*)\}/.exec(raw);
  assert.ok(hero, 'the hero style is gone');
  assert.ok(/alignItems: 'stretch'/.test(hero[1]),
    "the column beside the cover must stretch to the cover's height — " +
    "centring it puts the title's top below the top of the artwork");

  const info = /  heroInfo: \{([\s\S]*?)\n  \},/.exec(raw);
  assert.ok(info, 'the heroInfo style is gone');
  assert.ok(/justifyContent: 'space-between'/.test(info[1]),
    'the title block and the action row are the two children of that column; ' +
    'space-between is what puts the title level with the top of the artwork ' +
    'and the Play row level with its bottom, at any title length');
  assert.ok(/flexDirection: 'column'/.test(info[1]),
    'the column has to actually be a column for space-between to work vertically');
});

test('the action row sits beside the artwork, not below the details', () => {
  const d = code(readClient('components', 'AlbumDetail.jsx'));
  const heroAt = d.indexOf('style={s.hero}');
  const belowAt = d.indexOf('style={s.heroBelow}');
  const actionsAt = d.indexOf('style={s.heroActions}');
  assert.ok(heroAt !== -1 && belowAt !== -1 && actionsAt !== -1, 'hero markup is gone');
  assert.ok(actionsAt > heroAt && actionsAt < belowAt,
    'the Play row must be inside the hero row, between the cover and the ' +
    'full-width details block. Below the details it cannot line up with the ' +
    'bottom of the artwork, which is the whole point of where it sits.');
});

test('the album favourite is a heart in the action row, filled red when on', () => {
  const d = code(readClient('components', 'AlbumDetail.jsx'));
  const at = d.indexOf('style={s.heroActions}');
  const row = d.slice(at, at + 3000);
  assert.ok(/<Heart/.test(row),
    'the server favourite must be a button in the action row');
  assert.ok(/fill=\{isFavorite \? '#ff3b5c' : 'none'\}/.test(row),
    'hollow when not favourited, filled #ff3b5c when it is — the same red the ' +
    'overflow sheet used, so two readings of "favourited" cannot drift apart');
  assert.ok(/onClick=\{handleToggleFavorite\}/.test(row),
    'the heart must drive the existing favourite toggle rather than a second one');

  // And it must not ALSO still be in the overflow sheet. A duplicate control
  // is what the Add Queue pill was.
  const sheetAt = d.indexOf('function AlbumOverflowSheet');
  assert.ok(sheetAt !== -1, 'the overflow sheet is gone');
  // Bounded to THIS function. The per-track overflow sheet further down the
  // file has its own heart for the track favourite, which is a different
  // control and must not be caught by this check.
  const nextFn = d.indexOf('\nfunction ', sheetAt + 1);
  const albumSheet = d.slice(sheetAt, nextFn === -1 ? undefined : nextFn);
  assert.ok(!/<Heart/.test(albumSheet),
    'the album heart moved to the action row; leaving a copy in the ⋯ sheet ' +
    'is the duplication the Add Queue pill was removed for');
});

test('the heart is on every album and the service plus only on streaming ones', () => {
  const d = code(readClient('components', 'AlbumDetail.jsx'));
  const at = d.indexOf('style={s.heroActions}');
  const row = d.slice(at, at + 3000);
  // The ⊕ is gated on `service`; the heart is not gated on anything.
  assert.ok(/\{service && \(/.test(row),
    'the service ⊕ must be gated on the album belonging to Qobuz or Tidal — ' +
    'a local album has no service favourite to write');
  const heartAt = row.indexOf('<Heart');
  const gateAt = row.indexOf('{service && (');
  assert.ok(heartAt < gateAt,
    'the heart must come BEFORE the service gate, or it only renders on ' +
    'streaming albums — it is this app\'s own favourite and applies to all of them');
});

test('the detectors actually detect', () => {
  // A check that cannot fail is worse than no check.

  // (a) The old weights, against the same exact-match input.
  const oldWeights = 50 + 30;
  assert.ok(oldWeights < MATCHED_AT,
    'the exact-match test must be measuring something: under the old weights ' +
    'this input scored 80 and did not match');

  // (b) A grid that requests collapsing on Favourites.
  const leaky = "const versionsParam = '&versions=collapse'";
  assert.ok(!/!favoritesOnly && !savedOnly/.test(leaky),
    'the surface check must go red when the guard is dropped');

  // (c) A tile component with no version badge.
  const bare = 'return (<button><img src={a.cover}/></button>)';
  assert.ok(!/<VersionBadge count=\{album\.version_count\}/.test(bare),
    'the badge check must go red on a tile that does not draw it');

  // (d) A metadataMatch that kept its own copy of normalise().
  const dup = '\nfunction normalise(s) { return s; }\n';
  assert.ok(/^function normalise/m.test(dup),
    'the duplicate-normalisation check must go red when a copy comes back');

  // (e) A grid that went back to drawing its own cover.
  const ownTile = "<div style={s.artBox}><div style={s.artEmpty}>♫</div></div>";
  assert.ok(/artEmpty/.test(ownTile),
    'the shared-tile check must go red on a component that draws its own artwork');
  const delegating = '<AlbumTile album={album} onClick={onClick} />';
  assert.ok(!/artEmpty/.test(delegating),
    'and must stay green for one that delegates');

  // (g) The decluttering, undone.
  assert.ok(/Not matched yet/.test('<div>Not matched yet</div>'),
    'the not-matched check must go red if the chip comes back');
  assert.ok(/>\s*Add Queue\s*</.test('<button>Add Queue</button>'),
    'the Add Queue check must go red if the pill comes back');

  // (h) The old track grid.
  const oldGrid = /const TRACK_GRID = '(\d+)px 1fr (\d+)px'/.exec("const TRACK_GRID = '32px 1fr 52px'");
  assert.ok(oldGrid && Number(oldGrid[1]) > 22,
    'the gutter check must go red on the 32px number column it replaced');

  // (i) The hero centred again, which is what hid the title's top.
  const centred = "  hero: { display: 'flex', alignItems: 'center' }";
  const h = /  hero: \{([^}]*)\}/.exec(centred);
  assert.ok(h && !/alignItems: 'stretch'/.test(h[1]),
    'the hero-alignment check must go red on a centred hero');

  // (j) The heart left in the overflow sheet as well.
  const bothPlaces = 'function AlbumOverflowSheet() { return <Heart /> }';
  assert.ok(/<Heart/.test(bothPlaces.slice(bothPlaces.indexOf('function AlbumOverflowSheet'))),
    'the duplicate-heart check must go red when the sheet keeps a copy');

  // (f) The action row back on space-between.
  const spread = "heroActions: { display: 'flex', justifyContent: 'space-between', gap: 6 }";
  const row = /heroActions: \{([^}]*)\}/.exec(spread);
  assert.ok(row && !/justifyContent: 'flex-start'/.test(row[1]),
    'the button-row check must go red when space-between comes back');
});

test.after(() => {
  try { db.close(); } catch (e) { /* already closed */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
});
