// Crafted room templates (builder.html → exported JSON → committed here).
// The sim stamps their TILES deterministically (floor.ts); hosts place their
// PROPS cosmetically via the stamps the map carries. Contract enforced by
// validateTemplate: 1-tile floor border (never seals a doorway) and an open
// center (elite spawn probes stay walkable).

import type { RoomTemplate } from "../types";
import crateCache from "./crate-cache.json";

export const ROOM_TEMPLATES: RoomTemplate[] = [
  crateCache as RoomTemplate,
];

const byId = new Map(ROOM_TEMPLATES.map((t) => [t.id, t]));
export const roomTemplateById = (id: string): RoomTemplate | undefined => byId.get(id);

/** A template is stampable when its border ring and center tile are floor. */
export function validateTemplate(t: RoomTemplate): boolean {
  if (t.tiles.length !== t.w * t.h) return false;
  for (let x = 0; x < t.w; x++) {
    if (t.tiles[x] !== 1 || t.tiles[(t.h - 1) * t.w + x] !== 1) return false;
  }
  for (let y = 0; y < t.h; y++) {
    if (t.tiles[y * t.w] !== 1 || t.tiles[y * t.w + t.w - 1] !== 1) return false;
  }
  const cx = Math.floor(t.w / 2), cy = Math.floor(t.h / 2);
  return t.tiles[cy * t.w + cx] === 1;
}
