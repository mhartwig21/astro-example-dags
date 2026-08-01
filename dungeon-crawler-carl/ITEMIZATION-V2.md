# ITEMIZATION V2 — one loot system, a modifier layer, and a faster first act

Design doc (2026-08-01, aaa-refinement branch). Owner pillars this serves:

1. **Fast-round character building** — decisions come quickly and matter; a build
   takes shape within a floor or two and keeps evolving every safe room.
2. **Itemization = LoL × Diablo** — component→completed spike curve, gold as the
   tempo resource, a readable ~40-60-item shop — crossed with Diablo's rarity
   thrill, chase uniques, and stat fantasy.
3. **Abilities = LoL × Diablo × PoE2** — tight kits and cooldown play, visceral
   power, plus a support-gem-style MODIFIER layer with combo depth.
4. **Dungeon crawler first** — the Show is DCC's meta-fiction wrapper and economy
   flavor. It must never turn moment-to-moment play into a gameshow minigame.

Everything below is scoped against the shipped code (DESIGN.md 5.7–5.10,
`src/sim/abilities.ts`, `items.ts`, `catalog.ts`, `game.ts`). Section 5 is the
honest migration map.

---

## 1. AUDIT — what serves the pillars, what fights them

### 1.1 Keep (already right, don't touch the bones)

- **The catalog IS the LoL layer and it works.** `catalog.ts` + `buyCatalogItem`
  already do the real thing: components claim/credit at full price (bag OR
  equipped), built gear is gated on components-in-hand, higher tiers are
  floor-gated seeded subsets, and `gearAffixes` floor-scales purchases so the
  tree stays live all run. This is the spike curve. Keep the claim math verbatim.
- **Chase uniques with real passives.** The 16 legendaries (Perpetual Encore,
  Standing Ovation, Cancellation Axe, Blood Subscription, Backstage Pass…) are
  build-warpers implemented at the `damageMonster`/param-function choke points.
  The "novel mechanics live ONLY on items" rule (leech, execute, conduit, phase)
  is exactly Diablo-unique energy. Keep the rule and the hooks.
- **Weapon classes + bolt-from-weapon + schools.** Noun→class with one
  mechanical hook each, AP/SP schools, armored/warded resists, weapon-set damage
  variance (swift ±10% … Mug ±40%). The crossbow being a crossbow is load-bearing
  identity; the Mug joke stays (one absurd item is DCC-correct).
- **Constellations (forks/capstones/overranks).** Within-ability depth is
  shipped and good. The modifier layer (§3) composes ON TOP; it does not replace
  ranks.
- **The Five + bench + safe-room re-slot.** The slot scarcity is the build
  decision. Untouched.
- **Component drops** (`componentDropChance` 0.35) — random loot advancing the
  plan is the LoL/Diablo bridge. Keep, extend (§2.3).
- **Consumable stock scarcity, drop-rate restraint** (rare = windfall not
  strategy), healing-as-decision. All keep.

### 1.2 Change (fights the pillars)

- **Two parallel item systems.** `generateItem` rolls freeform affix-soup gear
  ("Vicious Maul", "Humming Hood") that never touches the catalog: no identity,
  no passive, no build path — exactly the "infinite affix soup" pillar 2 bans.
  Today a rare drop is only bigger numbers; the thrill decays by floor 5.
  **V2: one system — almost every drop is a catalog identity with a rarity roll
  on top** (§2.2). Freeform gear survives only as commons — dismantle fodder.
- **Fixed identities go stale.** A Prime-Time Cleaver bought on floor 4 is
  outgrown by floor 9 and the only answer is re-buying the same item (feels like
  a subscription, not progression). **V2: REFIT — upgrade an owned item's rarity
  in place** (§2.4). Diablo's "my item got better" on LoL's fixed identities.
- **No boss chase uniques.** `dropBossBonus` sprays generic items. Band bosses
  are the run's chapters; each should own a drop-only unique you can't shop for
  (§2.5). That's the missing Diablo half of the chase (store uniques = plan,
  boss uniques = thrill).
- **Dismantle is missing.** `sellItem` flattens everything to gold; materials
  are only elite_trophy/boss_sigil. Junk drops should feed the refit economy
  (§2.4), giving every pickup a use.
- **First act is decision-thin.** Legendary shelf at shop 4, ultimates floor 7,
  4th ability slot waits on the tome lottery, glyphless. Floors 1–3 are mostly
  "buy the obvious component." Pillar 1 wants a build clicking by floor 3–4;
  §4 rebuilds the cadence.
- **Auto-equip scoring is passive-blind and school-naive.** `itemScore` counts
  raw affixes; it will bench a legendary with a build-defining passive for a
  fatter stat stick, and scores spell/damage identically regardless of the
  crawler's dominant school. Fix alongside V2 (small, MUST).

### 1.3 Tone audit — gameshow-gimmick vs dungeon-grounded

The line: **the Show may narrate, price, and reward the crawl; it must not
interrupt the crawl's verbs or turn combat into a skit.** Flavor names on
dungeon mechanics are fine (the novels are exactly that); mechanics whose LOOP
is "audience minigame" are not.

Grounded — keep as is:
- Sponsor gates on legendaries, hype→frenzy (a passive buff), announcer
  pacing, ringside intros + boss bars (Diablo presentation in DCC voice),
  shrine bargains (Blood Price is a Diablo shrine with a lawyer), the gambling
  den (`svcWager` — gambling vendors are ARPG canon), Landlord's Ledger
  interest (greed engine, resolved in safe rooms only).
- Item naming register: "Cancellation Axe", "Plot Armor", "Sweeps Week Staff" —
  the joke is in the NAME; the mechanic under each is pure dungeon. Correct.

Gimmick-risk — change or re-ground:
- **Audience Participation** (ABILITY-CONCEPTS ultimate: crowd votes, anvils,
  confetti, a prank slot). This is a slot machine cutscene wearing an ultimate's
  slot — the clearest pillar-4 violation on the books. **Cut from the slate.**
  Its one good idea (outcome quality reads hype) belongs in sponsor draft roll
  quality, which already exists.
- **Golden Handshake** (spend shop gold as ammo). Gold is pillar 2's tempo
  resource; an ability that burns it fights the itemization game directly.
  **Cut or rework to spend a new throwaway resource** (e.g. picked-up debris).
- **System interference boredom mechanics** (`updateInterference`: flatlined
  hype spawns corrective ambushes/hazards). The dungeon punishing low RATINGS
  is meta leaking into the crawl. **Keep `postBounty`** (a bounty on a live
  monster is dungeon-grounded); demote corrective ambush/hazard-review to
  announcer needling only, or gate them out of floors 1–6 entirely.
- **Sponsor challenge floor event** — mechanically a no-hit room clear (fine,
  ARPG-shaped); presentation says "dare." Reframe as a posted **bounty
  contract** (same code, new lines): the System pays for clean work, it doesn't
  double-dog-dare you.
- **STOP THE COUNT** (concept) — despite the name, borrowing time from the
  collapse clock is the most dungeon-grounded design on the slate. Keep the
  concept, rename to the System register ("OVERTIME", VOICE.md pass).

Presentation rule going forward: **the Show comments on outcomes; it never
becomes an input the player must play against mid-combat.** (Hype as a passive
multiplier: fine. Hype as ammo/aim/roulette: not.)

---

## 2. ITEMIZATION V2 — one catalog, rarities on top

### 2.1 Architecture

Every meaningful item in the game is a **catalog identity**:

```
T0 STARTER   (3)   floor-1 kit, sell-back fodder
T1 COMPONENT (~16)  one clear stat identity; a few carry MICRO-passives
T2 COMPLETED (~16)  2 components + gold; every one has a build passive
T3 SIGNATURE (~16)  store-assembled chase uniques (sponsors + materials)  [shipped]
BOSS UNIQUE  (5)   drop-only, one per band boss — cannot be bought
CONSUMABLE   (6)   rations/rods/kits/tomes/favors + GLYPH CACHE (§3)
```

Total ≈ 56 named identities + the Mug — inside the 40–60 pillar budget. The
shipped catalog already covers ~43 of these; V2 is an extension and a drop-
system unification, not a rewrite.

**Rarity is a roll ON TOP of identity, not instead of it.** Any catalog item
can exist at common/magic/rare/epic *quality*:

| quality | stat line | extra |
|---|---|---|
| common | printed (× floor scaling) | — |
| magic  | ×1.15 | +1 bonus affix from the item's curated pool |
| rare   | ×1.30 | +1 bonus affix; micro-passive numbers upgraded |
| epic   | ×1.50 | +2 bonus affixes |

- **The shop sells common quality** — certainty and build paths, never jackpots.
- **Drops roll quality** (existing RARITIES weights 64/26/8/2) — a rare-quality
  Honed Edge is the Diablo moment: *the item you already wanted, but hot*.
- Bonus affixes come from a 3-4 key pool curated PER ITEM (e.g. Honed Edge:
  crit/speed/maxHp), so rolls stay readable — no six-affix soup.
- Combining consumes components regardless of quality; the built item comes out
  common (upgrade it via REFIT, §2.4). Quality-inheritance on combine is a
  LATER experiment — it complicates the claim math for marginal thrill.

Data shape: `Item` keeps `rarity` as the quality field (already rendered
everywhere); `catalogId` is now present on ~all drops; bonus affixes are just
materialized into `affixes` at roll time (nothing new to persist).

**Which multiplier table applies — keyed on `catalogId` presence.** There are
two tables, one per path, and BOTH are materialized into `affixes` at creation
time, so `rarity` is never read as a stat multiplier after the roll:

- `catalogId` present: base line = `gearAffixes` (printed × floor slope) ×
  **new `CONFIG.catalogQualityMult`** = { common 1.0, magic 1.15, rare 1.30,
  epic 1.50 } (the table above), applied only in `rollCatalogDrop` and
  `refitItem`. The shipped `RARITIES.mult` never touches a catalog item.
- `catalogId` absent (commodity): unchanged — `generateItem`'s
  `rollAffix × RARITIES.mult` (1.0/1.6; commodity no longer rolls rare/epic
  per §2.2). The big commodity mult IS that item's whole story; the small
  catalog mult rides on printed lines that already carry identity + a passive
  and are parity-calibrated at common.

The label overlap ("magic" commodity ×1.6 vs "magic" catalog ×1.15) is
deliberate, not an inversion: quality compares within a path, never across,
because the base lines differ by design. A **guard test** pins the pillar:
at equal floor and slot, a magic-quality catalog COMPLETED must `itemScore`
above a magic commodity — catalog identity first, enforced in CI.

Consumers and their branches (this is the Phase A checklist):
- `items.ts rarityMult`/`generateItem` — commodity-only path; gains a comment
  asserting no `catalogId` flows through it.
- `items.ts rollCatalogDrop` (new) — the only reader of `catalogQualityMult`
  besides `refitItem`.
- `itemScore` — NO branch: affixes are pre-materialized; identity value enters
  via the passive bonus (§5 Phase A).
- Item cards / `#itemtip` (`main3d.ts`) — branch on `catalogId`: quality stars
  for catalog items, rarity prefix/tint for commodity.
- `catalog.ts:342` tier-parity comment — rewrite: parity is now anchored at
  COMMON catalog quality vs commodity drops; cite the guard test.

### 2.2 The drop table (replaces freeform-first `dropLoot`)

Per equipment drop (`lootDropChance` unchanged):

- **55% catalog COMPONENT** at rolled quality (was 35% at common) — loot
  advances the plan, and sometimes spectacularly.
- **15% catalog COMPLETED** (floor-gated like the shop shelf) at rolled quality
  — the "skipped the shop line" windfall.
- **25% commodity gear** — slimmed `generateItem`: commons/magics only, no
  epic soup. Exists to be worn for 2 floors, then dismantled.
- **5% GLYPH** (§3) — the modifier drop, floor 2+.
- Elites: +1 guaranteed roll biased component/glyph; band bosses: guaranteed
  glyph + their unique's chance (§2.5).
- **Smart-loot bias (SHOULD):** weapon-slot drops roll the crawler's dominant
  school 60/40 (party: pick a random member's). Finding a great staff still
  nudges builds; finding one every floor as a maul crawler is noise.

### 2.3 The catalog additions (named, DCC-flavored, dungeon-grounded)

New COMPONENTS (fill class/slot gaps; * = micro-passive, LoL-component style —
a weak preview of the legendary it builds toward):

- **Rebar Spear** (weapon, reach) — dmg 6. "Structural. Formerly load-bearing."
- **Sledge Head** (weapon, heavy) — dmg 9, cd +15%. "No handle. Commit."
- **Stock and Trigger** (weapon, ballistic) — dmg 5, +10% bolt speed.
  "Some assembly required. The bolts are your problem."
- **Riot Shim** (armor) — armor 7. "Wedged between you and the incident."
- **Field Tourniquet*** (charm) — maxHp 8; *heal 2% of damage dealt* → builds
  toward Blood Subscription (6%). "Twist until the screaming stops. Yours."
- **Dowsing Fork*** (trinket) — speed 0.2; *gold pickups +1* → builds toward
  Landlord's Ledger. "Points at money. Occasionally at sewage."
- **Insulated Gloves** (helm-pool filler, charm) — spell 4, armor 3. "Rated for
  the voltage you're about to be."

New COMPLETED works (2 components + gold, each with a passive — LoL legendary
energy; slotting into existing chase ladders where marked):

- **Pikeman's Rebuttal** (Rebar Spear + Iron Plating; reach) — dmg 12, maxHp 20.
  Passive: melee hits from ≥1.5 tiles knock the target back 0.5. *The hallway
  is a weapon.*
- **Demolition Permit** (Sledge Head + Killer Instinct; heavy) — dmg 16,
  crit 5%. Passive: your stagger-breaking hits deal +40%. *Paperwork for
  hitting load-bearing things.* → builds into Cancellation Axe path.
- **Court Order** (Stock and Trigger + Glass Charm; ballistic) — dmg 11,
  crit 8%. Passive: bolts against UNALERTED monsters always crit. *Serve them.*
  → alternate rung under Standing Ovation.
- **Slumlord's Deposit** (Dowsing Fork + Focus Bead; trinket) — speed 0.3.
  Passive: monsters drop +20% gold. → Landlord's Ledger rung.
- **Ambulance Chaser** (Field Tourniquet + Padded Lining; charm) — maxHp 25.
  Passive: heal 3% of damage dealt (per-hit cap). → Blood Subscription rung.
- **Grounded Suit** (Riot Shim + Insulated Gloves; armor) — armor 12, spell 6.
  Passive: while above 70% HP, +15% spell power. *Do not become the path of
  least resistance.*

(Existing advanced items keep their lines; several gain the passive pass so
every T2 says something: e.g. Showstopper Plate gains *"first hit each pack
deals 30% less"*, Roadie Runner gains *"+10% move speed for 2s after a kill"*.
Budget: one sentence per item, implemented at existing choke points.)

### 2.4 Dismantle + REFIT (the crafting integration)

New material: **`refit_shard`** ("Scrap Certification").

- **DISMANTLE** (safe-room bench, replaces sell for gear you don't want to
  liquidate): a bag item breaks into shards by quality (common 1 / magic 2 /
  rare 4 / epic 8). Catalog items may still be SOLD for the 60% gold path —
  gold vs shards is the tempo-vs-power call, a real decision every safe room.
- **REFIT** (safe-room bench): upgrade an OWNED item's quality one step.
  Cost: shards (3 / 6 / 12 for →magic/→rare/→epic) + gold (~40% of the item's
  totalCost). Re-rolls its bonus affix additions at the new tier; floor-rescales
  the base line to the current floor (this is the "my floor-4 item stays alive"
  verb — strictly better than re-buying).
- Legendaries/signature gear refit too (that's the late-game shard sink);
  boss uniques refit with shards + a boss_sigil (their numbers are the chase).

### 2.5 Boss uniques — the drop-only chase

One per band boss, ~35% drop chance (seeded), announced by the System like a
title belt. Cannot be bought, cannot be target-farmed past the floor — the
Diablo "it finally dropped" thrill:

- **Front Desk Bell** (fl.3, Crypt Concierge — trinket): your kills leave NO
  corpses; each denied corpse pays 4 gold and 1% max-HP. *Checkout is
  immediate.* (Necromancer/raise denial + greed; reads the existing corpse
  plumbing.)
- **Sump Crown** (fl.6, Sump King — helm): ground hazards deal 50% to you; your
  chill and poison last +50%. *Royalty of the standing water.*
- **Rootcutter Shears** (fl.9, Topiary Warden — weapon, swift): every 3rd melee
  hit SNARES the target 0.6s (`rootT` flip — player-side roots at last).
- **Loadbearing Girder** (fl.12, Condemned Architect — armor): you cannot be
  knocked back; when a hit is mitigated by armor, 30% of the mitigated amount
  shards back at the attacker (physical). *The building disagrees.*
- **Furnace Draft** (fl.15, Furnace Marshal — charm): enemies that die burning
  spread their burn to the nearest enemy. *Fire is a rumor that travels.*
- (Floor 18 drops no unique — the run ends. A trophy-tier item for rivals/NG+
  is LATER.)

### 2.6 Gold tempo — what you buy when

Targets (current income ≈ 90-160g/floor early, scaling with depth + ledger/
greed effects; tune `goldPerFloor` to hit these bands, not the reverse):

| shop after floor | banked (target) | the intended buy |
|---|---|---|
| 1 | ~100–140 | 1–2 components — the build's first noun (school pick) |
| 2 | ~120 | 2nd component + a consumable; **glyph socket 1 is open** (§3) |
| 3 (boss) | ~180 + trophy | **first COMPLETED work — the build clicks** |
| 4–6 | ~150/floor | 2nd completed, first refit, glyph #2; legendary shelf opens |
| 7–9 | ~200/floor | signature ladder middles; ultimate arrives fl.7 |
| 10–13 | ~250/floor | first SIGNATURE legendary; refits to rare |
| 14–16 | ~300/floor | 2nd legendary or boss-unique refit; epic refits |
| 17–18 | leftovers | consumables, stabilizer rods, one last favor |

The change from today: the first completed work moves from "floor 5–6 if lucky"
to floor 3–4 by design (component prices already allow it; the boss-3 trophy +
guaranteed component drops close the gap). Advanced shelf unlock moves shop
2→2 (unchanged) but stocks +1 deeper per shop so the floor-3 combine is
reliably available.

---

## 3. ABILITY MODIFIERS — GLYPHS (the PoE2 layer)

### 3.1 The frame

**Glyphs** are socketable modifier stones for The Five. Fiction: System-issued
firmware patches for your abilities — found in the dungeon, not granted by the
crowd (dungeon-grounded; the Show may SPONSOR one as a gift, but glyphs are
loot).

- **Sockets live on the SLOT, not the ability.** Each of the 4 active slots has
  up to 2 sockets; the ultimate slot has 1. A glyph affects whatever ability
  currently occupies its slot — if the tags match; otherwise it sits DORMANT
  (shown greyed). Re-slotting abilities over glyphs is therefore itself a build
  verb ("this slot is my projectile slot").
- **Unlock cadence** (pure function of level, nothing persisted): socket 1 of
  every slot at level 4 (≈ floor 2); the four second sockets **stagger** at
  levels 11 / 13 / 15 / 17, one slot at a time. Ultimate socket unlocks with
  the ultimate. *(Staggered because opening all four at once outran the glyph
  supply: a typical run reached the act-2 beat with 3–4 stones and five empty
  wells, and an empty socket is the direct negation of fast-round building.
  See §3.5.)*
- **Socketing/removal is a SAFE-ROOM decision** (same gate as re-slotting), with
  the same "empty socket fills immediately in the field" exception as ability
  discovery — momentum for fresh finds, commitment for rearranging. Removal is
  free and lossless (glyphs go to a glyph bench); scarcity is in FINDING them,
  not in juggling them.
- **Acquisition:** 11% of equipment drops (§2.2), capped at 3 per floor;
  guaranteed from band bosses; 1–2 seeded per shop shelf as a consumable-tier
  row ("Glyph Cache", stock 1, ~90g + 8/floor — the roll inside is seeded); an
  occasional sponsor-draft option (`RewardKind: "glyph"`); pity rule: if the
  party owns zero glyphs by floor 2's shop, the shelf guarantees one. See §3.5
  for the supply↔socket contract these numbers answer to.

### 3.2 Tags and stacking rules

Ability archetype tags (declared in the registry beside `ABILITY_INFO`):

| tag | abilities |
|---|---|
| `projectile` | bolt, airstrike shells |
| `melee` | melee, cutto (Blindside) |
| `aoe` | nova, cataclysm, dash-shockstep detonations |
| `movement` | dash, crowdsurf (Extradition self-pull) |
| `summon` | stuntdouble |
| `buff` | stance, overcharge, bullettime |
| `any` | everything that deals damage |

Rules (all deterministic, order-independent):
1. One copy of a given glyph per slot; duplicates across different slots are
   legal (two Brand glyphs on two abilities: fine).
2. Glyphs carry a **family**; two glyphs of the same family cannot share a slot
   (`split`: Arc-Splice/Splitfang; `repeat`: Reprise/Static Charge; `lens`:
   the school converters; `range`: Point Blank/Longshot; `rebate`: the
   refund/cost glyphs; `tempo`: Heavyweight Plate/Hair Trigger — see the §3.3
   table's family column). Everything else composes.
   **Why `tempo` exists:** two opposed tradeoffs sharing a slot launder each
   other's downside. At launch these two had no family and the CDR sum
   cancelled exactly (+20% − 20% = 0), so the pair was **+18.8% damage at zero
   cooldown cost** — the auto-include on all nine sockets, and the reason the
   loadout screenshots showed the same two stones over and over. The family
   keeps the axis honest; any future glyph trading along damage↔cooldown joins
   it.
3. Numeric glyphs multiply with constellation ranks and item passives (they
   share the existing param-function pipelines).
4. Behavior overlaps are additive with named resolutions: RICOCHET capstone +
   Chain glyph = bounce counts ADD, each at its own printed fraction, `hitIds`
   still prevents re-hits. Frost Bolts node + Chill glyph = strongest slow
   wins, durations refresh (matches status.ts).
5. School converters (lens family) trump the weapon's bolt profile — an
   explicit socket beats a default.
6. DoT riders never crit and never build poise (existing status rules).
7. **Global CDR cap — on PERCENTAGE modifiers only.** All percentage cooldown
   modifiers — glyphs (Hair Trigger), constellation ranks, item passives — sum
   ADDITIVELY and then clamp once: the summed reduction is capped at **40%**,
   so the percentage layer alone never takes an ability below 60% of its
   printed base. Cooldown increases (Heavyweight Plate) join the same sum
   before the clamp and pass through unclamped. One clamp on that sum,
   deterministic and order-independent.
   **What rides OUTSIDE the cap** (and therefore below 60%): weapon-class and
   class-revision multipliers, which are *identity* multipliers, not modifiers
   — a swift blade swings faster because that is what a swift blade IS. They
   multiply the already-clamped result. The real floors that ship:
   melee `0.6 × swiftMeleeCdMult` = **0.54** of base on a swift weapon, bolt
   `0.6 × wandBoltCdMult` = **0.48** of base on a Wand, dash
   `0.6 × revisionHeavyDashCdMult` on The Heavy. Temporal buffs (frenzy,
   tempo, Bullet Time's `cdTickMult`) are likewise outside — they scale the
   passage of cooldown time, not the printed number.
   The `glyphs.test.ts` "RULE 7's REAL floor" case pins each of these so the
   band can't be widened by accident.
8. **Per-cast refund cap.** Cooldown REFUNDS (`rebate` family, Encore Clause,
   any item refund) share a per-cast budget: refunds triggered by one cast
   total at most **50% of that ability's post-cap cooldown**; excess refunds
   that cast are discarded. Tracked as a transient per-slot accumulator reset
   on cast (optional numeric Player field, same pattern as `meleeComboT`).
   Hair Trigger is CDR (rule 7), not a refund — it stacks with rebates only
   inside these two caps, so pack fights can't drive short-CD abilities or
   ultimates (Encore Clause on dense floors) to spam.
9. **Dormancy reads EFFECT, not just tags.** Tags are the fiction ("this is a
   projectile"); **channels** are the machinery (`damage`, `cooldown`, `onhit`,
   `bolt`, `echo`, `scale`, `surge` — `ABILITY_CHANNELS` / `GLYPH_CHANNELS` in
   `sim/glyphs.ts`). A glyph is live only when the tags intersect **and** the
   occupying ability exposes **every** channel the glyph consumes; otherwise it
   sits dormant, with a plain-language reason the host prints verbatim (the sim
   owns the sentence — dormancy is a rule).
   This is what stops a socket lighting up gold and doing nothing: Reprise on
   Airstrike (aoe on both sides, but only nova/cataclysm schedule
   re-detonations), Arc-Splice on Airstrike (shells are strikes, not
   projectiles), and the whole "any"-tag set on the buff abilities. Heavyweight
   Plate and Hair Trigger need BOTH halves of their trade present: an ability
   with a cooldown and no damage (Bullet Time, Stunt Double, Battle Stance,
   Overcharge) would take the drawback and skip the payoff — Heavyweight on
   Bullet Time was *strictly negative* while presenting as a buff — and Orbit,
   which has damage and no cooldown, would take a free +30%. Both read dormant
   now. Adding a consumer in code means adding its channel here; the
   `(glyph × ability)` contract test in `glyphs.test.ts` fails otherwise.

### 3.3 The glyph set — the authoritative table

**25 distinct glyphs: 10 ship at Phase B launch, 15 in Phase C.** Mirrors
(Arcane/Ballistic Lens, Point Blank/Longshot) are separate glyphs — readability
beats cleverness. Names in the System's register but grounded — dungeon
enchantments, not sketch comedy. This table IS the spec; the Phase B column
matches §5's launch list exactly.

| glyph | tags | family | effect | phase |
|---|---|---|---|---|
| Arc-Splice | projectile | split | hits arc 40% of damage to nearest other enemy, one link | B |
| Splitfang | projectile | split | on first impact forks into 2 at 45% damage, continuing outward | B |
| Reprise | aoe | repeat | re-detonates same spot 0.8s later at 40% power (`Strike` echo) | B |
| Static Charge | melee, projectile | repeat | every 3rd cast empowered: +60% damage, 2× poise | C |
| Brandmark | melee, projectile | — | hits BRAND 4s; branded take +12% from your OTHER abilities | B |
| Demolition Rider | aoe | — | blast consumes burn/poison, dealing remaining DoT instantly (setup: Accelerant/Envenomed) | C |
| Arcane Lens | melee, projectile | lens | ability deals MAGIC, scales off spell power | B |
| Ballistic Lens | melee, projectile | lens | mirror: deals PHYSICAL, scales off attack power | C |
| Accelerant | any | — | hits IGNITE for 25% of the hit over 3s (burn rules) | B |
| Envenomed | melee, projectile | — | hits have 35% chance to inject a poison stack | C |
| Cryo-Etch | aoe, projectile | — | hits CHILL 20% for 2s | C |
| Grave Dividend | aoe | — | consumes up to 3 corpses under the cast; +15% damage each | C |
| Executioner's Rebate | any | rebate | kill within 1s of hit refunds 30% of cooldown (rule 8 cap) | B |
| Culling Edge | melee, projectile | — | +50% damage below 25% HP | C |
| Poise Wrecker | melee, aoe | — | 2× poise damage; your staggers last +0.3s | C |
| Heavyweight Plate | any | tempo | +30% damage, +30% cooldown (joins rule 7 sum) — DPS-neutral | B |
| Hair Trigger | any | tempo | −20% cooldown (rule 7 cap), −20% damage — DPS-neutral | B |
| Point Blank | melee, projectile | range | +30% damage within 2 tiles, −15% beyond | C |
| Longshot | projectile | range | mirror: +30% damage beyond 4 tiles, −15% within 2 | C |
| Blood Price | any | rebate | casts cost 3% max HP; +30% damage (shrine language, item-ized) | C |
| Slipstream | movement | — | after movement resolves: +15% move speed, +10% damage for 2s | B |
| Phase Etch | movement | — | +0.15s i-frames; passed-through enemies take 30% ability power (physical) | C |
| Understudy's Rider | summon | — | double's contract +2s; its farewell blast chills | C |
| Encore Clause | ultimate | rebate | kills during the ultimate refund 4% of its cooldown each (rule 8 cap) | C |
| Cold Open | ultimate | — | ult cast CHILLS everything within 6 tiles 30% for 3s | C |

### 3.4 Composition with what exists

- Constellation = permanent within-ability depth you DRAFT; glyphs = portable
  cross-ability behavior you LOOT and re-socket. The same ability can be deep
  (ranks), forked (exclusive nodes), capped (capstone), branded and echoing
  (glyphs) — five layers, each with a different acquisition verb. That is the
  PoE2 promise on LoL's kit-clarity budget: at most 2 glyphs per ability keeps
  every kit describable in one breath.
- Bot-visible combos the design owes tests for: Brandmark bolt → nova cash-in;
  Cryo-Etch nova → Point-Blank melee; Grave Dividend cataclysm in a cleared
  room; Executioner's Rebate on Blindside (REPEAT OFFENDER adjacent — both
  fire, refund then reset).

### 3.5 Supply vs sockets — the contract

Sockets are the *demand* side and drops are the *supply* side, and they have to
grow together. They did not at launch: `dropGlyphShare` 5% × `lootDropChance`
22% is ~1.1% of kills, or roughly **one glyph per 90 kills**, against nine pips
that opened in two lumps (four at level 4, four more at level 11 plus the
ultimate). A typical run reached the §4 "act 2 rebuild moment" holding 3–4
stones and looking at five empty wells — and "glyphs are free to re-socket, the
cheapest pivot in the game" only reads as a pivot if you own alternatives.

Both sides moved:

- **Supply:** `dropGlyphShare` 5% → **11%**, with `glyphDropsPerFloorCap: 3` so
  a hot floor can't dump the pool (steady, not spiky).
- **Demand:** the four second sockets stagger across levels **11 / 13 / 15 /
  17** instead of all opening at once.

The ratio is a **contract, not a vibe**: `glyphs.test.ts` models supply from the
shipped knobs (drip × kills, band-boss guarantees, one cache per shop from the
shop it shelves on) and asserts it covers the sockets open at floors **4, 7 and
12** — plus an upper bound, so glyphs stay a pivot resource rather than a
vending machine. Retune any of those knobs and the test tells you which beat
you broke.

---

## 4. FAST-ROUND BUILDING — the decision cadence

The target: **by the floor-3 boss you can say your build's sentence out loud**
("frost bolt sniper with a chain glyph, saving for Court Order"). Layered
decision arrival, one new system per beat, never two panels at once:

| beat | decisions arriving |
|---|---|
| floor 1 | movement + first level draft (constellation entry); first component drop |
| shop 1 | school pick via first component buys (the fork in the road) |
| floor 2 | glyph socket 1 opens (lvl 4); first glyph drop/pity; 4th-slot tome window opens |
| shop 2 | glyph cache on shelf; 2nd component; first dismantle-vs-sell call |
| floor 3 | BAND BOSS: trophy, guaranteed glyph, boss-unique lottery |
| shop 3 | **first COMPLETED work — the click.** Sponsor draft quality rising |
| floors 4–6 | fork + capstone committed; refit #1; completed #2; revision fl.4 |
| shop 6 | signature ladder planning view (the 3-shop plan begins) |
| floor 7+ | ultimate + its socket + slot 1's second socket — act 2 rebuild moment |
| floors 8–12 | the remaining second sockets arrive one at a time (lvl 13/15/17), each with a stone already banked for it |
| floors 10–16 | signature legendaries, epic refits, boss uniques — stat fantasy act |

Interleave rule: safe rooms present at most shop OR draft OR glyph socketing as
the headline (existing UI zones); drafts stay non-blocking mid-floor.

Pivot / catch-up mechanics:
- **Retrain** (shipped, sponsor pool) — fork-side refund as fresh drafts.
- **Glyphs are free to re-socket** — the cheapest pivot in the game by design;
  a bad glyph plan costs a safe-room minute, not a run.
- **Same-shop full refund:** anything bought THIS safe room sells back at 100%
  (undo, LoL-style); 60% after leaving. **One rule closes the bench exploits:
  an item leaves `boughtThisShop` the moment it is modified or consumed —
  refit, dismantle, combine (as a component), or use.** The 100% path applies
  only to unmodified purchases: buy→dismantle yields shards but forfeits the
  refund; buy→refit sells back at 60% of the un-refitted price like any owned
  item. Prevents fat-finger tragedies without making the shop a bank or a
  shard mint.
- **Dismantle→refit** converts a dead-end bag into power for the live build.
- **Smart-loot school bias + rewardFitScore** (shipped) keep gifts on-build;
  the diminishing-returns rule keeps +damage from being the every-floor pick.
- Behind-the-curve rule (SHOULD): if a crawler's item total-value is under the
  floor's expected band, component drop share rises 55→70% for them
  (per-player roll, deterministic).

---

## 5. MIGRATION MAP — seams, scope, tests

Ground rules honored throughout: sim stays pure/seeded; saves extend
`SavedProgress` with OPTIONAL fields + load-time defaults; snapshots stay
plain-data spreads (new optional fields ride free; no SNAPSHOT_VERSION bump —
additive only); hosts get zero rules.

### Phase A — one item system (MUST)

- **`src/sim/types.ts`** — `MaterialId` += `"refit_shard"` (Record init in
  `makePlayer`; absent-key defaults on load — same pattern as bonusArmor).
  `Item` unchanged (quality reuses `rarity`; `catalogId` already optional).
- **`src/sim/catalog.ts`** — new entries (§2.3, §2.5); `CatalogEntry` +=
  `dropOnly?: true` (boss uniques: excluded from `generateSafeRoom` shelves),
  `bonusPool?: (keyof Affixes)[]`, `micro?: PassiveId`. `PassiveId` additions
  for new passives (`denycorpse`, `snare3`, `unmoved`, `spreadburn`, …) — each
  is one hook at an existing choke point (`damageMonster`, `damagePlayerHit`,
  `reapDead`, knockback application).
- **`src/sim/items.ts`** — new `rollCatalogDrop(rng, floor, slotBias?)`:
  entry pick + quality roll + bonus-affix materialization, applying
  `CONFIG.catalogQualityMult` — NEVER `RARITIES.mult`; the multiplier path
  keys on `catalogId` presence per §2.1, and the §2.1 guard test (magic
  catalog completed outscores magic commodity) lands here. `generateItem`
  demoted to commodity commons/magics (keeps `RARITIES.mult`). `itemScore`
  learns passives — the bonus scales by the passive's CATALOG TIER (advanced 25,
  legendary 60, drop-only boss unique 80, untiered 15/25), so auto-equip can
  never bench a chase unique for a shelf item with a marginally fatter stat
  line — and takes a school param; `wantsAutoEquip` reads it.
- **`src/sim/game.ts`** — `dropLoot` new table (§2.2); `dropBossBonus` +=
  boss-unique roll; bench verbs `dismantleItem(state, playerId, bagIdx)` and
  `refitItem(state, playerId, ref)` (safe-room gated like sell); same-shop
  100% sell-back (track `boughtThisShop` ids on `SafeRoom` — optional field;
  ids are EVICTED on refit/dismantle/combine/use per §4).
- **`src/sim/config.ts`** — `catalogQualityMult` (the §2.1 catalog table,
  distinct from `RARITIES`), drop-table shares, refit costs, boss-unique
  chance.
- **`src/sim/bot.ts`** — SHOP_LADDER extended through a completed-work-by-
  shop-3 line; shop() dismantles junk + refits when shards allow (bot
  competence keeps the balance contract honest about the new power curve).
- **Save/net** — `SafeRoom.boughtThisShop?`, materials key: both optional.
- **Hosts (`main3d.ts`)** — enumerated like the sim files; UI only, every
  number from sim helpers; all inside zones the features' parents already
  claim (iso.html zone map — no new zones):
  - Safe-room modal (`#saferoom`, z 24): a BENCH section beside the shop
    shelves — per bag item, DISMANTLE (shard-yield preview) and REFIT
    (shard + gold cost, resulting quality, floor-rescale preview, disabled
    state with reason when unaffordable) actions; `refit_shard` count joins
    the gold/materials readout in the same panel.
  - Item cards + cursor tooltip (`#itemtip`, z 30): quality stars on catalog
    items, rarity prefix/tint on commodity (the `catalogId` branch, §2.1);
    boss uniques get the drop-only marker.
  - Right-rail ticker (`#toasts`): shard gains and boss-unique drop lines ride
    the existing announcement routes — no new surface.
- **Tests** — `sim.test.ts` "itemization" + "planning-first drops" describe
  blocks change (drop composition is an intentional rules change — one-line
  justification: freeform epics removed by design). New bench suite
  (dismantle/refit determinism, refit floor-rescale, §2.1 quality-path guard,
  `boughtThisShop` eviction on refit/dismantle/combine). `balance.test.ts`
  contract stays green; the leveling-band and boss-TTK bands may need
  re-centering after the gold-tempo pass — each band move gets its own
  justification, never a silent widen.

### Phase B — glyphs core (MUST)

- **new `src/sim/glyphs.ts`** — `GlyphId`, `GLYPH_INFO` (name/blurb/tags/
  family/numbers), `glyphsFor(p, ability)` resolver (slot lookup + tag/
  dormancy check), pure param helpers.
- **`src/sim/types.ts`** — `Player.glyphs?: { slots: (GlyphId|null)[][],
  ultimate: (GlyphId|null)[], bench: GlyphId[] }` (optional, default-init);
  `LootKind` += `"glyph"`; `Loot.glyph?`; `RewardKind` += `"glyph"`.
- **`src/sim/abilities.ts`** — archetype tag table beside ABILITY_INFO; param
  functions (bolt/nova/melee/dash/ult) fold glyph numbers exactly like ranks.
- **`src/sim/game.ts`** — `socketGlyph`/`unsocketGlyph` (safe-room gated, field
  auto-fill exception); hooks: `damageMonster` opts (brand/DoT riders/culling),
  `castAbility` pre/post (blood price, static counter — counter lives in
  `Player.glyphs` state? No: transient counters go on Player as optional
  numeric fields, same as `meleeComboT`), `strikes` for Reprise echoes,
  `updateProjectiles` for Arc-Splice/Splitfang (reuse pierce/ricochet
  plumbing + `hitIds`).
- **`src/sim/snapshot.ts`** — `PLAYER_COLD_FIELDS` += `"glyphs"` (changes only
  on explicit actions — belongs in the cold block).
- **`src/sim/bot.ts`** — socket-first-compatible-glyph policy in shop().
- **Save** — `SavedProgress.player.glyphs?` + default; `applySavedPlayer` line.
- **Hosts (`main3d.ts`)** — enumerated; UI only, zone map respected:
  - Loadout panel (`#abil`, z 20): socket pips under each of the 4 slots
    (2 each) + 1 under the ultimate; locked pips show their unlock level
    (4 / 11); click-to-socket from the bench; DORMANT glyphs render greyed
    with a tag-mismatch tooltip; socket/unsocket disabled outside safe rooms
    (with reason), field auto-fill surfacing as a `#toasts` line.
  - Glyph bench: a row inside the same `#abil` panel listing unsocketed
    glyphs (name, tags, family).
  - Safe-room modal (`#saferoom`): Glyph Cache shelf row (seeded roll, price
    preview); sponsor-draft card renders `RewardKind: "glyph"`.
  - Cursor tooltip (`#itemtip`): glyph card — name, tags, family, numbers.
- **Tests** — new `glyphs.test.ts`: dormancy, family exclusion, determinism
  across socket order, ricochet+chain addition rule, **rule 7 CDR clamp at
  40% (Hair Trigger + constellation CDR) and rule 8 per-cast refund cap
  (Executioner's Rebate multi-kill in one pack)**, save round-trip, net
  cold-block round-trip. Launch = the 10 Phase-B rows of the §3.3 table:
  Arc-Splice, Splitfang, Reprise, Brandmark, Accelerant, Arcane Lens,
  Executioner's Rebate, Heavyweight Plate, Hair Trigger, Slipstream.

### Phase C — SHOULD

- The 15 Phase-C rows of the §3.3 table (includes both ultimate glyphs and
  the Demolition Rider combo).
- Component micro-passives + T2 passive pass on existing advanced items.
- Smart-loot school bias; behind-the-curve component share.
- Gold tempo re-centering sweep (bot metrics harness, BALANCE-NOTES round 2).
- Tone re-grounds: interference demotion, sponsor-challenge reframe, VOICE
  pass on new names; ABILITY-CONCEPTS.md edits (cut Audience Participation +
  Golden Handshake as specced, keep OVERTIME).
- `sheet.ts` — glyph lines + quality in the Crawler Profile.

### LATER

- Quality inheritance through combines; glyph rerolls/corruption; floor-18
  trophy unique; rivals-exclusive glyphs; NG+ chase tiers; telemetry columns
  for glyph popularity (BALANCE-NOTES round 3 instrument).

---

## Open design questions (for the owner)

1. **Sockets-on-slots vs sockets-on-abilities — DECIDED: slots (pending owner
   veto, deadline: before the Phase B branch cut).** Slots make re-slotting
   interact with glyphs ("my projectile slot") and keep the data flat;
   abilities-own-sockets is more intuitive but doubles the bookkeeping.
   Phase B's `Player.glyphs` shape, the save field, and the cold-block entry
   all encode this choice — a veto after Phase B starts reworks all three, so
   silence by branch cut means slots ship.
2. **Boss-unique drop rate** — 35% seeded feels right for an 18-floor run with
   5 chances, but rivals mode makes them contested; guarantee-on-first-kill in
   rivals?
3. **Commodity gear at 25%** — keep freeform drops at all, or go full catalog
   (100% identity) and let shards come from selling catalog dupes?
4. **Glyph shelf pricing** — 90g +8/floor competes with components on exactly
   the floors the build is clicking; too tight? Could price the CACHE cheap and
   the certainty (pick-your-glyph, late shops) expensive.
5. **Same-shop 100% refund** — worth the SafeRoom field, or does 60% sting
   acceptably given prices are small? (Exploit surface is settled either way:
   the §4 eviction rule — modified/consumed items leave `boughtThisShop` —
   ships with the feature if we keep it.)
