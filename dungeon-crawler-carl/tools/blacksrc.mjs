// Find the NaN/Inf pixel that UnrealBloomPass smears into the giant black box.
// Scans the FULL scene HDR buffer (RenderPass output) every Nth frame for
// non-finite half-floats and reports their screen positions, plus what the
// renderer has near that spot.
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const FLOOR = flag("--floor", "6"), SEED = flag("--seed", "77"), LEVEL = flag("--level", "14");
const PORT = flag("--port", "5291");
const MINUTES = Number(flag("--minutes", 6));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
const url = `http://localhost:${PORT}/iso.html?test&debug=1&eagerassets&floor=${FLOOR}&level=${LEVEL}&seed=${SEED}&abilities=all&gold=800`;
await page.goto(url, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
await page.waitForFunction(() => !!window.__dcc?.renderer, null, { timeout: 90000 });
await page.waitForTimeout(2000);

await page.evaluate(() => {
  const st = window.__dcc.state; const p = st.players[0];
  const all = st.monsters.filter((m) => m.hp > 0);
  const anchor = all.find((m) => m.kind === "boss") || all[0];
  p.pos.x = anchor.pos.x + 2.2; p.pos.y = anchor.pos.y + 1.4;
  const near = all.slice().sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y)).slice(0, 10);
  near.forEach((m, k) => { m.dormant = false; const a = (k / near.length) * Math.PI * 2 + 0.7; const rad = 1.8 + (k % 3) * 1.1;
    m.pos.x = p.pos.x + Math.cos(a) * rad; m.pos.y = p.pos.y + Math.sin(a) * rad; m.maxHp = Math.max(m.maxHp, 1e6); m.hp = m.maxHp; });
  anchor.maxHp = 1e7; anchor.hp = anchor.maxHp; anchor.dormant = false;
  setInterval(() => { const s = window.__dcc?.state; if (!s) return; for (const pl of s.players) { pl.hp = pl.maxHp; pl.dead = false; } }, 120);
  setInterval(() => {
    const d = window.__dcc; if (!d) return; const s = d.state; const pl = s.players[0];
    const nr = s.monsters.filter((m) => m.hp > 0 && Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y) < 9);
    nr.forEach((m, k) => { m.hitFlash = 0.3;
      if (k % 3 === 0) { m.windupKind = "slam"; m.windupTotal = 2.2; m.windup = 1.6; }
      if (k % 3 === 1) { const dd = Math.hypot(pl.pos.x - m.pos.x, pl.pos.y - m.pos.y) || 1;
        m.windupKind = "charge"; m.chargeDir = { x: (pl.pos.x - m.pos.x) / dd, y: (pl.pos.y - m.pos.y) / dd }; m.windupTotal = 2.4; m.windup = 2.0; }
      try { d.hit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 77, kind: k % 4 === 0 ? "crit" : "enemy",
        dir: { x: (m.pos.x - pl.pos.x) / 3, y: (m.pos.y - pl.pos.y) / 3 } }); } catch (e) {}
    });
    pl.attackSwing = 0.15; pl.novaFlash = 0.4;
  }, 300);
});

await page.evaluate(() => {
  const r3 = window.__dcc.renderer;
  const R = r3.renderer;
  const c = r3.composer;
  const bloom = c.passes[2];
  const bb = { reports: [], frames: 0, i: 0, every: 2, scan: false };
  window.__bb = bb;
  const bufs = new Map();
  function full(rt, label) {
    if (!rt || !rt.texture) return null;
    const w = rt.width, h = rt.height;
    const key = label + w + "x" + h;
    let b = bufs.get(key);
    const half = rt.texture.type === 1016;
    if (!b) { b = half ? new Uint16Array(w * h * 4) : new Uint8Array(w * h * 4); bufs.set(key, b); }
    try { R.readRenderTargetPixels(rt, 0, 0, w, h, b); } catch (e) { return { err: String(e).slice(0, 60) }; }
    if (!half) return { u8: true };
    let nan = 0, inf = 0, huge = 0; const spots = [];
    for (let i = 0; i < b.length; i++) {
      const v = b[i];
      if ((v & 0x7c00) !== 0x7c00) {
        if ((v & 0x7c00) >= 0x6c00) { // >= 2^14 = 16384: absurd for this HDR range
          huge++;
          if (spots.length < 6) { const p = (i >> 2); spots.push({ x: p % w, y: Math.floor(p / w), kind: "huge", ch: i & 3, raw: v }); }
        }
        continue;
      }
      if (v & 0x03ff) { nan++; if (spots.length < 6) { const p = (i >> 2); spots.push({ x: p % w, y: Math.floor(p / w), kind: "NaN", ch: i & 3, raw: v }); } }
      else { inf++; if (spots.length < 6) { const p = (i >> 2); spots.push({ x: p % w, y: Math.floor(p / w), kind: "Inf", ch: i & 3, raw: v }); } }
    }
    return { w, h, nan, inf, huge, spots };
  }
  // Scan the scene HDR output (RenderPass writes into readBuffer) right after
  // pass0, and the bloom's own bright/mip targets after pass2.
  const p0 = c.passes[0], origP0 = p0.render.bind(p0);
  p0.render = function (renderer, writeBuffer, readBuffer, dt, m) {
    const r = origP0(renderer, writeBuffer, readBuffer, dt, m);
    if (bb.scan) bb.cur.scene = full(readBuffer, "scene");
    return r;
  };
  const p1 = c.passes[1], origP1 = p1.render.bind(p1);
  p1.render = function (renderer, writeBuffer, readBuffer, dt, m) {
    const r = origP1(renderer, writeBuffer, readBuffer, dt, m);
    if (bb.scan) bb.cur.gtao = full(writeBuffer, "gtao");
    return r;
  };
  const origP2 = bloom.render.bind(bloom);
  bloom.render = function (renderer, writeBuffer, readBuffer, dt, m) {
    if (bb.scan) bb.cur.bloomIn = full(readBuffer, "bin");
    const r = origP2(renderer, writeBuffer, readBuffer, dt, m);
    if (bb.scan) {
      bb.cur.bright = full(bloom.renderTargetBright, "bright");
      bb.cur.mip0 = full(bloom.renderTargetsHorizontal[0], "m0");
      bb.cur.mip4 = full(bloom.renderTargetsHorizontal[4], "m4");
      bb.cur.bloomOut = full(readBuffer, "bout");
      bb.cur.strength = bloom.strength; bb.cur.radius = bloom.radius; bb.cur.threshold = bloom.threshold;
    }
    return r;
  };

  const gl = R.getContext();
  let px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  function blackScore() {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const STEP = 16, GW = Math.floor(w / STEP), GH = Math.floor(h / STEP);
    const grid = new Uint8Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) { const y = gy * STEP;
      for (let gx = 0; gx < GW; gx++) { const o = (y * w + gx * STEP) * 4;
        grid[gy * GW + gx] = px[o] <= 12 && px[o + 1] <= 12 && px[o + 2] <= 12 ? 1 : 0; } }
    const hh = new Int32Array(GW); let best = 0, bx = 0, by = 0, bw = 0, bh = 0;
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) hh[gx] = grid[gy * GW + gx] ? hh[gx] + 1 : 0;
      const s = [];
      for (let gx = 0; gx <= GW; gx++) { const cur = gx === GW ? 0 : hh[gx]; let start = gx;
        while (s.length && s[s.length - 1].h >= cur) { const t = s.pop(); const a = t.h * (gx - t.i);
          if (a > best) { best = a; bx = t.i * STEP; by = gy - t.h + 1; bw = (gx - t.i) * STEP; bh = t.h * STEP; } start = t.i; }
        s.push({ i: start, h: cur }); }
    }
    return { f: best / (GW * GH), x: bx, yGL: by * STEP, w: bw, h: bh };
  }

  const origRender = c.render.bind(c);
  c.render = function (...a) {
    const want = bb.reports.filter((r) => r.kind === "HIT").length < 3 || bb.reports.filter((r) => r.kind === "CLEAN").length < 1;
    bb.scan = want && (++bb.i % bb.every === 0);
    bb.cur = {};
    origRender(...a);
    bb.frames++;
    if (!bb.scan) return;
    bb.scan = false;
    const s = blackScore();
    const kind = s.f > 0.1 ? "HIT" : "CLEAN";
    const nH = bb.reports.filter((r) => r.kind === "HIT").length;
    const nC = bb.reports.filter((r) => r.kind === "CLEAN").length;
    if (kind === "HIT" ? nH < 3 : nC < 1) bb.reports.push({ kind, rect: s, ...bb.cur });
  };
});

console.log("scanning full HDR buffers for non-finite pixels...");
const deadline = Date.now() + MINUTES * 60000;
while (Date.now() < deadline) {
  await page.waitForTimeout(2500);
  const n = await page.evaluate(() => window.__bb.reports.filter((r) => r.kind === "HIT").length);
  process.stdout.write(`\r hits=${n} frames=${await page.evaluate(() => window.__bb.frames)}   `);
  if (n >= 2) break;
}
const out = await page.evaluate(() => window.__bb.reports);
console.log("\n");
for (const r of out) {
  console.log(`=== ${r.kind}  rect f=${r.rect.f.toFixed(3)} ${r.rect.w}x${r.rect.h}@${r.rect.x},yGL${r.rect.yGL}  bloom s=${r.strength} rad=${r.radius} thr=${r.threshold}`);
  for (const k of ["scene", "gtao", "bloomIn", "bright", "mip0", "mip4", "bloomOut"]) {
    if (r[k]) console.log(`   ${k.padEnd(9)} ${JSON.stringify(r[k])}`.slice(0, 400));
  }
}
await browser.close();
