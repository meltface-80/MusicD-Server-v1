// src/streamingBarcode.js — the barcode oracle already in the building.
//
// v1.1.38.0.
//
// THE OBSERVATION. metadataMatch.js has built a barcode-qualified
// MusicBrainz query since v30.19:
//
//     releasegroup:"..." AND artist:"..." AND barcode:"0724384499020"
//
// It is the best query in the file — a barcode is an exact identifier, so
// the answer is either right or absent, with no fuzz in between. And it
// almost never runs, because `albums.barcode` is almost always null:
// rippers do not write a UPC into tags, and the ones that do are the
// libraries that were never going to have a matching problem.
//
// Meanwhile this server holds working, authenticated clients for Qobuz
// and Tidal. Their catalogues are enormous, the user is already paying
// for them, and their album responses carry the UPC. So a local album
// that fails text matching can very often be handed a barcode by a
// service we are already logged in to, at which point the fuzzy problem
// becomes an exact lookup — using code that already exists and is
// already exercised.
//
// THE BAR IS DELIBERATELY HIGH, AND THERE IS NO FUZZY TIER BELOW IT.
// Attaching the WRONG barcode to an album is worse than attaching none:
// none leaves the matcher exactly where it was, whereas a wrong one
// sends it confidently to the wrong release group and stores that as a
// match. So a hit must agree on the normalised title AND the normalised
// artist, and on the track count when we have one. Anything less returns
// null and the matcher carries on as it would have done.
//
// Nothing in here ever throws. A streaming service being down, logged
// out, or rate-limiting is not a reason to fail a matcher run — it is a
// reason to have no barcode, which is the state the album was in anyway.

'use strict';

const identity = require('./albumIdentity');
const log = require('./serviceLog').forModule('barcode');

// How many search hits to look at per service. The verification below is
// strict enough that a correct answer is nearly always the first or
// second hit; going deeper mostly buys weaker matches.
const SEARCH_LIMIT = 5;

// A UPC/EAN is 12 or 13 digits (and occasionally 8, for EAN-8). Anything
// else came out of a field that is not a barcode, and storing it would
// put junk into a MusicBrainz query.
const BARCODE_RE = /^\d{8}$|^\d{12,14}$/;

function _streaming() {
  return require('./streamingLibrary');
}

/**
 * True when at least one streaming service is logged in.
 *
 * Delegates to streamingLibrary.isLoggedIn rather than reading the
 * settings keys directly — that module already owns the question of
 * which services exist and how to ask them, and a second answer here
 * would drift the moment a third service is added.
 */
function isAvailable() {
  try {
    const streaming = _streaming();
    return streaming.SERVICE_IDS
      ? streaming.SERVICE_IDS.some((id) => streaming.isLoggedIn(id))
      : ['qobuz', 'tidal'].some((id) => streaming.isLoggedIn(id));
  } catch (e) {
    // The streaming modules are optional at runtime — a build without
    // credentials configured must not make this throw on every album.
    return false;
  }
}

// Dig the UPC out of a raw catalogue item.
//
// Reached for on the RAW response rather than the normalised shape
// because streamingNormalise.js deliberately does not carry a barcode:
// its job is the fields the UI renders, and nothing on screen shows a
// UPC. Qobuz calls it `upc`. Tidal has called it `upc` and, on the newer
// API version, `barcodeId` — both are handled because which one arrives
// depends on the endpoint version tidal/api.js happens to be talking to.
function _upcFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [raw.upc, raw.barcodeId, raw.barcode, raw.ean];
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const s = String(c).trim();
    if (BARCODE_RE.test(s)) return s;
  }
  return null;
}

// Does this catalogue hit really describe the album in front of us?
//
// Uses albumIdentity for every comparison, so this module agrees with
// the matcher and with album version grouping about what an album is
// called. Writing a second normaliser here is exactly the divergence
// albumIdentity.js exists to prevent — three copies of one record can
// match the same release group and still refuse to group, and it looks
// like the grouping being broken.
function _verify(local, candidate) {
  const wantTitle = identity.normalise(identity.cleanAlbumTitle(local.title || '').cleaned);
  const wantArtist = identity.normalise(identity.cleanArtistName(local.artist || '').cleaned);
  if (!wantTitle || !wantArtist) return 0;

  const gotTitle = identity.normalise(identity.cleanAlbumTitle(candidate.title || '').cleaned);
  const gotArtist = identity.normalise(identity.cleanArtistName(candidate.artist || '').cleaned);
  if (gotTitle !== wantTitle) return 0;
  if (gotArtist !== wantArtist) return 0;

  // Both axes agree exactly. The track count, when we have one on both
  // sides, is the third opinion — and it is the one that separates the
  // album from its own deluxe edition, which is the realistic way to get
  // a technically-correct-but-wrong barcode.
  let score = 90;
  const localTracks = Number(local.trackCount) || 0;
  const gotTracks = Number(candidate.trackCount) || 0;
  if (localTracks && gotTracks) {
    const diff = Math.abs(localTracks - gotTracks);
    if (diff === 0) score = 100;
    else if (diff <= 2) score = 92;
    else return 0;            // a different edition — refuse rather than guess
  }
  return score;
}

/**
 * Find a barcode for one album from the logged-in streaming catalogues.
 *
 * Returns { barcode, service, matchedTitle, matchedArtist, confidence }
 * or null. Never throws.
 */
async function findBarcode({ title, artist, trackCount } = {}) {
  if (!title || !artist) return null;
  if (!isAvailable()) return null;

  let streaming;
  let normalise;
  try {
    streaming = _streaming();
    normalise = require('./streamingNormalise');
  } catch (e) {
    log.warn(`streaming modules unavailable: ${e.message}`);
    return null;
  }

  const services = streaming.SERVICE_IDS || ['qobuz', 'tidal'];
  const query = `${identity.cleanArtistName(artist).cleaned} ${identity.cleanAlbumTitle(title).cleaned}`.trim();

  let best = null;
  for (const service of services) {
    let loggedIn = false;
    try {
      loggedIn = streaming.isLoggedIn(service);
    } catch (e) {
      // Asked a service that cannot answer. Treated as logged out; the
      // other service, if any, still gets its turn.
      loggedIn = false;
    }
    if (!loggedIn) continue;

    let raw;
    try {
      raw = await streaming.apiFor(service).search(query, 'albums', SEARCH_LIMIT);
    } catch (e) {
      // Down, rate-limited, or the token expired. Not a matcher failure.
      log.warn(`${service} search failed for "${query}": ${e.message}`);
      continue;
    }

    let items;
    try {
      items = normalise.itemsFrom(raw, 'albums') || [];
    } catch (e) {
      log.warn(`${service} returned a shape we could not read: ${e.message}`);
      continue;
    }

    for (const item of items.slice(0, SEARCH_LIMIT)) {
      const upc = _upcFrom(item);
      if (!upc) continue;
      let shaped;
      try {
        shaped = normalise.normaliseList(service, 'album', [item])[0];
      } catch (e) {
        // One unreadable item must not abandon the rest of the page.
        continue;
      }
      if (!shaped) continue;
      const score = _verify({ title, artist, trackCount }, shaped);
      if (score === 0) continue;
      if (!best || score > best.confidence) {
        best = {
          barcode: upc,
          service,
          matchedTitle: shaped.title,
          matchedArtist: shaped.artist,
          confidence: score,
        };
      }
      // A perfect agreement on title, artist and track count is as good
      // as this gets; asking the other service cannot improve it.
      if (best.confidence === 100) return best;
    }
  }

  if (best) {
    log.info(`"${artist} — ${title}": ${best.service} UPC ${best.barcode} (${best.confidence})`);
  }
  return best;
}

module.exports = { isAvailable, findBarcode, _upcFrom, _verify, BARCODE_RE };
