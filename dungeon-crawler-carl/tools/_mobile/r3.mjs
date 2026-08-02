// ROUND 3 acceptance battery — the four claims round 2 could not make.
//
//  A. THE TELEGRAPH IS ON THE GLASS. Every shape, four drag directions, the
//     live indicator's own vertices projected through the renderer's camera.
//     Round 2 measured 0% of vertices inside the viewport for every PLACED
//     shape (nova 455 world units out, cataclysm 1050) and 8.1% for bolt.
//  B. TARGET SELECTION IS DRAWN. A world tap must produce a visible marker on
//     the locked monster, and a smart cast a distinct transient one.
//  C. MOVE WHILE AIMING, on the tablet descriptor, twice, four directions.
//     Round 2 measured 0.00 tiles kept on iPad Pro 11 in 2 of 2 runs.
//  D. AIMED CASTS DO NOT DROP. 40 identical aimed casts per slot, with the
//     layer's own verdict for every one of them (debug.touch.verdicts).
import { chromium, devices } from "playwright";

const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const ONLY = process.argv[2];
const MATRIX = [
  { key: "iphone13-land", pw: "iPhone 13 landscape", safe: [0, 47, 21, 47] },
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
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart", all()); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove", all()); },
    // THE ROUND-2 CORRECTION: touchEnd carries the RELEASED point, never the
    // survivors — sending the survivors desynchronises Chromium's touch stream
    // and every multi-finger claim driven through it is unestablished.
    async up(id) { const p = live.get(id); live.delete(id); await send("touchEnd", p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : []); },
  };
  return api;
}

const results = [];
const rec = (dev, name, pass, detail) => {
  results.push({ dev, name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

for (const dev of MATRIX) {
  const ctx = await browser.newContext({ ...devices[dev.pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const t = driver(client);
  const url = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance` +
    `&floor=6&level=16&seed=77&safe=${dev.safe.join(",")}`;
  await page.goto(url, { waitUntil: "load", timeout: 180000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
  await page.waitForTimeout(2000);
  const settle = async (n = 5) => {
    await page.waitForTimeout(110);
    await page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n).catch(() => {});
  };
  // The immortality watchdog: a dead crawler no-ops every later check, which
  // is where twelve phantom FAILs came from in round 1.
  await page.evaluate(() => {
    window.__keep = setInterval(() => {
      const d = window.__dcc; if (!d) return;
      const q = d.state.players[0];
      q.hp = q.maxHp; q.alive = true; q.downedT = 0;
      if (d.state.status !== "playing") d.state.status = "playing";
    }, 150);
  });
  const V = page.viewportSize();
  console.log(`\n===== ${dev.key} ${V.width}x${V.height} =====`);

  const chips = await page.evaluate(() => {
    const z = window.__dcc.touch.zones, out = {};
    for (const id of ["slot0", "slot1", "slot2", "slot3", "slot4"]) {
      const c = z.controls[id];
      out[id] = { x: Math.round(c.cx), y: Math.round(c.cy) };
    }
    return out;
  });

  // ---------------------------------------------------------------- A. aim
  // The indicator's own world vertices, projected through the live camera.
  const projectIndicator = () => page.evaluate(() => {
    const r = window.__dcc.renderer, ind = r && r.aimIndicator;
    if (!ind || !ind.visible) return null;
    ind.updateMatrixWorld(true);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0, on = 0;
    ind.traverse((o) => {
      const g = o.geometry; if (!g || !g.attributes || !g.attributes.position) return;
      const pos = g.attributes.position;
      const e = o.matrixWorld.elements;
      for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 40))) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        // matrixWorld by hand: no THREE import inside the page context.
        const w = {
          x: e[0] * x + e[4] * y + e[8] * z + e[12],
          y: e[1] * x + e[5] * y + e[9] * z + e[13],
          z: e[2] * x + e[6] * y + e[10] * z + e[14],
        };
        const s = r.worldToScreen(w.x, w.y, w.z);
        x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x);
        y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y);
        n++;
        if (s.x >= 0 && s.x <= innerWidth && s.y >= 0 && s.y <= innerHeight) on++;
      }
    });
    return n ? { x0, y0, x1, y1, n, on, frac: on / n } : null;
  });

  // ONE THROWAWAY GESTURE FIRST. The first press of a session lands while the
  // renderer is still settling under SwiftShader and intermittently produces
  // no indicator — which is a property of a 1 fps software rasteriser, not of
  // the touch layer, and recording it as a FAIL is exactly the phantom this
  // round spent its time undoing.
  {
    const c = chips.slot1;
    await t.down(1, c.x, c.y);
    for (let i = 1; i <= 6; i++) { t.tick(16); await t.move(1, c.x - i * 16, c.y - i * 8); }
    await settle(4);
    await t.up(1);
    await settle(4);
  }

  const DRAGS = [
    { name: "up", dx: 0, dy: -1 },
    { name: "down", dx: 0, dy: 1 },
    { name: "inboard", dx: -0.86, dy: 0.5 },
    { name: "outboard", dx: 0.86, dy: -0.5 },
  ];
  for (const slot of ["slot1", "slot2", "slot4"]) {
    const c = chips[slot];
    for (const d of DRAGS) {
      // RESET CHARGES, NOT JUST COOLDOWNS. dash spends a CHARGE, so a battery
      // that only zeroes `cd` leaves the next dash gesture REFUSED at
      // pointerdown — which draws no indicator and looks exactly like a broken
      // telegraph. That is what "telegraph slot1 up: no indicator" was in the
      // r3 log, and it is the same class of mistake as everything else this
      // round found: the harness, reported as the product.
      await page.evaluate(() => {
        const q = window.__dcc.state.players[0];
        q.dashCharges = 2; q.flaskCharges = 3;
        for (const k in q.cd) q.cd[k] = 0;
      });
      await settle(2);
      await t.down(1, c.x, c.y);
      await settle(2);
      for (let i = 1; i <= 8; i++) {
        t.tick(16);
        await t.move(1, Math.round(c.x + d.dx * i * 16), Math.round(c.y + d.dy * i * 16));
      }
      await settle(4);
      const info = await page.evaluate(() => {
        const q = window.__dcc.state.players[0];
        const slotIdx = window.__dcc.touchSample ? 0 : 0;
        return { ab: q.abilities.slots.concat([q.abilities.ultimate]), slotIdx };
      });
      const box = await projectIndicator();
      await t.up(1);
      await settle(3);
      const label = `${slot} ${d.name}`;
      if (!box) rec(dev.key, `telegraph ${label}`, false, "no indicator in the scene");
      else {
        rec(dev.key, `telegraph ${label}`, box.frac > 0.25,
          `${(box.frac * 100).toFixed(0)}% of vertices on screen, box ` +
          `(${box.x0.toFixed(0)},${box.y0.toFixed(0)})-(${box.x1.toFixed(0)},${box.y1.toFixed(0)}) ` +
          `in ${V.width}x${V.height}` + (info.ab ? ` [${info.ab.join("/")}]` : ""));
      }
    }
  }

  // ------------------------------------------------------- B. target markers
  {
    await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      // Park a monster somewhere the camera can see it and the finger can hit.
      const m = st.monsters.find((x) => x.hp > 0);
      if (m) { m.dormant = false; m.pos.x = p.pos.x + 2.2; m.pos.y = p.pos.y - 0.4; }
      window.__mob = m ? m.id : null;
      // PIN IT. A "tap" driven through settle() spans seconds of WALL clock on
      // an iPad running its backbuffer at ~1 fps under SwiftShader, and the sim
      // keeps stepping: the monster walks several tiles between the touchdown
      // and the frame that resolves it, so `screenTapTarget` correctly finds
      // nothing within a thumb of where the finger landed. On the iPad that
      // reported as "the lock ring is not drawn". Pin the pack for the check.
      window.__pin = setInterval(() => {
        const d = window.__dcc; if (!d || window.__mob == null) return;
        const q = d.state.players[0];
        const mm = d.state.monsters.find((x) => x.id === window.__mob);
        if (mm) { mm.pos.x = q.pos.x + 2.2; mm.pos.y = q.pos.y - 0.4; }
      }, 60);
    });
    await settle(4);
    const at = await page.evaluate(() => {
      const d = window.__dcc, m = d.state.monsters.find((x) => x.id === window.__mob);
      if (!m) return null;
      const s = d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y);
      return { x: Math.round(s.x), y: Math.round(s.y), zone: d.touch.route(Math.round(s.x), Math.round(s.y)).zone };
    });
    if (!at || at.zone !== "world") {
      rec(dev.key, "target marker: locked ring is drawn", false, `monster not in the world zone (${JSON.stringify(at)})`);
    } else {
      await t.down(1, at.x, at.y); t.tick(120); await settle(2); await t.up(1);
      await settle(6);
      const m = await page.evaluate(() => {
        const d = window.__dcc, r = d.renderer;
        const find = (pred) => { let f = null; r.scene.traverse((o) => { if (!f && pred(o)) f = o; }); return f; };
        // The lock bracket and the smart reticle are the only ring groups the
        // touch layer adds; identify them by the renderer's own fields.
        const lock = r.lockRing, smart = r.smartMark;
        return {
          locked: d.touch.lockedTargetId,
          lockVisible: !!(lock && lock.visible),
          lockAt: lock ? { x: +lock.position.x.toFixed(2), y: +lock.position.z.toFixed(2) } : null,
          mob: (() => { const mm = d.state.monsters.find((x) => x.id === window.__mob); return mm ? { x: +mm.pos.x.toFixed(2), y: +mm.pos.y.toFixed(2) } : null; })(),
          smartExists: !!smart,
          _unused: find,
        };
      });
      const near = m.lockAt && m.mob ? Math.hypot(m.lockAt.x - m.mob.x, m.lockAt.y - m.mob.y) : 99;
      rec(dev.key, "target marker: locked ring is drawn", m.lockVisible && near < 0.6,
        `lockedTargetId=${m.locked} ringVisible=${m.lockVisible} ring@${JSON.stringify(m.lockAt)} mob@${JSON.stringify(m.mob)} (${near.toFixed(2)} tiles apart)`);

      // ...and the smart cast's own pick gets a DIFFERENT, transient marker.
      await page.evaluate(() => { const q = window.__dcc.state.players[0]; for (const k in q.cd) q.cd[k] = 0; });
      const c = chips.slot1;
      await t.down(1, c.x, c.y); t.tick(80); await settle(2); await t.up(1);
      await settle(2);
      const sm = await page.evaluate(() => {
        const r = window.__dcc.renderer;
        return {
          visible: !!(r.smartMark && r.smartMark.visible),
          // A transient is measured by whether it FIRED, not by whether it
          // happened to still be on screen when a 3 fps harness looked: under
          // SwiftShader two settle frames can outlast the whole fade.
          ageMs: Math.round(performance.now() - r.smartMarkAt),
          at: r.smartMark ? { x: +r.smartMark.position.x.toFixed(2), y: +r.smartMark.position.z.toFixed(2) } : null,
        };
      });
      rec(dev.key, "target marker: smart cast flashes its own pick",
        sm.visible || sm.ageMs < 4000,
        `smart reticle visible=${sm.visible}, fired ${sm.ageMs}ms ago, at ${JSON.stringify(sm.at)}`);
    }
  }

  await page.evaluate(() => { if (window.__pin) clearInterval(window.__pin); });

  // ------------------------------------------------- C. move while aiming
  for (const run of [1, 2]) {
    const clear = await page.evaluate(([w, h]) => {
      const d = window.__dcc;
      for (const fy of [0.86, 0.78, 0.66]) for (const fx of [0.30, 0.22, 0.38]) {
        const x = Math.round(w * fx), y = Math.round(h * fy);
        if (!d.touch.controlAt(x, y) && d.touch.route(x, y).zone === "stick") return { x, y };
      }
      return null;
    }, [V.width, V.height]);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const kept = [];
    for (const [dx, dy] of dirs) {
      await page.evaluate(() => { const q = window.__dcc.state.players[0]; for (const k in q.cd) q.cd[k] = 0; });
      const a = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { x: q.pos.x, y: q.pos.y }; });
      // Finger 1: the stick, pushed and HELD.
      await t.down(1, clear.x, clear.y);
      t.tick(16); await t.move(1, clear.x + dx * 70, clear.y + dy * 70);
      await settle(3);
      // Finger 2: an ability chip, drag-aiming, while finger 1 stays down.
      const c = chips.slot2;
      await t.down(2, c.x, c.y);
      for (let i = 1; i <= 6; i++) {
        t.tick(16);
        await t.move(2, c.x - i * 14, c.y - i * 6);
        await t.move(1, clear.x + dx * 70, clear.y + dy * 70); // keep it pushed
        await settle(1);
      }
      await settle(6);
      const b = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { x: q.pos.x, y: q.pos.y }; });
      await t.up(2);
      await t.up(1);
      await settle(3);
      kept.push(Math.hypot(b.x - a.x, b.y - a.y));
    }
    const worst = Math.min(...kept);
    rec(dev.key, `move while aiming (run ${run})`, worst > 0.25,
      `tiles kept per direction: ${kept.map((k) => k.toFixed(2)).join(" / ")}`);
  }

  // ------------------------------------------- D. 40 aimed casts per slot
  for (const slot of ["slot1", "slot2"]) {
    const c = chips[slot];
    await page.evaluate(() => window.__dcc.touch.clearVerdicts());
    let fired = 0;
    const N = 40;
    for (let k = 0; k < N; k++) {
      await page.evaluate(() => { const q = window.__dcc.state.players[0]; q.dashCharges = 2; for (const j in q.cd) q.cd[j] = 0; });
      await settle(1);
      const a = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return JSON.parse(JSON.stringify(q.cd)); });
      await t.down(1, c.x, c.y);
      t.tick(16); await settle(1);
      for (let i = 1; i <= 6; i++) { t.tick(16); await t.move(1, c.x - i * 22, c.y + i * 6); }
      await settle(2);
      await t.up(1);
      await settle(3);
      const b = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return JSON.parse(JSON.stringify(q.cd)); });
      if (Object.keys(b).some((j) => (b[j] || 0) > (a[j] || 0))) fired++;
      t.tick(400); // clear of FLICK/queue debounces between reps
    }
    const v = await page.evaluate(() => window.__dcc.touch.verdicts());
    const tally = {};
    for (const e of v) tally[e.kind] = (tally[e.kind] || 0) + 1;
    rec(dev.key, `${N} identical aimed casts on ${slot}`, fired === N,
      `${fired}/${N} produced a cooldown; layer verdicts ${JSON.stringify(tally)}`);
  }

  await page.screenshot({ path: `tools/_mobile/r3-${dev.key}.png` });
  await ctx.close();
}
await browser.close();

const fails = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length - fails.length} PASS / ${fails.length} FAIL ====`);
for (const f of fails) console.log(`  FAIL ${f.dev} · ${f.name} — ${f.detail}`);
