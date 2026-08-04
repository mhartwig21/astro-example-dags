// Scratch probe (step 0 diagnosis): WHAT kills the bot mid-late game?
// Prints, for each dying seed: death floor, timeRemaining at death, hp curve
// context, whether the floor's boss was alive, monster count, and the last
// few events. Usage: npx tsx scripts/_probe-deathcause.ts [count] [startSeed]
import { createGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";
import { CONFIG } from "../src/sim/config";

const COUNT = Number(process.argv[2] ?? 12);
const START = Number(process.argv[3] ?? 1);

for (let i = 0; i < COUNT; i++) {
  const seed = START + i;
  const g = createGame(seed);
  const events: string[] = [];
  // Tap events as they stream (runBot doesn't clear them, step() does).
  const r = runBot(g, CONFIG.finalFloor + 2, 3_000_000);
  const p = g.players[0];
  if (r.won) { console.log(`seed ${seed}: WON`); continue; }
  const boss = g.monsters.find((m) => m.kind === "boss" && m.hp > 0);
  const alive = g.monsters.filter((m) => m.hp > 0).length;
  const elites = g.monsters.filter((m) => m.hp > 0 && m.elite).length;
  const lastFloor = r.floors[r.floors.length - 1];
  console.log(
    `seed ${seed}: died f${g.floor} | timeRemaining=${g.timeRemaining.toFixed(0)}s phase=${g.phase}` +
    ` | boss alive=${boss ? "YES" : "no"} | monsters=${alive} (${elites} elite)` +
    ` | lvl=${p.level} maxHp=${p.maxHp} armor=${p.armor}` +
    ` | prev floor: ${lastFloor ? `${lastFloor.simSeconds.toFixed(0)}s, ${lastFloor.damageTaken.toFixed(0)} dmg taken` : "-"}`,
  );
  void events;
}
