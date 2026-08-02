// ACCEPTANCE ROUND 3 — independent critic battery, pass 2.
// Pass 1's own mistakes are corrected here: the cancel affordance is
// #t-ocancel/#t-cancel (not #t-cancel* guesses), the walk test runs in open
// floor instead of into a wall, the flick clears the layer's own net-travel
// latch, loot comes from a real kill, and every silent cast is read back
// through debug.touch.verdicts() instead of being inferred from a cooldown.
import { chromium, devices } from "playwright";
import fs from "node:fs";

const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const ONLY = process.argv[2];
const OUT = process.argv[3] ?? "acc3b";
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
  await page.waitForTimeout(2500);
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
  const vis = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const st = getComputedStyle(e), r = e.getBoundingClientRect();
    return { on: st.display !== "none" && st.visibility !== "hidden" && +st.opacity > 0.02 && r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), op: +st.opacity, cls: (e.className || "").toString().slice(0, 30) };
  }, sel);

  // ------------------------------------------------- 0. COLD START
  {
    const body = await page.evaluate(() => ({ cls: document.body.className, layer: getComputedStyle(document.getElementById("t-layer")).display }));
    const ghost = await vis("#t-ghost");
    rec("cold start: a resting stick affordance is on screen before any finger lands",
      !!ghost?.on, `#t-ghost ${JSON.stringify(ghost)}; body="${body.cls}" #t-layer display=${body.layer}`);
    // What can a phone player press, at rest, without knowing the keyboard?
    const nav = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll("button, [role='button'], [data-tctl], .chip, #t-map, #t-lock, #t-stairs")) {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        if (s.display === "none" || s.visibility === "hidden" || +s.opacity < 0.05 || r.width < 4 || r.height < 4) continue;
        if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
        const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        out.push({ id: e.id || (e.className || "").toString().slice(0, 18), txt: (e.textContent || "").trim().slice(0, 14), w: Math.round(r.width), h: Math.round(r.height), hits: hit ? (e.contains(hit) || e === hit) : false });
      }
      return out;
    });
    rec("cold start: the touch controls a player can actually press at rest", null, JSON.stringify(nav));
  }

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
    out._zones = { aimThrow: Math.round(z.aimThrow), cancelRadius: Math.round(z.cancelRadius), R: Math.round(z.stickRadius ?? 0), cancelMode: z.cancelMode };
    return out;
  });
  console.log("  chips:", JSON.stringify(chips));
  const clearGround = await page.evaluate(([w, h]) => {
    const d = window.__dcc;
    for (const fy of [0.80, 0.70, 0.88, 0.60]) for (const fx of [0.26, 0.18, 0.34, 0.10]) {
      const x = Math.round(w * fx), y = Math.round(h * fy);
      if (!d.touch.controlAt(x, y) && d.touch.route(x, y).zone === "stick") return { x, y };
    }
    return null;
  }, [V.width, V.height]);

  // Park the crawler in the middle of the biggest room so a wall is never the
  // reason a direction reads as zero.
  const openRoom = await page.evaluate(() => {
    const st = window.__dcc.state, p = st.players[0];
    const rooms = st.map.rooms || [];
    let best = null;
    for (const r of rooms) { const a = (r.w || 0) * (r.h || 0); if (!best || a > best.a) best = { a, r }; }
    if (best) { p.pos.x = best.r.x + best.r.w / 2; p.pos.y = best.r.y + best.r.h / 2; }
    for (const m of st.monsters) m.hp = 0;
    return best ? { w: best.r.w, h: best.r.h, x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1) } : null;
  });
  await settle(6);
  console.log("  open room:", JSON.stringify(openRoom));

  // ------------------------------------------------- 1. WALK
  {
    const R = chips._zones.R || 60;
    const dirs = [[1, 0, "E"], [0.71, 0.71, "SE"], [0, 1, "S"], [-0.71, 0.71, "SW"], [-1, 0, "W"], [-0.71, -0.71, "NW"], [0, -1, "N"], [0.71, -0.71, "NE"]];
    const rows = [];
    for (const [dx, dy, name] of dirs) {
      await page.evaluate(([rx, ry]) => { const p = window.__dcc.state.players[0]; p.pos.x = rx; p.pos.y = ry; }, [openRoom.x, openRoom.y]);
      await reset();
      await settle(2);
      const a = await P();
      const s0 = await page.evaluate(() => { const d = window.__dcc, q = d.state.players[0]; const s = d.renderer.worldToScreen(q.pos.x, 0, q.pos.y); return { x: s.x, y: s.y }; });
      await t.down(1, clearGround.x, clearGround.y);
      for (let i = 1; i <= 6; i++) { t.tick(16); await t.move(1, clearGround.x + dx * R, clearGround.y + dy * R); await settle(1); }
      await settle(5);
      const b = await P();
      const s1 = await page.evaluate(() => { const d = window.__dcc, q = d.state.players[0]; const s = d.renderer.worldToScreen(q.pos.x, 0, q.pos.y); return { x: s.x, y: s.y }; });
      await t.up(1); await settle(2);
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      // Screen fidelity: the CAMERA follows, so compare world displacement
      // rotated into screen space via the renderer's own basis instead.
      const wd = { x: b.x - a.x, y: b.y - a.y };
      const proj = await page.evaluate(([ax, ay, bx, by]) => {
        const r = window.__dcc.renderer;
        const p0 = r.worldToScreen(ax, 0, ay), p1 = r.worldToScreen(bx, 0, by);
        return { dx: p1.x - p0.x, dy: p1.y - p0.y };
      }, [a.x, a.y, b.x, b.y]);
      let err = null;
      if (Math.hypot(proj.dx, proj.dy) > 6) {
        const want = Math.atan2(dy, dx), got = Math.atan2(proj.dy, proj.dx);
        err = +(Math.abs(((got - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 180 / Math.PI).toFixed(1);
      }
      rows.push({ name, moved: +moved.toFixed(2), err, s0, s1, wd });
    }
    const worstT = Math.min(...rows.map((r) => r.moved));
    const errs = rows.filter((r) => r.err != null).map((r) => r.err);
    rec("walk: the stick moves the crawler in all 8 directions (open floor)", worstT > 0.5,
      rows.map((r) => `${r.name} ${r.moved}t`).join(" / "));
    rec("walk: the crawler goes where the thumb pushed (screen-space angular error)",
      errs.length === 8 && Math.max(...errs) < 20,
      `${errs.length}/8 measurable, worst ${errs.length ? Math.max(...errs) : "n/a"}° — ${rows.map((r) => `${r.name} ${r.err ?? "n/a"}`).join(" / ")}`);
  }

  // ------------------------------------------------- 2. AIM + CANCEL
  {
    await reset();
    const c = chips.slot1;
    await t.down(1, c.x, c.y);
    await settle(2);
    const onDown = await page.evaluate(() => {
      const i = window.__dcc.renderer.aimIndicator;
      return { exists: !!i, visible: !!(i && i.visible) };
    });
    for (let i = 1; i <= 6; i++) { t.tick(16); await t.move(1, c.x - i * 18, c.y - i * 10); }
    await settle(3);
    const cancelUi = await page.evaluate(() => {
      const out = {};
      for (const id of ["t-ocancel", "t-cancel"]) {
        const e = document.getElementById(id);
        if (!e) { out[id] = null; continue; }
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        out[id] = { on: s.display !== "none" && +s.opacity > 0.05 && r.width > 0, op: +s.opacity, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: e.className };
      }
      return out;
    });
    rec("aim: the indicator appears on pointerdown", onDown.visible, JSON.stringify(onDown));
    rec("aim: a cancel affordance is DRAWN while aiming", !!(cancelUi["t-ocancel"]?.on || cancelUi["t-cancel"]?.on), JSON.stringify(cancelUi));
    // cancel by returning inside cancelRadius of the frozen origin
    const pre = await P();
    for (let i = 6; i >= 0; i--) { t.tick(16); await t.move(1, c.x - i * 3, c.y - i * 2); }
    await settle(3);
    const armed = await page.evaluate(() => {
      const e = document.getElementById("t-ocancel");
      return e ? { cls: e.className, armed: e.classList.contains("armed") } : null;
    });
    await t.up(1);
    await settle(5);
    const post = await P();
    const anyCd = Object.keys(post.cd).some((k) => (post.cd[k] || 0) > (pre.cd[k] || 0) + 0.01);
    rec("aim: returning to the origin cancels, and the affordance lights first", !anyCd && !!armed?.armed,
      `cd ${JSON.stringify(pre.cd)}->${JSON.stringify(post.cd)}, ✕ ${JSON.stringify(armed)}`);
    await t.clear();
  }

  // ------------------------------------------------- 3. CAST WHILE MOVING
  {
    const kept = [], verdicts = [];
    for (const [dx, dy, nm] of [[1, 0, "E"], [-1, 0, "W"], [0, 1, "S"], [0, -1, "N"]]) {
      await reset();
      await page.evaluate(() => window.__dcc.touch.clearVerdicts());
      const a = await P();
      await t.down(1, clearGround.x, clearGround.y);
      t.tick(16); await t.move(1, clearGround.x + dx * 70, clearGround.y + dy * 70);
      await settle(3);
      const c = chips.slot2;
      await t.down(2, c.x, c.y);
      for (let i = 1; i <= 6; i++) {
        t.tick(16);
        await t.move(2, c.x - i * 18, c.y - i * 8);
        await t.move(1, clearGround.x + dx * 70, clearGround.y + dy * 70);
        await settle(1);
      }
      await settle(4);
      await t.up(2);
      await settle(5);
      const b = await P();
      await t.up(1); await settle(2);
      const v = await page.evaluate(() => window.__dcc.touch.verdicts());
      kept.push({ nm, d: +Math.hypot(b.x - a.x, b.y - a.y).toFixed(2) });
      verdicts.push(v.map((e) => e.kind).join(",") || "none");
    }
    rec("cast while moving: movement survives the second finger", Math.min(...kept.map((k) => k.d)) > 0.4, kept.map((k) => `${k.nm} ${k.d}t`).join(" / "));
    rec("cast while moving: the layer's own verdict for the aimed cast", verdicts.every((v) => v.includes("aimed")), `verdicts per direction: ${verdicts.join(" | ")}`);
  }

  // ------------------------------------------------- 4. TARGETING REACH
  {
    await reset();
    // Where, around the crawler, can a finger tap at all? 16 bearings, 2 radii.
    const arc = await page.evaluate(() => {
      const d = window.__dcc, q = d.state.players[0], out = [];
      for (const rad of [2.5, 4.5]) {
        let ok = 0, tot = 0, blocked = [];
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          const wx = q.pos.x + Math.cos(a) * rad, wy = q.pos.y + Math.sin(a) * rad;
          const s = d.renderer.worldToScreen(wx, 0.8, wy);
          tot++;
          const x = Math.round(s.x), y = Math.round(s.y);
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { blocked.push("offscreen"); continue; }
          const ctl = d.touch.controlAt(x, y);
          const zone = d.touch.route(x, y).zone;
          if (!ctl && zone === "world") ok++; else blocked.push(ctl || zone);
        }
        out.push({ rad, ok, tot, blocked });
      }
      return out;
    });
    rec("target: how much of the ring around the crawler is world-tappable", arc.every((a) => a.ok >= 12),
      arc.map((a) => `r=${a.rad}: ${a.ok}/${a.tot} tappable [${[...new Set(a.blocked)].join(",")}]`).join(" | "));

    // Lock a monster that IS in the world zone.
    const placed = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, q = st.players[0];
      const m = st.monsters[0];
      if (!m) return null;
      m.hp = m.maxHp; m.dormant = false;
      // search a bearing whose projection lands in the world zone
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const wx = q.pos.x + Math.cos(a) * 3.2, wy = q.pos.y + Math.sin(a) * 3.2;
        const s = d.renderer.worldToScreen(wx, 0.8, wy);
        const x = Math.round(s.x), y = Math.round(s.y);
        if (x < 20 || y < 20 || x > innerWidth - 20 || y > innerHeight - 20) continue;
        if (d.touch.controlAt(x, y) || d.touch.route(x, y).zone !== "world") continue;
        m.pos.x = wx; m.pos.y = wy;
        window.__mob = m.id;
        window.__pin = setInterval(() => {
          const dd = window.__dcc; const mm = dd.state.monsters.find((z) => z.id === window.__mob);
          if (mm) { mm.pos.x = wx; mm.pos.y = wy; mm.hp = Math.max(mm.hp, mm.maxHp * 0.6); mm.dormant = false; }
        }, 60);
        return { x, y, id: m.id };
      }
      return null;
    });
    await settle(4);
    if (!placed) rec("target: tapping a monster locks it AND draws the lock", false, "no bearing at 3.2 tiles projects into the world zone");
    else {
      await t.down(1, placed.x, placed.y); t.tick(120); await settle(2); await t.up(1); await settle(7);
      const l = await page.evaluate(() => {
        const d = window.__dcc, r = d.renderer, lk = r.lockRing;
        return { locked: d.touch.lockedTargetId, want: window.__mob, vis: !!(lk && lk.visible), at: lk ? { x: +lk.position.x.toFixed(2), y: +lk.position.z.toFixed(2) } : null };
      });
      rec("target: tapping a monster locks it AND draws the lock", l.vis && l.locked === l.want, JSON.stringify({ ...l, tappedAt: placed }));
      // and the LOCK chip reflects it
      const lockChip = await vis("#t-lock");
      rec("target: the LOCK chip shows the lock state", !!(lockChip?.on && /on/.test(lockChip.cls)), JSON.stringify(lockChip));
    }
    await page.evaluate(() => { if (window.__pin) clearInterval(window.__pin); });
  }

  // ------------------------------------------------- 5. DODGE
  {
    const dashSlot = await page.evaluate(() => {
      const q = window.__dcc.state.players[0];
      return (q.abilities.slots || []).concat([q.abilities.ultimate]).indexOf("dash");
    });
    await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      st.monsters.slice(0, 5).forEach((m, k) => {
        m.hp = m.maxHp; m.dormant = false;
        const a = (k / 5) * Math.PI * 2;
        m.pos.x = p.pos.x + Math.cos(a) * 1.5; m.pos.y = p.pos.y + Math.sin(a) * 1.5;
      });
    });
    let chipFires = 0;
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
      if (b.dash < a.dash) chipFires++;
      t.tick(500);
    }
    rec("dodge: the dash chip fires while the stick is held and a pack is on top", chipFires >= 5, `${chipFires}/6 reps spent a charge (dash in slot ${dashSlot})`);

    const R = chips._zones.R || 60;
    // Flick amplitude sweep: how big a flick does this layer demand?
    const sweep = [];
    for (const netR of [0.8, 1.2, 1.6, 2.2]) {
      let fired = 0;
      for (let k = 0; k < 4; k++) {
        await reset();
        const a = await P();
        const total = netR * R;
        await t.down(1, clearGround.x, clearGround.y);
        await settle(1);
        for (let i = 1; i <= 6; i++) { t.tick(11); await t.move(1, clearGround.x + (total / 6) * i, clearGround.y - (total / 6) * i * 0.35); }
        await settle(3);
        const b = await P();
        await t.up(1); await settle(2);
        if (b.dash < a.dash) fired++;
        t.tick(700);
      }
      sweep.push({ netR, fired });
    }
    rec("dodge: flick-to-dash fires at a realistic thumb amplitude",
      (sweep.find((s) => s.netR === 1.2)?.fired ?? 0) >= 3,
      sweep.map((s) => `${s.netR}R: ${s.fired}/4`).join(" / ") + ` (R=${R}px, so 1.2R = ${Math.round(1.2 * R)}px of thumb travel)`);

    let falsePos = 0;
    for (let k = 0; k < 4; k++) {
      await reset();
      const a = await P();
      await t.down(1, clearGround.x, clearGround.y);
      await settle(1);
      for (let i = 1; i <= 16; i++) { t.tick(12); const th = (i / 16) * Math.PI * 2.4; await t.move(1, clearGround.x + Math.cos(th) * 46, clearGround.y + Math.sin(th) * 46); }
      await settle(3);
      const b = await P();
      await t.up(1); await settle(2);
      if (b.dash < a.dash) falsePos++;
      t.tick(700);
    }
    rec("dodge: a hard turn / thumb stir does NOT dash", falsePos === 0, `${falsePos}/4 stirs dashed`);
  }

  // ------------------------------------------------- 6. REFUSAL FEEDBACK
  {
    await reset();
    await page.evaluate(() => { const q = window.__dcc.state.players[0]; q.cd.bolt = 6; q.cd[Object.keys(q.cd)[0]] = 6; q.dashCharges = 0; });
    await page.evaluate(() => window.__dcc.touch.clearVerdicts());
    const dashSlot = await page.evaluate(() => {
      const q = window.__dcc.state.players[0];
      return (q.abilities.slots || []).concat([q.abilities.ultimate]).indexOf("dash");
    });
    const c = chips[`slot${dashSlot >= 0 ? dashSlot : 1}`];
    await t.down(1, c.x, c.y);
    await settle(2);
    const shakeOrInd = await page.evaluate(() => {
      const i = window.__dcc.renderer.aimIndicator;
      const chip = document.querySelector("#skills .chip.shake, #cockpit .shake, .refuse, .t-refuse");
      return { indicatorVisible: !!(i && i.visible), shakeEl: chip ? (chip.id || chip.className) : null };
    });
    await t.up(1); await settle(3);
    const v = await page.evaluate(() => window.__dcc.touch.verdicts());
    rec("feel: pressing a chip with no charge is REFUSED, not silently swallowed",
      v.some((e) => /refus/i.test(e.kind)) && !shakeOrInd.indicatorVisible,
      `verdicts ${JSON.stringify(v.map((e) => e.kind))}, indicator drawn on a dead chip=${shakeOrInd.indicatorVisible}, shake el=${shakeOrInd.shakeEl}`);
  }

  // ------------------------------------------------- 7. LOOT (real kill)
  {
    await reset();
    const a = await P();
    await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      const m = st.monsters.find((x) => x.hp > 0) || st.monsters[0];
      if (m) { m.dormant = false; m.pos.x = p.pos.x + 0.9; m.pos.y = p.pos.y; m.hp = 1; }
      window.__target = m ? m.id : null;
    });
    await settle(2);
    // kill it with the basic-attack chip, held
    await t.down(1, chips.slot0.x, chips.slot0.y);
    for (let i = 0; i < 10; i++) { t.tick(90); await settle(2); }
    await t.up(1); await settle(6);
    // then walk over whatever dropped
    const drop = await page.evaluate(() => {
      const st = window.__dcc.state;
      return st.loot.length ? { n: st.loot.length, kind: st.loot[0].kind } : { n: 0 };
    });
    await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      if (st.loot.length) { p.pos.x = st.loot[0].pos.x; p.pos.y = st.loot[0].pos.y; }
    });
    await t.down(1, clearGround.x, clearGround.y);
    t.tick(16); await t.move(1, clearGround.x + 20, clearGround.y);
    await settle(8);
    await t.up(1); await settle(4);
    const b = await P();
    const strip = await vis("#pickstrip");
    rec("loot: a kill drops, the crawler collects, and the pickup is fed back",
      (b.gold > a.gold || b.bag > a.bag) && !!strip?.on,
      `drops ${JSON.stringify(drop)}; gold ${a.gold}->${b.gold} bag ${a.bag}->${b.bag}; #pickstrip ${JSON.stringify(strip)}`);
  }

  // ------------------------------------------------- 8. INTERACT
  {
    await reset();
    const diag = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      for (const m of st.monsters) m.hp = 0;
      p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
      return { stairs: st.map.stairs, pos: { x: p.pos.x, y: p.pos.y } };
    });
    await settle(10);
    const chip = await page.evaluate(() => {
      const e = document.getElementById("t-stairs");
      if (!e) return null;
      const s = getComputedStyle(e), r = e.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      const hit = r.width > 0 ? document.elementFromPoint(cx, cy) : null;
      return { on: s.display !== "none" && +s.opacity > 0.05 && r.width > 0, display: s.display, cls: e.className, txt: (e.textContent || "").trim(), x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), hits: hit ? (e.contains(hit) || e === hit) : false, body: document.body.className.slice(0, 40) };
    });
    rec("interact: the context chip appears on the stairs and a finger hits it",
      !!(chip?.on && chip.hits && chip.w >= 44 && chip.h >= 44),
      JSON.stringify({ ...chip, diag }));
    if (chip?.on && chip.hits) {
      const f0 = await page.evaluate(() => window.__dcc.state.floor);
      await page.evaluate(() => clearInterval(window.__keep));
      await t.down(1, chip.x, chip.y); t.tick(130); await settle(3); await t.up(1);
      await settle(12);
      const after = await page.evaluate(() => ({ floor: window.__dcc.state.floor, safe: !!window.__dcc.state.safeRoom }));
      rec("interact: pressing it descends / opens the safe room", after.safe || after.floor !== f0, `floor ${f0}->${after.floor}, safeRoom=${after.safe}`);
    }
  }

  // ------------------------------------------------- 9. SHOP
  {
    await page.evaluate(() => { window.__dcc.state.players[0].gold = 20000; });
    for (let i = 0; i < 20; i++) {
      const st = await page.evaluate(() => {
        const v = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
        return { draft: v("draft"), shop: v("saferoom") };
      });
      if (st.shop && !st.draft) break;
      if (st.draft) await page.evaluate(() => { const c = document.querySelector("#draft-cards .reward"); if (c) c.click(); });
      else if (!st.shop) await page.evaluate(() => {
        const d = window.__dcc, st2 = d.state, p = st2.players[0];
        p.pos.x = st2.map.stairs.x + 0.5; p.pos.y = st2.map.stairs.y + 0.5;
        d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60);
      });
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
      rec("shop: a shelf tile is reachable by a finger", !!tile, tile ? `${tile.w}x${tile.h} at (${tile.x},${tile.y}) "${tile.txt}"` : "none");
      const nav = await page.evaluate(() => {
        const all = [...document.querySelectorAll("#sr-shelf .itile")];
        let on = 0;
        for (const e of all) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth) on++; }
        const rows = [...document.querySelectorAll("#saferoom .tp-seg, #saferoom .tabs, #saferoom .srtabs")].length;
        const panel = document.getElementById("saferoom").getBoundingClientRect();
        const navPx = [...document.querySelectorAll("#saferoom .tp-seg, #saferoom .tabs, #saferoom .srtabs, #saferoom .tp-x, #saferoom .tp-done")]
          .reduce((s, e) => s + e.getBoundingClientRect().height, 0);
        return { on, total: all.length, rows, navPct: Math.round((navPx / panel.height) * 100) };
      });
      rec("shop: how much shelf a finger sees at once", null, `${nav.on}/${nav.total} tiles fully on screen; ${nav.rows} rows of navigation eating ~${nav.navPct}% of the panel height`);
      if (tile) {
        await t.down(1, tile.x, tile.y); t.tick(110); await settle(3); await t.up(1); await settle(8);
        const buy = await reachable("#sr-detail [data-buy]");
        rec("shop: BUY is reachable after selecting a tile", !!buy, buy ? `${buy.w}x${buy.h} at (${buy.x},${buy.y})` : "none");
        if (buy) {
          const a = await P();
          await t.down(1, buy.x, buy.y); t.tick(120); await settle(3); await t.up(1); await settle(10);
          const b = await P();
          rec("shop: a FINGER on BUY spends gold", b.gold !== a.gold, `gold ${a.gold}->${b.gold}`);
        }
      }
      const exits = await page.evaluate(() => {
        const out = [];
        for (const e of document.querySelectorAll("#saferoom button, #saferoom .tp-x, #saferoom .tp-done")) {
          const txt = (e.textContent || "").trim();
          if (!/descend|leave|close|done|✕|×/i.test(txt) && !/tp-x|tp-done/.test(e.className)) continue;
          const r = e.getBoundingClientRect();
          if (r.width <= 0) continue;
          const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
          const hit = document.elementFromPoint(cx, cy);
          out.push({ txt: txt.slice(0, 18), w: Math.round(r.width), h: Math.round(r.height), x: cx, y: cy, hits: hit ? (e.contains(hit) || e === hit) : false });
        }
        return out;
      });
      rec("shop: there is a reachable way out", exits.some((e) => e.hits && e.h >= 40), JSON.stringify(exits));
      const ex = exits.find((e) => e.hits);
      if (ex) { await t.down(1, ex.x, ex.y); t.tick(130); await settle(3); await t.up(1); await settle(10); }
      const gone = await page.evaluate(() => { const e = document.getElementById("saferoom"); return !e || getComputedStyle(e).display === "none"; });
      rec("shop: a finger actually leaves it", gone, `#saferoom closed=${gone}`);
    }
    await page.evaluate(() => { clearInterval(window.__keep); window.__keep = setInterval(() => { const d = window.__dcc; if (!d) return; const q = d.state.players[0]; q.hp = q.maxHp; q.alive = true; if (d.state.status !== "playing") d.state.status = "playing"; }, 150); });
  }

  // ------------------------------------------------- 10. CHARACTER SHEET
  {
    await settle(4);
    const opener = await page.evaluate(() => {
      // Anything a finger can press that leads to the sheet.
      const cands = [];
      for (const e of document.querySelectorAll("button,[data-tctl],[data-panel],#t-map,#t-lock")) {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        if (s.display === "none" || +s.opacity < 0.05 || r.width < 6) continue;
        if (r.left > innerWidth || r.top > innerHeight || r.right < 0 || r.bottom < 0) continue;
        cands.push({ id: e.id || (e.className || "").toString().slice(0, 16), txt: (e.textContent || "").trim().slice(0, 12), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }
      return cands;
    });
    let sheetUp = false, via = null;
    for (const cand of opener) {
      await t.down(1, cand.x, cand.y); t.tick(120); await settle(2); await t.up(1); await settle(5);
      const up = await page.evaluate(() => {
        const v = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
        return { sheet: v("sheet"), menu: v("menu"), inv: v("inv"), abil: v("abil") };
      });
      if (up.sheet) { sheetUp = true; via = cand; break; }
      if (up.menu || up.inv || up.abil) {
        // one level deeper: is the sheet reachable from whatever opened?
        const deep = await page.evaluate(() => {
          const host = ["menu", "inv", "abil"].map((id) => document.getElementById(id)).find((e) => e && getComputedStyle(e).display !== "none");
          if (!host) return null;
          const b = [...host.querySelectorAll("button,.tp-seg button")].find((x) => /sheet|character|crawler|stats/i.test(x.textContent || ""));
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), txt: b.textContent.trim().slice(0, 14) };
        });
        if (deep) {
          await t.down(1, deep.x, deep.y); t.tick(120); await settle(2); await t.up(1); await settle(5);
          const up2 = await page.evaluate(() => { const e = document.getElementById("sheet"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
          if (up2) { sheetUp = true; via = { ...cand, then: deep.txt }; break; }
        }
        await page.evaluate(() => { for (const id of ["menu", "inv", "abil"]) { const e = document.getElementById(id); if (e && getComputedStyle(e).display !== "none") { const x = e.querySelector(".tp-x,.tp-done"); if (x) x.click(); } } });
        await settle(4);
      }
    }
    rec("sheet: a phone player can open the character sheet with a finger", sheetUp,
      sheetUp ? `opened via ${JSON.stringify(via)}` : `tried ${opener.length} pressable controls: ${JSON.stringify(opener.map((o) => o.id + ":" + o.txt))}`);
    if (!sheetUp) { await page.keyboard.press("p"); await settle(8); sheetUp = await page.evaluate(() => { const e = document.getElementById("sheet"); return !!e && getComputedStyle(e).display !== "none"; }); }
    if (sheetUp) {
      const geo = await page.evaluate(() => {
        const e = document.getElementById("sheet"), r = e.getBoundingClientRect();
        const sc = [...e.querySelectorAll("*")].filter((n) => n.scrollHeight - n.clientHeight > 8 || n.scrollWidth - n.clientWidth > 8)
          .map((n) => ({ cls: (n.className || "").toString().slice(0, 20), sy: Math.round(n.scrollHeight - n.clientHeight), sx: Math.round(n.scrollWidth - n.clientWidth) }));
        const clipped = [...e.querySelectorAll("td,th,.stat,.row,.srow")].filter((n) => { const q = n.getBoundingClientRect(); return q.width > 0 && (q.right > innerWidth + 1 || q.left < -1); }).length;
        return { box: [Math.round(r.width), Math.round(r.height)], sc: sc.slice(0, 5), clipped, vw: innerWidth, vh: innerHeight };
      });
      rec("sheet: nothing is clipped off the side of the glass", geo.clipped === 0,
        `panel ${geo.box.join("x")} in ${geo.vw}x${geo.vh}; ${geo.clipped} cells past a horizontal edge; scrollers ${JSON.stringify(geo.sc)}`);
      const close = await page.evaluate(() => {
        const e = document.querySelector("#sheet .tp-x, #sheet .tp-done");
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), hits: hit ? (e.contains(hit) || e === hit) : false, hitEl: hit ? (hit.id || hit.className || "").toString().slice(0, 20) : "none" };
      });
      if (close && close.hits) {
        await t.down(1, close.x, close.y); t.tick(130); await settle(3); await t.up(1); await settle(8);
        const gone = await page.evaluate(() => { const e = document.getElementById("sheet"); return !e || getComputedStyle(e).display === "none"; });
        rec("sheet: a finger closes it", gone, `close ${close.w}x${close.h} at (${close.x},${close.y}); closed=${gone}`);
      } else rec("sheet: a finger closes it", false, `close control not hit-testable: ${JSON.stringify(close)}`);
    }
  }

  await page.screenshot({ path: `tools/_mobile/${OUT}-${dev.key}.png` }).catch(() => {});
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`tools/_mobile/${OUT}.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.pass === false);
console.log(`\n==== ${results.filter((r) => r.pass === true).length} PASS / ${fails.length} FAIL / ${results.filter((r) => r.pass === null).length} INFO ====`);
for (const f of fails) console.log(`  FAIL ${f.dev} · ${f.name} — ${f.detail}`);
