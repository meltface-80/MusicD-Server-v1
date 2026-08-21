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
# The PUBLISHED face of the release — README.md and the GitHub Pages site —
# lives one level further up, beside the tarball and the manifest. Both sat
# seven releases behind before v1.1.28.0 because nothing here touched them and
# nothing tested them. They are rewritten below and verified with everything
# else; see the release checklist in CLAUDE.md.
REPO_ROOT="$(cd "$ROOT/.." && pwd)"

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
if [ -f "$REPO_ROOT/README.md" ]; then
  add_change "README.md current release:   'v$CURRENT_VERSION' → 'v$VERSION_DOTS'"
fi
if [ -f "$REPO_ROOT/docs/index.html" ]; then
  add_change "docs/index.html version:     'v$CURRENT_VERSION' → 'v$VERSION_DOTS'"
fi

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

# README.md and the Pages site. Only the CURRENT-release references are
# rewritten: both files also talk about v1.1.3.7 and v1.1.9.0 in upgrade notes,
# and those are history, not a version to bump. Every pattern below is anchored
# to a phrase that only the current release uses, which is also what makes the
# verify step below able to tell "updated" from "never matched".
if [ -f "$REPO_ROOT/README.md" ]; then
  sed -i.bak \
    -e "s/\*\*Current release:\*\* v$CURRENT_VERSION/**Current release:** v$VERSION_DOTS/" \
    -e "s/(React\/Vite), v$CURRENT_VERSION/(React\/Vite), v$VERSION_DOTS/" \
    -e "s/musicd-v$CURRENT_DASHES\.tar/musicd-v$VERSION_DASHES.tar/g" \
    -e "s/is over — v$CURRENT_VERSION has/is over — v$VERSION_DOTS has/" \
    -e "s/so it will offer v$CURRENT_VERSION and/so it will offer v$VERSION_DOTS and/" \
    "$REPO_ROOT/README.md"
  rm -f "$REPO_ROOT/README.md.bak"
fi

if [ -f "$REPO_ROOT/docs/index.html" ]; then
  sed -i.bak \
    -e "s/MusicD Server v$CURRENT_VERSION/MusicD Server v$VERSION_DOTS/g" \
    -e "s/<span class=\"badge\">v$CURRENT_VERSION<\/span>/<span class=\"badge\">v$VERSION_DOTS<\/span>/" \
    -e "s/What&rsquo;s new in $CURRENT_VERSION/What\&rsquo;s new in $VERSION_DOTS/" \
    -e "s/&mdash; v$CURRENT_VERSION has the same URL/\&mdash; v$VERSION_DOTS has the same URL/" \
    "$REPO_ROOT/docs/index.html"
  rm -f "$REPO_ROOT/docs/index.html.bak"
fi

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
if [ -f "$REPO_ROOT/README.md" ]; then
  verify "$REPO_ROOT/README.md"      "Current release:\*\* v$VERSION_DOTS"        "README.md current release"
  verify "$REPO_ROOT/README.md"      "musicd-v$VERSION_DASHES\.tar"                "README.md tarball name"
fi
if [ -f "$REPO_ROOT/docs/index.html" ]; then
  verify "$REPO_ROOT/docs/index.html" "badge\">v$VERSION_DOTS<"                     "docs/index.html badge"
  verify "$REPO_ROOT/docs/index.html" "MusicD Server v$VERSION_DOTS"                "docs/index.html version"
  verify "$REPO_ROOT/docs/index.html" "new in $VERSION_DOTS"                        "docs/index.html What's new heading"
fi
echo

if [ "$ERRORS" -gt 0 ]; then
  echo "✗ $ERRORS verification(s) failed. Inspect the files manually." >&2
  exit 1
fi

echo "Reminders:"
echo "  • Add a CHANGELOG.md entry for v$VERSION_DOTS (the script doesn't write release notes)."
echo "  • Rewrite the What's-new CARDS in docs/index.html for v$VERSION_DOTS."
echo "    The heading above them was bumped; the prose under it was not, and a"
echo "    heading that says $VERSION_DOTS over last release's cards is worse than a"
echo "    stale heading, because it reads as current."
echo "  • Check README.md still describes what the app does — features, not just"
echo "    the version number the sed above rewrote."
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
