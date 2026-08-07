// Round-2 check: does the shader guard fire on CHROME too, or only WebKit?
// One headless chromium, floor 5 (webkit smoke's scene) + floor 10, console tally.
import { chromium } from "playwright";

const PORT = 5288;
const urls = [
  `http://localhost:${PORT}/iso.html?test&floor=2&seed=42&debug=1`,
  `http://localhost:${PORT}/iso.html?test&floor=16&level=14&abilities=all&gold=500&seed=42&debug=1`,
];

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--dcc-r2-shaderguard-5288"],
});
const out = {};
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const lines = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[shader-guard]")) lines.push(t);
  });
  for (const url of urls) {
    lines.length = 0;
    await page.goto(url, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => {
      const el = document.querySelector("#loading");
      if (!el) return true;
      const cs = getComputedStyle(el);
      return el.classList.contains("done") || cs.display === "none" || +cs.opacity === 0;
    }, { timeout: 300000, polling: 500 });
    await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.state, { timeout: 60000 });
    // 25 s of play so anything lazy gets a chance to compile
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      await page.keyboard.down("d"); await page.waitForTimeout(300); await page.keyboard.up("d");
      await page.keyboard.down(" "); await page.waitForTimeout(260); await page.keyboard.up(" ");
      await page.keyboard.down("w"); await page.waitForTimeout(300); await page.keyboard.up("w");
    }
    const progs = await page.evaluate(() => {
      try { return window.__dcc.renderer.renderer.info.programs.length; } catch (e) { return null; }
    });
    const armed = lines.find((l) => l.includes("armed:"))?.match(/armed: (\d+)/)?.[1] ?? null;
    const built = lines.filter((l) => l.includes("built AFTER boot"));
    out[url] = {
      prewarmed: armed ? +armed : null,
      builtAfterBoot: built.length,
      liveProgramCount: progs,
      keys: built.map((l) => (l.match(/cacheKey: (.*)/) || [])[1]?.slice(0, 220)),
    };
    console.log(JSON.stringify({ url, ...out[url] }, null, 1));
  }
} finally {
  await browser.close();
}
