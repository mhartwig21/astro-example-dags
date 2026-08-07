// THE CHART'S KEYHOLE, verified WITHOUT moving anything after the drop.
//
// The main late-game probe had to relocate the key to keep it out of
// auto-pickup, and that exposed a cache detail rather than the feature:
// drawMinimap's rebuild key carries `keyAt ? 1 : 0` but NOT the key's
// position, so a key that moves after it has been drawn once does not reframe
// the chart. In shipped play a dropped key never moves. So here the carrier is
// killed AT RANGE with Bolt: the key lands ~5 tiles away, nobody walks onto
// it, nothing is teleported afterwards, and the chart frames it on first sight.
import { chromium } from "playwright";
const PORT = process.env.DCC_PORT ?? "5295";
const fails = [];
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fails.push(m); };
const info = (m) => console.log(`INFO ${m}`);

const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${PORT}/iso.html?test&floor=15&level=16&abilities=all&gold=500&seed=42&debug=1`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => !!window.__dcc?.state?.map, null, { timeout: 60000 });
  await p.waitForTimeout(4000);

  const st = await p.evaluate(() => {
    const s = window.__dcc.state;
    const pl = s.players[0];
    const c = s.monsters.find(m => m.hasKey && m.hp > 0);
    if (!c) return { err: "no carrier" };
    // Out of melee reach (1.3) and well outside pickupRadius (0.8), but inside
    // Bolt's range. Everything else is put to sleep so nothing shoves anyone.
    for (const m of s.monsters) if (m !== c) m.hp = 0;
    c.pos.x = pl.pos.x + 5.0; c.pos.y = pl.pos.y; c.hp = 1;
    return { ok: true, locked: s.map.locked, carrier: { x: +c.pos.x.toFixed(1), y: +c.pos.y.toFixed(1) } };
  });
  info(`staged: ${JSON.stringify(st)}`);

  for (let i = 0; i < 30; i++) {
    // Aim at the carrier through the real camera, then throw Bolt.
    const aim = await p.evaluate(() => {
      const s = window.__dcc.state;
      const c = s.monsters.find(m => m.hasKey && m.hp > 0);
      if (!c) return null;
      const sp = window.__dcc.renderer.worldToScreen(c.pos.x, 0.8, c.pos.y);
      return { x: Math.round(sp.x), y: Math.round(sp.y), vis: sp.visible };
    });
    if (!aim) break;
    await p.mouse.move(aim.x, aim.y);
    await p.waitForTimeout(120);
    await p.keyboard.down("q"); await p.waitForTimeout(430); await p.keyboard.up("q");
    await p.waitForTimeout(250);
  }

  await p.waitForTimeout(2500);
  const d = await p.evaluate(() => {
    const s = window.__dcc.state;
    const k = s.loot.find(l => l.kind === "key");
    const pl = s.players[0];
    const c = document.querySelector("#minimap canvas, canvas#minimap, #minimap-frame canvas");
    let mm = { err: "no canvas" };
    if (c) {
      const g = c.getContext("2d");
      const px = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0; let sample = null;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 200 && px[i+1] < 130 && px[i+2] > 150 && px[i+3] > 40) { n++; if (!sample) sample = [px[i],px[i+1],px[i+2]]; }
      }
      mm = { w: c.width, h: c.height, sealPixels: n, sample };
    }
    const km = document.getElementById("keymark");
    return {
      locked: !!s.map.locked, keyOnFloor: !!k, status: s.status,
      key: k ? { x:+k.pos.x.toFixed(1), y:+k.pos.y.toFixed(1) } : null,
      player: { x:+pl.pos.x.toFixed(1), y:+pl.pos.y.toFixed(1) },
      dist: k ? +Math.hypot(k.pos.x-pl.pos.x, k.pos.y-pl.pos.y).toFixed(1) : null,
      keymark: km && getComputedStyle(km).display !== "none" ? (km.textContent||"").replace(/\s+/g," ").trim() : null,
      mm,
    };
  });
  info(JSON.stringify(d, null, 2));
  ok(d.keyOnFloor && d.locked, "the key is on the floor and the district is still sealed");
  // ~24 px is the measured size of the glyph on a 150x150 chart; the picture
  // in tools/_shots/release/late-10-chart-crop.png is the real verdict.
  ok((d.mm.sealPixels ?? 0) > 15, `the CHART carries the seal-hue key mark (${d.mm.sealPixels} px)`);
  ok(!!d.keymark && /paces/.test(d.keymark), `the marker points at it: "${d.keymark}"`);
  await p.screenshot({ path: "tools/_shots/release/late-09-chart-full.png" });
  const el = await p.$("#minimap-frame, #minimap");
  if (el) await el.screenshot({ path: "tools/_shots/release/late-10-chart-crop.png" });
  console.log(fails.length ? `${fails.length} FAILURES` : "ALL PASS");
} finally { await b.close(); }
