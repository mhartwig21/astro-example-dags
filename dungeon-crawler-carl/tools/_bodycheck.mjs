// Is the boss body pale because of the hit FLASH (a real-but-brief state the
// capture harness freezes), or because of how it is lit? Walk in, raise the
// encounter, then run the fight WITHOUT the crawler ever attacking, on a live
// clock, and shoot the boss idle.
// usage: node tools/_bodycheck.mjs --base=http://localhost:5410 --out=DIR --floor=12 --seed=5
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const flag = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith("--" + n + "="));
  return hit ? hit.slice(n.length + 3) : d;
};
const BASE = (flag("base") || "").replace(/\/+$/, "");
const OUT = flag("out");
if (!BASE || !OUT) { console.error("usage: --base= --out= [--floor=] [--seed=]"); process.exit(2); }
const FLOOR = Number(flag("floor", "12"));
const SEED = Number(flag("seed", "5"));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const lvl = Math.min(30, 6 + FLOOR);
await page.goto(`${BASE}/iso.html?test&debug=1&clean=1&floor=${FLOOR}&level=${lvl}` +
  `&abilities=all&gold=4000&seed=${SEED}&eagerassets`, { waitUntil: "load", timeout: 240000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 120000 });
await page.waitForTimeout(1500);

// Stand next to the boss, never swing. The host's own loop drives the clock.
await page.evaluate(() => {
  const st = window.__dcc.state;
  const b = st.monsters.find((m) => m.kind === "boss");
  const p = st.players[0];
  p.pos.x = b.pos.x + 3.0; p.pos.y = b.pos.y + 3.0;
  window.__nohit = setInterval(() => {
    const s = window.__dcc.state, pl = s.players[0];
    if (pl) { pl.hp = pl.maxHp; pl.alive = true; pl.downedT = 0; }
    if (s.status !== "playing") s.status = "playing";
  }, 100);
});
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const b = window.__dcc.state.monsters.find((m) => m.kind === "boss");
  return { id: b && b.bossId, hp: b && Math.round(b.hp / b.maxHp * 100), flash: b && b.hitT };
});
console.log(JSON.stringify(info));
await page.screenshot({ path: `${OUT}/body-f${FLOOR}-noswing.png` });
console.log("saved " + OUT + "/body-f" + FLOOR + "-noswing.png");
await browser.close();
