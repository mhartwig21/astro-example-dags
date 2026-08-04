# ABILITIES V2 — kit clarity, ultimates that earn the slot, and the modifier layer landing

Design doc (2026-08-01, `abilities-v2` branch). Written against the SHIPPED
code — `src/sim/abilities.ts`, `glyphs.ts`, `config.ts`, `game.ts`'s
`castAbility`, `ai.ts`, `bot.ts` — not against ABILITY-CONCEPTS.md's wishlist.
Everything in §1 is measured; the probes are described below so the numbers can
be re-run when the roster moves.

Pillars this serves (unchanged):

1. **Fast-round character building** — decisions arrive quickly and matter; a
   build's identity is legible by floor 3–4 and keeps evolving.
2. **Abilities = LoL kit clarity × Diablo power fantasy × PoE2 modifier depth.**
   Every kit describable in one breath, even fully modified.
3. **Dungeon crawler first** — the Show narrates, prices and rewards the crawl;
   it never becomes a mid-combat input. (Audience Participation and Golden
   Handshake were cut for violating this. That line holds here: nothing below
   asks the player to interact with hype, gold or the crowd mid-fight.)

This composes ON TOP of what already shipped and does not re-litigate it:
ITEMIZATION-V2's one-catalog item system, the glyph layer (sockets on the SLOT,
tags + channels + dormancy, the one 40% CDR clamp, the per-cast refund budget),
The Five, the bench, and safe-room re-slotting. Ranks are DRAFTED, glyphs are
LOOTED — that split is load-bearing everywhere below.

### How §1 was measured (re-runnable) — and how much each probe is worth

- **Param probe** — `createTestGame({seed, floor, level, abilities:"all"})` at
  floors 4/8/12, reading every `*Params()` function to get per-hit damage,
  effective cooldown and single-target DPS for the whole roster on one crawler.
  *Confidence: high.* Arithmetic over shipped code, not a sample.
- **Density probe** — sampling twice a second through bot-played floors: how
  many living monsters are actually inside Nova's radius when you could cast.
  *Confidence: high.* Thousands of samples per floor, and the effect (median 0)
  is not marginal.

- **Kit probe** — `scripts/kit-sweep.ts`: the balance bot under §6.2's POLICY
  (one case per `role`, not a greedy presser), **30 fixed seeds**, floor 8 /
  level 13, one floor per run, reporting mean and the 10th/90th percentile per
  column. Swapping only the 4th slot, then only the ultimate, then ablating
  Collapse's gather. *Confidence: medium-high on the damage-taken column (a
  1.5–2x effect at n=30), medium on clear rate (30 Bernoulli trials still put
  ±1 seed of noise on every row).* **This replaced the n=8 greedy probe the
  first draft shipped** — see the box, which is now closed.

> **The n=8 problem, stated plainly.** §1.0c and §1.0d are eight seeds, no
> repeats, no interval. At n=8 a 7/8-vs-6/8 clear-rate gap is *one seed* and
> carries almost no information; 8/8-vs-6/8 is two. Worse, the instrument that
> produced them is the instrument §1.0e argues is incompetent — a greedy presser
> with no policy, firing Nova into a median of zero targets. **We cannot use a
> bot's verdict to condemn Nova and in the same breath argue that the same bot is
> too dumb to measure the roster.** Both cannot be true, and only the second has
> code evidence behind it. Nova's measured trap is *partly* the greedy policy
> wasting the cast — which is exactly what §6.2.3 ("never cast Collapse at fewer
> than 2 nearby monsters") concedes.
>
> So this document splits its claims by what actually backs them:
>
> | claim | backed by | status |
> |---|---|---|
> | Nova's N is ~0 in real rooms | density probe (large n) + the spacing contract | **solid** |
> | ultimates print less than 2 melee swings | param probe (arithmetic) | **solid** |
> | decoys are invulnerable; AWARD SEASON always fires | reading `Decoy` in game.ts | **solid** |
> | Shockstep is `sp`-scaled on a melee tool | reading `SCALING` | **solid** |
> | orbit out-damages every ability that costs a press | param probe | **solid** |
> | 36/54 nodes never drafted; loadout identical 20/20 | registry + fixture trace | **solid** |

> | "an empty 4th slot beats Nova" | kit probe, n=8 | **RETIRED — false at n=30** |
> | "Bullet Time is the only ultimate that wins" | kit probe, n=8 | **RETIRED — false at n=30** |
>
> What that licenses: **R1 (Collapse), R2 (dash school), R3 (orbit), R5's
> interrupt promotion and R8 (mortal doubles) rest on solid rows only** — they fix
> things readable in the source or measured with large n. **The magnitudes** (how
> much orbit loses, how much Blindside gains, whether Cataclysm needed a whole new
> beat) rest on provisional rows and are *not* defended here.
>

> **The gate:** §1.0c/d get re-run at **n ≥ 30 seeds**, reporting mean and the
> 10th/90th percentile per column, **after §6.2's policy bot lands**, and the
> tables below get replaced by those results. No §6.3 contract change is argued
> from the n=8 tables. That re-baseline is §7's **slice 1** and it ships **before
> any ability change**, so every later slice has a real baseline to be measured
> against. Two outcomes are pre-committed: if the 4th-slot column separates by
> less than its own 10–90 spread, "the 4th slot is not a decision" is confirmed
> for a better reason than we have today; and if Nova stops being a trap once a
> competent policy stops wasting it, **R1 shrinks from a rework to a base-gather
> change and this document will say so in writing.**
>
> ---
>
> **THE GATE, SETTLED.** `scripts/kit-sweep.ts` ships and §1.0c/d below are its
> n=30 output. Two things have to be said plainly before the pre-registered
> outcomes are called, because both are failures of process this document owes
> the reader:
>
> 1. **The re-run did not ship before the ability changes.** It was supposed to
>    be slice 1. It landed after R1–R8, which is exactly the order the box
>    warned against, and it means these numbers measure the NEW roster rather
>    than establishing a baseline the new roster was then judged against.
> 2. **Because R1 already landed, the pre-registered Nova branch could not be
>    tested by simply re-running the build** — the shipped Nova is gone from the
>    code. So it was tested by ABLATION instead (§1.0c-ablation): §3.1 states
>    R1's buff over shipped Nova is "entirely in N, not in per-target damage",
>    so Collapse with `novaGatherMult = 0` is behaviourally the old Nova, and
>    the sweep runs it as a third column on the same 30 seeds.
>
> **Outcome 1 — "the 4th slot is not a decision": CONFIRMED, and sharpened.**
> Every clear-rate column sits inside ±3 seeds of every other and every
> damage-taken band overlaps every other band, so nothing here separates on
> clears. But the damage-taken MEANS do separate, by up to 1.9x (Collapse 215,
> Blindside 410), and they separate along the axis §1.0c's n=8 table already
> pointed at. The honest statement is narrower than either draft: *the 4th slot
> does not change whether you clear the floor; it changes what the floor costs.*
>
> **Outcome 2 — "R1 shrinks to a base-gather change": REJECTED, on the
> ablation.** With a competent policy and no gather, Collapse is 24/30 clears
> and **441 damage taken — worse than carrying no 4th slot at all (22/30, 382)**.
> Turn the gather on and the same seeds read 28/30 and **215**. The gather is
> doing the work, not the policy; R1 keeps its magnitude, and it is the only
> claim in this document that has been tested against its own null hypothesis.

---

## 1. HONEST ROSTER AUDIT

### 1.0 The five measurements that drive this whole document

**(a) Single-target DPS is a landslide, and the ranking is nothing like the
fiction.** Same crawler, floor 12, level 18, all abilities known:

| ability | per-hit | cooldown | single-target DPS |
|---|---|---|---|
| melee | 121 | 0.35 | **346** |
| orbit (passive!) | 93 x 2 blades | 0.40 tick | **233** |
| bolt | 54 | 0.51 | 106 |
| overcharge (banked swing) | 181 | 8.0 | 23 |
| nova | 92 | 4.0 | 23 |
| Blindside | 112 | 6.0 | 19 |
| dash (Shockstep) | 30 | 2.2 | 14 |
| Cataclysm **(ULTIMATE)** | 180 | 35 | 5 |
| Stunt Double (mirror) | 28 | 18 | 2 |
| Extradition | 0 without Gavel Drop | 7 | 0 |
| Sponsor Airstrike **(ULT)** | 232/shell x 6 | 45 | 31 |

The floor-8 shape is identical (melee 167, orbit 150, bolt 71, everything else
≤ 20). **An ultimate that hits for 1.5 melee swings is not an ultimate.**

**(b) AoE is priced for a crowd that is never there.** Sampling live bot play:

| floor | mean monsters inside Nova's radius | median | ≥3 targets | ≥5 targets |
|---|---|---|---|---|
| 4 | 0.66 | **0** | 8% of samples | 4% |
| 8 | 0.98 | **0** | 13% | 7% |
| 12 | 0.62 | **0** | 2% | 0% |

Nova's whole case is "it multiplies by N." N's median is zero. And this is not
a bug to tune away — the balance contract *deliberately* spreads packs (HEAVY
PACKS run spread: median nearest-same-kind spacing > 1.4 tiles; trash < 1.2).
The dungeon's spacing design and the AoE ability's premise are fighting each
other, and spacing wins. The answer is not a bigger radius. **The answer is a
GATHER verb**, which the game already half-owns (IMPLOSION, CLASS ACTION) and
buries behind capstones.


**(c) The 4th slot does not decide whether you clear — it decides what the
clear costs.** `scripts/kit-sweep.ts`, **n=30**, the §6.2 POLICY bot (not a
greedy presser), floor 8 / level 13, one floor per run, only the 4th slot
changed. Mean, with the 10th–90th percentile band beside it:

| 4th slot | cleared | died | clear s | dmg taken | kills |
|---|---|---|---|---|---|
| *(empty)* | 22/30 | 8 | 37 [25–47] | 382 [0–897] | 47 [13–83] |
| **Collapse** | **28/30** | 2 | 36 [19–50] | **215 [0–499]** | 55 [30–79] |
| orbit | 23/30 | 7 | 37 [21–50] | 358 [0–918] | 49 [15–70] |
| stance | 25/30 | 5 | 43 [25–58] | 393 [28–890] | 55 [17–79] |
| Breaker | 25/30 | 5 | 38 [23–58] | 312 [0–795] | 50 [18–83] |
| Blindside | 25/30 | 5 | 35 [22–50] | **410 [45–757]** | 53 [14–81] |
| Extradition | 27/30 | 3 | 39 [25–53] | 333 [30–750] | 53 [14–84] |
| Stunt Double | 23/30 | 7 | 39 [24–53] | 357 [0–943] | 50 [26–73] |
| Bulwark | 24/30 | 6 | 37 [22–50] | 336 [23–875] | 49 [19–75] |
| Stage Cables | 27/30 | 3 | 43 [28–59] | 375 [0–1022] | 58 [36–80] |

**Read the bands, not the means.** Every damage-taken band overlaps every other
one — the p10 is zero for half the roster, because a floor-8 crawler who plays
it clean takes nothing. So no column here is separated by its own spread, and
the original headline stands: *the 4th slot is not what decides the floor.*
What DOES survive n=30 is the ordering of the means, which is stable and large:
Collapse costs **215** and Blindside costs **410** on the same 30 seeds and the
same fixture, a 1.9x gap on a 30-sample mean. The n=8 draft got the axis right
(the 4th slot moves damage taken, not clear time) and the direction wrong:
**Blindside is now the most expensive slot in the table, not the cheapest.**
That is R6 working as designed — Blindside became a burst tool that puts you
*inside* the pack (§6.4.7's window is the whole point) — but it is a cost the
first draft's table predicted the opposite of, and it should be watched.

An empty 4th slot is the WORST clear rate in the table (22/30) and the second
worst cost (382). "An empty slot beats Nova" is dead.

**(c-ablation) Is the gather the fix, or was the policy?** The pre-registered
branch, tested by removing R1's addition rather than by re-running the build
(see the box). `novaGatherMult = 0` is behaviourally the shipped Nova: the
blast without the drag. Same 30 seeds:

| 4th slot | cleared | died | clear s | dmg taken | kills |
|---|---|---|---|---|---|
| *(empty)* | 22/30 | 8 | 37 [25–47] | 382 [0–897] | 47 [13–83] |
| Collapse, gather ON | **28/30** | 2 | 36 [19–50] | **215 [0–499]** | 55 [30–79] |
| Collapse, gather OFF (= shipped Nova) | 24/30 | 6 | 41 [25–73] | **441 [28–1221]** | 54 [27–81] |

A competent policy is **not** enough. Gather-less Collapse under the policy bot
still costs more than carrying nothing at all (441 vs 382) and clears barely
better (24/30 vs 22/30) — it makes the crawler stand and fight a spread pack
for a blast that catches one body, which is precisely §1.0b's finding. Adding
the drag halves the cost and adds six clears. **R1 keeps its magnitude.**

**(d) The ultimates are four beats now, and none of them is "the one that
wins".** Same fixture and seeds, 4th slot held at Collapse, only the ultimate
changed:

| ultimate | cleared | died | clear s | dmg taken | kills |
|---|---|---|---|---|---|
| *(none)* | 28/30 | 2 | 36 [19–50] | 215 [0–499] | 55 [30–79] |
| Sponsor Barrage | 27/30 | 3 | **33 [25–45]** | 234 [0–645] | 58 [38–79] |
| Fault Line | **29/30** | 1 | 36 [19–47] | 219 [0–481] | 58 [36–80] |
| Bullet Time | 27/30 | 3 | 34 [21–44] | 286 [0–764] | 55 [31–80] |
| Injunction | 25/30 | 5 | 35 [21–51] | 314 [0–846] | 53 [23–79] |

**The n=8 headline is retired.** "Bullet Time is the only ultimate that wins"
and "the rules-changing ultimate halves incoming damage" were a 1421-vs-2715
gap at n=8; at n=30 under the policy bot Bullet Time is the *third* cheapest
column and Fault Line has the best clear rate. The four ultimates land within
28–34% of each other on cost and within 4 seeds on clears — which is what §3.3
was aiming at (four distinct beats, none dominant) and is a much less exciting
result than the one this document originally led with.

Two things in the table are worth keeping:

- **Every ultimate costs more than no ultimate** (215 → 219–314) while killing
  as much or more. That is the shape of a button that makes you commit: you
  stop retreating and start fighting. Injunction is the extreme (314, 25/30) —
  it is *supposed* to be, it enrages the floor by design (§3.2 N3), and it is
  the only ultimate whose column is worse than the baseline on both axes. It
  earns its slot on the clock, not on the fight, and §6.4.4 pins that.
- **Sponsor Barrage is now the fastest clear in the table** (33s) and no longer
  the most expensive ultimate. §1.0d's original finding — the biggest printed
  number was the worst ultimate, 3466 damage taken — does not reproduce for
  U2's rebuilt version. The 3s channel is measured directly in §6.4.9, not
  inferred from this column.

**(e) The bot does not press its own buttons — so the balance contract has
never measured the roster.** `bot.ts` emits `attack`/`bolt`/`dash` and a greedy
ultimate; slots 0–3 beyond melee/dash/bolt are never cast. Baseline vs greedy,
same seeds and fixture: **52s → 31s per floor, 3 deaths → 2**. Worse, test mode
learns `DISCOVERABLE_ABILITIES` in declaration order, so `abilities=all` always
slots the same kit — across 20 seeds the loadout was `[melee, dash, bolt, nova]`
+ airstrike **20/20 times**, and **36 of 54 constellation nodes were never
drafted once in 40 seeded crawlers** (every stance / overcharge / orbit /
Blindside / Extradition / Stunt Double / Cataclysm / Bullet Time node reads 0%).
Two thirds of the constellation is untested by every balance test we have.

### 1.1 Ability by ability

Format: *fantasy delivered — when it's picked — when it's a trap — is its
constellation a choice or filler.*

**Melee** — the swing, and the whole game's damage floor (346 DPS at floor 12).
Picked always. Trap: never, which is itself the problem (a slot nobody can
evaluate). Constellation is the roster's **best**: Wide Arc is filler (a number
on a number), but Heavy vs Swift is a genuine identity fork (overkill splash vs
momentum stacks) and EXECUTIONER is a real capstone. *Verdict: 1 filler node.*

**Dash** — the i-frame blink on two charges; the reason the telegraph system is
fun. Picked always. Trap: never. Constellation is **half filler**: Quickstep
(−18% cd) vs Long Blink (+30% distance) is number-vs-number with no identity on
either side, and its damage node (Shockstep) is `sp`-scaled while dash is a
melee build's escape tool — so a physical crawler's dash detonation does 30
damage at floor 12 (6 hits to kill a grunt). AFTERSHOCK is a fine capstone
attached to a limp number. *Verdict: false fork + a mis-schooled damage node.*

**Bolt** — "what your weapon throws," and the school routing through
`boltParams` is the single most elegant thing in the file. Picked always.
Trap: never, but it is a **stat readout, not a build** — the weapon decides its
damage, school and speed; the tree only tunes cadence. Rapid Bolts is a
mandatory gate (98% of drafted crawlers hold it) that grants a pure number.
Split vs Pierce is a real choice, Frost Bolts is real behavior, RICOCHET is a
real capstone. *Verdict: one dead gate node, otherwise healthy.*

**Nova** — "radial shockwave." **The flattest ability in the game and a
measurable trap** (§1.0b/c): median 0 targets, 23 DPS, and running it is worse
than running nothing. It scales spell power while auto-equip hands the crawler
a 30–68% AP coin flip (§1.2), so half of all crawlers cast it at ~60% value
without ever being told. Constellation: Bigger Bang (radius %), Aftershock
(cd %), Concussive (damage %) — three numbers and a false fork; Afterburn is
real; IMPLOSION, the *gather*, is the only genuinely good idea in the ability
and it is gated behind the filler node as a capstone. *Verdict: rework the
ability around IMPLOSION.*

**Orbit** — auto-blades. 233 DPS at floor 12, best-in-class clear rate (8/8),
**for zero presses and zero attention.** Fantasy: fully delivered. Trap: never.
The problem is structural: a slot that costs no decisions out-damages every
slot that costs one, which inverts the whole "your build is your five choices"
premise. It also has no cooldown at all, so three glyphs read DORMANT on it by
rule 9 — the modifier layer can barely touch the roster's #2 damage source.
Constellation is good (Extra Blade is a real change; Razor vs Corkscrew is
grinder-vs-sweeper; GUILLOTINE executes). *Verdict: keep the tree, give the
ability a verb.*

**Battle Stance** — a toggle that multiplies. There is no verb here: you press
it, a number changes, nothing happens on screen. Picked when a build is
mono-type; a **trap in every mixed kit**, because +25% on half your damage and
−20% on the other half is roughly zero and the player is never shown that math.
PERFECT FORM deletes the tradeoff that is the ability's only tension.
Discipline vs Flow (plant vs dance) is the best *fork* in the roster attached
to the worst *ability*. *Verdict: keep the fork, give the ability an action.*

**Overcharge** — bank power, spend it on the next attack. Fantasy: the wind-up,
and it half-lands. Picked by burst builds. Trap: at 23 DPS it is a worse melee
button unless you are timing it into something. Surge/Volley/Echo are three
numbers keyed to which button you spend on. SYSTEM SHOCK is the *only*
on-demand poise-breaker the player owns — in a game whose entire threat model
is telegraphed windups, the interrupt is buried as one ability's capstone.
*Verdict: promote the interrupt; that is what this ability is for.*

**Blindside (`cutto`)** — teleport onto an enemy, already swinging. **This one
is good.** 8/8 clears at the lowest damage taken in the whole column (2207).
Picked by anyone who wants to reach the shaman / necromancer / hexer standing
behind the pack. Trap: only into a brute you can't leave. Constellation: Long
Reach is filler; Short Notice (cd %) vs Sucker Punch (damage + stagger) is a
**false fork** — behavior beats a number every time, Sucker Punch is strictly
the pick. REPEAT OFFENDER (kill inside 1s -> reset) is an excellent capstone.
*Verdict: fix one fork side, buff base damage — 1.2x melee on a 6s cooldown is
a mobility tax, not a strike.*

**Extradition (`crowdsurf`)** — one chain: light enemies come to you, heavy ones
pull you to them. **The best verb in the roster and it deals literally zero
damage** until you draft Gavel Drop. It is also the game's only real GATHER, and
gather is exactly what §1.0b says AoE is starving for — but it gathers ONE
target on a 7s cooldown unless you take CLASS ACTION. Picked for reach; a trap
into an elite pack (highest damage taken of the mobility options: 3319, because
it plants you in the middle). Grip vs Dive (control vs damage) is a genuine
fork. *Verdict: the roster's keystone; promote CLASS ACTION's spirit into the
base and give the base a hit.*

**Stunt Double** — a taunting decoy. Its damage numbers are noise (2 DPS), but
that is not what it does: **decoys have no HP.** `Decoy` is
`{pos, facing, t, absorbed}` — nothing can kill it. So Stunt Double is 5 seconds
of guaranteed aggro removal in a 5-tile radius, the strongest defensive button
in the game, wearing a damage ability's costume. And AWARD SEASON ("a double
that *survives* its contract refunds the cooldown") fires unconditionally,
because surviving is the only thing a double can do — **a flat −50% cooldown
drawn as a diamond.** Method vs Pyro is a fine axis expressed as two numbers.
*Verdict: fix the lie — give the double HP, and make the capstone a choice.*

**Sponsor Airstrike (ULT)** — the biggest printed number in the game (1395 at
floor 12) and the **worst measured ultimate** (6/8, most damage taken). It is a
delayed nova at a cursor: you press it, keep fighting, and shells land near
where things used to be. No beat, no commitment, no rule change. Saturation
(more shells, wider) vs Precision (tighter) is a **false fork** — the same axis
twice, and its two sides cancel rather than compete. SPONSOR LOYALTY is a good
capstone. *Verdict: not an ultimate. Rework the beat.*

**Cataclysm (ULT)** — a bigger Nova on a 35s cooldown, 5 DPS, one blast. It is
literally the duplicate of a slot ability. Its knockback actively fights its own
Aftermath echo (Upheaval hurls enemies out of the crater the echo lands in) —
**a fork whose two sides are anti-synergistic within the same ability.**
EXTINCTION EVENT (corpses detonate, chaining) is the only ultimate-scale idea in
it. *Verdict: rework into a distinct beat; keep EXTINCTION.*

**Bullet Time (ULT)** — the world slows, you don't. **The only ultimate that
earns the slot** and the measured winner on every axis (8/8 clears, half the
damage taken, most kills). It changes the rules for four seconds; every problem
on screen becomes solvable. Deep Focus (duration) is the right kind of number;
Adrenaline vs Dead Eye is two numbers but at least on different axes; EXTENSION
(kills extend it) is the correct capstone shape. *Verdict: the template. Barely
touch it.*

### 1.2 Two systemic findings that are not any one ability's fault

**Your damage school is a drop lottery, not a choice.** Across 16 seeded floor-8
crawlers, the AP share of total power ranged **30% to 68%** (39, 63, 68, 41, 59,
54, 62, 66, 63, 61, 65, 53, 39, 34, 30, 58). Nova, Cataclysm and Shockstep are
`sp`-scaled; melee, orbit, Blindside, Extradition, Stunt Double and Airstrike
are `ap`-scaled. Nobody chooses this — the auto-equip does. A crawler cannot
commit to "I am a caster," which is a direct hit on pillar 1.

**§5 does NOT fix this, and the first draft of this document said it did.** The
claimed fix was "the lens family gains the `aoe` tag." Check it against the
source: `power()` short-circuits to `effectiveSpellPower(p)` the moment
`arcane_lens` is socketed, and `SCALING` already reads `nova: {sp:1}` and
`cataclysm: {sp:1}` — so **Arcane Lens on Collapse or Fault Line is a literal
no-op.** The only lens that converts an AoE *for the crawler who needs it* (the
physical one who rolled 30% AP share and wants his `sp` abilities to work) is
**Ballistic Lens**, which the first draft parked under SHOULD in §7. So: §5.1
**mitigates** §1.2 with a socket tax, and a socket spent on conversion is a socket
not spent on identity. §5.5 specs the actual fix — a school commitment — and says
plainly what it costs to schedule.

**Six abilities never appear in any balance measurement.** See §1.0e. Any claim
that stance, overcharge, orbit, Blindside, Extradition, Stunt Double, Cataclysm
or Bullet Time is "balanced" today is unfalsifiable. §6/§7 make this a contract
instead of a hope.

---

## 2. THE KIT MODEL

### 2.1 What makes a kit read (the LoL half)

Three properties, all three required. An ability that misses one goes back in
the oven.

1. **A defining verb.** One transitive verb, imperative, that a player would use
   unprompted: *swing, blink, shoot, implode, chain, brace, pin, hurl, bank,
   cut.* "Toggle a multiplier" is not a verb — that is why Battle Stance reads
   as a menu. If you cannot finish "press it to ___" with a single verb and an
   object, it is a passive with a keybind.
2. **A cost/cooldown rhythm in one of three bands.** These are the game's
   existing tempos and every ability must sit clearly in one:
   - **BEAT** (0.3–0.8s): melee, bolt, orbit ticks. Spam is the texture.
   - **PHRASE** (4–9s): nova, Blindside, Extradition, overcharge. One per
     engagement; casting it is a *sentence* in the fight.
   - **ACT** (18–70s): Stunt Double and the ultimates. Once per room. Pressing
     it should change what the room is.
   Abilities that drift between bands (Cataclysm at ACT cost with PHRASE
   impact) read as broken even when the DPS is fine.
3. **A counterplay window** — something the monster, the room, or the player's
   own body can do about it. Dash has i-frames you can waste; Blindside puts you
   where you cast it; Overcharge is a bank you can lose. Nova's counterplay
   window is currently "the enemies walk away," which is not a window, it is a
   whiff. Ultimates need the *biggest* windows: Bullet Time ends, a fissure can
   be walked around, a channel can be interrupted.

**The one-breath test.** Every kit must survive being read aloud with all its
modifiers: *"Frost bolt sniper, splitfang and a chain glyph, saving for Court
Order."* If the sentence needs a second breath, the ability has too many
independent riders and the constellation is doing the glyph layer's job.

### 2.2 Archetype coverage the roster must span

Seven archetypes. The roster should cover all seven with **no more than two
abilities per archetype at the same tier**, or slot choice degenerates.

| archetype | today | verdict |
|---|---|---|
| single-target burst | overcharge (23 DPS), Blindside (19) | **thin** — both under-tuned; melee out-damages both |
| wave clear | nova (broken), orbit (passive) | **broken** — see §1.0b |
| control (hard CC / interrupt) | SYSTEM SHOCK (a capstone), Extradition's 0.5s stagger | **HOLE** — no on-demand interrupt or root, in a game built entirely on windups |
| mobility | dash, Blindside, Extradition | **oversupplied and correct** — the owner's stated taste; keep all three, differentiate them |
| sustain / defense | nothing (the flask is an item) | **HOLE** — Stunt Double accidentally fills it (§1.1) |
| summon | Stunt Double | **thin, and it's a lie** (invulnerable decoy) |
| zone denial | nothing | **HOLE** — monsters own puddles, sludge, consecrated ground, roots and shard fields; the player owns none of it |
| *(gather)* | IMPLOSION, CLASS ACTION — both capstones | **the hidden hole**: it is what makes wave clear work at all |

**Duplicates to resolve:** Nova and Cataclysm are the same ability at two
cooldowns. Shockstep and Nova are both "radial damage centered on me." Airstrike
and Cataclysm are both "large delayed blast." Three of thirteen entries are the
same idea.

**Coverage plan (§3) — including the archetype an earlier pass quietly emptied.**
That pass filled control, sustain, zone denial, wave clear and summon, and then
re-roled Overcharge to *control* (R5) and tagged Blindside as *mobility* (R6) —
which left the roster with **zero single-target burst** while the row above says
burst was already the thin one. That is a coverage hole, not a taste call. The
plan now, one line per archetype:

| archetype | who owns it after §3 | the change |
|---|---|---|
| single-target burst | **Blindside** (opener), melee's EXECUTIONER line (closer) | R6 gives Blindside a real burst identity — the arrival strike CRITS an unaware target, so the window is ~3.8x a melee swing — and §6.4.7 measures it against a *stationary boss*, not against sustained DPS |
| wave clear | Collapse (gather-then-blast), orbit's hurl | R1, R3 |
| control | Breaker (stagger/interrupt), Stage Cables (pin) — **two, and only two** | R5, N2 |
| mobility | dash, Blindside, Extradition | unchanged; the owner's stated taste |
| sustain / defense | Bulwark | N1 |
| summon | Stunt Double (mortal) | R8 |
| zone denial | Fault Line's fissure, Cables' slow field | U1, N2 |
| gather | Collapse (radial, on you), Extradition (linear, chosen target) — **two, and only two** | R1, R7 |

**The two-owner cap, enforced instead of stated.** The rule above is "no more
than two abilities per archetype at the same tier." An earlier pass broke it
twice — four gathers (Collapse's base, Extradition's base, `orbit.magnet`, and
Cables read as a pull) and four controls. Both are now pinned **by definition**,
so the cap is checkable rather than rhetorical:

- **GATHER** means *bodies end up next to the player.* Collapse and Extradition
  own it. `orbit.magnet` (Return Policy) is **CUT** (§4.3) — orbit gets its verb
  from the hurl and does not need to be the third setup tool. **Cables do not
  pull:** a pinned enemy stays exactly where it was pinned, and `cab.snap` moves
  a body toward *the line*, never toward the player.
- **HARD CONTROL** means *an enemy cannot act, or cannot move, on demand.*
  Breaker (stagger/interrupt) and Stage Cables (pin) own it. Collapse carries the
  `control` **tag** for glyph routing only — its **role** stays `clear`, and a
  drag is not a stun. Fault Line's 30% slow is a `zone` effect.

Both caps are machine-checked in §6.4.8: at most two abilities carry
`role: "control"`, at most two expose the gather capability.

### 2.3 The one-breath test, applied to all sixteen kits

§2.1 sets this test and the first draft applied it only to the four abilities
that passed, which is not what a test is for. Here is every kit, fully modified —
base, plus its heaviest legal node load, plus the glyphs §5 expects it to want:

| kit | the fully-glyphed sentence | verdict |
|---|---|---|
| Melee | "Wide arc, heavy overkill splash, crits that bleed, and anything under a quarter dies." | one breath |
| Dash | "Three charges, a blind puff behind me, and everything I pass through eats the detonation." | one breath |
| Bolt | "Frost bolts that pierce, fired at a run, ricocheting off the first kill." | one breath |
| Collapse | "It yanks the room onto my feet, they land staggered, and every burn pops at once." | one breath |
| Orbit | "The blades grind what's close, and I can throw the ring through a line and back." | one breath |
| Battle Stance | "I settle into Brawler, and every change of footing buys a free heavy swing." | one breath |
| Breaker | "Bank a hit, shatter the brute's windup, and everything near it opens up." | one breath |
| Blindside | "I'm behind their caster, already critting, and a kill resets it." | one breath |
| Extradition | "One chain: the light three come here, the big one takes me there, and it hits now." | one breath |
| Stunt Double | "My double eats the pack, mirrors my abilities, and I can trade places with it before it goes up." | one breath **after a cut** |
| Bulwark | "I take the hit on purpose, and the next swing carries what it absorbed." | one breath |
| Stage Cables | "Nothing crosses this line, and the line stays live where they die." | one breath |
| Bullet Time | "The world stops, my dashes are free, and kills keep it going." | one breath |
| Fault Line | "I break the floor, the floor keeps working, and the hurl lands them back in it." | one breath |
| Sponsor Barrage | "I stop fighting and walk shells across the necromancer's corner." | one breath |
| Injunction | "I buy twelve violent seconds and the dungeon takes eight of them back." | one breath |

**Two kits failed on the first pass, and both were cut down rather than talked
around** — which is the only reason to run this exercise at all:

- **Stunt Double** carried *five* independent riders: a mortal body, a taunt
  aura, ability mirroring (`double.method`), a 15% damage redirect from the owner
  (`double.stand`), a farewell blast scaling on absorbed damage (`double.pyro`),
  plus a conditional refund and a chill from Understudy's Rider. **`double.stand`
  Body Double is CUT** (§4.3): it was a fourth defensive mechanic on an ability
  that already had three, and it duplicated what a taunting decoy does by
  existing. What replaces it is a *verb* (`double.cue` — swap places), not a
  fourth rider.
- **Bulwark** reads as four riders on paper (brace, heal, knockback, banked
  damage). It survives because its heal and its banked payoff sit on **opposite
  sides of an exclusive fork** — Rally and Grit — so no reachable build holds
  both, and the sentence stays one breath in every configuration a player can
  actually assemble. Fork exclusivity is a legitimate answer to this test;
  "you probably won't take all of them" is not.

---

## 3. NEW + REWORKED ABILITIES

Order matters: **eight reworks before three additions.** Every addition names the
§2.2 hole it fills. Every spec gives name / verb / school / band + cooldown /
scaling / tags / the one sentence a player would say.

### 3.1 Reworks

#### R1. Nova -> **COLLAPSE** (id stays `nova`)
- **Verb:** implode. **School:** magic (lens-convertible, §5). **Band:** PHRASE,
  cooldown 6.0s (up from 5.0).
- **What changes:** IMPLOSION stops being a capstone and becomes the *base*. The
  cast drags every non-boss body within `novaRadius x 1.6` inward to a ring at
  1.2 tiles, *then* detonates at `novaRadius`. Elites and bosses are dragged at
  40% distance (they resist, they don't ignore). Per-target damage unchanged at
  `novaDamageMult` 1.2 — the buff is entirely in N.
- **Scaling:** `sp: 1` (unchanged). **Tags:** `aoe`, plus new `control`.
- **Contract:** §6.4 pins mean gathered targets ≥ 2.5 at floors 4/8/12 (today
  0.62–0.98). If the rework misses that bar, it did not ship.
- **One sentence:** *"Collapse yanks the room onto your feet and detonates it."*
- **Why:** fixes the measured trap with the game's own idea, fills the *gather*
  hole, and turns the flattest ability into the setup half of every combo in §5.

#### R2. Dash — fix the school and the false fork
- Shockstep's arrival damage becomes **hybrid** (`ap: 0.5, sp: 0.5`) instead of
  pure `sp`, so a physical crawler's detonation is not a rounding error (30
  damage at floor 12 today). Fork rework in §4.
- **One sentence unchanged:** *"Blink through it."*

#### R3. Orbit — the blades get a verb (id stays `orbit`)
- **Verb:** hurl. **Band:** the aura stays a BEAT (0.4s ticks); the new press is
  a PHRASE, cooldown 7.0s.
- **What changes:** ambient grind drops to **0.44x** current (`orbitDamageMult`
  0.5 -> **0.22**), and pressing the slot **HURLS the ring**: blades fly out to
  5.5 tiles and return along the same line, hitting everything both ways at
  **2.6x a grind tick per pass**. No aura until they return (~1.1s) — that is the
  counterplay window: you spent your bodyguard.
- **Why 0.22 and not the 0.36 this document first proposed.** 0.36 does not
  achieve the stated goal, and the arithmetic says so out loud: 233 DPS x 0.72 =
  **168 DPS** at floor 12. That is still the game's #2 damage source, still 3–5x
  every ability §3 just reworked (post-rework Blindside ~38 sustained, Breaker
  ~21, Collapse ~58 against the 2.5-target contract), and still for **zero
  presses**. Claiming "the passive stops out-damaging abilities that cost
  attention" while shipping that number is a fix the doc's own numbers refuse to
  deliver. At **0.22** the ambient grind is **~103 DPS** — under 30% of melee —
  and the hurl (~7s cycle, two passes, both blades) carries roughly as much again.
  The ability's damage moves from the passive to the press, which was the point.
- **Pinned, not asserted:** §6.4.5 fails the build if ambient orbit exceeds **40%
  of melee's single-target DPS** at floors 4/8/12, and §6.4.6 fails it if melee +
  ambient orbit together exceed **55% of all damage dealt** in a bot floor. The
  honest alternative was to accept orbit as the auto-attack floor and say so; we
  are choosing the other one, so it is a test rather than a sentence.
- **Systemic win:** orbit finally exposes a `cooldown` channel, so Hair Trigger,
  Heavyweight Plate and Executioner's Rebate stop reading DORMANT on the
  roster's #2 damage source (glyphs.ts rule 9 excludes all three today).
- **Tags:** `melee`, plus `projectile` while hurled. **Scaling:** `ap: 1`.
- **One sentence:** *"The blades grind what's close and I can throw the ring."*

#### R4. Battle Stance — the swap IS an attack (id stays `stance`)
- **Verb:** swap. **Band:** PHRASE, `stanceSwapCooldown` stays 3s.
- **What changes:** swapping **fires a free strike in the new stance's shape** —
  Brawler: a full-power melee swing at 1.3x arc, no cooldown cost; Deadeye: a
  free bolt at 1.3x damage. Multipliers, PERFECT FORM and MOMENTUM stay exactly
  as shipped (the Signature Choreography legendary hook is untouched).
- **The strike is GATED ON THE SETTLE TIMER.** A swap only pays out if you were
  **settled** (`CONFIG.stanceSettleSeconds`, 6s) in the stance you are leaving.
  Without that gate, swapping on cooldown every 3s becomes the optimal line —
  which would make `stance.discipline` (which only pays *while settled*) and
  PERFECT FORM strictly worse to play. The base rework would then be attacking one
  side of the very fork this document calls the roster's best, which is the
  identical defect §4.2 indicts in `cata.aftermath` vs `cata.upheaval`
  ("anti-synergistic within the same ability"). Shipping it here while condemning
  it there is not an option.
- **What the fork becomes, precisely:** *Discipline is the ability that USES the
  strike; Flow is the ability that SPAMS it.* Discipline plants, banks its 6s and
  cashes a full-power swap-strike on top of the settled multiplier. **Flow
  ungates it** — with Flow drafted, every swap strikes regardless of settle, at
  **60% power**, which is what dancing should cost. MOMENTUM (already shipped: a
  swap primes a guaranteed crit) finally has a hit of its own to land on.
- **Why:** keeps the roster's best fork intact *on both sides*, stops the ability
  being a menu, and turns the 3s swap timer into a resource you can waste
  (counterplay).
- **One sentence:** *"Every time I change footing I get a free hit out of it."*

#### R5. Overcharge -> **BREAKER** (id stays `overcharge`)
- **Verb:** bank. **School:** follows the attack it is spent on. **Band:**
  PHRASE, cooldown 8s (unchanged, starts on cast).
- **What changes:** SYSTEM SHOCK's poise shatter moves to the **base** — a
  banked hit staggers any non-boss instantly and does 2x poise to bosses. Damage
  multiplier drops 1.5 -> **1.35** to pay for it. The capstone slot is freed for
  something that isn't a number (§4).
- **Why:** fills the *control* hole with an ability that already exists, and
  gives the telegraph system the answer it never shipped: an interrupt button.
  The single highest-value change here for moment-to-moment play.
- **One sentence:** *"Bank a hit, then cancel whatever that brute was doing."*

#### R6. Blindside — the roster's single-target BURST, not a mobility tax
- **Role: `burst`.** After §3 this is the only non-ultimate that answers "how do
  I kill the thing standing still." Tagging it `movement` for glyph routing does
  **not** re-role it — see §6.4's role rule (one role per ability, assigned here
  in the design, never inferred per test).
- Base `cutToDmgMult` 1.2 -> **1.9**, 6s cooldown unchanged. A multiplier bump was
  never going to be a burst identity on its own, so the base gains a real one:
  **the arrival strike CRITS automatically against a target that is not currently
  aggroed on you.** Behind the caster that is ~**3.8x a melee swing** in one
  frame; into the brute already chasing you it is 1.9x, and you took the trip for
  the reach — which is the honest trade and the ability's counterplay window.
- The `movement` tag ships too: it teleports, and Phase Etch / Slipstream should
  read it as movement. Today they don't.
- **Why burst is measured as a WINDOW, not as DPS.** 1.9x on a 6s cooldown is ~38
  sustained DPS against melee's 346, and that comparison is meaningless — burst is
  not a sustain role, which is exactly why §6.4.3's old melee-normalized band was
  the wrong ruler. §6.4.7 measures the thing that matters: largest damage
  delivered to a **stationary boss inside 1.0s**, with a floor of **3x a melee
  swing**, and Blindside is the ability that has to clear it.
- **One sentence:** *"I'm behind their caster and it's already a crit."*

#### R7. Extradition — the chain does something on its own
- Base gains a **hit**: arriving or landing deals `0.9 x power` in
  `surfDiveRadius` (Gavel Drop scales from 0.6/rank on top). A zero-damage base
  is why nobody drafts into it.
- **CLASS ACTION's spirit moves to the base at half strength:** the chain drags
  the *nearest two* light bodies it passes through, not just the anchor. The
  capstone then upgrades to everything (§4).
- **One sentence:** *"One chain: the little ones come here, the big ones take me
  there."*

#### R8. Stunt Double — give it HP so the ability is honest
- `Decoy` gains `hp`/`maxHp` = **35% of the owner's maxHp** (scaled by the
  owner's own stat, so it stays relevant). Damage routed to a decoy now kills it;
  `absorbed` keeps feeding the farewell blast.
- AWARD SEASON becomes a real choice (§4) — it currently fires unconditionally
  because a decoy cannot die.
- **Why:** turns the accidental best defensive button into a real one with a
  ceiling, and makes Method vs Pyro (survive longer vs die louder) mean
  something.
- **One sentence:** *"My double eats the pack for five seconds, then explodes."*

### 3.2 Additions (three, one per remaining hole)

#### N1. **BULWARK** (id `bulwark`) — the missing defensive window *(fills: sustain/defense)*
- **Verb:** brace. **School:** n/a (no damage). **Band:** PHRASE, cooldown 12s.
- **Effect:** 1.5s of **60% damage mitigation**; when it ends you heal **40% of
  what it absorbed** (capped at 25% maxHp). Movement unrestricted; **no
  i-frames** — that is dash's job and the two must never be interchangeable.
- **Tags:** `buff`. **Channels:** `cooldown` only (no damage to amplify).
- **Combo line:** walk *into* a brute's slam on purpose; brace -> Breaker the
  next windup. The first ability in the game that rewards standing still.
- **One sentence:** *"I take the hit on purpose and get paid for it."*
- **Why it isn't a gimmick:** it is the `shielded` elite affix flipped to the
  player (machinery already ships), and the roster's total lack of a defensive
  cooldown is why the flask carries the whole survival load.
- **Why it is no longer called CUT TO COMMERCIAL.** Two reasons, both cheap now
  and permanent later. **(1) Name collision.** Blindside's shipped id is `cutto`
  (`ABILITY_INFO.cutto`, nodes `cut.range` / `cut.smash` / `cut.match`,
  `cutToParams`, `CONFIG.cutToDmgMult`), and §7 rightly refuses to move ids
  because ids are save data. Shipping a `commercialParams()` next to a
  `cutToParams()` that means *Blindside* guarantees that every future reader gets
  it wrong exactly once, forever. **(2) Pillar 3.** The player's defensive
  cooldown cannot fictionally be an ad break they trigger mid-fight — that is the
  Show arriving as a combat input, which is precisely what Audience Participation
  was cut for. The crawler **braces**. The announcer may call it a commercial
  break; that is his job, not the player's verb (§4.5).

#### N2. **STAGE CABLES** — hard control *(fills: control, zone denial at active tier)*
- **Verb:** pin. **School:** physical. **Band:** PHRASE, cooldown 9s.
- **Effect:** throw cables along a 6-tile line; every non-boss crossed is
  **PINNED for 1.6s** (bosses 0.6s, no re-pin for 8s). Pinned enemies cannot
  move or close; they *can* finish a windup — the pin is control, not a stun
  (Breaker is the stun). The cables remain a 1-tile-wide **slow field (−35%) for
  4s** after the pin drops.
- **The cables never MOVE a body.** A pinned enemy stays exactly where it was
  pinned. That is what keeps Stage Cables out of the gather budget (§2.2's
  two-owner cap): it is control and denial, and Collapse and Extradition own
  gather. `cab.snap` (§4.3) moves a body toward *the line*, never toward the
  player, for the same reason.
- **Tags:** `aoe`, `control`. **Channels:** `damage` (0 base, but the field
  carries glyph riders), `cooldown`, `onhit`, `zone`.
- **Combo line:** cables -> Collapse (the gather cannot be walked out of);
  cables -> Fault Line; cables in a doorway is the first real *denial* play the
  player owns.
- **One sentence:** *"Nothing crosses this line for two seconds."*
- **Implementation note:** monsters have no root today. Add a distinct
  `Monster.pinnedT` respected in ai.ts's movement step only, so the poise/stagger
  system and the pin never overwrite each other.

#### N3. ULTIMATE — **INJUNCTION** *(fills: an ultimate about the RUN, not the room)*
- **Verb:** stay. **Band:** ACT, cooldown 70s — once or twice a run.
- **Effect:** the collapse timer **freezes for 12s**; you deal **+25% damage**
  while it holds; and **every monster on the floor is ENRAGED for the duration**
  (+30% move speed, windups 20% faster, they will not disengage). When the clock
  resumes it is **20 seconds shorter** than it would have been.
- **Do the arithmetic, because the first draft did not.** Not casting burns 12s of
  clock. Casting burns 0s and then pays a 20s debt: **net −8s of floor time**,
  bought with a violent window. The first draft priced the debt at **10s**, which
  made the button *net +2s of clock plus a free 12s of +25% damage* — strictly
  positive before any node. Then `inj.filibuster` shaved 4s/rank off the debt
  (net +10s) and DISMISSED WITH PREJUDICE cancelled it entirely (net +12s and a
  damage window, at no cost at all). That is not a gamble; that is a button that
  prints time. **The debt must exceed the freeze or the ability has no price.** It
  does now, at every rank: **the debt is always 5/3 of the freeze**, structurally,
  so no node can make the trade profitable. Nodes change what the window is *for*;
  they never change what it costs.
- **Counterplay, which §2.1's third property says ultimates need the biggest of:
  the enrage.** You froze the dungeon's clock; the dungeon fights back for exactly
  as long as you hold it. A crawler who presses this into a full room with no plan
  takes the worst twelve seconds of the floor **and still owes twenty**. It is
  visible, too — the enrage has its own tint and the System announces the terms.
- **Tags:** `buff`, `ultimate`. **Channels:** `cooldown`.
- **It is IN the ultimate contract now, not exempt from it.** The first draft
  failed §6.4.4's own test ("kill ≥3, remove ≥2s of enemy action, or change the
  room's traversal") on all three clauses and was quietly the one ultimate the
  test could not see. §6.4.4 gains a fourth clause — *changes the RATE at which
  the room acts* — because a rate change is exactly what this ultimate does, and
  Injunction carries two assertions of its own: **monsters act ≥25% faster inside
  the window** (the enrage is real) and **the net run-clock delta is negative at
  every rank** (the price is real). Fail either and it does not ship.
- **Roam / no-collapse contexts: the ability is NOT OFFERED.** The first draft's
  fallback was "+25% damage for 12s on a 45s cooldown so the slot is never dead" —
  which is *precisely* the numbers-not-rules ultimate §1.0d indicts, shipped
  inside the document that indicts it. An ultimate about the run clock does not
  belong in a mode with no run clock. `unknownAbilities` filters `injunction` out
  where the collapse timer is absent; the crawler gets one of the other three.
- **Why it earns the slot:** it is the only ability that touches the run's central
  resource, impossible in any other ARPG, and *dungeon-crawler-first* — the
  collapse timer is the dungeon's mechanic, not the Show's. The System's register
  writes itself ("The System has GRANTED a stay. Terms apply.").

### 3.3 The ultimates, reworked to four distinct beats

The rule: **an ultimate must change what the room IS for a while.** Four
ultimates, four different things changed — time, terrain, fire, the clock.

| ultimate | the beat it owns | cooldown |
|---|---|---|
| **Bullet Time** | TIME — the world's clock, not yours | 60s (unchanged) |
| **Fault Line** (was Cataclysm) | TERRAIN — the floor itself, for 10s | 40s |
| **Sponsor Barrage** (was Airstrike) | FIRE SUPPORT — you stop fighting and direct it | 45s |
| **Injunction** (new) | THE RUN CLOCK | 70s |

#### U1. **FAULT LINE** (id stays `cataclysm`)
- **Verb:** crack. **School:** magic. **Scaling:** `sp: 1`.
- **Effect:** the initial blast keeps `ultCataclysmDmgMult` and the hurl, then
  **the ground stays broken for 10s** — a `ultCataclysmRadius`-wide fissure field
  dealing 25% of the blast per second and slowing 30%. Enemies hurled out by the
  knockback have to walk back *through* it: knockback and zone now cooperate
  instead of fighting (today Upheaval throws targets clear of Aftermath's echo).
- EXTINCTION EVENT survives untouched as the capstone.
- **One sentence:** *"I break the floor and the floor keeps working."*

#### U2. **SPONSOR BARRAGE** (id stays `airstrike`)
- **Verb:** direct. **School:** physical. **Scaling:** `ap: 1`.
- **Effect:** instead of six shells scattered once, the barrage **walks with your
  cursor for 3.0s**, dropping a shell every 0.28s (~11 shells) at your aim point
  with `ultAirstrikeSpread x 0.5` scatter. You move at 70% speed and cannot
  attack while directing — that is the commitment and the counterplay window.

  Per-shell damage drops `ultAirstrikeDmgMult` 2.5 -> **1.9** (1.7 as first
  specced, corrected by §6.4.9(ii)'s measurement), so total output lands near
  today's when you aim well and far below it when you panic.
- **Why:** turns the worst-measured ultimate into a decision. The crawler who
  parks the barrage on the necromancer's corner wins; the crawler who presses it
  and keeps swinging (today's optimal play) now gets nothing.
- **The numbers it has to beat, because "lands near today's" is not a target.**
  Today's Airstrike is the worst-measured ultimate on *both* axes — 6/8 clears and
  **3466 damage taken, the highest in §1.0d**. Holding output flat while *adding*
  three seconds of not-fighting at 70% move speed, in a game whose entire threat
  model is telegraphed windups you dodge, is a plausible way to make the worst
  ultimate worse. So U2 ships against §6.4.9, two assertions: **(i)** damage taken
  during a Barrage cast ≤ damage taken over an equivalent 3s of normal play at the
  same floor; **(ii)** total barrage output ≥ **2.5x the best 3s of melee** at the
  same floor — it must beat what you gave up. If it cannot clear both, the channel
  drops to 2.0s, and if it still cannot, the commitment is cut and the ult goes
  back to an instant cast. A commitment that fails those is a tax, not a decision.
- **One sentence:** *"I stop fighting and walk artillery across the room."*

#### U3. **BULLET TIME** — unchanged. It is the standard the other three are held
to. Only its constellation moves (§4).

---

## 4. CONSTELLATION REBALANCE

### 4.1 The grammar every tree now obeys

Five nodes, fixed shape. This is a **rule, not a preamble** — §4.3 obeys it in
every tree and §4.2's reconciliation table closes against it line by line.

The first draft of this document called the grammar "the shipped grammar made
explicit and enforceable" and then shipped four ENTRY nodes that were exactly the
forbidden thing, marked "unchanged": `overcharge.surge` (+25%/rank damage),
`air.payload` (per-shell damage), `bt.focus` (duration) and `stance.edge` (+8%
matching damage) — three of which its own §4.2 had already listed as boring
numbers that should become behavior. A grammar broken in its own first
application is a preamble. **All five violations are fixed in §4.3 and there are
no grandfathered exceptions.**

- **ENTRY** — one node, always reachable, *behavior-flavored*: a number that
  changes what the ability TOUCHES (targets, reach, count, or which *categories*
  of thing it affects), never a number that changes what it PRINTS (damage %,
  cooldown %, duration).
- **FORK A ⊻ FORK B** — mutually exclusive, and **each side must change how you
  press the ability**. Two tests, both required:
  1. *If both sides could be written "+X%", the fork is dead.* (Shipped rule.)
  2. **If ONE side is a number and the other is a behavior, the fork is also
     dead.** The behavior wins unconditionally and the number side is a trap for
     anyone who hasn't played the ability yet. This is the corollary §4.2
     *discovered* in `cut.jump` vs `cut.smash` ("Sucker Punch wins
     unconditionally") and then failed to write down — so the same draft shipped
     `cab.taut` (+0.4s pin) against `cab.live` (a damage zone) and left
     `double.pyro` (+40% blast) opposite a `double.method` it had just upgraded
     to a behavior. It is written down now, and it is why `cab.taut`,
     `double.pyro` and `inj.filibuster` all changed below.

  One side moves *targeting/timing*, the other *payoff*.
- **RIDER** — one non-exclusive behavior rank beside the fork (Frost Bolts /
  Afterburn are the shipped model), so any build in that ability can take it.
- **CAPSTONE** — a build-defining behavior bit, never a number, `over: 0`. And a
  capstone **may not obsolete one side of its own fork**: the first draft's
  DISMISSED WITH PREJUDICE (cancel the debt) ate `inj.filibuster` (shrink the
  debt) whole, which is a fork side deleted by a node on the same tree. Both are
  gone.

Overrank headroom stays as shipped: 1 on cooldown nodes, 2 on other numeric
nodes, 0 on capstones and on riders that would break a cap.

**Acquisition verbs stay distinct:** ranks are DRAFTED (permanent,
within-ability, earned by leveling the kit you are actually running); glyphs are
LOOTED (portable, cross-ability, re-socketable in safe rooms). No node below
grants a glyph-shaped effect and no glyph in §5 grants a rank.

### 4.2 Verdicts on the shipped graph

**Ranks that are boring numbers and should become behavior** — **fourteen** of
fifty-four (the first draft said thirteen and then listed fourteen):
`melee.arc`, `bolt.rapid`, `nova.bang`, `nova.after`, `nova.conc`, `cut.range`,
`cut.jump`, `surf.chain`, `double.break`, `double.method`, `double.pyro`,
`air.payload`, `cata.epicenter`, `bt.focus`.

**Reconciliation — all fourteen, closed against §4.3.** The first draft left
three of its own list open, silently marked "unchanged" two paragraphs later
(`air.payload`, `bt.focus`, `double.pyro`). The checklist closes here or the
grammar is not a rule:

| node | was | becomes in §4.3 | closed |
|---|---|---|---|
| `melee.arc` | +arc % | +1 target cap per rank | yes |
| `bolt.rapid` | −15% cd | keeps the cd, and rank 3 removes the animation lock | yes |
| `nova.bang` | +radius % | +25% **gather** radius (the pull, not the blast) | yes |
| `nova.after` | −cd % | retired -> `nova.rift` (a 2s singularity) | yes |
| `nova.conc` | +damage % | retired -> `nova.crush` (dragged targets land staggered) | yes |
| `cut.range` | +range | range **and** can target a corpse or a party ping | yes |
| `cut.jump` | −cd % | retired -> `cut.encore` (a second charge) | yes |
| `surf.chain` | +range | range **and** +1 body dragged per rank | yes |
| `double.break` | +seconds | seconds **and** +20% double HP (HP now exists, R8) | yes |
| `double.method` | +taunt radius | the double mirrors your **abilities** | yes |
| `double.pyro` | +40% blast | **FIXED HERE:** the blast leaves burning ground for 3s, radius and burn scaled by `absorbed` | yes |
| `air.payload` | +per-shell damage | **FIXED HERE:** **+1 shell per rank** | yes |
| `cata.epicenter` | +radius | radius **and** +1.5s fissure duration | yes |
| `bt.focus` | +duration | **FIXED HERE:** rank 1 slows enemy projectiles already in flight; rank 2 slows hazard ticks and boss phase timers | yes |

And the fifteenth, which the first draft *created*: `overcharge.surge`
(+25%/rank damage) written as an ENTRY, which §4.1 forbids outright.
**FIXED HERE:** Surge now changes what the banked hit *touches* — +1 target on a
banked swing's hit list, +1 pierce on a banked bolt, per rank.

**Forks that are false choices (one side dominant, or the same axis twice):**
- `dash.quick` vs `dash.blink` — number vs number, no identity on either side.
- `nova.after` vs `nova.conc` — cd% vs damage%: the same axis, and it is the axis
  the `tempo` glyph family already exists to keep honest (rule 2 was written
  because that exact trade launders itself).
- `cut.jump` vs `cut.smash` — a cooldown % against a behavior; Sucker Punch wins
  unconditionally.
- `air.saturation` vs `air.precision` — more shells + wider scatter against
  narrower scatter. Two knobs on one dial; they cancel.
- `cata.aftermath` vs `cata.upheaval` — **anti-synergistic**: Upheaval's hurl
  throws targets out of Aftermath's echo radius.
- `bt.adrenaline` vs `bt.deadeye` — two numbers, at least on different axes.
  The weakest of the acceptable forks.

**Capstones worth the road:** EXECUTIONER, RICOCHET, GUILLOTINE, REPEAT
OFFENDER, CLASS ACTION, EXTINCTION EVENT, EXTENSION, SPONSOR LOYALTY, PERFECT
FORM / MOMENTUM. **Capstones that are not:** AWARD SEASON (fires
unconditionally — §1.1), AFTERSHOCK (real behavior bolted to a limp number),
SYSTEM SHOCK (correct, but base-kit material — R5 promotes it).

### 4.3 The new node graphs

Existing ids are kept wherever the meaning survives, so old saves keep their
ranks (§7). New ids are marked **[new]**; retired ids show their migration.

**MELEE** — *the healthiest tree; one filler node fixed.*
- ENTRY `melee.arc` **Wide Arc** (2, over 2) — now also **+1 target cap per rank**
  on the swing's hit list, so it changes what you touch.
- FORK A `melee.heavy` **Heavy Blows** (3, over 2) — unchanged (overkill splash).
- FORK B `melee.swift` **Swift Strikes** (3, over 1) — unchanged (momentum).
- RIDER `melee.bleed` **[new] Ragged Edge** (1, over 1) — swings that CRIT apply a
  poison stack (shipped poison rules; no new status).
- CAPSTONE `melee.execute` **EXECUTIONER** — unchanged.

**DASH** — *fix the false fork; the tree becomes mobility identity.*
- ENTRY `dash.shock` **Shockstep** (3, over 2) — promoted to entry; hybrid
  scaling (R2).
- FORK A `dash.quick` **Quickstep** (2, over 1) — rank 1 keeps −18% recharge;
  **rank 2 grants a THIRD dash charge.** A charge is an identity; a percentage
  is not.
- FORK B `dash.blink` **Long Blink** (2, over 2) — distance, **and enemies you
  pass through take 40% of Shockstep's damage**. The pass-through is what makes
  the long dash a play instead of a retreat.
- RIDER `dash.veil` **[new] Smoke Break** (1) — the dash leaves a 1.2-tile blind
  puff for 1.5s: monsters inside drop their current aggro target (reuses the
  decoy taunt seam in ai.ts, inverted).
- CAPSTONE `dash.after` **AFTERSHOCK** — unchanged.

**BOLT** — *kill the dead gate.*
- ENTRY `bolt.rapid` **Rapid Bolts** (3, over 1) — keeps −15%/rank, and **at rank
  3 the bolt loses its animation lock** (fire at full movement speed). A cadence
  node that changes your feet.
- FORK A `bolt.split` **Split Shot** / FORK B `bolt.pierce` **Piercing Bolts** —
  unchanged. (A genuinely good fork: spread vs line.)
- RIDER `bolt.frost` **Frost Bolts** — unchanged.
- CAPSTONE `bolt.ricochet` **RICOCHET** — unchanged.

**COLLAPSE** (was Nova) — *rebuilt around the gather.*
- ENTRY `nova.bang` **Event Horizon** (2, over 2) — **+25% gather radius** per
  rank (the pull, not the blast; blast radius rides along at half).
- FORK A `nova.crush` **[new] Crush** (3, over 2) *(migrates `nova.conc`)* —
  gathered targets land **staggered**, and the blast deals +25%/rank **to targets
  that were dragged**. Rewards the setup, not the raw number.
- FORK B `nova.rift` **[new] Rift** (2, over 1) *(migrates `nova.after`)* — the
  implosion point **stays a singularity for 2s**, pulling anything that walks
  near it; cooldown −10%/rank.
- RIDER `nova.scorch` **Afterburn** — unchanged.
- CAPSTONE `nova.singular` **SINGULARITY** *(replaces `nova.implode`, now base)*
  — the collapse **pulls projectiles too**: enemy shots bend into the crater and
  are consumed. The answer to toysoldier volleys, sentinel railshots and boss
  radial volleys — a capstone the AI roster demands.

**ORBIT** — *the tree was fine; it now hangs off a verb.*
- ENTRY `orbit.blade` **Extra Blade** — unchanged.
- FORK A `orbit.razor` **Razor's Edge** (3, over 2) — damage, **and hurled blades
  pierce** (they don't stop on the first body).
- FORK B `orbit.wide` **Corkscrew** — unchanged, **and the hurl travels 40%
  further**.
- RIDER `orbit.guard` **[new] Crossguard** (1, over 1) — while the ring is home it
  parries: the first enemy melee hit every 3s is negated. *(This replaces the
  first draft's `orbit.magnet` "Return Policy", which was **CUT**: it was a third
  gather on top of Collapse and Extradition, and it blew §2.2's own two-owner cap
  in the same document that states the cap. Orbit already gains a verb from the
  hurl; it does not need to be a setup tool as well.)*
- CAPSTONE `orbit.guillotine` **GUILLOTINE** — unchanged.

**BATTLE STANCE** — *keep the best fork in the game; the base now acts (R4).*
- ENTRY `stance.edge` **Honed Edge** (2, over 2) — **CHANGED**; it was
  "+8%/rank matching damage", which §4.1 forbids as an entry. It now widens what
  the stance *reaches*: rank 1, the matching multiplier applies to your
  **abilities** of that school, not just basic attacks; rank 2, it applies to
  lens-converted abilities too (§5). The stance stops being a number on two
  buttons and becomes a commitment that covers the whole kit.
- FORK A `stance.discipline` **Discipline** — numerically unchanged, and it is now
  the side that **uses** R4's swap-strike (the strike requires being settled).
- FORK B `stance.flow` **Flow** — numerically unchanged, **plus it ungates the
  swap-strike**: with Flow drafted every swap strikes regardless of settle, at 60%
  power. Discipline uses the strike; Flow spams it. Neither side is strictly
  better to play, which is the entire reason R4 gates it in the base.
- RIDER `stance.footwork` **[new] Footwork** (1, over 1) — the free swap-strike
  also **refunds 0.4s of the swapped-TO attack type's cooldown** (inside rule 8's
  per-cast refund budget — flagged in §5.4).
- CAPSTONES `stance.perfect` **PERFECT FORM** / `stance.moment` **MOMENTUM** —
  unchanged. A two-capstone tree is fine when the fork is this strong.

**BREAKER** (was Overcharge) — *the interrupt is base; the tree is what the
break BUYS.*
- ENTRY `overcharge.surge` **Surge** (3, over 2) — **CHANGED**; +25%/rank damage
  is an illegal entry under §4.1. Surge now changes what the banked hit *touches*:
  **+1 target** on a banked swing's hit list and **+1 pierce** on a banked bolt,
  per rank. The bank's raw damage lives in `CONFIG.overchargeDamageMult`, where a
  tuner can find it and a player never has to spend a node on it.
- FORK A `overcharge.volley` **Overcharged Volley** (2, over 1) — unchanged in
  spirit (extra bolts on a banked ranged spend).
- FORK B `overcharge.echo` **Echo Strike** (2, over 1) — unchanged (double swing
  on a banked melee spend).
- RIDER `overcharge.window` **[new] Open Season** (1, over 1) — enemies you
  stagger with a banked hit take **+20% from everything for 2s**. This is the
  cross-ability combo hook ABILITY-CONCEPTS asked for: *break, then dump.*
- CAPSTONE `overcharge.chain` **CHAIN REACTION** *(replaces `overcharge.shock`,
  now base)* — a banked hit that staggers **propagates the stagger to everything
  within 2.5 tiles**. Party-scale control, once per phrase.

**BLINDSIDE** — *fix the dominated fork side.*
- ENTRY `cut.range` **Long Reach** (2, over 2) — range, **and the cut can target a
  corpse or a party ping** (pure repositioning — mobility identity).
- FORK A `cut.encore` **[new] Second Take** (2, over 1) *(migrates `cut.jump`)* —
  the cut gains a **second charge**, recharging one at a time like dash, instead
  of a cooldown percentage.
- FORK B `cut.smash` **Sucker Punch** — unchanged.
- RIDER `cut.mark` **[new] Continuity** (1, over 1) — the arrival target is
  BRANDED for 3s (+12% from your other abilities — deliberately the same language
  as the Brandmark glyph; they do NOT stack, strongest wins).
- CAPSTONE `cut.match` **REPEAT OFFENDER** — unchanged.

**EXTRADITION** — *base now hits and drags three; the capstone goes further.*
- ENTRY `surf.chain` **Long Arm** (2, over 2) — range **and +1 body dragged per
  rank**.
- FORK A `surf.grip` **Contempt** / FORK B `surf.dive` **Gavel Drop** — unchanged
  (control vs damage; already a real fork).
- RIDER `surf.hook` **[new] Writ of Attachment** (1, over 1) — the chain can pull
  a **hazard** (spitter puddle, sludge, consecrated ground) toward you and
  extinguish it, or pull *you* out of one. Hazard interaction is a verb no other
  ability has.
- CAPSTONE `surf.wave` **CLASS ACTION** — everything the chain passes through, no
  cap. Now a real upgrade over a base that drags three.

**STUNT DOUBLE** — *the double can die, so its tree is finally a choice.*
- ENTRY `double.break` **Big Break** (2, over 2) — contract seconds **and +20%
  double HP** per rank.
- FORK A `double.method` **Method Actor** (2, over 1) — taunt radius **and the
  double mirrors your ABILITIES, not just swings** (at `doubleMirrorFrac`).
- FORK B `double.pyro` **Pyrotechnic Exit** (2, over 1) — **CHANGED**; +40% blast
  was a number sitting opposite a Method Actor the same draft had just upgraded to
  a behavior — a dead fork under §4.1's corollary. The farewell blast now **leaves
  burning ground for 3s**, its radius and burn scaled by `absorbed`. Method
  survives longer; Pyro dies louder *and leaves something behind*.
- RIDER `double.cue` **[new] Cue** (1) — once per contract you may **swap places
  with your double**. *(This replaces `double.stand` "Body Double" — the 15%
  damage redirect is **CUT**: a fourth defensive mechanic on an ability that
  already had three, duplicating what a taunting decoy does by existing, and the
  node that broke the one-breath test in §2.3. What the tree wanted was a verb,
  not another rider.)*
- CAPSTONE `double.award` **AWARD SEASON** — **now conditional and inverted:** a
  double that **DIES** on the clock refunds 60% of the cooldown (it did its job).
  A double that expires unharmed refunds nothing.

**BULWARK** [new tree] — *renamed from CUT TO COMMERCIAL; crawl language, not
broadcast puns (§4.5).*
- ENTRY `bul.dig` **Dig In** (2, over 2) — the brace **also covers allies (and
  your double) within 2 tiles**, +1 tile per rank. Changes what it touches, not
  what it prints. *(The first draft's `ad.slot` "Ad Slot" was +0.35s duration — an
  illegal entry; brace duration lives in `CONFIG.bulwarkSeconds`.)*
- FORK A `bul.rally` **Rally** (2, over 1) — the heal fires **immediately at 60%
  value** instead of on expiry (safety).
- FORK B `bul.grit` **Grit** (2, over 1) — mitigation 60% -> 75%, but the heal
  only pays out if you were hit at least twice (greed).
- RIDER `bul.shove` **[new] Shove** (1, over 1) — the brace's expiry knocks back
  and staggers everything within 2 tiles.
- CAPSTONE `bul.spite` **SPITE** — damage absorbed during the brace is added to
  your next attack (capped at 2x attackPower).

**STAGE CABLES** [new tree]
- ENTRY `cab.span` **Span** (2, over 2) — +1.5 tiles of line per rank.
- FORK A `cab.taut` **Taut** (2, over 1) — **CHANGED**; +0.4s pin duration was a
  number standing opposite Live Wire's behavior, dead under §4.1's corollary. The
  line is now a **tripwire that RE-ARMS once** after the first pin drops, so one
  cast holds a lane through two waves. Timing, not duration.
- FORK B `cab.live` **Live Wire** (2, over 1) — the cables deal `0.5 x power`/sec
  while anything is pinned in them (control becomes a zone). Payoff.
- RIDER `cab.snap` **[new] Snapback** (1, over 1) — when a pin ends, the enemy is
  yanked **back to the line** once. Read that carefully: toward the *line*, never
  toward the *player*. That distinction is what keeps Stage Cables out of the
  gather budget (§2.2), and it is a definition, not a hope — §6.4.8 counts gather
  owners in the registry.
- CAPSTONE `cab.curtain` **CURTAIN CALL** — pinned enemies that die leave the
  cables live: the field re-pins once more.

**SPONSOR BARRAGE** (was Airstrike) — *the fork is now WHAT the barrage is for.*
- ENTRY `air.payload` **Bigger Payload** (2, over 2) — **CHANGED**; per-shell
  damage is an illegal entry. **+1 shell per rank** — the barrage covers more
  ground, which is what an entry is for. Per-shell damage stays in
  `CONFIG.ultAirstrikeDmgMult`.
- FORK A `air.saturation` **Saturation Barrage** (2, over 1) — the barrage covers
  a moving **2-tile band** instead of a point (wave clear).
- FORK B `air.precision` **Precision Strike** (2, over 1) — shells **track the
  nearest elite/boss** within 2 tiles of your aim (single target). Two different
  jobs, not two settings of one dial.
- RIDER `air.smoke` **[new] Smokescreen** (1) — the impact zone blocks enemy ranged
  line of sight for 3s.
- CAPSTONE `air.loyalty` **SPONSOR LOYALTY** — unchanged.

**FAULT LINE** (was Cataclysm) — *the fork is now duration vs violence.*
- ENTRY `cata.epicenter` **Epicenter** (2, over 2) — radius **and +1.5s fissure
  duration**.
- FORK A `cata.aftermath` **Aftermath** (2, over 1) — the fissure **ticks 60%
  harder** (the zone is the payoff).
- FORK B `cata.upheaval` **Upheaval** (2, over 1) — bigger hurl and poise crush;
  **no longer anti-synergistic**, because the fissure is where they land.
- RIDER `cata.chasm` **[new] Chasm** (1, over 1) — the fissure blocks enemy pathing
  at its center for its duration (a hole, not just a burn).
- CAPSTONE `cata.extinction` **EXTINCTION EVENT** — unchanged.

**BULLET TIME** — *barely touched.*
- ENTRY `bt.focus` **Deep Focus** (2, over 2) — **CHANGED**; it was +duration,
  which §4.1 forbids in an entry (and §4.2 had already flagged it). Deep Focus now
  widens *what the slow reaches*: rank 1, enemy projectiles already in flight slow
  too; rank 2, hazard tick rates and boss phase timers slow too. Duration stays
  where a tuner can reach it (`CONFIG.ultBulletTimeSeconds`) and where a capstone
  already extends it (EXTENSION). This is the one change to the ultimate §1.0d
  calls the template, and it is a grammar fix, not a power change.
- FORK A `bt.adrenaline` **Adrenaline** (2, over 1) — cooldown ticks, **and dash
  charges refund instantly on use** while inside.
- FORK B `bt.deadeye` **Dead Eye** (2, over 1) — crit chance, **and crits inside
  do not consume Breaker's bank**.
- RIDER `bt.reel` **[new] Second Wind** (1) — the first kill inside pauses the
  world an extra 0.4s. A free extension, always. *(Renamed from "Highlight Reel"
  per §4.5: the node is the crawler's, the broadcast metaphor is the
  announcer's.)*
- CAPSTONE `bt.encore` **EXTENSION** — unchanged.

**INJUNCTION** [new tree] — *every node changes what the window is FOR; no node
changes its price. The debt is always 5/3 of the freeze, structurally.*
- ENTRY `inj.notice` **Notice Period** (2, over 2) — the stay reaches further:
  rank 1, hazard spread and puddle growth freeze too; rank 2, boss arena and phase
  timers freeze too. Changes what it touches. *(The first draft's `inj.stay`
  "+3s freeze per rank" is **CUT** — a duration entry, and worse, a node that
  moved the price.)*
- FORK A `inj.crunch` **Crunch Time** (2, over 1) — the stay is **shorter (12s ->
  7s, debt 20s -> 11.7s)** and you hit **+40% harder** inside it. A burst window
  cheap enough to spend twice a floor.
- FORK B `inj.recess` **[new] Recess** (2, over 1) — the stay is **longer (12s ->
  18s, debt 20s -> 30s)** with **no damage bonus**. The reposition / regroup /
  reach-the-stairs button, expensive on purpose. *(This replaces
  `inj.filibuster`, which is **CUT**: it shrank the debt 4s/rank, i.e. it made an
  already-free ability freer, and its own capstone obsoleted it outright.)*
- RIDER `inj.contempt` **[new] Contempt** (1) — an enraged monster you **stagger**
  inside the freeze loses the enrage for the rest of the window. The rider fights
  the ability's own drawback, which is the most interesting job a rider has.
- CAPSTONE `inj.dismissed` **DISMISSED WITH PREJUDICE** — if **no monster is alive
  within 8 tiles when the freeze ends**, the debt is **halved** (never cancelled).
  *(Two changes from the first draft, both required. It cancelled the debt
  outright, which made the entire ultimate free and ate one side of its own fork
  — §4.1's capstone rule. And its condition was "kill 12 monsters inside the
  freeze": a timed kill-counter with a number on screen, structurally the closest
  thing in this document to the Audience Participation line the intro says still
  holds. The condition is now something you **do** — clear the pack you opened the
  window on — rather than something you tally.)*

### 4.4 Draft-pool consequences, and the pacing regression hiding in the registry

**Pool size, recomputed.** Sixteen abilities (13 today + Bulwark, Stage Cables,
Injunction) x 5 nodes = **80 nodes**, plus Battle Stance's second capstone =
**81**. The first draft said "Thirteen abilities x 5 nodes = 65 nodes" — stale by
the three abilities the same document adds, in a doc whose credibility rests on
measurement. Drafts still only roll from SLOTTED abilities (`availableUpgrades`),
so a running crawler sees at most 5 x 5 = **25 nodes**, of which forks close about
half — a realistic pool of ~18. That is the right size for `upgradeDraftSize: 3`
and it keeps `rollUpgradeDraft` from starving late (today a nova/melee-heavy
crawler runs the pool dry by level 14). The conclusion survives the correction;
the arithmetic still had to be corrected.

**The pacing regression, which is not a one-line registry change.**
`DISCOVERABLE_ABILITIES` goes **10 -> 13**, and `tomeSchedule` spaces unlocks
`1 + rand*2` levels apart (~2 average) starting from level 1. Modelled over 2000
seeds against the shipped XP economy:

| | mean level of the LAST unlock | abilities that never unlock in a full run |
|---|---|---|
| today (10 discoverables) | 21.2 | **0.09** |
| naive +3 (13 discoverables) | 27.2 | **2.28** |

An on-curve crawler finishes floor 18 at **level 23** — computed from
`xpForLevel`, `monsterXp`/`monsterXpPerFloor`, `monsterBaseCountFloor1`/
`monsterCountPerFloor` and `naturalFloorForLevel`'s own 60%-clear assumption.
So appending three abilities without touching the schedule means **the average
run never sees two or three of them at all**, and a bad seed can bury the
defensive ability that fills the roster's worst hole. That is a direct
fast-round-building regression (pillar 1) shipped as a registry append, and the
first draft's migration map listed it as a one-line `MUST` with no consequence
noted.

**Fix, in the same commit as the registry change:** scale the step by the pool
size — `level += (1 + rand*2) * (10 / DISCOVERABLE_ABILITIES.length)`. At 13 that
is ~1.54 levels average and the last unlock lands back at ~21, exactly where it
sits today. Pinned by §6.4.12: **the mean last-unlock level over 200 seeds must
stay ≤ 22**, so the next person who appends an ability is told immediately
instead of quietly shipping content nobody sees.

### 4.5 Naming — where the Show is allowed to be

Pillar 3 says the Show narrates, prices and rewards the crawl and never becomes a
mid-combat input. That governs *names* too, and the first draft drifted hard: Ad
Slot, Rerun, Prime Time, Jingle, PAID PROGRAMMING, Highlight Reel — the player's
defensive cooldown was fictionally an ad break they trigger mid-fight, which is
the Show reaching into the player's hands.

**The rule: the Show gets the announcer's mouth and the ability's TITLE CARD. The
player's verb and the node names stay in dungeon language.** You brace, you dig
in, you shove, you pin, you break the floor. The System can call any of it a
commercial break over the PA — that register already carries the broadcast comedy
and it costs the player nothing mid-fight.

Applied here: **CUT TO COMMERCIAL -> BULWARK**, whole tree renamed (`ad.*` ->
`bul.*`: Dig In, Rally, Grit, Shove, SPITE). `bt.reel` Highlight Reel -> **Second
Wind**. Injunction's tree is *legal* language rather than broadcast language —
that is the System's own register (it issues rulings, it does not run ads) and it
stays. **Deliberately not renamed:** AWARD SEASON, SPONSOR LOYALTY, Stunt Double,
Sponsor Barrage, and the Phase-C glyph names (Encore Clause, Cold Open,
Understudy's Rider). Those are either shipped ids or specced in ITEMIZATION-V2
§3.3, they are ability *title cards* rather than the player's verbs, and churning
save data for tone is a bad trade.

---

## 5. PHASE C GLYPHS — finalized against the new roster

The 15 Phase-C rows from ITEMIZATION-V2 §3.3, checked against §3's roster. Four
need spec changes, one needs a family move, and the set needs **two new tags and
two new channels** before any of it can ship.

### 5.1 Registry prerequisites (do these first)

- **New tag `ultimate`** — `GlyphTag` has no way to say "ultimates only," which
  Encore Clause and Cold Open both require. Add it and tag Bullet Time, Fault
  Line, Sponsor Barrage and Injunction.
- **New tag `control`** — Collapse and Stage Cables want glyphs that read
  "affects things that grab enemies." Tag Collapse, Stage Cables, Extradition.
- **New channel `cast`** — "resolves as a discrete cast with a counter."
  Required by Static Charge (every 3rd cast), Encore Clause and Cold Open (fire
  at cast time) and Blood Price (pays at cast). Without it, Static Charge on
  Orbit's aura silently does nothing — exactly the failure rule 9 exists to stop.
- **New channel `zone`** — "creates or consumes ground." Required by Grave
  Dividend (corpses) and Demolition Rider. Fault Line, Collapse, Stage Cables and
  Sponsor Barrage expose it.
- **Orbit gains `cooldown`; Blindside gains `movement`** in `ABILITY_TAGS` /
  `ABILITY_CHANNELS`, as a consequence of R3/R6. That alone un-dormants Hair
  Trigger, Heavyweight Plate and Executioner's Rebate on Orbit, and Phase
  Etch/Slipstream on Blindside — five (glyph x ability) cells that read "wrong
  archetype" today.
- **The lens family gains the `aoe` tag — and this is NOT the §1.2 fix.** Be
  precise about what it buys, because the first draft overclaimed it. `power()`
  short-circuits to `effectiveSpellPower(p)` the moment `arcane_lens` is
  socketed, and `SCALING` already reads `nova: {sp:1}` and `cataclysm: {sp:1}` —
  so **Arcane Lens on Collapse or Fault Line is a literal no-op**, before and
  after this document. What the tag actually buys: **Ballistic Lens** (magic ->
  physical, `sp` -> `ap`) becomes the one glyph that converts an AoE *for the
  crawler who needs it* — the physical build that rolled a 30% AP share and wants
  Collapse to work — which is why it is promoted to **MUST** in §7; and Arcane
  Lens + `aoe` is meaningful only on the `ap`-scaled AoEs (Sponsor Barrage, Stage
  Cables). Both ship. The honest sentence is still: **§1.2 is mitigated by a
  socket tax, not fixed.** §5.5 is the fix.

### 5.2 The 15, finalized

| glyph | tags (final) | family | effect (final) | change vs §3.3 |
|---|---|---|---|---|
| **Static Charge** | melee, projectile | repeat | every 3rd **cast** empowered: +60% damage, 2x poise | needs `cast`; now also lands on Orbit's hurl and Stance's swap-strike |
| **Demolition Rider** | aoe | — | the blast consumes burn/poison on everything it hits, dealing the remaining DoT instantly | needs `zone`; Collapse's gather makes it the set's strongest — flagged §5.4 |
| **Ballistic Lens** | melee, projectile, **aoe** | lens | deals PHYSICAL, scales off attack power | **+aoe tag; promoted to MUST** — the only lens that converts anything for a physical crawler's AoE (§5.1) |
| **Arcane Lens** *(shipped, B)* | melee, projectile, **aoe** | lens | deals MAGIC, scales off spell power | **+aoe tag** — a retro-change to a shipped glyph; **no-op on Collapse / Fault Line** (already `sp: 1`), meaningful only on the `ap`-scaled AoEs |
| **Envenomed** | melee, projectile | — | hits have 35% chance to inject a poison stack | unchanged |
| **Cryo-Etch** | aoe, projectile | — | hits CHILL 20% for 2s | unchanged |
| **Grave Dividend** | aoe, **zone** | — | consumes up to 3 corpses under the cast; +15% damage each | needs `zone`; **Fault Line + EXTINCTION is the combo** |
| **Culling Edge** | melee, projectile | — | +50% damage below 25% HP | unchanged; **stacks additively** with EXECUTIONER and GUILLOTINE — flagged |
| **Poise Wrecker** | melee, aoe | — | 2x poise damage; your staggers last +0.3s | unchanged, but now overlaps Breaker's base stagger: the +0.3s applies, the doubling does not re-stagger |
| **Point Blank** | melee, projectile | range | +30% damage within 2 tiles, −15% beyond | unchanged |
| **Longshot** | projectile | range | +30% beyond 4 tiles, −15% within 2 | unchanged |
| **Blood Price** | any | **tempo** *(was rebate)* | casts cost 3% max HP; +30% damage | **family move** — see §5.4 |
| **Phase Etch** | movement | — | +0.15s i-frames; passed-through enemies take 30% ability power (physical) | unchanged; now live on Blindside too (R6) |
| **Understudy's Rider** | summon | — | double's contract +2s; its farewell blast chills | unchanged — and with R8 (mortal doubles) it is finally a real survivability pick |
| **Encore Clause** | **ultimate** | rebate | kills inside the ultimate's active window refund 4% of its cooldown each | needs the `ultimate` tag **and a defined window** (§5.4) |
| **Cold Open** | **ultimate** | — | the ult cast CHILLS everything within 6 tiles 30% for 3s | needs `ultimate` tag + `cast` channel |

### 5.3 Combos each glyph enables (the design owes tests for these)

- **Collapse + Demolition Rider**, fed by **Accelerant** or **Envenomed** on
  bolt: ignite the pack at range, gather them, detonate every DoT at once. The
  cleanest setup -> payoff line in the game, built from three shipped systems.
- **Collapse + Cryo-Etch -> Point Blank melee**: gather, chill, stand in the
  middle and swing at +30%. The melee build's answer to a spread-out room.
- **Stage Cables + Grave Dividend Fault Line**: pin them over the corpses.
- **Breaker + Open Season + any ultimate**: stagger, +20% vulnerability, dump.
- **Orbit's hurl + Static Charge**: every third throw is a 2x-poise ring — the
  passive slot becomes a stagger tool.
- **Blindside + Executioner's Rebate + REPEAT OFFENDER**: both fire on the kill
  (refund *and* reset), which rule 8's per-cast budget already contains.
- **Extradition (base drags 3) + Collapse**: chain three in, implode the rest.
  Two mobility/utility abilities producing a wave clear neither owns alone —
  exactly the cross-ability texture ABILITY-CONCEPTS said was missing.
- **Sponsor Barrage + Cold Open**: chill the room at cast, then walk fire across
  a room that cannot leave.

### 5.4 Flags — cap and budget risks

1. **Blood Price must move from `rebate` to `tempo`.** It is not a refund; it is
   a damage-for-cost trade, which is precisely the axis `tempo` exists to police
   (ITEMIZATION-V2 §3.2 rule 2). Left in `rebate`, it would happily share a slot
   with Heavyweight Plate for **+69% damage** off two drawbacks that never
   interact — the exact launder the tempo family was created to stop.
2. **Encore Clause needs a bounded window, not "during the ultimate."** Bullet
   Time and Injunction have durations; Sponsor Barrage has a 3s direct; Fault
   Line's fissure lasts 10s. Define the window as **the ultimate's own active
   duration, or 3s if it has none**, and let rule 8's per-cast budget (50% of the
   post-cap cooldown) do the rest. On floor 15 (80+ monsters) Fault Line's raw
   refund would be 4% x ~20 kills = 80% of a 40s cooldown; the budget clamps it
   to 20s. **The clamp holds — but it is doing all the work, so the test must pin
   it** (§6.4).
3. **Rule 7 (40% CDR) bookkeeping after R3/R5/R1:** Orbit's new cooldown enters
   the clamp for the first time; `cut.jump` retires as a CDR node (replaced by a
   charge) so `CDR_NODES` loses an entry; `nova.after` retires and `nova.rift`
   (−10%/rank) replaces it. `CDR_NODES` and the "RULE 7's REAL floor" case in
   `glyphs.test.ts` both move.
4. **Footwork (`stance.footwork`) is a refund** and must route through the rule-8
   budget rather than around it — it is the first *rank* that grants a refund,
   and the budget accumulator is currently armed only by `armRebate` on glyph
   sockets.
5. **Culling Edge + EXECUTIONER + GUILLOTINE** on one melee slot is +110% below
   25% HP plus an execute. A legitimate chase build, but the roster's highest
   ceiling — the balance sweep should look at it on purpose.
6. **Demolition Rider is the strongest Phase-C glyph** once Collapse gathers. If
   the §6.4 gather contract lands at 2.5+ targets, model it before shipping; it
   may need an "up to 3 targets" clause like Grave Dividend.

### 5.5 School commitment — the actual §1.2 fix, specced so it can be scheduled

§1.2's finding is that a crawler cannot *choose* to be a caster: auto-equip hands
out a 30–68% AP share and every `sp`-scaled ability inherits the coin flip. §5.1
mitigates that with a socket tax. This is the fix, and it is the single change in
this document that most directly serves pillar 1 — "I am a caster" is exactly the
kind of decision that should land by floor 3 and shape everything after. It is
specced here rather than parked in BACKLOG because the first draft named its own
mitigation a tax in §7's LATER list and then deferred the real answer, which is
how holes stay open across documents.

**DISCIPLINE (working name). One pick, offered at level 6, free, permanent:**

- **STEEL** — 40% of your spell power counts as attack power. Physical-school
  drops weight up in the shop and the drop tables.
- **ARCANE** — 40% of your attack power counts as spell power, same weighting the
  other way.
- **UNTYPED** — decline both: you keep the raw split you roll and gain **one extra
  glyph socket on your ultimate slot**. The build that says "I'll take what the
  dungeon gives me" gets paid for saying it.

Implementation is small because `power()` is already the one read point every
consumer shares: a `Player.discipline?: "steel" | "arcane" | null` field
(optional, load-time default `undefined` = not yet chosen — the §7 saves rule
applies unchanged), one conversion inside `power()`, one drop/shop weight, and a
three-card pick that reuses the upgrade-draft modal. No new host surface.

**Scope: SHOULD — and the first SHOULD to pull forward** if slices 2–5 land under
estimate. Roughly a day; the sim change is trivial and the drop-weighting is where
the time goes. If it does not ship on this branch, then **§1.2 stays open and the
roster keeps its lottery.** That is a legitimate call to make; it is not a
legitimate thing to leave unwritten.

---

## 6. BALANCE FRAME

### 6.1 Expected power curve, per floor band

Reference: the on-curve crawler (`naturalFloorForLevel`), shopping the way
`bot.ts`'s SHOP_LADDER does, holding the glyphs `createTestGame` grants.

| band | floors | kit shape | what the crawler can do | trash / veteran / elite TTK |
|---|---|---|---|---|
| **Act 1 opening** | 1–3 | 3 slots (melee/dash/bolt), 0–1 glyph, ~4 ranks | dodge a telegraph, kill a grunt in 1–2 swings | 1–2 / 3+ / 5+ swings |
| **Act 1 identity** | 4–6 | 4th slot filled, socket 1 open on every slot, one fork committed | one setup -> payoff line (gather, brace or pin) reads on screen; **the build's sentence is sayable** | 1–2 / 3–4 / 6+ |
| **Act 2 arrival** | 7–9 | ultimate slotted (`ultimateMinFloor` 7), 3–5 glyphs, first capstone | can answer a *specific* threat: interrupt a slagbreaker, pin a charger lane, gather a toysoldier squad | 1–2 / 3–4 / 7+ |
| **Act 2 rebuild** | 10–12 | second sockets staggering in (11/13/15/17), 2 capstones | a room is a plan, not a scramble; the ultimate resets one bad room per floor | 1 / 3 / 8+ |
| **Act 3 chase** | 13–15 | overranks, boss uniques, both sockets on the core slots | the deep ramp + resist bias demand the *right* school; lens glyphs matter | 1–2 / 3–4 / 8+ |
| **Act 3 finale** | 16–18 | full kit, chase legendaries | the ceiling is visible and the run's identity is unmistakable | 2 / 4 / 10+ |

The TTK ladder is deliberately flat across bands — that is the shipped POWER
LADDER contract (trash ≤ 2 on-curve swings, veteran ≥ 3, elite > veteran) and
nothing in §3 is allowed to break it.

### 6.2 What the bot must be able to do

The bot is the balance instrument and today it plays 3 of 5 slots (§1.0e).
`bot.ts` must gain a **per-role cast policy driven by the registry**, not more
hardcoded flags. Minimum competence, in priority order:

1. **Brace before a heavy telegraph** instead of retreating from it, when a
   defensive ability is slotted. This is what Bulwark is *for*, and it
   is measurable: damage-taken should drop.
2. **Interrupt with Breaker** when a brute / slagbreaker / charger / archivist
   windup is in range. The bot currently backs away from every heavy windup,
   which is exactly why the roster's control gap never showed up in the numbers.
3. **Gather before AoE**: never cast Collapse at fewer than 2 nearby monsters;
   pin (Stage Cables) or chain (Extradition) first when 3+ are within 8 tiles.
4. **Close on support kinds** (shaman, necromancer, hexer, drummer, cleric,
   broodmother) with Blindside/Extradition instead of walking. The AI roster is
   full of "kill the support first" puzzles the bot ignores.
5. **Spend the ultimate on an occasion** — the existing rule (3+ packed, or a
   boss) is right; extend it with "or the collapse timer is under 60s" for
   Injunction, which is also the only ultimate that must be *withheld* on a
   losing floor (it costs 8 net seconds of clock, §3.2 N3) and is not offered at
   all where there is no collapse timer.
6. **Press what it has**: any slotted ability with no specific policy still gets
   cast opportunistically at a valid target, so a new ability is never silently
   dead weight in a measurement.

Measured baseline for the change: greedy pressing alone took floor time **52s ->
31s** and converted a death. Expect the *policy* bot to land between the two and
to take materially less damage than either.

### 6.3 Balance-contract numbers I expect to move (and why)

The contract encodes *playable*, not *current numbers*. Each line is the
one-line justification the rule requires.

- **"usually clears floors 1-2" (≥4/6 seeds)** — *keep the threshold.* Floors 1–2
  are the 3-ability opening kit and §3 barely touches it; if it rises to 6/6 the
  early game got easier by accident and density is the lever, not the test.
- **"cleared after collapse" (`timeRemaining > 0`)** — *keep, and tighten.* A
  competent bot clears faster (31s vs 52s), so this assertion gets *easier* —
  a real loosening of the contract's grip. Compensate by also asserting each
  floor took at least ~15 sim-seconds, so "the bot got fast" cannot hide "the
  floor got empty."
- **Boss `minTtk` 12 / 15 / 20s** — *keep the floors.* They are the anti-one-shot
  guard. If the reworked roster (Breaker interrupts, Fault Line zones, a real
  ultimate) halves boss TTK, the fix is boss HP/phases in the same commit, not a
  lower floor.
- **Floor-12 fixture: `cleared ≥ 1/10` and `totalLostPct > 40`** — *both will
  move.* A bot that presses five slots and braces should clear more often (good)
  and take less damage (which threatens the 40% floor). If lostPct drops under
  40, the honest response is to re-tune Bulwark's mitigation (60% for
  1.5s is deliberately generous) and re-measure — **not** to lower the 40.
- **The leveling-band test (seed 19, bands 1–4 / 3–7 / 6–9 / 8–12)** — *will
  re-roll.* Any registry change shifts the shared RNG draw sequence, exactly as
  that test's comment documents nine previous times. Re-pick the seed; do not
  widen the bands.
- **`test/sim.test.ts`'s 65 node-id references** — mechanical updates for the
  five retired ids (`nova.conc`, `nova.after`, `nova.implode`, `cut.jump`,
  `overcharge.shock`).

### 6.4 New contract tests this design owes

**First, the `role` rule these tests stand on.** `ABILITY_INFO.role` is a
**single, required, non-overlapping value**, assigned here in the design (§3) and
read by the tests — never inferred per test, never a list. *Tags* are for glyph
routing and an ability may carry many; **role is exactly one** and it decides
which axis the ability is measured on. This matters because the first draft made
`role` a SHOULD, let the anti-dominance band exempt whole archetypes "by tag",
and then re-roled Overcharge to control (R5) and tagged Blindside as movement
(R6) — precisely the two abilities that would have failed the band. **A test
whose exemption list covers every failing case is not falsifiable.** The
assignment, fixed:

| role | abilities | measured on |
|---|---|---|
| `beat` | melee, bolt, battle stance | the §6.1 TTK ladder — they *are* the reference |
| `burst` | Blindside | damage into a stationary boss inside 1.0s (test 7) |
| `clear` | Collapse, orbit | targets hit per cast; damage share (tests 2, 5, 6) |
| `control` | Breaker, Stage Cables | enemy action-seconds removed |
| `mobility` | dash, Extradition | damage taken |
| `sustain` | Bulwark | damage taken; effective HP per floor |
| `summon` | Stunt Double | damage taken; decoy uptime |
| `zone` | Fault Line | area-seconds denied |
| `ultimate` | Bullet Time, Fault Line, Barrage, Injunction | test 4 |

Every role has an axis. Nothing is exempt — being measured differently is not the
same as not being measured, and the difference is the whole point.

1. **Dead-button guard** — for every ability in the registry: slot it, run the
   bot one floor, assert it was cast at least once. Catches "shipped an ability
   nobody can use," which §1.0e proves we already have.
2. **The gather contract** — mean monsters caught by a Collapse cast in bot play
   ≥ **2.5** at floors 4/8/12 (measured today: 0.62–0.98). This is the entire
   justification for R1; if it fails, R1 failed.
3. **Anti-dominance, anchored to the TTK ladder — NOT to melee.** The first draft
   normalized this band to melee's DPS: the one ability §1.1 calls "a slot nobody
   can evaluate", the outlier at 346 DPS, and the ability §4.3 then *buffs* (a
   target-cap entry and a new `melee.bleed` rider). Anchoring the ruler to the
   thing being measured means the ruler moves whenever the outlier does. The band
   is now absolute: at the §6.1 reference builds, **every `beat` and `burst`
   ability must land inside the shipped TTK ladder** (trash ≤ 2 on-curve swings,
   veteran ≥ 3, elite > veteran), and **no ability of any role may one-shot a
   veteran** at its own band. Non-damage roles are asserted on their own axis per
   the table above.
4. **Ultimates are ultimates** — each ultimate, cast once into a 6-monster pack,
   must do at least one of: kill ≥ 3; remove ≥ 2s of enemy action; change the
   room's traversal; **or change the RATE at which the room acts**. Four clauses
   for four beats. The fourth exists because a rate change is Injunction's entire
   job and the first draft left it as the one ultimate the contract could not
   see. Injunction carries two assertions of its own: monsters act **≥25% faster**
   inside the window, and its **net run-clock delta is negative at every rank**
   (freeze − debt < 0, including under `inj.crunch` and `inj.recess` and after
   DISMISSED halves it). Fail either and it is a button that prints time.
5. **The orbit ceiling** — ambient orbit DPS ≤ **40% of melee's** single-target
   DPS at floors 4/8/12. R3 claims the passive stops out-damaging abilities that
   cost attention; this is what makes the claim falsifiable rather than
   aspirational (at the first draft's 0.36 it would have failed at 168 vs 346).
6. **The reciprocal — the assertion §6 was missing entirely.** In bot floors at
   4/8/12, **melee + ambient orbit ≤ 55% of all damage dealt.** Nothing in the
   previous frame could ever catch "melee is the game," which is exactly what

   §1.0a measured. This can, and it is the test that will scream first if any
   §4.3 melee buff goes too far. **SHIPPED**, on a per-source damage instrument
   (`GameState.dmgBySource`, opt-in so live play and the wire pay nothing for
   it) plus an `ambient` tag on the one damage source in the game that costs no
   attention. Orbit is FORCED into the 4th slot for the run — `abilities: "all"`
   shuffles now, so on most seeds the ambient half would otherwise measure
   nothing. **Measured at ship, 10 seeds per floor: 34.1% / 51.2% / 32.7%.**
   Floor 8 is the live edge — melee alone is ~47% of everything the bot deals
   there — so the contract has about four points of headroom, and the next melee
   entry has to buy them from somewhere.
7. **The burst window** — at least one **non-ultimate** ability must deliver
   **≥ 3x a melee swing** to a stationary boss inside 1.0s at floors 4/8/12.
   Blindside is the ability that has to pass it (1.9x base x the unaware-target
   crit). If it fails, the roster has no answer to "how do I kill the thing
   standing still" except auto-attacking, and §2.2's thin row is still thin.
8. **The two-owner caps** — at most **two** abilities carry `role: "control"`, and
   at most **two** expose the gather capability flag. Two registry assertions, one
   line each. They are what turn §2.2's cap from advice into a rule, and they are
   why `orbit.magnet` is cut.

9. **Barrage pays for its commitment** — (i) damage taken during a Barrage cast ≤
   damage taken over an equivalent 3s of normal play at the same floor; (ii) total
   barrage output ≥ **2.5x the best 3s of melee** at the same floor. A 3s channel
   at 70% move speed that fails either is a tax, not a decision (§3.3 U2).
   **MEASURED — both clauses live in `test/abilities2.test.ts`.** (i) passes and
   is not close: paired runs (one warm run per seed, cloned at each checkpoint
   into two byte-identical arms, one of which then presses the ultimate) read
   channelled/normal **.63 .73 .78 .45** at floor 8, **.64 .51 .88 .64** at
   floor 12 and **.92 .62 .87 .65** at floor 16, on four disjoint 24-seed bases.
   Channelling is *safer* than fighting, because the shells kill and stagger
   what was about to reach you.

   **The fixture was rebuilt once**, after `bosses-v2` merged and this clause
   read 300 vs 52 at floor 12. That was the ruler, not the ability: the boss
   dealt 22 of the 352 damage in those windows and all 22 on the arm that was
   *not* channelling, `shieldHp` was 0 in 12 of 13 and `ap.track`/`ap.band` were
   0 in every fixture — the 300 was trash `shot` and `swarmer`. Two real
   defects: 13 windows could not resolve the claim (neighbouring seed bases read
   101v104, 119v240, 179v418), and the "playing normally" arm was itself
   pressing the ultimate in 21 of 81 windows. The control arm is now forbidden
   the ultimate, windows anyone died in are dropped, floors are **8/12/16**
   because `ultimateMinFloor` is 7, and the sample is ~5x larger for less work.
   The rebuilt ruler still bites: `barrageMoveMult` 0.7 -> 0.15 turns all three
   floors red at 1.90 / 1.66 / 1.65.

   **Watch item, measured not fixed:** the margin narrows with depth. A shell
   one-shots the median mob at floor 8 (0.56 shells-to-kill) and needs 1.34 of
   them by floor 12, so the barrage's affordability — which is bought by its
   lethality — thins out; floors 14 and 16 sit near parity (.83–1.03 before the
   death-window guard). If a later band pushes it past 1.0, the lever is shell
   damage at depth, **not** channel length. (ii) **failed at
   ship: 2.34x.** §3.3's pre-registered ladder (3.0s -> 2.0s, then cut the
   commitment) is aimed at a commitment that is unaffordable, and (i) says this
   one is not — and the ladder is not the lever anyway, because shells and
   swings both scale with the window, so the ratio sits near 2.39 at *any*
   channel length. The payoff moved instead: `ultAirstrikeDmgMult` 1.7 -> 1.9,
   landing **2.61x**. The ladder is untaken, and the reason is recorded here
   rather than left implied.
10. **Rule 8 under load** — Encore Clause on Fault Line, floor 15, 80 monsters:
    total refund ≤ 50% of the post-cap cooldown (§5.4 flag 2).
11. **Every (glyph x ability) cell** — the existing contract test in
    `glyphs.test.ts` extends to the new tags/channels automatically, but it must
    be re-run after §5.1 so no new cell lights gold and does nothing.
12. **Tome pacing** — mean last-unlock level over 200 seeds ≤ **22** (§4.4). The
    guard that stops the next ability append from silently shipping content the
    average run never reaches.

---

## 7. MIGRATION MAP

Scope keys: **MUST** (the design does not work without it), **SHOULD** (better
with it), **LATER** (parked in BACKLOG.md).

### `src/sim/abilities.ts` — the registry
- **MUST** `AbilityId` gains `"bulwark"`, `"cables"`, `"injunction"`. Keep
  `nova`, `cataclysm`, `airstrike`, `overcharge`, `cutto` as ids even though the
  display names change (`ABILITY_INFO.name`) — **ids are save data.**
- **MUST** `SCALING`: `dash` -> `{ ap: 0.5, sp: 0.5 }` (R2); `cables` ->
  `{ ap: 1 }`; `bulwark` / `injunction` absent (no damage).
- **MUST** `DISCOVERABLE_ABILITIES` gains the three new ids. **Note the ordering
  trap:** `createTestGame` learns this array in order, which is why
  `abilities=all` always produced the same loadout (§1.0e). Fix `createTestGame`
  to shuffle from the seeded RNG before slotting, or every test fixture keeps
  measuring one kit forever.
- **MUST — in the same commit — `tomeSchedule` scales its step by pool size**
  (`level += (1 + rand*2) * (10 / DISCOVERABLE_ABILITIES.length)`). Going 10 -> 13
  discoverables without this pushes the mean last unlock from level 21.2 to 27.2
  while an on-curve crawler ends the run at level 23 — **2.28 abilities per run
  that never unlock at all** (§4.4). This is a pillar-1 regression disguised as an
  array append; §6.4.12 pins it.
- **MUST** `UPGRADES`: the §4.3 graph. Retire `nova.conc`, `nova.after`,
  `nova.implode`, `cut.jump`, `overcharge.shock`; add the new riders and the
  three new trees.
- **MUST** `CDR_NODES`: drop the `cutto` entry; `nova` -> `["nova.rift", 0.10]`;
  orbit takes glyph CDR only (no rank CDR node).
- **MUST** new param functions `bulwarkParams`, `cablesParams`,
  `injunctionParams`; `orbitParams` gains `hurlCooldown` / `hurlRange`.
  **Naming note:** the defensive ability is `bulwark`, never `commercial` —
  `cutToParams()` already means *Blindside*, and a `commercialParams()` beside it
  would mislead every future reader exactly once, permanently (§3.2 N1, §4.5).
- **MUST** (not SHOULD) a **single-valued** `role` field on `ABILITY_INFO`
  (`beat | burst | clear | control | mobility | sustain | summon | zone`), plus
  `ultimate` derived from `tier`. §6.4's whole frame and the bot's policy table
  both read it, and the alternative — inferring archetype per test — is what let
  the first draft's band exempt every ability that would have failed it. One role
  per ability, assigned in §3, no overlap.

### `src/sim/game.ts` — cast surface + resolution
- **MUST** `castAbility` gains three cases. `doNova` becomes gather-then-blast;
  `doCataclysm` spawns a persistent fissure (extend `state.hazards` with an
  owner-side kind — the hazard system already ticks, slows and renders);
  `doAirstrike` becomes a 3s directed channel (a transient `p.barrageT` /
  `p.barrageAim` pair, same shape as `p.overcharged`); `doOvercharge` staggers on
  spend; `updateOrbit` gains the hurl state machine; `doStance` fires the free
  strike; `updateDecoys` respects decoy HP.
- **MUST** every new damage path passes its `ability` tag into `damageMonster` /
  `radialDamage` so glyph riders (brand, ignite, onhit) route correctly.
- **MUST** monster **pin**: a `Monster.pinnedT`, respected in `ai.ts`'s movement
  step only (windups still resolve — pin is not stun).
- **SHOULD** `hit()` events for the new abilities so hosts get FX hooks.

### `src/sim/glyphs.ts` — the modifier layer
- **MUST** `GlyphTag` += `"ultimate" | "control"`; `GlyphChannel` += `"cast" |
  "zone"`.
- **MUST** `ABILITY_TAGS` / `ABILITY_CHANNELS` rows for the three new abilities,
  plus: orbit += `cooldown`, cutto += `movement`, nova += `control`, cataclysm +=
  `zone`, airstrike += `zone`, all ultimates += the `ultimate` tag.
- **MUST** the 15 Phase-C `GLYPH_INFO` / `GLYPH_CHANNELS` rows; Blood Price in
  `tempo`; Arcane Lens gains `aoe` (a change to a *shipped* glyph — see saves).
- **SHOULD** a `glyphWindow` helper for Encore Clause's bounded window (§5.4).

### `src/sim/config.ts` — tuning
- **MUST** new blocks: `bulwark*` (5 knobs, incl. `bulwarkSeconds`), `cables*`
  (7), `injunction*` (5, incl. `injunctionFreeze` 12 and `injunctionDebtRatio`
  **5/3** — the debt is derived, never a free knob, so no retune can accidentally
  make the ultimate profitable), `orbitHurl*` (4), `faultLine*` (4), `barrage*`
  (5), `doubleHpFraction`.
- **MUST** retuned: `orbitDamageMult` 0.5 -> **0.22** (not 0.36 — see R3's
  arithmetic and §6.4.5), `cutToDmgMult` 1.2 -> 1.9, `overchargeDamageMult` 1.5 ->

  1.35, `ultAirstrikeDmgMult` 2.5 -> **1.9** (1.7 as first specced; §6.4.9(ii)
  measured the whole channel at 2.34x the best 3s of melee, under the
  pre-registered 2.5x bar, so the payoff moved), `ultCataclysmCooldown` 35 -> 40,
  `novaCooldown` 5.0 -> 6.0.

### Saves + net snapshots (the compatibility rule)
- **MUST** every new `Player` field is **optional with a load-time default**:
  `barrageT?`, `barrageAim?`, `bulwarkT?`, `bulwarkAbsorbed?`, `injunctionT?`,
  `injunctionDebt?`. Same pattern as `slipstreamT` / `rebateT` — transient, reset
  per floor, never required.
- **MUST** `Decoy.hp` / `maxHp` optional; a pre-rework decoy in flight loads as
  invulnerable and expires normally.
- **MUST** retired node ids must be **MIGRATED, not dropped.** `rank()` ignores
  unknown keys, so a resumed run would silently lose three ranks. Map
  `nova.conc -> nova.crush`, `nova.after -> nova.rift`, `cut.jump ->
  cut.encore`, `nova.implode -> nova.singular`, `overcharge.shock ->
  overcharge.chain` in `applySavedPlayer`. One small function, covered by a
  persistence test.
- **MUST** `PLAYER_COLD_FIELDS` needs no change (`abilities` and `glyphs` are
  already in the cold block); the new transient fields are hot and small.
- **SHOULD** bump the snapshot version stamp; the wire shape is additive, so old
  clients degrade rather than break.

### `src/sim/bot.ts` — competence (the gate on every measurement)
- **MUST** §6.2's policy, structured as a small table keyed by
  `ABILITY_INFO.role`, so adding an ability adds a row rather than a branch.
- **MUST** `SHOP_LADDER` unchanged; `socketBenchGlyphs` unchanged (it already
  reads `glyphMatches`, so the new tags/channels flow through for free).

### UI surfaces
- **MUST** `src/main3d.ts` — the T-panel constellation rows (`nodeRowHtml`),
  loadout slots, dormancy strings and ability blurbs all read the registry, so
  they follow automatically; the three new abilities need **icons** and the
  ultimate list needs a fourth entry. Sponsor Barrage needs a *directed-cast*
  input mode (hold-to-steer) — the only genuinely new host-side interaction in
  this document.

- **MUST** `src/render3d/renderer3d.ts` — a per-monster **pin decal** on
  `Monster.pinnedT`, deliberately a different shape from stagger (a hard
  bracketed shackle standing on a taut ring, versus stagger's grey squashed
  body with nothing on the floor) because "the pin is control, not a stun" is
  only a design statement if the two read differently; and a **sustained enrage
  tint** on every monster with `injRageT > 0` for the whole window, driven
  through the hit-flash shader stage with an amortized material-clone budget
  (Injunction enrages a whole floor at once, and cloning eighty rigs in one
  frame is the hitch the perf round spent a week killing). What shipped first
  was a reservoir-sampled ember on ONE enraged monster per ~9 events across the
  floor, which is a particle, not a tell. Also `cdRose()` cases for the new ids;
  `FX_PAL` entries for the fissure and the cable line; the Collapse gather needs
  an inward-pull visual (the existing IMPLOSION hook near renderer3d.ts:5336 is
  the seam).
- **MUST — the 2D host, and this call is made in writing rather than by
  omission.** `src/render/renderer.ts` is a live surface: it imports `novaParams`,
  `orbitBladePos` and `orbitParams` and draws the nova flash at lines 374–387, and
  `src/main.ts` is a live entry point that reads `ABILITY_INFO`. Nothing in the
  first draft's migration map gave it a gather visual, a fissure, a cable line, a
  barrage cursor or decoy HP — three new abilities and four reworked ones would
  have rendered as *nothing* there. **Decision: abilities-v2 is 3D-first and the
  2D host ships at parity, not fidelity.** MUST: it must not crash or silently
  no-op — a flat ring for the gather, a straight line for the cables, a shrinking
  pip for decoy HP, a cursor dot for the barrage, a tinted floor rect for the

  fissure. A few hours, and it is the whole difference between "reduced" and
  "broken." SHOULD: anything nicer than that.
  - **SHIPPED** — all five named primitives, plus three the first pass did not
    name: a brace arc for Bulwark, a crimson wash on enraged bodies for
    Injunction, and a pin shackle on `Monster.pinnedT`. The clock row reads
    `STAYED … owes Ns` while a stay holds, and the timer bar draws the debt as
    the slice already spoken for.
  - **The worse-than-missing case is closed too.** `orbitBladePos` computed
    blade positions purely from `p.orbitAngle` with no hurl term, while the 3D
    renderer carried a *private* copy of the throw's arithmetic. So the 2D ring
    calmly orbited the crawler for the whole ~1.1s the blades were 5.5 tiles
    downrange — the ability's entire counterplay window ("you spent your
    bodyguard") rendered as its exact opposite. `orbitHurlPoint()` now lives in
    `src/sim/abilities.ts` as the ONE source of truth: `updateOrbitHurl`'s
    damage pass reads it, `orbitBladePos` branches on it, and both hosts read
    `orbitBladePos`. There is no longer anywhere for a renderer to disagree
    with the sim about where the steel is.
- **SHOULD** `src/input/bindings.ts` — nothing structural (slots are bound, not
  abilities), but the barrage's hold-to-steer needs a binding note.
- **SHOULD** `src/sim/sheet.ts` — the character sheet should print the new
  role line, so "what does my build DO" is answerable on one screen.

### Tests
- **MUST** `test/sim.test.ts` — 65 node-id references; mechanical updates for the
  retired ids, plus new param-function coverage per §4.3 (every new node needs a
  rank -> param assertion; that is the rule-1 requirement).
- **MUST** `test/glyphs.test.ts` — the (glyph x ability) contract table grows to
  25 glyphs x 16 abilities; the "RULE 7's REAL floor" case changes (§5.4 flag 3);
  new cases for the `cast` / `zone` channels and the rule-8 load test.
- **MUST** `test/balance.test.ts` — §6.3's re-tunes with in-file justifications,
  plus §6.4's new contracts.
- **MUST** `test/persistence.test.ts` — the rank-migration case (an old save
  holding `nova.conc` loads holding `nova.crush`).
- **SHOULD** `test/status.test.ts` — pin interaction with chill and stagger.

### Scope call — vertical slices, not layers

The first draft's spine had **MUST depending on SHOULD**, which cannot ship. It
required R1 and R5 — which retire `nova.implode` / `nova.after` / `nova.conc` /
`overcharge.shock` and add `nova.singular` / `overcharge.chain` — while parking
"the full §4.3 graph" under SHOULD, i.e. a half-migrated constellation. And it
required §5.1's registry prerequisites (the `cast` and `zone` channels, the
`ultimate` and `control` tags) whose *only* consumers are the 15 Phase-C glyphs,
also SHOULD: dead plumbing with nothing plugged into it. Restated as slices, each
**shippable and measurable on its own**:

| # | slice | what lands | done when | size |
|---|---|---|---|---|
| **1** | **Instrument** | §6.2's policy bot (table keyed by `role`), the `role` field itself, the `createTestGame` shuffle fix, contracts 1/3/5/6/8/12, **and the n≥30 re-run of §1.0c/d that replaces those tables** | the baseline is real and every later slice has something honest to be measured against | 2–3 d |
| **2** | **Collapse** | R1 + Collapse's full node graph + the `control` tag + node-id migration + contract 2 | mean gathered ≥ 2.5 at floors 4/8/12 | 1.5–2 d |
| **3** | **Breaker** | R5 + its full graph (incl. `overcharge.chain`) + stagger plumbing | the bot interrupts a slagbreaker windup and damage-taken drops | 1.5 d |
| **4** | **Bulwark** | N1 + its tree + `bulwarkT` save fields + §6.2.1's brace policy | damage-taken drops again; §6.3's 40% lostPct floor re-measured, not lowered | 1.5 d |
| **5** | **Mortal doubles** | R8 + `Decoy.hp` + the AWARD SEASON inversion + `double.cue` | a decoy can die and the capstone is finally conditional | 1 d |
| **6** | **Ultimates** | U1 Fault Line + U2 Sponsor Barrage + contracts 4 and 9 | every live ultimate passes contract 4 on its own clause | 2–3 d |
| **7** | **Orbit + Stance** | R3's hurl, R4's settle-gated swap-strike, both graphs, contract 5 | ambient orbit under the ceiling; Discipline *and* Flow both worth playing | 2 d |
| **8** | **Glyph layer** | §5.1's prerequisites **together with** the Phase-C glyphs that consume them (Ballistic Lens included), contracts 10 and 11 | no tag or channel ships without a consumer | 2–3 d |
| **9** | **Reach + burst** | R6 Blindside (incl. contract 7), R7 Extradition, N2 Stage Cables | the burst-window contract passes | 2 d |
| **10** | **Injunction** | N3 + its tree + the enrage + the roam exclusion | net clock delta negative at every rank | 1.5 d |

**Total: roughly 17–21 working days** for all ten. That number is the one the
first draft owed and never gave — ~40 MUST bullets across 8 files plus a 25 x 16
glyph contract table (400 cells) with no estimate anywhere in the document.

**If only part of it ships, ship slices 1–5:** the instrument, the two worst holes
(control, defense), and the roster's biggest lie (invulnerable decoys). Slices
6–10 are each independently worth doing and none is a prerequisite for another,
so they can be dropped, reordered or split across branches without leaving
anything half-migrated.

- **SHOULD, in priority order:** §5.5 school commitment (the real §1.2 fix — first
  to pull forward if slices 2–5 come in under estimate), the 2D host's ability
  visuals beyond the non-crashing minimum, `src/sim/sheet.ts`'s role line.
- **LATER (BACKLOG):** Summon Champion (the DESIGN 5.7 ultimate the
  friendly-entity flag unlocks), the third Battle Stance, Instant Replay (needs a
  per-player damage-tally surface), Repossession.
