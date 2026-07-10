// Crafted enemies (builder.html → exported JSON → committed here).
// A def substitutes for its BEHAVIOR archetype at spawn time: the monster
// keeps kind = behavior (every ARCHETYPES[kind] read and ai.ts branch works
// untouched); the def layers stat multipliers + presentation via defId.

import type { CustomMobDef } from "../types";
import theAuditor from "./the-auditor.json";

export const MOB_DEFS: CustomMobDef[] = [
  theAuditor as CustomMobDef,
];

const byId = new Map(MOB_DEFS.map((d) => [d.id, d]));
export const mobDefById = (id: string): CustomMobDef | undefined => byId.get(id);

/** Register (or replace) a def at runtime — the builder's TEST-DRIVE path.
 *  Hosts call this before creating a test game so a work-in-progress enemy
 *  can spawn; shipped content still goes through the JSON registry. */
export function registerMobDef(d: CustomMobDef): void {
  const i = MOB_DEFS.findIndex((x) => x.id === d.id);
  if (i >= 0) MOB_DEFS[i] = d;
  else MOB_DEFS.push(d);
  byId.set(d.id, d);
}

/** Defs that can replace a spawn of `behavior` in `band` (0..5). */
export function defsFor(behavior: string, band: number): CustomMobDef[] {
  return MOB_DEFS.filter((d) =>
    d.behavior === behavior && (!d.bands || d.bands.includes(band)));
}
