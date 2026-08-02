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
  /**
   * This boss overrides the chassis its ASK would give it (see ASK_CHASSIS).
   *
   * r7 blocker: `tools/_ed3census.ts` measured the teaching band's three
   * candidates at pairwise cosine 0.993 / 0.972 / 0.968 on the normalised
   * threat vector — across two DIFFERENT asks. Deriving the chassis from the
   * ask fixes the cross-ask half of that (a kill-the-adds boss stops firing the
   * same ring as a burst-the-window one), but The Rent Collector and The Temp
   * SHARE the window ask by deliberate design (§3: the UNDERCROFT is the
   * teaching band and two of its three candidates both teach "recognise the
   * window and unload"), so the ask alone cannot separate them. A boss may
   * therefore state its own chassis; the ask is the default, not the law.
   */
  chassis?: Partial<BossChassisRule>;
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
      // ITS OWN CHASSIS, BECAUSE THE DOC ALREADY SAID SO (r7 blocker). Its
      // entry has read "a pushover with a visible ticking clause" since the
      // roster was written, and it fought exactly like The Rent Collector next
      // to it: cosine 0.972 on the threat vector, same ask, same everything.
      // A pushover does not fire a ring of bolts every 3.6 seconds. It barely
      // does anything — which is the whole setup for the clause, and makes the
      // two window bosses on the teaching floor two different lessons about
      // the same beat rather than one lesson printed twice.
      chassis: { volleyCd: 0, volleyCount: 0, rainMult: 1.8 },
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
// THE PUNISH WINDOW, IN EACH BOSS'S OWN VOICE (acceptance r5, blocker).
//
// The measurement that opened this: `stepBoss` fired the window off a single
// shared `m.heat` counter that every slam, ritual, hazard tick and band
// signature incremented, at one threshold (3), with one telegraph label
// (OVER-COMMIT), one core word (EXPOSED CORE) and one HUD call-out — on all
// eighteen bosses. Over 75s per boss: The Pollinator opened 21 windows and
// spent 44.7 of 75 seconds staggered; Sump King, Grease Trap, Permit Office
// and Standards Board opened 10 each. There was nothing to learn, because the
// window was not caused by a read the player made — it arrived on a count.
//
// Three changes, and they are all in service of one sentence: THE WINDOW IS
// SOMETHING YOU CAUSE.
//
//  1. The count is the boss's OWN verbs. The chassis (ground slam, the tier-3
//     ritual, hazard rain) no longer feeds it at all — only a kit verb, a
//     named band signature, and the two things below.
//  2. THE READ PAYS. A telegraphed heavy that catches NOBODY — you saw it and
//     left — advances the count by a whole extra step. Dodging is not merely
//     not-being-hit any more; it is progress toward the window.
//  3. Every boss owns its own WORD for it and its own count. `tell` is the
//     telegraph label (the FX table keys off it, so the shaft is the boss's),
//     `core` is what the exposed weak point is called, and `after` is how many
//     committed verbs this particular boss can spend before it over-extends.
//
// Plus `CONFIG.bossPunishRecovery`, a floor on how often a window may come
// round at all, so no boss is ever helpless for most of its own fight again.
// ---------------------------------------------------------------------------

export interface BossPunishRule {
  /** This boss's word for the over-commit — the telegraph label AND the HUD tell. */
  tell: string;
  /** What the exposed weak point is called once the window is open. */
  core: string;
  /** Committed verbs (or reads the player won) before it over-extends. */
  after: number;
}

const PUNISH_FALLBACK: BossPunishRule = {
  tell: "OVER-COMMIT", core: "EXPOSED CORE", after: CONFIG.bossPunishAfter,
};

export const BOSS_PUNISH: Record<BossId, BossPunishRule> = {
  // THE TEACHING BAND'S WINDOW HAS TO COME ROUND INSIDE THE TEACHING BAND'S
  // FIGHT (r6 blocker). Measured: 0.0 punish windows per fight on The Temp and
  // The Rent Collector, because a floor-3 fight lasted 11-14s and their own
  // verbs come round every 6-8s. The count is 2 here and nowhere else: this is
  // the band that exists to teach the beat, so the beat has to happen twice.
  // ...but NOT the Concierge, whose window is its own MECHANIC (the empty
  // ledger) and which already measured 1.0 windows per fight. Dropping its
  // count would let the shared count fire first and then rate-limit the beat
  // the player earned, which is the opposite of what §2.2 asks for.
  concierge: { tell: "UNRECONCILED", core: "THE OPEN LEDGER", after: 4 },
  rentcollector: { tell: "OVERDRAWN", core: "THE EMPTY TILL", after: 2 },
  temp: { tell: "UNSUPERVISED", core: "NO ONE TO ASK", after: 2 },
  sumpking: { tell: "OUT OF HIS DEPTH", core: "THE DRY THRONE", after: 4 },
  inspector: { tell: "CITATION VOID", core: "THE BLANK PAD", after: 3 },
  greasetrap: { tell: "BACKFLOW", core: "THE TRAP CORE", after: 4 },
  topiary: { tell: "OVER-PRUNED", core: "THE BARE TRUNK", after: 3 },
  zoningboard: { tell: "OUT OF ORDER", core: "NO QUORUM", after: 3 },
  pollinator: { tell: "SEEDED OUT", core: "THE SPENT HEAD", after: 5 },
  architect: { tell: "LOAD SHIFT", core: "THE WEAK SPAN", after: 3 },
  permitoffice: { tell: "FILING ERROR", core: "THE UNSTAMPED FORM", after: 4 },
  foundation: { tell: "SETTLING", core: "THE CRACKED FOOTING", after: 4 },
  marshal: { tell: "VENTING", core: "THE FURNACE CORE", after: 3 },
  linesupervisor: { tell: "LINE JAM", core: "THE STOPPED BELT", after: 3 },
  safetyofficer: { tell: "NON-COMPLIANT", core: "THE OPEN CAGE", after: 3 },
  showrunner: { tell: "DEAD AIR", core: "THE EMPTY STAGE", after: 4 },
  standards: { tell: "MOTION FAILS", core: "THE EMPTY CHAIR", after: 4 },
  sponsor: { tell: "AD BREAK OVERRUN", core: "THE UNSOLD SLOT", after: 4 },
};

// ---------------------------------------------------------------------------
// THE CHASSIS SPEAKS IN THE ASK'S VOICE (r7 blocker).
//
// The measurement: `ch_volley` is the TOP entry in the threat vector on twelve
// of eighteen bosses and the #2 entry on the other five — the single most
// common thing that happens in a boss fight, on nearly the whole roster. Median
// chassis share (melee + volley + slam + rain + ritual) is 58%, and on the
// teaching band it is 78% with the boss's own kit windups at 6%. §5.12 moved
// the volley 3.4s -> 4.6s and 10 -> 6 bolts and it stayed the modal event,
// because slowing a universal does not stop it being a universal.
//
// The critic named the two honest fixes: make the volley a KIT verb about six
// bosses own, or DERIVE ITS CADENCE FROM THE ASK. This is the second, and it is
// the one that does not need eighteen new kit blocks — the volley is genuinely
// chassis (a boss with no ranged answer is a boss you kite), so what has to
// stop is it being the SAME chassis on a break-the-shield boss and a
// kill-the-adds boss.
//
// The shape of the table is the design statement:
//   - `adds` and `storm` do not fire it AT ALL. Their ask already fills the air
//     with bodies and with ground; a ring of bolts on top is the chassis
//     talking over the mechanic the fight is named for.
//   - `lane` fires a thin, slow one. A lane boss's whole ask is "read the line
//     on the floor" and undodgeable bolts are the exact noise that ask cannot
//     survive; what is left is a reason not to stand still at range.
//   - `shield` and `arena` keep a real volley — those two asks send the player
//     to a PLACE (the weak point, the good ground), and the volley is the
//     price of the trip.
//   - `window` fires the densest one, on the shortest clock. The burst-the-
//     window fight is explicitly a rhythm of pressure and relief: the pressure
//     between windows is supposed to be the chassis, and the punish window
//     already suppresses it outright (`punishQuietT`).
//
// Everything the asks below give up in ambient chip is already paid for on the
// kit side by `bossKitDmgMult` (§5.12), which is the knob the ablation reads.
// ---------------------------------------------------------------------------

export interface BossChassisRule {
  /** Seconds between radial volleys; 0 means this ask does not fire one. */
  volleyCd: number;
  /** Bolts per volley. */
  volleyCount: number;
  /** Multiplier on `bossHazardCooldown` (the phase-1+ rain). */
  rainMult: number;
}

// `rainMult` scales `bossHazardCooldown`, so BELOW 1 is MORE rain. The asks
// that give the volley up entirely get some of that pressure back as rain
// instead — and that is a straight upgrade for the fight's readability, because
// the rain ARMS (`bossHazardDelay`) and the volley never did. What the roster
// loses is undodgeable chip; what it keeps is a reason to keep moving.
export const ASK_CHASSIS: Record<BossAsk, BossChassisRule> = {
  adds: { volleyCd: 0, volleyCount: 0, rainMult: 0.78 },
  storm: { volleyCd: 0, volleyCount: 0, rainMult: 0.74 },
  lane: { volleyCd: 6.4, volleyCount: 4, rainMult: 0.88 },
  shield: { volleyCd: 4.6, volleyCount: 6, rainMult: 1.0 },
  arena: { volleyCd: 5.0, volleyCount: 6, rainMult: 0.95 },
  window: { volleyCd: 3.6, volleyCount: 8, rainMult: 1.1 },
};

/** The chassis rule this boss's ask asks for; the shipped defaults otherwise.
 *  A roster entry may override any field of it (`BossDef.chassis`). */
export function bossChassisRule(id?: BossId): BossChassisRule {
  const def = id ? bossDef(id) : undefined;
  const base = (def && ASK_CHASSIS[def.ask]) ||
    { volleyCd: CONFIG.bossVolleyCooldown, volleyCount: CONFIG.bossVolleyCount, rainMult: 1 };
  return def?.chassis ? { ...base, ...def.chassis } : base;
}

/** This boss's punish identity — total, pure, safe on an unknown id. */
export function bossPunishRule(id?: BossId): BossPunishRule {
  return (id && BOSS_PUNISH[id]) || PUNISH_FALLBACK;
}

/** Every punish tell the sim can emit (host FX + sound tables read this). */
export function allPunishTells(): string[] {
  return [...new Set(Object.values(BOSS_PUNISH).map((r) => r.tell))];
}

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
/** The ARENA DIRECTOR's room verb (game.ts `roomScript`) — seeded per run. */
export const SALT_ROOM = 0x2004e3;

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
  /**
   * It changes the boss's VERB LIST, not the ambient pressure around it
   * (acceptance r5, major). Measured across a 1,000-seed sweep: only
   * `retrofit` and `understudied` change what the fight ASKS, and they were
   * the two RAREST draws (4-10%) because they are the two with legality
   * conditions — while the six ambient-pressure affixes drew at 13-36%. If
   * the mutator layer is the answer to "why is THIS run different?", the
   * mutators that answer it cannot be the ones you almost never see. The draw
   * now prefers an ask-changer for the FIRST slot wherever one is legal.
   */
  changesAsk?: boolean;
  /**
   * Tickets in the first-slot draw (default 1) — r6 blocker, and the reason
   * `changesAsk` is no longer what buys them.
   *
   * r5 handed every ask-changer three tickets. Measured over a 4,000-seed
   * sweep afterwards, SPONSORED landed on 90.6% of runs and 26.2% of every
   * slot drawn — more than twice any other — because it is the only shaper
   * legal almost everywhere, while RETROFIT (5.6%) and UNDERSTUDIED (4.2%)
   * stayed the two rarest draws. The weighting went to the one shaper whose
   * measured effect was a stat line and away from the one layer a critic could
   * photograph actually changing a fight. So the tickets are DECLARED, not
   * derived: the conditional shapers carry them, and SPONSORED (fixed this
   * round, but common) draws at ordinary weight.
   */
  tickets?: number;
  /** The VERB this mutator owns — one imperative, and it must be a thing the
   *  player's hands do. `tools/_ed4mut.ts` is the acceptance test for it. */
  verb: string;
}

// ---------------------------------------------------------------------------
// r7 STRUCTURAL 1 — A MUTATOR MUST OWN A VERB.
//
// The measurement that opened this round, and it is the same instrument that
// has judged every mutator claim since r4 (`tools/_ed4mut.ts`, 34 forced
// trials): MEDIAN mutator-vs-clean cosine 0.999, with 32 of 34 trials scoring
// >= 0.97 — "SAME FIGHT". Run-to-run, the same boss on a different seed scored
// 0.908 while a DIFFERENT boss in the same band scored 0.309: the NAME draw
// bought 0.599 of separation and mutators + arenas + seed combined bought
// 0.092. §4's "3 bosses x 8 mutators x ~2 arenas = 48 distinct encounters" was,
// in play, three encounters per band slot with 9% jitter.
//
// The cause is not weighting and it was never weighting. Six of the eight
// mutators were AMBIENT: more damage taken (LIVE AUDIENCE +40%), a shorter
// deadline (OVERTIME), a damage multiplier on a bubble (SPONSORED), a revive
// timer (UNION RULES), a telegraph length (REDACTED). Those change how much a
// fight hurts. None of them changes what the player has to DO, which is this
// table's own stated rule and has been since it was written.
//
// So every row below now names a VERB and owns the mechanic that demands it —
// a body that must be killed, ground that must be left, a lane that must be
// left, an armour that must be broken twice, a telegraph that must be re-read.
// The verbs are deliberately DIFFERENT FROM EACH OTHER: two mutators that both
// mean "kill the extra body" would multiply the draw table without multiplying
// the fight, which is the failure this round exists to stop repeating.
// ---------------------------------------------------------------------------

export const BOSS_MUTATORS: BossMutatorInfo[] = [
  {
    id: "entouraged", label: "ENTOURAGED", addsPressure: true,
    verb: "KILL THE BODY",
    note: "A tethered champion shields it, and the wings send a replacement. Kill the escort, again, or fight the boss at a third damage.",
    changesAsk: true,
  },
  {
    id: "unionrules", label: "UNION RULES", addsPressure: true,
    verb: "KILL IT AWAY FROM THE BOSS",
    note: "A picket rotates in on the clock and every one of them gets back up once. Break the line where it cannot be re-shifted.",
  },
  {
    id: "sponsored", label: "SPONSORED",
    verb: "LEAVE THE GROUND",
    // It changes WHERE the fight happens, which is a verb: the counterplay is
    // "move the fight", and on a boss that can move it is a real one.
    changesAsk: true,
    note: "The placement is LIVE GROUND it will not leave. Stand off the mark and drag it out, or burn on brand.",
    // ...WHICH A BOSS THAT CANNOT MOVE CAN NEVER BE PULLED OUT OF (r5 blocker).
    // The counterplay sentence is positional and `def.stationary` bosses have
    // `speed = 0` (applyBossDraw), so on The Grease Trap the bubble was simply
    // permanent damage reduction with no answer.
    legal: (def) => !def.stationary,
  },
  {
    id: "overtime", label: "OVERTIME",
    verb: "BE IN THE WEDGE",
    // r7: this was a deadline multiplier — a stat line with a countdown on it.
    // The slot being short is now something the room DOES: the hard out fires a
    // ring with exactly one gap in it, on a clock the player can count.
    changesAsk: true,
    note: "The slot is short and it runs to time. THE HARD OUT rings the arena every cycle — find the one gap before it closes.",
  },
  {
    id: "retrofit", label: "RETROFIT",
    verb: "READ A STRANGER'S TELEGRAPH",
    note: "Its signature is another band's. A familiar boss with an unfamiliar telegraph.",
    changesAsk: true,
    // A kit that calls its band signature BY NAME cannot be retrofitted: kits
    // route their signature cast through `castBandSignature`, which reads
    // `m.signature` — so this stays legal wherever a signature exists, and
    // `bosses.test.ts` pins that the routing holds.
    legal: (def) => !!def.signature,
  },
  {
    id: "understudied", label: "UNDERSTUDIED",
    verb: "BREAK IT TWICE",
    changesAsk: true,
    legal: (def) => !!def.plates || !!def.shield,
    note: "The stand-in re-plates itself on a channel, over and over. Interrupt the re-plate or break the same armour all night.",
  },
  {
    id: "liveaudience", label: "LIVE AUDIENCE",
    verb: "WATCH THE SEATS",
    note: "The crowd throws on a rhythm, and it leads you. The room is a second attacker with its own tell.",
  },
  {
    id: "redacted", label: "REDACTED",
    verb: "LEAVE THE STRUCK LANE",
    // r7: "shorter telegraphs" is a difficulty knob, not a verb. What REDACTED
    // does now is strike a CORRIDOR from the record — a lane that arms, fires
    // once and is gone, on top of shorter tells.
    changesAsk: true,
    note: "It strikes lanes from the record. Shorter tells, and the corridor you are standing in may stop existing.",
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
  // ---- THE TEACHING BAND DRAWS FROM THE WHOLE TABLE (r7 structural 2) ------
  //
  // r7 shipped a "teaching subset" of three mutators for floor 3, and a
  // 30,000-seed sweep measured what that narrowness actually produced: THE TEMP
  // draws ENTOURAGED on 100% of runs, forever, because it has no signature and
  // no plates and therefore exactly one legal mutator; the Rent Collector and
  // the Concierge collapse to two entries each. Five states across the whole
  // teaching band — in the one boss slot every short session is guaranteed to
  // reach. A subset chosen to protect the lesson deleted the variety the lesson
  // was supposed to be varied by.
  //
  // The subset is gone, and it is gone for a reason that is now true and was
  // not before: every mutator in the table owns a VERB (see BOSS_MUTATORS).
  // There is no longer a row on it that is ambient pressure or a stat line, so
  // there is no longer a row a first boss should not be allowed to teach. What
  // floor 3 still gets is exactly ONE of them.
  const legal = BOSS_MUTATORS.filter((m) => !m.legal || m.legal(def));
  if (legal.length === 0) return [];
  // TICKETS ARE FLAT AGAIN (r7 structural 1). r5 handed the "ask-changers"
  // three tickets each and r6 moved which rows carried them, and both rounds
  // were tuning the SHAPE of a draw over a table whose rows did not differ in
  // play (median mutator-vs-clean cosine 0.999). Weighting a draw is how you
  // pick between options that are genuinely different; it is not how you make
  // them different. Every row owns a verb now, so every row draws at one
  // ticket and the sweep in `tools/_ed4f3.ts` is the acceptance test for the
  // spread rather than a table of hand-set weights.
  const pool: BossMutatorInfo[] = [];
  for (const mut of legal) {
    for (let t = 0; t < Math.max(1, mut.tickets ?? 1); t++) pool.push(mut);
  }
  // The salt carries the FLOOR, not just the band. Two runs of the same band
  // slot are the thing this whole module exists to separate; folding the floor
  // in costs nothing and stops the mutator draw and the arena draw moving in
  // lockstep for a repeated seed.
  const first = pool[bossHash(seed, def.band, floor, SALT_MUT) % pool.length];
  const out: BossMutator[] = [first.id];
  if (floor >= CONFIG.bossMutatorSecondFromFloor || bonus) {
    // Never two that both add adds, and never the same one twice.
    const rest = legal.filter(
      (m) => m.id !== first.id && !(m.addsPressure && first.addsPressure),
    );
    if (rest.length > 0) {
      out.push(rest[bossHash(seed, def.band, floor, SALT_MUT2) % rest.length].id);
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
