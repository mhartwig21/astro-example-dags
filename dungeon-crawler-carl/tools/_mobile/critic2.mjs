// CRITIC ROUND 1 — pass 2. Fixes the invalid probes from pass 1 and adds the
// tests that matter: cancel-band vs stick-zone conflict, aimed-cast per slot,
// reach against the layer's OWN zone table, panel close controls, shop buy.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { touchDriver, DEVICE_SPECS } from "../mobileshot.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const BASE = flag("base", "http://localhost:5420");
const OUT = flag("out", "tools/_mobile/c2");
const DEVS = (flag("devices", "iphone13-land")).split(",");
mkdirSync(OUT, { recursive: true });

const TEST = "test&debug=1&abilities=all&noassets&quality=performance";
const URL_ = `${BASE}/iso.html?${TEST}&floor=6&level=14&gold=6000&seed=21`;

const SNAP = () => {
  const s = window.__dcc.state, p = s.players[0];
  return {
    pos: { x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3) },
    facing: { x: +p.facing.x.toFixed(3), y: +p.facing.y.toFixed(3) },
    hp: Math.round(p.hp), maxHp: Math.round(p.maxHp),
    cd: JSON.parse(JSON.stringify(p.cd || {})),
    flask: p.flaskCharges, dashCharges: p.dashCharges,
    pings: (s.pings || []).length,
    monstersAlive: s.monsters.filter((m) => m.hp > 0).length,
    monsterHp: s.monsters.reduce((a, m) => a + Math.max(0, m.hp), 0),
    gold: p.gold ?? 0, bag: (p.bag || []).length,
    lockedId: (window.__dcc.touch && window.__dcc.touch.lockedTargetId) ?? null,
    reasons: (window.__dcc.touch && window.__dcc.touch.suspendReasons && window.__dcc.touch.suspendReasons()) ?? null,
    slots: p.abilities.slots, ult: p.abilities.ultimate,
  };
};

async function ready(page) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0;
  }, null, { timeout: 300000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function run(devKey, browser) {
  const spec = DEVICE_SPECS[devKey];
  const ctx = await browser.newContext({ ...devices[spec.pw] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  const rows = [];
  const rec = (name, verdict, detail) => { rows.push({ name, verdict, detail }); console.log(`  [${verdict}] ${name} — ${detail}`); };
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 300000 });
  await ready(page);

  const V = page.viewportSize();
  const snap = () => page.evaluate(SNAP);
  const at = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width) return null; return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.x), t: Math.round(r.y) }; }, sel);
  const route = (x, y) => page.evaluate(([a, b]) => { const t = window.__dcc.touch; return { route: t.route ? t.route(a, b) : null, control: t.controlAt ? t.controlAt(a, b) : null }; }, [x, y]);
  const settle = async (frames = 5) => {
    await page.waitForTimeout(100);
    await page.evaluate((n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), frames).catch(() => {});
  };
  const keepAlive = () => page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing"; }).catch(() => {});
  await page.evaluate(() => {
    clearInterval(window.__keep);
    window.__keep = setInterval(() => { const s = window.__dcc && window.__dcc.state; if (!s) return; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; if (!s.safeRoom) s.status = "playing"; }, 120);
  }).catch(() => {});

  const chip = {};
  for (const k of ["0", "1", "2", "3", "4"]) chip[k] = await at(`#skills .skill[data-i="${k}"]`);
  chip.flask = await at("#flask-chip");
  const zones = await page.evaluate(() => JSON.parse(JSON.stringify(window.__dcc.touch.zones ?? null)));
  rows.push({ name: "zones", verdict: "INFO", detail: JSON.stringify(zones).slice(0, 1200) });

  // ---------- A. AIMED CAST, PER SLOT ----------
  {
    const s0 = await snap();
    const results = [];
    for (const k of ["0", "1", "2", "3", "4"]) {
      await keepAlive();
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const k of Object.keys(p.cd || {})) p.cd[k] = 0; p.dashCharges = 2; });
      const c = chip[k];
      // drag straight up-screen 100px: away from every band, past aimThrow/2
      const a = await snap();
      await touch.down(1, c.x, c.y);
      await settle(1);
      for (let i = 1; i <= 10; i++) { touch.tick(16); await touch.move(1, c.x, c.y - i * 10); await settle(1); }
      const mid = await page.evaluate(() => {
        const r = window.__dcc.renderer, ind = r && r.aimIndicator;
        const cb = document.getElementById("t-cancel");
        return { aim: ind ? { vis: ind.visible, shapes: ind.children.filter((x) => x.visible).map((x) => x.name) } : null, cancelVis: cb ? getComputedStyle(cb).opacity : null };
      });
      await touch.up(1);
      await settle(8);
      const b = await snap();
      const started = Object.keys(b.cd).filter((x) => (b.cd[x] || 0) > (a.cd[x] || 0));
      const dmg = a.monsterHp - b.monsterHp;
      results.push(`slot${k}(${a.slots[+k] ?? a.ult}):fired=${started.join("/") || "NONE"} shapes=${(mid.aim && mid.aim.shapes.join("+")) || "none"}`);
    }
    const fired = results.filter((r) => !r.includes("NONE")).length;
    rec("aim: drag-release fires an aimed cast, per slot", fired >= 4 ? "PASS" : "FAIL", `${fired}/5 slots fired — ${results.join(" · ")}`);
  }
  // smart cast (tap) per slot, for contrast
  {
    const results = [];
    for (const k of ["0", "1", "2", "3", "4"]) {
      await keepAlive();
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const k of Object.keys(p.cd || {})) p.cd[k] = 0; p.dashCharges = 2; });
      const a = await snap();
      await touch.tap(chip[k].x, chip[k].y, 1, 180);
      await settle(8);
      const b = await snap();
      const started = Object.keys(b.cd).filter((x) => (b.cd[x] || 0) > (a.cd[x] || 0));
      results.push(`slot${k}=${started.join("/") || "NONE"}`);
    }
    rec("cast: tap = smart cast, per slot", results.filter((r) => !r.includes("NONE")).length >= 4 ? "PASS" : "FAIL", results.join(" · "));
  }
  // long hold (3 s, no travel) must be byte-identical to a 40 ms tap
  {
    await keepAlive();
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const k of Object.keys(p.cd || {})) p.cd[k] = 0; });
    const a = await snap();
    await touch.down(1, chip["2"].x, chip["2"].y);
    touch.tick(3000);
    await page.waitForTimeout(1400);
    await touch.up(1);
    await settle(8);
    const b = await snap();
    const started = Object.keys(b.cd).filter((x) => (b.cd[x] || 0) > (a.cd[x] || 0));
    rec("aim: 3-second motionless hold still smart-casts", started.length ? "PASS" : "FAIL", `fired ${started.join(",") || "none"}`);
  }

  // ---------- B. CANCEL BAND vs THE MOVEMENT THUMB ----------
  {
    await keepAlive();
    // start an aim with finger 2 so the band is up
    await touch.down(2, chip["2"].x, chip["2"].y);
    for (let i = 1; i <= 8; i++) { touch.tick(16); await touch.move(2, chip["2"].x, chip["2"].y - i * 12); await settle(1); }
    const band = await at("#t-cancel");
    const stickZone = zones && zones.stick ? zones.stick : null;
    let overlap = null;
    if (band && stickZone) {
      const bx1 = band.l, bx2 = band.l + band.w, by1 = band.t, by2 = band.t + band.h;
      const sx1 = stickZone.x, sx2 = stickZone.x + stickZone.w, sy1 = stickZone.y, sy2 = stickZone.y + stickZone.h;
      const ox = Math.max(0, Math.min(bx2, sx2) - Math.max(bx1, sx1));
      const oy = Math.max(0, Math.min(by2, sy2) - Math.max(by1, sy1));
      overlap = { w: Math.round(ox), h: Math.round(oy), pctOfBand: Math.round((ox * oy * 100) / (band.w * band.h)) };
    }
    // now try to WALK with a fresh finger inside that overlap
    let moved = 0, under = "n/a", rt = null;
    if (overlap && overlap.w > 8 && overlap.h > 8) {
      const px = Math.round(Math.max(band.l, stickZone.x) + Math.min(band.w, overlap.w) / 2);
      const py = Math.round(Math.max(band.t, stickZone.y) + overlap.h / 2);
      rt = await route(px, py);
      const a = await snap();
      await touch.down(1, px, py);
      for (let i = 0; i < 12; i++) { touch.tick(16); await touch.move(1, px + 70, py); await settle(2); }
      const b = await snap();
      await touch.up(1);
      moved = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
      under = `${px},${py}`;
    }
    await touch.up(2);
    await settle(6);
    rec("conflict: start walking while the CANCEL band is up", overlap && overlap.w > 8 ? (moved > 0.4 ? "PASS" : "FAIL") : "PASS",
      `band ${band ? `${band.w}x${band.h}@${band.l},${band.t}` : "absent"}; stick zone ${stickZone ? `${stickZone.w}x${stickZone.h}@${stickZone.x},${stickZone.y}` : "unknown"}; overlap ${JSON.stringify(overlap)}; second finger at ${under} routed ${JSON.stringify(rt)} moved ${moved.toFixed(2)} tiles`);
  }

  // ---------- C. AIM PRECISION: 8 directions, frozen origin ----------
  {
    const rowsA = [];
    for (const [dx, dy] of [[1, 0], [0.707, -0.707], [0, -1], [-0.707, -0.707], [-1, 0], [-0.707, 0.707], [0, 1], [0.707, 0.707]]) {
      await keepAlive();
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const k of Object.keys(p.cd || {})) p.cd[k] = 0; });
      const c = chip["2"];
      await touch.down(1, c.x, c.y);
      for (let i = 1; i <= 10; i++) { touch.tick(16); await touch.move(1, c.x + dx * i * 9, c.y + dy * i * 9); await settle(1); }
      const f = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { x: p.facing.x, y: p.facing.y }; });
      await touch.up(1);
      await settle(4);
      const pa = Math.atan2(dy, dx), ma = Math.atan2(f.y, f.x);
      let d = ((ma - pa) * 180) / Math.PI; while (d > 180) d -= 360; while (d < -180) d += 360;
      rowsA.push(Math.round(d));
    }
    const spread = Math.max(...rowsA) - Math.min(...rowsA);
    rec("aim: screen->world rotation is constant across 8 directions", spread <= 12 ? "PASS" : "FAIL", `deltas ${rowsA.join(",")}° spread ${spread}° (a constant means the iso rotation is applied once and cleanly; spread means the mapping distorts by direction)`);
  }

  // ---------- D. TARGET LOCK, on a monster that is actually on screen ----------
  {
    await keepAlive();
    const mon = await page.evaluate(() => {
      const d = window.__dcc, s = d.state, r = d.renderer, p = s.players[0];
      const cam = r.camera;
      const mm = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      const proj = (x, z, y = 0.9) => {
        const cw = mm[3] * x + mm[7] * y + mm[11] * z + mm[15] || 1;
        return { sx: Math.round(((mm[0] * x + mm[4] * y + mm[8] * z + mm[12]) / cw * 0.5 + 0.5) * innerWidth), sy: Math.round((-(mm[1] * x + mm[5] * y + mm[9] * z + mm[13]) / cw * 0.5 + 0.5) * innerHeight) };
      };
      const cands = s.monsters.filter((m) => m.hp > 0).map((m) => ({ id: m.id, dormant: !!m.dormant, hp: m.hp, ...proj(m.pos.x, m.pos.y), d: Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) }))
        .filter((m) => m.sx > 40 && m.sx < innerWidth - 40 && m.sy > 40 && m.sy < innerHeight - 40)
        .sort((a, b) => a.d - b.d);
      return cands[0] ?? null;
    });
    if (!mon) rec("target: tap a monster to lock", "N/A", "no monster projected on screen");
    else {
      const rt = await route(mon.sx, mon.sy);
      const a = await snap();
      await touch.tap(mon.sx, mon.sy, 1, 120);
      await settle(10);
      const b = await snap();
      const lockUi = await at("#t-lock");
      rec("target: tap a monster to lock", b.lockedId != null ? "PASS" : "FAIL",
        `monster ${mon.id} at (${mon.sx},${mon.sy}) dist ${mon.d.toFixed(1)} routed ${JSON.stringify(rt)}; lockedId ${a.lockedId}->${b.lockedId}; #t-lock ${JSON.stringify(lockUi)}`);
      // does the smart cast now respect the lock (vs nearest)?
      if (b.lockedId != null) {
        const which = await page.evaluate(() => {
          const d = window.__dcc, s = d.state, p = s.players[0];
          const locked = s.monsters.find((m) => m.id === d.touch.lockedTargetId);
          const nearest = s.monsters.filter((m) => m.hp > 0).sort((x, y) => Math.hypot(x.pos.x - p.pos.x, x.pos.y - p.pos.y) - Math.hypot(y.pos.x - p.pos.x, y.pos.y - p.pos.y))[0];
          return { lockedIsNearest: locked && nearest && locked.id === nearest.id, lockedHp: locked && locked.hp };
        });
        rec("target: lock is distinguishable from nearest", "INFO", JSON.stringify(which));
      }
    }
  }

  // ---------- E. TWO-FINGER DASH, in the world zone ----------
  {
    await keepAlive();
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.dashCharges = 2; if (p.cd) p.cd.dash = 0; });
    const wz = zones && zones.world ? zones.world : { x: V.width * 0.5, y: V.height * 0.3, w: V.width * 0.3, h: V.height * 0.3 };
    const cx = Math.round(wz.x + wz.w / 2), cy = Math.round(wz.y + wz.h / 2);
    const rt1 = await route(cx - 40, cy), rt2 = await route(cx + 40, cy);
    const a = await snap();
    await touch.down(1, cx - 40, cy);
    touch.tick(50);
    await touch.down(2, cx + 40, cy);
    touch.tick(100);
    await page.waitForTimeout(100);
    await touch.up(1); await touch.up(2);
    await settle(10);
    const b = await snap();
    const used = (a.dashCharges ?? 0) > (b.dashCharges ?? 0) || (b.cd.dash || 0) > (a.cd.dash || 0);
    rec("dodge: two-finger world tap", used ? "PASS" : "FAIL", `points routed ${JSON.stringify(rt1)} / ${JSON.stringify(rt2)}; charges ${a.dashCharges}->${b.dashCharges}, cd.dash ${a.cd.dash ?? 0}->${b.cd.dash ?? 0}`);
  }

  // ---------- F. SUSPENSION: backgrounded with the stick held ----------
  {
    await page.evaluate(() => { const s = window.__dcc.state; for (const m of s.monsters) m.hp = 0; }); // no knockback to confound
    await keepAlive();
    const ox = Math.round(V.width * 0.2), oy = Math.round(V.height * 0.72);
    await touch.down(1, ox, oy);
    for (let i = 0; i < 8; i++) { touch.tick(16); await touch.move(1, ox + 70, oy); await settle(2); }
    const before = await snap();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle(4);
    const mid = await snap();
    await settle(24);
    const after = await snap();
    const drift = Math.hypot(after.pos.x - mid.pos.x, after.pos.y - mid.pos.y);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await touch.up(1);
    await settle(4);
    rec("safety: stick held while the app is backgrounded", drift < 0.08 ? "PASS" : "FAIL", `reasons at hide = ${JSON.stringify(mid.reasons)}; drifted ${drift.toFixed(3)} tiles over 24 frames while hidden`);
  }
  // stuck-pointer reaper: hold the stick motionless for 8 s
  {
    await keepAlive();
    const ox = Math.round(V.width * 0.2), oy = Math.round(V.height * 0.72);
    await touch.down(1, ox, oy);
    for (let i = 0; i < 6; i++) { touch.tick(16); await touch.move(1, ox + 70, oy); await settle(2); }
    const a = await snap();
    await page.waitForTimeout(9000);
    await settle(6);
    const b = await snap();
    const moved = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    await settle(20);
    const c = await snap();
    const after = Math.hypot(c.pos.x - b.pos.x, c.pos.y - b.pos.y);
    await touch.up(1);
    rec("safety: 8 s motionless stick is reaped", after < 0.08 ? "PASS" : "FAIL", `moved ${moved.toFixed(2)} tiles during the 9 s hold, then ${after.toFixed(3)} tiles after the TTL should have fired`);
  }

  // ---------- G. PANELS: close controls + target sizes ----------
  {
    const PANELS = [["inv", "i"], ["sheet", "p"], ["abil", "t"], ["keys", "k"]];
    for (const [id, key] of PANELS) {
      await keepAlive();
      let up = false;
      for (let i = 0; i < 3 && !up; i++) {
        await keepAlive();
        await page.keyboard.press(key);
        await page.waitForTimeout(650);
        up = await page.evaluate((pid) => { const e = document.getElementById(pid); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }, id);
      }
      if (!up) { rec(`panel ${id}: opens`, "FAIL", "never opened"); continue; }
      const g = await page.evaluate((pid) => {
        const p = document.getElementById(pid), r = p.getBoundingClientRect();
        const shown = (e) => { const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0; };
        const inter = [...p.querySelectorAll("button, .tab, [data-act], [data-buy], .itile, .bag-cell, .cell, .row, input, select, .acard")].filter(shown).map((e) => { const b = e.getBoundingClientRect(); return { t: (e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : "") || e.tagName), w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.y) }; });
        const closers = [...p.querySelectorAll(".tp-x, .tp-done, [data-close], .set-close")].filter(shown).map((e) => { const b = e.getBoundingClientRect(); return { cls: e.className, w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; });
        const clipped = [...p.querySelectorAll("*")].map((e) => ({ t: e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : ""), sx: e.scrollWidth - e.clientWidth, sy: e.scrollHeight - e.clientHeight })).filter((n) => n.sx > 4);
        return {
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          overhang: { top: Math.round(Math.max(0, -r.top)), bottom: Math.round(Math.max(0, r.bottom - innerHeight)) },
          nInter: inter.length, small: inter.filter((n) => n.w < 44 || n.h < 44).slice(0, 10),
          off: inter.filter((n) => n.y < 0 || n.y > innerHeight).length,
          closers, clipped: clipped.slice(0, 4), scrollY: p.scrollHeight - p.clientHeight,
        };
      }, id);
      const isOpen = () => page.evaluate((pid) => { const e = document.getElementById(pid); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }, id);
      const tests = [];
      if (g.closers.length) { const c = g.closers[0]; await touch.tap(c.x, c.y, 1, 110); await page.waitForTimeout(600); tests.push(`close(${c.cls} ${c.w}x${c.h})=${!(await isOpen())}`); }
      else tests.push("close=ABSENT");
      if (!(await isOpen())) { await page.keyboard.press(key); await page.waitForTimeout(600); }
      if (await isOpen()) { await touch.tap(Math.round(V.width * 0.5), Math.max(3, g.box.y - 6), 1, 110); await page.waitForTimeout(600); tests.push(`backdrop=${!(await isOpen())}`); }
      if (!(await isOpen())) { await page.keyboard.press(key); await page.waitForTimeout(600); }
      if (await isOpen()) {
        const c = { x: Math.round(g.box.x + g.box.w / 2), y: Math.round(g.box.y + 20) };
        await touch.down(1, c.x, c.y);
        for (let i = 1; i <= 8; i++) { touch.tick(20); await touch.move(1, c.x, c.y + i * 24); await page.waitForTimeout(20); }
        await touch.up(1);
        await page.waitForTimeout(600);
        tests.push(`swipeDown=${!(await isOpen())}`);
      }
      if (await isOpen()) { await page.keyboard.press("Escape"); await page.waitForTimeout(400); }
      rec(`panel ${id}: touch`, g.small.length === 0 && g.off === 0 && g.overhang.bottom === 0 && tests.filter((t) => t.includes("=true")).length >= 2 ? "PASS" : "FAIL",
        `${g.box.w}x${g.box.h} overhang${JSON.stringify(g.overhang)} scrollY ${g.scrollY} · ${g.nInter} interactive, ${g.small.length} under 44px ${JSON.stringify(g.small.slice(0, 5))}, ${g.off} off-screen, h-clipped ${JSON.stringify(g.clipped)} · closes: ${tests.join(" ")}`);
    }
  }

  // ---------- H. SHOP, via a real descent ----------
  {
    await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      p.gold = (p.gold ?? 0) + 6000;
      for (const m of st.monsters) m.hp = 0;
      p.alive = true; p.downedT = 0; p.hp = p.maxHp; st.status = "playing";
      p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
      clearInterval(window.__keep);
      window.__keep = setInterval(() => { const d = window.__dcc; if (!d) return; const q = d.state.players[0]; if (!d.state.safeRoom) { q.hp = q.maxHp; q.alive = true; q.downedT = 0; } }, 200);
    });
    await page.waitForFunction(() => {
      const d = window.__dcc;
      if (!d || d.state.safeRoom) return true;
      d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60);
      return !!d.state.safeRoom;
    }, null, { timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 24; i++) {
      const st = await page.evaluate(() => {
        const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
        return { draft: vis("draft"), shop: vis("saferoom") };
      }).catch(() => ({ draft: false, shop: false }));
      if (st.shop) break;
      if (st.draft) { await page.evaluate(() => { const c = document.querySelector("#draft-cards .reward"); if (c) c.click(); }).catch(() => {}); }
      await page.waitForTimeout(600);
    }
    const open = await page.evaluate(() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
    if (!open) rec("shop: open", "FAIL", "safe room never appeared");
    else {
      const g = await page.evaluate(() => {
        const p = document.getElementById("saferoom"), r = p.getBoundingClientRect();
        const shown = (e) => { const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0; };
        const inter = [...p.querySelectorAll("button, .tab, [data-act], [data-buy], .itile, .bag-cell, .cell, input, select")].filter(shown).map((e) => { const b = e.getBoundingClientRect(); return { t: (e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : "") || e.tagName), w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.y) }; });
        return {
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          overhang: { top: Math.round(Math.max(0, -r.top)), bottom: Math.round(Math.max(0, r.bottom - innerHeight)) },
          nInter: inter.length, small: inter.filter((n) => n.w < 44 || n.h < 44).slice(0, 10), off: inter.filter((n) => n.y < 0 || n.y > innerHeight).slice(0, 6),
          closers: [...p.querySelectorAll(".tp-x, .tp-done, [data-close], .set-close")].filter(shown).map((e) => ({ cls: e.className, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })),
          seg: [...p.querySelectorAll(".tp-seg, .tp-seg *")].filter(shown).map((e) => e.textContent.trim()).slice(0, 6),
        };
      });
      rec("shop: geometry + tap targets", g.small.length === 0 && g.off.length === 0 && g.overhang.bottom === 0 ? "PASS" : "FAIL",
        `${g.box.w}x${g.box.h} overhang ${JSON.stringify(g.overhang)}; ${g.nInter} interactive, ${g.small.length} under 44px ${JSON.stringify(g.small.slice(0, 6))}, ${g.off.length} off-screen ${JSON.stringify(g.off)}; closers ${JSON.stringify(g.closers)}; segmented=${JSON.stringify(g.seg)}`);
      // buy with a finger
      const tile = await page.evaluate(() => {
        const t = [...document.querySelectorAll("#saferoom .itile")].filter((e) => e.getBoundingClientRect().width > 0 && !e.classList.contains("locked") && !e.classList.contains("soldout"))[0];
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
      });
      let detail = "no shelf tile", ok = false;
      if (tile) {
        const a = await snap();
        await touch.tap(tile.x, tile.y, 1, 130);
        await settle(8);
        const buy = await page.evaluate(() => {
          const b = [...document.querySelectorAll("#saferoom [data-buy]")].filter((e) => e.getBoundingClientRect().width > 0)[0];
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), txt: b.textContent.trim(), dis: !!b.disabled };
        });
        if (buy && !buy.dis) {
          await touch.tap(buy.x, buy.y, 1, 130);
          await settle(10);
          const b2 = await snap();
          ok = b2.gold !== a.gold || b2.bag !== a.bag;
          detail = `tile ${tile.w}x${tile.h} -> BUY ${buy.w}x${buy.h} "${buy.txt}"; gold ${a.gold}->${b2.gold} bag ${a.bag}->${b2.bag}`;
        } else detail = `tile ${tile.w}x${tile.h} tapped; BUY = ${JSON.stringify(buy)}`;
      }
      rec("shop: buy with a finger", ok ? "PASS" : "FAIL", detail);
      // SELL ALL confirm?
      const sellAll = await page.evaluate(() => {
        const e = [...document.querySelectorAll("#saferoom button")].find((b) => /sell all/i.test(b.textContent));
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), txt: e.textContent.trim() };
      });
      if (sellAll) {
        const a = await snap();
        await touch.tap(sellAll.x, sellAll.y, 1, 120);
        await settle(8);
        const b = await snap();
        const after = await page.evaluate(() => { const e = [...document.querySelectorAll("#saferoom button")].find((b) => /sell all|confirm|sure/i.test(b.textContent)); return e ? e.textContent.trim() : null; });
        rec("shop: SELL ALL is two-step on touch", b.gold === a.gold ? "PASS" : "FAIL", `${sellAll.w}x${sellAll.h} "${sellAll.txt}" -> gold ${a.gold}->${b.gold}, button now "${after}"`);
      } else rec("shop: SELL ALL is two-step on touch", "N/A", "no SELL ALL button");
    }
  }

  await page.screenshot({ path: `${OUT}/${devKey}-final.png` });
  await ctx.close();
  return { device: devKey, rows };
}

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const all = [];
for (const d of DEVS) {
  console.log(`\n=== ${d} ===`);
  try { all.push(await run(d, browser)); }
  catch (e) { console.log(`  [ERROR] ${d}: ${e.message}`); all.push({ device: d, error: e.message }); }
}
await browser.close();
writeFileSync(`${OUT}/report-${DEVS.join("_")}.json`, JSON.stringify(all, null, 2));
console.log("\nwrote report");
