// Resident GPU texture census, comparable across builds. Run the SAME url path
// against the shipped reference and the candidate and diff the two numbers.
import { chromium } from "playwright";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const url = flag("--url", "http://localhost:5322/iso.html?test&floor=8&level=16&seed=41&abilities=all&eagerassets");
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("done") === true, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(6000);
const out = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const gl = R.renderer;
  const props = gl.properties;
  const models = R.models || {};
  const seen = new Set();
  let up = 0, upBytes = 0, allBytes = 0;
  for (const k of Object.keys(models)) {
    const m = models[k]; if (!m?.scene) continue;
    m.scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const mat of mats) {
        for (const s of ["map", "normalMap", "emissiveMap", "roughnessMap", "metalnessMap", "aoMap", "alphaMap"]) {
          const t = mat[s]; if (!t || seen.has(t)) continue; seen.add(t);
          const b = Math.ceil((t.image?.width || 0) * (t.image?.height || 0) * 4 * 4 / 3);
          allBytes += b;
          if (props.get(t)?.__webglTexture) { up++; upBytes += b; }
        }
      }
    });
  }
  return {
    residentGLTextures: gl.info.memory.textures,
    manifestUploaded: up,
    manifestTotal: seen.size,
    manifestUploadedMB: +(upBytes / 1048576).toFixed(1),
    manifestTotalMB: +(allBytes / 1048576).toFixed(1),
    programs: gl.info.programs.length,
  };
});
console.log(JSON.stringify(out));
await browser.close();
