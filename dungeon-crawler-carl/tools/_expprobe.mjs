// THROWAWAY recon probe (deleted after use). The capture harness freezes the
// frame clock, and the exposure governor's load DECAYS on that clock — so the
// exposureScale numbers a capture prints are harness-depressed and prove
// nothing about play. This drives a real boss fight on the REAL clock with real
// intents and samples the governor, the measured luma and the saturated-pixel
// fraction, so the "exposure destroys the read" blocker can be judged on
// numbers a player would actually get.
import { chromium } from "playwright";

const flag = (n, d) => { const h = process.argv.find((a) => a.startsWith("--" + n + "=")); return h ? h.slice(n.length + 3) : d; };
const BASE = flag("base", "http://localhost:5410");
const SEED = flag("seed", "1");
const FLOOR = flag("floor", "9");

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
const lvl = Math.min(30, 6 + Number(FLOOR));
await page.goto(`${BASE}/iso.html?test&debug=1&clean=1&floor=${FLOOR}&level=${lvl}&abilities=all&gold=4000&seed=${SEED}&eagerassets`,
  { waitUntil: "load", timeout: 240000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 120000 });
await page.waitForTimeout(1200);

// Park the crawler on the boss and let the HOST's own loop run the fight on the
// real clock. Intents are fed from a rAF driver so the crawler keeps moving and
// swinging, exactly as bossshot does — but nothing here touches the clock.
await page.evaluate(() => {
  const st = window.__dcc.state;
  const b = st.monsters.find((m) => m.kind === "boss");
  const p = st.players[0];
  p.pos.x = b.pos.x + 3.5; p.pos.y = b.pos.y + 3.5;
  p.bonusDamage = Math.max(p.bonusDamage || 0, 10);
  window.__exp = [];
  let i = 0;
  const tick = () => {
    const s = window.__dcc.state;
    const pl = s.players[0];
    const bs = s.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    if (bs) {
      const dx = bs.pos.x - pl.pos.x, dy = bs.pos.y - pl.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      const to = { x: dx / d, y: dy / d };
      const move = d > 2.6 ? to : { x: -to.y * 0.9, y: to.x * 0.9 };
      window.__dcc.step({ move, aim: to, attack: true, cast: [true, i % 42 === 0, i % 67 === 0, i % 101 === 0, i % 173 === 0], useStairs: false }, 1 / 60);
    }
    pl.hp = pl.maxHp; pl.alive = true; pl.downedT = 0;
    if (s.status !== "playing") s.status = "playing";
    const fx = window.__dcc.renderer.bossFx;
    if (i % 6 === 0) {
      window.__exp.push({
        t: +(performance.now() / 1000).toFixed(2),
        exp: +Number(fx.exposureScale).toFixed(3),
        luma: +Number(fx.measLuma ?? -1).toFixed(3),
        sat: +Number(fx.measSat ?? -1).toFixed(3),
        load: +Number(fx.load ?? -1).toFixed(2),
        punish: (bs && (bs.stagger ?? 0) > 0) ? 1 : 0,
      });
    }
    i++;
    if (i < 3000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(40000);
const rows = await page.evaluate(() => window.__exp);
await browser.close();
const vals = rows.map((r) => r.exp);
const pct = (p) => [...vals].sort((a, b) => a - b)[Math.floor(vals.length * p)];
console.log(`floor ${FLOOR} seed ${SEED}: n=${rows.length}`);
console.log(`exposureScale  min=${Math.min(...vals)}  p10=${pct(0.1)}  median=${pct(0.5)}  p90=${pct(0.9)}  max=${Math.max(...vals)}`);
const satClamped = rows.filter((r) => r.sat > 0.22).length;
console.log(`frames with measSat > 0.22 (HARD CLAMP to <=0.30): ${satClamped}/${rows.length}`);
const punished = rows.filter((r) => r.punish);
if (punished.length) {
  const pv = punished.map((r) => r.exp);
  console.log(`during the PUNISH window: n=${pv.length} exp min=${Math.min(...pv)} median=${[...pv].sort((a, b) => a - b)[Math.floor(pv.length / 2)]} max=${Math.max(...pv)}`);
} else console.log("no punish window sampled");
console.log("sample:", JSON.stringify(rows.filter((_, i) => i % 25 === 0).slice(0, 14)));
