#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
TARGET=${1:-x86_64-unknown-linux-gnu}
exec python3 scripts/build_tqe_sidecar.py --target "$TARGET"
