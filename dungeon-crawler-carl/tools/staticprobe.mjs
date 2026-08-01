// WHO ACTUALLY MOVES? Before switching the dungeon's scene graph to
// matrixAutoUpdate=false we need proof of which objects rewrite their local
// transform after the floor is built. Guessing here silently freezes an
// animated prop in place, and the bug would only show up in play.
//
// This snapshots every descendant's local matrix once, then re-checks every
// frame across idle + movement + combat and reports each object that EVER
// changed, keyed by the same category labels drawcensus.mjs uses.
//
// Usage: node tools/staticprobe.mjs "<url>" [--seconds 10]
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const seconds = Number(flag("--seconds", 10));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 }).catch(() => {});
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const root = R.floorGroup;
  const label = (o) => {
    let n = o, chain = [];
    while (n && n !== root) { chain.push(n.name || n.type); n = n.parent; }
    return chain.reverse().join("/") || "(root)";
  };
  const watch = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => { watch.push({ o, m: o.matrix.elements.slice(), label: label(o), moved: 0 }); });
  const movers = new Map();
  window.__sp = { watch, movers, frames: 0, total: watch.length };
  const tick = () => {
    const sp = window.__sp;
    sp.frames++;
    for (const w of sp.watch) {
      const e = w.o.matrix.elements;
      let same = true;
      for (let i = 0; i < 16; i++) if (e[i] !== w.m[i]) { same = false; break; }
      if (!same) {
        w.moved++;
        for (let i = 0; i < 16; i++) w.m[i] = e[i];
        movers.set(w.label, (movers.get(w.label) ?? 0) + 1);
      }
    }
    sp.raf = requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Exercise idle, walking (streams dressing, moves the canopy step-aside) and combat.
await page.waitForTimeout(seconds * 300);
await page.keyboard.down("w"); await page.waitForTimeout(seconds * 300); await page.keyboard.up("w");
for (const k of ["Space", "q", "e", "c"]) { await page.keyboard.press(k).catch(() => {}); await page.waitForTimeout(200); }
await page.waitForTimeout(seconds * 400);

const out = await page.evaluate(() => {
  const sp = window.__sp;
  cancelAnimationFrame(sp.raf);
  const rows = [...sp.movers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  return { frames: sp.frames, watched: sp.total, distinctMovingLabels: sp.movers.size, rows };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
