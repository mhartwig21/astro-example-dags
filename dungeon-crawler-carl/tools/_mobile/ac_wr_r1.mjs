// Acceptance critique r1 (post fix-round): core control layer on the 4-device
// matrix, REAL CDP touch only, one browser. Independent probe — trusts nothing
// from wrfix1. Evidence under tools/_mobile/ac-wr-r1/.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const BASE = "http://localhost:5286";
const OUT = "tools/_mobile/ac-wr-r1";
mkdirSync(OUT, { recursive: true });
const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: "0,47,21,47", insets: { top: 0, right: 47, bottom: 21, left: 47 } },
  "iphone13promax-land": { pw: "iPhone 13 Pro Max landscape", safe: "0,47,21,47", insets: { top: 0, right: 47, bottom: 21, left: 47 } },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: "24,0,20,0", insets: { top: 24, right: 0, bottom: 20, left: 0 } },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: "0,24,24,0", insets: { top: 0, right: 24, bottom: 24, left: 0 } },
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
      const { id = 1, steps = 10, holdMs = 24, lift = true, settle = false } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (settle) { this.tick(220); await this.move(id, tx, ty); await new Promise((r) => setTimeout(r, 200)); }
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
  const box = await page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return null;
    const r = l.getBoundingClientRect();
    return getComputedStyle(l).display !== "none" && r.width > 0 ? { w: r.width, h: r.height } : null;
  });
  if (box) throw new Error("loading still has a box");
}

const hit = async (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return { ok: false, why: "missing" };
  const r = e.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const at = document.elementFromPoint(cx, cy);
  return { ok: !!at && (at === e || e.contains(at)),
    w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(cx), cy: Math.round(cy),
    at: at ? `${at.tagName}#${at.id}.${[...at.classList].join(".")}` : "none",
    on: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight };
}, sel);

// Immortality + calm: keep the crawler alive and monsters passive.
const calm = (page) => page.evaluate(() => {
  const s = window.__dcc.state, p = s.players[0];
  p.hp = p.maxHp;
  for (const m of s.monsters) { m.speed = 0; m.windup = 0; m.attackCooldown = 999; m.shootCd = 999; m.blinkCd = 999; }
});

// Find clear ground for a stick gesture / world tap: no control, canvas under.
const clearPoint = (page, x0, y0) => page.evaluate(([x0, y0]) => {
  const d = window.__dcc;
  for (const [dx, dy] of [[0, 0], [30, -20], [-25, 15], [45, 10], [0, -40], [60, -30], [-40, -25], [20, 35]]) {
    const x = x0 + dx, y = y0 + dy;
    if (d.touch.controlAt(x, y)) continue;
    const e = document.elementFromPoint(x, y);
    if (!e) continue;
    if (e.tagName === "CANVAS" && e.id !== "minimap") return { x, y, at: e.id || e.tagName };
    if (e.id === "t-stickzone" || e.classList.contains("t-layer")) return { x, y, at: e.id };
  }
  return null;
}, [x0, y0]);

const cds = (page) => page.evaluate(() => {
  const p = window.__dcc.state.players[0];
  return JSON.parse(JSON.stringify(p.cooldowns ?? p.cds ?? {}));
});

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

    // ---- 0. idle skin + resting affordance --------------------------------
    await page.screenshot({ path: `${OUT}/${device}-idle.png` });
    const ghost = await page.evaluate(() => {
      const g = document.querySelector(".t-ghost");
      if (!g) return { ok: false, why: "missing" };
      const r = g.getBoundingClientRect();
      const cs = getComputedStyle(g);
      const z = window.__dcc.touch.zones;
      return { ok: +cs.opacity > 0.1 && r.width > 40, w: Math.round(r.width),
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
        opacity: cs.opacity, anchor: z.stickAnchor,
        inZone: r.x + r.width / 2 < z.viewport.w / 2 };
    });
    rec(device, "resting stick ghost visible at idle", ghost.ok && ghost.inZone ? "PASS" : "FAIL", JSON.stringify(ghost));

    // ---- 1. stick moves the crawler ---------------------------------------
    const z = await page.evaluate(() => window.__dcc.touch.zones);
    const sp = await clearPoint(page, z.stickAnchor.x, z.stickAnchor.y);
    if (!sp) rec(device, "stick: clear ground", "FAIL", "no clear stick point");
    else {
      const p0 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      await touch.drag(sp.x, sp.y, sp.x + Math.min(60, z.stickRadius), sp.y - 30, { steps: 6, holdMs: 40, lift: false });
      await page.waitForTimeout(1600);
      const p1 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      const stickVis = await page.evaluate(() => {
        const s = document.querySelector(".t-stick2"), n = document.querySelector(".t-nub2");
        return { stick: s ? getComputedStyle(s).opacity : "x", nub: n ? getComputedStyle(n).opacity : "x" };
      });
      await touch.up(1);
      const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      rec(device, "stick drag moves crawler + live visuals", moved > 0.8 && +stickVis.stick > 0.5 ? "PASS" : "FAIL",
        `moved=${moved.toFixed(2)} tiles vis=${JSON.stringify(stickVis)} from=${JSON.stringify(sp)}`);
    }
    await calm(page);

    // ---- 2. aimed cast of a PLACED shape: telegraph honesty (r3 regression)
    const slots = await page.evaluate(() => window.__dcc.state.players[0].abilities.slots);
    const placedPick = ["nova", "orbit", "cataclysm", "airstrike", "cutto"].map((a) => ({ a, i: slots.indexOf(a) })).find((x) => x.i >= 0)
      ?? { a: slots[4], i: 4 };
    const chip = await hit(page, `#skills .skill[data-i="${placedPick.i}"]`);
    if (!chip.ok) rec(device, "placed-aim: chip hit-test", "FAIL", JSON.stringify(chip));
    else {
      await page.evaluate(() => window.__dcc.touch.clearVerdicts?.());
      await touch.drag(chip.cx, chip.cy, chip.cx - 120, chip.cy - 55, { steps: 8, holdMs: 30, lift: false });
      await page.waitForTimeout(700);
      const aim = await page.evaluate(() => {
        const d = window.__dcc, r = d.renderer, p = d.state.players[0];
        const out = { ind: null, range: null, ocancel: null, cancelBandOn: null };
        const grab = (name) => (r.scene?.children ?? []).find((c) => c.name === name);
        const ind = grab("aimIndicator"), rng = grab("aimRange");
        const wpos = (o) => { let m = null; o.traverse((c) => { if (!m && c.isMesh) m = c; }); if (!m) return null;
          const v = m.position.clone().set(0, 0, 0); m.getWorldPosition(v); return v; };
        if (ind && ind.visible) {
          const v = wpos(ind);
          if (v) {
            const scr = r.worldToScreen(v.x, v.y, v.z);
            out.ind = { dist: +Math.hypot(v.x - p.pos.x, v.z - p.pos.y).toFixed(2),
              sx: Math.round(scr.x), sy: Math.round(scr.y), visible: scr.visible,
              onGlass: scr.x >= -20 && scr.x <= innerWidth + 20 && scr.y >= -20 && scr.y <= innerHeight + 20 };
          } else out.ind = { noMesh: true };
        }
        if (rng && rng.visible) {
          const v = wpos(rng);
          out.range = v ? { dist: +Math.hypot(v.x - p.pos.x, v.z - p.pos.y).toFixed(2) } : { noMesh: true };
        }
        const oc = document.querySelector(".t-ocancel");
        if (oc) { const cs = getComputedStyle(oc); const rr = oc.getBoundingClientRect();
          out.ocancel = { op: cs.opacity, disp: cs.display, x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width) }; }
        const cb = document.querySelector(".t-cancel");
        if (cb) out.cancelBandOn = getComputedStyle(cb).display !== "none" && cb.classList.contains("on");
        out.cancelMode = d.touch.zones.cancelMode;
        return out;
      });
      await page.screenshot({ path: `${OUT}/${device}-aim-placed.png` });
      const cdBefore = await cds(page);
      await touch.up(1);
      await page.waitForTimeout(700);
      const cdAfter = await cds(page);
      const verd = await page.evaluate(() => window.__dcc.touch.verdicts().slice(-2));
      const started = Object.keys(cdAfter).some((k) => (cdAfter[k] ?? 0) > (cdBefore[k] ?? 0) + 0.2);
      const indOk = aim.ind && !aim.ind.noMesh && aim.ind.dist <= 16 && aim.ind.onGlass;
      rec(device, `placed-aim (${placedPick.a}): telegraph near crawler + on glass`, indOk ? "PASS" : "FAIL", JSON.stringify(aim.ind));
      rec(device, "placed-aim: range ring anchored on crawler", aim.range && !aim.range.noMesh && aim.range.dist < 3 ? "PASS" : "FAIL", JSON.stringify(aim.range));
      const cancelDrawn = aim.cancelMode === "origin" ? (aim.ocancel && aim.ocancel.disp !== "none" && +aim.ocancel.op > 0.3)
        : aim.cancelBandOn;
      rec(device, `cancel affordance drawn while aiming (${aim.cancelMode})`, cancelDrawn ? "PASS" : "FAIL", JSON.stringify({ oc: aim.ocancel, band: aim.cancelBandOn }));
      rec(device, "placed-aim: release casts (cooldown starts)", started ? "PASS" : "FAIL",
        `verdicts=${JSON.stringify(verd)}`);
      // cooldown numeral
      const cdnum = await page.evaluate((i) => {
        const c = document.querySelector(`#skills .skill[data-i="${i}"] .cdnum`);
        return c ? { text: c.textContent, shown: getComputedStyle(c).display !== "none" } : { missing: true };
      }, placedPick.i);
      rec(device, "cooldown numeral on the chip face", cdnum.shown && cdnum.text ? "PASS" : "FAIL", JSON.stringify(cdnum));
    }
    await calm(page);

    // ---- 3. cancel: out past slop, back to origin, lift --------------------
    const cSlot = placedPick.i === 0 ? 1 : 0;
    const chip2 = await hit(page, `#skills .skill[data-i="${cSlot}"]`);
    if (chip2.ok) {
      await page.waitForTimeout(3500); // let cooldowns clear a bit
      const cdB = await cds(page);
      await page.evaluate(() => window.__dcc.touch.clearVerdicts?.());
      await touch.drag(chip2.cx, chip2.cy, chip2.cx - 110, chip2.cy - 50, { steps: 6, holdMs: 30, lift: false });
      await page.waitForTimeout(200);
      // crawl back to the frozen origin
      await touch.drag(chip2.cx - 110, chip2.cy - 50, chip2.cx, chip2.cy, { id: 1, steps: 6, holdMs: 30, lift: false }).catch(() => {});
      await page.waitForTimeout(250);
      await touch.up(1);
      await page.waitForTimeout(500);
      const cdA = await cds(page);
      const verd = await page.evaluate(() => window.__dcc.touch.verdicts().slice(-1));
      const leaked = Object.keys(cdA).some((k) => (cdA[k] ?? 0) > (cdB[k] ?? 0) + 0.2);
      rec(device, "drag out + return to origin cancels (no cast)",
        !leaked && verd[0] && verd[0].verdict === "cancel" ? "PASS" : (!leaked ? "WARN" : "FAIL"),
        `leaked=${leaked} verd=${JSON.stringify(verd)}`);
    }
    await calm(page);

    // ---- 4. move-while-aiming: two real fingers ----------------------------
    const sp2 = await clearPoint(page, z.stickAnchor.x, z.stickAnchor.y);
    const chip3 = await hit(page, `#skills .skill[data-i="${cSlot}"]`);
    if (sp2 && chip3.ok) {
      await page.waitForTimeout(2500);
      const pA = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      await touch.down(1, sp2.x, sp2.y);
      touch.tick(30);
      await touch.move(1, sp2.x + 50, sp2.y - 25);
      const cdB = await cds(page);
      await touch.drag(chip3.cx, chip3.cy, chip3.cx - 115, chip3.cy - 45, { id: 2, steps: 7, holdMs: 28, lift: false });
      // keep both held; wiggle the stick to prove it is still live
      for (let i = 0; i < 6; i++) {
        touch.tick(120);
        await touch.move(1, sp2.x + 50 + (i % 2 ? 8 : -8), sp2.y - 25);
        await new Promise((r) => setTimeout(r, 150));
      }
      const pMid = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      await touch.up(2);
      await page.waitForTimeout(500);
      const cdA = await cds(page);
      await touch.up(1);
      const kept = Math.hypot(pMid.x - pA.x, pMid.y - pA.y);
      const cast = Object.keys(cdA).some((k) => (cdA[k] ?? 0) > (cdB[k] ?? 0) + 0.2);
      rec(device, "move while aiming (two fingers)", kept > 1.2 && cast ? "PASS" : "FAIL",
        `keptTiles=${kept.toFixed(2)} castOnRelease=${cast}`);
    } else rec(device, "move while aiming (two fingers)", "FAIL", `sp=${JSON.stringify(sp2)} chip=${JSON.stringify(chip3)}`);
    await calm(page);

    // ---- 5. flask ----------------------------------------------------------
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = Math.max(1, Math.floor(p.maxHp * 0.35)); });
    const flask = await hit(page, "#flask-chip");
    if (flask.ok) {
      const hpB = await page.evaluate(() => window.__dcc.state.players[0].hp);
      await touch.tap(flask.cx, flask.cy, 1, 90);
      await page.waitForTimeout(700);
      const hpA = await page.evaluate(() => window.__dcc.state.players[0].hp);
      rec(device, "flask tap heals", hpA > hpB + 5 ? "PASS" : "FAIL", `hp ${hpB} -> ${hpA} rect=${flask.w}x${flask.h}`);
    } else rec(device, "flask tap heals", "FAIL", JSON.stringify(flask));
    await calm(page);

    // ---- 6. world tap = move order ----------------------------------------
    const wt = await page.evaluate(() => {
      const d = window.__dcc, z = d.touch.zones;
      const x = Math.round(z.viewport.w * 0.5), y = Math.round(z.viewport.h * 0.30);
      for (const [dx, dy] of [[0, 0], [40, 20], [-40, 25], [80, 0], [0, 45]]) {
        if (d.touch.controlAt(x + dx, y + dy)) continue;
        const e = document.elementFromPoint(x + dx, y + dy);
        if (e && e.tagName === "CANVAS" && e.id !== "minimap") return { x: x + dx, y: y + dy };
      }
      return null;
    });
    if (wt) {
      const pB = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
      await touch.tap(wt.x, wt.y, 1, 100);
      await page.waitForTimeout(1800);
      const after = await page.evaluate(() => ({
        pos: { ...window.__dcc.state.players[0].pos },
        tgt: window.__dcc.touch.clickMoveTarget, tap: window.__dcc.touch.lastWorldTap }));
      const moved = Math.hypot(after.pos.x - pB.x, after.pos.y - pB.y);
      rec(device, "world tap issues a move order", moved > 0.5 || after.tgt ? "PASS" : "FAIL",
        `moved=${moved.toFixed(2)} tgt=${JSON.stringify(after.tgt)} tap=${JSON.stringify(after.tap)}`);
    } else rec(device, "world tap issues a move order", "FAIL", "no clear world point");
    await calm(page);

    // ---- 7. tap-to-lock a staged monster -----------------------------------
    const diag = await page.evaluate(async () => {
      const d = window.__dcc, s = d.state, r = d.renderer, p = s.players[0];
      const m = s.monsters.find((mm) => mm.hp > 0 && !mm.dormant);
      if (!m) return null;
      for (const [dx, dy] of [[-2.5, -1.5], [-3, 0], [0, -3], [-2, 2], [2, -2]]) {
        m.pos.x = p.pos.x + dx; m.pos.y = p.pos.y + dy;
        const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        await frame();
        const p0 = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
        await frame();
        const p1 = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
        if (!p1.visible || !p0.visible) continue;
        if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > 10) continue;
        if (d.touch.controlAt(p1.x, p1.y)) continue;
        return { mob: m.id, x: Math.round(p1.x), y: Math.round(p1.y) };
      }
      return null;
    });
    if (!diag) rec(device, "tap-to-lock", "FAIL", "no stable stage point");
    else {
      let v = null, tries = 0;
      for (; tries < 3; tries++) {
        const at = await page.evaluate((mob) => {
          const d = window.__dcc;
          const m = d.state.monsters.find((mm) => mm.id === mob);
          if (!m || m.hp <= 0) return null;
          const p = d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y);
          return { x: Math.round(p.x), y: Math.round(p.y) };
        }, diag.mob);
        if (!at) break;
        await touch.tap(at.x, at.y, 1, 90);
        await page.waitForTimeout(450);
        v = await page.evaluate(() => window.__dcc.touch.lockedTargetId);
        if (v === diag.mob) break;
      }
      rec(device, "tap-to-lock staged monster", v === diag.mob ? (tries > 0 ? "WARN" : "PASS") : "FAIL",
        `locked=${v} want=${diag.mob} retries=${tries}`);
    }

    // ---- 8. control census: hit-tests, tiers, keepout, safe area -----------
    const census = await page.evaluate((insets) => {
      const d = window.__dcc, z = d.touch.zones;
      const out = { controls: [], keepoutViolations: [], safeIntrusions: [], tiers: {} };
      const ids = Object.keys(z.controls ?? {});
      for (const id of ids) {
        const c = z.controls[id];
        const at = d.touch.controlAt(c.cx, c.cy);
        out.controls.push({ id, cx: Math.round(c.cx), cy: Math.round(c.cy),
          w: Math.round(c.w), h: Math.round(c.h), vis: Math.round(c.vis ?? c.w), routed: at,
          hitOk: at === id || (id.startsWith("slot") && String(at) === id) });
        const k = z.keepout;
        const rect = { x: c.cx - c.w / 2, y: c.cy - c.h / 2, w: c.w, h: c.h };
        if (rect.x < k.x + k.w && rect.x + rect.w > k.x && rect.y < k.y + k.h && rect.y + rect.h > k.y)
          out.keepoutViolations.push(id);
      }
      out.tiers = { ult: Math.round(z.controls.slot4?.vis ?? 0), ab: Math.round(z.controls.slot1?.vis ?? 0),
        attack: Math.round(z.controls.slot0?.vis ?? 0), flask: Math.round(z.controls.flask?.vis ?? 0),
        lock: Math.round(z.controls.lock?.vis ?? 0), map: Math.round(z.controls.map?.vis ?? 0) };
      // safe-area: key HUD boxes vs real insets
      for (const id of ["minimap-frame", "cockpit", "hud-tl", "hud-tr", "xpbar", "banner"]) {
        const e = document.getElementById(id);
        if (!e) continue;
        const cs = getComputedStyle(e);
        if (cs.display === "none" || +cs.opacity === 0) continue;
        const r = e.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.x < insets.left) out.safeIntrusions.push(`${id} left ${Math.round(r.x)}<${insets.left}`);
        if (innerWidth - (r.x + r.width) < insets.right) out.safeIntrusions.push(`${id} right ${Math.round(innerWidth - r.x - r.width)}<${insets.right}`);
        if (r.y < insets.top) out.safeIntrusions.push(`${id} top ${Math.round(r.y)}<${insets.top}`);
        if (innerHeight - (r.y + r.height) < insets.bottom) out.safeIntrusions.push(`${id} bottom ${Math.round(innerHeight - r.y - r.height)}<${insets.bottom}`);
      }
      return out;
    }, SPECS[device].insets);
    const badHits = census.controls.filter((c) => !c.routed || (c.routed !== c.id));
    rec(device, "all controls route at their centre", badHits.length === 0 ? "PASS" : "FAIL",
      badHits.length ? JSON.stringify(badHits) : `${census.controls.length} controls`);
    const under44 = census.controls.filter((c) => c.w < 44 || c.h < 44);
    rec(device, "hit rects >= 44px", under44.length === 0 ? "PASS" : "FAIL",
      under44.length ? JSON.stringify(under44) : "all clear");
    rec(device, "no control inside crawler keepout", census.keepoutViolations.length === 0 ? "PASS" : "FAIL",
      JSON.stringify(census.keepoutViolations));
    rec(device, "size tiers (ult > abilities > satellites)",
      census.tiers.ult > census.tiers.ab && census.tiers.attack > census.tiers.ab && census.tiers.lock < census.tiers.ab ? "PASS" : "FAIL",
      JSON.stringify(census.tiers));
    rec(device, "safe-area intrusions", census.safeIntrusions.length === 0 ? "PASS" : "FAIL",
      JSON.stringify(census.safeIntrusions));

    rec(device, "pageerrors", errs.length === 0 ? "PASS" : "FAIL", JSON.stringify(errs));
    await ctx.close();
  }

  // ---- 9. quality auto-pick on phone/tablet class (no quality pin) ---------
  for (const device of ["iphone13-land", "ipadpro11-land"]) {
    const ctx = await browser.newContext({ ...devices[SPECS[device].pw] });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&floor=2&level=5&seed=9&safe=${SPECS[device].safe}`,
      { waitUntil: "load", timeout: 120000 });
    await ready(page);
    const q = await page.evaluate(() => {
      const r = window.__dcc.renderer;
      return { profile: r.qualityProfile?.name ?? null, setting: r.qualitySetting ?? null,
        coarse: matchMedia("(pointer: coarse)").matches,
        shortEdge: Math.min(screen.width, screen.height), dpr: devicePixelRatio };
    });
    rec(device, "quality auto-pick (emulated; Safari caveat applies)",
      q.profile === "low" || q.profile === "medium" ? "PASS" : "WARN", JSON.stringify(q));
    await ctx.close();
  }

  // ---- 10. customisation: mirrored layout + persistence (iPhone 13) --------
  {
    const ctx = await browser.newContext({ ...devices[SPECS["iphone13-land"].pw] });
    const page = await ctx.newPage();
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=8&abilities=all&seed=9&safe=${SPECS["iphone13-land"].safe}`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);
    await calm(page);
    const before = await page.evaluate(() => ({
      slot4: Math.round(window.__dcc.touch.zones.controls.slot4.cx),
      stick: Math.round(window.__dcc.touch.zones.stickAnchor.x), w: innerWidth }));
    // open SYSTEM menu -> keybinds -> CONTROLS by touch
    const tb = await hit(page, "#tb-system");
    await touch.tap(tb.cx, tb.cy, 1, 110);
    await page.waitForTimeout(500);
    const row = await page.evaluate(() => {
      const r = [...document.querySelectorAll("#tm-system .tm-row")].find((x) => x.dataset.act === "keybinds");
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return b.width > 0 ? { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) } : null;
    });
    let flipped = null;
    if (row) {
      await touch.tap(row.cx, row.cy, 1, 110);
      await page.waitForTimeout(600);
      const ctl = await page.evaluate(() => {
        const b = [...document.querySelectorAll(".kb-tabs button")].find((x) => x.textContent.includes("CONTROLS"));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
      });
      if (ctl) {
        await touch.tap(ctl.cx, ctl.cy);
        await page.waitForTimeout(400);
        const rows = await page.evaluate(() => {
          const ids = [...document.querySelectorAll("#kb-page-controls [data-tp]")].map((b) => b.dataset.tp);
          return { unique: [...new Set(ids)], count: ids.length };
        });
        rec("iphone13-land", "customisation rows present (size/opacity/hand/haptics)",
          ["stickScale", "buttonScale", "opacity", "handed"].every((k) => rows.unique.includes(k)) ? "PASS" : "FAIL",
          JSON.stringify(rows.unique));
        const flipBtn = await page.evaluate(async () => {
          const b = document.querySelector('#kb-page-controls [data-tp="handed"][data-set="LEFT"]');
          if (!b) return null;
          b.scrollIntoView({ block: "center" });
          await new Promise((r2) => setTimeout(r2, 250));
          const r = b.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), ok: !!at && (at === b || b.contains(at)) };
        });
        if (flipBtn?.ok) {
          await touch.tap(flipBtn.cx, flipBtn.cy);
          await page.waitForTimeout(600);
          const x = await hit(page, "#keys .tp-x");
          if (x.ok) await touch.tap(x.cx, x.cy);
          await page.waitForTimeout(600);
          flipped = await page.evaluate(() => ({
            slot4: Math.round(window.__dcc.touch.zones.controls.slot4.cx),
            stick: Math.round(window.__dcc.touch.zones.stickAnchor.x),
            handedLeft: document.body.classList.contains("handed-left"), w: innerWidth }));
          await page.screenshot({ path: `${OUT}/iphone13-land-lefty.png` });
          rec("iphone13-land", "left-hand mirror flips cluster + stick",
            flipped.handedLeft && flipped.slot4 < before.w / 2 && flipped.stick > before.w / 2 ? "PASS" : "FAIL",
            `before=${JSON.stringify(before)} after=${JSON.stringify(flipped)}`);
          // persistence across reload
          await page.reload({ waitUntil: "load" });
          await ready(page);
          const persisted = await page.evaluate(() => ({
            handedLeft: document.body.classList.contains("handed-left"),
            slot4: Math.round(window.__dcc.touch.zones.controls.slot4.cx), w: innerWidth }));
          rec("iphone13-land", "left-hand layout persists across reload",
            persisted.handedLeft && persisted.slot4 < persisted.w / 2 ? "PASS" : "FAIL", JSON.stringify(persisted));
        } else rec("iphone13-land", "left-hand mirror flips cluster + stick", "FAIL", `flip btn ${JSON.stringify(flipBtn)}`);
      } else rec("iphone13-land", "customisation: CONTROLS tab", "FAIL", "tab missing");
    } else rec("iphone13-land", "customisation: keybinds row", "FAIL", "row missing");
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.verdict === "FAIL");
console.log(`\n${results.length} checks, ${fails.length} FAIL`);
