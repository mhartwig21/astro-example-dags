// RECONCILIATION — the owner reported "a bit of lag even on early floors"
// before the mode work merged. Measure floor 2 on the Intel part in MEDIUM
// (the default), delivered ms against MEDIUM's 33.3 ms / 25% contract, in the
// three states early play is actually in: walking, fighting the local pack,
// and standing quiet. GPU-timer medians and foreign browser count beside
// every number; waits for the adapter to be ours before measuring.
import { writeFileSync } from "node:fs";
import { boot, installProbe, window1, waitForQuietGpu, shape, flag } from "./o3lab.mjs";
import { census } from "./trk_census.mjs";

const floor = Number(flag("--floor", 2));
const out = flag("--out", `tools/_earlyfloor_f${floor}_igpu_medium.json`);
const url = `http://localhost:5282/iso.html?test&floor=${floor}&level=${floor * 2}`
  + `&abilities=all&seed=11&eagerassets&clean=1&debug=1&quality=medium`;

const { browser, page } = await boot({ adapter: "igpu", url });
try {
  await installProbe(page);
  const quiet = await waitForQuietGpu(page, { maxMs: 14, tries: 6 });
  console.log("gpu quiet:", JSON.stringify(quiet));

  // WALK: real held movement, no combat — the state the owner walks floors in.
  const walkStart = async () => {
    await page.evaluate(() => {
      if (window.__walkT) return;
      const dirs = ["w", "d", "s", "a"];
      let i = 0;
      const send = (t, k) => {
        const ev = new KeyboardEvent(t, { key: k, bubbles: true, cancelable: true });
        window.dispatchEvent(ev); document.dispatchEvent(ev);
      };
      send("keydown", dirs[0]);
      window.__walkT = setInterval(() => {
        send("keyup", dirs[i % 4]);
        i++;
        send("keydown", dirs[i % 4]);
      }, 700);
    });
  };
  const walkStop = async () => {
    await page.evaluate(() => {
      if (!window.__walkT) return;
      clearInterval(window.__walkT); window.__walkT = null;
      for (const k of ["w", "a", "s", "d"]) {
        const ev = new KeyboardEvent("keyup", { key: k, bubbles: true });
        window.dispatchEvent(ev); document.dispatchEvent(ev);
      }
    });
  };

  await walkStart();
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__winStart());
  await page.waitForTimeout(6000);
  const walkRaw = await page.evaluate(() => window.__winEnd());
  await walkStop();
  const walk = { ...walkRaw, deltas: undefined, shape: shape(walkRaw.deltas, walkRaw.wallMs, 33.3) };
  console.log("WALK  ", JSON.stringify({ ...walk.shape, gpuMs: walkRaw.gpuMs, gpuP90: walkRaw.gpuP90, upd: walkRaw.updateMs, foreign: census().foreign }));

  // FIGHT: the floor's own densest pack, actually swinging.
  const fight = await window1(page, { secs: 6, scene: "fight", budgetMs: 33.3 });
  console.log("FIGHT ", JSON.stringify({ ...fight.shape, gpuMs: fight.gpuMs, gpuP90: fight.gpuP90, upd: fight.updateMs, vis: fight.visible, foreign: fight.foreign }));

  // QUIET: parked far from the pack.
  const quietW = await window1(page, { secs: 6, scene: "quiet", budgetMs: 33.3 });
  console.log("QUIET ", JSON.stringify({ ...quietW.shape, gpuMs: quietW.gpuMs, gpuP90: quietW.gpuP90, upd: quietW.updateMs, foreign: quietW.foreign }));

  writeFileSync(out, JSON.stringify({
    floor, quietGpu: quiet,
    walk: { shape: walk.shape, gpuMs: walkRaw.gpuMs, gpuP90: walkRaw.gpuP90, updateMs: walkRaw.updateMs },
    fight: { shape: fight.shape, gpuMs: fight.gpuMs, gpuP90: fight.gpuP90, updateMs: fight.updateMs, visible: fight.visible },
    quiet: { shape: quietW.shape, gpuMs: quietW.gpuMs, gpuP90: quietW.gpuP90, updateMs: quietW.updateMs },
    census: census(),
  }, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
