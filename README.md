# MusicD Server v1

https://meltface-80.github.io/MusicD-Server-v1/

A self-hosted music server with a Roon-inspired web UI, DLNA/UPnP output,
parametric EQ DSP, AutoEQ headphone presets, FIR convolution, multi-zone
renderer support, and a per-stream signal path visualiser.

**Current release:** v1.1.3.8 — see [`musicd/CHANGELOG.md`](musicd/CHANGELOG.md).

## Repository layout

| Path | What it is |
|------|------------|
| `musicd/` | MusicD Server (Node.js) and web client (React/Vite), v1.1.3.8 |
| `musicd-v1-1-3-8.tar` | Published release tarball — what the in-app updater downloads |
| `manifest.json` | Update manifest polled by the server's updater |
| `docs/` | GitHub Pages site (feature overview + install) |

## Docker

Source ships in the repo, so a build is two commands — no tarball to
download and unpack first.

```sh
git clone https://github.com/meltface-80/MusicD-Server-v1
docker build -t musicd-server ./MusicD-Server-v1/musicd
```

```sh
docker run -d --name musicd-server \
  --network host \
  --device /dev/snd --group-add 29 \
  -v /var/lib/musicd-server-v1:/data \
  -v /path/to/your/music:/music:ro \
  -v /sys/class/thermal:/sys/class/thermal:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e PORT=32700 -e MUSIC_DIR=/music -e DB_PATH=/data/musicd.db \
  --restart unless-stopped \
  musicd-server
```

Then open `http://<host>:32700`.

Three flags are load-bearing and worth understanding before you change
them:

- **`--network host`** is required on Linux for SSDP/UPnP multicast (UDP
  1900), without which renderers are not discovered. On Docker Desktop
  fall back to `-p 32700:32700 -p 1900:1900/udp` and expect to add
  renderers by IP.
- **`/var/lib/musicd-server-v1` must be owned by `1000:1000`.** The
  container runs as UID 1000 and writes the SQLite WAL; otherwise it
  fails at boot with `SQLITE_READONLY`.
- **`--group-add 29`** is the Debian/DietPi `audio` GID, needed only for
  local USB DAC output. Check yours with `getent group audio`.

Deliberately omitted: `-v /proc/asound:/proc/asound:ro`. On DietPi and
other stock kernels `runc` rejects mounts inside `/proc` and the
container will not start. USB DACs still work without it — `detect.js`
falls back to `aplay --dump-hw-params`.

A `docker-compose.yml` ships in `musicd/`.

## Updates

After the first install, updates happen in-app: **Settings → Check for
updates**. The server polls [`manifest.json`](manifest.json) on this
repo's `main` branch, compares the published version against its own,
and on request downloads the release tarball and restarts itself. The
Docker socket mount above is what lets it do that.

Cutting a release:

```sh
cd musicd
./scripts/release.sh 1.1.3.9 --apply --tar   # bumps VERSION, both package.json, install.sh; builds the tar
```

Then move the tarball to the repo root, update `manifest.json` to point
at it, and add a `CHANGELOG.md` entry. Access tiers live in the same
manifest — the four 4-digit codes unlock the Early Access, Beta and
Internal channels. Stable is the baseline, so a fresh install is
unlocked with no code.

## Development

```sh
cd musicd/server && npm install && npm start   # :32700
cd musicd/client && npm install && npm run dev # :5173, proxies /api and /ws
```

The client is a React 18 + Vite SPA served as static assets by the
server in production. The server is CommonJS Node 20 on Express,
better-sqlite3, ws, node-ssdp, sharp and music-metadata, shelling out to
`ffmpeg`, `loudgain` and `fpcalc`.

## Runtime data

Everything mutable lives under `/var/lib/musicd-server-v1`, bind-mounted
to `/data`:

```
musicd.db                # SQLite primary (+ -wal, -shm)
dsp/                     # user PEQ profiles, FIR impulse responses
coverart/  artistlogos/   # caches
backups/                 # snapshot exports
.pending-restore/        # atomic-swap staging for restores
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `32700` | HTTP / WebSocket port |
| `MUSIC_DIR` | `/music` | Music library root inside the container |
| `DB_PATH` | `/data/musicd.db` | SQLite database path |
| `NODE_ENV` | `production` | Node environment |
| `LMS_HOST` / `LMS_PORT` | `127.0.0.1` / `9000` | Lyrion Media Server (Squeezelite bridge) |
| `SSDP_INTERFACE` | (auto) | Interface for SSDP multicast — set when `--network host` is unavailable |

## Features

The [GitHub Pages site](https://meltface-80.github.io/MusicD-Server-v1/)
has the full breakdown. In short: lossless and lossy playback including
DSD and multichannel, loudness normalisation, DLNA/UPnP, Sonos,
Squeezelite/LMS and local ALSA output with multi-zone queue handoff,
parametric EQ with 1000+ AutoEQ presets, FIR convolution and crossfeed,
a Roon-style signal path visualiser, SQLite FTS5 search, MusicBrainz and
AcoustID matching, Last.fm scrobbling, share cards, and a Docker-aware
auto-updater.

## API

`GET /api/healthz` is the liveness probe. The library, player, renderer,
DSP, stream, share, scrobble and update routes live under `/api/` — see
`musicd/server/src/routes/`. A WebSocket on `ws://<host>:32700/` carries
`state`, `renderers_updated` and `library_updated` events.

## License

See [LICENSE](LICENSE).
