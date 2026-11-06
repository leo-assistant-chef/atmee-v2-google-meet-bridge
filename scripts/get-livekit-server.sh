#!/usr/bin/env bash
# Downloads the LiveKit server into .livekit/ for the LiveKit end-to-end test
# (test/bridge.livekit.e2e.test.ts), which is skipped when the server is absent.
set -euo pipefail

cd "$(dirname "$0")/.."
arch="$(uname -m)"
case "$arch" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
os="$(uname -s | tr '[:upper:]' '[:lower:]')"

url="$(curl -fsSL https://api.github.com/repos/livekit/livekit/releases/latest \
  | grep -o "https://[^\"]*_${os}_${arch}\.tar\.gz" | head -n 1)"
[ -n "$url" ] || { echo "no LiveKit release found for ${os}_${arch}" >&2; exit 1; }

mkdir -p .livekit
curl -fsSL "$url" | tar -xz -C .livekit livekit-server
echo "installed $(.livekit/livekit-server --version) from $url"
