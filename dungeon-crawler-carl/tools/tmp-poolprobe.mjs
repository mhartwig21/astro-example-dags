// TEMP probe: stage the beauty-combat moment, then toggle light/FX
// contributors in place and measure the hot-core luminance of the same
// center crop after each toggle. Attributes the blown pool to its source.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { inflateSync } from "node:zlib";

const OUT = "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots/poolprobe";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5285/iso.html";

function decodePng(buf) {
  let off = 8; let w = 0, h = 0, channels = 4; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawB = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = y > 0 && x >= channels ? px[dst - stride + x - channels] : 0;
      let v;
      if (filter === 0) v = rawB; else if (filter === 1) v = rawB + a; else if (filter === 2) v = rawB + b;
      else if (filter === 3) v = rawB + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}
function centerStats(path) {
  const { w, h, channels, px } = decodePng(readFileSync(path));
  const x0 = Math.floor(w * 0.34), x1 = Math.floor(w * 0.72);
  const y0 = Math.floor(h * 0.3), y1 = Math.floor(h * 0.75);
  let sum = 0, hot = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * w + x) * channels;
    const lum = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    sum += lum; if (lum > 236) hot++; n++;
  }
  return { mean: (sum / n / 255 * 100).toFixed(1), hotPct: (hot / n * 100).toFixed(2) };
}

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${BASE}?test&debug=1&clean=1&view=close&floor=6&level=14&abilities=all&seed=77&eagerassets`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 150000 });
await page.waitForTimeout(3500);
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });

function vclock() {
  if (window.__vt) return;
  const raf = window.requestAnimationFrame.bind(window);
  let t = performance.now();
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
}
function teleport() {
  const st = window.__dcc.state;
  const p = st.players[0];
  p.hp = p.maxHp || p.hp;
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  if (live.length === 0) return null;
  let best = live[0], bestN = -1;
  for (const m of live) {
    const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3).length;
    if (n > bestN) { bestN = n; best = m; }
  }
  p.pos.x = best.pos.x + 1.4; p.pos.y = best.pos.y + 0.4;
  p.facing.x = -1; p.facing.y = 0;
  const ring = live.filter((m) => m.kind !== "swarmer")
    .sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
    .slice(0, 5);
  ring.forEach((m, k) => {
    const a = (k / Math.max(ring.length, 1)) * Math.PI * 2 + 2.6;
    m.pos.x = p.pos.x + Math.cos(a) * (1.5 + (k % 2) * 0.5);
    m.pos.y = p.pos.y + Math.sin(a) * (1.5 + (k % 2) * 0.5);
    m.hp = m.maxHp || m.hp;
  });
  return { packSize: bestN };
}
await page.evaluate(() => {
  const p = window.__dcc.state.players[0];
  if (p && p.skin !== "knight") p.skin = "knight";
});
await page.waitForTimeout(700);
await page.evaluate(teleport);
await page.waitForTimeout(4500);
await page.evaluate(`(() => {
  (${vclock.toString()})();
  (${teleport.toString()})();
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  p.attackSwing = 0.15;
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.2);
  for (let i = 0; i < near.length; i++) {
    const m = near[i];
    if (i === 0) m.hitFlash = 0.24;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: 88, kind: i === 0 ? "crit" : "enemy", dir: { x: -0.8, y: -0.4 } });
  }
  if (p.hitFlash) p.hitFlash = 0;
})()`);
for (let i = 0; i < 6; i++) { await page.evaluate(() => window.__vt.advance(15)); await page.waitForTimeout(400); }
await page.evaluate(() => window.__vt.advance(420));
await page.waitForTimeout(450);

const shots = [];
async function snapCase(name, toggle) {
  if (toggle) await page.evaluate(toggle);
  await page.evaluate(() => window.__vt.advance(1));
  await page.waitForTimeout(600);
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, timeout: 240000 });
  shots.push([name, centerStats(path)]);
}
const REHIT = `(() => {
  const dcc = window.__dcc;
  const st = dcc.state;
  const p = st.players[0];
  if (p.hitFlash) p.hitFlash = 0;
  const emit = (h) => (dcc.hit ? dcc.hit(h) : dcc.renderer.emitHits([h]));
  const near = st.monsters.filter((m) => !m.dormant && m.hp > 0 &&
    Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 3.4).slice(0, 4);
  near.forEach((m, k) => {
    if (k === 1) m.hitFlash = 0.24;
    emit({ pos: { x: m.pos.x, y: m.pos.y }, amount: [34, 88, 123, 41][k % 4],
      kind: k === 1 ? "crit" : "enemy",
      dir: { x: (m.pos.x - p.pos.x) / 2, y: (m.pos.y - p.pos.y) / 2 } });
  });
})()`;
async function rehitCase(name, toggle) {
  await page.evaluate(REHIT);
  if (toggle) await page.evaluate(toggle);
  await page.evaluate(() => window.__vt.advance(110));
  await page.waitForTimeout(300);
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, timeout: 240000 });
  shots.push([name, centerStats(path)]);
  // age everything back out before the next case
  await page.evaluate(() => window.__vt.advance(900));
  await page.waitForTimeout(500);
}
await snapCase("base", null);
await rehitCase("rehit-base", null);
await rehitCase("rehit-nofxlights", () => { const r = window.__dcc.renderer; for (const s of r.fxLights ?? []) { s.life = s.max; s.light.intensity = 0; } });
await rehitCase("rehit-noshocks", () => { const r = window.__dcc.renderer; r.shocks.group.visible = false; });
await rehitCase("rehit-nofxp", () => { const r = window.__dcc.renderer; r.fxp.group.visible = false; });
await rehitCase("rehit-nolamp", () => { const r = window.__dcc.renderer; if (r.heroLamp) r.heroLamp.intensity = 0; r.heroLampBase = 0; });
console.log(JSON.stringify(shots, null, 1));
await browser.close();
