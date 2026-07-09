import { CONFIG } from "./config";
import type { GameState, Monster, Player } from "./types";

// Snapshot layer: GameState <-> JSON. The authoritative server serializes state
// for WebSocket snapshots (and persistence); clients deserialize and render.
// GameState is already plain data (the RNG is `{ state: number }`) except for two
// Uint8Arrays (map tiles + fog mask), which round-trip as number[]. Determinism
// guarantee: stepping a deserialized snapshot produces exactly the same states as
// stepping the original (covered by a golden test).
//
// TWO WIRE SHAPES. A FULL snapshot carries everything, including the tile grid
// and fog mask — sent on join and whenever the world changes (new floor, doors
// unlocking bump mapVersion). The recurring 15/s snapshot is DYNAMIC: it omits
// map + explored, which are static/monotonic and were ~half the payload. The
// client re-attaches its cached map and maintains fog locally with
// revealExplored (game.ts) — same math the sim runs, driven by the same
// player positions, so the mask matches what the server would have sent.

/**
 * Version stamp for PERSISTED world snapshots (instance_snapshots in the
 * server DB). Bump ONLY when a stored snapshot can no longer be deserialized
 * and stepped safely — a removed/retyped GameState field, or a mapgen change
 * that invalidates stored tiles. New OPTIONAL fields with load-time defaults
 * do NOT need a bump (the codebase convention). A version-mismatched store
 * falls back to seed + floor + character saves, never corruption. After a
 * bump, regenerate the golden fixture: npx tsx scripts/makeSnapshotFixture.ts
 */
export const SNAPSHOT_VERSION = 1;

interface WireState extends Omit<GameState, "explored" | "map"> {
  explored: number[];
  map: Omit<GameState["map"], "tiles"> & { tiles: number[] };
}

/** Encode a FULL game state as a JSON string (join/world-change/persistence). */
export function serialize(state: GameState): string {
  const wire: WireState = {
    ...state,
    explored: Array.from(state.explored),
    map: { ...state.map, tiles: Array.from(state.map.tiles) },
  };
  return JSON.stringify(wire);
}

/** Decode a serialized FULL game state, reviving typed arrays. */
export function deserialize(json: string): GameState {
  const wire = JSON.parse(json) as WireState;
  return {
    ...wire,
    explored: new Uint8Array(wire.explored),
    map: { ...wire.map, tiles: new Uint8Array(wire.map.tiles) },
  };
}

/**
 * Interest management: the monsters a client could currently perceive. Fog
 * hides everything beyond vision anyway, and on dense floors the far crowd
 * was most of the recurring payload. Bosses, named elites, and key carriers
 * always ship — the boss bar, ringside intros, and the key don't wait on
 * proximity. Dynamic snapshots carry `monstersLeft` (the authoritative count)
 * so hosts can tell a cleared floor from a distant one.
 */
export function interestMonsters(monsters: readonly Monster[], players: readonly Player[]): Monster[] {
  const r2 = CONFIG.interestRadius * CONFIG.interestRadius;
  return monsters.filter((m) =>
    m.kind === "boss" || m.elite || m.hasKey ||
    players.some((p) => {
      if (!p.alive) return false;
      const dx = p.pos.x - m.pos.x, dy = p.pos.y - m.pos.y;
      return dx * dx + dy * dy <= r2;
    }));
}

/** Encode the recurring DYNAMIC snapshot: everything except map + fog mask,
 * with the monster list trimmed to the party's interest bubble. */
export function serializeDynamic(state: GameState): string {
  const wire = {
    ...state,
    monsters: interestMonsters(state.monsters, state.players),
    monstersLeft: state.monsters.length,
    explored: undefined, map: undefined, worlds: undefined,
  };
  return JSON.stringify(wire);
}

/** Decode a DYNAMIC snapshot onto the client's cached world (map + fog). */
export function deserializeDynamic(
  json: string, map: GameState["map"], explored: Uint8Array,
): GameState {
  const wire = JSON.parse(json) as Omit<GameState, "explored" | "map">;
  return { ...wire, map, explored };
}

/** Race standings shipped to every rivals client (the ticker's data). */
export interface RivalMeta {
  id: number;
  name: string;
  floor: number; // the floor they're on (or heading to, if shopping)
  level: number;
  alive: boolean;
  downedT: number;
  shopping: boolean;
}

/**
 * RIVALS: each client gets a PERSONAL snapshot — their floor's world mounted
 * into the classic slots (so the client renders it exactly like a co-op
 * state), their own shop as state.safeRoom, only same-floor players, plus
 * the standings meta for everyone. Nobody ships every world every tick.
 */
function rivalView(state: GameState, playerId: number) {
  const me = state.players.find((p) => p.id === playerId);
  const floors = Object.keys(state.worlds!).map(Number);
  const floorNo = me?.floorNo ?? Math.min(...floors);
  const w = state.worlds![floorNo] ?? state.worlds![Math.min(...floors)];
  const rivals: RivalMeta[] = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    floor: p.safeRoom ? p.safeRoom.nextFloor : p.floorNo,
    level: p.level,
    alive: p.alive,
    downedT: p.downedT ?? 0,
    shopping: !!p.safeRoom,
  }));
  return {
    view: {
      ...state,
      ...w,
      worlds: undefined, // never ship the multiverse
      players: state.players.filter(
        (p) => p.id === playerId || (p.floorNo === floorNo && !p.safeRoom),
      ),
      safeRoom: me?.safeRoom ?? null, // the personal shop rides the classic slot
      rivals,
    },
    world: w,
  };
}

/** The world identity a rivals client is looking at (drives full-vs-dynamic). */
export function rivalWorldKey(state: GameState, playerId: number): string {
  if (state.mode !== "rivals" || !state.worlds) return `${state.floor}:${state.mapVersion}`;
  const me = state.players.find((p) => p.id === playerId);
  const floors = Object.keys(state.worlds).map(Number);
  const floorNo = me?.floorNo ?? Math.min(...floors);
  const w = state.worlds[floorNo] ?? state.worlds[Math.min(...floors)];
  return `${floorNo}:${w.mapVersion}`;
}

/** FULL personal rivals snapshot (join + world changes). */
export function serializeFor(state: GameState, playerId: number): string {
  if (state.mode !== "rivals" || !state.worlds) return serialize(state);
  const { view, world } = rivalView(state, playerId);
  return JSON.stringify({
    ...view,
    explored: Array.from(world.explored),
    map: { ...world.map, tiles: Array.from(world.map.tiles) },
  });
}

/** Recurring DYNAMIC personal rivals snapshot (no map, no fog mask, monsters
 * trimmed to the interest bubble of this floor's crawlers). */
export function serializeForDynamic(state: GameState, playerId: number): string {
  if (state.mode !== "rivals" || !state.worlds) return serializeDynamic(state);
  const { view } = rivalView(state, playerId);
  return JSON.stringify({
    ...view,
    monsters: interestMonsters(view.monsters, view.players),
    monstersLeft: view.monsters.length,
    explored: undefined, map: undefined,
  });
}
