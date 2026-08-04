// The owner's side-by-side, ROUND 4: our resized/de-overlapped corner cluster
// on a live gameplay frame beside the SAME Wild Rift reference as last round,
// with the measured ratios printed under both so the match is checkable rather
// than assertable.
//   node tools/_mobile/wr_composite2.mjs <ours.png> <ref.jpg> <out.png>
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { resolve } from "path";

const ours = resolve(process.argv[2] ?? "tools/_mobile/wr-r4/combat.png");
const ref = resolve(process.argv[3] ?? "C:/Users/hartw/.claude/jobs/d43e193f/tmp/refs/wr_03_aim_tidalwave.jpg");
const out = resolve(process.argv[4] ?? "C:/Users/hartw/.claude/jobs/d43e193f/tmp/wr-sidebyside-2.png");

const H = 520; // common tile height; both frames are ~2.2:1 landscape
// Measured: ours off the live zone table below, WR off wr_01 (1024x461) and
// confirmed on wr_03 (1024x458). Every row is a RATIO, so the two frames are
// comparable despite different pixel sizes.
const ROWS = [
  ["ability disc / viewport height", "0.126", "0.125", "43 px on a 342 px viewport (was 0.164)"],
  ["basic attack / viewport height", "0.187", "0.185", "64 px = 1.49x an ability (was 0.246)"],
  ["ultimate / viewport height", "0.140", "0.130", "48 px, still the biggest fan chip"],
  ["neighbour pitch / disc diameter", "1.26 - 1.36", "1.22 - 1.26", "was 0.86 — the overlap"],
  ["gap between neighbouring discs", "11 - 15 px", "0.24 x disc", "was MINUS 8 px"],
  ["hit target under every disc", "44 px", "n/a", "never shrinks; only the paint does"],
];

const page1 = `<!doctype html><html><head><style>
  body { margin: 0; background: #0b0e12; font: 700 15px/1.4 system-ui, sans-serif; }
  .row { display: flex; gap: 10px; padding: 10px 10px 0; align-items: flex-start; }
  figure { margin: 0; }
  img { height: ${H}px; width: auto; display: block; border: 1px solid #2a2f38; }
  figcaption { color: #cfd6e1; padding: 6px 2px; letter-spacing: 0.02em; }
  figcaption span { color: #8b93a1; font-weight: 400; }
  table { border-collapse: collapse; margin: 4px 10px 12px; font-size: 15px; }
  th, td { padding: 5px 14px; text-align: left; border-bottom: 1px solid #222831; }
  th { color: #8b93a1; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; font-size: 12px; }
  td { color: #e6ebf2; font-weight: 600; }
  td.k { color: #9aa3b2; font-weight: 400; }
  td.n { color: #8b93a1; font-weight: 400; }
</style></head><body>
  <div class="row">
    <figure>
      <figcaption>DUNGEON CRAWLER CLAUDE <span>— resized cluster, iPhone 13 landscape, live frame, real GPU</span></figcaption>
      <img id="a" src="file:///${ours.replace(/\\/g, "/")}">
    </figure>
    <figure>
      <figcaption>WILD RIFT <span>— the same reference corner as last round (wr_03)</span></figcaption>
      <img id="b" src="file:///${ref.replace(/\\/g, "/")}">
    </figure>
  </div>
  <table>
    <tr><th>measured</th><th>ours</th><th>wild rift</th><th></th></tr>
    ${ROWS.map(([k, a, b, n]) =>
    `<tr><td class="k">${k}</td><td>${a}</td><td>${b}</td><td class="n">${n}</td></tr>`).join("")}
  </table>
</body></html>`;
const scratch = resolve("tools/_mobile/wr-r4/composite2.html");
writeFileSync(scratch, page1);

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--window-size=1400,800"],
});
try {
  const page = await browser.newPage({ viewport: { width: 2540, height: H + 260 }, deviceScaleFactor: 1 });
  await page.goto(`file:///${scratch.replace(/\\/g, "/")}`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const box = await page.evaluate(() => {
    const r = document.querySelector(".row").getBoundingClientRect();
    const t = document.querySelector("table").getBoundingClientRect();
    return { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(t.bottom + 12) };
  });
  await page.setViewportSize({ width: box.width, height: box.height });
  await page.screenshot({ path: out, clip: box });
  console.log("composite ->", out, JSON.stringify(box));
} finally {
  await browser.close();
}
