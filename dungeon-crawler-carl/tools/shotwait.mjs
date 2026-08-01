// Like tools/shot.mjs but POLLS <html data-assets-settled="1"> (assets.ts
// stamps it when the manifest settles) instead of sleeping a fixed wait —
// robust when the dev server is busy re-transforming after HMR.
// Usage: node tools/shotwait.mjs "<url>" <out.png> [--timeout ms] [--keys "w:800"] [--settle ms]
import { chromium } from "playwright";

const [url, out] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node tools/shotwait.mjs <url> <out.png> [flags]"); process.exit(1); }
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const timeout = Number(flag("--timeout", 120000));
const settle = Number(flag("--settle", 2500));
const keys = flag("--keys", "");

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
// Two gates, retried across one reload (HMR reload storms from concurrent
// agents can wedge a boot): (1) assets settled, (2) the SIGNAL ACQUISITION
// loading screen actually dismissed — assets-settled alone still captured
// title-card frames when the floor build lagged the manifest.
let ready = false;
for (let attempt = 0; attempt < 2 && !ready; attempt++) {
  try {
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout });
    await page.waitForFunction(() => {
      const el = document.getElementById("loading");
      return !el || el.classList.contains("done") || getComputedStyle(el).display === "none";
    }, null, { timeout: 90000 });
    ready = true;
  } catch {
    if (attempt === 0) {
      console.error("WARN: boot never became ready; reloading once");
      await page.reload({ waitUntil: "load", timeout: 60000 }).catch(() => {});
    }
  }
}
if (!ready) console.error("WARN: page never reached floor-ready; shooting anyway");
await page.waitForTimeout(3500); // floor build + first frames after settle
// Dismiss SYSTEM tutorial/courtesy modals: a review panel must never ship the
// same undismissed popup twice (critic r3 minor). They can also appear late
// (favorites explanation triggers mid-walk), so this runs again pre-shot.
async function dismissModals() {
  for (let i = 0; i < 4; i++) {
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")].filter((b) => {
        const t = (b.textContent || "").trim().toUpperCase();
        if (t !== "GOT IT" && t !== "OK" && t !== "DISMISS") return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      btns.forEach((b) => b.click());
      return btns.length > 0;
    }).catch(() => false);
    if (!clicked) break;
    await page.waitForTimeout(300);
  }
}
await dismissModals();
if (keys) {
  for (const pair of keys.split(",")) {
    const [k, holdRaw] = pair.split(":");
    await page.keyboard.down(k);
    await page.waitForTimeout(Number(holdRaw ?? 120));
    await page.keyboard.up(k);
    await page.waitForTimeout(80);
  }
}
await page.waitForTimeout(settle);
await dismissModals();
await page.screenshot({ path: out, timeout: 120000 });
await browser.close();
console.log("saved", out);
