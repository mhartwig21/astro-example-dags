// Does R actually RUN IT BACK (same seed + ghost)? And how long is the reveal?
import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", e => console.error("PAGE ERROR:", e.message));
await page.addInitScript(() => { localStorage.setItem("dcc:token:v1", "SHOTCRAWLER"); localStorage.setItem("dcc:name:v1", "Carl"); localStorage.setItem("dcc:consent:v1", "public"); });
await page.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent("http://localhost:5431")}&noassets&debug=1`, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForTimeout(2000);
await page.click("#m-solo"); await page.waitForTimeout(1500); await page.click("#m-cast-go");
await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
const seed1 = await page.evaluate(() => window.__dcc.state.seed);
for (let i = 0; i < 3; i++) { await page.keyboard.down("w"); await page.waitForTimeout(700); await page.keyboard.up("w"); }
await page.evaluate(() => { const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead"; });
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });

// the reveal: how many animations and how long
const anim = await page.evaluate(() => {
  const a = document.getAnimations().filter(x => x.effect?.target?.closest?.("#recap"));
  return a.map(x => ({ n: x.animationName || "?", d: x.effect?.getTiming?.().duration, del: x.effect?.getTiming?.().delay }));
});
console.log("recap animations:", anim.length, JSON.stringify(anim.slice(0, 20)));
const last = Math.max(0, ...anim.map(x => (Number(x.del) || 0) + (Number(x.d) || 0)));
console.log("cascade ends at", last, "ms");

await page.waitForTimeout(6000);
console.log("primary CTA label:", await page.evaluate(() => document.getElementById("recap-again")?.innerText.replace(/\n/g, " | ")));
// press R
await page.keyboard.press("r");
await page.waitForTimeout(4000);
const after = await page.evaluate(() => ({
  seed: window.__dcc?.state?.seed, status: window.__dcc?.state?.status,
  recap: document.getElementById("recap")?.style.display,
  ghost: !!window.__dcc?.ghost || document.getElementById("ghostchip")?.style.display,
  chip: document.querySelector("#ghostchip, .ghostchip")?.innerText,
}));
console.log("seed before:", seed1, "after R:", JSON.stringify(after));
await page.screenshot({ timeout: 300000, path: "tools/_acc5/after-R.png" });
await browser.close();
