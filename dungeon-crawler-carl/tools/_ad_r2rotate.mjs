// The #rotate gate, honestly. r1 reported it MISSED at 390x844 with
// isMobile+touch+iPhone UA and concluded the gate was untested. The reason is
// in main3d.ts:89 — `isPhone` reads `screen.width/height`, and Chromium under
// device emulation reports the HOST screen, not the emulated viewport, so the
// `body.phone` class the gate keys off never gets added. `?phone=1` is the
// documented headless hook for exactly this. One browser, one page.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] || "shots/ad-r2";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const out = [];
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  page.setDefaultTimeout(180000);
  const cdp = await page.context().newCDPSession(page);
  await page.goto("http://localhost:5284/iso.html?test&floor=2&level=4&phone=1&eagerassets",
    { waitUntil: "commit", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
    null, { timeout: 200000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const rot = await page.evaluate(() => {
    const r = document.getElementById("rotate");
    if (!r) return { display: "absent" };
    const cs = getComputedStyle(r), b = r.getBoundingClientRect();
    return { display: cs.display, opacity: cs.opacity, bodyCls: document.body.className,
      portrait: matchMedia("(orientation: portrait)").matches,
      box: `${Math.round(b.width)}x${Math.round(b.height)}`,
      over: r.scrollHeight - r.clientHeight,
      docOver: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      text: (r.textContent || "").trim().replace(/\s+/g, " ").slice(0, 110) };
  });
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish(); }).catch(() => {});
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const up = rot.display !== "none" && rot.display !== "absent";
  writeFileSync(`${OUT}/${up ? "" : "MISSED-"}rotate-390x844.png`, Buffer.from(data, "base64"));
  out.push(["rotate 390x844", JSON.stringify(rot)]);
  await page.close();
} finally { await browser.close(); }
for (const [k, v] of out) console.log(`--- ${k}\n${v}`);
