// Music news aggregator (#30, #30.1, #30.4)
// =================================
// Periodically fetches RSS feeds and HTML pages from configured sources and
// caches items in the news_items table. The home screen pulls from the
// cache via the /api/news/feed endpoint — never hits the upstream feeds
// directly.
//
// Sources: Pitchfork (RSS — news, album reviews, The Pitch), Qobuz Magazine
// (HTML scrape with embedded album cards), Bandcamp Daily (HTML scrape with
// embedded album cards). Each source has its own parser since the DOM
// shapes differ; there's no useful generic "find article cards" abstraction
// across publishers. The FEEDS array is the only place to touch when
// adding another source.
//
// Refresh model
// -------------
// One refresh loop kicked off at boot, fires every 30 min. Each tick:
//   1. For each feed: fetch XML over HTTPS (axios), parse, normalise items
//   2. Upsert into news_items by URL (UNIQUE constraint dedupes silently)
//   3. Prune anything older than ~30 days so the table stays bounded
//
// Failures are non-fatal — one feed being down doesn't poison others.
// Errors are logged with the feed name so they're diagnosable.
//
// Manual refresh
// --------------
// /api/news/refresh kicks an immediate cycle. Rate-limited to once per
// minute so a stuck client polling refresh can't DoS Pitchfork on our
// behalf.

const axios = require('axios');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const crypto = require('crypto');
const db = require('./db');

// Feed configurations.
//
// kind:
//   'rss'  — XML RSS feed (xml2js parses the channel/item tree)
//   'html' — public web page (cheerio parses the article cards)
//
// The HTML scrapers each have a per-source parser function (parseQobuzHtml
// etc) keyed by the `parser` field. They're per-source because each site
// has its own DOM structure — there's no useful generic "find the article
// cards" abstraction across publishers.
//
// Pitchfork: open RSS feeds, no auth required, three editorial channels
// merged into a single feed for the home screen.
//
// Qobuz: no public RSS, no auth-free API. We scrape their public magazine
// section page like a browser would. Less frequent updates than Pitchfork
// (a few articles a week vs many per day) but editorial-quality content
// covering new releases. See parseQobuzHtml for the scraping logic.
// ── Which rows the Home screen may show ───────────────────────────────
//
// v1.1.20.0. Every one of these is OFF on a new install, and off means off:
// no upstream request is made, and the refresh timer does not exist. Turning
// the last one off stops the timer again. See newsEnabled()/applyPrefs().
//
// The four keys are the four rows a user actually sees, not the five feeds
// behind them — "Bandcamp new releases" and "Bandcamp reviews" both come out
// of one crawl of daily.bandcamp.com, and the three Pitchfork RSS feeds all
// land in the same articles list.
const NEWS_PREF_KEYS = ['qobuzReleases', 'bandcampReleases', 'pitchforkArticles', 'bandcampArticles'];
const NEWS_PREFS_SETTING = 'home_news_sources';

const FEEDS = [
  {
    source:  'pitchfork',
    section: 'News',
    url:     'https://pitchfork.com/feed/feed-news/rss',
    kind:    'rss',
    needs:   ['pitchforkArticles'],
  },
  {
    source:  'pitchfork',
    section: 'Album Reviews',
    url:     'https://pitchfork.com/feed/feed-album-reviews/rss',
    kind:    'rss',
    needs:   ['pitchforkArticles'],
  },
  {
    source:  'pitchfork',
    section: 'The Pitch',
    url:     'https://pitchfork.com/feed/feed-the-pitch/rss',
    kind:    'rss',
    needs:   ['pitchforkArticles'],
  },
  {
    source:  'qobuz',
    section: 'Magazine',
    url:     'https://www.qobuz.com/us-en/magazine/section/news',
    kind:    'html',
    parser:  'qobuz',
    needs:   ['qobuzReleases'],
  },
  {
    // Bandcamp Daily — editorial features, lists, artist spotlights.
    // No native RSS (they removed it years ago). We scrape the homepage
    // to find article URLs, then fetch each article body to extract
    // embedded album mentions for the releases row + the article itself
    // for the articles list. Same two-step crawl as Qobuz, different DOM.
    source:  'bandcamp',
    section: 'Daily',
    url:     'https://daily.bandcamp.com/',
    kind:    'html',
    parser:  'bandcamp',
    // One crawl feeds two rows, so this feed runs if EITHER is on — and the
    // album-page resolution inside it is skipped when only the articles are
    // wanted, which is the expensive half.
    needs:   ['bandcampReleases', 'bandcampArticles'],
  },
];

// How often we hit the upstream feeds. 30 min is a good balance between
// freshness (Pitchfork posts new news several times a day) and being a
// good citizen (we don't want to hammer their servers from every musicd
// instance every minute).
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

// Items older than this are pruned on every refresh so the table doesn't
// grow without bound. 30 days of music news is plenty for a "what's new"
// section — anything older the user can find on the publisher's site.
const PRUNE_AFTER_SEC = 30 * 24 * 60 * 60;

// Manual refresh rate limit. /api/news/refresh respects this so the UI's
// "refresh" button can't be spammed into a denial-of-service against the
// upstream feeds.
const MANUAL_REFRESH_COOLDOWN_MS = 60 * 1000;
let _lastManualRefresh = 0;
let _refreshInFlight = null;
let _refreshTimer = null;

// xml2js with explicitArray=false gives us a much friendlier object shape
// — single elements aren't wrapped in 1-element arrays. mergeAttrs folds
// XML attributes into the parent so `<media:thumbnail url="...">` becomes
// `{ url: '...' }` rather than `{ $: { url: '...' } }`.
const xmlParser = new xml2js.Parser({
  explicitArray: false,
  mergeAttrs:    true,
  trim:          true,
});

function sha1Short(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 40);
}

// Strip HTML tags + decode common entities. We're not building a full HTML
// parser here — RSS descriptions are usually a paragraph of HTML and a
// regex pass is fine. We do this because the description often has <p>
// and <a> tags that would render as raw "<p>" text in the UI.
function stripHtml(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Pitchfork's feed embeds the hero image as <media:thumbnail url="..."/>
// (xml2js with mergeAttrs gives us the url straight). Some feeds also use
// <enclosure url="..." type="image/..."/>. Try both, prefer media:thumbnail
// (it's their explicit choice and tends to be higher-res).
function extractImage(item) {
  const media = item['media:thumbnail'];
  if (media) {
    if (typeof media === 'string') return media;
    if (Array.isArray(media)) return media[0]?.url || null;
    if (typeof media === 'object' && media.url) return media.url;
  }
  const media2 = item['media:content'];
  if (media2) {
    if (Array.isArray(media2)) {
      const img = media2.find(m => (m.type || '').startsWith('image/'));
      if (img) return img.url;
    } else if (media2.url && (media2.type || '').startsWith('image/')) {
      return media2.url;
    }
  }
  const enc = item.enclosure;
  if (enc && enc.url && (enc.type || '').startsWith('image/')) {
    return enc.url;
  }
  return null;
}

// Parse an RSS pubDate ("Wed, 23 Apr 2026 14:30:00 +0000") into unix
// seconds. Date.parse handles the standard RFC 2822 format that RSS uses.
// If a feed sends something weird we fall back to "now" so the item still
// appears (rather than being silently dropped).
function parseDate(s) {
  if (!s) return Math.floor(Date.now() / 1000);
  const t = Date.parse(s);
  if (isNaN(t)) return Math.floor(Date.now() / 1000);
  return Math.floor(t / 1000);
}

// Normalise one RSS item into our row shape. Returns null if the item is
// missing essentials (title or url) — better to drop than to insert junk.
function normaliseItem(item, source, section) {
  const title = stripHtml(item.title || '');
  const url   = (item.link || '').trim();
  if (!title || !url) return null;

  const description = item.description || item['content:encoded'] || '';
  const excerpt = stripHtml(description).slice(0, 280);

  return {
    id:           sha1Short(url),
    kind:         'article',
    source,
    section,
    title,
    artist:       null,
    excerpt,
    url,
    image_url:    extractImage(item),
    published_at: parseDate(item.pubDate || item['dc:date']),
    fetched_at:   Math.floor(Date.now() / 1000),
  };
}

// Fetch + parse one feed. Returns array of normalised items, or empty
// on any failure (logged but not thrown — one bad feed shouldn't sink
// the whole refresh).
//
// Dispatch on feed.kind:
//   'rss'  → fetch URL, xml2js parse, return items
//   'html' → per-source scraper. Each HTML source does a two-step crawl:
//            listing page → article URLs → fetch article bodies →
//            extract embedded album cards. Different DOM per source so
//            the parsers are separate functions.
async function fetchFeed(feed, prefs = null) {
  try {
    if (feed.kind === 'html' && feed.parser === 'qobuz')    return await fetchQobuz(feed);
    if (feed.kind === 'html' && feed.parser === 'bandcamp') return await fetchBandcamp(feed, prefs);
    // Default: RSS
    return await fetchRss(feed);
  } catch (e) {
    console.warn(`[news] ${feed.source}/${feed.section} fetch failed: ${e.message}`);
    return [];
  }
}

// Generic HTTP get with sensible defaults. Returns body text or null on
// failure (caller logs).
async function httpGet(url) {
  const r = await axios.get(url, {
    timeout: 15_000,
    headers: {
      // Identify honestly. Pretending to be a browser is unnecessary and
      // makes anti-abuse easier to argue against — we ARE a feed reader.
      'User-Agent':      'musicd/1.0 (RSS / public web reader)',
      // Some sites gate on Accept-Language; English is fine.
      'Accept-Language': 'en-US,en;q=0.9',
    },
    responseType: 'text',
    transformResponse: [v => v],
  });
  if (!r.data || typeof r.data !== 'string') return null;
  return r.data;
}

// ── RSS path (Pitchfork) ──────────────────────────────────────────────
async function fetchRss(feed) {
  const xml = await httpGet(feed.url);
  if (!xml) {
    console.warn(`[news] ${feed.source}/${feed.section}: empty response`);
    return [];
  }
  const parsed = await xmlParser.parseStringPromise(xml);
  const items = parsed?.rss?.channel?.item;
  if (!items) {
    console.warn(`[news] ${feed.source}/${feed.section}: no items in feed`);
    return [];
  }
  const list = Array.isArray(items) ? items : [items];
  return list
    .map(it => normaliseItem(it, feed.source, feed.section))
    .filter(Boolean);
}

// ── Qobuz two-step crawl ──────────────────────────────────────────────
//
// Step 1: fetch the magazine listing page, find recent article URLs.
// Step 2: for each article URL (capped at 5), fetch the article body
//         and extract embedded album release cards.
//
// We cap at 5 listing articles to limit downstream HTTP load — Qobuz
// publishes a few articles a week, and 5 articles' worth of embedded
// album mentions is plenty for a "new releases" row. Higher caps make
// each refresh cycle slower without obvious benefit.
//
// Album cards inside Qobuz articles take a few different shapes
// (link cards, embedded player widgets, plain text mentions). We only
// trust ones with: clear /album/ URL, recognizable cover image, and
// inferrable title+artist. Items missing those are silently skipped.
async function fetchQobuz(feed) {
  const listingHtml = await httpGet(feed.url);
  if (!listingHtml) {
    console.warn(`[news] ${feed.source}/${feed.section}: empty listing response`);
    return [];
  }
  const articleUrls = extractQobuzArticleUrls(listingHtml).slice(0, 5);
  if (articleUrls.length === 0) {
    console.warn(`[news] ${feed.source}/${feed.section}: no article URLs found on listing page (DOM may have changed)`);
    return [];
  }
  console.log(`[news] qobuz: found ${articleUrls.length} articles to scrape for releases`);

  // Fetch article bodies in parallel — bounded concurrency would be safer
  // for very large fan-outs, but 5 in flight is fine for any modern host.
  const bodies = await Promise.all(articleUrls.map(async url => {
    try {
      const html = await httpGet(url);
      return { url, html };
    } catch (e) {
      console.warn(`[news] qobuz article fetch failed: ${url}: ${e.message}`);
      return { url, html: null };
    }
  }));

  // Extract release cards from each article. Dedupe across articles —
  // the same album can be mentioned in "Quarter Notes" and the monthly
  // guide and we only want it once.
  const seen = new Set();
  const releases = [];
  for (const { url: articleUrl, html } of bodies) {
    if (!html) continue;
    const cards = extractQobuzReleaseCards(html, articleUrl);
    for (const c of cards) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      releases.push(c);
    }
  }
  if (releases.length === 0) {
    // Common failure mode: Qobuz renders album cards via JS so server-side
    // HTML doesn't contain them. We fall back to article-as-tile so the
    // user at least sees something from Qobuz Magazine. Better than nothing
    // and visibly different so the user knows the rich-card scrape didn't
    // work today.
    console.warn(`[news] qobuz: no album cards extracted from any article — falling back to article tiles`);
    return bodies
      .filter(b => b.html)
      .map(({ url, html }) => qobuzArticleAsTile(url, html))
      .filter(Boolean);
  }
  console.log(`[news] qobuz: ${releases.length} unique release cards extracted`);
  return releases;
}

// Find article URLs on Qobuz Magazine's listing page. Their article URLs
// follow the pattern /<locale>/magazine/story/YYYY/MM/DD/slug/ — we
// grab any href matching that and dedupe.
function extractQobuzArticleUrls(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('a[href*="/magazine/story/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/\/magazine\/story\//.test(href)) return;
    const abs = href.startsWith('http')
      ? href
      : new URL(href, 'https://www.qobuz.com').toString();
    // Strip query/hash — same article with different tracking suffixes
    // is the same article.
    const clean = abs.split('?')[0].split('#')[0];
    urls.add(clean);
  });
  return Array.from(urls);
}

// Extract embedded album release cards from a Qobuz article body.
//
// Qobuz embeds album mentions as <a href="/<locale>/album/<slug>/<id>">
// usually wrapped around or near a cover image. We look for anchors
// matching the album URL pattern and try to extract the title + artist
// + cover from the surrounding DOM.
//
// Strategy:
//   1. Find every album-link anchor.
//   2. For each anchor, look for a sibling <img> (the cover) and figcaption
//      / heading text (title + artist).
//   3. If the anchor has an image directly inside it, that's also a cover.
//   4. Heuristically split title / artist from the link text or surrounding
//      paragraph — often formatted as "Title — Artist" or "Artist - Title".
//
// Items missing a cover image are dropped — for the visual row layout,
// a card without art looks broken. Better to skip than to ship empty
// squares.
// ── Shared cover/attribute helpers for the HTML scrapers ──────────────
//
// v1.1.18.0. Both release parsers used to pick an image with
//
//   $a.find('img').first().add($a.next('img')).add(…).first()
//
// read as "try these in order". It is not: cheerio's .add(), like jQuery's,
// returns the combined set in DOCUMENT order, so .first() yields whichever
// candidate sits earliest in the page rather than the first strategy that
// matched. An image above the anchor — a badge, a hi-res logo, a section
// header — beat the cover the anchor itself wrapped.
//
// These helpers exist so both parsers try their candidates in the order they
// are written, one at a time.

const ALBUM_ANCHOR_SEL = 'a[href*=".bandcamp.com/album/"]';
const MAX_CARD_DEPTH = 4;

function imgSrc($img) {
  if (!$img || !$img.length) return null;
  return $img.attr('src')
      || $img.attr('data-src')
      || $img.attr('data-lazy-src')
      || $img.attr('data-original')
      || null;
}

function bgImage($el) {
  if (!$el || !$el.length) return null;
  const m = ($el.attr('style') || '')
    .match(/background(?:-image)?\s*:\s*url\(['"]?([^'")]+)['"]?\)/i);
  return (m && m[1]) ? m[1] : null;
}

function findCoverForAnchor($, $a) {
  // 1. Inside the anchor. Unambiguous: an image wrapped by the album link is
  //    that album's cover.
  const inside = imgSrc($a.find('img').first()) || bgImage($a);
  if (inside) return inside;

  // 2. Immediately adjacent — but only where the anchor's parent is about
  //    this one album. A banner sitting directly above two album links is a
  //    sibling of both and belongs to neither, so the same shared-container
  //    rule that bounds the walk below has to bound this too.
  if ($a.parent().find(ALBUM_ANCHOR_SEL).length <= 1) {
    const adjacent = imgSrc($a.next('img')) || imgSrc($a.prev('img'));
    if (adjacent) return adjacent;
  }

  // 3. Up through the card, stopping the moment the ancestor stops being
  //    about this one album.
  let $el = $a.parent();
  for (let depth = 0; depth < MAX_CARD_DEPTH && $el && $el.length; depth++) {
    if ($el.find(ALBUM_ANCHOR_SEL).length > 1) break;   // shared container
    const found = imgSrc($el.find('img').first()) || bgImage($el);
    if (found) return found;
    $el = $el.parent();
  }
  return null;
}


function extractQobuzReleaseCards(html, articleUrl) {
  const $ = cheerio.load(html);
  const out = [];

  $('a[href*="/album/"]').each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') || '').split('?')[0].split('#')[0];
    if (!/\/album\//.test(href)) return;
    const url = href.startsWith('http')
      ? href
      : new URL(href, 'https://www.qobuz.com').toString();

    // Find a cover image: inside the anchor, then immediately after, then in
    // the parent. Tried in that order — see the note above imgSrc.
    //
    // Unlike the Bandcamp parser this deliberately keeps searching the whole
    // parent without the one-album-per-container rule, and keeps dropping
    // cards it finds no image for. Qobuz list pages carry a real cover for
    // every album, so the containment rule would only cost cards, and the
    // hero-image leak the Bandcamp parser suffered came from a closest()
    // fallback this parser never had.
    let img = imgSrc($a.find('img').first())
           || imgSrc($a.next('img'))
           || imgSrc($a.parent().find('img').first());
    if (!img) return;   // no cover → skip; would render empty
    if (!/^https?:/.test(img)) {
      img = new URL(img, 'https://www.qobuz.com').toString();
    }

    // Extract title + artist. The anchor's own text is usually the
    // album title. Artist is harder — sometimes it's the next sibling
    // text node, sometimes a separate anchor link to /interpreter/...
    // We try the anchor text first, then look for an /interpreter/
    // anchor nearby for the artist name.
    const linkText = stripHtml($a.text());
    if (!linkText) return;

    let title = linkText;
    let artist = '';

    // Look for an /interpreter/ (artist) link next to this album link.
    // Qobuz format: <a href="/album/...">Album Title</a> by <a href="/interpreter/...">Artist</a>
    // Same ordering fault as the cover chain: .add() would return whichever
    // /interpreter/ link came first in the page, not the nearest one to this
    // album. Take the adjacent link first, then a sibling, then anything in
    // the parent — nearest outwards.
    const INTERP = 'a[href*="/interpreter/"]';
    for (const $cand of [$a.next(INTERP), $a.siblings(INTERP).first(),
                         $a.parent().find(INTERP).first()]) {
      if ($cand && $cand.length) {
        const txt = stripHtml($cand.text());
        if (txt) { artist = txt; break; }
      }
    }

    // Sometimes the title text contains both: "Artist - Title" or
    // "Title — Artist". If we still have no artist, try splitting.
    if (!artist) {
      const m = linkText.match(/^(.+?)\s+[—–-]\s+(.+)$/);
      if (m) {
        // Heuristic: shorter token is probably the artist. Not reliable
        // but better than no split.
        const [_, a, b] = m;
        title = a.trim();
        artist = b.trim();
      }
    }

    if (!title) return;

    out.push({
      id:           sha1Short(url),
      kind:         'release',
      source:       'qobuz',
      section:      'New Releases',
      title,
      artist:       artist || null,
      excerpt:      null,
      url,
      image_url:    img,
      published_at: Math.floor(Date.now() / 1000),
      fetched_at:   Math.floor(Date.now() / 1000),
    });
  });

  return out;
}

// Fallback when the album-card scrape produces nothing — represent each
// article as a single tile pointing at the article. Keeps the section
// non-empty even when Qobuz changes their template.
function qobuzArticleAsTile(url, html) {
  const $ = cheerio.load(html);
  const title = stripHtml($('meta[property="og:title"]').attr('content') || $('title').text() || '');
  const image = $('meta[property="og:image"]').attr('content') || null;
  const desc = stripHtml($('meta[property="og:description"]').attr('content') || '');
  if (!title) return null;
  return {
    id:           sha1Short(url),
    kind:         'article',
    source:       'qobuz',
    section:      'Magazine',
    title,
    artist:       null,
    excerpt:      desc.slice(0, 280),
    url,
    image_url:    image,
    published_at: Math.floor(Date.now() / 1000),
    fetched_at:   Math.floor(Date.now() / 1000),
  };
}

// ── Bandcamp Daily two-step crawl ─────────────────────────────────────
//
// Bandcamp Daily has no native RSS feed (they removed it years ago).
// Same approach as Qobuz: scrape the homepage to find recent article
// URLs, fetch each article body, extract embedded album mentions for
// the releases row + record the article itself for the articles list.
//
// Bandcamp's URL conventions:
//   - Articles live at daily.bandcamp.com/<category>/<slug>
//     where <category> is one of: lists, features, scene-report,
//     album-of-the-day, best-of, etc.
//   - Albums live at <artist>.bandcamp.com/album/<slug>
//     The subdomain encodes the artist's slug, so artist name extraction
//     can use the URL itself when in-page text isn't reliable.
//   - Cover images are served from f4.bcbits.com (their CDN).
//
// Differences from Qobuz parsing:
//   - Album anchors are full-qualified URLs to subdomains, not paths
//   - Bandcamp Daily articles often embed iframe players for albums.
//     We skip iframes (they'd require an extra HTTP roundtrip per album
//     to resolve the iframe's album_id to a public URL) and rely on
//     plain anchor links + cover images. Loses some cards but keeps
//     the network footprint tight.

// ── Resolving a Bandcamp album from its own page ──────────────────────
//
// v1.1.18.0. Scraping the article body for covers, titles and artists does
// not work on Bandcamp Daily, and running the parser against the live site
// is what showed how badly. On the "queer country album guide" list — the
// article behind the report — 15 album links produced:
//
//   title "self-titled 1973 album", artist "Lavendercountry"
//   title "final album",            artist "Lavendercountry"
//   title "Rhinestone Tomboy",      artist "Myabyrne"
//   title ",",                      artist "Casaamarela"
//
// The titles are the prose the link happens to sit on, and the artists are
// the subdomain with a capital letter — "Cleopatrarecords" for a Patsy Cline
// record, because the link points at a label's page. The covers were the
// article's hero image on every card, which is the reported symptom.
//
// None of that is recoverable from the article, because the article does not
// contain it. The album page does: og:image is the real cover, and the
// JSON-LD block carries the real album title and artist name. So resolve each
// album from its own page and publish only what resolves.
//
// The original comment here rejected per-album fetches to "keep the network
// footprint tight". That was the right instinct and the wrong trade: it
// bought a row of wrong covers and prose fragments. The footprint is bounded
// instead — deduplicated, capped, concurrency-limited, and cached across
// refreshes, since an album's title and cover do not change.
const BC_RESOLVE_MAX = 24;      // album pages per refresh, after dedupe
const BC_RESOLVE_CONCURRENCY = 4;
const _bcAlbumCache = new Map(); // url -> { title, artist, image } | null
const BC_CACHE_MAX = 500;

function parseBandcampAlbumPage(html) {
  const $ = cheerio.load(html);
  const image = $('meta[property="og:image"]').attr('content') || null;

  let title = null;
  let artist = null;
  // JSON-LD is the authoritative pair. Bandcamp emits a MusicAlbum object
  // with name + byArtist.name.
  const ld = $('script[type="application/ld+json"]').first().html();
  if (ld) {
    try {
      const j = JSON.parse(ld);
      if (j && typeof j.name === 'string') title = j.name.trim() || null;
      if (j && j.byArtist && typeof j.byArtist.name === 'string') {
        artist = j.byArtist.name.trim() || null;
      }
    } catch (e) {
      // Malformed or unexpected JSON-LD. og:title below still gets us there.
    }
  }
  // Fallback: og:title is "Album Title, by Artist Name".
  if (!title || !artist) {
    const og = $('meta[property="og:title"]').attr('content') || '';
    const m = og.match(/^(.*),\s+by\s+(.+)$/);
    if (m) {
      if (!title) title = m[1].trim() || null;
      if (!artist) artist = m[2].trim() || null;
    } else if (!title && og.trim()) {
      title = og.trim();
    }
  }
  if (!title || !image) return null;   // no usable card without both
  return { title, artist: artist || null, image };
}

async function resolveBandcampAlbum(url) {
  if (_bcAlbumCache.has(url)) return _bcAlbumCache.get(url);
  let meta = null;
  try {
    const html = await httpGet(url);
    if (html) meta = parseBandcampAlbumPage(html);
  } catch (e) {
    // A single album that will not load must not take the refresh down.
    console.warn(`[news] bandcamp album resolve failed: ${url}: ${e.message}`);
  }
  // Negative results are cached too, so a dead link is not re-fetched every
  // half hour. The map is bounded; oldest insertions go first.
  if (_bcAlbumCache.size >= BC_CACHE_MAX) {
    _bcAlbumCache.delete(_bcAlbumCache.keys().next().value);
  }
  _bcAlbumCache.set(url, meta);
  return meta;
}

// Resolve many, a few at a time. Not Promise.all over the whole list: that
// would open two dozen sockets to one host at once, which is the kind of
// thing that gets a feed reader blocked.
async function resolveBandcampAlbums(urls) {
  const out = new Map();
  const queue = urls.slice(0, BC_RESOLVE_MAX);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const url = queue[cursor++];
      const meta = await resolveBandcampAlbum(url);
      if (meta) out.set(url, meta);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BC_RESOLVE_CONCURRENCY, queue.length) }, worker));
  return out;
}

async function fetchBandcamp(feed, prefs = null) {
  // One crawl serves two rows. When only one of them is switched on, do not
  // do the other one's work: resolving album pages is ~24 extra requests, and
  // an install that only wants the reviews should not be making them.
  const wantReleases = !prefs || prefs.bandcampReleases !== false;
  const wantArticles = !prefs || prefs.bandcampArticles !== false;
  const listingHtml = await httpGet(feed.url);
  if (!listingHtml) {
    console.warn(`[news] ${feed.source}/${feed.section}: empty listing response`);
    return [];
  }
  const articleUrls = extractBandcampArticleUrls(listingHtml).slice(0, 5);
  if (articleUrls.length === 0) {
    console.warn(`[news] ${feed.source}/${feed.section}: no article URLs found on listing page (DOM may have changed)`);
    return [];
  }
  console.log(`[news] bandcamp: found ${articleUrls.length} articles to scrape`);

  const bodies = await Promise.all(articleUrls.map(async url => {
    try {
      const html = await httpGet(url);
      return { url, html };
    } catch (e) {
      console.warn(`[news] bandcamp article fetch failed: ${url}: ${e.message}`);
      return { url, html: null };
    }
  }));

  // Two outputs per article:
  //   1. release cards from embedded album mentions (kind: 'release')
  //   2. the article itself as a tile (kind: 'article'), so it lands
  //      in the articles list mixed with Pitchfork.
  const seenReleases = new Set();
  const releases = [];
  const articles = [];

  for (const { url: articleUrl, html } of bodies) {
    if (!html) continue;

    // Collect the album links this article mentions. The article body is used
    // only to find WHICH albums; everything shown about them comes from the
    // album's own page — see resolveBandcampAlbum.
    if (wantReleases) {
      for (const c of extractBandcampReleaseCards(html, articleUrl)) {
        if (seenReleases.has(c.url)) continue;
        seenReleases.add(c.url);
        releases.push(c);
      }
    }

    // Always record the article itself for the articles list. We use
    // the same og:meta extraction as the Qobuz fallback — Bandcamp Daily
    // articles have proper Open Graph tags.
    if (wantArticles) {
      const tile = bandcampArticleAsTile(articleUrl, html);
      if (tile) articles.push(tile);
    }
  }

  // Replace the article-derived guesses with what each album says about
  // itself, and drop anything that would not resolve. A card we cannot
  // describe correctly is worse than no card: the row exists to show what is
  // out, and "final album by Lavendercountry" over the wrong sleeve is not
  // that.
  const resolved = await resolveBandcampAlbums(releases.map(r => r.url));
  const finalReleases = [];
  for (const r of releases) {
    const meta = resolved.get(r.url);
    if (!meta) continue;
    finalReleases.push({ ...r, title: meta.title, artist: meta.artist, image_url: meta.image });
  }

  console.log(`[news] bandcamp: ${releases.length} album links → ` +
    `${finalReleases.length} resolved releases + ${articles.length} articles`);
  return [...finalReleases, ...articles];
}

// Find Bandcamp Daily article URLs on the homepage. Articles live under
// known section paths — we match on those rather than every anchor on
// the page so we don't pick up nav links to genre tags etc.
function extractBandcampArticleUrls(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  // Known article section prefixes. If Bandcamp adds new sections we'd
  // need to extend this list — better than matching everything though,
  // because it filters out homepage nav links to /genre/, /tag/, etc.
  const SECTION_RE = /\/(?:lists|features|scene-report|album-of-the-day|best-of|label-profile|seven-essential|guide|playlist)\//;

  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') || '';
    if (!href) return;
    // Resolve relative URLs to absolute. Bandcamp uses both shapes.
    let abs;
    if (href.startsWith('http')) {
      abs = href;
    } else if (href.startsWith('/')) {
      abs = `https://daily.bandcamp.com${href}`;
    } else {
      return;
    }
    // Only daily.bandcamp.com URLs matching one of our known sections.
    if (!/^https?:\/\/daily\.bandcamp\.com/.test(abs)) return;
    if (!SECTION_RE.test(abs)) return;
    // Strip query/hash — same article with different tracking suffixes
    // is the same article.
    const clean = abs.split('?')[0].split('#')[0];
    // Filter out section-index URLs (e.g. /lists/ with no trailing slug).
    // Real article URLs have content after the section.
    const m = clean.match(SECTION_RE);
    if (!m) return;
    const afterSection = clean.slice(clean.indexOf(m[0]) + m[0].length);
    if (afterSection.length < 3) return;   // need a slug after the section

    urls.add(clean);
  });
  return Array.from(urls);
}

// Extract embedded album cards from a Bandcamp Daily article body.
//
// We look for anchors to <artist>.bandcamp.com/album/<slug> and try to
// pull the cover image + title + artist from surrounding DOM. Bandcamp
// Daily's exact card markup varies by article type (lists vs features
// vs album-of-the-day), so we walk fairly aggressively to find the
// cover — searching the anchor's ancestors up to article/section level
// and accepting both <img> tags and CSS background-image styles.
//
// On the first few production runs we also log diagnostic counts so we
// can see how many anchors were found vs how many were kept. If "found
// >> kept", the cover-image search is the bottleneck and we know what
// to widen.
// Every album anchor's cover image, or null.
//
// v1.1.18.0 — this replaces a chain that gave every release on a page the SAME
// cover. Two separate faults, both reproducible, both pushing the same way:
//
//   1. The old code built its candidates with
//        $a.find('img').first().add($a.next('img')).add(…).first()
//      and read that as "try these in order". It is not. Cheerio's .add(),
//      like jQuery's, returns the combined set in DOCUMENT order, so .first()
//      yields whichever candidate appears earliest in the page — not the
//      first strategy that matched. A badge or logo sitting above the anchor
//      inside the same card beat the anchor's own cover.
//
//   2. The widest fallback was $a.closest('figure, article, section, li, div').
//      In a prose article — Bandcamp Daily's lists are mostly paragraphs with
//      bare album links — the nearest matching ancestor is the article body,
//      and .find('img').first() on that is the article's hero image. Every
//      anchor on the page resolved to it. That is the reported symptom.
//
// The rule now: a release card contains exactly ONE album link. So walk up
// from the anchor only while the ancestor still contains just this one album
// anchor; the moment an ancestor holds two, we have left the card and
// anything found there belongs to the page, not to this release. An anchor
// with no image inside its own card gets null and is dropped, which is the
// right answer — no cover at all beats the same wrong cover on every row.
function extractBandcampReleaseCards(html, articleUrl) {
  const $ = cheerio.load(html);
  const out = [];

  // Match Bandcamp album URLs. The pattern is <subdomain>.bandcamp.com/album/<slug>
  // — we match on the path component being '/album/' and the host containing
  // '.bandcamp.com' to allow any artist subdomain.
  const ALBUM_HOST_RE = /^https?:\/\/[^/]+\.bandcamp\.com\/album\//i;

  // Diagnostic counters. Reported once at the end so we can see which
  // filter is the bottleneck on a real article. With production volumes
  // this is a single line per article — manageable.
  let cAnchors = 0;     // anchors matching the album URL pattern
  let cWithImg = 0;     // of those, with a recoverable cover image
  let cKept    = 0;     // of those, with a usable title (final output)

  $('a[href*=".bandcamp.com/album/"]').each((_, el) => {
    cAnchors++;
    const $a = $(el);
    const href = ($a.attr('href') || '').split('?')[0].split('#')[0];
    if (!ALBUM_HOST_RE.test(href)) return;

    // A release with no cover we can trust is still a release. The client
    // draws a disc placeholder for a null image_url (NewsSection's
    // releaseImgFallback), so keeping the card costs nothing and losing it
    // would quietly shrink New Releases on exactly the prose-style articles
    // that carry the most of them.
    let img = findCoverForAnchor($, $a);
    if (img) {
      cWithImg++;
      if (!/^https?:/.test(img)) {
        try { img = new URL(img, articleUrl).toString(); }
        catch { img = null; }   // malformed relative URL — no cover, keep card
      }
    }

    // Extract title. Anchor text first, then nearby headings as fallback.
    let title = stripHtml($a.text());
    if (!title) {
      // Look in the closest meaningful ancestor for headings.
      const $container = $a.closest('figure, article, section, li, div').first();
      const $heading = ($container.length ? $container : $a.parent())
        .find('h1, h2, h3, h4').first();
      if ($heading.length) title = stripHtml($heading.text());
    }
    if (!title) return;

    // Artist extraction — derive from URL subdomain as default.
    let artist = '';
    try {
      const u = new URL(href);
      const sub = u.hostname.replace(/\.bandcamp\.com$/i, '');
      // Skip the meta subdomains. Real artist subdomains are slugs.
      if (sub && sub !== 'daily' && sub !== 'www') {
        artist = sub
          .split('-')
          .map(w => w ? w[0].toUpperCase() + w.slice(1) : '')
          .join(' ');
      }
    } catch { /* malformed URL — leave artist empty */ }

    // Override with explicit artist text near the anchor when available.
    // Look for headings or .artist class within the closest container.
    const $container = $a.closest('figure, article, section, li, div').first();
    const $siblingArtist = ($container.length ? $container : $a.parent())
      .find('h4, h5, .artist, .by-artist').first();
    if ($siblingArtist.length) {
      const txt = stripHtml($siblingArtist.text()).replace(/^by\s+/i, '');
      if (txt) artist = txt;
    }

    out.push({
      id:           sha1Short(href),
      kind:         'release',
      source:       'bandcamp',
      section:      'New Releases',
      title,
      artist:       artist || null,
      excerpt:      null,
      url:          href,
      image_url:    img || null,
      published_at: Math.floor(Date.now() / 1000),
      fetched_at:   Math.floor(Date.now() / 1000),
    });
    cKept++;
  });

  // Diagnostic — helps narrow down "why are we getting zero cards" on
  // production data. We log unconditionally during the diagnostic phase so
  // we see all four scenarios: nothing found, anchors-but-no-images,
  // anchors-with-images-but-no-titles, or a healthy K kept count. cWithImg
  // is set only AFTER both the album-URL regex AND the image search
  // succeed, so the three counters tell three distinct stories.
  // Backstop. If a layout still lands the same URL on more than one release,
  // that image is a page asset — a hero, a section banner, a logo — and not
  // any one album's cover. That is the exact shape of the bug this function
  // was rewritten for, so catch it by observation as well as by construction:
  // clear those images rather than show a wall of identical covers. The cards
  // stay; only the wrong art goes.
  const seen = new Map();
  for (const r of out) {
    if (r.image_url) seen.set(r.image_url, (seen.get(r.image_url) || 0) + 1);
  }
  const shared = new Set([...seen.entries()].filter(([, n]) => n > 1).map(([u]) => u));
  if (shared.size) {
    let cleared = 0;
    for (const r of out) {
      if (r.image_url && shared.has(r.image_url)) { r.image_url = null; cleared++; }
    }
    console.warn(`[news] bandcamp parse: cleared ${cleared} duplicate cover(s) across ` +
      `${shared.size} shared image(s) — page assets, not covers`);
  }

  const withCover = out.filter(r => r.image_url).length;
  console.log(`[news] bandcamp parse: ${cAnchors} album anchors → ${cWithImg} with image → ` +
    `${out.length} kept (${withCover} with a cover)`);

  return out;
}

// Article-as-tile for Bandcamp. Same shape as the Qobuz fallback —
// pull og:title, og:description, og:image. Bandcamp Daily articles
// have proper Open Graph metadata so this is reliable.
function bandcampArticleAsTile(url, html) {
  const $ = cheerio.load(html);
  const title = stripHtml($('meta[property="og:title"]').attr('content') || $('title').text() || '');
  const image = $('meta[property="og:image"]').attr('content') || null;
  const desc = stripHtml($('meta[property="og:description"]').attr('content') || '');
  if (!title) return null;
  // Try to extract publish date from the article so it can sort
  // properly with Pitchfork articles in the articles list.
  // Bandcamp uses <meta property="article:published_time">.
  let published = null;
  const ts = $('meta[property="article:published_time"]').attr('content');
  if (ts) {
    const t = Date.parse(ts);
    if (!isNaN(t)) published = Math.floor(t / 1000);
  }

  // Section label. Try to pull from the URL — articles live under
  // /lists/, /features/, etc.
  let section = 'Daily';
  const m = url.match(/daily\.bandcamp\.com\/(lists|features|scene-report|album-of-the-day|best-of|label-profile|seven-essential|guide|playlist)\//i);
  if (m) {
    // Map URL slugs to display labels.
    const labels = {
      lists:               'Lists',
      features:            'Features',
      'scene-report':      'Scene Report',
      'album-of-the-day':  'Album of the Day',
      'best-of':           'Best Of',
      'label-profile':     'Label Profile',
      'seven-essential':   'Seven Essential',
      guide:               'Guide',
      playlist:            'Playlist',
    };
    section = labels[m[1].toLowerCase()] || section;
  }

  return {
    id:           sha1Short(url),
    kind:         'article',
    source:       'bandcamp',
    section,
    title,
    artist:       null,
    excerpt:      desc.slice(0, 280),
    url,
    image_url:    image,
    published_at: published || Math.floor(Date.now() / 1000),
    fetched_at:   Math.floor(Date.now() / 1000),
  };
}

// Upsert items into the cache. INSERT OR REPLACE on the URL constraint
// keeps the row id stable (it's a hash of the URL) and updates fetched_at
// so we know the item is still current. We don't update published_at on
// re-fetch because some feeds tweak that field after the fact — once we've
// recorded our first sighting, that's the canonical pubDate.
function persistItems(items) {
  if (!items || items.length === 0) return 0;
  const stmt = db.get().prepare(`
    INSERT INTO news_items (id, kind, source, section, title, artist, excerpt, url, image_url, published_at, fetched_at)
    VALUES (@id, @kind, @source, @section, @title, @artist, @excerpt, @url, @image_url, @published_at, @fetched_at)
    ON CONFLICT(url) DO UPDATE SET
      kind       = excluded.kind,
      title      = excluded.title,
      artist     = excluded.artist,
      excerpt    = excluded.excerpt,
      image_url  = excluded.image_url,
      section    = excluded.section,
      fetched_at = excluded.fetched_at
  `);
  const tx = db.get().transaction((rows) => {
    let n = 0;
    for (const r of rows) {
      // Default kind/artist to safe values for any item that didn't set them.
      // (RSS items now do, but legacy callers might not.)
      const safe = {
        kind:   'article',
        artist: null,
        ...r,
      };
      try { stmt.run(safe); n++; } catch (e) { /* skip individual failures */ }
    }
    return n;
  });
  return tx(items);
}

// Drop items older than PRUNE_AFTER_SEC. Bounded growth.
function pruneOld() {
  const cutoff = Math.floor(Date.now() / 1000) - PRUNE_AFTER_SEC;
  try {
    const r = db.get().prepare(`DELETE FROM news_items WHERE published_at < ?`).run(cutoff);
    return r.changes;
  } catch (e) {
    console.warn(`[news] prune failed: ${e.message}`);
    return 0;
  }
}

// ── Home-screen news preferences ──────────────────────────────────────
//
// Stored as one JSON row in `settings` rather than four rows, so reading them
// is a single lookup on a path that runs on every refresh and every feed
// request.
//
// Everything defaults to FALSE. A fresh install must not reach out to
// Pitchfork, Qobuz or Bandcamp until someone asks it to, so the absence of the
// row means "all off" — not "all on", which is the easy mistake here and the
// one that would make a new install phone out on first boot.
function getNewsPrefs() {
  const out = {};
  for (const k of NEWS_PREF_KEYS) out[k] = false;
  try {
    const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(NEWS_PREFS_SETTING);
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      // Read only the keys we know. A blob from a later build carrying extra
      // keys must not switch anything on here by accident.
      for (const k of NEWS_PREF_KEYS) if (parsed && parsed[k] === true) out[k] = true;
    }
  } catch (e) {
    // Unreadable or malformed. All-off is the safe reading: it costs the user
    // a toggle, where the other way costs them unrequested network calls.
    console.warn('[news] could not read preferences, treating as all-off:', e.message);
  }
  return out;
}

function setNewsPrefs(patch) {
  const next = getNewsPrefs();
  for (const k of NEWS_PREF_KEYS) {
    if (patch && typeof patch[k] === 'boolean') next[k] = patch[k];
  }
  db.get().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(NEWS_PREFS_SETTING, JSON.stringify(next));
  // Starting or stopping the timer is part of saving, not a thing the caller
  // has to remember: "off means no background work" has to hold the moment
  // the switch moves, not at the next boot.
  applyPrefs();
  return next;
}

const anyNewsEnabled = (prefs) => NEWS_PREF_KEYS.some(k => prefs[k]);

// The feeds worth fetching for the current preferences. A feed runs only if
// something it feeds is switched on.
function enabledFeeds(prefs) {
  return FEEDS.filter(f => (f.needs || []).some(k => prefs[k]));
}

// Rows whose source is now switched off are deleted, so turning a row off
// empties it instead of leaving the last fetch sitting there for 30 days
// until pruneOld() gets to it.
function purgeDisabled(prefs) {
  const drop = [];
  if (!prefs.qobuzReleases)     drop.push(["source = 'qobuz'", []]);
  if (!prefs.pitchforkArticles) drop.push(["source = 'pitchfork'", []]);
  if (!prefs.bandcampReleases)  drop.push(["source = 'bandcamp' AND kind = 'release'", []]);
  if (!prefs.bandcampArticles)  drop.push(["source = 'bandcamp' AND kind = 'article'", []]);
  if (drop.length === 0) return 0;
  let n = 0;
  for (const [where] of drop) {
    try { n += db.get().prepare(`DELETE FROM news_items WHERE ${where}`).run().changes; }
    catch (e) { console.warn('[news] purge failed:', e.message); }
  }
  return n;
}

// One full refresh cycle. Concurrent fetches across all feeds, then a
// single persist transaction. We share the in-flight promise so callers
// hitting refresh() while a refresh is already running just await the
// existing one (rather than queuing redundant work).
async function refresh() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    const t0 = Date.now();
    const prefs = getNewsPrefs();
    // Always sweep first: a source switched off between refreshes should have
    // its rows gone even if nothing is enabled and we return immediately.
    const purged = purgeDisabled(prefs);
    const feeds = enabledFeeds(prefs);
    if (feeds.length === 0) {
      // Nothing is on. No upstream request is made at all — not a fetch that
      // is discarded afterwards, none.
      if (purged) console.log(`[news] all sources off; removed ${purged} stale item(s)`);
      return { inserted: 0, pruned: 0, purged, skipped: true };
    }
    const allLists = await Promise.all(feeds.map(f => fetchFeed(f, prefs)));
    const all = [].concat(...allLists);
    const inserted = persistItems(all);
    const pruned = pruneOld();
    const ms = Date.now() - t0;
    console.log(`[news] refresh: ${inserted} items (${pruned} pruned) in ${ms} ms`);
    return { inserted, pruned, ms };
  })();
  try {
    return await _refreshInFlight;
  } finally {
    _refreshInFlight = null;
  }
}

// Manual refresh path — public so a /api/news/refresh route can drive it.
// Rate-limited to one cycle per minute. Returns { ok: true } on success
// or { ok: false, reason: 'cooldown' | 'busy' | 'error' } on rejection.
async function refreshManual() {
  const now = Date.now();
  if (now - _lastManualRefresh < MANUAL_REFRESH_COOLDOWN_MS) {
    const wait = Math.ceil((MANUAL_REFRESH_COOLDOWN_MS - (now - _lastManualRefresh)) / 1000);
    return { ok: false, reason: 'cooldown', retryInSec: wait };
  }
  _lastManualRefresh = now;
  try {
    const r = await refresh();
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  }
}

// Start the periodic refresh loop. Idempotent — calling start() twice
// won't create two timers. Called from index.js boot.
// Start or stop the periodic refresh to match the current preferences.
//
// This is what makes "off means no background work" true rather than
// aspirational: with everything off there is no interval registered at all,
// and switching the last source off clears the one that was.
function applyPrefs() {
  const on = anyNewsEnabled(getNewsPrefs());
  if (on && !_refreshTimer) {
    _refreshTimer = setInterval(() => {
      refresh().catch(e => console.warn('[news] periodic refresh failed:', e.message));
    }, REFRESH_INTERVAL_MS);
    console.log('[news] a source was enabled — refreshing every 30 min');
    refresh().catch(e => console.warn('[news] refresh after enable failed:', e.message));
  } else if (!on && _refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
    console.log('[news] all sources disabled — no further fetches scheduled');
    // Clear the rows so the Home screen empties immediately rather than
    // showing the last fetch until it ages out.
    try { purgeDisabled(getNewsPrefs()); } catch (e) { /* nothing to clear */ }
  }
  return on;
}

function start() {
  if (_refreshTimer) return;
  // Initial fetch on boot, but deferred a few seconds so the rest of the
  // server has finished starting up. setImmediate runs next tick — we use
  // a small setTimeout instead so the boot logs aren't interleaved with
  // [news] logs.
  // v1.1.20.0 — nothing at all happens on a fresh install. No boot fetch, no
  // interval. The first thing that runs is whatever the user switches on.
  if (!anyNewsEnabled(getNewsPrefs())) {
    console.log('[news] no sources enabled — idle (Settings → Home Screen)');
    return;
  }
  setTimeout(() => { refresh().catch(e => console.warn('[news] initial refresh failed:', e.message)); }, 5_000);
  _refreshTimer = setInterval(() => {
    refresh().catch(e => console.warn('[news] periodic refresh failed:', e.message));
  }, REFRESH_INTERVAL_MS);
}

function stop() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// Read API. Returns the most recent items across all sources, sorted
// newest-first. limit is bounded to keep responses reasonable.
//
// Filters:
//   source — restrict to one source ('pitchfork' | 'qobuz' | 'bandcamp')
//   kind   — restrict to articles or releases
function listItems({ limit = 30, source = null, kind = null } = {}) {
  const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || 30));
  const params = [];
  const conds = [];
  if (source) { conds.push('source = ?'); params.push(source); }
  if (kind)   { conds.push('kind = ?');   params.push(kind); }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  params.push(lim);
  return db.get().prepare(`
    SELECT id, kind, source, section, title, artist, excerpt, url, image_url, published_at
    FROM news_items
    ${where}
    ORDER BY published_at DESC
    LIMIT ?
  `).all(...params);
}

module.exports = {
  start,
  stop,
  refresh,
  refreshManual,
  listItems,
  getNewsPrefs,
  setNewsPrefs,
  // Test hook: whether a periodic refresh is currently scheduled. "Off means
  // no background work" is a claim about this handle, so the suite has to be
  // able to see it rather than infer it.
  _hasRefreshTimer: () => !!_refreshTimer,
  anyNewsEnabled,
  enabledFeeds,
  applyPrefs,
  NEWS_PREF_KEYS,
  // Exported for tests
  _stripHtml: stripHtml,
  _normaliseItem: normaliseItem,
};
