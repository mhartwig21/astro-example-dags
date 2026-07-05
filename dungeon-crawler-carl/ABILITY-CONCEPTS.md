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

### 6. CROWD SURF — the hook, but mass-aware
Throw a chain: anything lighter than you gets yanked to your arms (staggered,
into melee/orbit range); anything heavier yanks YOU to it (gap-close with
i-frames). One button, two verbs, resolved by the mass stat monsters already
have.
- Fork: **Headliner's Grip** (pulled enemies arrive staggered longer) vs
  **Stage Dive** (pulling yourself detonates on arrival).
- Capstone: **THE WAVE** — the chain drags everything it passed through.
- Rides: ARCHETYPES.mass, stagger/poise. Closest to a genre staple — the
  mass-flip earns its slot.

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

### 9. STUNT DOUBLE — the production hires help
Spawn a copy of you for 8s: taunts everything nearby (the aggro-transfer
defensive tool the kit lacks) and mirrors your melee swings at 40%. When the
contract expires it takes a bow and explodes proportional to damage absorbed.
- Fork: **Method Actor** (longer contract, harder taunt) vs **Pyrotechnic
  Exit** (bigger finale).
- Capstone: **AWARD SEASON** — if the double survives its contract, refund
  50% of your ultimate cooldown.
- Needs: friendly-entity surface (shared with UNION LABOR).

## Recommended first wave

**Crowd Work, Golden Handshake, Kill Clause, Instant Replay + Stop the
Count, Audience Participation** — six abilities, zero new sim surfaces beyond
a damage tally, every one impossible to describe without mentioning the show.
Second wave (Repossession, Crowd Surf, Stunt Double) lands with the
friendly-entity surface.

Delete sections from this doc as they ship (BACKLOG.md convention).
