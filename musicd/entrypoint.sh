#!/bin/bash
# musicd entrypoint
#
# Runs as root briefly to detect host docker socket GID, adds the musicd user
# (UID 1000) to that group so it can talk to docker for auto-updates, then
# drops to the unprivileged user via gosu.
#
# If the docker socket isn't mounted (e.g. user didn't enable auto-update),
# we just continue as 1000 with no docker access. Auto-update will report
# "no socket" gracefully in that case.
set -e

DOCKER_SOCK=/var/run/docker.sock
USERNAME=$(getent passwd 1000 | cut -d: -f1)
if [ -z "$USERNAME" ]; then
  # Fallback: shouldn't happen since the Dockerfile creates UID 1000
  USERNAME=node
fi

if [ -S "$DOCKER_SOCK" ]; then
  SOCK_GID=$(stat -c '%g' "$DOCKER_SOCK")
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" -ne 0 ]; then
    # Create a group with that GID if it doesn't already exist
    if ! getent group "$SOCK_GID" >/dev/null; then
      groupadd -g "$SOCK_GID" hostdocker
    fi
    GRPNAME=$(getent group "$SOCK_GID" | cut -d: -f1)
    usermod -aG "$GRPNAME" "$USERNAME" 2>/dev/null || true
    echo "[entrypoint] added $USERNAME to host docker group ($GRPNAME, GID $SOCK_GID)"
  fi
fi

# Pending-restore handling (#v1.1.0.2). The in-app restore endpoint
# stages a backup at /data/.pending-restore/ and asks for a container
# restart. On boot we check for that staging dir; if present we swap
# its musicd.db (and dsp/ subfolder if present) into place atomically
# before the app starts. This is the only safe time to overwrite the
# DB -- doing it while the app is running would corrupt SQLite WAL
# state.
PENDING_DIR=/data/.pending-restore
if [ -d "$PENDING_DIR" ] && [ -f "$PENDING_DIR/musicd.db" ]; then
  echo "[entrypoint] pending restore detected -- swapping in /data/.pending-restore"
  # Make a safety copy of the current DB next to the pending dir.
  # If the restore fails or the app refuses to start with the new
  # DB, the user can recover by stopping the container and copying
  # /data/.pre-restore-musicd.db back.
  if [ -f /data/musicd.db ]; then
    cp -a /data/musicd.db "/data/.pre-restore-musicd.db" || true
  fi
  # Atomic swap of the DB file. mv is atomic within /data.
  mv "$PENDING_DIR/musicd.db" /data/musicd.db
  # Optional DSP folders
  if [ -d "$PENDING_DIR/dsp" ]; then
    rm -rf /data/dsp.before-restore || true
    if [ -d /data/dsp ]; then mv /data/dsp /data/dsp.before-restore; fi
    mv "$PENDING_DIR/dsp" /data/dsp
  fi
  # Optional images (cover art + artist logos). Backups since
  # v1.1.0.2 may include these.
  for imgdir in coverart artistlogos; do
    if [ -d "$PENDING_DIR/$imgdir" ]; then
      rm -rf "/data/$imgdir.before-restore" || true
      if [ -d "/data/$imgdir" ]; then mv "/data/$imgdir" "/data/$imgdir.before-restore"; fi
      mv "$PENDING_DIR/$imgdir" "/data/$imgdir"
    fi
  done
  # Remove staging dir
  rm -rf "$PENDING_DIR"
  # Ownership in case a stray file slipped in as root
  chown -R 1000:1000 /data/musicd.db /data/dsp /data/coverart /data/artistlogos 2>/dev/null || true
  echo "[entrypoint] restore complete (previous DB saved as /data/.pre-restore-musicd.db)"
fi

# Auto-heal mount-dir ownership (#v1.1.0.5, expanded #v1.1.1.7).
# /mnt/musicd_updates, /mnt/downloads, /mnt/backups, and /data are
# bind-mounts from the host. If anything in them is owned by a UID
# other than 1000, the node process (UID 1000) can't write -- which
# manifests as EACCES on the auto-updater (#v1.1.0.5) or as SQLite
# "attempt to write a readonly database" on every track scan
# (#v1.1.1.5/.6 regression caused by a misguided "run as root"
# experiment in the installer that chowned /data to root).
# This self-healer fixes both classes of broken install on the next
# container restart, no manual intervention needed.
# We do this BEFORE dropping to the unprivileged user, while still
# root, so we have the perms to chown.
# Failures are non-fatal: if a mount isn't there or is read-only, we
# just continue. The relevant feature surfaces the clearer error.
for mount in /mnt/musicd_updates /mnt/downloads /mnt/backups /data; do
  if [ -d "$mount" ]; then
    chown -R 1000:1000 "$mount" 2>/dev/null || true
  fi
done

# Drop to UID 1000 with full group membership (gosu honours supplementary
# groups when given a username, but not when given numeric uid:gid).
exec gosu "$USERNAME" "$@"
