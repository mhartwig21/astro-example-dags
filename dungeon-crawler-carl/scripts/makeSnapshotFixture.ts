import { writeFileSync } from "node:fs";
import { createGame, step } from "../src/sim/game";
import { serialize, SNAPSHOT_VERSION } from "../src/sim/snapshot";
import type { Intent } from "../src/sim/types";

// Regenerates the golden fixture for PERSISTED world snapshots
// (test/fixtures/world-snapshot.json). Run after bumping SNAPSHOT_VERSION:
//   npx tsx scripts/makeSnapshotFixture.ts
// The fixture is a real mid-run state: deterministic seed, 240 ticks of a
// scripted crawler fighting its way through floor 1.

const g = createGame(31337);
const intents: Intent[] = [
  { move: { x: 1, y: 0 }, attack: true, useStairs: false, aim: { x: 1, y: 0 } },
  { move: { x: 0, y: 1 }, attack: false, useStairs: false, bolt: true },
  { move: { x: -1, y: 0 }, attack: true, useStairs: false },
];
for (let i = 0; i < 240; i++) step(g, intents[i % intents.length], 1 / 30);

writeFileSync(
  "test/fixtures/world-snapshot.json",
  JSON.stringify({ version: SNAPSHOT_VERSION, snapshot: serialize(g) }),
);
console.log(`wrote test/fixtures/world-snapshot.json (version ${SNAPSHOT_VERSION}, ${g.monsters.length} monsters, floor ${g.floor})`);
