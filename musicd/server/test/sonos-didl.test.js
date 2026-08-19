// The DIDL-Lite metadata sent to Sonos with SetAVTransportURI.
//
// It never declared a duration on its <res> element, so every item looked
// to Sonos like a stream of unknown length — the shape of thing it reports
// unreliable transport positions for. Track metadata also goes into this
// XML verbatim, so escaping is a correctness requirement, not a nicety:
// one ampersand in an artist name and Sonos gets a malformed document.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const xml2js = require('xml2js');

// Stub streamFormat before sonos.js loads it. buildDidl only needs the mime
// type from it, but the real predictStreamFormat reads the renderer's DSP
// profile from SQLite and throws "Database not initialized" outside a
// running server. Stubbing keeps this a test of the DIDL document rather
// than of the whole stream pipeline. (Same approach as the sibling repo's
// didl test, which stubs its soap module for the same reason.)
const SF = require.resolve('../src/streamFormat');
require.cache[SF] = {
  id: SF, filename: SF, loaded: true,
  exports: { predictStreamFormat: () => ({ mime: 'audio/flac' }) },
};

const { buildDidl, didlDuration } = require('../src/renderers/sonos');

test('durations are formatted as H:MM:SS.mmm', async (t) => {
  for (const [seconds, want] of [
    [529.2, '0:08:49.200'],
    [3661.5, '1:01:01.500'],
    [59.999, '0:00:59.999'],
    [1, '0:00:01.000'],
  ]) {
    await t.test(`${seconds}s -> ${want}`, () => {
      assert.equal(didlDuration(seconds), want);
    });
  }
});

test('an unknown duration yields no attribute at all', async (t) => {
  // Sonos parses an empty or zero duration as 0:00:00, which is worse than
  // omitting it — the transport then believes the track has no length.
  for (const bad of [0, null, undefined, -5, NaN, 'abc', '']) {
    await t.test(`${JSON.stringify(bad)} -> null`, () => {
      assert.equal(didlDuration(bad), null);
    });
  }
});

const TRACK = {
  title: 'Just Another Story',
  artist: 'Jamiroquai',
  album: 'Return Of The Space Cowboy',
  duration: 529.2,
};

test('the DIDL Sonos receives', async (t) => {
  const didl = buildDidl(TRACK, 'http://10.0.0.5/api/stream/abc?renderer=sonos%3A10.0.0.9',
                         'sonos:10.0.0.9', 44100);

  await t.test('declares the track duration', () => {
    assert.match(didl, /duration="0:08:49\.200"/);
  });
  await t.test('parses as XML', async () => {
    const p = await xml2js.parseStringPromise(didl, { explicitArray: false, mergeAttrs: true });
    assert.equal(p['DIDL-Lite'].item['dc:title'], 'Just Another Story');
    assert.equal(p['DIDL-Lite'].item['upnp:album'], 'Return Of The Space Cowboy');
  });
});

test('a track of unknown length omits the attribute and stays valid', async () => {
  const didl = buildDidl({ title: 'X', duration: null }, 'http://h/s', 'sonos:1', 44100);
  assert.ok(!/duration=/.test(didl));
  await xml2js.parseStringPromise(didl);
});

test('hostile metadata is escaped, not injected', async () => {
  // & and < in a title would otherwise close the document early and Sonos
  // would reject the whole SetAVTransportURI.
  const didl = buildDidl(
    { title: 'Rock & Roll <3', artist: 'AC/DC "The" <Band>', album: "A'B", duration: 200 },
    'http://h/s?a=1&b=2', 'sonos:1', 44100);
  const p = await xml2js.parseStringPromise(didl, { explicitArray: false, mergeAttrs: true });
  assert.equal(p['DIDL-Lite'].item['dc:title'], 'Rock & Roll <3');
  assert.equal(p['DIDL-Lite'].item['dc:creator'], 'AC/DC "The" <Band>');
});

test('the stream URL survives intact', async () => {
  const url = 'http://10.0.0.5/api/stream/abc?renderer=sonos%3A10.0.0.9&v=17';
  const didl = buildDidl(TRACK, url, 'sonos:10.0.0.9', 44100);
  const p = await xml2js.parseStringPromise(didl, { explicitArray: false, mergeAttrs: true });
  const res = p['DIDL-Lite'].item.res;
  assert.equal(typeof res === 'string' ? res : res._, url);
});
