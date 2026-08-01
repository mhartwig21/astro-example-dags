#!/usr/bin/env bash
# Final honest table. 3 runs per configuration; report the MEDIAN of the three.
# Every run re-boots the page, so each row includes its own boot variance.
set -u
cd "$(dirname "$0")/.."
BASE="${1:-http://localhost:5322}"
URL="$BASE/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1"
for preset in "" ultra high balanced performance; do
  for run in 1 2 3; do
    if [ -z "$preset" ]; then
      echo "### auto run$run"
      node tools/gpuprobe.mjs "$URL" --seconds 5 2>&1 | grep -E "^(GPU|PRESET|IDLE|MOVING|COMBAT)"
    else
      echo "### $preset run$run"
      node tools/gpuprobe.mjs "$URL" --seconds 5 --preset "$preset" 2>&1 | grep -E "^(PRESET|IDLE|MOVING|COMBAT)"
    fi
  done
done
echo "=== CPU FLOOR 640x360 dpr1 ==="
for preset in ultra performance; do
  for run in 1 2 3; do
    echo "### floor-$preset run$run"
    node tools/gpuprobe.mjs "$URL" --seconds 5 --w 640 --h 360 --dpr 1 --preset "$preset" 2>&1 | grep -E "^(PRESET|IDLE|MOVING|COMBAT)"
  done
done
