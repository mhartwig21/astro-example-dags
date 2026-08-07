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
