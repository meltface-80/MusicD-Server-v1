#!/bin/bash
# musicd installer -- v1.1.9.0
# =============================
# Interactive installer for first-time install OR for upgrading an
# existing install to v1.1.1.7.
#
# v1.1.1.7 changes vs v1.1.1.6:
#   1. Reverted the "run container as root" experiment from v1.1.1.5.
#      The entrypoint always drops to UID 1000 via gosu, so --user 0:0
#      did nothing useful and chowning the data dir to root made the
#      node process unable to write to it. Symptom: every track scan
#      failed with "attempt to write a readonly database". This release
#      chowns host dirs to 1000:1000 (the node user inside the image)
#      and removes --user from the docker run command.
#   2. install.sh path-validation no longer false-negatives on
#      libraries with 10000+ files. Previous version pipelined
#      `find ... | head -10000 | wc -l`, but head closing the pipe
#      early caused find to die with SIGPIPE; pipefail then triggered
#      the `|| echo 0` fallback which APPENDED a stray "0" to the
#      count, producing a multi-line FCOUNT that broke the integer
#      test. Symptom: any real-sized library reported "no audio
#      files found" and asked the user to confirm the path.
#
# v1.1.1.6 fixed a scanner SQL bug ("24 values for 23 columns") and
# dropped the /proc/asound bind-mount runc rejected on DietPi.
# Both still apply in v1.1.1.7.
#
# Once the container is running, future releases auto-update from
# Dropbox without anyone running this again. This script exists for
# first-time install + the rare release that needs a docker run
# command change.
#
# Usage:
#   curl -fsSL <link to install.sh>?dl=1 -o install.sh
#   chmod +x install.sh
#   ./install.sh
#
# What it does:
#   1. Asks where music lives, what port to use, whether to enable
#      backups (and where), what LMS host to point at, and whether
#      to expose USB audio hardware to the container
#   2. Validates each input as the user types
#   3. Shows a summary and asks for confirmation
#   4. Stops any existing musicd container (preserving its data dir)
#   5. Downloads the v1.1.1.5 tar from Dropbox (or uses local source
#      if running from inside an extracted tar)
#   6. Builds a fresh musicd:latest image
#   7. Starts the container as root with the chosen mounts and audio
#      flags
#
# It re-execs itself via sudo if not already root, since the host-side
# mkdir/chown/docker calls all need elevation.

set -e
set -u
set -o pipefail

# -- Configuration baked into this release -----------------------------
# IMPORTANT: Edit TAR_URL below before sharing this script. The
# placeholder below WILL NOT WORK -- you need to paste the actual share
# link to musicd-v1-1-1-5.tar from your Dropbox here. Make sure the
# URL ends with `dl=1` (not `dl=0`). The same URL you put in your
# manifest.json should work.
#
# Example:
#   TAR_URL="https://www.dropbox.com/scl/fi/abc123.../musicd-v1-1-2-11.tar?rlkey=xyz...&dl=1"
TAR_URL="https://www.dropbox.com/scl/fi/REPLACE_ME/musicd-v1-1-2-11.tar?rlkey=REPLACE_ME&dl=1"
TAR_FILENAME="musicd-v1-1-9-0.tar"
EXPECTED_VERSION="1.1.9.0"
MIN_TAR_BYTES=200000   # under this is almost certainly an error page

# Hardcoded paths -- the in-app updater script and other internal code
# expect exactly these on the host. The user CAN override the music
# dir, port, and backup dir via the prompts below.
HOST_DATA_DIR="/var/lib/musicd-data"
HOST_DOWNLOADS_DIR="/mnt/dietpi_userdata/downloads"
HOST_UPDATES_DIR="/mnt/dietpi_userdata/musicd_updates"

# Defaults shown to the user
DEFAULT_MUSIC_DIR="/mnt/dietpi_userdata/4tb"
DEFAULT_PORT="32700"
DEFAULT_LMS_HOST="127.0.0.1"
DEFAULT_BACKUPS_DIR="/mnt/dietpi_userdata/musicd_backups"
DEFAULT_AUDIO_GID="29"   # Debian/Ubuntu/DietPi default for the `audio` group

# Container internals
# UID/GID 1000 is the 'node' user inside the Debian Trixie base image,
# which is what the Dockerfile creates and what entrypoint.sh drops to
# via gosu. Host directories MUST be owned by 1000:1000 -- not by root,
# not by anything else -- because the node process runs as 1000 and
# needs to read/write /data, /mnt/musicd_updates etc.
#
# History (and a warning to my future self):
#
# v1.1.1.5 tried "run as root" by passing --user 0:0 to docker run and
# chowning the host dirs to root. This was wrong. The image's
# entrypoint.sh ends with `exec gosu node "$@"`, which unconditionally
# drops to UID 1000 regardless of what UID called the entrypoint.
# Docker's --user flag sets the UID at container start; gosu inside
# the entrypoint then drops to whatever it's told. Net effect: the
# node process always runs as 1000, and a /data dir owned by root
# produces "attempt to write a readonly database" SQLite errors on
# every write -- which is exactly the bug v1.1.1.7 fixes.
#
# If a future change really wants to run the app as root, the right
# move is to edit entrypoint.sh to skip the gosu drop when EUID is
# already 0, NOT to wrestle with --user. In the meantime: 1000:1000
# everywhere.
#
# Earlier still (pre-1.1.1.5): an Alpine-era version used UID 100/GID
# 101. The Dockerfile switched to Debian Trixie at some point and
# the docs lagged. Symptom of any wrong UID here: musicd boots, then
# scanner.js fails on every track with "attempt to write a readonly
# database" or "DATABASE INIT FAILED: unable to open database file".
CONTAINER_NAME="musicd"
CONTAINER_UID="1000"
CONTAINER_GID="1000"
IMAGE_TAG="musicd:latest"

# -- ANSI colours (with fallback) --------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  C_RESET="$(tput sgr0)"
  C_BOLD="$(tput bold)"
  C_BLUE="$(tput setaf 4)"
  C_GREEN="$(tput setaf 2)"
  C_RED="$(tput setaf 1)"
  C_YELLOW="$(tput setaf 3)"
  C_DIM="$(tput dim)"
else
  C_RESET="" ; C_BOLD="" ; C_BLUE="" ; C_GREEN="" ; C_RED="" ; C_YELLOW="" ; C_DIM=""
fi

say()    { echo "${C_BLUE}${1}${C_RESET}"; }
ok()     { echo "${C_GREEN}[ok] ${1}${C_RESET}"; }
warn()   { echo "${C_YELLOW}[!] ${1}${C_RESET}"; }
err()    { echo "${C_RED}[X] ${1}${C_RESET}" >&2; }
hr()     { echo "${C_DIM}--------------------------------------------------${C_RESET}"; }

# -- Re-exec via sudo if needed ----------------------------------------
if [ "$EUID" -ne 0 ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    err "This installer needs root for mkdir/chown/docker. Either run as root or install sudo."
    exit 1
  fi
  exec sudo bash "$0" "$@"
fi

# -- Banner ------------------------------------------------------------
clear || true
echo
say "${C_BOLD}==================================================${C_RESET}"
say "${C_BOLD}  musicd installer -- v${EXPECTED_VERSION}${C_RESET}"
say "${C_BOLD}==================================================${C_RESET}"
echo
echo "This installer will set up musicd on this machine, OR upgrade"
echo "an existing install to v${EXPECTED_VERSION}."
echo
echo "v${EXPECTED_VERSION} fixes a USB DAC regression that affected"
echo "anyone who installed via install.sh (rather than docker compose)."
echo "If your USB DACs stopped showing up, re-running this script will"
echo "rebuild the container with the correct audio passthrough flags."
echo
echo "After v${EXPECTED_VERSION} is running, future updates happen"
echo "automatically -- you won't need to run this script again."
echo

# -- Preflight: docker available ----------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  err "Docker is not installed."
  echo
  echo "On DietPi, run: ${C_BOLD}dietpi-software${C_RESET} and choose Docker (#162)."
  echo "On other Linux: see https://docs.docker.com/engine/install/"
  exit 1
fi

# Quick check that the daemon is actually running, not just the CLI
if ! docker info >/dev/null 2>&1; then
  err "Docker is installed but the daemon isn't running (or this user can't reach it)."
  echo "Try: ${C_BOLD}sudo systemctl start docker${C_RESET}"
  exit 1
fi
ok "Docker is available"

# Check that whoever shipped this script has filled in the TAR_URL.
# If they forgot, exit with a helpful message rather than confusing
# download errors later. The local-source path (running install.sh
# from inside an extracted tar) doesn't need the URL, so we only
# enforce this when no local source is available.
SCRIPT_DIR_EARLY="$(cd "$(dirname "$0")" && pwd)"
if [[ "$TAR_URL" == *"REPLACE_ME"* ]] && [ ! -f "${SCRIPT_DIR_EARLY}/VERSION" ]; then
  err "TAR_URL is not configured in this script."
  echo
  echo "Whoever sent you this installer needs to edit it and paste the"
  echo "real Dropbox share link. They should look at the comments near"
  echo "the top of install.sh."
  echo
  echo "Alternatively, if you have the ${TAR_FILENAME} file already,"
  echo "extract it and run install.sh from the extracted directory:"
  echo "  ${C_BOLD}tar -xf ${TAR_FILENAME}${C_RESET}"
  echo "  ${C_BOLD}sudo bash musicd/install.sh${C_RESET}"
  exit 1
fi

# -- Detect existing container and check version ----------------------
EXISTING_VERSION=""
EXISTING_STATE=""        # 'running' | 'stopped' | ''
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    EXISTING_STATE="running"
    EXISTING_VERSION="$(docker exec ${CONTAINER_NAME} cat /app/VERSION 2>/dev/null || true)"
  else
    EXISTING_STATE="stopped"
    # Container exists but isn't running. We can't docker exec into a
    # stopped container, but we can read VERSION from the image directly.
    # The image tag is musicd:latest; cat the file via a one-shot run.
    EXISTING_VERSION="$(docker run --rm --entrypoint cat ${IMAGE_TAG} /app/VERSION 2>/dev/null || true)"
  fi
fi

# Compare versions using sort -V (semver-aware). Returns 0 if a >= b.
# Empty 'a' counts as older-than-everything so the version check still
# works when VERSION can't be read.
version_ge() {
  local a="${1:-}" b="$2"
  if [ -z "$a" ]; then return 1; fi
  # If a == b, they're equal (>=). If sort -V puts b first, a is newer.
  if [ "$a" = "$b" ]; then return 0; fi
  local first
  first="$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)"
  [ "$first" = "$b" ]
}

if [ -n "$EXISTING_STATE" ]; then
  if [ -z "$EXISTING_VERSION" ]; then
    warn "Existing musicd container detected (${EXISTING_STATE}, version unknown)"
    echo "  Couldn't read /app/VERSION -- image may be old or built differently."
    echo "  Will install v${EXPECTED_VERSION} over it."
  elif version_ge "$EXISTING_VERSION" "$EXPECTED_VERSION"; then
    ok "musicd v${EXISTING_VERSION} is already installed (${EXISTING_STATE})"
    echo
    echo "This installer is for v${EXPECTED_VERSION} only. Your install is"
    echo "the same or newer, so there's nothing for this script to do."
    echo
    echo "Future updates will be applied automatically by musicd itself --"
    echo "you can check Settings -> Updates inside the app."
    echo
    read -rp "Reinstall v${EXPECTED_VERSION} anyway? [y/N] " forceit
    case "${forceit:-n}" in
      [Yy]|[Yy][Ee][Ss])
        warn "OK -- will downgrade/reinstall v${EXISTING_VERSION} -> v${EXPECTED_VERSION}"
        ;;
      *) echo "Aborted." ; exit 0 ;;
    esac
  else
    warn "Existing musicd v${EXISTING_VERSION} detected (${EXISTING_STATE})"
    echo "  Will upgrade to v${EXPECTED_VERSION}."
  fi
  echo
  echo "Continuing will:"
  echo "  * Stop and remove the existing container"
  echo "  * Replace it with v${EXPECTED_VERSION}"
  echo "  * Preserve your data dir (${HOST_DATA_DIR}) -- your library,"
  echo "    favourites, settings etc. survive intact"
  echo
  read -rp "Continue? [Y/n] " confirm
  case "${confirm:-y}" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *) echo "Aborted." ; exit 0 ;;
  esac
  echo
fi

# -- Q1: music directory ------------------------------------------------
hr
echo
say "${C_BOLD}1.${C_RESET} Where is your music library?"
echo "${C_DIM}This is the folder containing your music. It will be mounted${C_RESET}"
echo "${C_DIM}read-only inside the container. Inside the app you can pick${C_RESET}"
echo "${C_DIM}specific subfolders to scan from this root.${C_RESET}"
echo
while true; do
  read -rp "Music path [${DEFAULT_MUSIC_DIR}]: " MUSIC_DIR
  MUSIC_DIR="${MUSIC_DIR:-$DEFAULT_MUSIC_DIR}"
  if [ -d "$MUSIC_DIR" ]; then
    ok "Found: $MUSIC_DIR"
    # Quick file count to give the user confidence the path is right.
    # Caveats:
    #   * timeout 5s caps the search on slow network mounts so a
    #     misconfigured NFS share doesn't hang the installer.
    #   * We don't pipe to `head` here. Earlier versions did
    #     `find ... | head -10000 | wc -l` to bound the count, but on
    #     a library bigger than 10000 files head closed the pipe early,
    #     find died with SIGPIPE, and pipefail propagated that as a
    #     pipeline failure -- the `|| echo 0` fallback then APPENDED a
    #     "0" to wc's count, producing a multi-line string that broke
    #     the `[ -gt 0 ]` integer test below. Symptom: any library with
    #     10000+ files would falsely report "no audio files found".
    #   * Instead, we let find emit everything within the 5s budget and
    #     count with `wc -l`. On a real library that's a fraction of a
    #     second; on a misconfigured mount the timeout still saves us.
    #   * `2>/dev/null` swallows permission-denied chatter on /lost+found
    #     and similar. Stdout from a successful find is the only thing
    #     wc sees.
    #   * The whole expression is wrapped in `{ … } || echo 0` so a
    #     timeout exit doesn't kill the script under set -e + pipefail.
    #     `tr -d '[:space:]'` collapses any stray newline so FCOUNT is
    #     a clean integer regardless.
    FCOUNT="$( { timeout 5 find "$MUSIC_DIR" -maxdepth 4 -type f \( -iname '*.flac' -o -iname '*.mp3' -o -iname '*.wav' -o -iname '*.m4a' -o -iname '*.ogg' -o -iname '*.dsf' -o -iname '*.dff' \) 2>/dev/null | wc -l; } 2>/dev/null || echo 0 )"
    FCOUNT="$(echo "$FCOUNT" | tr -d '[:space:]')"
    # If for any reason FCOUNT is still not a clean integer, treat as 0.
    if ! [[ "$FCOUNT" =~ ^[0-9]+$ ]]; then FCOUNT=0; fi
    if [ "$FCOUNT" -gt 0 ]; then
      echo "  ${FCOUNT} audio files visible (sampled to depth 4)"
    else
      warn "  No audio files found at top level. Path may be wrong, or your music is deeper than 4 levels (or behind a slow mount)."
      read -rp "Use this path anyway? [y/N] " keep
      case "${keep:-n}" in [Yy]) ;; *) continue ;; esac
    fi
    break
  else
    err "Directory not found: $MUSIC_DIR"
    echo "  Try again, or Ctrl-C to abort."
  fi
done
echo

# -- Q2: port ----------------------------------------------------------
hr
echo
say "${C_BOLD}2.${C_RESET} Web UI port"
echo "${C_DIM}musicd's web interface listens on this port. The default${C_RESET}"
echo "${C_DIM}(${DEFAULT_PORT}) is fine unless something else uses it.${C_RESET}"
echo
while true; do
  read -rp "Port [${DEFAULT_PORT}]: " PORT
  PORT="${PORT:-$DEFAULT_PORT}"
  if [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -gt 0 ] && [ "$PORT" -lt 65536 ]; then
    # Try to detect if something's already listening (best-effort)
    if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then
      warn "Port ${PORT} is currently in use by another process"
      read -rp "Use it anyway? [y/N] " keep
      case "${keep:-n}" in [Yy]) ;; *) continue ;; esac
    fi
    ok "Will use port $PORT"
    break
  else
    err "Invalid port: $PORT"
  fi
done
echo

# -- Q3: backup ---------------------------------------------------------
hr
echo
say "${C_BOLD}3.${C_RESET} Enable the backup tool?"
echo "${C_DIM}musicd can create snapshots of its database (favourites, play${C_RESET}"
echo "${C_DIM}history, settings, cover art) to a host folder so you can${C_RESET}"
echo "${C_DIM}back them up offsite. Optional -- skip if you don't need it.${C_RESET}"
echo
read -rp "Enable backups? [Y/n] " enable_backup
case "${enable_backup:-y}" in
  [Yy]|[Yy][Ee][Ss])
    BACKUPS_ENABLED=1
    # Let the user pick where backups go. Default is the DietPi
    # standard location, but a user with an external/NAS mount may
    # want to point this elsewhere so backups land somewhere they
    # actually back up offsite.
    while true; do
      read -rp "Backup directory [${DEFAULT_BACKUPS_DIR}]: " HOST_BACKUPS_DIR
      HOST_BACKUPS_DIR="${HOST_BACKUPS_DIR:-$DEFAULT_BACKUPS_DIR}"
      # The directory may not exist yet -- we'll create it later. We
      # only validate that the parent exists, since creating a backup
      # dir under a non-existent mount point would silently land it
      # on the root filesystem instead of the intended NAS/USB drive.
      PARENT="$(dirname "$HOST_BACKUPS_DIR")"
      if [ -d "$PARENT" ]; then
        ok "Backups will be at: $HOST_BACKUPS_DIR"
        break
      else
        err "Parent directory doesn't exist: $PARENT"
        echo "  Make sure your backup destination is mounted, then try again."
      fi
    done
    ;;
  *)
    BACKUPS_ENABLED=0
    HOST_BACKUPS_DIR=""
    ok "Backups disabled (you can enable later by re-running this installer)"
    ;;
esac
echo

# -- Q4: LMS host -------------------------------------------------------
hr
echo
say "${C_BOLD}4.${C_RESET} Logitech Media Server host"
echo "${C_DIM}If you have an LMS / Lyrion Music Server somewhere on your${C_RESET}"
echo "${C_DIM}network, musicd can use it as a renderer. Default assumes${C_RESET}"
echo "${C_DIM}LMS is on this same machine. Leave blank to skip LMS support.${C_RESET}"
echo
read -rp "LMS host [${DEFAULT_LMS_HOST}, blank to skip]: " LMS_HOST
if [ -z "${LMS_HOST}" ]; then
  LMS_HOST=""
  ok "LMS support disabled"
else
  LMS_HOST="${LMS_HOST:-$DEFAULT_LMS_HOST}"
  ok "Will connect to LMS at $LMS_HOST"
fi
echo

# -- Q5: USB DAC passthrough -------------------------------------------
# v1.1.1.6: dropped /proc/asound bind-mount (runc rejects it on
# DietPi's stock kernel — detect.js falls back to aplay -l).
#
# What we add to docker run when this is enabled:
#   --device /dev/snd                    -- ALSA device nodes
#   --group-add <audio-gid>              -- /dev/snd permissions
#   -v /sys/class/thermal:...:ro         -- live CPU temp (#v1.1.0.94)
#
# Note: --group-add still works when the container is run as root.
# Root already has access to /dev/snd device nodes regardless, so
# the group is redundant for permissions, but we add it anyway for
# parity with docker-compose.yml and so the same flags work if
# someone later switches back to running as a non-root user.
hr
echo
say "${C_BOLD}5.${C_RESET} Expose USB audio hardware to the container?"
echo "${C_DIM}Required for USB DACs to appear in the Audio Devices page.${C_RESET}"
echo "${C_DIM}Adds: --device /dev/snd, audio group, thermal sensors.${C_RESET}"
echo "${C_DIM}Harmless to enable even if you have no USB DAC.${C_RESET}"
echo
read -rp "Enable USB DAC passthrough? [Y/n] " enable_audio
case "${enable_audio:-y}" in
  [Yy]|[Yy][Ee][Ss]) AUDIO_ENABLED=1 ;;
  *)                AUDIO_ENABLED=0 ;;
esac

if [ "$AUDIO_ENABLED" -eq 1 ]; then
  # Try to detect the host's audio GID. Fall back to the Debian/DietPi
  # default. The container runs as root so this is for parity with
  # docker-compose.yml; root already has /dev/snd access regardless.
  HOST_AUDIO_GID="$(getent group audio 2>/dev/null | cut -d: -f3 || true)"
  if [ -z "$HOST_AUDIO_GID" ]; then
    HOST_AUDIO_GID="$DEFAULT_AUDIO_GID"
    warn "Couldn't detect host audio GID via getent — defaulting to ${HOST_AUDIO_GID}"
  else
    ok "Detected host audio group GID: $HOST_AUDIO_GID"
  fi

  # Sanity-check that /proc/asound exists at all. We don't mount it
  # (v1.1.1.6 -- runc on DietPi's kernel rejects /proc bind-mounts
  # with "cannot be mounted because it is inside /proc"), but its
  # absence on the host means no audio drivers are loaded at all,
  # in which case USB DAC detection won't work no matter what we
  # mount. detect.js falls back to running `aplay -l` periodically
  # which only works if /dev/snd nodes exist, which only happens if
  # ALSA modules are loaded.
  if [ ! -d /proc/asound ]; then
    warn "/proc/asound doesn't exist on this host — no audio drivers loaded?"
    echo "  Continuing, but USB DAC detection won't work until kernel modules are loaded."
  fi
  ok "USB DAC passthrough enabled"
else
  HOST_AUDIO_GID=""
  ok "USB DAC passthrough disabled"
fi
echo

# -- Summary and confirmation -------------------------------------------
hr
echo
say "${C_BOLD}Summary${C_RESET}"
echo
echo "  Music library:   $MUSIC_DIR  (read-only)"
echo "  Web UI port:     $PORT"
if [ "$BACKUPS_ENABLED" -eq 1 ]; then
  echo "  Backups:         enabled at $HOST_BACKUPS_DIR"
else
  echo "  Backups:         disabled"
fi
if [ -n "$LMS_HOST" ]; then
  echo "  LMS host:        $LMS_HOST"
else
  echo "  LMS:             not configured"
fi
if [ "$AUDIO_ENABLED" -eq 1 ]; then
  echo "  USB DAC support: enabled (audio GID $HOST_AUDIO_GID)"
else
  echo "  USB DAC support: disabled"
fi
echo
echo "  Container user:  node (UID 1000) -- set by entrypoint via gosu"
echo "  Data directory:  $HOST_DATA_DIR  (persists across updates)"
echo "  Downloads dir:   $HOST_DOWNLOADS_DIR"
echo "  Updates dir:     $HOST_UPDATES_DIR"
echo
if [ -n "$EXISTING_STATE" ]; then
  if [ -n "$EXISTING_VERSION" ]; then
    echo "  Replacing:       existing v${EXISTING_VERSION} container (${EXISTING_STATE})"
  else
    echo "  Replacing:       existing musicd container, version unknown (${EXISTING_STATE})"
  fi
fi
echo
read -rp "Proceed with install? [Y/n] " final
case "${final:-y}" in
  [Yy]|[Yy][Ee][Ss]) ;;
  *) echo "Aborted." ; exit 0 ;;
esac
echo

# -- Step 1: directories ------------------------------------------------
# Container runs as root (UID 0), so host dirs are owned by root.
say "${C_BOLD}->${C_RESET} Creating host directories..."
mkdir -p "$HOST_DATA_DIR" "$HOST_DOWNLOADS_DIR" "$HOST_UPDATES_DIR"
chown -R "${CONTAINER_UID}:${CONTAINER_GID}" "$HOST_DATA_DIR" "$HOST_UPDATES_DIR"
chown "${CONTAINER_UID}:${CONTAINER_GID}" "$HOST_DOWNLOADS_DIR"
if [ "$BACKUPS_ENABLED" -eq 1 ]; then
  mkdir -p "$HOST_BACKUPS_DIR"
  chown "${CONTAINER_UID}:${CONTAINER_GID}" "$HOST_BACKUPS_DIR"
fi
ok "Directories ready"

# -- Step 2: stop existing container ------------------------------------
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  say "${C_BOLD}->${C_RESET} Stopping existing container..."
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
  ok "Existing container removed (data dir preserved)"
fi

# -- Step 3: download tar (or detect local extraction) -----------------
# If the script is being run from inside an already-extracted musicd
# tar (i.e. VERSION + Dockerfile are right next to install.sh), we skip
# the download and use the local source. This makes install.sh useful
# as the canonical install path whether the user got it via curl or
# inside the tar.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/VERSION" ] && [ -f "${SCRIPT_DIR}/Dockerfile" ]; then
  WORK_DIR="$SCRIPT_DIR/.."
  USE_LOCAL=1
  TAR_VERSION="$(cat "${SCRIPT_DIR}/VERSION" 2>/dev/null || echo unknown)"
  ok "Using local source from ${SCRIPT_DIR} (v${TAR_VERSION})"
  # Don't trap-rm the SCRIPT_DIR -- user owns it
  trap '' EXIT
  cd "${SCRIPT_DIR}"
else
  USE_LOCAL=0
  say "${C_BOLD}->${C_RESET} Downloading musicd v${EXPECTED_VERSION}..."
  TMP_TAR="/tmp/${TAR_FILENAME}"
  rm -f "$TMP_TAR"

  # Prefer curl (always installed on DietPi); fall back to wget. -L follows
  # redirects (Dropbox does redirect chains). -f makes curl exit non-zero on
  # 4xx/5xx so set -e catches a broken URL.
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fL --progress-bar -o "$TMP_TAR" "$TAR_URL"; then
      err "Download failed."
      echo "Check that the URL in this script is correct and that this machine has internet access."
      exit 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget --show-progress -O "$TMP_TAR" "$TAR_URL"; then
      err "Download failed."
      exit 1
    fi
  else
    err "Neither curl nor wget is available."
    exit 1
  fi

  # Sanity-check: did we get a real tar or a Dropbox HTML error page?
  TAR_SIZE="$(stat -c%s "$TMP_TAR" 2>/dev/null || stat -f%z "$TMP_TAR" 2>/dev/null || echo 0)"
  if [ "$TAR_SIZE" -lt "$MIN_TAR_BYTES" ]; then
    err "Downloaded file is too small (${TAR_SIZE} bytes)."
    echo "Probably an HTML error page rather than the tar -- check the URL."
    rm -f "$TMP_TAR"
    exit 1
  fi
  # tar magic bytes start with "ustar" at offset 257 -- quick check
  if ! file "$TMP_TAR" 2>/dev/null | grep -qi 'tar archive'; then
    warn "Downloaded file doesn't look like a tar archive. Continuing anyway, but extraction may fail."
  fi
  ok "Downloaded $(numfmt --to=iec --suffix=B "$TAR_SIZE" 2>/dev/null || echo "${TAR_SIZE} bytes")"

  # -- Step 4: extract ----------------------------------------------------
  say "${C_BOLD}->${C_RESET} Extracting..."
  WORK_DIR="$(mktemp -d -t musicd-install.XXXXXX)"
  trap 'rm -rf "$WORK_DIR" "$TMP_TAR"' EXIT
  tar -xf "$TMP_TAR" -C "$WORK_DIR"
  if [ ! -d "$WORK_DIR/musicd" ]; then
    err "Tar layout unexpected -- no 'musicd' directory inside."
    exit 1
  fi
  # Verify version matches
  TAR_VERSION="$(cat "$WORK_DIR/musicd/VERSION" 2>/dev/null || echo unknown)"
  if [ "$TAR_VERSION" != "$EXPECTED_VERSION" ]; then
    warn "Tar contains v${TAR_VERSION}, expected v${EXPECTED_VERSION} -- continuing anyway."
  fi
  ok "Extracted v${TAR_VERSION}"
  cd "$WORK_DIR/musicd"
fi

# -- Step 5: build ------------------------------------------------------
say "${C_BOLD}->${C_RESET} Building Docker image (this is slow on first install -- 5-10 min on a Pi)..."
echo "${C_DIM}---- docker build output ----${C_RESET}"
# WORK_DIR is set above, either to a temp extraction dir (then we cd'd
# into musicd subdir) or to the script's parent (already cd'd).
if ! docker build -t "$IMAGE_TAG" . ; then
  err "Build failed. See output above."
  exit 1
fi
echo "${C_DIM}---- end docker build output ----${C_RESET}"
ok "Image built: $IMAGE_TAG"

# -- Step 6: start container --------------------------------------------
say "${C_BOLD}->${C_RESET} Starting container..."

# Build the docker run argument list. We append optional mounts/env
# vars so disabling backup, LMS or USB DAC produces a leaner command.
#
# Note: no --user flag. The image's entrypoint.sh handles UID itself
# -- it boots as root briefly to set up host docker socket group
# membership, then `exec gosu node "$@"` drops to UID 1000 for the
# real node process. Setting --user here would only constrain what
# the entrypoint runs as, which doesn't help anything (gosu still
# drops afterwards) and could break the docker-socket setup that
# only works as root. So we leave it alone and let the entrypoint
# do its thing. See CONTAINER_UID notes near the top of this file.
DOCKER_ARGS=(
  run -d
  --name "$CONTAINER_NAME"
  --network host
  -v "${MUSIC_DIR}:/music:ro"
  -v "${HOST_DATA_DIR}:/data"
  -v "/var/run/docker.sock:/var/run/docker.sock"
  -v "${HOST_DOWNLOADS_DIR}:/mnt/downloads"
  -v "${HOST_UPDATES_DIR}:/mnt/musicd_updates"
)
if [ "$BACKUPS_ENABLED" -eq 1 ]; then
  DOCKER_ARGS+=(-v "${HOST_BACKUPS_DIR}:/mnt/backups")
fi

# v1.1.1.5+: USB DAC passthrough. These flags + the thermal mount
# are most of what docker-compose.yml ships. The /proc/asound bind
# mount that compose has is deliberately omitted here -- on
# DietPi's stock kernel runc rejects bind-mounts inside /proc, and
# detect.js falls back to running `aplay -l` when the proc mount
# isn't there, so USB DACs still detect (just with slightly slower
# hot-plug response). Without /dev/snd the container has no view
# of host audio hardware (#v1.1.0.93), and without the thermal
# mount the metadata scheduler's CPU-temp throttle reads a stuck
# ACPI sensor (#v1.1.0.94). Both are harmless when not needed.
if [ "$AUDIO_ENABLED" -eq 1 ]; then
  DOCKER_ARGS+=(--device /dev/snd)
  DOCKER_ARGS+=(-v /sys/class/thermal:/sys/class/thermal:ro)
  DOCKER_ARGS+=(--group-add "$HOST_AUDIO_GID")
fi

DOCKER_ARGS+=(-e "PORT=${PORT}")
if [ -n "$LMS_HOST" ]; then
  DOCKER_ARGS+=(-e "LMS_HOST=${LMS_HOST}")
fi
DOCKER_ARGS+=(--restart unless-stopped)
DOCKER_ARGS+=("$IMAGE_TAG")

if ! docker "${DOCKER_ARGS[@]}" >/dev/null; then
  err "docker run failed."
  exit 1
fi
ok "Container started"

# -- Step 7: verify it's actually serving -------------------------------
say "${C_BOLD}->${C_RESET} Waiting for musicd to come up..."
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-127.0.0.1}"
URL="http://${HOST_IP}:${PORT}"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fs --max-time 2 "${URL}/api/library/status" >/dev/null 2>&1; then
    ok "musicd is responding at ${URL}"
    break
  fi
  sleep 1
done

# -- Done ---------------------------------------------------------------
echo
hr
echo
say "${C_BOLD}${C_GREEN}Install complete!${C_RESET}"
echo
echo "  Open ${C_BOLD}${URL}${C_RESET} in a browser"
echo
if [ "$BACKUPS_ENABLED" -eq 0 ]; then
  echo "  ${C_DIM}Backups are disabled. Re-run this script to enable them later.${C_RESET}"
  echo
fi
if [ "$AUDIO_ENABLED" -eq 1 ]; then
  echo "  ${C_DIM}USB DACs (if any plugged in) should appear in Settings ->${C_RESET}"
  echo "  ${C_DIM}Audio Devices within ~10 seconds. If not, hit Diagnose on${C_RESET}"
  echo "  ${C_DIM}that page for a checklist of what went wrong.${C_RESET}"
  echo
fi
echo "  Container logs:    ${C_BOLD}docker logs -f ${CONTAINER_NAME}${C_RESET}"
echo "  Stop musicd:       ${C_BOLD}docker stop ${CONTAINER_NAME}${C_RESET}"
echo "  Start musicd:      ${C_BOLD}docker start ${CONTAINER_NAME}${C_RESET}"
echo
echo "Future updates will install themselves automatically -- no need"
echo "to run this script again."
echo
