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
