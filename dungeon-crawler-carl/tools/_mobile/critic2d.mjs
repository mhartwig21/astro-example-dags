// CRITIC ROUND 2, part D — the checks part A got wrong, done properly, plus
// clean HUD/cluster geometry taken AFTER the intro card clears.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const OUT = "tools/_mobile/c2d";
const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  "iphone13promax-land": { pw: "iPhone 13 Pro Max landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: { top: 24, right: 0, bottom: 20, left: 0 } },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: { top: 0, right: 24, bottom: 0, left: 0 } },
};

function touchDriver(client) {
  const live = new Map();
  const pts = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (t) => client.send("Input.dispatchTouchEvent", { type: t, touchPoints: pts(), timestamp: clock });
  const api = {
    tick(ms) { clock += ms / 1000; return api; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) { const p = live.get(id); live.delete(id); await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock }); },
    async tap(x, y, id = 1, hold = 100) { await api.down(id, x, y); api.tick(hold); await new Promise((r) => setTimeout(r, Math.min(hold, 60))); await api.up(id); },
  };
  return api;
}

async function run(dname) {
  const spec = SPECS[dname];
  const ctx = await browser.newContext({ ...devices[spec.pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const touch = touchDriver(client);
  const out = [];
  const rec = (n, v, d) => { out.push({ name: n, verdict: v, detail: d }); console.log(`  [${v}] ${n} — ${d}`); };
  const settle = async (k = 6) => {
    await page.waitForTimeout(180);
    await page.evaluate((q) => new Promise((r) => { let i = 0; const f = () => (++i >= q ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), k).catch(() => {});
  };
  const url = `${BASE}/iso.html?test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  // WAIT FOR THE INTRO CARD. Round A measured a 2.5 s frame and got a faded
  // cluster and an unsettled camera; the RINGSIDE intro is still on screen.
  await page.waitForFunction(() => {
    const c = document.querySelector("#skills .skill");
    if (!c) return false;
    const b = c.getBoundingClientRect();
    return b.width > 20 && +getComputedStyle(c).opacity > 0.6;
  }, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(6000);
  await settle(20);
  const V = page.viewportSize();

  // ---- G1. CLEAN GEOMETRY -------------------------------------------------
  const geo = await page.evaluate(() => {
    const d = window.__dcc, p = d.state.players[0], r = d.renderer;
    const q = r.worldToScreen(p.pos.x, 0.9, p.pos.y); const me = { x: Math.round(q.x), y: Math.round(q.y), vis: q.visible };
    const chips = [...document.querySelectorAll("#skills .skill, #flask-chip, #t-lock, #t-map")]
      .map((e) => { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display === "none" || !b.width ? null : { id: e.id || ("slot" + e.dataset.i), x: b.x, y: b.y, w: b.width, h: b.height }; }).filter(Boolean);
    const hudIds = ["cockpit", "hud-tl", "hud-tr", "skills", "banner", "show", "xpbar", "bossbar", "minimap-frame", "party", "t-lock", "t-map"];
    const hud = hudIds.map((id) => { const e = document.getElementById(id); if (!e) return null; const cs = getComputedStyle(e); if (cs.display === "none" || +cs.opacity === 0) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? { id, x: b.x, y: b.y, w: b.width, h: b.height } : null; }).filter(Boolean);
    // union area on a 4px grid — overlapping panels must not double count
    const step = 4; let covered = 0, total = 0;
    for (let y = 0; y < innerHeight; y += step) for (let x = 0; x < innerWidth; x += step) {
      total++;
      if (hud.some((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h)) covered++;
    }
    const cl = chips.length ? { x0: Math.min(...chips.map((c) => c.x)), y0: Math.min(...chips.map((c) => c.y)), x1: Math.max(...chips.map((c) => c.x + c.w)), y1: Math.max(...chips.map((c) => c.y + c.h)) } : null;
    return {
      vw: innerWidth, vh: innerHeight, crawler: me,
      crawlerInClusterBox: !!cl && me.x >= cl.x0 && me.x <= cl.x1 && me.y >= cl.y0 && me.y <= cl.y1,
      hudUnionPct: +(covered / total * 100).toFixed(1),
      hudParts: hud.map((h) => `${h.id} ${Math.round(h.w)}x${Math.round(h.h)}`),
      chips: chips.map((c) => ({ id: c.id, w: Math.round(c.w), h: Math.round(c.h), x: Math.round(c.x), y: Math.round(c.y) })),
      clusterBox: cl && { w: Math.round(cl.x1 - cl.x0), h: Math.round(cl.y1 - cl.y0), pctW: +((cl.x1 - cl.x0) / innerWidth * 100).toFixed(1), pctH: +((cl.y1 - cl.y0) / innerHeight * 100).toFixed(1) },
      cls: d.touch.zones.cls ?? null, cancelMode: d.touch.zones.cancelMode,
    };
  });
  rec("HUD footprint (union, 4px grid)", geo.hudUnionPct <= 25 ? "PASS" : "FAIL",
    `${geo.hudUnionPct}% of the viewport; cluster ${geo.clusterBox ? geo.clusterBox.w + "x" + geo.clusterBox.h + " = " + geo.clusterBox.pctW + "% x " + geo.clusterBox.pctH + "%" : "absent"}; chips=${JSON.stringify(geo.chips)}; parts=${geo.hudParts.join(", ")}`);
  rec("the crawler is not under the cluster", !geo.crawlerInClusterBox ? "PASS" : "FAIL", `crawler at ${JSON.stringify(geo.crawler)} on ${geo.vw}x${geo.vh}`);

  await page.evaluate(() => {
    clearInterval(window.__c2keep);
    window.__c2keep = setInterval(() => { const s = window.__dcc && window.__dcc.state; if (!s) return; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; s.status = "playing"; }, 120);
  });

  const clear = await page.evaluate(([w, h]) => {
    const d = window.__dcc;
    for (const fy of [0.86, 0.78, 0.66, 0.92]) for (const fx of [0.30, 0.22, 0.38, 0.14]) {
      const x = Math.round(w * fx), y = Math.round(h * fy);
      if (!d.touch.controlAt(x, y) && d.touch.route(x, y).zone === "stick") return { x, y };
    }
    return { x: Math.round(w * 0.3), y: Math.round(h * 0.86) };
  }, [V.width, V.height]);
  const chipAt = async (i) => page.evaluate((k) => { const e = document.querySelector(`#skills .skill[data-i="${k}"]`); const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; }, i);
  const resetCd = () => page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.dashCharges = 2; for (const k in p.cd) p.cd[k] = 0; });
  const dashState = () => page.evaluate(() => { const p = window.__dcc.state.players[0]; return { dc: p.dashCharges, cd: +(p.cd.dash || 0).toFixed(2) }; });

  // ---- D1. FLICK TO DASH: five profiles, each from a clean cooldown --------
  {
    const R = await page.evaluate(() => window.__dcc.touch.zones.stickRadius);
    const profiles = [
      { n: "4x34px @16ms", steps: 4, px: 34, ms: 16 },
      { n: "3x60px @12ms", steps: 3, px: 60, ms: 12 },
      { n: "6x25px @8ms", steps: 6, px: 25, ms: 8 },
      { n: "5x40px @16ms", steps: 5, px: 40, ms: 16 },
    ];
    const hits = [];
    for (const p of profiles) {
      await resetCd(); await settle(4);
      const a = await dashState();
      await touch.down(1, clear.x, clear.y);
      await settle(2);
      for (let i = 1; i <= p.steps; i++) { touch.tick(p.ms); await touch.move(1, clear.x + i * p.px, clear.y); await new Promise((r) => setTimeout(r, p.ms)); }
      await settle(6);
      await touch.up(1);
      await settle(4);
      const b = await dashState();
      hits.push(`${p.n}:${b.dc < a.dc || b.cd > a.cd ? "DASH" : "no"}`);
    }
    // false positives: ordinary circling steer
    await resetCd(); await settle(4);
    const a2 = await dashState();
    await touch.down(1, clear.x, clear.y);
    for (let i = 0; i < 20; i++) { touch.tick(16); const ang = (i / 20) * Math.PI * 2; await touch.move(1, clear.x + Math.cos(ang) * 55, clear.y + Math.sin(ang) * 55); await new Promise((r) => setTimeout(r, 16)); }
    await settle(6); await touch.up(1); await settle(4);
    const b2 = await dashState();
    const fp = b2.dc < a2.dc || b2.cd > a2.cd;
    const n = hits.filter((h) => h.endsWith("DASH")).length;
    rec("dodge: flick the stick (4 profiles)", n >= 3 ? "PASS" : n > 0 ? "WEAK" : "FAIL",
      `R=${Math.round(R)} threshold ${(12 * R).toFixed(0)} px/s; ${hits.join(" · ")}; ordinary circling steer at ~215 px/s → ${fp ? "FALSE POSITIVE" : "clean"}`);
  }

  // ---- D2. TWO-FINGER DASH, from a clean cooldown --------------------------
  {
    await resetCd(); await settle(4);
    const w = await page.evaluate(() => {
      const d = window.__dcc, pts = [];
      for (let ty = 0.45; ty < 0.9 && pts.length < 2; ty += 0.07) for (let tx = 0.5; tx < 0.95 && pts.length < 2; tx += 0.07) {
        const x = Math.round(innerWidth * tx), y = Math.round(innerHeight * ty);
        if (!d.touch.controlAt(x, y) && d.touch.route(x, y).zone === "world") pts.push({ x, y });
      }
      return pts;
    });
    const a = await dashState();
    await touch.down(1, w[0].x, w[0].y); touch.tick(40);
    await touch.down(2, w[1].x, w[1].y); touch.tick(80);
    await new Promise((r) => setTimeout(r, 80));
    await touch.up(1); await touch.up(2);
    await settle(8);
    const b = await dashState();
    rec("dodge: two-finger world tap", b.dc < a.dc || b.cd > a.cd ? "PASS" : "FAIL", `${JSON.stringify(w)}; charges ${a.dc}->${b.dc}, cd ${a.cd}->${b.cd}`);
  }

  // ---- D3. AIMED CAST, isolated (part A's iPad FAIL) ----------------------
  for (const slot of ["1", "2"]) {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; for (const k in p.cd) p.cd[k] = 0; });
    await settle(4);
    const c = await chipAt(slot);
    const a = await page.evaluate(() => JSON.parse(JSON.stringify(window.__dcc.state.players[0].cd || {})));
    await touch.down(1, c.x, c.y);
    await settle(3);
    // drag INBOARD (toward the world), which is where a player aims
    for (let i = 1; i <= 12; i++) { await touch.move(1, c.x - i * 10, c.y - i * 4); await settle(1); }
    const mid = await page.evaluate(() => {
      const d = window.__dcc;
      const oc = document.getElementById("t-ocancel"), cb = document.getElementById("t-cancel");
      const g = (e) => e ? { on: e.classList.contains("on"), armed: e.classList.contains("armed"), op: getComputedStyle(e).opacity } : null;
      return { ocancel: g(oc), band: g(cb), ind: !!(d.renderer.aimIndicator && d.renderer.aimIndicator.visible) };
    });
    await touch.up(1);
    await settle(8);
    const b = await page.evaluate(() => JSON.parse(JSON.stringify(window.__dcc.state.players[0].cd || {})));
    const started = Object.keys(b).filter((k) => (b[k] || 0) > (a[k] || 0));
    rec(`aimed cast, slot ${slot}, isolated`, started.length ? "PASS" : "FAIL",
      `drag ${Math.round(Math.hypot(120, 48))}px inboard from the chip; fired ${started.join(",") || "none"}; mid-drag ${JSON.stringify(mid)}`);
  }

  // ---- D4. CAST WHILE MOVING, isolated ------------------------------------
  {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; for (const k in p.cd) p.cd[k] = 0; });
    await settle(4);
    const c = await chipAt("1");
    let best = 0, note = "";
    for (const [dx, dy] of [[80, 0], [-80, 0], [0, 70], [0, -70]]) {
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const k in p.cd) p.cd[k] = 0; });
      await touch.down(1, clear.x, clear.y);
      await settle(2);
      for (let i = 0; i < 8; i++) { await touch.move(1, clear.x + dx, clear.y + dy); await settle(2); }
      const a = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { x: p.pos.x, y: p.pos.y, cd: JSON.parse(JSON.stringify(p.cd || {})) }; });
      await touch.down(2, c.x, c.y);
      await settle(2);
      for (let i = 1; i <= 10; i++) { await touch.move(2, c.x - i * 11, c.y - i * 4); await touch.move(1, clear.x + dx, clear.y + dy); await settle(2); }
      const m = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { x: p.pos.x, y: p.pos.y }; });
      await touch.up(2);
      await settle(6);
      const bb = await page.evaluate(() => JSON.parse(JSON.stringify(window.__dcc.state.players[0].cd || {})));
      await touch.up(1);
      await settle(3);
      const moved = Math.hypot(m.x - a.x, m.y - a.y);
      const fired = Object.keys(bb).filter((k) => (bb[k] || 0) > (a.cd[k] || 0));
      if (moved > best) { best = moved; note = `dir(${dx},${dy}): ${moved.toFixed(2)} tiles DURING the aim, cast ${fired.join(",") || "none"}`; }
      if (moved > 0.5 && fired.length) { note = `dir(${dx},${dy}): ${moved.toFixed(2)} tiles DURING the aim, cast ${fired.join(",")}`; break; }
    }
    rec("cast while moving (isolated)", best > 0.5 ? "PASS" : "FAIL", note || "no direction moved");
  }

  // ---- D5. TAP TO MOVE, to a point FAR from the crawler --------------------
  {
    await page.evaluate(() => { const d = window.__dcc; d.state.players[0].hp = d.state.players[0].maxHp; });
    await settle(4);
    const g = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      let best = null;
      for (let ty = 0.3; ty < 0.95; ty += 0.04) for (let tx = 0.45; tx < 0.98; tx += 0.04) {
        const x = Math.round(innerWidth * tx), y = Math.round(innerHeight * ty);
        if (d.touch.controlAt(x, y)) continue;
        if (d.touch.route(x, y).zone !== "world") continue;
        const gr = d.renderer.screenToGround(x, y);
        if (!gr) continue;
        const dist = Math.hypot(gr.x - p.pos.x, gr.y - p.pos.y);
        if (dist < 3.5) continue;
        // must be walkable floor, and no monster near it (that would be an attack)
        const ti = Math.floor(gr.y) * st.map.w + Math.floor(gr.x);
        if (st.map.tiles[ti] === 0) continue; // wall
        if (st.monsters.some((m) => m.hp > 0 && Math.hypot(m.pos.x - gr.x, m.pos.y - gr.y) < 2.5)) continue;
        const mobNear = st.monsters.some((m) => { if (m.hp <= 0 || m.dormant) return false; const s = d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y); return s.visible && Math.hypot(s.x - x, s.y - y) < 60; });
        if (mobNear) continue;
        if (!best || dist > best.dist) best = { x, y, gx: +gr.x.toFixed(2), gy: +gr.y.toFixed(2), dist: +dist.toFixed(2), px: +p.pos.x.toFixed(2), py: +p.pos.y.toFixed(2) };
      }
      return best;
    });
    if (!g) rec("tap to move (far target)", "N/A", "no walkable world point >= 3.5 tiles away");
    else {
      const a = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { x: p.pos.x, y: p.pos.y }; });
      await touch.tap(g.x, g.y, 1, 120);
      await settle(4);
      const t0 = await page.evaluate(() => ({ tgt: window.__dcc.touch.clickMoveTarget, tap: window.__dcc.touch.lastWorldTap }));
      for (let i = 0; i < 14; i++) await settle(8);
      const b = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { x: p.pos.x, y: p.pos.y }; });
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      const closed = Math.hypot(g.gx - a.x, g.gy - a.y) - Math.hypot(g.gx - b.x, g.gy - b.y);
      rec("tap to move (far target)", moved > 1 && closed > 0.8 ? "PASS" : "FAIL",
        `target ${g.dist} tiles away at (${g.gx},${g.gy}); walked ${moved.toFixed(2)} tiles, closed ${closed.toFixed(2)}; clickMoveTarget=${JSON.stringify(t0.tgt)}; lastWorldTap=${JSON.stringify(t0.tap)}`);
    }
  }

  // ---- D6. LOOT: does a pickup get acknowledged? --------------------------
  {
    const st0 = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      const m = st.monsters.find((q) => q.hp > 0 && !q.dormant);
      if (m) { m.pos.x = p.pos.x + 1.0; m.pos.y = p.pos.y + 0.5; m.hp = 1; }
      return { loot: (st.loot || []).length, bag: (p.inventory || []).length, gold: p.gold, staged: !!m };
    });
    const c0 = await chipAt("0");
    await touch.down(1, c0.x, c0.y);
    await page.waitForTimeout(2500);
    await touch.up(1);
    await settle(14);
    const st1 = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      const near = (st.loot || []).filter((l) => Math.hypot(l.pos.x - p.pos.x, l.pos.y - p.pos.y) < 4).map((l) => ({ k: l.kind, d: +Math.hypot(l.pos.x - p.pos.x, l.pos.y - p.pos.y).toFixed(2) }));
      const e = document.getElementById("pickstrip");
      const cs = e && getComputedStyle(e); const b = e && e.getBoundingClientRect();
      return { loot: (st.loot || []).length, bag: (p.inventory || []).length, gold: p.gold, near, strip: e ? { disp: cs.display, op: cs.opacity, w: Math.round(b.width), h: Math.round(b.height), rows: e.childElementCount, text: (e.textContent || "").trim().slice(0, 60) } : null };
    });
    // step onto the nearest drop with the stick
    let st2 = st1;
    if (st1.near.length) {
      const dir = await page.evaluate(() => {
        const d = window.__dcc, st = d.state, p = st.players[0], r = d.renderer;
        const l = (st.loot || []).slice().sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))[0];
        if (!l) return null;
        const s0 = r.worldToScreen(p.pos.x, 0, p.pos.y); const A = { x: s0.x, y: s0.y };
        const s1 = r.worldToScreen(l.pos.x, 0, l.pos.y); const B = { x: s1.x, y: s1.y };
        const m = Math.hypot(B.x - A.x, B.y - A.y) || 1;
        return { ux: (B.x - A.x) / m, uy: (B.y - A.y) / m };
      });
      if (dir) {
        await touch.down(1, clear.x, clear.y);
        await settle(2);
        for (let i = 0; i < 30; i++) { await touch.move(1, clear.x + dir.ux * 70, clear.y + dir.uy * 70); await settle(2); }
        await touch.up(1);
        await settle(10);
      }
      st2 = await page.evaluate(() => {
        const d = window.__dcc, st = d.state, p = st.players[0];
        const e = document.getElementById("pickstrip");
        const cs = e && getComputedStyle(e); const b = e && e.getBoundingClientRect();
        return { loot: (st.loot || []).length, bag: (p.inventory || []).length, gold: p.gold, near: [], strip: e ? { disp: cs.display, op: cs.opacity, w: Math.round(b.width), h: Math.round(b.height), rows: e.childElementCount, text: (e.textContent || "").trim().slice(0, 60) } : null };
      });
    }
    const picked = st2.bag > st0.bag || st2.gold > st0.gold || st2.loot < st1.loot;
    const acked = st2.strip && st2.strip.rows > 0 && st2.strip.disp !== "none";
    rec("loot: drop, walk over it, and see it acknowledged", picked && acked ? "PASS" : picked ? "WEAK" : "FAIL",
      `loot ${st0.loot}->${st1.loot}->${st2.loot}; bag ${st0.bag}->${st2.bag}; gold ${st0.gold}->${st2.gold}; nearest ${JSON.stringify(st1.near.slice(0, 2))}; pickstrip ${JSON.stringify(st2.strip)}`);
  }

  rec("page errors", errs.length === 0 ? "PASS" : "FAIL", errs.slice(0, 3).join(" | ") || "none");
  await page.screenshot({ path: join(OUT, `${dname}.png`) }).catch(() => {});
  await ctx.close();
  return { device: dname, viewport: V, geo, checks: out, errs };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const devs = (process.argv.includes("--devices") ? process.argv[process.argv.indexOf("--devices") + 1] : Object.keys(SPECS).join(",")).split(",");
const report = [];
for (const d of devs) { console.log("== " + d); try { report.push(await run(d)); } catch (e) { console.error("FAILED", d, e.message); report.push({ device: d, error: e.message }); } }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log("-> " + join(OUT, "report.json"));
await browser.close();
