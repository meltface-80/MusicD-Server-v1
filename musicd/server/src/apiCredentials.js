// Baked-in third-party API credentials (#v1.1.0.23)
// ===================================================
//
// Centralised place where all the application-level API keys live.
// Previously these were per-user settings; users had to register
// their own apps with each service and paste the keys in. That was
// painful for non-technical users and unnecessary -- every desktop
// audio app embeds the developer's app credentials.
//
// What's here:
//   - Last.fm API key + Shared Secret (registered to the musicd
//     developer's Last.fm account). Used for scrobbling, "now playing"
//     updates, and bio fetches. Each musicd USER still has their own
//     session key (from auth.getMobileSession) -- only the app
//     credentials are shared.
//   - fanart.tv project key. Used for artist logo lookups.
//   - TheAudioDB API key. Used for artist images and as a bio source.
//
// v1.1.39.0 — TWO OF THESE CAN NOW BE OVERRIDDEN PER INSTALL, and the
// reason is that they are not all the same kind of key.
//
// Last.fm and AcoustID are fine shared. Last.fm meters per originating
// IP rather than per application key, and AcoustID application keys are
// meant to be embedded in distributed software — a user only needs their
// own key to SUBMIT fingerprints, which this app never does. Every
// install has its own address, so neither accumulates against one bucket
// no matter how many people run MusicD.
//
// The other two do accumulate, and one of them was never a developer key
// at all:
//
//   TheAudioDB '123' is the service's PUBLIC TEST KEY. Not this project's
//   key — the value the service hands out for trying the API, throttled
//   accordingly. It carries three call paths here (artist logos, artist
//   bios and, since v1.1.38.0, album bios), which makes it the weakest
//   link in the set and the one that got busier.
//
//   fanart.tv's key is a genuine project key, but fanart meters per
//   project key, so every install shares one allowance. fanart also
//   issues free PERSONAL keys to registered users, passed alongside the
//   project key as `client_key` — when present the personal allowance is
//   used instead, and newer images become visible.
//
// So both now read an optional per-install setting first. Baked-in
// values remain the default, so an install that sets nothing behaves
// exactly as before; the settings rows already existed (they were
// per-user before v1.1.0.23) and are still trimmed at boot by db.js.
//   - AcoustID application key (also lives in fingerprintMatch.js as
//     a constant; kept there because the fingerprint module is already
//     standalone).
//
// Honest notes:
//   - Yes, the secrets are extractable from this file. That's the
//     trade-off. If they get abused, services can revoke our keys --
//     which would affect every musicd user. We'll deal if it happens.
//   - These keys belong to musicd's developer account, not to any
//     individual user. If the developer ever changes ownership, these
//     get regenerated.
//   - MusicBrainz isn't in this list because it doesn't use API keys
//     -- it requires a User-Agent containing per-deployer contact
//     info (URL/email), which lives in mb_contact setting.

module.exports = {
  // Last.fm: registered as application "musicd" by the developer.
  // The secret is required for all signed calls (scrobble, now-playing,
  // auth.getMobileSession). Per-user session keys are still stored in
  // settings (lastfm_session_key) and obtained via login flow.
  LASTFM_API_KEY:    '6e8fc6baf4700609879badde48e70507',
  LASTFM_API_SECRET: '98b79037223d4f062050ffc4d5939ea8',

  // fanart.tv: project-level key, no per-user step.
  FANART_API_KEY: '3b4019910501b9577297652f20ce8731',

  // TheAudioDB: '123' is treated as a public test/demo key by the
  // service (similar to '2'). Overridable per install — see
  // getAudioDbKey() below, which is what call sites should use.
  AUDIODB_API_KEY: '123',
};

// settings is required lazily inside each accessor rather than at module
// load. This module is pulled in from several places during boot, and
// settings reaches the database; a top-level require would put a
// database dependency in front of a file whose whole job is to hand back
// four string constants. settings.get() already answers '' when the
// database is not open, so an early call degrades to the baked-in value.
function _setting(key) {
  try {
    return require('./settings').get(key, '').trim();
  } catch (e) {
    // No settings module resolvable (a partial test harness). The
    // baked-in default is the correct answer and the caller gets it.
    return '';
  }
}

/**
 * TheAudioDB key: the user's own if they have set one, else the shared
 * test key. A Patreon-supporter key raises the allowance substantially
 * and is metered to that supporter rather than to everyone running this
 * app, which is the entire point of allowing the override.
 */
function getAudioDbKey() {
  return _setting('audiodb_api_key') || module.exports.AUDIODB_API_KEY;
}

/**
 * fanart.tv keys, as the API wants them.
 *
 *   api_key     the project key — ALWAYS sent. fanart rejects a request
 *               without one even when a personal key is present, so this
 *               is not an either/or.
 *   client_key  the user's personal key, sent only when set. Its
 *               presence is what moves the request onto their own
 *               allowance instead of the shared project one.
 *
 * Returned as a params object ready to spread into the request, so no
 * call site has to remember the two-key rule or the "omit when empty"
 * part — an empty client_key sent as a parameter is not the same as no
 * parameter, and fanart treats it as a malformed key rather than as
 * absent.
 */
function getFanartParams() {
  const params = { api_key: module.exports.FANART_API_KEY };
  const personal = _setting('fanart_client_key');
  if (personal) params.client_key = personal;
  return params;
}

/** Which overrides are in use — for the settings UI, never the values. */
function overrideStatus() {
  return {
    audiodb: _setting('audiodb_api_key') !== '',
    fanart:  _setting('fanart_client_key') !== '',
  };
}

module.exports.getAudioDbKey = getAudioDbKey;
module.exports.getFanartParams = getFanartParams;
module.exports.overrideStatus = overrideStatus;
