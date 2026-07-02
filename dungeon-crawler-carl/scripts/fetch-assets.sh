#!/usr/bin/env bash
# Best-effort fetcher for CC0 3D assets used by the isometric renderer.
# See ASSETS.md for the full catalogue + licenses. Scriptable sources are pulled
# automatically; the rest print manual-download instructions (itch.io / kenney.nl
# zips need a browser click-through and can't be curl'd reliably).
#
# Usage:  bash scripts/fetch-assets.sh
# Result: GLB files under public/assets/ (git-ignored). Then enable the matching
#         entries in src/render3d/assets.ts MODEL_MANIFEST.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/assets"
AUDIO="$ROOT/public/audio"
mkdir -p "$DEST/dungeon" "$DEST/characters" "$AUDIO/sfx" "$AUDIO/music"

have() { command -v "$1" >/dev/null 2>&1; }
if ! have curl; then echo "curl not found — install curl and re-run."; exit 1; fi

fetch() { # url dest
  local url="$1" out="$2"
  echo "→ $out"
  if curl -fsSL "$url" -o "$out"; then
    echo "  ok ($(wc -c <"$out" | tr -d ' ') bytes)"
  else
    echo "  SKIPPED (unreachable here): $url"
    rm -f "$out"
  fi
}

echo "== Scriptable CC0 sources =="
# poly.pizza serves per-model GLBs for the Quaternius/Kenney packs. Model IDs change
# over time — browse https://poly.pizza and copy a model's GLB link if one 404s.
# (Left as examples; uncomment/replace with the exact models you want.)
# fetch "https://poly.pizza/api/download/<MODEL_ID>?format=glb" "$DEST/dungeon/wall.glb"

echo
echo "== Manual downloads (browser required) =="
cat <<'EOF'
These CC0 packs are distributed as zips behind a download page. Grab the glTF/GLB
versions and unzip into public/assets/ as noted:

  Kenney — Modular Dungeon Kit (CC0)
    https://kenney.nl/assets/modular-dungeon-kit   -> public/assets/dungeon/

  Quaternius — LowPoly Modular Dungeon Pack (CC0)
    https://quaternius.itch.io/lowpoly-modular-dungeon-pack   -> public/assets/dungeon/

  KayKit — Dungeon Remastered (CC0)
    https://kaylousberg.itch.io/kaykit-dungeon-remastered   -> public/assets/dungeon/

  KayKit — Adventurers + Skeletons (CC0, rigged + animated)
    https://kaylousberg.itch.io/kaykit-adventurers   -> public/assets/characters/adventurer.glb
    https://kaylousberg.itch.io/kaykit-skeletons     -> public/assets/characters/skeleton.glb

After placing files, enable the matching lines in src/render3d/assets.ts
(MODEL_MANIFEST) and reload — the renderer will use the models automatically.
EOF

echo
echo "== Audio (see ASSETS.md — Audio for the license-tagged source list) =="
# FreePD serves direct CC0 MP3s — pick tracks at https://freepd.com and fetch:
# fetch "https://freepd.com/music/<Track%20Name>.mp3" "$AUDIO/music/dungeon.mp3"
# (then point src/audio/manifest.ts music entries at the .mp3, or convert to .ogg)
cat <<'EOF'
SFX are best grabbed manually (zips / per-file pages):

  Kenney — Impact Sounds, Interface Sounds, RPG Audio, Music Jingles (all CC0)
    https://kenney.nl/assets?q=audio          -> public/audio/sfx/
  Freesound — filter license to "Creative Commons 0" before downloading
    https://freesound.org                     -> public/audio/sfx/
  FreePD — CC0 music beds (dungeon / safe room / collapse loops)
    https://freepd.com                        -> public/audio/music/

Name files to match src/audio/manifest.ts (hit.ogg, crit.ogg, level_up.ogg, ...).
Missing files are fine — the game simply stays silent for those sounds.
CC-BY sources (soundimage.org etc.) require an attribution entry in ASSETS.md.
EOF
echo
echo "Done. Placeholder low-poly meshes render (and the game stays silent) until real assets are present."
