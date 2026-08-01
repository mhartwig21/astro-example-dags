// BRUTESHOT — staged heavy-pack capture for the r5 "fullbright brute" fix:
// two brutes + two wardens ringed tight around the hero in a combat room,
// one mid hit-flash, cropped close so shading gradients are auditable.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots/r5fx";
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto("http://localhost:5285/iso.html?test&debug=1&clean=1&floor=6&level=14&seed=77&eagerassets", { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 150000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
await page.waitForTimeout(3000);

const stage = `(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  p.hp = p.maxHp;
  // Combat-room center (no loot beacons), same pick as beautyshot's crowd.
  const mapW = st.map.w;
  const rooms = st.map.rooms || [], roles = st.map.roles || [];
  let best = null, bestA = -1;
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    if (roles[ri] !== "combat") continue;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    if (st.map.tiles[Math.floor(cy) * mapW + Math.floor(cx)] !== 1) continue;
    const glowy = (st.loot || []).some((l) =>
      l.pos.x >= r.x - 1 && l.pos.x <= r.x + r.w + 1 &&
      l.pos.y >= r.y - 1 && l.pos.y <= r.y + r.h + 1);
    if (glowy) continue;
    const a = r.w * r.h;
    if (a > bestA) { bestA = a; best = { cx, cy }; }
  }
  if (best) { p.pos.x = best.cx; p.pos.y = best.cy; }
  p.facing.x = 0; p.facing.y = 1;
  const heavies = st.monsters.filter((m) => m.hp > 0 && (m.kind === "brute" || m.kind === "warden")).slice(0, 4);
  heavies.forEach((m, k) => {
    const a = 0.8 + k * 1.55;
    m.pos.x = p.pos.x + Math.cos(a) * 1.7;
    m.pos.y = p.pos.y + Math.sin(a) * 1.6;
    m.hp = m.maxHp;
    m.dormant = false;
  });
  return heavies.map((m) => m.kind);
})()`;
console.log("staged:", JSON.stringify(await page.evaluate(stage)));
await page.waitForTimeout(3500);
// Re-pin the pack (they chased during the reveal), flash ONE warden briefly.
console.log("restaged:", JSON.stringify(await page.evaluate(stage)));
await page.evaluate(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const w = st.monsters.find((m) => m.hp > 0 && m.kind === "warden" &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3);
  if (w) w.hitFlash = 0.12;
});
await page.waitForTimeout(600);
const shot = `${OUT}/bruteshot-full.png`;
await page.screenshot({ path: shot, timeout: 240000 });
console.log("saved", shot);
await browser.close();
execFileSync("node", ["tools/crop.mjs", shot, `${OUT}/crop-brutepack.png`, "480", "180", "700", "520"]);
console.log("saved", `${OUT}/crop-brutepack.png`);
