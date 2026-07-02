# Dungeon Crawler Carl — vertical slice

A Diablo-like dungeon crawler inspired by *Dungeon Crawler Carl*: drop into a procedurally
generated dungeon and descend to floor 18 before each floor's **collapse timer** turns it
lethal. This directory is the **single-player, local vertical slice** — see
[`DESIGN.md`](./DESIGN.md) for the full architecture (party-private multiplayer,
authoritative server, drop-in/drop-out) that the slice is built to grow into.

## Run it

```bash
cd dungeon-crawler-carl
npm install
npm run dev        # then open one of:
                   #   http://localhost:5173/           -> 2D top-down slice
                   #   http://localhost:5173/iso.html   -> 3D isometric ARPG view
```

Both views run the **same deterministic sim** — only the renderer differs, which is
the whole point of keeping game rules in a pure core.

Other scripts:

```bash
npm test           # deterministic sim unit tests (vitest)
npm run typecheck  # tsc --noEmit
npm run build      # type-check + production build
```

## Controls

| Key | Action |
|---|---|
| `WASD` / arrows | Move |
| `Space` / left-click | Melee attack (arc in facing/aim direction) |
| `Q` / right-click | Ranged bolt (projectile) |
| `Shift` | Dash (blink + brief i-frames) |
| `I` | Toggle inventory (pauses the game) |
| `E` | Descend when standing on the stairs |
| `R` | Abandon the run and start a fresh one |

## What the slice proves

- **Collapse timer** — per-floor countdown with `safe → warning → collapse` phases; the
  collapsing floor deals escalating damage until you descend.
- **Descent** — find the stairs, drop through floors 1 → 18 with depth-scaled difficulty.
- **Combat / loot / leveling** — melee monsters, gold + health + weapon drops, XP and levels.
- **Log on / off** — your character is saved to `localStorage`; refresh resumes mid-dungeon.
- **Deterministic sim core** — all rules live in `src/sim/` (pure, DOM-free), so the same
  code ports to an authoritative server and a headless test/RL harness.

## Art direction (3D isometric)

The `iso.html` view is the target **isometric ARPG** look (Diablo/PoE-style): a
fixed pitched **orthographic camera** over a Three.js scene — real-time lighting,
shadows, torch glow, and iso-depth walls. It currently draws **procedural low-poly
placeholder meshes**; it's wired to load real **CC0 glTF** models the instant they
appear under `public/assets/`, with no gameplay changes (the sim is render-agnostic).

- **Sourcing open-source art:** see [`ASSETS.md`](./ASSETS.md) for vetted CC0 packs
  (Kenney / Quaternius / KayKit) and [`scripts/fetch-assets.sh`](./scripts/fetch-assets.sh).
- **Wiring a model:** drop a `.glb` in `public/assets/…`, enable its entry in
  `src/render3d/assets.ts` (`MODEL_MANIFEST`), reload. The renderer swaps the
  primitive for the model automatically and falls back if the file is absent.

## Gameplay depth

- **Enemy archetypes** — grunt, fast **swarmer**, tanky **brute**, and **ranged** shooters
  (kite + fire projectiles). The mix gets nastier with depth.
- **Active skills** — **dash** (blink + i-frames) and a **ranged bolt**, each on a cooldown
  shown in the skill bar.
- **Projectiles** — a shared system for player bolts and enemy shots.
- **Itemization** — equipment drops as **items** (weapon / armor / trinket) with a rarity
  tier (common / magic / rare / epic) and rolled **affixes** (damage, HP, speed, crit). An
  **inventory panel** (`I`) shows equipped vs bag; click to equip. Better drops auto-equip;
  effective stats = intrinsic(level) + loot-box bonuses + equipped affixes.
- **Floor-18 boss** — a boss arena that seals the exit until the boss (melee chase + radial
  volleys) is dead; killing it wins the run.
- **Minimap** — live top-down map with walls, stairs, enemies, and the player.

## Game feel + DCC personality

The 3D view has combat juice, all driven off the sim's deterministic event channels:
- **Procedural animation** on the placeholder meshes (walk bob, attack lunge, hit
  recoil/squash, death), with a glTF **AnimationMixer** seam for real clips.
- **Floating damage numbers**, **crits**, **hit particles**, and **camera shake** from the
  sim's typed `hits` events.
- The **DCC "System" announcer**: game-show-voiced toasts for level-ups, floor collapse,
  descent, and **loot boxes** (a randomized buff every few kills).
- **The Show** — a live **viewers / favorites / sponsors** economy. Exciting + challenging
  play (crits, multi-kill combos, tough-enemy kills, fighting at low HP or on a collapsing
  floor, epic drops) generates **hype**, which drives viewers; a slice convert to sticky
  **favorites**, and favorite thresholds earn **sponsors**. Between floors, sponsors offer a
  **draft** — pick one gift (gear, +max HP, bonus time, crit, gold…), with more/better
  options the more sponsors you have.

Add `?debug=1` to the `iso.html` URL to expose `window.__dcc` (live state + renderer) for
staging scenarios — off by default.

## Layout

```
src/sim/       deterministic core: rng, floor gen, combat, ai, collapse timer, step()
src/render/    Canvas2D top-down renderer + HUD (index.html)
src/render3d/  Three.js isometric renderer + glTF asset seam (iso.html)
src/input/     keyboard/mouse → intents
src/persist/   localStorage save/load (log on/off seam)
src/main.ts    2D host loop      src/main3d.ts  3D host loop
test/          deterministic sim tests
```
