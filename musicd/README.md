# musicd 🎵

A self-hosted music server with a Roon-inspired web UI, DLNA/UPnP output,
parametric EQ DSP, and a signal path visualiser.

## Features

| Feature | Detail |
|---|---|
| **Formats** | FLAC, MP3, DSF/DFF (DSD), WAV, AIFF, OGG, Opus, M4A, WavPack |
| **Multichannel** | Pass-through up to 8ch for FLAC/WAV; detected & labelled in UI |
| **DSD** | DSF/DFF decoded to 352.8kHz PCM via FFmpeg, streamed as FLAC |
| **Output** | DLNA/UPnP AVTransport (any renderer: Sonos, Linn, Naim, BubbleUPnP…) |
| **DSP** | Parametric EQ — up to N bands (peaking, shelves, HP/LP, notch) |
| **Signal Path** | Roon-style per-play chain: source → decode → EQ → network → renderer |
| **Metadata** | music-metadata + MusicBrainz enrichment |
| **Library** | SQLite FTS5 search, auto-scan on startup, inotify watch |
| **UI** | Dark, Roon-inspired React SPA; album grid, track list, modals |

---

## Quick start — docker run

```bash
docker run -d \
  --name musicd \
  --network host \
  -v /path/to/your/music:/music:ro \
  -v musicd-data:/data \
  -e MUSIC_DIR=/music \
  -e PORT=3000 \
  musicd:latest
```

Then open **http://localhost:3000** (or your server IP).

> **`--network host` is strongly recommended on Linux** so that SSDP/UPnP
> multicast (UDP 1900) works for automatic renderer discovery. On macOS /
> Windows Docker Desktop you can use `-p 3000:3000` for the web UI, but
> renderer discovery via SSDP may not work — use a BubbleUPnP Server or
> manually add your renderer's IP via the API.

---

## docker-compose

```bash
# 1. Edit docker-compose.yml — set your music path in volumes:
#      - /your/music:/music:ro

# 2. Build & start
docker compose up -d --build

# 3. View logs
docker compose logs -f

# 4. Open
http://<server-ip>:3000
```

---

## Build from source

```bash
# Install deps
cd server && npm install && cd ..
cd client && npm install && npm run build && cd ..

# Run
MUSIC_DIR=/path/to/music node server/src/index.js
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `MUSIC_DIR` | `/music` | Music library root |
| `DB_PATH` | `/data/musicd.db` | SQLite database path |
| `NODE_ENV` | `production` | Node environment |

---

## Parametric EQ

The PEQ engine uses FFmpeg's `equalizer` / `lowpass` / `highpass` filters
applied in the stream pipeline, so DSP is done server-side before delivery
to the renderer.

**Band types:**

| Type | Description |
|---|---|
| `peaking` | Bell / peak filter (freq, gain, Q) |
| `lowshelf` | Low-frequency shelf |
| `highshelf` | High-frequency shelf |
| `lowpass` | 2nd-order Butterworth LP |
| `highpass` | 2nd-order Butterworth HP |
| `notch` | Deep notch (−40 dB) at frequency |

Profiles are stored in SQLite and can be assigned per-renderer. Select a
profile in the EQ modal, click **Apply to playback**, then press Play.

---

## Signal Path

The signal path modal shows the processing chain for the currently playing
track:

```
[File] → [DSD Decoder?] → [Multichannel?] → [PEQ?] → [FFmpeg] → [UPnP] → [Renderer]
```

Each node shows format, sample rate, bit depth, and channel count where
applicable. PEQ nodes list every band. A green dot indicates a lossless path.

---

## DSD Playback

DSF and DFF files are decoded to high-rate PCM (352.8kHz / 32-bit) by
FFmpeg and re-encoded as FLAC for delivery over HTTP to the renderer. This
means:

- Any DLNA renderer that accepts FLAC can play your DSD files.
- Renderers with native DSD support (Linn DS, etc.) can be extended in
  `dlna.js` to receive raw DSD if desired.

---

## Multichannel

Multichannel FLAC and WAV files (5.1, 7.1, etc.) are detected during scan
(channel count stored) and streamed as-is. The renderer must support the
channel count. Channel info is shown in the track list and signal path.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/library/albums` | List albums |
| GET | `/api/library/albums/:id` | Album + tracks |
| GET | `/api/library/albums/:id/cover` | Cover art image |
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
| GET | `/api/stream/:trackId` | Stream audio (with `?peq=profileId`) |
| GET | `/api/peq` | List EQ profiles |
| POST | `/api/peq` | Create profile |
| PUT | `/api/peq/:id` | Update profile |
| DELETE | `/api/peq/:id` | Delete profile |

WebSocket on `ws://<host>/` — receives JSON `{ type, payload }` events:
`state`, `renderers_updated`, `library_updated`.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Docker container (node:20-alpine + ffmpeg)     │
│                                                 │
│  ┌──────────┐   ┌──────────┐   ┌─────────────┐ │
│  │ Express  │   │ Chokidar │   │ SSDP client │ │
│  │ API+WS   │   │ scanner  │   │ (UDP 1900)  │ │
│  └────┬─────┘   └────┬─────┘   └──────┬──────┘ │
│       │              │                │         │
│  ┌────▼──────────────▼────────────────▼──────┐  │
│  │          SQLite (better-sqlite3)          │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │   FFmpeg (stream route + PEQ DSP)         │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │   React SPA (served as static files)      │  │
│  └───────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────┘
                       │ HTTP + UPnP/SOAP
              ┌────────▼────────┐
              │  DLNA Renderer  │
              │ (Sonos, Linn…)  │
              └─────────────────┘
```
