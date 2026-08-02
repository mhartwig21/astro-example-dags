// Side-by-side A/B compositor. Two image paths in, one PNG out.
// usage: node tools/_abpair.mjs --a=path --b=path --out=path.png [--w=1900]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const flag = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith("--" + n + "="));
  return hit ? hit.slice(n.length + 3) : d;
};
const A = flag("a"), B = flag("b"), OUT = flag("out");
const W = Number(flag("w", "1900"));
if (!A || !B || !OUT) { console.error("usage: --a= --b= --out="); process.exit(2); }
const uri = (p) => "data:image/" + (extname(p) === ".png" ? "png" : "jpeg") + ";base64," +
  readFileSync(p).toString("base64");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: 600 } });
await page.setContent(`<style>
html,body{margin:0;background:#000;}
.row{display:flex;gap:8px;}
img{width:${Math.floor((W - 8) / 2)}px;display:block;}
</style><div class="row"><img id="a" src="${uri(A)}"><img id="b" src="${uri(B)}"></div>`);
await page.waitForFunction(() => {
  const i = [...document.images];
  return i.length === 2 && i.every((x) => x.complete && x.naturalWidth > 0);
});
const h = await page.evaluate(() => document.querySelector(".row").getBoundingClientRect().height);
await page.setViewportSize({ width: W, height: Math.ceil(h) });
await page.screenshot({ path: OUT });
await browser.close();
console.log("wrote " + OUT);
