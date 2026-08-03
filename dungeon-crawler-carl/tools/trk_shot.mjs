// EYES ON THE WORLD after the graph cull. The proof in trk_live is numeric
// (draw calls and triangles are identical whether a fog-hidden prop is in the
// graph or parked); this is the other half — that a prop RE-ENTERING the graph
// comes back in the right place. r1's first parking attempt is the cautionary
// tale: a detached subtree composes matrixWorld = matrix, which drops the
// parent's transform and puts 887 props on the map origin. That failure is
// invisible in a draw-call count and obvious in a screenshot.
//
// Also prints the world-space spread of the revealed props, which is the same
// check without human eyes: if the reparent lost a transform, min/max collapse.
//
// Usage: node tools/trk_shot.mjs [--floor 15] [--port 5282]
import { chromium } from "playwright";
import { census } from "./trk_census.mjs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = Number(flag("--port", 5282));
const floors = (flag("--floors", "15,1")).split(",").map(Number);

console.log("[contamination]", JSON.stringify(census()));
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
try {
  for (const floor of floors) {
    const level = floor >= 10 ? 26 : 6;
    await page.goto(`http://localhost:${port}/iso.html?test&floor=${floor}&level=${level}&seed=41&abilities=all&debug=1&quality=high`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 });
    await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 });
    await page.evaluate(() => {
      const pin = () => {
        for (const p of window.__dcc.state.players) { p.hp = p.maxHp; p.alive = true; p.downedT = 0; }
        requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);
    });
    await page.waitForTimeout(3000);
    // walk a lap so props get revealed, parked, and revealed again
    for (const k of ["w", "d", "s", "a", "w"]) {
      await page.keyboard.down(k); await page.waitForTimeout(700); await page.keyboard.up(k);
    }
    await page.waitForTimeout(1500);
    const stats = await page.evaluate(() => {
      const r = window.__dcc.renderer;
      const live = r.propEntries.filter((e) => e.obj.parent === r.floorGroup);
      const xs = live.map((e) => e.obj.matrixWorld.elements[12]);
      const zs = live.map((e) => e.obj.matrixWorld.elements[14]);
      const atOrigin = live.filter((e) => Math.abs(e.obj.matrixWorld.elements[12]) < 1e-6 && Math.abs(e.obj.matrixWorld.elements[14]) < 1e-6).length;
      let n = 0; r.scene.traverse(() => n++);
      return {
        props: r.propEntries.length, inGraph: live.length, parked: r.propEntries.length - live.length,
        nodes: n, calls: r.renderer.info.render.calls,
        xRange: live.length ? [+Math.min(...xs).toFixed(1), +Math.max(...xs).toFixed(1)] : null,
        zRange: live.length ? [+Math.min(...zs).toFixed(1), +Math.max(...zs).toFixed(1)] : null,
        propsSittingOnTheOrigin: atOrigin,
      };
    });
    console.log(`floor ${floor}:`, JSON.stringify(stats));
    await page.screenshot({ path: `tools/_trkshot_f${floor}.png` });
  }
} finally {
  await browser.close();
}
console.log("[contamination after]", JSON.stringify(census()));
