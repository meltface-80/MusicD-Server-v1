# MusicD Changelog

All notable changes to MusicD are documented here. The most recent
release is at the top.

Categories used per release:
- **New** — features added
- **Changed** — behaviour modified, defaults adjusted
- **Fixed** — bugs squashed
- **UI** — visible interface changes
- **Migrations** — automatic data/config changes on first boot

---

## v1.1.22.0 — 2026-08-20 — THE ABOUT-THE-TRACK PANEL IS GONE

### Removed

- **The chevron at the bottom of the Now Playing screen, and the About-the-
  Track panel it opened.** The panel showed the artist bio and then Title,
  Album, Duration, Genre, Artist and Audio Format — every one of which was
  already on the screen the chevron was drawn over. The bio keeps its own
  route in from the album and artist screens (`BioModal`), so nothing is
  actually lost.
- With it go the state, the swipe-up gesture ref, the `AboutTrackOverlay` and
  `AboutRow` components, the `/library/artists/:name/bio` call this screen was
  making, seventeen dead style keys and the now-unused `ChevronUp` import.
  The client bundle is ~5 kB smaller.
- `showAbout` was one term of the boolean that suppresses the queue swipe
  while an overlay is open. Only that term was removed; the volume popover,
  DSP, renderer modal, overflow menu and share card still suppress it.

### Tests

- `now-playing-about.test.js` — 8 assertions, seven mutations proven
  red-then-green. It pins all six of the panel's footholds as gone, that the
  format strip the chevron sat under is untouched, that the swipe guard kept
  its five other members, and that `ChevronUp` left while `ChevronDown` — which
  the queue's disclosure arrow still uses — stayed. This project has shipped a
  half-finished removal before; `artwork-longpress.test.js` exists for the same
  reason.

---

## v1.1.21.0 — 2026-08-20 — THREE CAROUSELS ON THE HOME SCREEN

### New

- **Random albums on the Home screen.** A carousel of albums picked at random
  from the whole library. Its heading is a button: tapping it opens a full
  wall, three across and five down, with a **Refresh** at the top for another
  roll. Modelled on MusicD-Remote's random wall, which is where the shape and
  the refresh affordance come from.
- **`GET /api/library/albums/random-set?limit=N`** — N albums at random,
  defaulting to 15 and capped at 60, in the same row shape as
  `/albums/recent`. Distinct from the existing `/albums/random`, which returns
  one id for "play something". Deliberately unseeded, unlike the library
  grid's Random *sort*: that one is paged and has to hold still between pages,
  where this returns one short set and a fresh roll is the entire point.
- **`GET` / `PUT /api/home/prefs`** — which carousels are switched on. A
  partial patch, so two switches tapped in quick succession cannot overwrite
  each other.

### Changed

- **"Recent activity" is now two rows, not one behind tabs.** *Recently added*
  and *Recently played* each have their own carousel. Seeing both used to mean
  tapping between them, with whichever you were not looking at invisible. The
  PLAYED/ADDED tab strip is gone.
- **Settings → Home Screen now has two groups, separated by a break line.**
  Above it: the three carousels, which read this server's own library. Below
  it: the four Music News sources, which fetch from Pitchfork, Qobuz and
  Bandcamp.
- **The three carousels are ON by default; the four news sources stay OFF.**
  They are two settings keys and two endpoints on purpose — one blob would
  have forced one default onto both halves, and whichever default won would
  have been wrong for the other. A carousel costs one local query when the
  Home screen mounts: no upstream request, no background timer, nothing to
  schedule. A row that is switched off does not run its query at all.
- The library counters (ARTISTS / ALBUMS / TRACKS / GENRES) are unchanged and
  stay at the top of the Home screen.

### UI

- Random albums are held for five minutes at module scope, so opening an album
  and coming back does not reshuffle the row you were looking at. The wall's
  Refresh button is there for when a new roll *is* what you want.
- The wall paints skeleton tiles rather than a spinner, so tapping Refresh does
  not collapse the grid and bounce the page back to the top.

### Tests

- `home-carousels.test.js` — 41 assertions. The defaults (all-on, and not
  reaching into the news blob), the partial patch, the type checks on both the
  read and write paths, a corrupt settings row reading as defaults, and that
  reading or writing a carousel preference registers no timer and touches no
  network. The `random-set` SQL is lifted out of the route and run against a
  real SQLite: it honours the limit, never returns an empty or excluded album,
  and actually varies between calls. Route-declaration order is pinned too —
  `/albums/random-set` after `/albums/:id` would 404 with `id="random-set"`,
  and the symptom is an empty carousel, not an error anyone would trace back.
- Sixteen mutations proven red-then-green, including the two that first slipped
  through: a truthiness check in place of the type check on the read path, and
  the counter tiles moving below the carousels.
- `artwork-longpress.test.js` now lists `RandomAlbumsScreen.jsx` among the
  surfaces that draw artwork and must mark it undraggable.

---

## v1.1.20.0 — 2026-08-20 — MUSIC NEWS IS OPT-IN, AND TAGS MOVES TO THE MENU

### Changed

- **Tags moved from Settings to the side menu**, directly under Favourites. It
  was filed under Settings → Tags, which put a browsing surface behind an admin
  screen — tags are a way through the library, like Favourites and Saved for
  later, and those live in the menu. The management UI itself is unchanged; only
  where it hangs has moved.

- **Settings → Home Screen** takes the slot Tags left.

### New

- **Music News is off until you ask for it.** Four switches, one per row:

  | Switch | Feeds it runs |
  |---|---|
  | New releases from Qobuz | the Qobuz Magazine scrape |
  | New releases from Bandcamp | the Bandcamp Daily crawl |
  | Pitchfork reviews and news | three Pitchfork RSS feeds |
  | Bandcamp Daily reviews | the Bandcamp Daily crawl |

  **Every one is off on a new install, and off means off.** Not "fetched and
  hidden" — with nothing enabled the server makes no request to Pitchfork,
  Qobuz or Bandcamp, and registers no refresh interval at all. Until now the
  loop ran unconditionally: an interval at boot and five upstream feeds every
  30 minutes whether or not anyone wanted them, with no way to decline.

  Switching the last source off **stops the timer** rather than leaving it
  fetching into a hidden panel, and clears the rows that source left behind so
  the Home screen empties immediately instead of showing the last fetch until
  `pruneOld` reaches it 30 days later.

  Turning one on starts the loop and fetches once, straight away.

  Two efficiencies fall out of the mapping. The two Bandcamp rows come from a
  single crawl, so it runs for either and only once when both are on — and when
  only the reviews are wanted, the per-album resolution added in v1.1.18.0 is
  skipped entirely, which is ~24 requests saved. The Qobuz crawl produces
  magazine articles as well as release cards; with no separate switch for them
  they ride with the Qobuz row, and the setting says so rather than leaving it
  to be discovered.

- `GET /api/news/prefs` and `PUT /api/news/prefs`. The PUT is a partial patch,
  so two quick taps on different switches cannot race into overwriting each
  other with a stale copy of the whole object. `GET /api/news/feed` now reports
  `enabled` alongside its items, which is what lets the Home screen leave the
  block out entirely rather than render an empty panel with a refresh button
  that would fetch nothing.

### Tests

- `news-prefs.test.js` — 29 assertions, run against a real in-memory database
  with `axios` replaced by a counter that **throws if anything reaches for the
  network**, so "makes no request" is demonstrated rather than asserted.

  Covers: all-off by default, an absent settings row reading as off rather than
  on, `start()` scheduling nothing, a refresh making zero calls, the timer
  starting on the first enable and stopping on the last disable, which feeds
  each row selects, the purge clearing only disabled sources, and a settings
  blob that cannot talk itself into being enabled — malformed JSON, a
  non-object, a truthy string, or keys from a later build.

  The first version of the harness stubbed `global.setInterval` for the
  duration of the require and restored it afterwards, so every later
  `applyPrefs()` got the real one, registered a live 30-minute handle, and hung
  the run. It reads the module's own timer through a test hook instead.

  Suite is 20 files and 430 assertions. Eight mutations run, each red then
  green.

### Unverified on hardware

- The UI moves. No `<head>`, root-style or safe-area shell changes.

---

## v1.1.19.0 — 2026-08-20 — PLAYLISTS, AND THE MENU ROWS THAT NEVER ARRIVED

### New

- **Playlists.** The track menu's "Add to Playlist" row has been greyed out
  with a `v60` badge on it since v57, because nothing backed it. Now something
  does.

  `playlists` and `playlist_tracks` tables, a `/api/playlists` router, a
  **Playlists** entry in the sidebar, and an **Add to Playlist** sheet on the
  ⋯ menu. The sheet ticks the playlists a track is already in — adding is
  idempotent server-side, and this is what makes that visible rather than
  mysterious — and "New playlist" creates *and* fills in one round trip.

  Track membership is keyed `(playlist_id, track_id)`, so tapping the menu row
  twice cannot silently duplicate a row. The cost is that a playlist cannot
  deliberately repeat a track; that is the rarer want, and the menu action is
  the common one.

  Positions continue from the current **maximum**, not the row count. Counting
  reuses a position a later track still holds, and `ORDER BY position` is then
  ambiguous between them.

- **"Add to Tag" and "Save for later" now work** — and were waiting on
  nothing. The per-track tag endpoints and the `save-for-later` route both
  already existed and were already wired up for albums; only these two menu
  rows were left disabled, one badged `v61` and the other `v61`. They call the
  routes that were already there, and Add to Tag opens the same `TagPicker` the
  album screen has used since v1.1.0.67.

### UI

- **The share card is centred instead of anchored to the bottom.** It was a
  bottom sheet, which put it — and its own Download button — underneath the
  mini transport bar. Both the album screen's card and the Now Playing one now
  sit in the middle of the screen and clear the safe areas themselves.

- **The Download button is gone from both.** On a plain-HTTP LAN install
  `navigator.canShare` is undefined, so that button only ever offered a blob
  download. Touch-and-hold on the card gives the OS save-and-share sheet, which
  is what the `.allow-callout` class added in v1.1.15.0 is there for.

### Still disabled, deliberately

- **Suggestions.** Unlike the three rows above it, this one has nothing behind
  it *and* no single obvious meaning — "more from this artist", "same genre",
  "things you have not played" and "similar-sounding" are four different
  features with four different implementations. Building one and calling it
  Suggestions would be inventing a spec rather than completing one, so it keeps
  an honest placeholder until that call is made. Its badge now reads "soon"
  rather than a version number it has already missed.

### Tests

- `playlists.test.js` — 32 assertions driving the **real route handlers**
  against a real in-memory SQLite built from **db.js's own DDL**, lifted from
  the source rather than restated, so a schema change that breaks the routes
  fails here instead of on a device.

  One assertion had to be rewritten: checking the resulting track *order*
  after a remove-then-re-add passed the position-collision bug, because on a
  tie SQLite returns rows in rowid order, which happened to be the order the
  test wanted. It now asserts the invariant directly — positions within a
  playlist are unique.

  Suite is 19 files and 401 assertions. Six mutations run, each red then green.

### Unverified on hardware

- All the UI work. No `<head>`, root-style or safe-area *shell* changes, so the
  home-screen shortcut does not need deleting and re-adding.

---

## v1.1.18.0 — 2026-08-20 — BANDCAMP RELEASES NOW COME FROM THE ALBUM PAGE

### Fixed

- **Bandcamp new releases all showed the same album art.** Two separate faults
  in one expression, both reproducible, both pushing the same way.

  The candidate chain was written as

  ```js
  $a.find('img').first()
    .add($a.next('img'))
    .add($a.parent().find('img').first())
    .add($a.closest('figure, article, section, li, div').find('img').first())
    .first()
  ```

  and read as "try these in order". **It is not.** Cheerio's `.add()`, like
  jQuery's, returns the combined set in *document* order, so `.first()` yields
  whichever candidate appears earliest in the page — not the first strategy
  that matched. A badge or logo above the anchor beat the cover the anchor
  itself wrapped.

  And the widest fallback, `closest('figure, article, section, li, div')`,
  matches the article body in a prose article — which is what Bandcamp Daily's
  lists mostly are, paragraphs with bare album links. `.find('img').first()` on
  the article body is the article's **hero image**, and every release on the
  page resolved to it. That is the reported symptom exactly.

  Both were confirmed by running the shipped expression against representative
  markup before anything was changed, and the test restores it verbatim to
  prove the fix is what fixes it.

  The rule now: **a release card contains exactly one album link.** The search
  walks out from the anchor only while the ancestor still holds just this one
  album anchor; the moment an ancestor holds two, we have left the card and
  anything found there belongs to the page. The same rule bounds the
  adjacent-sibling check, because a banner directly above two album links is a
  sibling of both and the cover of neither.

- **The Qobuz parser had the same fault, twice.** It was not in the report —
  the Bandcamp row is the one that shows it most starkly — but the identical
  `.add()` expression picked its cover, and another picked the artist link.
  Fixing only the reported site is the partial migration `CLAUDE.md` warns
  about, so both were corrected: a "Hi-Res" badge sitting above an album link
  was beating the cover the anchor wrapped.

  Qobuz deliberately keeps its wider parent search and still drops cards with
  no image. Its list pages carry a real cover for every album, so the
  one-album-per-container rule would only cost cards, and the hero-image leak
  came from a `closest()` fallback that parser never had.

- **Bandcamp releases are now read from the album's own page, not scraped
  from the article.** Running the fixed parser against the live site is what
  settled this. On the article behind the report —
  `daily.bandcamp.com/lists/queer-country-album-guide` — 15 album links gave:

  | title | artist |
  |---|---|
  | self-titled 1973 album | Lavendercountry |
  | final album | Lavendercountry |
  | Rhinestone Tomboy | Myabyrne |
  | `,` | Casaamarela |

  The titles are whatever prose the link happened to sit on; the artists are
  the subdomain with a capital letter — "Cleopatrarecords" for a Patsy Cline
  record, because that link points at a label. And with the article hero
  correctly refused, **no card had a cover at all**.

  None of it is recoverable from the article, because the article does not
  contain it. The album page does: `og:image` is the real cover and the JSON-LD
  block carries the real title and artist. Same article, after:

  | title | artist |
  |---|---|
  | Lavender Country | Lavender Country |
  | Blackberry Rose | Lavender Country |
  | Rhinestone Tomboy | Mya Byrne |
  | Walkin' After Midnight | Patsy Cline |

  **24 releases, 24 distinct covers, in 5.9 seconds.**

  The original code rejected per-album fetches to "keep the network footprint
  tight". Right instinct, wrong trade — it bought a row of wrong covers and
  prose fragments. The footprint is bounded instead: deduplicated, capped at 24
  album pages per refresh, four at a time, and cached across refreshes (an
  album's title and cover do not change). Failures are cached too, so a dead
  link is not retried every half hour, and one bad album costs only its own
  card.

  Albums that will not resolve are dropped rather than published with guesses.

- **A release with no trustworthy cover is still listed.** It used to be
  discarded. The client already draws a disc placeholder for a null
  `image_url`, so keeping the card costs nothing, and dropping it would quietly
  shrink New Releases on exactly the prose-style articles that carry the most
  of them.

- **A cover that lands on two releases is now published on neither.** A
  backstop for layouts the walk does not anticipate: the parser detects an
  image it used more than once, clears it from those cards — keeping the cards
  — and says so in the log. No cover beats the same wrong cover on every row.

### Tests

- `news-bandcamp.test.js` — 16 assertions over real markup: the prose article
  that caused the report, a badge above a cover, properly structured cards,
  covers beside the link, `background-image` cards, a banner shared by two
  albums, lazy-loading attributes, deep nesting, and a bare anchor. One
  assertion sweeps the whole file, not one function, and fails if `.add()` or
  the over-broad `closest()` returns to either parser — it was written that way
  after the Qobuz sites turned up in exactly that sweep.

  A further 17 cover the album-page resolver: the JSON-LD and `og:title`
  paths, an album whose name contains a comma, the fetch cap, the concurrency
  limit, the positive and negative caches, and one failure not taking the
  refresh down. One names a trap that was avoided — JSON-LD carries
  `datePublished`, and using a 1973 reissue's date as `published_at` would put
  it past `pruneOld`'s 30-day cutoff and delete it on the next sweep.

  Suite is 18 files and 369 assertions. Twelve mutations run, each red then
  green, including the shipped code restored verbatim.

### Verified against the live site

- The whole pipeline was run against daily.bandcamp.com — homepage, five
  articles, album resolution — and produced 24 releases with 24 distinct
  covers and correct titles and artists. That run is what found the deeper
  problem: the first fix stopped the wrong cover but left every card with no
  cover, because the information was never in the article.

---

## v1.1.17.0 — 2026-08-19 — GETTING THE BUG REPORT OFF THE PHONE

### Fixed

- **The bug-report screen blamed the wrong thing, and the copy button threw.**
  Both were the same cause.

  It said "Your browser doesn't support sharing files directly" and told the
  user to go and find the JSON on the server. Safari on iOS shares files
  perfectly well — what it will not do is expose the Web Share API on an
  **insecure origin**. MusicD is served over plain HTTP on a LAN address, so
  `navigator.share` and `navigator.canShare` are simply absent, and the old
  code read that absence as a browser limitation.

  `navigator.clipboard` is withheld on exactly the same terms, which is why
  "Copy as text" failed with `undefined is not an object (evaluating
  'navigator.clipboard.writeText')` — the code dereferenced an object the
  browser had not provided. Neither failure is fixed by switching browsers.

  The screen now distinguishes the two cases and says which one it is.

- **"Copy as text" works on a plain-HTTP install.** It falls back to
  `document.execCommand('copy')`, which is deprecated but is not
  secure-context-gated, and is therefore the only thing that works on exactly
  the origins that need it. The textarea is positioned off-screen rather than
  hidden (a `display: none` textarea cannot be selected) and uses
  `setSelectionRange`, because iOS ignores `select()` on its own and would
  otherwise copy nothing while reporting success.

### New

- **"Save report file"** downloads the real `.json` to the device. The server
  already saved it and already served it back as an attachment
  (`GET /api/bug-report/file/:name` → `res.download`), so this needed no
  server change at all — only a button pointing at it.

  On iOS the file lands in **Files → Downloads**, where the mail app's
  attachment picker can reach it: tap **Save report file**, tap **Open email
  app**, attach. That replaces "ask the developer for
  `2026-08-19T20-38-09-129Z-m01rt8.json` — it's saved on your box".

  The client's filename guard is the server's own `/^[\w\-:.]+\.json$/`, so a
  name the route would reject is never turned into a URL that 400s after the
  user has already tapped.

  One-tap attachment still needs the Web Share API and therefore HTTPS. The
  button is offered only when that path is unavailable; where it is available,
  nothing changes.

- The confirmation line now distinguishes the two paths. It said "your mail app
  should be open with the report ready to send" on both, including the `mailto:`
  path, which cannot carry an attachment — which is how a report arrives with
  nothing attached and nobody notices.

### Tests

- `bug-report-share.test.js` — 21 assertions over the capability classification
  (secure and insecure, half-present APIs, a probe that throws), the clipboard
  guard, and the download URL. One asserts the client's filename guard and the
  server's cannot diverge.

  Suite is 17 files and 336 assertions. Six mutations run, each red then green.

### Unverified on hardware

- The download landing in Files, and the `execCommand` copy, are both iOS
  behaviours this environment cannot exercise.

---

## v1.1.16.0 — 2026-08-19 — PLAY NOW / PLAY NEXT ON UPCOMING TRACKS TOO

### Fixed

- **Tapping a track that had not played yet just started it**, with no choice
  offered. v1.1.14.0 shipped the Play now / Play next sheet only for tracks
  *behind* the playhead, on the reading that a track not yet reached is
  unambiguous to tap. It is not — "play next" is at least as useful looking
  forward, where it means "after this one" rather than "in twenty minutes'
  time".

  The sheet now opens for every track except the one playing, which keeps its
  restart-on-tap: it is already playing, and "play next" would mean nothing.

- **"Play next" needed a different destination depending on which side of the
  playhead the track started.** `reorderQueue` splices the track out and back
  in, so the removal shifts what came after it down by one — but only what came
  after it:

  - from **behind** the playhead, the current track slides down to
    `queueIndex - 1` as the moved track is pulled out from behind it, so the
    slot immediately after it is `queueIndex`;
  - from **ahead**, the removal happened after the current track, which has not
    moved, so that slot is `queueIndex + 1`.

  One answer for both is an off-by-one in whichever case it is wrong for: too
  low and the moved track displaces the one playing, too high and it lands a
  place further down than asked. `playNextTarget` now takes the source index
  as well.

### Tests

- The "Play next" test now models the server's queueIndex adjustment as well as
  its splice, and runs exhaustively over every source position either side of
  every playhead position, asserting both that the playing track did not move
  and that the chosen track landed directly after it.

- One assertion was added after a mutation slipped through: dropping the source
  index at the call site left `from` undefined, made `undefined < queueIndex`
  false, and sent every move down the ahead-of-the-playhead path — silently
  wrong for exactly the tracks the feature first shipped for. Testing the
  function alone could not catch that, so the call site is now checked too.

  Suite is 16 files and 315 assertions. Five mutations run, each red then
  green.

### Unverified on hardware

- Visual only. No `<head>`, root-style or safe-area changes.

---

## v1.1.15.0 — 2026-08-19 — ARTWORK, BRANDING, AND ONE BUTTON THAT HAD NOTHING LEFT TO DO

### Fixed

- **Grey bands above and below the album art.** One element was doing two
  jobs: the flexible box that absorbs whatever vertical space the screen has
  left, *and* the surface the art was drawn on — `--jp-bg-surface` background,
  `objectFit: 'contain'`. On a tall phone that box is far taller than it is
  wide, so a square cover fitted to the width and left the surface showing
  above and below it. Those were the bands.

  The wrapper now only centres and paints nothing, and a separate square box
  is what the art fills. `objectFit` is `cover`, so every cover is the same
  size and an odd-shaped one is cropped rather than framed — nearly all covers
  are already square, so in practice nothing is cropped.

  The share button is positioned against the square box rather than the
  wrapper; anchored to the wrapper it would float in the empty space below the
  cover.

### UI

- **The share button now stands out on any artwork.** It sampled nothing and
  wore one translucent-dark chip, which disappeared on a bright sleeve. It now
  reads the bottom-right corner of the cover — the corner it actually sits on,
  not a whole-image average — and takes the opposite palette: dark on light
  art, light on dark art.

  The brightness is WCAG relative luminance over linearised sRGB, not the
  `0.299R + 0.587G + 0.114B` shorthand. That shorthand operates on
  gamma-encoded values and reads a saturated yellow as darker than it looks,
  which is exactly the sleeve in the report.

  Threshold 0.5, which sits well above mid-grey (#808080 is about 0.216), so
  the established dark chip holds until the art is genuinely bright.

- **The MusicD mark is gone from the side menu and the Settings header.** The
  wordmark stays in the menu. `src/assets/md-icon.png` now has no importers; it
  is left in the tree rather than deleted, since it is the same duck-head mark
  as the app icons in `public/`.

### Removed

- **"Clear stuck update files".** It existed for one failure — a stale tar in
  the local watch dir pinning `findAvailableUpdate()` on an old version — and
  that was fixed twice over in the meantime:

  - **v1.1.0.73** changed the rule to "highest version wins regardless of
    source", so a stale *lower* version can no longer pin anything;
  - **v1.1.2.8** made the update check itself call
    `clearPendingTars({ staleOnly: true })`, so those files are now swept
    automatically on every check.

  What was left was a button whose only behaviour the automatic sweep does not
  already have is deleting tars at or *newer* than the running version — that
  is, throwing away a download the user deliberately started. A footgun, not a
  recovery tool.

  `POST /api/update/clear-pending` and the wipe-all mode of
  `clearPendingTars()` are untouched on the server; only the UI is gone.

### Changed

- **"Force re-check" is now just "Check now"**, and no longer sits under a
  "Troubleshoot updates" heading. It is not troubleshooting: the manifest is
  polled on a schedule, and this is how you pick up a release the moment it is
  published rather than waiting for the next poll.

### Tests

- `now-playing-art.test.js` — 31 assertions. The luminance maths is a pure
  module (`client/src/artLuminance.js`) so the palette decision is tested
  directly rather than eyeballed on a phone: the actual Hard-Fi yellow, dark
  sleeves, mid-grey, near-white, mixed corners, transparent pixels, and
  degenerate cover sizes.

  One assertion guards the removal rather than the code: it fails if the
  automatic stale-tar sweep is ever taken out, because that is the thing whose
  existence makes removing the button safe.

  Suite is 16 files and 310 assertions. Seven mutations run, each red then
  green.

### Unverified on hardware

- All of it is visual. No `<head>`, root-style or safe-area changes, so the
  home-screen shortcut does not need deleting and re-adding.

---

## v1.1.14.0 — 2026-08-19 — THE QUEUE SCREEN

### New

- **The playing track is pinned to the top of the queue.** Played tracks pass
  up out of sight and stay reachable by scrolling back; the list re-pins
  whenever the track changes, so it follows playback instead of drifting.

  Measured against the sticky header rather than `scrollIntoView`, which knows
  nothing about a header inside the scroller and would drop the row underneath
  it.

- **Skipped tracks fold into one "N skipped" row.** Tap it to expand the run.

  Runs, rather than one row for the whole queue: a queue view whose rows are
  out of queue order is worse than a few extra rows, and skips arrive in runs
  anyway. A run of one still folds — left unfolded it would render exactly like
  a played track, which is the distinction the feature exists to draw.

  The server records this. `advanceTrack` already distinguished `via: 'manual'`
  (you pressed next) from `via: 'auto-end'` (the track finished) — since
  v1.1.0.87 — so the skip signal needed no new plumbing, only recording.
  Tapping a track further down the queue also marks everything it passes over,
  because none of it was played.

  Marks are keyed by **track id, not queue position**. Eight sites splice
  `zone.queue` — reorder, remove, remove-batch, append, replace, clear and the
  boot restore — and an index-keyed parallel array would have to be kept in
  step at every one of them, which is the partial migration `CLAUDE.md` warns
  about. Ids move with their rows, so none of those sites changed. The
  trade-off is that the same track twice in one queue shares one mark.

- **Tapping a track the queue has already reached asks what you meant** — play
  it now, or line it up next — instead of guessing. Upcoming tracks still play
  directly, which is unambiguous and the behaviour that already existed.

  "Play next" inserts at `queueIndex`, not `queueIndex + 1`: the current track
  slides down one as the moved track passes it, so `+ 1` would land a place too
  far.

### UI

- **The queue header is fixed and opaque.** The radio toggle and the
  remaining-count/bulk row stay at the top while the list moves beneath them,
  and the top bar carries a background too. Both were transparent over this
  screen's blurred album-art wash, so track rows were visible against them as
  they scrolled past.

### Tests

- `queue-skipped.test.js` — 31 assertions. The fold is a pure function in its
  own module (`client/src/queueFold.js`, following `scrollRestore.js`) so it
  can be driven directly: runs, lone skips, the playhead boundary, selection
  mode, and a sweep asserting every track appears exactly once across every
  combination of marks and playhead positions.

  The multi-site guard compares `skipped` against `radio` — same origin, same
  lifetime, same hydration paths — rather than pinning a count that would go
  stale. Miss one path and the fold silently stops working on whichever route
  that was, which is how the progress-bar anchor shipped broken twice.

  Suite is 15 files and 279 assertions. Seven mutations run, each red then
  green.

### Unverified on hardware

- Everything visual here. No `<head>`, root-style or safe-area changes, so the
  home-screen shortcut does not need deleting and re-adding.

---

## v1.1.13.0 — 2026-08-19 — TWO INSTALLS ON ONE HOST NO LONGER FIGHT

### Fixed

- **Two musicd containers on one host could destroy each other's update.**
  The updater sidecar was always called `musicd-updater`, and every update
  began with `docker rm -f musicd-updater` to clear a stale one.

  That is fine for a single install. A host that took one of the broken
  pre-v1.1.10.0 updates is left running **both** `musicd` and `musicd-server`
  — two servers, both polling the same manifest, both holding the Docker
  socket, both entitled to start an update. Whichever moved second force-
  removed the other's **in-flight** sidecar. Land that between the victim's
  `docker rm <container>` and the `docker run` that recreates it, and the
  machine is left with no musicd container at all, and nothing in the log to
  explain it.

  The sidecar is now named after the container it is updating —
  `musicd-updater-musicd-server`, `musicd-updater-musicd` — so the two are
  independent. The name is sanitised to Docker's `[a-zA-Z0-9][a-zA-Z0-9_.-]*`,
  since it comes from `docker inspect` rather than from us.

  The old shared name is still cleaned up, because it is debris on every
  install that has ever updated — but with plain `docker rm`, never `-f`. If
  another musicd on the host has one running under the old name right now,
  `docker rm` simply fails and leaves it alone, which is exactly the wanted
  behaviour.

- **`docker logs musicd-updater` was useless advice** once the sidecar could
  be called something else. The stuck-update hint now names the container that
  actually exists.

### Tests

- Seven more assertions in `updater-container.test.js` (27 in the file, 248 in
  the suite): distinct names per install, a legal Docker name out of every
  input including empty and non-ASCII, the legacy name cleaned but never
  forced, and the log hint tracking the real name. Four mutations, each red
  then green.

---

## v1.1.12.0 — 2026-08-19 — UPDATER HOUSEKEEPING, FOUND IN A SUCCESSFUL UPDATE'S LOG

The v1.1.10.0 updater fix worked: the first clean in-app install on a
README-style container (`musicd-server`, not `musicd`) preserved all five
mounts, stopped and removed the right container, and started the new one.
Two things in that log still needed fixing.

### Fixed

- **The Docker socket was passed to `docker run` twice.** It is always among
  the mounts read back off the running container — musicd cannot have spawned
  the updater without it — and `launchArgsFor()` added it again, so every
  update ran `docker run … -v /var/run/docker.sock:/var/run/docker.sock …
  -v /var/run/docker.sock:/var/run/docker.sock`.

  The Docker this was observed on tolerates a repeated identical mount. One
  that rejects a duplicate mount destination would fail the run — and then
  fail the byte-identical rollback run immediately after, leaving the machine
  with **no container at all**. The socket is now appended only if the
  preserved mounts somehow lack it, and says so in the log when it does.

### Changed

- **The update log now reports everything it preserved, not just the mounts.**
  It printed `preserving mounts:` and then went straight to `config
  preservation complete`, so a log could not distinguish "carried over the
  env vars, network mode, devices and group-adds" from "carried over
  nothing". That silence is exactly how the wrong-container bug survived
  several releases — the one line it did print looked plausible.

  It now names the env vars, network mode, restart policy, devices and
  group-adds as well, so `--device /dev/snd` and `--group-add 29` surviving
  an update is visible in the log instead of needing `docker inspect`.

### Tests

- `updater-container.test.js` grew from 14 to 20 assertions and stopped being
  purely textual. The config-preservation section of the generated script is
  now **executed** by `/bin/sh` against a stub `docker` that answers the six
  `inspect --format` calls, and the resulting flags are asserted: the socket
  exactly once, `:ro` surviving on the music mount, `--device` and
  `--group-add` present, docker-injected `PATH` left behind, and every
  category reported in the log.

  The first version of the socket check counted occurrences inside
  `ALL_FLAGS` only and passed the bug it was written for — the duplicate came
  from the launch args, which are concatenated at the `docker run` line forty
  lines away. It now composes the whole command and counts that.

  Suite is 14 files and 241 assertions.

### Documentation

- `CLAUDE.md`'s dependency note listed one vite-related advisory; there are
  now four. All four are dev-server only and production is a static
  `vite build`, so the reasoning is unchanged — but the note now records the
  exact `npm audit` totals to expect (**4 in `server/`, 2 in `client/`**), so
  a future build log can be checked against it at a glance instead of being
  waved through.

---

## v1.1.11.0 — 2026-08-19 — THE FULL SORT SUITE ON THE ALBUM WALL

### New

- **Seven ways to sort the album library, each with a direction.** The three
  Title / Artist / Year pills are now one chip that opens a sheet:

  | Sort | Opens at | Reversed |
  |---|---|---|
  | Album name | A → Z | Z → A |
  | Artist | A → Z | Z → A |
  | Release year | Newest first | Oldest first |
  | Recently added | Newest first | Oldest first |
  | Most played | Most played first | Least played first |
  | Last played | Most recent first | Longest ago first |
  | Random | — | re-pick to reshuffle |

  Modelled on MusicD-Remote's library wall, including the two rules that are
  easy to lose. Alphabetical sorts open A→Z while quantitative ones open with
  the biggest or newest first, because that is what "sort by year" means — so
  the default direction is per sort, not global. And **re-picking the sort you
  are already on reverses it**: the arrow on the active row is the whole
  direction affordance, there is no second control. Random is the one row with
  nothing to reverse, so re-picking it reshuffles.

  The chip is on the Favourites screen too. Each grid — Albums, Favourites,
  Saved for later — keeps its own sort, so putting Favourites in Most played
  order does not re-sort the main wall.

- **The sort survives the app being closed.** It is written to `localStorage`
  the moment it changes, not on unmount — iOS discards a backgrounded PWA and
  an unmount handler is exactly what does not run when it does. Relaunching
  from the home-screen shortcut comes back to the sort you left.

  The stored blob is validated field by field on read rather than trusted:
  JSON can parse cleanly and still be the wrong shape, and an unvalidated
  sort would reach the query string and come back as an empty grid with no
  way out short of clearing site data.

### Fixed

- **Albums with no year or no added date now sort last in BOTH directions.**
  Previously there was no such thing to get wrong — but with Release year
  reversible, treating "no year" as year zero would float every undated album
  to the top the moment you asked for oldest-first. On a library the scanner
  could not read many dates for, that is most of the first screen.

- **Paging is now totally ordered.** Every sort ends with title then id as a
  tiebreaker. Without one, `LIMIT/OFFSET` over rows sharing a sort key — every
  album released in the same year, every album never played — lets SQLite
  return them in any order it likes per page, so consecutive pages overlap:
  the grid shows duplicates and silently drops albums. This was latent on the
  old Year sort too.

### Changed

- `GET /api/library/albums` takes `sort`, `dir` and `seed`. `sort` accepts the
  seven ids above; `title` still resolves to `album` so an older client keeps
  working. `dir` is `asc`/`desc`, case-insensitive, and an absent or
  unrecognised value now means **that sort's own default** rather than a
  blanket ascending — so `?sort=year` with no direction returns newest first
  where it used to return oldest first.

- The random sort is a seeded shuffle rather than `ORDER BY RANDOM()`. The
  order has to be a pure function of (album, seed) or paging through it
  re-rolls the shuffle and serves the same album twice while missing others.
  Reshuffling is a new seed, not a new query. `db.init()` registers the hash
  on the connection.

### Tests

- `library-sort.test.js` — 65 assertions, run against a real in-memory SQLite
  rather than asserting on the shape of the SQL. It builds a library with
  every awkward case in it (no year, year 0, no album artist, a lower-case
  title, two albums sharing a year, one never played) and checks each sort
  pages cleanly with no duplicates or gaps.

  It also pins the client's option list against the server's field by field.
  The list exists on both sides of the wire, and a sort added to the sheet
  that the server does not know falls back to Album name — the chip would read
  "Most played" while the wall stayed alphabetical, with nothing logged at
  either end.

  Suite is now 14 files and 235 assertions.

### Unverified on hardware

- The sheet's layout on a phone. No `<head>`, root-style or safe-area changes,
  so the home-screen shortcut does not need deleting and re-adding.

---

## v1.1.10.0 — 2026-08-19 — UPDATES THAT ACTUALLY INSTALL, AND FOUR UI/PLAYBACK FIXES

### Fixed

- **In-app updates never installed on a README-style install.** This is
  the "downloads, says it succeeded, still on the old version" report,
  and the reason was not the mount — it was the name.

  The generated update script had `musicd` hardcoded in nine places,
  because `install.sh` always passes `--name musicd`. The README's
  `docker run` — and the one on the Pages site — creates `--name
  musicd-server` from an image built as `musicd-server`. On those
  installs every line missed: six `docker inspect musicd` calls returned
  nothing, so no mounts, environment variables, network mode, devices or
  group-adds were carried over; `docker stop musicd` and `docker rm
  musicd` matched nothing, so the old container kept running; and
  `docker run --name musicd … musicd:latest` started a *second* container
  beside it under `--network host`, with no `/data` and no `/music`.

  The single preserved mount in the log — `/var/run/docker.sock` — was
  the one the script contributes itself.

  The server already resolved its own container id from
  `/proc/self/mountinfo` without guessing (v1.1.7.0). That resolution now
  also yields the container's real name and image, and the script is
  generated with both. It additionally refuses to run at all if that
  container is not present, rather than proceeding to build an image and
  orphan the user's data. Registry ports are handled (`reg.local:5000/x`
  tags a rollback as `reg.local:5000/x:rollback`, not `reg.local:rollback`).

  **This release cannot deliver itself** — the broken updater is the one
  that would install it. Take v1.1.10.0 manually once; see the README
  section "Upgrading from v1.1.9.0 or earlier". Every update after it is
  in-app again.

- **Playback went wrong after a track had been paused for a while.**
  `audio/alsa.js` counted paused time as played time. The USB-DAC path
  cannot ask `aplay` where it is, so it estimated the playhead from wall
  clock; `pause()` SIGSTOPs the `ffmpeg | aplay` pair — the audio stops
  dead — but nothing stopped the clock and `resume()` never gave the time
  back. The error was exactly the length of the pause.

  `Math.min(duration, elapsed)` then clamps it, so a pause longer than the
  track's remainder pinned the reported position at exactly `duration`.
  That disarmed the v1.1.0.89 `playedToEnd` guard — `position >= duration
  - 5` reads true — so the guard that stops a renderer which hung up early
  from advancing the queue no longer held, and the next `STOPPED` tick
  skipped to the next track. **Press play after a long pause and you got
  the next track.** It also walked the progress bar to the end while
  paused, and made `maybePreQueueNext` fire the instant play was pressed.

  `pause()` now stamps `pausedAt`, `resume()` advances `startedAt` by the
  paused duration, and `getPositionInfo()` measures to `pausedAt ||
  Date.now()`.

- **The Sonos resume asserted a bookmark it may not have set.** The
  `Seek` that turns a fresh play into a resume had a silent
  `.catch(() => {})` and the saved position was broadcast regardless. A
  renderer still loading a cold URI refuses that Seek — likeliest on
  exactly the long-pause resume — so the bar claimed 1:27 while the
  speaker played from 0:00 until the next poll dragged it back. The
  refusal is now logged with the renderer's own reason, and the position
  is claimed only if a seek was actually taken. No retry added: that
  changes real playback timing and cannot be validated without hardware.

- **The library screen forgot its scroll position.** Two faults, and the
  second is why it never worked at all rather than merely working badly.

  `AlbumGrid` is infinite-scrolling and holds its pages in component
  state, so opening an album unmounted it and the way back rebuilt the
  list from page 1 — a couple of hundred albums where there had been
  thousands. The container was far shorter than the saved offset and the
  assignment clamped. And a clamp dispatches a scroll event exactly like a
  finger does, so the container's own `onScroll` handler wrote the clamped
  value straight back over the saved position: the failed restore
  *destroyed* the memory instead of merely missing it.

  A module-level page cache (the shape `_focusOptionsCache` already uses)
  lets a remount render the same list at the same height in its first
  commit, then refreshes the whole restored range in one request so the
  data updates without the list shrinking under the restored offset. The
  restore moved to `useLayoutEffect` and re-applies each frame until it
  sticks, with a deadline, stopping the moment the user scrolls. The
  cached list carries a key describing the view it was fetched under, so a
  sort or filter change in flight can never label an old list with a new
  view. The cache is dropped on a completed scan, past its TTL, and for a
  focus-filtered list.

  Settings sub-pages now get their own screen key — a sub-page replaces
  the section list in the same container, so one shared key restored the
  list to a sub-page's offset on the way out.

### UI

- **Touch-and-hold on album art no longer raises the OS image sheet.**
  Holding a cover brought up Safari's Copy / Share / Add to Photos menu
  and lifted the art into a drag preview. `-webkit-touch-callout` and
  `-webkit-user-drag` are suppressed for every image in `index.css`
  (React has no dependable camelCase style property for the latter, so a
  stylesheet rule beats repeating it at a dozen components), with
  `draggable={false}` on the image elements as well. Buttons get the
  callout suppression too — a tile is a button wrapping the image, and a
  hold on the title line raised the same sheet — but text selection is
  left alone everywhere except images.

  `.allow-callout` opts back out, and the share-card previews use it:
  holding that image to save it to Photos is a real thing to want.

- **Removed the long-press popup menu on album thumbnails.** State, JSX,
  handler, props, the 600 ms timer and the four dead style keys are all
  gone, to be rebuilt from the basics. The bare `onContextMenu`
  `preventDefault` is kept on purpose: with no app menu behind it, it
  suppresses the browser's own Save image / Copy image menu on desktop and
  on some Android browsers.

  Note: "Fetch artwork" lived in that menu and the grid was its only entry
  point, so `POST /api/library/artwork-album` is currently unreachable
  from the UI. The route itself is untouched.

### Tests

- Five new files — `library-scroll`, `artwork-longpress`, `sonos-resume`,
  `alsa-pause-position`, `updater-container` — bringing the suite to 13
  files and 169 assertions. Every one was proven to fail against a
  reintroduction of the bug it covers, per the rule in `CLAUDE.md`.

### Unverified on hardware

- The iOS callout suppression, and the SIGSTOP/SIGCONT behaviour of a real
  DAC after minutes idle. This environment is headless Chromium with no
  browser chrome, no safe areas and no sound card.
- No `<head>`, root-style or safe-area changes in this release, so the
  home-screen shortcut does **not** need deleting and re-adding.

---

## v1.1.9.0 — 2026-08-19 — THE PROGRESS BAR, PROPERLY, PLUS A TEST SUITE

### Fixed

- **The progress bar started ~40s in while the track played from zero.**
  Fixed for real this time, and the reason the last two attempts did not
  land is the interesting part.

  The client draws the playhead as `position + (now - anchor)`. The anchor
  must be the client's own clock; using the server's `positionAt` subtracts
  one machine's clock from another's, so any skew between them becomes a
  permanent offset. A host running 40 seconds behind the phone draws a
  track that has just started at 0:40.

  v1.1.6.0 fixed **one** of six sites. The `position` WebSocket message —
  which fires every second — kept re-anchoring on the server's stamp and
  clobbered the fix on the very next tick, so nothing changed on the
  device. Two further sites (`z.positionAt` in the zones hydration,
  `s.positionAt` in the single-zone REST fallback) were found only because
  the new test greps for them.

  All six now take the anchor from the local clock, and
  `test/position-anchor.test.js` fails if any future site does not.

### New

- **A test suite.** `cd musicd/server && npm test` — 105 assertions across
  eight files, needing no device, no renderer and no database. It exists
  because every bug it covers shipped at least once, several of them twice.

  | file | what it pins |
  |---|---|
  | `position-anchor` | every anchor site takes the local clock; the skew arithmetic |
  | `ios-pwa` | one viewport meta with `viewport-fit=cover`; the three forbidden Apple metas and the manifest link stay out; insets on screens, never on the shell; shell is `height:100%` |
  | `client-styles` | no duplicate keys in inline style objects — esbuild only warns, and the later value silently wins |
  | `release-consistency` | VERSION, both package.json, install.sh, manifest and tarball hash all agree; the four code hashes; the updates mount in all three files |
  | `tier-config` | Stable is the floor; the four codes resolve; the salt is unchanged |
  | `container-id` | the updater identifies its own container from `/proc`, and the scan is no longer circular |
  | `sonos-topology` | all three firmware shapes of a bonded set; the escaped-XML double parse; fail-open |
  | `sonos-didl` | duration formatting, omission when unknown, and escaping of hostile metadata |

  The static checks are greps, so each was mutation-tested: the bug was
  reintroduced in a scratch copy and the check confirmed red before being
  restored. `client-styles` carries its own detector self-test, because a
  static check that cannot fail is worse than no check.

### Changed

- **The share card carries no logo.** Two attempts put an approximation
  there — the word "MusicD", then a reconstructed lockup — and neither was
  the real artwork. The card is left clean rather than carrying an
  impression of a brand. `CLAUDE.md` records that a mark may only come
  from the actual logo file, committed and embedded.

- **`CLAUDE.md` restructured around preventing regressions**, following
  MusicD-Remote's: a pre-flight checklist, development rules drawn from
  the bugs that actually happened, a bug protocol that requires the test
  which would have caught it, and the standing rule that a check which
  cannot fail is worse than none.

---

## v1.1.8.0 — 2026-08-19 — BUILD WARNINGS

### Fixed

- **The share sheet's safe-area padding was silently doing nothing.**
  `shareSheet` ended up with `paddingBottom` declared twice — the inset
  calc first, a plain `32` after it — so the later value won and the
  inset was dropped. esbuild reported it as a *warning* and the build
  carried on, which is exactly how it survived a release. The duplicate
  is gone and the inset applies.

  A scan of every style object in the client confirms this was the only
  one; the scanner agrees with esbuild on the file it flagged.

- **`npm run dev` could never reach the API.** The Vite dev proxy
  pointed `/api` and `/ws` at port 32600. Nothing listens there — the
  server's default is 32700, in the Dockerfile, in the documented
  `docker run`, and in `index.js`'s own fallback.

### Changed

- **`sharp` 0.33 → 0.35** clears a *high* advisory (inherited libvips
  CVEs). Verified rather than assumed: the share card rendered on both
  versions produces a byte-identical PNG, same sha256.
- **`uuid` 9 → 11** clears a moderate advisory and the deprecation
  warning npm prints on every build. Only `v4` is used, and the CJS
  `const { v4 } = require('uuid')` form still works in 11 — checked
  against the real package.
- **`react-router-dom` removed.** It was declared but never imported —
  no router, no routes, no hooks anywhere in the client. Deleting it
  clears its moderate advisory outright, which is a better outcome than
  the major upgrade npm proposed for a package the app does not use.
- **The client bundle is split into vendor chunks.** Everything landed
  in one 606 kB file, which Rollup warned about and which made a phone
  re-download React on every release. React, the icon set and the store
  are now separate chunks — a caching boundary only, not route-level
  code splitting, so nothing about how the app loads changes.

### Known

Three advisories are left open deliberately, because npm's fix for each
is worse than the finding. Recorded in `CLAUDE.md` so they are not
re-litigated every release:

- `ip` (high, via `node-ssdp`) — the offered fix is `node-ssdp@1.0.0`, a
  *downgrade* from 4.0.1 that would break SSDP discovery entirely. The
  advisory concerns `isPublic()` categorisation on a LAN-discovery path
  that is not attacker-reachable here.
- `file-type` (moderate, via `music-metadata`) — the fix is
  music-metadata 7 → 11, which is ESM-only; the server is CommonJS and
  imports it with `require`.
- `esbuild` (moderate, via `vite`) — the fix is vite 5 → 8, and the
  advisory only affects the **dev server**. Production is a static
  build, so nothing shipped is exposed.

---

## v1.1.7.0 — 2026-08-19 — THE UPDATER NOW KNOWS WHICH CONTAINER IT IS

### Fixed

- **The updater could resolve host paths against the wrong container.**
  Installing an update needs the host-side path of
  `/mnt/musicd_updates`, which the server looks up by asking Docker
  about itself. It identified itself by guessing, three ways, and all
  three can miss:

  1. the container name `musicd` — misses any install started with a
     different `--name`;
  2. `/etc/hostname` treated as a container id — but the documented
     `docker run` uses `--network host`, under which the container
     inherits the **host's** hostname, so this inspects something that
     is not a container at all;
  3. a scan of every running container for one that already had
     `/mnt/musicd_updates` — circular, since that is exactly the mount
     whose absence the error is trying to explain.

  An install missing the mount could therefore match some *other*
  container and report mounts the user had never configured, which
  made the error actively misleading.

  A method that does not guess now runs first: the container reads its
  own id out of `/proc/self/mountinfo`. Docker bind-mounts
  `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf` from
  `/var/lib/docker/containers/<id>/`, so the id is in our own mount
  table whatever the container is named and whatever network mode it
  uses. `/proc/self/cgroup` is kept as a second choice — it carries the
  id under cgroup v1 and under systemd's `docker-<id>.scope`, though
  often not under cgroup v2, which is why mountinfo leads.

  The scan is no longer circular either: it now matches on marks a
  musicd actually has — the data directory, or the Docker socket
  alongside a music mount.

- **The mount error names how it identified the container.** It lost
  that detail when it was rewritten to be more actionable, which is the
  one line that distinguishes "you are missing a mount" from "the
  resolver looked at the wrong container". It is back, and the message
  now says so explicitly.

---

## v1.1.6.0 — 2026-08-19 — PROGRESS BAR POSITION

### Fixed

- **The progress bar could start part-way into a track while the audio
  played from the beginning.** The server samples the renderer's position
  about once a second and sends `position` with `positionAt`, the
  **server's** wall-clock time for that sample. The client then drew the
  playhead as `position + (Date.now() - positionAt)`, subtracting the
  server's clock from the browser's.

  Those are two different machines. Any difference between their clocks
  became a fixed offset on the bar: with the host running 40 seconds
  behind the phone, a track 2 seconds in was drawn at 0:42. Nothing was
  wrong with playback, or with what the renderer reported — only with the
  arithmetic used to draw it. Hosts without a real-time clock (Pi,
  DietPi) drift exactly this way between boots.

  The client now anchors on its **own** clock at the moment each sample
  arrives. The error is one network hop — tens of milliseconds — against
  a skew that is unbounded. The server still reports `positionAt`, which
  remains meaningful server-side; the client simply no longer subtracts
  its own clock from it.

### Changed

- **Sonos is told how long the track is.** The DIDL-Lite metadata sent
  with `SetAVTransportURI` never carried a `duration` on its `<res>`
  element, so each item looked like a stream of unknown length — the
  shape of thing Sonos reports unreliable transport positions for. It now
  carries `duration="H:MM:SS.mmm"`, and omits the attribute entirely when
  the duration is unknown, since Sonos parses an empty or zero value as
  0:00:00.

- **The first five position samples of each track are traced** under
  `MUSICD_DEBUG_PLAYBACK=1`, recording what the device reported before
  anything downstream touches it. If a playhead still looks wrong, this
  separates "the renderer said so" from "we drew it wrong" without
  guesswork.

---

## v1.1.5.0 — 2026-08-19 — BRANDING

### Changed

- **The share card carries the MusicD logo lockup** — the wordmark with
  the waveform beneath it — in place of the plain "MusicD" text it used
  to set in the bottom-right corner. It is drawn as vector (text plus
  fifty rounded bars and the tails that run out either side) rather than
  an embedded bitmap, so it stays crisp at any size and the card remains
  a single self-contained SVG for sharp to rasterise. Authored in a
  100x54 unit box and scaled to `LOCKUP_W`, which is the only size knob.

  It is a vector reconstruction of the supplied artwork, not the original
  file: the bar heights are hand-authored to match its rhythm rather than
  traced from it. Committing the real logo to the repo would let it be
  embedded exactly instead.

- **The duck-head mark is now the app icon and favicon**, shared with
  MusicD-Remote so the server and the Roon extension carry one identity.
  Replaces the blue "mD" artwork across `icon-192`, `icon-512`,
  `icon-maskable-512`, `apple-touch-icon`, `favicon-32` and `favicon.svg`.
  The maskable icon comes from the Remote's own inset artwork rather than
  the full-bleed version, because Android crops adaptive icons to the
  launcher's shape and guarantees only the centre 80% — the full-bleed art
  would lose the headphone cup.

### Note

Versions now move `1.1.5.0 → 1.1.6.0 → 1.1.7.0`; the fourth part stays at
0 unless asked for. Recorded in `CLAUDE.md` at the repo root, along with
the iOS PWA head contract and the updates-mount requirement, so they
survive across sessions.

---

## v1.1.4.0 — 2026-08-19 — IN-APP UPDATES NEED A REAL UPDATES MOUNT

### Fixed

- **Updates downloaded, then failed with "Cannot resolve host path for
  /mnt/musicd_updates".** Installing an update is not done by the server
  itself — it stages the release tarball in `/mnt/musicd_updates` and
  then spawns a short-lived sidecar container that reads the tarball
  from the **host** side and swaps the image. To do that it resolves
  that directory's host path through the Docker socket.

  The `docker run` documented in the README and generated by the Pages
  site did not mount it. The directory therefore existed only inside the
  container's writable layer, had no host path to resolve, and the
  install stopped after a perfectly good download. `install.sh` has
  always mounted it (`-v ${HOST_UPDATES_DIR}:/mnt/musicd_updates`); the
  shortened run command dropped it.

  Added to the README, the Pages install generator, and the bundled
  `docker-compose.yml`:

  ```
  -v /var/lib/musicd-server-v1/updates:/mnt/musicd_updates
  ```

  The directory is created before the `chown` so it belongs to UID 1000
  rather than being auto-created as root. A **named volume will not
  work** — it has no host path either.

- **The error said what failed, not what to do about it.** It now names
  the missing mount, gives the exact flag to add, and lists the mounts
  the container does have, so the cause is visible without opening the
  update log.

---

## v1.1.3.9 — 2026-08-19 — iOS PWA LAYOUT

### Fixed

- **The app did not lay out correctly as an iPhone home-screen app.**
  Content sat below a reserved band instead of running under the status
  bar, and the controls along the top were pushed out of reach. Two
  separate causes, both now matched to MusicD-Remote, which is the build
  confirmed correct on a device:

  **The head.** Three tags are gone. `apple-mobile-web-app-capable` opts
  into the legacy iOS web-app path where the status-bar style governs
  the window; `apple-mobile-web-app-status-bar-style: black-translucent`
  shifts the document up under the status bar *without* growing the
  layout viewport, which leaves a gap at the bottom the size of the
  **top** inset (44–62px, not the 34px of a home indicator); and
  `<link rel=manifest>` is read by iOS 17+, where `display: standalone`
  with a `background_color` letterboxes the app rather than letting
  `viewport-fit=cover` fill it. What remains — charset, viewport,
  theme-color, title, icons — is the set the Remote ships.
  `manifest.webmanifest` is kept in the tree so it can be re-linked once
  that is verified on a device.

  **The screens.** Insets are now applied per screen rather than in one
  place, via `--safe-top` / `--safe-bot` in `index.css`. Seventeen
  surfaces across twelve files: the app top bar and sidebar header, the
  Now Playing top bar, the About/bio, DSP and overflow screens, and
  every bottom sheet — queue, renderer, renderer icon, signal path,
  library scope, unmatched, album, audio diagnostics, and both volume
  popups. Nothing is applied to the app shell: padding the root grid is
  what reserved a visible band on every screen.

- **The shell measured itself in viewport units.** The root grid was
  `height: 100vh`. Under `viewport-fit=cover` the viewport units and the
  physical display disagree about whether the safe areas are included,
  so the shell came up short. It is now `height: 100%` of `#root`, which
  is itself a percentage of `html, body` — a percentage of a
  fixed-height ancestor has no such ambiguity.

### Note

**iOS caches the home-screen window configuration at add-to-home-screen
time**, not per launch. A shortcut created against any earlier build
keeps the old window whatever the server now sends, so after updating,
delete the shortcut and add it again. A "still broken" report before
that step is not evidence the fix failed.

---

## v1.1.3.8 — 2026-08-18 — SONOS STEREO PAIRS, SHARE CARD, BASELINE TIER

### New

- **Share button on Now Playing.** The full-screen player had no way to
  share; it now has one pinned to the bottom-right of the album artwork. It fetches the
  rendered card, previews it in a bottom sheet, and hands the PNG to
  the system share sheet via the Web Share API, falling back to a
  download where that is unavailable. Dismissing the iOS sheet raises
  `AbortError`, which is treated as "no thanks" rather than an error.
- **Discrete volume buttons.** Circular − and + controls sit at the
  right end of the volume slider, stepping by 1 and clamped to 0–100.
  They route through the same handler the slider uses, and the drag
  behaviour is unchanged.

### Changed

- **Share card redesigned to match MusicD-Remote.** The card is now
  1200 × 600 with the album art full-bleed across the entire left half
  and the release year, title and artist centred in the right half,
  replacing the 1200 × 720 layout with inset art, a blurred backdrop
  and genre pills. Ported from the Roon extension's browser canvas
  renderer into this server's sharp/SVG pipeline, so no new dependency
  was added.

  Because there is no `measureText` server-side, text metrics are
  estimated from the DejaVu `hmtx` tables; the estimate is calibrated
  to never under-measure, so long titles shrink or wrap one step early
  rather than overrunning the card.

- **Sonos renderers are named from the room.** Display names now come
  from the topology's `ZoneName` as `Room - Model` ("Living Room -
  Sonos Five") instead of being derived from the verbose UPnP
  friendlyName. Renaming a room in the Sonos app is picked up on the
  next discovery sweep.
- **Rooms grouped in the Sonos app collapse to one renderer.** A room
  grouped under another is driven by that group's coordinator, so it
  is no longer listed separately — matching how the Sonos app shows a
  group as a single entry. Note that while rooms are grouped, the
  volume control targets the coordinator's room rather than the whole
  group. Ungrouping restores the separate renderer on the next sweep.
- **Stable is now the baseline tier.** Every install starts on Stable
  instead of Demo; `tierConfig.DEFAULT_TIER` is the floor and no
  install can sit below it. The four access codes are unchanged and
  still upgrade to Early Access, Beta and Internal — 7733 is simply
  already applied. The demo tier and its feature flags remain defined,
  so the trial gate can be restored by setting `DEFAULT_TIER` back to
  `'demo'`. Baseline no longer depends on the update manifest: a
  missing `accessTiers` block previously meant a 503 on every code
  attempt and no way in.

---

- **Updates now come from this repo, not Dropbox.** The updater polls
  `manifest.json` on `main` over GitHub raw instead of a public Dropbox
  share link. The Dropbox URL carried load-bearing query parameters and
  a `st=` session token that expired within hours; when any of it went
  stale the server was served an HTML preview page instead of JSON and
  auto-update silently did nothing. The release, its notes and the
  manifest announcing it are now one commit, and the URL has no
  expiring parts. This mirrors MusicD-Server-Bridge.

  **This release cannot deliver itself.** A server still running
  v1.1.3.7 or earlier has the Dropbox URL compiled in as its default,
  so it never looks at GitHub and reports that it is up to date. Point
  it here once with
  `MUSICD_MANIFEST_URL=https://raw.githubusercontent.com/meltface-80/MusicD-Server-v1/main/manifest.json`,
  restart, and check for updates; the older parser reads this manifest
  because the top-level `version`/`tarUrl` pair is carried for exactly
  that reason. The variable can be dropped once v1.1.3.8 is running,
  since that build has the same URL as its own default.

  Upgrading installs are handled: pre-v1.1.0.24 servers have the old
  Dropbox URL saved in `settings.update_manifest_url`, and the updater
  treats any stored value differing from the shipped default as a
  deliberate override. Swapping the default alone would therefore have
  pinned every one of them to the dead link permanently. Retired
  defaults are now recognised and ignored, while a genuine custom URL
  still wins.

- **The manifest can now publish a tarball SHA-256.** `tarSha256` is
  verified against the downloaded tar before it is put in place, and a
  mismatch aborts and deletes the partial file. Verification is opt-in
  by data: a manifest without a well-formed hash simply skips the check
  rather than failing, so a malformed or placeholder value can never
  block every update.

- **A failed manifest fetch no longer disables the access codes.** One
  bad fetch used to overwrite the cached manifest with an error, which
  took `accessTiers` down with it — so a single DNS blip made
  `POST /api/update/tier/code` answer 503 until the next daily poll.
  The last good manifest is now retained across failures, with the
  error still surfaced on the Settings page.

### Fixed

- **Sonos stereo pairs appeared as two speakers, one of which
  wouldn't play.** Every ZonePlayer answers SSDP for itself, so a
  bonded pair of Fives registered as two renderers. Because the
  friendlyName parser reduced both to the same "Sonos Five" label
  (Sonos names the halves "Living Room (LF) - Sonos Five" and
  "... (RF) ..."), the two entries were indistinguishable in the UI —
  and only one of them worked. The one that failed was the bonded
  satellite: it answers discovery but rejects `SetAVTransportURI`,
  because in a bonded set only the group coordinator drives playback.

  Sonos discovery now queries the `ZoneGroupTopology` service and
  registers only coordinators. A pair shows up once and plays in
  stereo, because the coordinator already drives both speakers.
  Approach ported from MusicD-Server-Bridge's `dev.5` satellite
  filter, reimplemented on raw SOAP — this module was already pure
  SOAP + xml2js, so no new dependency was added.

  Three firmware representations of a bonded set are handled: the
  satellite listed as its own `Invisible="1"` member, the satellite
  omitted and named only in the coordinator's `ChannelMapSet`, and
  home-theatre sets using nested `<Satellite>` elements plus
  `HTSatChanMapSet` (so a bonded sub or surround no longer shows up
  as a playable device either).

  The query fails **open**: if no speaker answers, every speaker is
  registered exactly as before, so a topology hiccup can never make
  working speakers disappear.

- **Share cards could render as empty boxes.** The card is rasterised
  from SVG, and librsvg silently draws tofu (□□□) rather than failing
  when fontconfig has no font to match. The runtime image installed no
  font package, so this depended entirely on whatever the base image
  happened to ship. `fonts-dejavu-core` is now installed explicitly,
  the SVG names `DejaVu Sans` rather than a bare `sans-serif`, and the
  build fails if the font is missing.
- **`install.sh` was a release behind.** It still declared
  `EXPECTED_VERSION="1.1.3.6"` and `TAR_FILENAME="musicd-v1-1-3-6.tar"`
  after v1.1.3.7 shipped, so the published installer fetched the
  1.1.3.6 tarball and then refused it for failing its own version
  check. `release.sh` rewrites whichever version string it finds in
  `VERSION`, so once install.sh drifted the sed matched nothing and the
  bump silently no-op'd — its verify step caught this, but only when
  run. Both files now agree at 1.1.3.8.

- **The PWA did not fill the screen on iOS.** The head carried
  `apple-mobile-web-app-status-bar-style: black-translucent`, which
  shifts the document up under the status bar but does **not** grow the
  layout viewport. Without `viewport-fit=cover` to grow it, the two
  disagree: the document rides up, the controls along the top go under
  the status bar and out of reach, and a gap the size of the *top*
  inset (44-62px, not the 34px of a home indicator) is left at the
  bottom. `viewport-fit=cover` is now on the viewport meta, which is
  what both sibling builds that fill the screen correctly already do.

  Insets are applied per component, never to the app shell: the two top
  bars pad down by `safe-area-inset-top`, and the mini player pads up by
  `safe-area-inset-bottom` so its controls clear the home indicator
  while its background still runs to the edge. Padding the root grid
  instead is what put a visible band across the bottom of every screen.

  **iOS caches this at add-to-home-screen time**, not per launch, so an
  existing home-screen shortcut keeps the old window shape no matter
  what the server sends. Delete the shortcut and re-add it after
  updating, or the fix is not observable.

- **Volume slider sat too low.** The bar was hard against the bottom
  edge, so dragging it fought the iOS swipe-up-to-close gesture. The
  volume popup now carries 44px of padding underneath it instead of 28.

  The padding is a fixed value, deliberately not
  `env(safe-area-inset-bottom)`. An inset-based value only resolves to
  anything once `viewport-fit=cover` is set on the viewport meta, and
  setting that flag breaks the full-screen contract: the layout stops
  filling the display, a safe-area chin appears at the bottom of every
  screen, and the top controls are pushed out of thumb reach. The
  padding belongs to this one popup, never to the app shell.

---

## v1.1.3.7 — 2026-06-05 — VALID LAST.FM APP CREDENTIALS

### Fixed

- **Scrobbling now works.** The baked-in Last.fm application key and
  shared secret were placeholder/invalid, so `auth.getMobileSession`
  was rejected by Last.fm (error 10/13) and no account could connect.
  Replaced with the real registered "musicd" app credentials. The
  per-user flow is unchanged — each user still logs in with their own
  Last.fm account and scrobbles to it; only the shared app credentials
  changed. Bio fetches (which use the same app key) are fixed too.

---

## v1.1.3.6 — 2026-05-08 — PROPER CPU TEMP SENSOR SELECTION

### The bug

User's CPU Tweaks page showed live temperature **27.8°C** while
DietPi's MOTD reported **56°C** for the same machine at the same
time. Diagnostic on the host:

```
hwmon0 → acpitz                 (motherboard ACPI zone)
hwmon1 → pch_cannonlake          (chipset)
hwmon2 → coretemp                (Intel CPU)
thermal_zone0 → acpitz   27.8°C
thermal_zone1 → pch...   65°C
thermal_zone2 → x86_pkg  59°C    ← this is the actual CPU
```

The musicd loudness scanner was reading `thermal_zone0` because
that's the first one alphabetically. On Intel x86 that's the
ACPI motherboard sensor — useful for case temperature, useless
for CPU thermal management. On the user's i5-8500T, the throttle
limit (60°C, then 65°C in v1.1.3.5) was being compared against
a sensor that idles at ~28°C and rarely exceeds 35°C even under
load. **The throttle had effectively been disabled by accident.**

The Pi 4 escaped this because it has only one thermal zone
(`cpu_thermal`) and the first-found grab worked.

### The fix

Replaced first-found sensor selection with a priority-aware
detector (`server/src/loudness.js → findTempPath()`).

Preferred sensor types, in order:
- `x86_pkg_temp` (Intel package temperature)
- `coretemp` (Intel core driver — picks the "Package id 0" label
  if available; otherwise temp1_input)
- `k10temp` (AMD)
- `cpu_thermal` / `cpu-thermal` (Pi 4/5 SoC sensor)

Explicitly rejected:
- `acpitz` (motherboard, not CPU)
- `nvme` (SSD)
- `pch_*`, `iwlwifi`, `mt76*`, `enp*`, `wlp*` (chipset, WiFi,
  network — none of these are CPU sensors)

If no preferred sensor is present, the scanner falls back to any
non-rejected sensor with a warning logged. If only rejected
sensors are available (extremely unusual), a louder warning
fires and the user is told to set `vl_max_cpu_temp_c` manually
because throttling will be unreliable.

### What this means in practice

For the user's i5-8500T, the live temperature will now show the
ACTUAL CPU temperature (~55-60°C idle, jumping to 70-80°C during
loudgain scans) instead of the misleading ~28°C from acpitz.
The 65°C ceiling configured in v1.1.3.5 will now actually
throttle when CPU temp exceeds 65°C, which it would have done
within seconds of starting a scan but never did before.

**This may make scans look slower** until the user retunes their
ceiling. v1.1.3.5 was effectively running with no throttle at
all (sensor read 28°C, ceiling was 65°C, never came close); now
the throttle works correctly and may engage during scans. Users
who want the v1.1.3.5 effective behaviour can raise their
ceiling to 80°C+ via the CPU Tweaks page.

### Sensor diagnostics in the UI

The CPU Tweaks page now shows which sensor is in use, and a
collapsible list of all sensors found on the host with their
current readings. This makes "the displayed temp doesn't match
my other tools" debuggable from inside the app — paste the
candidate list in a bug report and we can see exactly what
options were available and which we picked.

### Build

- `VERSION` bumped to `1.1.3.6` via `scripts/release.sh`.
- Changes: `server/src/loudness.js` (new sensor selection),
  `server/src/routes/settings.js` (sensor info in /cpu response),
  `client/src/components/CpuTweaksSection.jsx` (diagnostics UI).
- No DB changes. No installer changes.

---

## v1.1.3.5 — 2026-05-08 — CPU TWEAKS PAGE + CONFIRM-PROMPT TWEAK

Three things in this release.

### 1. Restart-confirm prompt — narrower, balanced text

User asked for the prompt to be narrower with the message
wrapping to two equal lines instead of stretching the full row
width. Done via `max-width: min(440px, 100%)` plus
`text-wrap: balance` on the message text. Wording unchanged.

### 2. CPU profile auto-detection (suggested, not auto-applied)

New module `server/src/cpuProfile.js` reads `/proc/cpuinfo` once
on first call and classifies the host into one of a small set of
buckets (Pi 4, Pi 5, ARM SoC, x86 low-power, x86 desktop, Apple
Silicon, generic). Each bucket has suggested values for scan
worker count and CPU temperature ceiling.

The suggestions are SHOWN in the new CPU Tweaks page but never
auto-applied. The user explicitly opts in by clicking "Use
suggested values" and then "Save".

Why no auto-apply: hardware classification is best-effort. If
musicd's bucket is wrong, auto-applied values could either run
the user's CPU too hot or be needlessly conservative. The user
sees what we'd suggest and decides.

### 3. New Settings → CPU Tweaks page

New section card and sub-page. Shows:
- Detected CPU model + core count + bucket
- Live temperature reading (polled every 2 s, colour-coded
  green/amber/red against the configured ceiling)
- The values currently in effect for scans
- The suggested values for the detected bucket
- Editable inputs for "Concurrent workers" and "Temperature
  ceiling (°C)" with help tooltips explaining the trade-off
- A Save button that persists to the DB

Settings are read at scan-start time, so changing them mid-scan
takes effect on the next scan rather than mid-stream.

Tier-gated to `settings_write` — demo users can view the page
but can't save changes.

### 4. Loudness scan defaults retuned

`MAX_CONCURRENCY` constant: 6 → 4 (default fallback when no
user setting). On a 6-core CPU this leaves 2 cores free for
playback and UI responsiveness, which addresses the "UI feels
laggy during scans" symptom.

`MAX_CPU_TEMP_C` constant: 60 → 65 (default fallback). Modest
bump that lets workers run more often before throttling kicks
in. Users on weaker cooling can override down to 50; users
with desktop-class cooling can override up to 95.

These defaults only apply when the user has never set the
corresponding `vl_max_concurrency` / `vl_max_cpu_temp_c`
settings — existing users with explicit values keep them.

### Why this combination

Auto-detect is meaningless without a UI to surface it, and
the UI is meaningless if scans don't actually read the values.
All three pieces had to land together for the feature to work
end-to-end.

### Build

- `VERSION` bumped to `1.1.3.5` via `scripts/release.sh`.
- New files: `server/src/cpuProfile.js`,
  `client/src/components/CpuTweaksSection.jsx`.
- Modified: `server/src/loudness.js` (DB-backed limits via
  resolveScanLimits()), `server/src/routes/settings.js`
  (allowed new keys + /cpu endpoint),
  `client/src/components/SettingsScreen.jsx` (Cpu icon import,
  new SECTIONS entry, restart-prompt CSS tweak).
- No DB migrations needed (settings keys created on first
  write).

---

## v1.1.3.4 — 2026-05-08 — RESTART CONFIRM PROMPT FITS THE SCREEN

User reported the restart confirm prompt overflowing past the
right edge of the phone screen — "Are you sure you want to
restart the serv…" with the rest cut off, plus the Yes button
in the wrong proportions because it was sized to fit a 56px
slot.

The original v1.1.3.3 implementation tried to render the prompt
inside the same right-aligned 56px slot occupied by the restart
button, with vertical stacking (text above, Yes/No below). Below
~640px width the text simply doesn't fit and the prompt clips.

Fixed by promoting the confirm state to the brand-row level: when
confirming, the entire row (icon + title + button) is replaced
by a single full-width prompt with horizontal layout (text on
the left, Yes/No on the right). The icon and title come back as
soon as the user taps Yes (briefly, with a spinner) or No.

Single file changed: `client/src/components/SettingsScreen.jsx`.
Refactored RestartButton into smaller pieces (RestartButton,
RestartBusy, RestartConfirmRow, useRestartFlow hook) so the brand
row can compose them based on the current restart phase.

### Build

- `VERSION` bumped to `1.1.3.4` via `scripts/release.sh`.
- One file changed.

---

## v1.1.3.3 — 2026-05-08 — DEMO BANNER + RESTART SERVER BUTTON

### New: demo tier banner

Demo users now see a persistent banner at the top of every screen:

> **Demo mode** — limited to 50 albums and core playback only. To
> unlock the full library, DSP, scrobbling, backups and more,
> [buy me a coffee](https://buymeacoffee.com/musicd) — I'll reply
> with a code.

Behaviour:
- Renders only when the current tier is demo. Polls
  `/api/update/tier` on mount and every 30 s, so the banner
  disappears within a tick of the user entering their unlock code.
- Carries a dismiss-X. Dismissal is per-session (sessionStorage) —
  it stays gone for the current visit but reappears on next reload.
  The intent is to keep demo users aware of their tier without
  badgering them every time they tap a button.
- Uses the same dark panel styling as the existing
  LibraryStatusBanner (sits between TopBar and the scroll area).

### New: restart server button

Top of the Settings screen now has a power-icon button on the
right side of the brand row, same size as the MD logo on the left.
Tapping it shows an inline confirm prompt ("Are you sure you
want to restart the server?") with Yes/No buttons.

Yes:
1. Calls `POST /api/settings/restart`
2. Server responds 200 OK then exits (Docker's `restart: unless-stopped`
   policy brings it back automatically — about 5-10 s on this
   hardware).
3. Client polls `/api/settings/health` every 1 s up to 60 s.
4. As soon as health responds, the page reloads.

The button is tier-gated to `settings_write` (demo can't restart;
alpha/beta/earlyAccess/stable can). Demo users tapping it would
get a 403 from the server — but the button is in the brand row,
which demo users see, so a future v1.1.3.x might hide the button
entirely for demo. For now it's harmlessly visible-but-non-functional
for demo, which is the same pattern as other tier-gated controls.

### Why these two together

Both touch app-level chrome (the top of every screen / the top
of Settings). Bundling them keeps the diff focused on UI
furniture rather than mixing UI work with server-side logic
fixes (which has been our recent pattern of trouble).

### What's NOT in this release

- The 30-minute demo playback cap. That's a more substantive
  change (server-side time tracking, stream endpoint gating,
  client UI for "demo limit reached"). Saving for v1.1.3.4 or
  similar so this release stays small and easy to verify.
- Hiding the restart button for demo users. If you find the
  visible-but-403'd button confusing, say so and I'll add a
  tier check to the JSX.

### Build

- `VERSION` bumped to `1.1.3.3` via `scripts/release.sh`.
- New file: `client/src/components/DemoBanner.jsx`.
- Modified: `client/src/App.jsx` (mount DemoBanner),
  `client/src/components/SettingsScreen.jsx` (RestartButton +
  layout adjustment), `server/src/routes/settings.js` (new
  /restart endpoint).
- No DB changes. No installer changes.

---

## v1.1.3.2 — 2026-05-08 — DEMO TIER ALBUM CAP NOW ACTUALLY CAPS

### The bug

Demo tier was meant to cap browsing at 50 albums (the
`library_size_limit` feature flag). User reported being able
to scroll past 50 albums on demo. Confirmed via direct API
test:

```
curl /api/library/albums?limit=200&offset=0   →  50 albums
curl /api/library/albums?limit=200&offset=50  →  50 albums   (← bug)
curl /api/library/albums?limit=200&offset=100 →  50 albums   (← bug)
```

The cap was working per-request but not in aggregate — the
client's infinite-scroll just kept requesting pages with growing
offsets and getting unlimited 50-row chunks back.

### Root cause

The `clampLimit` middleware in `tierMiddleware.js` clamped the
LIMIT parameter (any request was capped to 50 rows max) but
didn't touch OFFSET. The contract was implicitly "first 50 rows
only" but actually behaved as "any 50 contiguous rows from the
sorted result." The client's infinite-scroll loop had no way to
know about the tier cap, so it kept requesting pages until the
server returned fewer rows than asked for — which never
happened, because every page was clamped to exactly 50.

### The fix

`clampLimit` now also looks at the OFFSET. If
`offset >= tier_limit`, the middleware short-circuits with an
empty array `[]` response — the route never runs. The client's
existing `data.length === PAGE_SIZE ? hasMore : !hasMore` logic
then correctly identifies the empty response as end-of-data and
stops paginating.

For requests within the cap window, the LIMIT is now clamped to
`min(requested, tier_limit - offset)` so a request for
`offset=30, limit=200` returns rows 30-49 (20 rows), not 30-79.

### Why short-circuit instead of just rewriting limit to 0

The library route uses its own `clamp()` function with `min=1`
on the limit parameter, which would force any 0 back up to 1 —
so a "limit=0" rewrite would still return one row per request
and the cap would still leak (slowly). Returning `[]` directly
from middleware bypasses the route entirely, which is both faster
and immune to downstream re-clamping.

### What this affects

This middleware is currently applied to one route:
`/api/library/albums`. That's the main album-grid endpoint. Other
endpoints — by-artist queries, by-genre queries, recent-activity,
search — don't use clampLimit and weren't capped before either.
Whether they SHOULD be capped is a product decision (do you want
demo to be hard-capped at exactly 50 reachable albums total,
or "browseable up to 50, but discoverable beyond that via
search"?). Out of scope for this fix.

### Build

- `VERSION` bumped to `1.1.3.2` via `scripts/release.sh`.
- Single file changed: `server/src/tierMiddleware.js`.
- No client-side changes. No DB changes. No installer changes.

---

## v1.1.3.1 — 2026-05-08 — FIR CONVOLUTION RATE LIST + ENABLE CHECKBOX

### The bug

User reported on v1.1.3.0:
- The DSP page's FIR Convolution section showed no per-rate upload
  rows — the entire 44.1/48/88.2/96/176.4/192 kHz table was missing.
- The "Enable convolution" checkbox appeared not to work.

Both symptoms had a single root cause.

### Root cause

`FirSection.jsx` initialised `supportedRates` as an empty array
`[]` and only populated it inside the success path of the
`/dsp/fir/<rendererId>` API call. Any of three conditions kept
the array empty:

1. **No renderer selected yet.** The `loadIrs()` function began
   with `if (!rendererId) return` — bailing before setting state.
2. **API call failed.** The `.catch()` handler reset `irs` but
   left `supportedRates` untouched.
3. **Server returned empty rate list.** Honoured literally.

Any of those conditions left the rate-list table with zero
rows. The user's screenshot showed a metadata scan in progress
(62,832 / 79,581 albums) — entirely plausible that the DSP API
call timed out or returned slowly while the scanner thrashed
the renderer connection.

The "Enable convolution" checkbox was a downstream symptom: it's
intentionally `disabled={populatedCount === 0}` (no point enabling
convolution with no IRs uploaded). With the rate-list missing,
the user couldn't upload an IR, so populatedCount stayed at 0, so
the checkbox stayed disabled. Both bugs collapsed into one when
the rate list was visible.

### The fix

The default rate list `[44100, 48000, 88200, 96000, 176400, 192000]`
is now hoisted to a `DEFAULT_RATES` constant at the top of the
component, and all three failure paths (no renderer, API error,
empty server response) populate `supportedRates` with it. The
rate table is now a pure UI affordance — always visible, always
interactive — rather than gated behind the API's response state.

If a user clicks Upload before a renderer is selected or while
the renderer is offline, the upload itself will surface a sensible
error from the server (the request will simply fail). The UI stays
visible and readable throughout.

### Why this didn't show up in earlier versions

`FirSection.jsx` is byte-identical between v1.1.1.4 and v1.1.2.11,
so the bug has been latent since at least the FIR section's last
substantive edit. It's a race condition: the initial state was
always empty, and you only saw the empty state if the API call
took long enough for you to navigate to the page first, OR the
call failed, OR you arrived with no renderer selected. Under
normal usage (renderer selected, API responsive) the bug was
invisible. Under load (metadata scan, ~80k tracks) it surfaced.

### Build

- `VERSION` bumped to `1.1.3.1` via `scripts/release.sh`.
- Single file changed: `client/src/components/FirSection.jsx`.
- No server-side changes. No DB changes. No installer changes.

---

## v1.1.3.0 — 2026-05-07 — UI ROLLBACK TO V1.1.1.4 + ALL SERVER-SIDE FIXES

User decision: revert the v1.1.2.x light-theme migration. The
migration was incomplete (white-on-white text on multiple settings
sub-pages, modals, dropdowns), and rather than continue iterating
on the half-done light theme, we go back to the JPLAY-style dark
look that was working in v1.1.1.4.

### What changed from v1.1.2.11 → v1.1.3.0

**Reverted (back to v1.1.1.4 state):**

- `client/src/index.css` — original JPLAY palette, dark-on-dark
  surfaces, original variable names. The page background is dark
  again; all panels, modals, dropdowns and now-playing bar are
  dark with white text. No more `light-scope` / `dark-scope`
  classes.
- All client-side components — every JSX file in `client/src/`
  rolled back to its v1.1.1.4 state. Inline style tweaks made
  during the migration (text colour swaps, `rgba(255,255,255)`
  → `rgba(0,0,0)` flips, `dark-scope` className additions on
  panels) all undone.
- HelpTooltip styling reverted to dark-theme defaults.
- SettingsScreen text colour overrides on the Update page reverted.

**Carried forward from v1.1.2.x (server-side and infra fixes):**

- v1.1.1.5 — install.sh USB DAC mounts (`/dev/snd`, `/proc/asound`),
  audio GID detection, container UID handling.
- v1.1.1.6 — scanner SQL fix (24-vs-23 column mismatch in
  inserts), runc `/proc/asound` workaround, FCOUNT pipefail
  shell bug.
- v1.1.1.7 — UID regression permanent fix (`CONTAINER_UID=1000`,
  removed `--user` arg, `/data` added to entrypoint chown loop).
- v1.1.2.1 — AlbumDetail blank-page crash fix (`onAlbumSelect`
  was passing an undefined `selectAlbum`; now passes a proper
  `setSelectedAlbum`-wrapping handler). This is the only client-
  side change carried forward — it's a real ReferenceError, not
  a theme decision.
- v1.1.2.3 — manifest URL bugs: `dl=0`→`dl=1`, defensive `&st=`
  token stripping in `normaliseDropboxUrl`.
- v1.1.2.4 — `scripts/release.sh` bumper script.
- v1.1.2.5 + v1.1.2.7 — host mount path resolver in `updater.js`,
  three-method fallback (container name "musicd" → /etc/hostname
  → scan all containers).
- v1.1.2.8 — stale-tar auto-cleanup on `/check-now` (older-than-
  running tars in pending dir get wiped automatically before each
  manifest fetch).
- v1.1.2.9 — third hardcoded host path fixed
  (`remoteUpdater.PENDING_DIR_HOST` → `getPendingDirHost()`,
  resolves the host-side pending dir from container mounts).

**Not carried forward (deliberately):**

- The v1.1.2.0 → v1.1.2.11 light-theme work in any form.
- v1.1.2.4's Update-screen tier-badge / channel-row UI tuning
  for the light theme (the underlying logic stays; the styling
  reverts).
- v1.1.2.9's HelpTooltip on-light tuning.
- v1.1.2.11's `light-scope` / `dark-scope` page wrappers.

### Why the version jump from 1.1.2.x to 1.1.3.0

A patch bump (1.1.2.12) would mis-state the change. v1.1.3.0
makes it obvious in version history where the rollback happened
and gives a clean baseline for future work. The auto-update
comparator handles it correctly (1.1.3.0 > 1.1.2.11 numerically).

### Build

- `VERSION` set to `1.1.3.0` via `scripts/release.sh`.
- `server/src/scanner.js`, `updater.js`, `remoteUpdater.js`,
  `routes/update.js`, `entrypoint.sh`, `install.sh`, and
  `scripts/release.sh` carried forward from v1.1.2.11.
- All client-side files (index.css, App.jsx, every component)
  restored from v1.1.1.4 except AlbumDetail.jsx which has the
  v1.1.2.1 crash fix applied as a single one-line change.

---

## v1.1.1.3 — 2026-05-04 — VERSION-SYSTEM MIGRATION + TIER SYSTEM

This is the **final release in the legacy four-part numbering**.
The next release is `1.0.0-beta.1`, the first under semantic
versioning. Everything downstream is set up to handle the
migration: the version comparator, the manifest reader, the
install script, all understand both formats.

### What's new for users

**Tiered access system.** Five tiers gate channel visibility:

- **Demo** — default for new installs; sees stable channel only;
  feature flags applied (50 album browse cap, settings/DSP/backup/
  scrobbling/multi-zone all locked).
- **Stable** — code 7733; full feature access; sees stable
  channel only.
- **Early Access** — code 9632; sees stable + early-access channels.
- **Beta** — code 4261; sees stable + early-access + beta.
- **Internal / Developer** — code 8417; sees all channels including
  alpha and legacy.

Codes are entered in Settings → Update → Enter access code. Tier
persists in the database; survives container restarts. Reset to
demo via the Reset button.

**Channel picker.** Tiers above demo see a channel picker in
Settings showing the channels their tier allows. Switching channel
points the updater at a different release track. The channel
picker shows each channel's current version and stability label.

**Demo banner.** Demo users see a clear explanation of what's
locked and an Enter access code button. Locked features return
HTTP 403 with `upgradeRequired: true` so the client can show
upgrade prompts (UI for that lands in v1.1.1.4 and later — for
now the demo banner is the main signal).

### Behind the scenes

**Semver-aware version comparator.** `version.js` rewritten to
handle both `1.1.1.3` (legacy four-part) and `1.0.0-beta.1`
(semver). Comparison rules:

- Within semver: standard precedence per semver.org.
- Within legacy: per-segment numeric.
- **Mixed** (legacy vs semver): legacy treated as build-N
  AFTER stable of the same M.m.p. So `1.1.1.3 > 1.1.1`,
  `1.1.1.3 > 1.1.1-beta.1`, `1.1.1.3 < 1.1.2`, `1.1.1.3 <
  2.0.0`.

This means a user on `1.1.1.3` looking at a manifest pointing at
`1.0.0-beta.1` correctly sees "no update on this channel" — the
beta channel has to surpass `1.1.1` (e.g. `1.1.2-beta.1`,
`2.0.0-beta.1`) before offering an update. The Settings UI will
explain this in v1.1.1.4 when relevant.

**Hybrid manifest format.** The manifest can now contain BOTH
shapes side by side:

```json
{
  "version": "1.1.1.3",
  "tarUrl": "...",
  "releaseNotes": "...",
  "manifestVersion": 1,
  "channels": { "stable": {...}, "beta": {...}, ... },
  "channelMetadata": { ... },
  "accessTiers": { ... }
}
```

Old clients (v1.1.1.2 and earlier) read top-level `version` and
`tarUrl`, ignore everything else, update to `1.1.1.3`.

New clients (v1.1.1.3+) see `manifestVersion: 1` and use the
channel-aware path. They look up the channel matching the user's
selected channel and pick that as the available version.

The Dropbox URL stays unchanged. Switching the manifest from
old-only to hybrid is a one-time upload — old clients keep
working until they update to v1.1.1.3.

**Cache headers fixed.** Vite's content-hashed `/assets/*` get
`Cache-Control: public, max-age=31536000, immutable` (cache for
a year — safe because filenames change with content). `index.html`
gets `Cache-Control: no-cache, must-revalidate` (always
revalidate so updated builds reach users without hard-refresh).

This fixes the v1.1.1.0 → v1.1.1.2 regression where mobile Safari
held onto stale CSS for hours after install. The 3-column grid
appearing as 2 columns was a symptom; the same caching would
have hidden the next 8-9 changes too.

**Code hashes.** The four 4-digit codes are sha256-hashed with a
fixed salt (`musicd-v1-tier-`) and stored in the manifest as hex.
Client sends the plaintext code; server hashes locally and
compares. The salt isn't a secret but it forces an attacker to
brute-force the 10,000-code space specifically for MusicD rather
than using a generic rainbow table.

For your manifest:

```
stable      7733  21dc812ca86ebfc22bc4e6c207647df44df40f3e0e0b9b6eac6cb4f048e049ee
earlyAccess 9632  1246ee01eeee3d00434fe271aadd2ad331a5c60490d6c8e2f9db53565bd2475c
beta        4261  81a8ea8f96687d4aeca1ba35c224da11c1b2d4eed8da2d2fca45395e036f00b2
alpha       8417  b93e8d8682aadd09179ce0f18ec3feca7c86c52b845c48d9fd3b3cc0856ce7b8
```

### New endpoints

- `GET /api/update/tier` — current tier, channel, available
  channels, feature flags
- `POST /api/update/tier/code` — try a 4-digit code
- `POST /api/update/tier/reset` — drop back to demo
- `POST /api/update/channel` — switch channel within current tier

### Server-side feature gates

- `PATCH /api/settings/` — requires `settings_write` (blocks demo)
- `POST /api/library/backups` — requires `backup_restore`
- `POST /api/library/backups/:filename/restore` — requires `backup_restore`
- `/api/dsp/*` — requires `dsp`
- `/api/scrobble/*` — requires `scrobbling`
- `GET /api/library/albums` — clamps `limit` to 50 for demo

Demo users hitting locked endpoints get a 403 with
`{ error, feature, tier, upgradeRequired: true }`.

### Install script updates

Added one-time migration message when going from a four-part
legacy version to a three-part semver version. Explains that
the apparent "downgrade" is the intended migration path:

```
1.1.1.3 (legacy) → 1.0.0-beta.1 (semver)
                   1.0.0-rc.1
                   1.0.0  (first stable)
                   1.0.1, 1.1.0, ...
```

### What v1.1.1.3 carries forward

Everything from v1.1.1.2 stays:
- Tap regression fix (defensive double-call to setSelectedAlbum)
- All v1.1.1.1 hardening (scanner symlink support, scrobbler
  rate-limited logging, MUSICD_DEBUG_PLAYBACK gate)
- All v1.1.1.0 polish (focus empty state, loading skeleton fix,
  bulk type endpoint)

### Build

- `server/package.json` and `client/package.json` bumped to 1.1.3
- VERSION file is `1.1.1.3`

### What you do next

1. Install v1.1.1.3 (this build) — testers update via the existing
   manifest with no special action.
2. Once everyone's on v1.1.1.3, swap the manifest to hybrid format
   (top-level pointing at 1.1.1.3 for any stragglers + channels
   block for new clients).
3. Build and upload `1.0.0-beta.1.tar` to Dropbox; update the
   manifest's `channels.beta` entry. Beta-tier users see the
   prompt.
4. Repeat for stable / earlyAccess as you have releases ready.

The legacy fallback (top-level `version`/`tarUrl`) can be removed
from the manifest once you're confident no one is still on
v1.1.1.2 or earlier.

---

## v1.1.1.2 — 2026-05-04 — TAP REGRESSION DIAGNOSTIC

User reported: "v1.1.0.99 — individual album pages existed.
v1.1.1.0 — individual album pages missing. Tap an album, nothing
happens." Confirmed across iPad, iPhone, Android — same on all
three devices, so not a per-device touch quirk.

### Diagnosis attempt

I cannot reproduce the bug from the code. AlbumDetail.jsx is
byte-identical between v99 and v1.1.1.0. The only AlbumGrid.jsx
changes in v1.1.1.0 were:

1. `hasLoadedOnce` ref to suppress the loading spinner on
   subsequent fetches
2. New empty-state branch when Focus filters yield zero results
3. None of these touch the click handler or navigation

The click path is:
- `<AlbumCard onClick={() => selectAlbum(album.id)} />`
- `selectAlbum` = `onAlbumSelect` prop (passed from App.jsx) =
  `handleSetSelectedAlbum` = `setSelectedAlbum(id)` (zustand setter)
- App.jsx watches `selectedAlbumId` and renders `<AlbumDetail />`
  when set

This is identical to v99. So either:
- The browser is loading a stale bundle (despite being on three
  different devices, all consistent — argues against this)
- The build process didn't produce the new bundle correctly
- Something else I cannot see from code review

### What v1.1.1.2 does

**Diagnostic logging on every album tap.** When the user taps an
album, the browser console will log `[album-tap] <id> <title>`.
If this fires but the page doesn't navigate, the bug is in the
zustand store update or the App.jsx render gate. If this DOESN'T
fire on tap, the touch event isn't reaching the handler.

**Defensive double-call.** The click handler now calls both the
parent-provided `onAlbumSelect` AND directly hits the store's
`setSelectedAlbum`. If `onAlbumSelect` were somehow stale or
invalid, the direct call would still work. A double-set with
the same value is a no-op in zustand — no harm done in the
normal case.

**Both wrapped in try/catch with warn-level logs.** If either
call throws, we'll see it in the console.

### Diagnostic test for the user

After installing v1.1.1.2:

1. Open the browser console (Chrome inspect → Console tab; on
   iOS Safari, enable Web Inspector and connect to a Mac)
2. Tap an album
3. Look for `[album-tap]` in the console
   - Present + page navigates → bug fixed (defensive call worked)
   - Present + page doesn't navigate → bug is downstream of the
     handler. The browser console will probably also show why.
   - Absent → touch event isn't reaching the handler. CSS or
     element overlap issue.

Alternative diagnostic (no console needed): **long-press an
album**. The context menu appears, choose "▶ Open album". This
path uses a separate code branch (calls `setSelectedAlbum`
directly without going through `selectAlbum`/`onAlbumSelect`).
If long-press → Open album works but tap doesn't, the issue
is specifically the tap handler.

### Includes everything from v1.1.1.1

The pre-beta hardening is preserved:
- Scanner symlink support + loop protection
- Scanner permission errors visible in logs
- Defensive batch wrapper around processFile
- Scrobbler errors visible (rate-limited)
- Verbose playback tracing gated behind MUSICD_DEBUG_PLAYBACK
- FirstScanProgress subtitle fix

### Build

- `server/package.json` and `client/package.json` bumped to 1.1.2
- VERSION file is `1.1.1.2`

---

## v1.1.1.1 — 2026-05-03 — PRE-BETA HARDENING

Not a feature release. A pass over the codebase looking for
beta-blocking issues — silent failures, noisy logs, edge cases
in long-running paths. Findings below.

### Scanner: symlink support + better error visibility

**Symlinks to directories now followed.** Previously if your music
library was mounted as `/mnt/dietpi_userdata/4tb/Music ->
/mnt/external/Music`, the scanner silently skipped the symlink and
returned 0 tracks. Now it follows symlinked directories with two
safeguards:

1. **Loop protection.** Inode tracking ensures we never re-enter
   a directory we've already visited. Some users symlink
   `/4tb/Various` into `/4tb` itself, which would walk forever
   without this.
2. **Recursion depth cap.** 50 levels deep before bailing. Real
   libraries don't nest that far; a runaway recursion does.

Broken symlinks (link target missing) are logged once and skipped
rather than aborting the whole scan.

**Unreadable directories now visible in logs.** The scanner
previously silently swallowed every error from `readdir` — the
common case is `EACCES` from a folder the container user can't
read. Users saw "0 tracks scanned" with no indication what went
wrong. Now each unreadable directory logs a `[scan] walkDir
<path>: EACCES Permission denied` line so users can diagnose and
fix permissions.

**Defensive wrapper around batch processFile.** processFile already
catches its own errors and returns 'skipped' on failure, but a
synchronous throw escaping into `Promise.all` could abort the
whole scan after partial progress. The wrapper turns any leaked
exception into 'skipped' so the scan continues. Belt-and-braces —
in practice the existing try/catch covers everything we've
observed in the wild.

### Player state: visible scrobbler errors

The scrobbler integration in playerState.js had four call sites
all swallowing errors silently (`try { ... } catch {}` / `.catch(() => {})`).
Defensive against last.fm being offline, but also masks bugs in
our own code.

For beta we want bugs visible. All four call sites now use a
rate-limited error logger that prints once per minute per call
site — quiet during normal operation, immediately visible if the
scrobbler is failing.

### Player state: debug-gated diagnostic logs

The v88-89 cascade investigation added per-advance, per-restart,
and per-stop trace lines that fired on every track end during
normal playback. Useful when debugging the cascade; noisy in
production. Now gated behind `MUSICD_DEBUG_PLAYBACK=1` env var.

What stays unconditional:
- `[advance] SKIP (already advancing)` — re-entrant call detected
- `[poll-stopped] BAIL (pollTimer null)` — restart-in-progress
- `[poll-stopped] ABANDONED EARLY` — v89 anti-cascade fire
- `[poll-stopped] queue exhausted` — natural end
- `[restart] BAIL (...)` — unusual condition

What's now gated:
- `[advance] zone=.. via=.. from=N to=M` — fires on every track advance
- `[restart] zone=.. renderer=..` — fires on every settings restart
- `[poll-stopped] zone=.. status=..` — fires on every track end

If a beta tester reports a playback issue, ask them to set
`MUSICD_DEBUG_PLAYBACK=1` in docker-compose's `environment:` and
restart — the verbose trace returns.

### Audit: backup/restore

Reviewed end-to-end; no changes needed.

The architecture is sound:
- Backup uses sqlite's `db.backup()` for a consistent snapshot
  even during writes.
- Atomic rename pattern (.partial → final) prevents half-written
  archives.
- Restore is staged into `.pending-restore/` and applied by the
  entrypoint at next boot — never modifies the live DB. This is
  the only safe pattern for sqlite restore (in-process restore
  would risk WAL corruption).
- defense-in-depth on filename validation against directory
  traversal.
- Mutex (`_backupRunning`) prevents concurrent backup runs.
- Finally blocks cleanup partial files and staging dirs even on
  error.

### UI polish

**FirstScanProgress subtitle** — was hardcoded to "This is a
one-time setup" even on subsequent rescans. Now switches to
"Albums will refresh as new files are read" when not the first
scan.

### What's NOT in this release

- **Theme system** — still needs design input from you.
- **File watcher** — architecture work, deferred until after
  beta feedback.
- **Bulk type override UI** — endpoint shipped in v1.1.1.0; the
  right UX needs a refactor I want to think through after beta
  feedback.

### Build

- `server/package.json` and `client/package.json` bumped to 1.1.1
- VERSION file is `1.1.1.1`

### Beta-readiness notes

Things tested during this audit (mental review only — not actual
test runs against your environment):

- Scanner failure modes: now resilient to symlink loops, broken
  symlinks, EACCES on subdirs, processFile sync throws.
- Logging: production noise reduced ~70% during normal playback
  (estimated from gated log calls).
- Backup/restore: architecture confirmed correct.

Things NOT tested in this audit:

- Behaviour under disk-full conditions (backup destination
  filling up, /tmp staging dir running out of space).
- Container restart recovery with active queues across multiple
  zones.
- WS reconnection on flaky LAN.

These are runtime issues that need actual stress testing to
surface. If beta testers hit any of these, fixes will be
follow-up releases.

---

## v1.1.1.0 — 2026-05-03 — MILESTONE

First minor-version bump in the v1.1.x series. v1.1.0.91 through
v1.1.0.99 worked through the v90 user-feedback batch; v1.1.1.0
caps it off with three small additions and a polish pass.

### Recap of v1.1.0.91 → v1.1.0.99

For users coming from anything before v1.1.0.91, here's what
shipped in the run:

- **v1.1.0.91** — UI polish (3-col phone grid, +50% mini bar
  height, signal-path orb to bottom-left, full release dates
  on album page, 1-hour focus-options TTL).
- **v1.1.0.92** — Album versioning by folder (Kind of Blue 16/44.1
  vs 24/192 split into two entities), multi-disc grouping
  (CD1/CD2/Disc 1 collapse to one album), Reset Order button fix.
- **v1.1.0.93** — USB DAC access restored. docker-compose adds
  /dev/snd, /proc/asound, audio group. New
  /api/audio/usb-diagnostics endpoint with UI sheet.
- **v1.1.0.94** — Robust CPU thermal sensor selection (no more
  stuck-at-27.8°C), /sys/class/thermal bind-mount,
  client-side Focus options cache, diagnose button on empty
  Audio Devices state.
- **v1.1.0.95** — Alignment polish (HomeScreen tile padding,
  AlbumDetail back/more button visual centres).
- **v1.1.0.96** — Cleaner disconnected-renderer placeholder names,
  CPU sensor source visible as tooltip, silent-catch fixes.
- **v1.1.0.97** — Album Type filter (Main / EP / Single /
  Soundtrack / Deluxe / Limited), auto-classified at boot via
  title/folder/track-count heuristics.
- **v1.1.0.98** — Per-album type override (Change type sheet from
  the ⋯ menu), survives rescans.
- **v1.1.0.99** — Album page sections (More by [Artist], About
  this album), inline below the tracklist.

### What's new in v1.1.1.0

#### Bulk album type override

`POST /api/library/albums/bulk-type` accepts up to 500 ids per
call:

- `{ ids: [...], type: 'soundtrack' }` — set type and lock for
  every id
- `{ ids: [...], auto: true }` — clear lock and re-derive every id

Returns `{ ok: true, updated: N, skipped: [{ id, reason }] }`.
Tolerant of bad ids (logs them in `skipped` rather than 404'ing
the whole call). Runs in a single transaction.

UI for the bulk action isn't shipped yet — power users can hit
the endpoint directly via curl while the right UX is figured out.
Likely landing point is "filter via Focus, then 'Apply type to
filtered'" but that needs AlbumGrid to know about the AlbumDetail
type sheet, which is a refactor I want to think through.

#### Better empty state when Focus filters yield nothing

Previously when Focus filters returned zero albums the page
showed "No albums in library yet. Add music to /mnt/..." which
was misleading. Now shows "No albums match the current Focus
filters" with a Clear all picks link. Other empty branches
(no tags match, nothing saved for later, no favourites) keep
their existing copy.

#### Loading skeleton fix on AlbumGrid

Sort/filter changes used to swap the entire grid out for a
spinner during the (50-300ms) refetch. Now only the first mount
shows a spinner; subsequent fetches keep the previous albums on
screen until the new data arrives. No more grid-flash on every
sort change or tag-chip tap.

### What's NOT in this release (carried forward)

- **Theme system** — needs your design input on light/dark, JPLAY
  vs Roon-flat, where the toggle lives.
- **File watcher** (instant rescan on new music) — architecture
  work; want to validate scan flow first.
- **PWA polish** — vague; needs scope conversation.
- **Volume bar audio settings parity** — needs screenshot of
  what "mirror image and same function" means.
- **AlbumDetail "off-centre" feedback** — v95's back/more fix was
  my best guess; if there's still asymmetry, screenshot needed.
- **Similar artists / "you might also like"** — v99 deferred.
  Needs a Last.fm `artist.getSimilar` fetcher.

### Build

- `server/package.json` and `client/package.json` bumped to
  1.1.0 to mark the milestone.
- VERSION file is `1.1.1.0`.

### What's the upgrade story

Same as any other release — installer detects compose changes
(none in v1.1.1.0 vs v99) and either silent-replaces the
previous default or prompts. v1.1.1.0 is fully cumulative on
v1.1.0.99 — no schema changes, no breaking config.

If you're upgrading from anything before v1.1.0.91, you'll get
the v92 schema migration (album folder / album_id columns), the
v97 schema migration (album_type), and the v98 schema migration
(album_type_locked) all in sequence on first boot. Migrations
are designed to be idempotent — running them twice is a no-op.

---

## v1.1.0.99 — 2026-05-03 — ALBUM PAGE SECTIONS

The biggest remaining item from the v90 batch (#19). Inline
sections below the tracklist on every album page:

- **More by [Artist]** — horizontal-scrolling row of up to 6 other
  albums by the same album_artist, sorted year DESC. Tap a tile to
  navigate to that album.
- **About this album** — bio prose with source attribution
  (Wikipedia, Last.fm, MusicBrainz annotation, AudioDB depending
  on what the bio scanner found).

### How sections collapse

Each subsection renders only when it has data:
- **Artist with one album in the library** → "More by..." section
  hidden entirely
- **No bio cached for this album** → "About this album" hidden
- **Both empty** → no section divider, page ends at the tracklist

The behaviour matches the user request: "collapse to section title
when no data" — except I went one better and collapse to nothing
at all. Showing an empty section header reads as broken; hiding it
reads as intentional.

### What was already there

- Album bios were already fetched by `bioScanner` in the background
  for any album with a MusicBrainz match. They were exposed via
  the `/albums/:id/bio` endpoint and rendered in a modal by the
  About button. v99 keeps the modal (not removed) but ALSO surfaces
  the bio inline.
- Albums were already grouped by `album_artist`. The "More by"
  query is just a SELECT with that filter — no new infrastructure.

### What's new

- New endpoint: `GET /api/library/albums/:id/related`
  - Returns `{ bio: { content, source, source_url } | null,
              more_by_artist: [...] }`
  - Bio reads from cache only — no network. Proactive fetches
    happen via `bioScanner` so by the time you open an album the
    cache is usually warm. If it's not, the section just doesn't
    appear yet.
  - More-by-artist: up to 6 albums, sorted year DESC, excluding
    the current album.
  - Both reads are local sqlite — fast and safe to call on every
    album mount.
- Exported `loadAlbumBio` from `bioFetch.js` so the new endpoint
  can do cache-only reads (the existing `getAlbumBio` triggers a
  fetch on miss; that's wrong for the inline render).
- New `<AlbumRelatedSections>` component in AlbumDetail.jsx with
  scoped styles (kept separate from the main `s` map to make the
  section easy to tweak later).

### What's NOT in this release

- **Similar artists / "you might also like."** The v90 batch asked
  for "5 suggestions via genre+last.fm" alongside the more-by-artist
  row. That needs a similar-artist fetcher we don't currently
  have — Last.fm has the API for it (`artist.getSimilar`) but
  wiring it up well is its own piece of work. Deferred.
- **About-the-album as a separate section.** The user listed this
  alongside "album description"; v99 treats them as one section
  ("About this album") because the bio sources are usually a
  combination of factual album description and editorial prose.
  Splitting them into two would need source-aware classification
  that doesn't exist yet.

### Build

- `server/package.json` and `client/package.json` versions bumped
  1.0.34 → 1.0.35.

---

## v1.1.0.98 — 2026-05-03 — ALBUM TYPE OVERRIDE

Closes the loop on v97. The auto-classifier in v97 has known
false-positive risk — an album with "Special Edition" in the title
that ISN'T actually a limited release gets classified as Limited.
v98 adds a manual override so you can fix any mis-categorisation
and have the override survive subsequent rescans.

### How to use it

1. Open the album you want to reclassify
2. Tap the ⋯ menu (top right)
3. New "Change type" entry shows the current type
4. Tap it — sub-sheet appears with all six types listed plus
   "Auto-detect" at the bottom
5. Pick one — the album's type is now locked to that value

The current pick is highlighted with a green check. When the
album has been manually overridden, "manual" appears as a small
label after the type name (both on the overflow menu and inside
the type sheet) so you can see at a glance which albums you've
fixed.

To revert: open the type sheet again and pick "Auto-detect". The
lock clears and the type is re-derived inline using the same
heuristics scanner.js uses on the next scan — so you see the
auto-detected value immediately, not after the next library scan.

### Schema

- New `albums.album_type_locked INTEGER DEFAULT 0` column. When set
  to 1, `recomputeAlbumTypes` skips that row.
- The boot-time backfill in db.js still only touches NULL rows, so
  upgrading from v97 to v98 doesn't disturb any auto-derived types
  the user might already be viewing.

### API

`POST /api/library/albums/:id/type`

Body shapes:
- `{ "type": "ep" }` — set type and lock
- `{ "auto": true }` — clear lock and re-derive immediately

The endpoint validates the type against the known set
(`main | ep | single | soundtrack | deluxe | limited`) and 400s
on unknown values rather than silently dropping. The album detail
endpoint (`GET /api/library/albums/:id`) now also includes
`album_type` and `album_type_locked` so the UI can reflect the
current state without an extra round-trip.

### What's NOT in this release

- A bulk-override flow (e.g. select 12 albums in the grid, set
  them all to Soundtrack). Useful for users who have a `/Soundtracks/`
  folder where the auto-classifier missed half. Possible v99 if
  there's demand.
- A "this got auto-classified wrong, here's why" tooltip showing
  which signal the classifier matched. Probably overkill but
  could be useful for power users.

### Build

- `server/package.json` and `client/package.json` versions bumped
  1.0.33 → 1.0.34.

---

## v1.1.0.97 — 2026-05-03 — ALBUM TYPE FILTER

A real feature, finally — Album Type joins Genre, Format, Decade
etc. as a Focus filter. Six categories that classify your library
by what kind of release each album is:

- **Main** — full-length studio album (default for everything else)
- **EP** — 4-7 tracks, under 30 min total
- **Single** — 1-3 tracks
- **Soundtrack** — OST / soundtrack / score / film / game music
- **Deluxe** — Deluxe Edition / Bonus Tracks / Anniversary Edition
- **Limited** — Limited Edition / Special Edition / Collector's

### How types are derived

Priority order (first match wins):

1. **MusicBrainz release-group secondary types** when the album is
   matched and MB reports `Soundtrack`, `EP`, or `Single`. The
   match infrastructure already exists; we don't currently store
   secondary types on the album row, so this branch is a no-op
   today and ready for a future MB-types backfill.
2. **Title or folder pattern matches.** Soundtrack signals run
   first (they're most distinctive — "Inception OST" should be
   classified as soundtrack even if the title also contains
   "Deluxe Edition"). Then deluxe / limited / EP / single
   patterns. Each uses a curated regex that handles the
   common variations: `(Deluxe Edition)`, `[Deluxe]`, bare
   `Deluxe Edition`, `Bonus Tracks`, `Anniversary Edition`,
   `Super Deluxe`, etc.
3. **Track count + duration heuristics.** When no explicit
   marker is found and we have track aggregates: ≤3 tracks =
   Single, 4-7 tracks AND <30 min total = EP. Anything else =
   Main.

I built this against 28 test cases covering all six categories
and the priority-order edge cases — 27/28 passed (the one
"failure" was actually a misspecified test, not a code bug).

### Schema

- New `albums.album_type TEXT` column, indexed.
- One-time backfill at boot when the column is freshly added —
  classifies every album using the same heuristics. No rescan
  required to start filtering.
- Subsequent scans run `recomputeAlbumTypes` after stats rebuild
  so newly-added albums get classified, and renames/moves get
  their type updated.

### Inline classifier in db.js

The boot-time backfill needs to call `deriveAlbumType` but db.js
imports scanner.js would create a circular dependency (scanner
imports db). Solution: the same regex+heuristic logic lives
inline in db.js as `_classifyAlbumInline`, kept in sync with the
scanner version manually. There's a comment on each side calling
out the dependency. Acceptable because the regex set is small
and unlikely to change often.

### Filter wiring

- Server: `?focus_album_type=ep,single` and
  `?focus_album_type_excl=soundtrack` honour the same shape as
  every other focus filter — comma-separated, validated against
  the known set, AND across sub-sections, OR within.
- Client: new `Type` column appears in the Focus bar, second from
  the left (after Genre). Empty types are omitted — if your
  library has no soundtracks, you don't see a "Soundtrack: 0"
  row.

### What this enables

Useful filters you couldn't build before:

- "Show me only my full-length studio albums" → Type = Main
- "Show me my soundtracks" → Type = Soundtrack
- "Hide all the EPs and singles from the main browse" →
  Type excludes EP, Single
- "Only Deluxe editions" → Type = Deluxe (great for finding
  re-issues you might want to revisit)

### Honest caveats

- Pattern matching has false positives. An album literally titled
  "Special Edition" (unrelated to a limited release) would be
  classified as Limited. Edge cases like that are rare; if you
  hit one, the per-album type override will need to ship as a
  separate v98 feature (currently the type is auto-derived only).
- The track-count heuristic is conservative. A 6-track album
  that's 35 minutes is classified as Main, not EP, because the
  duration test failed. This errs on the side of Main when in
  doubt — undercounting EPs is better than overcounting them
  (most libraries are mostly Mains).
- "Compilation" albums (Various Artists box sets) are NOT a
  separate type in this taxonomy — they fall into Main by
  default. Adding a Compilation type would need album_artist
  classification (e.g. "Various Artists" → compilation), which
  is a larger discussion than I want to embed in v97.

### Build

- `server/package.json` and `client/package.json` versions bumped
  1.0.32 → 1.0.33.

---

## v1.1.0.96 — 2026-05-03 — DIAGNOSTICS POLISH

Three small, safe additions. Like v95, no schema, no compose, no
endpoints. All cosmetic / dev-quality work.

### Disconnected renderer names cleaned up

The Audio Devices page lists previously-seen but currently-offline
renderers (greyed out) so settings can be tweaked before
reconnecting hardware. The placeholder names for these were rough:

```
Sonos (RINCON_X1234ABCD)         ← raw uuid, meaningless to user
Squeezelite (3a2b8f9d…)           ← arbitrary truncation
USB DAC alsa-card-2               ← shows the full ID twice
DLNA (12345678…)                  ← ditto
```

Now:

```
Sonos zone
Squeezelite player
USB DAC (card 2)
DLNA renderer
```

Honest names that don't pretend to know what the device is. The
user's custom_name (set via the rename action on the device's
detail screen) still takes precedence — these are just what shows
up before the user has bothered to rename a placeholder.

### CPU sensor source visible

v94 fixed the stuck-at-27.8°C bug by walking all
`/sys/class/thermal/thermal_zone*` directories and picking the most
CPU-relevant sensor. v94 logged the resolved sensor at startup, but
that log is buried in `docker logs` and not visible from the UI.

v96 adds the resolved sensor name (e.g. `x86_pkg_temp`,
`cpu-thermal`, `coretemp`) to the `/scheduler/status` API response
as `thermalSource`, and the metadata scheduler page in Settings
shows it as a tooltip when you hover over the temperature reading.

If your CPU temp is reading something weird, hover the value and
you'll see which sensor it came from. `acpitz` means the resolver
fell back to a chassis sensor (no real CPU sensor visible to the
container) — at that point the `/sys/class/thermal` bind-mount
added in v94 is the next thing to check.

### Silent-catch fix on focus loads

Two `useEffect` hooks in AlbumGrid had `.catch(() => {})` on the
focus-options and section-order loads. Errors there were silently
discarded with no signal to console. Reset Order button bug bit me
the same way in v92 — silent catch on `api.delete` (which doesn't
exist) hid a TypeError for weeks.

Both are now `console.warn` so a future regression there announces
itself. The catches stay (a transient network blip shouldn't crash
the screen) but errors are no longer invisible.

I deliberately didn't sweep all the other `.catch(() => {})` calls
in the codebase — many are on polling endpoints where logging
every 5-second hiccup would spam the console. The two fixed are
one-shot loads where a persistent error is signal not noise.

### What's NOT in this release

Same list as v95. The big items still need your input or are too
large to ship blind.

### Build

- `server/package.json` and `client/package.json` versions bumped
  1.0.31 → 1.0.32.

---

## v1.1.0.95 — 2026-05-03 — ALIGNMENT POLISH

A deliberately small release: just two visible alignment
corrections. No schema, no compose changes, no new endpoints — so
this stacks on top of v94 without compounding risk if v92-v94
testing surfaces any issues.

### HomeScreen tiles row padding (16, was 14)

The four library-stat tiles at the top of the HomeScreen had
`padding: '0 14px 18px'` while everything else on the screen
(greeting, recent activity header, tabs) used 16. Two pixels off,
but enough that the tile row read as slightly narrower than the
greeting above it.

v91's standardisation pass missed this row. Now matched.

### AlbumDetail back / more buttons aligned

The top of the album page has a back arrow on the left and a ⋯
overflow button on the right. Visually these should sit at the
same distance from their respective screen edges.

The back button has its `ArrowLeft` icon flush against the left
edge of the button bounds (no padding before it), so the icon's
visual centre sits ~7px from the screen edge. The ⋯ button was
36×36 with `justify-content: center`, putting its icon centre
~18px from the screen edge. Net difference: ~11px asymmetry —
small, but readable as "the right side has a gap and the left
doesn't".

Fix: the ⋯ button is now 24×24 with `justify-content: flex-end`,
putting its icon flush against the right edge of its bounds and
matching the back arrow's distance from the screen edge. The
borderRadius (which was 999, used for a hover ring that we don't
actually render) is dropped since the button no longer has a
visible chrome.

This addresses your "off-centre" feedback on the album page. If
the imbalance you saw was somewhere else, send a screenshot and
I'll fix that too.

### What's NOT in this release

Same list as v94. The big items (theme system, file watcher, album
page sections, PWA polish, Album Type filter) all need more
substantial work and remain queued.

### Build

- `server/package.json` and `client/package.json` versions bumped
  1.0.30 → 1.0.31.

---

## v1.1.0.94 — 2026-05-03 — POLISH PASS

Small, safe improvements while v92 and v93 settle in. Four changes:

### CPU temperature reads the right sensor

The user reported the CPU temp on the metadata scheduler page was
stuck at 27.8°C while htop showed real, varying temperatures. The
cause was naive: the original code read
`/sys/class/thermal/thermal_zone0/temp` blindly. On the user's
DietPi container that zone exposed an ACPI thermal sensor (chassis
temp, near-constant) instead of the CPU package temp.

The fix walks all `/sys/class/thermal/thermal_zone*` directories,
reads each one's `type` file, and picks the most CPU-relevant
sensor in this order:

1. `x86_pkg_temp` (Intel/AMD package temp — the one htop shows)
2. `cpu-thermal` (ARM, Pi family)
3. `coretemp` (per-core x86)
4. `soc_thermal` (some ARM SoCs)

If none match, falls back to any zone whose name contains "cpu",
then to the zone with the highest reading above 35°C (real CPUs
under load run 40–80°C; chassis sensors sit at 27–30°C), then to
thermal_zone0 as a last resort.

The resolved path is logged at startup so you can see which sensor
was picked: `🌡️  CPU temp source: /sys/class/thermal/thermal_zone1/temp (x86_pkg_temp)`.

### /sys/class/thermal bind-mount

Even with the smarter resolver, the container needs to actually SEE
the host's thermal zones. Docker exposes `/sys` by default but on
some kernels the view inside the container is partial — `thermal_zone0`
inside differs from outside.

`docker-compose.yml` now bind-mounts `/sys/class/thermal:/sys/class/thermal:ro`
so the container has the same thermal view htop has on the host.
Read-only because we never write to thermal sensors.

The install script's known-default-hash list is updated so users
on the v93 default compose get the new mount silently. Users with
customised compose files get the existing Y/n prompt about the
specific change.

### Focus options client-side cache

v91 made the server-side cache 1 hour, so opening the Focus bar is
fast in steady state. But navigating away from the Albums page and
back unmounted the React component, dropping the cached options,
and the bar would briefly flash "Loading focus options…" on every
return.

Fixed by promoting the cache to a module-level variable that
survives unmount/remount cycles. TTL matches the server (1 hour).
Doesn't persist across page reloads — the data can be tens of KB,
and a fresh page load should always re-fetch to pick up library
changes.

Effect: opening Focus on a previously-visited screen is now
instant, no loading flash.

### Diagnose button on empty Audio Devices state

v93 added the "Don't see your USB DAC?" diagnose banner, but only
showed it when at least one device was already in the list (so the
user wasn't on the empty state). Users with NO devices at all —
e.g. expecting only a USB DAC, no Sonos/WiiM — saw an empty page
with no diagnose option.

The empty state now includes a "Diagnose USB DAC" button that
opens the same UsbDiagSheet. Reuses the existing diagnostic
endpoint and UI; just makes it discoverable from one more place.

### Build

- `server/package.json` and `client/package.json` versions bumped
  1.0.29 → 1.0.30.

### What's NOT in this release

Same list as v93 plus:
- Volume bar audio settings parity (#13) — still need a screenshot
  to nail "mirror image and same function"
- AlbumDetail padding audit — same, screenshot-blocked
- Theme system (#22), file watcher (#20), album page sections (#19),
  PWA polish (#21), Album Type filter (#12) — all queued for later
  releases

---

## v1.1.0.93 — 2026-05-03 — USB DAC ACCESS

Bringing back USB DAC detection. The user reported their USB DACs
stopped showing up around v85; they're correct, the underlying
issue is that the docker-compose.yml in the tar doesn't expose any
audio hardware to the container. Detection was working *in theory*
but the container had nothing to detect.

### What was wrong

The `docker-compose.yml` in v89-v92 had no `devices:` declaration
and no `/proc/asound` bind-mount. The container could see network
renderers (Sonos, DLNA, Squeezelite) over the host's network stack
because we use `network_mode: host`, but USB hardware is namespaced
separately and needs explicit pass-through.

The detection code in `server/src/audio/detect.js` is structurally
fine — it falls back from `/proc/asound` parsing to `aplay -l`
probing, and from there to per-format capability probes. But all of
those need at minimum `/dev/snd` access to do anything useful.

### The fix

Three changes to `docker-compose.yml`:

```yaml
devices:
  - /dev/snd

volumes:
  - /proc/asound:/proc/asound:ro
  # ... existing mounts ...

group_add:
  - "29"
```

`/dev/snd` exposes ALSA device nodes to the container. `/proc/asound`
gives capability detection rich format info. `group_add: ["29"]` puts
the container's user in the host's `audio` group so device nodes are
openable without root. (29 is the standard Debian/Ubuntu/DietPi audio
GID. If your host uses a different GID, edit this number — the
diagnostic page tells you what to look for.)

### USB DAC diagnostics

New endpoint `GET /api/audio/usb-diagnostics` reports the state of
the detection pipeline in plain English, with checks for:
- `/dev/snd` accessibility (device nodes mounted?)
- `/proc/asound` visibility (capability detection?)
- `aplay -l` runs without permission errors
- How many DACs detect.js currently sees

When the Audio Devices page loads and finds no USB DACs (but does
find network renderers), it shows a "Don't see your USB DAC?"
banner with a Diagnose button. The button opens a sheet that calls
the diagnostics endpoint and presents the checklist with green/red
ticks plus tailored advice when something's wrong.

The endpoint is read-only and side-effect-free. Probing the host
for hardware uses the same paths detect.js does — no new audio
device opens, just reading `/proc/asound` and running the same
`aplay -l` we already run during detection.

### Install script

The script now detects when:
- the new tar's compose has `/dev/snd` mounts, AND
- the user's existing compose does NOT

In that case it explicitly prompts the user whether to use the new
compose or keep their customised version. This is specifically the
v93 path — users coming from v89-v92 with no USB DAC mounts will be
asked once. Users who'd already added their own mounts won't be
prompted (their existing compose still has `/dev/snd`).

### Why USB DACs worked once and stopped

The user reported they used to work. I can't pinpoint exactly when
it broke — the docker-compose.yml in the v89-v92 tars does not have
the mounts, but it's possible a previous install from an earlier
tar (with mounts) was overwritten somewhere along the way. The
install script preserves user customisations to docker-compose.yml,
so if your old compose had the mounts they should have been
preserved. If they weren't, that's a script regression that
predates v89 (where my visibility into the codebase begins).

The new prompting behaviour means: even if your compose was
silently overwritten in some past install, v93 puts you back on a
working config with your explicit consent.

### What this release does NOT do

- It doesn't make USB DACs work if they aren't physically plugged
  in or recognised by the host kernel. If `aplay -l` on the host
  doesn't show your DAC, the container won't either. The diagnostic
  page will tell you exactly that.
- It doesn't fix the hypothetical `runc on DietPi rejects /proc/asound
  bind-mount` case. The aplay-based fallback in detect.js handles
  that, but if it's biting you, the diagnostics page will say so.

### Build

- `server/package.json` and `client/package.json` versions bumped
  1.0.28 → 1.0.29 to force docker rebuild path.

---

## v1.1.0.92 — 2026-05-03 — ALBUM VERSIONING + RESET ORDER FIX

Second release in the v90-feedback sweep. Two big things:

1. **Album versioning by folder.** Two copies of the same album in
   different folders (e.g. Kind of Blue 16/44.1 vs Kind of Blue
   24/192) now show as two separate album entities instead of
   collapsing into one with duplicated tracks.
2. **Multi-disc grouping.** CD1/CD2/Disc 1/Disc 2 folder structures
   collapse to a single album. Tracks are ordered by disc number
   then track number within the album page.

Plus a third small but real fix: the **Reset Order button** on the
Focus bar now actually works.

### How album versioning works

The album identity is now `(album_artist, album_title, album_folder)`
instead of just `(album_artist, album_title)`.

The "album folder" is the directory all the tracks of one release
live in. For most albums that's just the parent directory of the
files. For multi-disc releases organised as one folder per disc:

```
/music/Pink Floyd/The Wall/CD1/01 In the Flesh.flac
/music/Pink Floyd/The Wall/CD2/01 Hey You.flac
```

the album folder is `/music/Pink Floyd/The Wall/`, and both discs
share one album entity. The detection uses a regex to match disc
folders: `/^(?:cd|disc|disk)[\s_-]*\d+$/i` — case-insensitive, with
optional separators between the prefix and number. Examples that
match: `CD1`, `CD 1`, `Disc 1`, `Disc-2`, `cd_3`, `disk 5`. Folders
like `CDS` or `Disc Edition` correctly DON'T match (they're not
disc-N patterns) and become their own album.

For collections lacking disc tags, the disc number is derived from
the folder name, so a flat box-set with `CD1/CD2/CD3` folders gets
proper disc ordering even without proper tags.

### Schema changes

- **`albums.album_folder TEXT`** — the canonical album folder. NULL
  on migration; populated on next scan. Two album rows can now
  share title+artist if their folders differ.
- **`tracks.album_id TEXT`** — explicit link to the album row this
  track belongs to. Lets queries do a clean JOIN instead of
  resolving by title+artist (which collides on dual-version
  libraries). NULL on migration; populated on next scan.
- **`tracks.album_folder TEXT`** — redundant copy for the small
  number of read paths that don't need a JOIN.
- New indexes `idx_tracks_album_id` and `idx_albums_folder` to keep
  per-album queries fast.

### Migration story

Pre-v92 album rows have IDs computed as `md5(artist + '\\0' + title)`.
Post-v92 album rows have IDs computed as
`md5(artist + '\\0' + title + '\\0' + folder)`. These are different
hashes, so a naive rescan would create duplicate rows.

To prevent that, the scanner now does a one-time in-place migration
inside `ensureAlbum`: when it encounters an album row that doesn't
exist under the new (folder-aware) ID, it looks for the legacy
(title+artist) row, and if found, rewrites that row's ID to the new
form within a transaction, cascading FK updates to `album_tags` and
`tracks`. After the first scan post-v92, every album row uses the
new ID format.

User-set state (favorites, saved_for_later, ratings, tags) is
preserved by the migration because we update IDs in-place rather
than wiping and recreating.

### `rebuildAlbumStats` updated

The per-album subqueries that compute `track_count`, `total_duration`,
`primary_format`, etc. previously joined on `album = title AND
album_artist = artist`. After v92 that conflates two same-named
albums in different folders. The new join clause is:

```sql
WHERE (t.album_id = albums.id
       OR (t.album_id IS NULL
           AND t.album = albums.title
           AND t.album_artist = albums.album_artist))
```

— prefer the explicit album_id link when present, fall back to
title+artist for tracks predating the migration. Once a rescan has
populated album_id on every track the fallback becomes a no-op.

### Album detail query

Same change: `/library/albums/:id` now selects tracks by `album_id =
?` instead of `album = ? AND album_artist = ?`, with the same
title+artist fallback for unmigrated tracks.

### Multi-disc UI

The `AlbumDetail` component already had disc grouping — when more
than one distinct `disc_number` was present in the tracks list, it
rendered "Disc N" headers. v92 fixes the disc sort to be numeric
(was lexical, so disc 10 sorted before disc 2). For libraries with
3-disc collections like Yessongs that didn't matter; for hypothetical
10+ disc collections it matters. Free fix.

### Reset Order button (Focus bar)

The button was wired but didn't work because the click handler
called `api.delete(...)`. The api object exports `del`, not
`delete`. Calling `api.delete` returns undefined, calling that as a
function throws `TypeError: api.delete is not a function`, the
`catch` block silently swallowed it, and the user saw "click does
nothing".

Fixed by calling `api.del(...)`. Same bug existed in
`FocusLibraryScreen` for bulk-delete of saved focuses, also fixed.
The `del` helper itself was extended to support an optional body
(was path-only) since FocusLibrary's bulk delete passes a list of
ids in the body.

### Behaviour changes

- **Existing albums show as single rows until rescanned.** v92's
  album versioning only kicks in when a track is rescanned — only
  then does the migration code see the file path and discover the
  folder. To see your dual-version albums (Kind of Blue 16/44.1 vs
  24/192) split into two entities, trigger a rescan.
- **Previously played albums keep their favourites/tags through the
  migration.** The in-place ID rewrite preserves all FK references.
- **Multi-disc albums in folders like `Album/CD1/...` will start
  showing disc headers** if they didn't before (when `disc_number`
  tag was missing on the files but the folder name carries it).

### What's NOT in this release

Same list as v91, plus:
- Multi-format album page UI affordance (showing "this is the
  16-bit version" vs "this is the 24-bit version" inline so users
  can distinguish them at a glance) — deferred until I know whether
  the format/quality badges in AlbumGrid are sufficient
- USB DACs regression
- CPU sensor
- File watcher
- Theme system
- Album page additional sections (more albums by artist, etc.)

### Build

- `server/package.json` and `client/package.json` versions bumped
  1.0.27 → 1.0.28 to force the docker rebuild path.

---

## v1.1.0.91 — 2026-05-03 — UI POLISH PASS

First of a planned 4-release sweep through the v90 feedback batch.
This release covers the CSS / layout changes, full release-date
display, and Focus options performance. Larger items (album
versioning, theme system, USB DAC regression, CPU sensor, file
watcher) are deferred to v92–v95 because each needs its own focused
investigation.

### UI / layout

- **Album grid: 3 columns on phone portrait** (was 2). Grid widens
  to 4 columns at ≥600 px viewport, 5 at ≥900 px, 6 at ≥1400 px.
  Tile gap tuned to keep tiles readable at 1/3 screen width.
- **Mini Now Playing bar: +50% height** (90 → 135 px). The cover
  thumbnail (56 → 80) and play button (48 → 64) scale
  proportionally so the bar reads as one unified element rather
  than a tall bar with tiny controls. The `--nowplaying-h` CSS
  variable propagates so AlbumDetail's bottom-anchored "track is
  playing" hint continues to clear the bar correctly.
- **Mini bar volume icon: matched to main NP screen.** Both icons
  open the same volume popover, so they should look the same.
  Bumped from 18 px (Volume2 lucide) to 24 px (the inline device
  SVG used on the full-screen NP).
- **Signal-path orb: bottom-LEFT of main NP** (was stacked above
  the device-icon button on the right). Orb and device-icon now
  sit on the same horizontal plane, which reads cleaner and gives
  each control breathing room. Spacer between them is flex-1 so
  the bottom row scales gracefully.
- **Volume popup: 3-button row borderless.** The hairline divider
  under DSP / Switch / Device was reading hard against the dark
  popup background; replaced with margin-only spacing. Matches
  the JPLAY flat aesthetic.
- **Volume popup: trimmed height** (top 20 → 16, bottom 48 → 28).
  Reads slightly more compact without losing breathing room.
- **HomeScreen padding standardised** to 16 px L/R (was 18 px).
  AlbumGrid, AlbumDetail, ArtistList already used 16 — HomeScreen
  was the outlier that made the home tiles look like they sat in
  a slightly different gutter.
- **Recent activity scroll: more breathing room.** Scroll padding
  bumped 16 → 18 with `scrollPaddingLeft: 18` so when the user
  scrolls back to the start, the snapped-into-place tile sits
  inside the panel rather than flush against the edge.

### Album page

- **Full release date displayed.** When the album's underlying
  files carry a full date tag (most FLAC `DATE` fields and ID3
  `TDRC`/`TDRL` frames do, e.g. "1982-10-01"), the album page
  shows it as `01 Oct 1982`. When only a year is known, falls
  back to the year alone. The DD MMM YYYY ordering matches UK
  date convention.

### Schema

- New `release_date` TEXT column on `albums` and `tracks`. Stored
  as a canonical YYYY-MM-DD or YYYY-MM or YYYY string. Existing
  albums get NULL on the migration; the next track scan back-fills
  from tags.
- The scanner extracts and normalises dates from `common.date`,
  `common.originaldate`, and `common.year` (in that priority).
  Various tag formats (YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, plain
  YYYY) all collapse to the canonical hyphen form. Unrecognised
  formats return null and the year column takes over for display.
- `ensureAlbum` accepts a new `releaseDate` parameter and
  back-fills it on already-existing album rows. Doesn't overwrite
  a release_date that's already set (user-curated matches stay
  authoritative).

### Focus performance

- **Focus options TTL bumped 30 s → 1 hour.** The `/focus/options`
  endpoint computes per-facet counts across the whole library
  (54k+ tracks for the canonical user). The dominant cost is the
  in-JS genre normalisation loop, which has to iterate every album
  row to canonicalise multi-genre values via the genreAlias table.
  Cache invalidation on library change (scanner completion) is
  already wired, so a 1-hour TTL is safe — genuine library changes
  bust the cache, and stale `lastPlayed` time-bucket counts age
  out at the same rate.
- **Per-key TTL.** The `cached(key, fn, ttlMs)` helper accepts an
  optional ttlMs override. Other endpoints keep the 30-second
  default; only `/focus/options` opts into the longer TTL.
- **Focus columns condensed horizontally.** Item label was
  `flex: 1` which pushed the count to the far right and left a
  wide gap on short labels ("Pop ............... 1234"). Now the
  label takes its natural width with ellipsis when too long, and
  the count sits 6 px after the label. Reads as "Pop · 1234" and
  uses less horizontal space per row.

### Build

- `server/package.json` and `client/package.json` version bumped
  1.0.26 → 1.0.27. This forces the install script's "rebuild
  required" path so the new client code lands in the docker image
  rather than being silently skipped on hot-swap.

### What's NOT in this release

These are queued for v92–v95 because each is too large to bundle
in a UI polish pass:

- **Reset Order button** (#4) — investigated, code path looks
  correct end-to-end, smoking gun not found yet. Will repro on
  installed v91 and trace.
- **Album versioning** — Kind of Blue 16/44.1 vs 24/192 grouped
  separately. Schema change and grouping logic.
- **Multi-disc track ordering** — CD1, CD2, etc. grouped in
  natural order. Needs query and UI changes.
- **Album Type focus filter** — EP / Single / Main / Deluxe /
  Limited / Soundtrack. Schema change to derive type.
- **Theme system** — JPLAY/flat toggle, dark/light toggle,
  greyish-blue palette. New design tokens, settings UI.
- **USB DAC regression** — last worked ~v85; needs investigation.
- **CPU sensor** — `27.8°C all the time` suggests the path or
  parsing is wrong; needs hardware probing.
- **File watcher** — instant scan on new music. New
  inotify/chokidar pipeline.
- **PWA polish** — service worker, manifest, install prompt.
- **Volume bar audio settings parity** — fixed/variable toggle
  inside the popover.
- **Album page additional sections** — more albums by artist,
  suggestions, album description, about-the-album.

### Behaviour changes

- Existing albums show year only on the page until rescanned
  (release_date column is NULL until a track scan back-fills it).
  To get full dates immediately, trigger a rescan in Settings.
- Phone users will see denser album grids. If 3 columns at phone
  width feels too tight, tell me — easy to dial back to 2 or
  introduce a user setting.

---

## v1.1.0.89 — 2026-05-03 — THE CASCADE FIX

The actual fix for the cascade. Diagnosed from a clean v88 trace
that finally showed the real mechanism. v86 and v87 fixed real
bugs but neither was the root cause; v89 is.

### What the v88 trace showed

A clean reproduction of the cascade with diagnostic logging
revealed:

```
[restart] zone=... track=e3bad1cb status=playing            ← toggle restart
[stream] track=e3bad1cb ... applied: Headroom -8.0 dB       ← new URL fetched
[stream] ffmpeg cmd: ... volume=-8.000dB ...                ← ffmpeg starts
[restart] zone=... track=e3bad1cb status=playing            ← second restart
[poll-stopped] qIdx=0/8 pos=0/285.21 pollTimer=set         ← renderer reports STOPPED at pos=0
[advance] via=auto-end from=0 to=1                          ← polling fires advance
[stream] track=64cafb8f ... empty chain                     ← next track fetched
[poll-stopped] qIdx=1/8 pos=0/263.85 pollTimer=set         ← renderer STOPPED at pos=0 again
[advance] via=auto-end from=1 to=2                          ← cascade
... 7 more times until queue exhausted
```

**Every cascade step has `pos=0`.** The renderer accepts each new
URL, fetches a packet or two, then reports STOPPED before the
playhead has advanced past zero. Our polling loop interpreted
each STOPPED as "track ended naturally, advance to next" and
chased the renderer through the queue.

The protocol-level mismatch theory (v86, v87) was directionally
right but addressed the wrong layer. The renderer DOES hang up on
some streams, but we can't reliably prevent that from the server
side — the renderer's behaviour depends on its own buffering and
firmware. What we CAN control is whether we treat each hang-up as
a completed track. The cascade engine is the polling-loop
auto-advance, not the renderer.

### The fix

The polling loop's STOPPED handler now distinguishes "track ended
naturally" from "renderer abandoned stream early" by comparing the
playhead position to the track duration:

- `position >= duration - 5` → played to end, advance normally
- `position < duration - 5` → abandoned early, mark zone stopped,
  stop polling, do NOT advance
- `duration === 0` (live streams, missing metadata) → bypass the
  check and advance normally

When a renderer abandons a stream early, the zone goes to STOPPED
state. The user can press Play, Next, or Prev to resume — these
all force a fresh URI which usually works because they go through
the v87-protected restart paths (`ensureRendererIdle` Stop-before-Set).

### Why this is the right fix

Three reasons it's the actual root-cause fix, not another bandage:

1. **The cascade engine is the polling loop, not the protocol.**
   Even if the WiiM hangs up on every stream, our cascade only
   exists because we keep advancing the queue in response. Refuse
   to advance and the cascade can't form.

2. **It defends against ANY future "renderer hangs up" bug.** New
   firmware, new device, new edge case — if the renderer hangs up
   early on a stream, we don't burn through the queue. We stop.

3. **It fails safe.** If the threshold is wrong, the worst case
   is "track stops at end instead of advancing gaplessly", which
   the user can fix with one button press. Compared to "burns
   through the entire album in 5 seconds," this is dramatically
   better behaviour.

### Behaviour changes

After v89:

- **Toggle DSP mid-album, renderer hangs up:** zone stops at the
  current track. User presses Play to resume from that track.
  No cascade.
- **Toggle DSP mid-album, restart succeeds cleanly:** track
  restarts from beginning, plays through, gapless transition to
  next track normally. Same as before.
- **Track ends naturally on a non-gapless renderer:** advances
  normally. Same as before.
- **Track ends naturally on a gapless renderer:** transitions
  via `onGaplessTransition` before reaching STOPPED branch. Same
  as before. This fix doesn't touch that path.
- **Network glitch causes renderer to drop a stream mid-play:**
  zone stops, user presses Play to resume. Pre-v89, this would
  have potentially cascaded too (depending on timing). Now it
  doesn't.

### What this means for users

- **No more cascade.** When DSP toggles trigger renderer
  hang-ups, playback halts cleanly instead of skipping through
  the album. User resumes with one button press.
- **The "skip button greyed out" symptom from earlier reports is
  gone.** Cascade can't reach queue-end any more because we don't
  advance on every hang-up.
- **Brief audio interruption on toggle is unchanged.** v85/v86/v87
  trade-offs all preserved.

### What this DOESN'T fix

- The underlying reason the WiiM hangs up on streams after a chain
  change. That's a renderer firmware behaviour we can't fix
  server-side. Squeezelite is unaffected because its protocol
  doesn't have this failure mode.
- The "Headroom missing from volume-bar shortcut" report — still
  unreproducible from code reading.
- Position preservation on restart — still resets to 0.

### What's preserved

- All v84 fixes (headroom-only attenuation, FIR auto-clear, bug
  report 10k chars, Web Share text/plain)
- v85 restart-all-zones-on-VL-change
- v86 Stop-before-Set in restartCurrentTrack and the polling-loop
  pollTimer-null guard
- v87 ensureRendererIdle helper used in advanceTrack-manual,
  startPlayback-mid-playback, and restartCurrentTrack
- v88 diagnostic logging — kept on at WARN level for now in case
  another race shows up. If v89 holds, we'll downgrade these to
  INFO or remove them in v90.

### Things to watch for after this release

- **If a track stops mid-album when toggling**, that's the fix
  working. Resume with Play / Next / Prev.
- **If the cascade still happens**, the trace will show `[advance]`
  events with `playedToEnd=true` somehow — meaning my threshold
  logic is wrong for some edge case. Send the trace and I'll
  investigate.
- **If tracks stop in the last 5 seconds and don't advance**,
  threshold is too generous. Will tighten to e.g. 3 seconds or
  use a percentage. Tell me if this happens.

### Risks

- **The 5-second threshold is empirical.** Picked because the v88
  trace showed `pos=0` definitively, so any reasonable threshold
  catches it. 5 seconds is comfortable margin for natural track
  ends without being so loose it lets through obvious abandonments.
  If a renderer reports STOPPED ~6 seconds early on natural ends,
  we'd refuse to advance there. Empirically I haven't seen that
  in any trace; if it shows up we'll adjust.
- **`zone.position` is updated by polling, so it could be stale
  by up to ~1 second.** That's well within the 5-second margin.
  Even if the position lags, the comparison is conservative — we
  only advance when we're confident the track played to end.

---

## v1.1.0.88 — 2026-05-03 — DIAGNOSTIC RELEASE

**No behaviour changes. No new fixes.** Five diagnostic log lines
added to identify the actual mechanism behind the DLNA cascade
that v86 and v87 didn't fully close.

### Why this is diagnostic-only

v86 fixed restartCurrentTrack with Stop-before-Set. v87 audited
every callsite that issues SetAVTransportURI mid-stream and applied
the same protection (advanceTrack-manual, startPlayback-mid-playback).
Both reduced the cascade frequency but did not eliminate it on the
WiiM-as-DLNA path. The Squeezelite-as-same-WiiM path is bulletproof,
so the protocol is the variable, but knowing "DLNA is racy" doesn't
tell us **which specific race** is firing now.

Three patches deep without a confirmed mechanism is too many. v88
just adds logging. User reproduces once, journal reveals the actual
firing sequence, v89 fixes the actual mechanism.

### What gets logged

All at WARN level, all prefixed for grep, all on a single line per event:

- **`[advance]`** — every `advanceTrack` fire. Shows zone, via
  (`manual` / `auto-end` / `radio-append`), from-index, to-index,
  trackIds, queue length. If a cascade is going through advanceTrack
  we see this fire repeatedly. The `via` value tells us which entry
  point.

- **`[poll-stopped]`** — every time the polling loop observes
  `transportInfo.state === 'STOPPED'`. Shows zone status, queue
  position, current playback position vs. track duration, and
  whether `zone.pollTimer` is still set. Position-vs-duration tells
  us whether the renderer hung up early (mid-track) or ended
  naturally. PollTimer state tells us whether stopPolling was
  called between tick start and STOPPED handler — if it's null
  here, the v86 guard fires and we log "BAIL".

- **`[prequeue]`** — every gapless pre-queue. Logs the URL and the
  dspVersion at pre-queue time. If the cascade is from stale
  pre-queue URLs (pre-queued at version=N1, then DSP profile bumped
  to N2 before the renderer auto-advanced to the stale URL), the
  dspVersion in this log will not match the dspVersion in the
  `[restart]` log that follows.

- **`[restart]`** — every `restartCurrentTrack` fire. Shows zone,
  renderer, current trackId, queueIndex, status. A single restart
  per user-toggle is correct. Multiple restarts per toggle would
  indicate something looping that we hadn't seen.

- **`[gapless]`** — every gapless transition observed (renderer
  auto-advanced from pre-queued URI). Same identifier shape as the
  others so a single grep filters the trace.

### How to use it

1. Install v88
2. Reproduce the bug: music playing on WiiM-as-DLNA, toggle Headroom
   OFF mid-album, observe cascade
3. Capture: `journalctl -u musicd --since "2 min ago" --no-pager | grep -E '\\[advance\\]|\\[poll-stopped\\]|\\[prequeue\\]|\\[restart\\]|\\[gapless\\]|stream\\] track|stream\\] ffmpeg error' > /tmp/v88-trace.log`
4. Send the file (or paste contents)

The grep filter cuts out the verbose ffmpeg startup banners — what
remains is just the diagnostic timeline.

### What we'll learn from it

A few specific patterns to look for:

- **Cascade goes through advanceTrack auto-end repeatedly:**
  `[poll-stopped]` fires multiple times with `pos < duration`,
  each followed by `[advance] via=auto-end`. This means the
  renderer is hanging up early on streams it just received,
  polling sees STOPPED, advances, repeats. The fix is at the
  pre-queue layer or polling layer.

- **Cascade goes through gapless auto-advance:**
  `[gapless]` fires multiple times in rapid succession. This means
  the renderer is auto-advancing through pre-queued URIs at network
  speed (each one immediately framing-fails). The fix is to clear
  pre-queue more aggressively when the chain changes.

- **Stale pre-queue URLs:** `[prequeue]` shows dspVersion=N1, then
  `[restart]` (from the toggle) shows or implies dspVersion=N2,
  but the next `[gapless]` or `[poll-stopped]` event references
  a track played from a version=N1 URL. Renderer didn't accept
  the clearNext SOAP. Fix is to verify clearNext landed before
  proceeding.

- **Restart fires multiple times unexpectedly:** would indicate the
  toggle is somehow triggering multiple `reapplyDspToRenderer`
  calls. Unlikely but the log will tell us.

### What this DOESN'T do

- No fixes
- No behaviour changes from v87
- Slight increase in log volume during DSP toggles and skips
  (one extra line per event). Negligible disk impact.

### Risks

- **Performance:** `console.warn` has a tiny overhead. Five extra
  log calls per second during a cascade is fine.
- **Privacy:** the `[prequeue]` log line includes the full stream
  URL, which contains the trackId and rendererId. No personal
  data, but technically more verbose than the previous logging.
  This is intentional for diagnostic purposes; v89 will roll the
  logging back to a less verbose form once we know the mechanism.

---

## v1.1.0.87 — 2026-05-03

Systematic fix for the **DLNA cascade family** of bugs. v86 patched
one specific entry point (`restartCurrentTrack`); v87 audits every
call site that issues a new SetAVTransportURI on a potentially-active
renderer and applies the same Stop-before-Set protection consistently.

### The diagnosis (proved by a controlled experiment)

User tested the same physical device (WiiM Pro Plus) under both DLNA
and Squeezelite protocols, in back-to-back captures:

- **DLNA**: Headroom toggle → 7-track skip cascade. Manual Next →
  another cascade. The signature: `[stream] ffmpeg error: Output
  stream closed` followed by rapid succession of new track requests.
- **Squeezelite**: Headroom toggled three times in quick succession
  (-5 dB → -1.5 dB → save → off). Same track ID throughout, no
  cascade. Each toggle cleanly restarted the same track.

Same hardware, same MusicD server, same DSP toggles. **Protocol is
the only variable.** The cascade is a UPnP/DLNA protocol problem,
not a renderer problem.

The DLNA failure mode: the renderer has cached current AVTransportURI
metadata and a pre-queued NextAVTransportURI. When we change the
audio chain mid-stream, the new track URL has different framing
(passthrough = Content-Length, re-encode = chunked). The renderer
hangs up early on framing mismatch. Polling sees STOPPED, calls
`advanceTrack`, which fires another SetAVTransportURI for a track
whose URL is also stale. Cascade.

### The fix

A single helper, `ensureRendererIdle()`, sends a Stop SOAP to every
renderer in a zone. Three call sites now use it:

1. **`restartCurrentTrack`** (was inline in v86, now uses the helper) —
   triggered by DSP profile changes, VL toggles, FIR delete-with-conv-active.
2. **`advanceTrack` with `via: 'manual'`** (new) — triggered by user
   pressing Next/Prev. The `via` parameter distinguishes manual skip
   (renderer mid-playback, needs Stop) from auto-end (renderer already
   STOPPED, doesn't need Stop) and radio-append (queue exhausted,
   already idle).
3. **`startPlayback` when zone was already playing/paused** (new) —
   triggered when the user picks a new album while another is playing.
   The most common trigger most people don't notice as a "skip" because
   the cascade lands on the new album's queue, but the same race exists.

Stop on an already-idle renderer is a near-no-op SOAP call, so calling
the helper costs nothing on the auto-end / cold-start paths.

The helper centralises a comment block explaining the rationale, so
the next person debugging a cascade variant only has to read one place.

### Audit table

Every callsite that issues SetAVTransportURI was reviewed:

| Callsite | Fix in v87 | Notes |
|---|---|---|
| `restartCurrentTrack` (DSP/VL/FIR-delete) | refactor to helper | inherited from v86 |
| `advanceTrack` manual (Next/Prev) | new — uses helper | the bug from latest report |
| `advanceTrack` auto-end (polling STOPPED) | unchanged | renderer already idle |
| `advanceTrack` radio-append (queue exhausted) | unchanged | renderer already idle |
| `startPlayback` (new album from idle) | unchanged | renderer already idle |
| `startPlayback` (new album mid-playback) | new — uses helper | gap closed |
| Sonos pause-as-Stop resume | unchanged | renderer Stop'd by pause |
| Restart-from-stopped (boot recovery) | unchanged | renderer cold |
| `moveQueueToRenderer` | unchanged | already Stops old zone |
| `stopAll` | unchanged | explicit Stop, no URI change |
| `appendQueue`, `reorderQueue`, `removeFromQueue`, `removeFromQueueBatch`, `insertNextInQueue` | not applicable | queue-array mutation only, no SetAVTransportURI |

### Why this should be the last release in this family

The cascade fingerprint is "renderer hangs up early on stream framing
mismatch, polling advances queue, repeats." That requires:

1. A SetAVTransportURI issued mid-stream
2. With framing different from what the renderer is currently fetching
3. On a renderer that doesn't gracefully abort the in-flight fetch

(3) is fixed at the renderer-protocol layer (Squeezelite avoids it
entirely). For DLNA we can't fix the renderer side, so we fix (1):
every callsite that could trigger this race now Stops first.

If a future cascade appears, it'll have to come from a code path
that doesn't go through the three protected callsites — i.e. a new
feature introducing a new SetAVTransportURI emission. The audit
table above is the authoritative list of current callsites; future
additions should consult this list.

### Things to watch for

- **Brief pause on every settings save / skip / new-album-while-playing.**
  ~200-500ms total. Same as v86 trade-off, just consistently applied.
- **First track of a new album takes slightly longer to start** when
  the user was already playing music. The Stop adds one round-trip.
- **No regression on Squeezelite.** Stop is a near-no-op there.

### Risks

- **The `via` parameter is a soft contract.** Future code adding a new
  caller of `advanceTrack` must remember to pass `via: 'manual'` if
  that caller is triggered by user action rather than auto-end. The
  helper bails safely if `via` is missing (treats as auto-end), so
  the failure mode of forgetting is "back to v86 behaviour at this
  one site," not data corruption.
- **`ensureRendererIdle` doesn't await renderer state confirmation.**
  We send Stop and proceed. If the renderer takes longer than the
  SOAP round-trip to actually be idle, we still fire the new
  SetAVTransportURI. In practice this hasn't been an issue — the
  Squeezelite comparison shows even a near-zero-latency Stop is
  enough. If a slow renderer starts cascading despite v87, we'd add
  a `getTransportInfo` poll to confirm STOPPED before proceeding.

### What's NOT changed

- v85 restart-all-zones-on-VL-change behaviour preserved
- v86 polling-loop pollTimer-null guard preserved
- All v84 fixes preserved (headroom-only, FIR auto-clear, bug report
  10k, Web Share text/plain)
- No client changes — server-only
- No schema changes — no migration

### Side benefit

The audit also identified that `appendQueue`, `reorderQueue`, and
similar queue-mutation paths correctly never issue SetAVTransportURI
mid-current-track. They only mutate the queue array and clear the
NextURI when the next-track-id changes. That's correct — confirmed
by audit, no change needed.

---

## v1.1.0.86 — 2026-05-03

Targeted fix for the track-skip bug, identified from journal output
captured during v85 testing. Single change, all in playerState.js.

### Fixed — Disabling DSP mid-album no longer skips tracks

**The diagnosis** (from journal output):

When the user toggled Headroom (or any DSP / VL setting) mid-album,
playback would skip 3-5 tracks or sometimes the entire album.
Reproducer: turn ON works fine, turn OFF skips. The journal showed
the cause:

The user was streaming a passthrough FLAC (no DSP, source bytes
served verbatim with `Content-Length`). Toggling Headroom ON forced
a re-encode pipeline (chunked FLAC, no `Content-Length`). Pre-queue
fired with the re-encode URL for the next track. Then the user
toggled Headroom OFF — pipeline switched back to passthrough. The
restart fired but couldn't unwind the renderer's already-queued
NextURI, which still pointed at a stale URL. The renderer played
that, hit a stream-framing mismatch, hung up early. Polling saw
STOPPED, called `next()`, which fired pre-queue for the
track-after, with another stale URL. Cascade.

`[stream] ffmpeg error: Output stream closed` in the journal is
the renderer hanging up on each re-encode stream as it skipped past.

The asymmetry the user reported (turn-on works, turn-off skips) is
because passthrough → re-encode is more permissive than re-encode
→ passthrough at the framing-mismatch boundary. WiiM Pro Plus
handles "expected Content-Length got chunked" better than
"expected chunked got Content-Length."

**The fix:**

`restartCurrentTrack` now sends an explicit `Stop` SOAP to the
renderer before issuing the new `SetAVTransportURI`. This forces
the renderer fully out of any play-or-transition state, so when
the new URI arrives the renderer is in a known idle state with no
pre-queued NextURI in flight.

The user explicitly asked for this:

> "Music playing > turn off HR, hit save (stop music command) >
>  HR removed from signal stream > start track from start >
>  playback continues instead of skipping"

That's exactly what this fix does. Cost: a brief audible pause
during the transition (the Stop SOAP plus the new
SetAVTransportURI plus Play SOAP — three round-trips instead of
one). The user has explicitly accepted this trade-off — the
"track restarts from beginning" interruption was already present
since v85; v86 just tightens up the renderer state-machine
handshake to avoid the skip cascade that was happening
afterwards.

**Plus a defensive secondary fix:**

The polling loop's STOPPED branch now checks `zone.pollTimer` is
non-null before calling `advanceTrack`. This catches the race
where `restartCurrentTrack` calls `stopPolling` while a polling
tick is mid-flight: the tick continues, sees the renderer's
STOPPED state from our explicit Stop SOAP, and would otherwise
fire `advanceTrack` — landing the user one track ahead of where
they were. Now that path safely bails when the timer's already
been cancelled.

### Why the fix is asymmetric-symmetric

The bug only manifested when going re-encode → passthrough.
Doing the Stop SOAP only in that direction would be slightly
faster (no Stop on re-encode → re-encode transitions like a PEQ
filter tweak). But:

1. Detecting "framing changes" reliably means comparing the OLD
   stream's framing against the NEW one, which means tracking
   the old framing per-zone — extra state to maintain.
2. The "fast" case (re-encode → re-encode) has a brief audible
   transition anyway because the track restarts from position 0.
   Adding ~50-100ms for the Stop SOAP is imperceptible.
3. Symmetric behaviour is easier to reason about and debug.

So Stop fires on every restart. Simpler beats slightly faster.

### What this DOESN'T fix

- **Tracks still restart from position 0** on settings change.
  Position preservation requires per-renderer Seek implementations
  (DLNA SetAVTransportURI + Seek REL_TIME, LMS Time, etc) and is a
  v87+ candidate.
- **The Headroom-section-missing-from-volume-bar-DSP-shortcut
  report.** Couldn't reproduce from code reading. After v86 ships,
  if the user still sees it missing, screenshot would help.
- **The v85 restart-all-zones-on-VL-change behaviour** is preserved.
  Each zone's restart now goes through the Stop-then-Set-then-Play
  sequence, so the VL toggle cascade should be cleaner across
  multiple zones too.

### Risks

- **Audible "click" or brief silence** during every restart, not
  just framing-changing ones. ~200-500ms total interruption.
  The user has accepted this.
- **The Stop SOAP itself can fail** (transient network, renderer
  busy). Currently logged and the restart continues anyway. If
  Stop fails, behaviour falls back to v85's pattern — the new
  SetAVTransportURI may race with whatever the renderer was
  doing. This is logged as `[restartCurrentTrack] stop failed`
  for diagnosis if it ever shows up.

---

## v1.1.0.85 — 2026-05-03

Settings changes during playback now affect the currently-playing
track instead of waiting for the next one. Closes the v84-deferred
behaviour the user explicitly asked for.

### Changed — Volume Levelling toggle takes effect immediately

Toggling Volume Levelling (or changing the target LUFS, or the
mode) now restarts the current track on every active zone so the
new pipeline takes effect right away. Before this, the running
ffmpeg process kept whatever chain it started with — VL on but
disabled in settings stayed attenuated; VL off but enabled in
settings stayed flat — and only the next track picked up the
change.

The signal path was correctly showing what was actually happening
to the audio, but it looked wrong to users (because it disagreed
with the current settings). Now both agree because both update
together.

Implementation: a new `restartAllPlayingZones()` helper iterates
over zones with active playback (status `playing` or `paused`),
refreshing the signal path and restarting the current track on
each. Sequenced rather than parallel — staggered restarts produce
fewer transient renderer hiccups when multiple zones are active.

The settings PATCH route detects whether any VL key actually
changed value (skipping a re-save with the same value, which would
otherwise feel like the app interrupting playback for no reason),
and only fires the restart in that case. Implementation uses
JavaScript loose equality (`!=`) to handle the case where settings
are stored as strings via manual SQL but submitted as numbers via
the UI.

### Changed — FIR DELETE restarts current track when convolution was active

Deleting an impulse response while convolution was running on a
live stream now restarts the current track so the user hears the
change immediately. Before this, deleting the IR mid-track left
the running ffmpeg pipeline using the in-memory IR data; the chain
"changed" only when the next track started.

Captures `conv_enabled` before the delete (so we know whether the
live chain was actually using FIR) and only triggers the restart
when convolution was active. Deleting an IR for a renderer where
convolution was off is silent — no point interrupting playback for
a no-op.

This complements the v84 fix that auto-clears `conv_enabled` when
the last IR is deleted: now both the flag and the audio update
together, in real time.

### Architectural note — what this does NOT do

This release does NOT add restart-on-DSP-profile-change for
playback-affecting fields beyond what v84 already had. DSP
profile changes (PEQ filters, headroom, crossfeed, conv toggle)
have been triggering `reapplyDspToRenderer` since v60+. v85's
addition is specifically the global settings (VL) and the FIR
DELETE corner case.

The "everything that affects the audio chain restarts the track"
behaviour is now consistent across:

- **DSP profile saves** (PEQ, headroom, conv toggle, crossfeed,
  master_enabled) — restarts that renderer's track
- **VL toggle / target / mode** — restarts every playing zone
- **FIR upload** (when conv is active) — restarts that renderer
- **FIR delete** (when conv was active) — restarts that renderer
- **Profile snapshot apply** — restarts that renderer

### Things to watch for after this release

- **Brief audio interruption on VL/DSP toggle.** Same flavour as
  the existing PEQ-toggle behaviour — track restarts from position
  0. Position is reset, not preserved. Preserving position would
  require per-renderer Seek implementations (DLNA SetAVTransportURI
  + Seek REL_TIME, LMS playlist time, etc) and that's a bigger
  follow-up. Documented as a v86+ candidate if anyone misses the
  position.
- **Multi-zone restart staggering.** With multiple zones playing,
  restarts run sequentially. Each restart can take ~200-500ms (the
  renderer round-trip), so all-zones-restart for a 3-zone setup
  takes ~1-1.5s end-to-end. Acceptable for a settings change; not
  acceptable for anything time-sensitive (none of these are).
- **The track-skip bug from the user's earlier report.** The
  existing `restartCurrentTrack` already has the polling-loop
  defence against the queue-advance race that causes the skip
  bug. v85 reuses this same code path. So in theory, v85's VL
  restart should NOT trigger the skip bug. If it does, the issue
  is elsewhere and we need a journal capture from when it
  happens.
- **No-op detection uses loose equality.** A PATCH that sends
  `vl_target_lufs: '-18'` (string) when stored as `-18` (number)
  is detected as no-change and skips the restart. This is the
  correct behaviour, but worth noting if a future change tightens
  type handling and breaks the comparison.

### Risks

- **Track restarts are user-visible.** The user explicitly
  preferred this over the stuck-on-old-chain behaviour. If
  anyone else who upgrades expected silent settings application,
  it'll feel different. Documented in this changelog.
- **Position is lost on restart.** Settings changes happen rarely
  enough mid-track that this is acceptable, but it's a
  regression from the previous "settings change but track keeps
  playing" behaviour for that one specific dimension.

---

## v1.1.0.84 — 2026-05-03

Bug-fix release based on a DSP / signal-path debugging session.
Targeted fixes only; no feature work.

### Fixed — Headroom-only DSP profiles silently dropped headroom

A profile with **only** Headroom enabled (no PEQ, no crossfeed, no
FIR) compiled to an empty filter list with a non-zero `headroomDb`.
The stream route gated headroom application on `dspApplied`, which
itself was true only when `compiled.filters.length > 0`. Result:
the user enabled Headroom on its own, set the slider to anything,
and nothing happened — no attenuation, no signal-path indication.

The signal path mirrored the same bug because its `dspWouldApply`
check used the same `filters.length > 0` test. So the user saw no
Headroom node either, even though the DSP profile had it enabled.

Fixed in two places — both check now also accepts a non-zero,
negative `headroomDb` as "DSP is doing something":

```js
const hasFilters = compiled.filters.length > 0;
const hasHeadroom = compiled.headroomDb && compiled.headroomDb < 0;
if (hasFilters || hasHeadroom) { dspApplied = true; ... }
```

The `master_enabled = false` and `headroom_db = 0` cases still
correctly evaluate to "no DSP" — the gating is on a *negative*
headroom value, which is what attenuation requires.

After this fix:
- Headroom-only profiles correctly attenuate the stream
- The signal path emits the Headroom node
- The X-Musicd-DSP response header includes "Headroom -X.X dB"
- canPassThrough on the stream side correctly forces a re-encode
- The signal path's `passThrough` flag also becomes false

### Fixed — FIR `conv_enabled` flag stayed true after deleting last IR

Deleting an impulse response file did not clear the `conv_enabled`
flag in the DSP profile. Symptom for the user: a checked-but-greyed
checkbox in the FIR section that couldn't be unticked, and a
permanent "FIR Convolution · Skipped — no IR uploaded" bypassed
node in the signal path.

The DELETE handler at `/api/dsp/fir/:rendererId/:rate` now checks
the renderer's IR count after deletion. When the count drops to
zero, it calls `dsp.saveProfile(rendererId, { conv_enabled: false })`
to clear the orphaned flag. Side effect (correct): saveProfile
recomputes `clipping_indicator` based on the empty IR set, which
removes any FIR-induced clip warning.

The flag re-enables on the next IR upload via the same UI, so
behaviour is symmetric: upload-an-IR-then-tick-conv works,
delete-the-last-IR auto-unticks.

### Fixed — Bug report description capped at 4000 characters

Server-side validation rejected descriptions over 4000 characters.
For a real bug report with steps to reproduce, this was tight.
Bumped to 10000.

The client-side textarea has no `maxLength` attribute, so the
limit was only enforced on POST. Users typed long descriptions,
hit Continue, and got "description too long (max 4000 chars)"
back. Now they get to write 10000.

### Fixed — Web Share API "permission denied" on iOS Safari

Sharing a bug report with the full JSON attachment failed on iOS
Safari with "permission denied" even after `canShare()` returned
true at probe time. iOS approves `application/json` files at the
canShare check but rejects them at the actual share invocation.

Two changes:

1. **Build the share file as `text/plain`** with a `.txt`
   extension instead of `application/json` / `.json`. The payload
   is identical (JSON text either way), but iOS Safari accepts
   `text/plain` consistently. Mail apps render the contents the
   same way on the receiving end.

2. **Re-verify `canShare` on the actual file** before calling
   `share()`, not just on the probe. If the actual file is
   rejected, fall back to a text-only share with the JSON appended
   inline — the user still gets the share sheet open and can
   forward to the developer, just without an attachment file.

### Not fixed — "Headroom missing from DSP shortcut on volume bar"

The user reported Headroom not appearing when DSP is opened from
the volume bar. The code review couldn't reproduce this — the
DSP overlay opens `<DspTab forceRendererId={rendererId} />` which
renders the same component as the Settings flow, and HeadroomSection
is included unconditionally. Possibilities not yet investigated:

- The Subsection scrolls out of the visible overlay area
- A CSS issue specific to the overlay context
- Something else only visible at runtime

After v84 ships and headroom actually works (fix 1), if the
"missing" complaint persists, a screenshot of the DSP overlay
will help — until we can see what the user is seeing, this stays
unfixed.

### Not fixed — Settings change requires next track to take effect

Toggling DSP / VL during playback doesn't restart the running
ffmpeg pipeline. The current track keeps playing with the chain
it started with. The signal path correctly reflects this — it's
showing what's actually happening, not what the saved settings
say.

This is architectural, not a bug per se. Fixing it cleanly means
either:

- Restart the current track on settings change (predictable but
  audible interruption)
- Live filter-graph reconfig via ffmpeg's `sendcmd` / `zmq` (much
  harder, more failure modes)

User has indicated a preference for the track-restart behaviour.
Deferred to v85 to keep this release focused on the contained
fixes above. The track-skipping bug also needs investigation
with journal output before claiming any fix.

### Not fixed — Track-skip / album-cuts-out on toggle

Symptom: certain DSP enable/disable actions cause playback to
skip 3-5 tracks or cut out the entire album. Sometimes the
audio continues but the remote screen doesn't reflect it.

Without journal output captured at the moment of the bug, the
root cause is uncertain. Possibilities include:
- Stream-pipeline rebuild racing with the renderer's playback
- A stale state in playerState triggering false queue-advance
- A renderer reconnect interpreting current playlist as exhausted

Deferred to a future release pending journal capture from a
reproducer.

### Risks

- **Headroom suddenly works.** Users who had Headroom enabled on
  its own and were unknowingly getting no attenuation will hear
  their stream get quieter after upgrading to v84. This is the
  correct behaviour — it just wasn't happening before.
- **FIR auto-unbox.** Users who deleted IRs while leaving conv
  enabled will see the tick clear on next page load. Re-tick if
  you want it back.

---

## v1.1.0.83 — 2026-05-03

Closes out the Focus feature: drag-reorder of sub-section columns,
plus rename for saved focuses. The original Focus spec from v80 is
now fully implemented.

### New — Drag-reorder Focus columns

Long-press a column title in the Focus bar (Genre, Audio format,
Bit depth, etc.) to "lift" the column. While lifted, drag left
or right to reposition it among the other columns. Release to
drop it into the new slot. Other columns shift visually to
indicate where the drop will land.

Gesture mechanics:

- **Long-press threshold**: 450ms. The press has to hold steady
  for that long before the drag activates. This lets normal
  horizontal swipes (to scroll the bar to additional columns)
  pass through without accidentally starting a reorder.
- **Movement cancels press**: if your finger or pointer moves
  more than ~8px during the press window, MusicD treats it as a
  scroll gesture and cancels the long-press timer. So a quick
  swipe across the bar scrolls; a deliberate hold reorders.
- **Pointer capture**: once the drag activates, the bar locks
  on to your pointer until release — even if your finger drifts
  off the column title. No "lost the drag halfway through"
  surprises.
- **Bar scroll suppressed during drag**: the Focus bar's
  horizontal scroll is disabled while a drag is active. Without
  this, the bar would try to scroll along with your pointer and
  fight the drag.
- **Haptic feedback**: on devices that support `navigator.vibrate`
  (most Android, some iPhones depending on settings), a brief
  8ms buzz fires when the long-press tips into drag mode. Just
  enough to confirm the gesture took.

The drop math:

- Slot pitch is `column width + gap` (188px in v83). The dragged
  column's centre offset (in slot pitches, rounded) determines
  the drop slot.
- Drop indices clamp at `[0, columns-1]` — you can drag
  off-screen left or right but the drop slot stays in range.
- Dropping where you started is a no-op; no network call, no
  visual flicker.

### New — Persistent custom order

Your reorder persists across reloads, server restarts, and
devices on the same MusicD instance. Storage is a single key
(`focus_section_order`) in the existing settings table, value is
a JSON array of section keys.

Forwards-compat: a saved order from a future version of MusicD
that mentions sections this version doesn't recognise gets the
unknown keys silently dropped at render time. The known keys are
respected; new sections appear at the end of the order. So you
can downgrade and your custom order won't crash anything.

Backwards-compat: when a future release adds a new sub-section
(e.g. a "Composer" column), it appears at the end of your
existing custom order automatically. Your earlier sections stay
where you put them.

### New — Reset order button

When you've customised the order, a "Reset order" button appears
in the Focus bar's top-right (next to Save / Update). Tap it to
revert to the default order. The button is hidden when you
haven't customised — keeps the bar clean for users who don't
care about reorder.

### New — Rename saved focuses

A pencil button on each Focus Library card opens a rename modal.
The current name pre-fills; type a new one and tap Save.
Validates the same way Save-as-new does (60-char limit, name
collision check). Optimistic update — the card updates locally
the moment the server confirms, and the list re-sorts
alphabetically to reflect the new name.

The pencil hides during selection mode (the tickbox lives in the
same corner there) and reappears when you exit selection mode.

### Server endpoints

- `GET    /api/library/focus/section-order`
  → `{ order: string[] | null }`
- `PUT    /api/library/focus/section-order`
  body: `{ order: string[] }`, returns `{ ok: true }`
- `DELETE /api/library/focus/section-order`
  resets to default

Validation on PUT:
- Array required
- Max 32 entries (generous future-proof bound)
- Each entry a non-empty string ≤ 64 chars
- No duplicates (would cause React key collisions)

The PUT handler for `/focus/saved/:id` already accepted `name`
from v82 — the rename UI just wires up to it.

### Risks / known limitations

- **iOS Safari long-press timing varies.** I picked 450ms based
  on iOS conventions. If it feels too long on a specific device,
  the threshold lives in `useColumnReorder` in Focus.jsx
  (`LONG_PRESS_MS`).
- **Mid-drag screen rotation hasn't been tested.** Most users
  hold their phone in one orientation while filtering, but if
  you rotate during a drag the math may briefly disagree with
  the visible layout. The drag should resolve cleanly on
  release; worst case is the drop lands one slot off.
- **No drag auto-scroll.** If you drag toward the edge of the
  visible bar and there are columns offscreen, the bar doesn't
  auto-scroll to reveal them. You'd have to drop, scroll
  manually, then drag again. Adding auto-scroll is doable but
  needs careful timing to feel right; deferred for now.
- **Pointer capture failure**: on rare browsers `setPointerCapture`
  throws. The `try`/`catch` swallows the error and the gesture
  still works, but the pointer can release if you drag too far
  off the column title. Not worth chasing unless you hit it.
- **No keyboard support for reorder.** Mouse and touch only. A
  power-user keyboard mode (e.g. `Shift+arrow` while a column
  has focus) would be a small follow-up.
- **Rename doesn't auto-rename if the new name collides
  case-insensitively** with another existing focus. Server-side
  uniqueness is case-sensitive (`UNIQUE` constraint on the
  `name` column). "Late Night Jazz" and "late night jazz" can
  coexist — odd but not harmful.

### What's next

Focus feature is complete. From here, the parked list:

- **Composer / conductor / sort-field scanning** — biggest
  remaining gap; classical and jazz collections especially
  benefit
- **Track-level multi-tag filter** — track view has no
  equivalent of the album-level multi-tag chip filter
- **iTunNORM (Apple Sound Check) decoder** — additional
  ReplayGain source for iTunes-ripped libraries
- **"Drop a tar" UI for stuck testers** — replaces the SSH
  recovery step
- **OR-mode multi-tag** — still parked unless raised
- **Various Artists / compilations** — bigger schema project
- **Multi-genre support** — bigger schema project
- **Wikipedia / Discogs metadata** — deferred from v66
- **SMTP-via-proxy for bug reports** — needs server
  infrastructure you'd own

---

## v1.1.0.82 — 2026-05-03

Saved focus combinations. Pick a set of Focus filters, name it,
recall it later from a new Focus Library screen.

### New — Save current focus

Two new buttons appear in the top-right of the Focus bar (opposite
the X close button) when relevant:

- **"Save as new…"** — visible whenever there's at least one pick.
  Opens a centred modal asking for a name. Press Save → the
  current picks are stored under that name on the server.
- **"Update X"** — visible only when the user has loaded a saved
  focus and modified its picks. Tapping saves the new picks under
  the same name. (X is the loaded focus's name, e.g.
  "Update Late Night Jazz".)

The bar tracks "dirty" state — the moment you change anything
after loading a saved focus, "Update X" appears. Save it, or
ignore the changes and navigate away (changes don't auto-persist).

### New — Focus Library screen

A new sidebar entry below "Saved for later", labelled "Focus
library", with the funnel/sliders icon. Lists all saved focus
combinations as cards, two per row on phone, more on wider
screens. Each card shows:

- The name (e.g. "Late Night Jazz")
- A one-line summary of the picks (e.g. "Genre: Jazz · 24-bit ·
  1970s · -MP3")

Tap a card → the focus loads and the screen routes to the Albums
view with the focus active. Picks are visible as pills above the
album grid; the funnel highlights to show focus is engaged.

### New — Selection-mode delete flow

Per spec: tap the trash icon (top-right of the Focus Library
header) to enter selection mode. Each card grows a tickbox in its
top-right corner. Tap as many cards as you want. The trash icon
turns red when at least one card is selected. Tap red trash → a
centred confirmation modal asks "Are you sure you want to remove
N selected items?" with Yes / No.

- **Yes** → bulk delete via `DELETE /api/library/focus/saved`
  with the id list. The cards disappear, selection mode exits.
- **No** → modal closes, selection persists.
- **Done** button in the header exits selection mode without
  deleting.

The modal is explicit about scope: "This only removes the saved
focus. Your music files are not touched." (Per spec.)

### New — Server endpoints

- `GET    /api/library/focus/saved` → list rows
- `POST   /api/library/focus/saved` → create (name + picks)
- `PUT    /api/library/focus/saved/:id` → update name and/or picks
- `DELETE /api/library/focus/saved` → bulk delete by id list

Validation enforced server-side:

- 20-row hard cap (per spec)
- Unique name per server (409 collision)
- Name max 60 chars
- Picks JSON max 16 KB
- DELETE silently skips non-existent ids (idempotent)

### New — Schema

New `saved_focuses` table:

```
id          INTEGER PRIMARY KEY AUTOINCREMENT
name        TEXT NOT NULL UNIQUE
picks_json  TEXT NOT NULL
created_at  INTEGER NOT NULL
updated_at  INTEGER NOT NULL
```

`picks_json` stores the serialised picks blob (Sets converted to
arrays). Picks are read together, written together, and never
queried against — JSON is the right shape rather than a normalised
join table.

No migration needed for existing installs — `CREATE TABLE IF NOT
EXISTS` runs idempotently on boot.

### New — Hook integration

`useFocusState` gains five new fields:

- `loadedFocus` — `{ id, name, picksSnapshotJson }` of the
  currently-loaded focus, or null
- `isDirty` — boolean, true when current picks differ from the
  loaded snapshot
- `serialisePicks()` — converts current picks to plain-JSON for
  POST/PUT
- `loadSaved(savedRow)` — hydrates picks from a row returned by
  the server
- `markSaved(savedRow)` — marks the current picks as the new clean
  baseline (used after Save / Update succeeds)

`clearAll()` now also clears `loadedFocus` — clearing all picks
implies "I'm starting fresh, this isn't 'Late Night Jazz'
anymore."

### New — Modal helper

`FocusModal` is a small centred-dialog component used for both
the save-name input and the delete confirmation. Tap outside the
dialog to dismiss (calls `onCancel`); inside the dialog,
caller-supplied content. Renders into a full-screen fixed overlay
so it doesn't get clipped by the sticky header / Focus bar.

### Risks / known limitations

- **No rename UI in v82.** The PUT endpoint accepts `name` so the
  capability is there, but the UI doesn't surface it. If you save
  "Late Night Jaz" with a typo, your options are to delete and
  re-save. Rename UI is a small follow-up.
- **No reorder of saved focuses.** Cards display in alphabetical
  order. If you want a different order, name them strategically
  (lead with a number or a letter to influence sort).
- **20-row cap is enforced at the create endpoint only.** If you
  hit 20, deletes free up slots normally. This is an intentional
  bound — saved focuses you don't use are noise.
- **iOS Safari modal dismiss**: tapping the dim backdrop calls
  cancel. If iOS rendering quirks ever make the backdrop
  unreceptive, the explicit Cancel/No buttons inside the dialog
  always work.
- **Loading a saved focus from the Library screen does NOT open
  the Focus bar** — it just applies the picks and routes to the
  Albums view. The pills row makes the active focus visible
  without taking up bar space. Tap the funnel afterwards if you
  want to refine.
- **Dirty check uses JSON string equality** of serialised picks.
  Cheap, but means if a future release adds a new sub-section,
  loading an old saved focus and re-saving will produce a
  different JSON (the new section's empty entry is added). That's
  technically a "change" but functionally a no-op. Acceptable.
- **The pickup-via-store pattern (`pendingFocusToLoad`) means a
  page refresh after navigating from the Library screen would
  lose the focus.** In practice this doesn't matter because the
  user's just navigated, not refreshed, but worth knowing.

### What's next

- v83 — drag-reorder of Focus sub-sections (per the original
  spec, deferred from v82 to isolate risk). Long-press a column
  title → drag left/right to reorder. Persisted server-side.
- v83+ — rename saved focuses (PUT endpoint already supports it).
- Composer / conductor / sort-field scanning (still parked).
- iTunNORM (Apple Sound Check) RG decoder.
- Track-level multi-tag filter.
- "Drop a tar" UI for stuck testers.

---

## v1.1.0.81 — 2026-05-03

Audio-quality Focus sub-sections — the v80 placeholders are real.
Bit depth, Sample rate, and Channel layout now appear as Focus
columns alongside Genre, Format, Decade, etc.

### New — Three new Focus columns

In the Focus bar, between **Audio format** and **Decade**, three
new columns:

- **Bit depth** — 16-bit / 24-bit / 32-bit (only those present in
  the library)
- **Sample rate** — 44.1 kHz / 48 kHz / 88.2 kHz / 96 kHz / 176.4 kHz
  / 192 kHz / 352.8 kHz / 384 kHz / 705.6 kHz / 768 kHz (only those
  present)
- **Channel layout** — Mono / Stereo / 5.1 / 7.1 (only those
  present); unusual counts get "{n}ch"

Each column behaves like every other Focus column. Tick a value to
add a pill; pill `+/-` toggles include/exclude; `X` removes.

Sub-section ordering in the Focus bar is now:
Genre → Audio format → Bit depth → Sample rate → Decade → Last
played → Added on → Channel layout → Artist.

### Migration — three new columns + automatic backfill

Three new columns added to the `albums` table:

- `primary_bit_depth INTEGER`
- `primary_sample_rate INTEGER`
- `primary_channels INTEGER`

Populated from a representative track per album, the same way
`primary_format` is. The "representative" track is the first one
returned by `ORDER BY format LIMIT 1` — same selection rule as
`primary_format`, so a multi-format album that picked FLAC for
its format also picks the FLAC track's bit depth / sample rate /
channels. Consistency over cleverness.

The boot migration triggers `rebuildAlbumStats()` once when it
sees albums with NULL audio quality columns whose tracks have
non-NULL values. Idempotent — subsequent boots are no-ops because
the trigger condition is false. Self-healing if any new album is
inserted without these values: the scanner runs
`rebuildAlbumStats` at the end of every scan that adds or
updates anything, which keeps the columns current.

For typical libraries the migration adds ~1-2 seconds to first
boot of v81; the `rebuildAlbumStats` UPDATE statement is one
correlated subquery extra per row but the existing index on
`(album, album_artist)` keeps it tractable.

### Trade-off — mixed-rate albums

An album with mixed-rate tracks (e.g. one 24/96 bonus track on an
otherwise 16/44.1 album) gets categorised by its first track's
values — usually 16/44.1 in this scenario. Same caveat already
applies to `primary_format` and nobody's complained about that,
so I've kept the behaviour consistent.

If this becomes a real problem we can switch to mode-based
aggregation ("most common bit_depth among this album's tracks
wins") in a future release without breaking the filter API. For
now: simpler is better.

### New — server endpoints extended

`GET /api/library/focus/options` adds three response fields:

- `bitDepths`:    `[{ value: 16, label: '16-bit', count: 1234 }, ...]`
- `sampleRates`:  `[{ value: 44100, label: '44.1 kHz', count: 1234 }, ...]`
- `channels`:     `[{ value: 2, label: 'Stereo', count: 1234 }, ...]`

Existing fields (formats / decades / genres / artists / lastPlayed
/ addedOn) unchanged.

`GET /api/library/albums` accepts six new params:

- `focus_bit_depth`        / `focus_bit_depth_excl`
- `focus_sample_rate`      / `focus_sample_rate_excl`
- `focus_channels`         / `focus_channels_excl`

All comma-separated integer lists. NULL-safe excludes (an album
with NULL `primary_bit_depth` won't be silently filtered out by
"exclude 16-bit" — it might be 24-bit but unscanned).

### Risks / known limitations

- **Pre-v81 albums need a one-time rebuild.** The migration
  triggers it automatically on first boot; if it doesn't fire
  for some reason (no tracks have audio metadata, or the check
  query failed), the audio-quality Focus columns will show
  empty options. Forced-fix: run a Rescan from Settings, which
  invokes `rebuildAlbumStats`.
- **MP3 / lossy formats often have NULL bit_depth.** The
  underlying tags don't have a meaningful "bit depth" — bitrate
  is what matters there. Albums with NULL `primary_bit_depth`
  simply won't appear in the Bit depth column's lists. They're
  reachable via Audio format = MP3 instead.
- **DSD files** report sample rates like 2_822_400 (DSD64) or
  5_644_800 (DSD128). The label formatter falls back to "{x.x}
  kHz" — so DSD64 shows as "2822.4 kHz". Not ideal but
  understandable; if you have lots of DSD a "DSD64 / DSD128"
  abstraction would be a follow-up.
- **Mixed-rate albums** (caveat above).
- **Sub-section reordering and saved focus** still deferred to
  v82+ per the original spec.

### What's next

- v82+ — Saved focus combinations (named, recallable) and
  tap-and-hold sub-section reordering.
- Composer / conductor / sort-field scanning (still parked).
- iTunNORM (Apple Sound Check) RG decoder.
- Track-level multi-tag filter.
- "Drop a tar" UI for stuck testers.

---

## v1.1.0.80 — 2026-05-03

Roon-style **Focus** filter. Funnel pill in the top bar opens a
columns bar with sub-section pickers; ticks become pills with
`+`/`-` toggle (include/exclude). Six sub-sections in this release;
audio-quality filters (bit depth, sample rate, channel layout) land
in v81 — they need new schema columns.

### New — Focus filter

A new pill icon (`SlidersHorizontal` from lucide) sits next to the
favourites heart in the existing top pill bar. Tap it to slide
down a Focus bar containing sub-section columns. Each column has
a title at the top and a vertical, scrollable list of options
below with tickboxes. Tap a tick to add a pick.

Picks become **pills** in a row above the album grid, sandwiched
between the existing top pill row and the grid:

```
[ + Rock      X ]   [ + 1970s X ]   [ - MP3 X ]   [ Clear all ]
```

Each pill has:

- A `+` icon on the left → tap to toggle to `-` (the pill turns
  red and the album list excludes that value)
- The label in the middle
- An `X` icon on the right → removes the pill entirely

Closing the Focus bar (top-left X) preserves the pills — the bar
just hides. Tapping the funnel again reopens with current
selections reflected as ticked rows.

### New — Sub-sections

Six sub-sections in v80, in this default order:

1. **Genre** — alphabetical, alias-aware (clicking "Electronic"
   matches albums tagged "Electronique")
2. **Audio format** — alphabetical (FLAC, ALAC, MP3, etc., from
   `primary_format`)
3. **Decade** — chronological, only those with albums in the
   library (e.g. no 1920s column if you have nothing from then)
4. **Last played** — Last 24h / Last 7 days / Last 30 days /
   Longer ago. Computed via `play_history`.
5. **Added on** — same buckets, derived from `albums.added_at`
6. **Artist** — top 50 by album count, presented alphabetically.
   Each Artist column has a search box for narrowing.

Audio quality (Bit depth, Sample rate, Channel layout) is **not**
in v80. These need three new columns on the `albums` table
(`primary_bit_depth`, `primary_sample_rate`, `primary_channels`)
populated from a representative track, plus a re-run of
`rebuildAlbumStats`. v81 will add them with a one-off migration
that runs on boot. Spec is otherwise the same — they'll appear
between Audio format and Decade in the column order.

### New — Filter logic

- **AND across sub-sections.** "Genre = Rock" + "Decade = 1970s"
  shows albums that are rock AND from the 70s.
- **OR within a sub-section.** Ticking "Rock" and "Jazz" in Genre
  shows albums that are rock OR jazz.
- **Excludes are AND NOT.** "- MP3" filters out all MP3 albums.
- All Focus filters compose with the existing favourites/saved/
  tag filters (so you can combine "Saved for later" with
  "Genre = Jazz").

### New — Server endpoints

`GET /api/library/focus/options` — returns the picks per
sub-section, computed live from the library so the user only sees
options that actually exist (no "1920s" if they have nothing from
then). Cached server-side for 60s; client refetches when the bar
opens.

`GET /api/library/albums` — accepts these new params, all
comma-separated, all optional:

- `focus_format` / `focus_format_excl`
- `focus_genre`  / `focus_genre_excl`
- `focus_decade` / `focus_decade_excl`
- `focus_artist` / `focus_artist_excl`
- `focus_last_played` / `focus_last_played_excl` (single value:
  `day`/`week`/`month`/`longer`)
- `focus_added_on` / `focus_added_on_excl` (same)

Backwards-compatible — existing callers without focus params get
exactly the same behaviour as v79.

### UI — funnel highlights when picks exist

The funnel pill is highlighted both when the bar is **open** and
when there are **active picks**, so the user can tell at a glance
whether the album list is filtered by Focus even when the bar is
hidden. (Without this, a user who closed the bar after picking
filters would see a quiet funnel and wonder why their library
looked smaller than usual.)

### Risks / known limitations

- **Focus state is ephemeral**: picks live in component state, not
  in localStorage or query params. Reloading the page clears them.
  This is intentional for v80; saved focus combinations are a v81+
  feature per spec.
- **Sub-section column reordering deferred to v81+** per spec. The
  default order ships fixed.
- **Focus bar height is 220px**: roughly the height of an album
  cover row but not exactly. Tweakable via `BAR_HEIGHT` constant
  in Focus.jsx if it feels wrong.
- **Genre matching uses the same alias logic as the existing
  `?genre=` filter**: if you have albums tagged "Electronique"
  and you tick "Electronic", they'll match. This is correct for
  the current scanner but means the alias map quality affects
  Focus accuracy.
- **Artist top-50 is by album count, presented alphabetically.**
  The 51st-most-prolific artist is reachable only via search.
  If your usage pattern wants different filtering — e.g. recently-
  added artists, or alphabetical from A onwards — let me know.
- **Last played 'longer ago'** is the inverse of "last 30 days"
  (i.e. albums with no play in the last 30 days). It includes
  albums that have never been played. There's no separate "never
  played" bucket; if you want one, easy to add.
- **Focus is suppressed on Favourites and Saved For Later screens**
  — those are themselves filtered views and stacking Focus on top
  would add complexity for unclear benefit. The funnel pill simply
  doesn't render there.
- **No keyboard shortcut yet.** Focus is mouse/touch only. If
  power users want a keyboard accelerator (e.g. `f` to toggle), I
  can add it.

### What's next

- v81 — Audio quality sub-sections (Bit depth, Sample rate,
  Channel layout). Schema additions + populate + UI.
- v81+ — Saved focus combinations (named, recallable).
- v81+ — Tap-and-hold sub-section reordering.
- Composer / conductor / sort-field scanning (still parked).
- iTunNORM (Apple Sound Check) RG decoder.
- Track-level multi-tag filter.

---

## v1.1.0.79 — 2026-05-03

Tiny UI release. Sticky header on the album grid so the heading,
sort pills, and tag chips stay visible while you scroll. Sets up
the v80 Focus feature (which needs predictable header geometry).

### UI — Sticky header on album-grid screens

The heading + sort pills (Title/Artist/Year/Random/Favourites) +
tag chip row now stay pinned at the top of the scroll container
while the album grid scrolls underneath. Same change applies to
the dedicated Favourites and Saved For Later screens (they share
the same component).

### Implementation notes

- Used `position: sticky; top: 0` on the existing header div
  rather than restructuring the page layout. Sticky positioning
  works because the parent (`s.content` in App.jsx) already had
  `overflowY: auto` — the parent is the scroll container and
  `top: 0` sticks the header to its top edge.
- Header has a solid `var(--jp-bg)` background and a subtle
  bottom border so albums don't show through when they scroll
  past. zIndex 10 keeps it above the grid.
- Restructured padding: removed `padding: 20px 16px 120px` from
  `.page` and split it into `.header` (top) and `.gridArea`
  (bottom, 120px clearance for the now-playing bar). The 16px
  horizontal padding stays on `.page`. The header uses negative
  16px margins to extend its background to the page edges.

### Risks / known limitations

- **iOS Safari bounce-overscroll** — sticky elements can briefly
  detach from the top during rubber-band scroll. Acceptable;
  proper fix would be a flex layout with internal scroll, which
  is a bigger refactor.
- **Header height vs phone screen** — three rows (heading + sort
  pills + tag chips) take ~120px on iPhone portrait. With the
  Focus pills row coming in v80 it could grow further. Not yet
  cramping; will reconsider if v80 makes the situation worse.

### What's next

v80 — Focus feature. Roon-style filter panel with sub-section
columns (genre, format, bit depth, sample rate, decades, last
played, added on, channel layout, artist) and active-focus pills
with `+ Label X` include/exclude semantics. Spec is locked.

---

## v1.1.0.78 — 2026-05-03

Bug fixes from the v77 audit, plus first real bug-report email
flow.

### Fixed — `matched_at` was stored in two different units

Pre-v78, the matcher loop wrote `Date.now()` (milliseconds) while
the scanner's tag-match path wrote `Math.floor(Date.now() / 1000)`
(seconds), into the same column. Manual match and reject sites
also used milliseconds. The mixed units were silently breaking
the v77 auto-retry SQL: comparing a millisecond-scale value
(`~1.7e12`) against a seconds-scale cutoff (`~1.7e9`) is always
false, so error-state albums never got re-queued.

v78 standardises every writer on **unix seconds** to match the
rest of the schema (`added_at`, `updated_at`, etc.). Three call
sites updated: matcher loop, `POST /match/:id/manual`, and
`POST /match/:id/reject`. Two scanner sites were already correct.

### Migration — `matched_at` legacy ms values converted on boot

A one-off migration runs at startup to normalise existing rows.
Sniff: any value `> 1e10` is millisecond-scale (unix seconds
don't reach 1e10 until year 2286), divide by 1000. Anything
≤ 1e10 already in seconds, leave alone. NULL rows untouched.
Idempotent — safe to re-run; no-op once complete.

Smoke-tested against 8 adversarial values (NULL, 0, ms-now,
ms-recent, sec-now, sec-ancient, threshold-1, threshold+1).
All correct after one pass; second pass changes 0 rows.

### Fixed — v77 retry SQL targeted wrong status string

The scheduler's `maybeReQueueStaleUnmatched()` looked for
`match_status IN ('unmatched', 'uncertain', 'errored')`, but the
matcher writes `'error'` (singular). One-character fix; combined
with the unit normalisation above, the v77 auto-retry now
actually fires for stale failed matches.

### Fixed — "Re-queue" button was invisible most of the time

The user reported this as broken. Pre-v78 the Re-queue button
only appeared when the v66 string-cleaner identified albums it
would query *differently*. Libraries with already-clean titles —
or libraries where the cleaner had nothing to strip — saw no
button at all even when there were dozens of unmatched albums
worth retrying. From the user's perspective: pressed Run
diagnostic, no button appeared, conclusion: broken.

The button is now **always visible** when there are unmatched,
uncertain, or errored albums. The cleaner-changed count is now
informational (revealed via "Show what the rescan would change"
disclosure) rather than gating the action.

### Fixed — Re-queue button label vs server behaviour

Pre-v78 button said `Re-queue {wouldChangeQuery} albums`,
implying it only re-queued the cleaner-changeable subset. But
the server-side `requeueUnmatched()` re-queued **all**
unmatched/uncertain albums — the count was wrong. v78 button
label uses `totalUnmatched`, matching what actually happens.

Also: server-side `requeueUnmatched()` now includes
error-state albums in its re-queue set (was previously skipping
them, leaving transient-failure albums permanently flagged).

### Changed — Section renamed: "Run diagnostic" → "Rescan Unmatched"

The user asked for this directly. The section now leads with the
action ("Rescan Unmatched") rather than the means to it ("Run
diagnostic"). The diagnostic info — what the cleaner would
change, examples — still exists, just hidden behind a `<details>`
disclosure for users who want it.

### Changed — Diagnostic auto-loads on render

Pre-v78 the user had to tap "Run diagnostic" to populate the
section. v78 fetches it on mount and refreshes every 30s. Cheap
call (in-memory loop, no MusicBrainz traffic) but kept off the
3s `loadAll` hot loop because a 5000-album library makes the
diagnostic ~50-100ms.

### Fixed — duplicate "paused — playback" message

When a zone was playing, the client showed both:
> **Paused: music is playing**
> Paused — playback active

v78 suppresses the second line whenever it duplicates the first.

### New — Bug report email flow

Three-tier delivery:

1. **Web Share API** (preferred). On platforms that support
   `navigator.share({ files: [...] })` — iOS, Android, desktop
   Safari — the user gets a system share sheet with the full
   JSON attached as a real file. Pick Mail, hit Send, done.
2. **`mailto:` fallback** for older browsers / desktops without
   Web Share. Opens the user's mail client with To/Subject
   pre-filled and a compact summary in the body. Recipient is
   baked in as `lm1980@me.com`. Subject is
   `MusicD bug report v1.1.0.78 — <id>`. Body contains the
   description, version, system fingerprint, active renderer,
   and the last 50 journal lines (mailto URLs are practically
   capped around 2000 chars across mail clients).
3. **Copy as text** button always available. If the share sheet
   was dismissed or the mailto: didn't open, the user can copy
   the entire email contents to clipboard and paste into their
   client of choice.

The full JSON report is still saved to disk regardless of which
path the user takes — that's how the email body references the
on-disk filename for follow-up if needed.

### New — Bug report retention policy

Pre-v78 the JSON reports accumulated forever in
`/var/lib/musicd/bug-reports/`. New policy:

- Keep the 50 most recent reports unconditionally
- Beyond that, drop anything older than 90 days
- Whichever is more lenient wins

So a tester with a flurry of reports in one week keeps all of
those for 90 days, plus the most recent 50 at all times. A
tester filing one a year keeps the lot.

Runs on every boot and once a day after that. Smoke-tested with
60 reports across 120 days; 50 kept (including some 98 days
old), 10 removed (all 100+ days old).

### Why I'm NOT baking iCloud SMTP credentials into the tar

The user offered an iCloud app password to bake into MusicD for
SMTP relay. I declined and asked them to revoke it (they did,
and generated a new one for their own use, not for MusicD).

Reasoning: any credential in the tar is a credential in every
tester's hands. Encrypted-in-source isn't actual security
because the decryption key has to be in the same source. The
only real options are (a) Web Share / mailto / clipboard from
the user's own device with their own mail account — what v78
does — or (b) a server-side proxy with the key, deployed by the
developer. Option (b) is a v79+ project if testers grow.

### Risks / known limitations

- **Migration is irreversible.** Running v78 on a v77 DB
  permanently divides any millisecond-scale `matched_at` values
  by 1000. Backwards compatibility note: a v77 binary opening
  a v78-migrated DB will see seconds-scale values everywhere
  (including those it wrote in milliseconds) and treat them
  consistently. The retry SQL would still be broken on v77
  because of the `'errored'` vs `'error'` issue, but no data
  loss.
- **`mailto:` body has a hard length cap.** ~2000 chars on iOS
  Mail; macOS Mail handles more; desktop Gmail web is variable.
  The server's `buildEmailBody` trims to 50 journal lines to
  stay under the cap, but a user typing a 1500-char description
  could still overflow. The Copy fallback always works.
- **Web Share file support is browser-dependent.** Probed at
  render time; the UI hides the button if `canShare({files})`
  returns false. iOS Safari supports it; Chrome on Android
  supports it; desktop Firefox doesn't. The mailto fallback
  catches the gaps.
- **`mailto:` may do nothing on a desktop with no default mail
  client.** Common on dev machines that only use webmail.
  Result: button click, nothing visible happens. The Copy
  button is the safety net here.
- **Diagnostic auto-load every 30s on the Settings page.** Most
  users don't sit on Settings for long, but if they do, that's
  one extra `/library/match/diagnostic` call every 30s. Cheap
  (in-memory loop, ~50-100ms on 5000 albums) but visible in
  server logs if anyone's watching.

### What's next

- Composer / conductor / sort-field scanning (v79 candidate)
- iTunNORM (Apple Sound Check) RG decoder
- Track-level multi-tag filter
- "Drop a tar" UI for stuck testers
- OR-mode multi-tag (still parked unless raised)
- SMTP-via-proxy for bug reports (real attachments without
  client involvement) — requires a server you run

---

## v1.1.0.77 — 2026-05-03

Metadata page cleanup, destructive buttons removed, and a new
auto-retry for failed matches that runs in the background only
when no music is playing.

### Removed — Three destructive "force everything" buttons

All three of the following had the same shape: a secondary button
next to the legitimate primary action that re-fired the same
operation across the entire library, ignoring per-item state.
Easy to fire by accident, hard to undo.

- **Album Matching → "Reset all"** — cleared every album's match
  status and re-queued thousands of MusicBrainz queries. Gone.
  The `resetMatch` handler is removed too. The `/library/match/reset`
  endpoint stays in place server-side for diagnostic tooling but
  no UI calls it.
- **Artist Logos → "Refetch all"** — re-fetched every artist's
  image, burning the fanart.tv quota. Gone. The "Fetch missing
  logos" button remains and only touches artists that didn't
  get an image last time.
- **Volume-Levelling Scan → "Rescan all"** — force re-read of
  every track's RG tags. Gone. Replaced with a state-aware
  single button (see below).

### Changed — Volume-Levelling Scan button is state-aware

The single button now reflects what's actually possible:

- **Library has unscanned tracks** → `Scan N tracks` (the count is real)
- **Library is fully scanned**     → `All tracks scanned` (disabled)
- **Pre-scan / no library**         → `Scan tracks` (generic fallback)

Backed by a new `missingCount` field on the `/settings/loudness/progress`
response. Server-side the count is a single LEFT JOIN counting
tracks with no `track_loudness` row.

If you re-tag your library externally (re-run r128gain, etc.),
the file's mtime changes and the library scanner picks them up
in the "missing" bucket on the next library rescan. So the
formerly-destructive "Rescan all" path is preserved for the
legitimate use case via the natural file-change → mtime → rescan
chain, without exposing a button that nukes everything.

### Added — Auto-retry of failed matches (idle-only, once a day)

The new behaviour the user asked for: albums that previously
failed to match (status `unmatched`, `uncertain`, or `errored`)
get automatically re-queued for the matcher once a day, but only
when no music is playing.

Mechanics:
- New helper `maybeReQueueStaleUnmatched()` runs inside the
  scheduler tick. Checks `last_unmatched_requeue_at` setting; if
  more than 24h since last run, finds failed albums whose
  `matched_at` is older than 7 days and resets their
  `match_status` to `pending`. The matcher worker then picks
  them up on the next cycle.
- Capped at once per 24h. Won't hammer MusicBrainz.
- Only failed/uncertain/errored albums are touched. Clean
  matches are never re-queried.
- Records `last_unmatched_requeue_count` for UI surfacing.

Why a 7-day stale window: failed matches usually fail because
MusicBrainz doesn't have a release entry for the album yet, or
because our string-cleaner hadn't matured (the v66 cleaner
recovered ~30% of unmatched albums on test libraries). MB adds
data continually; a week is roughly when it's worth re-trying
without being noisy.

### Added — Playback-aware scheduler

The metadata scheduler now defers all background work whenever
any zone has `status === 'playing'`. New helper
`playerState.isAnyZonePlaying()` checked twice in the scheduler:

1. **In `tick()`** — if music is playing, the tick returns early
   without starting a cycle. Status shows "Paused: music is playing".
2. **In `runCycle()` between jobs** — if playback starts mid-cycle
   (e.g. matcher running, you press Play), the next job in the
   priority list is skipped and the cycle pauses cleanly with
   the same "paused-playback" status. The currently-running job
   isn't interrupted (jobs are designed to complete or hit their
   1-hour cap; killing one mid-MB-fetch could leave a partial
   write). Worst case: one more job ticks until it naturally
   yields, then the cycle pauses.

Paused state clears automatically when playback stops — no
manual resume needed. Next tick picks back up where it left off.

### UI — Metadata page, action button alignment

Cover Art and Rematch Unmatched sections' action rows now
right-align (using a new `actionRowEnd` style class). This
matches the right-side button position in the Album Matching
and Volume-Levelling progress blocks, giving the Metadata page
a single consistent action edge.

The Library Rescan, Scrobbling, and Update screens keep their
existing left-aligned `actionRow` — the user scoped this change
to the Metadata page specifically, and drag-along refactoring
unrelated screens isn't worth the risk.

### UI — Auto-retry status line in Metadata Scheduler

The scheduler status panel grows one new dashed-divider row,
shown only when at least one auto-retry has run:

> Last auto-retry of failed matches    3 days ago · 12 re-queued

So users can see that the retry is working, and understand why
an album that was unmatched yesterday now shows "pending" again
without them having done anything.

### Risks / known limitations

- **"Paused: music is playing" can show even when nothing's
  pending.** Walks the order: playback check fires first, then
  pending-count check. If you have nothing pending and music is
  playing, the UI says paused — technically true (the scheduler
  *is* deferring) but slightly misleading. If this becomes a
  noise problem we can swap the order so we only show the paused
  status when there's actually something to defer.
- **The auto-retry timer is unix-time based, not tied to first
  boot.** First-time installs have `last_unmatched_requeue_at`
  unset (treated as 0), so the first re-queue runs on the first
  scheduler tick after boot — typically 60 seconds in. If the
  library was just freshly matched, this means a re-queue runs
  immediately. Empty result, no harm done, but the
  `last_unmatched_requeue_at` setting then persists and the next
  one is 24h later as expected.
- **Job pause is between-jobs, not within-job.** A matcher cycle
  takes up to an hour. If you press Play while the matcher is
  10 minutes in, the rest of that hour will keep running. The
  scheduler pauses *the next job*, not the current one. If
  in-job pause is wanted, that's a deeper change — the matcher
  would need a `shouldPause` callback honoured between MB
  requests.
- **The `/library/match/reset` server endpoint still exists but
  is unreachable from the UI.** Fine — kept for diagnostic /
  scripted use. If we eventually decide it's dead code we can
  remove it in a later release.

### What's next

- Track-level multi-tag filter (track list view)
- OR semantics for multi-tag (still parked unless you raise it)
- Composer / conductor / sort-field scanning (v78 candidate)
- iTunNORM (Apple Sound Check) RG decoder
- "Drop a tar" UI for stuck testers
- Whatever your tester reports

---

## v1.1.0.76 — 2026-05-03

ReplayGain visibility: tags read into the DB, surfaced on the
Album Detail page, and the LUFS back-out math now uses the
file's own reference loudness when present.

### Verified — Three real-world tag samples scan correctly

The user supplied three actual tag dumps from a tester's library.
All three parse correctly with the v75 + v76 logic:

| Sample | track gain | album gain | track peak | album peak | reference |
|---|---|---|---|---|---|
| File 1 | −8.83 dB | −8.33 dB | 0.00 dBFS | 0.00 dBFS | −18.00 LUFS |
| File 2 | −0.30 dB | −0.30 dB | −2.04 dBFS | −2.04 dBFS | (none) |
| File 3 | −7.64 dB | −6.95 dB | +0.26 dBFS | +0.30 dBFS | (none) |

All five `REPLAYGAIN_*` keys parse. Peaks above 1.0 (File 3,
inter-sample) preserve the >0 dBFS value rather than getting
clamped, so the runtime true-peak limiter sees the real number.

### Added — `REPLAYGAIN_REFERENCE_LOUDNESS` capture

Pre-v76 we read this tag but never stored it. Now stored in a
new `track_loudness.reference_lufs` column. Range-guarded to
−30..−10 LUFS — anything outside is treated as nonsense and the
column stays null.

### Changed — Integrated-LUFS back-out uses the file's own reference

The math `integrated_lufs = reference - track_gain` was always
correct in shape. Pre-v76 it used our `r128gain_target_lufs`
setting (default −18) as the reference, silently producing a
5 dB error if the file was tagged against −23 (some old r128gain
workflows). v76 uses the file's own `REPLAYGAIN_REFERENCE_LOUDNESS`
when present, falling back to the setting only when absent.

R128 tags get an implicit reference of −23 LUFS per the spec
when they don't carry an explicit value, since R128 isn't a
RG-spec value at −18.

### Added — Raw RG values stored alongside derived LUFS

Two new columns on `track_loudness`: `track_gain_db` and
`album_gain_db`. Stores the gain values exactly as the file is
tagged. The derived LUFS columns stay (used by `computeStreamGain`
for VL), but the raw values are what the UI shows.

### Added — ReplayGain visible on the Album Detail page

Three surfaces, all of which render only when data exists:

**Hero RG row** — appears below the year/tracks/genre meta line:

> REPLAYGAIN  Album −8.33 dB · peak 0.00 dBFS · ref −18 LUFS

If the album is partially scanned, a coverage badge follows:
`8/12 tracks`.

**Inline RG chip in track row** — small pill in the spec line:

> RG −8.8

Title attribute on hover gives the full 2-decimal value.

**Full RG block in the track overflow sheet** — long-press a
track to see all five values:

```
Track gain     -8.83 dB
Track peak      0.00 dBFS
Album gain     -8.33 dB
Album peak      0.00 dBFS
Reference     -18.00 LUFS
```

### Confirmed — MusicD never calculates loudness internally

The user wrote: *"The tags should be used before the calculating
within MusicD."* This is already true. MusicD reads embedded RG
tags. There is no internal `ebur128` or `loudnorm` measurement
pass — never has been. `computeStreamGain` works backwards from
the embedded values: track_gain → integrated_lufs → stream-time
gain.

If a track has no embedded RG, MusicD has no loudness data for
it. Volume Levelling falls back to no-op for that track. Running
r128gain (or any other tagger) externally and re-scanning is the
only way to populate the data.

### Risks / known limitations

- **Existing track_loudness rows have null in the new columns.**
  Pre-v76 scans don't have the raw gain values stored. The Album
  page will render nothing for previously-scanned tracks until
  they're re-scanned. Telling users to "force re-scan" via
  Settings → Volume Levelling → Scan picks them up. Not auto-
  triggered because some libraries are large.
- **Album-level RG is derived from the first track that has an
  album_gain_db.** All tracks on a properly-tagged album share
  the same album-level value, so this is correct in 99% of
  cases. Compilations or mixed-source albums where some tracks
  were tagged in album-mode and others weren't could show a
  partial picture. The coverage badge surfaces this.
- **Files tagged at non-default references silently get rescaled
  on re-scan.** A user who has tagged their library at −23 LUFS
  reference, then scanned with v75, then re-scans with v76, will
  see their integrated_lufs values shift by 5 dB. This is the
  fix landing — pre-v76 numbers were wrong by that amount — but
  flagging in case anyone notices the change.

### What's next

- Track-level multi-tag filter (track list view)
- OR semantics for multi-tag (still parked unless you raise it)
- Composer / conductor / sort-field scanning (v77)
- iTunNORM (Apple Sound Check) RG decoder
- "Drop a tar" UI for stuck testers
- Whatever your tester reports

---

## v1.1.0.75 — 2026-05-03

Three items the user flagged: headroom rework, ReplayGain coverage,
and a screenshot ask I couldn't action without input.

### Fixed — Headroom: actually applied, signal-path visible, VL collision handled

Three bugs in one feature.

**Was applied only when FIR was on.** v53's design assumed
headroom only made sense alongside FIR convolution. v75 broadens
it: headroom is now applied whenever the toggle is on, regardless
of FIR. If the user enables it, it takes effect.

**Was placed mid-chain.** v53 inserted the attenuation between
PEQ and FIR, which made sense as "FIR safety margin" but didn't
match the user's mental model. v75 moves it to **end of chain,
just before bit-narrow** — matching the user's description:
float-64 → all DSP → headroom → bit convert. This means
headroom now also covers any peaks generated by the rate
converter or other late-chain stages, not just FIR.

**Wasn't shown in the signal path.** A headroom node now
appears in the Signal Path display between Crossfeed and Sample
Rate, with the configured dB value and a "guard band before
bit-narrow" subtitle. When VL is active for the playing track,
the node is rendered as a `bypassed` badge with the explanation
"suppressed — Volume Levelling already attenuating," so the
user can see why the headroom isn't being applied right now.

### Added — VL+Headroom collision logic

If both Volume Levelling and Headroom are on, the stream
pipeline now silently suppresses headroom on tracks VL has
measured (because VL's per-track LUFS-targeting attenuation
already does the same job). Suppression is logged to the
journal: `[stream] headroom -3.0 dB suppressed (VL active for
this track)`.

The DSP screen's Headroom section now shows a blue note when
VL is on:

> Volume Levelling is on. Headroom is automatically suppressed
> on tracks VL has scanned, since VL already attenuates to a
> LUFS target. You don't need both — turn off whichever feels
> redundant.

### Fixed — ReplayGain coverage broadened (incl. MP3)

A user reported their tester's RG tags weren't being scanned.
Audit of the loudness tag-reader showed it walked four native
tag namespaces (Vorbis / ID3v2.3 / ID3v2.4 / iTunes) and missed
two that are common in the wild:

- **APEv2** — Foobar2000's historical default for MP3 ReplayGain
  tagging on Windows, also written by some old taggers like
  MP3Gain. Many Windows-side libraries store RG here. v75 walks
  this namespace.
- **ID3v2.2** — rare but exists for very old taggers. Now read.
- **ASF / WMA** — added support for the `WM/replaygain_*`
  attribute scheme.

Also: **`parseLinearDb` had two parser bugs** that silently
dropped valid tags in real-world libraries:
- Leading whitespace (`"  -6.54 dB"`) was rejected — some taggers
  pad their values
- Plus-sign prefix (`"+0.00 dB"`) was rejected — r128gain
  outputs this for non-negative values

Both fixed. Smoke-tested 13 cases including the two failures.

**MP3 ReplayGain is supported and always was**, but with the
APEv2 gap it appeared not to be for libraries tagged with
Foobar2000. Users with broken RG should retry the loudness scan
after upgrading.

### Not addressed — screenshot ask

The user noted: *"See attach screenshots. Still missing some
from older versions. Note: I cannot upload photos. Very
irritating."* I have no information about which specific
screenshots are missing or where they're meant to live (in the
What's New modal? on the Update page? in the public CHANGELOG?
something else?). Awaiting clarification.

### Risks / known limitations

- **Headroom placement change is a behaviour change.** Anyone who
  was relying on v53's pre-FIR headroom behaviour will see a
  measurable difference in chain output. The audible effect is
  small (the attenuation is the same total amount), but the FIR
  is now seeing un-attenuated signal — if the IR has +6 dB peaks
  and the source is hot, FIR output could clip internally before
  the bit-narrow stage attenuates it. The clipping prediction in
  the DSP UI still flags this case. If a user wants the v53
  semantics back, that's a separate "Pre-FIR Headroom" knob, not
  yet built.
- **APE / ASF tag walk depends on music-metadata's namespace
  exposure.** The library returns these as `meta.native.APEv2`
  and `meta.native.asf` respectively. If a future music-metadata
  release renames either, our walk will silently start missing
  tags again. There's no defensive fallback.
- **No diagnostic surface for "I have RG tags but musicd isn't
  finding them".** A `GET /api/library/tracks/:id/raw-tags`
  endpoint would let testers see exactly which native namespaces
  carry which keys. Worth adding if RG-not-found reports keep
  coming in.
- **Scanning side: r128gain still operates only as the user runs
  it externally**, embedded into source files. We don't write RG
  tags ourselves. Bringing tag-writing in-process would let
  testers seed RG without leaving the app, but it's a much
  larger feature.

---

## v1.1.0.74 — 2026-05-03

A single UI tweak.

### Changed — "What's new" collapsed to a tappable link

Previously, Settings → Update rendered the running build's full
release notes inline as a long markdown block. As release notes
have grown (v68 onward got progressively chattier), the block
came to dominate the Update screen — to reach the **Force re-check**
or **Troubleshoot** buttons below it you had to scroll past every
paragraph.

Now the inline block is replaced by a single quiet link:

> What's new in v1.1.0.74 →

Tapping it opens a full-screen modal reader with the close button
(✕) at the **top left**, distinct from the existing Changelog
modal's right-side X. The user asked for left-side here
specifically — easier thumb reach after scrolling, and reads more
like a "back" gesture than a "dismiss" one.

The modal renders the same release-notes text the inline block
used to render; nothing about *what* is shown has changed, just
the disclosure pattern.

### Why I didn't also move the Changelog modal's X

The user asked for left-side X on the new modal, not on the
existing Changelog modal that's been shipping since v25. Drag-
along refactoring an unrelated UI surface they didn't ask about
is exactly the kind of "while I'm in there" change that goes
wrong. If you want consistency across both modals, say the word
and that's a one-line change.

### Risks / known limitations

- **Loading state regression for fast networks.** The inline
  block used to show "Loading…" inline for ~50–200ms on first
  render. Now it shows the same brief inline message before
  flipping to the link. On fast networks this is invisible; on
  slow networks the inline message will linger. If it bothers
  you we can render the link skeleton immediately and let the
  modal do its own loading state.
- **No "Loading…" inside the modal itself.** The modal is given
  the notes prop on open, so it never shows a load state. This
  is intentional — the parent has already loaded. If we ever
  switch to "load on modal open" (saves one API call when the
  user never opens it), we'd need to add the loading state
  back inside the modal.

---

## v1.1.0.73 — 2026-05-03

The deferred multi-tag-filter decision, finally made.

### Added — Multi-select on the Albums tag chip strip

Tapping a tag chip on the Albums screen used to *replace* the
active tag. Now it *toggles membership* in an active filter set,
and the server intersects all selected tags. So tapping
"Late Night" then "Reference" shows albums that carry **both**
labels.

The "All albums" leading chip clears every selected chip in one
tap — useful when an over-tight intersection has produced an
empty page.

#### AND-vs-OR — the call I made

The semantics of "two chips active" had two reasonable choices:

- **AND (intersection)** — albums that carry every selected tag
- **OR (union)** — albums that carry any selected tag

I went with **AND**, for three reasons:

1. **Consistency.** Every other filter on the page already
   composes with AND (artist AND genre AND favourite). Mixing
   semantics by tag would break the mental model.
2. **Default usefulness.** "Jazz that's also late night" is
   more often what you want than "jazz OR late night". OR
   broadly behaves the same as just tapping each tag in turn,
   browsing each result.
3. **No fallback for AND.** If you want OR with a single-select
   chip strip, you can already get it by tapping each tag in
   sequence. There's no fallback for AND without multi-select.

If OR turns out to be wanted in real use, the cleanest path is a
`&match=any` query param + a long-press-to-OR gesture on chips.
That's an additive change — no breaking. v74 if you ask for it.

### Added — `?tag_ids=N,M,P` on `/api/library/albums`

Comma-separated list of integer tag ids. Each generates its own
`EXISTS (SELECT 1 FROM album_tags …)` clause, all AND-ed
together. Each clause is satisfiable from `idx_album_tags_tag`,
so even five active tag filters stays in low-millisecond
territory at typical library sizes. Smoke-tested against an
in-memory DB: single tag, two-tag intersection (positive), two-
tag intersection (empty), three-tag intersection (empty), full
unfiltered list, excluded-album-with-tag — all six cases pass.

The original `?tag_id=N` (single integer) is preserved verbatim
for back-compat. Anything that emitted v71-style requests still
works; new client emits the v73-style.

### UI — chip count hidden during multi-select

Each tag chip shows a small album count next to its name when
the selection is empty or single. With 2+ tags active the per-
tag count is hidden because it would mislead — that count is
the tag's standalone usage, not the size of the current
intersection.

### Risks / known limitations

- **No live intersection counter.** When 2+ tags are active,
  the chip strip doesn't show "showing 17 albums." The grid
  itself is the count; for now I'd rather not double-render
  the same number. If it bothers you, we can add a small
  status line under the chip strip.
- **No "save filter as smart playlist."** A natural next step
  for tag filtering is "this combination is a thing I want to
  open repeatedly." The data model supports it (just store the
  tag id list); the UI affordance is more thinking. v74 or
  later if you want it.
- **Track-level tag filter still doesn't exist.** The chip strip
  acts on the album list; it has no parallel on the (yet to be
  built) track list view.

---

## v1.1.0.73 — 2026-05-03

A user reported a tester stuck on v69 — their updater showed v69 as
available but wouldn't move forward, even though the manifest had
been advancing through v70/71/72. Diagnosis-first investigation
identified the most likely cause and three supporting fixes.

### Diagnosis (full)

The update pipeline has three sources of "what version should I
install next":

1. **Local watch dir** (`/var/lib/musicd/downloads`).
2. **Remote pending dir** (`/var/lib/musicd/updates/pending`).
3. **Manifest cache** (`_lastResult` in `remoteUpdater`).

Pre-v73 rule in `findAvailableUpdate()`: "use highest local newer
than current; fall back to manifest only if no local is newer."

The failure case: a tester pre-v69 with a stale `musicd-v1-1-0-69.tar`
in their local watch dir, plus intermittent manifest-fetch failures
(network blip, expired Dropbox `st=` token, whatever) → the v69
local tar shadows the cached v72 manifest indefinitely, even after
they reach v69, because the manifest cache may be stuck on a
previous-week's v69 entry too. There's no UI way to clear the stuck
local tar.

### Fix 1 — Highest version wins, regardless of source

`findAvailableUpdate()` now compares both candidates and picks the
higher version. On a tie, prefer local. This preserves the dev
workflow that justified local-priority (drop v99 test tar → it
wins because v99 > manifest's v72) while removing the stale-tar
shadowing.

Logs the choice clearly:
```
[update] remote v1.1.0.72 > local v1.1.0.69 (musicd-v1-1-0-69.tar); using remote
```

### Fix 2 — Opportunistic refresh on `/check`

`GET /check` was a pure cache read. If the daily manifest fetch
had failed once, the cache could sit stale for 24h. Now `/check`
notes cache age and, if older than 30 minutes, kicks off a
background `checkNow()` (no await). Client gets cached result
instantly; next poll picks up the refresh.

### Fix 3 — `POST /api/update/clear-pending`

New recovery endpoint. Deletes only files matching the canonical
`musicd-vX-Y-Z-W.tar` pattern from both the local watch dir and
the remote pending dir, then triggers a fresh manifest fetch.
Library data untouched.

### UI — Troubleshoot Updates block

Settings → Update gains a new section at the bottom with two
buttons: **Force re-check** (was "Manual update check," now
explicitly framed as recovery) and **Clear stuck update files**.
HelpTooltip explains when to use each. Result panel shows what
was deleted or any permission errors.

### How a stuck tester recovers

1. They first need to reach v73 by some manual means — drop a
   v73 tar in their watch dir, or SSH in and clear the stuck
   v69 tar with `rm /var/lib/musicd/downloads/musicd-v1-1-0-69.tar`.
2. Once on v73, Settings → Update → Troubleshoot → tap **Force
   re-check**. Banner reflects the manifest's current version.
3. If still wrong, tap **Clear stuck update files** — pending
   dirs wiped, manifest re-fetched.

### Risks / known limitations

- **Clear-pending will delete a manually-dropped tar if it matches
  the pattern.** Confirm dialog is the only safeguard. If the dev
  workflow hits this in practice, we can add a "preserve files
  newer than X minutes" filter — for now, simpler is better.
- **The v73 fix only takes effect once the user is on v73.** A
  currently-stuck tester needs a one-time manual rescue first.
- **Manifest-fetch failure root cause not addressed.** If the
  Dropbox URL is genuinely broken, neither the opportunistic
  refresh nor the clear-pending action helps. The
  `lastResult.error` field already surfaces the failure reason
  inline. A real fix would mirror the manifest somewhere with
  a more reliable host (GitHub release asset would be a natural
  choice), but that's project policy not code.
- **No automatic stale-tar GC.** Future enhancement could
  auto-delete pending tars whose version `<= current` after a
  successful update. Background file deletion is the kind of
  thing that goes wrong subtly though — explicit user action
  first, automatic later if the explicit action proves too
  manual.

---

## v1.1.0.72 — 2026-05-03

One bug fix and the second half of the v70 follow-up list.

### Fixed — Info panel closing on stray downward swipe

The About-this-track panel (opened by tapping the chevron at the
bottom of the Now Playing screen) was dismissing itself on the
slightest downward swipe in the middle of the page. With a long
artist bio, you couldn't reach the bottom of the panel without
the panel closing under your finger.

The previous touch handler treated any vertical motion of 60+px as
"close." Replaced with a horizontal-only swipe handler — left
swipes still navigate to the queue tab, but downward motion is
now silently ignored so the body's natural scroll handles it. The
**X in the top-left** of the panel header is now the only way to
close, which matches what the user asked for.

The handler also now requires horizontal motion to be at least
~50% greater than vertical to register as a queue swipe, so a
diagonal down-and-left scroll won't accidentally tab over.

### Added — Tag management screen (Settings → Tags)

Renaming and deleting tags previously required hitting the API
directly. There's now a dedicated section in Settings → Tags,
between Library and Audio Devices.

Each tag row shows:
- Colour dot (or muted placeholder if no colour set)
- Tag name
- Album / track usage counts
- Edit pencil → inline rename + colour picker
- Delete bin → with confirmation only when the tag is in use
  (empty tags delete on a single tap)

There's also an inline "+ New tag" form at the bottom that
duplicates the TagPicker create flow but with the full colour
palette visible. Use this when you want to seed a tag without
first applying it to anything.

Errors are inlined per-row so you see which tag failed without
losing context. The 60-character name cap and case-insensitive
uniqueness are enforced server-side; the UI surfaces 409 ("a tag
with that name already exists") and 400 (validation) responses
with the server's message.

### Added — Tag colour at create time in TagPicker

The TagPicker on album / track overflow sheets now exposes the
same colour palette in its create form. Previously every tag
created from an overflow sheet was monochrome; now you can pick
a colour at the point of creation rather than going to Settings
afterwards.

The palette is the same nine-swatch set as the management screen:
None / Red / Orange / Yellow / Green / Cyan / Blue / Purple /
Pink. None gives the default monochrome chip; the others are
hand-picked to clear 4.5:1 contrast against the JPLAY surface
scale at 18% alpha + full-strength border, so chips remain
legible on both `#0a0a0c` and `#1a1a22`.

### Risks / known limitations

- **No undo for tag deletion.** Once you confirm, the tag is
  removed from every album and track via the schema's `ON DELETE
  CASCADE`. If you need a tag back you'll have to recreate it and
  re-apply it. That's consistent with how Favourites and Saved
  for later behave (no undo), but call it out in case it surprises
  you.
- **Colour palette is fixed.** The schema and API both accept any
  `#RRGGBB` hex, but the UI only exposes the curated nine. If you
  want a custom hex, it's still possible via `PATCH /api/tags/:id
  {"color": "#abcdef"}`. I'd rather not surface freeform hex in
  the UI without contrast warnings — too easy to pick something
  that's invisible against the dark surfaces.
- **No bulk operations.** Deleting 20 unused tags requires 20
  taps. If you find yourself in that position, let me know and
  I'll add a "delete all unused" action.
- **Multi-select tag filter on Albums is still single-select.**
  v71 ships with one tag filter at a time; v72 doesn't change
  that. Multi-select is still parked on the AND-vs-OR question.

---

## v1.1.0.71 — 2026-05-03

The first half of the v70 follow-up list: tag chip strip on the
Albums screen. The other half (tag management screen + tag colour
picker in the create form) is v72.

### Added — Tag filter chip strip on Albums

A horizontally-scrolling row of user tags now appears on the
Albums screen, just below the existing sort/heart pill row. Tap a
chip to filter the grid to albums carrying that tag; tap the
active chip (or the leading "All albums" chip) to clear.

The chip strip is hidden on the Favourites and Saved-for-later
screens — those are themselves filtered views and the UX of
stacking another filter on top isn't worth designing without a
clearer reason. It's also hidden when no user tag has any album-
side usage (track-only tags don't trigger it).

Per-tag colour is respected on the active chip — if the user has
set a tag colour via the API or a future v72 colour picker, the
chip background uses that colour at 18% alpha and the border
uses the full colour. Untoned tags use the standard JPLAY
border-and-fill treatment.

Each chip shows the tag name plus a quiet count of how many
albums carry it.

### Added — `?tag_id=N` on `/api/library/albums`

Composable with the existing `?favorites=1`, `?saved=1`,
`?artist=`, `?genre=`, `?format=` filters. Numeric-only
validation; non-numeric `tag_id` is silently treated as "no
filter" rather than a 400 (keeps the URL forgiving when the
client races a tag deletion).

Implemented as an `EXISTS (SELECT 1 FROM album_tags …)`
sub-clause in the existing four-branch album query, with the
validated integer inlined into the SQL fragment. Smoke-tested
against an in-memory copy: solo, composed with favourite,
non-existent tag, and excluded-albums-tagged cases all pass.

The legacy v30.x favOnly fast-path branch was removed during
v70 — same pattern continues here. One ELSE branch handles
"no filters," any single filter, and any combination, all via
the cumulative `filterClause` string.

### Risks / known limitations

- **Single-select only.** Tapping a chip replaces the active
  tag rather than adding to it. Multi-select introduces the
  AND-vs-OR question (does "Late Night" + "Workout" mean
  *both* labels, or *either*?), which I'd rather design with
  intent than ship a guess. v72 if you actually want it.
- **Track-tagged albums don't appear in the chip strip.** A
  tag with zero album-side usage is suppressed. If you tag
  individual tracks but never an album, the tag is invisible
  on the Albums screen — but it still shows up in the
  TagPicker for that track. Track-tag filtering is a separate
  UI surface (probably a Saved-for-later-style sidebar entry).
- **No live update when tags are created elsewhere.** The chip
  strip refetches when the screen mounts and on each sort
  change, but not when you create a tag mid-session via the
  TagPicker on a track row. You'd need to navigate away and
  back. A `window` focus listener would close that gap; I
  haven't added one because it's a small inconvenience and the
  store would be a cleaner home for tag state when v72 lands.
- **No way to manage tags from the UI yet.** Renaming or
  deleting a tag still requires the `/api/tags/:id` endpoint
  directly. Tag management screen is v72.

---

## v1.1.0.70 — 2026-05-03

> **Recovery release.** Earlier tars I shipped for v1.1.0.67, .68
> and .69 were assembled from the wrong staging directory and
> didn't actually contain the v67 work (tags, save-for-later
> schema, TagPicker UI). What was claimed in those tars vs what
> they actually contained didn't match. v70 is rebuilt from the
> intact v67 source dir and re-applies the v68 + v69 changes on
> top, plus the new v70 work. If you installed any of v67, v68
> or v69 from the bad tars, this release will quietly add the
> missing schema columns on first boot via `safeAddColumn` and
> `CREATE TABLE IF NOT EXISTS` — no manual migration needed.

This release contains the work that should have been in v67, v68,
v69 (recovered) plus the new v70 sidebar entry for saved-for-later.

### v67 — Tags and Save for later (recovered)

Wires the disabled `Add to Tag` and `Save for later` placeholders
in the album and track overflow sheets. Both are now real working
features.

**Save for later** — a single bookmark flag per album / per track,
mirroring the favourites schema. Tap the bookmark item in either
overflow sheet to toggle. Storage:
- `albums.is_saved_for_later`, `albums.saved_for_later_at` with
  partial index for fast "show all saved"
- `tracks.is_saved_for_later`, `tracks.saved_for_later_at` (same)
- `POST /api/library/{albums,tracks}/:id/save-for-later`

**Tags** — many-to-many tagging system. Tags are user-defined,
case-insensitively unique, with optional colour. Albums and
tracks can each carry any number of tags.
- `tags`, `album_tags`, `track_tags` tables (cascade delete both
  ways)
- `GET/POST/PATCH/DELETE /api/tags`
- `GET/PUT /api/library/{albums,tracks}/:id/tags` — set the full
  list (idempotent diff)
- New `TagPicker` React component — JPLAY-styled bottom sheet,
  chip-based, inline tag creation

### v68 — Settings sub-section reset + zone identity (recovered)

**Fixed: Settings sub-section sticking when navigating away.**
Opening Settings → DSP, then hopping to Albums via the hamburger
menu, then returning to Settings dumped you straight back into
DSP instead of the section list. Three sidebar handlers
(`handleSection`, `handleSettings`, `handleHome`) now reset
`settingsSubSection`, so any navigation away from Settings
re-opens to a clean section list.

**Restored: Zone name editing.** Each renderer/zone has an
inline-editable display name on Settings → Audio Devices →
[device]. Tap the pencil to edit. Custom name takes precedence
everywhere via the renderer registry's `applyOverrides` helper —
Output sheet, mini-bar, sidebar. Schema: new
`renderer_settings.custom_name` column.

**Restored: Zone icon picker.** `RendererIconPicker` was in the
codebase since #30.22 but unmounted. Now tappable from the icon
tile on the device settings page.

### v69 — Two visual tweaks (recovered)

**Now Playing sizes bumped for phones.** Artist 14 → 16, album
12 → 14 (and one contrast tier brighter). The 14/12 from v64
read as caption text rather than as the primary "what am I
listening to" answer.

**JPLAY black floor lifted.** Pure `#000000` was too dark for
everyday use on OLED — harsh edge contrast against bright
artwork, visible smearing on motion. Lifted to `#0a0a0c`
(perceptually below the contrast-perception threshold for text,
above it for "is this OLED smearing"). Elevated tiers raised
proportionally:
- `--jp-bg`: `#000000` → **`#0a0a0c`**
- `--jp-bg-elevated`: `#0c0c0c` → **`#14141a`**
- `--jp-bg-surface`: `#141414` → **`#1a1a22`**

Hardcoded `#0a0a0a` placeholder fallbacks in five components
(AlbumDetail, AlbumGrid, ArtistAlbums, NowPlaying,
NowPlayingFullScreen) replaced with `var(--jp-bg-surface)` so
missing-art tiles read as deliberate placeholders rather than
slightly-darker holes.

### v70 — Saved-for-later sidebar entry (new)

The v67 backend stores a saved-for-later flag per album / per
track. v67 wired the toggle UI but didn't add a way to *see*
what you'd saved. v70 surfaces it.

- New **Saved for later** entry in the sidebar Library group
  (Bookmark icon, between Favourites and Settings)
- Reuses `AlbumGrid` via a new `savedOnly` prop — server
  composes `?saved=1` with the existing `?favorites=1` filter
  and any other (artist / genre / format) constraint
- Empty state: "Nothing saved for later yet. Tap an album's
  ⋯ menu and choose Save for later to add it here."
- Removed the v30.x favOnly fast-path SQL branch (no longer
  needed; the SQL planner handles a leading `AND` against the
  `excluded = 0` predicate just as efficiently as the
  dedicated branch did, and removing the special case avoids
  having to duplicate the savedOnly logic)

### Risks / known limitations

- **Track-level saved-for-later still has no list view.** The
  endpoint exists (`GET /api/library/saved/tracks`); the sidebar
  entry surfaces only the album list. Track-level saved is
  visible in the per-track overflow sheet but not browsable.
  Track-list view is for a future release.
- **No tag filter UI yet.** v67 stored tags; v70 still doesn't
  let you browse by tag. Chip-strip filter on the Albums and
  Artists screens is the v71 work.
- **No tag management screen.** Renaming or deleting tags
  still requires the API directly. Coming with the chip filter
  in v71.
- **Tag colour picker still missing from the create form.**
  Schema and chip rendering both respect colour; the picker UI
  doesn't expose it. v71.

---

## v1.1.0.67 — 2026-05-03

Wires the **Add to Tag** and **Save for later** placeholders that
have been sitting disabled in the album and track overflow sheets
since v62 and v63. Both features are now fully functional —
backend, schema, API routes, store actions, and UI all in place.

### Added — Save for later

A single bookmark flag per album and per track. Equivalent to a
built-in tag named "Saved" but kept as a column rather than as a
special-cased tag because the UI surfaces it as a primary action
(the bookmark icon, distinct from arbitrary user labels).

- `albums.is_saved_for_later` + `albums.saved_for_later_at`
  (partial index for fast "show all saved")
- `tracks.is_saved_for_later` + `tracks.saved_for_later_at`
  (partial index)
- `POST /api/library/albums/:id/save-for-later  { value: bool }`
- `POST /api/library/tracks/:id/save-for-later  { value: bool }`
- `GET /api/library/saved/albums` (newest-saved first, paged)
- `GET /api/library/saved/tracks` (newest-saved first, paged)
- Album-detail endpoint now exposes `is_saved_for_later` for both
  album row and tracks
- Album sheet's `Save for later` button toggles + persists; icon
  fills when set
- Track sheet's `Save for later` button toggles + persists

### Added — User tags

Many-to-many tagging system. Tags are user-defined, stored case-
insensitively unique, with optional colour. Albums and tracks can
each carry any number of tags.

- `tags` table (id, name UNIQUE COLLATE NOCASE, color, created_at)
- `album_tags` link table (composite PK, ON DELETE CASCADE both
  ways)
- `track_tags` link table (same)
- Indexed by `tag_id` for fast "show everything tagged X" lookups
- `GET /api/tags` — list with usage counts (albums + tracks per tag)
- `POST /api/tags` — create, returns 409 on case-insensitive
  collision
- `PATCH /api/tags/:id` — rename / recolour with collision check
  that excludes the tag being edited (so case-only renames like
  "jazz" → "Jazz" work)
- `DELETE /api/tags/:id` — cascades through both link tables
- `GET /api/tags/:id/albums` — list of albums carrying this tag
- `GET /api/tags/:id/tracks` — list of tracks carrying this tag
- `GET /api/library/albums/:id/tags` — get the album's current tags
- `PUT /api/library/albums/:id/tags  { tag_ids }` — set the full
  list (idempotent diff: server adds and removes to match wanted
  state in a single transaction)
- `GET /api/library/tracks/:id/tags`
- `PUT /api/library/tracks/:id/tags  { tag_ids }`
- New `TagPicker` React component — JPLAY-styled bottom sheet,
  chip-based selector with inline tag creation. Per-tag colour is
  respected via a translucent fill on the active chip. Empty state
  prompts the user to create their first tag.

### How to use

1. Tap an album's `⋯` menu → **Add to Tag…** opens the picker.
2. Tick existing tags or hit **+ New tag** to create one.
3. **Done** persists. The full new list comes back from the server
   so the UI stays in sync.
4. Long-press a track row → **Add to Tag…** does the same for
   tracks.
5. Tap the **Save for later** button in either sheet for a single-
   click bookmark.

### Tested

- Schema validated against an in-memory SQLite copy: case-
  insensitive uniqueness, cascade-on-tag-delete, cascade-on-album-
  delete, save-for-later round-trip — all pass.
- All server JS passes `node --check`.
- All client JSX passes brace-balance check.

### Risks / known limitations

- **No filter UI yet.** You can tag albums and tracks but there's
  no place in the app yet to *browse* by tag. The endpoints are
  there (`GET /api/tags/:id/albums`); the chip-strip filter on
  Albums + Artists is **v68**.
- **No tag management screen.** To rename or delete a tag right
  now you'd have to call the API directly. A Settings → Tags
  screen comes in v68 alongside the filter UI.
- **No saved-for-later list view yet.** The endpoints exist but
  there's no menu item in the sidebar to browse what you've
  saved. Same v68 work.
- **Track-level saved-for-later isn't surfaced anywhere visible
  on the album page.** When you save a track, it's stored, but
  the album row doesn't show a bookmark chip the way it shows
  the heart and ★ chips. Small gap, easy v68 add.
- **Per-tag colour picker is missing from the UI.** The schema
  + API both support a `color` field; `TagPicker` respects it
  visually if set; but the create flow doesn't expose colour
  selection. Tags created from the app right now will be the
  default monochrome chip. Roughly one form-field's worth of
  v68 work.
- **No bulk-tag operations.** You can't tag every track on an
  album in one tap, nor untag a whole album's tracks at once.
  If the library suggests this is needed, can be added.
- **Tag names case-preserved on display, case-insensitive on
  match.** "Jazz" and "jazz" are the same tag — typing either
  finds the existing one. The server returns 409 on collision
  with the `id` of the existing tag, but the current store
  helper strips that out; the picker handles it by refetching
  and toggling the matching tag on. Slightly clunky; a future
  refinement could short-circuit the round trip.

---

## v1.1.0.66 — 2026-05-03

Metadata pass — round 1. The visual JPLAY work (v62–v65) made the
app look coherent; this release starts addressing the much bigger
underlying problem you flagged: 1,261 albums sitting in the
unmatched bucket because the v30.19 matcher couldn't find them on
MusicBrainz despite Roon finding nearly all of them.

This is **round 1** of the metadata work. The strategy is
incremental: improve the matcher's title/artist cleaning (highest
leverage, no new sources needed), ship a diagnostic so we can
*see* which albums benefit, and a rematch button so you can re-run
just the unmatched set rather than the whole library. Discogs,
Wikipedia-as-search-fallback, and album-review aggregation are
deferred to v67+ once we have evidence about how much round-1
moves the needle.

### Added — title and artist cleaners

`cleanAlbumTitle()` strips trailing noise from a tagged album
title before sending it to MusicBrainz:

- `(Remastered)`, `(Remastered 2019)`, `(Deluxe Edition)`,
  `(Anniversary Edition)`, `(Special Edition)`, `(Director's Cut)`,
  `(Bonus Tracks)`, `(Live)`, `(Acoustic)`, `(Demo)`, `(Reissue)`,
  `(Repackaged)` etc.
- `(50th Anniversary Edition)`, `(25th Anniversary)`, ordinal
  variants
- `[Bonus Tracks]`, `[Hi-Res]` bracketed variants
- ` - Remastered`, ` - Deluxe Edition`, ` - Live at Foo` en-dash
  trailers
- ` CD1`, ` Disc 2`, ` Vol. 1` disc markers
- `(24/96)`, `(DSD)`, `(FLAC)`, `(MQA)`, `(Hi-Res)` format hints

The cleaner runs iteratively (up to 4 passes) so a title like
`Foo (Remastered) [Bonus Tracks]` is reduced to `Foo` in one call.
Smoke-tested against 13 cases (all pass) including titles that
should NOT change (`Live at Wembley` stays as-is; `(Live)` as the
full title stays as-is).

`cleanArtistName()` strips trailing `feat. X`, `ft. X`,
`featuring X`, `with X` clauses. Smoke-tested against 6 cases.

### Changed — matcher uses cleaners both for query and scoring

The cleaners are wired in two places:
1. **Query construction** in `matchOneAlbum`: the cleaned title +
   artist are sent to MusicBrainz. A new fallback also queries with
   the original raw strings if cleaning produced no candidates,
   covering edge cases where MB genuinely has the deluxe edition as
   its own release group.
2. **Candidate scoring** in `scoreCandidate`: the album side is
   cleaned before normalising, so a tagged "Abbey Road (Remastered
   2019)" scores against MB's "Abbey Road" without the trailing
   noise inflating the edit distance.

A new last-resort attempt (`artist:"X"` alone) was also added to
the query chain. If everything else returns nothing, we'll scan the
artist's catalogue and let the candidate scorer find any near-
title match. This catches the case where the title is wrong enough
that no title-clause query hits, but a fuzzy title score against
the real artist's release groups is still informative.

### Changed — proportional fuzzy match threshold

The old fixed cap of 4 edit-distance was too tight for long titles
(classical works, "Symphony No. X in Y Major Op. Z" patterns).
Replaced with a length-proportional cap:
- Title: ~10% of the longer-side length, between 2 and 8.
- Artist: ~12% of the longer-side length, between 2 and 6.

Score awards are now stratified by how close the match is within
the dynamic cap rather than a single tier:
- Exact: +50 (title) / +30 (artist) — unchanged
- ≤ 25% of cap: +35 (title) / +22 (artist)
- ≤ 50% of cap: +25 (title)
- ≤ cap:        +15 (title) / +12 (artist)

This means short titles still get a tight match but long titles
get the latitude they need. A 3-character title still requires a
near-perfect match; a 30-character title can absorb 3 edits and
still land in the top tier.

### Added — diagnostic endpoint

`GET /api/library/match/diagnostic?samples=N` runs the v66 cleaners
against every currently-unmatched album **without hitting
MusicBrainz** and returns:
- `totalUnmatched` — how many albums are in the unmatched/uncertain
  buckets right now.
- `wouldChangeQuery` — how many of those would be re-queried with
  a different (cleaner) string under v66. These are the high-
  probability rematch wins.
- `wouldNotChange` — already-clean titles that the v66 cleaner
  doesn't help. These are likely genuine misses; suggest manual
  matcher or fingerprint.
- `missingTitleOrArtist` — albums with no usable title or artist.
  Can't be matched until they're tagged.
- `samples` — up to N (default 30) example albums showing the
  before/after of the cleaner so you can sanity-check what's
  about to be re-queried.

Surfaced in **Settings → Metadata Refresh → Rematch unmatched
(v66)** as a new "Run diagnostic" button. Result shows inline with
an expandable "Show N examples" details panel.

### Added — rematch endpoint

`POST /api/library/match/rematch-unmatched` flips currently-
unmatched and uncertain albums back to `match_status='pending'`
so the regular matcher worker re-processes them with the v66
improvements. Skips albums marked `matched_by='manual'` or
`matched_by='tag'` — those decisions stick.

The endpoint just queues; it doesn't start the worker. The user
clicks "Re-queue N albums" in Settings, then "Start matching" as a
separate step, so they're in control of when the MusicBrainz load
hits. Returns `{ ok: true, queuedCount: N }`.

### Risks / known limitations

- **Round 1 only addresses titles where the noise is at the end.**
  An album tagged `Live at Wembley (Remastered)` becomes
  `Live at Wembley` (good — that's the canonical title). An album
  tagged `Remastered 2019: Abbey Road` is unchanged because the
  noise is at the front and stripping it would risk eating real
  titles. If common, we can add a leading-noise pattern in v67.
- **Various Artists / Compilations are not specifically handled.**
  MB stores compilations differently and the artist-match scoring
  won't favour them. If the diagnostic shows a lot of "would
  change query" but the rematch run still leaves most unmatched,
  this is likely the explanation. Compilation handling is a
  separate v67 task.
- **No new metadata sources yet.** Discogs (an excellent free
  source for releases MB sometimes misses) and a Wikipedia-as-
  search-fallback are deferred. Both require API key handling and
  more careful integration; doing them properly is bigger than
  this release should be.
- **The proportional fuzzy threshold could over-match for very
  long titles.** A 60-character title gets an 8-edit allowance
  which is generous. The stratified scoring pushes those into the
  weakest score tier (+15) so they're unlikely to clear the
  85-confidence threshold without other signals (artist match,
  year match), but if you see false-positives surface let me know
  and we can tighten the cap.
- **Smoke tests cover the cleaner regexes but no automated tests
  cover the full match pipeline.** The v66 changes have to be
  trusted by user testing — running the diagnostic against your
  real 1,261 unmatched, then a rematch, then comparing the new
  unmatched count.

### How to use this

1. Settings → Metadata Refresh → "Run diagnostic" (no MB calls,
   instant).
2. Read the result. If it says e.g. "1,261 unmatched, 800 would be
   re-queried with a cleaner string," that's your win estimate.
3. "Re-queue 800 albums" — flips them to pending.
4. "Start matching" up top — kicks off the worker. ~13 minutes per
   1,000 albums at MB's 1-req/sec limit.
5. After it finishes, run the diagnostic again. The remaining
   unmatched are the genuine misses that need manual matching or
   fingerprint.

---

## v1.1.0.65 — 2026-05-03

JPLAY pass continues — Artists screen, the per-artist album page,
and the side menu. After this release every navigable screen on the
music-browsing path is on the JPLAY palette. Settings and a few
infrequently-visited screens (Search, BioModal, etc.) still use the
legacy charcoal-blue and will be addressed as part of v66 onwards
when their content changes.

### Changed — Artists screen

- **Pure black background**, 20/16 padding matching AlbumGrid.
- **2-col phone grid** (was 3-col) using a new `.jp-artist-grid`
  CSS class with the same breakpoint progression as `.album-grid`
  (2 / 3 / 4 / 5 columns from phone up to desktop).
- **Avatars dropped chromatic gradients.** v64 generated a per-
  artist HSL hue from the artist's name and rendered each missing
  avatar as a unique colour gradient. JPLAY's monochrome aesthetic
  doesn't allow that — every artist with no real logo now shows
  initials on a flat `--jp-bg-surface` tile with a `--jp-border`
  hairline.
- **Drop the avatar's drop-shadow** (was `0 4px 12px rgba(0,0,0,0.3)`).
- **Initials weight** softened from 700 to 500. The 700 read as
  "logo type" against the JPLAY rest-of-the-app discipline.
- **Heading 24/600**, name 13/500, count 11/mono.

### Changed — per-artist album page (ArtistAlbums)

- Pure black ground, 20/16 padding.
- Section header dividers thinned to `--jp-border` (was the visible
  `--border` at 10% white).
- Section title 11/600/uppercase in `--jp-text-2` (was 12/700 in
  `--text-secondary`) — matches JPLAY's quieter section labels.
- Album cards in this view migrated to v62-style: 4 px corners,
  no card chrome, 13/500 title, 12/400 artist, year line dropped.
- Action row (Play all / Queue all / About): rebuilt against
  `--jp-*` tokens. Play all uses the white-fill primary button.
  Queue all and About are quiet outline buttons in `--jp-text-2`.

### Changed — side menu (Sidebar)

- **Pure black ground** (was `--bg-surface` charcoal), hairline
  borders (was 10% white).
- **MusicD wordmark** dropped the bright blue D — JPLAY is
  monochrome, so the chromatic accent against an otherwise
  monochrome menu read as a leftover. The "D" stays visually
  distinct via weight (700 vs 500), not colour.
- **Active nav item** uses a 6%-white fill with brighter text
  (was the blueish `--accent-dim` fill with `--accent` text).
  Monochrome active state matches the rest of the JPLAY pass.
- Renderer button: outline-style (transparent fill, hairline
  border) instead of the previous charcoal panel.
- More breathing room across the menu — nav padding 12 px (was
  10), section labels with slightly tighter letter-spacing.

### Risks / known limitations

- **Artist avatars look more uniform.** With every "no logo" case
  showing the same near-black tile + initials, the visual variety
  the chromatic gradients used to provide is gone. Whether this is
  better depends on taste; JPLAY's discipline prefers it. If you
  want some variety back without going chromatic, we can introduce
  3-4 monochrome variants (e.g. slightly different fills per first-
  letter band) — let me know.
- **The blue D in the wordmark was a piece of brand identity.**
  Going monochrome there is a real loss. If you'd like it back,
  it's a one-line change (`logoD: { color: '#5b7fff' }`).
- **Active nav state** is now subtler. Easier to overlook which
  section you're in. JPLAY's design intent is "you know because
  the page content is showing"; if it feels too understated we can
  bump the active fill to 10 % white.

---

## v1.1.0.64 — 2026-05-03

JPLAY pass continues — Now Playing full-screen + the mini bar at the
bottom of the app. After this release, the most-used screens (Albums
grid, Album Detail, Now Playing, mini bar) are all on the JPLAY
palette. The remaining legacy-styled screens are Artists, Search,
Settings, and the side menu — those come in v65.

### Changed — Now Playing full-screen

- **Pure black background.** The legacy `#0a0a10` charcoal-blue
  ground is replaced with `var(--jp-bg)`. The background-art blur
  (which tinted the screen with the album cover's dominant colour)
  is dialled way back: 0.6 → 0.18 opacity, 0.2 → 0.10 brightness.
  Just enough warmth to stop the screen feeling sterile, not enough
  to read as a colour cast.
- **Album art** now 4 px corners (was 14), no drop-shadow (was a
  heavy 12 px / 50 px / 80% black). Sits flat on the canvas
  matching the album-grid and album-detail aesthetic.
- **Title 22/600** (was 20/700), artist 14/500 in `--jp-text-2`,
  album 12/400 in `--jp-text-3` — italic dropped (JPLAY doesn't
  italicise album names; the contrast muting alone reads as
  context).
- **Progress** white-fill on 8% white (was white-fill on 12%).
  Slightly thinner contrast.
- **Transport** kept the dominant white play-circle (JPLAY does
  this too) but lost the 28-px white glow shadow that read as
  "iTunes button".

### Changed — mini bar (bottom strip)

The bottom mini-now-playing bar gets the most use across the app
and was the most-different from JPLAY of any current screen. Big
overhaul:

- **Album cover thumbnail** added on the left of the bar (56×56,
  4 px corners). JPLAY-style — having the cover always visible
  while you browse other screens is part of the audiophile
  control-point feel. Tapping the cover opens full-screen NP, same
  as tapping the text.
- **Pure black ground** (was `var(--bg-surface)` charcoal). Hairline
  border-top in `--jp-border` (was the visible 10 % white).
- **Thin 2 px progress strip** absolutely positioned across the very
  top edge of the bar. Smoothed playhead, white-on-6%-white. Lets
  you see how close to track-end the playhead is without opening
  full-screen NP.
- **Play button** keeps the white circle but loses the visible
  drop-shadow (was `0 2px 10px black/25`).
- **Right-cluster icon buttons** lose their charcoal fills and
  visible borders for a quiet 4 % white fill on a transparent
  border.
- **Track title** weight bumped to 600 (was 700) so it sits closer
  to AlbumDetail's 600 hero. Artist quietened to 12/400 in
  `--jp-text-2`.

### Risks / known limitations

- **Cover image fetch on every track change.** The mini bar now
  pulls `/api/library/tracks/:id/cover` for the active track. The
  endpoint is already used by the full-screen NP and by AlbumDetail
  so it's cached, but if you switch tracks rapidly there may be a
  brief flash where the bar shows the old cover before the new one
  loads. Acceptable for v64; could add a subtle fade-in if needed.
- **Background warmth on the full-screen NP** is now very subtle.
  If you've come to rely on the album-colour wash to identify
  what's playing at a glance, this may feel too muted. The values
  are easy to tune (search `bgWash` in NowPlayingFullScreen.jsx —
  bump opacity to 0.4 and brightness to 0.18 to get something
  halfway between v63 and v64).
- **The Settings / Sidebar / Artist / Search screens still use the
  legacy charcoal palette.** Switching to those after browsing
  Albums or Now Playing will feel like switching apps. v65 closes
  most of that gap.
- **Mini-bar progress strip at the very top edge** can be visually
  close to the bottom edge of any sheet/modal that's currently
  open above it. Not a functional issue but if it reads as
  cluttered we can move it to the bottom of the bar instead.

---

## v1.1.0.63 — 2026-05-03

JPLAY pass continues — Album Detail screen and the track list inside
it. v62 did the library Albums grid; v63 does what you see when you
tap into an album. Together v62+v63 are the bulk of "looking like
JPLAY" for the music-browsing path.

### Changed — Album Detail page (background, hero, type)

- **Pure black background.** The legacy `#0a0a10` charcoal-blue and
  the blurred album-art halo behind the hero (the `bgArt` blur and
  `bgDim` gradient that fade-washed the page in album colour) are
  gone. JPLAY pages are clean black canvases — atmospheric tinting
  reads as iTunes, not audiophile.
- **Hero cover** now 144×144 (was 130×130), 4 px corner radius (was
  10 px), no drop-shadow. Sits flat on the black ground, same way
  album tiles do in the library grid.
- **Hero title** 22/600 (was 18/700). "Section heading" weight, not
  "magazine masthead".
- **Artist line** 14/500 secondary-text (was 15/500 at 78% white).
- **Meta line consolidated.** Year, track count, total duration,
  and genre now share one quiet mono line separated by middle-dots,
  in `--jp-text-3`. The blueish "genre pill" that lived as a
  separate tappable component is retired (its style is set to
  `display: none` so any leftover code paths don't crash); genre
  is still tappable via an underlined link inside the meta line.

### Changed — Track list (the big one)

- **Removed always-visible Heart and Star buttons** added in v58.
  The 4-column grid (number / info / duration / actions) is now
  3-column. Tracks read as a clean list — number, title with format
  spec line, duration. That's it.
- **Fav and rating still reachable.** Long-press a track row (or
  right-click on desktop) opens a new `TrackOverflowSheet` — same
  bottom-sheet idiom as the album `⋯` sheet from v61. Sheet
  contents: Play track, Favourite this track, Rate (with inline
  5-star expander), Add to Tag (disabled, "v66"), Save for later
  (disabled, "v66"). Long-press delay is 500 ms; touch-cancel and
  touch-move both abort, so accidental drag-scrolls don't trigger.
- **State indicators inline in the spec row.** When a track is
  favourited, a tiny heart appears in the spec line. When rated,
  a small ★ chip in gold. Both hidden when off — keeps unrated/
  unfavourited rows visually pure.
- **Active row** background lifted to 4% white (was 6%). JPLAY's
  active highlights are restrained.
- **Number column** now uses `--jp-text` for the active row, white
  for the playing row, and `--jp-text-3` for everything else (was
  the legacy blue accent for active). Monochrome aesthetic.

### Migration / dead code

- The v58 `TrackRowActions` component is left defined in the file
  but no longer rendered — kept as inert code in case the always-
  visible widgets need to come back as a user-toggled option. Same
  for `s.trackActions`/`s.trackActionBtn`/`s.trackRatingNum` —
  removed (those styles definitively don't return).

### Risks / known limitations

- **Long-press is the only way to favourite/rate from the album
  page now.** If you don't know about the gesture, you can't reach
  those actions. The previous Heart/Star buttons made them
  obvious. Trade-off accepted in line with the JPLAY-clean brief;
  if discoverability proves to be a problem we can add a small
  "Long-press a track for actions" hint above the track list, or
  introduce a dedicated edit-mode toggle in the album `⋯` sheet.
- **Visual mismatch persists across the app.** AlbumGrid (v62) and
  AlbumDetail (v63) are now JPLAY. Now Playing, Settings, Sidebar,
  Search, Artist screen — still legacy. Switching between them
  will feel jarring until those migrate too.
- **The right-click context menu on desktop now opens the track
  sheet, not the browser context menu.** That matches mobile
  long-press but takes away "open image in new tab" etc. Probably
  fine; can add a modifier key escape if needed.

---

## v1.1.0.62 — 2026-05-03

JPLAY-style theme proof-of-concept. Smallest scope I could justify for
locking in the visual direction before committing to the full pass.
Two changes only: a new `--jp-*` CSS token set added alongside the
existing theme variables, and the main Albums grid rewritten against
those tokens. Every other screen is unchanged in this release.

This is deliberately a half-step. The Now Playing screen, the album
detail screen, the artists screen, the sidebar, the settings — all
still on the legacy charcoal-blue palette. v63 onwards will migrate
them one at a time. If you don't like how Albums looks, this is the
right release to say so before the rest follows the same pattern.

### Added — `--jp-*` design token set

Added to `:root` in `index.css` alongside the existing tokens:

- `--jp-bg` / `--jp-bg-elevated` / `--jp-bg-surface` — pure black
  through near-black for backgrounds, sheets, and modals
- `--jp-text` / `--jp-text-2` / `--jp-text-3` — three text contrast
  levels at 92% / 55% / 32% white
- `--jp-border` / `--jp-border-hot` — barely-there borders at 6% and
  16% white
- `--jp-accent` — a near-monochrome `#e6e6ea` for active state. JPLAY
  almost never uses chromatic accent colour on its surfaces.
- `--jp-hot` — `#ff3b5c`, reserved exclusively for the favourite heart
- `--jp-gap` / `--jp-pad` / `--jp-section-gap` — consistent 12 / 16 /
  24 spacing scale

The legacy `--bg-base` / `--text-primary` / `--accent` etc. are
unchanged. Components opt in to JPLAY by reading the `--jp-*` names.

### Changed — main Albums grid

The library Albums screen (`components/AlbumGrid.jsx` plus the
`.album-grid` CSS class) is now JPLAY-styled:

- Pure black page background (was charcoal `#16161a`)
- 2-column grid on phone (was 3-column), 3 / 4 / 5 column at the
  larger breakpoints (was 4 / 5 / 6). Each cover gets significantly
  more presence at typical viewing distances.
- 12 px gutter (was 8) for the breathing room JPLAY favours
- Album cards: removed card chrome entirely. No background fill, no
  border, no shadow. Just a 4 px-radius cover (square-ish, reads as
  "record sleeve" rather than "iOS app icon"), a 13 px medium-weight
  title, a 12 px regular-weight artist line. Year line dropped — it's
  auxiliary info that lives on the album detail screen now.
- Heading: 24 / 600 with -0.3 px tracking (was 22 / 700 / -0.4).
  Reads as a shelf label rather than a magazine masthead.
- Filter / sort chips: now a horizontally scrolling capsule strip
  along the top (was a flex-wrap centred row). No borders by default;
  a quiet 5%-white fill instead. Active state for sort chips is
  white-fill / black-text, not faint white-on-translucent. The
  favourites chip stays heart-red as its identity colour.
- Page padding bumped to 20 px / 16 px (was 14 px / 10 px). The
  120 px bottom kept the same so the now-playing strip overlap stays
  predictable.

### Risks / known limitations

- **Visual mismatch between Albums and the rest of the app.** This is
  expected during the migration. The Albums screen will look like a
  different product to the rest until v63+ catch up. If you're
  switching back and forth between Albums and Now Playing it'll feel
  jarring; that resolves once Now Playing migrates in v64.
- **The artist page's local album grid is unchanged.** That file
  (`ArtistAlbums.jsx`) defines its own internal grid component; v62
  doesn't touch it. v63 will.
- **Year info dropping from the cards** is a deliberate JPLAY-style
  choice. If the year is essential for your browsing flow we can
  bring it back as an opt-in toggle in a later release.
- **Page padding 20/16 may feel tight on iPad in landscape.** I
  tuned for phone first; if the iPad view feels cramped we can add a
  responsive padding bump above 900 px.

---

## v1.1.0.61 — 2026-05-03

Small UX-tightening release. Two changes: an album-header `⋯` overflow
sheet, and removal of the duplicate Report-a-bug button that snuck
through in v60.

### Added — album-page `⋯` overflow sheet

The album page now has a `⋯` button in the top-right of the screen,
mirroring the NowPlaying overflow pattern. Tapping opens a bottom
sheet with secondary album actions:

- Favourite / unfavourite this album
- Share album link
- Play next
- Shuffle play
- Add to Tag (disabled, "v62")
- Save for later (disabled, "v62")

The Heart and Share pill-buttons that previously lived in the hero
actions row have been **removed** and rolled into the sheet. The
hero-actions row now contains only the primary verbs (Play split-button,
Add Queue) — that row was getting crowded and the secondary actions
were competing for attention with Play.

The sheet uses the same visual idiom as NowPlaying's overflow:
translucent backdrop captures outside taps to close, the inner panel
slides up from the bottom, items are 44 px tall for comfortable thumb
taps, dividers separate the primary / queue / future-feature groups.

### Fixed — duplicate Report-a-bug button on Update screen

v60 ended up with two `<BugReportPanel />` calls in a row inside the
SettingsScreen Update section — a leftover from an earlier in-day v59
attempt that wasn't fully cleaned up when v60 was rebuilt. Removed
the second one.

### Roadmap label adjustment

The `Add to Tag` and `Save for later` items in the album overflow now
both label as "v62" (was previously v60/v61 in NowPlaying — kept those
where they were since they still match). Tags + Save for later is
intended as the v62 release.

---

## v1.1.0.60 — 2026-05-03

Originally cut as v59 but that build never installed (bad tar / version
collision with an abandoned v59 attempt earlier in the day). Rebuilt
clean as v60. Same fixes — six bugs from the v58 listening session, plus
a new swipe gesture and a stale-router cleanup.

### Fixed — DSP profile saves silently dropped headroom (since v53)

The `PUT /dsp/profile/:rendererId` route's `ALLOWED` field whitelist
still mirrored the v29.6 schema where headroom had been removed in
favour of the auto-preamp. When v53 brought the headroom slider back as
a manual control for FIR margin, the server route was never updated to
allow `headroom_enabled` and `headroom_db` through. The HeadroomSection
UI sent them; the route filtered them out before reaching `saveProfile`;
the unchanged profile came back to the client; the client's "Saved ✓"
toast lied; the `useEffect` syncing state from the response then reset
the checkbox to false and the slider to 0 dB. Six releases of headroom
did nothing on disk.

Confirmed by reading the route after a real failure on a Psychedelic
Furs track ("Come All Ye Faithful") with five FIR IRs uploaded and a
+2.1 dB predicted clip the user couldn't reduce despite enabling
headroom. Fix:

- Added `headroom_enabled` and `headroom_db` to the `ALLOWED` set in
  `PUT /api/dsp/profile/:rendererId`.
- Added the same fields to `PROFILE_FIELDS` and `payloadFromLive` in
  `dsp/profiles.js` so saved/named profiles preserve headroom across
  Save-as / Apply round-trips. Previously, applying a profile silently
  reset headroom to defaults too.

No migrations required — the columns have existed in the schema since
v29.x as "legacy" but were always being ignored.

**Backfill caveat:** Anyone who set headroom in v53–v58 had their
setting silently dropped. After upgrading you'll need to re-set the
headroom slider for each renderer. There's no way to recover the
original intent — the values were never written to disk.

### Fixed — orb keeps pulsing red after playback stops (WPP only)

The clip-warning orb pulse was driven purely by
`signalPath[0].clippingPredicted`, which is a static prediction
computed at profile save time. It stays set until the profile changes
again — so the orb pulsed red indefinitely after stopping playback,
implying live clipping with nothing playing.

Sonos was unaffected because Sonos has DSP bypassed and the predicted
flag is never set on it.

Fix: gate the pulse animation on `playerStatus === 'playing'`. The orb
colour itself stays red as a passive warning (tells the user "the
profile you've configured will clip"); only the attention-getting
pulse stops on pause/stop. The flag itself isn't cleared because that
would require server-side coordination and the prediction is still
correct — the next time you press play, it'll start pulsing again.

### Fixed — "bit-perfect with FIR convolution active" race

When a DSP profile changed during a paused or stopped state,
`reapplyDspToRenderer` early-returned from `restartCurrentTrack`
without rebuilding the signal path, leaving `signalPath[0].orbColor`
showing the *previous* state (e.g. green/bit-perfect) while
`clippingPredicted` was already updated to the *new* state (red).
Visually inconsistent: green orb pulsing red.

Added `playerState.refreshSignalPathForRenderer(rendererId)` which
rebuilds the path from the current track + new profile and broadcasts
via the existing `updateZone` path. Called *before*
`restartCurrentTrack` from the DSP-reapply hook, so the WebSocket
broadcasts a consistent signal path even when the renderer isn't
actively playing.

### Fixed — About chevron tap area was the entire bottom strip

The v57 chevron under the format-strip was styled with `width: 100%;
padding: 4px 0 8px` so any tap below the transport opened the About
panel. Reported in v58 testing.

Now a 44×44 button (≈10mm at iOS density, matches Apple's HIG minimum
tap target), absolutely-positioned at `bottom: 4px; left: 50%` of the
NowPlaying inner container so it sits cleanly above the bottom bar
without competing for tap area with the format strip. Also responds to
a swipe-up gesture originating on the chevron itself (≥30 px upward
delta) for users who'd rather drag than tap.

### Fixed — Swipe right→left on NowPlaying didn't open the queue

The About panel had its own swipe-left handler from v57, but the main
NowPlaying screen didn't — only the tab selector at the top could move
between Now Playing and Queue.

Added `onTouchStart`/`onTouchEnd` on the screen root with the same
gesture vocabulary as the About panel: horizontal swipe ≥ 60px and at
least 1.5× the vertical movement opens the queue (right→left) or
returns to NowPlaying (left→right). Disabled while any overlay is
open (volume popup, DSP, About, Renderer modal, overflow menu) so
they don't fight for the gesture.

The existing left→right swipe on NowPlaying that closes back to the
album browser is unrelated and lives in App-level routing — left
unchanged.

### Added — VL/FIR guidance in FIR Convolution help

When a track has no LUFS analysis yet, no volume-levelling attenuation
is applied — so a hot input runs straight into the FIR and can clip
even when the IR's measured peak is mild. There's no runtime warning
because no track-level LUFS data exists to detect against.

Added a paragraph to the FIR Convolution section's HelpTooltip
explaining the workaround: either run a Loudness scan from Settings,
or set headroom to −5 dB or lower until the scan completes.

This is a guidance fix only — no runtime detection. A later release
could add an inline banner when FIR is enabled and the currently
playing track's LUFS row is missing.

### Added — Bug report button on Update screen

A new "Report a bug" button at the bottom of the Update section opens
an inline text box. Typing a description and tapping Send POSTs to
`/api/bug-report`, which captures:

- The user's free-text description (max 4000 chars)
- Timestamp + musicd version
- Active renderer, current track, player status
- Basic system info (platform, arch, node version, uptime, mem, load)
- Last update log (the existing `getLastUpdateLog` source)
- Tail of `journalctl -u musicd -n 500 --no-pager` if available

The report is written to `<DATA_DIR>/bug-reports/<timestamp>-<id>.json`.
The success message includes the file path so the user can grab the
JSON and email it manually for now. SMTP wiring is deferred — when
configured the same payload will be POSTed straight through.

Three endpoints:

- `POST /api/bug-report` — write a new report, returns `{ ok, id, file, version }`
- `GET  /api/bug-report/list` — list saved reports with size/mtime
- `GET  /api/bug-report/file/:name` — download a specific report

The `/file/:name` endpoint validates the filename strictly
(`/^[\w\-:.]+\.json$/`) and refuses anything that resolves outside
`BUG_REPORT_DIR`, defending against path traversal.

### Cleanup — removed stale duplicate `bugreport` router

An earlier in-day attempt at v59 left a `server/src/routes/bugreport.js`
(lowercase) sitting next to the canonical `bugReport.js`. Both were
mounted (`/api/bugreport` and `/api/bug-report`) which would have
caused confusion. Deleted the lowercase file and removed its mount
from `index.js`. Only `/api/bug-report` is canonical.

### Roadmap labels in `⋯` overflow menu shifted

The placeholder pills next to disabled items in the NowPlaying overflow
menu have been bumped to reflect the v59-cancelled timeline:

- Add to Playlist: v59 → **v60** (this release does NOT ship Playlists;
  the label is still a "coming soon" — only this release's bug fixes
  ship in v60)
- Add to Tag: v60 → **v61**
- Save for later: v60 → **v61**
- Suggestions: v61+ → **v62+**

That said, "v60" sitting next to Add to Playlist while v60 is what's
installed is going to read as a bug. Worth bumping the label to v61 in
the next release once Playlists actually lands; for now it's the least
wrong of the available options.

### Migration notes

A new directory `<DATA_DIR>/bug-reports/` is created on first boot
via `paths.ensureDirs()`. Empty until the first report is filed; not
rotated automatically (volume should be tiny — one file per submitted
report).

### Risks accepted

- **`journalctl` not available in non-systemd deployments.** Returns
  null and the bug report still saves with the rest of the fields.
  No fallback to capture stdout-only logs from a `node` invocation —
  that needs a log-to-file pipeline we don't have.
- **Bug 5 fix is documentation-only.** The user has to read the help
  tooltip to learn about the −5 dB workaround. A runtime banner would
  be more discoverable.
- **The orb fix doesn't clear the static prediction flag.** Stop+play
  with a clipping profile will pulse red again. That's intentional —
  the prediction is still correct — but a user might expect "stop"
  to reset everything.
- **"Add to Playlist v60" pill is misleading on first install.** See
  roadmap-labels section above.

---


## v1.1.0.58 — 2026-05-03

Track-level favourites and ratings. Wires the v57 overflow menu's "Favourite this track" and "Rate" items, and adds heart + star controls to per-track rows in the album view.

### Database

Three new columns on `tracks`, added via the `safeAddColumn` migration pattern (no destructive ALTERs, idempotent):

- `is_favorite` — INTEGER 0/1
- `favorited_at` — INTEGER (unix epoch, nullable)
- `user_rating` — INTEGER 0–5 (0 = unrated)

Two new partial indexes for fast filtering: `idx_tracks_favorite` (is_favorite=1) and `idx_tracks_rating` (user_rating>0).

Track-level favourites are independent of album-level favourites — a single starred track from an album the user doesn't otherwise care about is the common case.

### Server

- `POST /library/tracks/:id/favorite` — body `{ value: boolean }` to set explicitly, omit `value` to toggle. Sets `favorited_at` on enable, NULL on disable.
- `POST /library/tracks/:id/rating` — body `{ rating: 0-5 }`. Server clamps to range and floors non-integers.
- `GET /library/tracks/:id` and the album-detail track query now both include `is_favorite` and `user_rating` (via `COALESCE` so old rows that don't have the columns yet read as 0).

### Client store

- `setTrackFavorite(trackId, value)` — POSTs the favourite, returns the server-confirmed value (or null on failure).
- `setTrackRating(trackId, rating)` — POSTs the rating, clamps locally before send, returns server-confirmed value.

### Album view

Each track row now has a Heart and a Star at the right edge.

- **Heart** — toggles track favourite. Filled red (`#ff3b5c`) when favourite, hollow otherwise.
- **Star** — single-tap cycle: `0 → 1 → 2 → 3 → 4 → 5 → 0`. The current rating shows as a small numeric badge next to the star. Filled gold (`#ffc62b`) when rated.

Both buttons stop propagation so tapping them doesn't also fire the row's play handler. Track row markup changed from `<button>` to `<div role="button">` with keyboard handlers so the inner buttons aren't HTML-invalid nested buttons.

Track row grid changed from `32px 1fr 52px` to `32px 1fr 52px auto` to make space for the actions cluster.

### NowPlaying overflow menu (`⋯`)

The v57 menu's track-context section is now functional:

- **Favourite this track** — toggles track favourite (was disabled `v58` placeholder)
- **Rate** — expands an inline 5-star rater row. Tap a star to set; tap the same star to clear; tap the X at the end to clear regardless. Closed state shows current rating ("Rated 3/5") or "Rate" if unrated.
- **Favourite this album** — moved to a secondary item below the track-level favourite, dimmed slightly so the primary action is the track-level one.

The remaining items (Add to Playlist v59, Add to Tag v60, Save for later v60, Suggestions v61+) stay disabled with their version labels.

### Bug fix

The v57 overflow-menu album-favourite call used `PUT /favorite` with a `{ favorite }` body. The actual server endpoint is `POST /favorite` with `{ value }`. Album favourite from the overflow menu was a no-op in v57; fixed to match the server contract.

### Risks accepted

- **Optimistic UI on rating.** When the user taps a star, the row updates immediately, then the server is called. If the server fails (e.g. network blip) the rating reverts. There's no toast — a silent revert may be confusing if it happens repeatedly. If feedback indicates this, future versions can show an error.
- **Rating cycle on the album row** is single-tap and goes 0→1→…→5→0. Setting a specific rating without cycling requires the NowPlaying `⋯` menu's expanded rater. We could add a long-press or right-click rater to the row in a later release.
- **Track ratings aren't yet exposed elsewhere.** The schema has the data, the API serves it, the album view edits it — but Search results, the queue, the About panel, and the artist albums view don't yet show ratings or filter by them. That's a separate UX pass.
- **No "favourites of tracks" sidebar yet.** Album favourites have a `/favorites` endpoint and a sidebar entry. Track favourites need an equivalent — `GET /library/tracks?favorites=1` or similar — to be browsable. Not in this release; deferring to v59 alongside Playlists where the navigation pattern lives.

---

## v1.1.0.57 — 2026-05-03

NowPlaying gets a track-context overflow menu and an About-the-Track panel.

### `⋯` overflow menu (top-right of NowPlaying)

Replaces the v56 spacer with a proper button. Tapping opens a bottom-sheet with track-context actions:

- **Album** → navigates to the album page (closes NowPlaying full-screen, lands on AlbumDetail)
- **Artist** → artist albums
- **Genre** → genre browser
- **Favourite this album** → toggles `albums.is_favorite` for the album the current track belongs in. Worded "Favourite this album" rather than "Favourite this track" because track-level favourites don't exist yet — they ship in v58. The menu wording will change at that point.

The remaining items render as disabled rows with a small version label (`v58`, `v59`, `v60`, `v61+`) so the menu shape is committed but doesn't pretend to work:

- Add to Playlist (v59)
- Add to Tag (v60)
- Save for later (v60)
- Rate (v58)
- Suggestions (v61+)

### About-the-Track panel

Tap the new chevron under the format strip on NowPlaying to open a full-screen scrollable About panel.

- **Artist bio** — fetched on mount via the existing `/library/artists/:name/bio` endpoint (which already caches Wikipedia / Last.fm bios under `artist_bio`). Collapsed to ~4 lines initially with a chevron to expand. Empty state if no bio is available.
- **About the Track** rows — Title, Album, Duration, Genre, Artist, Audio Format. Rows are only rendered if the field exists, so unmatched/missing data doesn't show as "—".
- **Composer / Label / Copyright / Album Release Date** — not yet shown because those columns don't exist in the tracks schema. The scanner doesn't extract them. The panel is wired so they'll appear automatically once the schema is extended (likely v58 alongside track favourites).
- **Track Credits / Suggestions** — sections from the design photos. Hidden entirely until backing data exists, rather than shown empty. Suggestions ships v61+ when there's a recommendations engine.

### NowPlaying chrome

- Format strip (`HI-RES · 24-bit 96.0kHz` style) now shows under the transport row, using the same `FormatBadge` used in album track listings (named export added to AlbumDetail). It only shows when there's a current track.
- Downward chevron beneath the format strip opens the About panel. The chevron is hidden when there's no active track.

### Gestures (About panel)

- **Swipe down** dismisses the About panel back to NowPlaying
- **Swipe left** dismisses the About panel and switches NowPlaying to the queue tab — same gesture vocabulary as the rest of the player. Threshold is 60px so casual scrolls don't trigger.

### Wiring

- `NowPlayingFullScreen` now accepts `onGenreClick` alongside the existing `onArtistClick` and `onAlbumClick`. `NowPlaying.jsx` and `App.jsx` pass it through to the existing `handleSetGenreFilter`.
- `AlbumDetail.jsx` exports `FormatBadge` and `shortCodec` as named exports so NowPlaying's format strip uses the same visual.

### Risks accepted

- **Album lookup for "go to album" is a name match.** The overflow menu's Album item resolves the current track's album by listing albums for the artist and matching the album title. In rare cases (multiple albums with identical titles by the same artist — hello compilations) the wrong album could be picked. Track → album_id linkage at the data layer would solve it cleanly; deferring to v58.
- **Bio field shape varies.** `bioFetch.js` returns either `{ bio }`, `{ content }` or `{ summary }` depending on the source. The About panel falls back through all three. If a future bio source returns a different field name the bio will show as empty until the fallback list is extended.
- **Disabled menu rows could be confusing.** Showing greyed items with future-version labels is a deliberate UX choice — the user sees what's coming. If feedback suggests these are noise, future releases can hide them.

---

## v1.1.0.56 — 2026-05-03

Bug-fix release for the v55 NowPlaying overlays plus an album-page action-row redesign.

### Fixed (v55 regressions)

- **DSP overlay didn't open.** Tapping the DSP icon in the volume popover did nothing because the overlay component used `require('./DspTab')` to lazily load DspTab. Vite (the client bundler) doesn't expose CommonJS `require()` in the browser bundle, so the call threw at runtime and the overlay never mounted. Switched to a top-level ES `import`. Same fix applied to the device-settings overlay (`require('./AudioSection')` → ES import).

- **Switch playback didn't switch playback.** The Switch icon in the volume popover opened the renderer picker, but tapping a different device only changed which zone the UI was *focused on* — playback stayed on the original device. The picker was using the legacy `focusZone()` path from #v1.1.0.9, which is correct for "look at another zone without disturbing it" but wrong for "I want my music to follow me". `RendererModal` now accepts a `mode` prop:
  - `mode="focus"` (default, unchanged) — UI focus only
  - `mode="move"` — calls `/player/queue/move` (existing, server-side `moveQueueToRenderer`) so the active queue + position transfers to the new device, then re-focuses the UI on it
  The Switch icon passes `mode="move"`. The picker title also reflects the mode ("Switch playback to…" vs "Output").

- **Audio device settings didn't open.** Same `require()` bug as DSP. Fixed alongside.

- **`appendToQueue` was silently colliding.** v55's bulk-add store actions added a new `appendToQueue(trackIds)` (taking IDs) that shadowed the existing `appendToQueue(tracks)` (taking full track objects). Album-page → Add Queue and any other path passing track objects had been broken since v55. Renamed the v55 ID-based version to `appendIdsToQueue`; bulk-add menu actions in QueueView updated to call it. Album-page Add Queue restored.

### Album page — action-row redesign

Replaced the row of `Play / [+ Queue] / Heart / Share` with a Play split-button + Add Queue + Heart + Share.

- **Play [▾] split-button.** Tap "Play" to start the album from track 1 as before. Tap the chevron to open a small dropdown:
  - Play Now (same as primary)
  - Play Next — inserts the album immediately after the currently-playing track
  - Add to Queue — same as the "Add Queue" pill next to it
  - Shuffle — Fisher-Yates the album, then play
- **Add Queue** is now a separate pill (was a "+ Queue" pill before). Functionally unchanged — appends the album to the end of the queue.
- **Heart and Share** unchanged.
- The standalone `+` and bookmark icons that lived between Add Queue and Heart in the wider mock-up are dropped (they weren't wired to anything in MusicD, just visual placeholders).

### Server

- New `playerState.insertNextInQueue(trackIds, rendererId)` — inserts at `queueIndex + 1` and clears the renderer's pre-queued gapless next-stream so the inserted track actually wins (without that, the user taps Play Next but the *old* next track keeps playing because it was already pre-rolled).
- New route `POST /player/queue/insert-next` — body `{ trackIds: [Int|String], rendererId? }`.

### Client store

- New `insertNextInQueue(tracks)` — optimistic local insert + server call, takes track objects (not IDs) for parity with the album-page surface.
- New `shufflePlay(tracks)` — Fisher-Yates shuffle then `playQueue(shuffled, 0)`. Doesn't touch the global shuffle toggle; this is a one-shot "play these in random order".
- `appendToQueue(tracks)` reinstated as the canonical track-objects version.
- `appendIdsToQueue(trackIds)` is the v55 ID-based version, now distinctly named.

### What's deferred to v57

- The `⋯` overflow menu on NowPlaying — Album / Artist / Genre links + Add to Favorites / Add to Playlist / etc.
- The "About this Track" panel: HI-RES badge moves under the Play button, downward chevron opens an artist-bio + track-credits + suggestions panel; swipe-left reveals queue.
- Track-level favourites and ratings (DB columns + per-track UI).
- Album-header `⋯` overflow menu (top-right of album page) — the photo's right-side icon cluster.

### Risks accepted

- **Move-queue across protocols may have edge cases.** Moving from Sonos to a UPnP DLNA renderer (or vice versa) goes through the existing `moveQueueToRenderer` path which has been stable since #v1.1.0.9, but it hasn't been heavily exercised from this entry point. Worth real-world testing.
- **Play Next inserts the *whole* album.** Tapping Play Next from the album page schedules every track of the album to play next, in order. That matches the photo's mock-up but might be more than you intend if the queue is long and you only wanted one track in. Single-track Play Next ships with the per-track ⋯ menu in v57+.
- **Shuffle is non-destructive of state.** It copies the track list, shuffles, and starts playback. The global shuffle toggle and repeat mode are unchanged. The shuffled queue is what the server sees from then on — there's no "unshuffle" — but that's standard behaviour for "shuffle play".

---

## v1.1.0.55 — 2026-05-02

Picks up the deferred items from v54: bulk queue actions and the per-device settings inline panel.

### Bulk queue actions

Two new icon buttons in the queue header next to the remaining-tracks count.

- **`(−)` Remove menu**: Remove all · Remove played · Remove upcoming · Remove selected
- **`(+)` Add menu**: Add all · Add played · Add now playing · Add selected

The first three actions in each menu run immediately. The `selected` actions enter selection mode (or apply if you're already in it). Add operations append to the end of the queue; remove operations preserve the currently-playing track even when "Remove all" is chosen.

### Selection mode

Two ways in:
- Tap-and-hold (500ms) on any queue row enters selection mode with that row pre-selected
- Pick "Add selected" or "Remove selected" from a header menu

While selecting:
- The header turns into `N selected · [Cancel] [Add/Remove]`
- The Apply button only appears if you arrived via a menu pick (so the action is unambiguous)
- Each row's cover-art slot becomes a checkbox; tap to toggle
- The currently-playing track can't be selected
- Cancel exits without applying

### Per-device settings overlay (real, not a stub)

Tapping the cog icon in the volume popover now mounts the actual per-device settings page from `Settings → Audio Devices` over NowPlaying, locked to the renderer that's currently playing. ALSA cards (USB DACs, etc.) get the full settings; network renderers (Sonos, DLNA) get a friendly notice explaining they're configured at the device itself.

### Server

- New `playerState.removeFromQueueBatch(indices, rendererId)`: drops a list of queue indices in a single pass, sorts descending so splices don't shift, silently skips the current-track index. Re-broadcasts state once at the end.
- New routes:
  - `POST /player/queue/remove-batch` — body `{ indices: [Int], rendererId? }`
  - `POST /player/queue/append` — body `{ trackIds: [Int|String], rendererId? }`. Wraps the existing `playerState.appendQueue`.

### Client

- New store actions: `removeFromQueueBatch(indices)` and `appendToQueue(trackIds)`. Both do optimistic local updates and call the new endpoints; server WebSocket broadcasts re-hydrate the queue with full track metadata.
- `AudioSection` now exports `DeviceSettingsPage` as a named export so the NowPlaying overlay can mount it directly.
- `BulkMenu` helper in `NowPlayingFullScreen.jsx` — small dropdown with click-outside dismiss, used by both header menus.

### Risks accepted

- **Optimistic append uses stub track objects.** When you tap "Add all", the new rows appear immediately with just track IDs — no titles or artwork — until the WebSocket broadcast comes back from the server (typically <100ms). On a slow LAN you might briefly see id-only rows at the bottom.
- **Tap-and-hold uses 500ms.** This is a balance between false-positive holds during normal scrolling and feeling responsive. We can tune up or down based on feedback.
- **The per-device overlay shares state with the live Audio Devices page.** If you have Settings open in another tab and change a setting in either place, both update on next reload. Same as before — just confirming the overlay isn't a separate copy of the data.

---

## v1.1.0.54 — 2026-05-02

NowPlaying redesign — section 1 of a multi-release UI tidy. Phone-first layout that also works on tablet, drawn from your Roon-inspired sketches.

### UI

- **Top tab bar replaced with icon pills.** Two centred buttons, `[♪ Now Playing] [≡ Queue]`, instead of the old underlined "NOW PLAYING" / "QUEUE" labels. Active pill gets the accent border; inactive pill is a quieter outline. Back arrow remains on the left; right side is empty for now (overflow `⋯` lands in v56 alongside the album-header redesign).
- **Signal-path orb has moved.** No longer in the top bar; now sits stacked above a new device-icon button at the bottom-right corner of the player. Same colour and clip-pulse behaviour as v53. Tap it to open the signal-path detail modal as before.
- **Device-icon button** (bottom-right) opens the new volume popover. Replaces the old "renderer name + volume number" chips, which both lived inline at the bottom and competed for attention.

- **Volume popover redesigned.** Slides up from the bottom edge, full width. New icon row above the slider:
  - **DSP** — opens the DSP overlay (see below); volume popover closes
  - **Switch** — opens the device-switch picker over NowPlaying
  - **Device** — opens the device-settings overlay over NowPlaying
  Volume slider only appears for variable-output devices; fixed-output devices show a "Fixed Output" label instead. Tap-outside dismisses the popover; tapping any of the three icons dismisses the popover and opens the corresponding overlay.

- **DSP overlay** (`DspOverlay`). New full-screen modal that renders the existing DspTab pinned to the currently playing renderer. The renderer dropdown is hidden because the overlay is contextual to "what's playing right now". Tap the X (top-left) to close back to NowPlaying.

- **Device-settings overlay** (`DeviceSettingsOverlay`). Stub overlay that lays out the same chrome as the DSP overlay but with a placeholder body. The full per-device settings inline panel ships in v1.1.0.55 — the navigation affordance is in place so the icon row is wired correctly today.

- **Queue redesigned for v54:**
  - Each row is informational: cover art (36×36), track title, artist · album, duration. Per-row action icons (`+`, `♡`, `☆`, `⋮`, drag handle, edit-mode chevrons, delete) all removed. Tap a row to play that track; queue stays open.
  - **Active track title is now the accent blue** (was `#fff`).
  - **"Now Playing" divider** sits *above* the active row instead of being a row-level highlight. Two thin accent-coloured rules with "NOW PLAYING" letterspaced text between them.
  - **"Radio after queue ends" toggle** moved out of the chip toolbar into a dedicated labelled row at the top of the queue. Standard switch UI; persists immediately.
  - **Queue header** shows remaining tracks + remaining time: `"5 tracks remaining · 22m 14s left"`. Counts everything *after* the now-playing row, plus the durations of those tracks.

### What's deferred to v55 / later

- **Bulk queue actions** (Add all / Add played / Add now playing / Add selected; Remove all / Remove played / Remove upcoming / Remove selected) with selection mode — designed but not built. Header `(+)` and `(−)` icons land in v55.
- **Per-device settings inline panel** — the overlay shell is in place but the body is a stub.
- **Album-header redesign** (the `Diavola` photo edits — removing `+` and bookmark from the action row, etc) — that's a separate screen and lands in v56.
- **Mini-player bottom-bar redesign** — also v56.
- **Phone vs tablet polish** — current layout works on both, but tighter responsive tuning lands in a later release after feedback.

### Internal

- New `DspTab` prop: `forceRendererId`. When set, locks the editor to that renderer and hides the picker dropdown. Used by the NowPlaying DSP overlay; the Settings → DSP entry-point still passes nothing and behaves unchanged.
- New shared style entries on the NowPlaying styles object: `tabPill`, `tabPillBtn`, `bottomRightStack`, `orbBtnSmall`, `deviceIconBtn`, `volIconRow`, `volIconBtn`, `volFixedLabel`, `modalOverlay`, `dspOverlay*`, `queueRow2`, `npDivider*`, etc. Old styles (`tabBtn`, `tabLabel`, `tabUnderline`, `bottomBtn`, `queueChip`, `queueZoneChip`, `queueRow`, `queueNum`, `queueEditCtrls`, etc) remain in the styles dict but are no longer referenced; left in place for now to avoid churn during this redesign.

---

## v1.1.0.53 — 2026-05-02

Headroom + clipping prediction for FIR convolution. Resurrects the headroom controls that were stripped in #29.6, but constrained to the FIR stage where they actually matter — PEQ keeps its existing auto-preamp.

### Added

- **Headroom slider in DSP settings.** New section between Parametric EQ and FIR Convolution. Toggle (off by default) plus a slider from −12 dB to 0 dB, default −3 dB. When enabled and FIR convolution is active, the chain is attenuated by the slider amount before the IR is applied. The PEQ is unaffected — the auto-preamp continues to handle PEQ peaks on its own.

  Chain is now:
  ```
  source → ReplayGain → PEQ-with-auto-preamp → headroom → FIR → crossfeed → output
  ```

- **Per-IR peak gain shown in the FIR list.** Each rate row shows "peak +5.7 dB" (or whatever) next to the existing format/size info, derived from a one-pass scan of the IR's samples done at upload time. Highlighted amber when the IR alone would push the chain over 0 dBFS.

- **Static clipping prediction.** Whenever the DSP profile is saved or an IR is uploaded, the server computes `headroom + worst-IR-peakDb` and stores a `clipping_indicator` flag. When set, the Headroom section shows a "Chain may clip" warning with the predicted overshoot, and the signal-path orb in the player pulses red.

  Cheap and deterministic — no live audio monitoring, no FFT analysis at stream time. The math: PEQ output is by design ≈ 0 dBFS peak (auto-preamp guarantees that). Headroom shaves it negative. FIR can boost by up to its peak gain. Sum > 0 means clipping.

- **One-time peak metadata backfill.** On first boot under v53, any IR that was uploaded before the per-IR peak sidecar existed gets its peak computed and stored. Runs in the background after `listen()`, idempotent, doesn't block startup. Failures on individual files are logged and skipped.

### Changed

- **`getProfile` and `saveProfile`** now include `headroom_enabled`, `headroom_db`, and `clipping_indicator`. The columns have always been in the SQLite schema (left as ghosts after #29.6); no migration is needed. The dormant fields are simply being read again.

- **`compileChain` returns `headroomDb`** alongside `filters` and `summary`. The stream route reads it and inserts a `volume={N}dB:precision=double` filter into `preFilters` between the PEQ output and the FIR convolution input. Same `precision=double` flag used by the auto-preamp so the headroom doesn't lose detail at low values.

- **`buildSignalPath` reads the renderer's DSP profile** to set `orbColor` and `clippingPredicted` on the source node. Sonos is excluded — DSP is bypassed there, so the indicator would be meaningless. The orb in `NowPlayingFullScreen` shows red and pulses (1 Hz scale + brightness wobble) when clipping is predicted.

### UI

- New `HeadroomSection` component with the same `?` tooltip pattern introduced in v52. Tooltip explains the relationship to PEQ's auto-preamp and the default −3 dB recommendation.
- New `peakBadge` style in `FirSection` (tertiary text colour for normal IRs; amber + bold for hot IRs).
- New `@keyframes orbClipPulse` in `index.css`.

### Internal

New exports from `server/src/dsp/fir.js`:
- `computeIrPeakDb(buffer)` — returns peak gain in dBFS, supports 16/24/32-bit PCM and 32/64-bit IEEE float
- `backfillPeakMeta()` — scans every renderer's IR dir, computes peaks for any wav lacking a sidecar
- `metaPath(rendererId, sampleRate)` — sibling-of-wav JSON sidecar location
- `readMeta(rendererId, sampleRate)` — null-safe sidecar reader

### Risks accepted

- **The peak prediction is conservative.** It assumes worst case across IRs — if the user has IRs at 44.1 / 48 / 96, the warning fires when the loudest of the three would clip with current headroom, even though playback at one rate uses only one IR. This is intentional; we'd rather warn aggressively than miss a clip.
- **Sonos is silently exempt.** Headroom + clipping indicator are no-ops there (DSP is bypassed). The slider in the UI still works; it just won't affect anything, since none of the chain runs for Sonos.
- **Clipping indicator updates only on profile save or IR upload.** If the user changes the volume on the renderer (via Sonos / Squeezelite app, etc.) the prediction doesn't recompute. The math is independent of playback gain, so this is OK.

---

## v1.1.0.52 — 2026-05-02

UI tidy. Help text throughout the app moved out of inline paragraphs and into `?` icon tooltips next to section titles, freeing vertical space and making screens scannable. Settings layout tightened.

### UI

- **New `HelpTooltip` component.** Standard `?` icon (lucide `HelpCircle`, 14px, tertiary colour) sits next to section titles and labels. Tap to open a 280px popover with the help text; tap outside or press Escape to close. Popover auto-shifts left if it would otherwise overflow the right edge of the viewport on a narrow phone screen. Used wherever help text lived inline.

- **Inline help paragraphs converted to tooltips:**
  - `FirSection` × 2 (the FIR upload intro, and the dry/wet A-B comparison hint)
  - `PeqEditor` × 1 (the biquad/auto-preamp explanation)
  - `AutoEqTab` × 2 (AutoEQ preset loader description, Crossfeed description)
  - `SettingsScreen` × 18 (album-mode/track-mode gain explanation, MusicBrainz contact requirement, album matcher description, throttling note, cover art note, artist logos sources, bios source order, volume-levelling scan note, built-in services note, Last.fm signup link, Last.fm password handling note, Last.fm deprecation caveat, scrobbling profile link, auto-update polling note, scheduler off-by-default note, automatic-mode behaviour note, scheduled-mode behaviour note)

  All 23 conversions preserve the original copy verbatim; only the presentation changed. The text is still discoverable, just hidden by default.

- **Settings layout tightened.** Page padding 14→10 on top, brand header bottom margin 24→14, section dividers 20px/14px → 14px/10px, section-to-section gap 10→8. Recovers roughly half a screenful of vertical space at the top of the Settings page.

### Not changed

- All v49/v50/v51 FIR fixes are carried forward unchanged: iOS Safari picker reliability, MP4/AAC detection, `listIrs` reading enough of the file to find the data chunk past metadata.
- No backend changes. Server, database schema, API endpoints, DSP chain — all identical to v51.
- The text inside each tooltip is the same as before, so any downstream document or bookmark referencing the help copy still applies.

### Coming in v53

Headroom slider for FIR convolution (post-PEQ, pre-FIR), with static clipping prediction that flashes the signal-path orb red when the chain would clip. Sequenced as a separate release so feedback on v52 lands first.

---

## v1.1.0.51 — 2026-05-02

Single-purpose follow-up to v1.1.0.50. Fixes the IR list endpoint so uploaded HouseCurve / REW / broadcast-WAV impulse responses display correctly in the UI.

### Fixed

- **Uploaded IRs now appear in the FIR section UI for HouseCurve/REW/broadcast WAVs.** When `listIrs` reported on stored IRs, it was reading only the first 1 KB of each file to extract the WAV header — fast, but too small to walk past WAV files with `bext`, `JUNK`, or `LIST` metadata chunks between the `fmt` chunk and the `data` chunk. Files from HouseCurve, REW, and most broadcast/measurement tools embed several KB of metadata that pushed the data-chunk header past 1 KB. The header parser then gave up with `"No data chunk found"`, the API returned `ok: false`, and the UI showed "No IR uploaded" — even though the file was on disk and would actually have been used at convolution time, since the runtime code reads the full file.

  `listIrs` now reads up to 64 KB per file, comfortably past any sane metadata payload. Files that genuinely have no `data` chunk still fail loudly (correctly).

### Not changed

This is a one-line semantic fix in a single function. No client changes, no API changes, no behavioural changes anywhere else. The IRs already on disk for any renderer will start displaying correctly after upgrade.

---

## v1.1.0.50 — 2026-05-02

Single-purpose follow-up to v1.1.0.49. The FIR upload path now diagnoses "wrong file format" cases specifically — including the MP4/AAC-in-.wav-clothing case that was tripping testers — and gives a tailored, actionable error message per format.

### Fixed

- **MP4/AAC files masquerading as `.wav` are now diagnosed clearly.** Previously the upload error read `"Got '????' (hex 00000014); expected 'RIFF'"` — accurate but unhelpful unless you read MP4 box headers in hex for fun. The error now identifies the actual format (MP4/QuickTime/AAC, FLAC, OGG, AIFF, MP3, raw AAC) and explains what to do per format. For MP4/AAC specifically, the message warns that AAC compression destroys IR precision and the user should re-export from their measurement tool rather than trying to convert.

  This case bites a lot harder than expected on iOS — Voice Memos, screen recording, and several iOS audio apps default to AAC even when they expose a `.wav` save option.

- **Lossless container types (FLAC, AIFF, MP4/ALAC) get conversion guidance.** When the file is genuinely lossless but in the wrong container, the error includes the exact `ffmpeg` command to convert to PCM WAV without losing precision.

### Internal

- New helper `explainWrongFormat(buffer, magic)` in `server/src/dsp/fir.js`. Detects MP4 (via `ftyp` at offset 4), FLAC (`fLaC`), Ogg (`OggS`), AIFF (`FORM`+`AIFF`/`AIFC`), MP3 (`ID3` prefix or MPEG sync), and raw AAC (ADTS sync). Inside an MP4 container it does a cheap scan for `mp4a` or `alac` four-cc strings to identify the audio codec. Falls through to the v49 generic error for anything unrecognised.

### Not changed

The actual WAV parser (RIFF/RF64/BW64 magic check, fmt and data chunk walking, PCM-only validation) is identical to v49. This release only improves the error message when the parser refuses a file. The iOS Safari client-side picker fixes from v49 are still in place.

---

## v1.1.0.49 — 2026-05-02

Single-purpose fix release: FIR convolution upload from iOS Safari.

### Fixed

- **FIR IR upload is reliable from iOS Safari.** Tapping Upload, picking a `.wav`, and returning to musicd previously did nothing — no upload request was ever sent. Cause: the file input's `accept=".wav,audio/wav,audio/x-wav"` filter is unreliable on iOS Safari; the picker often returns without firing the `change` event, so the upload code never runs. Two changes:

  - **Client** (`client/src/components/FirSection.jsx`): broadened the accept filter to `audio/*,.wav` (iOS picks the first matching filter, and broad `audio/*` is more reliable than specific MIME types). The input value is now reset after each pick so re-selecting the same file fires `change` again. Added a magic-byte check that runs after the file arrives — if the bytes don't start with `RIFF`/`RF64`/`BW64`, the user gets a clear error showing the actual filename and first 4 bytes, with a hint that on iOS the Files app is more reliable than Photos.

  - **Server** (`server/src/dsp/fir.js`): `parseWavHeader` now accepts `RF64` and `BW64` magic in addition to `RIFF`. These are broadcast WAV variants (EBU RF64, Wave64) that exporters like REW post-2022 and several pro tools produce by default. The chunk-walking parser is identical for all three; only the magic check needed to widen. Error messages now show the actual first 4 bytes (hex + ASCII) when the magic doesn't match, so a future failure is diagnosable from the error alone.

### Not changed

Everything else is identical to v1.1.0.48. Backend behaviour, UI, install paths, orchestrator, native install — all the same.

### Install

In-app update from v1.1.0.48 (Docker) or via the local update script. Database, settings, and library are preserved across the upgrade.

---

## v1.1.0.48 — 2026-05-02

Native (non-Docker) install support, alongside the existing Docker-based deployment. Both work — Docker installs are unaffected and continue to update via the existing alpine-sidecar flow. New installs can now use systemd directly.

### Added

- **Native systemd install method.** New `install-native.sh` apt-installs Node 20, ffmpeg, loudgain, libchromaprint-tools, and sqlite3, creates a `musicd` system user, lays out `/opt/musicd/{server,client}` and `/var/lib/musicd/{data,downloads,backups,updates}`, builds the client, writes a hardened systemd unit (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadOnlyPaths` for the music directory), and a scoped sudoers entry that lets the musicd user run `systemctl restart musicd` without a password. The whole install is ~30s on a modest box, vs ~3 min for Docker.

- **Orchestrator abstraction** (`server/src/orchestrator.js`). Detects whether musicd is running under Docker (`/.dockerenv` present) or systemd (`INVOCATION_ID`/`JOURNAL_STREAM`) or neither, and exposes `selfRestart()` that does the right thing for the detected environment. Replaces direct `docker restart` and `systemctl` calls scattered through `backup.js`, `updater.js`, and `index.js`.

- **Native in-app update path.** `runUpdate()` in `updater.js` now dispatches by orchestrator mode. Docker mode keeps the existing alpine-sidecar build-and-restart flow. Native mode extracts the tar to `/opt/musicd/.staging/v{ver}/`, runs `npm ci --omit=dev` only if `package.json` changed (otherwise reuses node_modules via hard-link), builds the client only if `dist/` isn't shipped pre-built, atomically swaps the new install into place via `rename(2)`, archives the previous install at `/opt/musicd/.previous/`, and asks systemd to restart. Typical update is ~5s for code-only changes, ~30s with new server deps.

### Changed

- `DOWNLOADS_DIR` and `PENDING_DIR` in `updater.js` and `remoteUpdater.js` now resolve based on orchestrator mode (Docker: `/mnt/downloads` and `/mnt/musicd_updates/pending`; native: `/var/lib/musicd/downloads` and `/var/lib/musicd/updates/pending`). User-visible paths on the host stay the same.

- `getLastUpdateLog()` now checks both possible log file locations so the UI's "view last update log" button works regardless of mode.

- Auto-update preflight at boot (`index.js`) now reports orchestrator status: `mode=`, `canSelfRestart=`, `canApplyUpdate=`. Docker preflight (alpine image pre-pull) only runs in Docker mode.

### Notes

- Existing Docker installs are unchanged. No migration required to keep using Docker.
- The native installer detects an existing Docker container and offers to migrate (stops the container, leaves the database in place, lays out native install on top). The Docker images stay around — `docker rmi musicd:latest musicd:rollback*` to clean up afterwards.
- This is a structural change. Test thoroughly before posting out to other testers.

---

## v1.1.0.47 — 2026-05-02

Comprehensive cleanup pass driven by the v46 audit. Multiple fixes shipped together — if behaviour regresses anywhere, this is the version to roll back from.

### Fixed

- **Sonos DIDL-Lite metadata is now honest about format and complete.** Previously hardcoded `audio/flac` regardless of the actual stream Content-Type. For non-FLAC pass-through (MP3, WAV) this lied to Sonos about what it would receive; some firmware notices and refuses. Now uses a shared predictor that mirrors the stream pipeline's pass-through-vs-re-encode decision. Also adds `<dc:creator>` (artist) and `<upnp:album>` so Sonos's display shows track + artist + album instead of just track.

- **DLNA DIDL-Lite mime claim is now honest about format.** Previously claimed the source mime (`audio/mpeg` for MP3, etc.) but the re-encode pipeline always emits FLAC. Some DLNA renderers reject when DIDL claim and response Content-Type disagree. Now uses the same predictor as Sonos.

- **Range request handling on the stream endpoint.** Pass-through path advertised `Accept-Ranges: bytes` but ignored the Range header — a renderer asking for byte N got bytes 0..end. Now serves real partial content with a 206 status and proper `Content-Range`. Re-encode path returns 416 for non-zero Range starts so renderers fall back to a fresh GET; `bytes=0-` falls through to a normal full-stream response.

- **`inferLanHost` no longer silently falls back to 127.0.0.1** when network inference fails. The fallback told the renderer to fetch from its own loopback, which always failed silently with no log line. Now throws a clear error and stops playback.

- **DSP cache-buster missing on gapless pre-queue URL.** Changing a DSP profile mid-playback didn't take effect on the next track because its URL was already pre-loaded onto the renderer with the old version param. Now matches the main play path's `&v={dspVersion}`.

- **In-app updater preserves all container config from the running container.** Previously `LAUNCH_ARGS` hardcoded `/var/lib/musicd/data:/data` and a fixed env var set; if your install used a different data path or had custom env vars, the in-app update would create a new container with the defaults and your data would appear to vanish. Now the updater reads existing -v mounts, -e env vars, --network mode, --restart policy, --device entries and --group-add entries via `docker inspect` and replays them. The hardcoded list shrinks to just `--name musicd` and the docker.sock mount.

### Added

- **Squeezelite renderer declares `maxSampleRate: 192000`.** Previously had no cap, so hi-res content went to it at native source rate even if the downstream DAC couldn't handle it. 192k is a safe ceiling for typical USB DACs.

### Internal

- New module `server/src/streamFormat.js` with `predictStreamFormat(track, rendererId, sourceRate) -> { mime, willPassThrough }`. Single source of truth for what the stream endpoint will serve, used by both renderer DIDL builders. Decision tree mirrors `routes/stream.js` exactly.

- DLNA's old `getMimeType()` is kept as a legacy helper for callers without renderer context, but everything in the play path now goes through the predictor.

---

## v1.1.0.46 — 2026-05-02

### Changed
- **Sonos pause/resume reframed as Stop-with-bookmark.** After several rounds of trying to make UPnP `PAUSED_PLAYBACK`-style resume reliable on current Sonos firmware (v1.1.0.40-45 attempts), the approach is changed to: the pause button on a Sonos zone now sends Stop and saves the position; the play button on a "paused" Sonos zone does a fresh play of the same track and seeks to the saved position. This is identical to the skip-forward path, which is rock-solid on this hardware.

  Trade-off: a perceptible 1-2s gap on resume because the URI re-loads. In exchange the firmware-dependent pause-resume flicker is gone.

  Other renderers (DLNA, Squeezelite, ALSA) keep real pause/resume — their behaviour is unchanged.

### Removed
- v1.1.0.45's STOPPED debounce in the polling loop. No longer needed: the polling loop now ignores STOPPED entirely while `zone.status === 'paused'` (because we put the renderer there on purpose), and natural track-end advancement is back to firing on the first STOPPED tick.

---

## v1.1.0.45 — 2026-05-02

### Fixed
- **Sonos pause→resume regression.** Source-level diff against v1.1.0.8, v1.1.0.13, v1.1.0.14, v1.1.0.15, and v1.1.0.20 (which all worked) revealed the resume code path was byte-for-byte identical to v1.1.0.44 (which doesn't). The behavioural difference is on the speaker side — newer Sonos firmware briefly reports STOPPED for a single tick after a Play SOAP issued from PAUSED_PLAYBACK. The polling loop interpreted that single STOPPED tick as "track ended" and called advanceTrack, skipping to the next track in the queue.

  Fix: the resume code path is reverted to the v1.1.0.13 three-line form (Sonos handles bare Play correctly), and the polling loop now requires **two consecutive STOPPED ticks** (~2 seconds) before treating it as a real track-end. A real track end stays STOPPED; a transient resume-flicker recovers to PLAYING within one tick.

  My v1.1.0.40-44 attempts at fixing this were all wrong — I was treating it as a fundamental Sonos UPnP issue and rewrote the resume path several times. Comparing real source against the working baselines made the actual cause obvious.

### Cleanup
- Removed `[SONOS-DEBUG]` log lines from v1.1.0.42.
- Reverted v1.1.0.41's clearNext-on-pause and gaplessQueued reset (never addressed real cause).
- Reverted v1.1.0.43's playTrackOnZone-based resume (added complexity that wasn't needed).
- Reverted v1.1.0.44's Stop+clearNext+playTrackOnZone+Seek resume sequence (same).
- Kept the v1.1.0.40 `sonos.resume()` and v1.1.0.43 `sonos.seek()` functions in case they're useful later, but neither is currently called by the resume path.

---

## v1.1.0.44 — 2026-05-02

### Fixed
- Sonos pause→resume skip-to-next bug, properly this time. v1.1.0.43's playTrackOnZone-only approach still saw the speaker report STOPPED after the resume SOAP, which the polling loop interpreted as track-ended. The reliable pattern (mirroring what skip-forward does) is: stop polling, send Stop, send clearNext, send SetAVTransportURI + Play (via playTrackOnZone), then Seek to the saved position. Going through Stop first forces Sonos's transport into NO_MEDIA_PRESENT before the new URI is loaded, which avoids the bad-state condition that caused STOPPED on resume.

### Diagnostic
- `[SONOS-DEBUG]` log lines kept for one more release. After v1.1.0.45 confirms the fix, they'll be removed.

---

## v1.1.0.43 — 2026-05-02

### Fixed
- **Sonos pause→resume skip-to-next bug.** Diagnosed via the v1.1.0.42 trace logs: after a pause (especially a long one), the bare UPnP Play action causes Sonos's transport to report STOPPED rather than resume — which the polling loop interpreted as "track ended" and triggered advance to the next track. Sonos appears to drop the CurrentURI after pause under some conditions; a bare Play with no URI loaded transitions to STOPPED.

  Fix: resume now re-loads the current track's URI via SetAVTransportURI then issues a UPnP Seek to the saved position. This is the same path that manual skip uses, which the user confirmed reliably works. Cost is a brief "loading" state on resume rather than instant continuation, but the resume now lands on the same track at the same position.

  Also dropped the v1.1.0.41 clearNext-on-pause defensive call — it never addressed the real cause and added an unnecessary SOAP round-trip on every pause.

- New UPnP Seek implementation for Sonos. Exposed via `renderers.seek(id, seconds)` in case other code paths need to seek in future (scrubbing, resume, etc).

### Diagnostic
- `[SONOS-DEBUG]` log lines kept in for one more release in case any new symptoms appear after this fix is deployed. To capture if needed: `sudo docker logs musicd 2>&1 | grep SONOS-DEBUG | tail -40`. Will be removed in v1.1.0.44 once this fix is confirmed stable.

---

## v1.1.0.42 — 2026-05-02

### Diagnostic
- v1.1.0.41's gapless-pre-queue theory didn't hold up — pause→resume still skips even at 40 seconds into a long track, where pre-queue can't have been triggered. This release adds temporary `[SONOS-DEBUG]` logging to the pause path, the resume path, and every polling tick so we can see exactly what Sonos reports between Pause and Play. To capture: reproduce the bug, then run `sudo docker logs musicd 2>&1 | grep SONOS-DEBUG | tail -40` and share the output. Logging will be removed once the bug is fully understood and fixed.

---

## v1.1.0.41 — 2026-05-02

### Fixed
- Sonos pause/resume edge case. After v1.1.0.40 fixed the no-audio-on-resume bug, a second symptom appeared: pausing late in a track and then tapping play would skip to the next track instead of resuming. Cause: the gapless pre-queue mechanism loads the next track's URI onto the speaker about 8 seconds before the current track ends. Sonos firmware sometimes interprets a Play action after Pause — when a NextURI is already loaded and the playhead is near track end — as a transition rather than a resume. Fixed by clearing the pre-queued NextURI on pause; the next polling tick re-arms the gapless pre-queue cleanly once playback continues.

---

## v1.1.0.40 — 2026-05-02

### Fixed
- Sonos resume bug. After pausing playback, tapping play would briefly flicker the pause icon then revert to play with no audio. Skipping forward or backward worked because that started fresh playback. Root cause: the Sonos renderer module didn't implement a `resume` method, so the dispatcher fell back to a "last-ditch" path that called `play(id)` with no stream URL — which caused the speaker to be sent `SetAVTransportURI` with `undefined`, wiping the loaded URI before the bare Play action ran. Sonos now implements a proper `resume` that issues a UPnP Play action without re-loading the URI.

---

## v1.1.0.39 — 2026-05-02

### UI
- Library counter tiles on the Home screen (Artists / Albums / Tracks / Genres) are now shorter in height. Vertical padding tightened (14 → 8), inner gap (4 → 2), icon size (18 → 16), and tile-value font (18 → 17). Width is unchanged. The four tiles now read as squat rectangles rather than tall squares.

---

## v1.1.0.38 — 2026-05-02

### UI
- Album page MBID pill shrunk slightly so the About pill no longer slips off the right edge of the screen on narrower phones. Padding tightened (5/12 → 4/10), font 11 → 10, gap 6 → 4, inner icon buttons 20 → 18.
- Genre and Search screens now use the same responsive album grid as the main Albums and per-artist screens. All four surfaces now show 3 columns at phone widths, 4 at tablets (≥600px), 5 at small desktops (≥900px), 6 at large desktops (≥1400px). Card sizing and gutters were already identical; this just makes the responsive behaviour consistent.

---

## v1.1.0.37 — 2026-05-02

### New
- Toast confirmations on the album page. Tapping Play shows "Album now playing"; tapping Queue shows "Album added to end of queue". White pill with dark text, centred horizontally above the mini now-playing bar with breathing room from it. Auto-dismiss after 3 seconds.

---

## v1.1.0.36 — 2026-05-02

### UI
- Albums screen: the active sort pill (Title / Artist / Year) now uses a white-on-translucent-white styling that matches the Play button, instead of the red that was inherited from the favourites heart styling. The favourites pill keeps its red active state since red is its identity.

---

## v1.1.0.35 — 2026-05-02

### UI
- Album page action row and MBID/About row reverted to the v1.1.0.33 layout (rows live inside the info column to the right of the album artwork). The v1.1.0.34 full-width version was rejected.
- Album artwork now centres vertically within the hero block, so it sits comfortably in the middle of its column rather than pinning to the top with a large empty gap below.

---

## v1.1.0.34 — 2026-05-02

### UI
- Album page action row (Play / Queue / Heart / Share) and the MBID + About row now span the full screen width below the hero block, instead of being constrained to the narrow column to the right of the album artwork. The buttons distribute edge-to-edge with equal padding to each side of the screen.

---

## v1.1.0.33 — 2026-05-02

### UI
- Album page action row now distributes Play / Queue / Heart / Share edge-to-edge with equal gaps, instead of centring with a fixed gap (which on iPhone widths was wrapping the Share button to a second row). Play and Queue padding tightened slightly so all four buttons fit comfortably on one line.
- MBID and About pills now distribute edge-to-edge in the same way, matching the action row's rhythm.
- Unmatched-album "Not matched yet" placeholder now centres on its own row (it's a single chip with no sibling, so the edge-to-edge logic doesn't apply).

---

## v1.1.0.32 — 2026-05-02

### UI
- Album page action row restructured. Play, Queue, Heart, and Share are now inline on a single centred row instead of having Heart and Share float in a separate vertical column on the far right. This makes the row centre cleanly on both iOS and Android, and lets the MBID + About pills below it centre relative to the actual centre of the layout instead of an asymmetric centre.
- Heart and Share buttons are now the same height as Play and Queue (34px), so they sit as visual peers rather than smaller siblings squeezed into a corner.

---

## v1.1.0.31 — 2026-05-02

### UI
- Album page: MusicBrainz ID chip and About pill are now centred horizontally as a pair below the action buttons, rather than left-aligned. The MBID chip has been reshaped to match the About pill (same border-radius, padding, and visual weight) so the two read as a balanced pair instead of a chip + pill mismatch.
- Albums screen: the row of Title / Artist / Year / Random / Favourites pills is now centred horizontally rather than left-aligned.
- Favourites screen: the Play All / Queue All / Random pills are now centred horizontally.

---

## v1.1.0.30 — 2026-05-02

### UI
- Theme tweaked: backgrounds nudged a step lighter (less black, more charcoal) and text contrast improved across the board so labels and metadata read more easily. Accent blue brightened slightly. Stays a dark theme — this is a tuning, not a redesign.
- Album page redesigned. Album art now anchors at the top of its column rather than aligning to the bottom of the info block, with breathing room from the topbar. The MusicBrainz ID chip and the About bio button now sit side-by-side in a balanced row below the action buttons. The favourites heart and share button are now the same width.
- Album page: genre is now a tappable blue-tinted pill instead of plain text. Tapping it jumps to the genre filter view with that genre pre-selected.
- Album page: unmatched albums show a discreet "Not matched yet" placeholder where the MBID/About pills would sit, so the layout reads consistently between matched and unmatched albums.
- Albums grid header redesigned. The Title / Artist / Year sort buttons, Random, and Favourites are all in one row of equal-sized pills now. The Favourites pill shows just the heart icon (the label has been removed).
- Recent Activity panel on the Home screen reduced to roughly half its previous height. Album thumbnails scale down proportionally; year/title/format under each tile keeps the same aspect ratio relative to the artwork.
- Update screen: removed the developer-workflow note about dropping tars into `/mnt/dietpi_userdata/downloads`. The note is still in the changelog where it belongs as reference rather than mid-flow UI clutter.

---

## v1.1.0.29 — 2026-05-02

### Fixed
- CPU temperature reading on the metadata scheduler status was always null. The reader function worked correctly but the cached value in the scheduler state was only updated by the 30-second tick loop, so the UI's 5-second polls always saw a stale null. Status calls now read fresh from sysfs each time.

### UI
- Off / Automatic / Scheduled controls on the Metadata scanning section are now themed pills (matching the Random and Favourites buttons on the Albums screen) instead of a segmented bar. Single-select behaviour is unchanged — tapping one mode deselects the others.

---

## v1.1.0.28 — 2026-05-02

### New
- Metadata scanning scheduler. Configure when and how MusicD fetches metadata from external services. Three modes:
  - **Off** (default) — nothing scans automatically; manual buttons still work.
  - **Automatic** — runs one full pass through all 5 metadata jobs in priority order. Each job runs until its queue is empty or 1 hour has elapsed, whichever comes first. 5-minute cooldown between jobs. After a complete pass, scheduler stops. New albums detected by the file watcher trigger a fresh pass on just those new items.
  - **Scheduled** — jobs only run inside a user-defined time window (default 01:00 to 06:00, minimum 5 hours). No cooldown between jobs. If the window closes mid-job, the job pauses cleanly and resumes the next night.
- Job priority order: 1) MusicBrainz match, 2) Cover art, 3) Volume levelling, 4) Artist logos, 5) Album & artist bios.
- Live status panel on the Metadata settings screen showing current job, pending counts per job, and CPU temperature reading.
- CPU thermal guard. If CPU temperature exceeds 59°C for more than 30 seconds, the running job pauses for 60 seconds and re-checks. After 5 consecutive thermal trips, the job is skipped and the scheduler moves on. Reads from `/sys/class/thermal/thermal_zone0/temp`.
- "Run cycle now" button forces an immediate pass regardless of mode (useful for testing or after a manual library update).
- Bio scanner. Previously bios were fetched lazily on demand; the new scanner pre-warms entries that haven't been attempted yet, but on-demand fetching still works as before.

### Changed
- Albums and artists table now have a `bio_attempted_at` column tracking whether the bio fetcher has tried each entity. Lazy on-demand fetches still work; the scheduler uses this column to know what hasn't been touched yet.
- New `albums.scheduled_excluded` flag for "stop trying to scan this." Currently set only on rejected matches (so the scheduler doesn't keep retrying albums the user has explicitly rejected).

### Notes
- Scheduled times are in the container's local timezone. The container defaults to UTC. To use your local time, set `-e TZ=Europe/London` (or your zone) when starting the container.
- Manual entry points for each job (Start matching, Refresh missing artwork, Scan loudness, Fetch artist logos) still exist — the scheduler is additive, not a replacement.
- First scheduler run on a fresh library will be heavy work (matching thousands of albums against MusicBrainz takes hours, throttled to 1 req/sec by their rules). The thermal guard will throttle if needed but the box will be busy.

---

## v1.1.0.27 — 2026-05-02

### UI
- Settings reorganised. The standalone "Volume Levelling" and "API" screens have been retired. Their contents moved to where they fit naturally:
  - Volume-levelling settings (toggle, mode, target LUFS) are now at the top of **Settings → DSP**, since they're a signal-processing concern.
  - The volume-levelling scanner moved to **Settings → Metadata** below the bios section, since it's a library-scan operation.
  - MusicBrainz contact field now sits at the top of **Settings → Metadata** above the album matcher (it's the prerequisite the matcher needs).
  - Built-in services health indicators moved to the bottom of **Settings → Metadata** beside the services they monitor.
- "Random" and "Favourites" pills on the Albums screen are now larger and easier to tap on phones (padding +60%, font and icons bumped one notch).

---

## v1.1.0.26 — 2026-05-02

### Fixed
- v1.1.0.25 failed to build because `.dockerignore` excludes `*.md` files, which prevented `CHANGELOG.md` from being copied into the container. Added an explicit `!CHANGELOG.md` un-ignore line so the changelog ships with each build.

---

## v1.1.0.25 — 2026-05-02

### New
- Full changelog (this document) is now bundled with each release.
- "What's in this version" panel on the Update screen — shows the running release's notes inline so you don't have to leave the app to see what changed.
- In-app changelog viewer — tap "Click here for MusicD Changelog" on the Update screen to read every release's notes without leaving the app.
- Auto-update manifest URL is now baked in. To override (e.g. for development or a private mirror), set the `MUSICD_MANIFEST_URL` environment variable when starting the container.

### UI
- Update screen simplified: the "Auto-update source" heading and URL input field have been removed. The manifest URL is no longer something users configure.
- The Update screen now leads with the current version, then the manual update check button, then the new "What's in this version" panel, then the changelog link.

---

## v1.1.0.24 — 2026-05-02

### New
- Service health indicators on Settings → API → Built-in services. Each external service (Last.fm, fanart.tv, TheAudioDB, AcoustID, MusicBrainz) now shows a green / red / grey dot reflecting whether the most recent call succeeded, failed, or hasn't happened recently.
- When a service is failing, the most recent error message is shown directly under the row so you can share it back if reporting an issue.

### UI
- Settings → API → Built-in services now lists all five services with status dots, what they're used for, and a relative-time hint ("last ok 2m ago", "last failed 5h ago", "no recent calls").

### Notes
- Health state is in-memory and resets when the container restarts. After a restart, dots show grey ("idle") until each service gets called again.

---

## v1.1.0.23 — 2026-05-02

### New
- API keys for Last.fm, fanart.tv, TheAudioDB, and AcoustID are now baked into MusicD. No more registering apps with each service or pasting keys into Settings.
- Last.fm sign-in is now a single screen — username + password — with no API key configuration step.

### Changed
- Settings → API simplified. Only the MusicBrainz contact field remains (it's still per-deployer because MusicBrainz requires identifying contact info per their terms of service).

### Migrations
- Existing Last.fm sessions are cleared on first boot of v1.1.0.23. Session keys were tied to whichever API key issued them, and we've switched to the baked-in app credentials. Re-authenticate in Settings → LastFM Scrobbler to resume scrobbling.

---

## v1.1.0.22 — 2026-05-02

### New
- AcoustID fingerprint matching for unmatched albums. When the metadata matcher can't identify an album by title and artist, you can now run an audio-fingerprint match: it samples up to three tracks, generates fingerprints with `fpcalc`, and queries AcoustID. Useful for files with bad or missing tags.
- "Try AcoustID fingerprint match" button in the Unmatched modal. Manual per-album, no automatic background sweep.

### Changed
- Container now includes `libchromaprint-tools` (provides `fpcalc`). Adds about 5 MB to the image.

### Notes
- AcoustID coverage is good but not universal. Mainstream/pop is well-covered. Classical, jazz, bootlegs, and obscure releases are weaker. Expect 60-80% hit rate on a typical Western library.

---

## v1.1.0.21 — 2026-05-02

### New
- Manual matching in the Unmatched screen. You can now confirm a candidate the matcher found, reject the album entirely (it won't be re-checked), or run a free-text MusicBrainz search to find it manually.
- Free-text MusicBrainz search box, pre-populated with the album's title and artist so the obvious case needs no typing.

### Changed
- "Reset all matches" now preserves manual decisions and tag-sourced matches. Only auto-matches get reset.
- Matcher tracks who decided each match (`auto`, `tag`, or `manual`) so manual choices stick across resets.

### UI
- The Unmatched modal is now actionable rather than read-only. Each candidate has a "Use this" button. A reject button lives at the bottom.

---

## v1.1.0.20 — 2026-05-02

### New
- The scanner now reads MusicBrainz IDs from file tags (FLAC vorbis comments, ID3v2 TXXX, M4A iTunes atoms). If a file already has `MUSICBRAINZ_RELEASEGROUPID`, the album is marked as matched immediately at scan time — no MusicBrainz API call needed.
- Files with only the release-level MBID (`MUSICBRAINZ_ALBUMID`) get one direct MusicBrainz lookup to convert to a release-group, then both are stored.
- Barcode and catalog number are extracted from tags and used to sharpen MusicBrainz queries when matching is needed.

### Changed
- The matcher now tries progressively narrower queries before falling back to title+artist alone: barcode-narrowed, catalog-number-narrowed, year-narrowed, then plain. First non-empty result wins.

### Notes
- Existing already-matched albums won't be re-evaluated. To pick up the tag-sourced MBIDs, re-scan from Settings → Library, or reset the matcher.

---

## v1.1.0.19 — 2026-05-02

### UI
- Scrollbars are now wider (14 px instead of 6 px) with a faint horizontal-ridge texture on the thumb so it reads as something to grip on a phone. Also slightly inset from the edge so it looks like a control rather than a clipped blob.
- Firefox now gets a thumb colour and `scrollbar-width: auto` for parity.

### Fixed
- Removed a dead "scroll strip" element from Settings that claimed to capture touch but wasn't actually scrolling anything.

---

## v1.1.0.18 — 2026-05-02

### Fixed
- DAC capabilities (PCM rates, formats, channel count) now show in the Audio Devices screen. The probe code worked correctly in v1.1.0.17, but the UI was reading from the wrong field in the API response, so it showed "Capabilities not yet probed" even when the data was there.
- Removed stale UI text that referenced a `/proc/asound` bind-mount workaround from earlier versions.

---

## v1.1.0.17 — 2026-05-02

### Fixed
- DAC capability probing was broken: the probe was sending mono audio to USB DACs (which are stereo-only). All probes failed silently with "Sample format non available". The probe now adds `-c 2` (stereo channels) and parses formats and rate ranges directly from `aplay --dump-hw-params` output. Faster too — one dump call instead of 40 individual probes for PCM.

---

## v1.1.0.16 — 2026-05-02

### Fixed
- DAC capability detection restored using `aplay` as a fallback when `/proc/asound/cardN/stream0` is empty. (This release shipped with a probe bug — see v1.1.0.17 for the actual fix.)

---

## v1.1.0.15 — 2026-05-02

### Fixed
- The self-updater now preserves `--device /dev/snd` and `--group-add 29` flags when recreating the container. Previous releases stripped these on update, which broke USB DAC access until manual recovery.

---

## v1.1.0.14 — 2026-05-02

### Fixed
- USB DACs no longer appear duplicated in the Audio Devices list. The renderer enumeration was including ALSA devices in both the USB DAC list and the network device list.
- USB DACs now appear in the Output sheet renderer picker. Previously the picker filtered them out.

---

## v1.1.0.13 — 2026-05-02

### UI
- Settings header no longer shows the "MusicD" wordmark — the MD logo on its own is recognisable and the wordmark crowded the header on small screens.
- Renamed Settings sections for clarity: Audio → Audio Devices, Metadata Refresh → Metadata, Scrobbling → LastFM Scrobbler, Software Update → Update.

### Fixed
- Update process now logs spawn arguments verbatim and pre-cleans any stale `musicd-updater` container before starting. Failed update containers persist (no `--rm`) so `docker logs musicd-updater` can be used to diagnose.

---

## Earlier versions (pre-v1.1.0.13)

This changelog starts at v1.1.0.13 because that's where reliable per-release notes
begin. Older versions exist but are not documented here.
