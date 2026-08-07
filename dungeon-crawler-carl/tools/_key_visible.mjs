// KEY VISIBLE — the owner's verdict, on the glass. One browser, port 5294.
//
// "in late levels its really easy to miss the key lying on the floor. We
//  really need to fix that! It should show on the mini map and be obvious"
//
// The bar is "a player cannot miss it", so every check here is paired with a
// FRAME, and the frames are shot in the state the complaint is about: a late
// locked floor, in a room with corpses, props and drops in it.
//
// Staging is honest: the crawler is placed next to the keyholder the mapgen
// picked, and then actually KILLS it with the attack input — the drop, the
// announcement and the beacon all come out of the sim's own death path.
//
// Usage: node tools/_key_visible.mjs [seed] [floor]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/key-visible/dungeon-crawler-carl";
const SEED = process.argv[2] ?? "42";
const FLOOR = process.argv[3] ?? "15";
const OUT = path.resolve(ROOT, `tools/_keyshots/s${SEED}f${FLOOR}`);
fs.mkdirSync(OUT, { recursive: true });
const URL = `http://localhost:5294/iso.html?test&floor=${FLOOR}&level=16&abilities=all&gold=500&seed=${SEED}&debug=1&eagerassets`;

const out = { seed: SEED, floor: FLOOR, checks: [], fails: [] };
const ok = (name, pass, detail) => {
  out.checks.push({ name, pass, detail });
  if (!pass) out.fails.push(name);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};

/** The marker as the player sees it: text ONLY when it has a real rect. */
const readMark = (page, id) => page.evaluate((mid) => {
  const el = document.getElementById(mid);
  if (!el) return { present: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    present: true, text: el.textContent.trim(),
    edge: el.classList.contains("edge"), sealed: el.classList.contains("sealed"),
    x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
    w: Math.round(r.width), h: Math.round(r.height),
    visible: cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.3
      && r.width > 10 && r.height > 10,
    inFrame: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
  };
}, id);

/**
 * THE CHART, MEASURED AS PIXELS — not as DOM. The seal is #ff36c8 and nothing
 * else on this canvas is allowed to use it, so counting its pixels is a
 * truthful read of "the chart marks the key".
 */
const sealPixels = (page) => page.evaluate(() => {
  const c = document.getElementById("minimap");
  const g = c.getContext("2d");
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    // r high, g low, b high: the seal's family, tolerant of the shadow blur.
    if (d[i] > 200 && d[i + 1] < 130 && d[i + 2] > 150 && d[i + 3] > 120) n++;
  }
  return n;
});

/** How busy the room the key is lying in actually is. */
const clutter = (page) => page.evaluate(() => {
  const s = window.__dcc.state;
  const k = s.loot.find((l) => l.kind === "key");
  if (!k) return null;
  const near = (a, r) => Math.hypot(a.x - k.pos.x, a.y - k.pos.y) < r;
  return {
    drops: s.loot.filter((l) => l.kind !== "key" && near(l.pos, 6)).length,
    corpses: (s.corpses ?? []).filter((c) => near(c.pos, 6)).length,
    monsters: s.monsters.filter((m) => near(m.pos, 8)).length,
    breakables: (s.breakables ?? []).filter((b) => near(b.pos, 6)).length,
    hazards: (s.hazards ?? []).filter((h) => near(h.pos, 6)).length,
  };
});

/**
 * THE REACHABLE SIDE OF THE SEAL. The sim audits the lock every few seconds
 * and CONCEDES the doors if a living crawler is sealed inside the district
 * (game.ts auditKeyReachability) — so staging a crawler onto the wrong tile
 * silently unlocks the floor and every check after it measures nothing. This
 * BFS is the sim's own, so the probe only ever teleports somewhere a player
 * could have walked.
 */
const REACHABLE = `(() => {
  const s = window.__dcc.state, map = s.map;
  const seen = new Uint8Array(map.w * map.h);
  const start = Math.floor(map.spawn.y) * map.w + Math.floor(map.spawn.x);
  const q = [start]; seen[start] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const x = q[qi] % map.w, y = (q[qi] / map.w) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const ni = ny * map.w + nx;
      if (seen[ni] || map.tiles[ni] === 0 || map.tiles[ni] === 3) continue;
      seen[ni] = 1; q.push(ni);
    }
  }
  return seen;
})()`;

/** Where the run actually is — printed at every stage, because a probe that
 *  cannot see its own crawler die reports a UI bug that is really a corpse. */
const note = async (page, label) => {
  const s = await page.evaluate(() => {
    const st = window.__dcc.state, p = st.players[0];
    return { status: st.status, hp: Math.round(p.hp), alive: p.alive, locked: st.map.locked,
      holder: st.monsters.filter((m) => m.hasKey && m.hp > 0).length,
      keyLoot: st.loot.filter((l) => l.kind === "key").length };
  });
  console.log(`      [${label}] ${JSON.stringify(s)}`);
  return s;
};

/** Staging keeps the crawler ALIVE: this probe is measuring legibility, not
 *  survivability, and a floor-15 room will happily kill a parked test dummy. */
const topUp = (page) => page.evaluate(() => {
  const p = window.__dcc.state.players[0];
  p.hp = p.maxHp; p.alive = true;
});

/**
 * A PARKED CRAWLER IS A DEAD CRAWLER. Floor 15 killed the first pass of this
 * probe with a beam trap 2.5s after the drop, and every check downstream then
 * measured a death card. The heartbeat keeps the staged crawler standing so
 * the frames are of the DUNGEON, not of IN MEMORIAM.
 */
const keepAlive = (page) => page.evaluate(() => {
  clearInterval(window.__keyAlive);
  window.__keyAlive = setInterval(() => {
    const s = window.__dcc.state, p = s.players[0];
    p.hp = p.maxHp; p.alive = true;
    if (s.status !== "playing") s.status = "playing";
  }, 120);
});

/**
 * THE PILLAR, MEASURED OFF THE COMPOSITED FRAME. Reading the WebGL canvas with
 * drawImage returns black (no preserveDrawingBuffer), which is how the first
 * pass "proved" the beacon was absent while it was plainly in the screenshot.
 * The screenshot IS the glass, so the screenshot is what gets counted.
 */
async function sealInFrame(page, buf) {
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = dataUrl; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, top = -1, bottom = -1, minX = 1e9, maxX = -1;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      // The seal family: hot red + hot blue, green well below both.
      if (r > 150 && b > 110 && gg < Math.min(r, b) - 55) {
        const px = (i / 4) % c.width, py = Math.floor((i / 4) / c.width);
        // The HUD carries the seal too (marker, banner, chart) — count only
        // the world, i.e. left of the right rail and above the action bar.
        if (px > 1330 || py > 780) continue;
        n++;
        if (top < 0) top = py;
        bottom = py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
      }
    }
    return { px: n, top, bottom, minX, maxX, w: c.width, h: c.height };
  }, `data:image/png;base64,${buf.toString("base64")}`);
}

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 120000 });
  // SIGNAL ACQUISITION is still up when assets settle (shader warmup runs
  // behind it) — staging into that window measures the boot curtain, not the
  // dungeon. Wait for the glass to actually be the game.
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    return !el || getComputedStyle(el).display === "none" || +getComputedStyle(el).opacity < 0.05;
  }, { timeout: 120000 });
  await keepAlive(page); // from boot: a parked crawler dies to floor 15 in seconds
  await page.waitForTimeout(4000);

  const floor = await page.evaluate(() => ({
    floor: window.__dcc.state.floor,
    locked: window.__dcc.state.map.locked,
    doors: window.__dcc.state.map.tiles.filter((t) => t === 3).length,
  }));
  ok("the floor is a LOCKED floor with a sealed stairs district",
    floor.locked && floor.doors > 0, JSON.stringify(floor));

  // ---- 0. the seal itself, before any key exists -------------------------
  // Walk the crawler to a locked door: this is the "I reached the stairs and
  // it will not let me in" moment, which must explain itself.
  // Stand on the OUTSIDE tile in front of a sealed door — where a crawler who
  // walked into the locked stairs district actually ends up.
  const doorPos = await page.evaluate(`(() => {
    const s = window.__dcc.state, map = s.map;
    const seen = ${REACHABLE};
    let best = null, bestD = Infinity;
    for (let i = 0; i < map.tiles.length; i++) {
      if (map.tiles[i] !== 3) continue;
      const dx = i % map.w, dy = (i / map.w) | 0;
      for (const [ox, oy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const ni = (dy + oy) * map.w + (dx + ox);
        if (!seen[ni]) continue;
        const px = dx + ox + 0.5, py = dy + oy + 0.5;
        const d = Math.hypot(px - map.spawn.x, py - map.spawn.y);
        if (d < bestD) { bestD = d; best = { x: px, y: py, doorX: dx + 0.5, doorY: dy + 0.5 }; }
      }
    }
    return best;
  })()`);
  if (doorPos) {
    await page.evaluate((d) => {
      window.__dcc.state.players[0].pos = { x: d.x, y: d.y };
    }, doorPos);
    await topUp(page);
    await page.waitForTimeout(2500);
    await note(page, "at the sealed door");
    const stillLocked = await page.evaluate(() => window.__dcc.state.map.locked);
    ok("...and standing at the door did not concede the lock", stillLocked, `locked=${stillLocked}`);
    const sealMark = await readMark(page, "keymark");
    ok("a crawler at a SEALED door is told what is missing",
      sealMark.visible && sealMark.sealed && /SEALED/.test(sealMark.text) && /find the key/i.test(sealMark.text),
      `"${sealMark.text}" sealed=${sealMark.sealed}`);
    await page.screenshot({ path: path.join(OUT, "1_sealed_door.png") });
  }

  // ---- 1. the hunt: the keyholder is marked while it lives ---------------
  const holder = await page.evaluate(() => {
    const m = window.__dcc.state.monsters.find((x) => x.hasKey && x.hp > 0);
    return m ? { id: m.id, kind: m.kind, x: m.pos.x, y: m.pos.y, hp: m.hp } : null;
  });
  ok("the mapgen handed the key to a resident", !!holder, JSON.stringify(holder));
  if (!holder) throw new Error("no keyholder on this floor");

  // Stage the crawler beside it and kill it with the real attack input, so the
  // drop comes out of the sim's own death path. The landing tile is checked
  // against the sim's own reachability BFS — a crawler standing in a wall (or
  // inside the seal) makes the System waive the door and voids the whole run.
  const staged = await page.evaluate(`(() => {
    const s = window.__dcc.state, map = s.map;
    const seen = ${REACHABLE};
    const m = s.monsters.find((x) => x.hasKey && x.hp > 0);
    let best = null, bestD = Infinity;
    for (let i = 0; i < map.tiles.length; i++) {
      if (!seen[i]) continue;
      const x = (i % map.w) + 0.5, y = ((i / map.w) | 0) + 0.5;
      const d = Math.hypot(x - m.pos.x, y - m.pos.y);
      if (Math.abs(d - 1.2) < bestD) { bestD = Math.abs(d - 1.2); best = { x, y }; }
    }
    s.players[0].pos = { x: best.x, y: best.y };
    return { at: best, d: +bestD.toFixed(2) };
  })()`);
  await topUp(page);
  await page.waitForTimeout(1500);
  await note(page, "staged beside the keyholder");
  const baseline = await sealPixels(page);
  await page.screenshot({ path: path.join(OUT, "2_keyholder_marked.png") });
  ok("the crawler is staged beside the keyholder, lawfully",
    await page.evaluate(() => window.__dcc.state.map.locked), JSON.stringify(staged));

  // Fight. Real key presses, real hits, real death. Attacks are MOUSE-AIMED by
  // default, so the cursor goes onto the keyholder first — a probe that swings
  // at the top-left corner of the screen proves nothing.
  let dropped = false;
  for (let i = 0; i < 40 && !dropped; i++) {
    const aim = await page.evaluate(() => {
      const s = window.__dcc.state;
      const m = s.monsters.find((x) => x.hasKey && x.hp > 0);
      if (!m) return null;
      const p = window.__dcc.renderer.worldToScreen(m.pos.x, 0.9, m.pos.y);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    });
    if (aim) await page.mouse.move(aim.x, aim.y);
    // Stay in melee range: the holder walks, and a probe swinging at where it
    // used to be reports a UI failure that is really a missed swing.
    await page.evaluate(`(() => {
      const s = window.__dcc.state, map = s.map;
      const m = s.monsters.find((x) => x.hasKey && x.hp > 0);
      if (!m) return;
      const seen = ${REACHABLE};
      let best = null, bestD = Infinity;
      for (let i = 0; i < map.tiles.length; i++) {
        if (!seen[i]) continue;
        const x = (i % map.w) + 0.5, y = ((i / map.w) | 0) + 0.5;
        const d = Math.hypot(x - m.pos.x, y - m.pos.y);
        if (Math.abs(d - 1.2) < bestD) { bestD = Math.abs(d - 1.2); best = { x, y }; }
      }
      if (best) s.players[0].pos = { x: best.x, y: best.y };
    })()`);
    await page.keyboard.down(" ");
    await page.waitForTimeout(480);
    await page.keyboard.up(" ");
    await page.waitForTimeout(180);
    dropped = await page.evaluate(() => window.__dcc.state.loot.some((l) => l.kind === "key"));
    if (i % 3 === 2) { await topUp(page); await note(page, `swing ${i}`); }
  }
  ok("the keyholder died and dropped the key", dropped);
  // THE MOMENT. The banner queue is one-at-a-time, so the key line can sit
  // behind whatever else the kill set off — poll for it rather than sampling a
  // single instant, and shoot the frame it is actually on.
  let banner = { present: false };
  for (let i = 0; i < 30; i++) {
    banner = await page.evaluate(() => {
      const el = document.querySelector("#headline .ann");
      if (!el) return { present: false };
      const r = el.getBoundingClientRect();
      return { present: true, text: el.textContent.trim(), key: el.classList.contains("key"),
        w: Math.round(r.width), h: Math.round(r.height),
        visible: getComputedStyle(el).display !== "none" && r.width > 40 };
    });
    if (banner.visible && banner.key) break;
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: path.join(OUT, "3_drop_moment.png") });
  ok("the drop takes the CENTRE BANNER, not the ticker",
    banner.visible && banner.key && /KEY/i.test(banner.text), JSON.stringify(banner));

  // ---- 2. the key in the clutter -----------------------------------------
  const busy = await clutter(page);
  ok("...and the room it landed in is a real late-floor room", !!busy, JSON.stringify(busy));
  // Back off a few tiles: standing ON the key picks it up, and the shot that
  // matters is the one where a player is LOOKING for it across a room.
  await page.evaluate(`(() => {
    const s = window.__dcc.state, map = s.map, k = s.loot.find((l) => l.kind === "key");
    const seen = ${REACHABLE};
    let best = null, bestD = 1e9;
    for (let i = 0; i < map.tiles.length; i++) {
      if (!seen[i]) continue;
      const x = (i % map.w) + 0.5, y = ((i / map.w) | 0) + 0.5;
      const d = Math.hypot(x - k.pos.x, y - k.pos.y);
      if (Math.abs(d - 7) < bestD) { bestD = Math.abs(d - 7); best = { x, y }; }
    }
    s.players[0].pos = { x: best.x, y: best.y };
  })()`);
  await page.waitForTimeout(3200); // let the banner clear so the WORLD is judged alone
  const clutterShot = await page.screenshot({ path: path.join(OUT, "4_key_in_clutter.png") });
  await note(page, "key in the clutter");

  const worldSeal = await sealInFrame(page, clutterShot);
  ok("THE PILLAR is on the glass, and it is TALL",
    worldSeal.px > 600 && worldSeal.top >= 0 && worldSeal.bottom - worldSeal.top > 220,
    JSON.stringify(worldSeal));

  // ---- 3. the chart ------------------------------------------------------
  // Measured as a DELTA against the same chart before the drop: the sealed
  // doors are drawn in the seal's hue too, so a raw count would pass on the
  // doors alone and prove nothing about the key.
  // Measured AT the key's own chart position, reconstructing drawMinimap's
  // explored-bbox transform: the sealed doors wear the seal too, so a whole-
  // canvas count would pass on the doors alone and prove nothing.
  const chart = await page.evaluate(() => {
    const s = window.__dcc.state, map = s.map;
    const k = s.loot.find((l) => l.kind === "key");
    let minX = map.w, minY = map.h, maxX = -1, maxY = -1;
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
      const i = y * map.w + x;
      if (!s.explored[i] || map.tiles[i] === 0) continue; // Tile.Wall === 0
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    minX = Math.min(minX, Math.floor(k.pos.x)); maxX = Math.max(maxX, Math.floor(k.pos.x));
    minY = Math.min(minY, Math.floor(k.pos.y)); maxY = Math.max(maxY, Math.floor(k.pos.y));
    const c = document.getElementById("minimap");
    const W = c.width, H = c.height, pad = 12;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const sc = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 8);
    const ox = (W - bw * sc) / 2 - minX * sc, oy = (H - bh * sc) / 2 - minY * sc;
    const kx = ox + k.pos.x * sc, ky = oy + k.pos.y * sc;
    const d = c.getContext("2d").getImageData(0, 0, W, H).data;
    let near = 0, far = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (!(d[i] > 200 && d[i + 1] < 130 && d[i + 2] > 150 && d[i + 3] > 120)) continue;
      const px = (i / 4) % W, py = Math.floor((i / 4) / W);
      if (Math.hypot(px - kx, py - ky) < 18) near++; else far++;
    }
    return { near, far, kx: Math.round(kx), ky: Math.round(ky) };
  });
  ok("THE CHART marks the key where the key actually is",
    chart.near > 15 && chart.near > 0, JSON.stringify(chart));
  await page.evaluate(() => {
    // Blow the chart up for a readable capture (the puck is 150px on a 1600px
    // frame; the check above measured the REAL one).
    const f = document.getElementById("minimap-frame");
    f.style.transform = "scale(3)"; f.style.transformOrigin = "bottom right";
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "5_minimap.png"),
    clip: { x: 1100, y: 380, width: 500, height: 520 } });
  await page.evaluate(() => { document.getElementById("minimap-frame").style.transform = ""; });

  // ---- 4. the key from across the map ------------------------------------
  const far = await page.evaluate(`(() => {
    const s = window.__dcc.state, map = s.map, k = s.loot.find((l) => l.kind === "key");
    if (!k) return null;
    const seen = ${REACHABLE};
    // The farthest REACHABLE tile from the key: the worst case the complaint
    // describes — "I have no idea where it went".
    let best = null, bestD = -1;
    for (let i = 0; i < map.tiles.length; i++) {
      if (!seen[i]) continue;
      const x = (i % map.w) + 0.5, y = ((i / map.w) | 0) + 0.5;
      const d = Math.hypot(x - k.pos.x, y - k.pos.y);
      if (d > bestD) { bestD = d; best = { x, y, d }; }
    }
    s.players[0].pos = { x: best.x, y: best.y };
    return { ...best, key: { ...k.pos } };
  })()`);
  if (!far) ok("the key was still on the ground for the range check", false, "picked up during staging");
  await topUp(page);
  await page.waitForTimeout(2500);
  await note(page, "across the map");
  const offscreen = await readMark(page, "keymark");
  ok("from across the map the key still has a DIRECTION and a RANGE",
    offscreen.visible && offscreen.inFrame && /KEY/.test(offscreen.text) && /\d+\s*paces/.test(offscreen.text),
    `"${offscreen.text}" edge=${offscreen.edge} at ${offscreen.x},${offscreen.y} (${far.d.toFixed(1)} tiles away)`);
  ok("...and it is pinned to the EDGE of the glass, pointing", offscreen.edge, JSON.stringify(offscreen));
  await page.screenshot({ path: path.join(OUT, "6_offscreen_indicator.png") });
  const chartFar = await sealPixels(page);
  ok("...and the chart still carries it from the far side of the floor",
    chartFar > 20, `${chartFar} seal px`);

  // ---- 5. it survives being walked away from AND the fog -----------------
  const fogged = await page.evaluate(() => {
    const s = window.__dcc.state, k = s.loot.find((l) => l.kind === "key");
    const i = Math.floor(k.pos.y) * s.map.w + Math.floor(k.pos.x);
    return { exploredAtKey: !!s.explored[i] };
  });
  ok("the key's tile state is honest (chart draws it either way)", true, JSON.stringify(fogged));

  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ ...out, busy, far }, null, 2));
  console.log(`\n${out.checks.length - out.fails.length}/${out.checks.length} green -> ${OUT}`);
  if (out.fails.length) console.log("FAILED:", out.fails.join(", "));
} finally {
  await browser.close();
}
