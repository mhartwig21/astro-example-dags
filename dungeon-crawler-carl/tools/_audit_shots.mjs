// AUDIT-ONLY capture harness for the competitive surfaces. Reads the app; never
// edits it. Output: tools/_audit/.  node tools/_audit_shots.mjs [filter]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "tools/_audit";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5430/iso.html";
const API = process.env.SHOT_API ?? "http://localhost:5433";
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] ?? "";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

const HISTORY = [];
for (let i = 0; i < 31; i++) {
  const floor = [2,3,3,4,5,5,6,6,7,7,8,8,9,9,10,11,12,13,15,18][i % 20];
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

async function seedStorage(page) {
  await page.addInitScript(([hist]) => {
    localStorage.setItem("dcc:token:v1", "SHOTCRAWLER");
    localStorage.setItem("dcc:consent:v1", "public");
    localStorage.setItem("dcc:name:v1", "Carl");
    localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
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
    if (opts.clearConsent) await page.addInitScript(() => localStorage.removeItem("dcc:consent:v1"));
    await boot(page, `${BASE}?debug=1&api=${encodeURIComponent(API)}${opts.q ?? ""}`);
    await fn(page);
    if (opts.noShot) { console.log("done", name); return; }
    await page.waitForTimeout(opts.settle ?? 700);
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 300000 });
    console.log("saved", name);
  } catch (e) {
    console.error("FAILED", name, e.message);
  } finally {
    await page.close();
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
    return { status: s.status, hp: pl.hp, floor: s.floor,
      dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99 };
  });
  for (let i = 0; i < (opts.rounds ?? 34); i++) {
    const st = await readState();
    if (st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.1) {
      if (st.dy < -0.4) keys.push("w"); else if (st.dy > 0.4) keys.push("s");
      if (st.dx > 0.4) keys.push("d"); else if (st.dx < -0.4) keys.push("a");
    }
    if (i < (opts.fightFor ?? 22)) keys.push(" ");
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(1200);
    for (const k of keys) await page.keyboard.up(k);
  }
  if (opts.stageWin) {
    // STAGED, and labelled as such in the report: a real 18-floor clear is ~100
    // minutes under SwiftShader. Nothing else on the screen is faked - the run,
    // the build, the recorder and the server round trip are all real, which is
    // also why the seal legitimately comes back REJECTED.
    await page.evaluate(() => {
      const s = window.__dcc.state;
      s.floor = 18; s.status = "won";
    });
  }
  await page.waitForFunction(() => window.__dcc.state.status !== "playing", null, { timeout: 180000 })
    .catch(() => console.error("  (never died - shooting the live screen)"));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex",
    null, { timeout: 30000 });
  await page.waitForTimeout(opts.after ?? 6500);
}

// ---- 1. THE REVEAL. Frames from the instant the verdict is allowed on screen.
await shot("01-reveal", async (page) => {
  await page.setViewportSize({ width: 720, height: 420 });
  await page.click("#m-daily");
  await page.waitForTimeout(600);
  await page.click("#m-cast-go");
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
  // die fast: stand still in the open
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const s = window.__dcc.state, pl = s.players[0];
      const near = s.monsters.filter((m) => m.hp > 0)
        .map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y }))
        .sort((a, c) => a.d - c.d)[0];
      return { status: s.status, dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99 };
    });
    if (st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.1) {
      if (st.dy < -0.4) keys.push("w"); else if (st.dy > 0.4) keys.push("s");
      if (st.dx > 0.4) keys.push("d"); else if (st.dx < -0.4) keys.push("a");
    }
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(1200);
    for (const k of keys) await page.keyboard.up(k);
  }
  await page.waitForFunction(() => window.__dcc.state.status !== "playing", null, { timeout: 180000 }).catch(() => {});
  await page.setViewportSize({ width: 1600, height: 900 });
  // Beat 0: what the screen looks like DURING the 620ms freeze.
  await page.screenshot({ path: `${OUT}/01a-freeze.png` });
  await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 30000 });
  for (const [tag, ms] of [["b-t0", 0], ["c-t250", 250], ["d-t900", 650], ["e-t2500", 1600], ["f-t8000", 5500]]) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: `${OUT}/01${tag}.png` });
  }
}, { noShot: true });

// ---- 2. death, shallow, settled
await shot("02-verdict-death", async (page) => { await playAndDie(page, { fightFor: 12, rounds: 60 }); });
// ---- 3. held TAB
await shot("03-verdict-tab", async (page) => {
  await playAndDie(page, { fightFor: 12, rounds: 60, after: 3000 });
  await page.keyboard.down("Tab");
  await page.waitForTimeout(900);
});
// ---- 4. the WIN face (staged status, real everything else)
await shot("04-verdict-win", async (page) => {
  await playAndDie(page, { fightFor: 16, rounds: 24, stageWin: true, after: 7000 });
});
await shot("05-verdict-win-tab", async (page) => {
  await playAndDie(page, { fightFor: 16, rounds: 24, stageWin: true, after: 5000 });
  await page.keyboard.down("Tab");
  await page.waitForTimeout(900);
});
// ---- 6. deep, from the test chamber
await shot("06-verdict-deep", async (page) => {
  await playAndDie(page, { test: true, rounds: 26, fightFor: 16, after: 2600 });
}, { q: "&test&floor=13&level=22&gear=level&abilities=all" });
// ---- 7. the earned drawer, expanded
await shot("07-verdict-math", async (page) => {
  await playAndDie(page, { fightFor: 12, rounds: 60, after: 5000 });
  await page.click("#recap-earned").catch(() => {});
  await page.waitForTimeout(700);
});
// ---- 8-11. the standings
await shot("08-standings-contracts", async (page) => {
  await page.click("#m-standings"); await page.waitForTimeout(2500);
});
await shot("09-standings-alltime", async (page) => {
  await page.click("#m-standings"); await page.waitForTimeout(1800);
  await page.click('[data-lt="alltime"]'); await page.waitForTimeout(1800);
});
await shot("10-standings-bands", async (page) => {
  await page.click("#m-standings"); await page.waitForTimeout(1800);
  await page.click('[data-lt="bands"]'); await page.waitForTimeout(2200);
});
await shot("11-standings-rivals", async (page) => {
  await page.click("#m-standings"); await page.waitForTimeout(1800);
  await page.click('[data-lt="rivals"]'); await page.waitForTimeout(1800);
});
// ---- 12. career
await shot("12-career", async (page) => {
  await page.click("#m-careerset"); await page.waitForTimeout(2600);
});
await shot("13-career-scrolled", async (page) => {
  await page.click("#m-careerset"); await page.waitForTimeout(2600);
  await page.evaluate(() => { document.getElementById("career").scrollTop = 99999; });
  await page.waitForTimeout(600);
});
// ---- 14. consent
await shot("14-consent", async (page) => {
  await playAndDie(page, { fightFor: 8, rounds: 60, after: 3000 });
}, { clearConsent: true });
// ---- 15. ghost mid-run
await shot("15-ghost", async (page) => {
  await playAndDie(page, { fightFor: 10, rounds: 60, after: 5200 });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.click("#recap-again");
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
  for (let i = 0; i < 16; i++) {
    const st = await page.evaluate(() => {
      const s = window.__dcc.state, pl = s.players[0];
      const near = s.monsters.filter((m) => m.hp > 0)
        .map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y }))
        .sort((a, c) => a.d - c.d)[0];
      return { status: s.status, dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99 };
    }).catch(() => null);
    if (!st || st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.1) {
      if (st.dy < -0.4) keys.push("w"); else if (st.dy > 0.4) keys.push("s");
      if (st.dx > 0.4) keys.push("d"); else if (st.dx < -0.4) keys.push("a");
    }
    keys.push(" ");
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(1200);
    for (const k of keys) await page.keyboard.up(k);
  }
  await page.waitForTimeout(2400);
});
// ---- 16. share
await shot("16-share", async (page) => {
  await playAndDie(page, { fightFor: 10, rounds: 60, after: 5200 });
  await page.click("#recap-share");
  await page.waitForTimeout(500);
}, { settle: 250 });
// ---- 17. challenge accept
const CHALLENGE = Buffer.from(JSON.stringify(
  [1, 2698932116, "daily-2026-08-02", "Donut Holes", 18, 1, 902, 641, 34, "airstrike", "seed-1"],
)).toString("base64url");
await shot("17-challenge", async (page) => { await page.waitForTimeout(900); }, { q: `&c=${CHALLENGE}` });
// ---- 18. the menu, cold (no run yet) - the other half of the between-runs loop
await shot("18-menu", async (page) => { await page.waitForTimeout(1200); });
await browser.close();
