#!/usr/bin/env bash
# Standard screenshot panel for visual QA. Usage: bash tools/shotset.sh <tag>
# Produces $OUT/<tag>-f{2,5,8,11,14,17}.png + a combat shot.
# Uses shotwait.mjs (polls <html data-assets-settled>) — fixed sleeps were
# flaky while concurrent agent edits kept the dev server re-transforming.
# SHOT_BASE overrides the server (e.g. a `vite preview` of the same checkout
# when dev-server HMR reload storms keep interrupting boot).
set -e
OUT="${SHOT_DIR:-C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots}"
TAG="${1:?usage: shotset.sh <tag>}"
BASE="${SHOT_BASE:-http://localhost:5285/iso.html}"
mkdir -p "$OUT"
node tools/shotwait.mjs "$BASE?test&floor=2&level=4&seed=41"    "$OUT/$TAG-f2.png"
node tools/shotwait.mjs "$BASE?test&floor=5&level=10&seed=41"   "$OUT/$TAG-f5.png"  --keys "w:900,d:600"
node tools/shotwait.mjs "$BASE?test&floor=8&level=16&seed=41"   "$OUT/$TAG-f8.png"  --keys "w:900,d:600"
node tools/shotwait.mjs "$BASE?test&floor=8&level=16&seed=43"   "$OUT/$TAG-combat.png" --keys "w:1200,Space:200,q:200,Space:200"
node tools/shotwait.mjs "$BASE?test&floor=11&level=22&seed=41"  "$OUT/$TAG-f11.png" --keys "w:900,a:600"
node tools/shotwait.mjs "$BASE?test&floor=14&level=28&seed=41"  "$OUT/$TAG-f14.png" --keys "w:900,d:600"
# seed 41 spawn-wipes the level-34 test crawler on floor 17 under current
# balance (sim-side; ~1100 dmg in the first second) — seed 44 shows the band.
node tools/shotwait.mjs "$BASE?test&floor=17&level=34&seed=44"  "$OUT/$TAG-f17.png" --keys "w:600"
echo "panel saved to $OUT with tag $TAG"
