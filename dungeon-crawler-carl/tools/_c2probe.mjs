// Can a real-input run actually reach a death in reasonable wall time under
// SwiftShader? Measures sim-time dilation and HP decay with no state poking.
import { chromium } from "playwright";
const API = "http://localhost:5441";
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`;
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "C2-PROBE-TOKEN-0007");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
});
await page.goto(BASE, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForTimeout(2000);
await page.click("#m-daily");
await page.waitForFunction(() => document.getElementById("menu").classList.contains("casting"), null, { timeout: 30000 });
await page.waitForTimeout(1000);
await page.click("#m-cast-go");
await page.waitForFunction(() => window.__dcc?.state?.elapsed > 0.2, null, { timeout: 120000 });

const t0 = Date.now();
const keys = ["w", "d", "s", "a"];
for (let i = 0; i < 60; i++) {
  const k = keys[i % 4];
  await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k);
  const s = await page.evaluate(() => {
    const st = window.__dcc.state, p = st.players[0];
    let near = 1e9;
    for (const m of st.monsters ?? []) if (m.alive !== false) {
      const d = Math.hypot(m.x - p.x, m.y - p.y); if (d < near) near = d;
    }
    return { st: st.status, f: st.floor, el: +st.elapsed.toFixed(1), hp: Math.round(p.hp), mobs: (st.monsters ?? []).length, near: +near.toFixed(1) };
  });
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s wall  sim ${s.el}s  f${s.f}  hp ${s.hp}  mobs ${s.mobs}  nearest ${s.near}  ${s.st}`);
  if (s.st !== "playing") break;
}
await browser.close();
