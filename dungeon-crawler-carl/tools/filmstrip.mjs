// FILM STRIP — motion made reviewable in one image.
//
// Every critic round so far has judged STILLS, and every bug the owner found
// (shadow stutter, boss-cam losing the player, lag) lives BETWEEN frames.
// This captures N frames at a fixed cadence while the game plays, composites
// them into one contact sheet (tiled in-browser — no image deps), captions
// each cell with the sim events that fired since the previous cell, and
// reports a frame-pair difference series so periodic stutter shows up as a
// NUMBER (a strong alternating diff signature = something updating at half
// framerate).
//
// Usage:
//   node tools/filmstrip.mjs <url> <out.jpg> [--frames 10] [--every 150]
//                            [--keys "w:1600"] [--crop x,y,w,h]
//
//   <url>     full test-mode URL (include &debug=1&eagerassets&clean=1)
//   --keys    hold keys while capturing, e.g. "w:1600" walks up for 1.6s
//   --crop    analyse diffs on a sub-region only (e.g. the ground under the
//             player, to isolate the shadow) — cells still show full frame
//
// Honesty rules baked in: real-GPU launch, #loading must be GONE (not just
// data-assets-settled), and the strip FAILS if any two consecutive cells are
// byte-identical (a frozen game photographs as a beautiful, useless strip).
import { chromium } from "playwright";

const [, , URL_ARG, OUT, ...rest] = process.argv;
if (!URL_ARG || !OUT) {
  console.error('usage: node tools/filmstrip.mjs <url> <out.jpg> [--frames N] [--every ms] [--keys "w:1600"] [--crop x,y,w,h]');
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const FRAMES = Number(opt("frames", 10));
const EVERY = Number(opt("every", 150));
const KEYS = opt("keys", "");
const CROP = opt("crop", "");

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(URL_ARG, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
await page
  .waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 180000 })
  .catch(() => {});
await page.waitForTimeout(2500);
const booting = await page.evaluate(() => {
  const el = document.getElementById("loading");
  return !!el && !el.classList.contains("done") && (el.offsetWidth > 0 || el.offsetHeight > 0);
});
if (booting) {
  console.error("FAIL: still on the boot screen — refusing to photograph the loading card.");
  await browser.close();
  process.exit(1);
}

// Event cursor: remember how much of the log we have seen, caption the delta.
await page.evaluate(() => {
  const d = window.__dcc;
  window.__fsCursor = d?.state?.events?.length ?? 0;
});

// Start held keys (fire and forget — capture proceeds while they play out).
if (KEYS) {
  for (const spec of KEYS.split(",")) {
    const [k, ms] = spec.split(":");
    page.keyboard.down(k).then(async () => {
      await page.waitForTimeout(Number(ms) || 500);
      await page.keyboard.up(k).catch(() => {});
    }).catch(() => {});
  }
  await page.waitForTimeout(120); // let the input register before frame 1
}

const cells = [];
for (let i = 0; i < FRAMES; i++) {
  const shot = await page.screenshot({ type: "jpeg", quality: 78 });
  const events = await page.evaluate(() => {
    const d = window.__dcc;
    const evs = d?.state?.events ?? [];
    const from = window.__fsCursor ?? evs.length;
    window.__fsCursor = evs.length;
    const hits = (d?.state?.hits?.length ?? 0);
    return { fresh: evs.slice(from).slice(-2), hits };
  });
  cells.push({ b64: shot.toString("base64"), caption: events.fresh.join(" · ").slice(0, 90), hits: events.hits });
  if (i < FRAMES - 1) await page.waitForTimeout(EVERY);
}

// Identical-cell guard + diff series, computed in-browser on canvases.
const analysis = await page.evaluate(async ({ cells, crop }) => {
  const region = crop ? crop.split(",").map(Number) : null;
  const imgs = await Promise.all(cells.map((c) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.src = "data:image/jpeg;base64," + c.b64;
  })));
  const w = imgs[0].width, h = imgs[0].height;
  const [rx, ry, rw, rh] = region ?? [0, 0, w, h];
  const cv = document.createElement("canvas"); cv.width = rw; cv.height = rh;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const px = imgs.map((im) => { cx.drawImage(im, rx, ry, rw, rh, 0, 0, rw, rh); return cx.getImageData(0, 0, rw, rh).data; });
  const diffs = [];
  for (let i = 1; i < px.length; i++) {
    let sum = 0;
    const a = px[i - 1], b = px[i];
    for (let j = 0; j < a.length; j += 16) sum += Math.abs(a[j] - b[j]); // sampled luma-ish
    diffs.push(Math.round(sum / (a.length / 16)));
  }
  // Alternation score: |even-mean − odd-mean| / overall-mean. Near 0 = smooth;
  // > ~0.5 = something updating every OTHER frame in this region.
  const even = diffs.filter((_, i) => i % 2 === 0), odd = diffs.filter((_, i) => i % 2 === 1);
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const alternation = mean(diffs) ? Math.abs(mean(even) - mean(odd)) / mean(diffs) : 0;
  return { diffs, alternation: Number(alternation.toFixed(3)), identicalPairs: diffs.filter((d) => d === 0).length };
}, { cells: cells.map((c) => ({ b64: c.b64 })), crop: CROP });

if (analysis.identicalPairs > 0) {
  console.error(`FAIL: ${analysis.identicalPairs} consecutive cell pair(s) byte-identical — the game was not moving. Strip rejected.`);
  await browser.close();
  process.exit(1);
}

// Composite the strip in-browser (grid + captions), screenshot the composite.
const COLS = Math.min(5, FRAMES);
await page.setViewportSize({ width: COLS * 428, height: Math.ceil(FRAMES / COLS) * 268 + 30 });
await page.setContent(`<body style="margin:0;background:#111;font:11px monospace;color:#cea">
  <div style="padding:4px">strip: ${FRAMES}f @ ${EVERY}ms · diffs [${analysis.diffs.join(",")}] · alternation ${analysis.alternation}${CROP ? ` (crop ${CROP})` : ""}</div>
  <div style="display:grid;grid-template-columns:repeat(${COLS},1fr);gap:4px;padding:4px">
    ${cells.map((c, i) => `<div><img src="data:image/jpeg;base64,${c.b64}" style="width:100%;display:block">
      <div style="height:26px;overflow:hidden;padding:1px 2px;color:#9c8">#${i} +${i * EVERY}ms ${c.caption || ""}</div></div>`).join("")}
  </div></body>`);
await page.waitForTimeout(400);
await page.screenshot({ path: OUT, type: "jpeg", quality: 82, fullPage: true });

console.log(JSON.stringify({ out: OUT, frames: FRAMES, everyMs: EVERY, diffs: analysis.diffs, alternation: analysis.alternation, pageErrors }, null, 2));
console.log(analysis.alternation > 0.5
  ? `WARN: alternation ${analysis.alternation} — something in ${CROP ? "the crop region" : "frame"} updates every other frame (half-rate cadence).`
  : `alternation ${analysis.alternation} — no half-rate cadence detected.`);
await browser.close();
