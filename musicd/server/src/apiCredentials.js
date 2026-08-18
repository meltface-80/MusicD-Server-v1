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
  // service (similar to '2'). If a real Patreon-supporter key is
  // available later, swap it here.
  AUDIODB_API_KEY: '123',
};
