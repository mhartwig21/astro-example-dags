// CRITIC ROUND 2 — independent acceptance battery. Written by a critic who did
// not write the touch layer and does not reuse its self-checks.
// Everything is REAL CDP touch. Every verdict ends in a number the sim owns.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const OUT = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1] : "tools/_mobile/c2a";

const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  "iphone13promax-land": { pw: "iPhone 13 Pro Max landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: { top: 24, right: 0, bottom: 20, left: 0 } },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: { top: 0, right: 24, bottom: 0, left: 0 } },
};

function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });
  const api = {
    tick(ms) { clock += ms / 1000; return api; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [],
        timestamp: clock,
      });
    },
    async tap(x, y, id = 1, holdMs = 90) {
      await api.down(id, x, y); api.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 60)));
      await api.up(id);
    },
    async drag(x, y, tx, ty, o = {}) {
      const { id = 1, steps = 12, holdMs = 24, release = true } = o;
      await api.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        api.tick(holdMs);
        await api.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (release) await api.up(id);
    },
    live,
  };
  return api;
}

const SNAP = () => {
  const s = window.__dcc.state, p = s.players[0];
  return {
    pos: { x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3) },
    facing: { x: +p.facing.x.toFixed(3), y: +p.facing.y.toFixed(3) },
    hp: Math.round(p.hp), maxHp: Math.round(p.maxHp),
    cd: JSON.parse(JSON.stringify(p.cd || {})),
    flask: p.flaskCharges, dashCharges: p.dashCharges,
    pings: (s.pings || []).length,
    monsterHp: s.monsters.reduce((a, m) => a + Math.max(0, m.hp), 0),
    gold: p.gold ?? 0, bag: (p.inventory || p.bag || []).length,
    locked: (window.__dcc.touch && window.__dcc.touch.lockedTargetId) ?? null,
    clickTarget: (window.__dcc.touch && window.__dcc.touch.clickMoveTarget) ?? null,
    scale: (window.visualViewport && +window.visualViewport.scale.toFixed(3)) ?? 1,
  };
};

const CENTRE = (sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  if (!r.width) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.x), top: Math.round(r.y) };
};

async function ready(page) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function run(dname) {
  const spec = SPECS[dname];
  const desc = devices[spec.pw];
  const ctx = await browser.newContext({ ...desc, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const touch = touchDriver(client);
  const out = [];
  const rec = (name, verdict, detail) => { out.push({ name, verdict, detail }); console.log(`  [${verdict}] ${name} — ${detail}`); };

  const url = `${BASE}/iso.html?test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await ready(page);
  const V = page.viewportSize();
  const snap = () => page.evaluate(SNAP);
  const at = (sel) => page.evaluate(CENTRE, sel);
  const hitAt = (x, y) => page.evaluate(([px, py]) => {
    const e = document.elementFromPoint(px, py);
    return e ? `${e.tagName}#${e.id || ""}.${typeof e.className === "string" ? e.className.split(" ")[0] : ""}` : "nothing";
  }, [x, y]);
  const settle = async (n = 6) => {
    await page.waitForTimeout(180);
    await page.evaluate((k) => new Promise((res) => { let i = 0; const t = () => (++i >= k ? res(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {});
  };

  // ---- A0. FIRST CONTACT: what does a player see before touching anything?
  {
    const ghost = await page.evaluate(() => {
      const g = document.getElementById("t-ghost");
      if (!g) return { present: false };
      const cs = getComputedStyle(g);
      const r = g.getBoundingClientRect();
      return { present: true, display: cs.display, opacity: cs.opacity, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    });
    rec("first contact: resting stick affordance", ghost.present && ghost.display !== "none" && +ghost.opacity > 0.05 ? "PASS" : "FAIL", JSON.stringify(ghost));
  }

  // ---- A1. TAP TARGETS: every touch control, measured
  {
    const ctrls = await page.evaluate(() => {
      const ids = ["#skills .skill[data-i='0']", "#skills .skill[data-i='1']", "#skills .skill[data-i='2']",
        "#skills .skill[data-i='3']", "#skills .skill[data-i='4']", "#flask-chip", "#t-stairs", "#t-lock", "#t-map",
        "#tb-system", "#tb-crawler"];
      const o = {};
      for (const s of ids) {
        const e = document.querySelector(s);
        if (!e) { o[s] = null; continue; }
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        o[s] = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), hidden: cs.display === "none" || +cs.opacity === 0 };
      }
      return o;
    });
    const small = Object.entries(ctrls).filter(([, r]) => r && !r.hidden && (r.w < 44 || r.h < 44)).map(([k, r]) => `${k} ${r.w}x${r.h}`);
    const hidden = Object.entries(ctrls).filter(([, r]) => r && r.hidden).map(([k]) => k);
    const missing = Object.entries(ctrls).filter(([, r]) => !r).map(([k]) => k);
    rec("tap targets >= 44px", small.length === 0 ? "PASS" : "FAIL",
      `under 44: ${small.join(" · ") || "none"}; hidden right now: ${hidden.join(",") || "none"}; absent: ${missing.join(",") || "none"}`);
    out.ctrls = ctrls;
  }

  // immortality watchdog — a dead crawler no-ops every later check
  await page.evaluate(() => {
    clearInterval(window.__c2keep);
    window.__c2keep = setInterval(() => {
      const s = window.__dcc && window.__dcc.state; if (!s) return;
      const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; s.status = "playing";
    }, 120);
  }).catch(() => {});

  // stage a pack around the crawler
  await page.evaluate(() => {
    const st = window.__dcc.state, p = st.players[0];
    const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
    if (!live.length) return;
    live.sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
      .slice(0, 6).forEach((m, k) => {
        const a = (k / 6) * Math.PI * 2 + 2.6;
        m.pos.x = p.pos.x + Math.cos(a) * (2.0 + (k % 2) * 0.6);
        m.pos.y = p.pos.y + Math.sin(a) * (2.0 + (k % 2) * 0.6);
      });
  });
  await settle(10);

  const chip = {};
  for (const k of ["0", "1", "2", "3", "4"]) chip[k] = await at(`#skills .skill[data-i="${k}"]`);
  chip.flask = await at("#flask-chip");

  // A clear patch of the stick zone that no chip or card claims.
  const clear = await page.evaluate(([w, h]) => {
    const d = window.__dcc;
    for (const fy of [0.86, 0.78, 0.66, 0.92]) {
      for (const fx of [0.30, 0.22, 0.38, 0.14]) {
        const x = Math.round(w * fx), y = Math.round(h * fy);
        if (d.touch.controlAt(x, y)) continue;
        if (d.touch.route(x, y).zone !== "stick") continue;
        return { x, y };
      }
    }
    return { x: Math.round(w * 0.3), y: Math.round(h * 0.86) };
  }, [V.width, V.height]);

  // ---- B1. WALK: does the crawler go where the thumb points (screen space)?
  {
    const a = await snap();
    await touch.down(1, clear.x, clear.y);
    await settle(3);
    for (let i = 0; i < 12; i++) { await touch.move(1, clear.x + 75, clear.y); await settle(2); }
    const b = await snap();
    await touch.up(1);
    await settle(3);
    // screen-space direction of the movement, via the renderer's own projection
    const dirOk = await page.evaluate(([ax, ay, bx, by]) => {
      const r = window.__dcc.renderer;
      const q0 = r.worldToScreen(ax, 0, ay); const p0 = { x: q0.x, y: q0.y };
      const q1 = r.worldToScreen(bx, 0, by); const p1 = { x: q1.x, y: q1.y };
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const m = Math.hypot(dx, dy);
      return { dx: Math.round(dx), dy: Math.round(dy), cos: m > 1 ? +(dx / m).toFixed(2) : null };
    }, [a.pos.x, a.pos.y, b.pos.x, b.pos.y]);
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    rec("walk: thumb right -> crawler moves right on screen",
      d > 0.4 && dirOk.cos !== null && dirOk.cos > 0.82 ? "PASS" : d > 0.4 ? "WEAK" : "FAIL",
      `${d.toFixed(2)} tiles from (${clear.x},${clear.y}) over ${await hitAt(clear.x, clear.y)}; screen delta ${dirOk.dx},${dirOk.dy} cos=${dirOk.cos}`);
  }

  // ---- B2. WALK with a transient System card in the thumb zone
  {
    await page.evaluate(() => {
      const t = document.getElementById("tutorial");
      if (!t) return;
      t.style.display = "block";
      t.innerHTML = '<div class="tut-card"><div>SYSTEM: a courtesy explanation that eats your thumb.</div><button class="tut-dismiss">GOT IT</button></div>';
    });
    await settle(3);
    const card = await at("#tutorial");
    const a = await snap();
    const px = card ? card.x : clear.x, py = card ? card.y : clear.y;
    const under = await hitAt(px, py);
    await touch.down(1, px, py);
    await settle(3);
    for (let i = 0; i < 12; i++) { await touch.move(1, px + 70, py); await settle(2); }
    const b = await snap();
    await touch.up(1);
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    rec("walk: thumb lands on a System card", d > 0.4 ? "PASS" : "FAIL",
      `card at (${px},${py}) hit=${under}; moved ${d.toFixed(2)} tiles`);
  }

  // ---- C1. AIM: press a chip, drag, and photograph the telegraph
  {
    const a = await snap();
    const c = chip["2"];
    await touch.down(1, c.x, c.y);
    await settle(3);
    const pressFrame = await page.evaluate(() => {
      const d = window.__dcc, r = d.renderer, ind = r && r.aimIndicator;
      return { indicatorOnPress: !!(ind && ind.visible && ind.children.some((k) => k.visible)) };
    });
    for (let i = 1; i <= 10; i++) { await touch.move(1, c.x - i * 11, c.y - i * 5); await settle(1); }
    const aim = await page.evaluate(() => {
      const d = window.__dcc, r = d.renderer, ind = r && r.aimIndicator;
      const cancel = document.getElementById("t-cancel") || document.querySelector("[data-tcancel], .t-cancel");
      const band = document.getElementById("t-cancelband");
      const vis = (e) => { if (!e) return null; const cs = getComputedStyle(e); const rr = e.getBoundingClientRect(); return { display: cs.display, opacity: cs.opacity, w: Math.round(rr.width), h: Math.round(rr.height), x: Math.round(rr.x + rr.width / 2), y: Math.round(rr.y + rr.height / 2) }; };
      let shape = null, mat = null, n = 0;
      if (ind) {
        for (const ch of ind.children) if (ch.visible) { shape = ch.name || ch.type; n++; }
        ind.traverse((o) => { if (!mat && o.material) mat = { color: "#" + o.material.color.getHexString(), opacity: o.material.opacity }; });
      }
      return {
        aimingSlot: d.touch ? undefined : undefined,
        indicator: !!ind && ind.visible, visibleChildren: n, shape, mat,
        cancelRing: vis(cancel), cancelBand: vis(band),
        cancelMode: d.touch.zones.cancelMode,
        aimThrow: d.touch.zones.aimThrow, cancelRadius: d.touch.zones.cancelRadius,
      };
    });
    await touch.up(1);
    await settle(6);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    rec("aim: drag off chip -> aimed cast", started.length ? "PASS" : "FAIL",
      `fired ${started.join(",") || "none"}; indicator on press=${pressFrame.indicatorOnPress}; ` +
      `during drag: indicator=${aim.indicator} children=${aim.visibleChildren} shape=${aim.shape} mat=${JSON.stringify(aim.mat)}; ` +
      `cancelMode=${aim.cancelMode} ring=${JSON.stringify(aim.cancelRing)} band=${JSON.stringify(aim.cancelBand)} ` +
      `aimThrow=${aim.aimThrow} cancelRadius=${aim.cancelRadius}`);
    out.aim = aim;
  }

  // ---- C2. CANCEL by returning to origin
  {
    const a = await snap();
    const c = chip["3"];
    await touch.down(1, c.x, c.y);
    await settle(2);
    for (let i = 1; i <= 8; i++) { await touch.move(1, c.x - i * 14, c.y - i * 4); await settle(1); }
    const mid = await page.evaluate(() => {
      const e = document.getElementById("t-cancel");
      if (!e) return null;
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      return { display: cs.display, opacity: cs.opacity, w: Math.round(r.width), h: Math.round(r.height) };
    });
    for (let i = 8; i >= 0; i--) { await touch.move(1, c.x - i * 14, c.y - i * 4); await settle(1); }
    await touch.up(1);
    await settle(6);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    rec("cancel: drag out and home", started.length === 0 ? "PASS" : "FAIL",
      `${started.length ? "LEAKED " + started.join(",") : "no cooldown"}; cancel affordance while aiming = ${JSON.stringify(mid)}`);
  }

  // ---- C3. CANCEL by the band (only meaningful where a band ships)
  {
    const z = await page.evaluate(() => ({ mode: window.__dcc.touch.zones.cancelMode, band: window.__dcc.touch.zones.cancelBand }));
    if (z.mode !== "band" || !z.band) rec("cancel: the labelled band", "N/A", `cancelMode=${z.mode} (no band on this posture)`);
    else {
      const a = await snap();
      const c = chip["3"];
      const bx = Math.round(z.band.x + z.band.w / 2), by = Math.round(z.band.y + z.band.h / 2);
      await touch.down(1, c.x, c.y);
      await settle(2);
      const steps = 14;
      for (let i = 1; i <= steps; i++) { await touch.move(1, c.x + ((bx - c.x) * i) / steps, c.y + ((by - c.y) * i) / steps); await settle(1); }
      await touch.up(1);
      await settle(6);
      const b = await snap();
      const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
      const drag = Math.round(Math.hypot(bx - c.x, by - c.y));
      rec("cancel: drag into the band", started.length === 0 ? "PASS" : "FAIL",
        `band ${z.band.w}x${z.band.h} at (${z.band.x},${z.band.y}); ${drag}px cross-screen drag; ${started.length ? "LEAKED " + started.join(",") : "no cooldown"}`);
    }
  }

  // ---- D1. CAST WHILE MOVING (two real fingers, movement measured DURING aim)
  {
    const dirs = [[75, 0], [-75, 0], [0, 70], [0, -70]];
    let best = 0, detail = "";
    for (const [dx, dy] of dirs) {
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; });
      await touch.down(1, clear.x, clear.y);
      await settle(2);
      for (let i = 0; i < 6; i++) { await touch.move(1, clear.x + dx, clear.y + dy); await settle(2); }
      const a = await snap();
      const c = chip["1"];
      await touch.down(2, c.x, c.y);
      await settle(2);
      for (let i = 1; i <= 8; i++) {
        await touch.move(2, c.x - i * 12, c.y - i * 5);
        await touch.move(1, clear.x + dx, clear.y + dy);
        await settle(2);
      }
      const mid = await snap();
      await touch.up(2);
      await settle(4);
      const b = await snap();
      await touch.up(1);
      await settle(3);
      const during = Math.hypot(mid.pos.x - a.pos.x, mid.pos.y - a.pos.y);
      const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
      if (during > best) { best = during; detail = `dir(${dx},${dy}) moved ${during.toFixed(2)} tiles DURING the aim; cast ${started.join(",") || "none"}`; }
      if (during > 0.5 && started.length) break;
    }
    rec("cast while moving: two fingers", best > 0.5 ? "PASS" : "FAIL", detail || "no direction produced movement");
  }

  // ---- E1. TARGET SELECTION: tap a monster
  {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; });
    const target = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, r = d.renderer;
      let best = null;
      for (const m of st.monsters) {
        if (m.hp <= 0 || m.dormant) continue;
        const p = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
        if (!p.visible) continue;
        if (p.x < 8 || p.y < 8 || p.x > innerWidth - 8 || p.y > innerHeight - 8) continue;
        if (d.touch.controlAt(Math.round(p.x), Math.round(p.y))) continue;
        if (d.touch.route(Math.round(p.x), Math.round(p.y)).zone !== "world") continue;
        if (!best || m.hp > best.hp) best = { id: m.id, hp: m.hp, x: Math.round(p.x), y: Math.round(p.y) };
      }
      return best;
    });
    if (!target) rec("target: tap a monster to lock", "N/A", "no monster projects into a tappable world-zone point");
    else {
      const a = await snap();
      await touch.tap(target.x, target.y, 1, 110);
      await settle(8);
      const b = await snap();
      const ind = await page.evaluate(() => {
        const r = window.__dcc.renderer;
        const k = Object.keys(r).filter((n) => /lock|target|reticle|marker/i.test(n));
        const o = {};
        for (const n of k) { const v = r[n]; o[n] = v && typeof v === "object" && "visible" in v ? v.visible : typeof v; }
        return o;
      });
      rec("target: tap a monster to lock", b.locked === target.id ? "PASS" : "FAIL",
        `tapped mob ${target.id} at (${target.x},${target.y}) hit=${await hitAt(target.x, target.y)}; locked ${a.locked}->${b.locked}; ` +
        `pack hp ${a.monsterHp}->${b.monsterHp}; lock visuals ${JSON.stringify(ind)}`);
      out.lockTarget = target;
    }
  }

  // ---- E2. does the LOCK actually steer the smart cast?
  {
    const res = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      const lock = d.touch.lockedTargetId;
      if (lock == null) return { skip: "no lock held" };
      const t = st.monsters.find((m) => m.id === lock);
      if (!t) return { skip: "locked mob gone" };
      const dl = Math.hypot(t.pos.x - p.pos.x, t.pos.y - p.pos.y);
      const nearer = st.monsters.filter((m) => m.hp > 0 && !m.dormant && m.id !== lock)
        .map((m) => Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y)).sort((a, b) => a - b)[0];
      return { lock, distLocked: +dl.toFixed(2), distNearest: nearer ? +nearer.toFixed(2) : null };
    });
    rec("target: lock outranks nearest", res.skip ? "N/A" : (res.distNearest !== null && res.distNearest < res.distLocked ? "TESTABLE" : "UNTESTABLE"),
      JSON.stringify(res));
  }

  // ---- E3. TAP TO MOVE on empty ground
  {
    const g = await page.evaluate(() => {
      const d = window.__dcc;
      for (let ty = 0.5; ty < 0.9; ty += 0.06) {
        for (let tx = 0.5; tx < 0.95; tx += 0.06) {
          const x = Math.round(innerWidth * tx), y = Math.round(innerHeight * ty);
          if (d.touch.controlAt(x, y)) continue;
          if (d.touch.route(x, y).zone !== "world") continue;
          const gr = d.renderer.screenToGround(x, y);
          if (!gr) continue;
          const near = d.state.monsters.some((m) => m.hp > 0 && Math.hypot(m.pos.x - gr.x, m.pos.y - gr.y) < 1.6);
          if (near) continue;
          return { x, y, gx: +gr.x.toFixed(2), gy: +gr.y.toFixed(2) };
        }
      }
      return null;
    });
    if (!g) rec("tap to move: empty ground", "N/A", "no empty world point found");
    else {
      const a = await snap();
      await touch.tap(g.x, g.y, 1, 120);
      await settle(3);
      const t0 = await snap();
      for (let i = 0; i < 10; i++) await settle(6);
      const b = await snap();
      const moved = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
      const lw = await page.evaluate(() => ({ tap: window.__dcc.touch.lastWorldTap, pref: window.__dcc.touch.prefs.tapToMove, locked: window.__dcc.touch.lockedTargetId }));
      rec("tap to move: empty ground", moved > 0.4 ? "PASS" : "FAIL",
        `tapped (${g.x},${g.y}) -> ground (${g.gx},${g.gy}); clickMoveTarget=${JSON.stringify(t0.clickTarget)}; walked ${moved.toFixed(2)} tiles; lastWorldTap=${JSON.stringify(lw)}`);
    }
  }

  // ---- F1. DODGE: flick the stick
  {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.dashCharges = p.maxDashCharges ?? p.dashCharges; });
    const a = await snap();
    await touch.down(1, clear.x, clear.y);
    await settle(2);
    // a genuine flick: two consecutive fast samples
    for (let i = 1; i <= 4; i++) {
      touch.tick(16);
      await touch.move(1, clear.x + i * 34, clear.y);
      await new Promise((r) => setTimeout(r, 16));
    }
    await settle(4);
    const b = await snap();
    await touch.up(1);
    await settle(4);
    const c = await snap();
    rec("dodge: flick the stick", (c.dashCharges ?? 0) < (a.dashCharges ?? 0) || (c.cd.dash || 0) > (a.cd.dash || 0) ? "PASS" : "FAIL",
      `dashCharges ${a.dashCharges}->${c.dashCharges}; cd.dash ${a.cd.dash ?? 0}->${c.cd.dash ?? 0}`);
  }

  // ---- F2. DODGE: two-finger world tap
  {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.dashCharges = p.maxDashCharges ?? 2; });
    const w = await page.evaluate(() => {
      const d = window.__dcc;
      const pts = [];
      for (let ty = 0.45; ty < 0.9 && pts.length < 2; ty += 0.07) {
        for (let tx = 0.5; tx < 0.95 && pts.length < 2; tx += 0.07) {
          const x = Math.round(innerWidth * tx), y = Math.round(innerHeight * ty);
          if (d.touch.controlAt(x, y)) continue;
          if (d.touch.route(x, y).zone !== "world") continue;
          pts.push({ x, y });
        }
      }
      return pts;
    });
    if (w.length < 2) rec("dodge: two-finger tap", "N/A", "no two clear world points");
    else {
      const a = await snap();
      await touch.down(1, w[0].x, w[0].y);
      touch.tick(40);
      await touch.down(2, w[1].x, w[1].y);
      touch.tick(80);
      await new Promise((r) => setTimeout(r, 80));
      await touch.up(1);
      await touch.up(2);
      await settle(8);
      const b = await snap();
      rec("dodge: two-finger tap", (b.dashCharges ?? 0) < (a.dashCharges ?? 0) || (b.cd.dash || 0) > (a.cd.dash || 0) ? "PASS" : "FAIL",
        `points ${JSON.stringify(w)}; dashCharges ${a.dashCharges}->${b.dashCharges}; cd.dash ${a.cd.dash ?? 0}->${b.cd.dash ?? 0}`);
    }
  }

  // ---- F3. DODGE UNDER PRESSURE: flick while a chip is already down
  {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.dashCharges = p.maxDashCharges ?? 2; });
    const a = await snap();
    const c = chip["2"];
    await touch.down(2, c.x, c.y);
    await settle(2);
    for (let i = 1; i <= 5; i++) { await touch.move(2, c.x - i * 12, c.y - i * 5); await settle(1); }
    await touch.down(1, clear.x, clear.y);
    await settle(2);
    for (let i = 1; i <= 4; i++) { touch.tick(16); await touch.move(1, clear.x + i * 34, clear.y); await new Promise((r) => setTimeout(r, 16)); }
    await settle(4);
    const mid = await snap();
    await touch.up(1);
    await touch.up(2);
    await settle(6);
    const b = await snap();
    rec("dodge while aiming (chip down + flick)",
      (mid.dashCharges ?? 0) < (a.dashCharges ?? 0) || (mid.cd.dash || 0) > (a.cd.dash || 0) ? "PASS" : "FAIL",
      `dashCharges ${a.dashCharges}->${mid.dashCharges}; cd.dash ${a.cd.dash ?? 0}->${mid.cd.dash ?? 0}`);
  }

  // ---- G. POTION
  {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = Math.max(1, Math.round(p.maxHp * 0.25)); });
    await page.evaluate(() => { clearInterval(window.__c2keep); });
    const a = await snap();
    await touch.tap(chip.flask.x, chip.flask.y, 1, 110);
    await settle(10);
    const b = await snap();
    rec("potion: tap the flask chip", b.hp > a.hp ? "PASS" : "FAIL", `hp ${a.hp}->${b.hp}, charges ${a.flask}->${b.flask}`);
    await page.evaluate(() => {
      window.__c2keep = setInterval(() => {
        const s = window.__dcc && window.__dcc.state; if (!s) return;
        const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; s.status = "playing";
      }, 120);
    });
  }

  // ---- H. LOOT: kill something at the crawler's feet and pick the drop up
  {
    const before = await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      const m = st.monsters.find((q) => q.hp > 0 && !q.dormant);
      if (m) { m.pos.x = p.pos.x + 0.8; m.pos.y = p.pos.y + 0.4; m.hp = 1; }
      return { loot: (st.loot || []).length, bag: (p.inventory || []).length, staged: !!m };
    });
    await touch.down(1, chip["0"].x, chip["0"].y);
    await page.waitForTimeout(2500);
    await touch.up(1);
    await settle(12);
    const mid = await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      const near = (st.loot || []).map((d) => ({ k: d.kind, dx: +(d.pos.x - p.pos.x).toFixed(2), dy: +(d.pos.y - p.pos.y).toFixed(2) }));
      return { loot: (st.loot || []).length, near, bag: (p.inventory || []).length };
    });
    // walk on to it with the STICK, not a teleport: pickup is a movement verb
    let after = mid;
    if (mid.near.length) {
      const d0 = mid.near[0];
      const sc = await page.evaluate(([dx, dy]) => {
        const st = window.__dcc.state, p = st.players[0], r = window.__dcc.renderer;
        const a = r.worldToScreen(p.pos.x, 0, p.pos.y); const A = { x: a.x, y: a.y };
        const b = r.worldToScreen(p.pos.x + dx, 0, p.pos.y + dy); const B = { x: b.x, y: b.y };
        const m = Math.hypot(B.x - A.x, B.y - A.y) || 1;
        return { ux: (B.x - A.x) / m, uy: (B.y - A.y) / m };
      }, [d0.dx, d0.dy]);
      await touch.down(1, clear.x, clear.y);
      await settle(2);
      for (let i = 0; i < 26; i++) { await touch.move(1, clear.x + sc.ux * 70, clear.y + sc.uy * 70); await settle(2); }
      await touch.up(1);
      await settle(8);
      after = await page.evaluate(() => {
        const st = window.__dcc.state, p = st.players[0];
        return { loot: (st.loot || []).length, bag: (p.inventory || []).length, near: [] };
      });
    }
    const strip = await page.evaluate(() => {
      const e = document.getElementById("pickstrip");
      if (!e) return null;
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      return { display: cs.display, opacity: cs.opacity, text: (e.textContent || "").trim().slice(0, 70), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const gotIt = after.bag > before.bag || after.loot < mid.loot || (strip && strip.display !== "none" && +strip.opacity > 0.05);
    rec("loot: kill -> drop -> walk over it", mid.loot > before.loot ? (gotIt ? "PASS" : "FAIL") : "N/A",
      `loot on floor ${before.loot}->${mid.loot}->${after.loot}; bag ${before.bag}->${after.bag}; nearest ${JSON.stringify(mid.near.slice(0, 2))}; pickstrip=${JSON.stringify(strip)}`);
  }

  // ---- I. INTERACT: the context chip
  {
    const ctx2 = await page.evaluate(() => {
      const e = document.getElementById("t-stairs");
      if (!e) return null;
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      return { display: cs.display, opacity: cs.opacity, text: (e.textContent || "").trim(), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    // teleport onto the stairs so the chip has something to mean
    await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      for (const m of st.monsters) m.hp = 0;
      p.pos.x = st.map.stairs.x; p.pos.y = st.map.stairs.y;
    });
    await settle(10);
    const ctx3 = await page.evaluate(() => {
      const e = document.getElementById("t-stairs");
      if (!e) return null;
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      return { display: cs.display, opacity: cs.opacity, text: (e.textContent || "").trim(), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (!ctx3 || ctx3.display === "none") rec("interact: the context chip on the stairs", "FAIL", `chip off stairs=${JSON.stringify(ctx2)}; chip ON stairs=${JSON.stringify(ctx3)}`);
    else {
      await page.evaluate(() => { clearInterval(window.__c2keep); });
      await touch.tap(ctx3.x, ctx3.y, 1, 110);
      await settle(20);
      const sr = await page.evaluate(() => {
        const s = window.__dcc.state;
        const e = document.getElementById("saferoom");
        const cs = e && getComputedStyle(e);
        return { safeRoom: !!s.safeRoom, floor: s.floor, panel: !!(e && cs.display !== "none" && e.getBoundingClientRect().width > 0) };
      });
      rec("interact: the context chip on the stairs", sr.safeRoom || sr.panel ? "PASS" : "FAIL",
        `chip ${ctx3.w}x${ctx3.h} "${ctx3.text}" (off-stairs it was ${ctx2 ? ctx2.display : "absent"}); safeRoom=${sr.safeRoom} panel=${sr.panel} floor=${sr.floor}`);
    }
  }

  // ---- L1. SAFE AREAS
  {
    const intr = await page.evaluate((safe) => {
      const ids = ["minimap-frame", "cockpit", "hud-tl", "hud-tr", "xpbar", "toasts", "tutorial", "banner", "skills", "t-stairs", "pickstrip", "show"];
      const bad = [];
      for (const id of ids) {
        const e = document.getElementById(id);
        if (!e) continue;
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.left < safe.left) bad.push(`${id} left ${Math.round(r.left)}<${safe.left}`);
        if (innerWidth - r.right < safe.right) bad.push(`${id} right ${Math.round(innerWidth - r.right)}<${safe.right}`);
        if (r.top < safe.top) bad.push(`${id} top ${Math.round(r.top)}<${safe.top}`);
        if (innerHeight - r.bottom < safe.bottom) bad.push(`${id} bottom ${Math.round(innerHeight - r.bottom)}<${safe.bottom}`);
      }
      return bad;
    }, spec.safe);
    rec("safe areas: HUD clears the hardware insets", intr.length === 0 ? "PASS" : "FAIL",
      intr.length ? intr.join(" · ") : "no intrusions");
  }

  // ---- L2. HUD OCCLUSION of the world
  {
    await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      const pool = st.monsters.slice(0, 6);
      pool.forEach((m, k) => {
        m.hp = m.maxHp || 100; m.dormant = false;
        const a = (k / pool.length) * Math.PI * 2 + 0.4;
        m.pos.x = p.pos.x + Math.cos(a) * (2.4 + (k % 2) * 0.8);
        m.pos.y = p.pos.y + Math.sin(a) * (2.4 + (k % 2) * 0.8);
      });
    });
    await settle(10);
    const occ = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, r = d.renderer;
      const hudIds = ["cockpit", "hud-tl", "hud-tr", "skills", "minimap-frame", "banner", "show", "xpbar", "bossbar", "toasts"];
      const rects = hudIds.map((id) => {
        const e = document.getElementById(id);
        if (!e) return null;
        const cs = getComputedStyle(e);
        if (cs.display === "none" || +cs.opacity === 0) return null;
        const b = e.getBoundingClientRect();
        return b.width && b.height ? b : null;
      }).filter(Boolean);
      const area = rects.reduce((a, b) => a + b.width * b.height, 0);
      let on = 0, under = 0;
      for (const m of st.monsters) {
        if (m.hp <= 0 || m.dormant) continue;
        const p = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
        if (!p.visible || p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight) continue;
        on++;
        if (rects.some((q) => p.x >= q.left && p.x <= q.right && p.y >= q.top && p.y <= q.bottom)) under++;
      }
      return { on, under, hudFrac: +(area / (innerWidth * innerHeight)).toFixed(3) };
    });
    rec("world zone: HUD occlusion", occ.hudFrac < 0.28 ? "PASS" : "FAIL",
      `HUD covers ${(occ.hudFrac * 100).toFixed(1)}% of the viewport; ${occ.under}/${occ.on} on-screen monsters sit under it`);
  }

  // ---- L3. MODAL MID-AIM
  {
    await page.evaluate(() => {
      window.__c2keep = setInterval(() => {
        const s = window.__dcc && window.__dcc.state; if (!s) return;
        const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; s.status = "playing";
      }, 120);
    });
    await settle(6);
    const a = await snap();
    const c = chip["1"];
    await touch.down(1, c.x, c.y);
    await settle(2);
    for (let i = 1; i <= 8; i++) { await touch.move(1, c.x - i * 12, c.y - i * 5); await settle(1); }
    await page.keyboard.press("i");
    await settle(8);
    const openNow = await page.evaluate(() => document.body.classList.contains("modal"));
    await touch.up(1);
    await settle(8);
    const b = await snap();
    await page.keyboard.press("Escape");
    await settle(10);
    const cc = await snap();
    const s1 = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    const s2 = Object.keys(cc.cd).filter((k) => (cc.cd[k] || 0) > (a.cd[k] || 0));
    rec("modal opens mid-aim -> no queued detonation", s2.length === 0 ? "PASS" : "FAIL",
      `body.modal=${openNow}; casts while up: ${s1.join(",") || "none"}; casts after close: ${s2.join(",") || "none"}`);
  }

  // ---- L4. pinch/zoom/scroll hygiene
  {
    const s = await snap();
    const sel = await page.evaluate(() => String(getSelection() || "").length);
    rec("no browser gestures", s.scale === 1 && sel === 0 ? "PASS" : "FAIL", `visualViewport.scale=${s.scale}, selected chars=${sel}`);
  }

  rec("page errors", errs.length === 0 ? "PASS" : "FAIL", errs.slice(0, 3).join(" | ") || "none");

  await page.screenshot({ path: join(OUT, `${dname}-combat.png`) }).catch(() => {});
  await ctx.close();
  return { device: dname, viewport: V, checks: out, ctrls: out.ctrls, aim: out.aim, errs };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const devs = (process.argv.includes("--devices") ? process.argv[process.argv.indexOf("--devices") + 1] : Object.keys(SPECS).join(",")).split(",");
const report = [];
for (const d of devs) {
  console.log("== " + d);
  try { report.push(await run(d)); }
  catch (e) { console.error("FAILED", d, e.message); report.push({ device: d, error: e.message }); }
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log("-> " + join(OUT, "report.json"));
await browser.close();
