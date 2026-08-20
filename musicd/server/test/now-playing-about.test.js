// The About-the-Track panel is gone (v1.1.22.0).
//
// A chevron sat pinned to the bottom-centre of the Now Playing screen and
// opened a full-screen panel: artist bio, then Title / Album / Duration /
// Genre / Artist / Audio Format. Everything but the bio was already on the
// screen the chevron was drawn over, and the bio has its own route in from
// the album and artist screens. The owner asked for the whole feature to go.
//
// A removal needs pinning as much as a fix does. The panel had six separate
// footholds in one 2,500-line file — state, a gesture ref, a member of the
// overlay guard, the render site, the chevron button, the component itself
// and seventeen style keys — and this project has shipped a half-finished
// removal before (the album-thumbnail long-press menu, which left its state
// and styles behind and is pinned by artwork-longpress.test.js for the same
// reason).
//
// The guard assertion is the one that matters most: showAbout was one member
// of a boolean chain that also suppresses the queue swipe for the volume
// popover, DSP, the renderer modal and the share card. Deleting the whole
// condition instead of the one term would silently re-enable a gesture that
// fights every remaining overlay.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const read = (...p) => fs.readFileSync(path.join(CLIENT_SRC, ...p), 'utf8');
// Comments explain; they do not implement. The panel is described in several
// of them by name, so structure is asserted on the stripped source.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('nothing of the About panel is left in NowPlayingFullScreen', async (t) => {
  const raw = read('components', 'NowPlayingFullScreen.jsx');
  const src = code(raw);

  await t.test('no state, no ref, no component, no render site', () => {
    const orphans = [
      'showAbout', 'setShowAbout',      // the open/close state
      'aboutSwipeStartY',               // the swipe-up gesture origin
      'AboutTrackOverlay', 'AboutRow',  // the panel and its field rows
    ];
    const left = orphans.filter(o => src.includes(o));
    assert.deepEqual(left, [], 'left behind by the removal: ' + left.join(', '));
  });

  await t.test('no chevron button', () => {
    assert.doesNotMatch(src, /About this track/,
      'the chevron button is still rendered');
  });

  await t.test('no style keys left in the map', () => {
    // Seventeen of them. A dead key is invisible — nothing warns, nothing
    // breaks, and the next person reading the map believes the panel exists.
    const smap = src.slice(src.indexOf('const s = {'));
    const dead = [...smap.matchAll(/^ {2}(about[A-Za-z0-9]*):/gm)].map(m => m[1]);
    assert.deepEqual(dead, [], 'dead About styles: ' + dead.join(', '));
  });

  await t.test('the swipe guard kept its other members', () => {
    // showAbout was one term of a chain. Removing the condition rather than
    // the term would let the queue swipe fire underneath every other overlay.
    const guard = /if \(([^)]*shareCard)\) \{\s*screenTouchRef\.current\.active = false/.exec(src);
    assert.ok(guard, 'the overlay guard on the queue swipe is gone');
    for (const term of ['showVolume', 'showRendererLocal', 'showDsp',
                        'showDeviceSettings', 'showOverflow', 'shareCard']) {
      assert.ok(guard[1].includes(term), `the swipe guard no longer checks ${term}`);
    }
  });

  await t.test('the format strip the chevron sat under is still there', () => {
    // Only the chevron was asked for. The FLAC / 16-bit / 44.1kHz line above
    // it is a different thing that happened to share a comment.
    assert.match(src, /style=\{s\.formatStrip\}/);
    assert.match(src, /<FormatBadge/);
    const smap = src.slice(src.indexOf('const s = {'));
    assert.match(smap, /^ {2}formatStrip:/m);
    assert.match(smap, /^ {2}formatText:/m);
  });

  await t.test('the icon it used is no longer imported', () => {
    // ChevronUp was the bio's expand arrow and had no other caller. An import
    // with no use is the tell that a removal stopped halfway.
    const imports = /import \{([^}]*)\} from 'lucide-react'/.exec(raw);
    assert.ok(imports, 'the lucide import is gone');
    const names = imports[1].split(',').map(n => n.split(' as ').pop().trim());
    assert.equal(names.includes('ChevronUp'), false,
      'ChevronUp is imported but nothing renders it any more');
    // ChevronDown has another caller (the queue's disclosure arrow) and must
    // survive — proving this test distinguishes the two rather than just
    // asserting "no chevrons".
    assert.ok(names.includes('ChevronDown'));
    assert.match(src, /<ChevronDown /);
  });
});

test('the artist bio the panel showed is still reachable', () => {
  // The panel was the only place the bio appeared on the Now Playing screen,
  // but not the only place it appears. Removing a surface is fine; removing
  // the last route to a feature is not, and would need saying out loud.
  for (const f of ['AlbumDetail.jsx', 'ArtistAlbums.jsx']) {
    const src = read('components', f);
    assert.match(src, /import BioModal from '\.\/BioModal'/, `${f} lost its bio route`);
    assert.match(src, /<BioModal/, `${f} imports BioModal but never renders it`);
  }
});
