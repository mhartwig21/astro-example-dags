// Side-by-side zoom of two captures over the same STATIC geometry (props,
// walls, floor), which is where geometry AA and contact AO actually read.
// Mobs diverge between builds; the environment does not.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const a = flag("--a", "tools/_visab/A-shipped-5291.png");
const b = flag("--b", "tools/_visab/B-mine-ultra.png");
const x = Number(flag("--x", 1150)), y = Number(flag("--y", 300));
const w = Number(flag("--w", 800)), h = Number(flag("--h", 560));
const zoom = Number(flag("--zoom", 2));
const out = flag("--out", "tools/_visab/crop.png");
const d = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: w * zoom * 2 + 60, height: h * zoom + 60 } });
await page.setContent(`
<style>
 body{margin:0;background:#111;color:#eee;font:14px monospace;display:flex;gap:20px;padding:20px}
 .c{width:${w * zoom}px;height:${h * zoom}px;overflow:hidden;position:relative;border:1px solid #444}
 .c img{position:absolute;left:${-x * zoom}px;top:${-y * zoom}px;width:${2880 * zoom}px;image-rendering:pixelated}
 figure{margin:0}figcaption{padding:4px 0}
</style>
<figure><figcaption>A — SHIPPED (MSAA4, AO normals from G-buffer)</figcaption>
 <div class="c"><img src="${d(a)}"></div></figure>
<figure><figcaption>B — MINE ULTRA (SMAA, AO normals from depth)</figcaption>
 <div class="c"><img src="${d(b)}"></div></figure>
`);
await page.waitForTimeout(600);
await page.screenshot({ path: out });
await browser.close();
console.log("wrote", out);
