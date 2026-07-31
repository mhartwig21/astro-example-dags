// TEMP probe: list placed props (model keys + positions) near the player on a
// given floor URL — identifies which manifest keys render as graybox stand-ins.
// Usage: node tools/propprobe.mjs "http://localhost:5285/iso.html?test&debug=1&floor=11&level=15&seed=41&eagerassets"
import { chromium } from "playwright";

const url = process.argv[2];
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 150000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
await page.waitForTimeout(2500);
const out = await page.evaluate(() => {
  const r = window.__dcc.renderer;
  const st = window.__dcc.state;
  const p = st.players[0];
  const entries = r.propEntries ?? [];
  const rows = [];
  for (const e of entries) {
    const o = e.obj;
    const d = Math.hypot(o.position.x - p.pos.x, o.position.z - p.pos.y);
    if (d > 12) continue;
    // Walk down for a mesh + material summary.
    let meshInfo = [];
    o.traverse((m) => {
      if (m.isMesh && meshInfo.length < 3) {
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        meshInfo.push(`${m.geometry?.type}/${mat?.type}${mat?.map ? "+map" : ""} col=${mat?.color?.getHexString?.()}`);
      }
    });
    rows.push({ key: o.userData.modelKey ?? o.name ?? "?", x: +o.position.x.toFixed(1), z: +o.position.z.toFixed(1), d: +d.toFixed(1), meshInfo });
  }
  rows.sort((a, b) => a.d - b.d);
  return { player: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1) }, rows };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
