#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_APP="$ROOT_DIR/agent/app"
OUT_DIR="$ROOT_DIR/dashboard/public/agent"

mkdir -p "$OUT_DIR"

tar -czf "$OUT_DIR/latest.tar.gz" -C "$AGENT_APP" .
cp "$AGENT_APP/VERSION" "$OUT_DIR/VERSION"

echo "Agent bundle created at $OUT_DIR/latest.tar.gz"