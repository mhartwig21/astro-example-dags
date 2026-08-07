# ASSET BUDGET — what a cold boot costs, and what this branch changed

Closing report for the `asset-budget` branch. Every number below was measured on
the shipping server against a real browser; nothing here is estimated.

**Headline, cold cache, `/iso.html`:**

| | requests that hit the network | on the wire |
|---|---|---|
| baseline (`main@d7487f1`) | 399 | **35.86 MB** |
| now | 411 | **12.60 MB** |
| now, gesture-gated browser (see §2c) | 410 | **11.76 MB** |

**−23.26 MB, −64.9%.** Repeat visit: **4 requests, 0 bytes** (one `304` on the
document, three live API calls).

---

## 1. How this was measured, and why you can trust it

**The server is the shipping one.** `npm run build`, then `gameServer` with
`STATIC_DIR=dist` on port 5285. This matters more than it sounds: `vite preview`
serves the same bytes under different headers, and measuring against it is what
produced this round's founding error — the brief's *"VERIFIED ON PROD: gzip
achieves ~0% on GLB"*. It does not. `vite preview` serves GLB identity-encoded;
the real server sends a precompressed sidecar. `skeleton_warrior.glb` is
1,741,844 B on disk and **405,342 B on the wire**.

**Server fingerprinted before any measurement** (HANDOFF §5 records a whole round
once measured against a stale server on another branch):

```
GET /assets/characters/skeleton_warrior.62834b82.glb
  cache-control: public, max-age=31536000, immutable
  content-encoding: gzip          content-length: 405342
GET /iso.html
  cache-control: no-cache         content-encoding: gzip
```

Served bytes are byte-identical to `dist/` (`sha256` compared for both the
document and a model), and the model's sha256 begins `62834b82` — the same hash
its own filename carries, so the file is self-describing and provably the one
this build produced.

**Harness**: one headless Chromium at a time, real GPU
(`ANGLE (Intel, Intel(R) Graphics (0x0000B0A0) Direct3D11)`, not SwiftShader),
1440×900, `performance.setResourceTimingBufferSize(6000)` installed before any
page script — the default 250-entry buffer silently truncates a 642-reference
boot and every total under it is a lie.

**Definitions, stated because the baseline did not state them:**

- *first paint* — `performance.getEntriesByType("paint")`, `first-paint`.
- *loading-screen done* — the `#loading` overlay has `.done` or is `display:none`.
- *time-to-interactive* — the overlay is gone **and** the render loop has since
  delivered 3 consecutive `requestAnimationFrame` ticks: the first moment a
  keypress would be both seen and drawn.
- *on the wire* — `transferSize`, i.e. bytes that crossed the socket. **A cache
  hit reports 0 here and its full size in `decodedBodySize`**, which is how a
  cache measurement talks itself into nonsense.

**Instruments** (untracked, `tools/_*` scratch convention):
`tools/_abfinal.mjs` (cold + warm census, floor stills, combat filmstrip),
`tools/_abrows.mjs` (per-row census — the only way to separate distinct bytes
from cache re-references), `tools/_ablineup.mjs` (the casting-call close-ups),
`tools/_abaudio.mjs` (the autoplay-policy A/B/C in §2c). Evidence in
`tools/_abshots/`.

---

## 2. Baseline vs final

### 2a. Cold boot

| | baseline | now |
|---|---|---|
| requests that hit the network | 399 | 411 |
| subresource references | — | 642 |
| **on the wire** | **35.86 MB** | **12.60 MB** |
| bytes the client ends up holding | 35.86 MB | 27.81 MB |
| first paint | 2.78 s | **0.94 s** |
| assets settled | — | 2.70 s |
| loading screen done | 8.66 s | **7.96 s** |
| time-to-interactive | 9.25 s | **8.75 s** |
| 4xx/5xx · page errors · console warnings | — | **0 · 0 · 0** |

Request count went *up* by 12: the shared-texture pool added 29 real requests
and clip pruning removed none. That is the right trade at 29 requests for
1.78 MB, and production speaks HTTP/2 (DEPLOY.md) so they multiplex.

**The 23.26 MB decomposes into two independent effects, and conflating them
would overstate the asset work:**

| | | |
|---|---|---|
| baseline | | 35.86 MB |
| assets made genuinely smaller (clips, textures, fonts) | −8.05 MB | 27.81 MB |
| those assets actually compressed on the wire | −15.21 MB | 12.60 MB |

−22.4% of it is bytes that no longer exist. −54.7% of the remainder is
compression that was always available and was being measured wrong.

### 2b. Warm boot (same context, nothing cleared)

| | |
|---|---|
| requests that hit the network | **4** — `iso.html` (304) + `/auth`, `/rush`, `/boards` |
| transferred | **0.00 MB** |
| first paint | 0.29 s |
| loading screen done | 2.93 s |
| time-to-interactive | 3.30 s |

Every asset and every chunk is a cache hit. This is what the content-hash +
`immutable` work bought, and it only holds because filenames name their bytes.

### 2c. The one number that needs an asterisk

The cold boot fetches **95 audio files, not 94**: `menu.ogg`, 838,358 B, at
~5.9 s. That is not a regression — it is the harness.

`MusicDeck.claim()` defers a bed's download only while
`!unlocked && ctx.state !== "running"` (`src/audio/deck.ts:256`). I instrumented
the `AudioContext` constructor directly and it reports `running` **at
construction, with no user gesture**, under all three policy values
(`no-user-gesture-required`, `user-gesture-required`,
`document-user-activation-required`). Headless Chromium will not produce a
suspended context, so the deferral path never executes here and the deck
correctly downloads a bed it is allowed to play.

On a gesture-gated browser — the owner's iPhone — that bed is held back until the
tap, and the pre-gesture cold boot is **11.76 MB over 410 requests**. Both
numbers are stated everywhere in this document; neither is presented as the
other. The deferral itself is covered by 6 unit tests in
`test/audioStream.test.ts`, including the late-suspend case that would otherwise
silently kill the soundtrack.

### 2d. The 8 heaviest character rigs

Baseline: 17.9 MB combined, and the brief's central problem.

| file | baseline (disk) | now (disk) | now (wire) |
|---|---|---|---|
| skeleton_warrior | 2.51 MB | 1.74 MB | 406 kB |
| skeleton | 2.49 | 1.72 | 392 |
| skeleton_mage | 2.48 | 1.71 | 382 |
| adventurer | 1.92 | 1.36 | 314 |
| barbarian | 1.91 | 1.34 | 307 |
| rogue | 1.91 | 1.34 | 303 |
| rogue_hooded | 1.90 | 1.34 | 300 |
| mage | 1.90 | 1.34 | 299 |
| **combined** | **17.9 MB** | **11.89 MB** | **2.70 MB** |

---

## 3. Per-class ledger

Boot-path bytes. "wire" is what crossed the socket; "distinct" excludes cache
re-references.

| class | refs | net | wire | distinct decoded |
|---|---|---|---|---|
| models | 260 | 260 | 9.555 MB | 23.177 MB |
| audio | 95 | 95 | 1.813 | 1.784 |
| js | 4 | 4 | 0.573 | 1.803 |
| document | 1 | 1 | 0.160 | 0.558 |
| textures | 246 | **29** | 0.309 | 0.300 |
| fonts | 4 | 4 | 0.173 | 0.172 |
| icons | 29 | 15 | 0.013 | 0.017 |
| other | 3 | 3 | 0.001 | 0.000 |
| **total** | **642** | **411** | **12.598** | **27.811** |

The whole shipped tree, base commit vs now:

| class | files | base (disk) | now (disk) | now (wire) |
|---|---|---|---|---|
| models | 265 | 32.367 MB | 23.215 MB | 9.506 MB |
| audio | 110 | 23.183 | 23.183 | 23.183 |
| icons | 298 | 1.634 | 1.634 | 0.264 |
| fonts | 4 | 0.927 | **0.172** | 0.172 |
| textures | 6 → 35 | 0.106 | 0.406 | 0.406 |

### The four rounds, and the pixel gate each one passed

**① Rigged characters — clip pruning.** `12fa237`.
841 clips → 616. Class raw 27.10 → 20.22 MB (−25.4%); on the wire 8.93 →
7.88 MB (−1.05 MB). 25 animated GLBs rewritten, 46 static ones untouched.

> **PIXEL GATE: PASS**, on three independent gates. (1) *Numerically* — 616 kept
> clips / 63,974 channels diffed against the HEAD blobs: worst rotation deviation
> **0.0000°** (bit-identical quaternions), worst translation 4.883e-4 model units
> on rigs ~2.6 units tall, worst scale 0. (2) *Runtime census* — instrumented
> `attachClipAnimator` + `play()` across three scenarios: all 78 slot→clip
> bindings identical, all 23 played slots identical, zero missing-clip warnings,
> 57 frame pairs with no byte-identical consecutive frames (nothing frozen).
> (3) *Pixels* — 57 gameplay frame pairs plus full-resolution close-ups of all 8
> hero skins in the casting call, the only place these rigs render large.
>
> The keep-set is **narrower than the brief asked, deliberately**: keep every clip
> matching any regex in any of the three host consumers (~70/file, not the
> census-derived ~40). Because `pick()` is `clips.find()`, preserving every
> regex's full match-set and ordering makes drift impossible **by construction**,
> not merely absent when checked. That forgoes ~0.7 MB for a property that can be
> proved. Guarded permanently by `test/clipCoverage.test.ts`, which re-derives
> the rule from `renderer3d.ts` and fails if the prune goes stale.

**② Props / environment — cross-file texture dedup.** `740c4e0`.
244 embedded texture instances of only 55 distinct images (76% waste). The 29
images used by 2+ files externalised to `public/assets/tex/`; the 26 single-use
images left embedded on purpose. GLB wire 10.89 → 9.11 MB, +0.29 MB of shared
textures, class net −1.49 MB.

> **PIXEL GATE: PASS**, and proved rather than eyeballed. Stills of a live
> dungeon are weak evidence (boss beam phase, viewer counter and collapse timer
> all move between runs), so
> `tools/asset-pipeline/verify-texture-dedupe.mjs` replays all 218 rewritten
> GLBs against their HEAD versions: **221 images byte-identical**, every geometry
> accessor byte-identical, all counts unchanged. The image bytes were copied,
> never re-encoded, so the pixels *cannot* differ. Runtime assertions identical
> before and after: 332/332 and 370/370 materials with a map decoded,
> `mapNoImage` 0.

**③ Fonts + audio scheduling.** `41a4860`.
4 TTFs → subset WOFF2: 905.5 kB → 167.8 kB on disk, 447,497 → 172,832 B on the
boot path (−61.4%). The upstream TTFs left the served tree entirely. Music no
longer fetched by a page that is not allowed to make a sound (§2c).

> **PIXEL GATE: PASS.** The decisive evidence: the four text-dense panels —
> crawler profile, inventory, key bindings, deep-run sheet — are **pixel-identical**,
> 0 differing pixels above an 8/255 threshold. Reading them confirms they are
> full of type, not blank: en dashes, middots, the approx sign, ×2, the
> right-arrow in "30 raw→ 30 taken", diamond bullets, dotted leaders, arrow-key
> keycaps, and real small caps (`smcp`/`c2sc` survived the subset — synthesized
> small caps would have shifted every glyph). Cinzel stays **variable**
> (`fvar`/`gvar`/`avar`/`HVAR`/`STAT` intact) so 600/700/900 are real instances.

**④ Delivery — content hashes, immutable caching, precompression.** `6f5b9c7`,
`bf319f7` (sibling stream, same branch).
491 files precompressed at build, 27.3 → 10.5 MB. This is the single largest
wire lever on the branch, and it is also what disproved the founding "gzip does
nothing on GLB" reading.

> **PIXEL GATE: N/A by construction** — a `.gz` sidecar and a renamed file cannot
> change a pixel; the decoded bytes are identical or the file does not decode at
> all. Covered by `test/staticCache.test.ts` and re-verified by the closing pass
> below (0 × 4xx across every capture; a GLB that 404s falls back to a
> procedural stand-in *silently*, so the 4xx count is the machine half of that
> check and the stills are the human half).

### Closing visual confirmation (this round)

One browser, `?eagerassets` so stills show final art rather than a mid-stream
mix of real models and stand-ins.

- **Floors 1, 4, 10, 16** at `seed=42`, level-scaled, 191 GLBs each, **0 × 4xx**.
  Read: floor 1 — crates, barrels, bone prop, lit torches, stone wall texture,
  minimap. Floor 4 — the sewer/garden tint, wooden barrels with hoops, baskets of
  red fruit, mushrooms, lanterns. Floor 10 — red band lighting, skulls, coiled
  rope, bones, two rendered monsters. Floor 16 — red banners, damage numbers
  (78/38/635), party-wipe banner, full HUD. Every class of asset present and
  textured in every one.
- **Combat sequence**, floor 7, six frames over a held attack. HP falls
  429 → 397 → 367 across the strip, the crawler translates and rotates between
  frames, the weapon mesh is attached and swinging (visible blade in frame 06,
  swipe trail in 05), enemies engage. No T-pose, no frozen mesh, no
  snapped-to-idle substitution, no missing-texture magenta.
- **The casting call**, all 8 heroes at full scale — the only place these rigs
  render large (at game camera a crawler is ~60–80 px). Read at 1440×900 and
  cropped: plate armour with a visor and shoulder trim, antlered druid hood,
  goggles and belt buckles on the adventurer, the mage's hat and coat collar,
  face detail on every skin. Two captures at different animation phases show
  different arm/torso positions — the idle clips are running, not frozen.
- **0 × 4xx, 0 page errors, 0 console warnings** across the whole pass.

---

## 4. What I did NOT compress, and why

Each of these was measured or reasoned about, not skipped.

1. **Audio — 23.18 MB, the largest class on disk, untouched.** All 16 beds
   measure 69–138 kbps stereo Vorbis at a uniform `-q:a 3`; `menu.ogg`'s higher
   bitrate is content complexity at the same quality setting, not an outlier.
   Music streams lazily and is off the critical path, so re-encoding would gamble
   audible quality — on files the owner already fought a round over
   (SOUNDPLAN 2.2) — for Fly egress and nothing a player would feel. **No `.gz`
   sidecars either**, correctly: Vorbis does not compress, and the build's
   ">10% or no sidecar" rule keeps that honest automatically.
2. **KTX2 / Basis textures.** Textures are 0.31 MB of a 12.60 MB payload after
   dedup — 2.5%. GPU texture formats are typically 2–4× *larger* on disk than
   WebP; they buy VRAM and upload time, not wire bytes. Wrong lever for this
   budget; possibly the right one for a memory round.
3. **Draco, or re-running meshopt.** Measured: ~7% return. The files already
   carry `EXT_meshopt_compression` + `KHR_mesh_quantization` with POSITION i16n /
   NORMAL i8n / TEXCOORD u16n. This is the compression floor.
4. **Animation resampling.** Returns exactly zero — the clips are already
   resampled.
5. **Mesh decimation on the 46 static background characters.** These are now the
   heaviest class on the wire (4.12 MB gzip vs 3.41 MB for the 8 famous rigged
   heavies — *"heaviest files" is not "heaviest download"*), with nine background
   monsters carrying 1.54 MB of meshopt geometry at up to 20k verts for actors
   ~80 px on screen. Decimation is the **only** lever that alters silhouettes, so
   it needs per-model gating at the game camera and cannot be done blind under an
   "any visible degradation is disqualifying" rule.
6. **The last ~0.7 MB of clip pruning** — forgone for the provable keep-set (§3①).
7. **The 26 single-use embedded textures.** Externalising them buys a round trip
   and no bytes.
8. **Icons.** 298 SVGs, 1.63 MB on disk but 0.26 MB gzipped, and a boot fetches
   15 of them totalling 13 kB. A sprite sheet would trade a real architecture for
   nothing.
9. **JS.** 573 kB on the wire over 4 chunks, 4.5% of the payload. This was
   asset-pipeline work; code-splitting `iso` (794 kB decoded) is a different
   round with a different risk profile.

**The biggest remaining lever, unclaimed: brotli sidecars alongside gzip.**
Measured at ~0.7 MB on the character class alone (7.86 → 7.17 MB). The build
already emits `.gz` and `gameServer` already prefers a sidecar, so it is a
symmetrical addition — build-side only, zero visual risk.

---

## 5. What only a real device can prove

The bytes in this document are facts. The timings are a desktop lower bound, and
several claims are *structurally* unprovable on this box.

- **Every duration above.** Loopback has 0 ms RTT, no radio wake, no TLS
  handshake, no thermal throttle, and an Intel D3D11 GPU an order of magnitude
  past a phone's. First paint 0.94 s and TTI 8.75 s are floors, not forecasts.
  The baseline's own GL backend is unstated, so **the before/after timing
  comparison is weaker evidence than the before/after byte comparison** — treat
  the byte numbers as the result and the timings as directional.
- **411 requests on cellular.** Here they run over loopback HTTP/1.1 keep-alive.
  Production negotiates `h2` at the Fly edge with `max_concurrent_streams: 100`,
  which is load-bearing: the same 411 requests over HTTP/1.1 would serialize into
  a materially slower boot on exactly the phone the owner tests on.
- **The autoplay deferral (§2c).** This harness cannot produce a suspended
  `AudioContext` under any policy flag, so the 838 kB saving is asserted from the
  code path and its unit tests, never observed end-to-end. An iPhone proves it in
  one cold visit: open `/iso.html`, do not touch the screen, and check whether
  `menu.ogg` appears in the network log.
- **Whether the shared-texture prewarm is doing anything.** Chromium coalesced
  the 218 concurrent requests for 29 URLs by itself, so the A/B was
  byte-identical. The prewarm was kept because the entire saving is
  cache-dependent and coalescing is a browser optimisation, not a guarantee — a
  browser that skipped it would download 1.84 MB of duplicates and land *worse*
  than baseline. Only mobile Safari can say which it is.
- **Memory and VRAM.** 23.18 MB of decoded GLB becomes GPU buffers; iOS Safari's
  per-tab memory ceiling is the risk this round did not measure at all.
- **Perceived quality at phone scale** — the pruned rigs, the WOFF2 subsets under
  iOS text rendering and Dynamic Type, and the 29 shared WebPs through a mobile
  decoder. Pixel-identical at 1440×900 does not automatically survive a 3× DPR
  screen the reviewer is holding 30 cm from their face.

---

## 6. Found on the way, not fixed here

`src/sim/ai.ts` contains **169 mojibake sequences** — `â€"` where an em dash
belongs — and they render straight into the live feed ("A cleric CONSECRATES the
ground â€" it heals them"). This is *not* a font or encoding-header problem: the
corrupt bytes are in the committed source. It is present identically at
`main@d7487f1`, this branch changed nothing under `src/sim/`, and `src/sim` was
out of scope for this work. Visible in `tools/_abshots/floor10.png`. Worth a
BACKLOG entry: a UTF-8 re-decode of the affected string literals.

---

## 7. Reproducing this

```sh
npm run build
PORT=5285 STATIC_DIR=dist npx tsx src/server/gameServer.ts     # NOT vite preview
curl -sI -H 'Accept-Encoding: gzip' localhost:5285/iso.html    # fingerprint first
node tools/_abfinal.mjs --base http://127.0.0.1:5285 --out tools/_abshots
node tools/_abrows.mjs  http://127.0.0.1:5285
```

Asset regeneration commands, and the license position on every modification
(all CC0 or OFL-without-RFN, all recorded), are in **ASSETS.md**. Cache policy
and the per-tree-hash scheme are in **DEPLOY.md**.
