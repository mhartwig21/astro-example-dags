# PERF-REPORT — the `perf-mobile` round

Final re-measure at `perf-mobile@54a173e` (branched from `main@d7487f1`).
Seven optimizations committed, one reverted. This file is the round's evidence:
what moved, what did not, what got worse, and which questions no instrument on
this box can answer.

**Read `HANDOFF.md §0` first.** Every number below is reported with the
instrument that produced it, because the recurring failure mode in this project
is an accurate instrument answering an adjacent question — and it happened
twice more during this round (see *Instrument defects found*, below).

---

## 1. Method

- Worktree `.claude/worktrees/perf-mobile/dungeon-crawler-carl`, branch
  `perf-mobile`, based on `main@d7487f1`.
- **Production builds only.** `npm run build` → `dist/`, served by
  `vite preview --port 5288 --strictPort`. Every probe fingerprints the served
  `/iso.html` against the bundle hash in `dist/iso.html` before measuring
  (`iso-BYTJSQ6d.js` for this pass) and throws on a mismatch.
- **One headless browser at a time**, always closed in a `finally`.
- Dev box: RTX 5090 Laptop + Intel iGPU, Windows 11. **Contended** — 77-82
  foreign `chrome.exe` processes (the owner's own browser) and ~83 `node`
  processes from parallel worktrees were live throughout. The baseline sheet
  recorded 97 foreign chrome processes, so contention is comparable but not
  controlled.

| probe | what it produces |
|---|---|
| `tools/_boot_profile_r1.mjs` | cold + warm boot: bytes/requests by type, paint, loading-screen phase timeline, long tasks, post-loading stall, menu input latency |
| `tools/_perfprobe_wf.mjs` | 3 scenes, CPU throttle 4x, 30 s samples: frame percentiles, delivered fps, long tasks, process working set, CPU self-time |
| `tools/_perfprobe2_wf.mjs` | per-frame draw calls / triangles / render passes (`info.autoReset=false` window) + heap churn via CDP `Runtime.getHeapUsage` |
| `tools/_mobile/webkit_smoke.mjs` | WebKit at iPad viewport (1180x820, dsf 2, touch): boot, GL caps, touch drive, shader builds after boot |

The three scenes are the baseline's scenes, unchanged:

- **A — floor 2 calm**: `?test&floor=2&seed=42&debug=1`
- **B — floor 10 combat**: `?test&floor=10&level=14&abilities=all&gold=500&seed=42&debug=1`
- **C — floor 16 combat**: `?test&floor=16&level=14&abilities=all&gold=500&seed=42&debug=1`

Runtime probes were run **twice** end to end. Both runs are printed. Where the
two disagree, the disagreement is the honest error bar — do not average them
into a single confident number.

---

## 2. Headline

| | baseline | final | |
|---|---|---|---|
| Mid-fight shader compiles (floor 10) | 16 programs built during the fight | **0** | fixed |
| Post-loading-screen freeze | 517 ms across 2 rAF gaps | **0 ms, 0 gaps** | fixed |
| First menu frame | 554 ms blocking freeze | **3 ms** | fixed |
| Floor-10 fight, delivered fps | 9.1 | **13.7 / 10.1** | +11% to +51% |
| Floor-10 frame p99 | 516.7 ms | **183.4 / 200.0 ms** | -61% to -64% |
| Floor-10 worst frame | 1683.2 ms | **250.0 / 1099.9 ms** | -35% to -85% |
| Floor-10 longest long task | 622 ms | **241 / 226 ms** | -61% |
| GL textures leaked per fight | +187 (ends at 549) | **+49 to +58** | leak closed |
| Cold font bytes | 928,504 | **225,284** | -76% |
| Cold total bytes | 35,863,489 | **35,269,846** | -1.7% |
| Mid-fight music fetch (floor 11) | 3,737,204 B | **900,618 B** | -76% |
| Calm-scene allocation churn | 10.13 MB/s | **6.51 MB/s** | -36% |
| Post-load fps (first 5 s after the card) | 53 | **59.6** | +12% |
| **Cost: cold loading screen** | **8,659 ms** | **10,541 ms** | **+1,882 ms** |

The single deliberate regression is the last row. The owner's constraint was
"longer up-front loading is explicitly acceptable"; the round spent 3.1 s of
extra prewarm to buy a fight with no compile hitches and a menu that does not
freeze. Nothing else was traded.

---

## 3. Boot — baseline vs final

`tools/_boot_profile_r1.mjs`, headed Chromium, ANGLE/D3D11 on the RTX 5090,
1366x768, cache cleared for the cold arm. One run per arm (this probe is
comparatively stable; the runtime probe is not).

### Cold

| metric | baseline | final | delta |
|---|---:|---:|---|
| total bytes | 35,863,489 | 35,269,846 | **-593,643** |
| total requests | 399 | 405 | +6 |
| js bytes / requests | 574,048 / 4 | 575,352 / 4 | +1,304 |
| models bytes / requests | 32,361,856 / 260 | 32,361,856 / 260 | unchanged |
| textures bytes / requests | 26,718 / 29 | 134,582 / 35 | **+107,864 / +6** (deliberate: skin preload) |
| audio bytes / requests | 1,809,653 / 95 | 1,809,653 / 95 | unchanged |
| fonts bytes / requests | 928,504 / 4 | 225,284 / 4 | **-703,220** |
| html bytes / requests | 162,710 / 7 | 163,119 / 7 | +409 |
| first paint / FCP | 2,776 ms | 1,788 ms | -988 ms *(see caveat)* |
| first rAF frame | 1,307 ms | 1,137 ms | -170 ms |
| DOMContentLoaded | 2,284 ms | 1,345 ms | -939 ms |
| load event | 2,318 ms | 1,471 ms | -847 ms |
| **loading screen done** | **8,659 ms** | **10,541 ms** | **+1,882 ms** |
| ├ phase: models | 2,328 ms | 2,224 ms | -104 ms |
| ├ phase: audio | 338 ms | 170 ms | -168 ms |
| └ phase: prewarm | 3,680 ms | 6,790 ms | **+3,110 ms** |
| long tasks in first 10 s | 9 / 4,522 ms | 10 / 4,828 ms | +1 / +306 ms |
| longest task | 1,175 ms @ 1,112 ms | 1,715 ms @ 5,812 ms | moved |
| **post-loading stall** | **517 ms / 2 gaps** | **0 ms / 0 gaps** | **eliminated** |
| post-load fps (5 s) | 53 | 59.6 | +6.6 |
| menu input response | 74 ms | 56 ms | -18 ms |
| time to interactive | 9,250 ms | ~10,541 ms | +1,291 ms |

**The longest task moved, it did not grow into a new problem.** Baseline's
1,175 ms task started at 1,112 ms — module evaluation, *in front of* the first
paint. The final build's 1,715 ms task starts at 5,812 ms: it is the shader
prewarm, and it runs **behind the opaque loading card**, where a blocked main
thread is invisible. Time-to-interactive rose by the same 1.3 s the loading
screen did.

**Caveat on first paint** (established by the reverted opt5, and it stands):
~900-1,000 ms of every `cold_first_paint_ms` this probe reports is Chromium's
own pre-navigation startup with a cleared cache — navigation `requestStart`
lands at ~950 ms before the page has done anything. A no-JS control (`iso.html`
with every `<script>` and `modulepreload` stripped) still paints ~370 ms after
`responseEnd`, which is parse + style + layout of the 537 KB / 154 KB-gzip
document. So: the honest page-attributable paint budget is ~400 ms, roughly all
of it the document itself, and the 2,776 → 1,788 improvement is mostly the
lighter font payload plus a quieter box. **Do not read it as a 1-second win.**

### Warm (primed cache)

| metric | baseline | final |
|---|---:|---:|
| total bytes | 51,817 | 52,891 |
| first paint | 224 ms | 172 ms |
| loading screen done | 3,435 ms | 3,092 ms |
| ├ phase: models | 1,884 ms | 1,573 ms |
| ├ phase: audio | 263 ms | 188 ms |
| └ phase: prewarm | 739 ms | 980 ms |
| long tasks first 10 s | 8 / 1,212 ms | 7 / 1,143 ms |
| post-loading stall | 0 ms | 0 ms |
| post-load fps | 60 | 60 |

Warm boot got **faster overall** (-343 ms) despite the wider prewarm net,
because programs already in the driver's cache re-link cheaply. This is the
arm that most resembles a returning player.

---

## 4. Runtime — baseline vs final

`tools/_perfprobe_wf.mjs`, `chrome-headless-shell`, **CPU throttle 4x**,
1180x820 @ dsf 2, 30 s samples, bot-driven combat. Both runs bound the **Intel
iGPU** via ANGLE/D3D11 (`ANGLE (Intel, Intel(R) Graphics (0x0000B0A0) …)`) —
that is the pessimistic path and it is what makes these numbers a useful mobile
proxy, but the baseline sheet does not record which adapter it bound, so
adapter parity across the round is **assumed, not proven**.

### B — floor 10 combat (the headline scene)

| metric | baseline | final run 1 | final run 2 |
|---|---:|---:|---:|
| load to playable | 6.6 s | 8.6 s | 6.6 s |
| **delivered fps** | **9.1** | **13.7** | **10.1** |
| frame p50 | 100.0 ms | 66.8 ms | 83.4 ms |
| frame p95 | 150.0 ms | 133.4 ms | 150.0 ms |
| **frame p99** | **516.7 ms** | **183.4 ms** | **200.0 ms** |
| **worst frame** | **1,683.2 ms** | **250.0 ms** | **1,099.9 ms** |
| frames > 33 ms | 296 | 328 | 321 |
| long tasks | 294 / 29,843 ms | 306 / 26,571 ms | 320 / 29,726 ms |
| **longest long task** | **622 ms** | **241 ms** | **226 ms** |
| draw calls / rAF | 556.7 | 551.8 | — |
| triangles / rAF | 936,992 | 891,984 | — |
| **render passes / rAF** | **23** | **22** | — |
| **programs during fight** | **164 (grew 16)** | **257 → 257 (grew 0)** | **257 → 257 (grew 0)** |
| textures over the fight | 278 → 510 (**+232**) | 318 → 376 (**+58**) | 310 → 359 (**+49**) |
| geometries | 149 | 141 | 146 |
| heap alloc | 5.24 MB/s | 4.87 MB/s | — |
| GC drops / collected (15 s) | 6 / 64.7 MB | 3 / 50.1 MB | — |
| working set (total) | 3,444 MB | 3,519 MB | 3,311 MB |
| monsters alive at end | 119 | 122 | 116 |

The shape of the win is **tails, not throughput**. `frames > 33 ms` is flat —
this scene is genuinely too heavy for a 4x-throttled iGPU and always will be —
but the catastrophic frames are gone: p99 is down 61-64%, the longest single
blocked task is down 61%, and the 16 mid-fight shader compilations that caused
the multi-hundred-millisecond spikes are down to zero. That is the difference
between "the game stutters" and "the game freezes", and it is the difference the
owner asked for.

### A — floor 2 calm — **the one metric that moved the wrong way**

| metric | baseline | final run 1 | final run 2 |
|---|---:|---:|---:|
| **delivered fps** | **36.3** | **33.0** | **31.5** |
| **frame p50** | **16.7 ms** | **33.3 ms** | **33.3 ms** |
| frame p95 | 66.7 ms | 50.0 ms | 33.4 ms |
| frame p99 | 183.4 ms | 99.9 ms | 50.1 ms |
| worst frame | 533.2 ms | 1,150.0 ms | 1,166.6 ms |
| frames > 33 ms | 167 | 212 | 208 |
| frames > 50 ms | 68 | 33 | 12 |
| long tasks | 72 / 7,006 ms / max 397 | 42 / 3,530 / max 405 | 9 / 1,685 / max 718 |
| draw calls / rAF | 230.0 | 228.7 | — |
| triangles / rAF | 480,056 | 478,762 | — |
| render passes / rAF | 23 | 22 | — |
| programs | 148 | 255 | 255 |
| textures | 118 | 154-160 | 156-159 |
| **heap alloc** | **10.13 MB/s** | **6.51 MB/s** | — |
| GC drops / collected (15 s) | 7 / 185.6 MB | 3 / 85.3 MB | — |

**Read this honestly.** The calm scene's median frame moved up one full vsync
step (16.7 → 33.3 ms) and delivered fps fell ~10%, in both runs. Everything
else about the distribution got better — p99 halved or quartered, frames over
50 ms fell from 68 to 33 and then 12, long-task time fell 50-76%, allocation
churn fell 36%, GC collected less than half as much.

That combination is what you get when the mean frame moves from 27.5 ms to
30.3 ms while the spikes disappear: the frame stops occasionally making the
16.7 ms vsync and lands consistently on 33.3 ms. **A ~10% mean-frame regression
on a calm scene is real and I am not explaining it away.** The most likely
cause is the resident cost of the wide shader prewarm (opt1): this scene now
holds 255 programs instead of 148 and ~40 more textures, and the materials are
deliberately never disposed because disposing them would release the programs.
On an iGPU with a 3 GB working set that is not free. It was not isolated —
proving it needs an A/B with the prewarm net narrowed, which is the first thing
a follow-up round should do.

### C — floor 16 combat

| metric | baseline | final run 1 | final run 2 |
|---|---:|---:|---:|
| delivered fps | 27.3 | 29.7 | 27.6 |
| frame p50 | 33.3 ms | 33.3 ms | 33.3 ms |
| frame p95 | 50.0 ms | 50.1 ms | 50.1 ms |
| frame p99 | 66.7 ms | 66.7 ms | 66.7 ms |
| worst frame | 1,949.9 ms | 1,166.7 ms | 1,133.3 ms |
| frames > 33 ms | 307 | 273 | 280 |
| long tasks | 44 / 2,470 / max 87 | 42 / 2,702 / max 245 | 57 / 3,571 / max 345 |
| draw calls / rAF | 231.5 | 230.0 | — |
| triangles / rAF | 877,875 | 875,226 | — |
| render passes / rAF | 23 | 22 | — |
| programs | 155 | 261 | 261 |
| textures | 267 | 307 | 307 |
| heap alloc | 9.23 MB/s | 9.04 MB/s | — |
| monsters alive at end | 192 | 192 | 192 |

Essentially flat, with a better worst frame and fewer dropped frames. Note the
longest long task got **worse** (87 → 245/345 ms); with 192 monsters alive this
scene is dominated by `computeSeparation`, see hotspots below.

### Memory

| metric | baseline | final |
|---|---:|---:|
| resident PCM (`residentPcmBytes()`) | 14.8 MB | 14.8 MB (all three scenes) |
| renderer process peak | 1,631.8 MB | 1,637.2 / 1,668.2 MB |
| GPU process peak | 1,464.4 MB | 1,532.9 / 1,461.2 MB |

Unmoved. Nothing this round targeted resident memory (audio r2 already did that
on main); opt8 was a **wire-cost** fix, not a memory one, and `residentPcmBytes`
correctly reports no change. The GL-texture leak opt4 closed is VRAM, which
these process counters do not cleanly separate.

---

## 5. WebKit / iPad-viewport smoke

`tools/_mobile/webkit_smoke.mjs`, Playwright WebKit, 1180x820 @ dsf 2, touch,
iPad UA, floor 5, 60 s touch-driven play.

| check | verdict | detail |
|---|---|---|
| boot: loading screen fully left | PASS | settled 10,368 ms, playable 23,543 ms |
| fingerprint: iso bundle | PASS | `iso-BYTJSQ6d.js` |
| webgl: context is WebGL2 | PASS | renderer `Apple GPU`, maxTex 16384, maxSamples 8 |
| webgl: extension gaps | WARN | missing `WEBGL_compressed_texture_astc`, `…_etc`, `OES_texture_half_float_linear` (of 30 present) |
| **shader: zero programs built after boot** | **PASS** | prewarmed **257**, built after boot **0** |
| touch: zone table exists | PASS | preset `compact` |
| touch: synthetic stick moves the crawler | PASS | 5.17 tiles in ~2.4 s |
| touch: chip taps resolved as casts | PASS | taps and cooldown refusals both routed |
| touchdebug overlay boots | PASS | |
| post-drive: sim alive on floor 5 | PASS | |
| audio: context running after gesture | **FAIL** | `before=none after=none` |
| perf: 60 s drive | INFO | p50 120 ms, p95 205 ms, p99 325 ms, max 896 ms, 7.43 fps, 447 frames > 50 ms |

Two things to take from this and one not to.

**Take:** the opt1 prewarm result reproduces on a *different shader compiler* —
257 programs prewarmed, zero built during 60 s of play. That is the strongest
evidence in this round that the fix is about the engine's behaviour and not
about ANGLE specifically. Compare opt1's pre-change WebKit arm, which built 7
programs after boot.

**Take:** boot on WebKit is 10.4 s to assets-settled and 23.5 s to playable.
opt1's contended pre-change arm read 22.2 s / 44.1 s and its contended
post-change arm read 87.4 s / 237.2 s — both under a box carrying 85 foreign
chrome processes. Today's cleaner 10.4 / 23.5 s says those figures were mostly
contention, not the change. **It does not say boot is fast on an iPad.**

**Do not take:** the 7.43 fps. WebKit-on-Windows is not Safari-on-Apple-silicon;
it reports `Apple GPU` while running through a Windows compositor with no Metal
path. It is a *correctness and behaviour* proxy — does the touch layer route,
does the shader compiler stay quiet, does anything throw — not a frame-rate
proxy. The `audio: context running` FAIL is likewise a headless-WebKit
limitation (no trusted gesture, no audio session); the same drive shows 16
sound `plays` dispatched, so the director is running.

---

## 6. Per-optimization ledger

| # | change | outcome | commit |
|---|---|---|---|
| 1 | shader prewarm: combat / FX / boss variants | **committed** | `2f6b3d4` |
| 2 | build the campfire behind the loading card | **committed** | `b2e4272` |
| 3 | per-frame allocation elimination | **committed** | `6f06d82` |
| 4 | combat texture churn / bone-texture leak | **committed** | `f42106d` |
| 5 | first-paint code split | **REVERTED** | — |
| 6 | post-chain pass consolidation | **committed** | `fb46341` |
| 7 | fonts → subset woff2 | **committed** | `b7c15f3` |
| 8 | audio fetch scheduling (`battle_winter` trim) | **committed** | `54a173e` |

### 1. Shader prewarm — `2f6b3d4`

Prewarms every combat / FX / boss program variant during the loading phase.
Mid-fight program builds **16 → 0** on floor 10; post-arm builds across all
three scenes 23 → 0; WebKit builds-after-boot 7 → 0. **Cost: prewarm phase
3.68 s → 9.24 s** in its own arm (6.79 s here), and the post-loading stall it
removed was 517 ms / 2 gaps → 0. Pixel gate passed with an A/A control proving
the floor-10 delta sat inside same-build noise.

*Residency cost, declared:* +107 programs, ~+40 textures, +1 geometry held for
the session, never disposed (disposal would release the programs). This is the
prime suspect for the floor-2 median regression in §4.

### 2. Campfire behind the loading card — `b2e4272`

`CharSelectScene.warm()` does the hydrate + two hidden renders during prewarm.
First `charSelect.frame()` **554 ms → 3 ms**; max rAF gap after `loadingDone`
567 → 67 ms; 5 s post-dismiss fps 52.0 → 59.2.

*Correction carried forward:* `openMenu()` is **not** lazy — it runs at module
eval. The whole cost was the first *rendered* frame (8 SkeletonUtils clones,
~28 dressing clones, program variants, first shadow map), so the fix had to be
a render, not a construction hoist.

### 3. Per-frame allocation elimination — `6f06d82`

Calm-floor churn **10.78 → 6.47 MB/s** (-40%), floor-16 21.81 → 9.59 MB/s
(-56%), `update()` self-allocation 145.8 → 37.5 KB/frame (-74%).

*The root cause was not what the brief assumed.* It was not object churn.
~100% of sampled allocation was objects ≤24 bytes — boxed doubles from two
mechanisms: (a) `Object3D.userData` in V8 dictionary mode, so every
`ud.someFloat = x` allocates a fresh HeapNumber (fixed with a declared-shape
`BodyNum` class, NaN sentinels instead of `undefined` to keep fields Double);
(b) `update()` at ~2,100 lines is too large for TurboFan, so it runs
interpreted forever and boxes every intermediate double — proven by ablation
and fixed by extracting `computeSeparation()` and `updateFirelight()`.

*Targets not met:* <2 MB/s and <50 MB collected. ~5 MB/s of the remainder is
inside three.js (uniform setters, animation interpolants) and is unreachable
host-side.

### 4. Combat texture churn — `f42106d`

Floor-10 fight GL textures **+187 → +48** in its own census (+58 / +49 in this
final pass). `retireBody()` disposes a departing rigged body's skeleton bone
textures at the 11 sites where a body leaves for good; `preloadSkinTextures()`
pulls elite/crafted atlases behind the loading card and re-keys the cache from
monster *kind* to *URL* (the table mapped 9 kinds onto 6 files, so the same PNG
was decoded up to 4x).

*The brief's premise was half wrong.* All 181 new GL textures were 12x12 —
three.js per-skeleton **bone textures**, not art. `bossFx.ts` creates no
textures at all.

*Target not met:* `texSubImage2D` self-time <100 ms is unreachable by
preloading. ~90% of it is bone-matrix re-upload:
`WebGLRenderer.projectObject` calls `skeleton.update()` for every in-scene
skinned body *before* frustum culling, so ~170 live rigs re-upload every frame.
The only lever is culling skeletons the camera cannot see, which changes what
is drawn and what casts shadows — a visual decision, out of scope for a
zero-risk pass. It is still visible in this final run: `texSubImage2D` is a
top-10 CPU self-time entry on floor 10 in both runs (608 / 757 ms of 30 s).

### 5. First-paint code split — **REVERTED**

Built `src/isoBoot.ts` (a shim yielding a painted frame between four sequential
dynamic imports) plus a Vite plugin injecting `modulepreload` links to keep the
fetch waterfall flat. It built into 8 chunks and was green on tests and
typecheck. **Reverted on the measurement.**

- Target metric, 3 cold runs per arm: first paint mean 1,425 → 1,375 ms;
  page-attributable (`paint - responseEnd`) 436 → 397 ms. Both inside the
  ±70 ms run-to-run spread. **No win.**
- The decisive control (`tools/_opt5_nojs.mjs`): `iso.html` with *all* script
  and modulepreload tags stripped still paints 383/359 ms after `responseEnd`.
  ~370 ms of the ~400 ms budget is parse + style + layout of the document. No
  JS change can touch it.
- Regressions it did bring: loading screen 10,236 → 11,443 ms; JS requests
  4 → 9; encoded JS 575,166 → 613,011 B.
- Real but off-target: DOMContentLoaded 1,522 → 1,011 ms mean. Eval did leave
  the parse→paint window; it just was not what gated the paint.

**The premise was stale and the parent sheet should be updated:** the baseline
blamed a 1,175 ms module-eval task at 1,112 ms. On the post-opt1..opt4 tree
that task is 310-470 ms. The real lever is `iso.html` itself — 537 KB of markup
with ~6,800 lines of inline CSS in one `<style>`. Deferring the
non-loading-screen overlay markup and CSS is the change that would move this
number; splitting the import graph is not.

### 6. Post-chain pass consolidation — `fb46341`

The Grade `ShaderPass` is gone; its fragment body is appended verbatim to the
end of three's `OutputShader` `main()` in a new `OutputGradePass`. Render passes
per rAF **23 → 22** on every scene (confirmed in this final pass). In its own
matched A/B on floor 16: p50 50.0 → 33.3 ms, delivered 17.4/19.4 → 34.7/34.9
fps. The splice asserts both anchors and throws at construction if a three.js
upgrade rewrites `OutputShader`, rather than silently shipping an ungraded
frame.

*Targets partially met, stated plainly.* 22 is the floor, not the requested
≤21: `EffectComposer` skips disabled passes at zero cost, and it already marks
the last *enabled* pass `renderToScreen`, so there is no trailing copy blit to
merge. And "p50 ≤ 31 ms" is unreachable as written — the frame clock is
vsync-quantised to 16.7 / 33.3 / 50.0.

*Its pixel gate is the reusable one:* both shader paths rendered into one
frozen frame in a single synchronous task on the shipped build,
`gl.readPixels` on each. Control is bit-exact. SMAA off: max channel delta 1.
SMAA on: 32-76 isolated pixels of 1.9 M exceed delta 4 — a thresholded edge
classifier reacting to a 1-LSB input change. `tools/postchain_pixgate.mjs` is
committed.

### 7. Fonts → subset woff2 — `b7c15f3`

Cold font bytes **928,504 → 225,284** (-75.7%), still 4 requests, all 200. TTF
masters kept as the second `src` (pre-woff2 WebKit, and they are the
OFL-license-bearing originals). `.woff2` added to the production server's MIME
map. `tools/fonts/subset.py` is committed and reproducible.

*Two things that would have silently broken the type,* both documented in the
script header: `pyftsubset`'s **default** `--layout-features` drops `smcp`,
`c2sc` and `tnum` — and `iso.html` uses `font-variant: small-caps` on every
title and plaque and `tabular-nums` on every HUD number, so the default would
have swapped real small-caps for synthesized ones invisibly to any byte count.
Built with `--layout-features='*'`. And Cinzel is a **variable** font
(`font-weight: 400 900`); it is not instanced.

*Pre-existing bug found, not introduced:* the LIVE FEED ticker renders mojibake
em-dashes (`â€"`) on **both** arms, i.e. already on main. The same corruption
appears in a `src/sim/config.ts` comment, so it may be a source-file encoding
problem rather than a runtime one. Worth its own ticket.

### 8. Audio fetch scheduling — `54a173e`

`battle_winter` trimmed to a measured 64 s loop: mid-fight fetch **3,737,204 →
900,618 bytes** (-75.9%), buffered-ahead 262.5 → 64.0 s, loop-seam delta 95.1
→ 0.4 dB, peak -7.2 → -7.5 dBFS. `residentPcmBytes` unmoved at 14.8 MB (this
is a wire fix, not a memory fix).

*Two corrections to that brief, both measured.* (a) The stated verification
probe would have passed **vacuously**: the director picks
`BATTLE_TRACKS[floor % 3]`, and `battle_winter` is index 2 — floors 2/5/8/11/
14/17. The floor-10 and floor-16 scenes every perf probe in this repo uses can
*never* fetch it. Verified on floor 11 with floor 10 kept as a control. (b) The
menu-audio half of the task **was already true**; `engine.load()` skips
streamed ids and the director's first frame runs after `loadingDone`. Measured:
zero music bytes before `loadingDone`, `menu.ogg` at `loadingDone`+1 ms. The
1,809,653-byte `cold_audio_bytes` baseline reads high only because the boot
probe's window runs 5 s past `loadingDone` and sweeps `menu.ogg` in — which is
also why that row is *identical* before and after in §3. No win was invented to
fill the gap.

**Owner verdict owed** (logged in `SOUNDPLAN.md §1.3a`): instruments can say the
seam is clean and the level unmoved. They cannot say whether 64 s repeats
audibly or whether it is the right 64 seconds musically. If the owner says it
repeats, the fix is a longer window — rerun the tool with `SPAN=96s`, the next
macro-autocorrelation peak — **not** a revert.

---

## 7. Instrument defects found (fixed; carry these forward)

Three of these would have reported success on a broken build.

1. **`waitForFunction` options in the wrong argument slot.** The signature is
   `(fn, arg, options)`. `webkit_smoke.mjs`, `_opt1_verify.mjs` and the pixel
   gate all passed options *second*, so their 240 s / 300 s timeouts were
   silently the 30 s default. The WebKit smoke crashed on the opt1 build for
   exactly this reason — which would have read as "the change broke WebKit
   boot". All fixed.
2. **Hardcoded bundle hashes in probes.** Two probes asserted
   `iso-m9S46dDd.js` against a live server; a rebuild would leave them
   fingerprinting a stale hash. They now read it from `dist/iso.html`.
3. **The boot probe polls for `loadingDone` at 40 ms.** On the pre-opt2 build
   the boundary freeze blocked the poller itself, so the 554 ms stall got
   booked as a *pre*-`done` long task and the probe reported
   `post_loading_stall_ms = 0` on a build that still froze.
   `tools/_opt2_stall.mjs` timestamps the dismissal with a `MutationObserver`
   and wraps `CharSelectScene.frame/.warm`, attributing the freeze instead of
   inferring it. **Use it alongside the boot profile.**
4. **`tools/_pixgate_wf.mjs` seeded its frozen clock from `performance.now()`**,
   so two captures of the *same* build differed by mean 27.3 on floor 10. Fixed
   to an absolute base and committed — this matters for every future stream on
   this branch, because without it the gate cannot distinguish a real visual
   change from its own noise.
5. **`performance.memory` is frozen under `chrome-headless-shell`.**
   `_perfprobe_wf.mjs` reads `heapStart == heapEnd == heapPeak` and an alloc
   rate of exactly 0 on all three scenes — before *and* after. The
   `a_heap_alloc_mb_per_s` row in the baseline came from
   `_pm_runtime_profile.mjs` (headed), and the honest churn numbers in §4 come
   from `_perfprobe2_wf.mjs` via CDP `Runtime.getHeapUsage`. **Do not quote
   `_perfprobe_wf`'s heap block.**
6. **A type gate that measured nothing.** The first font gate built its
   specimen with `innerHTML` and emitted `style="font-family:"Cinzel";…"` — the
   attribute terminated at the inner quote, so every row rendered in the
   inherited face. Before/after PNGs came back pixel-identical, which was true
   and meaningless. The tell was that all 15 rows also had *identical* widths.
   The replacement asserts 17 distinct row widths before trusting the picture.

**Still broken, for the next round:** `tools/_pixgate_wf.mjs`'s **floor-10**
capture is not reproducible even with the clock pinned. Two captures of arms
whose structural census is byte-identical still differ in viewer count and
ticker line count, i.e. they reach different sim times and photograph the boss
telegraph bloom at different phases. Same-build controls score mean 9.4-27.3
there. **Any round using floor 10 as a pass/fail pixel gate is reading its own
noise.** Floor 4 is sound (~0.2 mean).

---

## 8. Remaining hotspots

CPU self-time, 30 s at 4x throttle, both runs agreeing. `(program)` is the
native/driver bucket and `dressing-*.js` is where three.js landed in the chunk
split.

**Floor 16 (192 monsters) — host-side, and the largest remaining host cost:**

| function | self ms (run 1 / run 2) |
|---|---:|
| `(program)` — driver | 6,709 / 6,721 |
| **`computeSeparation` @ renderer3d** | **2,260 / 2,041** |
| **`update` @ renderer3d** | **1,724 / 1,411** |
| `setFromQuaternion` (three) | 1,107 / 1,118 |
| `evaluate` (animation interpolants) | 573 / 534 |

1. **`computeSeparation` is now the single biggest host function at depth.**
   It is the O(n²) render-side monster separation pass — opt3 extracted it out
   of `update()` to stop the interpreter boxing its intermediates, which fixed
   the *allocation*, but the quadratic work is untouched. At 192 monsters it is
   ~2.1 s of 30 s. A uniform-grid spatial hash would make it near-linear and is
   pure host code with no sim contact. **Highest-value next move.**
2. **`update()` self is still ~22.3 KB/frame of interpreter double-boxing**,
   all in the monster reconcile loop — the largest remaining inline block.
   Extracting it needs ~8 locals threaded through (`inVision` closure,
   `rigFull`, `rigStep`, `sepEase`, `p`, `rebuilt`), so it is a bigger and
   riskier move than opt3's two extractions.
3. **Skeleton bone-matrix upload.** `texSubImage2D` is a top-10 entry on floor
   10 (608 / 757 ms). `projectObject` calls `skeleton.update()` for every
   in-scene skinned body **before** frustum culling, so every live rig
   re-uploads its bone matrices every frame regardless of visibility. Fixing it
   means culling skeletons the camera cannot see — a visual decision (shadow
   casters), so it needs an owner-facing gate, not a zero-risk pass.
4. **Duplicated model atlases.** The opt4 census found 5-7 *separate* 1024²
   `THREE.Texture`s all named `dungeon_texture` — the same source PNG embedded
   in different GLBs, ~39 MB of duplicated VRAM. Deduping by name+size would
   free real budget but assumes same-named atlases are pixel-identical, so it
   wants its own scoped pass.
5. **`iso.html` is 537 KB with ~6,800 lines of inline CSS.** The opt5 no-JS
   control proves ~370 ms of first paint is this document alone. Deferring the
   non-loading-screen overlay markup and CSS is the only remaining lever on
   first paint.
6. **The floor-2 median regression** (§4). Suspect: the prewarm's ~107 retained
   programs and ~40 retained textures. Needs an A/B with a narrowed prewarm net.
7. **The allocation floor is three.js itself** — uniform setters
   (`setValueV3f`/`M4`) and animation interpolant `evaluate` at ~5 MB/s,
   unreachable without patching `node_modules`.
8. **Boot is model-bound.** 32.4 MB across 260 GLB requests, and the top 8
   character GLBs alone are 17.9 MB. Nothing this round touched it, and it is
   the largest single number on the sheet. Draco/meshopt compression or a
   deferred second wave for non-floor-1 casts is the obvious lever — and it is
   the one most likely to matter on a phone's network.

---

## 9. What only a real device can prove

This is the part the numbers above cannot reach. **The owner tests on a phone
against production; a localhost screenshot cannot overrule that** (HANDOFF §5).

1. **Whether it is actually smooth on an iPhone / iPad.** Every runtime number
   here is `chrome-headless-shell` on an Intel iGPU at 4x CPU throttle — a
   *proxy* chosen because it is pessimistic, not because it is Apple hardware.
   Tile-based deferred rendering (PowerVR/Apple GPU) has a completely different
   cost model from immediate-mode desktop D3D11: overdraw, MSAA resolves and
   full-res RGBA16F post-chain traffic are priced differently, and opt6's win
   in particular was a *bandwidth* win whose size is architecture-dependent. The
   direction of every change here should hold; the magnitudes will not.
2. **How long boot actually takes on a phone, on a phone's network.** 32.4 MB
   of models over cellular is the dominant term and no local probe models it.
   And the prewarm cost this round deliberately added (+3.1 s locally) is paid
   in Apple's shader compiler, which is not the compiler that was measured.
   WebKit-on-Windows is a pessimistic and structurally different stand-in.
3. **Whether the longer loading screen is acceptable in practice.** The owner
   said longer up-front loading is acceptable in principle. 10.5 s cold on a
   fast desktop is the local number; the phone number is unknown and the
   *felt* verdict is the owner's.
4. **Thermals and battery.** A 30-second sample cannot see the sustained
   throttle a phone applies after minutes of play. Nothing here measures
   whether a 15-minute run stays at the fps a 30-second run reports.
5. **Whether `battle_winter`'s 64-second loop repeats audibly**, and whether it
   is the right 64 seconds musically. No agent in this loop can hear. Open in
   `SOUNDPLAN.md §1.3a`.
6. **Whether anything looks worse.** Every change passed a pixel gate, and the
   strongest of them (opt6's two-path in-frame `readPixels`, opt7's in-page
   type specimen) removed build and sim variance entirely. But a gate proves
   *pixels did not change*; it does not prove *the game still looks good* on a
   6-inch OLED at arm's length. Torch bloom, fog density and the vignette are
   exactly the things that read differently on a phone.
7. **Touch feel.** The WebKit smoke proves the touch router *resolves* taps and
   stick movement. It cannot prove the stick feels good, that the chips are
   reachable one-handed, or that the deadzone is right.

---

## 10. Reproducing this report

```
cd .claude/worktrees/perf-mobile/dungeon-crawler-carl
npm run build
npx vite preview --port 5288 --strictPort &     # production build only
curl -s localhost:5288/iso.html | grep -o 'iso-[A-Za-z0-9_-]*\.js'   # must match dist/
node tools/_boot_profile_r1.mjs        > tools/_final_boot.json
node tools/_perfprobe_wf.mjs           # -> tools/_perfprobe_wf.out.json
node tools/_perfprobe2_wf.mjs          # -> tools/_perfprobe2_wf.out.json
node tools/_mobile/webkit_smoke.mjs    > tools/_final_webkit.json
```

One browser at a time — the box crashes at ~6 headless browsers (HANDOFF §5).
Port 5288 only; other 52xx ports belong to other worktrees. Never trust a
server you have not fingerprinted against your own `dist/`.

---
---

# ROUND 2 — the draw-call round

Appended, not merged. **Everything above this line is round 1**
(`perf-mobile@54a173e`) and is left exactly as it was written. This section
re-measures at `perf-mobile@d7a5cd8`, three commits later, and reports what the
three draw-call commits did to the sheet round 1 produced.

Round 1's thesis was *tails*: stop the freezes. Round 2's thesis was **draw
calls** — a CPU-side cost paid per frame by the main thread, and on a
phone-class CPU going through WebKit's WebGL-to-Metal translation typically the
dominant runtime cost. Three commits attacked three classes of object:
characters, environment, FX overlays.

---

## 11. Method — what changed since §1, and why

Same three scenes, same probes, same 4x CPU throttle, same 1180x820 @ dsf 2.
Two things about the harness are different and both matter.

**`vite preview` is banned for measurement on this project.** §1 and §10 above
tell you to serve `dist/` with `vite preview`. Do not. It serves GLB
identity-encoded and does not send the precompressed representation the shipping
server sends, and measuring against it produced two separate false conclusions
in earlier streams. Round 2 served the production build with the **shipping
server**:

```
npm run build
STATIC_DIR=dist PORT=5288 npx tsx src/server/gameServer.ts   &
```

**Fingerprint before trusting anything.** Round 2's check, run before the first
probe:

| check | result |
|---|---|
| bundle name in `dist/iso.html` | `iso-CPI36A8V.js` |
| bundle name in served `/iso.html` | `iso-CPI36A8V.js` |
| served `/iso.html` vs `dist/iso.html` | **byte-identical** (`cmp`) |
| `GET /assets/characters/4gtn.glb` | `content-encoding: gzip`, `content-type: model/gltf-binary` |

Both probes fingerprint again themselves and throw on a mismatch. The WebKit
smoke recorded `iso-CPI36A8V.js` independently.

### 11.1 The contention record (read this before any fps number)

Round 1 had to print two disagreeing runs because ~80 foreign `chrome.exe` and
~83 `node` processes from parallel worktrees were live throughout. Round 2
waited for a quiet box instead, twice, and **the instrument recorded its own
contention**: `_perfprobe_wf.mjs` counts every `%chrome%` process it does not
own, so a sibling's headless browser shows up as exactly +5.

| | foreign chrome | verdict |
|---|---:|---|
| run 1, floor 2 | 77 | quiet (77 = the owner's own Chrome, this box's floor) |
| run 1, floor 10 | **82** | **sibling headless live** |
| run 1, floor 16 | **82** | **sibling headless live** |
| run 2, all three scenes | 77 | quiet |

Timeline: a sibling browser was live on arrival, went quiet at 06:36:38, and I
started immediately. It **relaunched at 06:38:09**, mid-run-1, which is what the
82s are. I waited again (06:41 → 06:46:38) and ran run 2 entirely inside the
quiet window. `npm test` and `npm run typecheck` were run during the waits, not
during the samples. The draw-call probe's run 1 fell entirely inside the
contended window; its run 2 entirely inside the quiet one.

**The disagreement between the two runs is not explained by that contention**,
and I am not going to pretend it is: on floor 10 the *contended* run was the
faster one (18.9 vs 16.6 fps). Treat the run-to-run spread below as the
instrument's own error bar on this box.

---

## 12. Headline — baseline → round 1 → round 2

`tools/_perfprobe2_wf.mjs` for the geometry columns, `tools/_perfprobe_wf.mjs`
for the frame columns. Every round-2 cell is **both runs, unaveraged**.

### Floor 10 combat — the scene this round was aimed at

| metric | baseline | round 1 final | **round 2 run 1 / run 2** |
|---|---:|---:|---:|
| **draw calls / rAF** | **556.7** | **551.8** | **273.2 / 299.5** |
| triangles / rAF | 936,992 | 891,984 | 954,430 / 1,025,009 |
| render passes / rAF | 23 | 22 | **22 / 22** |
| **delivered fps** | **9.1** | **13.7 / 10.1** | **18.9 / 16.6** |
| frame p50 | 100.0 ms | 66.8 / 83.4 ms | **50.0 / 50.1 ms** |
| frame p95 | 150.0 ms | 133.4 / 150.0 ms | **66.8 / 83.3 ms** |
| frame p99 | 516.7 ms | 183.4 / 200.0 ms | **149.9 / 100.0 ms** |
| worst frame | 1,683.2 ms | 250.0 / 1,099.9 ms | 866.7 / 816.6 ms |
| long tasks | 294 / 29,843 ms | 306 / 26,571, 320 / 29,726 | 274 / 17,080, 365 / 22,511 |
| longest long task | 622 ms | 241 / 226 ms | **380 / 140 ms** |
| geometries | 149 | 141 / 146 | **95 / 85** |
| textures over the fight | 278 → 510 (**+232**) | +58 / +49 | **+10 / +16** |
| programs during fight | 164 (grew 16) | 257 (grew 0) | 261 (grew 0 in-window) |
| monsters alive at end | 119 | 122 / 116 | 120 / 125 |

**Draw calls per frame are down 46-51% from the baseline** and the two runs'
ranges do not overlap it. Median frame time halved from the baseline
(100.0 → 50.0 ms) and is a full vsync step better than round 1's. p99 is down
71-81% from baseline.

### Floor 2 calm — round 1's one wrong-way metric, reversed

| metric | baseline | round 1 final | **round 2 run 1 / run 2** |
|---|---:|---:|---:|
| draw calls / rAF | 230.0 | 228.7 | **192.3 / 192.3** |
| triangles / rAF | 480,056 | 478,762 | 478,696 / 479,038 |
| render passes / rAF | 23 | 22 | 22 / 22 |
| delivered fps | 36.3 | 33.0 / 31.5 | **47.9 / 40.1** |
| **frame p50** | **16.7 ms** | **33.3 / 33.3 ms** | **16.7 / 16.7 ms** |
| frame p95 | 66.7 ms | 50.0 / 33.4 ms | 33.4 / 33.4 ms |
| frame p99 | 183.4 ms | 99.9 / 50.1 ms | 33.4 / 49.9 ms |
| worst frame | 533.2 ms | 1,150.0 / 1,166.6 ms | 766.6 / 1,033.3 ms |
| frames > 33 ms | 167 | 212 / 208 | 67 / 123 (**4.5% / 9.8%** of frames) |
| long tasks | 72 / 7,006 / max 397 | 42 / 3,530, 9 / 1,685 | **0 / 0, 1 / 53** |
| heap alloc | 10.13 MB/s | 6.51 MB/s | 6.12 / 7.43 MB/s |

**§4's stated regression is gone.** The calm median went 16.7 → 33.3 ms in
round 1 (both runs) and is back at **16.7 ms in both runs** here, with delivered
fps above the original baseline for the first time on this branch. There is a
mechanism — this scene's draw calls fell 16% — but see §15 for what I will not
claim about the magnitude.

### Floor 16 combat

| metric | baseline | round 1 final | **round 2 run 1 / run 2** |
|---|---:|---:|---:|
| draw calls / rAF | 231.5 | 230.0 | **203.5 / 204.0** |
| triangles / rAF | 877,875 | 875,226 | 872,026 / 875,226 |
| render passes / rAF | 23 | 22 | 22 / 22 |
| delivered fps | 27.3 | 29.7 / 27.6 | **26.3 / 32.1** |
| frame p50 | 33.3 ms | 33.3 / 33.3 ms | 33.3 / 33.3 ms |
| frame p95 | 50.0 ms | 50.1 / 50.1 ms | 66.7 / 50.0 ms |
| frame p99 | 66.7 ms | 66.7 / 66.7 ms | 100.0 / 50.1 ms |
| worst frame | 1,949.9 ms | 1,166.7 / 1,133.3 ms | **700.0 / 799.9 ms** |
| frames > 33 ms | 307 | 273 / 280 | 316 / 214 (38.9% / 21.1%) |
| long tasks | 44 / 2,470 / max 87 | 42 / 2,702, 57 / 3,571 | **1 / 59, 15 / 827** |
| geometries | — | — | 79 / 80 |

Floor 16 is where the two runs disagree most (26.3 vs 32.1 fps), and run 1 is
the contended one. **That disagreement is the error bar; I am not averaging it
into a single number.** The p50 has not moved in three measurements — this scene
is vsync-pinned at 33.3 ms and dominated by `computeSeparation`, not by draw
calls (§8.1, still open, still the highest-value host-side move).

### `frames > 33 ms` is a count, not a rate — do not compare it across rounds

It rises when fps rises, because more delivered frames means more frames to
count. Floor 10 reads 490 / 505 here against a baseline 296, and that is not a
regression: as a *fraction* it is 81.3% / 95.3% of frames, on a scene that is
genuinely too heavy for a 4x-throttled iGPU and always will be. Fractions are
given above where I have both numerator and denominator; the baseline sheet did
not record frame totals, so the baseline fractions cannot be reconstructed.

---

## 13. Per-class ledger — the three commits, with gate results

| # | class | change | floor-10 calls/frame, own A/B | gate | commit |
|---|---|---|---:|---|---|
| 1 | **characters** | merge each rig's skinned parts into one SkinnedMesh per material | 620.2 / 559.0 → **355.3 / 372.6** | PASS | `eb25a1b` |
| 2 | **environment** | carry a prop's tint per instance so its batches merge | 373.5 / 409.7 → **314.6 / 305.5** | PASS, one measured residual | `0f6549f` |
| 3 | **FX overlays** | draw every contact-shadow disc in one instanced call | 305.0 / 322.6 → **282.0 / 293.0** | PASS, byte-identical | `d7a5cd8` |

Each commit re-measured its own baseline before starting, because the census
that opened the round was stale within one commit. The arms above are each
change's own A/B, not a chain — which is why they do not compose arithmetically
into the 273 / 300 in §12.

### 13.1 Characters — `eb25a1b`

A KayKit character ships as 6-14 separate `SkinnedMesh` nodes already sharing one
material and one bone set; nothing in this codebase addresses a limb on its own.
Cleric 8 parts → 2, paladin 11 → 2, 4GTN 12 → 2. Meshes per drawn rig
9.33 → 3.33; body colour draws/frame 26 → 8; body shadow draws/frame 8.5 → 2.

`InstancedMesh` per (geometry, material) is the **wrong** tool here and was not
used: `SkinnedMesh` cannot be instanced, and it turned out not to matter, because
the win is intra-rig rather than inter-rig.

**The non-obvious part.** The shipped GLBs are gltfpack output with
`KHR_mesh_quantization`, so every primitive owns a *separate* skin whose
`inverseBindMatrices` carry that primitive's dequantization. The skins bind
identical bones and are still not interchangeable. Naive `mergeGeometries`
reproduces the pose of exactly one part and scatters the rest across the arena.
The fix derives the rewrite (`v' = Bm_ref⁻¹ · Q_p · Bm_p · v`, with
`Q_p = bi_ref[j]⁻¹ · bi_p[j]` proven joint-independent) and **checks six
preconditions per group**, refusing any group that fails one — so a model that
cannot merge loses nothing. Only positions are rewritten (int16 grid → float32,
strictly more precise); normals, UVs, skin indices and weights are copied
bit-for-bit, legal precisely because `Q` is verified to be a uniform scale.

*Proof independent of the pixel gate:* `tools/_rigmerge_verify.mjs` loads all
**68** shipped character GLBs through the real `GLTFLoader` + `MeshoptDecoder`,
CPU-skins every vertex before and after across four random poses, and
index-aligns the point clouds. 68 of 68 merged, zero groups refused, **worst
position error 4.674e-7 world units** on a 1.1-unit-tall character.
`test/rigMerge.test.ts` guards the math permanently, including five refusal paths.

*Gate:* two pinned scenes, clock frozen on an absolute base (§7.4), **six frames
per scene 992 ms of animation apart** rather than one still, and — because the
raw diffs were non-zero — the gate's own noise floor established by running it
twice on the same build. All twelve frames sit inside the same-build control
range; on floor 10 the change diff is *below* the control on every frame.
Transparency: transparent draws/frame identical (40 → 40, 39 → 39), and blended
geometry is refused by construction. Shadow casting: every drawn mesh still
carries `castShadow`; `mon:171` shadow draws 4 → 1 per frame as its 8 meshes
became 2. Frustum culling: `DRAWN_WHILE_INVISIBLE` empty in both arms, zero
merged meshes with `frustumCulled` disabled.

*Side effects visible in §12:* live GL textures on the floor-10 fight 379/348 →
200, geometries 135/133 → 86, and **skeletons across 125 tracked rigs
1086 → 198** — the bone-texture collapse §8.3 asked for. That is the mechanism
behind the +232 → +10/+16 texture-growth row.

### 13.2 Environment — `0f6549f`

§8's census claimed prop batches differed only by "material-clone identity, not
any real material difference". **That was wrong**, and deduping on it would have
merged nothing: every placed prop draws a quantized value/warmth variant
(`PROP_VARIANTS`/`FOLIAGE_VARIANTS`) baked into a cloned material's colour.
Keying with colour merges 55 of 58 batches on floor 10 — i.e. nothing. The fix
moves the tint off the material onto the batch's per-instance colour: batches
58 → 20 on floor 10, 55 → 22 on floor 4.

**The trap that almost shipped:** `material.vertexColors = true` +
`InstancedMesh.instanceColor` renders every batched prop **black**. three.js only
multiplies `vColor` into `diffuseColor` under `USE_COLOR`, and `USE_COLOR` makes
the vertex shader read a `color` *attribute* these geometries do not have.
(`defaultAttributeValues.color = [1,1,1]` is defined in the `ShaderMaterial`
constructor; `MeshStandardMaterial` has none, so the generic attribute stays at
WebGL's `(0,0,0,1)`.) The pixel gate caught it — floor-4 mean 1.77 against a 0.20
noise floor, 240 max channel delta. The shipped fix injects the multiply into
`worldLit`'s own prop stage, gated on `USE_INSTANCING_COLOR`. Setting
`material.defaultAttributeValues` would also work, but `Material.copy()` does not
copy it, so any future clone would silently revert to black props — a landmine,
deliberately not taken.

*Gate:* pinned absolute clock, 5 stills per scene, read by eye at 1:1 and 8x,
plus `tools/_diffmap` (connected-component analysis separating 1-2px edge rims
from filled patches — this is what turned "0.28 vs 0.20, is that noise?" into a
decidable question). Tint correctness is checked as arithmetic, not by eye: the
gate asserts `batchMaterial.color * instanceColor == the old tinted
material.color` for every live instance on both floors, **worst case 3.3e-8**.
Frustum culling is not weakened — this is not a spatial merge, it merges material
variants of one geometry over the same membership set, so instances submitted per
frame are unchanged (floor 10: 54 live before and after) while drawn batch
objects fell 31 → 11.

*The residual, declared:* before-vs-after sits at 0.264-0.341 mean against a
0.197-0.263 same-build noise floor, with 9-10 "thick" components, reproduced
across two independent captures. A/B isolated it to the `USE_INSTANCING_COLOR`
**program recompile**, not the merge: the added varying with no `instanceColor`
sits on the noise floor (0.205-0.252, 1 thick), while tint transport *without*
the merge reproduces the residual (0.253-0.302, 8 thick). Mechanism is
`wlN = cross(dFdx(vWlPos), dFdy(vWlPos))` moving in its last bits — a
cancellation on near-horizontal faces, which is why it lands on barrel lids and
crate tops and not on the barrels' vertical sides. ~10 patches over 0.35% of the
frame, invisible at 1:1 and at 8x. Recorded rather than averaged away.

### 13.3 FX overlays — `d7a5cd8`

Contact-shadow discs draw as one `InstancedMesh`: that bucket goes 43 → 3 draws
on a dense frame. Interleaved drift-cancelling A/B (`tools/_fxdc_wf.mjs`), run
twice: per-mesh 305.0 → batched 282.0, and 322.6 → 293.0. All ten interleaved
rounds negative, -18.5 to -34.3. Honest figure **-23 to -30 calls/frame**.

*Gate:* the decisive instrument was a **same-page A/B on one frozen sim state**
(batched → legacy per-mesh → batched again), so no cross-run drift is involved.
Both scenes **byte-identical, mean 0.000, max channel delta 0**. On a dense
41-disc frame with every body hidden so the frame *is* the discs: mean 0.025 /
19 pixels over threshold, against a same-setting noise floor of 0.035 / 36 —
**the batch differs from the per-mesh path by less than the per-mesh path differs
from itself.** Order-independence is proven, not eyeballed: all discs are the
same black at the same alpha with `depthWrite` off, so `dst·(1-a)·(1-a)` is
commutative. Frustum culling verified still culling — the `InstancedMesh`
bounding sphere is rebuilt every frame from the instances actually written
(r=7.32 around a pack, r=0.69 with one disc live), because three computes an
`InstancedMesh` sphere once and never refreshes it, so a stale sphere would have
made the merged mesh always-drawn.

*Declined, with the numbers:* `GroundDecals` (9 draws, genuinely instanceable,
worth 8 calls — but the slots carry *different* colours, so collapsing 9
depth-sorted transparent quads into one instance-ordered draw can composite
differently where marks overlap); `hazardRings` (0-6 draws, six ShaderMaterials
with per-ring uniforms, at most 5 calls). Measured and *not* manufactured into
work: particles are already 3 draws total for the whole system; health bars and
damage numbers are DOM and cost **zero** WebGL draw calls; the post-chain's 21
fullscreen quads are one draw per pass by construction.

### 13.4 What the round did not touch, and why

- **`floorGroup`** — 98-99 colour draws at 100% instance fill, 188 chunks over 14
  families. Raising `CHUNK` is pixel-safe but trades CPU draw calls for GPU
  instances on a scene already at ~1M triangles, and nobody walked that curve.
  **This is now the single largest remaining bucket.**
- **18 torch `Sprite`s** — one geometry, 18 `SpriteMaterial`s, ~16 amortized
  calls. Needs a camera-facing-quad shader, i.e. real visual risk.
- **Handslot weapon grafts** — 1-2 static draws each, and merging them would
  break `hideAllAttachments`. Deliberately left alone; `ATTACHMENT_NODES` is
  passed into the merge as untouchable, keyed off the same table the toggling
  reads, so a new arsenal node cannot be added on one side only.
- **Monster material clones** — the census's "dedupe them" advice is dangerous as
  written: `applyHitFlash` clones per-mesh specifically so each body owns its own
  `uChHitFlash`/`uChHitTint` uniform *objects*, which no field comparison can
  see. Deduping on field evidence would have silently killed the per-body hit
  flash. It is a uniform-ownership problem, not a redundant-state problem — and
  the rig merge collapsed it as a side effect anyway.

---

## 14. WebKit / iPad-viewport smoke — round 1 vs round 2

`tools/_mobile/webkit_smoke.mjs`, Playwright WebKit, 1180x820 @ dsf 2, touch,
iPad UA, floor 5, 60 s touch-driven play. One run.

| check | round 1 | **round 2** |
|---|---|---|
| boot: loading screen fully left | PASS 10,368 / 23,543 ms | PASS **10,410 / 21,279 ms** |
| fingerprint: iso bundle | PASS | PASS `iso-CPI36A8V.js` |
| webgl: context is WebGL2 | PASS `Apple GPU`, maxTex 16384 | PASS, identical |
| webgl: extension gaps | WARN (3 of 30 missing) | WARN, identical |
| **shader: zero programs built after boot** | **PASS** (257 prewarmed, 0 built) | **FAIL** (261 prewarmed, **2 built**) |
| touch: zone table exists | PASS | PASS (`compact`) |
| touch: synthetic stick moves the crawler | PASS 5.17 tiles | PASS 5.17 tiles |
| touch: chip taps resolved as casts | PASS | PASS |
| touchdebug overlay boots | PASS | PASS |
| post-drive: sim alive on floor 5 | PASS | PASS |
| audio: context running after gesture | FAIL | FAIL (same headless limitation; 17 plays dispatched) |
| perf: 60 s drive | p50 120, p95 205, p99 325, max 896, 7.43 fps | **p50 104, p95 116, p99 128**, max **1,162**, **9.4 fps** |

**The frame distribution tightened a lot and the tail got worse.** p95 205 → 116
and p99 325 → 128 ms is the draw-call reduction showing up on a different
engine; the single worst frame went 896 → 1,162 ms. `frames > 50 ms` reads
564 of 564 — that metric is saturated on this stand-in and carries no
information; p50/p95/p99 are the signal.

**Do not read the 9.4 fps as an iPad number.** WebKit-on-Windows reports
`Apple GPU` while running through a Windows compositor with no Metal path. It is
a correctness-and-behaviour proxy, exactly as §5 says.

Two 404s for `/assets/generated/index.json` are pre-existing (the builder's
dev-only generated-content index is not in `dist/`) and benign.

---

## 15. What got worse

Seven things. One is a real regression with an identified cause.

1. **The shader-prewarm guard fails again: 0 → 2 programs built after boot.**
   This is round 1's headline win partially undone, and it is the most important
   item here. Both builds carry the `wl3p` (world-lit prop) custom cache key —
   one with `uv` (mapped), one without.

   *Cause, traced:* commit `0f6549f` ships prop batches with an `instanceColor`
   attribute. `USE_INSTANCING_COLOR` forks a program permutation, and the prewarm
   zoo's prop grid (`renderer3d.ts`, the "THE WORLD-LIT PROP GRID" block) builds
   its `InstancedMesh` with `setMatrixAt` only — it **never calls `setColorAt`**,
   so it never mints an `instanceColor` buffer and never builds the two
   permutations the shipped batches now need. The grid closes the
   `map × instancing` square; it does not close
   `map × instancing × instanceColor`.

   *Reproduced on both engines, not just WebKit* (`tools/_r2_shaderguard.mjs`,
   headless Chrome, 25 s of play per scene, console tally of the in-app
   shader guard):

   | scene | prewarmed | built after boot |
   |---|---:|---:|
   | floor 2 | 259 | 0 |
   | floor 5 | 261 | 0 |
   | floor 10 | 261 | 0 |
   | **floor 16** | 265 | **2** |
   | **floor 5, WebKit** | 261 | **2** |

   *Not fixed in this round, deliberately.* The fix is small — call `setColorAt`
   on the zoo's instanced prop mesh so both permutations build behind the loading
   card — but it changes the bundle, and every number in §12 was measured against
   `iso-CPI36A8V.js` on a box that took two waits to get quiet. Shipping the fix
   here would leave this sheet describing a build that is not HEAD. **It is the
   first item for the next round**, and it should be re-gated with the WebKit
   smoke plus `_r2_shaderguard.mjs` on all four floors.

2. **Floor-10 triangles are up**: 936,992 (baseline) and 891,984 (round 1) →
   954,430 / 1,025,009. The two runs disagree by 70k, and monsters-alive-at-end
   was 120 and 125 against a baseline 119, so most of this tracks live monster
   count on a scene §7 already documents as non-reproducible. But I cannot prove
   it is *all* scene state. Floor 2 (478,696 / 479,038 vs 480,056) and floor 16
   (872,026 / 875,226 vs 877,875) are flat, so whatever this is, it is specific
   to floor 10. Flagged, not explained.

3. **Longest long task on floor 10, run 1: 380 ms**, against round 1's 241 / 226.
   Run 2 read 140 ms. Run 1 is the contended run. Both are far below the 622 ms
   baseline, but round 1's result does not cleanly hold.

4. **WebKit's worst single frame: 896 → 1,162 ms**, while every percentile below
   it improved. One frame in a 60 s drive.

5. **Resident programs are up ~4 per scene** (255/257/261 → 259/261/265). The
   prewarm zoo grew to cover permutations earlier streams found. §4 named
   resident program count as the prime suspect for round 1's floor-2 median
   regression; that regression reversed anyway, which weakens the hypothesis
   without killing it.

6. **Floor-2 worst frame: 533.2 ms (baseline) → 766.6 / 1,033.3 ms.** Round 1
   read 1,150 / 1,166, so this is better than round 1 and worse than baseline. It
   is a single frame against a p99 of 33.4 / 49.9 ms.

7. **Floor-16 delivered fps run 1 (26.3) is below the baseline (27.3)**, while
   run 2 (32.1) is above it and above round 1. Run 1 is the contended run. The
   scene's p50 has not moved in three measurements.

---

## 16. What only a real iPhone / iPad can settle

§9 stands in full. Round 2 adds four items and sharpens one.

1. **Whether cutting draw calls ~50% is worth what this round assumes it is.**
   The entire premise — that draw calls dominate on a phone-class CPU through
   WebKit's WebGL-to-Metal translation — is an *argument*, not a measurement.
   Nothing on this box establishes the draw-call-to-frame-time conversion; the
   census that opened the round could only bracket it at 0-20%. On the local
   proxy floor 10 gained 9.1 → 18.9/16.6 fps across two rounds, but the local
   proxy is immediate-mode D3D11 on an Intel iGPU, where the per-call cost is
   *lower* than the thing this round is modelling. **If the premise is right the
   device win is larger than the local one; if it is wrong the local number is
   the whole win.** Only the device says which.
2. **Whether the merged rigs still look right in motion, on a 6-inch screen.**
   The gate proves pixels did not change across six frames a second of animation
   apart, and the CPU-skinning verifier proves 4.674e-7 world units of positional
   error across 68 characters and four poses. Neither proves a cape or a shoulder
   plate reads correctly at arm's length while the camera moves.
3. **Whether the prop-tint residual is visible on an OLED.** ~10 patches over
   0.35% of a frame, on near-horizontal faces, from a shader recompile changing
   `dFdx`/`dFdy` in their last bits. Invisible at 8x on a desktop panel. A
   phone's contrast curve is not a desktop panel's.
4. **Whether the two post-boot shader builds are felt.** On desktop they are two
   hitches, once, at floor 16. On an iPad, where no shader disk cache softens them
   and the compiler is Apple's, round 1's own evidence says post-boot builds are
   exactly what the owner feels as a freeze.
5. **Sharpened from §9.1:** round 1 said the *direction* of every change should
   hold and the magnitudes would not. Round 2's changes are CPU-side draw
   submission, which is the one class where a tile-based deferred renderer's
   different cost model should *not* reverse the direction — the call still has to
   cross the translation layer. That is the strongest reason to expect this round
   to travel to the device, and it is still a reason, not a measurement.

---

## 17. Reproducing round 2

```
cd .claude/worktrees/perf-mobile/dungeon-crawler-carl
npm run build
STATIC_DIR=dist PORT=5288 npx tsx src/server/gameServer.ts &     # NOT vite preview
curl -s localhost:5288/iso.html | grep -o 'iso-[A-Za-z0-9_-]*\.js'   # must match dist/
curl -sI -H 'Accept-Encoding: gzip' localhost:5288/assets/characters/4gtn.glb | grep content-encoding
# then WAIT for a quiet box: zero chrome-headless-shell root processes you did not start
node tools/_perfprobe_wf.mjs        # twice, saving each run
node tools/_perfprobe2_wf.mjs       # twice, saving each run
node tools/_mobile/webkit_smoke.mjs
node tools/_r2_shaderguard.mjs      # console tally of post-boot program builds
```

Port 5288 only. One headless browser at a time, closed in a `finally`. Check
`foreignChromeCount` in the probe output **afterwards** — 77 is this box's floor
(the owner's own Chrome); anything above it is a sibling stream that was inside
your sample.
