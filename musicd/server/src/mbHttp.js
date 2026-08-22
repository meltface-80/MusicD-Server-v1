// src/mbHttp.js — the one MusicBrainz client in this server.
// ==========================================================
//
// v1.1.38.0. Until this module existed there were four independent
// MusicBrainz callers in the tree, and only two of them behaved:
//
//   metadataMatch.js  1 req/sec through mbThrottle, real contact in the
//                     User-Agent, refuses to run without one.
//   bioFetch.js       the same.
//   coverArt.js       its OWN `lastMBRequest` gate, and the User-Agent
//                     `musicd/1.0 (self-hosted)` — no contact at all.
//   artistLogos.js    its OWN `mbGuard`, and the same anonymous string.
//
// MusicBrainz's published limit is one request per second PER IP, not
// per module. Three separate 1-req/sec streams leaving one host during
// a library scan is three times the allowance, and the two anonymous
// ones carried no way for MB to tell us we were doing it. The matcher
// refusing to start without a contact on terms-of-service grounds while
// two other modules sent unattributable traffic from the same address
// was the worst of both: the honest path was rate-limited and the
// dishonest one was not.
//
// So: every MusicBrainz request in the server goes through request()
// below. There is exactly one throttle (mbThrottle) and exactly one
// User-Agent, and a caller with no contact configured cannot get a
// request out of this module at all.
//
// The other thing this module does that none of the four did is handle
// a 503 properly. MusicBrainz answers a rate-limit breach with 503 and
// a Retry-After header — it is asking us to come back, not telling us
// the album does not exist. Every previous caller treated it as a hard
// failure and moved on, which during a long crawl meant a burst of
// albums silently marked unmatched because of our own pacing rather
// than because MB had nothing for them. Here a 503 is retried, honouring
// Retry-After, and only a run of them gives up (with e.code
// 'MB_RATE_LIMITED', so a caller can tell that apart from "no match").

'use strict';

const axios = require('axios');

// The shared 1 req/sec gate (#30.23). This is the only place in the
// server that should be calling it for a MusicBrainz request; if you
// find yourself writing `await mbThrottle.wait()` somewhere else, the
// request belongs in here instead.
const mbThrottle = require('./mbThrottle');

const MB_BASE = 'https://musicbrainz.org/ws/2';
const REQUEST_TIMEOUT_MS = 8000;

// Three retries after the initial attempt: with the default 2s delay
// doubling that is 2 + 4 + 8 = 14 seconds of patience before we call it
// rate-limited. Long enough to ride out a burst we caused ourselves,
// short enough that a genuinely unhappy MB does not stall a scan.
const MAX_503_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 2;

// Read once. The VERSION file cannot change under a running process —
// an update replaces the whole container — and buildUserAgent() is
// called on every request.
let _version = null;

function _readVersion() {
  if (_version !== null) return _version;
  let v = 'unknown';
  try {
    const fs = require('fs');
    const path = require('path');
    v = fs.readFileSync(path.join(__dirname, '../../VERSION'), 'utf-8').trim() || 'unknown';
  } catch (e) {
    // Not fatal: a User-Agent without an accurate version still carries
    // the contact, which is the part MusicBrainz's terms actually
    // require. Refusing to make the request over a missing VERSION file
    // would take out matching, bios and art for no benefit to anyone.
  }
  _version = v;
  return _version;
}

/**
 * Build the User-Agent string that identifies this client to
 * MusicBrainz. Their terms require a contactable identity — they need
 * a way to reach the operator if the client misbehaves — and the
 * version tells their logs which release made the request.
 *
 * Called with an empty contact it returns the bare `musicd/<version>`.
 * That form is NOT good enough for MusicBrainz and request() will not
 * send it; it exists for the Cover Art Archive and the other services
 * (fanart.tv, TheAudioDB) which want to know who is calling but do not
 * demand a contact, so those keep working for a user who has not
 * filled the field in.
 */
function buildUserAgent(contact) {
  const version = _readVersion();
  const c = String(contact || '').trim();
  if (!c) return `musicd/${version}`;
  return `musicd/${version} ( ${c} )`;
}

/**
 * The contact the user typed into Settings, trimmed. '' when unset.
 *
 * Read fresh on every call rather than cached: the field is editable in
 * the UI, and a user who fixes an empty contact mid-scan should see the
 * next request go out rather than have to restart the server.
 */
function getContact() {
  const settings = require('./settings');
  return settings.get('mb_contact', '').trim();
}

function hasContact() {
  return getContact() !== '';
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retry-After is documented as a number of seconds, and that is what
// MusicBrainz sends. The HTTP spec also allows an absolute date; we do
// not try to parse one, we just fall back to the default delay, because
// a wrong date parse would either hammer them or stall the scan for
// hours and the default is right either way.
function _retryAfterSeconds(response) {
  if (!response || !response.headers) return null;
  const raw = response.headers['retry-after'] ?? response.headers['Retry-After'];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Cap it: a pathological header must not park a scan for an hour.
  return Math.min(n, 60);
}

/**
 * Throttled, retrying GET against the MusicBrainz web service.
 *
 *   path    e.g. '/release-group/' or `/release/${mbid}`
 *   params  query params; { fmt: 'json' } is merged in for you
 *   opts    identity, in one of two forms — at least one is REQUIRED:
 *             { contact }    a contact string; the User-Agent is built here
 *             { userAgent }  a User-Agent already built, used verbatim
 *
 * The second form exists for mbArtist.js, which is handed an
 * `mbRequest(path, params, userAgent)` callable in its ctx object. That
 * three-argument shape is what lets mbArtist be tested without a network
 * and without knowing where the contact came from, so it is worth
 * keeping — and it means this module has to accept a finished
 * User-Agent as readily as it accepts the contact to build one from.
 * Neither form falls back to settings: a caller that has not decided
 * who it is should fail here, loudly, rather than send a request MB
 * cannot attribute.
 *
 * Resolves with the parsed response body.
 *
 * Errors:
 *   e.code === 'MB_NO_CONTACT'    no identity was supplied; nothing was sent
 *   e.code === 'MB_RATE_LIMITED'  503 after every retry
 *   a 404 is rethrown untouched — see below
 */
async function request(path, params = {}, opts = {}) {
  const contact = String((opts && opts.contact) || '').trim();
  const suppliedUA = String((opts && opts.userAgent) || '').trim();
  if (!contact && !suppliedUA) {
    // Deliberately thrown before the request rather than sent anonymously.
    // MusicBrainz's terms require a contactable identity, the matcher has
    // always refused to run without one, and this module is what makes
    // that true for every other caller too.
    const err = new Error(
      'MusicBrainz requests need a contact (Settings → MusicBrainz contact). Nothing was sent.'
    );
    err.code = 'MB_NO_CONTACT';
    throw err;
  }

  const serviceHealth = require('./serviceHealth');
  const url = `${MB_BASE}${path}`;
  const headers = { 'User-Agent': suppliedUA || buildUserAgent(contact) };
  let backoffS = 0;

  for (let attempt = 0; ; attempt++) {
    // Before EVERY attempt, retries included. A retry that skipped the
    // throttle would be a second request inside the same second, which
    // is the exact thing the 503 was complaining about.
    await mbThrottle.wait();

    try {
      const res = await axios.get(url, {
        params: { ...params, fmt: 'json' },
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      });
      serviceHealth.recordSuccess('musicbrainz');
      return res.data;
    } catch (e) {
      const status = e.response && e.response.status;

      // 404 on a specific MBID lookup is a normal "not found", not a
      // service failure — search endpoints don't 404, they return an
      // empty list. Rethrown untouched so the caller can tell it apart
      // from everything else, exactly as metadataMatch.js has always
      // done.
      if (status === 404) {
        serviceHealth.recordSuccess('musicbrainz');
        throw e;
      }

      if (status === 503 && attempt < MAX_503_RETRIES) {
        const advertised = _retryAfterSeconds(e.response);
        // The first 503 waits what MB asked for (2s when the header is
        // missing or unusable). Each further one doubles the last wait,
        // and a bigger Retry-After still wins — if they tell us to back
        // off harder than our own curve, they are the authority.
        backoffS = backoffS === 0
          ? (advertised || DEFAULT_RETRY_AFTER_S)
          : Math.max(backoffS * 2, advertised || 0);
        await _sleep(backoffS * 1000);
        continue;
      }

      if (status === 503) {
        // Out of retries. This is a real failure for the health
        // indicator, but it carries its own code so a caller can say
        // "MusicBrainz is rate-limiting us" rather than "no match".
        const err = new Error(
          `MusicBrainz rate-limited this request after ${MAX_503_RETRIES} retries (503)`
        );
        err.code = 'MB_RATE_LIMITED';
        err.response = e.response;
        serviceHealth.recordFailure('musicbrainz', err.message);
        throw err;
      }

      serviceHealth.recordFailure('musicbrainz', e.message || 'unknown error');
      throw e;
    }
  }
}

/**
 * The contact, or a throw. For callers that assemble a batch of work
 * before sending any of it — the matcher walks thousands of albums, and
 * finding out on album one that there is no contact is far better than
 * finding out on each of them in turn.
 */
function requireContact() {
  const contact = getContact();
  if (!contact) {
    const err = new Error(
      'A contact (URL or email) is required for MusicBrainz API requests. Set one in Settings → Metadata Refresh.'
    );
    err.code = 'MB_NO_CONTACT';
    throw err;
  }
  return contact;
}

module.exports = { request, buildUserAgent, getContact, hasContact, requireContact };
