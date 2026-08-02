// BOSSES V2 — the roster, and the draw that keeps a run from repeating itself.
//
// The audit that opened BOSSES-V2.md measured three consecutive runs across
// six boss floors and found ONE name, ONE signature, ONE HP value and ONE
// arena shape per slot. Not "low variety" — zero. For a game designed around
// short sessions played over and over, the boss was the most repetitive thing
// in it.
//
// This module is the fix, and it is deliberately PURE: roster data plus three
// seeded draws (boss, mutators, arena). Nothing here touches GameState, and
// nothing here consumes `state.rng` — every draw comes from a dedicated hash
// of (runSeed, band, salt), exactly like assignRoomPurposes(seed, floor, map).
// That is not fastidiousness: pulling from the floor's live RNG stream would
// shift every downstream spawn draw and re-roll every existing fixture.
//
// The multiplication, per band slot: 3 bosses x 8 mutators x ~2 legal arenas.

import type { School } from "./abilities";
import { CONFIG } from "./config";
import type {
  ArenaVariant, BossAsk, BossId, BossMutator, BossSignature, Breakable,
} from "./types";

/** One roster entry. The DATA half of a boss; its verbs live in ai.ts. */
export interface BossDef {
  id: BossId;
  band: number; // 1..6 (floors 3/6/9/12/15/18)
  name: string;
  /** Name-card subtitle (§5.3). Civic satire, System-lane, sanctioned. */
  epithet: string;
  /** The ONE thing the fight asks. Two asks is two bosses. */
  ask: BossAsk;
  /** The System's single deadpan line at the ringside reveal. */
  line: string;
  /** Which shipped band signature this boss leans on, if any. */
  signature?: BossSignature;
  /** Arena layouts this fight is legal in (§4.3 draws from this set). */
  arenas: ArenaVariant[];
  /** Fine tuning inside the band's HP/damage budget. */
  hpMult?: number;
  dmgMult?: number;
  /** It never moves (The Grease Trap is a fixture, not a creature). */
  stationary?: boolean;
  /** Plates it wears from the first frame (V1). */
  plates?: { key: string; label: string; school?: School }[];
  /** It carries a regrowing shield pool (V2). */
  shield?: boolean;
  /** Its shield only erodes to ONE school (The Sponsor's Brand Integration). */
  shieldSchool?: School;
  /** It arrives with tethered aides that hand their verb over when they die. */
  aides?: number;
  /** The interactive arena prop this fight requires (V3). */
  prop?: NonNullable<Breakable["onBreak"]>;
  /** Phases before the last one (default 2 = the shipped 2/3 and 1/3 gates). */
  maxPhase?: number;
}

// ---------------------------------------------------------------------------
// THE ROSTER — 18 named band bosses, three per band. Every band contains at
// least three DIFFERENT asks, so whichever boss a run draws, the band still
// plays differently from its neighbours (§3.8).
// ---------------------------------------------------------------------------

export const BOSS_POOL: Record<number, BossDef[]> = {
  // ---- THE UNDERCROFT (floor 3) — the teaching band. Each candidate teaches
  // exactly ONE grammar element and nothing else. No mutators here, mirroring
  // the shipped "floor 1 stays pristine" rule.
  1: [
    {
      // Its risen are TETHERED: each one feeds it, so ignoring them stalls the
      // fight. Deny the corpses and it panics into a long reconciliation — the
      // fight teaches exactly what its own drop (the Front Desk Bell) does.
      id: "concierge", band: 1, name: "The Crypt Concierge",
      epithet: "MORTUARY FRONT DESK — RING FOR SERVICE",
      ask: "adds", signature: "graverising", arenas: ["pillared", "split"],
      line: "Check-in is continuous. Check-out is not offered.",
    },
    {
      // Late Fee seizes gold into a lockbox PLATE. Break it inside the window
      // and the party is refunded with interest; miss it and you paid for the
      // privilege. The ask is target-switch under a clock.
      id: "rentcollector", band: 1, name: "The Rent Collector",
      epithet: "COLLECTIONS — THIRD AND FINAL NOTICE",
      ask: "window", arenas: ["open", "pillared"],
      line: "Payment plans are available. They are worse.",
      plates: [{ key: "lockbox", label: "THE LOCKBOX" }],
      hpMult: 0.95,
    },
    {
      // A pushover with a visible ticking clause. Burst it through half health
      // inside the channel and it never transforms at all — two completely
      // different second halves, decided by the player.
      id: "temp", band: 1, name: "The Temp",
      epithet: "PROVISIONAL — DO NOT LEARN ITS NAME",
      ask: "window", arenas: ["open", "pillared", "split"],
      line: "Contract includes a transformation clause. Standard boilerplate.",
      hpMult: 0.9,
    },
  ],

  // ---- THE SEWERS (floor 6) — pressure and ground.
  2: [
    {
      // Keeps the best telegraph in the game (armed pools) and adds FLOODGATES:
      // break them and the flooded half drains. Routing beats out-running.
      id: "sumpking", band: 2, name: "The Sump King",
      epithet: "SANITATION DISTRICT — CROWNED, UNELECTED",
      ask: "arena", signature: "flood", arenas: ["split", "pillared"],
      line: "The court is in session. Mind the level.",
      prop: "drain",
    },
    {
      // Citation lanes CONDEMN the tiles they hit, so clean floor is a
      // resource you spend. Open sightlines only — pillars would eat the lanes
      // the whole fight is made of.
      id: "inspector", band: 2, name: "The Sanitation Inspector",
      epithet: "HEALTH CODE ENFORCEMENT, FLOOR SIX",
      ask: "lane", arenas: ["open"],
      line: "I am condemning this floor. Section by section.",
      hpMult: 0.9, dmgMult: 1.05,
    },
    {
      // A STATIONARY boss. It pulls you in on a rhythm and births tethered
      // adds that shove you back toward it; break the chain and the pit
      // inverts, spitting its core out as a weak point. Needs anchor geometry.
      id: "greasetrap", band: 2, name: "The Grease Trap",
      epithet: "NOT A CREATURE. A FIXTURE.",
      ask: "adds", arenas: ["pillared", "split"],
      line: "It does not chase. It waits, and the floor does the walking.",
      stationary: true, hpMult: 1.15,
    },
  ],

  // ---- THE GARDEN (floor 9) — shields and swarms.
  3: [
    {
      // The snare finally CASHES IN: roots hold you still while the hedge
      // shield regrows. Burst the shield inside the regen gap.
      id: "topiary", band: 3, name: "The Topiary Warden",
      epithet: "GROUNDS MAINTENANCE — ARMED AND PRUNING",
      ask: "shield", signature: "roots", arenas: ["pillared", "split"],
      line: "The hedge grows back. That is the entire threat.",
      shield: true,
    },
    {
      // The council format without a new spawn shape: three TETHERED aides
      // shield the Board body, and each aide's death hands its verb to the
      // Board. Killing the wrong one first makes the fight worse. The kill
      // order IS the fight, and it is legible from the intro.
      id: "zoningboard", band: 3, name: "The Zoning Board",
      epithet: "THE BOARD WILL SEE YOU NOW",
      ask: "adds", arenas: ["open", "pillared"],
      line: "Three signatures. Order matters. It always has.",
      aides: 3, hpMult: 0.85,
    },
    {
      // Bloom seeds armed pods; pods that go off seed more pods. Left alone
      // the arena saturates. The storm IS the problem, so no cover.
      id: "pollinator", band: 3, name: "The Pollinator",
      epithet: "POLLEN ADVISORY: SEVERE",
      ask: "storm", arenas: ["open"],
      line: "It is not attacking you. It is reproducing near you.",
      hpMult: 0.9,
    },
  ],

  // ---- THE RUINS (floor 12) — the arena fights back.
  4: [
    {
      // Debris now demolishes the arena's cover FOR REAL — the fight starts
      // cover-based and ends in open ground. Zero new verbs: breakables plus
      // SMASH_KINDS already includes "boss". Must have pillars to eat.
      id: "architect", band: 4, name: "The Condemned Architect",
      epithet: "STRUCTURAL REVIEW — FINDINGS: DEMOLISH",
      ask: "arena", signature: "debris", arenas: ["pillared"],
      line: "Every column in here is a formality. Watch.",
    },
    {
      // Four plates, each IMMUNE to one damage school. A mono-school build
      // physically cannot break all four quickly — the same lesson the
      // armored/warded deep-floor affix bias teaches, escalated to a boss.
      id: "permitoffice", band: 4, name: "The Permit Office",
      epithet: "STOP-WORK ORDER, AMBULATORY",
      ask: "shield", arenas: ["open", "pillared"],
      line: "Four stamps. Two schools. Do the arithmetic.",
      plates: [
        { key: "stamp_a", label: "STAMP: STRUCTURAL", school: "physical" },
        { key: "stamp_b", label: "STAMP: ELEMENTAL", school: "magic" },
        { key: "stamp_c", label: "STAMP: OCCUPANCY", school: "physical" },
        { key: "stamp_d", label: "STAMP: VARIANCE", school: "magic" },
      ],
      hpMult: 0.7, // the plates ARE most of this fight's health
    },
    {
      // The shipped colossus fissure at boss scale and in multiples: wedge
      // safe zones, then radial lanes. Move perpendicular, never along.
      id: "foundation", band: 4, name: "The Foundation",
      epithet: "LOAD-BEARING, AND IT KNOWS IT",
      ask: "lane", arenas: ["open", "split"],
      line: "It has held this ceiling for a century. It can hold a grudge.",
      hpMult: 1.1, dmgMult: 0.95,
    },
  ],

  // ---- THE IRONWORKS (floor 15) — rhythm and machinery.
  5: [
    {
      // Keeps the best signature in the game and finally gives a boss the
      // slagbreaker's HEAT RHYTHM: sweeps build heat, the third forces a vent
      // and a genuine self-stagger. Count, dodge, unload.
      id: "marshal", band: 5, name: "The Furnace Marshal",
      epithet: "FIRE SAFETY — BY DEMONSTRATION",
      ask: "window", signature: "flamewall", arenas: ["pillared", "open"],
      line: "Three sweeps, then it has to breathe. Count with me.",
      prop: "vent",
    },
    {
      // It barely fights. It runs CONVEYORS that deliver wind-up battalion
      // squads; the squads are the threat. Attack the system, not the boss —
      // the clearest "the answer is not DPS" fight in the roster.
      id: "linesupervisor", band: 5, name: "The Line Supervisor",
      epithet: "PRODUCTION QUOTA: YOU",
      ask: "adds", arenas: ["pillared"],
      line: "It does not fight. It schedules.",
      prop: "shutdown", hpMult: 0.8,
    },
    {
      // Compliance Lattice: lock-on beams that arm IN SEQUENCE, turning the
      // arena into a timing puzzle of moving safe cells. Read it, move early,
      // never panic-dash.
      id: "safetyofficer", band: 5, name: "The Safety Officer",
      epithet: "COMPLIANCE LATTICE ONLINE",
      ask: "storm", arenas: ["open"],
      line: "Stand in a lit cell. There will be fewer of them shortly.",
      hpMult: 0.95,
    },
  ],

  // ---- THE APPROACH (floor 18). The audit's most embarrassing finding was
  // that the last boss in the game is called "THE BOSS". All three candidates
  // are new, and all three have names.
  6: [
    {
      // Each phase it REBUILDS the arena into a previous band's, hazards and
      // all, behind an intermission — and the counterplay is whatever that
      // band taught you. The whole run is the tutorial.
      id: "showrunner", band: 6, name: "The Showrunner",
      epithet: "STITCHED FROM EVERY SET YOU BURNED",
      ask: "arena", arenas: ["open", "pillared", "split"],
      line: "You have already been taught how to beat this. Six times.",
      maxPhase: 3,
    },
    {
      // The Board format at finale scale: five aides, each death redistributing
      // verbs. For runs that want the finale to be an execution test.
      id: "standards", band: 6, name: "The Standards and Practices Board",
      epithet: "FIVE SIGNATURES REQUIRED",
      ask: "adds", arenas: ["open", "pillared"],
      line: "The Board finds your conduct broadly acceptable. Broadly.",
      aides: 5, maxPhase: 3, hpMult: 0.85,
    },
    {
      // Brand Integration: a shield only ONE damage school erodes, and the
      // school it accepts changes every phase. This is Diablo's "immune to X"
      // affix wearing a sponsorship joke — it never asks for another genre.
      id: "sponsor", band: 6, name: "The Sponsor",
      epithet: "THIS FIGHT BROUGHT TO YOU BY",
      ask: "shield", arenas: ["open", "split"],
      line: "Brand integration is live. One school works. Find out which.",
      shield: true, shieldSchool: "physical", maxPhase: 3,
    },
  ],
};

// ---------------------------------------------------------------------------
// THE BAND SIGNATURES, IN EACH BOSS'S OWN VOICE.
//
// Acceptance review, round 3: "ENTANGLING ROOTS" was the live beat line on the
// Topiary Warden (break-the-shield), the Zoning Board (kill-the-adds) AND the
// Condemned Architect (use-the-arena). Three different bosses, three different
// asks, ONE readout. The four shipped band signatures are shared HAZARDS - the
// arena director fires them on floors 6/9/15 whoever the boss is, and a boss
// past phase 1 alternates into the previous band's (BORROWED in ai.ts) - but a
// shared hazard must not mean a shared NAME, exactly as RITUAL_LABEL already
// established for the tier-3 channel.
//
// So the mechanic stays shared and the label is identity. Every boss that can
// ever be standing next to one of these four owns its own word for it.
// ---------------------------------------------------------------------------

/** The band signature's own name when nobody has renamed it. */
export const BAND_SIG_DEFAULT: Record<string, string> = {
  flood: "FLOOD SURGE",
  roots: "ENTANGLING ROOTS",
  debris: "DEBRIS RAIN",
  flamewall: "FLAME SWEEP",
  graverising: "CHECK-IN",
};

/**
 * Per-boss renames. A row exists for every (boss, signature) pair the sim can
 * actually produce: the boss's OWN band signature, the one its arena director
 * fires at it, and the one BORROWED hands it from phase 1.
 */
export const BAND_SIG_LABEL: Partial<Record<BossId, Partial<Record<string, string>>>> = {
  // ---- floor 6: the arena director floods for all three ---------------------
  sumpking: { flood: "FLOOD SURGE", graverising: "THE DROWNED RISE" },
  inspector: { flood: "SEWER BACKUP", graverising: "CONDEMNED, RISING" },
  greasetrap: { flood: "THE GREASE RISES", graverising: "SKIMMED OFF THE TOP" },
  // ---- floor 9: the director regrows for all three -------------------------
  topiary: { roots: "HEDGE GRASP", flood: "IRRIGATION SURGE" },
  zoningboard: { roots: "EASEMENT CLAIMED", flood: "STORMWATER VARIANCE" },
  pollinator: { roots: "RUNNER ROOTS", flood: "GROUNDWATER BLOOM" },
  // ---- floor 12: no director, so only its own and its borrowed one ---------
  architect: { debris: "DEBRIS RAIN", roots: "CREEPING RUIN" },
  permitoffice: { debris: "CONDEMNATION NOTICE", roots: "UNPERMITTED GROWTH" },
  foundation: { debris: "SPALL", roots: "SUBSIDENCE" },
  // ---- floor 15: the director vents for all three --------------------------
  marshal: { flamewall: "FLAME SWEEP", debris: "CEILING FAILURE" },
  linesupervisor: { flamewall: "LINE PURGE", debris: "TOOL DROP" },
  safetyofficer: { flamewall: "EVACUATION DRILL", debris: "OVERHEAD HAZARD" },
  // ---- floor 18: a finale can wear any of them, so all four are named ------
  showrunner: {
    flamewall: "PYRO CUE", debris: "SET COLLAPSE",
    roots: "GREEN ROOM", flood: "WATER FEATURE",
  },
  standards: {
    flamewall: "CENSURE", debris: "STRUCK FROM THE RECORD",
    roots: "TABLED", flood: "MOTION TO FLOOD",
  },
  sponsor: {
    flamewall: "AD SPOT: FIRE", debris: "PRODUCT PLACEMENT",
    roots: "ORGANIC REACH", flood: "SPONSORED CONTENT",
  },
  // ---- floor 3 (the Concierge's own graverising keeps its shipped name) -----
  rentcollector: { graverising: "PAST-DUE ACCOUNTS" },
  temp: { graverising: "PREVIOUS TEMPS" },
};

/**
 * What THIS boss calls a shared band signature. Pure, total, and the one
 * source of truth for the label the sim puts on the `telegraph` event - the
 * plate's beat line, the per-boss FX and the per-boss telegraph SOUND all key
 * off that label, so renaming here renames the whole beat.
 */
export function bandSignatureLabel(sig: string, bossId?: BossId): string {
  const fallback = BAND_SIG_DEFAULT[sig] ?? sig.toUpperCase();
  if (!bossId) return fallback;
  return BAND_SIG_LABEL[bossId]?.[sig] ?? fallback;
}

/** Every distinct label the band signatures can emit (host FX/sound tables). */
export function allBandSignatureLabels(): string[] {
  const out = new Set<string>(Object.values(BAND_SIG_DEFAULT));
  for (const row of Object.values(BAND_SIG_LABEL)) {
    for (const label of Object.values(row ?? {})) if (label) out.add(label);
  }
  return [...out];
}

const BY_ID = new Map<BossId, BossDef>();
for (const key of Object.keys(BOSS_POOL)) {
  for (const def of BOSS_POOL[Number(key)]) BY_ID.set(def.id, def);
}

/** Look up a roster entry (snapshot restore, tests, host name cards). */
export function bossDef(id: BossId): BossDef | undefined {
  return BY_ID.get(id);
}

/** Every roster entry, band order. */
export function allBossDefs(): BossDef[] {
  return [...BY_ID.values()];
}

/** The band slot (1..6) a boss floor belongs to. Floor 18 is band 6. */
export function bandForBossFloor(floor: number): number {
  if (floor >= CONFIG.finalFloor) return 6;
  return Math.max(1, Math.min(5, Math.floor(floor / CONFIG.bossFloorEvery)));
}

// ---------------------------------------------------------------------------
// THE DRAW. A 32-bit avalanche hash over (seed, band, salt) — deterministic,
// stable across processes, and completely independent of state.rng.
// ---------------------------------------------------------------------------

/** Deterministic 32-bit hash of a list of integers (FNV-1a + a final mix). */
export function bossHash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    let v = part >>> 0;
    for (let b = 0; b < 4; b++) {
      h = Math.imul(h ^ (v & 0xff), 0x01000193) >>> 0;
      v >>>= 8;
    }
  }
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const SALT_BOSS = 0x0b0551;
const SALT_MUT = 0x0117a7;
const SALT_MUT2 = 0x0117a8;
const SALT_ARENA = 0x0a2e4a;

/**
 * V9 — SEEDED BOSS SELECTION. One of the band's three candidates, drawn from
 * (seed, band). `prevId` is the SAME band slot's boss from the player's last
 * run: when the pool allows, the draw steps off it. Pure seeding alone will
 * happily serve the same opener three runs running and the player will not
 * care that it was statistically fair (§4.1) — this is the highest-value
 * piece of code in the doc for the owner's stated problem.
 */
export function pickBandBoss(seed: number, band: number, prevId?: BossId): BossDef {
  const pool = BOSS_POOL[band] ?? BOSS_POOL[1];
  let idx = bossHash(seed, band, SALT_BOSS) % pool.length;
  if (prevId && pool.length > 1 && pool[idx].id === prevId) {
    idx = (idx + 1) % pool.length;
  }
  return pool[idx];
}

// ---------------------------------------------------------------------------
// V10 — BOSS MUTATORS. The rule that makes these worth building: a mutator
// must change what the player DOES. A mutator that only adds HP or damage is
// banned. Each one is a single sentence of counterplay, the same standard the
// shipped elite six-pack met.
// ---------------------------------------------------------------------------

export interface BossMutatorInfo {
  id: BossMutator;
  label: string;
  /** What changes / the new counterplay — hosts show this on the name card. */
  note: string;
  /** Some mutators need something to act on. */
  legal?: (def: BossDef) => boolean;
  /** Both of these spawn bodies; never draw two adds mutators together. */
  addsPressure?: boolean;
}

export const BOSS_MUTATORS: BossMutatorInfo[] = [
  {
    id: "entouraged", label: "ENTOURAGED", addsPressure: true,
    note: "Arrives with a champion-grade escort. Split attention; pick a kill order.",
  },
  {
    id: "unionrules", label: "UNION RULES", addsPressure: true,
    note: "Its adds get back up once, on a delay. Kill them away from it, or burst them twice.",
  },
  {
    id: "sponsored", label: "SPONSORED",
    note: "A hazard-immune bubble it must be pulled out of. Move the fight, not just yourself.",
  },
  {
    id: "overtime", label: "OVERTIME",
    note: "The broadcast slot is short. The enrage deadline arrives early — this is a race.",
  },
  {
    id: "retrofit", label: "RETROFIT",
    note: "Its signature is another band's. A familiar boss with an unfamiliar telegraph.",
    legal: (def) => !!def.signature,
  },
  {
    id: "understudied", label: "UNDERSTUDIED",
    note: "Its armour comes back once at half health. The break-window happens twice.",
    legal: (def) => !!def.plates || !!def.shield,
  },
  {
    id: "liveaudience", label: "LIVE AUDIENCE",
    note: "The crowd throws things on a rhythm. The room does damage now, not just the boss.",
  },
  {
    id: "redacted", label: "REDACTED",
    note: "Shorter telegraphs — but it announces its next move in text. Read the ticker.",
  },
];

const MUT_BY_ID = new Map(BOSS_MUTATORS.map((m) => [m.id, m] as const));

/** A mutator's host-facing label + counterplay sentence (name card). */
export function bossMutatorInfo(id: BossMutator): BossMutatorInfo {
  return MUT_BY_ID.get(id) ?? { id, label: String(id).toUpperCase(), note: "" };
}

/**
 * V10 — the per-encounter mutator draw. Gating mirrors the shipped "floor 1
 * stays pristine" discipline: NONE on floor 3 (the teaching band), one from
 * floors 6-12, up to two from floor 15. `bonus` is the free mutator a boss you
 * have beaten five times gains (§4.4) — escalation in mechanics, never stats.
 */
export function rollBossMutators(
  seed: number, floor: number, def: BossDef, bonus = false,
): BossMutator[] {
  if (floor < CONFIG.bossMutatorFromFloor) return []; // the teaching band stays clean
  const legal = BOSS_MUTATORS.filter((m) => !m.legal || m.legal(def));
  if (legal.length === 0) return [];
  const first = legal[bossHash(seed, def.band, SALT_MUT) % legal.length];
  const out: BossMutator[] = [first.id];
  if (floor >= CONFIG.bossMutatorSecondFromFloor || bonus) {
    // Never two that both add adds, and never the same one twice.
    const rest = legal.filter(
      (m) => m.id !== first.id && !(m.addsPressure && first.addsPressure),
    );
    if (rest.length > 0) {
      out.push(rest[bossHash(seed, def.band, SALT_MUT2) % rest.length].id);
    }
  }
  return out;
}

/**
 * §4.3 — the arena layout. Drawn seeded from the boss's LEGAL set, so the
 * Sanitation Inspector never gets pillars in its lanes and the Grease Trap
 * never gets an arena with nothing to brace against.
 */
export function pickArenaVariant(seed: number, def: BossDef): ArenaVariant {
  const legal = def.arenas.length > 0 ? def.arenas : (["open"] as ArenaVariant[]);
  return legal[bossHash(seed, def.band, SALT_ARENA) % legal.length];
}

/**
 * The whole encounter identity for one boss floor, in ONE pure call. The
 * spawner, floor.ts, the hosts, and the tests all read the same answer for a
 * given (seed, floor, save) — nobody recomputes half of it.
 */
export interface BossDraw {
  def: BossDef;
  mutators: BossMutator[];
  arena: ArenaVariant;
  /** How many times this profile has already put this boss down. */
  defeats: number;
}

export function drawBossEncounter(
  seed: number, floor: number,
  prevLineup?: Record<string, BossId>,
  defeats?: Record<string, number>,
): BossDraw {
  const band = bandForBossFloor(floor);
  const def = pickBandBoss(seed, band, prevLineup?.[String(band)]);
  const beaten = defeats?.[def.id] ?? 0;
  return {
    def,
    mutators: rollBossMutators(seed, floor, def, beaten >= CONFIG.bossRepeatMutatorAt),
    arena: pickArenaVariant(seed, def),
    defeats: beaten,
  };
}
