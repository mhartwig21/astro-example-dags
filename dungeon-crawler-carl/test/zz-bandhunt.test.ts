import { describe, it } from "vitest";
import { createGame } from "../src/sim/game";
import { runBot } from "../src/sim/bot";

describe("hunt", () => {
  it("fresh-seed clear rate", () => {
    let ok = 0, n = 0;
    for (let seed = 101; seed <= 114; seed++) {
      const g = createGame(seed);
      const r = runBot(g, 3);
      n++; if (!r.died && r.floorsCleared === 3) ok++;
      console.log(`seed ${seed}: died=${r.died} cleared=${r.floorsCleared}`);
    }
    console.log(`CLEARED ${ok}/${n}`);
  }, 900_000);
});
