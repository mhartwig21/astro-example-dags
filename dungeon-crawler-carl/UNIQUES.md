# UNIQUES.md — the full uniques economy (design)

Status: **designed 2026-07-26, awaiting owner sign-off.** This is the end-state
design for itemization's top tier: every unique in the game, what it rolls,
what it does, and which economy it belongs to. MOB-CONCEPTS style — delete
sections as they ship. Backlog #14 points here.

The frame (owner direction): **a single-run Diablo 2 with a League of Legends
crafting path.** Certain uniques are FOUND (drop-only, the dungeon's dead),
certain uniques are BUILT (shop-only, sponsor merchandise), and the run has a
clear item arc from floor 1 to floor 18.

---

## 1. The two economies

| | FOUND (the dungeon's dead) | BUILT (sponsor merchandise) |
|---|---|---|
| Source | Band bosses, vault pedestals, named menaces. **Never sold in shops.** | System Shop build trees. **Never drops.** |
| Emotional job | The upset — the corpse that changes the run | The plan — certainty that survives bad luck |
| Power style | Weird, conditional, build-WARPING rules; some carry a downside | Reliable, build-COMPLETING plumbing every build can use some of |
| Currency | Killing the right thing (+ luck + pity) | Gold + components + elite trophies / boss sigils + sponsors |
| Exit | Sell for gold only — **never** salvages to materials | Components consumed upward through the tree (existing) |
| Naming voice | Relics of dead crawlers and the dungeon's inhabitants | Show-business contracts and broadcast gear (existing) |

**Hard rules that keep the two systems honest:**

1. **Economy separation.** Found uniques cannot be bought, and selling one
   pays gold only. The moment found loot converts into trophies at a fair
   rate, the two currencies unify and the deterministic path always wins.
2. **Equal ceiling, different variance.** Both tiers read best-in-slot on
   stats before the rule triggers (built legendaries already follow this).
   Built rules are dependable engines; found rules are spikier and stranger.
3. **No passive appears in both pools.** Deliberate cross-echoes are fine
   (Venom Clause crits poison / Winter Rose crits chill) but each PassiveId
   lives on exactly one item.
4. **One bridge, and it flows found → built:** The System's Favorite (found,
   Approach) counts as +1 sponsor — a found item can UNLOCK built grails,
   never the reverse.
5. **The shop can TUNE found loot, not create it.** The Refurbishment bench
   (§6) rerolls a found unique's rolled line for gold. LoL crafting energy
   applied to D2 loot — the collision point where both systems meet.

## 2. Rolls: how unique variance works

Every unique (both tiers) has:

- **Fixed identity lines** — 2–3 affixes from the existing pool (`damage`,
  `spell`, `maxHp`, `armor`, `speed`, `crit`), materialized at acquisition
  floor on the catalog slope (`1 + 0.15 × (floor − 2)`, `gearAffixes`-style).
  The numbers are band-tuned; the RULE is what keeps the item alive to 18.
- **One ROLLED line** — the quality dial, rolled once from the seeded RNG at
  drop/purchase. This is the D2 "is it a good one?" moment: same unique,
  different corpse, different roll. Ranges are listed per item below; rolls
  are uniform across the range. The UI shows the rolled value (and the range,
  so a good roll is legible).
- **The rule** — a PassiveId hooked at existing choke points (`damageMonster`,
  `step`, dash resolution, status application, safe-room entry). Rules never
  scale with floor; they're rules.

Built uniques keep their current fixed stat lines; their rolled line is added
by this design (ranges in §5) so the shop keeps a whisper of gambling without
losing its certainty (you always get the item; the roll is the garnish).

## 3. Drop channels & pity (found tier)

Uniques **never drop from chaff** — a unique is always earned at a landmark:

| Channel | Chance | Notes |
|---|---|---|
| Band boss kill (floors 3, 6, 9, 12, 15, 18) | 45% + pity | Rolls from the CURRENT band's pantheon |
| Vault pedestal | 25% of vault rooms | `floor.ts` vault role gains a showcase pedestal: visible, announced, guarded. Touch to claim |
| Named menace / Foreman kill | 8% | The champion layer's lottery ticket |

- **Pity:** `state.uniquePity` +20% per boss/pedestal that fails to produce a
  unique; resets to 0 on any unique drop. Deterministic (seeded RNG). A full
  run expects **2.5–3.5 found uniques** — enough that the system exists every
  run, few enough that each one is an event.
- **No duplicates per run:** the pantheon roll excludes ids already dropped
  this run (`state.droppedUniques`).
- **Band gating IS the scaling arc:** Undercroft uniques are run-benders,
  Approach uniques are run-definers. A floor-3 unique that fits your build
  stays equipped to floor 18 because its rule doesn't decay.
- Drop moment: `announce` priority high ("UNIQUE MERCHANDISE — one of a
  kind, crawler"), gold beam + brief hold per backlog #14c drop drama.
- Multiplayer: existing party loot/pickup rules apply unchanged.

## 4. The found pantheon — 24 uniques, 4 per band

Format: **Name** (slot · weapon class if any) — fixed lines → **rolled line
[range]** → the rule. Weapon uniques' final noun registers in
`WEAPON_CLASS_BY_NOUN` (new nouns noted).

### THE UNDERCROFT (1–3) — the tutorial dead. Simple, legible run-benders.

1. **Doorman's Last Stand** (armor) — +armor, +maxHp → **shield strength
   [10–18% maxHp]** → Standing still for 1.5s raises a decaying shield.
   Rewards holding ground — the anti-kite fight, from the player's side.
2. **First Blood Trophy** (trinket) — +crit, +speed → **bonus first-hit
   damage [+15–35%]** → Your first hit on any monster is always a crit.
   Openers matter; pairs with Overcharge and heavy nouns.
3. **Coupon Book (Expired)** (charm) — +maxHp, +speed → **shop discount
   [12–20%]** → All System Shop prices reduced. The dungeon mocking the
   sponsors; the announcer mocks every purchase right back. (The one found
   item that accelerates the BUILT path — greed bridge, gold-side only.)
4. **Demolition Molar** (weapon · heavy, new noun "Molar") — +damage,
   +maxHp → **corpse-pop knockback [1.5–2.5 tiles]** → Kills detonate the
   corpse, shoving everything adjacent. Crowd bowling.

### THE SEWERS (4–6) — filth builds. Being surrounded becomes a stat.

5. **The Rat King's Crown** (helm) — +maxHp, +armor → **damage cap
   [+20–36%]** → +2% damage per enemy within 6 tiles, up to the rolled cap.
   Inverts "swarmed is bad"; the Sewers press density anyway.
6. **Grease Trap Boots** (boots) — +speed, +maxHp → **trail burn magnitude
   [band-tuned ±30%]** → Your dash leaves a burning grease trail (magic DoT
   ground strip). Stacks with the built Blastplate for full dash-build arson.
7. **Sump Pump Charm** (charm) — +maxHp, +armor → **stacks vented [1–2]** →
   Taking a melee hit vents poison onto all adjacent enemies. The tank's
   poison source; the Sump King's own trick, looted.
8. **Storm Drain Staff** (weapon · arcane) — +spell, +crit → **pull
   strength [0.8–1.4 tiles]** → Your Nova PULLS enemies inward instead of
   shoving them out. Build-warping combo tool (drain → Cataclysm/melee arc).

### THE GARDEN (7–9) — dead, hungry, and patient. Status payoffs bloom.

9. **Compost Plate** (armor) — +maxHp, +armor → **heal per DoT kill
   [8–16 HP]** → Kills by burn/poison ticks feed you. The DoT build's
   sustain, where leech (built, hit-scaled) can't reach.
10. **Bee Line** (boots) — +speed, +crit → **move speed after reset
    [+10–20% for 2s]** → Dash cooldown resets on kill. The zoom fantasy;
    turns cleared rooms into slalom courses.
11. **Winter Rose** (charm) — +crit, +spell → **chill magnitude
    [30–45% slow]** → Your crits CHILL. The only lootless chill source —
    the found-tier mirror of the built Venom Clause.
12. **The Gardener's Shears** (weapon · swift, new noun "Shears") —
    +damage, +speed → **bonus vs statused [+30–50%]** → Hits on burning,
    poisoned, or chilled enemies hit harder. Knits 9/11 + Venom Clause +
    the Afterburn constellation into one blade.

### THE RUINS (10–12) — whoever lived here lost. Attrition and memory.

13. **Load-Bearing Crown** (helm) — +maxHp, +armor → **armor slope
    [+1 per 2.5–4% HP missing]** → Armor grows as HP falls. The
    low-HP tank; terrifying with Cliffhanger Rig (#23), if you dare.
14. **Memorial Wall Fragment** (armor) — +armor, +maxHp → **kill quota
    [every 8–12 kills]** → Each quota met on a floor grants +1 permanent
    armor for the run. Greed made structural; collapse timer says hurry.
15. **Runner-Up's Javelin** (weapon · reach, new noun "Javelin") —
    +damage, +crit → **damage multiplier [1.8–2.4×]** → Your Bolt becomes
    this thrown javelin: multiplied damage, pierces everything, double
    cooldown. A dead crawler's whole build, in one throw.
16. **Broken Season Trophy** (trinket) — +crit, +damage → **overkill carry
    [60–100%]** → Overkill damage on a kill carries to the nearest enemy.
    The audience loves efficiency. Heavy/Overcharge's best friend.

### THE IRONWORKS (13–15) — the machinery remembers. Rhythm and heat.

17. **Assembly Line Gauntlet** (weapon · swift, new noun "Gauntlet") —
    +damage, +speed → **cadence [every 3rd–4th hit]** → Every Nth hit on
    the same target is a guaranteed crit that staggers (full poise break).
    A rhythm weapon; swap targets and the counter resets.
18. **Blast Furnace Core** (armor) — +maxHp, +armor → **burn magnitude
    [band-tuned ±30%]** → Melee attackers catch fire. The Furnace
    Marshal's lining, pried out. Found-tier fire mirror of Sump Pump.
19. **Body Double Contract** (charm) — +maxHp, +crit → **mirror damage
    [80–120% of yours]** → Your Stunt Double swings at the rolled fraction
    of your damage and its exit blast doubles in radius. The double gets
    top billing.
20. **Conveyor Treads** (boots) — +speed, +armor → **momentum cap
    [+15–30% speed]** → Speed builds while moving the same direction; at
    full momentum, colliding with an enemy knocks it down (stagger).
    Positioning becomes a weapon.

### THE APPROACH (16–18) — something enormous breathing. Run-definers.

21. **The Understudy's Script** (charm) — +crit, +spell → **echo power
    [60–80%]** → Your ultimate can be recast once within 4s at the rolled
    fraction of full power. Two Cataclysms. The finale deserves a callback.
22. **The Butcher's Quota** (weapon · heavy, new noun "Quota") — +damage,
    +maxHp → **snowball cap [+30–60%]** → +1% damage per kill this floor,
    resets at the stairs. The deepest floors have the most to kill.
23. **Cliffhanger Rig** (armor) — +maxHp, +speed → **desperation haste
    [30–50% faster cooldowns]** → Below 35% HP, all ability cooldowns run
    at the rolled speed. The Show's favorite camera angle.
24. **The System's Favorite** (trinket) — +crit, +speed → **gift heat
    [+1–2 floors]** → Counts as +1 sponsor for every gate, and sponsor
    gifts roll as if from the rolled number of floors deeper. The found →
    built bridge: the dungeon vouching for you to the network.

**Coverage check** (why these 24): every ability with room for a warp gets
one (dash ×2, nova, bolt, stance-adjacent crit play, stunt double, ultimate,
melee rhythm/snowball); every status kind gets a found source (burn ×2,
poison, chill) to feed The Gardener's Shears and the status constellation;
every slot appears 3–5 times; no rule reduces to "+bigger number" without a
condition attached.

## 5. The built ladder — 18 uniques on three shelves

The existing 16 catalog legendaries survive intact (same trees, same
passives) but are re-priced onto three shelves so the chase LADDERS —
Stealth-on-day-one vs. Enigma-never, instead of today's one mid-priced shelf.
Each also gains a **rolled line** (the garnish; ranges ~±20% around one of
its existing affixes, rolled at purchase, rerollable at the bench).

**EARLY shelf** (unlock shop 4 · sponsors 1 · elite_trophy 1 · combine ≤120):
first-plan uniques a floor-5 crawler completes.

| Item | Rule (existing) | Rolled line |
|---|---|---|
| The Headliner | +4 hype per kill | hype per kill [3–6] |
| Sweeps Week Staff | active cooldowns −15% | CDR [12–18%] |
| Standing Ovation Crossbow | bolts pierce +2 | pierce [+2–3] |
| Location Scout | stairs marked on arrival | +speed roll [±20%] |
| Live Feed | crits arc 30% as magic | arc fraction [24–36%] |

**CORE shelf** (unlock shop 6 · sponsors 2 · elite_trophy 2–3 · combine
140–180): the run's main plan, unchanged from today's costs.

| Item | Rule (existing) |
|---|---|
| Blastplate Harness | dash detonates at launch point |
| Landlord's Ledger | +6 gold/kill, 10% safe-room interest |
| Perpetual Encore | +1 orbit blade, 25% faster ticks |
| Signature Choreography | stance swap grants +20% crit surge |
| Blood Subscription | leech 6% |
| Cancellation Axe | execute non-elites below 15% |
| Venom Clause | crits poison |
| Backstage Pass | dash phases through walls |

(Rolled lines: one per item, ±20% on the passive's magnitude where it has
one — leech [5–7%], execute threshold [13–18%], surge crit [16–24%], gold
[5–8] — else on a stat line.)

**GRAIL shelf** (unlock shop 8 · sponsors 3–4 · elite_trophy 4 +
boss_sigil 2 · combine 300+): you commit a whole run to at most one.

| Item | Rule | Rolled line |
|---|---|---|
| Plot Armor (moved up) | once per floor, killing blow leaves 1 HP | post-save i-frames [1–2s] (new) |
| Overtime Clause (moved up) | ultimate CDR 25% | ult CDR [20–30%] |
| **Series Finale** (weapon · NEW) | your ultimate's school infuses your basic attacks for 8s after cast (Cataclysm → melee hits echo magic splash; Airstrike → bolts explode) | infusion power [30–50%] |
| **Syndication Deal** (trinket · NEW) | every OTHER equipped unique's rolled line counts as max-roll | +crit roll [±20%] |

Syndication Deal is the cross-economy capstone: it's built, but its value
scales with how many FOUND uniques you're wearing — the shop selling you a
better version of your luck.

## 6. The Refurbishment bench (shop service, floor 6+)

The one place the economies touch. Any unique's **rolled line** (found or
built) can be rerolled at a safe room: first reroll 60 gold, price ×1.6 per
subsequent reroll of the same item (per run). Uses the seeded RNG; the roll
is a fresh uniform draw (no pity, no ratchet — walking away mid-streak is
the decision). Sits in the shop UI next to sell/salvage.

## 7. Generated gear stays the floor, not the ceiling

Commons/magics/rares/epics remain the stat-stick underlayer (items.ts
untouched by this design except: **commons leave the drop table after floor
6** — past the first shop tier they're strictly noise). Epic drops remain
the best STAT items; uniques beat them only when the rule fits the build.
`itemScore` keeps working (uniques score by stats alone), so auto-equip
suggests but never understands a unique — which is correct: wearing one is
a decision the scalar shouldn't make. The affix-pool expansion question
(resists/CDR as generated affixes) is deliberately OUT of scope here —
that's backlog #14a's pruning-and-widening pass, and it should follow the
usage_events mining (#13), not precede it.

## 8. Implementation map (for the shipping PRs)

- `src/sim/uniques.ts` (new): `UNIQUES` table (id, name, slot, band, fixed
  affixes, rolled line spec, PassiveId), `rollUnique(rng, band, state)` —
  excludes `state.droppedUniques`, materializes stats at drop floor,
  rolls the variance line.
- `types.ts`: `Rarity` gains `"unique"` (gold tint in both hosts);
  `Item.uniqueId?: string`; `Item.roll?: { key: string; value: number }`;
  `PassiveId` +24 (one per pantheon entry) +2 (Series Finale, Syndication
  Deal); `GameState.uniquePity`, `GameState.droppedUniques: string[]`.
- Drop channels: boss-kill hook beside `dropBossBonus` (game.ts:2122);
  pedestal spawn in `floor.ts` vault rooms + touch-claim in game.ts;
  menace hook where elite trophies drop (game.ts:2769).
- Rule hooks: all at existing choke points — `damageMonster` (first-hit
  crit, cadence, statused bonus, overkill carry, snowball), status
  application (Winter Rose, Sump Pump, Blast Furnace), dash resolution
  (Bee Line, Grease Trap, Conveyor), `step` (Doorman shield, Load-Bearing,
  momentum), safe-room/shop (Coupon Book, Refurbishment), ult cast
  (Understudy, Series Finale), sponsor gating (System's Favorite).
- `snapshot.ts`: new Item/GameState fields; `persist/save.ts`: optional
  fields per the existing `revisions?` convention.
- Shop UI (main3d.ts): grail shelf styling, Refurbishment row, roll-range
  display on unique tooltips.
- Tests: per-band pantheon tests (rule fires, roll in range, no dupes,
  pity ratchet); balance-bot contract re-run per shipped band; a
  determinism test that the same seed drops the same unique with the same
  roll.

## 9. Shipping order (one PR each, top down)

1. **Skeleton + Undercroft** — unique tier, drop channels, pity, drop
   drama, the first 4 uniques. The system exists.
2. **Sewers + Garden** (8 uniques) — status-economy uniques land with the
   statused-payoff weapon.
3. **Ruins + Ironworks** (8 uniques).
4. **Approach + the bridge** (4 uniques incl. System's Favorite).
5. **Built ladder re-price** + rolled lines on built uniques + grail shelf
   (Series Finale, Syndication Deal).
6. **Refurbishment bench.**
7. Balance sweep vs. the bot contract + usage_events check-in; tune drop
   rates/pity against real runs.
