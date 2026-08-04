# HARNESS — how agents see this game, and how to not be lied to

Every capture/measurement lesson this project has paid for, in one place, plus
the shared instruments. Read this before building a new probe; extend it when
you learn a new failure mode. **The owner's play sessions keep finding what
still-based critic rounds miss** (the shadow stutter, the boss camera losing
the player, early-floor lag, screens that "measured fine" with sheared copy) —
the instruments below exist to close that gap.

## The honesty rules (all learned the hard way here)

1. **Boot-gate**: `html[data-assets-settled="1"]` is NOT playable — the boot
   card still runs shader precompile and the PMREM bake behind it. Poll until
   `#loading` has actually left (absent, `.done`, `display:none`, or zero
   opacity), wait ~3s, then ASSERT it has no box. A shot taken early is a
   photograph of the loading screen (this shipped as "evidence" twice).
2. **Capture truth**: a frame that does not visibly contain what it claims is
   worse than a missing frame — it launders a defect into evidence. Verify the
   pixels (element-clip raster non-empty, beat visibly present) or mark it
   MISSED. Never substitute a different scene under the requested label.
3. **Real GPU, right adapter**: SwiftShader composites seconds late and kills
   short FX. Launch `headless:false` with `--use-angle=d3d11 --enable-gpu
   --ignore-gpu-blocklist`; that selects the **Intel iGPU** on this box — add
   `--force_high_performance_gpu` for the RTX 5090. ASSERT the unmasked
   renderer string on the game's own context. The Intel part is the contract
   hardware for LOW/MEDIUM.
4. **Delivered throughput, never medians of rAF deltas**: vsync quantises to
   8.33ms multiples on the 120Hz panel, and a median hides queued cheap
   callbacks (this produced two retracted conclusions). Measure frames per
   wall-second over a pinned scene.
5. **Foreign load**: a timing number taken while another automation browser
   runs is contaminated. Count foreign `chrome.exe` (siblings run
   headless:false — counting only `chrome-headless-shell` read "0" while
   fifteen were live) by walking the process tree from your own node process.
   Report foreign load % WITH every number.
6. **Pin the scene**: a live fight diverges between A/B arms (one measured 11
   monsters vs 69). Freeze/immortalize the crowd and re-stage on a cadence
   before comparing anything.
7. **Numbers alone are not acceptance**: the fit gate passed a shop whose body
   copy was sheared mid-line. Every claim needs the number AND a frame a human
   would agree with.
8. **Machine limit**: at most ONE Chromium per workflow, ~3 on the box total.
   Launch, use, CLOSE. Six crashed the owner's machine.

## Shared instruments (tools/)

- **`filmstrip.mjs`** — motion in one reviewable image. N frames at a fixed
  cadence, tiled with sim-event captions, plus a frame-pair diff series and an
  **alternation score** (>0.5 in a crop region = something updates every other
  frame — this is how the player-shadow stutter becomes a number). Rejects
  strips with byte-identical consecutive cells (frozen game = useless strip).
  Critics: request a strip of a WALK and a FIGHT every round, not just stills.
- **`feelprobe.mjs latency <url>`** — input-to-motion latency, in-page
  timestamps (keydown → first frame the player's position moved). Median ≤50ms
  good, >90ms fails.
- **`feelprobe.mjs bosscam <url>`** — THE PLAYER IS NEVER LOST: triggers a
  boss beat, runs the player away, samples the player's projected screen
  position; FAILS if it leaves the 6%–94% safe rect. This is the owner's
  reported camera bug as a permanent regression test — run it on every boss
  camera change.
- `combatshot.mjs` — virtual-clock frozen mid-impact capture (the only honest
  way to photograph a 70–400ms effect).
- `gpuprobe.mjs` / delivered-throughput harnesses (`acc*_perf.mjs` family on
  trk-render) — perf measurement with adapter assertion.

## Specs — the next signal unlocks (build these, they are priced)

1. **Per-frame pixel ring buffer** (owner: the render track; ~20 lines in
   renderer3d + a page API). After each composed frame, copy a small screen
   crop (e.g. 96×96 under the player) into a ring of ~32 ImageData entries,
   exposed via `__dcc.frameRing()`. Playwright screenshots are 100–300ms apart
   — too coarse for an 8ms cadence; this gives TRUE per-frame pixel history
   (shadow cadence, hit-flash timing, bloom flicker) queryable from the page.
2. **Replay-locked visual fixtures**. The deterministic sim + replay codec
   (src/sim/replay.ts) means a bot run recorded ONCE can be replayed under the
   renderer and captured at exact tick numbers — pixel-aligned before/after
   forever, no staged-scene drift. Needs a host hook that steps the sim from a
   recorded intent stream while rendering (the codec and MUST-3 canonical
   intent path already exist).
3. **Bot session reels**. Drive the balance bot through the REAL renderer for
   a full floor; filmstrip every ~2s; tag cells with sim events. The critic
   then judges a minute of actual play — the thing the owner keeps judging and
   the loop keeps not seeing.
4. **Impact-sync probe**. On a staged hit: frame delta between sim HitEvent,
   visible flash (ring-buffer pixel delta), damage-number DOM node, and audio
   director trigger. AAA feel = all four inside ~2 frames.
5. **Owner feedback hotkey** (needs owner sign-off; touches main3d). One key
   dumps seed + tick + full state snapshot + screenshot to a local folder when
   something feels wrong mid-play. The owner is the highest-signal critic this
   project has; today their findings arrive as prose that must be
   reverse-engineered into repros.

## Settled-findings ledger

Fresh critics re-litigate closed issues and anchor low. When a finding is
FIXED AND VERIFIED WITH A FRAME, add one line to `SETTLED.md` (`finding →
commit → proof frame`). Critics: read it, do not re-open entries unless your
own fresh capture contradicts the proof — in which case say so loudly, because
a reopened settled finding is a regression, which outranks everything else.
