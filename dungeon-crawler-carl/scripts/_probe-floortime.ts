// Probe: how long does CLEARING a floor actually take, floor by floor, against
// what the collapse timer allows? (owner 2026-08-07: "floor timers need to get
// a bit longer in later levels")
//
// Two passes per floor, both driving the scripted balance bot (src/sim/bot.ts)
// on an on-curve crawler (naturalFloorForLevel inverse + floor-scaled gear):
//   UNCENSORED — the clock is stubbed to a huge budget so the measurement is
//     "seconds of play this floor costs", not "seconds before the floor killed
//     us". Without this, floors that take too long report as deaths and the
//     clear-time average is silently truncated by the very budget under review.
//   LIVE — the real floorTimeBudget(), so the clear rate is the shipping one.
// The bot reads `state.timeRemaining < 45` as "losing" (one cast-gating
// heuristic), so the uncensored pass is a hair more patient than live play.
//
// Usage: npx tsx scripts/_probe-floortime.ts [seedCount] [floors...]
import { createTestGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";
import { CONFIG, floorTimeBudget, naturalFloorForLevel } from "../src/sim/config";

const SEEDS = Number(process.argv[2] ?? 8);
const FLOORS = process.argv.length > 3
  ? process.argv.slice(3).map(Number)
  : Array.from({ length: CONFIG.finalFloor }, (_, i) => i + 1);

// The level a crawler naturally carries ONTO this floor. Walks the curve and
// stops at the first level representative of the floor — a plain "largest L
// with naturalFloorForLevel(L) <= floor" saturates at finalFloor (every level
// past 23 maps to 18) and would dress floor 18 with a level-40 crawler.
const levelForFloor = (floor: number) => {
  let level = 1;
  for (let l = 1; l <= 40; l++) {
    if (naturalFloorForLevel(l) <= floor) level = l;
    if (naturalFloorForLevel(l) >= floor) break;
  }
  return level;
};

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

console.log(`floors ${FLOORS.join(",")} x ${SEEDS} seeds, on-curve crawler (level = naturalFloorForLevel inverse)\n`);
console.log("fl  lvl  budget |  uncensored clear-time (s)      | live clock");
console.log("                |  n   median   mean    p-slowest | cleared  min margin");

for (const floor of FLOORS) {
  const level = levelForFloor(floor);
  const budget = floorTimeBudget(floor);
  const free: number[] = [];
  let liveCleared = 0, liveMargin = Infinity;
  for (let seed = 1; seed <= SEEDS; seed++) {
    // UNCENSORED
    {
      const g = createTestGame({ seed, floor, level, abilities: "all" });
      g.timeBudget = 100_000;
      g.timeRemaining = 100_000;
      const r = runBot(g, 1, 200_000);
      const fl = r.floors[0];
      if (fl) free.push(fl.simSeconds);
    }
    // LIVE
    {
      const g = createTestGame({ seed, floor, level, abilities: "all" });
      const r = runBot(g, 1, 200_000);
      const fl = r.floors[0];
      if (fl) { liveCleared++; liveMargin = Math.min(liveMargin, fl.timeRemaining); }
    }
  }
  const slowest = free.length ? Math.max(...free) : NaN;
  console.log(
    `${String(floor).padStart(2)}  ${String(level).padStart(3)}  ${budget.toFixed(1).padStart(6)} | ` +
    `${String(free.length).padStart(2)}  ${median(free).toFixed(1).padStart(6)}  ${mean(free).toFixed(1).padStart(6)}  ${slowest.toFixed(1).padStart(8)} | ` +
    `${String(liveCleared).padStart(2)}/${SEEDS}     ${(liveMargin === Infinity ? NaN : liveMargin).toFixed(1).padStart(6)}`,
  );
}
