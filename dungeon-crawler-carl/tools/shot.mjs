// Screenshot harness for visual QA loops.
// Usage: node tools/shot.mjs "<url>" <out.png> [--wait ms] [--w px] [--h px] [--keys "w:800,1:0"] [--click x,y] [--settle ms]
//   --keys  comma list of key:holdMs pairs sent after load (e.g. "w:600" walks up)
// Renders with SwiftShader WebGL in headless chromium.
import { chromium } from "playwright";

const [url, out] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node tools/shot.mjs <url> <out.png> [flags]"); process.exit(1); }
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const wait = Number(flag("--wait", 3500));
const settle = Number(flag("--settle", 400));
const width = Number(flag("--w", 1600));
const height = Number(flag("--h", 900));
const keys = flag("--keys", "");
const click = flag("--click", "");

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });
await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(wait);
if (click) {
  const [cx, cy] = click.split(",").map(Number);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
}
if (keys) {
  for (const pair of keys.split(",")) {
    const [k, holdRaw] = pair.split(":");
    const hold = Number(holdRaw ?? 120);
    await page.keyboard.down(k);
    await page.waitForTimeout(hold);
    await page.keyboard.up(k);
    await page.waitForTimeout(80);
  }
}
await page.waitForTimeout(settle);
// Post-processing under SwiftShader renders at seconds-per-frame; give the
// capture generous room instead of the 30s playwright default.
await page.screenshot({ path: out, timeout: 120000 });
await browser.close();
console.log("saved", out);
