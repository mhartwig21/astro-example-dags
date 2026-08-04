# SOUNDPLAN — the audio track's contract

The document the whole `audio-aaa` track builds against. Every phase (SFX,
beds, mix, audit) checks its work against the tables here; when a row ships,
mark it shipped rather than deleting it — the final audit walks this file.

**The honest constraint**: nobody in this loop can hear. Every quality claim is
either MEASURED (decode the file, compute the number — ffmpeg/ffprobe are on
the box: `ffmpeg -af loudnorm=print_format=json` for real LUFS, plus
peak/clipping, windowed RMS, spectral centroid, silence share, and the
loop-seam delta defined in §5) or VERIFIED IN-GAME (the clip fires on its
event with correct timing, via the §5 analyser hook). The owner's ear is the
final acceptance; the deliverable ends with an audition report telling the
owner exactly what to listen to and where.

**House sound** (derived from the game, not genre defaults): a dungeon that is
also a bureaucratic galactic TV show. Dungeon-crawler FIRST — dry menace, not
carnival. Registers: Diablo 2/4 dark ambient beds and meaty physical impacts;
Hades-punchy ability audio; the System's announcer moments get a **stinger
language** (dry, broadcast, a little too professional), never a laugh track.

---

## 1. Inventory

### 1.1 What exists — manifest + files present (all licensed in ASSETS.md)

| Family | Clips (manifest ids) | State |
|---|---|---|
| Combat hits | `hit, crit, player_hurt, heal, gold, item` | shipped, CC0 |
| DoT ticks | `dot_burn, dot_poison, dot_chill` | shipped, CC0 (element-voiced, throttled) |
| Footsteps | `step_{stone,wet,grass,metal}_{a,b,c}` | shipped, generated in-repo (gen-footsteps.mjs) |
| Skills | `dash, bolt, nova` | shipped, CC0 |
| Progression | `level_up, lootbox, achievement, door_unlock, descend, death, victory, band_sting` | shipped, CC0 |
| Show/UI | `announce, sponsor, warning, buy, equip` | shipped, CC0 |
| Music | `music_dungeon, music_safe, music_collapse, music_battle_{a,b,c}, music_boss_{epic,tides,colossal}` | shipped; battle_b/c + both named boss themes are CC-BY (credited in-game) |

### 1.2 Manifest entries whose FILES ARE MISSING (silent today, P0)

`swing` (melee whoosh, fires on every attack), `tell` (enemy windup — the
game's fastest telegraph channel AND the per-boss pitched signature carrier),
`kill` (killing-blow thump layered over `hit`), `crowd` (multi-kill /
frenzy / boss-beat roar), `boss_intro` (the RINGSIDE INTRODUCTION sting, also
the `intro` boss beat). These are wired end-to-end in director.ts and simply
never sound. **Highest value-per-byte in the whole plan.**

### 1.3 Director mappings today (src/audio/director.ts)

- HitEvent kind → clip, distance-attenuated + iso-panned; `killed` layers `kill`.
- StatusKind DoT ticks → element clips (don't pin the battle bed).
- Windup edge per monster → `tell`; boss telegraph pitched via `signatureFor`.
- Footstep stride accumulator per player → band surface, 3 variants, deterministic jitter.
- Boss beats (BOSSES-V2 §7.4): intro/phase/intermission/punish/plate/shieldbreak/enrage/prop/telegraph → semantic-reuse clips (see 1.4-G for upgrades).
- State edges: warning, descend (+band_sting on band cross), death, victory,
  door_unlock, level_up, lootbox, achievement, sponsor, frenzy-crowd,
  encounter→boss_intro, swing/dash/nova/bolt edges, ability layers
  (cataclysm/flask/stunt-double/bullet-time), worthy-drop chime, ping chime.
- Music state machine: safe → boss (final-phase escalation to colossal) →
  collapse → battle (per-floor rotation, 6s linger) → dungeon bed; APPROACH
  corridor duck (0.22) before an un-introduced boss; bullet-time muffle.

### 1.4 THE SILENT MOMENTS (the gap list this track exists to close)

**A. Status effects (BACKLOG #3)**
1. Ignite/poison/chill APPLY — the moment the status lands has no cue (only
   the later ticks sound). Needs 3 short apply cues distinct from tick voices.
2. Status EXPIRE/cleanse — silent (P2; only if a clip earns its place).

**B. Music (BACKLOG #17)**
3. Per-band beds — all six bands share one `dungeon.ogg` crypt ambience. The
   entire §3 music plan. Seam is ready (director routes music by state).
4. Menu / campfire check-in — the pre-run screen and the campfire lineup have
   no bed at all (music starts with the run).

**C. Room grammar (BACKLOG #22)**
5. Breakable smash — pots/crates/furniture pop silently (smashBreakables +
   arena props; `fireArenaProp` too). Needs a small smash family (wood/clay/metal)
   or one clip with rate spread.
6. Service purchase — "OPEN FOR BUSINESS" pickup and the service buy ride the
   generic announce/buy chimes; deserves a till/transaction sting (the System
   takes a cut — make the cut audible).
7. Per-purpose room tone (P2) — forge crackle, tavern murmur; positional loops
   are an engine addition; only after beds ship.
8. System-line stinger — every announcement plays the same `announce` blip.
   Plan: a 2-3 note System IDENT for normal lines (replace announce), a
   heavier ident for `priority: "high"` lines.

**D. Creatures — vocalization is entirely absent**
9. Aggro/pain/death barks per archetype FAMILY (not per 36-mob roster):
   skeletal (rattle), beast/plant (organic), humanoid/show-cast (grunt),
   machine (servo/metal), phantom/witch (airy) — x {aggro, pain, death},
   2 variants each ≈ 30 mono clips. Death bark layers under `kill`.

**E. Branch-shipped moments nobody scored**
10. STARTING GUN (rivals READY card): countdown ticks + a GO hit at second
    zero. The one synchronized moment every seat shares — it must land as one.
11. TODAY'S RULE announcement (dealt at second zero, priority high): the heavy
    System ident (C.8) + a paper-stamp tail. Bureaucracy, audible.
12. Result card / THE VERDICT: a grade-reveal sting (one sting, pitch/length
    scaled by grade — not five recordings) + share-button click.
13. Ledger bank moment (run end IS the deposit): coin-settle + drawer-close
    thunk under the deposit lines. Losing runs still bank — same sound,
    the System is indifferent.
14. DEATH IS A DOOR (concede): a single cold door-close. Terminal, dry, no
    musical comment.
15. Boss beats keep semantic-reuse clips but three deserve dedicated files:
    `boss_intro` (missing file, P0), a real phase-transition hit (band_sting
    is doing double duty), a punish-window opener (crowd-gasp + crack).
    Boss KILL: keep kill+crowd layer, add a low tail.
16. LEVEL UP draft: `level_up` fires on the level; the draft modal itself
    (open / option hover / PICK / bank-behind-badge) is silent. Pick = the
    constellation confirm (short ascending shimmer); bank = a soft filing cue.
17. Descent transition: `descend` + `band_sting` exist; add a descent WHOOSH
    (the portal swallows you) under the existing pair — one clip.
18. Rush tile "RACE FORMING — GUN IN mm:ss" (P2): last-10-seconds tick only,
    and only when the tile is visible. No siren spam.

**F. Already-mapped but worth an upgrade pass (P2, measure first)**
19. `music_collapse` is a 4.4MB WAV — re-encode (frees ~3.6MB, §4.4).
20. `music_safe` is a 6.3MB MP3 — re-encode to OGG (frees ~4.6MB).

Priority: P0 = 1.2's missing files + rows 1, 10, 11, 13. P1 = rows 3, 4, 5,
6, 8, 9, 12, 14, 15, 16, 17. P2 = rows 2, 7, 18, 19, 20 (19/20 are trivially
scriptable and fund the budget — do them early even though they're P2 polish).

---

## 2. Mix architecture

### 2.1 Buses

Today: `sfx / music / ui` → master gain → muffle LPF → compressor → out.
Add **`announcer`** (System idents, TODAY'S RULE, starting gun, verdict,
boss_intro): it needs its own level AND it is the DUCK SOURCE — the show
talks over the dungeon, never the reverse. Barks/smashes/status stay on
`sfx`. Buses and any ducking live in engine.ts (existing architecture).

### 2.2 Loudness targets (measured, per family)

Beds are mastered to a shared integrated loudness so crossfades never step;
one-shots are specified by peak + momentary loudness since integrated LUFS is
meaningless for 300ms files. All numbers verified with ffmpeg loudnorm (beds)
or peak/windowed-RMS decode (one-shots).

| Family | Target | Peak ceiling |
|---|---|---|
| Ambient beds (six bands, menu, safe) | -23 LUFS-I ±1 | -6 dBTP |
| Battle / collapse beds | -20 LUFS-I ±1 | -5 dBTP |
| Boss beds / low-HP layer | -18 LUFS-I ±1 | -4 dBTP |
| Impacts (hit/crit/kill/smash) | -15 LUFS momentary | -3 dBFS |
| Barks, status applies, tells | -18 LUFS momentary | -6 dBFS |
| Footsteps, DoT ticks, room tone | -28 LUFS momentary | -12 dBFS |
| UI clicks (buy/equip/draft) | -22 LUFS momentary | -8 dBFS |
| Announcer idents / stingers / GO | -14 LUFS momentary | -3 dBFS |

Headroom contract: with a bed at target plus a 20-hit brawl, the level at the
master compressor input stays under 0 dBFS and the OUTPUT never hard-clips —
verified by the §5 brawl probe, not asserted.

### 2.3 Ducking matrix (who yields to whom)

| Trigger | Ducks | Amount / shape |
|---|---|---|
| Announcer bus active (any ident/stinger) | music -6 dB, sfx -3 dB | 80ms attack, 600ms release, sidechain-style flag in engine |
| Boss intro sting | music to 0.3 for sting length | then boss bed swells in |
| APPROACH corridor (shipped) | music to 0.22 | keep; release at reveal |
| Bullet time (shipped) | master LPF 700Hz | keep |
| Starting gun countdown | music to 0.4 until GO | GO releases it as the bed hits |
| Victory/death/verdict | music out (shipped: music(null)) | verdict sting owns the room |

Rule: at most ONE duck source engages at a time; announcer wins ties.
A duck you can hear working is a bug — slow releases, fast attacks.

### 2.4 Rate limits (manifest throttleMs, per family)

impacts 70-90 · swing 120 · tell 150 · steps 100 · DoT ticks 450-600 ·
status applies 300 · smash 90 · barks 250/family + one bark per monster per
4s (director-side set, like `winding`) · crowd 1500 · announcer idents 400 ·
countdown ticks force-played (caller is the limit) · beds n/a (crossfade).
Boss beats keep `force: true` — one cue per sim beat, the sim IS the limiter.

---

## 3. The music plan

All beds loop; loop-seam continuity is measured (§5). "Synth" = generated by
committed scripts in `tools/audio/` (reproducible, license: ours/CC0).
Loudness per §2.2. Lengths chosen so a floor (~5-10 min) doesn't obviously
lap: 60-96s for ambient beds.

| Bed | Register / intent | Tempo & texture | Loop | Source |
|---|---|---|---|---|
| THE UNDERCROFT (1-3) | Crypt drone. Bone-dry low C pedal, faint choir-formant swells, one distant stone impact per phrase. First floors: pristine, museum-quiet menace. | ~60 BPM implied; drone + sparse | 64-80s | Synth |
| THE SEWERS (4-6) | Wet resonance. Detuned metal-pipe partials (comb/feedback delays), drip transients as percussion, sub pulse like distant pumps. | irregular drips over a slow 2-bar sub cycle | 60-90s | Synth |
| THE GARDEN (7-9) | Overgrown false calm. Minor-mode pad, breath-slow; shaped-noise insect bed; occasional wrong-note bloom (the floor fights back). | ~70 BPM, pad-led | 80-96s | Synth |
| THE RUINS (10-12) | Dead civilization. Formant-filtered saw "choir", a slow tolling bell (inharmonic FM), long stone reverb tails. | ~55 BPM, liturgical | 80-96s | Synth |
| THE IRONWORKS (13-15) | The machine floor. Actual rhythm arrives: 90-96 BPM industrial pulse, vent hiss, clank accents on the off-beats, conveyor drone. | 90-96 BPM | 64-85s (bar-exact) | Synth |
| THE APPROACH (16-18) | Showtime dread. Broadcast mains hum, low brass-ish drone cluster, a distant crowd-texture layer that NEVER resolves into cheering. The studio is watching. | drone + 45 BPM heartbeat pulse | 80-96s | Synth |
| Menu / campfire | The check-in. Small, warm-ish, tired: soft pad + slow filtered arp, the only near-friendly cue in the game. | ~65 BPM | 60-75s | Synth |
| Safe room | Keep `music_safe` (CC0 synthwave calm fits the vending-machine mercy of safe rooms) — re-encode MP3→OGG 96k. | — | as-is | Existing |
| Battle rotation | Keep the three shipped battle tracks (rotation already per-floor). | — | as-is | Existing |
| Boss themes | Keep epic/tides/colossal (+ shipped final-phase escalation to colossal). Optional P2: a generated percussion LAYER the engine adds at low HP instead of a full bed swap. | — | as-is | Existing (CC-BY credited) |
| Collapse | Keep, re-encode WAV→OGG. | — | as-is | Existing |

Band beds replace `music_dungeon` via `floorBand(state.floor)` in the
director's music selector (one-line routing change per the existing seam);
`music_dungeon` stays as the fallback for any band whose bed file is absent —
the silent-fallback philosophy extends to per-band graceful degradation.

Generator architecture (tools/audio/): one shared DSP library (band-limited
osc, noise shaping, ADSR, biquads, feedback-delay reverb, PCM-WAV writer —
same pattern as scripts/gen-footsteps.mjs, seeded + deterministic), one
script per bed. Render WAV → `ffmpeg -c:a libvorbis -q:a 3` → loudnorm
verify → commit script + ASSETS.md row ("this project, CC0/ours").

---

## 4. Sourcing & generation strategy, license plan, payload budget

### 4.1 Per family

| Family | Strategy | Why |
|---|---|---|
| Six band beds + menu bed | **Generate** (tools/audio) | Exactly the game's aesthetic (its textures are generative), tweakable forever, license-clean, and dark-ambient drones are the easiest genre to synthesize credibly |
| Missing combat trio (swing/tell/kill) + boss_intro + crowd | **Source CC0** (Kenney Impact/RPG/Interface; freesound CC0 for crowd) | Physical transients are the hardest thing to synthesize convincingly; Kenney rows already cover the style |
| Status applies (3) | Source CC0 first (freesound: ignite whoosh, splat, ice crack); synth fallback | Short elemental transients — either path works |
| Breakable smash (2-3) | Source CC0 (Kenney Impact has wood/ceramic) | ditto |
| Creature barks (~30 mono) | **Mixed**: machine + skeletal + phantom families synth (servo sweeps, bone rattle = filtered noise bursts, airy = formant noise); organic grunts sourced CC0 | Organic voices resist synthesis; mechanical ones prefer it |
| Announcer language (ident ×2, rule stamp, countdown tick + GO, verdict sting, till, door-close, deposit, draft pick/bank, descent whoosh) | **Generate** | It must sound like ONE voice — a family generated from one script with shared timbre IS the stinger language; sourcing 12 clips from 12 authors is how you get carnival |
| Room tones (P2) | Generate | Loopable textures, same as beds |

### 4.2 License rules (unchanged, restated as gates)

CC0 preferred; CC-BY allowed WITH the in-game credits row (KEY BINDINGS
footer) + ASSETS.md attribution table, both in the same commit as the file;
NC/ND never. Generated output: ASSETS.md row naming the generator script,
license "this project, CC0 (own work)". **A single file in public/audio/
without an ASSETS.md row is a merge blocker; the final audit re-verifies
every row against every file on disk (script it: ls vs table diff).**

### 4.3 Payload budget (net audio growth ≤ 10MB gz; OGG≈incompressible so raw≈gz)

Measured today: public/audio = **24.7MB raw** (music 24.2, sfx 0.5).

| Item | Est. |
|---|---|
| 7 generated beds (~80s @ OGG q3 ≈ 112kbps ≈ 1.1MB each) | +7.7MB |
| Combat trio + boss_intro + crowd (mono OGG) | +0.3MB |
| Barks ~30 × ~15KB mono | +0.5MB |
| Announcer family ~12 × ~25KB | +0.3MB |
| Status applies + smashes + misc UI | +0.2MB |
| **Gross additions** | **≈ +9.0MB** |
| Re-encode collapse.wav → OGG q4 | −3.6MB |
| Re-encode safe_room.mp3 → OGG q3 | −4.6MB |
| **Net growth** | **≈ +0.8MB** |

Even if every bed comes out double the estimate, net stays ≈ +8.5MB < 10MB.
The re-encode pass lands FIRST so the budget is banked before beds arrive.
Report the measured delta (before/after `du` + gz) in the phase-final commit.
Audio still loads on idle after playability (perf-round decision) — nothing
here touches boot.

### 4.4 Phasing

1. **Phase A — SFX**: re-encode pass (banks ~8MB), the five missing P0 files,
   status applies, smash, announcer P0 (gun, rule, ident), the §5 analyser
   hook + probe. Extend test/audio.test.ts for every new mapping.
2. **Phase B — beds**: tools/audio DSP lib + six band beds + menu bed,
   director band routing, seam/LUFS measurement harness.
3. **Phase C — voices & polish**: barks, verdict/ledger/draft/concede cues,
   ducking matrix in engine.ts, P2 rows that survive scrutiny.
4. **Phase D — audit**: license re-verification, full measurement table,
   in-game verification run, the owner's audition report.

---

## 5. Verification instruments & acceptance

**Analyser hook (built in Phase A, engine.ts, debug-only)**: master-bus
AnalyserNode + a ring of recent `(clipId, startedAt)` plays on
`window.__dcc.audio` under `?debug=1`. Then `tools/audio-probe.mjs` drives a
staged fight (test-mode URL) and asserts:

- **Impact sync**: impact clip fires within 2 frames of the sim HitEvent
  (HARNESS.md spec #4).
- **Brawl headroom**: 20-hit staged brawl — analyser time-domain peak < 1.0
  throughout (rate limits + compressor doing their jobs).
- **Duck test**: System stinger while a bed plays — music-bus gain drops ≥
  measured 4dB within 150ms, releases within 1s.
- **Band swap**: crossing floor 3/6/9... swaps the bed id in the ring.

**Per-file measurements (every committed clip)**: peak ≤ ceiling, LUFS in
family band (§2.2), silence share < 10% (beds) — and for loops the **seam
delta**: RMS over the last 50ms vs first 50ms differ by < 3dB AND the
concatenated end→start window shows no transient above the loop's own p95
(a click at the seam is a number, not an opinion). One script
(`tools/audio/measure.mjs`) prints the table; the table goes in the phase
commit message.

**Acceptance**: measurements green + probe green + ASSETS.md audit clean +
the audition report (what to listen to, where, on which test-mode URL, and
what "wrong" would sound like) delivered to the owner. No claim of "sounds
great" anywhere — claims of what was measured, and a map for the only ear
that counts.
