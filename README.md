# MusicD-Server-v1

A self-hosted music server with a Roon-inspired web UI, DLNA/UPnP output,
parametric EQ DSP, AutoEQ headphone presets, FIR convolution, multi-zone
renderer support, and a per-stream signal path visualiser.

**Current release:** `musicd-v1-1-3-7.tar` (version 1.1.3.7)

---

## Features

### Audio playback

| Capability | Detail |
|---|---|
| Lossless codecs | FLAC, WAV, AIFF, ALAC (M4A), WavPack |
| Lossy codecs | MP3, OGG, Opus, AAC |
| DSD | DSF / DFF decoded via FFmpeg to 352.8 kHz PCM, streamed as FLAC |
| Multichannel | 5.1 / 7.1 pass-through up to 8 channels, detected at scan time |
| Volume levelling | Per-track and per-album loudness normalisation (LUFS target configurable, default −18 LUFS) via `loudgain` (libebur128) with FFmpeg fallback |
| CPU thermal throttling | Background loudness / metadata jobs throttle based on a user-configured CPU temperature ceiling (default 65 °C); reads `/sys/class/thermal` with `x86_pkg_temp`, `coretemp`, `k10temp`, `cpu_thermal` fallback |

### Renderers & output

| Renderer | Detail |
|---|---|
| DLNA / UPnP | Any AVTransport renderer — Sonos, Linn, Naim, BubbleUPnP, WiiM, etc. Auto-discovered via SSDP |
| Sonos | Native integration with optional 16-bit force-mode for stubborn zones |
| Squeezelite / LMS | Squeezebox sink discovery and control, optional Lyrion Media Server bridge |
| USB DAC / ALSA | Local audio output with capability detection, configurable variable / fixed gain, per-device DSD playback mode |
| Multi-zone | Move queues across renderers, per-renderer last-used tracking |

### DSP & signal processing

- Parametric EQ — up to N biquad bands per profile (peaking, low / high shelf, low-pass, high-pass, notch)
- AutoEQ — 1000+ factory headphone and speaker presets
- FIR convolution — upload impulse responses, per-IR peak metadata, dry / wet mix
- Crossfeed — cmoy, Meier, JMeier profiles
- Headroom slider between PEQ and FIR stages (−12 dB to 0 dB)
- Auto-preamp — automatic gain reduction to prevent clipping on PEQ peaks, calculated when the profile is saved
- Per-renderer profile assignment; bypass switch for renderers with internal EQ
- DSP eligibility: DLNA & Squeezelite (Sonos uses internal EQ)

### Signal path visualiser

Roon-style per-play chain — `source → decode → EQ → network → renderer` — with
format, sample rate, bit depth, channel count, and every PEQ band on every node.
A green dot indicates a lossless path.

### Library & search

- Auto-scan on startup with inotify watch; manual rescan via API
- SQLite FTS5 search across title, artist, album, genre
- Album grouping with multi-disc detection (CD1 / CD2 folder flattening)
- Embedded cover art extraction with MusicBrainz / Last.fm / Qobuz fallback
- Custom tags with colours; album and track tagging; save-for-later bookmarks
- MusicBrainz album & artist matching (scheduler-driven, throttled)
- AcoustID fingerprint matching for unlabelled files (`fpcalc`)

### Metadata & discovery

- Artist bios from Last.fm (cached)
- Music news feed — Pitchfork, Bandcamp Daily, Qobuz releases
- Genre alias normalisation
- SSDP / mDNS renderer discovery

### Streaming & transcoding

- Real-time FFmpeg pipeline with adaptive downsampling to the renderer's max sample rate
- TPDF dithering on 24 → 16-bit conversion
- Precise seek via Content-Duration headers
- Per-request profile selection — `GET /api/stream/:trackId?peq=profileId`

### Sharing & integrations

- Share cards — generated PNG artwork for the current track / album
- Last.fm scrobbling — login, queue status, manual flush
- WebSocket broadcast of state, renderer, and library events

### Administration & ops

- Tier system — Demo (50-album cap), Stable, Early Access, Beta, Alpha (code-locked)
- Settings persisted in SQLite with a shadow config
- `GET /api/healthz` endpoint with 503 guard until the database is ready
- Docker-aware auto-updater (manifest polling, version comparison, in-place restart)
- Bug reporter — local JSON capture with system diagnostics, 90-day retention
- Client-side console relay to `/api/debug`
- Backup / restore — database snapshot export and atomic-swap import

---

## Stack

- Node 20 (Express + WebSocket)
- SQLite via `better-sqlite3`
- FFmpeg + `loudgain` + `fpcalc`
- React SPA, served as static assets
- Three-stage Docker build on `node:20-trixie-slim`

---

## Docker build

Data, the SQLite database, DSP profiles, cover-art cache, and backups all live
under **`/var/lib/musicd-server-v1`** on the host. This path is bind-mounted
into the container at `/data` and owned by UID 1000:1000 (matching the
container's `musicd` user).

### 1. Download and extract the release

The release tar is published on the repo's `main` branch. Download it
directly with `curl` (or `wget`) and extract into the build context:

```bash
sudo mkdir -p /opt/musicd-server-v1
cd /opt/musicd-server-v1

# Pull the release tar straight from the repo
sudo curl -fSL -o musicd-v1-1-3-7.tar \
  https://github.com/meltface-80/MusicD-Server-v1/raw/main/musicd-v1-1-3-7.tar

sudo tar -xf musicd-v1-1-3-7.tar --strip-components=1
sudo rm musicd-v1-1-3-7.tar
```

> For a specific version, swap `main` for the tagged commit, e.g.
> `https://github.com/meltface-80/MusicD-Server-v1/raw/v1.1.3.7/musicd-v1-1-3-7.tar`.

### 2. Prepare the data directory

```bash
sudo mkdir -p /var/lib/musicd-server-v1
sudo chown -R 1000:1000 /var/lib/musicd-server-v1
sudo chmod 750 /var/lib/musicd-server-v1
```

The container runs as UID 1000 and writes the SQLite WAL, so the directory
**must** be owned by 1000:1000 — otherwise SQLite will report
`SQLITE_READONLY: attempt to write a readonly database` at boot.

### 3. Build the image

```bash
docker build -t musicd-server-v1:1.1.3.7 -t musicd-server-v1:latest .
```

The build runs three stages — the React client on Alpine, server `node_modules`
on Trixie (so native bindings like `better-sqlite3` and `sharp` match the
runtime glibc), and a final Trixie-slim image with `ffmpeg`, `loudgain`,
`docker-cli`, `gosu`, `tini`, `alsa-utils`, and `libchromaprint-tools`.

### 4. Run with `docker run`

```bash
docker run -d \
  --name musicd-server-v1 \
  --network host \
  --device /dev/snd \
  --group-add 29 \
  -v /var/lib/musicd-server-v1:/data \
  -v /path/to/your/music:/music:ro \
  -v /sys/class/thermal:/sys/class/thermal:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e PORT=32700 \
  -e MUSIC_DIR=/music \
  -e DB_PATH=/data/musicd.db \
  -e NODE_ENV=production \
  --restart unless-stopped \
  musicd-server-v1:latest
```

Then open `http://<host>:32700`.

> **USB DAC capability probing (`-v /proc/asound:/proc/asound:ro`)** is
> deliberately omitted above. On DietPi and other stock kernels `runc`
> **rejects** this bind-mount with
> `cannot be mounted because it is inside /proc` and the container fails to
> start. USB DACs still work without it — `detect.js` falls back to
> `aplay --dump-hw-params`, probing capabilities lazily on first use. Only
> add `-v /proc/asound:/proc/asound:ro` if your kernel allows it (you can
> test: if the container starts, it's fine).

### 5. Or run with `docker compose`

A `docker-compose.yml` is bundled in the release. Edit the music path and
swap the data volume for the host bind-mount, then bring it up:

```yaml
services:
  musicd:
    image: musicd-server-v1:latest
    build: .
    container_name: musicd-server-v1
    network_mode: host
    devices:
      - /dev/snd
    group_add:
      - "29"
    volumes:
      - /path/to/your/music:/music:ro
      - /var/lib/musicd-server-v1:/data
      - /sys/class/thermal:/sys/class/thermal:ro
      - /var/run/docker.sock:/var/run/docker.sock
      # USB DAC probing — omit on DietPi / stock kernels (runc rejects
      # mounts inside /proc and the container won't start):
      # - /proc/asound:/proc/asound:ro
    environment:
      PORT: 32700
      MUSIC_DIR: /music
      DB_PATH: /data/musicd.db
      NODE_ENV: production
    restart: unless-stopped
```

```bash
docker compose up -d --build
docker compose logs -f
```

### What each mount is for

| Mount | Purpose | Required |
|---|---|---|
| `/var/lib/musicd-server-v1 → /data` | SQLite DB, DSP profiles, cover-art cache, backups | yes |
| `/path/to/music → /music:ro` | Your music library, read-only | yes |
| `/dev/snd` + `--group-add 29` | USB DAC / ALSA device access | only for local audio output |
| `/proc/asound:ro` | Richer USB DAC capability probing (sample rates, formats) | optional — **omit on DietPi / stock kernels** (runc rejects mounts inside `/proc`); DACs still work via the `aplay` fallback |
| `/sys/class/thermal:ro` | Host CPU temperature for background-job throttling | recommended |
| `/var/run/docker.sock` | Auto-updater pulls new images and restarts the container | optional |

GID 29 is the Debian / Ubuntu / DietPi default for the `audio` group. On
other distros check `getent group audio` on the host and substitute the
correct number.

### Network mode

`--network host` is required on Linux for SSDP/UPnP multicast (UDP 1900) so
renderers are discovered automatically. On macOS / Windows Docker Desktop,
fall back to `-p 32700:32700 -p 1900:1900/udp` — renderer auto-discovery
may not work and you may need to set `SSDP_INTERFACE` or add renderers by
IP via the API.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `32700` | HTTP / WebSocket port |
| `MUSIC_DIR` | `/music` | Music library root inside the container |
| `DB_PATH` | `/data/musicd.db` | SQLite database path |
| `NODE_ENV` | `production` | Node environment |
| `LMS_HOST` | `127.0.0.1` | Lyrion Media Server host (Squeezelite bridge) |
| `LMS_PORT` | `9000` | Lyrion Media Server port |
| `SSDP_INTERFACE` | (auto) | Interface name for SSDP multicast — set when `--network host` is unavailable |

### Healthcheck

The image ships a HEALTHCHECK that polls `http://localhost:32700/api/healthz`
every 30 s. Healthchecks fail with HTTP 503 until the database is ready.

---

## Directory layout under `/var/lib/musicd-server-v1`

```
/var/lib/musicd-server-v1/
├── musicd.db                # SQLite primary
├── musicd.db-wal            # WAL
├── musicd.db-shm            # shared memory
├── dsp/                     # user PEQ profiles, FIR impulse responses
├── coverart/                # cover-art cache
├── artistlogos/             # fanart artist logos
├── backups/                 # snapshot exports
└── .pending-restore/        # atomic-swap staging for restores
```

---

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/healthz` | Liveness probe |
| GET | `/api/library/albums` | List albums |
| GET | `/api/library/albums/:id` | Album + tracks |
| GET | `/api/library/albums/:id/cover` | Cover art |
| GET | `/api/library/tracks` | List tracks |
| GET | `/api/library/search?q=` | FTS search |
| GET | `/api/library/stats` | Library statistics |
| POST | `/api/library/scan` | Trigger rescan |
| GET | `/api/renderers` | List discovered renderers |
| POST | `/api/player/play` | Play track on renderer |
| POST | `/api/player/pause` | Toggle pause |
| POST | `/api/player/stop` | Stop |
| POST | `/api/player/volume` | Set volume |
| GET | `/api/player/state` | Current player state |
| GET | `/api/stream/:trackId` | Stream audio (supports `?peq=profileId`) |
| GET | `/api/dsp/profiles` | List EQ profiles |
| POST | `/api/dsp/profiles` | Create profile |
| PUT | `/api/dsp/profiles/:id` | Update profile |
| DELETE | `/api/dsp/profiles/:id` | Delete profile |
| GET | `/api/share/card/:trackId` | Generate share card PNG |
| POST | `/api/scrobble/login` | Last.fm login |
| GET | `/api/news` | Music news feed |
| GET | `/api/update/check` | Manifest check |
| POST | `/api/update/apply` | Apply update |

WebSocket on `ws://<host>:32700/` — JSON `{ type, payload }` events:
`state`, `renderers_updated`, `library_updated`.

---

## License

See [LICENSE](LICENSE).
