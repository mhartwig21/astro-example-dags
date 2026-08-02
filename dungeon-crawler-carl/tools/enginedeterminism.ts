// Cross-engine determinism probe: does the SAME seed + inputs produce the SAME
// state in a browser engine as it does in Node? The sim uses ~80 call sites of
// Math.sin/cos/atan2/hypot/pow, which ECMA-262 leaves implementation-approximated.
// If engines disagree, replay verification only holds within one engine family.
import { chromium, firefox, webkit } from "playwright";
import { createHash } from "node:crypto";
import { createGame, step } from "../src/sim/game";
import type { Intent } from "../src/sim/types";

const DEV = process.env.DEV_URL ?? "http://localhost:5350";
const STEPS = Number(process.env.STEPS ?? 4000);
const SEED = Number(process.env.SEED ?? 2024);

const SCRIPT = (seed: number, steps: number) => `(async () => {
  const g = await import("/src/sim/game.ts");
  const s = await import("/src/sim/snapshot.ts");
  const st = g.createGame(${seed});
  const intents = [
    { move: { x: 1, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false },
    { move: { x: 0.7071067811865476, y: 0.7071067811865475 }, attack: true, aim: { x: 0.3, y: 0.9 }, useStairs: false, bolt: true },
    { move: { x: -0.5, y: 0.8660254037844387 }, attack: false, useStairs: false, nova: true, dash: true },
  ];
  for (let i = 0; i < ${steps}; i++) step_(st, intents[i % 3]);
  function step_(a, b) { return g.step(a, b, 1/60); }
  return s.serialize(st);
})()`;

function nodeHash(): string {
  const st = createGame(SEED);
  const intents: Intent[] = [
    { move: { x: 1, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false },
    { move: { x: 0.7071067811865476, y: 0.7071067811865475 }, attack: true, aim: { x: 0.3, y: 0.9 }, useStairs: false, bolt: true },
    { move: { x: -0.5, y: 0.8660254037844387 }, attack: false, useStairs: false, nova: true, dash: true },
  ];
  for (let i = 0; i < STEPS; i++) step(st, intents[i % 3], 1 / 60);
  // eslint-disable-next-line
  const { serialize } = require("../src/sim/snapshot");
  return serialize(st);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function run(): Promise<void> {
  const { serialize } = await import("../src/sim/snapshot");
  const st = createGame(SEED);
  const intents: Intent[] = [
    { move: { x: 1, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false },
    { move: { x: 0.7071067811865476, y: 0.7071067811865475 }, attack: true, aim: { x: 0.3, y: 0.9 }, useStairs: false, bolt: true },
    { move: { x: -0.5, y: 0.8660254037844387 }, attack: false, useStairs: false, nova: true, dash: true },
  ];
  for (let i = 0; i < STEPS; i++) step(st, intents[i % 3], 1 / 60);
  const nodeOut = serialize(st);
  console.log("node (V8)      :", sha(nodeOut), nodeOut.length, "bytes");

  for (const [name, launcher] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]] as const) {
    try {
      const b = await launcher.launch();
      const page = await b.newPage();
      await page.goto(DEV + "/iso.html?test&noassets", { waitUntil: "domcontentloaded" });
      const out = await page.evaluate(SCRIPT(SEED, STEPS)) as string;
      console.log(name.padEnd(15) + ":", sha(out), out.length, "bytes", out === nodeOut ? "IDENTICAL to node" : "*** DIVERGED ***");
      if (out !== nodeOut) {
        for (let i = 0; i < Math.min(out.length, nodeOut.length); i++) {
          if (out[i] !== nodeOut[i]) {
            console.log("  first diff at char " + i + ":\n   node: ..." + nodeOut.slice(Math.max(0, i - 60), i + 60)
              + "\n   " + name + ": ..." + out.slice(Math.max(0, i - 60), i + 60));
            break;
          }
        }
      }
      await b.close();
    } catch (e) {
      console.log(name.padEnd(15) + ": unavailable (" + String((e as Error).message).split("\n")[0].slice(0, 90) + ")");
    }
  }
}
void run();
void nodeHash;
