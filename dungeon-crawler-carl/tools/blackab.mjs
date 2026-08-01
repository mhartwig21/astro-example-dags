// A/B the giant black box across render-pipeline variants.
// Detection = the screenshot metric that reproduced it in tools/blackbox.mjs
// (large solid-black axis-aligned rect), run over several boss scenarios.
//
// Variants are applied either at context-creation time (addInitScript patch of
// getContext, for WebGLRenderer constructor options) or after load via __dcc.
//
// Usage: node tools/blackab.mjs [--port 5291] [--shots 8] [--variants a,b,c]
import { chromium } from "playwright";
import { inflateSync } from "node:zlib";
import { readFileSync, mkdirSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = flag("--out", "C:/Users/hartw/astro-example-dags/.claude/worktrees/aaa-refinement/dungeon-crawler-carl/tools/_blackbox/ab");
const PORT = flag("--port", "5291");
const SHOTS = Number(flag("--shots", 8));
const ONLY = flag("--variants", null);
mkdirSync(OUT, { recursive: true });

function decodePNG(buf) {
  let p = 8, w = 0, h = 0, colorType = 6; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString("ascii", p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); colorType = body[9]; }
    else if (type === "IDAT") idat.push(body); else if (type === "IEND") break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat)); const stride = w * ch;
  const out = Buffer.alloc(h * stride); let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++]; const row = raw.subarray(rp, rp + stride); rp += stride;
    const o = y * stride, po = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0, b = y > 0 ? out[po + x] : 0;
      const c = x >= ch && y > 0 ? out[po + x - ch] : 0;
      let v = row[x];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[o + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}
function blackFrac(img, cell = 16, thresh = 14) {
  const { w, h, ch, data } = img;
  const cw = Math.floor(w / cell), chh = Math.floor(h / cell);
  const grid = new Uint8Array(cw * chh);
  for (let cy = 0; cy < chh; cy++) for (let cx = 0; cx < cw; cx++) {
    let dark = 0;
    for (let y = cy * cell; y < (cy + 1) * cell; y += 2) { const ro = y * w * ch;
      for (let x = cx * cell; x < (cx + 1) * cell; x += 2) { const o = ro + x * ch;
        if (data[o] <= thresh && data[o + 1] <= thresh && data[o + 2] <= thresh) dark++; } }
    grid[cy * cw + cx] = dark >= (cell / 2) * (cell / 2) * 0.96 ? 1 : 0;
  }
  const heights = new Int32Array(cw); let best = 0, bx = 0, by = 0, bw = 0, bh = 0;
  for (let cy = 0; cy < chh; cy++) {
    for (let cx = 0; cx < cw; cx++) heights[cx] = grid[cy * cw + cx] ? heights[cx] + 1 : 0;
    const st = [];
    for (let cx = 0; cx <= cw; cx++) {
      const cur = cx === cw ? 0 : heights[cx]; let start = cx;
      while (st.length && st[st.length - 1].h >= cur) {
        const t = st.pop(); const a = t.h * (cx - t.i);
        if (a > best) { best = a; bx = t.i * cell; by = (cy - t.h + 1) * cell; bw = (cx - t.i) * cell; bh = t.h * cell; }
        start = t.i;
      }
      st.push({ i: start, h: cur });
    }
  }
  return { frac: +(best / (cw * chh)).toFixed(3), px: { x: bx, y: by, w: bw, h: bh } };
}

const SCENARIOS = [
  { name: "f06", floor: 6, level: 14, seed: 77 },
  { name: "f09", floor: 9, level: 20, seed: 42 },
  { name: "f12", floor: 12, level: 26, seed: 13 },
  { name: "f15", floor: 15, level: 32, seed: 5 },
  { name: "f03", floor: 3, level: 8, seed: 21 },
];

// initScript = runs before page scripts (context-creation options)
// after = evaluated once __dcc is live
const VARIANTS = {
  baseline: {},
  noAA: {
    initScript: () => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === "webgl2" || type === "webgl") attrs = { ...(attrs || {}), antialias: false };
        return orig.call(this, type, attrs);
      };
    },
  },
  noComposerMSAA: {
    after: `(() => { const r = window.__dcc.renderer;
      r.composer.renderTarget1.samples = 0; r.composer.renderTarget2.samples = 0;
      r.composer.renderTarget1.dispose(); r.composer.renderTarget2.dispose(); return "ok"; })()`,
  },
  noBloom: { after: `(() => { window.__dcc.renderer.composer.passes[2].enabled = false; return "ok"; })()` },
  noGTAO: { after: `(() => { window.__dcc.renderer.composer.passes[1].enabled = false; return "ok"; })()` },
  noGrade: { after: `(() => { window.__dcc.renderer.composer.passes[4].enabled = false; return "ok"; })()` },
  // Bypass the whole post chain: straight scene -> default framebuffer.
  directRender: {
    after: `(() => { const r = window.__dcc.renderer;
      r.composer.render = () => { r.renderer.setRenderTarget(null); r.renderer.render(r.scene, r.camera); };
      return "ok"; })()`,
  },
  // HDR off: 8-bit composer targets instead of HalfFloat.
  ldrTargets: {
    after: `(() => { const r = window.__dcc.renderer;
      for (const rt of [r.composer.renderTarget1, r.composer.renderTarget2]) {
        rt.dispose(); rt.texture.type = 1009 /* UnsignedByteType */; }
      return "ok"; })()`,
  },
  // Suspect: TrailRibbons' RIB_FRAG does pow(1.0 - vT, 1.55). Under MSAA an
  // edge fragment's varyings extrapolate past the vertex range, so vT can go
  // slightly above 1 -> pow(negative, 1.55) = NaN -> NaN alpha survives the
  // `if (a < 0.004) discard` (NaN compares false) -> additive blend writes NaN
  // to every channel -> bloom smears it into the black rectangle.
  noRibbons: { after: `(() => { window.__dcc.renderer.ribbons.group.visible = false; return "ok"; })()` },
  fixRibbonPow: {
    after: `(() => {
      const r = window.__dcc.renderer;
      const patch = () => {
        for (const rb of r.ribbons.pool) {
          const m = rb.mat;
          if (m.userData.__patched) continue;
          m.fragmentShader = m.fragmentShader.replace("pow(1.0 - vT, 1.55)", "pow(max(1.0 - vT, 0.0), 1.55)");
          m.needsUpdate = true; m.userData.__patched = 1;
        }
      };
      patch(); setInterval(patch, 200); return "ok";
    })()`,
  },
  // Only the scene render + output (no GTAO, no bloom, no grade).
  renderOnly: {
    after: `(() => { const r = window.__dcc.renderer;
      r.composer.passes[1].enabled = false; r.composer.passes[2].enabled = false;
      r.composer.passes[4].enabled = false; return "ok"; })()`,
  },
};

const STAGE = `(() => {
  const st = window.__dcc.state; const p = st.players[0];
  const all = st.monsters.filter((m) => m.hp > 0);
  const anchor = all.find((m) => m.kind === "boss") || all[0];
  if (!anchor) return 0;
  p.pos.x = anchor.pos.x + 2.2; p.pos.y = anchor.pos.y + 1.4;
  const near = all.slice().sort((a,b) => Math.hypot(a.pos.x-p.pos.x,a.pos.y-p.pos.y) - Math.hypot(b.pos.x-p.pos.x,b.pos.y-p.pos.y)).slice(0,9);
  near.forEach((m,k) => { m.dormant=false; const a=(k/near.length)*Math.PI*2+0.7; const rad=1.8+(k%3)*1.1;
    m.pos.x=p.pos.x+Math.cos(a)*rad; m.pos.y=p.pos.y+Math.sin(a)*rad; m.maxHp=Math.max(m.maxHp,1e6); m.hp=m.maxHp; });
  anchor.maxHp=1e7; anchor.hp=anchor.maxHp; anchor.dormant=false;
  setInterval(() => { const s=window.__dcc&&window.__dcc.state; if(!s) return;
    for (const pl of s.players) { pl.hp=pl.maxHp; pl.dead=false; } }, 120);
  return near.length;
})()`;
const AGITATE = `(() => {
  const d = window.__dcc; const s = d.state; const pl = s.players[0];
  const nr = s.monsters.filter((m) => m.hp>0 && Math.hypot(m.pos.x-pl.pos.x,m.pos.y-pl.pos.y)<9);
  nr.forEach((m,k) => { m.hitFlash=0.3;
    if (k%3===0){m.windupKind="slam";m.windupTotal=2.2;m.windup=1.6;}
    if (k%3===1){const dd=Math.hypot(pl.pos.x-m.pos.x,pl.pos.y-m.pos.y)||1;
      m.windupKind="charge";m.chargeDir={x:(pl.pos.x-m.pos.x)/dd,y:(pl.pos.y-m.pos.y)/dd};m.windupTotal=2.4;m.windup=2.0;}
    try { d.hit({pos:{x:m.pos.x,y:m.pos.y},amount:77,kind:k%4===0?"crit":"enemy",
      dir:{x:(m.pos.x-pl.pos.x)/3,y:(m.pos.y-pl.pos.y)/3}}); } catch(e){}
  });
  pl.attackSwing=0.15; pl.novaFlash=0.4;
})()`;

const names = ONLY ? ONLY.split(",") : Object.keys(VARIANTS);
const results = {};
for (const vname of names) {
  const v = VARIANTS[vname];
  if (!v) { console.error("unknown variant", vname); continue; }
  const browser = await chromium.launch({
    headless: false,
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
      "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  if (v.initScript) await page.addInitScript(v.initScript);
  let hits = 0, total = 0;
  const worst = [];
  for (const sc of SCENARIOS) {
    const url = `http://localhost:${PORT}/iso.html?test&debug=1&eagerassets&floor=${sc.floor}&level=${sc.level}&seed=${sc.seed}&abilities=all&gold=800`;
    try {
      await page.goto(url, { waitUntil: "load", timeout: 90000 });
      await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
      await page.waitForFunction(() => !!window.__dcc?.renderer, null, { timeout: 90000 });
      await page.waitForTimeout(1800);
      if (v.after) await page.evaluate(v.after);
      await page.evaluate(STAGE);
      await page.waitForTimeout(1200);
      for (let i = 0; i < SHOTS; i++) {
        if (i % 2 === 0) await page.evaluate(AGITATE).catch(() => {});
        await page.waitForTimeout(320);
        const f = `${OUT}/${vname}-${sc.name}-${i}.png`;
        await page.screenshot({ path: f, timeout: 120000 });
        const r = blackFrac(decodePNG(readFileSync(f)));
        total++;
        if (r.frac > 0.12) { hits++; worst.push(`${sc.name}#${i} ${r.frac} ${r.px.w}x${r.px.h}@${r.px.x},${r.px.y}`); }
      }
    } catch (e) { console.error(`  ${vname}/${sc.name} failed:`, e.message.split("\n")[0]); }
  }
  await browser.close();
  results[vname] = { hits, total, worst };
  console.log(`VARIANT ${vname.padEnd(16)} artifact ${hits}/${total}` + (worst.length ? `   e.g. ${worst.slice(0, 4).join(" | ")}` : ""));
}
console.log("\n=== SUMMARY ===");
for (const [k, r] of Object.entries(results)) console.log(` ${k.padEnd(16)} ${r.hits}/${r.total}`);
