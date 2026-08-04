# SETTLED — fixed findings with their proof frames

One line per finding, per HARNESS.md: `finding → commit → proof`. Critics: do
not re-open an entry unless a FRESH capture contradicts its proof — and if one
does, say so loudly: a reopened settled finding is a regression and outranks
everything else.

| finding | fixed | proof |
|---|---|---|
| Sharesheet trap on phones (COPY/SAVE/CLOSE off-glass, no scroll, no backdrop close) | mobile-wr r4 | `tools/_mobile/wr-fix1/iphone13-land-sharesheet.png` + report.json (all 4 actions 165x58 hit-tested, ✕ present, backdrop closes) |
| Top-menu dropdown taps leak into the world as move/lock orders | mobile-wr r4 | wr-fix1 report: `blocker2` PASS x3 devices (`lastWorldTap` unchanged through a menu tap) |
| Tap-to-lock dead on phones (poisoned 0x0 chip-rect cache) / moving targets un-lockable under poll latency | mobile-wr r4 | wr-fix1 report: `blocker3` PASS iPhone/Pixel, WARN iPad (camera-sway forensics in wrfix1.mjs comments) |
| THE RUSH tile occluded/clipped on compact | mobile-wr r4 | `tools/_mobile/wr-fix1/pixel5-land-menu.png` + `blocker4` strict centre hit PASS |
| READY under the 44px floor on the STARTING GUN card | mobile-wr r4 | wr-fix1 report: `major1` 220x48 on all three devices |
| CRAWL LEDGER had zero touch closers | mobile-wr r4 | wr-fix1 report: `major2` ✕ closes by touch on all three devices |
| Recap CTA rail (3 sticky rows) buried the medal/death/ledger copy | mobile-wr r4 | `tools/_mobile/wr-fix1/iphone13-land-recap.png` (one pinned row, opaque; secondaries in flow) |
| #bosscall painted across the stick zone on short screens | mobile-wr r4 | wr-fix1 report: `major5` top <= 34% of glass on all three devices |
| Touch settings rows unmeasurable (non-.kb-row markup); no live preview | mobile-wr r4 | wr-fix1 report: `major4` 16 kb-rows, veil 0.14 under a held stepper, handedness flip persisted |
| Control skin: opaque plates, no hierarchy, worded LOCK chip, no cooldown numerals, no max-range ring | mobile-wr r4 | `wr-fix1/*-skin-dark.png`, `iphone13-land-aim-ult-garden.png` (range disc + chip cancel ✕), tier numbers in report |
| three.js `reading 'isReady'` pageerror on phone-class boots / aim scenes | mobile-wr r4 | wr-fix1 r7 run: zero pageerrors across 3 device sessions (disposal-safe compile poll + shared aim materials) |
