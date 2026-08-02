// Desktop verb probe, round 2. deskdeep's ability check detects a cast by
// watching `p.cd`, which is silent for a slot whose ability has no cooldown
// (melee) or spends charges instead (dash). This one watches EVERYTHING the
// sim can show for a cast: cd, charges, projectiles, hits, events, and the
// keyboard binding it actually pressed.
import { chromium } from "playwright";
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = (flag("base", "http://localhost:5420")).replace(/\/$/, "");
const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance&floor=3&level=14&seed=7";

const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${BASE}/iso.html?${TEST}`, { waitUntil: "load", timeout: 180000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => { const l = document.getElementById("loading"); return !l || getComputedStyle(l).display === "none" || getComputedStyle(l).opacity === "0"; }, null, { timeout: 120000 });
await page.waitForTimeout(1500);

const alive = () => page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing"; });
const settle = (n = 14) => page.evaluate((k) => new Promise((r) => { let i = 0; const t = () => (++i >= k ? r(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {});
const snap = () => page.evaluate(() => {
  const s = window.__dcc.state, p = s.players[0];
  return {
    cd: JSON.parse(JSON.stringify(p.cd || {})),
    charges: { dash: p.dashCharges, flask: p.flaskCharges },
    proj: (s.projectiles || s.shots || []).length,
    hits: (s.hits || []).length,
    events: (s.events || []).length,
    mobHp: s.monsters.reduce((a, m) => a + Math.max(0, m.hp), 0),
    slots: p.abilities.slots.slice(), ult: p.abilities.ultimate,
    keyCast: p.__lastCast ?? null,
  };
});
// Instrument the INTENT the host builds: the honest question is "did the
// keyboard produce a cast field", not "did a downstream number move".
await page.evaluate(() => {
  const d = window.__dcc;
  window.__castLog = [];
  const orig = d.step.bind(d);
  d.step = (intents, dt) => {
    const i = intents && intents[0];
    if (i && i.cast && i.cast.length) window.__castLog.push(i.cast.map((c) => c.id ?? c.slot ?? JSON.stringify(c)).join(","));
    return orig(intents, dt);
  };
});
const stage = () => page.evaluate(() => {
  const s = window.__dcc.state, p = s.players[0];
  const live = s.monsters.filter((m) => m.hp > 0 && m.kind !== "boss");
  if (live.length) { const m = live[0]; m.dormant = false; m.hp = m.maxHp; p.pos.x = m.pos.x + 1.2; p.pos.y = m.pos.y + 0.6; }
});

const out = [];
const rec = (n, ok, d) => { out.push({ n, ok }); console.log(`  [${ok ? "PASS" : "FAIL"}] ${n} — ${d}`); };

const KEYS = [[" ", "slot1"], ["Shift", "slot2"], ["q", "slot3"], ["c", "slot4"], ["f", "ultimate"]];
for (const [k, name] of KEYS) {
  await alive(); await stage();
  await page.evaluate(() => { window.__castLog = []; const p = window.__dcc.state.players[0]; p.cd = {}; });
  const a = await snap();
  await page.keyboard.down(k);
  await page.waitForTimeout(520);
  await settle(10);
  await page.keyboard.up(k);
  await settle(18);
  const b = await snap();
  const log = await page.evaluate(() => window.__castLog.slice(0, 4));
  const cdMoved = Object.keys(b.cd).filter((id) => (b.cd[id] ?? 0) > (a.cd[id] ?? 0));
  const chg = a.charges.dash !== b.charges.dash;
  const dmg = b.mobHp < a.mobHp;
  rec(`desktop key '${k}' (${name}) produces a cast intent`, log.length > 0,
    `intents=${JSON.stringify(log)} cd=${cdMoved.join("/") || "-"} dashCharges ${a.charges.dash}->${b.charges.dash} mobHp ${Math.round(a.mobHp)}->${Math.round(b.mobHp)} slots=${JSON.stringify(a.slots)} ult=${a.ult}`);
}
console.log(errs.length ? "PAGE ERRORS: " + errs.slice(0, 3).join(" | ") : "no page errors");
console.log("RESULT:", out.filter((o) => !o.ok).length, "failed of", out.length);
await browser.close();
