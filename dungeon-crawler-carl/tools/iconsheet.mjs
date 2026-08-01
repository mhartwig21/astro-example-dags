// Contact sheet for the painted icon set: renders every /icons/painted/<set>
// file at tile size + pip size so a new batch can be eyeballed in one frame.
// Usage: node tools/iconsheet.mjs <outDir> [set=items,glyphs] [filter]
import { chromium } from "playwright";
import { readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? ".";
const sets = (process.argv[3] ?? "items,glyphs").split(",");
const filter = process.argv[4] ?? "";
// Read straight off disk (file://) — the dev server caches /public assets, and
// a freshly repainted batch must not be judged against a stale response.
const BASE = `file:///${join(root, "public").replace(/\\/g, "/")}`;

let body = "";
for (const set of sets) {
  const files = readdirSync(join(root, "public", "icons", "painted", set))
    .filter((f) => f.endsWith(".svg") && f.includes(filter));
  body += `<h2>${set} (${files.length})</h2><div class=g>` + files.map((f) => {
    const u = `${BASE}/icons/painted/${set}/${f}`;
    return `<figure><div class=box><img src="${u}"></div>` +
      `<div class=pip><img src="${u}"></div><figcaption>${f.replace(".svg", "")}</figcaption></figure>`;
  }).join("") + `</div>`;
}

const html = `<!doctype html><meta charset=utf-8><style>
body{background:#171208;color:#cbbfa4;font:12px/1.3 ui-sans-serif,system-ui;margin:18px}
h2{color:#f2c14e;letter-spacing:.2em;font-size:12px}
.g{display:flex;flex-wrap:wrap;gap:10px}
figure{margin:0;width:96px;text-align:center}
.box{width:60px;height:60px;margin:0 auto;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(180deg,#251d14,#14100c);border:1px solid #6e5533;border-radius:3px}
.box img{width:50px;height:50px}
.pip{margin:4px auto 2px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;
  background:#0e0b07;border:1px solid #4a3a22;border-radius:50%}
.pip img{width:14px;height:14px}
figcaption{color:#8a7f6a;font-size:9px;word-break:break-all}
</style>${body}`;

// The page must LIVE on file:// too — an about:blank document may not pull
// file:// subresources.
const tmp = join(OUT, "_iconsheet.html");
writeFileSync(tmp, html);
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
await page.goto(`file:///${tmp.replace(/\\/g, "/")}`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${OUT}/iconsheet.png`, fullPage: true });
await browser.close();
console.log("saved", `${OUT}/iconsheet.png`);
