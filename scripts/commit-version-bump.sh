#!/usr/bin/env bash
#
# Usage: scripts/commit-version-bump.sh [version]
#
# Bumps package.json, creates a signed release commit, and adds a signed
# annotated tag.
#
# If [version] is provided (e.g. "1.4.0" or "v1.4.0"), that exact version is
# used. Otherwise the script inspects conventional commits since the last tag
# to determine major / minor / patch and calculates the next version with the
# `semver` package.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Ensure clean working tree ───────────────────────────────────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty — commit or stash changes first" >&2
  exit 1
fi

# ── Current version ─────────────────────────────────────────────────────────
CURRENT_VERSION="$("$SCRIPT_DIR/get-version-number.sh")"

# ── Determine target version ────────────────────────────────────────────────
if [ $# -ge 1 ]; then
  # Strip leading 'v' if present
  VERSION="${1#v}"

  # Validate
  VALID=$(node -p "require('semver').valid('$VERSION') || ''" 2>/dev/null)
  if [ -z "$VALID" ]; then
    echo "Error: '$1' is not valid semver" >&2
    exit 1
  fi
  VERSION="$VALID"
else
  # Infer bump from conventional commits since last tag
  LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

  if [ -z "$LAST_TAG" ]; then
    RANGE="HEAD"
  else
    RANGE="${LAST_TAG}..HEAD"
  fi

  BUMP="patch"

  while IFS= read -r msg; do
    # Breaking change: `feat!:` or `fix(scope)!:` etc.
    if echo "$msg" | grep -qE '^[a-z]+(\(.+\))?!:'; then
      BUMP="major"
      break
    fi
    # BREAKING CHANGE in commit subject (body not available via --format=%s)
    if echo "$msg" | grep -qi 'BREAKING CHANGE'; then
      BUMP="major"
      break
    fi
    # feat → minor (don't break; a later commit might be major)
    if echo "$msg" | grep -qE '^feat(\(.+\))?:'; then
      BUMP="minor"
    fi
  done < <(git log --format="%s" "$RANGE" 2>/dev/null)

  VERSION=$(node -p "require('semver').inc('$CURRENT_VERSION', '$BUMP')")
  echo "Detected bump: $BUMP ($CURRENT_VERSION → $VERSION)"
fi

# ── Guard: version must be greater than current ─────────────────────────────
IS_GT=$(node -p "require('semver').gt('$VERSION', '$CURRENT_VERSION')")
if [ "$IS_GT" != "true" ]; then
  echo "Error: $VERSION is not greater than current version $CURRENT_VERSION" >&2
  exit 1
fi

# ── Guard: tag must not already exist ───────────────────────────────────────
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "Error: tag v$VERSION already exists" >&2
  exit 1
fi

# ── Bump package.json ──────────────────────────────────────────────────────
node -e "
const fs = require('fs');
const path = '$ROOT_DIR/package.json';
const raw = fs.readFileSync(path, 'utf8');
const pkg = JSON.parse(raw);
pkg.version = '$VERSION';
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

# ── Commit and tag ──────────────────────────────────────────────────────────
cd "$ROOT_DIR"
git add package.json
git commit -S -m "release: bump version to $VERSION"
git tag -s -a "v$VERSION" -m "v$VERSION"

echo "Released v$VERSION"
