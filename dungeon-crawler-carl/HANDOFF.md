# Bosses V2 — checkpoint handoff

**Status: work in progress, checkpointed mid-flight.** Agents were still editing
this worktree when the snapshot was taken, so treat this as a save point, not a
finished round. Run `npx tsc --noEmit` and `npx vitest run` before building on it.

Branch: `bosses-v2`, forked from `main@334cc32`.
Design doc: `BOSSES-V2.md` (991 lines, 8 sections).
Dev server used during the round: `http://localhost:5360`.

## What landed

1. **Design** — `BOSSES-V2.md`, approved by a harsh encounter-design critic at
   **8.0/10**: an honest audit of every shipped boss, a boss *grammar* (phases,
   telegraph language, arena interaction, add waves, payoff beats), a large named
   roster across the six bands, seeded selection + boss mutators so repeat runs
   differ, and per-beat elevation requirements.
2. **Sim** — the full MUST scope in `src/sim/**`, plus the SHOULD-tier verbs the
   roster needed. Seeded boss selection and mutators are deterministic.
3. **Presentation** — §5 wired into the 3D host: arena reveal, intro beat,
   per-boss telegraphs, phase-transition spectacle, kill and payoff. Audio hooks
   through `src/audio/director.ts`.

## Why it is NOT finished

Two acceptance rounds scored **5.8** then **5.5** against an 8.5 bar. The design
passed at 8.0; the *captured frames* did not. Open blockers, from the critics:

- **The name card is absent from 8 of 18 intro captures** and unreadable in a 9th
  — the marquee beat does not reliably fire.
- **The punish window has no in-world read.** The doc calls it "the one beat that
  most needs to read"; nothing on screen communicates it.
- **Exposure destroys the read on several bosses** despite the claimed shared
  brightness governor (topiary especially).
- **The payoff chain does not land** across rentcollector / permitoffice /
  sumpking — the beat a short-session game lives on.
- **Fights differ by hue, not shape.** The same concentric-ring + white-radial-
  spoke telegraph appears across different bosses; recolouring is not variety.
- **The boss is occluded by its own health plate** in the `-3fight` captures.

## What to do next

1. Fix the four blockers in order: name card, punish window, exposure governor,
   payoff chain. These are presentation bugs, not design gaps.
2. Give each boss a **distinct telegraph SHAPE**, not a distinct colour. This is
   the most repeated criticism and it decides whether the roster reads as varied.
3. Move the boss health plate so it never occludes the boss at gameplay camera
   distance.
4. Re-run the acceptance critic with fresh captures. Do not trust a capture that
   does not visibly contain the claimed beat — several earlier ones did not.
5. Then `npx tsc --noEmit`, `npx vitest run`, `scripts/balance-sweep.ts`, and open
   a PR against `main`.

## Resuming the workflow

    Workflow({ scriptPath: "C:\Users\hartw\.claude\projects\C--Users-hartw-astro-example-dags--claude-worktrees-aaa-refinement\3a9dd2e4-b17a-4269-ba2d-1295fe0446c5\workflows\scripts\boss-variety-wf_02cbd389-b2e.js",
               resumeFromRunId: "wf_02cbd389-b2e" })

Completed agents replay from cache; edited or new stages run live.
