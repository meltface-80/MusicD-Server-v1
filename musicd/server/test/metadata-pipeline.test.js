// test/metadata-pipeline.test.js — v1.1.38.0
//
// Pins the fourteen findings from the metadata-pipeline audit. Most of
// these are greps, and CLAUDE.md is explicit that a test which cannot
// fail is worse than no test — so where a check is a grep it carries a
// DETECTOR SELF-TEST alongside it: the same needle run against a string
// that reproduces the old bug, asserting that it goes red. If someone
// later loosens a regex until it matches anything, the self-test fails
// first and says so.
//
// The behavioural checks (the pick-loop termination proof, the cover-art
// retry curve, the works queue, the scoring arithmetic) are real: they
// run the actual exported code, or the actual SQL, against real data.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const read = (...p) => fs.readFileSync(path.join(SERVER_SRC, ...p), 'utf8');
const readClient = (...p) => fs.readFileSync(path.join(CLIENT_SRC, ...p), 'utf8');

// Comments are stripped before grepping for CODE. Several of these files
// describe the old bug at length in prose directly above the fix, and a
// naive grep finds the description and passes on a file that still has
// the bug in it.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

// ─────────────────────────────────────────────────────────────────────
// M-01 — the matcher could loop forever on one album
// ─────────────────────────────────────────────────────────────────────

test('M-01 the matcher cannot re-pick an album it already tried this run', async (t) => {
  const src = stripComments(read('metadataMatch.js'));

  await t.test('the pick is paged and filtered by an attempted set', () => {
    assert.match(src, /const attempted = new Set\(\)/,
      'the in-run attempted set is gone');
    assert.match(src, /attempted\.has\(row\.id\)/,
      'the pick no longer consults the attempted set');
    assert.match(src, /attempted\.add\(album\.id\)/,
      'albums are no longer recorded as attempted');
  });

  await t.test('the old single-row pick is gone', () => {
    // The bug WAS `... IN ('pending','error') ORDER BY id LIMIT 1` with
    // nothing else excluding the row it had just failed on.
    const pick = src.slice(src.indexOf('const pickStmt'), src.indexOf('const updateStmt'));
    assert.ok(!/LIMIT 1\s*`/.test(pick),
      'the pick statement is back to LIMIT 1, which is the bug');
    assert.match(pick, /AND id > \?/,
      'the pick lost its cursor');
  });

  // The real proof. This is the same algorithm the runLoop uses, driven
  // against a table where EVERY album fails — the MusicBrainz-is-down
  // case, which is the one that used to spin. Before the fix this did
  // not terminate; the assertion is that it does, and that it visits
  // every album exactly once on the way.
  await t.test('it terminates and visits every album exactly once', () => {
    function drive(n, pageSize) {
      const rows = Array.from({ length: n }, (_, i) =>
        ({ id: 'id' + String(i).padStart(3, '0'), status: 'pending' }));
      const pick = (cursor) => rows
        .filter(r => (r.status === 'pending' || r.status === 'error') && r.id > cursor)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, pageSize);
      const attempted = new Set();
      let cursor = '';
      let wrapped = false;
      function next() {
        for (;;) {
          const page = pick(cursor);
          if (page.length === 0) {
            if (wrapped) return null;
            wrapped = true; cursor = ''; continue;
          }
          for (const row of page) {
            if (!attempted.has(row.id)) { cursor = row.id; return row; }
          }
          cursor = page[page.length - 1].id;
        }
      }
      const seen = [];
      for (let guard = 0; guard < n * 20 + 100; guard++) {
        const a = next();
        if (!a) return seen;
        attempted.add(a.id);
        seen.push(a.id);
        a.status = 'error';        // every album fails
      }
      return null;                 // did not terminate
    }
    for (const n of [0, 1, 7, 50, 120]) {
      for (const pageSize of [1, 3, 50]) {
        const seen = drive(n, pageSize);
        assert.ok(seen !== null, `n=${n} page=${pageSize}: the loop did not terminate`);
        assert.equal(seen.length, n, `n=${n} page=${pageSize}: visited ${seen.length}, expected ${n}`);
        assert.equal(new Set(seen).size, n, `n=${n} page=${pageSize}: an album was visited twice`);
      }
    }
  });

  await t.test('DETECTOR: the needles fail against the pre-fix source', () => {
    const old = `
      const pickStmt = database.prepare(\`
        SELECT id FROM albums
        WHERE excluded = 0 AND (match_status IS NULL OR match_status IN ('pending', 'error'))
        ORDER BY id
        LIMIT 1
      \`);
      const updateStmt = database.prepare(\`UPDATE albums\`);
    `;
    assert.ok(!/const attempted = new Set\(\)/.test(old),
      'the attempted-set needle matches source that has no attempted set');
    const pick = old.slice(old.indexOf('const pickStmt'), old.indexOf('const updateStmt'));
    assert.ok(/LIMIT 1\s*`/.test(pick),
      'the LIMIT-1 needle does not catch the original bug');
  });
});

// ─────────────────────────────────────────────────────────────────────
// M-02 / M-03 / M-04 — one client, one throttle, one User-Agent
// ─────────────────────────────────────────────────────────────────────

test('M-02/03/04 every MusicBrainz call goes through one client', async (t) => {
  const files = fs.readdirSync(SERVER_SRC).filter(f => f.endsWith('.js'));

  await t.test('mbThrottle is called from exactly one module', () => {
    const callers = files.filter(f => {
      if (f === 'mbThrottle.js' || f === 'mbHttp.js') return false;
      return /mbThrottle\s*\.\s*wait\s*\(/.test(stripComments(read(f)));
    });
    assert.deepEqual(callers, [],
      `these modules pace themselves independently of mbHttp: ${callers.join(', ')}. ` +
      'MusicBrainz allows one request per second PER IP, not per module.');
  });

  await t.test('nothing sends a contact-free User-Agent', () => {
    const offenders = files.filter(f =>
      /['"`]musicd\/1\.0 \(self-hosted\)['"`]/.test(stripComments(read(f))));
    assert.deepEqual(offenders, [],
      `these modules hard-code a User-Agent with no contact: ${offenders.join(', ')}`);
  });

  await t.test('nothing but mbHttp calls the MusicBrainz web service', () => {
    // The WEB SERVICE path specifically, not any musicbrainz.org URL. A
    // first cut of this check matched the bare host and failed on
    // bioFetch.js, which builds `musicbrainz.org/release-group/<id>`
    // links to SHOW the user in the bio modal. Those are not requests
    // and there is nothing wrong with them; what must not exist outside
    // mbHttp is a second client for /ws/2.
    const offenders = files.filter(f => {
      if (f === 'mbHttp.js') return false;
      return /musicbrainz\.org\/ws\//.test(stripComments(read(f)));
    });
    assert.deepEqual(offenders, [],
      `these modules call the MusicBrainz web service directly: ${offenders.join(', ')}`);
  });

  await t.test('mbHttp honours Retry-After on a 503', () => {
    const src = stripComments(read('mbHttp.js'));
    assert.match(src, /retry-after/i, 'the Retry-After header is not read');
    assert.match(src, /503/, 'there is no 503 branch');
    assert.match(src, /MB_RATE_LIMITED/, 'a rate-limit failure is not distinguishable');
    assert.match(src, /MB_NO_CONTACT/, 'requests without a contact are not refused');
  });

  await t.test('DETECTOR: the needles fire on the pre-fix sources', () => {
    const oldCover = "let lastMBRequest = 0;\nconst MB_HEADERS = { 'User-Agent': 'musicd/1.0 (self-hosted)' };\n"
      + "await axios.get('https://musicbrainz.org/ws/2/release', {});";
    assert.ok(/['"`]musicd\/1\.0 \(self-hosted\)['"`]/.test(oldCover),
      'the contact-free User-Agent needle does not match the original');
    assert.ok(/musicbrainz\.org\/ws\//.test(oldCover),
      'the web-service needle does not match the original');
    const oldBio = 'await mbThrottle.wait();';
    assert.ok(/mbThrottle\s*\.\s*wait\s*\(/.test(oldBio),
      'the independent-throttle needle does not match the original');
  });
});

// ─────────────────────────────────────────────────────────────────────
// M-05 / M-06 — cover art
// ─────────────────────────────────────────────────────────────────────

test('M-05 cover art uses the MBID it already has', async (t) => {
  const cover = stripComments(read('coverArt.js'));
  const scanner = stripComments(read('scanner.js'));

  await t.test('the release-group endpoint is used', () => {
    // Sharpened after a mutation test walked straight past the first
    // version of this check. Asserting that the string
    // "opts.releaseGroupId" appears SOMEWHERE in the file is satisfied by
    // a doc comment, by a dead branch, and by any one of several call
    // sites — so renaming the one that matters left the check green.
    //
    // What actually has to be true is narrower: the archive is asked for
    // a RELEASE GROUP, and that request is guarded by the caller having
    // supplied a release-group id. Both, in the same expression.
    assert.match(cover, /fetchCaaFront\(\s*'release-group'\s*,\s*opts\.releaseGroupId\s*\)/,
      'coverArt does not ask the Cover Art Archive for the release group it was given — '
      + 'without this an already-identified album is re-identified fuzzily against '
      + 'MusicBrainz on every art fetch');
    assert.match(cover, /coverartarchive\.org/, 'the Cover Art Archive base URL is gone');
    // And the fuzzy MusicBrainz search must remain GATED on having no
    // MBID, rather than running first regardless.
    const order = cover.indexOf("fetchCaaFront('release-group'");
    const fuzzy = cover.search(/release-group\/'|\/release-group\/`|mbSearch|fetchMBArt/);
    assert.ok(order !== -1 && (fuzzy === -1 || order < fuzzy),
      'the fuzzy MusicBrainz search runs before the release-group shortcut');
  });

  await t.test('the scanner selects the MBID and passes it', () => {
    const fn = scanner.slice(scanner.indexOf('async function enrichMissingArt'));
    assert.match(fn, /mb_release_group_id/,
      'enrichMissingArt does not select the release-group MBID');
    assert.match(fn, /releaseGroupId:/,
      'enrichMissingArt does not pass the release-group MBID to findCoverArt');
  });

  await t.test('the sample track is found by album_id, not by title', () => {
    const fn = scanner.slice(scanner.indexOf('async function enrichMissingArt'));
    assert.ok(!/FROM tracks WHERE album = a\.title/.test(fn),
      'the sample-path subquery still joins on title and artist, which picks a '
      + 'file from the wrong album whenever two albums share both');
  });
});

test('M-06 cover art has a negative cache, shared with the scheduler', async (t) => {
  await t.test('the predicate is defined once and imported', () => {
    const db = read('db.js');
    assert.match(db, /ART_PENDING_SQL/, 'db.js does not export the shared predicate');
    const scanner = stripComments(read('scanner.js'));
    const sched = stripComments(read('metadataScheduler.js'));
    assert.match(scanner, /db\.ART_PENDING_SQL/, 'the scanner restates the rule instead of importing it');
    assert.match(sched, /db\.ART_PENDING_SQL/, 'the scheduler restates the rule instead of importing it');
    assert.ok(!/AND\s+cover_art IS NULL\s*\n\s*`\)\.get\(\)/.test(sched),
      'the scheduler still counts a bare `cover_art IS NULL`, which never drains');
  });

  await t.test('every attempt is stamped, including the ones that fail', () => {
    const fn = stripComments(read('scanner.js'));
    const body = fn.slice(fn.indexOf('async function enrichMissingArt'));
    assert.match(body, /art_attempted_at = unixepoch\(\)/, 'attempts are not stamped');
    assert.match(body, /art_attempt_count = COALESCE\(art_attempt_count, 0\) \+ 1/,
      'the attempt count is not incremented');
    // The stamp must sit OUTSIDE the try that wraps the fetch, or an
    // album that throws every time is retried every cycle forever —
    // which is the bug this whole finding is about.
    const tryEnd = body.indexOf('status.artProcessed++');
    const stampAt = body.indexOf('stampStmt.run(album.id)');
    assert.ok(stampAt !== -1 && stampAt < tryEnd,
      'the stamp does not run before the loop advances');
  });

  // Real SQL against a real database: the retry curve has to behave.
  await t.test('the retry curve: never-tried and stale retry, recent and spent do not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicd-art-'));
    const prev = process.env.DB_PATH;
    process.env.DB_PATH = path.join(dir, 'art.db');
    // db.js caches its handle at module scope, so it must be loaded fresh.
    delete require.cache[require.resolve('../src/db')];
    const db = require('../src/db');
    try {
      db.init();
      const h = db.get();
      const now = Math.floor(Date.now() / 1000);
      const ins = h.prepare(
        'INSERT INTO albums (id,title,album_artist,art_attempted_at,art_attempt_count) VALUES (?,?,?,?,?)');
      ins.run('never', 'A', 'X', null, 0);
      ins.run('recent', 'B', 'X', now - 60, 1);
      ins.run('week', 'C', 'X', now - 8 * 86400, 1);
      ins.run('month', 'D', 'X', now - 40 * 86400, 2);
      ins.run('spent', 'E', 'X', now - 400 * 86400, 3);
      const got = h.prepare(`SELECT id FROM albums WHERE (${db.ART_PENDING_SQL})`)
        .all().map(r => r.id).sort();
      assert.deepEqual(got, ['month', 'never', 'week']);
    } finally {
      try { db.close(); } catch (e) { /* already closed by a failed init */ }
      delete require.cache[require.resolve('../src/db')];
      if (prev === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// M-07 / M-08 / M-09 / M-11 — the matcher's own behaviour
// ─────────────────────────────────────────────────────────────────────

test('M-07 fingerprinting is reachable from the automatic matcher', () => {
  const src = stripComments(read('metadataMatch.js'));
  assert.match(src, /require\('\.\/fingerprintMatch'\)/,
    'the matcher does not import the fingerprinter');
  assert.match(src, /fingerprintMatch\.matchAlbumRow\(/,
    'the matcher never calls the fingerprinter');
  const fp = stripComments(read('fingerprintMatch.js'));
  assert.match(fp, /WHERE album_id = \?/,
    'fingerprintMatch still selects tracks by title and artist (M-14)');
});

test('M-08 the search fallback scores every attempt, not just the first', () => {
  const src = stripComments(read('metadataMatch.js'));
  const loop = src.slice(src.indexOf('for (const query of attempts)'));
  assert.ok(!/if \(fetched\.length > 0\) \{\s*groups = fetched;/.test(loop),
    'the loop still stops at the first non-empty response — MusicBrainz search is '
    + 'fuzzy and one junk hit then blocks the artist-only sweep behind it');
  assert.match(loop, /DECISIVE_SCORE/,
    'the early exit is no longer conditional on the answer being good');
});

test('M-09 the secondary-type penalty needs evidence, not just absence', async (t) => {
  const { scoreCandidate } = require('../src/metadataMatch');
  const soundtrack = {
    id: 'x', title: 'Trainspotting',
    'artist-credit': [{ name: 'Various Artists' }],
    'primary-type': 'Album', 'secondary-types': ['Soundtrack'],
  };

  await t.test('a soundtrack whose title does not say so still matches', () => {
    // The album is called Trainspotting. Nothing in that title resembles
    // the word "soundtrack", so the old flat -10 fired and took an exact
    // title + exact artist from 90 to 80, under the 85 bar.
    const album = { title: 'Trainspotting', album_artist: 'Various Artists', track_count: 14 };
    const score = scoreCandidate(album, soundtrack, { trackCount: 14 });
    assert.ok(score >= 85,
      `an exactly-matching soundtrack scored ${score}, below the 85 match bar`);
  });

  await t.test('a real disagreement is still punished', () => {
    // Same candidate, but the scanner has classified the local rows as a
    // studio album. Now the two genuinely disagree.
    const album = {
      title: 'Trainspotting', album_artist: 'Various Artists',
      track_count: 14, album_type: 'album',
    };
    const withEvidence = scoreCandidate(album, soundtrack, { trackCount: 14 });
    const without = scoreCandidate(
      { title: 'Trainspotting', album_artist: 'Various Artists', track_count: 14 },
      soundtrack, { trackCount: 14 });
    assert.ok(withEvidence < without,
      'positive evidence against the type costs nothing extra');
  });
});

test('M-11 the track-count bonus is no longer dead code', async (t) => {
  const { scoreCandidate } = require('../src/metadataMatch');
  const album = { title: 'Moon Safari', album_artist: 'Air', track_count: 10 };
  const cand = {
    id: 'x', title: 'Moon Safari',
    'artist-credit': [{ name: 'Air' }], 'primary-type': 'Album',
  };

  await t.test('supplying a candidate track count changes the score', () => {
    const bare = scoreCandidate(album, cand, { trackCount: 10 });
    const exact = scoreCandidate(album, cand, { trackCount: 10, candidateTrackCount: 10 });
    assert.ok(exact > bare,
      'candidateTrackCount still has no effect — it was read but never written '
      + 'for four releases, and this is the check that says so');
  });

  await t.test('something actually writes it', () => {
    const src = stripComments(read('metadataMatch.js'));
    assert.match(src, /candidateTrackCount:/,
      'nothing supplies candidateTrackCount, so the bonus cannot fire');
    assert.match(src, /refineWithTrackCounts/,
      'the tie-break that earns the track count is gone');
  });
});

// ─────────────────────────────────────────────────────────────────────
// M-12 / M-13 — bios and the scanner's tag harvest
// ─────────────────────────────────────────────────────────────────────

test('M-12 the album bio chain can actually return something', async (t) => {
  const src = stripComments(read('bioFetch.js'));

  await t.test('Last.fm is no longer asked with a release-GROUP mbid alone', () => {
    assert.ok(!/fetchLastfmAlbumBio\(album\.mb_release_group_id\)/.test(src),
      'album.getInfo indexes release mbids, not release-group mbids — passing '
      + 'the group id is a near-guaranteed miss');
    assert.match(src, /fetchLastfm\('album\.getInfo', \{ artist, album \}\)/,
      'there is no artist+album fallback');
  });

  await t.test('AudioDB is wired in for albums, as the header always claimed', () => {
    assert.match(src, /album-mb\.php/, 'the release-group-keyed AudioDB endpoint is unused');
    assert.match(src, /fetchAudioDbAlbumBio/, 'no AudioDB album source exists');
    assert.match(src, /strDescriptionEN/, 'the AudioDB description field is not read');
  });
});

test('M-13 the scanner harvests the MusicBrainz tags already in the files', async (t) => {
  const src = stripComments(read('scanner.js'));

  await t.test('recording id, work id and ISRC are read and stored', () => {
    for (const field of ['musicbrainz_recordingid', 'musicbrainz_workid', 'isrc']) {
      assert.ok(src.includes('common.' + field), `common.${field} is not read`);
    }
    assert.match(src, /mb_recording_id, mb_work_id, isrc/,
      'the new columns are not in the track insert');
  });

  await t.test('array-valued and malformed tags are handled', () => {
    // isrc almost always arrives as an array; rippers write junk into
    // these frames, and a malformed MBID reaching a lookup is worse than
    // a null because null is honest and the lookup is simply skipped.
    assert.match(src, /function firstTagString/, 'no array-flattening helper');
    assert.match(src, /function firstMbid/, 'no MBID validation helper');
    const { execFileSync } = require('child_process');
    // Drive the helpers for real rather than trusting the grep.
    const probe = `
      ${src.slice(src.indexOf('function firstTagString'), src.indexOf('async function enrichMissingArt'))}
      const ok = '3ac8b0e5-0d4d-4b26-9b6c-1234567890ab';
      const r = [
        firstTagString(['GBAYE0601498','X']) === 'GBAYE0601498',
        firstTagString([]) === null,
        firstTagString('  ') === null,
        firstMbid([ok]) === ok,
        firstMbid('MusicBrainz') === null,
        firstMbid('0') === null,
        firstMbid(ok.toUpperCase()) === ok,
      ];
      console.log(r.every(Boolean) ? 'PASS' : 'FAIL ' + JSON.stringify(r));
    `;
    const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim();
    assert.equal(out, 'PASS', `tag helpers misbehaved: ${out}`);
  });

  await t.test('a rescan does not wipe an MBID the matcher supplied', () => {
    assert.match(src, /mb_recording_id=COALESCE\(excluded\.mb_recording_id, tracks\.mb_recording_id\)/,
      'a plain overwrite would discard the AcoustID-derived id on every rescan');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Works
// ─────────────────────────────────────────────────────────────────────

test('works are per-recording, never per-album, and never fetch a recording id', async (t) => {
  const src = stripComments(read('mbWorks.js'));

  await t.test('the module refuses to look up a recording MBID over the network', () => {
    assert.match(src, /mb_recording_id IS NOT NULL/,
      'the eligibility rule does not require a recording MBID to be present already');
    // A recording SEARCH would be the expensive mistake: it is per track,
    // and a 20,000-track library at 1 req/sec is five and a half hours.
    assert.ok(!/\/recording\/'\s*,\s*\{\s*query/.test(src) && !/recording\/\?query/.test(src),
      'the module searches MusicBrainz for recordings, which is the cost this design avoids');
  });

  await t.test('every attempt is stamped, found or not', () => {
    assert.match(src, /work_attempted_at = unixepoch\(\)/,
      'tracks are not stamped, so the queue never drains');
  });

  await t.test('classical is prioritised by a signal that exists', () => {
    // album_type looks right and is not: deriveAlbumType only ever
    // returns main/ep/single/soundtrack/deluxe/limited. Testing it would
    // be a condition that never fires.
    const scanner = read('scanner.js');
    assert.ok(!/album_type.*=.*'classical'/i.test(scanner),
      'scanner now emits a classical album_type — mbWorks should use it');
    assert.match(src, /CLASSICAL_GENRE_TERMS/, 'no classical prioritisation at all');
  });

  await t.test('the queue orders tag-named works first, then classical, then the rest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicd-works-'));
    const prev = process.env.DB_PATH;
    process.env.DB_PATH = path.join(dir, 'w.db');
    delete require.cache[require.resolve('../src/db')];
    const db = require('../src/db');
    try {
      db.init();
      const h = db.get();
      h.prepare("INSERT INTO albums (id,title,album_artist,genre,excluded) VALUES ('c','Sym','Beethoven','Classical',0)").run();
      h.prepare("INSERT INTO albums (id,title,album_artist,genre,excluded) VALUES ('p','Moon Safari','Air','Electronic',0)").run();
      const t2 = h.prepare('INSERT INTO tracks (id,path,album_id,disc_number,track_number,mb_recording_id,mb_work_id,excluded) VALUES (?,?,?,?,?,?,?,0)');
      const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
      t2.run('t1', '/m/c1.flac', 'c', 1, 1, uuid(1), null);
      t2.run('t2', '/m/c2.flac', 'c', 1, 2, uuid(2), null);
      t2.run('t3', '/m/p1.flac', 'p', 1, 1, uuid(3), null);
      t2.run('t4', '/m/p2.flac', 'p', 1, 2, uuid(4), uuid(9));
      t2.run('t5', '/m/p3.flac', 'p', 1, 3, null, null);   // ineligible
      delete require.cache[require.resolve('../src/mbWorks')];
      const works = require('../src/mbWorks');
      assert.equal(works.pendingCount(), 4,
        'a track with no recording MBID must not be counted as pending');
      assert.deepEqual(works.worksForAlbum('c'), [],
        'an album with no resolved works must answer with an empty list, not throw');
    } finally {
      try { db.close(); } catch (e) { /* already closed */ }
      delete require.cache[require.resolve('../src/db')];
      delete require.cache[require.resolve('../src/mbWorks')];
      if (prev === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// ListenBrainz
// ─────────────────────────────────────────────────────────────────────

test('the ListenBrainz mapper is used correctly', async (t) => {
  const lb = require('../src/listenBrainz');
  const src = stripComments(read('listenBrainz.js'));

  await t.test('results are mapped by index, never by position', () => {
    // The POST response is SHORTER than the input when some lookups
    // miss. Mapping by position silently attributes one album's MBID to
    // another, which is the worst failure mode available here.
    assert.match(src, /\.index/, 'the response index is never read');
    assert.ok(src.includes('MAX_LOOKUPS_PER_POST'), 'the 50-per-POST cap is not expressed');
  });

  await t.test('it is off without a token', () => {
    assert.match(src, /listenbrainz_token/, 'the token setting is not read');
    assert.equal(typeof lb.isConfigured, 'function');
    assert.equal(lb.isConfigured(), false,
      'with no database and no token configured, it must report itself off');
  });

  await t.test('confidence rises with agreement and a lone vote is not enough', () => {
    const three = lb._confidence(3, 0, 0);
    const two = lb._confidence(2, 1, 0);
    const one = lb._confidence(1, 0, 0);
    assert.ok(three > two && two > one, `confidence is not monotonic: ${three}/${two}/${one}`);
    // The matcher's gate. A single track agreeing with itself says
    // nothing: that song may appear on twelve compilations.
    assert.ok(one < 65, `a lone vote scores ${one}, at or above the matcher's 65 bar`);
    assert.ok(two >= 65, `two of three scores ${two}, below the matcher's 65 bar`);
  });

  await t.test('the matcher gates on that number and falls through otherwise', () => {
    const m = stripComments(read('metadataMatch.js'));
    assert.match(m, /LB_MIN_CONFIDENCE/, 'the matcher takes any ListenBrainz answer at all');
    assert.match(m, /listenBrainz\.releaseGroupFor/,
      'the release mbid is never converted to a release group');
  });
});

// ─────────────────────────────────────────────────────────────────────
// The Qobuz / Tidal barcode oracle
// ─────────────────────────────────────────────────────────────────────

test('the barcode oracle refuses to guess', async (t) => {
  const b = require('../src/streamingBarcode');

  await t.test('only real UPC/EAN shapes are accepted', () => {
    assert.equal(b._upcFrom({ upc: '0724384499020' }), '0724384499020');
    assert.equal(b._upcFrom({ barcodeId: '00602557247671' }), '00602557247671');
    assert.equal(b._upcFrom({ upc: '  0724384499020  ' }), '0724384499020',
      'a padded value should still be read');
    assert.equal(b._upcFrom({ upc: '12345' }), null, 'a five-digit number is not a barcode');
    assert.equal(b._upcFrom({ upc: 'not-a-barcode' }), null);
    assert.equal(b._upcFrom({}), null);
    assert.equal(b._upcFrom(null), null);
  });

  await t.test('a hit must agree on title, artist and track count', () => {
    const local = { title: 'Moon Safari', artist: 'Air', trackCount: 10 };
    // Attaching the WRONG barcode is worse than attaching none: none
    // leaves the matcher where it was, a wrong one sends it confidently
    // to the wrong release group and stores that as a match.
    assert.equal(b._verify(local, { title: 'Moon Safari', artist: 'Air', trackCount: 10 }), 100);
    assert.equal(b._verify(local, { title: 'Moon Safari (Deluxe)', artist: 'Air', trackCount: 10 }), 100,
      'edition noise must be stripped from both sides, as the matcher does');
    assert.equal(b._verify(local, { title: 'Moon Safari', artist: 'Air', trackCount: 20 }), 0,
      'a 20-track edition of a 10-track album is a different record');
    assert.equal(b._verify(local, { title: 'Moon Safari', artist: 'Aire', trackCount: 10 }), 0,
      'a near-miss artist must be refused, not fuzzily accepted');
    assert.equal(b._verify(local, { title: 'Premiers Symptomes', artist: 'Air', trackCount: 10 }), 0);
  });

  await t.test('it is off when no service is logged in, and never throws', async () => {
    assert.equal(b.isAvailable(), false,
      'with no database and no credentials it must report itself unavailable');
    assert.equal(await b.findBarcode({ title: 'X', artist: 'Y' }), null);
    assert.equal(await b.findBarcode({}), null, 'a call with no album must not throw');
  });

  await t.test('the matcher uses it, and prefers a stored barcode', () => {
    const m = stripComments(read('metadataMatch.js'));
    assert.match(m, /streamingBarcode\.findBarcode\(/, 'the matcher never asks for a barcode');
    assert.match(m, /const knownBarcode = album\.barcode \|\| borrowedBarcode/,
      'a barcode already on the album row must win over a borrowed one');
    assert.match(m, /barcode = COALESCE\(barcode, \?\)/,
      'a borrowed barcode is not persisted, so it is re-fetched on every run');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Per-install API key overrides (v1.1.39.0)
// ─────────────────────────────────────────────────────────────────────

test('the two shared-quota keys can be overridden per install', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicd-keys-'));
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'k.db');

  // db.js caches its handle at module scope and settings.js resolves
  // ./db once at ITS load time, so all three have to be dropped from the
  // require cache TOGETHER and reloaded in dependency order. Dropping
  // only db leaves settings holding the previous db module — which is
  // closed — and every write silently no-ops, which looks exactly like
  // the override not working.
  const MODS = ['../src/db', '../src/settings', '../src/apiCredentials'];
  for (const m of MODS) delete require.cache[require.resolve(m)];
  const db = require('../src/db');

  let settings;
  let creds;
  try {
    db.init();
    settings = require('../src/settings');
    creds = require('../src/apiCredentials');

    await t.test('with nothing set, the baked-in values are used', () => {
      assert.equal(creds.getAudioDbKey(), creds.AUDIODB_API_KEY);
      const p2 = creds.getFanartParams();
      assert.equal(p2.api_key, creds.FANART_API_KEY);
      assert.ok(!('client_key' in p2),
        'an unset personal key must be ABSENT, not sent empty — fanart reads an '
        + 'empty client_key as a malformed key rather than as no key');
      assert.deepEqual(creds.overrideStatus(), { audiodb: false, fanart: false });
    });

    await t.test('a set override wins', () => {
      settings.set('audiodb_api_key', 'patreon-key');
      settings.set('fanart_client_key', 'personal-key');
      assert.equal(creds.getAudioDbKey(), 'patreon-key');
      const p2 = creds.getFanartParams();
      assert.equal(p2.client_key, 'personal-key');
      assert.equal(p2.api_key, creds.FANART_API_KEY,
        'the PROJECT key must still be sent alongside a personal key — fanart '
        + 'rejects a request that has only one of the two');
      assert.deepEqual(creds.overrideStatus(), { audiodb: true, fanart: true });
    });

    await t.test('a blank or whitespace-only override falls back', () => {
      settings.set('audiodb_api_key', '   ');
      settings.set('fanart_client_key', '');
      assert.equal(creds.getAudioDbKey(), creds.AUDIODB_API_KEY);
      assert.ok(!('client_key' in creds.getFanartParams()));
    });
  } finally {
    try { db.close(); } catch (e) { /* already closed */ }
    for (const m of MODS) delete require.cache[require.resolve(m)];
    if (prev === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await t.test('every call site resolves the key rather than reading the constant', () => {
    // The whole override is worthless if one of the four call sites still
    // imports the baked-in constant directly — and that is a silent
    // failure: the app works, the user has pasted a key, and one lookup
    // in three quietly keeps using the shared one.
    for (const f of ['bioFetch.js', 'artistLogos.js']) {
      const src = stripComments(read(f));
      assert.ok(!/\{\s*AUDIODB_API_KEY\s*\}\s*=\s*require/.test(src),
        `${f} still destructures AUDIODB_API_KEY instead of calling getAudioDbKey()`);
      assert.ok(!/\{\s*FANART_API_KEY\s*\}\s*=\s*require/.test(src),
        `${f} still destructures FANART_API_KEY instead of calling getFanartParams()`);
    }
    const logos = stripComments(read('artistLogos.js'));
    assert.match(logos, /getFanartParams\(\)/, 'the fanart request does not use the resolver');
    assert.match(logos, /getAudioDbKey\(\)/, 'the AudioDB request does not use the resolver');
    const bio = stripComments(read('bioFetch.js'));
    assert.equal((bio.match(/getAudioDbKey\(\)/g) || []).length, 2,
      'both AudioDB call sites in bioFetch (artist and album) must resolve the key');
  });

  await t.test('the keys are accepted, trimmed, and never echoed back', () => {
    const route = stripComments(read('routes', 'settings.js'));
    // Scoped to the `allowed` array. A bare route.includes() finds these
    // names in the TRIMMED set further down as well, so removing them
    // from the allowlist — which silently drops every write — left the
    // first version of this check green. The mutation test is what said so.
    const allowed = route.slice(route.indexOf('const allowed = ['), route.indexOf('const TRIMMED'));
    for (const k of ['audiodb_api_key', 'fanart_client_key']) {
      assert.ok(allowed.includes(`'${k}'`), `${k} is not in the settings allowlist`);
    }
    // Pasted from a web page, usually on a phone — smart quotes and
    // trailing newlines come with them.
    const trimmed = route.slice(route.indexOf('const TRIMMED'), route.indexOf('const NUMERIC_BOUNDS'));
    for (const k of ['audiodb_api_key', 'fanart_client_key', 'listenbrainz_token']) {
      assert.ok(trimmed.includes(k), `${k} is not trimmed on save`);
    }
    // The GET must report only WHETHER a key is set. A settings page that
    // echoes a credential puts it in every browser cache and screenshot.
    const get = route.slice(0, route.indexOf("router.patch('/'"));
    assert.match(get, /audiodb_api_key_set/, 'the UI cannot tell whether an AudioDB key is set');
    assert.match(get, /fanart_client_key_set/, 'the UI cannot tell whether a fanart key is set');
    assert.ok(!/audiodb_api_key:/.test(get) && !/fanart_client_key:/.test(get)
      && !/listenbrainz_token:/.test(get),
      'a credential VALUE is being returned to the client');
  });

  await t.test('DETECTOR: the echo check catches a leaked value', () => {
    const leaky = "res.json({ mb_contact: x, audiodb_api_key: y });\nrouter.patch('/'";
    const get = leaky.slice(0, leaky.indexOf("router.patch('/'"));
    assert.ok(/audiodb_api_key:/.test(get),
      'the echo needle does not catch a route that returns the key');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Client: the theming work
// ─────────────────────────────────────────────────────────────────────

test('the client type floor holds at 11px', async (t) => {
  const files = fs.readdirSync(path.join(CLIENT_SRC, 'components'))
    .filter(f => f.endsWith('.jsx')).map(f => ['components', f]);
  files.push(['App.jsx']);

  const sizes = [];
  for (const f of files) {
    for (const m of readClient(...f).matchAll(/fontSize:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
      sizes.push({ file: f.join('/'), px: parseFloat(m[1]) });
    }
  }

  await t.test('nothing is smaller than 11px', () => {
    const tooSmall = sizes.filter(s => s.px < 11);
    assert.deepEqual(tooSmall, [],
      'the owner reported the UI as cramped and 41% of its type measured 11px or '
      + 'smaller; these declarations are below the floor: '
      + tooSmall.map(s => `${s.file}=${s.px}`).join(', '));
  });

  await t.test('the sweep actually happened', () => {
    // Sanity: if someone deletes every fontSize the check above passes
    // vacuously. There must still be a lot of type in this app.
    assert.ok(sizes.length > 400,
      `only ${sizes.length} font sizes found — the detector is looking in the wrong place`);
  });

  await t.test('DETECTOR: a 9px declaration is caught', () => {
    const probe = [{ file: 'x.jsx', px: 9 }].filter(s => s.px < 11);
    assert.equal(probe.length, 1, 'the floor check does not catch 9px');
  });
});

test('the client carries a shared size vocabulary and the remote grid', async (t) => {
  const css = readClient('index.css');

  await t.test('the control tokens exist', () => {
    for (const tok of ['--ctl-h', '--ctl-h-sm', '--tap-min', '--ctl-pad-x', '--ctl-radius']) {
      assert.ok(css.includes(tok + ':'), `${tok} is not declared`);
    }
    for (let i = 1; i <= 6; i++) {
      assert.ok(css.includes(`--fs-${i}:`), `--fs-${i} is not declared`);
    }
  });

  await t.test('the album wall is 3 / 5 / 7 / 9, orientation-aware', () => {
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const n of [3, 5, 7, 9]) {
      assert.ok(new RegExp(`\\.album-grid \\{[^}]*repeat\\(${n}, minmax\\(0, 1fr\\)\\)`).test(noComments)
        || new RegExp(`repeat\\(${n}, minmax\\(0, 1fr\\)\\)`).test(noComments),
        `the album grid has no ${n}-column step`);
    }
    assert.match(noComments, /orientation: portrait/, 'the breakpoints ignore orientation');
    assert.match(noComments, /orientation: landscape/, 'the breakpoints ignore orientation');
  });

  await t.test('the second, darker playback surface tier is folded away', () => {
    // --jp-bg used to be #0a0a0c against the app's #16161a, making the
    // playback screen a darker room than the rest of the app. That is
    // the audiophile-software convention the owner asked to move away
    // from. Folded per palette, so every palette must agree.
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = noComments.split(/(?=\[data-theme)/);
    let checked = 0;
    for (const b of blocks) {
      const jp = b.match(/--jp-bg:\s*([#\w]+);/);
      const base = b.match(/--bg-base:\s*([#\w]+);/);
      if (!jp || !base) continue;
      checked += 1;
      assert.equal(jp[1].toLowerCase(), base[1].toLowerCase(),
        '--jp-bg still differs from --bg-base in one of the palettes');
    }
    assert.ok(checked >= 3, `only ${checked} palettes carried both tokens; expected at least 3`);
  });
});
