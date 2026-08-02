// Round-1 critique, part 2: the REAL path. A fresh (non-test) run recorded from
// floor 1, submitted to the live server on :5433 (the vite dev server does not
// proxy the competitive API, so the harness routes it), plus the standings and
// career surfaces with real rows.
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

const API_PATHS = /\/(boards|bands|events|crawler|runs|rivals|auth|open-parties|leaderboard)(\/|\?|$)/;
await page.route("**/*", async (route) => {
  const u = new URL(route.request().url());
  if (API_PATHS.test(u.pathname)) {
    const target = API + u.pathname + u.search;
    const req = route.request();
    try {
      const r = await fetch(target, {
        method: req.method(),
        headers: { "content-type": req.headers()["content-type"] ?? "application/json" },
        body: ["GET", "HEAD"].includes(req.method()) ? undefined : (req.postDataBuffer() ?? undefined),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      console.log("PROXY", req.method(), u.pathname, "->", r.status, buf.length + "b");
      await route.fulfill({
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") ?? "application/json", "access-control-allow-origin": "*" },
        body: buf,
      });
    } catch (e) { console.error("PROXY FAIL", u.pathname, e.message); await route.abort(); }
    return;
  }
  await route.continue();
});

await page.addInitScript(() => {
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
});

async function settle() {
  await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch {} } });
  await page.waitForTimeout(200);
}
async function shot(name) {
  await settle();
  await page.screenshot({ timeout: 300000, path: `${OUT}/${name}.png` });
  console.log("saved", name);
}

// ---- fresh recorded run, floor 1, die immediately
await page.goto(`${BASE}?debug=1`, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => {});
// click through the menu to start a run
await page.waitForTimeout(1500);
const menuText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
console.log("=== MENU ===\n" + menuText + "\n=== END MENU ===");
await page.evaluate(() => document.getElementById("m-daily")?.click());
await page.waitForTimeout(1200);
await shot("O-campfire");
await page.evaluate(() => document.getElementById("m-cast-go")?.click());
await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 })
  .catch(() => console.error("WARN never started"));
// let it run a few seconds of real ticks so the proof is not zero-length
await page.waitForTimeout(6000);
await page.evaluate(() => { const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead"; });
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 })
  .catch(async () => {
    console.error("WARN no recap; diag=" + JSON.stringify(await page.evaluate(() => ({
      status: window.__dcc?.state?.status,
      hp: window.__dcc?.state?.players?.[0]?.hp,
      alive: window.__dcc?.state?.players?.[0]?.alive,
      disp: document.getElementById("recap")?.style.display,
    }))));
  });
await shot("P-verdict-real-t0");
// watch the seal resolve
for (const wait of [3000, 6000]) {
  await page.waitForTimeout(wait);
  await shot(`P-verdict-real-t${wait}`);
}
console.log("=== REAL VERDICT ===\n" + await page.evaluate(() => document.getElementById("recap")?.innerText) + "\n=== END ===");
await page.keyboard.down("Tab");
await page.waitForTimeout(500);
await shot("Q-verdict-real-tab");
console.log("=== TAB ===\n" + await page.evaluate(() => document.getElementById("recap")?.innerText) + "\n=== END ===");
await page.keyboard.up("Tab");

// ---- standings with real rows
await page.evaluate(() => document.getElementById("recap-standings")?.click());
await page.waitForTimeout(3000);
await shot("R-standings-contracts");
console.log("=== STANDINGS ===\n" + await page.evaluate(() => document.getElementById("ladder")?.innerText) + "\n=== END ===");
const tabs = await page.evaluate(() => Array.from(document.querySelectorAll("#ladder [data-tab]")).map((e) => e.dataset.tab));
console.log("tabs:", JSON.stringify(tabs));
for (const t of tabs.filter((x) => x !== "contracts")) {
  await page.evaluate((tt) => document.querySelector(`#ladder [data-tab="${tt}"]`)?.click(), t);
  await page.waitForTimeout(2500);
  await shot(`R-standings-${t}`);
  console.log(`=== STANDINGS ${t} ===\n` + await page.evaluate(() => document.getElementById("ladder")?.innerText) + "\n=== END ===");
}

// ---- career
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById("m-careerset")?.click());
await page.waitForTimeout(3000);
await shot("S-career");
console.log("=== CAREER ===\n" + await page.evaluate(() => document.getElementById("career")?.innerText) + "\n=== END ===");

await browser.close();
console.log("done");
