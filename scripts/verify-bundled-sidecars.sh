#!/usr/bin/env bash
# Verify that a macOS Buzz app contains usable managed-agent sidecars.

set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <path-to-Buzz.app>" >&2
    exit 2
fi

APP_PATH=$1
MACOS_DIR="$APP_PATH/Contents/MacOS"
SIDECARS=(buzz buzz-acp buzz-agent buzz-backend-kubernetes buzz-dev-mcp git-credential-nostr)

[[ -d "$APP_PATH" ]] || {
    echo "Missing app bundle: $APP_PATH" >&2
    exit 1
}

for sidecar in "${SIDECARS[@]}"; do
    path="$MACOS_DIR/$sidecar"
    [[ -f "$path" ]] || {
        echo "Missing bundled sidecar: $path" >&2
        exit 1
    }
    [[ -s "$path" ]] || {
        echo "Bundled sidecar is empty: $path" >&2
        exit 1
    }
    [[ -x "$path" ]] || {
        echo "Bundled sidecar is not executable: $path" >&2
        exit 1
    }
done

echo "Verified ${#SIDECARS[@]} executable, non-empty sidecars in $APP_PATH"
