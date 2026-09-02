#!/usr/bin/env bash
#
# Builds the two agent artifacts the dashboard serves:
#
#   dashboard/public/agent/latest.tar.gz          Python agent (Linux, macOS)
#   dashboard/public/agent/windows/aaul-agent.exe Go agent (Windows)
#
# The Windows agent is cross-compiled from this machine. That is the whole
# reason it is written in Go: no Windows build host, no CI runner, no signing
# chain to stand up -- one `go build` produces a static binary with nothing to
# install on the target.
#
# Set AAUL_SKIP_WINDOWS_AGENT=1 to skip the Go build when iterating on the
# Python agent alone. release.sh refuses to publish without it.
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

if [ "${AAUL_SKIP_WINDOWS_AGENT:-0}" = "1" ]; then
  echo "AAUL_SKIP_WINDOWS_AGENT=1 -- Windows agent not built"
  exit 0
fi

if ! command -v go >/dev/null 2>&1; then
  echo "error: the Go toolchain is required to build the Windows agent." >&2
  echo "       Install Go, or set AAUL_SKIP_WINDOWS_AGENT=1 to skip it." >&2
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
    -o "$OUT_DIR/windows/aaul-agent.exe" .
)

echo "Windows agent built at $OUT_DIR/windows/aaul-agent.exe (version $AGENT_VERSION)"
