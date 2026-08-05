# AAA AUDIT — whole-game verdict at main@d7487f1

Bar: current AAA action-RPG production values (Diablo IV, Path of Exile 2,
Hades II, D2R). 10 = best-in-class, 8.5 = shippable AAA, 5 = good indie,
3 = jam build. Evidence-only; effort and team size are not graded.

Audited from the release-fixes worktree, dev server on :5289. Two dimension
critiques (audio, systems) arrived as text; visual, combat, UX and tech were
synthesized from this round's sibling-stream evidence on disk
(`tools/_shots/audit_first/`, `tools/_shots/audit_combat/`,
`tools/_shots/audit_visual/`, `shots/_shopprobe/`) plus the repo's own docs
and registers. Note: the branch has moved two audio commits past the audit
target (`d6a3f16` — SOUNDPLAN §1.3a: **the r2 generated set is REJECTED by
ear — robotic**; audio r3 queued). That owner verdict post-dates the audio
critique's "OPEN" rows and is folded in below.

---

## GATE RESULT — shop_1366 (HANDOFF.md §3b)

The one unverified fix from polish r1 (`SHELF_ROW_BUDGET 7 → 6` in
`main3d.ts` + the gutter type cap in `iso.html`), driven at 1366x768:

- **IN STOCK (the tab the shop opens on): PASS.** The SIGNATURE section
  header is fully visible above the DESCEND CTA — the tier that was 1%
  visible before the fix now renders complete.
  Evidence: `shots/_shopprobe/shop-stock-1366x768.png`.
- **ALL ITEMS: RESIDUE.** The COMPLETED WORKS grid overflows the 768px
  viewport — a row of tiles is clipped behind/below the DESCEND button and
  the SIGNATURE section is pushed off-screen entirely. Given the standing
  no-scrollbars rule (panels must fit the viewport), this tab still fails
  the same class of defect the gate exists to catch.
  Evidence: `shots/_shopprobe/shop-all-1366x768.png`.

**Verdict: conditional pass.** The named boundary case is fixed; the
adjacent tab reproduces the bug. (Gap #20.)

---

## SCORE TABLE

| Dimension | Score | Headline |
|---|---|---|
| Combat feel | **4.5** | Telegraph vocabulary exists; impact does not — hits, ultimates and the death moment all under-read |
| Visual fidelity | **4.0** | Asset-pack world under a prestige UI: flat monochrome light, empty landmark rooms, elite intros dim to black |
| Audio | **4.5** | Generated half instrument-coherent, stock combat music breaks every §2.2 contract — and the owner has now rejected the generated set by ear |
| Systems & content | **6.0** | AAA-wide breadth on indie-deep numbers; the niche's headline loop is unshipped plumbing |
| UX / UI & presentation | **6.5** | Menu, shop and death screens are near-AAA craft; climactic moments drown under stacked chrome |
| Tech foundation | **6.5** | The replay-verified ladder is genuinely novel and measured; runtime perf on real GPUs is unproven in this round's evidence |
| **OVERALL** | **5.0** | A good indie wearing AAA-grade UI chrome — the world rendering and combat impact are what hold it two full points under shippable |

Weighting per brief: combat feel and visual fidelity carry double weight
(0.25 each); audio and systems 0.15; UX and tech 0.10.
(4.5+4.0)x0.25 + (4.5+6.0)x0.15 + (6.5+6.5)x0.10 = **5.0**.

---

## THE CROSS-CUTTING PATTERNS (what no single dimension saw whole)

**1. The build is two products.** The 2D chrome — main menu, System Shop,
IN MEMORIAM, ringside typography — sits at genuine 7.5-8 craft: coherent
gold-on-leather art direction, disciplined type, a voice ("the System is
legally required to inform you that survival is optional") that lands the
license better than most licensed AAA games land theirs. The 3D world under
it is an asset-pack prototype: KayKit chibi figures in flat monochrome
rooms. Every screenshot pair (menu vs f01-landmark) reads as two different
games. Audio has the same split, measured: 7 generated beds at
-23.00..-23.14 LUFS-I vs stock combat music 8-11 LUFS hot. The audit's
single biggest finding is this seam, and it runs through every dimension.

**2. The game hides itself at its own climaxes.** Elite intros stack a
letterbox + dim overlay onto already-night scenes and produce near-black
frames (f04/f07/f10 landmarks). The death moment stacks boss bar +
RULES VIOLATION banner + a second faded banner + an achievement toast + the
live-feed text wall — "YOU DIED" is a small red line in a log panel
(f15_death_moment.png). Achievement toasts pop dead-center during boss adds
pressure (f15_elite_fight.png). The screen-zone map exists (iso.html CSS)
but has no priority rule for when zones fire simultaneously — and they
simultaneously fire exactly at the moments an ARPG is supposed to peak.

**3. "The instrument was green about something adjacent" is still live.**
HANDOFF.md §0 names this the project's recurring lesson; this round caught
it again three times: audioMix.test.ts walks `cast_*` filenames and misses
`bolt` (+7dB over hit); the shop gate verified IN STOCK while ALL ITEMS
clips; residentPcmBytes() self-certifies the streaming path no process has
weighed. The guard-writing culture is real, but guards keep enumerating
from the wrong set.

**4. Acceptance debt is compounding.** The owner's ear has now REJECTED the
r2 generated set wholesale (d6a3f16, "robotic") — the 13 cast cues, dash and
level_up all inherit it, audio r3 is queued, and 15+ clips have never been
auditioned. Meanwhile boss anti-repeat and rematch escalation are shipped,
tested, and inert (no host writes `SavedProgress.bosses`), and NICHE.md —
cited by five files as the governing doc — is not in the worktree. The gap
between "merged" and "accepted/wired/real" is where this project's score
leaks.

---

## TOP 20 GAPS — ranked by severity x drag on the AAA feel

Severity 1-5. Format: what, evidence, next action (files/systems).

**1. Melee and hit impact feedback is near-absent. (sev 5)**
The core verb of the genre does not land. Floor-1 melee is a faint orange
swipe with no target flash, no hit-stop, no recoil, no decal
(`tools/_shots/audit_first/07_combat_hit.png`,
`tools/_shots/audit_first/07b_melee_impact.png`); floor-3 impact is a lone
"38" over a pastel scrum (`tools/_shots/audit_combat/f3_melee_impact.png`).
D4 sells a basic-attack hit with flash + number + sound + camera; here two
of those four are missing and a third (audio: bolt louder than hit) is
inverted. NEXT: `src/render3d/renderer3d.ts` + juice layer — add per-hit
target emissive flash (~80ms), 2-3 frame hit-stop on melee connect, scaled
damage-number pops for crits, reading `state.hits` which already types the
events.

**2. World lighting is a flat monochrome wash; landmark rooms are unlit and
empty. (sev 5)**
Floor 1's landmark room is a uniform blue-violet box dressed with four
identical bookcases — no key light, no hero prop, no focal point
(`tools/_shots/audit_visual/f01-landmark.png`); corridors and rooms share
one hue per band. Torch pools exist (`04_spawn.png`) but nothing shapes the
frame. D2R/D4 landmark rooms are lit theater. NEXT:
`src/render3d/floorThemes.ts` + `ambient.ts` — per-room-role key lights
(landmark/vault get a colored key + practical), one hero prop per landmark
from the KayKit inventory, and a contrast floor so no band renders
single-hue.

**3. Ringside intros dim unlit scenes to illegibility. (sev 5)**
The elite-intro letterbox + dim overlay stacks multiplicatively on night
rooms: "The Block Captain" and "Old Chompy" intros are near-black frames
with the subject invisible behind the title
(`tools/_shots/audit_visual/f04-landmark.png`, `f10-vault.png`,
`f07-landmark.png`). The one intro that works (Line Supervisor,
`tools/_shots/audit_combat/f15_pile_readability.png`) works because the
boss glows. This is the game's signature presentation beat failing 3 of 4
times. NEXT: `src/render3d/bossFx.ts` + the intro path in `main3d.ts` —
during RINGSIDE, add a rim/key light on the subject and RAISE scene
exposure inside the letterbox instead of dimming it.

**4. Combat/boss music breaks every §2.2 loudness contract; 4 files decode
past full scale. (sev 5)**
boss_epic.ogg -6.92 LUFS-I / +2.75 dBTP against a -18 / -4 contract; the
battle rotation spans 13.4 LUFS at identical manifest volume; a 10-19dB bed
step at every boss door. The 7 generated beds prove the pipeline hits
contract exactly; the stock half never went through it. NEXT: run the
existing `tools/audio/fix-beds.mjs` two-pass loudnorm over battle_a/b, all
three boss beds, collapse, safe_room; re-verify with `measure.mjs`.

**5. Primary combat beds have measured loop-seam defects. (sev 4)**
boss_blackmoor 4.6dB seam click, boss_epic 3.1dB, boss_colossal 2.1dB
(the final-phase bed); battle_theme_a seam delta 57.3dB and battle_winter
95.1dB — fade to silence, slam back, every wrap. Boss fights outlast all of
these. NEXT: same `fix-beds.mjs` trim + loop-crossfade treatment that
repaired safe_room (20.7dB → 0.8dB); then run the unrun
`probe-beds.mjs musicSeam()` on the streamed path.

**6. No endgame: the game ends at one 18-floor clear. (sev 4)**
`src/sim/catalog.ts:424` — floor 18 drops none, trophy tier "LATER"; no
paragon/heat/atlas analog in `src/sim/`. Hades ships Heat 1-64 on the same
short-run premise. NEXT: a heat/pact layer composing the existing
`bosses.ts` mutators + `dailyRules.ts` seams into a self-selected per-run
modifier stack with CP multipliers.

**7. Climax UI stacking: the HUD buries the game's best moments. (sev 4)**
FIRST BLOOD achievement toast dead-center over boss-adds pressure
(`tools/_shots/audit_combat/f15_elite_fight.png`); at the death moment,
boss bar + two stacked banners + toast + live-feed wall, with "YOU DIED"
as a log line (`f15_death_moment.png`). NEXT: `main3d.ts` announcement
router — a climax lock: while a boss bar or death beat is active, queue
normal-priority toasts/achievements; drain them after. The priority field
already exists on `state.announcements`.

**8. Loot has no ground presentation. (sev 4)**
The "first loot" beat is an unlabeled tiny prop with no beam, no nameplate,
no rarity color on the ground (`tools/_shots/audit_first/08_first_loot.png`);
no shot in any stream shows a ground label. Loot celebration is THE genre
dopamine loop — D2R's beams and labels are the reference. NEXT:
`src/render3d/renderer3d.ts` — rarity-colored light pillar + hoverable
nameplate on drops; wire from the existing drop events in `state.events`.

**9. The niche's headline loop has no front door. (sev 4)**
"Everyone racing today's dungeon live" is reachable only by hand-typing a
`?join=DAILY-` code (BACKLOG.md #30); NICHE.md itself — cited by
COMPETITIVE.md:9, dailyRules.ts:1, crewWire.ts, DEPLOY.md:103 — is absent
from the worktree. NEXT: menu button minting DAILY-<today> rivals codes via
`gameServer.ts` dayFromDailyCode (~207) / creation (~977) into the main3d
race-forming UI; commit NICHE.md.

**10. `bolt` and `heal` escape the act-under-consequence mix invariant, and
the guard cannot see them. (sev 4)**
bolt plays -15.1 — 7dB ABOVE hit, louder than all four ultimates; heal
-12.4, the loudest non-death SFX in the game.
`test/audioMix.test.ts:82` filters `id.startsWith("cast_")` so neither is
walked. NEXT: enumerate the ability roster in audioMix.test.ts; trim bolt's
manifest volume to ~0.31, re-level heal to the UI/pickup register.

**11. The death moment has no presentation beat. (sev 4)**
Between "fighting" and the (excellent) IN MEMORIAM screen there is nothing:
no slow-mo, no desaturation, no camera push — death registers as a red log
line while banners argue overhead (`f15_death_moment.png`; the screen
itself: `tools/_shots/audit_combat/f9_burst_t0.png`). Hades/D4 both mark
the instant. NEXT: `main3d.ts` + `renderer3d.ts` — a 1.5s death beat
(time dilation via presentation layer, vignette, HUD suppression) before
the IN MEMORIAM card.

**12. Style coherence: pastel chibi cast vs prestige-grimdark chrome.
(sev 3)**
Lime-green brutes and toy trees under a gold-leather HUD
(`f9_ultimate_injunction.png`, `f7-landmark`) — the world and the UI make
opposite promises. Stylization is legal at AAA (Hades) but must be
committed; this reads accidental. NEXT: art-direction pass in
`floorThemes.ts` + material tuning in `assets.ts` — desaturate/rim-light
the world toward the UI's register per BIOMES.md; do not swap models.

**13. Ultimate FX do not read as ultimates. (sev 3)**
The f9 "ultimate pressure" frame shows a small red swirl indistinguishable
from a standard hit effect (`tools/_shots/audit_combat/f9_ultimate_injunction.png`,
`f15_ultimate_pressure.png`). Four ultimate lanes are the build identity
(COMPETITIVE.md §3.4) and none owns the screen for a beat. NEXT: bespoke
per-lane ultimate FX + brief camera/exposure response in
`src/render3d/renderer3d.ts` juice layer keyed off the cast event.

**14. Enemy health bars float over fog with no visible owner. (sev 3)**
Bars render for mobs the fog still hides — floating red slivers in empty
murk (`tools/_shots/audit_first/06_first_fight_real.png` lower-left,
`f3_melee_impact.png` right edge). Leaks information AND reads as a bug.
NEXT: gate bar rendering on `fogOfWar.ts` visibility in renderer3d's
overlay pass.

**15. Boss anti-repeat and rematch escalation are shipped but inert.
(sev 3)**
No host persists `state.bossLineup`/`state.bossDefeats` into
`SavedProgress.bosses` (grep at d7487f1: only sim/game.ts + sim/types.ts);
"WE HAVE MET N TIMES" and no-repeat variety silently degrade to seed luck.
NEXT: one write at the existing save checkpoint in `src/persist/` — the sim
and UI halves already exist.

**16. Itemization numeric space is an order below the bar. (sev 3)**
Six affix keys, two damage schools, three status effects (`src/sim/items.ts`,
`status.ts`); all build interest lives in ~30 unique passives. D4 ships
dozens of affixes + aspects. NEXT: widen the affix vocabulary on support
slots first (per-ability CDR, AoE size, projectile count, status duration) —
SLOT_BUDGET already differentiates slots.

**17. Player-critical audio vanishes on small speakers. (sev 3)**
Under the 250Hz small-speaker filter: player_hurt -48.1 (your own damage
feedback), boss_down -52.5 (the kill payoff), skel_death barks -38.8 —
resurfacing the "skeletons vanish" defect on laptops. NEXT: add an
upper-band click/crack layer (>500Hz) to those clips and an hp250 floor
assertion for the player-critical set in `test/audioMix.test.ts`.

**18. The announcer "one voice" family measures indistinct; bark variants
are near-duplicates. (sev 3)**
contactsheet: ident/verdict 0.92 — THE VERDICT sting occupies the same
shape/brightness/envelope point as the everyday blip; four bark a/b pairs
at distance 0.11-0.24 defeat the anti-repetition purpose; hum-vs-org
families blur (~20 cross pairs under threshold). NEXT: give verdict a
distinct gesture/length, re-seed the four b-variants in
`tools/audio/gen-sfx-barks.mjs`, push hum's formant space away from org;
re-run the matrix. (All subject to the r3 recorded-source rebuild the owner
verdict just queued.)

**19. Champion tier is a 3-floor stub. (sev 3)**
CHAMPIONS is three fixed floors (Foreman 14, Pack Alpha 8, QA Team 17 —
MOB-CONCEPTS.md Layer 1; BOSSES-V2.md SHOULD-14 open); 12 of 15 non-boss
floors have no named mid-band beat and the three that do are identical
every run. NEXT: convert CHAMPIONS to a seeded per-band pool drawn like
`pickBandBoss` in `src/sim/bosses.ts`.

**20. Shop ALL ITEMS overflows 1366x768 — the gate's residue. (sev 3)**
A tile row clips behind the DESCEND button; SIGNATURE never enters the
viewport (`shots/_shopprobe/shop-all-1366x768.png`). The owner's standing
rule: panels fit the viewport, no scrollbars. NEXT: apply the same
`SHELF_ROW_BUDGET` discipline to the ALL ITEMS tab in `main3d.ts` (collapse
sold-out/filler tiles) or give the shelf region an internal max-height
that reserves the CTA strip in `iso.html`.

---

## DIMENSION EVIDENCE HIGHLIGHTS

### Combat feel — 4.5
- Telegraph vocabulary is real and varied at depth: beam lines, AoE rings,
  tracers, arena plates all read
  (`tools/_shots/audit_combat/f15_elite_fight.png`,
  `f15_death_moment.png` — the purple tesla arcs are the best frame in the
  build).
- Boss grammar shows: named intro, subtitle threat, add-control objective
  ("KILL THE ADDS"), phase pips on the boss bar
  (`f15_pile_readability.png`).
- Against that: no readable melee impact (gaps #1), invisible ultimates
  (#13), a buried death moment (#11), and the audio layer actively
  fighting feel — bolt out-punching hit, player_hurt inaudible (#10, #17).
- The combat stream's own f9 run died in 9.98s holding 3 flasks
  (`f9_burst_t0.png` — IN MEMORIAM: "CHARGER — 51 damage, from 2% HP"),
  which is at least honest evidence that depth pressure exists.

### Visual fidelity — 4.0
- Failing frames: `audit_visual/f01-landmark.png` (monochrome empty
  landmark), `f04-landmark.png` / `f07-landmark.png` / `f10-vault.png`
  (intro dim stacking → near-black), `f9_ultimate_injunction.png`
  (cone-tree repetition, toy palette).
- Working frames: `audit_first/02_menu.png` (campfire cast diorama —
  genuinely handsome), `04_spawn.png` (torch pools + prop scatter),
  `f15_death_moment.png` (arena dressing: pentagram, grates, pillars).
- The split between those two lists is pattern #1 and the whole story.

### Audio — 4.5 (instruments-only, per its critique)
- Generated half coherent: 110/110 URLs resolve, 7 beds at -23.00..-23.14
  LUFS-I, 30 level-matched barks. Stock half is the entire combat
  soundtrack and breaks every contract (gaps #4, #5).
- Superseding event: commit `d6a3f16` records the owner's ear verdict on
  the r2 generated set — REJECTED, "robotic"; audio r3 (recorded-source)
  queued. Instrument coherence and acceptance are different gates; the set
  passed one and failed the other.

### Systems & content — 6.0
- Breadth is past indie: 81-node constellation, 26 glyphs, 36 mobs,
  15 elite affixes, 18 seeded bosses x 8 mutators, and a replay-verified
  ladder (29KB proof, 5.9s full-clear verify) no shipped AAA ARPG has.
- Held down by: no endgame (#6), no front door on the niche (#9), shallow
  numeric space (#16), inert shipped features (#15), 3-rule daily rotation
  and a weekly that is the base game (`src/sim/season.ts:180`).

### UX / UI & presentation — 6.5
- Near-AAA: main menu information architecture (`02_menu.png`), System Shop
  layout and tier language (`shop-stock-1366x768.png`), IN MEMORIAM's named
  death + cause + "not ranked" honesty (`f9_burst_t0.png`), the System's
  voice throughout.
- Dragged down by climax stacking (#7), the death beat (#11), the shop
  overflow residue (#20), and live-feed text walls during fights
  (`f15_elite_fight.png` left panel).

### Tech foundation — 6.5
- Deterministic one-sim-three-hosts with dmath discipline, replay proofs,
  rules-hash eras, survivable deploys — this is the build's most
  differentiated engineering and it is measured (COMPETITIVE.md).
- Unproven in this round: process-level memory on the streamed audio path,
  el.loop seam behavior (E-22 rows), and any fps number on real consumer
  GPUs — every screenshot here is SwiftShader. No perf claim above 6.5 can
  be defended from this evidence.

---

## QUICK WINS (highest feel-per-hour, from all streams)

1. `fix-beds.mjs` over battle_theme_a/battle_winter + three boss beds
   (script exists, loop verified on safe_room/collapse).
2. audioMix.test.ts: walk the ability roster, not `cast_*` filenames;
   trim bolt to ~0.31.
3. Persist `state.bossLineup`/`bossDefeats` → `SavedProgress.bosses` — one
   write unlocks two shipped features.
4. Fog-gate enemy health bars in renderer3d.
5. Climax toast queue in main3d's announcement router.
6. Mint DAILY-<today> codes from a menu button (server plumbing live).
7. Commit NICHE.md.
8. Annotate SOUNDPLAN §1.1's music row as out-of-contract so the next
   audit inherits the truth.
