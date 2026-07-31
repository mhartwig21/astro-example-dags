// One-frame probe for the LANE telegraph shader (charger rush strip): stages a
// charge windup on the monster nearest the player and grabs a single frame.
// Runs under the virtual rAF clock (audit r4) so the captured frame shows the
// lane mid-windup with its gather motes alive, not a stale post-rush frame.
// Usage: node tools/laneshot.mjs [outPng]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots/laneshot.png";
const URL =
  "http://localhost:5285/iso.html?test&debug=1&floor=6&level=14&abilities=all&seed=77&eagerassets";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
// HERO RIG GUARD (audit r5): never ship the capsule-fallback hero in a shot.
for (let i = 0; i < 6; i++) {
  const rig = await page.evaluate(() => {
    const r = window.__dcc.renderer;
    const mesh = [...r.playerMeshes.values()][0];
    return mesh ? (mesh.userData.body ? "fallback" : "rigged") : "none";
  });
  if (rig === "rigged") break;
  if (rig === "none") { await page.waitForTimeout(1500); continue; }
  if (i === 5) { console.error("hero rig never loaded"); process.exit(1); }
  console.log("hero is the fallback capsule — reloading for real assets");
  await page.reload({ waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
  await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
}
await page.evaluate(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  p.hp = p.maxHp || p.hp;
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  let near = null, nearD = 1e9;
  for (const m of live) {
    const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
    if (d < nearD) { nearD = d; near = m; }
  }
  if (!near) return;
  // Park the crawler a lane-length away and aim the rush at it.
  p.pos.x = near.pos.x + 5;
  p.pos.y = near.pos.y;
});
await page.waitForTimeout(2500); // camera + fog settle on the new spot
await page.evaluate(() => {
  // Freeze the clock, THEN arm the rush: the frame holds mid-windup.
  if (!window.__vt) {
    const raf = window.requestAnimationFrame.bind(window);
    let t = performance.now();
    window.__vt = { advance: (ms) => { t += ms; } };
    window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
  }
  const st = window.__dcc.state;
  const p = st.players[0];
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  let near = null, nearD = 1e9;
  for (const m of live) {
    const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
    if (d < nearD) { nearD = d; near = m; }
  }
  if (!near) return;
  near.windupKind = "charge";
  near.chargeDir = { x: 1, y: 0 };
  near.windupTotal = 1.6;
  near.windup = 1.2;
});
for (let s = 0; s < 5; s++) {
  await page.evaluate((m) => window.__vt && window.__vt.advance(m), 16);
  await page.waitForTimeout(450);
}
await page.screenshot({ path: OUT, timeout: 240000 });
console.log("saved", OUT);
await browser.close();
