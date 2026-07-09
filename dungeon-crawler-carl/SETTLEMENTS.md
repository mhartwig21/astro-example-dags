# Settlements, NPCs, quests &amp; tribes — research, none implemented yet

Design research for the civilization layer the Expedition seed needs and the
base game doesn't have: places on the map with people in them, enemies that
belong to something bigger than an archetype, and objectives that aren't
"reach the stairs." Confirmed by grep (2026-07-09): **zero** hits for
`quest|NPC|vendor|dialogue|settlement|faction|tribe` anywhere in `src/`. This
is the single largest net-new content surface of anything currently proposed
— bigger than the persistence/bandwidth work in the Expedition-mode pitch,
because that work extends existing systems and this doesn't extend anything.

Companion to `MEGAFLOORS.md` (huge floors, where settlements get room to
exist) and `MOB-CONCEPTS.md` (the bestiary, where tribe identity comes from).
Delete sections as they ship.

## Where we are today (measured, 2026-07-09)

| Thing | Today | Source |
|---|---|---|
| Room roles | closed union: `entrance / stairs / landmark / vault / combat` — no `settlement` | `src/sim/types.ts:451-456` |
| Role assignment | once, at floor-gen: entrance=first, stairs=farthest, landmark=biggest remaining, vault=smallest off-path | `src/sim/floor.ts:248-268` |
| "Safe room" | a **between-floor screen** — sim pauses, no map position, one static flavor line | `src/sim/types.ts:378-392`, `game.ts:2476` |
| Monster identity | archetype stats only; band flavor is emergent from floor-gated spawn *weights*, not a data tag | `src/sim/ai.ts:148-198` |
| Elite variance | `EliteAffix` (swift/shielded/volatile/...) rolled per named elite | `types.ts:150-156`, `ai.ts:451-454` |
| Offer-and-pick plumbing | one generic mechanism, already reused 3×: sponsor draft, System Shrine, Class Revision | `game.ts:2941-3070` |
| Dialogue | `state.announcements` is **exclusively the System's voice** by explicit doc mandate | `VOICE.md:51-53` |
| No-aggro zones | proposed in MEGAFLOORS.md, **zero code** — `ai.ts` has no room-role awareness at all | grep confirmed |
| Save persistence | character progression only, extended via optional fields + load-time defaults | `src/persist/save.ts:17-50` |
| Snapshot sync | `GameState` fields ride a full spread — new plain-data arrays need **zero** snapshot.ts changes | `src/sim/snapshot.ts:16-23` |
| "Culture" precedent | pack *templates* (Drumline, Hook Squad, Procession, Entourage) — unbuilt design language, no code | `MOB-CONCEPTS.md:227-327` |

The encouraging finding: three of the four new systems below have a proven,
reusable seam already in the codebase. The one genuinely novel piece of
engineering is runtime no-aggro logic — `ai.ts` doesn't know what room it's
in today.

## 1. Tribes — factions with a stat table, not a wiki

**Problem.** `MonsterKind` bands only by comment (`// SEWERS specialists`,
`types.ts:182-200`); `rollArchetype(rng, floor)` gates each kind's spawn
*weight* by `floor >= CONFIG.gardenFromFloor`-style flags (`ai.ts:163-175`).
There's no data anywhere that says "these monsters are the same people."

**Proposal.** Add `Monster.tribe?: TribeId` (optional, same shape as
`affix?: EliteAffix`) and a small `TRIBES` lookup table — `ARCHETYPES`-shaped
(`config.ts:822-880`), keyed by band, carrying:
- **Territory** — which settlement(s)/regions a tribe claims (feeds spawn
  siting once floors have regions, `MEGAFLOORS.md:115-123`).
- **Posture** — `territorial | opportunistic | raiding`, a behavior flag, not
  prose. Territorial tribes hold ground near their settlement; raiders roam
  (reuses the existing `m.roams` flag, `game.ts:332`).
- **Pack template** — MOB-CONCEPTS.md's playbook already names these:
  **The Drumline** (Sewers), **The Hook Squad** (Garden), **The Procession**
  (Ruins), **The Entourage** (Approach) — `MOB-CONCEPTS.md:227-327`. Each is
  a named formation of support+threat roles, not a weighted single. This
  *is* tribal culture, already designed, never wired to a data table
  (`MOB-CONCEPTS.md:249-250` names the exact seam: "a per-band template
  table in config, consumed by `spawnMonsters`").
- **Naming register** — the civic-satire elite/boss names (`ELITE_NAMES`,
  `ai.ts:200-205`; `BAND_BOSSES`, `ai.ts:207-214`) are explicitly sanctioned
  as reusable/extensible flavor (`VOICE.md:87-89`) — a tribe's rank-and-file
  naming can lean the same direction without inventing a new voice.

**Seam:** `TRIBES` consumed inside `makeMonster`/`spawnMonsters`
(`game.ts:103-145`, `227+`), same pattern as today's floor-gated weight
math — additive, not a refactor.

## 2. Settlements — places, not screens

**Problem.** The only "friendly place" today is `SafeRoom` — sim-paused,
between floors, one flavor string (`SafeRoom.tip`, `game.ts:2494-2504`). It
has no map position and closes the moment you leave it.

**Proposal — two kinds, one new room role:**

- **New `RoomRole: "settlement"`**, carved at floor-gen the same way
  `"landmark"` is today (`floor.ts:251-258`) — largest/best-placed remaining
  room, dressed via a new `theme.settlementProps` pool the renderer already
  knows how to key on role (`renderer3d.ts:1354-1358`). At megafloor scale
  this graduates to a region anchor per `MEGAFLOORS.md`'s region-per-cell
  proposal instead of a single room.
- **Friendly settlement** — reuses `SafeRoom`'s proven stock-tracking
  mechanism almost verbatim: a System kiosk (the existing
  `consumableStock`/`purchased` pattern, `game.ts:2615-2624`), a paid heal
  fountain, a rumor-monger selling the nearest stairway's minimap ping
  (`MEGAFLOORS.md:141-143`), and 1-2 quest-giver NPCs (§3). Unlike
  `SafeRoom`, the sim does **not** pause — you walk in and out mid-floor.
- **Hostile settlement** — a tribe's stronghold. Garrison drawn from that
  tribe's pack template (§1), raidable, no shop. Razing one is the natural
  first quest objective (§4) and a natural world-persistence test case
  (§"Open questions").
- **Sanctuary (friendly only)** — MEGAFLOORS.md proposed a `sanctuary` room
  mask monsters won't path into; **this does not exist in any form today** —
  `ai.ts` has zero room-role references, so this is genuinely new runtime
  logic, not a refactor of something partial. Cheapest correct version:
  a per-tile no-path mask checked once in the monster movement step,
  scoped to friendly-settlement tiles only (hostile settlements are
  *supposed* to have monsters in them). The one existing precedent is
  build-time only — entrance/vault rooms get zero spawn weight
  (`game.ts:301-303`) but nothing stops a roamer or a knockback from
  entering them mid-fight.

## 3. NPCs — a new entity type, and a voice problem to solve first

**Problem.** There is no non-combat entity type at all. And dialogue has
nowhere to go: `Announcement` (`types.ts:615-621`) carries no
`speaker`/`source` field, and `VOICE.md:51-53` explicitly owns the entire
`state.announcements` surface for "the System register" — this is a
documented design boundary, not an oversight. The **one** precedent for a
non-System voice in the whole codebase is `SafeRoom.tip`, a single string
field, called out in `VOICE.md:68-69` as "a distinct character voice; keep"
— but it isn't structurally separate, just an untyped string.

**Proposal.**
- A lightweight `Npc` type (position, `kind: "vendor" | "rumor" | "quest"`,
  `tribeId?` for a captured/hostile-tribe representative, optional
  `giving: QuestId[]`). Lives in a new `state.npcs: Npc[]` — per the
  snapshot finding below, this needs **no** `snapshot.ts` changes as long
  as it stays plain data.
- **Dialogue needs its own field**, not an `Announcement` extension —
  overloading the System's channel would break `VOICE.md`'s "one
  institution, two registers" thesis. Recommend `state.dialogue:
  DialogueLine[]` with `speakerId`/`speakerName`, and a short `VOICE.md`
  amendment carving out a third register ("settlement voices") explicitly,
  the same way the manager-tip exception was carved out.
- Rivals-mode isolation, if any NPC state is per-player (e.g. "has this
  player met this vendor"), follows `serializeFor`'s existing pattern
  (`snapshot.ts:74`, `safeRoom: me?.safeRoom ?? null`) — shared/global
  settlement state (an NPC's stock, a tribe's territory) needs no
  rivals-specific handling.

## 4. Quests — reuse the reward-draft seam before inventing anything

**Problem.** No objective system exists beyond "reach the stairs" and the
one-shot System Shrine bargain.

**Proposal.** The `Reward`/`pendingRewards`/`applyReward` mechanism
(`types.ts:411-421`, `398-409`; `Player.pendingRewards`, `types.ts:109`) is
already a generic "offer N, pick by index, apply as data" system, and it's
been reused twice beyond its original sponsor-draft purpose — the System
Shrine's own comment says it explicitly: *"rides the same `pendingRewards`
plumbing as sponsor drafts... hosts need no new UI"* (`game.ts:3072-3074`).
A quest payout is a fourth consumer of the exact same plumbing — no new
draft UI, no new apply-reward switch needed if it reuses existing
`RewardKind`s (`item`, `gold`, `materials`).

What's actually new is quest **state**, which nothing today tracks:
- `Quest { id, giverNpcId, objective: {kind: "killTribe", tribeId, count}, reward: Reward, status: "offered"|"active"|"complete" }`.
- Start with exactly **one** objective kind — kill N of tribe X — because it
  needs zero new sim verbs (kills are already counted, `Player.kills?` per
  `save.ts`'s field list) and zero new pathing/delivery logic. Prove the
  seam before adding "reach a location" or "deliver an item" objective
  kinds, which do need new verbs.
- Track active quests on `Player` (co-op: shared via party state; rivals:
  per-player, same isolation pattern as `pendingRewards` already uses).
- Persistence: quest completion needs a new optional `SaveData` field,
  following the codebase's own established migration convention — optional
  field + load-time default, exactly like `revisions?`/`tipsSeen?` were
  added (`save.ts:32,35,45-46`).

## Implementation impact map

- **`RoomRole` gains a member.** Every place that switches on role — the
  renderer's prop-pool pick (`renderer3d.ts:1354-1358`), the spawn-weight
  gate (`game.ts:301-303`), the event/vault siting filter (`game.ts:613`) —
  needs a `"settlement"` branch. Mechanical but wide, same shape as
  MEGAFLOORS.md's own `stairs: Vec2 → Vec2[]` breaking-change note.
- **`ai.ts` gets its first room-role awareness, ever.** Not a refactor of
  existing logic — there is currently none to refactor. This is the one
  piece of real new engineering in this doc; scope it as its own commit
  before any settlement content lands, same discipline MEGAFLOORS.md
  applied to the multi-stair breaking change.
- **`VOICE.md` needs an explicit amendment** before any NPC line ships, or
  settlement dialogue will read as a doc violation on day one, not a design
  decision.
- **`snapshot.ts` needs nothing.** `npcs`, `quests`, `dialogue` all ride the
  existing full-state spread as long as every field is plain JSON-safe data
  — confirmed by how `pings`/`lootBoxes`/`hazards` already work today with
  zero special-case code. Worth calling out as the one place this proposal
  is *cheaper* than it looks.
- **`SaveData` gets new optional fields** (settlement reputation, quest
  completion, tribe standing) via the codebase's own established
  optional-field-with-default convention — no new persistence mechanism
  needed, just more fields on the existing one.

## Phasing (each phase ships playable, testable via `?test&floor=N` today —
none of this is gated on the Expedition mode's persistence work)

**P1 — One tribe, one settlement, one quest.** A single friendly
settlement room role, one tribe with a pack template and territory posture,
sanctuary no-path logic (the one real new engineering piece), one
quest-giver NPC offering the kill-N-of-tribe-X quest via the existing
reward-draft seam, a `state.dialogue` field + VOICE.md amendment. Proves
every seam above in the *existing* 18-floor game — no persistence, no
Expedition mode required yet.

**P2 — Multiple tribes, hostile settlements.** Roll out the rest of
MOB-CONCEPTS.md's pack templates as tribe identities, add hostile
settlements (tribal strongholds, raidable, no shop), wire the rumor-monger's
stairway-ping (ties directly into `MEGAFLOORS.md`'s stairway-scarcity
design). Still no persistence — a hostile settlement's "razed" state resets
with the floor, same as everything else today.

**P3 — Persistence.** Settlement/quest/reputation state survives log-off —
this is the phase that actually needs the Expedition-mode world-persistence
wall from the other pitch. Until P3, "razing a settlement" or "completing a
quest" only lasts as long as the current floor instance, same ceiling every
other sim state has today.

## Open questions for the next session

- Is tribe standing/reputation global (per-account) or per-shard/per-run?
  Determines whether P3's persistence needs to be keyed by player or by
  world instance.
- Does a razed hostile settlement stay cleared, or does the tribe
  eventually retake it? The latter is more DCC (nothing stays won) but
  needs a repopulation timer that itself must survive log-off.
- Does a quest giver hold position, or patrol? Fixed-position is
  dramatically simpler (no new pathing) and is the right P1 default.
- Should hostile-tribe elites use the existing `EliteAffix` pool (§ "Elite
  variance" above) unchanged, or does tribe identity want its own affix
  flavor eventually? Not a P1 question — the existing pool is sufficient
  to ship a first tribe.
