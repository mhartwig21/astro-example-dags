// Visual regression guard for the content-hashed asset round: every asset url
// changed, so the failure mode is a MISSING icon/font/model, not a wrong pixel.
// Boots a real stage, opens the icon-heavy panels, and reports (a) every failed
// request, (b) every <img>/mask-image that resolved to nothing, (c) whether the
// two document fonts actually loaded. Screenshots for the eyeball pass.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const base = process.argv[2] ?? "http://127.0.0.1:5285";
const url = `${base}/iso.html?test&floor=9&level=12&abilities=all&gold=500&seed=42&eagerassets`;

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(180000);
const shot = (path) => page.screenshot({ path, timeout: 180000 }).catch((e) => console.log("shot skipped:", path, e.message.slice(0, 60)));
const failed = [];
page.on("requestfailed", (r) => failed.push(`FAILED ${r.url()}`));
page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
page.on("pageerror", (e) => failed.push(`PAGEERROR ${e.message}`));

await page.goto(url, { waitUntil: "commit", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 });
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || el.classList.contains("done");
}, null, { timeout: 300000 }).catch(() => {});
await page.waitForTimeout(2500);

// Panels that are nothing BUT icons: character sheet, inventory, ability index.
for (const key of ["p", "i", "k"]) {
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
  await shot(`tools/_hashvisual_${key}.png`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}
await shot("tools/_hashvisual_world.png");

const report = await page.evaluate(() => {
  const brokenImgs = [...document.querySelectorAll("img")]
    .filter((i) => i.currentSrc && i.complete && i.naturalWidth === 0)
    .map((i) => i.currentSrc);
  // Every url() the live styles point at, resolved through the network.
  const urls = new Set();
  for (const el of document.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    for (const prop of ["maskImage", "webkitMaskImage", "backgroundImage"]) {
      const v = s[prop];
      if (v && v !== "none") for (const m of v.matchAll(/url\("([^"]+)"\)/g)) urls.add(m[1]);
    }
  }
  return {
    brokenImgs,
    cssUrls: [...urls].filter((u) => u.startsWith(location.origin)),
    fonts: [...document.fonts].map((f) => `${f.family} ${f.style} ${f.weight}: ${f.status}`),
    modelKeys: Object.keys(window.__dcc?.renderer?.models ?? {}).length,
  };
});

// Resolve every CSS url the page actually asked for.
const bad = [];
for (const u of report.cssUrls) {
  const r = await page.request.get(u);
  if (!r.ok()) bad.push(`${r.status()} ${u}`);
}

console.log("failed requests / page errors:", failed.length ? failed.slice(0, 20) : "none");
console.log("broken <img>:", report.brokenImgs.length ? report.brokenImgs.slice(0, 10) : "none");
console.log(`css url() referenced: ${report.cssUrls.length}, unreachable: ${bad.length ? bad.slice(0, 10) : "none"}`);
console.log("fonts:", report.fonts.join(" | "));
console.log("models loaded:", report.modelKeys);
await browser.close();
