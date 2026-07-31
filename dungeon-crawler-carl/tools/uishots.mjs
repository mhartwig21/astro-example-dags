// TEMP UI shot panel (deleted after use). Reproduces the r2-ui-* shots.
import { chromium } from "playwright";

const OUT = "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots";
// SHOT_BASE: point at a `vite preview` of the same checkout when dev-server
// HMR reload storms keep interrupting boot (same escape hatch as shotset.sh).
const BASE = process.env.SHOT_BASE ?? "http://localhost:5285/iso.html";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

async function keys(page, pairs) {
  for (const [k, hold] of pairs) {
    await page.keyboard.down(k);
    await page.waitForTimeout(hold);
    await page.keyboard.up(k);
    await page.waitForTimeout(80);
  }
}

// Optional CLI filter: `node tools/uishots.mjs boss` re-shoots only matching tags.
const only = process.argv[2] ?? "";

async function shot(name, url, fn, opts = {}) {
  if (only && !name.includes(only)) return;
  // One failed shot must never kill the whole panel run (the r2 attempt died
  // on a 30s waitForFunction under SwiftShader and produced 1/7 files).
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error(name, "PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error(name, "CONSOLE:", m.text()); });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    // Poll the assets-settled stamp (shotwait.mjs pattern) — fixed sleeps
    // lose to dev-server re-transform storms while other agents edit.
    try {
      await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
        null, { timeout: 120000 });
    } catch {
      console.error(name, "WARN: assets never settled; shooting anyway");
    }
    await page.waitForTimeout(opts.wait ?? 5000);
    if (fn) await fn(page);
    await page.waitForTimeout(opts.settle ?? 500);
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 300000 });
    console.log("saved", name);
  } catch (e) {
    console.error("FAILED", name, e.message);
  } finally {
    await page.close();
  }
}

const openShop = async (page) => {
  await page.waitForFunction(() => !!window.__dcc, { timeout: 90000 });
  // Retry the walk-to-stairs + E press until the safe-room panel is actually
  // open — a single 400ms press can fall between dilated SwiftShader steps.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const s = window.__dcc.state;
      const p = s.players[0];
      p.pos.x = s.map.stairs.x;
      p.pos.y = s.map.stairs.y;
    });
    await page.waitForTimeout(400);
    await keys(page, [["e", 500]]);
    await page.waitForTimeout(1500);
    const open = await page.evaluate(() =>
      document.getElementById("saferoom")?.style.display === "flex");
    if (open) break;
  }
  await page.waitForTimeout(600);
};

await shot("r2-ui-hud", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, async (page) => {
  await keys(page, [["w", 900], [" ", 200]]);
});

await shot("r2-ui-combat", `${BASE}?test&floor=8&level=16&gold=430&seed=43&debug=1`, async (page) => {
  // Teleport next to the nearest monster pack so the attack lands and the
  // damage numbers are in frame.
  await page.waitForFunction(() => !!window.__dcc, { timeout: 90000 });
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    let best = null, bd = 1e9;
    for (const m of s.monsters) {
      const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) { p.pos.x = best.pos.x + 1; p.pos.y = best.pos.y + 1; }
  });
  await page.waitForTimeout(400);
  await keys(page, [[" ", 200], ["q", 200], [" ", 200]]);
  // Stage the engagement read at capture time (SwiftShader runs seconds-per-
  // frame, so live hit FX die between key-up and screenshot): drop pack HP so
  // the overhead micro-bars are lit, then fire the full hit path (world FX +
  // damage numbers) through the debug hook — same channel real hits use.
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    const near = s.monsters
      .filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 7)
      .slice(0, 8);
    near.forEach((m, i) => { m.hp = Math.max(1, Math.round(m.maxHp * (0.25 + i * 0.09))); });
  });
  // SwiftShader renders ~1fps under load and the capture itself can outlive
  // the plates' 3s post-hit hold — keep the engagement FRESH with tiny hp
  // ticks so the overhead bars stay lit for however long the capture takes.
  await page.evaluate(() => {
    window.__keepAlive = setInterval(() => {
      const s = window.__dcc.state;
      s.monsters.filter((m) => m.hp > 1 && m.hp < m.maxHp)
        .forEach((m) => { m.hp -= 0.02; });
    }, 400);
  });
  await page.waitForTimeout(4500);
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    const near = s.monsters
      .filter((m) => m.hp > 0 && Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 7)
      .slice(0, 5);
    near.forEach((m, i) => {
      window.__dcc.hit({
        kind: i === 1 ? "crit" : "enemy", amount: i === 1 ? 187 : 40 + i * 13,
        pos: { x: m.pos.x, y: m.pos.y }, killed: false,
      });
    });
  });
  // Freeze the numbers mid-pop so the (slow) capture can't outlive them.
  await page.waitForTimeout(280);
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => { try { a.pause(); } catch { /* ok */ } });
  });
}, { settle: 120 });

await shot("r2-ui-shop", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, openShop);

await shot("r2-ui-shop-detail", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, async (page) => {
  await openShop(page);
  // force: skip the "stable box" actionability wait — SwiftShader rAF runs at
  // seconds-per-frame, so the stability heuristic can starve past the timeout.
  await page.click("#sr-shelf .itile[data-id]", { force: true });
  await page.waitForTimeout(700);
});

await shot("r2-ui-sheet", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, async (page) => {
  await keys(page, [["w", 900], ["p", 150]]);
  await page.waitForTimeout(900);
});

await shot("r2-ui-constellation", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, async (page) => {
  await keys(page, [["w", 900], ["t", 150]]);
  await page.waitForTimeout(900);
});

await shot("r2-ui-boss", `${BASE}?test&floor=3&level=8&seed=41&debug=1`, async (page) => {
  await page.waitForFunction(() => !!window.__dcc, { timeout: 90000 });
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    const boss = s.monsters.find((m) => m.kind === "boss");
    if (boss) { p.pos.x = boss.pos.x; p.pos.y = boss.pos.y + 3; }
  });
  // The ringside card lives ~3.5s wall-clock, but a SwiftShader screenshot
  // can take longer than that — freeze every animation mid-hold once the
  // card is fully in, so the capture shows the cut as a player sees it.
  await page.waitForFunction(
    () => document.getElementById("bossintro")?.classList.contains("show"),
    null, { timeout: 60000 });
  await page.waitForTimeout(1100); // let bi-in/letterbox/spotlight land
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => { try { a.pause(); } catch { /* infinite anims */ } });
  });
}, { settle: 80 });

await browser.close();
console.log("done");
