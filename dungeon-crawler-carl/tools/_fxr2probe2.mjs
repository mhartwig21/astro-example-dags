// FX r2 probe 2: what object projects onto the tall gold rectangle's pixels?
import { chromium } from "playwright";
import { census } from "./trk_census.mjs";

console.log("[census BEFORE]", JSON.stringify(census()));
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto("http://localhost:5282/iso.html?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&eagerassets&quality=medium", { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => !!window.__dcc?.state, null, { timeout: 240000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
await page.waitForFunction(() => {
  const l = document.getElementById("loading");
  return !l || l.classList.contains("done") || l.style.display === "none" ||
    getComputedStyle(l).opacity === "0" || l.getBoundingClientRect().width === 0;
}, null, { timeout: 240000 });
await page.waitForFunction(() => !!window.__dcc.renderer, null, { timeout: 90000 });
await page.bringToFront();
await page.waitForTimeout(3200);
await page.waitForFunction(() => {
  const l = document.getElementById("loading");
  return !l || l.getBoundingClientRect().width === 0;
}, null, { timeout: 60000 });

await page.evaluate(`(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  let pick = live[0], bestScore = -1e9;
  for (const m of live) {
    const n = live.filter((o) => o !== m && Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4).length;
    if (-n > bestScore) { bestScore = -n; pick = m; }
  }
  p.pos.x = pick.pos.x + 4.0; p.pos.y = pick.pos.y + 0.3;
  p.facing.x = -1; p.facing.y = 0;
  window.__pick = { x: pick.pos.x, y: pick.pos.y };
})()`);
await page.waitForTimeout(200);
await page.keyboard.down("f");
await page.waitForTimeout(150);
await page.keyboard.up("f");
await page.waitForTimeout(100);
// Freeze nothing; just snapshot + dump in the same beat.
const [report] = await Promise.all([
  page.evaluate(`(() => {
    const r = window.__dcc.renderer;
    const out = [];
    r.scene.traverse((o) => {
      if (!o.visible || !o.isMesh) return;
      const e = o.matrixWorld.elements;
      const wx = e[12], wy = e[13], wz = e[14];
      const sxl = Math.hypot(e[0], e[1], e[2]);
      const syl = Math.hypot(e[4], e[5], e[6]);
      const s = r.worldToScreen(wx, wy, wz);
      if (!s.visible) return;
      out.push({
        name: o.name || o.type, pname: o.parent?.name || o.parent?.type,
        px: Math.round(s.x), py: Math.round(s.y),
        wy: +wy.toFixed(2), sx: +sxl.toFixed(2), sy: +syl.toFixed(2),
        em: o.material && o.material.emissive ? "#" + o.material.emissive.getHexString() : null,
        inst: !!o.isInstancedMesh, ro: o.renderOrder,
        ud: Object.keys(o.userData || {}).slice(0, 5).join("|"),
      });
    });
    return out;
  })()`),
  page.screenshot({ path: "C:/Users/hartw/astro-example-dags/.claude/worktrees/trk-look/dungeon-crawler-carl/tools/_fxr2/P-probe.png", timeout: 60000 }),
]);
// The gold rectangle sat around (830, 270-390) in the prior captures; the
// same seed restages identically. Report everything projecting near it.
const near = report.filter((o) => Math.abs(o.px - 830) < 90 && o.py > 220 && o.py < 430);
console.log("NEAR:", JSON.stringify(near, null, 1).slice(0, 3500));
await browser.close();
console.log("[census AFTER]", JSON.stringify(census()));
