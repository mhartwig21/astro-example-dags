// RUN-END FLOOR r1 acceptance — THE RESULT CARD (NICHE.md 4.2) + funnel.
//
// Drives the REAL app on the dev server (:5286) with the REAL game server
// (:5281) behind it, ONE browser (machine rule):
//   1. opens a ?c= card link -> the daily tile re-dresses as ACCEPT CHALLENGE
//      and names the claim WITH its scale ("floor 7 of 18")
//   2. card_open + first_input funnel POSTs hit /telemetry and return 200
//   3. accepting the card starts a run ON THE CARD'S SEED (not today's daily
//      contract seed) and the claim banner is announced ONCE, statically
//   4. run_start POST carries fromCard:true
//   5. the crawler dies (honestly — walked into the dungeon unarmed);
//      the log carries the ONE end-of-run claim comparison
//   6. SHARE opens the sheet: #share-text holds the System-voiced card
//      (scale + grade line + ?c= door), COPY CARD puts it on the clipboard,
//      card_copy + run_end POSTs return 200
//   7. no scrollbars at 1366x768 with the sheet open
//
// usage: node tools/_runend_card.mjs   (expects vite :5286 + server :5281)
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
// A hand-rolled challenge code: [ver, seed, ev, by, floor, won, timeSec, kills, level, ult]
const SEED = 987654321;
const tuple = [1, SEED, "", "Meatshield", 7, 0, 372, 41, 12, ""];
const code = Buffer.from(JSON.stringify(tuple)).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});
const ctx = await browser.newContext({
  viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1,
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e.message)));

// Watch the funnel wire itself.
const posts = []; // {kind, status, body}
page.on("response", async (res) => {
  const req = res.request();
  if (req.method() === "POST" && req.url().endsWith("/telemetry")) {
    try {
      const body = JSON.parse(req.postData() ?? "{}");
      posts.push({ kind: body.kind, status: res.status(), data: body.data });
      console.log(`  [telemetry] ${body.kind} -> ${res.status()}`);
    } catch { /* ignore */ }
  }
});

await page.goto(`${BASE}/iso.html?noassets&c=${code}`, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 120000 });
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  if (!el || el.classList.contains("done")) return true;
  const cs = getComputedStyle(el);
  return cs.display === "none" || parseFloat(cs.opacity) === 0;
}, { timeout: 120000 });
await page.waitForTimeout(3000);

// 1. The tile re-dresses and the claim carries its scale.
const tile = await page.evaluate(() => ({
  head: document.querySelector("#m-daily b")?.textContent ?? "",
  sub: document.getElementById("m-daily-sub")?.textContent ?? "",
}));
check("tile reads ACCEPT CHALLENGE", tile.head === "ACCEPT CHALLENGE", tile.head);
check("claim carries its scale (floor 7 of 18)", /floor 7 of 18/i.test(tile.sub), tile.sub);
await page.screenshot({ path: "tools/_card_accept_tile.png" });

// 2. card_open fired; poke an input for first_input.
await page.mouse.click(10, 10);
await page.waitForTimeout(800);
check("card_open POST 200", posts.some((p) => p.kind === "card_open" && p.status === 200));
check("card_open says cold+desktop", (() => {
  const p = posts.find((x) => x.kind === "card_open");
  return p && p.data.cold === true && p.data.mobile === false && p.data.seed === SEED;
})());
check("first_input POST 200", posts.some((p) => p.kind === "first_input" && p.status === 200));

// 3. Accept: tile -> casting -> go.
await page.click("#m-daily");
await page.waitForTimeout(600);
await page.click("#m-cast-go");
await page.waitForTimeout(1500);
const started = await page.evaluate(() => ({
  log: document.getElementById("hud-log")?.innerText ?? "",
  menuGone: getComputedStyle(document.getElementById("menu")).display === "none",
}));
check("run started (menu gone)", started.menuGone);
check("claim banner announced statically", /CLAIMS FLOOR 7 OF 18 IN 6:12\. OUTLIVE THEM\./.test(started.log), started.log.slice(0, 200));

// 4. run_start carries fromCard:true — which also proves the run is ON the
// card's seed (fromCard is computed as seed === card.seed).
await page.waitForTimeout(500);
const rs = posts.find((p) => p.kind === "run_start");
check("run_start POST 200 with fromCard:true + card seed", !!rs && rs.status === 200 && rs.data.fromCard === true && rs.data.seed === SEED, JSON.stringify(rs?.data ?? null));

// 5. Die honestly: wander unarmed until the dungeon wins. Random-ish walk.
console.log("  walking into the dungeon unarmed…");
const t0 = Date.now();
let dead = false;
const dirs = ["w", "d", "s", "a"];
let i = 0;
while (Date.now() - t0 < 180000) {
  const key = dirs[i++ % dirs.length];
  await page.keyboard.down(key);
  await page.waitForTimeout(700 + Math.floor(Math.random() * 500));
  await page.keyboard.up(key);
  const recapUp = await page.evaluate(() =>
    getComputedStyle(document.getElementById("recap")).display === "flex");
  if (recapUp) { dead = true; break; }
}
check("the dungeon won (recap up)", dead, `${Math.round((Date.now() - t0) / 1000)}s`);

if (dead) {
  const note = await page.evaluate(() => document.getElementById("recap-note")?.textContent ?? "");
  check("ONE claim comparison at the end (verdict note slot)", /CLAIM (STANDS|SETTLED):/.test(note), note);
  // No live pace-delta ever appeared (§5): cheap proxy — no BEHIND/AHEAD copy.
  check("no pace-delta furniture", !/\d+:\d+ BEHIND|AHEAD OF/.test(note));

  // The once-per-browser proof-consent card docks ~900ms after the verdict
  // and would intercept clicks — answer it first (scratch server, DO NOT SUBMIT).
  await page.waitForTimeout(1500);
  if (await page.evaluate(() => document.getElementById("consent").classList.contains("on"))) {
    await page.click("#consent-no");
    await page.waitForTimeout(400);
  }

  // 6. SHARE -> the sheet.
  await page.click("#recap-share");
  await page.waitForTimeout(600);
  const sheet = await page.evaluate(() => ({
    on: document.getElementById("sharesheet").classList.contains("on"),
    text: document.getElementById("share-text")?.textContent ?? "",
    link: document.getElementById("share-link")?.textContent ?? "",
    scroll: document.documentElement.scrollWidth > document.documentElement.clientWidth
      || document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  check("sheet open", sheet.on);
  check("card text: System voice + scale", /THE SYSTEM REGRETS TO ANNOUNCE:.*FLOOR \d+ OF 18/.test(sheet.text), sheet.text.split("\n")[0]);
  check("card text: grade line", /THE SYSTEM RATES THIS CLAIM:/.test(sheet.text));
  check("card text: the ?c= door", /beat it → .*\?c=/.test(sheet.text));
  check("no scrollbars with the sheet open", !sheet.scroll);
  await page.screenshot({ path: "tools/_card_sharesheet.png" });

  // COPY CARD -> clipboard === preview text; card_copy 200.
  await page.click("#share-card");
  await page.waitForTimeout(800);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  const norm = (s) => s.replace(/\r\n/g, "\n").trim();
  check("COPY CARD puts the card on the clipboard", norm(clip) === norm(sheet.text),
    norm(clip) === norm(sheet.text) ? clip.split("\n")[0]
      : `clip=${JSON.stringify(clip)} vs text=${JSON.stringify(sheet.text)}`);
  check("card_copy POST 200", posts.some((p) => p.kind === "card_copy" && p.status === 200));
  check("run_end POST 200", posts.some((p) => p.kind === "run_end" && p.status === 200));
}

await browser.close();
console.log(fails.length ? `\n${fails.length} FAIL(S): ${fails.join(", ")}` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
