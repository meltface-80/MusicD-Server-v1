#!/bin/bash
# musicd v1.1.0.48 — native (non-Docker) installer for DietPi / Debian.
#
# Run as your normal user (NOT root). Will sudo as needed.
#
#   bash install-native.sh
#
# What this does:
#   - apt-installs Node 20, ffmpeg, loudgain, libchromaprint-tools, sqlite3
#   - creates `musicd` system user
#   - extracts the source to /opt/musicd
#   - npm ci (server) + npm run build (client)
#   - installs /etc/systemd/system/musicd.service
#   - installs /etc/sudoers.d/musicd (scoped: just `systemctl restart musicd`)
#   - if a Docker musicd container is running, offers to stop/remove it
#     and migrate the database
#   - starts the service and verifies the API answers
#
# Idempotent: re-running upgrades the source in place without losing data.

set -u

# =============================================================================
# EDIT THESE TO MATCH YOUR SETUP
# =============================================================================

MUSIC_DIR="/mnt/dietpi_userdata/4tb"
WEB_PORT="32700"
LMS_HOST="127.0.0.1"

# Tar URL. Override with: TAR_URL=... bash install-native.sh
TAR_URL="${TAR_URL:-https://www.dropbox.com/scl/fi/PLACEHOLDER/musicd-v1-1-0-48.tar?dl=1}"

# =============================================================================

INSTALL_DIR="/opt/musicd"
STATE_DIR="/var/lib/musicd"
UNIT_FILE="/etc/systemd/system/musicd.service"
SUDOERS_FILE="/etc/sudoers.d/musicd"

if [ "$(id -u)" = "0" ]; then
  echo "Run as your normal user, not root. The script will sudo where needed."
  exit 1
fi

if [ ! -d "$MUSIC_DIR" ]; then
  echo "MUSIC_DIR=$MUSIC_DIR doesn't exist. Edit the top of this script."
  exit 1
fi

echo ""
echo "musicd native install"
echo "  Tar URL    : $TAR_URL"
echo "  Music dir  : $MUSIC_DIR (read-only)"
echo "  Web port   : $WEB_PORT"
echo "  LMS host   : ${LMS_HOST:-(disabled)}"
echo "  Install at : $INSTALL_DIR"
echo "  State at   : $STATE_DIR"
echo ""

# --- detect existing Docker install -----------------------------------------
HAVE_DOCKER_INSTALL=0
if command -v docker >/dev/null 2>&1; then
  if sudo docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^musicd$'; then
    HAVE_DOCKER_INSTALL=1
  fi
fi

if [ "$HAVE_DOCKER_INSTALL" = "1" ]; then
  echo "Existing musicd Docker container detected."
  echo "Native install will:"
  echo "  - stop and remove the container"
  echo "  - keep your database (it's already at $STATE_DIR/musicd.db or $STATE_DIR/data/musicd.db)"
  echo "  - migrate the DB to the layout the native install expects, if needed"
  echo "  - leave musicd:* Docker images in place (you can `docker rmi` them later)"
  echo ""
  read -r -p "Proceed with migration to native install? (y/N) " CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi
else
  read -r -p "Proceed with fresh native install? (y/N) " CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi
fi

# --- apt deps ---------------------------------------------------------------
echo ""
echo "[1/9] Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  curl ca-certificates \
  ffmpeg loudgain libchromaprint-tools alsa-utils \
  sqlite3 \
  build-essential python3

# Node 20: prefer DietPi/Debian package if it's >= 20, else use NodeSource.
NODE_VERSION_OK=0
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\)\..*/\1/')
  if [ "$CURRENT_NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    NODE_VERSION_OK=1
    echo "Existing Node $(node -v) is OK."
  fi
fi
if [ "$NODE_VERSION_OK" = "0" ]; then
  echo "Installing Node 20 from NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# --- musicd user ------------------------------------------------------------
echo "[2/9] Creating musicd system user..."
if ! id -u musicd >/dev/null 2>&1; then
  sudo useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin musicd
fi
# Add musicd to audio group so it can use ALSA/USB DACs
sudo usermod -aG audio musicd 2>/dev/null || true

MUSICD_UID=$(id -u musicd)
MUSICD_GID=$(id -g musicd)
echo "      musicd UID=$MUSICD_UID GID=$MUSICD_GID"

# --- stop docker container if migrating -------------------------------------
if [ "$HAVE_DOCKER_INSTALL" = "1" ]; then
  echo "[3/9] Stopping and removing existing Docker container..."
  sudo docker stop musicd 2>/dev/null
  sudo docker rm musicd 2>/dev/null
else
  echo "[3/9] (skipped: no Docker install to migrate)"
fi

# --- state dir layout -------------------------------------------------------
echo "[4/9] Setting up state directory at $STATE_DIR..."
sudo mkdir -p "$STATE_DIR"
sudo mkdir -p "$STATE_DIR/data"
sudo mkdir -p "$STATE_DIR/downloads"
sudo mkdir -p "$STATE_DIR/backups"
sudo mkdir -p "$STATE_DIR/updates/pending"

# Migrate database if it's in the legacy flat-layout location.
if [ -f "$STATE_DIR/musicd.db" ] && [ ! -f "$STATE_DIR/data/musicd.db" ]; then
  echo "      migrating DB from flat layout to data/ subdir"
  sudo mv "$STATE_DIR/musicd.db" "$STATE_DIR/data/musicd.db" 2>/dev/null
  sudo mv "$STATE_DIR/musicd.db-wal" "$STATE_DIR/data/musicd.db-wal" 2>/dev/null
  sudo mv "$STATE_DIR/musicd.db-shm" "$STATE_DIR/data/musicd.db-shm" 2>/dev/null
fi

sudo chown -R musicd:musicd "$STATE_DIR"

# --- download + extract source ----------------------------------------------
echo "[5/9] Downloading source tar..."
WORK_DIR=$(mktemp -d)
TAR_PATH="$WORK_DIR/musicd.tar"
curl -fL --progress-bar -o "$TAR_PATH" "$TAR_URL" || {
  echo "Download failed."; rm -rf "$WORK_DIR"; exit 1;
}
TAR_BYTES=$(stat -c %s "$TAR_PATH")
if [ "$TAR_BYTES" -lt 200000 ]; then
  echo "Tar too small ($TAR_BYTES bytes). Probably a Dropbox HTML page."
  rm -rf "$WORK_DIR"; exit 1
fi

echo "[6/9] Extracting to $INSTALL_DIR (preserving prior install as .previous/)..."
# If installing over an existing native install, archive it.
if [ -d "$INSTALL_DIR/server" ]; then
  sudo rm -rf "$INSTALL_DIR/.previous"
  sudo mkdir -p "$INSTALL_DIR/.previous"
  for item in server client VERSION CHANGELOG.md; do
    if [ -e "$INSTALL_DIR/$item" ]; then
      sudo mv "$INSTALL_DIR/$item" "$INSTALL_DIR/.previous/" || true
    fi
  done
fi
sudo mkdir -p "$INSTALL_DIR"
sudo tar -xf "$TAR_PATH" -C "$INSTALL_DIR" --strip-components=1
sudo chown -R musicd:musicd "$INSTALL_DIR"
rm -rf "$WORK_DIR"

INSTALLED_VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null | tr -d '\n\r')
echo "      installed version: $INSTALLED_VERSION"

# --- install deps + build client --------------------------------------------
echo "[7/9] Installing server deps..."
sudo -u musicd npm ci --omit=dev --prefix "$INSTALL_DIR/server"

echo "      Building client..."
if [ ! -d "$INSTALL_DIR/client/dist" ]; then
  sudo -u musicd npm ci --prefix "$INSTALL_DIR/client"
  sudo -u musicd npm run build --prefix "$INSTALL_DIR/client"
else
  echo "      (skipped: client/dist already present in tar)"
fi

# --- systemd unit -----------------------------------------------------------
echo "[8/9] Writing systemd unit..."

LMS_ENV=""
if [ -n "$LMS_HOST" ]; then
  LMS_ENV="Environment=\"LMS_HOST=$LMS_HOST\""
fi

# Heredoc into a tmp file then sudo install -- avoids tee/permission games.
UNIT_TMP=$(mktemp)
cat > "$UNIT_TMP" <<UNIT
[Unit]
Description=musicd self-hosted music server
After=network.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=musicd
Group=musicd
WorkingDirectory=$INSTALL_DIR
Environment="NODE_ENV=production"
Environment="MUSICD_MODE=systemd"
Environment="PORT=$WEB_PORT"
Environment="MUSIC_ROOT=$MUSIC_DIR"
Environment="DB_PATH=$STATE_DIR/data/musicd.db"
$LMS_ENV
ExecStart=/usr/bin/node $INSTALL_DIR/server/src/index.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$STATE_DIR $INSTALL_DIR
ReadOnlyPaths=$MUSIC_DIR

[Install]
WantedBy=multi-user.target
UNIT
sudo install -m 0644 "$UNIT_TMP" "$UNIT_FILE"
rm -f "$UNIT_TMP"

# --- sudoers ----------------------------------------------------------------
echo "      Writing sudoers entry for self-restart..."
SUDOERS_TMP=$(mktemp)
cat > "$SUDOERS_TMP" <<SUDOERS
# Allow the musicd user to restart its own service via sudo without
# password. Scoped to ONLY systemctl restart musicd. The in-app updater
# uses this after applying a tar to bring the new code into service.
musicd ALL=(root) NOPASSWD: /bin/systemctl restart musicd
SUDOERS
# visudo -c to validate before installing -- if the file is malformed
# we leave the system in a working state.
sudo visudo -c -f "$SUDOERS_TMP" >/dev/null
sudo install -m 0440 "$SUDOERS_TMP" "$SUDOERS_FILE"
rm -f "$SUDOERS_TMP"

# --- start the service ------------------------------------------------------
echo "[9/9] Starting service..."
sudo systemctl daemon-reload
sudo systemctl enable musicd
sudo systemctl restart musicd

# Wait for API
echo "      Waiting for API..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$WEB_PORT/api/healthz" >/dev/null 2>&1; then
    REPORTED=$(curl -fsS "http://127.0.0.1:$WEB_PORT/api/version" 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    echo ""
    echo "Done. musicd v$REPORTED is running on port $WEB_PORT."
    echo ""
    echo "Useful commands:"
    echo "  sudo systemctl status musicd       # check service health"
    echo "  sudo journalctl -u musicd -f       # tail logs"
    echo "  sudo systemctl restart musicd      # restart"
    echo ""
    exit 0
  fi
  sleep 1
done

echo ""
echo "WARNING: API didn't respond within 30s. Check logs:"
echo "  sudo journalctl -u musicd -n 50 --no-pager"
exit 1
