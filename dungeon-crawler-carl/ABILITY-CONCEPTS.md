# Ability concepts — the Showtime slate

Design research for the next wave of abilities (proposed 2026-07-05, none
implemented yet). The rule that shaped this list: **every ability must be
entangled with a system this game uniquely has** — the show economy, the
collapse clock, gold, corpses, the camera. If an ability would work fine in
Diablo, it didn't make the list.

Context: the constellation pass (PR #46) fixed within-ability depth (forks,
capstones, scarcity). This slate fixes POOL depth: 10 actives fighting for 4
slots and 6 ultimates for 1 makes slot choice — and freeing melee/dash/bolt —
a genuine build decision. With tome scarcity, runs stop discovering
everything, so which tome drops starts defining the run.

Constellation sketches follow the shipped grammar: entry → exclusive fork →
capstone.

## Direction (owner review, 2026-07-05)

Favorites from this slate: **Audience Participation**, **Stunt Double**
(retiered — see its section: it should be a REGULAR ACTIVE, not an ultimate),
and **Crowd Surf**. Stated taste, which should weight all future picks:

> "I like mobility and utility skills, I think they're what make kits fun,
> as well as combo skills (where you press multiple buttons to set up attacks)."

Priorities that fall out of that:
- **Mobility beyond dash**: Crowd Surf (pull-yourself mode) and CUT TO (the
  phantom-blink flip, mined section) are the top mobility candidates.
- **Utility verbs over damage buttons**: decoys (Stunt Double), zones and CC
  (STAGE CABLES roots), defensive windows (CUT TO COMMERCIAL), the crowd
  roulette (Audience Participation).
- **Cross-ability combo hooks**: every new ability should name at least one
  setup→payoff line with an EXISTING ability (pull-in → nova; roots →
  stampede; decoy taunt → backstab bonus). The kit's current combo texture
  is mostly single-ability internal (overcharge→spend, stance-swap→momentum,
  dash→shockstep); cross-ability setups are the gap.

**SHIPPED (PR #60):** Crowd Surf, Stunt Double (as a regular active), and
CUT TO from the mined list — the friendly-entity surface is live
(state.decoys + the ai.ts taunt seam), so the summon designs below are
unblocked.

## Actives

### 1. CROWD WORK — hype as ammunition
Channel the broadcast into a shockwave: spend up to 40 hype; damage scales
with hype spent. Casting it silences your own broadcast (no frenzy, empty
meter) — converts ratings into violence at exactly the wrong-feeling moment.
- Fork: **Cheap Pop** (lower cost, stay near frenzy) vs **Blowoff** (spend it
  ALL, huge ceiling).
- Capstone: **ENCORE CHANT** — kills with Crowd Work refund half the hype.
- Rides: the hype meter/frenzy economy (config.show), addHype plumbing.

### 2. GOLDEN HANDSHAKE — gold as a weapon
Fling coins as a piercing cone; each cast spends gold (~15 + 2/floor), damage
scales with the throw. Every cast is a shop component you didn't buy. The
crowd adores conspicuous spending: hype per gold thrown.
- Fork: **Payroll** (cheaper casts) vs **Golden Parachute** (double cost,
  double coverage).
- Capstone: **RETURN ON INVESTMENT** — kills refund 60% of the throw.
- Rides: gold economy, shop tension, Liquidity Event achievement.

### 3. KILL CLAUSE — the System posts a bounty
Mark a monster: +25% damage from you, and a kill within 8s pays out gold +
hype + a 2s refund on all cooldowns. Miss the deadline and the crowd boos
(small hype loss). A promise made on camera.
- Fork: **Headline Bout** (one big mark, boss-killer payout) vs **Undercard**
  (mark 3 chaff, chained small payouts).
- Capstone: **RENEWAL OPTION** — a paid contract instantly re-arms the mark.
- Rides: kill credit, hype, cooldown map.

### 4. INSTANT REPLAY — your burst, again
Cast to record: for 2.5s the sim tallies every point of damage you deal. Then
the replay airs — an AoE burst dealing 50% of the recorded total. Build a
highlight, then broadcast it. Synergizes with overcharge dumps, orbit
grinding, ult windows; rewards planning a "take" over mashing.
- Fork: **Extended Cut** (longer window) vs **Prime Time** (higher playback %).
- Capstone: **SYNDICATION** — airs twice, second at half.
- Needs: one new sim surface (a per-player damage tally window). The most
  build-warping active on the list.

### 5. REPOSSESSION — the corpse economy switches sides
Consume every raisable corpse in range (the same corpses that fuel the
necromancer): each pops for AoE damage and a sliver of HP. Value depends on
where monsters died; denies reruns.
- Fork: **Cleanup Crew** (heal per corpse) vs **Waste Disposal** (damage per
  corpse).
- Capstone: **UNION LABOR** — consuming 3+ corpses raises ONE as your worker
  for 10s. (Friendly-minion surface — capstone can ship after the base.)
- Rides: state.corpses, necromancer denial.

## Ultimates

### 7. STOP THE COUNT — gamble against the house clock
Freeze the collapse timer for 12s, +30% damage while the floor holds its
breath — then the timer resumes 10s SHORTER. Borrowing time from the only
resource the run actually runs on. During an active collapse, hype-per-second
doubles (clutch television).
- Fork: **Filibuster** (longer freeze) vs **Crunch Time** (bigger damage).
- Capstone: **AHEAD OF SCHEDULE** — 15 kills during the freeze cancel the debt.
- Rides: timeRemaining/collapse phase. Impossible in any other ARPG.

### 8. AUDIENCE PARTICIPATION — the crowd votes
Six seeded outcomes rain on the arena over 4s: care packages (heal/gold),
anvils on random enemies, one random non-elite CANCELED, confetti (pure
hype)... and one rotten slot (a hazard lands on YOU). The hook: **outcome
weights read your current hype** — beloved crawlers get spoiled, boring ones
get pranked. The show economy decides the quality of your ultimate.
- Fork: **Fan Favorites** (more packages) vs **Heel Turn** (meaner anvils).
- Capstone: **BELOVED** — in frenzy, the rotten slot is removed.
- Rides: hype state, strikes rail (telegraphed impacts), hazards.

## Recommended first wave

**Crowd Work, Golden Handshake, Kill Clause, Instant Replay + Stop the
Count, Audience Participation** — six abilities, zero new sim surfaces beyond
a damage tally, every one impossible to describe without mentioning the show.
Second wave (Repossession, Crowd Surf, Stunt Double) lands with the
friendly-entity surface.

---

# Mined from the repo (2026-07-05 sweep)

A systematic pass over docs, code comments, monster AI, elite affixes, boss
signatures, and catalog passives found abilities the codebase has ALREADY
half-built. These are cheaper than the Showtime slate — the sim plumbing
exists; most need only a player caster + constellation entries.

## Boss signatures = pre-built ultimates (DESIGN 5.14, game.ts helpers)

The band-boss signature mechanics are self-contained, telegraphed,
floor-agnostic helpers with config knobs. Each is an ultimate wearing a
boss costume:

- **Flame Sweep** → *PYRO SWEEP*: an advancing directional wall of fire
  (bossFlameSweep; flameRows/flameStepDelay knobs). Burn status included.
- **Debris Rain** → *METEOR STORM*: telegraphed impact circles at the cursor
  (bossDebrisRain) — this is the DESIGN.md 5.7 example ultimate, already coded.
- **Flood Surge** → *FLASH FLOOD*: carpet a zone in ticking sludge pools.
- **Entangling Roots** → *STAGE CABLES*: root-snare zones — the hard-CC verb
  the player kit completely lacks (Player.rootT already exists).
- **Dark Ritual** → *SEASON FINALE*: a long, INTERRUPTIBLE self-channel into
  an arena-scale nuke — high-risk broadcast television.

## Monster flips = pre-built actives (ai.ts + config knobs)

- **Phantom blink** → *CUT TO*: targeted teleport-onto-enemy strike (distinct
  from dash's directional blink).
- **Charger rush** → *STAMPEDE*: committed line-rush hitting everything in
  the lane once (chargeHits plumbing).
- **Spitter lob** → *CAUSTIC LOB*: plant a ticking poison puddle (hazard +
  poison status both live).
- **Bomber fuse** → *TIME BOMB*: plant a fused charge; the dodge-window
  telegraph is the fun.
- **Ambush dormancy** → *SLEEPER CELL*: brief stealth ending in a surge
  alpha-strike (ambushSurge knobs).
- **Boss radial volley** → *FIREWORK VOLLEY*: full ring of bolts.

## The friendly-entity flag is the master unlock

summonMinion + raiseCorpse already construct monsters at runtime; an "ally"
ownership flag turns on FIVE designs at once: **Summon Champion** (the other
named-but-unbuilt DESIGN 5.7 ultimate), **Understudy** (raise one corpse as
your fighter — necromancer flip), **Franchise** (deployed nest births allied
swarmers — broodmother flip), plus the slate's UNION LABOR and STUNT DOUBLE.
One surface, five abilities.

## Smaller seeds

- **Elite affixes as player buffs**: shielded → *CUT TO COMMERCIAL* (short
  mitigation bubble — the missing defensive cooldown); thorns → retaliation
  window; chilling aura → *COLD OPEN* slow-field toggle (chill status live).
- **Shaman heal flip** → *FIELD MEDIC*: heal the lowest-HP nearby crawler
  (co-op verb; hypeRevive already pays hype for rescues).
- **Shrine bargains as actives**: Blood Price → *BLOOD PACT* (spend HP for
  crit/damage burst); Greed Clause → *HIGH ROLLER* (double gold, hype cost).
- **Third Battle Stance**: abilities.ts invites it ("a third stance is a
  union member away") — a defensive stance completes the triangle.
- **Status appliers**: burn/poison/chill shipped with only 1-2 sources each;
  a dedicated applicator active per status has room (e.g. *POISON DART*).
- **A pure interrupt/stun button**: poise/stagger is a full system, but only
  SYSTEM SHOCK (overcharge capstone) touches it on demand.

Delete sections from this doc as they ship (BACKLOG.md convention).
