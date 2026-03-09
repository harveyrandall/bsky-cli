#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

node -p "JSON.parse(require('fs').readFileSync('$ROOT_DIR/package.json','utf8')).version"
