// How much GPU texture memory does preuploadTextures() make resident?
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: false,
  args: ["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync"] });
async function probe(name, base) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
  await page.goto(`${base}/iso.html?test&floor=5&level=18&seed=41&abilities=all&eagerassets&debug=1`, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
  await page.waitForTimeout(16000);
  const r = await page.evaluate(() => {
    const R = window.__dcc.renderer;
    const props = R.renderer.properties;
    let bytes = 0, n = 0, uploaded = 0;
    const seen = new Set();
    const walk = (o) => { o.traverse?.((c) => {
      const ms = c.material ? (Array.isArray(c.material) ? c.material : [c.material]) : [];
      for (const m of ms) for (const k in m) {
        const t = m[k];
        if (t && t.isTexture && !seen.has(t)) { seen.add(t);
          const w = t.image?.width || 0, h = t.image?.height || 0;
          n++; if (w && h) { const b = w*h*4*1.33; bytes += b;
            if (props.get(t)?.__webglTexture) uploaded += b; }
        }
      }
    }); };
    walk(R.scene);
    for (const k in R.models) if (R.models[k]?.scene) walk(R.models[k].scene);
    return { glTextures: R.renderer.info.memory.textures, distinct: n,
      totalMB: +(bytes/1048576).toFixed(1), uploadedMB: +(uploaded/1048576).toFixed(1) };
  });
  console.log(name.padEnd(9), JSON.stringify(r));
  await page.close();
}
await probe("SHIPPED", "http://localhost:5291");
await probe("MINE", "http://localhost:5294");
await browser.close();
