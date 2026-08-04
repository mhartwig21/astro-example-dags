// Session-only capture of THE VERDICT (wipe = IN MEMORIAM). Deleted after use.
//   node tools/_verdictshot.mjs <label>
// ONE browser, launched and closed inside this process.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "tools/_verdict";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5281/iso.html";
const label = process.argv[2] ?? "shot";
mkdirSync(OUT, { recursive: true });

const HISTORY = [];
for (let i = 0; i < 31; i++) {
  const floor = [2, 3, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 11, 12, 13, 15, 18][i % 20];
  const wob = ((i * 2654435761) % 997) / 997;
  HISTORY.push({
    endedAt: Date.now() - (i + 1) * 3600_000 * 7 - Math.round(wob * 3600_000),
    mode: i % 3 === 0 ? "daily" : "random",
    day: "2026-07-" + String((i % 28) + 1).padStart(2, "0"),
    name: "Carl", won: floor === 18, floor,
    timeSec: 90 * floor + Math.round(wob * 220),
    level: Math.min(35, 3 + floor * 2),
    kills: floor * 28 + Math.round(wob * 41),
    damageDealt: floor * 900 + Math.round(wob * 1300),
    damageTaken: floor * 260 + Math.round(wob * 410),
    gold: 400, viewers: 11_400 + i * 873 + Math.round(wob * 611),
    favorites: 287 + i * 19 + Math.round(wob * 23), sponsors: i % 4, seed: 1000 + i,
  });
}

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });

try {
  await page.addInitScript(([hist]) => {
    localStorage.setItem("dcc:token:v1", "SHOTCRAWLER");
    localStorage.setItem("dcc:consent:v1", "public");
    localStorage.setItem("dcc:name:v1", "Carl");
    localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
    localStorage.removeItem("dcc:bandbests:v1");
  }, [HISTORY]);

  // A REAL run, not the test chamber: `?test` stamps TEST CHAMBER — NOT RANKED
  // and suppresses the ladder plate, which is half the panel under review.
  const url = `${BASE}?debug=1&eagerassets&clean=1`;
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
    null, { timeout: 240000 }).catch(() => console.error("WARN assets never settled"));
  // READINESS: data-assets-settled is not playable — poll until #loading has
  // actually left the screen, then let the shader precompile finish.
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0
      || l.getBoundingClientRect().width === 0;
  }, null, { timeout: 240000 });
  await page.waitForTimeout(3000);
  const box = await page.evaluate(() => {
    const l = document.getElementById("loading");
    return l ? l.getBoundingClientRect().width * l.getBoundingClientRect().height : 0;
  });
  if (box > 0) throw new Error("#loading still has a box — the shot would photograph the boot card");

  // Start today's contract from the front door, so the screen carries a real
  // mode, a real seed and a real ladder line.
  await page.click("#m-daily");
  await page.waitForTimeout(900);
  await page.click("#m-cast-go");
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 120000 });
  // Fight for a stretch so the run has kills, a level and a build to report.
  for (let i = 0; i < 10; i++) {
    await page.keyboard.down(" ");
    await page.waitForTimeout(700);
    await page.keyboard.up(" ");
  }
  // The SIM ends the run: zero the crawler and step until its own wipe rule
  // flips status. Nothing about the verdict screen is faked.
  await page.evaluate(() => {
    const d = window.__dcc, st = d.state, p = st.players[0];
    for (let i = 0; i < 3000 && st.status === "playing"; i++) {
      p.hp = 0;
      d.step({ 0: { move: { x: 0, y: 0 }, useStairs: false } }, 1 / 30);
    }
    if (st.status === "playing") { st.status = "dead"; window.__forcedWipe = true; }
  });
  let up = false;
  for (let i = 0; i < 40; i++) {
    up = await page.evaluate(() => {
      const e = document.getElementById("recap");
      const cs = e && getComputedStyle(e);
      return !!(cs && cs.display !== "none" && e.getBoundingClientRect().width > 0);
    }).catch(() => false);
    if (up) break;
    await page.waitForTimeout(700);
  }
  if (!up) throw new Error("#recap never opened");
  // Let every staged beat finish, so a BEFORE shot photographs the END state of
  // the cascade rather than an accidentally flattering mid-frame.
  await page.waitForTimeout(9000);

  const probe = await page.evaluate(() => {
    const el = document.getElementById("recap");
    const anims = (el.getAnimations?.({ subtree: true }) ?? []).map((a) => a.animationName || "?");
    const panel = el.querySelector(".panel");
    return {
      scrollbars: document.documentElement.scrollHeight > window.innerHeight + 1,
      panelOverflows: panel ? panel.scrollHeight > panel.clientHeight + 1 : null,
      panelRect: panel ? [Math.round(panel.getBoundingClientRect().width),
        Math.round(panel.getBoundingClientRect().height)] : null,
      cine: document.body.classList.contains("cine"),
      letterbox: document.getElementById("letterbox")?.classList.contains("on") ?? false,
      canvasFilter: document.querySelector("canvas")?.style.filter ?? "",
      buttons: [...el.querySelectorAll(".rfoot button")].map((b) => b.id),
      animCount: anims.length,
      anims: [...new Set(anims)],
      title: document.getElementById("recap-title")?.textContent,
    };
  });
  console.log(JSON.stringify(probe, null, 2));
  await page.screenshot({ path: `${OUT}/${label}.png`, timeout: 300000 });
  console.log("saved", `${OUT}/${label}.png`);
} finally {
  await page.close();
  await browser.close();
}
