// Visual proof for the MSAA finding: same frame, composer target multisampled
// vs not, captured on the REAL GPU (headed ANGLE D3D11) at the owner's true
// 2880x1704 backbuffer. Also reports a cheap edge-energy metric (mean |Laplacian|
// over the luma) so the aliasing difference is a number, not just a vibe.
//
// Usage: node tools/msaashot.mjs [--out tools/_msaa]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1");
const out = flag("--out", "tools/_msaa");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
console.log("GPU:", await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return gl.getParameter(d.UNMASKED_RENDERER_WEBGL);
}));
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(4000);

// Edge energy + "is anything even drawn" check, straight off the WebGL canvas.
const probe = () => page.evaluate(() => new Promise((res) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const c = document.querySelector("canvas");
    const cv = document.createElement("canvas");
    cv.width = 900; cv.height = 600;
    const g = cv.getContext("2d");
    g.drawImage(c, 400, 200, 900, 600, 0, 0, 900, 600); // a busy crop
    const d = g.getImageData(0, 0, 900, 600).data;
    const lum = new Float32Array(900 * 600);
    let sum = 0;
    for (let i = 0; i < 900 * 600; i++) {
      lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
      sum += lum[i];
    }
    let edge = 0;
    for (let y = 1; y < 599; y++) for (let x = 1; x < 899; x++) {
      const i = y * 900 + x;
      edge += Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - 900] - lum[i + 900]);
    }
    res({ meanLuma: +(sum / (900 * 600)).toFixed(2), edgeEnergy: +(edge / (898 * 598)).toFixed(3) });
  }));
}));

const setMsaa = (n) => page.evaluate((s) => {
  const c = window.__dcc.renderer.composer;
  for (const rt of [c.renderTarget1, c.renderTarget2]) { rt.samples = s; rt.dispose(); }
  return { samples: c.renderTarget1.samples };
}, n);

for (const n of [4, 0, 4]) {
  await setMsaa(n);
  await page.waitForTimeout(2500);
  const m = await probe();
  await page.screenshot({ path: `${out}/msaa${n}.png` });
  console.log(`samples=${n}`, JSON.stringify(m));
}
await browser.close();
