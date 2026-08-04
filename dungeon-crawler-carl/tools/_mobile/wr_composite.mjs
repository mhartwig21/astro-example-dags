// Build the owner's side-by-side: our rebuilt cluster on a live gameplay
// frame vs the Wild Rift reference, tiled in a scratch page and screenshotted.
//   node tools/_mobile/wr_composite.mjs <ours.png> <ref.jpg> <out.png>
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { resolve } from "path";

const ours = resolve(process.argv[2] ?? "tools/_mobile/wr-arr/combat.png");
const ref = resolve(process.argv[3] ?? "C:/Users/hartw/.claude/jobs/d43e193f/tmp/refs/wr_03_aim_tidalwave.jpg");
const out = resolve(process.argv[4] ?? "C:/Users/hartw/.claude/jobs/d43e193f/tmp/wr-sidebyside.png");

const H = 520; // common tile height; both frames are ~2.2:1 landscape
const page1 = `<!doctype html><html><head><style>
  body { margin: 0; background: #0b0e12; font: 700 15px/1.4 system-ui, sans-serif; }
  .row { display: flex; gap: 10px; padding: 10px; align-items: flex-start; }
  figure { margin: 0; }
  img { height: ${H}px; width: auto; display: block; border: 1px solid #2a2f38; }
  figcaption { color: #cfd6e1; padding: 6px 2px; letter-spacing: 0.02em; }
  figcaption span { color: #8b93a1; font-weight: 400; }
</style></head><body>
  <div class="row">
    <figure>
      <figcaption>DUNGEON CRAWLER CLAUDE — rebuilt corner cluster <span>(iPhone 13 landscape, live frame, real GPU)</span></figcaption>
      <img id="a" src="file:///${ours.replace(/\\/g, "/")}">
    </figure>
    <figure>
      <figcaption>WILD RIFT — reference control corner <span>(wr_03)</span></figcaption>
      <img id="b" src="file:///${ref.replace(/\\/g, "/")}">
    </figure>
  </div>
</body></html>`;
const scratch = resolve("tools/_mobile/wr-arr/composite.html");
writeFileSync(scratch, page1);

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--window-size=1400,800"],
});
try {
  const page = await browser.newPage({ viewport: { width: 2540, height: H + 80 }, deviceScaleFactor: 1 });
  await page.goto(`file:///${scratch.replace(/\\/g, "/")}`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const box = await page.evaluate(() => {
    const r = document.querySelector(".row").getBoundingClientRect();
    return { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  await page.setViewportSize({ width: box.width, height: box.height });
  await page.screenshot({ path: out, clip: box });
  console.log("composite ->", out, JSON.stringify(box));
} finally {
  await browser.close();
}
