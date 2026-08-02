// CRITIC ROUND 1 — an independent acceptance battery.
// Not the author's --drive battery. Real touch only (CDP dispatchTouchEvent).
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { touchDriver, DEVICE_SPECS } from "../mobileshot.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const BASE = flag("base", "http://localhost:5420");
const OUT = flag("out", "tools/_mobile/c1");
const DEVS = (flag("devices", "iphone13-land,iphone13promax-land,ipadpro11-land,pixel5-land")).split(",");
mkdirSync(OUT, { recursive: true });

const URL_ = `${BASE}/iso.html?test&debug=1&floor=9&level=12&abilities=all&gold=900&seed=42&eagerassets&quality=performance`;

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
    equipped: JSON.stringify(p.equipped ?? {}).length,
    scale: (window.visualViewport && +window.visualViewport.scale.toFixed(3)) ?? 1,
    stickShown: (() => { const e = document.getElementById("t-stick2"); return !!e && getComputedStyle(e).opacity !== "0"; })(),
    ghostShown: (() => { const e = document.getElementById("t-ghost"); return !!e && getComputedStyle(e).opacity !== "0"; })(),
    cancelShown: (() => { const e = document.getElementById("t-cancel"); return !!e && getComputedStyle(e).display !== "none" && getComputedStyle(e).opacity !== "0"; })(),
    lockedId: (window.__dcc.touch && window.__dcc.touch.lockedTargetId) ?? null,
    vibes: window.__vibes ? window.__vibes.length : -1,
    aim: (() => {
      const r = window.__dcc.renderer, ind = r && r.aimIndicator;
      if (!ind) return null;
      return { visible: !!ind.visible, shapes: ind.children.filter((c) => c.visible).map((c) => c.name) };
    })(),
  };
};
const CENTRE = (sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  if (!r.width) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.x), t: Math.round(r.y) };
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
  await page.waitForTimeout(1500);
}

async function run(devKey, browser) {
  const spec = DEVICE_SPECS[devKey];
  const ctx = await browser.newContext({ ...devices[spec.pw] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
  const touch = touchDriver(client);
  const rows = [];
  const rec = (name, verdict, detail) => { rows.push({ name, verdict, detail }); console.log(`  [${verdict}] ${name} — ${detail}`); };
  page.on("pageerror", (e) => rec("console: pageerror", "FAIL", String(e).slice(0, 200)));

  await page.addInitScript(() => {
    window.__vibes = [];
    const orig = navigator.vibrate && navigator.vibrate.bind(navigator);
    try { Object.defineProperty(navigator, "vibrate", { value: (p) => { window.__vibes.push({ p, t: performance.now() }); return orig ? orig(p) : true; }, configurable: true }); } catch (e) {}
    // instrument same-frame acknowledgement: record class mutations on chips
    window.__ack = [];
  });
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 300000 });
  await ready(page);

  const V = page.viewportSize();
  const snap = () => page.evaluate(SNAP);
  const at = (sel) => page.evaluate(CENTRE, sel);
  const hitAt = (x, y) => page.evaluate(([px, py]) => {
    const e = document.elementFromPoint(px, py);
    return e ? `${e.tagName}#${e.id || ""}.${typeof e.className === "string" ? e.className.split(" ")[0] : ""}` : "nothing";
  }, [x, y]);
  const settle = async (frames = 5) => {
    await page.waitForTimeout(120);
    await page.evaluate((n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), frames).catch(() => {});
  };
  const keepAlive = () => page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing";
  }).catch(() => {});
  await page.evaluate(() => {
    clearInterval(window.__keep);
    window.__keep = setInterval(() => {
      const s = window.__dcc && window.__dcc.state; if (!s) return;
      const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; s.status = "playing";
    }, 120);
  }).catch(() => {});

  // ---------- LAYOUT PROBE ----------
  const layout = await page.evaluate((safe) => {
    const box = (id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0" }; };
    const chips = [...document.querySelectorAll("#skills .skill")].map((c) => { const r = c.getBoundingClientRect(); return { id: c.dataset.i ?? c.id, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; });
    const ids = ["minimap-frame", "cockpit", "hud-tl", "hud-tr", "xpbar", "toasts", "tutorial", "t-map", "t-stairs", "banner", "flask-chip"];
    const boxes = ids.map(box).filter(Boolean).filter((b) => b.vis && b.w > 0);
    const intr = [];
    for (const b of boxes) {
      if (b.x < safe.left) intr.push(`${b.id} left ${b.x}<${safe.left}`);
      if (b.y < safe.top) intr.push(`${b.id} top ${b.y}<${safe.top}`);
      if (innerWidth - (b.x + b.w) < safe.right) intr.push(`${b.id} right ${innerWidth - (b.x + b.w)}<${safe.right}`);
      if (innerHeight - (b.y + b.h) < safe.bottom) intr.push(`${b.id} bottom ${innerHeight - (b.y + b.h)}<${safe.bottom}`);
    }
    return {
      body: document.body.className, uiclass: document.body.dataset.uiclass, dpr: devicePixelRatio,
      vp: { w: innerWidth, h: innerHeight }, chips, boxes, intrusions: intr,
      zones: window.__dcc && window.__dcc.zones ? window.__dcc.zones : null,
    };
  }, spec.safe);
  rec("layout: safe-area intrusions", layout.intrusions.length === 0 ? "PASS" : "FAIL", layout.intrusions.join(" · ") || "none");
  rec("layout: class + chips", "INFO", `uiclass=${layout.uiclass} vp=${layout.vp.w}x${layout.vp.h} chips=${layout.chips.map((c) => `${c.id}@${c.x},${c.y} ${c.w}px`).join(" ")}`);

  const chip = {};
  for (const k of ["0", "1", "2", "3", "4"]) chip[k] = await at(`#skills .skill[data-i="${k}"]`);
  chip.flask = await at("#flask-chip");

  // ---------- 1. WALKING ----------
  {
    await keepAlive();
    const ox = Math.round(V.width * 0.2), oy = Math.round(V.height * 0.7);
    const under = await hitAt(ox, oy);
    const a = await snap();
    await touch.down(1, ox, oy);
    await settle(3);
    const during = await snap();
    for (let i = 0; i < 14; i++) { await touch.move(1, ox + 80, oy); await settle(2); }
    const b = await snap();
    await touch.up(1);
    await settle(3);
    const after = await snap();
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    // does the crawler keep coasting after lift?
    await settle(6);
    const c2 = await snap();
    const coast = Math.hypot(c2.pos.x - after.pos.x, c2.pos.y - after.pos.y);
    rec("walk: floating stick", d > 0.4 ? "PASS" : "FAIL", `moved ${d.toFixed(2)} tiles from (${ox},${oy}) over ${under}; stickVisual=${during.stickShown}; coast after lift ${coast.toFixed(3)} tiles`);
    rec("walk: resting ghost visible before touch", a.ghostShown ? "PASS" : "FAIL", `ghostShown(idle)=${a.ghostShown}`);
  }
  // direction fidelity: 8 compass pushes, is the produced motion monotone in the pushed direction?
  {
    const dirs = [[1, 0], [0.707, -0.707], [0, -1], [-0.707, -0.707], [-1, 0], [-0.707, 0.707], [0, 1], [0.707, 0.707]];
    const results = [];
    for (const [dx, dy] of dirs) {
      await keepAlive();
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.pos.x = 0 + p.pos.x; });
      const ox = Math.round(V.width * 0.2), oy = Math.round(V.height * 0.62);
      const a = await snap();
      await touch.down(1, ox, oy);
      for (let i = 0; i < 10; i++) { await touch.move(1, ox + dx * 70, oy + dy * 70); await settle(2); }
      const b = await snap();
      await touch.up(1);
      await settle(2);
      const mv = { x: b.pos.x - a.pos.x, y: b.pos.y - a.pos.y };
      const mag = Math.hypot(mv.x, mv.y);
      results.push({ push: [dx, dy], moved: [+mv.x.toFixed(2), +mv.y.toFixed(2)], mag: +mag.toFixed(2) });
    }
    // consistency: angle between screen push and world motion should rotate by a CONSTANT (the iso basis)
    const angs = results.filter((r) => r.mag > 0.15).map((r) => {
      const pa = Math.atan2(r.push[1], r.push[0]);
      const ma = Math.atan2(r.moved[1], r.moved[0]);
      let d = ((ma - pa) * 180) / Math.PI; while (d > 180) d -= 360; while (d < -180) d += 360;
      return Math.round(d);
    });
    const spread = angs.length ? Math.max(...angs) - Math.min(...angs) : 999;
    rec("walk: 8-way direction fidelity", angs.length >= 6 && spread <= 40 ? "PASS" : "FAIL", `${results.length} pushes, ${angs.length} produced motion; screen->world rotation ${angs.join(",")}° spread ${spread}°; mags ${results.map((r) => r.mag).join(",")}`);
  }

  // ---------- 2. AIM: indicator on pointerdown ----------
  {
    await keepAlive();
    const a = await snap();
    await touch.down(1, chip["2"].x, chip["2"].y);
    await settle(2);
    const onDown = await snap();
    // measure the projected indicator size + a legibility diff
    const aimGeom = await page.evaluate(() => {
      const r = window.__dcc.renderer, ind = r && r.aimIndicator;
      if (!ind || !ind.visible) return null;
      const cam = r.camera;
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0;
      const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      ind.updateWorldMatrix(true, true);
      ind.traverse((o) => {
        if (!o.visible) return;
        const g = o.geometry; if (!g || !g.attributes || !g.attributes.position) return;
        const pos = g.attributes.position, e = o.matrixWorld.elements;
        for (let i = 0; i < pos.count; i++) {
          const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
          const wx = e[0] * vx + e[4] * vy + e[8] * vz + e[12];
          const wy = e[1] * vx + e[5] * vy + e[9] * vz + e[13];
          const wz = e[2] * vx + e[6] * vy + e[10] * vz + e[14];
          const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15] || 1;
          const cx = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
          const cy = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;
          const sx = (cx * 0.5 + 0.5) * innerWidth, sy = (-cy * 0.5 + 0.5) * innerHeight;
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy); n++;
        }
      });
      let mat = null; ind.traverse((o) => { if (!mat && o.material && o.visible) mat = o.material; });
      return {
        shapes: ind.children.filter((c) => c.visible).map((c) => c.name),
        screen: n ? { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) } : null,
        mat: mat ? { color: "#" + mat.color.getHexString(), opacity: mat.opacity, depthTest: mat.depthTest } : null,
      };
    });
    rec("aim: indicator appears on pointerdown (no travel)", onDown.aim && onDown.aim.visible ? "PASS" : "FAIL", `aim=${JSON.stringify(onDown.aim)} geom=${JSON.stringify(aimGeom && aimGeom.screen)} mat=${JSON.stringify(aimGeom && aimGeom.mat)}`);
    // now drag past the slop; does the cancel band show?
    for (let i = 1; i <= 8; i++) { await touch.move(1, chip["2"].x - i * 14, chip["2"].y - i * 5); await settle(1); }
    const aiming = await snap();
    const bandBox = await at("#t-cancel");
    rec("aim: CANCEL band appears while aiming", aiming.cancelShown ? "PASS" : "FAIL", `cancelShown=${aiming.cancelShown} band=${JSON.stringify(bandBox)}`);
    await touch.up(1);
    await settle(6);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    rec("aim: release fires an aimed cast", started.length ? "PASS" : "FAIL", `fired ${started.join(",") || "none"}`);
  }

  // ---------- 3. CANCEL: band, and return-to-origin ----------
  {
    await keepAlive();
    const bandC = await at("#t-cancel-hit") || await at("#t-cancel");
    const a = await snap();
    await touch.down(1, chip["3"].x, chip["3"].y);
    await settle(1);
    for (let i = 1; i <= 8; i++) { await touch.move(1, chip["3"].x - i * 16, chip["3"].y - i * 4); await settle(1); }
    const band = await at("#t-cancel");
    if (band) {
      for (let i = 1; i <= 6; i++) { await touch.move(1, chip["3"].x + ((band.x - chip["3"].x) * i) / 6, chip["3"].y + ((band.y - chip["3"].y) * i) / 6); await settle(1); }
      const inBand = await snap();
      await touch.up(1);
      await settle(6);
      const b = await snap();
      const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
      rec("cancel: drag into the CANCEL band", started.length === 0 ? "PASS" : "FAIL", `band at ${band.x},${band.y} ${band.w}x${band.h}; cast leaked: ${started.join(",") || "none"}`);
    } else {
      await touch.up(1);
      rec("cancel: drag into the CANCEL band", "FAIL", "no #t-cancel element on screen while aiming");
    }
  }
  {
    await keepAlive();
    const a = await snap();
    await touch.down(1, chip["3"].x, chip["3"].y);
    for (let i = 1; i <= 8; i++) { await touch.move(1, chip["3"].x - i * 16, chip["3"].y); await settle(1); }
    for (let i = 8; i >= 0; i--) { await touch.move(1, chip["3"].x - i * 16, chip["3"].y); await settle(1); }
    await touch.up(1);
    await settle(6);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    rec("cancel: return to origin", started.length === 0 ? "PASS" : "FAIL", started.length ? `LEAKED ${started.join(",")}` : "no cooldown started");
  }

  // ---------- 4. CAST WHILE MOVING ----------
  {
    await keepAlive();
    const ox = Math.round(V.width * 0.22), oy = Math.round(V.height * 0.8);
    await touch.down(1, ox, oy);
    for (let i = 0; i < 6; i++) { await touch.move(1, ox + 60, oy - 40); await settle(2); }
    const a = await snap();
    await touch.down(2, chip["1"].x, chip["1"].y);
    await settle(2);
    for (let i = 0; i < 6; i++) { await touch.move(1, ox + 60, oy - 40); await settle(2); }
    const midAim = await snap();
    // drag the SECOND finger to aim while the FIRST keeps walking
    for (let i = 1; i <= 8; i++) { await touch.move(2, chip["1"].x - i * 14, chip["1"].y - i * 5); await touch.move(1, ox + 60, oy - 40); await settle(1); }
    const b = await snap();
    await touch.up(2);
    await settle(4);
    for (let i = 0; i < 4; i++) { await touch.move(1, ox + 60, oy - 40); await settle(2); }
    const c = await snap();
    await touch.up(1);
    const moved = Math.hypot(c.pos.x - a.pos.x, c.pos.y - a.pos.y);
    const started = Object.keys(c.cd).filter((k) => (c.cd[k] || 0) > (a.cd[k] || 0));
    rec("cast while moving (2 fingers, aimed)", moved > 0.3 && started.length ? "PASS" : "FAIL", `moved ${moved.toFixed(2)} tiles during an AIMED cast; fired ${started.join(",") || "none"}`);
  }

  // ---------- 5. TARGET SELECTION ----------
  {
    await keepAlive();
    // find a monster's screen position through the renderer camera
    const mon = await page.evaluate(() => {
      const d = window.__dcc, s = d.state, r = d.renderer;
      const p = s.players[0];
      const alive = s.monsters.filter((m) => m.hp > 0);
      if (!alive.length) return null;
      alive.sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y));
      const m = alive[0];
      const cam = r.camera;
      const mm = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      const wx = m.pos.x, wy = 0.9, wz = m.pos.y;
      const cw = mm[3] * wx + mm[7] * wy + mm[11] * wz + mm[15] || 1;
      const cx = (mm[0] * wx + mm[4] * wy + mm[8] * wz + mm[12]) / cw;
      const cy = (mm[1] * wx + mm[5] * wy + mm[9] * wz + mm[13]) / cw;
      return { id: m.id, hp: m.hp, sx: Math.round((cx * 0.5 + 0.5) * innerWidth), sy: Math.round((-cy * 0.5 + 0.5) * innerHeight), n: alive.length };
    });
    if (!mon) rec("target: tap a monster to lock", "N/A", "no monsters alive");
    else {
      const under = await hitAt(mon.sx, mon.sy);
      const a = await snap();
      await touch.tap(mon.sx, mon.sy, 1, 120);
      await settle(8);
      const b = await snap();
      rec("target: tap a monster to lock", b.lockedId ? "PASS" : "FAIL", `tapped monster ${mon.id} at (${mon.sx},${mon.sy}) over ${under}; lockedId ${a.lockedId}->${b.lockedId}`);
      // is there a visible lock ring / plate?
      const lockUi = await page.evaluate(() => {
        const r = window.__dcc.renderer;
        const keys = Object.keys(r).filter((k) => /lock|target|reticle/i.test(k));
        const dom = [...document.querySelectorAll("*")].filter((e) => /lock|targetplate/i.test(e.id || "")).map((e) => e.id);
        return { keys, dom };
      });
      rec("target: lock has an on-screen read", lockUi.keys.length || lockUi.dom.length ? "PASS" : "FAIL", `renderer[${lockUi.keys.join("|") || "none"}] dom[${lockUi.dom.join("|") || "none"}]`);
      // does a smart cast now respect the lock?
    }
  }
  // world tap on empty ground -> move order
  {
    await keepAlive();
    const a = await snap();
    const wx = Math.round(V.width * 0.62), wy = Math.round(V.height * 0.45);
    const under = await hitAt(wx, wy);
    await touch.tap(wx, wy, 1, 300);
    await settle(20);
    const b = await snap();
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    rec("world: tap-to-move (300 ms, the old dead band)", d > 0.25 ? "PASS" : "FAIL", `moved ${d.toFixed(2)} tiles after a tap at (${wx},${wy}) over ${under}`);
  }
  {
    await keepAlive();
    const a = await snap();
    const wx = Math.round(V.width * 0.62), wy = Math.round(V.height * 0.5);
    await touch.down(1, wx, wy);
    touch.tick(700); await page.waitForTimeout(700);
    await touch.up(1);
    await settle(8);
    const b = await snap();
    rec("world: long press pings", b.pings > a.pings ? "PASS" : "FAIL", `pings ${a.pings}->${b.pings}`);
  }

  // ---------- 6. DODGE UNDER PRESSURE ----------
  {
    await keepAlive();
    const dash = await page.evaluate(() => {
      const p = window.__dcc.state.players[0];
      p.dashCharges = 2; if (p.cd) p.cd.dash = 0;
      const i = p.abilities.slots.findIndex((a) => a && /dash|dodge|blink|roll/i.test(a));
      return { i, slots: p.abilities.slots };
    });
    // flick on the stick WHILE walking, monsters adjacent
    const ox = Math.round(V.width * 0.22), oy = Math.round(V.height * 0.78);
    await touch.down(1, ox, oy);
    for (let i = 0; i < 6; i++) { touch.tick(30); await touch.move(1, ox + 30, oy); await settle(1); }
    const a = await snap();
    for (let k = 1; k <= 4; k++) { touch.tick(9); await touch.move(1, ox + 30 + k * 50, oy); }
    await settle(8);
    const b = await snap();
    await touch.up(1);
    const usedCharge = (a.dashCharges ?? 0) > (b.dashCharges ?? 0) || (b.cd.dash || 0) > (a.cd.dash || 0);
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    rec("dodge: flick-dash on the stick mid-walk", usedCharge ? "PASS" : "FAIL", `dash slot ${dash.i}; charges ${a.dashCharges}->${b.dashCharges}; cd.dash ${a.cd.dash ?? 0}->${b.cd.dash ?? 0}; travelled ${d.toFixed(2)} tiles`);
  }
  {
    await keepAlive();
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.dashCharges = 2; if (p.cd) p.cd.dash = 0; });
    const a = await snap();
    const wx = Math.round(V.width * 0.6), wy = Math.round(V.height * 0.55);
    await touch.down(1, wx - 30, wy);
    touch.tick(40);
    await touch.down(2, wx + 30, wy);
    touch.tick(120);
    await page.waitForTimeout(120);
    await touch.up(1); await touch.up(2);
    await settle(8);
    const b = await snap();
    const used = (a.dashCharges ?? 0) > (b.dashCharges ?? 0) || (b.cd.dash || 0) > (a.cd.dash || 0);
    rec("dodge: two-finger world tap", used ? "PASS" : "FAIL", `charges ${a.dashCharges}->${b.dashCharges}, cd.dash ${a.cd.dash ?? 0}->${b.cd.dash ?? 0}`);
  }

  // ---------- 7. POTION ----------
  {
    await page.evaluate(() => { clearInterval(window.__keep); const p = window.__dcc.state.players[0]; p.alive = true; p.downedT = 0; p.hp = Math.max(1, Math.round(p.maxHp * 0.35)); });
    const a = await snap();
    await touch.tap(chip.flask.x, chip.flask.y, 1, 180);
    await settle(10);
    const b = await snap();
    rec("potion: tap the flask chip", b.flask < a.flask || b.hp > a.hp ? "PASS" : "FAIL", `charges ${a.flask}->${b.flask}, hp ${a.hp}->${b.hp}, flask chip ${chip.flask.w}x${chip.flask.h} at (${chip.flask.x},${chip.flask.y})`);
    // low-hp pulse on the chip?
    const pulse = await page.evaluate(() => {
      const e = document.getElementById("flask-chip");
      return e ? { cls: e.className, anim: getComputedStyle(e).animationName } : null;
    });
    rec("potion: low-HP affordance on the chip", pulse && (/low|urgent|pulse/i.test(pulse.cls) || pulse.anim !== "none") ? "PASS" : "FAIL", `at 35% hp the chip reads: class="${pulse && pulse.cls}" animation=${pulse && pulse.anim}`);
    await page.evaluate(() => { window.__keep = setInterval(() => { const s = window.__dcc && window.__dcc.state; if (!s) return; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; s.status = "playing"; }, 120); });
  }

  // ---------- 8. LOOT ----------
  {
    await keepAlive();
    const loot = await page.evaluate(() => {
      const s = window.__dcc.state, p = s.players[0];
      const items = (s.drops || s.items || s.loot || []);
      return { kinds: Object.keys(s).filter((k) => /drop|loot|item|pickup/i.test(k)), n: items.length, bag: (p.bag || []).length };
    });
    // spawn a drop next to the crawler if the sim allows; otherwise report feedback surfaces
    const feedback = await page.evaluate(() => {
      const r = window.__dcc.renderer;
      return {
        rendererKeys: Object.keys(r).filter((k) => /pickup|lootring|magnet/i.test(k)),
        dom: [...document.querySelectorAll("*")].filter((e) => /pickup|lootstrip|loot/i.test(e.id || "")).map((e) => e.id),
      };
    });
    rec("loot: pickup feedback surfaces exist", feedback.rendererKeys.length || feedback.dom.length ? "PASS" : "FAIL", `sim loot keys ${loot.kinds.join(",")}, drops=${loot.n}, bag=${loot.bag}; renderer[${feedback.rendererKeys.join("|") || "none"}] dom[${feedback.dom.join("|") || "none"}]`);
  }

  // ---------- 9. INTERACT (context chip) ----------
  {
    await keepAlive();
    const ctx1 = await page.evaluate(() => {
      const e = document.getElementById("t-stairs");
      if (!e) return null;
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      return { text: e.textContent.trim(), shown: cs.display !== "none", x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    });
    // teleport the crawler onto the stairs so the chip must appear
    const tp = await page.evaluate(() => {
      const s = window.__dcc.state, p = s.players[0];
      const st = s.map && (s.map.stairs || s.map.exit);
      if (!st) return null;
      p.pos.x = st.x + 0.2; p.pos.y = st.y + 0.2;
      return { x: st.x, y: st.y };
    });
    await settle(10);
    const ctx2 = await page.evaluate(() => {
      const e = document.getElementById("t-stairs");
      if (!e) return null;
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      return { text: e.textContent.trim(), shown: cs.display !== "none", x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    });
    let acted = "not attempted";
    if (ctx2 && ctx2.shown && ctx2.w > 0) {
      const a = await snap();
      await touch.tap(ctx2.x, ctx2.y, 1, 140);
      await settle(14);
      const b = await snap();
      acted = `floor/panel change: monstersAlive ${a.monstersAlive}->${b.monstersAlive}, panels ${await page.evaluate(() => ["saferoom", "draft"].filter((id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }).join(",") || "none")}`;
    }
    rec("interact: context chip", ctx2 && ctx2.shown && ctx2.h >= 44 ? "PASS" : "FAIL", `before=${JSON.stringify(ctx1)} on-stairs=${JSON.stringify(ctx2)} tp=${JSON.stringify(tp)}; ${acted}`);
  }

  // ---------- 10. MODAL MID-AIM ----------
  {
    await keepAlive();
    const a = await snap();
    await touch.down(1, chip["2"].x, chip["2"].y);
    for (let i = 1; i <= 8; i++) { await touch.move(1, chip["2"].x - i * 16, chip["2"].y - i * 5); await settle(1); }
    await page.keyboard.press("i");
    await page.waitForTimeout(500);
    const modalUp = await page.evaluate(() => { const e = document.getElementById("inv"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
    await touch.up(1);
    await settle(6);
    const during = await snap();
    await page.keyboard.press("i");
    await page.waitForTimeout(600);
    await settle(10);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    rec("safety: modal opens mid-aim, finger lifts", started.length === 0 ? "PASS" : "FAIL", `modal opened=${modalUp}; casts after close: ${started.join(",") || "none"}`);
  }
  // ---------- 10b. BACKGROUNDED MID-DRAG (the no-event path) ----------
  {
    await keepAlive();
    const ox = Math.round(V.width * 0.22), oy = Math.round(V.height * 0.78);
    await touch.down(1, ox, oy);
    for (let i = 0; i < 6; i++) { await touch.move(1, ox + 70, oy); await settle(1); }
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("blur"));
    });
    await settle(6);
    const a = await snap();
    await settle(20);
    const b = await snap();
    const drift = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await touch.up(1);
    await settle(4);
    rec("safety: backgrounded with the stick held", drift < 0.12 ? "PASS" : "FAIL", `crawler drifted ${drift.toFixed(3)} tiles while hidden with the finger still down`);
  }

  // ---------- 11. HAPTICS ----------
  {
    const v = await page.evaluate(() => (window.__vibes || []).map((v) => v.p));
    rec("haptics: navigator.vibrate calls so far", v.length ? "PASS" : "FAIL", `${v.length} pulses: ${JSON.stringify(v.slice(0, 12))}`);
  }

  // ---------- 12. SHOP ----------
  {
    await keepAlive();
    let opened = false;
    for (let i = 0; i < 4 && !opened; i++) {
      await page.evaluate(() => { const d = window.__dcc; const p = d.state.players[0]; p.hp = p.maxHp; p.alive = true; d.state.status = "playing"; p.gold = 3000; });
      await page.keyboard.press("b").catch(() => {});
      await page.waitForTimeout(700);
      opened = await page.evaluate(() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
      if (!opened) { await page.evaluate(() => { const d = window.__dcc; if (d.openShop) d.openShop(); }); await page.waitForTimeout(600); opened = await page.evaluate(() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }); }
    }
    if (!opened) rec("shop: open", "FAIL", "could not open #saferoom with B or __dcc.openShop");
    else {
      const geom = await page.evaluate(() => {
        const p = document.getElementById("saferoom");
        const r = p.getBoundingClientRect();
        const shown = (e) => { const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0; };
        const inter = [...p.querySelectorAll("button, .tab, [data-act], [data-buy], .itile, .bag-cell, .cell, input, select")].filter(shown).map((e) => { const b = e.getBoundingClientRect(); return { t: (e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : "") || e.tagName), w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.y) }; });
        const off = inter.filter((n) => n.y < 0 || n.y > innerHeight);
        const small = inter.filter((n) => n.w < 44 || n.h < 44);
        const closers = [...p.querySelectorAll("[data-close], .p-close, .panel-close, .set-close, .done, [data-act='close']")].filter(shown).map((e) => { const b = e.getBoundingClientRect(); return { t: e.id || e.className, w: Math.round(b.width), h: Math.round(b.height) }; });
        return {
          panel: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          overhang: { top: Math.round(Math.max(0, -r.top)), bottom: Math.round(Math.max(0, r.bottom - innerHeight)), right: Math.round(Math.max(0, r.right - innerWidth)) },
          nInter: inter.length, small, off, closers,
          buy: [...p.querySelectorAll("[data-buy]")].filter(shown).map((e) => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), txt: e.textContent.trim().slice(0, 24), dis: e.disabled }; }),
        };
      });
      rec("shop: geometry + tap targets", geom.small.length === 0 && geom.off.length === 0 && geom.overhang.bottom === 0 ? "PASS" : "FAIL",
        `panel ${geom.panel.w}x${geom.panel.h} overhang ${JSON.stringify(geom.overhang)}; ${geom.nInter} interactive, ${geom.small.length} under 44px ${JSON.stringify(geom.small.slice(0, 8))}, ${geom.off.length} off-screen; closers ${JSON.stringify(geom.closers)}`);
      // Buy something with a finger.
      const tile = await page.evaluate(() => {
        const p = document.getElementById("saferoom");
        const t = [...p.querySelectorAll(".itile")].filter((e) => e.getBoundingClientRect().width > 0)[0];
        if (!t) return null;
        const b = t.getBoundingClientRect();
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) };
      });
      let buyDetail = "no shelf tile";
      let buyOk = false;
      if (tile) {
        const a = await snap();
        await touch.tap(tile.x, tile.y, 1, 120);
        await settle(8);
        const buyBtn = await page.evaluate(() => {
          const b = [...document.querySelectorAll("#saferoom [data-buy]")].filter((e) => e.getBoundingClientRect().width > 0)[0];
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), txt: b.textContent.trim(), dis: b.disabled };
        });
        if (buyBtn && !buyBtn.dis) {
          await touch.tap(buyBtn.x, buyBtn.y, 1, 120);
          await settle(10);
          const b = await snap();
          buyOk = b.gold !== a.gold || b.bag !== a.bag || b.equipped !== a.equipped;
          buyDetail = `tile ${tile.w}x${tile.h} -> BUY ${buyBtn.w}x${buyBtn.h} "${buyBtn.txt}"; gold ${a.gold}->${b.gold}, bag ${a.bag}->${b.bag}`;
        } else buyDetail = `tile tapped; BUY control = ${JSON.stringify(buyBtn)}`;
      }
      rec("shop: buy an item with a finger", buyOk ? "PASS" : "FAIL", buyDetail);
      // close it three ways
      const closeTests = [];
      // (a) explicit close control
      const closer = await page.evaluate(() => {
        const p = document.getElementById("saferoom");
        const e = [...p.querySelectorAll("[data-close], .p-close, .panel-close, .set-close, .pt-close, .pt-done")].filter((x) => x.getBoundingClientRect().width > 0)[0];
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), cls: e.className };
      });
      const isOpen = () => page.evaluate(() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
      if (closer) { await touch.tap(closer.x, closer.y, 1, 110); await page.waitForTimeout(700); closeTests.push(`closeControl(${closer.cls} ${closer.w}x${closer.h})=${!(await isOpen())}`); }
      else closeTests.push("closeControl=ABSENT");
      if (!(await isOpen())) { await page.keyboard.press("b").catch(() => {}); await page.waitForTimeout(700); }
      if (await isOpen()) { await touch.tap(Math.round(V.width * 0.5), 4, 1, 110); await page.waitForTimeout(700); closeTests.push(`backdropTap=${!(await isOpen())}`); }
      if (!(await isOpen())) { await page.keyboard.press("b").catch(() => {}); await page.waitForTimeout(700); }
      if (await isOpen()) {
        const c = await page.evaluate(() => { const r = document.getElementById("saferoom").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 24) }; });
        await touch.down(1, c.x, c.y);
        for (let i = 1; i <= 8; i++) { touch.tick(20); await touch.move(1, c.x, c.y + i * 22); await page.waitForTimeout(20); }
        await touch.up(1);
        await page.waitForTimeout(700);
        closeTests.push(`swipeDown=${!(await isOpen())}`);
      }
      rec("shop: close by touch", closeTests.every((t) => t.includes("=true")) ? "PASS" : "FAIL", closeTests.join(" · "));
      await page.evaluate(() => { const e = document.getElementById("saferoom"); if (e) e.style.display = "none"; });
    }
  }

  // ---------- 13. CHARACTER SHEET ----------
  {
    await keepAlive();
    let opened = false;
    for (let i = 0; i < 4 && !opened; i++) {
      await keepAlive();
      await page.keyboard.press("p");
      await page.waitForTimeout(700);
      opened = await page.evaluate(() => { const e = document.getElementById("sheet"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
    }
    if (!opened) rec("sheet: open", "FAIL", "#sheet never opened");
    else {
      const geom = await page.evaluate(() => {
        const p = document.getElementById("sheet"), r = p.getBoundingClientRect();
        const shown = (e) => { const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0; };
        const scroller = [...p.querySelectorAll("*")].map((e) => ({ t: e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : ""), sx: e.scrollWidth - e.clientWidth, sy: e.scrollHeight - e.clientHeight })).filter((n) => n.sx > 4);
        const inter = [...p.querySelectorAll("button, .tab, [data-act], .row, .cell, input")].filter(shown).map((e) => { const b = e.getBoundingClientRect(); return { t: e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : ""), w: Math.round(b.width), h: Math.round(b.height) }; });
        return {
          panel: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          overhang: { top: Math.round(Math.max(0, -r.top)), bottom: Math.round(Math.max(0, r.bottom - innerHeight)) },
          hClip: scroller, scrollY: p.scrollHeight - p.clientHeight,
          small: inter.filter((n) => n.w < 44 || n.h < 44).slice(0, 8), nInter: inter.length,
          hoverHint: /hover/i.test(p.textContent) ? p.textContent.match(/[^.]*hover[^.]*/i)[0].trim().slice(0, 70) : null,
          closers: [...p.querySelectorAll("[data-close], .p-close, .pt-close, .pt-done, .set-close")].filter(shown).length,
        };
      });
      rec("sheet: fits + reachable", geom.hClip.length === 0 && geom.overhang.bottom === 0 ? "PASS" : "FAIL",
        `panel ${geom.panel.w}x${geom.panel.h}, overhang ${JSON.stringify(geom.overhang)}, horizontally-clipped subtrees ${JSON.stringify(geom.hClip.slice(0, 4))}, vertical scroll ${geom.scrollY}px, ${geom.small.length} sub-44px controls, close controls ${geom.closers}, hover hint: ${geom.hoverHint || "none"}`);
      // tap a stat row -> derivation sheet?
      const row = await page.evaluate(() => {
        const p = document.getElementById("sheet");
        const e = [...p.querySelectorAll(".row, tr, .stat, [data-math]")].filter((x) => x.getBoundingClientRect().width > 30 && x.getBoundingClientRect().height > 10)[3];
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), h: Math.round(r.height), txt: e.textContent.trim().slice(0, 40) };
      });
      if (row) {
        await touch.tap(row.x, row.y, 1, 130);
        await settle(8);
        const sheetUp = await page.evaluate(() => {
          const e = document.getElementById("tsheet") || document.querySelector("[data-sheet]");
          return e ? { id: e.id, shown: getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0, txt: e.textContent.trim().slice(0, 60) } : null;
        });
        rec("sheet: tap a row for the math", sheetUp && sheetUp.shown ? "PASS" : "FAIL", `tapped "${row.txt}" (${row.h}px tall) -> ${JSON.stringify(sheetUp)}`);
      } else rec("sheet: tap a row for the math", "FAIL", "no tappable stat row found");
      // close by touch
      const isOpen = () => page.evaluate(() => { const e = document.getElementById("sheet"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
      const closer = await page.evaluate(() => {
        const p = document.getElementById("sheet");
        const e = [...p.querySelectorAll("[data-close], .p-close, .pt-close, .pt-done, .set-close")].filter((x) => x.getBoundingClientRect().width > 0)[0];
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), cls: e.className };
      });
      let detail = [];
      if (closer) { await touch.tap(closer.x, closer.y, 1, 110); await page.waitForTimeout(700); detail.push(`closeControl(${closer.w}x${closer.h})=${!(await isOpen())}`); }
      else detail.push("closeControl=ABSENT");
      rec("sheet: close by touch", detail.every((t) => t.includes("=true")) ? "PASS" : "FAIL", detail.join(" · "));
      await page.evaluate(() => { const e = document.getElementById("sheet"); if (e && getComputedStyle(e).display !== "none") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      await page.keyboard.press("Escape").catch(() => {});
    }
  }

  // ---------- 14. ZOOM / SELECTION HYGIENE ----------
  {
    const s = await snap();
    rec("hygiene: no pinch zoom / text selection", s.scale === 1 ? "PASS" : "FAIL", `visualViewport.scale=${s.scale}`);
  }

  await page.screenshot({ path: `${OUT}/${devKey}-final.png` });
  await ctx.close();
  return { device: devKey, layout, rows };
}

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const all = [];
for (const d of DEVS) {
  console.log(`\n=== ${d} ===`);
  try { all.push(await run(d, browser)); }
  catch (e) { console.log(`  [ERROR] ${d}: ${e.message}`); all.push({ device: d, error: e.message }); }
}
await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(all, null, 2));
console.log("\nwrote " + OUT + "/report.json");
