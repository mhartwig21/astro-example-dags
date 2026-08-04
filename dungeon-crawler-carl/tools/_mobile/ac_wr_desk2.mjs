// The two "NOTHING" desktop keys, verified on their own terms:
//  - key 1 (melee): held near a staged monster -> monster hp drops
//  - key c (stuntdouble): held -> a decoy/effect exists or cd/uses change
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=3&level=14&seed=7`,
    { waitUntil: "load", timeout: 180000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    p.hp = p.maxHp;
    for (const m of s.monsters) { m.speed = 0; m.windup = 0; m.attackCooldown = 999; m.shootCd = 999; }
    const m = s.monsters.find((mm) => mm.hp > 0 && !mm.dormant);
    if (m) { m.pos.x = p.pos.x + p.facing.x * 0.9; m.pos.y = p.pos.y + p.facing.y * 0.9; window.__target = m.id; }
  });
  const hp0 = await page.evaluate(() => {
    const m = window.__dcc.state.monsters.find((mm) => mm.id === window.__target);
    const p2 = window.__dcc.state.players[0];
    return m ? { hp: m.hp, d: +Math.hypot(m.pos.x-p2.pos.x, m.pos.y-p2.pos.y).toFixed(2) } : null;
  });
  await page.keyboard.down(" ");
  await page.waitForTimeout(1400);
  await page.keyboard.up(" ");
  await page.waitForTimeout(400);
  const hp1 = await page.evaluate(() => {
    const m = window.__dcc.state.monsters.find((mm) => mm.id === window.__target);
    return m ? m.hp : null;
  });
  console.log('melee key SPACE:', JSON.stringify(hp0), '->', JSON.stringify(hp1), (hp1 && hp0 && hp1 < hp0.hp) ? 'PASS' : 'FAIL');
  const before = await page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    return { cd: JSON.parse(JSON.stringify(p.cd || {})), decoys: (window.__dcc.state.decoys ?? []).length,
      buffs: JSON.stringify(p.buffs ?? null).slice(0, 100) };
  });
  await page.keyboard.down("c");
  await page.waitForTimeout(900);
  await page.keyboard.up("c");
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    const ents = Object.keys(window.__dcc.state).filter((k) => Array.isArray(window.__dcc.state[k]));
    return { cd: JSON.parse(JSON.stringify(p.cd || {})), decoys: (window.__dcc.state.decoys ?? []).length,
      stunt: p.cd?.stuntdouble ?? null, arrays: ents.join(",").slice(0, 200) };
  });
  console.log("stuntdouble before:", JSON.stringify(before));
  console.log("stuntdouble after:", JSON.stringify(after));
} finally {
  await browser.close();
}
