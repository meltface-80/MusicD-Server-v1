// Bandcamp Daily release cards, and why they all had the same cover.
//
// Two separate faults in one expression, both reproducible, both pushing the
// same way:
//
//   1. The candidate chain was built as
//        $a.find('img').first().add($a.next('img')).add(…).first()
//      and read as "try these in order". It is not. Cheerio's .add(), like
//      jQuery's, returns the combined set in DOCUMENT order, so .first()
//      yields whichever candidate sits earliest in the page rather than the
//      first strategy that matched. A badge above the anchor won over the
//      cover inside it.
//
//   2. The widest fallback was $a.closest('figure, article, section, li, div').
//      Bandcamp Daily's lists are mostly prose with bare album links, so the
//      nearest matching ancestor is the article body — and .find('img')
//      .first() on that is the article's hero. Every release on the page
//      resolved to it, which is the reported symptom exactly.
//
// The rule now: a release card contains exactly ONE album link, so the search
// walks up only while the ancestor still holds just this anchor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'news.js'), 'utf8');

// Lift the finder rather than require()ing news.js, which opens the database
// and starts a refresh timer. The real source text, not a copy — the
// container-id.test.js technique.
const finderSrc = SRC.slice(SRC.indexOf('const ALBUM_ANCHOR_SEL'),
                            SRC.indexOf('function extractBandcampReleaseCards'));
assert.ok(finderSrc.includes('findCoverForAnchor'), 'could not lift findCoverForAnchor');
const findCoverForAnchor = new Function(finderSrc + '; return findCoverForAnchor;')();

// Every cover the finder returns for a fragment, in anchor order.
function coversIn(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('a[href*=".bandcamp.com/album/"]').each((_, el) => {
    out.push(findCoverForAnchor($, $(el)));
  });
  return out;
}

test('a card gets its own cover, not the page\'s', async (t) => {
  await t.test('prose article: the hero is not handed to every release', () => {
    // THE bug. Two bare album links in paragraphs under an article body whose
    // first image is the hero. The old chain returned HERO.jpg for both.
    const covers = coversIn(`<div class="article-body">
      <img src="HERO.jpg">
      <p>Try <a href="https://alpha.bandcamp.com/album/one">One</a>.</p>
      <p>And <a href="https://beta.bandcamp.com/album/two">Two</a>.</p>
    </div>`);
    assert.deepEqual(covers, [null, null],
      'the article hero is being served as an album cover');
  });

  await t.test('an image inside the anchor beats one earlier in the card', () => {
    // The .add() document-order fault: BADGE.jpg precedes the anchor, so the
    // old chain preferred it over the cover the anchor actually wraps.
    const covers = coversIn(`<div class="card">
      <img src="BADGE.jpg">
      <a href="https://alpha.bandcamp.com/album/one"><img src="REAL_COVER.jpg">One</a>
    </div>`);
    assert.deepEqual(covers, ['REAL_COVER.jpg']);
  });

  await t.test('properly structured cards keep their own covers', () => {
    const covers = coversIn(`<div>
      <div class="c"><a href="https://alpha.bandcamp.com/album/one"><img src="C1.jpg">One</a></div>
      <div class="c"><a href="https://beta.bandcamp.com/album/two"><img src="C2.jpg">Two</a></div>
    </div>`);
    assert.deepEqual(covers, ['C1.jpg', 'C2.jpg']);
  });

  await t.test('a cover beside the link is still found', () => {
    const covers = coversIn(`<ul>
      <li><img src="C1.jpg"><a href="https://alpha.bandcamp.com/album/one">One</a></li>
      <li><img src="C2.jpg"><a href="https://beta.bandcamp.com/album/two">Two</a></li>
    </ul>`);
    assert.deepEqual(covers, ['C1.jpg', 'C2.jpg']);
  });

  await t.test('background-image cards still work, per card', () => {
    const covers = coversIn(`<div>
      <figure style="background-image:url('BG1.jpg')"><a href="https://alpha.bandcamp.com/album/one">One</a></figure>
      <figure style="background-image:url('BG2.jpg')"><a href="https://beta.bandcamp.com/album/two">Two</a></figure>
    </div>`);
    assert.deepEqual(covers, ['BG1.jpg', 'BG2.jpg']);
  });

  await t.test('a shared container is not mined for images', () => {
    // Two album links under one figure means the figure is a grouping, and
    // its image belongs to neither album on its own.
    const covers = coversIn(`<figure>
      <img src="SECTION_BANNER.jpg">
      <a href="https://alpha.bandcamp.com/album/one">One</a>
      <a href="https://beta.bandcamp.com/album/two">Two</a>
    </figure>`);
    assert.deepEqual(covers, [null, null],
      'a banner over two albums is being used as both their covers');
  });

  await t.test('lazy-loaded covers are read from their data attributes', () => {
    for (const attr of ['data-src', 'data-lazy-src', 'data-original']) {
      const covers = coversIn(
        `<div class="c"><a href="https://a.bandcamp.com/album/x"><img ${attr}="LAZY.jpg">X</a></div>`);
      assert.deepEqual(covers, ['LAZY.jpg'], `${attr} was not read`);
    }
  });

  await t.test('the walk up is bounded', () => {
    // Deeply nested wrappers must not let the search climb to the page.
    const covers = coversIn(`<div><img src="PAGE.jpg">
      <div><div><div><div><div><div>
        <a href="https://alpha.bandcamp.com/album/one">One</a>
      </div></div></div></div></div></div>
    </div>`);
    assert.deepEqual(covers, [null], 'the search climbed out of the card');
  });

  await t.test('an anchor with nothing around it yields null, not a throw', () => {
    assert.deepEqual(coversIn('<a href="https://a.bandcamp.com/album/x">X</a>'), [null]);
  });
});

test('the parser refuses to publish a cover it used twice', async (t) => {
  // Belt and braces: the finder is meant to prevent this by construction, but
  // an unfamiliar layout should degrade to "no cover" rather than to "the same
  // cover on every row", which is what was reported.
  const body = SRC.slice(SRC.indexOf('function extractBandcampReleaseCards'));

  await t.test('duplicates are detected across the article', () => {
    assert.match(body, /const shared = new Set\(\[\.\.\.seen\.entries\(\)\]\.filter\(\(\[, n\]\) => n > 1\)/,
      'nothing checks whether one image landed on several releases');
  });

  await t.test('the card survives, only the image is cleared', () => {
    // Dropping the release would quietly shrink New Releases; the client
    // already draws a disc placeholder for a null image_url.
    assert.match(body, /r\.image_url = null; cleared\+\+/,
      'a duplicated cover removes the whole release instead of just the art');
    assert.ok(!/out\.filter\(r => !shared/.test(body),
      'cards are still being dropped for a shared image');
  });

  await t.test('a release with no cover is still published', () => {
    assert.match(body, /image_url:\s*img \|\| null/,
      'image_url can still be undefined rather than an explicit null');
    assert.ok(!/if \(!img\) return;/.test(body),
      'the parser still discards a release it could not find a cover for');
  });

  await t.test('it says so in the log rather than silently', () => {
    assert.match(body, /page assets, not covers/);
  });
});

test('the old chain is gone from every parser, not merely bypassed', () => {
  // .add() looks like "or else" and is not. The Bandcamp parser was the one
  // reported, but the Qobuz parser had the identical expression twice — once
  // for the cover and once for the artist link. Fixing only the reported site
  // is the partial migration CLAUDE.md warns about, so this checks the whole
  // file rather than one function.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
                  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  const chains = code.match(/\.add\(\$a\.[^\n]*/g) || [];
  assert.deepEqual(chains, [],
    'a .add() candidate chain is back — it returns document order, not ' +
    'priority: ' + chains.join(' | '));

  assert.ok(!/closest\('figure, article, section, li, div'\)\.find\('img'\)/.test(code),
    'the over-broad closest() fallback is back — it reaches the article hero');

  // And the replacement is actually in use at both parsers.
  assert.match(code, /findCoverForAnchor\(\$, \$a\)/, 'the Bandcamp parser lost its finder');
  assert.match(code, /imgSrc\(\$a\.find\('img'\)\.first\(\)\)/,
    'the Qobuz parser is no longer picking its cover in written order');
});
