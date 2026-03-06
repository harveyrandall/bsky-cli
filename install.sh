#!/bin/sh
# install.sh — download and install the latest bsky-cli binary
# Usage: curl -fsSL https://raw.githubusercontent.com/harveyrandall/bsky-cli/main/install.sh | sh
set -e

REPO="harveyrandall/bsky-cli"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BINARY="bsky"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Darwin) os="macos" ;;
  Linux)  os="linux" ;;
  *)
    echo "Error: unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ARTIFACT="bsky-${os}-${arch}"

# Get latest release tag
TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"

if [ -z "$TAG" ]; then
  echo "Error: could not determine latest release" >&2
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}.tar.gz"
CHECKSUM_URL="https://github.com/${REPO}/releases/download/${TAG}/checksums.txt"

echo "Downloading ${BINARY} ${TAG} for ${os}/${arch}..."
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

curl -fsSL "$URL" -o "${TMPDIR}/${ARTIFACT}.tar.gz"
curl -fsSL "$CHECKSUM_URL" -o "${TMPDIR}/checksums.txt"

# Verify checksum
EXPECTED="$(grep "${ARTIFACT}.tar.gz" "${TMPDIR}/checksums.txt" | awk '{print $1}')"
if [ -n "$EXPECTED" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "${TMPDIR}/${ARTIFACT}.tar.gz" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "${TMPDIR}/${ARTIFACT}.tar.gz" | awk '{print $1}')"
  else
    echo "Warning: no sha256sum or shasum found, skipping checksum verification" >&2
    ACTUAL="$EXPECTED"
  fi

  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Error: checksum mismatch" >&2
    echo "  expected: $EXPECTED" >&2
    echo "  actual:   $ACTUAL" >&2
    exit 1
  fi
fi

# Extract and install
tar -xzf "${TMPDIR}/${ARTIFACT}.tar.gz" -C "$TMPDIR"
chmod +x "${TMPDIR}/${BINARY}"

if [ -w "$INSTALL_DIR" ]; then
  mv "${TMPDIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "${TMPDIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
fi

echo "Installed ${BINARY} ${TAG} to ${INSTALL_DIR}/${BINARY}"
