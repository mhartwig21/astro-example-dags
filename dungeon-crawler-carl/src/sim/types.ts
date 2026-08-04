import type { Rng } from "./rng";
import type { AbilityId, School, StanceId, UpgradeOffer } from "./abilities";
import type { GlyphId } from "./glyphs";

export interface Vec2 {
  x: number;
  y: number;
}

export enum Tile {
  Wall = 0,
  Floor = 1,
  StairsDown = 2,
  DoorLocked = 3, // sealed door; not walkable until the floor key is picked up
}

export type TimerPhase = "safe" | "warning" | "collapse";

export interface Player {
  id: number; // stable per party member; 0 is the solo/first player
  name: string; // shown in announcer lines and (later) over the head
  // Chosen crawler look (CRAWLER_SKINS in game.ts), picked at the campfire
  // check-in. COSMETIC ONLY — kits come from the constellation, not the body.
  // Absent (old saves / no pick yet): hosts fall back to the seeded heroSkin.
  skin?: string;
  pos: Vec2;
  facing: Vec2; // unit vector of last movement/attack direction
  hp: number;
  maxHp: number;
  speed: number;
  // Damage schools (DESIGN 5.8): physical abilities scale off attackPower,
  // magic ones off spellPower — see SCALING/power() in abilities.ts. Both are
  // recomputed as intrinsic(level) + permanent bonuses + equipment.
  attackPower: number;
  spellPower: number;
  // Unified per-ability cooldowns (seconds remaining), keyed by AbilityId —
  // scales to any number of abilities without new fields.
  cd: Partial<Record<AbilityId, number>>;
  dashTime: number; // seconds of active dash remaining (i-frames + speed)
  rootT: number; // seconds of root snare remaining (heavy slow; boss roots zones)
  // Knockback (MOB-CONCEPTS.md verb): remaining shove distance along a fixed
  // direction, consumed at knockbackSpeed through moveWithCollision (walls
  // stop it). Set via applyPlayerKnockback; big slams shove.
  knock?: { dir: Vec2; left: number };
  // The Briar Witch's mark (curse verb): seconds of +hexVulnerability damage
  // taken remaining. The pack suddenly cares about the marked crawler.
  cursedT?: number;
  // Dash runs on charges: cd.dash is the recharge timer for the NEXT charge
  // (only ticking while below max), so dashes can be woven into offense.
  dashCharges: number;
  // Sponsor Slurp™ flask: charges spent to heal, refilled by kill credit.
  flaskCharges: number;
  flaskKillProgress: number; // kills banked toward the next charge (below max only)
  // Crowd Frenzy: true while sustained hype buffs move speed + cooldowns
  // (hysteresis thresholds in CONFIG.show). Hosts read this for glow/audio.
  frenzy: boolean;
  novaFlash: number; // transient render flag: seconds remaining of nova ring effect
  orbitAngle: number; // current rotation of the orbit blades (radians)
  orbitTick: number; // seconds until the orbit blades' next damage tick
  // Corkscrew (orbit.wide): phase of the in-out spiral oscillation (radians).
  orbitSpiral: number;
  // Battle Stance (only meaningful while the stance ability is slotted).
  stance: StanceId; // which attack type is currently favored
  stanceTime: number; // seconds since the last swap (drives Discipline's "settled")
  stanceSwapWindow: number; // seconds left of Flow's post-swap surge
  stanceCritReady: boolean; // MOMENTUM capstone: next matching attack crits
  // Swift Strikes momentum: consecutive connecting swings stack a damage bonus
  // (stacks capped by rank; the timer resets on every hit, stacks drop on expiry).
  meleeCombo: number;
  meleeComboT: number; // seconds left before the combo drops
  // REPEAT OFFENDER (Blindside capstone): the marked target + the reset window left.
  cutMark?: { monsterId: number; t: number } | null;
  overcharged: boolean; // Overcharge banked: the next attack spends it
  plotArmorUsed: boolean; // Plot Armor's once-per-floor cheat death spent (resets each floor)
  reviveProgress: number; // 0..1: teammates standing close stabilize a downed crawler
  // RIVALS mode (all no-ops in co-op):
  floorNo: number; // which floor world this crawler is on (mirrors state.floor in co-op)
  safeRoom?: SafeRoom | null; // PERSONAL shop between floors — the race keeps running
  downedT?: number; // seconds until auto-revive after going down
  // DEATH IS A DOOR (NICHE.md 4.7): a downed rival who chose the second door.
  // Conceded is terminal for the run — no revive timer, no seat in the race's
  // win condition — and it is a SIM fact (set via concedeRival), so replays
  // and the server agree about who was still racing.
  conceded?: boolean;
  reviveGraceT?: number; // brief post-revive immunity (no spawn-camping the timer)
  // The Five (DESIGN.md 5.7): 4 active slots + 1 ultimate + a bench of known-
  // but-unslotted abilities, plus rank taken per upgrade node.
  abilities: {
    slots: (AbilityId | null)[]; // length 4
    ultimate: AbilityId | null;
    bench: AbilityId[];
    ranks: Record<string, number>;
  };
  critChance: number; // effective crit chance (base + equipment)
  // Effective armor (equipment + permanent bonuses). Incoming hits are reduced
  // by armor/(armor+armorK), capped — see armorReduction/mitigate in combat.ts.
  armor: number;
  level: number;
  xp: number;
  xpToNext: number;
  gold: number;
  weaponRarity: Rarity; // rarity of the currently-equipped weapon (for HUD/flavor)
  // Itemization. Effective baseDamage/maxHp/speed/critChance are recomputed as
  // intrinsic(level) + permanent bonuses + equipped affixes (see recomputeStats).
  equipment: Equipment;
  inventory: Item[];
  bonusDamage: number; // permanent physical buff (loot boxes / sponsor rewards grant BOTH schools)
  bonusSpell: number; // permanent magic buff (kept separate so gear stays the differentiator)
  bonusMaxHp: number;
  bonusCrit: number; // permanent crit-chance buff
  bonusArmor: number; // permanent armor buff
  alive: boolean;
  // transient render flag: seconds remaining to show an attack swing
  attackSwing: number;

  // Personal, non-blocking offers: the world keeps running while these pend.
  pendingUpgrades: UpgradeOffer[]; // level-up ability draft awaiting this player's pick
  upgradeDraftsOwed: number; // queued drafts from multiple level-ups
  pendingRewards: Reward[]; // sponsor draft awaiting this player's pick

  // Per-player achievement progress + flags its checks read.
  achievements: string[];
  // Achievement ids whose loot box hasn't been opened yet (see
  // claimAchievementLootBox) — claimed only from a Safe Room's ACHIEVEMENTS
  // tab. Optional for old-save/snapshot compat; makePlayer initializes [].
  unclaimedAchievements?: string[];
  goldSpent: number; // cumulative shop spending this run
  kills: number; // cumulative kill credit (killing blows) this run
  killsThisStep: number; // transient: kills credited to this player this step
  lowHpKill: boolean; // transient: killed something while below 10% HP

  // Crafting materials (spent at the safe-room bench).
  materials: Record<MaterialId, number>;

  // Cumulative combat stats for this run.
  damageDealt: number;
  damageTaken: number;
  /** WHO LANDED THE LAST HIT, and the numbers the post-run screen needs.
   *  state.hits is a per-tick render buffer wiped at the top of every step
   *  (game.ts), so this Player field is the sim's ONLY memory of an attacker.
   *  The replay verifier reads it at the death tick and writes the named death
   *  onto the run row (COMPETITIVE.md 2.5.5 / 6 Beat 3) - no client assertion,
   *  no crowd-guessing heuristic. Pure data; no rule ever reads it. */
  lastHitSrc?: LastHitSrc;

  // Active status effects on this crawler (poison from acid, chill auras).
  // Optional for old-save/snapshot compat; reset every floor.
  statuses?: StatusEffect[];

  // The Show, PER CRAWLER: everyone runs their own broadcast. Your crits and
  // kills grow YOUR audience; your near-death moments are your ratings gold.
  hype: number; // excitement meter (decays)
  viewers: number; // live audience count
  favorites: number; // sticky fans
  sponsors: number; // backers earned at favorite thresholds

  // CLASS REVISIONS taken (revisions.ts ids; "uncast" once per declined offer).
  // Optional for old-save/snapshot compat; makePlayer initializes [].
  revisions?: string[];
  // First-contact System tips already delivered (tips.ts ids) — each rule is
  // explained exactly once, the first time it touches this crawler.
  tipsSeen?: string[];
  // The System's boredom bookkeeping (interference): seconds of hype flatline,
  // and how many times it has intervened without a hype recovery between.
  boredT?: number;
  boredTier?: number;
  petUsed?: boolean; // PRODUCER'S PET: the once-per-floor save spent (resets each floor)

  // GLYPHS (ITEMIZATION-V2 §3): sockets live on the SLOT, not the ability —
  // slots[i] mirrors abilities.slots[i] (2 sockets each; unlock by level),
  // ultimate has 1, and the bench holds unsocketed finds. Optional for
  // old-save/snapshot compat; grantGlyph/socketGlyph default-init it.
  glyphs?: {
    slots: (GlyphId | null)[][];
    ultimate: (GlyphId | null)[];
    bench: GlyphId[];
  };
  // Slipstream glyph: seconds of post-movement surge remaining (speed+damage).
  slipstreamT?: number;
  // Executioner's Rebate (rule 8): the per-cast refund window + budget.
  // Transient combat state (same pattern as meleeComboT) — reset each floor.
  rebateAbility?: AbilityId;
  rebateT?: number; // seconds left in which a kill still refunds
  rebateBudget?: number; // refund budget remaining for THIS cast
  rebateCd0?: number; // the cooldown value set at cast (refund basis)
  // Rootcutter Shears (boss unique): melee hits since the last snare proc.
  shearsCount?: number;

  // ---- ABILITIES-V2 transient combat state ----
  // Every one of these is OPTIONAL with a load-time default and reset per
  // floor, exactly like slipstreamT / rebateT. Old saves and old snapshots
  // load with them absent and behave as they did before.
  /** Sponsor Barrage: seconds left of the directed channel, and where it walks. */
  barrageT?: number;
  barrageAim?: Vec2;
  barrageNext?: number; // seconds until the next shell drops
  /** Bulwark: seconds of brace left, what it has soaked, and how many hits landed. */
  bulwarkT?: number;
  bulwarkAbsorbed?: number;
  bulwarkHits?: number;
  /** SPITE: absorbed damage riding on the next attack. */
  spiteBank?: number;
  /** Injunction: seconds of stay left and the clock debt it owes on release. */
  injunctionT?: number;
  injunctionDebt?: number;
  /** Orbit's hurl: the ring is away (out then back); no aura until it returns. */
  orbitHurlT?: number;
  orbitHurlDir?: Vec2;
  orbitHurlOut?: boolean;
  orbitHurlHits?: number[]; // monster ids already hit by the current pass
  /** Crossguard: seconds until the ring can parry again. */
  orbitGuardT?: number;
  /** Blindside charges (Second Take), like dash's. */
  cutCharges?: number;
  /** Static Charge: casts made per ability, for the every-3rd counter. */
  glyphCastCount?: Partial<Record<AbilityId, number>>;
  /** Stunt Double's Cue: the swap already spent on the current contract. */
  doubleCueUsed?: boolean;
  /** R4: the power of the free swap-strike currently resolving (1 = settled,
   * stanceFlowStrikeMult = ungated by Flow). Transient, one call deep. */
  stanceStrikeMult?: number;
}

// Elite affixes: one bonus mechanic a named elite can roll (see spawnMonsters).
export type EliteAffix =
  | "swift" | "shielded" | "volatile" | "summoner" | "splitter" | "thorns"
  // School resists (DESIGN 5.8 phase 3): the party's damage MIX starts
  // mattering — a warded elite pack is the crossbow crawler's fight.
  | "armored" // takes reduced PHYSICAL damage
  | "warded" // takes reduced MAGIC damage
  // The six-pack (MOB-CONCEPTS.md) — each is one sentence of counterplay:
  | "linked" // its pack SOAKS its damage while any ally stands — thin the pack
  | "vampiric" // heals off landed hits — don't get hit and it starves
  | "juggernaut" // immune to stagger + knockback, slower — kite, don't CC
  | "mortar" // lobs arcing shells over walls — cover stops being safe
  | "berserking" // below half HP: faster everything — finish what you start
  | "executioner" // hits crawlers under 40% HP harder — retreat thresholds are real
  | "chilling"; // radiates a cold aura that SLOWS crawlers inside it

// ---- Status effects (burn / poison / chill) ----
// Deterministic, dt-ticked entries living on the afflicted entity (monster or
// player). Apply/stack/tick rules live in status.ts; DoT damage flows back
// through the damageMonster/damagePlayerHit choke points in game.ts so
// schools, resists, armor, and hit events compose for free.
export type StatusKind = "burn" | "poison" | "chill";

export interface StatusEffect {
  kind: StatusKind;
  remaining: number; // seconds until the effect fades
  // burn/poison: damage per tick PER STACK; chill: fraction of speed removed
  // (move + attack/windup — a chilled entity experiences slowed time).
  magnitude: number;
  stacks: number; // poison stacks up to poisonMaxStacks (each adds); others stay 1
  tick: number; // DoT only: seconds until the next damage tick
  school: School; // DoT school (burn = magic, poison = physical) — resists apply
  sourceId?: number; // player id credited with monster-side DoT kills
}

// Band-end boss signature mechanics: ONE themed ability per arena, layered on
// the shared boss kit (set at spawn from the floor's band — see spawnMonsters).
export type BossSignature = "graverising" | "flood" | "roots" | "debris" | "flamewall";

// ---- BOSSES V2 (BOSSES-V2.md) ---------------------------------------------
// The problem this section solves is "the same boss appears every run". A
// run's lineup is DRAWN, not scripted: each band-end floor picks one of three
// candidates from a dedicated hash of (runSeed, band) — never from state.rng,
// so the floor's spawn stream stays byte-identical to the fixed-boss baseline
// (the same discipline assignRoomPurposes already uses). See bosses.ts.

/** What a fight ASKS the player to do (BOSSES-V2 §2.1). One per boss; a boss
 *  whose ask you cannot name in four words is a big monster with more HP. */
export type BossAsk =
  | "lane" // dodge-the-lane: read a locked line, step perpendicular
  | "shield" // break-the-shield: burst a targetable thing on a timer
  | "adds" // kill-the-adds: retarget under pressure, kill order
  | "arena" // use-the-arena: move the fight to good ground
  | "window" // burst-the-window: recognize and unload in a punish beat
  | "storm"; // survive-the-storm: sustain and reposition through a phase

/** The 18-strong band-boss roster (three candidates per band). */
export type BossId =
  // THE UNDERCROFT (floor 3) — the teaching band, no mutators
  | "concierge" | "rentcollector" | "temp"
  // THE SEWERS (floor 6) — pressure and ground
  | "sumpking" | "inspector" | "greasetrap"
  // THE GARDEN (floor 9) — shields and swarms
  | "topiary" | "zoningboard" | "pollinator"
  // THE RUINS (floor 12) — the arena fights back
  | "architect" | "permitoffice" | "foundation"
  // THE IRONWORKS (floor 15) — rhythm and machinery
  | "marshal" | "linesupervisor" | "safetyofficer"
  // THE APPROACH (floor 18) — the finale finally has a name
  | "showrunner" | "standards" | "sponsor";

/** Affix-style layers that change the ASK, never the numbers (§4.2). */
export type BossMutator =
  | "entouraged" // arrives with a champion-grade escort
  | "unionrules" // its adds get back up once, on a delay
  | "sponsored" // a hazard-immune bubble it must be pulled out of
  | "overtime" // hard enrage starts at 40% of the normal deadline
  | "retrofit" // swaps its band signature for a different band's
  | "understudied" // its plates/shield come back once, at 50%
  | "liveaudience" // the arena gains crowd-thrown hazards on a rhythm
  | "redacted"; // shorter telegraphs, but it announces its next move

/** Seeded arena layouts (§4.3). A boss's `arenas` list constrains the draw. */
export type ArenaVariant =
  | "pillared" // dense destructible cover; line-of-sight play
  | "open" // no cover, wider; favors lanes and storms
  | "split"; // a hazard band divides the arena; favors routing

/** What advanced a phase. At least one phase per fight is "mechanic" — the
 *  player's PLAY, not their damage, moved the story (§2.2). */
export type BossPhaseReason = "hp" | "mechanic" | "timer" | "positional";

/**
 * BREAKABLE PLATE / WEAK POINT (verb V1): a targetable sub-object on a boss
 * with its own HP. While an unbroken plate stands the boss itself takes only a
 * fraction of incoming damage; breaking one is a mechanic-triggered phase
 * edge. A plate with a `school` IGNORES that school entirely — the build check.
 */
export interface BossPlate {
  key: string; // stable id (renderers anchor a mesh to it)
  label: string; // announcer / health-plate label
  hp: number;
  maxHp: number;
  angle: number; // radians around the boss — where the plate hangs
  school?: School; // damage of this school does NOTHING to this plate
  broken?: boolean;
}

/**
 * Typed boss beats for the presentation layer (BOSSES-V2 §5). Same contract as
 * state.hits / state.announcements: the sim emits DATA, hosts turn it into
 * camera moves, name cards, stingers, and FX. Transient — cleared at the top
 * of every step, exactly like hits.
 */
export interface BossEvent {
  kind:
    | "intro" // the encounter's identity is known (name card / mutator tag)
    | "phase" // a phase edge crossed (carries the reason)
    | "plate" // a plate broke
    | "shieldbreak" // the shield pool emptied
    | "punish" // the boss over-committed and self-staggered — UNLOAD
    | "intermission" // briefly untargetable while the board is re-dealt
    | "enrage" // the hard-enrage deadline passed (stacking)
    | "telegraph" // a named signature is committing (must read in 0.2s)
    | "prop"; // an interactive arena prop fired
  monsterId: number;
  bossId?: BossId;
  phase?: number;
  reason?: BossPhaseReason;
  label?: string; // human name of the plate / telegraph / prop / mutator
  pos?: Vec2;
  value?: number; // plates left, shield fraction, enrage stacks...
  duration?: number; // seconds the beat lasts (punish window, intermission)
}

// Enemy archetypes. Each spawns with distinct stats + behavior (see ai.ts / config.ts).
export type MonsterKind =
  | "grunt" | "swarmer" | "brute" | "ranged" | "boss"
  | "bomber" | "shaman" | "phantom"
  | "charger" | "spitter" | "necromancer"
  | "broodmother"
  // SEWERS specialists (MOB-CONCEPTS.md): the Drum Sergeant frenzies its pack
  // (kill-order lesson); the Repo Rat is a fleeing loot-goblin (chase lesson).
  | "drummer" | "filcher"
  // IRONWORKS specialists (floors 13-15): the machine learns your timing.
  // lineworker: piston punch that LAUNCHES you. sentinel: lock-on tracking
  // beam (juke at the click, not before). slagbreaker: three swings then a
  // forced scalding vent + self-stagger (count, dodge, punish). toysoldier:
  // squads that volley AS ONE. greeter: dormant among the props, sparks on death.
  | "lineworker" | "sentinel" | "slagbreaker" | "toysoldier" | "greeter"
  // GARDEN specialists (floors 7+): the floor fights back. lasher: whip-HOOK
  // along a lane that DRAGS you to it. understudy: a weak shuffler that
  // TRANSFORMS into a full charger at half HP (stagger the morph or burst it).
  // hexer: curses a crawler with a vulnerability mark the pack exploits.
  | "lasher" | "understudy" | "hexer"
  // UNDERCROFT trainers (floor 2+ — floor 1 stays pristine): cutpurse lunges
  // down a short lane and STEALS gold (killing it refunds with interest).
  // warden: a slow bone golem whose slam leaves a shard zone. digger: a huge
  // club tell that LAUNCHES you gently — knockback in training dosage.
  | "cutpurse" | "warden" | "digger"
  // RUINS cast (floors 10+): the dead civilization drills you. shieldbearer:
  // near-immune from the FRONT while its guard holds (make it swing, or go
  // around). cleric: consecrates ground that heals monsters and burns you.
  // archivist: channels a SWEEPING beam — dodge continuously or stagger it.
  // colossus: its slam sends a fissure travelling down a lane.
  | "shieldbearer" | "cleric" | "archivist" | "colossus"
  // THE APPROACH (floors 16+): the System fields its own. stagehand: blinks
  // in, two hits, smoke-bombs out to a MARKED re-entry. sniper: cross-room
  // lanes, relocates after every shot. duelist: riposte flourish — hold your
  // swing or shoot it. darling: shields her entourage while SHE takes extra
  // (the kill order is stated; execution is the exam). canceled: a former
  // favorite running player verbs. suitactor: dies and UNZIPS — the suitguy
  // flees; sparing him pays more hype than the kill.
  | "stagehand" | "sniper" | "duelist" | "darling" | "canceled"
  | "suitactor" | "suitguy"
  // CHAMPION tier (MOB-CONCEPTS boss layer 1): mini-boss fights between the
  // named elites and the band bosses. The Foreman pilots the tier.
  | "foreman";

export interface Monster {
  id: number;
  kind: MonsterKind;
  pos: Vec2;
  hp: number;
  maxHp: number;
  damage: number;
  speed: number;
  attackRange: number; // contact range (melee) or preferred standoff (ranged)
  attackCooldown: number; // melee swing / ranged shot cooldown remaining
  shootCd: number; // secondary timer: boss radial volley
  healCd: number; // shaman: seconds until it can heal a wounded ally again
  blinkCd: number; // phantom: seconds until its next blink toward a player
  xp: number;
  // Attack telegraph: while windup > 0 the monster is committed to an attack
  // that lands when it expires (see ai.ts). Hosts render the tell; players
  // dodge out of range or through it with dash i-frames.
  windup: number; // seconds until the pending attack resolves (0 = none)
  windupTotal: number; // full length of the pending windup (render progress)
  // "slam": self-centered ground AoE (brute's signature hit, also a boss ability).
  // "ritual": boss-tier-3 channelled cast — the game's one real interrupt-or-hurt stake.
  // "punch": lineworker melee that also LAUNCHES the target (knockback verb).
  // "aim": sentinel's lock-on — the beam hazard does the damage; the windup
  // just holds the aiming pose. "vent": slagbreaker's forced heat dump.
  // "hook": lasher whip along the chargeDir lane — hits get DRAGGED in.
  // "morph": understudy transformation (interruptible; it becomes a charger).
  // "hex": the Briar Witch's vulnerability curse on the nearest crawler.
  // "lunge": cutpurse dash-stab down the chargeDir lane; a hit STEALS gold.
  // "consecrate": cleric ground-blessing (heals monsters, burns crawlers).
  // "sweep": archivist beam channel — the hazard rotates while this holds.
  // BOSSES V2 adds exactly FOUR new kinds, on purpose — everything else the
  // roster does reuses a shipped windup with a per-boss branch, the way the
  // colossus already branches inside "slam":
  // "punish": the universal boss OVER-COMMIT (V4) — one scalding beat, then a
  // genuine self-stagger. This is the counterplay window every shipped boss
  // was missing. "latefee": The Rent Collector's seizure (opens its lockbox
  // plate). "bloom": The Pollinator seeds armed spore pods. "pull": The Grease
  // Trap's rhythmic, uncapped drag toward a boss that never moves.
  windupKind?: "melee" | "shot" | "fuse" | "charge" | "spit" | "raise" | "slam" | "ritual"
    | "punch" | "aim" | "vent" | "hook" | "morph" | "hex" | "lunge"
    | "heal" | "summon" | "consecrate" | "sweep"
    | "punish" | "latefee" | "bloom" | "pull" | "regrow"; // what resolves when windup expires
  healId?: number; // shaman: the ally committed to at heal-channel start
  // Charger: while chargeT > 0 the monster is mid-rush along chargeDir,
  // plowing through players (each hit at most once per charge).
  // (The lasher's hook also locks its lane here — one dir field, two verbs.)
  chargeDir?: Vec2;
  chargeT?: number; // seconds of rush remaining
  chargeHits?: number[]; // player ids already hit by this charge
  // Spitter: where the committed lob will land (locked at windup start).
  spitTarget?: Vec2;
  // Necromancer: the corpse it committed to raising (may expire mid-windup).
  raiseId?: number;
  // Stagger: hit reactions. Damage accumulates as poise damage; crossing the
  // archetype's poise threshold interrupts the windup and freezes the monster.
  // Poise DRAINS over time (interrupts take a burst, not banked chip damage),
  // and bosses/elites gain a post-stagger grace window (no stun-locking).
  stagger: number; // seconds of stagger remaining (helpless while > 0)
  poiseDmg: number; // damage accumulated toward the next stagger
  staggerGraceT?: number; // seconds of post-stagger composure left (bosses/elites; optional for save compat)
  // transient render flag: seconds remaining to show a hit flash
  hitFlash: number;
  lastHitBy?: number; // player id credited with the killing blow (loot boxes)
  elite?: boolean; // neighborhood boss: beefed-up named archetype with loot
  veteran?: boolean; // the middle rung: a pack's long-surviving heavy anchor — bigger, tougher, no name/affix/fanfare
  eliteName?: string; // announcer name for elites and city bosses
  defId?: string; // crafted enemy (src/content/mobs): stats applied at spawn; hosts resolve skin/tint from the def
  // System bounty (interference tier 1): seconds left to collect + the purse.
  bountyT?: number;
  bountyGold?: number;
  // Elite affix: one extra mechanic per named elite (rolled at spawn, floor 3+).
  affix?: EliteAffix;
  affixCd?: number; // summoner: seconds until the next summon
  summons?: number; // summoner: lifetime adds spawned (capped)
  phase?: number; // boss enrage tier already applied (0..2)
  // Boss-tier kit escalation, layered on the universal boss behavior (phase
  // adds waves + hazard rain, backlog #11): 1 = floor-6 city boss (Ground
  // Slam), 2 = floor-12 city boss (slam cycles faster), 3 = final boss
  // (+ Dark Ritual). Every tier keeps the abilities of the ones below it.
  bossTier?: 1 | 2 | 3;
  slamCd?: number; // boss only: seconds until Ground Slam can commit again
  ritualCd?: number; // boss tier 3 only: seconds until Dark Ritual can cast again
  // Band-end boss signature mechanic (one per arena, themed to the band).
  signature?: BossSignature;
  // Seated resident of a dressed room (roomPurposes phase 5): first damage
  // to the pack announces the purpose's interruption line, once per floor.
  residentOf?: string;
  // Staging v2: spawned ON one of the plan's seat slots — the renderer plays
  // the chair-sit instead of the floor-sit for this actor.
  seated?: boolean;
  sigCd?: number; // seconds until the signature can fire again
  sigUsed?: boolean; // the first-cast announcer line already played
  // Signature STACKING (boss layer 2): from phase 1 the boss alternates its
  // own signature with the PREVIOUS band's — fights escalate in mechanics.
  sigAlt?: boolean;
  // THE DUO (boss layer 4): members share a duoId; when one dies the
  // survivor ENRAGES — permanent frenzy, hotter hits, and a grudge.
  duoId?: number;
  enraged?: boolean;
  introduced?: boolean; // ringside introduction already played (bosses/elites)
  exploded?: boolean; // bomber: detonation already fired (prevents a double blast)
  hasKey?: boolean; // carries the key to the locked stairs district (drops it on death)
  // Ambush (deep floors): a dormant monster lies inert until a player strays
  // near, then springs — the whole cluster wakes together with a speed surge.
  dormant?: boolean; // waiting in ambush: no move, no attack, until sprung
  surgeT?: number; // seconds of ambush speed-surge remaining (the pounce)
  // Active status effects (optional so old snapshots/tests stay valid).
  statuses?: StatusEffect[];
  // Roaming (see wander in ai.ts): off-duty patrol around a leashed post.
  // VARIETY is the point: lone wanderers always roam, some packs patrol
  // together, the rest are sentries that hold their post (and ambushers lie
  // perfectly still). Rolled at spawn.
  roams?: boolean; // this monster patrols when off-duty (absent = sentry)
  home?: Vec2; // patrol post (set the first time the monster goes off-duty)
  wanderDir?: Vec2; // current stroll heading (undefined = standing a beat)
  wanderT?: number; // seconds left on the current wander leg
  // Generalized monster auras (MOB-CONCEPTS.md verb): a carrier buffs every
  // pack-mate in radius each step. "frenzy" = the Drum Sergeant's war-drum
  // (allies move + attack faster while the beat holds). Chilling remains its
  // own elite affix — auras here are ally-facing.
  // "frenzy" = the Drum Sergeant's beat; "shield" = the Darling's stardust
  // (her entourage takes less while SHE takes more — kill-order pressure).
  aura?: "frenzy" | "shield";
  // Boss anti-kite: seconds spent out of melee reach (chase speed ramps past
  // a patience delay; contact resets — see the boss branch in ai.ts).
  chaseT?: number;
  chaseVexed?: boolean; // the one-per-orbit "done chasing politely" line fired
  frenzyT?: number; // seconds of drum frenzy remaining on THIS monster
  slipT?: number; // seconds of committed obstacle-rounding (flank bias suppressed)
  alertT?: number; // seconds of pursuit memory after losing sight of prey (LOS aggro)
  rushBeaten?: boolean; // drummer: this alarm's CHARGE was already beaten (one surge per alarm)
  regroupT?: number; // seconds left of bolting-for-reinforcements flight
  regrouped?: boolean; // one retreat per lifetime — a survivor that found nobody dies where it stands
  shieldT?: number; // seconds of Darling stardust remaining on THIS monster
  // Featured Extra (duelist): seconds of riposte FLOURISH remaining — melee
  // into it reflects; wait it out or answer with ranged/magic.
  riposteT?: number;
  // Stagehand: mid-vanish bookkeeping — seconds until the marked re-entry,
  // and where the smoke clears.
  vanishT?: number;
  reentryAt?: Vec2;
  // Filcher (Repo Rat): the gold it carries — bleeds out as it's damaged,
  // drops the rest on death, and leaves with ALL of it if the rat escapes.
  carry?: number;
  bleedStage?: number; // HP quarters already bled (3 -> 2 -> 1)
  fleeT?: number; // seconds spent safely away from every crawler (escape timer)
  escaped?: boolean; // reap as an escape, not a kill (no XP, no corpse, no loot)
  noticed?: boolean; // the "a rat!" event already fired
  // Slagbreaker: swings landed since the last vent (3 forces the heat dump).
  heat?: number;
  // Ruins cleric: where the committed consecration will land (locked at cast).
  consecrateAt?: Vec2;
  // Wind-Up Battalion: members sharing a squadId hold their musket windups
  // until the whole squad is ready, then FIRE AS ONE (see toysoldier in ai.ts).
  squadId?: number;
  tribe?: string; // Roam-only: which TribeId this monster belongs to, for quest kill-credit
  // Brandmark glyph: seconds of BRAND remaining, the ability that stamped it,
  // and the crawler whose OTHER abilities cash it in (+12%).
  brandT?: number;
  brandAbility?: AbilityId;
  brandBy?: number;

  // ---- ABILITIES-V2 ----
  /** STAGE CABLES: seconds of PIN remaining. Respected in ai.ts's MOVEMENT
   * step only — a pinned enemy cannot close, but it can still finish a windup.
   * The pin is control; Breaker is the stun, and the two must never overwrite
   * each other's bookkeeping (which is why this is not `stagger`). */
  pinnedT?: number;
  /** Seconds until this body can be pinned again (no perma-lock). */
  pinLockT?: number;
  /** Open Season: seconds of +vulnerability left after a Breaker stagger. */
  vulnT?: number;
  vulnBonus?: number;
  /** Smoke Break: seconds of blindness — the monster drops its current target. */
  blindT?: number;
  /** Injunction: this body is enraged by the stay (and Contempt can strip it). */
  injRageT?: number;

  // ---- BOSSES V2 -----------------------------------------------------------
  // Which roster entry this boss IS (drawn per band from the run seed). Drives
  // the per-boss ability block in ai.ts, the name card, and the drop hook.
  // Absent on pre-V2 snapshots and on every non-boss monster.
  bossId?: BossId;
  // Encounter mutators layered on top (never on floor 3; one from 6-12; up to
  // two from 15). A mutator changes what the player DOES, never the numbers.
  bossMutators?: BossMutator[];
  // Breakable plates / weak points (V1). Targeted before the boss body; while
  // any unbroken plate stands the boss body takes plateBossDamageMult.
  plates?: BossPlate[];
  // Boss SHIELD POOL (V2): absorb-HP in front of the health bar. It regrows
  // after shieldRegenDelay seconds without damage — burst it inside the gap.
  shieldHp?: number;
  shieldMax?: number;
  shieldRegenT?: number; // seconds until regeneration resumes
  shieldSchool?: School; // set: ONLY this school erodes the pool (The Sponsor)
  // INTERMISSION (V6): briefly untargetable while the arena re-deals.
  invulnT?: number;
  // ADD TETHER (V8): this monster is linked to the boss with this id — it
  // feeds/shields it until killed, and hosts draw the cord.
  tetherId?: number;
  tetherRevived?: boolean; // UNION RULES: this add already used its one revival
  // HARD ENRAGE (V5): seconds this fight has been live, and how many enrage
  // stacks the deadline has handed out. A ceiling on fight length, not a
  // fail-state — it should almost never fire for a competent player.
  fightT?: number;
  enrageStacks?: number;
  // Punish window (V4): `heat` (shared with the slagbreaker's gauge) counts
  // committed signatures; the window itself is plain `stagger`, so every
  // existing "the boss is helpless" rule composes for free.
  punishArmed?: boolean;
  // Phase machine: the last reason a phase advanced, and the cap. Bosses run
  // 0..2 (band) or 0..3 (finale); mechanic/timer/positional triggers share the
  // same counter as the HP gates so the fight never double-counts a beat.
  phaseReason?: BossPhaseReason;
  maxPhase?: number;
  // The Rent Collector's lockbox: gold seized from the party, refunded WITH
  // INTEREST when the lockbox plate breaks.
  lockbox?: number;
  // Per-boss scratch counters (adds killed toward a mechanic phase, pods
  // seeded, conveyors left...). Two generic fields, because every kit needs
  // about one and eighteen bespoke fields is how a Monster grows to 200 keys.
  bossCount?: number;
  bossTimer?: number; // seconds
}

// Roam-only: a settlement resident. Static, unarmed, no AI. `role` drives
// dialogue content + services (npc.ts); absent on v1 snapshots (treated as
// a plain elder). The guide role is Mordecai — present in every entrance
// settlement.
export type NpcRole = "guide" | "trader" | "quartermaster" | "rumor" | "elder";

export interface Npc {
  id: number;
  pos: Vec2;
  name: string;
  kind: "settlement";
  role?: NpcRole;
  settlementId?: number; // which Settlement this resident belongs to
  portraitId?: string; // host portrait art key (defaults to the role)
}

// Roam-only: a friendly settlement — a sanctuary room (monsters won't path
// in; see isWalkableForMonster) with residents, a vendor shelf, and safe-room
// services (heal, ability re-slot). The vendor reuses the SafeRoom shape
// verbatim so buyCatalogItem/sellItem work unchanged (shopRoomFor falls back
// to the settlement the player is standing in).
export interface Settlement {
  id: number;
  name: string;
  roomIdx: number; // index into map.rooms
  entrance: boolean; // the settlement nearest spawn (Mordecai lives here)
  npcIds: number[];
  shop: SafeRoom; // nextFloor = the CURRENT floor (price basis); ready unused
}

// Roam-only NPC dialogue: its own channel, deliberately separate from
// state.announcements (VOICE.md reserves that surface for the System's
// voice — settlement voices are a third register, carved out like the
// safe-room manager tips were). Emitted by startDialogue/chooseDialogue in
// npc.ts; hosts render the panel and call chooseDialogue with a choice id.
export interface DialogueLine {
  speaker: string;
  text: string;
}

export type DialogueEffect =
  | "acceptQuest" // questKey: offered -> active (may spawn objective props)
  | "turnIn" // questKey: active+done -> complete, rewards via pendingRewards
  | "vendor" // host signal: open the settlement shop (session.open)
  | "reslot" // host signal: open the loadout panel (session.open)
  | "heal" // pay `price` gold: full heal + cleanse (safe-room service in-map)
  | "rumor" // pay `price` gold: the stairway ping + revealed ground
  | "orient" // guide only: what this floor holds; reveals settlement regions
  | "tip" // guide only: first-time advice (gated by Player.tipsSeen)
  | "farewell"; // close the session

export interface DialogueChoice {
  id: string;
  label: string;
  effect: DialogueEffect;
  questKey?: string; // acceptQuest / turnIn
  price?: number; // heal / rumor: gold cost (UI shows it; sim charges it)
}

export interface DialogueSession {
  id: number;
  playerId: number; // whose session this is (one active session per state)
  npcId: number;
  npcName: string;
  portraitId: string;
  settlementId: number;
  lines: DialogueLine[];
  choices: DialogueChoice[];
  open?: "vendor" | "reslot"; // host signal set by the matching choice
  done?: boolean; // farewell chosen — hosts close the panel
}

// Roam-only quest objectives — the five archetypes. killTribe is the floor's
// anchor quest; clearStronghold is appended once killTribe turns in (floors
// with a stronghold); the rest are rolled per floor from different NPCs.
export type QuestObjective =
  | { kind: "killTribe"; tribe: string; target: number; killed: number }
  | { kind: "clearStronghold"; leaderName: string }
  // Recover a cache from the vault room (the prop spawns on accept).
  | { kind: "cache"; roomIdx: number; recovered: boolean }
  // Deliver a parcel to a named resident of ANOTHER settlement; turn-in
  // happens at the recipient, not the giver.
  | { kind: "delivery"; toNpcId: number; toName: string; toSettlementId: number; cargo: string; delivered: boolean }
  // Light every beacon (walk to each spot while the quest is active).
  | { kind: "beacons"; spots: { x: number; y: number; lit: boolean }[] };

export interface Quest {
  id: number;
  // Stable identity for save round-trips (quest generation is deterministic
  // per (seed, floor), so a key matches across rebuilds). Absent on v1 saves.
  key?: string;
  giverNpcId?: number;
  title?: string;
  objective: QuestObjective;
  state: "offered" | "active" | "complete";
}

export type LootKind = "gold" | "heal" | "item" | "tome" | "key" | "material" | "shrine" | "service" | "cache" | "glyph";

// Crafting materials, dropped by named menaces and spent in the System Shop
// on legendary signature gear (see catalog.ts). refit_shard is the V2
// dismantle/refit currency ("Scrap Certification") — see dismantleItem.
export type MaterialId = "elite_trophy" | "boss_sigil" | "refit_shard";
export type Rarity = "common" | "magic" | "rare" | "epic";
// Six-slot ARPG spread (backlog #10): weapon/armor carry the build's spine,
// helm/boots are supporting armor pieces, trinket/charm are the two accessory
// sockets. An item's slot IS its socket — no shared-socket special cases.
export type ItemSlot = "weapon" | "armor" | "helm" | "boots" | "trinket" | "charm";

/** Every equipment socket, in paper-doll display order. The ONE list all
 * slot iteration derives from (stats, shop, UI, save migration). */
export const EQUIP_SLOTS = ["weapon", "armor", "helm", "boots", "trinket", "charm"] as const;

export type Equipment = Record<ItemSlot, Item | null>;

// Stat modifiers granted by an equipped item. All optional; summed across equipment.
export interface Affixes {
  damage?: number; // attack power (physical school)
  spell?: number; // spell power (magic school)
  maxHp?: number;
  speed?: number; // tiles/sec
  crit?: number; // added crit chance (0..1); crit serves BOTH schools
  armor?: number; // flat armor; mitigates incoming hits via armor/(armor+K)
}

// Unique behaviors carried by LEGENDARY signature gear (sponsor-gated shop
// purchases). Implemented as hooks in game.ts; one id = one behavior.
export type PassiveId =
  | "showrunner" // kills feed the broadcast: bonus hype per kill
  | "blastplate" // your dash detonates at the launch point
  | "ledger" // kills pay bonus gold + banked gold earns interest each safe room
  | "overtime" // ultimate cooldowns reduced
  | "tempo" // active-ability cooldowns reduced (legendary caster staff)
  // CHASE passives (store-only legendaries): each one warps a specific build
  // around itself — the reason you planned three shops ahead.
  | "encore" // +1 orbit blade; blades tick faster
  | "skewer" // bolts pierce +2
  | "choreography" // swapping Battle Stance grants bonus crit for the surge window
  | "plot_armor" // once per floor, a killing blow leaves you at 1 HP
  // Novel mechanics that ONLY exist on these items — no tree, no drop:
  | "leech" // lifesteal: heal a fraction of the damage you deal
  | "cancellation" // executes: non-elite monsters below a threshold just die
  | "conduit" // crits arc a fraction of the hit to a nearby enemy (magic)
  | "phase" // your dash passes through walls when it can reach the far side
  | "pathfinder" // the stairs are marked on your minimap, explored or not
  | "venom" // crits inject a poison stack (the only lootless poison source)
  // COMPLETED-work passives (ITEMIZATION-V2 §2.3) — every T2 says something:
  | "longarm" // Pikeman's Rebuttal: melee hits from range knock the target back
  | "wrecker" // Demolition Permit: your stagger-breaking hits deal +40%
  | "served" // Court Order: bolts against UNALERTED monsters always crit
  | "rent" // Slumlord's Deposit: monsters drop +20% gold
  | "chaser" // Ambulance Chaser: heal 3% of damage dealt (per-hit cap)
  | "grounded" // Grounded Suit: above 70% HP, +15% spell power
  // BOSS UNIQUES (§2.5) — drop-only, one per band boss:
  | "denycorpse" // Front Desk Bell: kills leave NO corpses; each pays gold + HP
  | "sumpcrown" // Sump Crown: ground hazards halved; your chill/poison last longer
  | "snare3" // Rootcutter Shears: every 3rd melee hit SNARES the target
  | "unmoved" // Loadbearing Girder: knockback immune; mitigation shards back
  | "spreadburn"; // Furnace Draft: enemies that die burning pass the burn on

export interface Item {
  id: number;
  slot: ItemSlot;
  rarity: Rarity;
  name: string;
  affixes: Affixes;
  passive?: PassiveId; // present on legendary signature gear only
  // Set when this item came from the System Shop catalog: it can be consumed
  // as a build-path component (see buyCatalogItem). Dropped loot has none.
  catalogId?: string;
}

export interface Loot {
  id: number;
  pos: Vec2;
  kind: LootKind;
  amount: number; // gold value or heal amount
  item?: Item; // present when kind === "item"
  rarity?: Rarity; // convenience for render tint (mirrors item.rarity)
  ability?: AbilityId; // present when kind === "tome": the ability it teaches
  material?: MaterialId; // present when kind === "material"
  service?: string; // present when kind === "service": the purpose taking customers
  glyph?: GlyphId; // present when kind === "glyph": the modifier stone inside
}

// The between-floors safe room / System Shop. While non-null, the sim is
// paused: buy from the catalog shelf, then leaveSafeRoom() drops the crawler
// onto `nextFloor`. The shelf (`available`) is a floor-gated, seeded subset of
// the static catalog (see generateSafeRoom in game.ts + catalog.ts).
export interface SafeRoom {
  nextFloor: number;
  available: string[]; // catalog ids purchasable in THIS shop
  tomeAbility?: AbilityId; // what today's Ability Tome teaches (absent = no tome)
  tip: string; // Mordecai-style manager advice about the next floor
  bonusTime?: number; // purchased stabilizer seconds, applied when the floor builds
  ready: number[]; // player ids who hit DESCEND; the party leaves when all are ready
  // Consumables have LIMITED per-shop stock now (scarcity — excess gold can no
  // longer buy an infinite HP graft). This counts what's been bought here.
  purchased: Record<string, number>; // catalogId -> units bought in this shop
  // Same-shop full refund (§4): item ids of GEAR bought in THIS shop sell
  // back at 100%. An item leaves the list the moment it is modified or
  // consumed — refit, dismantle, combine (as a component) — so the shop is an
  // undo button, never a bank or a shard mint. Optional: pre-V2 saves/snaps.
  boughtThisShop?: number[];
}

// Sponsor draft: a reward offered between floors. `apply` semantics live in game.ts.
// The pool is deliberately WIDE so no single stat is the every-floor pick:
// permanent stat gifts (damage/maxHp/crit/armor) diminish as you stack them,
// while build-variety gifts (item/materials/favor) never do.
export type RewardKind =
  | "healFull" | "maxHp" | "damage" | "crit" | "armor" | "item" | "gold" | "bonusTime"
  | "materials" // crafting material toward signature (legendary) gear
  | "glyph" // a sponsored ability-modifier stone (ITEMIZATION-V2 §3.1)
  | "favor" // an owed ability-upgrade draft (advances the constellation build)
  | "retrain" // unlearn one fork-side node; its ranks return as fresh drafts
  // System Shrine bargains (floor events — never in the sponsor pool):
  | "shrineBlood" // pay a slice of max HP now for permanent crit
  | "shrineGreed" // this floor's monsters speed up; its gold drops double
  | "shrineDecline" // walk away (the System notes the cowardice)
  | "shrineDraft" // Overtime Draft: the clock loses seconds, you gain an ability draft
  | "shrineLoan" // Time Loan: +seconds now; the NEXT floor starts shorter
  | "shrineLiquidate" // Liquidation Event: the shrine buys the whole bag at a premium
  | "shrinePremium" // Insurance Premium: a slice of gold for full heal + cleanse
  // SERVICE ROOMS (roomPurposes phase 4 — rare; at most one per floor):
  | "svcTemper" // the forge: gold for permanent damage, both schools
  | "svcDraught" // the apothecary: gold for full heal + cleanse
  | "svcWager" // the den: stake gold on a hand the house usually wins
  | "svcMap" // the archive: the floor's layout, filed and cross-referenced
  | "svcPlans" // the war room: the shortcuts are marked (+collapse time)
  // CLASS REVISION milestone drafts (revisions.ts — never in the sponsor pool):
  | "revision" // a permanent recasting with a built-in curse
  | "revisionDecline"; // REMAIN UNCAST (defiance pays a small permanent hype bonus)

export interface Reward {
  id: number;
  kind: RewardKind;
  title: string;
  desc: string;
  amount: number;
  item?: Item; // present when kind === "item"
  material?: MaterialId; // present when kind === "materials"
  glyph?: GlyphId; // present when kind === "glyph"
  nodeId?: string; // present when kind === "retrain": the node being refunded
  revisionId?: string; // present when kind === "revision": the casting on offer
  source?: "quest"; // Roam only: a settlement quest payout, not a sponsor gift (draft header)
}

// Projectiles: player bolts and enemy shots share one system.
export interface Projectile {
  id: number;
  pos: Vec2;
  vel: Vec2; // tiles/sec
  damage: number;
  ttl: number; // seconds before it despawns
  from: "player" | "enemy";
  ownerId?: number; // firing player's id (crit rolls + kill credit)
  pierce?: number; // remaining enemies this projectile can pass through (player bolts)
  hitIds?: number[]; // monsters already struck (so a piercing bolt hits each once)
  bounced?: boolean; // ricochet capstone: this bolt is already a bounce (no chains)
  forked?: boolean; // Splitfang glyph: this bolt is already a fork (no fork chains)
  crit?: boolean; // MOMENTUM capstone: this bolt crits on impact
  shatter?: boolean; // BREAKER (V2 R5): a banked bolt staggers non-bosses on impact
  /** BREAKER: this shot spent the bank, so Open Season / CHAIN REACTION fire. */
  breaker?: boolean;
  school?: School; // damage school (hosts tint magic missiles differently)
  chill?: number; // FROST BOLTS node: slow fraction applied on impact
  ability?: AbilityId; // casting ability (glyph hooks: brand/accelerant/arc-splice)
}

/** Axis-aligned room rectangle in tile coordinates (interior tiles only). */
export interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Room intent tags (mission-lite): every room means something. The sim uses
// them for spawn pacing and rewards; the renderer for rule-based dressing.
export type RoomRole =
  | "entrance" // spawn room: safe, no monsters
  | "stairs" // exit room (sealed by doors on deep floors)
  | "landmark" // the floor's big set-piece hall: pillars, the neighborhood boss
  | "vault" // off-path treasure detour: guaranteed loot + a guardian
  | "settlement" // Roam-only: a sanctuary room monsters won't enter, holds the NPC
  | "stronghold" // Roam-only: a hostile tribe garrison + named leader, not sanctuary
  | "combat"; // everything else

export interface FloorMap {
  w: number;
  h: number;
  tiles: Uint8Array; // row-major, length w*h, values from Tile
  // PHYSICAL FURNITURE (PHYSICALITY.md §1): a removable overlay — tiles the
  // dressing plan stamped with blocking furniture. isWalkable() consults it,
  // so players, monsters, dashes, drags, and the bot all inherit blocking
  // through the one choke point. Smashing the furniture clears its bits
  // WITHOUT a floor rebuild. Optional: pre-furniture snapshots lack it.
  blocked?: Uint8Array;
  spawn: Vec2; // player entry point
  stairs: Vec2; // stairs-down location
  rooms: RoomRect[]; // generated room rectangles (rooms[0] contains the spawn)
  roles: RoomRole[]; // intent tag per room (parallel to rooms)
  depths: number[]; // 0..1 progress along the critical path per room (pacing)
  cycles: number; // extra loop corridors carved beyond the spanning chain
  locked: boolean; // the stairs room is sealed behind DoorLocked tiles
  lockedRoomIdx: number; // index into rooms of the sealed stairs room; -1 when unlocked
  settlementRoomIdx: number; // the ENTRANCE settlement's room; -1 when not a Roam floor
  // ALL settlement rooms (2-4 per Roam megafloor; the first is the entrance
  // one). Optional: v1 snapshots carry only the singular field above.
  settlementRoomIdxs?: number[];
  strongholdRoomIdx: number; // index into rooms of the Roam hostile stronghold; -1 when none
  // Landmark set pieces carved into the GRID (tile indices; the tiles are
  // Wall): pillars/pedestal used to be walk-through renderer dressing —
  // "solid" props players clipped through. Now the sim blocks them and
  // renderers draw pillar/centerpiece models ON these tiles, so what the
  // floor SHOWS and what it BLOCKS agree.
  pillars: number[];
  pedestal: number; // centerpiece tile (-1 = none); OFF-center so the room center stays walkable
  // Crafted-room stamps (builder.html templates): where each template's
  // origin landed. Tiles are already merged into `tiles`; hosts use these to
  // place the template's cosmetic props (src/content/rooms).
  stamps?: { id: string; x: number; y: number }[];
}

export type RunStatus = "playing" | "dead" | "won";

// Seeded per-floor event (floors 2+, never on boss floors): at most ONE per
// floor, rolled at build time. Pure sim data — hosts only render/announce.
export type FloorEvent =
  // A shrine prop (carried in `loot` as kind "shrine"): touching it opens a
  // pick-1 bargain via the same pendingRewards plumbing as sponsor drafts.
  | { type: "shrine" }
  // The vault room is sealed at build; proximity springs it open for
  // `openT` seconds of sprint-for-loot, then it seals forever. `doors` are
  // the tile indices this event owns (the floor KEY never opens them).
  | { type: "vault"; roomIdx: number; doors: number[]; phase: "sealed" | "open" | "resealed"; openT: number }
  // A room-scoped dare: clear the tracked pack without ANY crawler taking a
  // hit. Activates when someone enters the room; pays gold + hype on success.
  | { type: "challenge"; roomIdx: number; phase: "offered" | "active" | "failed" | "cleared"; ids: number[]; gold: number; dmg0?: number };

// A scheduled ultimate impact: Sponsor Airstrike shells in flight, or
// Cataclysm's Aftermath echo. Absent fields fall back to airstrike-shell
// defaults in updateStrikes (echoes pre-compute their blast at schedule time).
export interface Strike {
  pos: Vec2;
  t: number; // seconds until impact
  ownerId: number; // caster (kill credit)
  kind?: "shell" | "echo";
  radius?: number;
  dmg?: number;
  knockback?: number;
  school?: School;
  /** Which ability scheduled this blast (V2 §3): echoes are no longer all
   * Cataclysm — the Reprise glyph schedules NOVA echoes too, and only a
   * Cataclysm echo may chain EXTINCTION. Also carries the glyph riders
   * (brand/accelerant) through to the delayed detonation. Optional: older
   * snapshots/saves read as the legacy "shell = airstrike, echo = cataclysm". */
  ability?: AbilityId;
}

// STUNT DOUBLE: a taunting copy of a crawler. Monsters in taunt range hunt it
// instead of players, their hits are ABSORBED (banked, never lethal — it's a
// professional), and the contract's end is an explosion proportional to what
// it soaked. The game's first friendly entity.
export interface Decoy {
  id: number;
  ownerId: number;
  pos: Vec2;
  facing: Vec2; // mirrored swings + rendering read this
  t: number; // seconds left on the contract
  absorbed: number; // damage soaked so far (feeds the farewell blast)
  // ABILITIES-V2 R8: the double is MORTAL. Optional so a pre-rework decoy in
  // flight (old snapshot) loads as invulnerable and expires normally.
  hp?: number;
  maxHp?: number;
  died?: boolean; // it was killed rather than expiring (AWARD SEASON reads this)
}

// A ringside introduction: set when the party first closes with a boss/elite.
// While non-null the WORLD IS FROZEN (like the safe room) so the reveal can't
// kill anyone; hosts render the intro splash + boss health bar from it.
export interface Encounter {
  monsterId: number;
  name: string;
  kind: MonsterKind;
  elite: boolean;
  affix?: EliteAffix;
  timeLeft: number; // seconds of freeze remaining
  total: number; // full intro length (render progress)
  // ---- BOSSES V2 name card (§5.3): title, epithet, ask, and the mutator tag
  // as DATA, so the host can build a designed card instead of a toast.
  bossId?: BossId;
  epithet?: string; // "MORTUARY FRONT DESK, EST. NEVER"
  ask?: BossAsk; // the one-word promise the fight makes
  mutators?: BossMutator[];
  line?: string; // this boss's one System line, deadpan, in its own voice
  // How many times this profile has already put it down. > 0 shortens the
  // freeze (§4.4) — a 2.2s beat you have seen ten times is a tax.
  repeat?: number;
}

// Enemy-side ground danger. Four shapes share the struct:
// - "blast" (default): a delayed one-shot — t counts down to detonation,
//   damage lands once on players still in radius (volatile elite corpses).
// - "puddle": a lingering zone (spitter lobs) — active for its whole life,
//   dealing `damage` to players inside every tick until t runs out.
// - "sludge": an ARMED pool (boss Flood Surge) — inert for the first `arm`
//   seconds (the telegraph), then ticks like a puddle until t runs out.
// - "roots": an armed zone (boss Entangling Roots) — after arming it SNARES
//   (heavy slow) players inside instead of damaging them.
export interface Hazard {
  id: number;
  pos: Vec2;
  t: number; // blast: seconds until detonation; zones: seconds of life left
  total: number; // full delay/duration (render progress)
  radius: number; // tiles
  damage: number; // blast: the hit; puddle/sludge: damage per tick
  // "shards": the Ossuary Warden's slam debris — a lingering ticking zone
  // like a puddle, but bone-physical (no poison soak).
  // "consecrate": the Ruins cleric's blessing — a zone that HEALS monsters
  // standing in it and burns crawlers (contested ground).
  // "fissure": FAULT LINE's broken ground (V2 U1) — a player-owned zone that
  // ticks and slows for its whole life. "cables": STAGE CABLES' line (V2 N2),
  // which pins on contact and leaves a slow field. Both carry ownerId so kill
  // credit and glyph riders route exactly like every other player damage path.
  // "spore": a BOSSES-V2 armed pod (The Pollinator) — it arms like sludge,
  // bites once when it blooms, and seeds children while the bloom is unchecked.
  // Hosts may draw it as a sludge-family decal until it gets its own dressing.
  kind?: "blast" | "puddle" | "sludge" | "roots" | "beam" | "shards" | "consecrate" | "fissure" | "cables" | "spore"; // absent = blast (older saves/snapshots)
  /** Player-owned zones (fissure/cables): the crawler who made the ground. */
  ownerId?: number;
  /** Player-owned zones: which ability owns it (glyph riders + kill credit). */
  ability?: AbilityId;
  /** Zones that SLOW rather than (or as well as) damage: fraction removed. */
  slow?: number;
  /** Cables: pin seconds applied on contact, and re-arms left (Taut). */
  pin?: number;
  rearms?: number;
  /** Fissure with Chasm: the center BLOCKS enemy pathing. */
  blocks?: boolean;
  flavor?: "flame" | "debris"; // blast dressing: fire wall / falling masonry (default: clown ordnance)
  tick?: number; // puddle/sludge: seconds until the next damage tick
  arm?: number; // sludge/roots/beam: telegraph seconds before it goes live
  // Beam (MOB-CONCEPTS.md verb): a LINE from pos to `end`, `radius` acting as
  // the half-width. It telegraphs for `arm` seconds (thin tracking line),
  // fires ONCE (piercing — the whole segment hits), then fades out.
  end?: Vec2;
  fired?: boolean;
  // Lock-on beams (the sentinel): while arming, `end` TRACKS this player —
  // lagging their movement — until beamLockSeconds before the shot, when the
  // line freezes. Juke at the click, not before.
  trackId?: number;
  // Sweeping beams (the Archivist): the segment ROTATES around `pos` at this
  // rate (radians/sec), ticking anyone it crosses, for as long as the caster
  // (`srcId`) keeps channeling — stagger or kill the caster and it dies.
  sweep?: number;
  srcId?: number;
}

// A party ping: a crawler marks a spot for the team ("loot here", "danger",
// "this way"). Pure sim data with a TTL — hosts render the pulse on the world
// and minimap; multiplayer gets it for free via snapshots.
export interface Ping {
  id: number;
  pos: Vec2;
  byId: number; // player who pinged (hosts color/label by party member)
  t: number; // seconds of life left
  total: number; // full lifetime (render progress)
}

// Destructible dressing (roomPurposes phase 5): a corner hoard you can SMASH.
// Non-blocking like every prop (only hittable); melee arcs and radial blasts
// pop them for pocket gold. Positions come from the pure dressing plan, so
// looks and hitboxes agree everywhere.
export interface Breakable {
  id: number;
  pos: Vec2;
  key: string; // prop model key (hosts render it; the sim only owns the hp)
  hp: number; // clutter: 1 (one good hit); blocking furniture: CONFIG.blockerHp
  // Blocking furniture (PHYSICALITY.md §1): the map.blocked tile indices this
  // piece owns. Cleared when it dies — smash the bookcase, open the lane.
  footprint?: number[];
  // INTERACTIVE PROP (BOSSES-V2 verb V3): a breakable that DOES something when
  // it dies, instead of just opening a lane. "drain" clears the arena's live
  // ground hazards and staggers the boss (the Sump King's floodgates);
  // "vent" bleeds the boss's heat gauge early (the Furnace Marshal's wall
  // vents); "shutdown" stops the thing feeding it adds (the Line Supervisor's
  // conveyors); "collapse" drops masonry where it stood. Arena-owned: these
  // are placed by the arena variant, not by room dressing.
  onBreak?: "drain" | "vent" | "shutdown" | "collapse";
  label?: string; // prop name for the announcer ("FLOODGATE", "CONVEYOR")
}

// A fallen monster the necromancer can raise. Purely positional — the fresh
// minion is rebuilt from the corpse's kind (see raiseCorpse in game.ts).
export interface Corpse {
  id: number;
  pos: Vec2;
  kind: MonsterKind;
  t: number; // seconds until the corpse is too cold to raise
}

// Transient combat/feedback events emitted during a single step. Hosts turn these
// into floating damage numbers, particles, camera shake, and announcer lines. They
// are derived deterministically from the sim (the RNG that rolls a crit is the same
// seeded stream), so replays reproduce them exactly.
export type HitKind = "enemy" | "crit" | "player" | "heal" | "gold" | "weapon" | "chain";

export interface HitEvent {
  pos: Vec2;
  amount: number;
  kind: HitKind;
  dir?: Vec2; // unit impact direction (attacker -> victim): directional particles
  killed?: boolean; // this hit was the killing blow (kill pops, heavier shake)
  // The killing blow OVERSHOT by ≥35% of max hp: hosts stage it bigger
  // (corpse launch, longer hit-stop). Only ever set alongside killed.
  overkill?: boolean;
  school?: School; // damage school of a player hit (hosts tint magic numbers)
  resisted?: boolean; // the target resisted this school (hosts dim the number)
  effect?: StatusKind; // DoT tick: which status dealt it (hosts tint per effect)
  to?: Vec2; // kind "chain": far endpoint — hosts draw a link from pos to here
}

// Semantic source of an announcer line. Hosts use this to route presentation
// (audio stingers, multiplayer filtering); it is data, not styling.
export type AnnouncementKind =
  | "boss" // named-monster intros, deaths, phase changes, corpse warnings
  | "progress" // floors, bands, keys/doors, collapse timer, win/wipe
  | "levelup" // levels, abilities learned, upgrade ranks
  | "loot" // loot boxes, tomes, notable drops, signature gear
  | "achievement"
  | "show" // audience economy: sponsors, frenzy, ultimates, favors
  | "tip" // first-contact rule explainers (tips.ts) — once per crawler, ever
  | "flavor"; // one-off color lines

export interface Announcement {
  text: string;
  kind: AnnouncementKind;
  // high = a headline moment (boss down, new band, wipe); hosts may give these
  // an exclusive full-width treatment. normal = a queued toast.
  priority: "high" | "normal";
  // Addressed to one crawler (tips: the System explains rules to whoever they
  // first touched, not the whole party). Absent = everyone sees it.
  forPlayer?: number;
}

/**
 * RIVALS mode: everything that belongs to ONE floor, so several floors can
 * run concurrently while rivals race at their own pace. The sim still executes
 * through the classic GameState slots — stepRivals MOUNTS a world into them,
 * runs the ordinary floor logic for that floor's residents, and captures the
 * fields back. Co-op never allocates worlds; nothing changes for it.
 */
export interface FloorWorld {
  floor: number;
  rng: Rng;
  map: FloorMap;
  explored: Uint8Array;
  exploredVersion: number;
  mapVersion: number;
  monsters: Monster[];
  loot: Loot[];
  projectiles: Projectile[];
  strikes: Strike[];
  bulletTimeLeft: number;
  decoys: Decoy[];
  breakables?: Breakable[]; // smashable dressing (phase 5; optional: pre-phase-5 snapshots) // active Stunt Doubles (friendly entities)
  hazards: Hazard[];
  corpses: Corpse[];
  pings: Ping[];
  encounter: Encounter | null;
  floorEvent: FloorEvent | null;
  goldSurge: boolean;
  glyphsDroppedThisFloor?: number;
  timeBudget: number;
  timeRemaining: number;
  phase: TimerPhase;
  collapseElapsed: number;
}

export interface GameState {
  // "coop" is the classic run (default). "rivals" is the competitive race:
  // up to 4 hostile crawlers, individual descent through concurrent floor
  // worlds, 15s revives, rival kills pay XP, first FINAL-BOSS kill wins.
  mode: "coop" | "rivals";
  // "race" is the classic 18-floor descent (default). "roam" is the v1
  // Expedition seed: one big, low-pressure floor per stairway with a
  // settlement/tribe/quest, regenerating open-endedly instead of ending at
  // floor 18. See SETTLEMENTS.md.
  runKind: "race" | "roam";
  // TODAY'S RULE (NICHE.md §4.8): the daily mutator this run was dealt, or
  // null/absent for the base game. Set once at createGame from the day
  // string (sim/dailyRules.ts) — never mid-run. Optional: older snapshots
  // lack it and read as the base game, which is what they were.
  dailyRule?: import("./dailyRules").DailyRuleId | null;
  // Roam only: the guide NPC (Mordecai, entrance settlement). Kept as the
  // legacy singular field so v1 snapshots and the current renderer path stay
  // valid; the full roster lives in `npcs` below.
  npc: Npc | null;
  quests: Quest[];
  // Roam only: every settlement resident on this floor (includes `npc`).
  // Optional: v1 snapshots lack it — readers default to [npc].
  npcs?: Npc[];
  // Roam only: the floor's settlements (2-4; [0] is the entrance one).
  settlements?: Settlement[];
  // Roam only: the active NPC dialogue session (one at a time — solo-first,
  // like pendingRewards but floor-scoped). Hosts render it and answer via
  // chooseDialogue/closeDialogue in npc.ts. Null/absent = no panel.
  dialogue?: DialogueSession | null;
  // Roam only (BACKLOG #25 seam): position keys of breakables smashed on
  // THIS floor, so a save/load rebuild doesn't restock consumed hoards.
  roamSmashed?: string[];
  // Roam only: the current floor's hostile stronghold, if any. The leader id
  // is tracked so reapDead can flip strongholdCleared on its death even if no
  // clearStronghold quest exists yet (killing it "early" is a valid outcome).
  strongholdLeaderId: number;
  strongholdLeaderName: string; // captured at spawn so it outlives the leader's death
  strongholdCleared: boolean;
  // Rivals only: the concurrent floor instances, keyed by floor number.
  worlds?: Record<number, FloorWorld>;
  winnerId?: number; // rivals: who secured the contract (status "won")
  // Rivals only, CLIENT-side: standings meta from the personal snapshot
  // (see serializeFor in snapshot.ts). The server never reads this.
  rivals?: {
    id: number; name: string; floor: number; level: number;
    alive: boolean; downedT: number; shopping: boolean;
    conceded?: boolean; // DEATH IS A DOOR (NICHE.md 4.7): out by choice
  }[];
  rng: Rng;
  seed: number;
  floor: number; // 1-indexed current floor
  map: FloorMap;
  // Fog of war: 1 = explored, row-major like map.tiles. Reset per floor.
  // Shared by the party; revealed around every living player.
  explored: Uint8Array;
  exploredVersion: number; // bumped whenever new tiles are revealed (render diffing)
  // Bumped whenever the tile grid itself changes (floor build, doors unlocking) so
  // renderers that cache floor geometry know to rebuild.
  mapVersion: number;
  // The party (1-6). Solo play is a party of one; players[0] is the local player
  // in the browser hosts. Order is stable and intents are applied in id order so
  // the RNG stream stays reproducible.
  players: Player[];
  monsters: Monster[];
  // Wire-only (set by the interest-filtered DYNAMIC net snapshots): the
  // AUTHORITATIVE living-monster count when `monsters` above is trimmed to
  // what the client can perceive — hosts tell "cleared" from "far away" with
  // it. Absent in local play and in full snapshots (monsters is complete).
  monstersLeft?: number;
  loot: Loot[];
  projectiles: Projectile[];
  nextEntityId: number;

  // Collapse timer
  timeBudget: number; // total seconds allotted for this floor
  timeRemaining: number; // seconds left; can go negative once collapsing
  phase: TimerPhase;
  collapseElapsed: number; // seconds spent in the collapse phase
  // TIME LOAN (shrine): seconds the NEXT floor's budget owes the System.
  // Collected (and cleared) by buildFloor. Not persisted — a reload forgives
  // the debt, which the System would never admit to.
  pendingTimeDebt?: number;

  status: RunStatus;
  // Event messages produced during the last step (consumed by host for the log/HUD).
  events: string[];
  // Announcer lines in the DCC "System" game-show voice (a curated subset of drama).
  announcements: Announcement[];
  // Combat/feedback events for this step (floating numbers, particles, shake).
  hits: HitEvent[];
  killCount: number; // monsters killed this run (drives loot-box milestones)
  lootBoxes: number; // loot boxes awarded this run

  // Ultimate side-state: scheduled airstrike impacts + bullet-time remaining.
  strikes: Strike[];
  bulletTimeLeft: number;
  /** Second Wind (bt.reel): the free extension for THIS bullet-time window is
   * still unspent. Optional — old snapshots read as "already used". */
  btSecondWind?: boolean;

  /** COLLAPSE's gather contract (V2 §6.4.2): how many bodies the last cast
   * actually dragged. Diagnostic only — the sim never reads it back. */
  gatheredLast?: number;
  /**
   * §6.4.6's instrument: damage dealt to monsters, keyed by SOURCE. Ambient
   * sources (the ones that cost no attention) key as `"<ability>:ambient"`,
   * so "melee + ambient orbit vs everything else" is answerable without
   * inferring it from hit shapes.
   *
   * OFF unless a caller allocates it (`state.dmgBySource = {}`), so live play
   * and the wire pay nothing for it. Diagnostic only — the sim never reads it
   * back, and it is never persisted.
   */
  dmgBySource?: Record<string, number>;

  // Friendly entities: active Stunt Doubles (see Decoy).
  decoys: Decoy[];
  breakables?: Breakable[]; // smashable dressing (phase 5; optional: pre-phase-5 snapshots)

  // Enemy-side ground danger (volatile blasts, spitter puddles).
  hazards: Hazard[];

  // ARENA DIRECTOR (boss layer 3): seconds the current band-boss arena has
  // been cooking — the room itself acts on a rhythm while the boss lives.
  arenaT?: number;

  // ---- BOSSES V2 -----------------------------------------------------------
  // This floor's arena LAYOUT (§4.3). Drawn seeded from the legal set for the
  // floor's boss; floor.ts carves it, game.ts stocks its props, and the
  // renderer dresses it. Absent on non-boss floors and pre-V2 snapshots.
  arenaVariant?: ArenaVariant;
  // Typed boss beats emitted during the last step (name cards, phase stingers,
  // punish windows, plate breaks). Transient — cleared every step alongside
  // hits/announcements. Hosts read this channel; the sim never reads it back.
  bossEvents?: BossEvent[];
  // This run's DRAWN lineup, keyed by band index as a string ("1".."6"). Filled
  // in as each boss floor is built, so a snapshot restores the same identity a
  // coop client already saw — a boss whose identity is not in the snapshot
  // desyncs the moment a phase lands.
  bossLineup?: Record<string, BossId>;
  // ANTI-REPEAT (§4.1): the PREVIOUS run's lineup, handed in from the save.
  // The draw avoids repeating a band slot's boss two runs running when the
  // pool allows — pure seeding will happily serve the same opener three runs
  // in a row and the player will not care that it was statistically fair.
  bossPrevLineup?: Record<string, BossId>;
  // ESCALATION ON REPEAT (§4.4): per-profile defeat counts, keyed by BossId.
  // 2nd+ meeting opens at the phase-2 kit and shortens the intro; 5th+ adds a
  // free mutator. Escalation in MECHANICS, never in stats.
  bossDefeats?: Record<string, number>;

  // Raisable corpses left by monster deaths (necromancer fuel, TTL-capped).
  corpses: Corpse[];

  // Active party pings (TTL-capped, few per player).
  pings: Ping[];

  // Ringside introduction in progress (world frozen while non-null).
  encounter: Encounter | null;

  // Seeded per-floor event (see FloorEvent). Reset every floor build.
  floorEvent: FloorEvent | null;
  // Shrine Greed Clause accepted on this floor: gold drops pay double.
  goldSurge: boolean;
  // Field glyphs dropped on this floor (V2 §3.5 supply cap). Reset every floor
  // build; optional so pre-cap saves/snapshots load reading it as 0.
  glyphsDroppedThisFloor?: number;

  // Softlock self-healing: seconds until the next locked-door key audit
  // (auditKeyReachability in game.ts). Optional for snapshot/save compat.
  keyAuditT?: number;

  // Safe room between floors (null while crawling). The whole instance is "between
  // floors" while non-null: the sim idles until every player readies up.
  safeRoom: SafeRoom | null;

  // Party-level per-step flags (per-player progress lives on Player).
  killsThisStep: number; // transient: party kills reaped this step (combo hype)
  escapedCollapse: boolean; // transient: descended while the floor was collapsing
  // Resident interruption lines already delivered this floor (purpose ids).
  residentAggro?: string[];

  elapsed: number; // total seconds elapsed this run (for stats/display)
}

/** Intent produced by a host (client input, script, or agent) for one sim step. */
export interface Intent {
  move: Vec2; // desired movement direction (need not be normalized); zero = stand still
  attack?: boolean; // legacy: cast the slot holding melee (see cast below)
  aim?: Vec2; // optional aim direction for the attack (falls back to facing)
  useStairs: boolean; // attempt to descend if standing on stairs
  // Slot casts: indices 0-3 = the four ability slots, 4 = the ultimate slot.
  cast?: boolean[];
  // Drink the Sponsor Slurp™ flask (edge-triggered; charge-gated in the sim).
  flask?: boolean;
  // Legacy convenience flags (tests/bots): each maps to "cast the slot currently
  // holding that ability" — a no-op if it isn't slotted.
  dash?: boolean;
  bolt?: boolean;
  nova?: boolean;
  // Drop a party ping at this WORLD position (edge-triggered). Downed players
  // may ping too — calling for help is content.
  ping?: Vec2;
}

export const NO_INTENT: Intent = {
  move: { x: 0, y: 0 },
  useStairs: false,
};

/** Per-player intents for one step, keyed by player id. Missing ids = NO_INTENT. */
export type PartyIntents = Record<number, Intent>;

/** Attacker identity plus the shape of the blow (Player.lastHitSrc).
 *  `by` is a stable machine key - a MonsterKind, "hazard:<kind>",
 *  "status:<kind>", "shot" or "crawler" - so the post-run screen and the
 *  board row can name a death without parsing prose. */
export interface LastHitSrc {
  by: string;
  /** Announcer name when the attacker had one (elites, city bosses). */
  label?: string;
  /** Damage dealt AFTER mitigation - what actually came off the bar. */
  dmg: number;
  /** HP before the blow, so the screen can say "from 62%". */
  hpBefore: number;
  /** Max HP at that moment - the denominator for hpBefore. */
  maxHp: number;
}
