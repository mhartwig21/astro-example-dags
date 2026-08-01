// BLOBPROBE — identify the bright additive object riding the hero position.
import { chromium } from "playwright";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto("http://localhost:5285/iso.html?test&debug=1&clean=1&floor=6&level=14&seed=77&eagerassets", { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 150000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
await page.waitForTimeout(3000);

const out = await page.evaluate(() => {
  const dcc = window.__dcc;
  const st = dcc.state;
  const r = dcc.renderer;
  const p = st.players[0];
  const res = [];
  r.scene.traverse((o) => {
    if (!o.visible) return;
    const m = o.material;
    const isLight = o.isLight;
    if (!m && !isLight) return;
    let v = { x: 0, y: 0, z: 0 };
    try { const w = o.getWorldPosition(new o.position.constructor()); v = { x: w.x, y: w.y, z: w.z }; } catch { return; }
    const d = Math.hypot(v.x - p.pos.x, v.z - p.pos.y);
    if (d > 2.2) return;
    const rec = { type: o.type, name: o.name || "", key: o.userData?.modelKey ?? "", d: +d.toFixed(2), y: +v.y.toFixed(2) };
    if (isLight) { rec.light = { intensity: o.intensity, color: o.color && "#" + o.color.getHexString(), dist: o.distance }; }
    else {
      rec.mat = m.type;
      if (m.color) rec.color = "#" + m.color.getHexString();
      rec.blending = m.blending;
      rec.opacity = m.opacity;
      if (o.scale) rec.scale = +o.scale.x.toFixed(2);
    }
    res.push(rec);
  });
  return { hero: { x: p.pos.x, y: p.pos.y }, near: res.slice(0, 40) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
