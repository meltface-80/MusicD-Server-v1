# MusicD Server v1 — working rules

## Before every push

```sh
cd musicd/server && npm test
```

Assertions across the whole suite; it is fast and needs no device, no
renderer and no database. Run it. Three of this project's worst bugs were
shipped by changes that "obviously" could not break anything.

`test/screens-render.test.js` is the one test here that RUNS the client
rather than reading it: esbuild bundles every screen and
`renderToStaticMarkup` executes their render bodies. It exists because
v1.1.25.0 shipped an Albums screen that came up blank — one line of state
deleted by accident — and every other check in this suite is a grep. `node
--check` passes on an undeclared identifier. So does `vite build`. If you
delete or move code, that file is the one that tells you the screen still
mounts.

- [ ] `npm test` passes
- [ ] `node --check` on every server file you touched
- [ ] `prettier --parser babel <file>` on every client file you touched —
      it is the only syntax gate the client has outside a full build
- [ ] Version bumped with `./scripts/release.sh`, not by hand
- [ ] `CHANGELOG.md` entry added
- [ ] **`README.md` and `docs/index.html` updated** — every release, not just
      the ones that feel big. See *The published face of a release* below
- [ ] Tarball rebuilt **after** the last source edit, `manifest.json`
      pointed at it, `tarSha256` refreshed
- [ ] If you touched the client's `<head>`, `App.jsx`'s root style, or
      anything with `safe-area`: say plainly that it is unverified on
      hardware, and tell the owner to delete and re-add the home-screen
      shortcut

**A test that cannot fail is worse than no test.** The static checks here
are greps. If you add one, prove it bites: reintroduce the bug in a scratch
copy, watch it go red, then restore. `test/client-styles.test.js` carries
its own detector self-test for this reason.

## Versioning

Versions are `1.1.MINOR.PATCH`. **Bump the third part and leave the fourth
at 0**: after `1.1.9.0` comes `1.1.10.0`.

The fourth part is the owner's to spend. Do not increment it, and do not
"round up" to it, unless the owner asks for that specific number in that
message. If a release seems too small to justify a minor bump, it still
gets one.

Cut a release with the repo's own script — it verifies the bump landed:

```sh
cd musicd && ./scripts/release.sh 1.1.10.0 --apply
```

It updates `VERSION`, both `package.json` files, and three strings in
`install.sh`. If its verify step reports a miss, `install.sh` has drifted
out of step and the `sed` matched nothing — fix the file, do not skip the
check. That drift shipped a broken installer once: the published installer
downloaded one release and then refused it for failing its own version
check. `release-consistency.test.js` now catches it.

Then, at the repo root: rebuild `musicd-v1-<dashed>.tar` from `musicd/`,
point `manifest.json` at it (top level **and** all five channels), and
refresh `tarSha256` / `tarball_sha256` from `sha256sum`. The tarball must
be rebuilt **after** the last source edit — including a CHANGELOG edit,
because `musicd/CHANGELOG.md` is inside it.

Never rewrite a released tarball's contents under its own version. If it
is already published on `main`, ship the fix as a new version instead: an
install that already took that version is never offered a same-version
update, and anyone who fetched the old bytes holds something the manifest
no longer describes.

## The published face of a release

`CHANGELOG.md` is not the only file that describes a release. Two others are
what anyone outside this repo actually reads:

- **`README.md`** — the repo's front page: the current version, the layout
  table, the tarball name, and the upgrade notes that name a version.
- **`docs/index.html`** — the GitHub Pages site at
  <https://meltface-80.github.io/MusicD-Server-v1/>: the header badge, the
  `<meta name="description">` that link previews and search results show, the
  footer, and the **What's new in X** section.

Both sat **seven releases behind** — still announcing v1.1.20.0 after
v1.1.27.0 had shipped — because `release.sh` did not touch them and no test
checked them. Being told to remember is not a mechanism; that is why they were
stale in the first place. So:

**The version strings are mechanical.** `./scripts/release.sh <version>
--apply` rewrites them in both files and its verify step reports a ✗ if a
pattern matched nothing. `release-consistency.test.js` fails the suite if
either file disagrees with `VERSION`. Neither needs remembering; both need
not being worked around.

**The prose is not, and is the part that gets skipped.** The script bumps the
*heading* of the What's-new section; it cannot write the cards under it. A
heading that says the new version over the last release's cards is **worse
than a stale heading**, because it reads as current. So every release:

- [ ] Rewrite the What's-new cards in `docs/index.html` from this release's
      `CHANGELOG.md` entry. Same voice as the rest of the page: what changed
      and why it matters to someone using the app, not what the code does.
      Keep the card markup — `<div class="card new">`, a `<span class="tagline">`
      of New / Changed / Fixed, an `<h3>` with an HTML entity glyph, then `<p>`s.
- [ ] Carry forward the handful of earlier cards still worth showing, and drop
      the ones nobody would read now. The section is a highlights reel, not an
      archive — `CHANGELOG.md` is the archive.
- [ ] Re-read `README.md`'s opening description. It describes the app, not the
      release, so the sed does not touch it — and it goes stale silently as
      features land.

If a release genuinely changes nothing a user would notice, say so in one card
rather than leaving the previous release's up.

## Development rules

- **No incomplete implementations.** Write the full code. Never leave
  `// rest stays the same`.
- **Declaration before use.** `const` is not hoisted. A helper declared
  below its first use works only until something calls it during module
  init, and then it is a ReferenceError.
- **No silent catch.** `catch (e) {}` needs a comment saying why silence
  is safe.
- **Never add a key to an inline style object blind.** These files carry
  large `const s = { ... }` maps, and a duplicate key is a *warning* in
  esbuild, not an error — the build succeeds and the later value silently
  wins. A scripted insert of `paddingBottom` landed on top of an existing
  one and quietly disabled the fix it was making.
- **No partial migrations.** When a rule changes, grep the whole file for
  other sites before committing. The progress-bar anchor was fixed three
  times because each pass found one site and missed the others.

## When a bug is found

1. Find the root cause, not the symptom.
2. Confirm the root cause explains **all** of the reported behaviour. A
   cause that explains most of it is usually the wrong one.
3. Fix the root cause.
4. Add the test that would have caught it, and prove the test fails
   without the fix.

## The progress-bar anchor

The server samples each renderer's position ~1/s and broadcasts it with
`positionAt`, a timestamp from **its own** wall clock. The client draws the
playhead as `position + (Date.now() - anchor)`.

**The anchor must always be the client's own clock, taken when the sample
arrives.** Using the server's stamp subtracts one machine's clock from
another's, and any skew between them becomes a permanent offset on the bar:
a host 40 seconds behind the phone draws a track that has just started at
0:40 while the audio plays correctly from zero. Hosts without an RTC drift
exactly like this.

There are **six** sites in `client/src/store/index.js` that set an anchor —
the zones snapshot, the REST hydration, the REST single-zone fallback, the
`state` message, and two in the `position` message. The `position` message
fires every second, so missing it alone makes fixing the other five
invisible. That is how this shipped twice.
`test/position-anchor.test.js` greps for every site.

## iOS PWA layout

This broke three times. MusicD-Remote's `CLAUDE.md` holds the full account.
`test/ios-pwa.test.js` pins all of it; the parts that bite here:

- **`musicd/client/index.html` must carry exactly one viewport meta, and it
  must include `viewport-fit=cover`.** A second viewport meta silently
  overrides the first and zeroes every `env(safe-area-inset-*)`.
- **These three must never come back** without testing on a real device:
  `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
  and a `link rel=manifest`. The first two shift the document up under the
  status bar without growing the layout viewport — leaving a gap at the
  bottom the size of the *top* inset and pushing the top controls out of
  reach. The third makes iOS 17+ letterbox the app.
  `public/manifest.webmanifest` is kept unlinked so it can be restored once
  that is verified on hardware.
- Name those tags in comments **without writing them as tags**, so a
  tag-matching check does not fire on the explanation. A check that cries
  wolf gets ignored, which is how a real one gets waved through.
- **Safe-area insets go on individual screens, never on the app shell.**
  Use `var(--safe-top)` / `var(--safe-bot)` from `index.css`. Padding the
  root grid in `App.jsx` reserves a visible band on *every* screen. The
  shell is `height: 100%`, not `100vh` — viewport units and the physical
  display disagree under `viewport-fit=cover`.
- **iOS caches the window configuration when the home-screen shortcut is
  created**, not per launch. After any head change the shortcut must be
  deleted and re-added. A "still broken" report before that step is not
  evidence the fix failed — ask before diagnosing.

Device behaviour cannot be observed from this environment: the harness is
headless Chromium with no browser chrome and no safe areas. Verify by
construction and against the sibling builds, and say plainly that it is
unverified on hardware.

## Updates

In-app updates need `/mnt/musicd_updates` to be a **real bind mount** from
the host. Installing is done by a short-lived sidecar container that reads
the staged tarball from the host side, so the path is resolved through the
Docker socket. A named volume has no host path and fails. Any change to the
documented `docker run` must keep:

```
-v /var/lib/musicd-server-v1/updates:/mnt/musicd_updates
```

It appears in three places that must stay in step: `README.md`, the
generator in `docs/index.html`, and `musicd/docker-compose.yml`.
`release-consistency.test.js` checks all three.

The container identifies itself for that lookup by reading its own id from
`/proc/self/mountinfo`. Do not replace that with a guess at the container
name, `/etc/hostname` (which is the *host's* name under `--network host`),
or a scan for a container that already has the mount — that last one is
circular, and it reported another container's mounts to a user.

`manifest.json` also carries the `accessTiers` block the four 4-digit codes
validate against. Drop it and `POST /api/update/tier/code` answers 503 and
every code stops working. Stable is the baseline tier, so a fresh install
needs no code.

## Dependencies

Three findings are knowingly left open, because every available fix is
worse than the finding. Re-check only if the fix changes:

- **`ip` (high, via `node-ssdp`)** — npm's fix is `node-ssdp@1.0.0`, a
  *downgrade* from 4.0.1 that breaks SSDP discovery. The advisory is about
  `isPublic()` on a LAN-discovery path that is not attacker-reachable here.
- **`file-type` (moderate, via `music-metadata`)** — the fix is
  music-metadata 7 → 11, which is ESM-only. The server is CommonJS and
  imports it with `require`.
- **`vite` (high) and `esbuild` (moderate, via `vite`)** — the fix is
  vite 5 → 8. Every one of the four advisories affects the **dev server**
  only: esbuild's cross-origin request reflection, vite's `.map` path
  traversal, its `server.fs.deny` bypass on Windows alternate paths, and
  launch-editor's NTLMv2 disclosure on Windows. Production is a static
  `vite build`, and vite is a devDependency, so none of it ships.

`npm audit` therefore reports **4 in `server/` (1 moderate, 3 high)** and
**2 in `client/` (1 moderate, 1 high)**. Those are the expected numbers —
npm counts the dependent package as well as the vulnerable one, so `ip`
also lights up `node-ssdp`, and `file-type` also lights up
`music-metadata`. A build log showing anything other than those two totals
means something genuinely new has appeared and is worth reading.

The client bundle is split by `manualChunks` in `vite.config.js` — a
caching boundary, not route-level code splitting. Entries must be modules
that are genuinely imported, or the build errors on an empty chunk.

## Branding

The duck-head mark (shared with MusicD-Remote) is the app icon and favicon:
`musicd/client/public/` holds `icon-192`, `icon-512`, `icon-maskable-512`
(inset for Android's crop — do not swap it for the full-bleed art),
`apple-touch-icon`, `favicon-32` and `favicon.svg`.

**The share card carries no logo.** Two attempts put an approximation there
— the word "MusicD", then a reconstructed lockup — and neither was the real
artwork. Do not add a mark back from a description or from a sibling repo's
favicon. Only from the actual logo file, committed to this repo and
embedded.
