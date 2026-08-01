// Isolates the multi-second freeze: three.js's WebGLProgram.onFirstUse calls
// gl.getProgramInfoLog() behind renderer.debug.checkShaderErrors (default TRUE).
// That is a SYNCHRONOUS driver readback that blocks the main thread until the
// shader has finished linking. This probe A/Bs it across fresh page loads
// (programs only compile once, so it cannot be A/B'd inside one load).
import { chromium } from "playwright";
const URL = "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const reps = Number(process.argv[2] ?? 2);
const out = { on: [], off: [] };

for (let r = 0; r < reps; r++) {
  for (const mode of ["on", "off"]) {
    const b = await chromium.launch({ headless: false, args: ["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync","--disable-frame-rate-limit"] });
    const ctx = await b.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: "load", timeout: 60000 });
    await p.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
    const applied = await p.evaluate((m) => {
      const gl = window.__dcc?.renderer?.renderer;
      if (!gl) return "no renderer";
      if (m === "off") gl.debug.checkShaderErrors = false;
      return `checkShaderErrors=${gl.debug.checkShaderErrors} programs=${gl.info.programs.length}`;
    }, mode);
    // Play: walk + fight so NEW material/light permutations compile mid-game.
    await p.evaluate(() => { window.__ft = []; let l = performance.now();
      const t = () => { const n = performance.now(); window.__ft.push(n - l); l = n; requestAnimationFrame(t); };
      requestAnimationFrame(t); });
    for (let i = 0; i < 6; i++) {
      await p.keyboard.down(["w","d","s","a"][i % 4]); await p.waitForTimeout(1400);
      await p.keyboard.up(["w","d","s","a"][i % 4]);
      for (const k of ["Space","q","e","r","c","f"]) await p.keyboard.press(k).catch(()=>{});
    }
    const res = await p.evaluate(() => {
      const f = window.__ft.slice(20).sort((a, b) => a - b);
      const gl = window.__dcc.renderer.renderer;
      const over = (ms) => window.__ft.filter((x) => x > ms).length;
      return { frames: f.length, median: +f[Math.floor(f.length/2)].toFixed(1),
        p99: +f[Math.floor(f.length*0.99)].toFixed(0), worst: +f[f.length-1].toFixed(0),
        over100: over(100), over250: over(250), over500: over(500),
        stallMs: +window.__ft.filter(x=>x>100).reduce((a,c)=>a+c,0).toFixed(0),
        programs: gl.info.programs.length };
    });
    console.log(mode.toUpperCase().padEnd(4), applied, JSON.stringify(res));
    out[mode].push(res);
    await b.close();
  }
}
const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
console.log("\n  checkShaderErrors  median  p99  worst  >100ms  >250ms  >500ms  stallTotalMs  programs");
for (const m of ["on","off"]) {
  const v = out[m];
  console.log(`  ${(m==="on"?"true (default)":"false").padEnd(17)} ${med(v.map(x=>x.median)).toFixed(1).padStart(6)} ` +
    `${med(v.map(x=>x.p99)).toFixed(0).padStart(4)} ${med(v.map(x=>x.worst)).toFixed(0).padStart(6)} ` +
    `${med(v.map(x=>x.over100)).toFixed(0).padStart(7)} ${med(v.map(x=>x.over250)).toFixed(0).padStart(7)} ` +
    `${med(v.map(x=>x.over500)).toFixed(0).padStart(7)} ${med(v.map(x=>x.stallMs)).toFixed(0).padStart(13)} ` +
    `${med(v.map(x=>x.programs)).toFixed(0).padStart(9)}`);
}
