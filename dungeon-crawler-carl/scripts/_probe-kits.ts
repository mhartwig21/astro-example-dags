/* Throwaway kit-comparison probe for ABILITIES-V2. Not shipped. */
import { createTestGame, step, chooseReward, chooseUpgrade, setReady } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { ABILITY_SLOTS } from "../src/sim/abilities";
import type { AbilityId } from "../src/sim/abilities";
import type { GameState } from "../src/sim/types";

/** Bot run that GREEDILY presses every slot + the ultimate (cooldowns no-op). */
function run(g: GameState, greedy: boolean, maxSteps = 90_000) {
  const dt = 1 / 60;
  const mem = freshMemory();
  const p = g.players[0];
  const startFloor = g.floor;
  let steps = 0;
  const dmg0 = p.damageTaken;
  while (steps < maxSteps && g.status === "playing" && g.floor < startFloor + 1 && !g.safeRoom) {
    if (p.pendingRewards.length > 0) chooseReward(g, p.id, 0);
    if (p.pendingUpgrades.length > 0) chooseUpgrade(g, p.id, 0);
    const intent = botIntent(g, mem);
    if (greedy) {
      const cast = [...(intent.cast ?? [])];
      while (cast.length < ABILITY_SLOTS + 1) cast.push(false);
      for (let s = 0; s < ABILITY_SLOTS + 1; s++) cast[s] = true;
      intent.cast = cast;
    }
    step(g, intent, dt);
    steps++;
  }
  return {
    cleared: g.safeRoom || g.floor > startFloor,
    died: g.status === "dead",
    seconds: steps / 60,
    dmg: p.damageTaken - dmg0,
    kills: p.kills,
    hpPct: p.hp / p.maxHp,
  };
}

const KITS: [string, AbilityId[]][] = [
  ["4th=none", []],
  ["4th=nova", ["nova"]],
  ["4th=orbit", ["orbit"]],
  ["4th=stance", ["stance"]],
  ["4th=overcharge", ["overcharge"]],
  ["4th=cutto", ["cutto"]],
  ["4th=crowdsurf", ["crowdsurf"]],
  ["4th=stuntdouble", ["stuntdouble"]],
];
const ULTS: [string, AbilityId[]][] = [
  ["ult=none", []],
  ["ult=airstrike", ["airstrike"]],
  ["ult=cataclysm", ["cataclysm"]],
  ["ult=bullettime", ["bullettime"]],
];

const SEEDS = [21, 22, 23, 24, 25, 26, 27, 28];
const floor = 8, level = 13;

console.log("=== 4th-SLOT COMPARISON (greedy bot, floor " + floor + " lvl " + level + ", " + SEEDS.length + " seeds) ===");
for (const [name, abil] of KITS) {
  let cleared = 0, died = 0, secs = 0, dmg = 0, kills = 0;
  for (const seed of SEEDS) {
    const g = createTestGame({ seed, floor, level, abilities: abil });
    const r = run(g, true);
    if (r.cleared) { cleared++; secs += r.seconds; }
    if (r.died) died++;
    dmg += r.dmg; kills += r.kills;
  }
  console.log("  " + name.padEnd(16) + " cleared " + cleared + "/" + SEEDS.length +
    "  died " + died + "  avgClearSec " + (cleared ? (secs / cleared).toFixed(0) : "-") +
    "  dmgTaken " + dmg.toFixed(0) + "  kills " + kills);
}

console.log("\n=== ULTIMATE COMPARISON (greedy bot, same fixture, 4th=nova) ===");
for (const [name, abil] of ULTS) {
  let cleared = 0, died = 0, secs = 0, dmg = 0, kills = 0;
  for (const seed of SEEDS) {
    const g = createTestGame({ seed, floor, level, abilities: ["nova", ...abil] as AbilityId[] });
    const r = run(g, true);
    if (r.cleared) { cleared++; secs += r.seconds; }
    if (r.died) died++;
    dmg += r.dmg; kills += r.kills;
  }
  console.log("  " + name.padEnd(16) + " cleared " + cleared + "/" + SEEDS.length +
    "  died " + died + "  avgClearSec " + (cleared ? (secs / cleared).toFixed(0) : "-") +
    "  dmgTaken " + dmg.toFixed(0) + "  kills " + kills);
}

console.log("\n=== BASELINE BOT vs GREEDY BOT (4th=nova, ult=airstrike) ===");
for (const greedy of [false, true]) {
  let cleared = 0, died = 0, secs = 0, dmg = 0, kills = 0;
  for (const seed of SEEDS) {
    const g = createTestGame({ seed, floor, level, abilities: ["nova", "airstrike"] });
    const r = run(g, greedy);
    if (r.cleared) { cleared++; secs += r.seconds; }
    if (r.died) died++;
    dmg += r.dmg; kills += r.kills;
  }
  console.log("  " + (greedy ? "greedy" : "baseline").padEnd(16) + " cleared " + cleared + "/" + SEEDS.length +
    "  died " + died + "  avgClearSec " + (cleared ? (secs / cleared).toFixed(0) : "-") +
    "  dmgTaken " + dmg.toFixed(0) + "  kills " + kills);
}
