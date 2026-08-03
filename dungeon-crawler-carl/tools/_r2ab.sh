#!/usr/bin/env bash
# ALTERNATING BEFORE/AFTER, ONE THERMAL WINDOW.
#
# The r1 paydown recorded that this package reads 14.9 ms GPU early in a session
# and 21.2 ms after two test suites have heated it, on the identical scene. That
# is not noise you can average away by taking more samples in one arm — it is a
# monotone drift, so an A-then-B comparison charges the whole drift to B. This
# alternates A/B/A/B and reports each arm's MEDIAN OF ITS RUNS, so a monotone
# drift lands on both arms equally.
#
# "before" is HEAD (the r2 SPEND commit); "after" is the working tree. The
# switch is a stash of exactly the one file that changed.
set -u
cd "$(dirname "$0")/.."
COOL="${COOL:-240}"
REPS="${REPS:-2}"
echo "cooling ${COOL}s so the first arm is not measured on a hot package..."
sleep "$COOL"
for r in $(seq 1 "$REPS"); do
  git stash push -q -- src/render3d/renderer3d.ts
  echo "===== rep $r BEFORE (HEAD) ====="
  node tools/_r2budget.mjs --tag "ab_before_$r" --seconds 12 2>&1 | sed -n '/====/,/BUDGET/p'
  git stash pop -q
  echo "===== rep $r AFTER (working tree) ====="
  node tools/_r2budget.mjs --tag "ab_after_$r" --seconds 12 2>&1 | sed -n '/====/,/BUDGET/p'
done
echo "ALL DONE"
