// Resident STAGING (PHYSICALITY.md §2): what a dressed room's pack does
// until you interrupt it. Pure presentation — the sim's only contributions
// already shipped (Monster.residentOf marks the cast, sentries hold their
// rooms, state.residentAggro flips when the scene is broken).
//
// The A1 clip audit found REAL clips for everything (rig_medium_simulation +
// rig_medium_tools are loaded in RIG_CLIP_MANIFEST): the mess hall sits at
// dinner, the barracks lies asleep, the forge hammers, the kitchen chops,
// the training hall does push-ups between spars. Fuzzy clip matching means
// any character on the medium rig inherits all of it.
//
// Rules: staging only applies in the animator's IDLE slot — dormancy,
// stagger, windups, and locomotion all outrank it upstream in renderer3d's
// clip state machine, so the interruption transition is free. Once a room's
// scene breaks (residentAggro), its actors never resume the act.

import type { GameState, Monster } from "../sim/types";

interface Act {
  clip: string; // steady state (looped)
  rise?: string; // scene-break stand-up ONE-SHOT (the garrison gets UP)
  burst?: string; // occasional flourish, playFirst'd...
  burstEvery?: [number, number]; // ...this often (seconds, seeded by id)
  faceAnchor?: boolean; // turn toward the room's social anchor
}

// Canonical animator keys (renderer3d's clip table), NOT raw GLB names —
// bursts must be ONE-SHOT keys so the busy timer hands back to the loop.
const ACTS: Record<string, Act> = {
  mess: { clip: "stage_sit", rise: "stage_rise_sit", faceAnchor: true }, // dinner
  den: { clip: "stage_sit", rise: "stage_rise_sit", burst: "cheer", burstEvery: [6, 13], faceAnchor: true }, // the hand is going well
  barracks: { clip: "stage_lie", rise: "stage_rise_lie" }, // off shift
  kitchen: { clip: "stage_chop" }, // prep never stops
  forge: { clip: "stage_hammer" }, // the work order
  archive: { clip: "stage_sit", rise: "stage_rise_sit", faceAnchor: true }, // reading
  apothecary: { clip: "stage_work_b" }, // brewing
  warroom: { clip: "stage_idle_b", faceAnchor: true }, // the planning session
  trainhall: { clip: "stage_pushups", burst: "punch", burstEvery: [4, 8] }, // drills
  guardpost: { clip: "stage_idle_b" }, // the watch
  storage: { clip: "stage_hold" }, // stocktaking
  ossuary: { clip: "stage_idle_b" }, // filing
};

/** The staged clip for an idle resident, or null when the scene is over. */
export function residentAct(state: GameState, mon: Monster): Act | null {
  if (!mon.residentOf) return null;
  // The scene breaks for the whole room — on DETECTION (staged perception in
  // ai.ts) or on damage — and never resumes.
  if (state.residentAggro?.includes(mon.residentOf)) return null;
  const act = ACTS[mon.residentOf] ?? null;
  // Plan-seated actors sit ON the chair the plan put there (staging v2),
  // not cross-legged on the floor beside it.
  if (act && mon.seated && act.clip === "stage_sit") {
    return { ...act, clip: "stage_sit_chair", rise: "stage_rise_chair" };
  }
  return act;
}

/** Seeded per-monster burst period so a room's actors don't sync like a chorus line. */
export function burstPeriod(act: Act, id: number): number {
  if (!act.burst || !act.burstEvery) return Infinity;
  const [lo, hi] = act.burstEvery;
  return lo + ((id * 2654435761) % 1000) / 1000 * (hi - lo);
}
