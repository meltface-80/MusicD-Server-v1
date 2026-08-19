# MusicD Server v1 — working rules

## Versioning

Versions are `1.1.MINOR.PATCH`. **Bump the third part and leave the fourth
at 0**: after `1.1.5.0` comes `1.1.6.0`, then `1.1.7.0`.

The fourth part is the owner's to spend. Do not increment it, and do not
"round up" to it, unless the owner asks for that specific number in that
message. If a release seems too small to justify a minor bump, it still
gets one.

Cut a release with the repo's own script rather than editing versions by
hand — it also verifies the bump landed:

```sh
cd musicd && ./scripts/release.sh 1.1.6.0 --apply
```

It updates `VERSION`, both `package.json` files, and three strings in
`install.sh`. If its verify step reports a miss, `install.sh` has drifted
out of step with `VERSION` and the `sed` matched nothing — fix the file,
do not skip the check. That drift shipped a broken installer once.

Then, at the repo root: rebuild `musicd-v1-<dashed>.tar` from `musicd/`,
point `manifest.json` at it (top level **and** all five channels), and
refresh `tarSha256` / `tarball_sha256` from `sha256sum`. The tarball must
be rebuilt **after** the last source edit — including a CHANGELOG edit,
because `musicd/CHANGELOG.md` is inside it.

Never rewrite a released tarball's contents under its own version. If it
is already published on `main`, ship the fix as a new version instead:
an install that already took that version is never offered a same-version
update, and anyone who fetched the old bytes is left holding something the
manifest no longer describes.

## iOS PWA layout — do not regress this

This has broken three times. MusicD-Remote's `CLAUDE.md` holds the full
account; the parts that bite here:

- **`musicd/client/index.html` must carry exactly one viewport meta, and
  it must include `viewport-fit=cover`.** A second viewport meta silently
  overrides the first and zeroes every `env(safe-area-inset-*)`.
- **These three must never come back** without testing on a real device:
  `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
  and a `link rel=manifest`. The first two shift the document up under the
  status bar without growing the layout viewport — leaving a gap at the
  bottom the size of the *top* inset and pushing the top controls out of
  reach. The third makes iOS 17+ letterbox the app instead of filling it.
  `public/manifest.webmanifest` is kept in the tree, unlinked, so it can be
  restored once that is verified on hardware.
- **Safe-area insets go on individual screens, never on the app shell.**
  Use `var(--safe-top)` / `var(--safe-bot)` from `index.css`. Padding the
  root grid in `App.jsx` reserves a visible band on *every* screen; that
  was the regression. The shell is `height: 100%`, not `100vh` — viewport
  units and the physical display disagree under `viewport-fit=cover`.
- **iOS caches the window configuration when the home-screen shortcut is
  created**, not per launch. After any head change, the shortcut must be
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
Docker socket. A named volume has no host path and fails. Any change to
the documented `docker run` must keep:

```
-v /var/lib/musicd-server-v1/updates:/mnt/musicd_updates
```

It appears in three places that must stay in step: `README.md`, the
generator in `docs/index.html`, and `musicd/docker-compose.yml`.

`manifest.json` also carries the `accessTiers` block that the four 4-digit
codes validate against. Drop it and `POST /api/update/tier/code` answers
503 and every code stops working. Stable is the baseline tier, so a fresh
install needs no code.

## Branding

The duck-head mark (shared with MusicD-Remote) is the app icon and
favicon: `musicd/client/public/` holds `icon-192`, `icon-512`,
`icon-maskable-512` (inset for Android's crop — do not swap it for the
full-bleed art), `apple-touch-icon`, `favicon-32` and `favicon.svg`.

The share card is marked with the MusicD logo lockup — wordmark over
waveform — built as vector in `shareCard.js` from `LOCKUP_*` and
`WAVE_*`. `LOCKUP_W` is the only size knob. It is a reconstruction of the
supplied artwork, so if the original file is ever committed, embed that
instead of tuning the bar array.
