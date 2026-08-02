// Probe: floors-1-4 survival + the level a bot carries out of each floor.
// Used to tell "the bot got worse" apart from "the seed lottery re-rolled"
// whenever a bot-policy change moves test/balance.test.ts's fixed seed.
import { createGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";

const N = Number(process.argv[2] ?? 30);
const BANDS: [number, number][] = [[1, 4], [3, 7], [6, 9], [8, 12]];
let survived = 0;
const onBand: number[] = [];
for (let seed = 1; seed <= N; seed++) {
  const g = createGame(seed);
  const levels: number[] = [];
  let died = false;
  for (let f = 0; f < 4 && !died; f++) {
    const r = runBot(g, 1, 400_000);
    if (r.died) { died = true; break; }
    levels.push(g.players[0].level);
  }
  if (!died) survived++;
  const fits = !died && levels.every((l, i) => l >= BANDS[i][0] && l <= BANDS[i][1]);
  if (fits) onBand.push(seed);
  console.log(`seed ${seed}: ${died ? `died f${levels.length + 1}` : `cleared 4 (levels ${levels.join("/")})`}${fits ? "  ON-BAND" : ""}`);
}
console.log(`SURVIVED-4 ${survived}/${N}`);
console.log(`ON-BAND seeds: ${onBand.join(", ")}`);
