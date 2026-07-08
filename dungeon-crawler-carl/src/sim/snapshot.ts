import type { GameState } from "./types";

// Snapshot layer: GameState <-> JSON. The authoritative server serializes state
// for WebSocket snapshots (and persistence); clients deserialize and render.
// GameState is already plain data (the RNG is `{ state: number }`) except for two
// Uint8Arrays (map tiles + fog mask), which round-trip as number[]. Determinism
// guarantee: stepping a deserialized snapshot produces exactly the same states as
// stepping the original (covered by a golden test).

interface WireState extends Omit<GameState, "explored" | "map"> {
  explored: number[];
  map: Omit<GameState["map"], "tiles"> & { tiles: number[] };
}

/** Encode a game state as a JSON string (safe to send over the wire / persist). */
export function serialize(state: GameState): string {
  const wire: WireState = {
    ...state,
    explored: Array.from(state.explored),
    map: { ...state.map, tiles: Array.from(state.map.tiles) },
  };
  return JSON.stringify(wire);
}

/** Decode a serialized game state, reviving typed arrays. */
export function deserialize(json: string): GameState {
  const wire = JSON.parse(json) as WireState;
  return {
    ...wire,
    explored: new Uint8Array(wire.explored),
    map: { ...wire.map, tiles: new Uint8Array(wire.map.tiles) },
  };
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
export function serializeFor(state: GameState, playerId: number): string {
  if (state.mode !== "rivals" || !state.worlds) return serialize(state);
  const me = state.players.find((p) => p.id === playerId);
  const floors = Object.keys(state.worlds).map(Number);
  const floorNo = me?.floorNo ?? Math.min(...floors);
  const w = state.worlds[floorNo] ?? state.worlds[Math.min(...floors)];
  const rivals: RivalMeta[] = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    floor: p.safeRoom ? p.safeRoom.nextFloor : p.floorNo,
    level: p.level,
    alive: p.alive,
    downedT: p.downedT ?? 0,
    shopping: !!p.safeRoom,
  }));
  const view = {
    ...state,
    ...w,
    worlds: undefined, // never ship the multiverse
    players: state.players.filter(
      (p) => p.id === playerId || (p.floorNo === floorNo && !p.safeRoom),
    ),
    safeRoom: me?.safeRoom ?? null, // the personal shop rides the classic slot
    rivals,
    explored: Array.from(w.explored),
    map: { ...w.map, tiles: Array.from(w.map.tiles) },
  };
  return JSON.stringify(view);
}
