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
npm run dev        # open the printed http://localhost:5173 URL
```

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
| `Space` / click | Melee attack (arc in facing/aim direction) |
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

## Layout

```
src/sim/     deterministic core: rng, floor gen, combat, ai, collapse timer, step()
src/render/  Canvas2D top-down renderer + HUD
src/input/   keyboard/mouse → intents
src/persist/ localStorage save/load (log on/off seam)
src/main.ts  fixed-timestep host loop
test/        deterministic sim tests
```
