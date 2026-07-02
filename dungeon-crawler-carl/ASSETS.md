# Art assets — open-source (CC0) sourcing

The 3D isometric renderer (`src/render3d/`) currently draws **procedural low-poly
placeholder meshes** so we can confirm art direction without any downloads. It's
built to load real **glTF/GLB** models the moment they're present under
`public/assets/` — see `src/render3d/assets.ts` (`MODEL_MANIFEST`). Uncomment a
manifest entry, drop the matching `.glb` in place, and the renderer swaps the
primitive for the model automatically (falling back to the primitive if the file
is missing). No gameplay code changes — the sim knows nothing about rendering.

## Recommended CC0 packs (public domain, commercial-OK, attribution-free)

All of the following are **CC0 1.0** unless noted. CC0 means you can use, modify,
and ship them commercially with no attribution required (attribution still
appreciated).

### Environment — modular dungeon kits
| Pack | Author | License | Link |
|---|---|---|---|
| Modular Dungeon Kit (40 pcs) | Kenney | CC0 | https://kenney.nl/assets/modular-dungeon-kit |
| Mini Dungeon (with animations) | Kenney | CC0 | https://kenney-assets.itch.io/mini-dungeon |
| LowPoly Modular Dungeon Pack (45+ pcs) | Quaternius | CC0 | https://quaternius.itch.io/lowpoly-modular-dungeon-pack |
| KayKit Dungeon Remastered | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-dungeon-remastered |

### Characters & monsters (rigged + animated — the big 3D win)
| Pack | Author | License | Link |
|---|---|---|---|
| KayKit Character Pack: Adventurers | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-adventurers |
| KayKit Character Pack: Skeletons | Kay Lousberg | CC0 | https://kaylousberg.itch.io/kaykit-skeletons |
| RPG Characters / Animated Monsters | Quaternius | CC0 | https://quaternius.com/ |

KayKit Adventurers + Skeletons are the sweet spot for this game: rigged humanoids
sharing a skeleton, with idle/walk/attack/hit/death clips already included — exactly
what maps onto our player and monster entities.

### Aggregators / single-model grabbing
- **poly.pizza** — https://poly.pizza — searchable CC0 model library, per-model GLB
  download (includes the Quaternius/Kenney packs above).
- **OpenGameArt.org** (filter to CC0) — https://opengameart.org
- **Mixamo** — https://www.mixamo.com — free auto-rigging + a large animation
  library. Note: free to use, but **not CC0** (Adobe account + license terms), so
  prefer the CC0 packs above if you want a fully public-domain asset base.

## Where to put files

```
public/assets/
  dungeon/    wall.glb, floor.glb, stairs.glb, props…
  characters/ adventurer.glb, skeleton.glb…
```

Then enable the matching lines in `MODEL_MANIFEST` (`src/render3d/assets.ts`). The
manifest keys the renderer already looks for are `player`, `skeleton`/`monster`,
`wall`, `floor`, `stairs`.

## Fetching

Some hosts (itch.io, kenney.nl direct zips) require a browser click-through and
can't be scripted reliably, and in this repo's sandbox the proxy blocks a few of
them outright. `scripts/fetch-assets.sh` attempts the scriptable sources and prints
manual-download instructions for the rest. Downloaded binaries are git-ignored
(`public/assets/` is not committed) — each contributor fetches their own copy, so
the repo stays lightweight and license-clean.

## Licensing hygiene

- Keep this file's table as the source of truth for every asset's origin + license.
- CC0 needs no attribution, but record it anyway so provenance is never lost.
- If you ever add a non-CC0 asset (e.g. CC-BY), add an attribution section here and
  in an in-game credits screen.
