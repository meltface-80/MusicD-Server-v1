# ── Stage 1: Build React frontend (alpine fine for the build, faster) ────────
FROM node:20-alpine AS frontend-build
WORKDIR /build/client
COPY client/package.json ./
RUN npm install --legacy-peer-deps
COPY client/ ./
RUN npm run build


# ── Stage 2: Install server deps on Trixie (matches runtime base) ─────────────
# Using the same Trixie base for deps so any native modules (better-sqlite3, sharp)
# are compiled against glibc, matching the final image.
FROM node:20-trixie-slim AS server-deps
WORKDIR /build/server
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json ./
RUN npm install --omit=dev


# ── Stage 3: Final image — Debian Trixie slim ────────────────────────────────
FROM node:20-trixie-slim

# Runtime tools:
#  - ffmpeg: streaming, DSD transcode, fallback loudness analyser
#  - loudgain: libebur128 — primary VL analyser (~10x faster than ffmpeg loudnorm)
#  - ca-certificates: HTTPS for cover-art / future enrichers
#  - tini: proper PID 1 / signal handling for clean shutdown
#  - docker-cli: needed by the auto-update flow to talk to the host docker
#    daemon via the mounted socket. We only need the client binary, not the
#    daemon — on Trixie these are separate packages (older Debian shipped
#    them as one in `docker.io`; do NOT use that package here, it pulls in
#    the full daemon and runtime that we don't need).
#  - gosu: drop privileges from root → UID 1000 in the entrypoint after
#    detecting the host docker socket's GID
#  - libchromaprint-tools: provides `fpcalc` for AcoustID fingerprinting
#    (#v1.1.0.22). ~5 MB. We only invoke it once per album when the user
#    taps "Try fingerprint" in the Unmatched UI.
#  - fonts-dejavu-core: the share card is rasterised from SVG by sharp,
#    and librsvg draws tofu boxes (not an error) when fontconfig has no
#    font to match. node:20-trixie-slim is slim enough that we should
#    not assume one is present, so pin a real font rather than rely on
#    the base image. ~1 MB, and shareCard.js names "DejaVu Sans" first.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg loudgain ca-certificates tini wget docker-cli gosu \
      alsa-utils libchromaprint-tools fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && command -v docker >/dev/null || (echo "docker CLI missing after install" && exit 1) \
    && command -v fpcalc >/dev/null || (echo "fpcalc missing after install" && exit 1) \
    && ls /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf >/dev/null \
       || (echo "DejaVu font missing after install — share cards would render as boxes" && exit 1)

# Reuse existing UID/GID 1000 if the base image already provides one
# (node:20-trixie-slim ships a `node` user at 1000:1000). Otherwise create.
# Add the user to the audio group so /dev/snd ioctls work when the
# container is started with --group-add <host-audio-gid>. The group
# already exists in node:20-trixie-slim with GID 29 (Debian default);
# the `usermod -aG` is idempotent if the user is already a member.
RUN ( getent group 1000 >/dev/null || groupadd -g 1000 musicd ) \
 && ( id -u 1000 >/dev/null 2>&1 || useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin musicd ) \
 && ( getent group audio >/dev/null || groupadd -r audio ) \
 && usermod -aG audio "$(id -un 1000)" 2>/dev/null || true

WORKDIR /app

# Copy server + node_modules (Trixie-built native bindings)
COPY --from=server-deps /build/server/node_modules ./server/node_modules
COPY server/ ./server/

# Copy built frontend
COPY --from=frontend-build /build/client/dist ./client/dist

# Single source of truth for version — read by both server (runtime) and
# baked into client at build time via Vite's define plugin
COPY VERSION ./VERSION

# Changelog (#v1.1.0.25). Served by /api/update/changelog and
# /api/update/release-notes. Bundled with the build so the running
# version always describes itself.
COPY CHANGELOG.md ./CHANGELOG.md

# Data directory for SQLite WAL + working files
RUN mkdir -p /data && chown 1000:1000 /data
RUN mkdir -p /music
RUN mkdir -p /mnt/downloads /mnt/musicd_updates

ENV PORT=32700
ENV DB_PATH=/data/musicd.db
ENV MUSIC_DIR=/music
ENV NODE_ENV=production
ENV LMS_HOST=127.0.0.1
ENV LMS_PORT=9000

# Custom entrypoint: at startup, detect the GID of /var/run/docker.sock (host's
# docker group, typically 998 or 999), create a matching group inside the
# container, add UID 1000 to it, then drop privileges and exec the app.
# This lets us preserve UID 1000 for normal ops while still allowing socket
# access for the auto-updater. If the socket isn't mounted (no auto-update),
# the script just runs as 1000 normally.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 32700
EXPOSE 1900/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:32700/api/healthz || exit 1

# tini gives us proper signal forwarding and reaps zombie ffmpeg processes
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server/src/index.js"]
