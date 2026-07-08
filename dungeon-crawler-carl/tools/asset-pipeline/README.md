# Asset Pipeline — AI-generated models in the KayKit style

Generates game-ready GLB assets with Meshy AI and forces them onto the **same
gradient atlas the game's KayKit assets already use**, so generated models sit
next to the originals without looking bolted-on. Full design rationale:
[`docs/plan-v2.md`](docs/plan-v2.md).

```
prompt ──► Meshy (text/image-to-3D) ──► raw.glb
                                          │
              Blender headless: palette-snap quality gate
              (per-face color → nearest KayKit swatch → re-UV onto master atlas,
               single shared material, normalize scale/pivot, validate)
                                          │
                                          ▼
                              <id>.glb  +  report.json  +  preview.png
```

The key idea: **cohesion lives in the shared atlas, not the geometry.** Meshy's
per-asset textures are used only as a color oracle; every face is quantized to
the nearest swatch of the real KayKit atlas (extracted from the GLBs shipped in
`public/assets/`), so texture drift between generations is eliminated by
construction.

## Setup

- Python 3.11+
- Blender: either set `BLENDER_BIN=/path/to/blender`, or `pip install bpy`
  (the scripts run in-process under the bpy module)
- `MESHY_API_KEY` for generation (paid tier required for commercial rights to
  the output; assets with `source_glb` need no key)

Everything else is stdlib-only — no other Python dependencies.

## Quickstart

```bash
cd dungeon-crawler-carl/tools/asset-pipeline

# 1. Build the master palette from a KayKit asset already in the repo (one-time)
python3 extract_atlas.py ../../public/assets/dungeon/barrel_large.glb -o palette/
python3 build_palette.py palette/dungeon_texture.png -o palette/palette.json

# 2. Describe the assets you want
cp manifest.example.json manifest.json   # then edit

# 3. See what would happen, then run
python3 orchestrator/run.py --manifest manifest.json --dry-run
MESHY_API_KEY=msy_... python3 orchestrator/run.py --manifest manifest.json --previews
```

Outputs land in `out/<id>/`: the final `<id>.glb`, the raw Meshy download, a
validation `report.json`, and (with `--previews`) a `preview.png`. Stages are
resumable — re-running skips anything already produced; delete an asset's
`out/<id>/` directory to regenerate it.

To use an asset in the game: copy `out/<id>/<id>.glb` into
`public/assets/…`, register it in `MODEL_MANIFEST`
(`src/render3d/assets.ts`), and **record it in `ASSETS.md`** (AI-generated via
Meshy — note the Meshy plan/license used; the atlas itself is CC0 KayKit).

## Manifest fields

| Field | Meaning |
|---|---|
| `id` | output name, must be unique |
| `type` | `prop` or `character` (characters: prompt for **T-pose**) |
| `prompt` | Meshy text-to-3D prompt (see examples for the house-style suffix) |
| `image` | instead of `prompt`: reference image path/URL for image-to-3D |
| `source_glb` | skip generation, palette-snap an existing local GLB |
| `target_height` | world-unit height after normalize (pivot goes to bottom-center) |
| `target_polycount` / `max_tris` | generation target / validation budget |
| `rig` | flag for characters — **not wired up yet** (Phase 3); logs a note |

## Tools

| Script | Purpose |
|---|---|
| `extract_atlas.py` | pull embedded texture(s) out of any .glb |
| `build_palette.py` | sample an atlas PNG into `palette.json` swatches |
| `blender/palette_snap.py` | the quality gate (see diagram) |
| `blender/render_preview.py` | render GLBs side-by-side to PNG for review |
| `orchestrator/run.py` | manifest runner (generate → snap → preview) |
| `orchestrator/animate.py` | rig a humanoid + apply a Meshy preset clip (Phase-3 spike) |
| `orchestrator/meshy.py` | stdlib Meshy API client (async tasks, polling) |
| `blender/retarget_clip.py` | bake a Meshy-skeleton clip onto a KayKit rig (bone auto-map + rest-delta) |
| `blender/render_clip_frames.py` | render sampled frames of a clip playing on a model |
| `blender/print_bones.py` | dump bone hierarchies/clips of GLBs (retarget debugging) |
| `tests/synthetic_snap_test.py` | self-test: off-palette model must come out 100% on-atlas |

## Testing

```bash
python3 tests/synthetic_snap_test.py    # needs bpy; asserts the quality gate end-to-end
```

The Meshy client can be wired-tested without spending credits using Meshy's
documented test-mode key (`orchestrator/meshy.py: TEST_MODE_KEY`).

## Status / roadmap

Phase 0–1 (this directory): prop path proven end-to-end — a KayKit barrel
round-trips through the gate visually unchanged, and a deliberately
off-palette synthetic model comes out with every face on the atlas.
**Live API wiring verified** (2026-07-05, test mode, zero credits): create →
poll → SUCCEEDED with GLB URLs. One find: the v2 endpoint now accepts only
`art_style: "realistic"` — defaults updated; house style comes from the
prompt suffix + palette snap, so nothing else changes.
**First paid generation verified** (2026-07-08, Blender 5.1.2 headless on
Windows): a crate prompt ran generate → snap → preview end-to-end and passed
validation (2,791 tris against a 3,000 target, 48 swatches, single material).
One find: `target_polycount` is silently ignored unless `should_remesh: true`
is also sent (without it the same prompt returned 924k triangles); the client
now sets it whenever a polycount target is given.
**Animation path spiked** (2026-07-08): Meshy auto-rig (5 credits) + preset
clip (3 credits) on the KayKit adventurer, retargeted onto the Adventurers 1.0
rig with `blender/retarget_clip.py` and shipped in-game as the Extradition
cast clip. Two finds: the animate result exposes `animation_glb_url` (not
`model_urls`), and animated GLBs bake the clip's first frame as the bind pose
— always pass the rig task's T-pose output as `--rest-source`.
Next per `docs/plan-v2.md`: generated-character path end-to-end (generate →
snap → rig → retarget), 2D concept stage for style anchoring, batch runs +
contact-sheet review, cost/reject-rate measurement.
