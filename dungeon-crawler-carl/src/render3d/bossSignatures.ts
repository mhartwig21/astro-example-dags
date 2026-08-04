import type { BossAsk, BossId } from "../sim/types";

// ===========================================================================
// BOSSES V2 §5 — the PURE half of the boss presentation layer: which hue and
// which primitive a named signature speaks in, what each fight ASKS, and the
// per-boss playback rate that gives eighteen bosses eighteen audible tells
// out of one shared clip.
//
// It lives apart from bossFx.ts on purpose: this module imports nothing but
// types, so the AUDIO director and the 2D host can read the signature table
// without pulling three.js into their bundle. bossFx.ts owns the shaders and
// the scene graph; this owns the table they agree on.
//
// THE READABILITY CONTRACT that governs both halves:
//   1. Every telegraph parses in 0.2s — SHAPE first, hue second.
//   2. Nothing is a recolored nova. The nova is a ground ring that EXPANDS;
//      every primitive here moves differently on purpose (the shield shell
//      cracks, the tether pulses along its length, the punish beacon
//      converges DOWNWARD, the arena warning CONTRACTS). If two beats can be
//      confused at a glance, the shape is wrong — not the color.
//   3. No beat borrows a floor hue. Emissives run over white at their peak so
//      the bloom pass lifts them off any biome palette.
//
// HUE FAMILIES, by the fight ASK (§2.1) — the player should learn the VERB
// from the color before they learn the name, so each family reuses a meaning
// the game already taught with trash mobs:
//   lane   -> amber        (the charger's rush lane)
//   shield -> cyan-white   (the thing you burst)
//   adds   -> violet       (the necromancer's summon)
//   arena  -> rust         (masonry, debris, the room itself)
//   window -> white-gold   (crit gold: UNLOAD)
//   storm  -> acid green   (the spitter's ground)
// ===========================================================================
export type BossAskFamily = "lane" | "shield" | "adds" | "arena" | "window" | "storm";

export interface BossPalette { core: number; mid: number; rim: number }

export const ASK_PAL: Record<BossAskFamily, BossPalette> = {
  lane: { core: 0xfff0cf, mid: 0xffa227, rim: 0xa8410a },
  shield: { core: 0xf0fbff, mid: 0x62d8ff, rim: 0x1050a8 },
  adds: { core: 0xf2e6ff, mid: 0xa46bff, rim: 0x4c1aa8 },
  arena: { core: 0xffe2c4, mid: 0xd9743a, rim: 0x7a2a10 },
  window: { core: 0xfff8dc, mid: 0xffcf3c, rim: 0xa86a00 },
  storm: { core: 0xeaffd0, mid: 0x9ad838, rim: 0x2f6a12 },
};

/**
 * The primitive that stages a named signature.
 *
 * THE SILHOUETTE RULE (capture review, round 2). The first cut of this table
 * had seven labels across five different ASKS all resolving to a concentric
 * ring with white radial spokes - arena, window, shield, storm and adds fights
 * that differed by HUE and nothing else. Hue is the second read; if the shapes
 * match, the fights match.
 *
 * So each ask now owns a silhouette, chosen to stay distinguishable as pure
 * black-and-white masks:
 *
 *   lane   -> "lanes"  hard chevroned RECTANGLES running along the beam
 *   adds   -> "cords"  cords converging INWARD from the bodies that matter
 *   shield -> "shell"  a domed shell with CRACKS opening across it
 *   arena  -> "props"  geometry anchored on the PROPS, not on the boss
 *   storm  -> "cells"  a grid of cells lighting in sequence
 *   window -> "column" motes falling in, then a shaft standing up
 *
 * "ring" - the contracting arena ring, and the ONLY primitive still allowed to
 * draw radial spokes - is reserved to the ARENA ask, one signature deep.
 */
export type BossShape =
  | "column" | "ring" | "lanes" | "cords" | "shell" | "props" | "cells"
  | "burrow" | "swarm" | "brand" | "quake" | "set" | "burst";

/**
 * The SIGNATURE table — one row per named telegraph the sim can emit (§7.4).
 * This is the whole "18 bosses, 18 identities" promise on the presentation
 * side: the LABEL is the key, so a new boss kit that emits a new label gets
 * its own beat by adding one row here and touching nothing else.
 *
 * `shape` picks the primitive; `family` picks the hue; `rate` pitches the one
 * shared telegraph clip so every boss has an audible fingerprint (§5.4 —
 * audio is the fastest telegraph channel we have, and we have no new clips,
 * so the pitch IS the signature).
 */
export interface BossSignatureFx {
  family: BossAskFamily;
  shape: BossShape;
  /** Playback rate for the shared `tell` clip — the boss's audible signature. */
  rate: number;
  /** Screen trauma at commit. Telegraphs shake LESS than impacts, always. */
  trauma?: number;
}

export const BOSS_SIGNATURES: Record<string, BossSignatureFx> = {
  // ---- THE UNDERCROFT ------------------------------------------------------
  // The Crypt Concierge rings for service: CORDS converge on the desk out of
  // the dark, one per body being checked in. Adds fights get cords, always —
  // the shape says "things are arriving", which is the whole ask.
  "RING FOR SERVICE": { family: "adds", shape: "cords", rate: 0.78 },
  "CHECK-IN": { family: "adds", shape: "cords", rate: 0.84 },
  // The Rent Collector seizes gold: motes fall INWARD, then the lockbox
  // stands up in the shaft. Window family, because the lockbox IS the window.
  "LATE FEE": { family: "window", shape: "column", rate: 1.22, trauma: 0.12 },
  // The Temp reaches down a locked lane. The lane is the whole tell.
  OVERREACH: { family: "lane", shape: "lanes", rate: 1.05 },
  "TRANSFORMATION CLAUSE": { family: "window", shape: "brand", rate: 0.7, trauma: 0.2 },
  "CLAUSE DENIED": { family: "window", shape: "burst", rate: 1.4 },
  "CLAUSE EXECUTED": { family: "arena", shape: "brand", rate: 0.62, trauma: 0.35 },
  "LAST CALL": { family: "adds", shape: "cords", rate: 0.58, trauma: 0.18 },

  // ---- THE SEWERS ----------------------------------------------------------
  // The Sump King's surge is the ONE signature allowed the radial-spoke ring:
  // the room is changing state, and nothing else in the game may say that.
  "FLOOD SURGE": { family: "arena", shape: "ring", rate: 0.72, trauma: 0.14 },
  // ...and its sluices vent from the GATES, so the geometry hangs off the
  // props. Prop-anchored is what "use the arena" has to look like.
  "SLUICE GATE": { family: "arena", shape: "props", rate: 0.68, trauma: 0.12 },
  // Citations condemn the ground: chevroned rectangles down the lane, hard
  // edged, no soft falloff anywhere.
  CITATION: { family: "lane", shape: "lanes", rate: 1.12 },
  // The Grease Trap inhales: a ring that CONTRACTS on the pit — the one beat
  // in the game that moves inward, because you are the thing being pulled.
  "THE PIT PULLS": { family: "arena", shape: "burrow", rate: 0.66, trauma: 0.16 },
  "THE DRAIN OPENS": { family: "arena", shape: "burrow", rate: 0.54, trauma: 0.24 },

  // ---- THE GARDEN ----------------------------------------------------------
  // The Topiary Warden's roots hold you still while the hedge grows back: the
  // beat converges, because being HELD is the thing it does to you.
  "ENTANGLING ROOTS": { family: "storm", shape: "burrow", rate: 0.88 },
  // The Pollinator seeds: a low swarm that scatters wide and settles.
  BLOOM: { family: "storm", shape: "swarm", rate: 1.3 },
  "SEED HEAD": { family: "storm", shape: "swarm", rate: 0.6, trauma: 0.16 },
  "HARD PRUNE": { family: "shield", shape: "shell", rate: 0.6, trauma: 0.2 },
  "EXECUTIVE SESSION": { family: "adds", shape: "cords", rate: 0.62, trauma: 0.2 },

  // ---- THE RUINS -----------------------------------------------------------
  "FISSURE: FAN": { family: "lane", shape: "lanes", rate: 0.72, trauma: 0.22 },
  "FISSURE: RADIAL": { family: "lane", shape: "lanes", rate: 0.66, trauma: 0.3 },
  FISSURE: { family: "lane", shape: "lanes", rate: 0.7, trauma: 0.24 },
  // The masonry EATS your cover, so both Architect beats are anchored on the
  // cover it is about to take: the ARENA ask draws on the ARENA.
  "CONTROLLED DEMOLITION": { family: "arena", shape: "props", rate: 0.6, trauma: 0.28 },
  "DEBRIS RAIN": { family: "arena", shape: "props", rate: 0.58, trauma: 0.26 },
  // The Permit Office stamps: a shell, because the stamps ARE its armour, and
  // one lane stops existing for every stamp you crack off it.
  "STOP-WORK ORDER": { family: "shield", shape: "shell", rate: 1.05, trauma: 0.14 },
  "FINAL NOTICE": { family: "shield", shape: "shell", rate: 0.66, trauma: 0.22 },
  "LOAD TEST": { family: "lane", shape: "lanes", rate: 0.56, trauma: 0.26 },

  // ---- THE IRONWORKS -------------------------------------------------------
  // The Furnace Marshal's wall of fire: pick a gap and COMMIT. Amber, and it
  // marches — the one signature that is literally a moving line.
  "FLAME SWEEP": { family: "lane", shape: "lanes", rate: 0.82, trauma: 0.16 },
  "FULL BURN": { family: "lane", shape: "lanes", rate: 0.5, trauma: 0.3 },
  // Cells lighting in sequence: the lattice is a TIMING puzzle, and the shape
  // has to say "safe squares, for now" rather than "a big bright thing".
  "COMPLIANCE LATTICE": { family: "storm", shape: "cells", rate: 1.36 },
  "FULL COMPLIANCE": { family: "storm", shape: "cells", rate: 0.7, trauma: 0.22 },
  "PRODUCTION QUOTA": { family: "adds", shape: "cords", rate: 0.92 },
  "MANDATORY OVERTIME": { family: "adds", shape: "cords", rate: 0.55, trauma: 0.2 },

  // ---- THE APPROACH --------------------------------------------------------
  // The Showrunner re-dresses the set: FLATS slide in from the wings. It is the
  // only rectangular full-arena beat in the game, so it cannot be confused with
  // the Sponsor's shield dome the way the old shared ring was.
  SET: { family: "arena", shape: "set", rate: 0.9, trauma: 0.2 },
  "SET STRIKE": { family: "arena", shape: "set", rate: 0.52, trauma: 0.3 },
  // Brand Integration is a PROPERTY of the boss: the shell, cracking, in the
  // school's own hue. Never a disc on the floor.
  BRAND: { family: "shield", shape: "shell", rate: 1.16 },
  "BRAND: MAGIC": { family: "shield", shape: "shell", rate: 1.44 },
  "BRAND: PHYSICAL": { family: "shield", shape: "shell", rate: 1.16 },
  "AD BREAK": { family: "shield", shape: "shell", rate: 0.5, trauma: 0.26 },
  // The Standards Board fires THROUGH its seats: cords from every chair.
  "MOTION CARRIED": { family: "adds", shape: "cords", rate: 1.28, trauma: 0.16 },
  "FINAL RULING": { family: "adds", shape: "cords", rate: 0.48, trauma: 0.32 },

  // ---- THE BAND SIGNATURES, RENAMED PER BOSS (BAND_SIG_LABEL in bosses.ts) --
  // Round 3 acceptance: ENTANGLING ROOTS was the live beat line on three
  // different bosses across three different asks, because four hazards were
  // shared and so were their names. The sim now hands every boss its own word
  // for the shared hazard; these are the rows those words resolve through, and
  // each one carries the ASK's family and its own pitch so the rename is a
  // different FIGHT on screen and in the ear, not a different caption.
  //
  // floor 6 (flood): the King owns the spoked ring; the other two do not.
  "SEWER BACKUP": { family: "lane", shape: "props", rate: 0.86 },
  "THE GREASE RISES": { family: "adds", shape: "burrow", rate: 0.6, trauma: 0.12 },
  // floor 9 (roots)
  "HEDGE GRASP": { family: "shield", shape: "cords", rate: 0.94 },
  "EASEMENT CLAIMED": { family: "adds", shape: "cords", rate: 0.7 },
  "RUNNER ROOTS": { family: "storm", shape: "cells", rate: 1.18 },
  "IRRIGATION SURGE": { family: "shield", shape: "props", rate: 0.8 },
  "STORMWATER VARIANCE": { family: "adds", shape: "props", rate: 0.74 },
  "GROUNDWATER BLOOM": { family: "storm", shape: "swarm", rate: 1.1 },
  // floor 12 (debris / borrowed roots)
  "CONDEMNATION NOTICE": { family: "shield", shape: "shell", rate: 0.9, trauma: 0.2 },
  SPALL: { family: "lane", shape: "lanes", rate: 0.64, trauma: 0.24 },
  "CREEPING RUIN": { family: "arena", shape: "props", rate: 0.68 },
  "UNPERMITTED GROWTH": { family: "shield", shape: "cords", rate: 0.88 },
  SUBSIDENCE: { family: "lane", shape: "lanes", rate: 0.58, trauma: 0.2 },
  // floor 15 (flamewall / borrowed debris)
  "LINE PURGE": { family: "adds", shape: "lanes", rate: 0.96 },
  "EVACUATION DRILL": { family: "storm", shape: "cells", rate: 1.24 },
  "CEILING FAILURE": { family: "window", shape: "props", rate: 0.72, trauma: 0.24 },
  "TOOL DROP": { family: "adds", shape: "props", rate: 1.0 },
  "OVERHEAD HAZARD": { family: "storm", shape: "props", rate: 1.06 },
  // floor 18 — a finale can wear any of the four, and never anonymously.
  "PYRO CUE": { family: "arena", shape: "lanes", rate: 0.88, trauma: 0.2 },
  "SET COLLAPSE": { family: "arena", shape: "set", rate: 0.56, trauma: 0.28 },
  "GREEN ROOM": { family: "arena", shape: "cords", rate: 0.8 },
  "WATER FEATURE": { family: "arena", shape: "props", rate: 0.76 },
  CENSURE: { family: "adds", shape: "lanes", rate: 1.32, trauma: 0.18 },
  "STRUCK FROM THE RECORD": { family: "adds", shape: "props", rate: 1.2, trauma: 0.2 },
  TABLED: { family: "adds", shape: "cords", rate: 1.1 },
  "MOTION TO FLOOD": { family: "adds", shape: "props", rate: 1.02 },
  "AD SPOT: FIRE": { family: "shield", shape: "lanes", rate: 1.28, trauma: 0.18 },
  "PRODUCT PLACEMENT": { family: "shield", shape: "props", rate: 1.34 },
  "ORGANIC REACH": { family: "shield", shape: "cords", rate: 1.2 },
  "SPONSORED CONTENT": { family: "shield", shape: "props", rate: 1.4 },
  // floor 3 (graverising) — the Concierge keeps CHECK-IN; the others do not.
  "PAST-DUE ACCOUNTS": { family: "window", shape: "cords", rate: 1.16 },
  "PREVIOUS TEMPS": { family: "window", shape: "cords", rate: 1.3 },
  "THE DROWNED RISE": { family: "arena", shape: "cords", rate: 0.64 },
  "CONDEMNED, RISING": { family: "lane", shape: "cords", rate: 0.9 },
  "SKIMMED OFF THE TOP": { family: "adds", shape: "cords", rate: 0.68 },

  // ---- The Topiary Warden's own verb (round 3: it had none) ----------------
  // A break-the-shield boss must SHOW a shield, so the regrow channel wears the
  // shell — the dome, closing back up — and nothing else in the game does that.
  "HEDGE REGROWTH": { family: "shield", shape: "shell", rate: 0.76, trauma: 0.14 },

  // ---- shared chassis verbs (any boss can commit these) ---------------------
  // The generic channel, for a boss with no name of its own for it. Every
  // shipped boss now has one (RITUAL_LABEL in ai.ts): this is the fallback.
  "DARK RITUAL": { family: "arena", shape: "column", rate: 0.55, trauma: 0.18 },
  "OVER-COMMIT": { family: "window", shape: "burrow", rate: 1.5 },
};

/** The ask a boss belongs to — the hue when a label has no row of its own. */
export const BOSS_FAMILY: Record<BossId, BossAskFamily> = {
  concierge: "adds", rentcollector: "window", temp: "window",
  sumpking: "arena", inspector: "lane", greasetrap: "adds",
  topiary: "shield", zoningboard: "adds", pollinator: "storm",
  architect: "arena", permitoffice: "shield", foundation: "lane",
  marshal: "window", linesupervisor: "adds", safetyofficer: "storm",
  showrunner: "arena", standards: "adds", sponsor: "shield",
};

/**
 * The ASK, in the player's words. §2.1 says a boss whose ask you cannot name
 * in four words is a big monster with more HP — so the name card states the
 * ask outright. Hades' clarity: tell them what the fight WANTS, then let the
 * fight be hard.
 */
export const ASK_LABEL: Record<BossAsk, string> = {
  lane: "DODGE THE LANE",
  shield: "BREAK THE SHIELD",
  adds: "KILL THE ADDS",
  arena: "USE THE ARENA",
  window: "BURST THE WINDOW",
  storm: "SURVIVE THE STORM",
};

/** The ask's own hue family (the HUD tints the plate's ask chip with it). */
export const ASK_TO_FAMILY: Record<BossAsk, BossAskFamily> = {
  lane: "lane", shield: "shield", adds: "adds",
  arena: "arena", window: "window", storm: "storm",
};

export function bossFamily(bossId?: BossId): BossAskFamily {
  return bossId ? BOSS_FAMILY[bossId] ?? "arena" : "arena";
}

export function signatureFor(label: string | undefined, bossId?: BossId): BossSignatureFx {
  if (label && BOSS_SIGNATURES[label]) return BOSS_SIGNATURES[label];
  // "SET: PILLARED" / "BRAND: PHYSICAL" fall back to their head token.
  if (label) {
    const head = label.split(":")[0].trim();
    if (BOSS_SIGNATURES[head]) return BOSS_SIGNATURES[head];
  }
  return { family: bossFamily(bossId), shape: "ring", rate: 1 };
}
