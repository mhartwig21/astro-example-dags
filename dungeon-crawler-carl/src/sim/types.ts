import type { Rng } from "./rng";
import type { AbilityId, School, StanceId, UpgradeOffer } from "./abilities";

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
  goldSpent: number; // cumulative shop spending this run
  kills: number; // cumulative kill credit (killing blows) this run
  killsThisStep: number; // transient: kills credited to this player this step
  lowHpKill: boolean; // transient: killed something while below 10% HP

  // Crafting materials (spent at the safe-room bench).
  materials: Record<MaterialId, number>;

  // Cumulative combat stats for this run.
  damageDealt: number;
  damageTaken: number;

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
}

// Elite affixes: one bonus mechanic a named elite can roll (see spawnMonsters).
export type EliteAffix =
  | "swift" | "shielded" | "volatile" | "summoner" | "splitter" | "thorns"
  // School resists (DESIGN 5.8 phase 3): the party's damage MIX starts
  // mattering — a warded elite pack is the crossbow crawler's fight.
  | "armored" // takes reduced PHYSICAL damage
  | "warded" // takes reduced MAGIC damage
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
  | "shieldbearer" | "cleric" | "archivist" | "colossus";

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
  windupKind?: "melee" | "shot" | "fuse" | "charge" | "spit" | "raise" | "slam" | "ritual"
    | "punch" | "aim" | "vent" | "hook" | "morph" | "hex" | "lunge"
    | "heal" | "summon" | "consecrate" | "sweep"; // what resolves when windup expires
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
  stagger: number; // seconds of stagger remaining (helpless while > 0)
  poiseDmg: number; // damage accumulated toward the next stagger
  // transient render flag: seconds remaining to show a hit flash
  hitFlash: number;
  lastHitBy?: number; // player id credited with the killing blow (loot boxes)
  elite?: boolean; // neighborhood boss: beefed-up named archetype with loot
  eliteName?: string; // announcer name for elites and city bosses
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
  sigCd?: number; // seconds until the signature can fire again
  sigUsed?: boolean; // the first-cast announcer line already played
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
  aura?: "frenzy";
  frenzyT?: number; // seconds of drum frenzy remaining on THIS monster
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
}

export type LootKind = "gold" | "heal" | "item" | "tome" | "key" | "material" | "shrine";

// Crafting materials, dropped by named menaces and spent in the System Shop
// on legendary signature gear (see catalog.ts).
export type MaterialId = "elite_trophy" | "boss_sigil";
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
  | "venom"; // crits inject a poison stack (the only lootless poison source)

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
}

// Sponsor draft: a reward offered between floors. `apply` semantics live in game.ts.
// The pool is deliberately WIDE so no single stat is the every-floor pick:
// permanent stat gifts (damage/maxHp/crit/armor) diminish as you stack them,
// while build-variety gifts (item/materials/favor) never do.
export type RewardKind =
  | "healFull" | "maxHp" | "damage" | "crit" | "armor" | "item" | "gold" | "bonusTime"
  | "materials" // crafting material toward signature (legendary) gear
  | "favor" // an owed ability-upgrade draft (advances the constellation build)
  | "retrain" // unlearn one fork-side node; its ranks return as fresh drafts
  // System Shrine bargains (floor events — never in the sponsor pool):
  | "shrineBlood" // pay a slice of max HP now for permanent crit
  | "shrineGreed" // this floor's monsters speed up; its gold drops double
  | "shrineDecline" // walk away (the System notes the cowardice)
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
  nodeId?: string; // present when kind === "retrain": the node being refunded
  revisionId?: string; // present when kind === "revision": the casting on offer
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
  crit?: boolean; // MOMENTUM capstone: this bolt crits on impact
  shatter?: boolean; // SYSTEM SHOCK capstone: this bolt staggers non-bosses on impact
  school?: School; // damage school (hosts tint magic missiles differently)
  chill?: number; // FROST BOLTS node: slow fraction applied on impact
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
  | "combat"; // everything else

export interface FloorMap {
  w: number;
  h: number;
  tiles: Uint8Array; // row-major, length w*h, values from Tile
  spawn: Vec2; // player entry point
  stairs: Vec2; // stairs-down location
  rooms: RoomRect[]; // generated room rectangles (rooms[0] contains the spawn)
  roles: RoomRole[]; // intent tag per room (parallel to rooms)
  depths: number[]; // 0..1 progress along the critical path per room (pacing)
  cycles: number; // extra loop corridors carved beyond the spanning chain
  locked: boolean; // the stairs room is sealed behind DoorLocked tiles
  lockedRoomIdx: number; // index into rooms of the sealed stairs room; -1 when unlocked
  // Landmark set pieces carved into the GRID (tile indices; the tiles are
  // Wall): pillars/pedestal used to be walk-through renderer dressing —
  // "solid" props players clipped through. Now the sim blocks them and
  // renderers draw pillar/centerpiece models ON these tiles, so what the
  // floor SHOWS and what it BLOCKS agree.
  pillars: number[];
  pedestal: number; // centerpiece tile (-1 = none); OFF-center so the room center stays walkable
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
  kind?: "blast" | "puddle" | "sludge" | "roots" | "beam" | "shards" | "consecrate"; // absent = blast (older saves/snapshots)
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
  decoys: Decoy[]; // active Stunt Doubles (friendly entities)
  hazards: Hazard[];
  corpses: Corpse[];
  pings: Ping[];
  encounter: Encounter | null;
  floorEvent: FloorEvent | null;
  goldSurge: boolean;
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
  // Rivals only: the concurrent floor instances, keyed by floor number.
  worlds?: Record<number, FloorWorld>;
  winnerId?: number; // rivals: who secured the contract (status "won")
  // Rivals only, CLIENT-side: standings meta from the personal snapshot
  // (see serializeFor in snapshot.ts). The server never reads this.
  rivals?: {
    id: number; name: string; floor: number; level: number;
    alive: boolean; downedT: number; shopping: boolean;
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
  loot: Loot[];
  projectiles: Projectile[];
  nextEntityId: number;

  // Collapse timer
  timeBudget: number; // total seconds allotted for this floor
  timeRemaining: number; // seconds left; can go negative once collapsing
  phase: TimerPhase;
  collapseElapsed: number; // seconds spent in the collapse phase

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

  // Friendly entities: active Stunt Doubles (see Decoy).
  decoys: Decoy[];

  // Enemy-side ground danger (volatile blasts, spitter puddles).
  hazards: Hazard[];

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

  // Softlock self-healing: seconds until the next locked-door key audit
  // (auditKeyReachability in game.ts). Optional for snapshot/save compat.
  keyAuditT?: number;

  // Safe room between floors (null while crawling). The whole instance is "between
  // floors" while non-null: the sim idles until every player readies up.
  safeRoom: SafeRoom | null;

  // Party-level per-step flags (per-player progress lives on Player).
  killsThisStep: number; // transient: party kills reaped this step (combo hype)
  escapedCollapse: boolean; // transient: descended while the floor was collapsing

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
