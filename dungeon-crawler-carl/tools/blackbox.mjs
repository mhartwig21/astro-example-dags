// BLACK-BOX HUNT: stages encounters with LARGE monsters / dense packs on a REAL
// GPU (ANGLE D3D11 — SwiftShader hides depth/blend/precision artifacts) and
// captures a BURST of frames through each fight, then scores every frame for a
// large solid-black rectangle so we only eyeball the suspicious ones.
//
// Usage:
//   node tools/blackbox.mjs [outDir] [--port 5291] [--w 1920] [--h 1080]
//                           [--only scenarioName] [--burst 10] [--gap 320]
import { chromium } from "playwright";
import { inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = process.argv[2]?.startsWith("--") || !process.argv[2]
  ? "C:/Users/hartw/astro-example-dags/.claude/worktrees/aaa-refinement/dungeon-crawler-carl/tools/_blackbox"
  : process.argv[2];
const PORT = flag("--port", "5291");
const W = Number(flag("--w", 1920));
const H = Number(flag("--h", 1080));
const ONLY = flag("--only", null);
const BURST = Number(flag("--burst", 10));
const GAP = Number(flag("--gap", 320));
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- PNG decode
/** Minimal non-interlaced PNG -> {w,h,data(RGBA-ish stride)} decoder. */
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("bitDepth " + bitDepth);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error("colorType " + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const o = y * stride, po = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0;
      const b = y > 0 ? out[po + x] : 0;
      const c = x >= ch && y > 0 ? out[po + x - ch] : 0;
      let v = row[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

/** Largest all-"black" axis-aligned rectangle over a coarse cell grid.
 * Returns { cells, px:{x,y,w,h}, frac } — frac = share of the frame. */
function blackRect(img, cell = 16, thresh = 14) {
  const { w, h, ch, data } = img;
  const cw = Math.floor(w / cell), chh = Math.floor(h / cell);
  const grid = new Uint8Array(cw * chh);
  for (let cy = 0; cy < chh; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let dark = 0;
      for (let y = cy * cell; y < (cy + 1) * cell; y += 2) {
        const ro = y * w * ch;
        for (let x = cx * cell; x < (cx + 1) * cell; x += 2) {
          const o = ro + x * ch;
          if (data[o] <= thresh && data[o + 1] <= thresh && data[o + 2] <= thresh) dark++;
        }
      }
      grid[cy * cw + cx] = dark >= (cell / 2) * (cell / 2) * 0.96 ? 1 : 0;
    }
  }
  // maximal rectangle in a binary matrix (histogram + stack)
  const heights = new Int32Array(cw);
  let best = { cells: 0, px: { x: 0, y: 0, w: 0, h: 0 } };
  for (let cy = 0; cy < chh; cy++) {
    for (let cx = 0; cx < cw; cx++) heights[cx] = grid[cy * cw + cx] ? heights[cx] + 1 : 0;
    const st = [];
    for (let cx = 0; cx <= cw; cx++) {
      const cur = cx === cw ? 0 : heights[cx];
      let start = cx;
      while (st.length && st[st.length - 1].h >= cur) {
        const t = st.pop();
        const area = t.h * (cx - t.i);
        if (area > best.cells) {
          best = { cells: area, px: { x: t.i * cell, y: (cy - t.h + 1) * cell, w: (cx - t.i) * cell, h: t.h * cell } };
        }
        start = t.i;
      }
      st.push({ i: start, h: cur });
    }
  }
  best.frac = +(best.cells / (cw * chh)).toFixed(4);
  return best;
}

// ------------------------------------------------------------------ scenarios
// Big/heavy kinds (ARCHETYPES in src/sim/config.ts): mass >= 2.2 / radius >= .45
const HEAVY = ["brute", "slagbreaker", "colossus", "warden", "broodmother", "foreman", "charger", "shieldbearer", "lineworker", "digger"];
const AFFIXES = ["frenzied", "armored", "chilling", "explosive", "vampiric", "warded", "hasted", "thorned"];

const SCENARIOS = [
  { name: "f06-boss", floor: 6, level: 14, seed: 77, mode: "boss" },
  { name: "f09-boss", floor: 9, level: 20, seed: 42, mode: "boss" },
  { name: "f12-boss", floor: 12, level: 26, seed: 13, mode: "boss" },
  { name: "f15-boss", floor: 15, level: 32, seed: 5, mode: "boss" },
  { name: "f03-boss", floor: 3, level: 8, seed: 21, mode: "boss" },
  { name: "f06-heavies", floor: 6, level: 14, seed: 77, mode: "heavies" },
  { name: "f09-heavies", floor: 9, level: 20, seed: 42, mode: "heavies" },
  { name: "f12-elites", floor: 12, level: 26, seed: 13, mode: "elites" },
  { name: "f15-elites", floor: 15, level: 32, seed: 5, mode: "elites" },
  { name: "f09-swarm", floor: 9, level: 20, seed: 42, mode: "swarm" },
  { name: "f15-swarm", floor: 15, level: 32, seed: 8, mode: "swarm" },
  { name: "f18-giants", floor: 18, level: 36, seed: 3, mode: "giants" },
  { name: "f12-giants", floor: 12, level: 26, seed: 99, mode: "giants" },
];

// ------------------------------------------------------------------ in-page
/** Staging prologue, stringified into the page. mode selects the encounter. */
const STAGE = (mode, heavy, affixes) => `(() => {
  const dcc = window.__dcc; const st = dcc.state; const p = st.players[0];
  p.hp = p.maxHp;
  const live = () => st.monsters.filter((m) => m.hp > 0);
  const all = live();
  if (!all.length) return { staged: 0, note: "no monsters" };
  const mode = ${JSON.stringify(mode)};
  const HEAVY = ${JSON.stringify(heavy)};
  const AFFIXES = ${JSON.stringify(affixes)};
  // Anchor: prefer a real boss, else the densest cluster.
  let anchor = all.find((m) => m.kind === "boss") || all.find((m) => m.kind === "foreman");
  if (!anchor) {
    let bn = -1;
    for (const m of all) {
      const n = all.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4).length;
      if (n > bn) { bn = n; anchor = m; }
    }
  }
  p.pos.x = anchor.pos.x + 2.2; p.pos.y = anchor.pos.y + 1.4;
  p.facing.x = -1; p.facing.y = -0.6;
  // Pull a crowd around the player.
  const near = all.slice().sort((a, b) =>
    Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y));
  const count = mode === "swarm" ? 24 : mode === "giants" ? 10 : 9;
  const ring = near.slice(0, count);
  ring.forEach((m, k) => {
    m.dormant = false;
    const a = (k / ring.length) * Math.PI * 2 + 0.7;
    const rad = 1.8 + (k % 3) * 1.1;
    m.pos.x = p.pos.x + Math.cos(a) * rad;
    m.pos.y = p.pos.y + Math.sin(a) * rad;
    if (mode === "heavies" || mode === "giants") {
      m.kind = HEAVY[k % HEAVY.length];
      if (mode === "giants") { m.elite = true; m.affix = AFFIXES[k % AFFIXES.length]; }
    }
    if (mode === "elites") { m.elite = true; m.affix = AFFIXES[k % AFFIXES.length]; }
    if (mode === "giants" && k < 3) { m.kind = "boss"; }
    m.maxHp = Math.max(m.maxHp, 100000); m.hp = m.maxHp; // survive the burst
  });
  if (anchor) { anchor.maxHp = Math.max(anchor.maxHp, 500000); anchor.hp = anchor.maxHp; anchor.dormant = false; }
  // Keep the crawler alive + the camera parked through the whole burst.
  if (!window.__bbKeep) {
    window.__bbKeep = setInterval(() => {
      const s = window.__dcc && window.__dcc.state; if (!s) return;
      for (const pl of s.players) { pl.hp = pl.maxHp; pl.dead = false; }
    }, 120);
  }
  return { staged: ring.length, anchor: anchor.kind, at: [+anchor.pos.x.toFixed(1), +anchor.pos.y.toFixed(1)],
           kinds: [...new Set(ring.map((m) => m.kind))] };
})()`;

/** Mid-burst agitation: force telegraphs / windups / hits so transient FX fire. */
const AGITATE = `(() => {
  const dcc = window.__dcc; const st = dcc.state; const p = st.players[0];
  const near = st.monsters.filter((m) => m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 9);
  near.forEach((m, k) => {
    m.hitFlash = 0.3;
    if (k % 3 === 0) { m.windupKind = "slam"; m.windupTotal = 2.2; m.windup = 1.6; }
    if (k % 3 === 1) {
      const d = Math.hypot(p.pos.x - m.pos.x, p.pos.y - m.pos.y) || 1;
      m.windupKind = "charge"; m.chargeDir = { x: (p.pos.x - m.pos.x) / d, y: (p.pos.y - m.pos.y) / d };
      m.windupTotal = 2.4; m.windup = 2.0;
    }
    try { dcc.hit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 77, kind: k % 4 === 0 ? "crit" : "enemy",
      dir: { x: (m.pos.x - p.pos.x) / 3, y: (m.pos.y - p.pos.y) / 3 } }); } catch (e) {}
  });
  p.attackSwing = 0.15; p.novaFlash = 0.4;
  return near.length;
})()`;

// --------------------------------------------------------------------- drive
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => { errors.push("PAGEERROR " + e.message); console.error("PAGE ERROR:", e.message); });
page.on("console", (m) => {
  const t = m.text();
  if (/error|warn|NaN|shader|program|GL_INVALID|three\.js/i.test(t)) { errors.push(m.type() + " " + t); }
});

const report = [];
for (const sc of SCENARIOS) {
  if (ONLY && sc.name !== ONLY) continue;
  const url = `http://localhost:${PORT}/iso.html?test&debug=1&eagerassets&floor=${sc.floor}&level=${sc.level}&seed=${sc.seed}&abilities=all&gold=800`;
  console.log("\n=== " + sc.name + "  " + url);
  try {
    await page.goto(url, { waitUntil: "load", timeout: 90000 });
    await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
    await page.waitForFunction(() => !!window.__dcc?.renderer, null, { timeout: 90000 });
    await page.waitForTimeout(2000);
    const staged = await page.evaluate(STAGE(sc.mode, HEAVY, AFFIXES));
    console.log("  staged:", JSON.stringify(staged));
    await page.waitForTimeout(1200);
    for (let i = 0; i < BURST; i++) {
      if (i % 2 === 0) await page.evaluate(AGITATE).catch(() => {});
      await page.waitForTimeout(GAP);
      const file = `${OUT}/${sc.name}-${String(i).padStart(2, "0")}.png`;
      await page.screenshot({ path: file, timeout: 120000 });
      const img = decodePNG(readFileSync(file));
      const r = blackRect(img);
      report.push({ scenario: sc.name, i, file, ...r });
      console.log(`  [${i}] blackRect ${r.px.w}x${r.px.h} @${r.px.x},${r.px.y}  frac=${r.frac}`);
    }
  } catch (e) {
    console.error("  scenario failed:", e.message.split("\n")[0]);
    report.push({ scenario: sc.name, error: e.message.split("\n")[0] });
  }
}

report.sort((a, b) => (b.frac ?? 0) - (a.frac ?? 0));
writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, errors: [...new Set(errors)].slice(0, 60) }, null, 1));
console.log("\nTOP BLACK RECTS:");
for (const r of report.slice(0, 15)) console.log(" ", r.frac, r.px ? `${r.px.w}x${r.px.h}@${r.px.x},${r.px.y}` : r.error, r.file ?? "");
console.log("\nerrors:", [...new Set(errors)].slice(0, 20));
await browser.close();
