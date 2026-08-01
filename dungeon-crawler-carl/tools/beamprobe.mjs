// BEAMPROBE — inject synthetic beam hazards (arming + fired) around the hero
// and capture, verifying the r5 beam-anatomy shader end to end.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots/r5fx";
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto("http://localhost:5285/iso.html?test&debug=1&clean=1&floor=17&level=21&seed=61&eagerassets", { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 150000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  // Two arming lanes + two fired lanes fanned around the hero.
  const mk = (id, ang, fired) => ({
    id: 90000 + id,
    pos: { x: p.pos.x, y: p.pos.y },
    end: { x: p.pos.x + Math.cos(ang) * 7, y: p.pos.y + Math.sin(ang) * 7 },
    t: fired ? 0.45 : 1.1,
    total: fired ? 0.6 : 2.0,
    arm: 1.6,
    radius: 0.45,
    damage: 0,
    kind: "beam",
    fired,
  });
  st.hazards.push(mk(1, 0.4, false), mk(2, 1.7, false), mk(3, 2.9, true), mk(4, 4.4, true));
});
await page.waitForTimeout(1200);
const shot = `${OUT}/beamprobe-full.png`;
await page.screenshot({ path: shot, timeout: 240000 });
console.log("saved", shot);
await browser.close();
execFileSync("node", ["tools/crop.mjs", shot, `${OUT}/crop-beams.png`, "400", "150", "800", "600"]);
console.log("saved", `${OUT}/crop-beams.png`);
