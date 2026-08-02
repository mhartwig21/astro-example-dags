// ACCEPTANCE ROUND 3 — an independent critic's battery.
// Every gesture is a REAL touch event through CDP. Nothing here trusts a rect,
// a class name or a scene-graph key: each check reads sim/DOM state before and
// after and reports the delta.
import { chromium, devices } from "playwright";
import fs from "node:fs";

const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const ONLY = process.argv[2];
const OUT = process.argv[3] ?? "acc3";
const MATRIX = [
  { key: "iphone13-land", pw: "iPhone 13 landscape", safe: [0, 47, 21, 47] },
  { key: "iphone13promax-land", pw: "iPhone 13 Pro Max landscape", safe: [0, 47, 21, 47] },
  { key: "ipadpro11-land", pw: "iPad Pro 11 landscape", safe: [24, 0, 20, 0] },
  { key: "pixel5-land", pw: "Pixel 5 landscape", safe: [0, 24, 0, 0] },
].filter((d) => !ONLY || d.key.includes(ONLY));

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

function driver(client) {
  const live = new Map();
  let clock = Date.now() / 1000;
  const all = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  const send = (type, pts) => client.send("Input.dispatchTouchEvent", { type, touchPoints: pts, timestamp: clock });
  const api = {
    tick(ms) { clock += ms / 1000; return api; },
    async down(id, x, y) { live.set(id, { x: Math.round(x), y: Math.round(y) }); await send("touchStart", all()); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x: Math.round(x), y: Math.round(y) }); await send("touchMove", all()); },
    async up(id) { const p = live.get(id); live.delete(id); await send("touchEnd", p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : []); },
    async clear() { for (const id of [...live.keys()]) await api.up(id); },
  };
  return api;
}

const results = [];
let CUR = "";
const rec = (name, pass, detail) => {
  results.push({ dev: CUR, name, pass, detail });
  console.log(`  [${pass === null ? "INFO" : pass ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

for (const dev of MATRIX) {
  CUR = dev.key;
  const ctx = await browser.newContext({ ...devices[dev.pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const t = driver(client);
  const url = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance` +
    `&floor=6&level=16&gold=9000&seed=77&safe=${dev.safe.join(",")}`;
  await page.goto(url, { waitUntil: "load", timeout: 180000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
  await page.waitForTimeout(1500);
  const V = page.viewportSize();
  console.log(`\n===== ${dev.key} ${V.width}x${V.height} =====`);

  const settle = async (n = 4) => {
    await page.waitForTimeout(90);
    await page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n).catch(() => {});
  };
  const P = () => page.evaluate(() => {
    const q = window.__dcc.state.players[0];
    return { x: q.pos.x, y: q.pos.y, hp: q.hp, maxHp: q.maxHp, gold: q.gold, bag: (q.bag || []).length, cd: JSON.parse(JSON.stringify(q.cd || {})), dash: q.dashCharges, flask: q.flaskCharges };
  });
  const reset = () => page.evaluate(() => {
    const q = window.__dcc.state.players[0];
    q.hp = q.maxHp; q.alive = true; q.downedT = 0;
    q.dashCharges = 2; q.flaskCharges = 3;
    for (const k in q.cd) q.cd[k] = 0;
    if (window.__dcc.state.status !== "playing") window.__dcc.state.status = "playing";
  }).catch(() => {});

  // ------------------------------------------------- 0. COLD START, no touch
  {
    const cold = await page.evaluate(() => {
      const vis = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return { on: s.display !== "none" && s.visibility !== "hidden" && +s.opacity > 0.02 && r.width > 0, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), op: +s.opacity };
      };
      return { stick: vis("#t-stick"), ghost: vis("#t-ghost, #t-stickghost, #t-rest"), zone: vis("#t-stickzone") };
    });
    rec("cold start: a resting stick affordance is on screen before any finger lands",
      !!(cold.ghost?.on || cold.stick?.on),
      `#t-stick=${JSON.stringify(cold.stick)} ghost=${JSON.stringify(cold.ghost)}`);
  }

  // watchdog after the cold-start read
  await page.evaluate(() => {
    window.__keep = setInterval(() => {
      const d = window.__dcc; if (!d) return;
      const q = d.state.players[0];
      if (!d.state.safeRoom) { q.hp = q.maxHp; q.alive = true; q.downedT = 0; if (d.state.status !== "playing") d.state.status = "playing"; }
    }, 150);
  });

  const chips = await page.evaluate(() => {
    const z = window.__dcc.touch.zones, out = {};
    for (const id of Object.keys(z.controls)) {
      const c = z.controls[id];
      out[id] = { x: Math.round(c.cx), y: Math.round(c.cy), w: Math.round(c.w), h: Math.round(c.h) };
    }
    out._zones = { aimThrow: Math.round(z.aimThrow), cancelRadius: Math.round(z.cancelRadius), R: Math.round(z.stickRadius ?? z.R ?? 0), cancelMode: z.cancelMode, posture: z.posture ?? z.grip };
    return out;
  });
  console.log("  chips:", JSON.stringify(chips));

  const clearGround = await page.evaluate(([w, h]) => {
    const d = window.__dcc;
    for (const fy of [0.80, 0.70, 0.88, 0.60]) for (const fx of [0.26, 0.18, 0.34, 0.10]) {
      const x = Math.round(w * fx), y = Math.round(h * fy);
      if (!d.touch.controlAt(x, y) && d.touch.route(x, y).zone === "stick") {
        const el = document.elementFromPoint(x, y);
        return { x, y, el: el ? `${el.tagName}#${el.id || ""}` : "none" };
      }
    }
    return null;
  }, [V.width, V.height]);
  console.log("  clear stick ground:", JSON.stringify(clearGround));

  // ------------------------------------------------- 1. WALK, eight directions
  {
    const R = chips._zones.R || 60;
    const dirs = [[1, 0, "E"], [0.71, 0.71, "SE"], [0, 1, "S"], [-0.71, 0.71, "SW"], [-1, 0, "W"], [-0.71, -0.71, "NW"], [0, -1, "N"], [0.71, -0.71, "NE"]];
    const errs = [], tiles = [];
    for (const [dx, dy, name] of dirs) {
      await reset();
      const a = await P();
      const scr0 = await page.evaluate(() => { const d = window.__dcc, q = d.state.players[0]; const s = d.renderer.worldToScreen(q.pos.x, 0, q.pos.y); return { x: s.x, y: s.y }; });
      await t.down(1, clearGround.x, clearGround.y);
      for (let i = 1; i <= 8; i++) { t.tick(16); await t.move(1, clearGround.x + dx * R, clearGround.y + dy * R); await settle(1); }
      await settle(6);
      const b = await P();
      const scr1 = await page.evaluate(([ax, ay]) => { const d = window.__dcc, q = d.state.players[0]; const s = d.renderer.worldToScreen(q.pos.x, 0, q.pos.y); return { x: s.x, y: s.y, ax, ay }; }, [a.x, a.y]);
      await t.up(1);
      await settle(2);
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      tiles.push(moved);
      // Screen-space fidelity: did the crawler go the way the thumb pushed?
      const sdx = scr1.x - scr0.x, sdy = scr1.y - scr0.y;
      let err = 999;
      if (Math.hypot(sdx, sdy) > 4) {
        const want = Math.atan2(dy, dx), got = Math.atan2(sdy, sdx);
        err = Math.abs(((got - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
      }
      errs.push({ name, moved: +moved.toFixed(2), err: +err.toFixed(1) });
    }
    const worstT = Math.min(...tiles);
    const measured = errs.filter((e) => e.err < 900);
    const worstE = measured.length ? Math.max(...measured.map((e) => e.err)) : 999;
    rec("walk: the stick moves the crawler in all 8 directions", worstT > 0.4,
      `tiles: ${errs.map((e) => `${e.name} ${e.moved}`).join(" / ")}`);
    rec("walk: the crawler goes where the thumb pushed (screen-space angular error)", worstE < 22,
      `worst ${worstE.toFixed(1)}° — ${errs.map((e) => `${e.name} ${e.err > 900 ? "n/a" : e.err + "°"}`).join(" / ")}`);
  }

  // ------------------------------------------------- 2. AIM: indicator + cancel
  {
    await reset();
    const c = chips.slot1;
    // 2a. indicator on pointerdown, in the same frame, with the SIM FROZEN.
    await page.evaluate(() => { window.__frz = window.__dcc.state; window.__frz.__frozen = true; });
    await t.down(1, c.x, c.y);
    await settle(2);
    const onDown = await page.evaluate(() => {
      const i = window.__dcc.renderer.aimIndicator;
      return { exists: !!i, visible: !!(i && i.visible) };
    });
    // 2b. does the telegraph TRACK the finger without a sim step?
    const before = await page.evaluate(() => { const i = window.__dcc.renderer.aimIndicator; return i ? { x: +i.position.x.toFixed(3), z: +i.position.z.toFixed(3), r: +(i.rotation?.y ?? 0).toFixed(3) } : null; });
    for (let i = 1; i <= 6; i++) { t.tick(16); await t.move(1, c.x - i * 18, c.y - i * 10); }
    await settle(3);
    const after = await page.evaluate(() => { const i = window.__dcc.renderer.aimIndicator; return i ? { x: +i.position.x.toFixed(3), z: +i.position.z.toFixed(3), r: +(i.rotation?.y ?? 0).toFixed(3) } : null; });
    rec("aim: the indicator appears on pointerdown", onDown.visible, JSON.stringify(onDown));
    const drift = before && after ? Math.hypot(after.x - before.x, after.z - before.z) + Math.abs(after.r - before.r) : 0;
    rec("aim: the indicator tracks the drag", drift > 0.05,
      `indicator moved ${drift.toFixed(3)} (from ${JSON.stringify(before)} to ${JSON.stringify(after)})`);

    // 2c. the CANCEL affordance is drawn, and where
    const cancelUi = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll("#t-cancel, .t-cancel, [data-cancel], #t-cancelband, #t-cancelring")) {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        if (s.display === "none" || +s.opacity < 0.05 || r.width < 1) continue;
        out.push({ id: e.id || e.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      }
      return out;
    });
    rec("aim: a cancel affordance is drawn while AIMING", cancelUi.length > 0, JSON.stringify(cancelUi));

    // 2d. return-to-origin cancels: no cooldown, no charge
    const pre = await P();
    for (let i = 6; i >= 0; i--) { t.tick(16); await t.move(1, c.x - i * 3, c.y - i * 2); }
    await settle(3);
    await t.up(1);
    await settle(5);
    const post = await P();
    const anyCd = Object.keys(post.cd).some((k) => (post.cd[k] || 0) > (pre.cd[k] || 0) + 0.01);
    rec("aim: dragging back to the origin cancels (no cooldown, no charge spent)", !anyCd,
      `cd before ${JSON.stringify(pre.cd)} after ${JSON.stringify(post.cd)}`);

    // 2e. the cancel gesture in the OTHER direction: drag out, release on the
    //     drawn cancel affordance if there is one.
    if (cancelUi.length) {
      await reset();
      const pre2 = await P();
      await t.down(1, c.x, c.y);
      for (let i = 1; i <= 6; i++) { t.tick(16); await t.move(1, c.x - i * 20, c.y - i * 8); }
      await settle(2);
      const b = cancelUi[0];
      t.tick(16); await t.move(1, b.x + b.w / 2, b.y + b.h / 2);
      await settle(3);
      await t.up(1);
      await settle(4);
      const post2 = await P();
      const fired = Object.keys(post2.cd).some((k) => (post2.cd[k] || 0) > (pre2.cd[k] || 0) + 0.01);
      rec("aim: releasing on the drawn cancel affordance cancels", !fired,
        `released at (${Math.round(b.x + b.w / 2)},${Math.round(b.y + b.h / 2)}); cd ${JSON.stringify(post2.cd)}`);
    }
    await t.clear();
  }

  // ------------------------------------------------- 3. CAST WHILE MOVING
  {
    const kept = [], cast = [];
    for (const [dx, dy, nm] of [[1, 0, "E"], [-1, 0, "W"], [0, 1, "S"], [0, -1, "N"]]) {
      await reset();
      const a = await P();
      await t.down(1, clearGround.x, clearGround.y);
      t.tick(16); await t.move(1, clearGround.x + dx * 70, clearGround.y + dy * 70);
      await settle(3);
      const c = chips.slot2;
      await t.down(2, c.x, c.y);
      for (let i = 1; i <= 6; i++) {
        t.tick(16);
        await t.move(2, c.x - i * 16, c.y - i * 7);
        await t.move(1, clearGround.x + dx * 70, clearGround.y + dy * 70);
        await settle(1);
      }
      await settle(4);
      await t.up(2);
      await settle(4);
      const b = await P();
      await t.up(1);
      await settle(2);
      kept.push({ nm, d: +Math.hypot(b.x - a.x, b.y - a.y).toFixed(2) });
      cast.push(Object.keys(b.cd).some((k) => (b.cd[k] || 0) > (a.cd[k] || 0) + 0.01));
    }
    rec("cast while moving: movement survives the second finger", Math.min(...kept.map((k) => k.d)) > 0.4,
      kept.map((k) => `${k.nm} ${k.d}t`).join(" / "));
    rec("cast while moving: the aimed cast actually fires", cast.every(Boolean),
      `${cast.filter(Boolean).length}/4 directions produced a cooldown`);
  }

  // ------------------------------------------------- 4. TARGET SELECTION
  {
    await reset();
    const stage = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      const live = st.monsters.filter((m) => m.hp > 0).slice(0, 2);
      live.forEach((m, i) => { m.dormant = false; m.pos.x = p.pos.x + (i ? -2.4 : 2.4); m.pos.y = p.pos.y + (i ? 1.2 : -0.6); });
      window.__mobs = live.map((m) => m.id);
      window.__pin = setInterval(() => {
        const dd = window.__dcc; if (!dd) return;
        const q = dd.state.players[0];
        window.__mobs.forEach((id, i) => {
          const mm = dd.state.monsters.find((x) => x.id === id);
          if (mm) { mm.pos.x = q.pos.x + (i ? -2.4 : 2.4); mm.pos.y = q.pos.y + (i ? 1.2 : -0.6); mm.hp = Math.max(mm.hp, mm.maxHp * 0.5); }
        });
      }, 60);
      return window.__mobs;
    });
    await settle(4);
    const at = (i) => page.evaluate((k) => {
      const d = window.__dcc, m = d.state.monsters.find((x) => x.id === window.__mobs[k]);
      if (!m) return null;
      const s = d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y);
      return { x: Math.round(s.x), y: Math.round(s.y), zone: d.touch.route(Math.round(s.x), Math.round(s.y)).zone, ctl: d.touch.controlAt(Math.round(s.x), Math.round(s.y)) || null, on: s.x > 0 && s.y > 0 && s.x < innerWidth && s.y < innerHeight };
    }, i);
    const a0 = await at(0), a1 = await at(1);
    rec("target: a monster next to the crawler is tappable at all (in the world zone, not under a chip)",
      !!(a0?.on && a0.zone === "world" && !a0.ctl) && !!(a1?.on && a1.zone === "world" && !a1.ctl),
      `mob0 ${JSON.stringify(a0)} mob1 ${JSON.stringify(a1)}`);
    if (a0?.on && a0.zone === "world") {
      await t.down(1, a0.x, a0.y); t.tick(110); await settle(2); await t.up(1); await settle(6);
      const l0 = await page.evaluate(() => {
        const d = window.__dcc, r = d.renderer, lk = r.lockRing;
        return { locked: d.touch.lockedTargetId, vis: !!(lk && lk.visible), at: lk ? { x: +lk.position.x.toFixed(2), y: +lk.position.z.toFixed(2) } : null, want: window.__mobs[0] };
      });
      rec("target: tapping a monster locks it AND draws the lock", l0.vis && l0.locked === l0.want,
        JSON.stringify(l0));
      // switch lock
      const b1 = await at(1);
      if (b1?.on && b1.zone === "world" && !b1.ctl) {
        await t.down(1, b1.x, b1.y); t.tick(110); await settle(2); await t.up(1); await settle(6);
        const l1 = await page.evaluate(() => ({ locked: window.__dcc.touch.lockedTargetId, want: window.__mobs[1] }));
        rec("target: tapping a second monster moves the lock", l1.locked === l1.want, JSON.stringify(l1));
      }
      // clear lock by tapping empty ground in the world zone
      const empty = await page.evaluate(([w, h]) => {
        const d = window.__dcc;
        for (const fy of [0.35, 0.45, 0.28]) for (const fx of [0.55, 0.62, 0.48]) {
          const x = Math.round(w * fx), y = Math.round(h * fy);
          if (!d.touch.controlAt(x, y) && d.touch.route(x, y).zone === "world") return { x, y };
        }
        return null;
      }, [V.width, V.height]);
      if (empty) {
        await t.down(1, empty.x, empty.y); t.tick(110); await settle(2); await t.up(1); await settle(5);
        const l2 = await page.evaluate(() => ({ locked: window.__dcc.touch.lockedTargetId }));
        rec("target: tapping empty ground clears the lock", l2.locked == null, JSON.stringify(l2));
      }
    }
    await page.evaluate(() => { if (window.__pin) clearInterval(window.__pin); });
  }

  // ------------------------------------------------- 5. DODGE UNDER PRESSURE
  {
    // Chip-dash first, then flick-dash, WHILE the stick is already engaged and
    // a pack is on top of the crawler — which is the only situation a dodge
    // ever happens in.
    await reset();
    await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      st.monsters.filter((m) => m.hp > 0).slice(0, 5).forEach((m, k) => {
        m.dormant = false;
        const a = (k / 5) * Math.PI * 2;
        m.pos.x = p.pos.x + Math.cos(a) * 1.5; m.pos.y = p.pos.y + Math.sin(a) * 1.5;
      });
    });
    await settle(3);
    let chipFires = 0, flickFires = 0, falsePos = 0;
    const dashSlot = await page.evaluate(() => {
      const q = window.__dcc.state.players[0];
      const all = (q.abilities.slots || []).concat([q.abilities.ultimate]);
      return all.indexOf("dash");
    });
    for (let k = 0; k < 6; k++) {
      await reset();
      const a = await P();
      const c = chips[`slot${dashSlot >= 0 ? dashSlot : 3}`] ?? chips.slot3;
      await t.down(1, clearGround.x, clearGround.y);
      t.tick(16); await t.move(1, clearGround.x + 60, clearGround.y - 20);
      await settle(2);
      await t.down(2, c.x, c.y);
      t.tick(60); await settle(1);
      await t.up(2);
      await settle(4);
      const b = await P();
      await t.up(1); await settle(2);
      if (b.dash < a.dash || Math.hypot(b.x - a.x, b.y - a.y) > 2.2) chipFires++;
      t.tick(500);
    }
    rec("dodge: the dash chip fires while the stick is held and a pack is on top", chipFires >= 5,
      `${chipFires}/6 reps spent a dash charge (dash in slot ${dashSlot})`);

    for (let k = 0; k < 6; k++) {
      await reset();
      const a = await P();
      // a genuine flick: ~900 px/s over 5 samples, straight
      await t.down(1, clearGround.x, clearGround.y);
      await settle(1);
      for (let i = 1; i <= 5; i++) { t.tick(11); await t.move(1, clearGround.x + i * 10, clearGround.y - i * 4); }
      await settle(3);
      const b = await P();
      await t.up(1); await settle(2);
      if (b.dash < a.dash) flickFires++;
      t.tick(600);
    }
    rec("dodge: flick-to-dash fires under pressure", flickFires >= 5, `${flickFires}/6 flicks spent a charge`);

    // FALSE POSITIVE: a hard turn / thumb stir must NOT dash.
    for (let k = 0; k < 4; k++) {
      await reset();
      const a = await P();
      await t.down(1, clearGround.x, clearGround.y);
      await settle(1);
      const R = 46;
      for (let i = 1; i <= 16; i++) { t.tick(12); const th = (i / 16) * Math.PI * 2.4; await t.move(1, clearGround.x + Math.cos(th) * R, clearGround.y + Math.sin(th) * R); }
      await settle(3);
      const b = await P();
      await t.up(1); await settle(2);
      if (b.dash < a.dash) falsePos++;
      t.tick(600);
    }
    rec("dodge: a hard turn / thumb stir does NOT dash", falsePos === 0, `${falsePos}/4 stirs dashed`);
  }

  // ------------------------------------------------- 6. POTION (3rd finger)
  {
    await reset();
    await page.evaluate(() => { const q = window.__dcc.state.players[0]; q.hp = Math.round(q.maxHp * 0.3); });
    const a = await P();
    const f = chips.flask;
    // hold the stick AND an ability chip, then drink — three live pointers
    await t.down(1, clearGround.x, clearGround.y);
    t.tick(16); await t.move(1, clearGround.x + 60, clearGround.y);
    await settle(2);
    await t.down(2, chips.slot0.x, chips.slot0.y);
    await settle(2);
    await t.down(3, f.x, f.y);
    t.tick(90); await settle(2);
    await t.up(3);
    await settle(6);
    const b = await P();
    await t.up(2); await t.up(1); await settle(2);
    rec("potion: the flask chip drinks as a THIRD simultaneous finger", b.hp > a.hp + 5 || b.flask < a.flask,
      `hp ${a.hp}->${b.hp} (max ${a.maxHp}), charges ${a.flask}->${b.flask}`);
  }

  // ------------------------------------------------- 7. LOOT feedback
  {
    await reset();
    await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      st.loot.push({ id: 99001, kind: "gold", amount: 137, pos: { x: p.pos.x + 0.4, y: p.pos.y + 0.4 } });
    });
    const a = await P();
    // walk a hair so a sim step runs
    await t.down(1, clearGround.x, clearGround.y);
    t.tick(16); await t.move(1, clearGround.x + 30, clearGround.y);
    await settle(8);
    await t.up(1); await settle(4);
    const b = await P();
    const strip = await page.evaluate(() => {
      const e = document.getElementById("pickstrip");
      if (!e) return null;
      const s = getComputedStyle(e), r = e.getBoundingClientRect();
      return { on: s.display !== "none" && +s.opacity > 0.02 && r.width > 0, txt: e.textContent.trim().slice(0, 40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    rec("loot: picking up gold is fed back on screen", b.gold > a.gold && !!strip?.on,
      `gold ${a.gold}->${b.gold}; #pickstrip ${JSON.stringify(strip)}`);
  }

  // ------------------------------------------------- 8. INTERACT
  {
    await reset();
    await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      for (const m of st.monsters) m.hp = 0;
      p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
    });
    await settle(6);
    const ctxChip = await page.evaluate(() => {
      const e = document.getElementById("t-stairs");
      if (!e) return null;
      const s = getComputedStyle(e), r = e.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      const hit = document.elementFromPoint(cx, cy);
      return { on: s.display !== "none" && +s.opacity > 0.05 && r.width > 0, txt: e.textContent.trim().slice(0, 24), x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), hits: hit ? (e.contains(hit) || e === hit) : false, hitEl: hit ? `${hit.tagName}#${hit.id || ""}` : "none" };
    });
    rec("interact: the context chip appears on the stairs with a verb, and a finger hits it",
      !!(ctxChip?.on && ctxChip.hits && ctxChip.txt.length > 0), JSON.stringify(ctxChip));
    if (ctxChip?.on && ctxChip.hits) {
      const floorA = await page.evaluate(() => window.__dcc.state.floor);
      await page.evaluate(() => { clearInterval(window.__keep); });
      await t.down(1, ctxChip.x, ctxChip.y); t.tick(120); await settle(3); await t.up(1);
      await settle(10);
      const after = await page.evaluate(() => ({ floor: window.__dcc.state.floor, safe: !!window.__dcc.state.safeRoom }));
      rec("interact: pressing it actually descends / opens the safe room", after.safe || after.floor !== floorA,
        `floor ${floorA}->${after.floor}, safeRoom=${after.safe}`);
    }
  }

  // ------------------------------------------------- 9. SHOP by finger
  {
    // ensure the safe room is up
    await page.evaluate(() => {
      const d = window.__dcc; const p = d.state.players[0];
      p.gold = 20000;
      for (const m of d.state.monsters) m.hp = 0;
      p.hp = p.maxHp; p.alive = true;
    });
    for (let i = 0; i < 20; i++) {
      const st = await page.evaluate(() => {
        const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
        return { draft: vis("draft"), shop: vis("saferoom") };
      });
      if (st.shop && !st.draft) break;
      if (st.draft) {
        await page.evaluate(() => { const c = document.querySelector("#draft-cards .reward"); if (c) c.click(); });
      } else if (!st.shop) {
        await page.evaluate(() => {
          const d = window.__dcc, st2 = d.state, p = st2.players[0];
          p.pos.x = st2.map.stairs.x + 0.5; p.pos.y = st2.map.stairs.y + 0.5;
          d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60);
        });
      }
      await page.waitForTimeout(500);
    }
    const shopUp = await page.evaluate(() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
    rec("shop: the safe room opened", shopUp, shopUp ? "on screen" : "never appeared");
    if (shopUp) {
      const reachable = (sel) => page.evaluate((s) => {
        for (const e of document.querySelectorAll(s)) {
          const r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
          if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
          const hit = document.elementFromPoint(cx, cy);
          if (!hit || !(e.contains(hit) || e === hit)) continue;
          return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), txt: (e.textContent || "").trim().slice(0, 26) };
        }
        return null;
      }, sel);
      const segAt = (re) => page.evaluate((src) => {
        const e = [...document.querySelectorAll("#saferoom .tp-seg button")].find((x) => new RegExp(src, "i").test(x.textContent));
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) } : null;
      }, re);
      const sh = await segAt("shelf");
      if (sh) { await t.down(1, sh.x, sh.y); t.tick(110); await settle(3); await t.up(1); await settle(6); }
      const tile = await reachable("#sr-shelf .itile[data-id]:not(.locked):not(.soldout)");
      rec("shop: a shelf tile is reachable by a finger", !!tile, tile ? `${tile.w}x${tile.h} at (${tile.x},${tile.y}) "${tile.txt}"` : "no tile hit-tests to itself");
      // how many tiles a phone actually gets to see at once
      const shelfCount = await page.evaluate(() => {
        const all = [...document.querySelectorAll("#sr-shelf .itile")];
        let onScreen = 0;
        for (const e of all) {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth) onScreen++;
        }
        const sc = document.querySelector("#sr-shelf");
        return { total: all.length, onScreen, hiddenScroll: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : null };
      });
      rec("shop: how much of the shelf a finger can see at once", null,
        `${shelfCount.onScreen}/${shelfCount.total} tiles fully on screen, ${shelfCount.hiddenScroll}px of hidden scroll`);
      if (tile) {
        await t.down(1, tile.x, tile.y); t.tick(110); await settle(3); await t.up(1); await settle(8);
        const buy = await reachable("#sr-detail [data-buy]");
        rec("shop: BUY is reachable after selecting a tile", !!buy, buy ? `${buy.w}x${buy.h} at (${buy.x},${buy.y})` : "no reachable [data-buy]");
        if (buy) {
          const a = await P();
          await t.down(1, buy.x, buy.y); t.tick(120); await settle(3); await t.up(1); await settle(10);
          const b = await P();
          rec("shop: a FINGER on BUY spends gold", b.gold !== a.gold, `gold ${a.gold}->${b.gold}, bag ${a.bag}->${b.bag}`);
        }
      }
      // close it with a finger
      const close = await page.evaluate(() => {
        const e = document.querySelector("#saferoom .tp-x, #saferoom .tp-done");
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), hits: hit ? (e.contains(hit) || e === hit) : false, cls: e.className };
      });
      rec("shop: a close control exists and a finger hits it", !!(close && close.hits && close.w >= 40 && close.h >= 40),
        close ? JSON.stringify(close) : "none");
    }
  }

  // ------------------------------------------------- 10. CHARACTER SHEET
  {
    await page.evaluate(() => {
      const sr = document.getElementById("saferoom");
      if (sr && getComputedStyle(sr).display !== "none") {
        const x = sr.querySelector(".tp-x, .tp-done");
        if (x) x.click();
      }
    });
    await settle(6);
    await page.evaluate(() => { window.__keep = setInterval(() => { const d = window.__dcc; if (!d) return; const q = d.state.players[0]; q.hp = q.maxHp; q.alive = true; if (d.state.status !== "playing") d.state.status = "playing"; }, 150); });
    // open it the way a phone player has to
    const openBtn = await page.evaluate(() => {
      for (const sel of ["#t-menu", "#t-sheet", "[data-open='sheet']", "#hud-tr button", "#t-map"]) {
        const e = document.querySelector(sel);
        if (!e) continue;
        const r = e.getBoundingClientRect();
        if (r.width > 0) return { sel, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    });
    let sheetUp = false;
    if (openBtn) {
      await t.down(1, openBtn.x, openBtn.y); t.tick(120); await settle(3); await t.up(1); await settle(6);
      sheetUp = await page.evaluate(() => { const e = document.getElementById("sheet"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
    }
    rec("sheet: there is a touch path to open the character sheet", sheetUp,
      sheetUp ? `opened via ${openBtn.sel}` : `no touch control opened #sheet (tried ${openBtn ? openBtn.sel : "nothing found"})`);
    if (!sheetUp) { await page.keyboard.press("p"); await settle(6); sheetUp = await page.evaluate(() => { const e = document.getElementById("sheet"); return !!e && getComputedStyle(e).display !== "none"; }); }
    if (sheetUp) {
      const geo = await page.evaluate(() => {
        const e = document.getElementById("sheet");
        const r = e.getBoundingClientRect();
        const sc = [...e.querySelectorAll("*")].filter((n) => n.scrollHeight - n.clientHeight > 8 || n.scrollWidth - n.clientWidth > 8)
          .map((n) => ({ cls: (n.className || "").toString().slice(0, 24), sy: Math.round(n.scrollHeight - n.clientHeight), sx: Math.round(n.scrollWidth - n.clientWidth) }));
        const clipped = [...e.querySelectorAll("td,th,.stat,.row")].filter((n) => { const q = n.getBoundingClientRect(); return q.width > 0 && (q.right > innerWidth + 1 || q.bottom > innerHeight + 1); }).length;
        return { box: [Math.round(r.width), Math.round(r.height)], scrollers: sc.slice(0, 6), clipped, vw: innerWidth, vh: innerHeight };
      });
      rec("sheet: its numbers fit / are reachable", geo.clipped === 0,
        `panel ${geo.box.join("x")} in ${geo.vw}x${geo.vh}; ${geo.clipped} cells past the viewport edge; scrollers ${JSON.stringify(geo.scrollers)}`);
      // scroll it with a finger
      if (geo.scrollers.some((s) => s.sy > 8)) {
        const before = await page.evaluate(() => { const e = [...document.querySelectorAll("#sheet *")].find((n) => n.scrollHeight - n.clientHeight > 8); return e ? e.scrollTop : null; });
        const mid = { x: Math.round(V.width * 0.5), y: Math.round(V.height * 0.6) };
        await t.down(1, mid.x, mid.y);
        for (let i = 1; i <= 8; i++) { t.tick(16); await t.move(1, mid.x, mid.y - i * 14); }
        await settle(4); await t.up(1); await settle(4);
        const after = await page.evaluate(() => { const e = [...document.querySelectorAll("#sheet *")].find((n) => n.scrollHeight - n.clientHeight > 8); return e ? e.scrollTop : null; });
        rec("sheet: a finger drag scrolls it", after > before + 5, `scrollTop ${before} -> ${after}`);
      }
      const close = await page.evaluate(() => {
        const e = document.querySelector("#sheet .tp-x, #sheet .tp-done");
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), hits: hit ? (e.contains(hit) || e === hit) : false };
      });
      if (close && close.hits) {
        await t.down(1, close.x, close.y); t.tick(120); await settle(3); await t.up(1); await settle(6);
        const gone = await page.evaluate(() => { const e = document.getElementById("sheet"); return !e || getComputedStyle(e).display === "none"; });
        rec("sheet: a finger closes it", gone, `close ${close.w}x${close.h} at (${close.x},${close.y}); closed=${gone}`);
      } else {
        rec("sheet: a finger closes it", false, `no reachable close control (${JSON.stringify(close)})`);
      }
    }
  }

  // ------------------------------------------------- 11. MODAL MID-AIM
  {
    await reset();
    const c = chips.slot1;
    const pre = await P();
    await t.down(1, c.x, c.y);
    for (let i = 1; i <= 6; i++) { t.tick(16); await t.move(1, c.x - i * 20, c.y - i * 8); }
    await settle(3);
    await page.keyboard.press("i");
    await settle(6);
    await t.up(1);
    await settle(4);
    const mid = await P();
    await page.evaluate(() => { const e = document.querySelector("#inv .tp-x, #inv .tp-done"); if (e) e.click(); });
    await settle(8);
    const post = await P();
    const leakedNow = Object.keys(mid.cd).some((k) => (mid.cd[k] || 0) > (pre.cd[k] || 0) + 0.01);
    const leakedAfter = Object.keys(post.cd).some((k) => (post.cd[k] || 0) > (pre.cd[k] || 0) + 0.01);
    rec("authority: a modal opening mid-aim does not queue a cast that detonates on close",
      !leakedNow && !leakedAfter, `cd pre ${JSON.stringify(pre.cd)} / during ${JSON.stringify(mid.cd)} / after close ${JSON.stringify(post.cd)}`);
  }

  // ------------------------------------------------- 12. WORLD OCCLUSION
  {
    await page.evaluate(() => { const e = document.querySelector("#inv .tp-x, #inv .tp-done"); if (e) e.click(); });
    await reset();
    await settle(4);
    const occ = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      const mons = st.monsters.filter((m) => m.hp > 0);
      let on = 0, hidden = 0;
      for (const m of mons) {
        const s = d.renderer.worldToScreen(m.pos.x, 0.9, m.pos.y);
        if (s.x < 0 || s.y < 0 || s.x > innerWidth || s.y > innerHeight) continue;
        on++;
        const e = document.elementFromPoint(Math.round(s.x), Math.round(s.y));
        if (e && e.tagName !== "CANVAS" && e.id !== "t-stickzone" && e.id !== "t-worldzone" && getComputedStyle(e).pointerEvents !== "none") hidden++;
      }
      // area of the HUD/controls over the viewport
      let area = 0;
      const seen = [];
      for (const e of document.querySelectorAll("#cockpit, #minimap-frame, #hud-tl, #hud-tr, #xpbar, #banner, #ticker, #toasts, #t-stairs, [id^='t-']")) {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        if (s.display === "none" || +s.opacity < 0.05 || r.width < 2 || r.height < 2) continue;
        if (e.id === "t-stickzone" || e.id === "t-worldzone") continue;
        seen.push(e.id || e.className);
        area += Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      }
      return { on, hidden, pct: Math.round((area / (innerWidth * innerHeight)) * 100), seen };
    });
    rec("readability: on-screen monsters not covered by chrome", occ.hidden === 0,
      `${occ.hidden}/${occ.on} visible monsters sit under an opaque HUD element; chrome covers ~${occ.pct}% of the viewport`);
  }

  await page.screenshot({ path: `tools/_mobile/${OUT}-${dev.key}.png` }).catch(() => {});
  await ctx.close();
}
await browser.close();

fs.writeFileSync(`tools/_mobile/${OUT}.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.pass === false);
console.log(`\n==== ${results.filter((r) => r.pass === true).length} PASS / ${fails.length} FAIL / ${results.filter((r) => r.pass === null).length} INFO ====`);
for (const f of fails) console.log(`  FAIL ${f.dev} · ${f.name} — ${f.detail}`);
