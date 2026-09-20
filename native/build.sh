#!/usr/bin/env bash
# Build the native Needle 3 addon end to end:
#   1. build the needle-c C ABI shared library with cargo (release, parallel)
#   2. vendor the .so and the C header next to the addon
#   3. build the node-gyp addon against the vendored .so (release = -O3)
#
# NEEDLE_RS points at a checked-out needle-rs workspace (default /tmp/needle-rs).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NEEDLE_RS="${NEEDLE_RS:-/tmp/needle-rs}"
CARGO_MANIFEST="${CARGO_MANIFEST:-$NEEDLE_RS/Cargo.toml}"

if [[ ! -f "$CARGO_MANIFEST" ]]; then
  echo "needle-rs workspace not found at $NEEDLE_RS (set NEEDLE_RS)." >&2
  exit 1
fi

mkdir -p "$HERE/lib" "$HERE/include"

# 1. Build the C ABI cdylib (release, multi-threaded via the `parallel` feature).
echo "[build] cargo build -p needle-c (release)"
cargo build --release -p needle-c --manifest-path "$CARGO_MANIFEST"

# 2. Vendor the .so and the C header next to the addon.
echo "[build] vendor libneedle_c.so + needle.h"
cp "$NEEDLE_RS/target/release/libneedle_c.so" "$HERE/lib/libneedle_c.so"
cp "$NEEDLE_RS/crates/needle-c/include/needle.h" "$HERE/include/needle.h"

# 3. Build the node-gyp addon in release (optimized) mode.
echo "[build] node-gyp rebuild --release"
cd "$HERE" && node-gyp rebuild --release

echo "[build] done -> $HERE/build/Release/native.node"
