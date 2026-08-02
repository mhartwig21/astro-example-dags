// Round-1 critique, part 3: a REAL daily run actually played for a while, so
// the verdict has real numbers in it, plus the remaining standings tabs.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "tools/_critic1";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5430/iso.html";
const API = "http://localhost:5433";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

const API_PATHS = /\/(boards|bands|events|crawler|runs|rivals|auth|open-parties)(\/|\?|$)/;
await page.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  if (API_PATHS.test(u.pathname)) {
    const req = route.request();
    try {
      const r = await fetch(API + u.pathname + u.search, {
        method: req.method(),
        headers: { "content-type": req.headers()["content-type"] ?? "application/json" },
        body: ["GET", "HEAD"].includes(req.method()) ? undefined : (req.postDataBuffer() ?? undefined),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      await route.fulfill({ status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" }, body: buf });
    } catch (e) { console.error("PROXY FAIL", u.pathname, e.message); await route.abort(); }
    return;
  }
  await route.continue();
});

await page.addInitScript(() => {
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
});

const settle = () => page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch {} } });
async function shot(name) {
  await settle(); await page.waitForTimeout(200);
  await page.screenshot({ timeout: 300000, path: `${OUT}/${name}.png` });
  console.log("saved", name);
}

await page.goto(`${BASE}?debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(() => document.getElementById("m-daily")?.click());
await page.waitForTimeout(1200);
await page.evaluate(() => document.getElementById("m-cast-go")?.click());
await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });

// PLAY. Hold a direction and attack so the run produces real numbers.
const canvas = await page.$("canvas");
const box = await canvas.boundingBox();
for (let i = 0; i < 26; i++) {
  const k = ["w", "d", "s", "a"][i % 4];
  await page.keyboard.down(k);
  await page.mouse.move(box.x + box.width * (0.3 + 0.4 * Math.random()), box.y + box.height * (0.3 + 0.4 * Math.random()));
  await page.mouse.down(); await page.waitForTimeout(1500); await page.mouse.up();
  await page.waitForTimeout(1500);
  await page.keyboard.up(k);
  if (i % 6 === 5) {
    const st = await page.evaluate(() => ({ f: window.__dcc.state.floor, el: window.__dcc.state.elapsed, k: window.__dcc.state.players[0].kills, hp: window.__dcc.state.players[0].hp }));
    console.log("play tick", i, JSON.stringify(st));
    if (st.el > 150) break;
  }
  if (await page.evaluate(() => window.__dcc.state.status !== "playing")) { console.log("died naturally at", i); break; }
}
console.log("pre-death:", JSON.stringify(await page.evaluate(() => ({ f: window.__dcc.state.floor, el: window.__dcc.state.elapsed, k: window.__dcc.state.players[0].kills }))));
await page.evaluate(() => { const s = window.__dcc.state; if (s.status === "playing") { s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead"; } });
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 }).catch(() => console.error("WARN no recap"));
await page.waitForTimeout(5000);
await shot("T-verdict-played");
console.log("=== PLAYED VERDICT ===\n" + await page.evaluate(() => document.getElementById("recap")?.innerText) + "\n=== END ===");
await page.keyboard.down("Tab"); await page.waitForTimeout(600);
await shot("U-verdict-played-tab");
await page.keyboard.up("Tab");

// remaining standings tabs
await page.evaluate(() => document.getElementById("recap-standings")?.click());
await page.waitForTimeout(3000);
for (const t of ["alltime", "bands", "rivals"]) {
  await page.evaluate((tt) => document.querySelector(`#ladder [data-lt="${tt}"]`)?.click(), t);
  await page.waitForTimeout(2500);
  await shot(`V-standings-${t}`);
  console.log(`=== ${t} ===\n` + await page.evaluate(() => document.getElementById("ladder-body")?.innerText) + "\n=== END ===");
}

await browser.close();
console.log("done");
