#!/usr/bin/env bash
#
# Builds the two agent artifacts the dashboard serves:
#
#   dashboard/public/agent/latest.tar.gz          Python agent (Linux, macOS)
#   dashboard/public/agent/windows/aaul-agent.exe Go agent (Windows)
#
# The Python agent is built from sources tracked in git, so any host can produce
# it. The Windows agent cannot: it needs the Go toolchain, which a dashboard
# server has no reason to carry. The binary is therefore committed to the
# repository, and this script:
#
#   - rebuilds it when Go is available (a development machine), or
#   - keeps the committed one when Go is absent (a production server running
#     install.sh after a git pull).
#
# It only fails when there is neither a toolchain nor a binary, which is the one
# case where a Windows install would 404 with no way to tell in advance.
#
# Set AAUL_SKIP_WINDOWS_AGENT=1 to skip the rebuild while iterating on the
# Python agent alone.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_APP="$ROOT_DIR/agent/app"
AGENT_WIN="$ROOT_DIR/agent/windows"
OUT_DIR="$ROOT_DIR/dashboard/public/agent"

AGENT_VERSION="$(tr -d '[:space:]' < "$AGENT_APP/VERSION")"

mkdir -p "$OUT_DIR"

tar -czf "$OUT_DIR/latest.tar.gz" -C "$AGENT_APP" .
cp "$AGENT_APP/VERSION" "$OUT_DIR/VERSION"
echo "Agent bundle created at $OUT_DIR/latest.tar.gz"

WIN_AGENT="$OUT_DIR/windows/aaul-agent.exe"

if [ "${AAUL_SKIP_WINDOWS_AGENT:-0}" = "1" ]; then
  echo "AAUL_SKIP_WINDOWS_AGENT=1 -- Windows agent not rebuilt"
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  if [ -f "$WIN_AGENT" ]; then
    echo "Go toolchain absent -- keeping the committed Windows agent ($WIN_AGENT)"
    exit 0
  fi
  echo "error: no Windows agent binary and no Go toolchain to build one." >&2
  echo "       Expected: $WIN_AGENT" >&2
  echo "       Install Go, or restore the binary from the repository." >&2
  exit 1
fi

mkdir -p "$OUT_DIR/windows"

# CGO_ENABLED=0 keeps the binary free of any C runtime dependency; -trimpath
# strips build-host paths so the artifact is reproducible; the version is
# stamped from the same VERSION file the Python bundle uses, so the dashboard
# keeps a single readVersion() for every platform.
(
  cd "$AGENT_WIN"
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags "-s -w -X aaul-agent/internal/version.Version=$AGENT_VERSION" \
    -o "$WIN_AGENT" .
)

echo "Windows agent built at $WIN_AGENT (version $AGENT_VERSION)"
echo "  Commit it: it is what a production server serves after a git pull."
