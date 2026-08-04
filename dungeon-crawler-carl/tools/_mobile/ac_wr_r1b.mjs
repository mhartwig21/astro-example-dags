// v2: corrected selectors (#t-ghost etc are IDs), p.cd for cooldowns, range
// ring on a long-range ability, and a full diagnosis of move-while-aiming.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const BASE = "http://localhost:5286";
const OUT = "tools/_mobile/ac-wr-r1";
mkdirSync(OUT, { recursive: true });
const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: "0,47,21,47" },
  "iphone13promax-land": { pw: "iPhone 13 Pro Max landscape", safe: "0,47,21,47" },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: "24,0,20,0" },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: "0,24,24,0" },
};
const results = [];
const rec = (d, n, v, det) => {
  results.push({ device: d, check: n, verdict: v, detail: det });
  console.log(`[${v}] ${d} :: ${n} — ${det}`);
};

function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; return this; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock });
    },
    async tap(x, y, id = 1, holdMs = 90) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 50)));
      await this.up(id);
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 10, holdMs = 24, lift = true } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (lift) await this.up(id);
    },
  };
}

async function ready(page) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

const hit = async (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return { ok: false, why: "missing" };
  const r = e.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const at = document.elementFromPoint(cx, cy);
  return { ok: !!at && (at === e || e.contains(at)),
    w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(cx), cy: Math.round(cy),
    at: at ? `${at.tagName}#${at.id}` : "none",
    on: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight };
}, sel);

const calm = (page) => page.evaluate(() => {
  const s = window.__dcc.state, p = s.players[0];
  p.hp = p.maxHp;
  for (const m of s.monsters) { m.speed = 0; m.windup = 0; m.attackCooldown = 999; m.shootCd = 999; m.blinkCd = 999; }
});
const clearPoint = (page, x0, y0) => page.evaluate(([x0, y0]) => {
  const d = window.__dcc;
  for (const [dx, dy] of [[0, 0], [30, -20], [-25, 15], [45, 10], [0, -40], [60, -30], [-40, -25], [20, 35]]) {
    const x = x0 + dx, y = y0 + dy;
    if (d.touch.controlAt(x, y)) continue;
    const e = document.elementFromPoint(x, y);
    if (e && e.tagName === "CANVAS" && e.id !== "minimap") return { x, y };
  }
  return null;
}, [x0, y0]);
const cds = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__dcc.state.players[0].cd ?? {})));

const browser = await chromium.launch({ headless: true });
try {
  for (const device of Object.keys(SPECS)) {
    const ctx = await browser.newContext({ ...devices[SPECS[device].pw] });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=8&abilities=all&seed=9&safe=${SPECS[device].safe}`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);
    await calm(page);

    // ---- resting ghost (by ID) --------------------------------------------
    const ghost = await page.evaluate(() => {
      const g = document.getElementById("t-ghost");
      if (!g) return { ok: false, why: "missing" };
      const r = g.getBoundingClientRect();
      const cs = getComputedStyle(g);
      return { ok: +cs.opacity > 0.1 && r.width > 40 && cs.display !== "none",
        w: Math.round(r.width), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), op: cs.opacity };
    });
    rec(device, "resting stick ghost visible at idle", ghost.ok ? "PASS" : "FAIL", JSON.stringify(ghost));

    // ---- long-range aim: range ring + telegraph + cancel affordance --------
    const slots = await page.evaluate(() => window.__dcc.state.players[0].abilities.slots);
    const pick = ["bolt", "cataclysm", "airstrike", "crowdsurf"].map((a) => ({ a, i: slots.indexOf(a) })).find((x) => x.i >= 0) ?? { a: "ult", i: 4 };
    const chip = await hit(page, `#skills .skill[data-i="${pick.i}"]`);
    await page.evaluate(() => window.__dcc.touch.clearVerdicts?.());
    await touch.drag(chip.cx, chip.cy, chip.cx - 120, chip.cy - 55, { steps: 8, holdMs: 30, lift: false });
    await page.waitForTimeout(700);
    const aim = await page.evaluate(() => {
      const d = window.__dcc, r = d.renderer, p = d.state.players[0];
      const grab = (name) => (r.scene?.children ?? []).find((c) => c.name === name);
      const rng = grab("aimRange"), ind = grab("aimIndicator");
      const oc = document.getElementById("t-ocancel");
      const cb = document.getElementById("t-cancel");
      const ocs = oc ? getComputedStyle(oc) : null;
      const or = oc ? oc.getBoundingClientRect() : null;
      return {
        rng: rng ? { vis: rng.visible, kids: rng.children.length,
          dist: +Math.hypot(rng.position.x - p.pos.x, rng.position.z - p.pos.y).toFixed(2) } : null,
        ind: ind ? { vis: ind.visible, kids: ind.children.length } : null,
        ocancel: oc ? { disp: ocs.display, op: ocs.opacity, on: oc.classList.contains("on") || +ocs.opacity > 0.2,
          x: Math.round(or.x + or.width / 2), y: Math.round(or.y + or.height / 2), w: Math.round(or.width) } : null,
        band: cb ? { disp: getComputedStyle(cb).display, on: cb.classList.contains("on") } : null,
        mode: d.touch.zones.cancelMode,
      };
    });
    await page.screenshot({ path: `${OUT}/${device}-aim-${pick.a}.png` });
    const cdB = await cds(page);
    await touch.up(1);
    await page.waitForTimeout(700);
    const cdA = await cds(page);
    const started = Object.keys(cdA).some((k) => (cdA[k] ?? 0) > (cdB[k] ?? 0) + 0.2);
    rec(device, `range ring during ${pick.a} aim`, aim.rng && aim.rng.vis && aim.rng.dist < 3 ? "PASS" : "FAIL", JSON.stringify(aim.rng));
    const cancelDrawn = aim.mode === "origin"
      ? aim.ocancel && aim.ocancel.disp !== "none" && aim.ocancel.on
      : aim.band && aim.band.disp !== "none" && aim.band.on;
    rec(device, `cancel affordance drawn while aiming (${aim.mode})`, cancelDrawn ? "PASS" : "FAIL", JSON.stringify({ oc: aim.ocancel, band: aim.band }));
    rec(device, `release casts ${pick.a} (p.cd moves)`, started ? "PASS" : "FAIL",
      JSON.stringify({ before: cdB, after: cdA }).slice(0, 220));
    await calm(page);

    // ---- move-while-aiming, instrumented ------------------------------------
    const z = await page.evaluate(() => window.__dcc.touch.zones);
    const sp = await clearPoint(page, z.stickAnchor.x, z.stickAnchor.y);
    const chip2 = await hit(page, `#skills .skill[data-i="0"]`);
    const abChip = await hit(page, `#skills .skill[data-i="${pick.i === 1 ? 2 : 1}"]`);
    if (sp && abChip.ok) {
      await page.waitForTimeout(2000);
      // 1: stick down + sustained circling BEFORE, DURING and AFTER the aim
      const pA = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      await touch.down(1, sp.x, sp.y);
      for (let i = 0; i < 3; i++) {
        touch.tick(40);
        await touch.move(1, sp.x + 55, sp.y - 28);
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 500));
      const pPre = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      const stickState1 = await page.evaluate(() => ({
        route: window.__dcc.touch.debugRoute ? window.__dcc.touch.route?.(0, 0) : null,
        vis: getComputedStyle(document.getElementById("t-stick2")).opacity,
        suspend: window.__dcc.touch.suspendReasons?.() }));
      const cdB2 = await cds(page);
      await touch.drag(abChip.cx, abChip.cy, abChip.cx - 115, abChip.cy - 45, { id: 2, steps: 7, holdMs: 28, lift: false });
      // hold both, keep stick deflected, sample over ~1.6s
      for (let i = 0; i < 8; i++) {
        touch.tick(120);
        await touch.move(1, sp.x + 55 + (i % 2 ? 10 : -10), sp.y - 28);
        await new Promise((r) => setTimeout(r, 130));
      }
      const pMid = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      const during = await page.evaluate(() => ({
        stickVis: getComputedStyle(document.getElementById("t-stick2")).opacity,
        suspend: window.__dcc.touch.suspendReasons?.(),
        verdicts: window.__dcc.touch.verdicts().slice(-1) }));
      await touch.up(2);
      await page.waitForTimeout(600);
      const cdA2 = await cds(page);
      // stick STILL held: does movement continue after the cast?
      for (let i = 0; i < 4; i++) {
        touch.tick(120);
        await touch.move(1, sp.x + 55, sp.y - 28 + (i % 2 ? 8 : -8));
        await new Promise((r) => setTimeout(r, 130));
      }
      const pPost = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      await touch.up(1);
      const pre = Math.hypot(pPre.x - pA.x, pPre.y - pA.y);
      const kept = Math.hypot(pMid.x - pPre.x, pMid.y - pPre.y);
      const post = Math.hypot(pPost.x - pMid.x, pPost.y - pMid.y);
      const cast = Object.keys(cdA2).some((k) => (cdA2[k] ?? 0) > (cdB2[k] ?? 0) + 0.2);
      rec(device, "move-while-aiming: stick alive through the aim",
        pre > 0.4 && kept > 1.0 && cast ? "PASS" : "FAIL",
        `preTiles=${pre.toFixed(2)} duringAim=${kept.toFixed(2)} postCast=${post.toFixed(2)} cast=${cast} state1=${JSON.stringify(stickState1)} during=${JSON.stringify(during)}`);
    } else rec(device, "move-while-aiming: stick alive through the aim", "FAIL", `sp=${JSON.stringify(sp)} chip=${JSON.stringify(abChip)}`);

    rec(device, "pageerrors", errs.length === 0 ? "PASS" : "FAIL", JSON.stringify(errs));
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/report-b.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.verdict === "FAIL");
console.log(`\n${results.length} checks, ${fails.length} FAIL`);
