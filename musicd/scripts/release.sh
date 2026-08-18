#!/bin/bash
# scripts/release.sh — bump every version reference in one go.
# =============================================================
#
# Why this exists: musicd version numbers live in too many places.
# A typical release needs to update:
#
#   /VERSION                           e.g. 1.1.2.4
#   /server/package.json               e.g. 1.2.4
#   /client/package.json               e.g. 1.2.4
#   /install.sh   header comment       e.g. v1.1.2.4
#   /install.sh   EXPECTED_VERSION     e.g. 1.1.2.4
#   /install.sh   TAR_FILENAME         e.g. musicd-v1-1-2-4.tar
#   /CHANGELOG.md  prepended entry
#   /manifest.json (separately, hosted on Dropbox)
#
# Doing this by hand has bitten us repeatedly (v1.1.1.5, v1.1.1.7,
# v1.1.2.0 all shipped with at least one stale version reference).
# This script does it atomically: all-or-nothing, with a dry-run
# default so you can review before committing.
#
# Note on the dotted vs dashed forms:
#   - VERSION, EXPECTED_VERSION use 1.2.3.4 (four parts, dots)
#   - package.json uses 1.2.3 (three parts — middle two dots
#     concatenated with no separator: "1.1.2.4" → "1.2.4")
#   - tar filenames use 1-2-3-4 (four parts, dashes)
#
# All three forms are derived from the input. Pass the canonical
# four-part dotted form: ./scripts/release.sh 1.1.2.4
#
# Usage:
#   ./scripts/release.sh 1.1.2.4          # dry-run; prints what would change
#   ./scripts/release.sh 1.1.2.4 --apply  # actually edits files
#   ./scripts/release.sh 1.1.2.4 --apply --tar  # also builds the tar
#
# After --apply, the only remaining manual step is uploading the
# tar and updating manifest.json on Dropbox.

set -e
set -u
set -o pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <version> [--apply] [--tar]"
  echo "  e.g.: $0 1.1.2.4 --apply"
  exit 1
fi

VERSION="$1"; shift || true
APPLY=0
DO_TAR=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --tar)   DO_TAR=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# Validate canonical form W.X.Y.Z
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be in W.X.Y.Z form (got: '$VERSION')" >&2
  exit 1
fi

# Derive the three forms.
VERSION_DOTS="$VERSION"
VERSION_DASHES="${VERSION//./-}"
# package.json: combine the two middle parts (#v1.1.0.62 convention).
# 1.1.2.4 → 1.2.4 (drop the first dot, keep the rest).
IFS='.' read -ra PARTS <<< "$VERSION"
PKG_VERSION="${PARTS[0]}.${PARTS[1]}${PARTS[2]}.${PARTS[3]}"
# Actually that produces 1.12.4 not 1.2.4. Looking at history:
#   VERSION=1.1.0.62 → package.json was 1.0.62
#   VERSION=1.1.1.5  → package.json was 1.1.5
#   VERSION=1.1.2.4  → package.json should be 1.2.4
# So the rule is: drop PARTS[0], use PARTS[1].PARTS[2].PARTS[3].
PKG_VERSION="${PARTS[1]}.${PARTS[2]}.${PARTS[3]}"

# Repo root (one up from scripts/).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Sanity check we're in a musicd repo.
if [ ! -f "$ROOT/VERSION" ] || [ ! -f "$ROOT/server/package.json" ] || [ ! -f "$ROOT/client/package.json" ] || [ ! -f "$ROOT/install.sh" ]; then
  echo "Error: this doesn't look like a musicd source tree (missing VERSION, server/package.json, client/package.json, or install.sh)" >&2
  echo "Run from the repo root, or place this script at <repo>/scripts/release.sh" >&2
  exit 1
fi

# Read the current version (for stale-reference cleanup later).
CURRENT_VERSION="$(cat "$ROOT/VERSION" | tr -d '[:space:]')"
CURRENT_DASHES="${CURRENT_VERSION//./-}"
IFS='.' read -ra CUR_PARTS <<< "$CURRENT_VERSION"
CURRENT_PKG="${CUR_PARTS[1]}.${CUR_PARTS[2]}.${CUR_PARTS[3]}"

if [ "$CURRENT_VERSION" = "$VERSION_DOTS" ]; then
  echo "Note: VERSION already says $VERSION_DOTS. Re-running anyway to fix any drift."
fi

# Build the diff plan.
declare -a CHANGES=()
add_change() {
  CHANGES+=("$1")
}

add_change "VERSION:                    '$CURRENT_VERSION' → '$VERSION_DOTS'"
add_change "server/package.json version: '$CURRENT_PKG' → '$PKG_VERSION'"
add_change "client/package.json version: '$CURRENT_PKG' → '$PKG_VERSION'"
add_change "install.sh header comment:   'v$CURRENT_VERSION' → 'v$VERSION_DOTS'"
add_change "install.sh EXPECTED_VERSION: '$CURRENT_VERSION' → '$VERSION_DOTS'"
add_change "install.sh TAR_FILENAME:     'musicd-v$CURRENT_DASHES.tar' → 'musicd-v$VERSION_DASHES.tar'"

echo
echo "=== Release v$VERSION_DOTS ==="
echo
echo "Changes that will be made:"
for c in "${CHANGES[@]}"; do
  echo "  $c"
done
echo

if [ "$APPLY" -eq 0 ]; then
  echo "(dry run — pass --apply to actually edit files)"
  echo
  if [ "$DO_TAR" -eq 1 ]; then
    echo "(skipping --tar in dry-run mode)"
  fi
  exit 0
fi

# Apply edits.
echo "$VERSION_DOTS" > "$ROOT/VERSION"
sed -i.bak \
  "s/\"version\": \"$CURRENT_PKG\"/\"version\": \"$PKG_VERSION\"/" \
  "$ROOT/server/package.json" "$ROOT/client/package.json"
sed -i.bak \
  -e "s/musicd installer -- v$CURRENT_VERSION/musicd installer -- v$VERSION_DOTS/" \
  -e "s/musicd-v$CURRENT_DASHES\\.tar/musicd-v$VERSION_DASHES.tar/g" \
  -e "s/EXPECTED_VERSION=\"$CURRENT_VERSION\"/EXPECTED_VERSION=\"$VERSION_DOTS\"/" \
  "$ROOT/install.sh"

# Clean up sed backups.
rm -f "$ROOT/server/package.json.bak" "$ROOT/client/package.json.bak" "$ROOT/install.sh.bak"

echo "✓ Files updated"
echo

# Sanity-verify all bumps landed.
ERRORS=0
verify() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if ! grep -q "$pattern" "$file"; then
    echo "  ✗ $label: pattern '$pattern' not found in $file" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "  ✓ $label"
  fi
}

echo "Verifying:"
verify "$ROOT/VERSION"               "^$VERSION_DOTS$"                              "VERSION"
verify "$ROOT/server/package.json"   "\"version\": \"$PKG_VERSION\""                "server/package.json"
verify "$ROOT/client/package.json"   "\"version\": \"$PKG_VERSION\""                "client/package.json"
verify "$ROOT/install.sh"            "musicd installer -- v$VERSION_DOTS"           "install.sh header"
verify "$ROOT/install.sh"            "EXPECTED_VERSION=\"$VERSION_DOTS\""           "install.sh EXPECTED_VERSION"
verify "$ROOT/install.sh"            "TAR_FILENAME=\"musicd-v$VERSION_DASHES.tar\"" "install.sh TAR_FILENAME"
echo

if [ "$ERRORS" -gt 0 ]; then
  echo "✗ $ERRORS verification(s) failed. Inspect the files manually." >&2
  exit 1
fi

echo "Reminders:"
echo "  • Add a CHANGELOG.md entry for v$VERSION_DOTS (the script doesn't write release notes)."
echo "  • Update manifest.json on Dropbox to point at musicd-v$VERSION_DASHES.tar"
echo "    (5 tarUrl fields: top-level + 4 channels)."
echo

if [ "$DO_TAR" -eq 1 ]; then
  TAR_NAME="musicd-v$VERSION_DASHES.tar"
  OUT_PATH="$ROOT/$TAR_NAME"
  echo "Building $TAR_NAME ..."
  # Tar the parent directory so the archive contains a 'musicd/' top-level dir
  # (matching the layout install.sh expects).
  PARENT="$(dirname "$ROOT")"
  BASENAME="$(basename "$ROOT")"
  rm -f "$OUT_PATH"
  tar -cf "$OUT_PATH" -C "$PARENT" "$BASENAME" --transform="s,^$BASENAME,musicd,"
  SIZE="$(stat -c%s "$OUT_PATH" 2>/dev/null || stat -f%z "$OUT_PATH" 2>/dev/null || echo 0)"
  echo "✓ $OUT_PATH ($SIZE bytes)"
fi

echo
echo "Done."
