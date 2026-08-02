// Session-only capture panel for the competitive screens. Deleted after use.
//   node tools/_shots.mjs [filter]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "tools/_social";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5280/iso.html";
const API = process.env.SHOT_API ?? "http://localhost:5383";
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] ?? "";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

// A believable local career, so the grade has a real comparison set and the
// profile has a histogram instead of a placeholder. Deliberately NOT round:
// a career total that lands on exactly 2,000 kills reads as a placeholder or a
// cap, and a reviewer is right to distrust it.
const HISTORY = [];
for (let i = 0; i < 31; i++) {
  const floor = [2,3,3,4,5,5,6,6,7,7,8,8,9,9,10,11,12,13,15,18][i % 20];
  const wob = ((i * 2654435761) % 997) / 997; // deterministic, not round
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

async function seedStorage(page) {
  await page.addInitScript(([hist]) => {
    localStorage.setItem("dcc:token:v1", "SHOTCRAWLER");
    localStorage.setItem("dcc:consent:v1", "public");
    localStorage.setItem("dcc:name:v1", "Carl");
    localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
    // NO dcc:bandbests seed: band personal bests are the SERVER's now, and the
    // point of the capture is that the career panel and the band board are the
    // same query. Pre-loading a local ledger would hide exactly that.
    localStorage.removeItem("dcc:bandbests:v1");
  }, [HISTORY]);
}

async function boot(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
    null, { timeout: 180000 }).catch(() => console.error("WARN assets never settled"));
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    return !l || l.classList.contains("done") || getComputedStyle(l).display === "none";
  }, null, { timeout: 180000 }).catch(() => console.error("WARN loading never cleared"));
  await page.waitForTimeout(2500);
}

async function shot(name, fn, opts = {}) {
  if (only && !name.includes(only)) return;
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error(name, "PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error(name, "CONSOLE:", m.text()); });
  try {
    await seedStorage(page);
    if (opts.clearConsent) {
      await page.addInitScript(() => localStorage.removeItem("dcc:consent:v1"));
    }
    await boot(page, `${BASE}?debug=1&api=${encodeURIComponent(API)}${opts.q ?? ""}`);
    await fn(page);
    await page.waitForTimeout(opts.settle ?? 700);
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 300000 });
    console.log("saved", name);
  } catch (e) {
    console.error("FAILED", name, e.message);
  } finally {
    await page.close();
  }
}


/**
 * Play a REAL run and die in it. Nothing is mutated: the world is never touched
 * from outside the sim, because a proof that does not replay is a rejected
 * proof, and a screenshot of a fake seal would be worth nothing.
 *
 * SwiftShader runs ~1.5 fps and the host caps a frame at 0.1s of sim, so the
 * dungeon advances at roughly 0.15x. The play phase therefore runs at a small
 * viewport (many times the frame rate) and the window is resized to the shot
 * size once the crawler is dead and the DOM is all that matters.
 */
async function chase(page, rounds, fightFor) {
  const readState = () => page.evaluate(() => {
    const s = window.__dcc.state, pl = s.players[0];
    const near = s.monsters.filter((m) => m.hp > 0)
      .map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y }))
      .sort((a, c) => a.d - c.d)[0];
    return {
      status: s.status,
      dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99,
    };
  });
  for (let i = 0; i < rounds; i++) {
    const st = await readState().catch(() => null);
    if (!st || st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.1) {
      if (st.dy < -0.4) keys.push("w"); else if (st.dy > 0.4) keys.push("s");
      if (st.dx > 0.4) keys.push("d"); else if (st.dx < -0.4) keys.push("a");
    }
    if (i < fightFor) keys.push(" ");
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(1200);
    for (const k of keys) await page.keyboard.up(k);
  }
}

async function playAndDie(page, opts = {}) {
  await page.setViewportSize({ width: 720, height: 420 });
  if (!opts.test) {
    await page.click("#m-daily");
    await page.waitForTimeout(600);
    await page.click("#m-cast-go");
  }
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
  const readState = () => page.evaluate(() => {
    const s = window.__dcc.state, pl = s.players[0];
    const near = s.monsters.filter((m) => m.hp > 0)
      .map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y }))
      .sort((a, c) => a.d - c.d)[0];
    return {
      status: s.status, hp: pl.hp, kills: pl.kills, floor: s.floor, elapsed: s.elapsed,
      dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99,
    };
  });
  for (let i = 0; i < (opts.rounds ?? 34); i++) {
    const st = await readState();
    if (st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.1) {
      if (st.dy < -0.4) keys.push("w"); else if (st.dy > 0.4) keys.push("s");
      if (st.dx > 0.4) keys.push("d"); else if (st.dx < -0.4) keys.push("a");
    }
    // Fight for the first stretch (kills, XP, a build worth reporting), then
    // drop the weapon and let the dungeon finish the job.
    const fighting = i < (opts.fightFor ?? 22);
    if (fighting) keys.push(" ");
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(1200);
    for (const k of keys) await page.keyboard.up(k);
  }
  await page.waitForFunction(() => window.__dcc.state.status !== "playing", null, { timeout: 180000 })
    .catch(() => console.error("  (never died — shooting the live screen)"));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex",
    null, { timeout: 30000 });
  await page.waitForTimeout(opts.after ?? 6500); // let the seal resolve on screen
}


await shot("01-verdict", async (page) => { await playAndDie(page, { fightFor: 12, rounds: 60 }); });
await shot("02-verdict-tab", async (page) => {
  await playAndDie(page, { fightFor: 12, rounds: 60, after: 3000 });
  await page.keyboard.down("Tab");
  await page.waitForTimeout(900);
});
await shot("03-standings-contracts", async (page) => {
  await page.click("#m-standings");
  await page.waitForTimeout(2500);
});
await shot("04-standings-alltime", async (page) => {
  await page.click("#m-standings");
  await page.waitForTimeout(1800);
  await page.click('[data-lt="alltime"]');
  await page.waitForTimeout(1800);
});
await shot("05-standings-bands", async (page) => {
  await page.click("#m-standings");
  await page.waitForTimeout(1800);
  await page.click('[data-lt="bands"]');
  await page.waitForTimeout(2200);
});
await shot("06-standings-rivals", async (page) => {
  await page.click("#m-standings");
  await page.waitForTimeout(1800);
  await page.click('[data-lt="rivals"]');
  await page.waitForTimeout(1800);
});
await shot("07-career", async (page) => {
  await page.click("#m-careerset");
  await page.waitForTimeout(2600);
});


await shot("08-consent", async (page) => {
  await playAndDie(page, { fightFor: 8, rounds: 60, after: 3000 });
}, { clearConsent: true });
// The same screen from the TEST CHAMBER: a full build and deep splits, wearing
// the banner that says what the verifier would say about a start at depth.
await shot("09-verdict-deep", async (page) => {
  await playAndDie(page, { test: true, rounds: 26, fightFor: 16, after: 2600 });
}, { q: "&test&floor=13&level=22&gear=level&abilities=all" });

// RUN IT BACK: the same seed with the run you just played as your ghost. The
// ghost is a BODY in the room, not a widget — the capture waits for the two of
// them to be on the same floor and then holds still long enough to see it.
await shot("10-ghost", async (page) => {
  await playAndDie(page, { fightFor: 10, rounds: 60, after: 5200 });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.click("#recap-again");
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
  // Play the SAME policy the recorded run played. The ghost is your own last
  // run on this exact seed, so chasing the same monsters keeps the two of you in
  // the same room — which is the only way the shot can show what the feature is.
  await chase(page, 16, 16);
  await page.waitForTimeout(2400);
});
await shot("11-share", async (page) => {
  await playAndDie(page, { fightFor: 10, rounds: 60, after: 5200 });

  await page.click("#recap-share");
  // The confirmation label reverts after 1.6s, and shot() adds its own settle
  // on top of this wait — so the window is tighter than it looks.
  await page.waitForTimeout(500);
}, { settle: 250 });
// ACCEPT A CHALLENGE: a seed plus a claim in eighty characters, pasted back in.
const CHALLENGE = Buffer.from(JSON.stringify(
  [1, 2698932116, "daily-2026-08-02", "Donut Holes", 18, 1, 902, 641, 34, "airstrike", "seed-1"],
)).toString("base64url");
await shot("12-challenge", async (page) => {
  await page.waitForTimeout(900);
}, { q: `&c=${CHALLENGE}` });
console.log("challenge code length:", CHALLENGE.length);
await browser.close();
