// TEMP UI shot panel (deleted after use). Reproduces the r1-ui-* shots.
import { chromium } from "playwright";

const OUT = "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots";
const BASE = "http://localhost:5285/iso.html";

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

async function shot(name, url, fn, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error(name, "PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error(name, "CONSOLE:", m.text()); });
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(opts.wait ?? 7000);
  if (fn) await fn(page);
  await page.waitForTimeout(opts.settle ?? 500);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 300000 });
  await page.close();
  console.log("saved", name);
}

const openShop = async (page) => {
  await page.waitForFunction(() => !!window.__dcc, { timeout: 30000 });
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.pos.x = s.map.stairs.x;
    p.pos.y = s.map.stairs.y;
  });
  await page.waitForTimeout(500);
  await keys(page, [["e", 400]]);
  await page.waitForTimeout(1800);
};

await shot("r1-ui-hud", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, async (page) => {
  await keys(page, [["w", 900], [" ", 200]]);
});

await shot("r1-ui-combat", `${BASE}?test&floor=8&level=16&gold=430&seed=43&debug=1`, async (page) => {
  // Teleport next to the nearest monster pack so the attack lands and the
  // damage numbers are in frame.
  await page.waitForFunction(() => !!window.__dcc, { timeout: 30000 });
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
}, { settle: 60 });

await shot("r1-ui-shop", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, openShop);

await shot("r1-ui-shop-detail", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, async (page) => {
  await openShop(page);
  // force: skip the "stable box" actionability wait — SwiftShader rAF runs at
  // seconds-per-frame, so the stability heuristic can starve past the timeout.
  await page.click("#sr-shelf .itile[data-id]", { force: true });
  await page.waitForTimeout(700);
});

await shot("r1-ui-sheet", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, async (page) => {
  await keys(page, [["w", 900], ["p", 150]]);
  await page.waitForTimeout(900);
});

await shot("r1-ui-constellation", `${BASE}?test&floor=8&level=16&gold=430&seed=41&debug=1`, async (page) => {
  await keys(page, [["w", 900], ["t", 150]]);
  await page.waitForTimeout(900);
});

await shot("r1-ui-boss", `${BASE}?test&floor=3&level=8&seed=41&debug=1`, async (page) => {
  await page.waitForFunction(() => !!window.__dcc, { timeout: 30000 });
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    const boss = s.monsters.find((m) => m.kind === "boss");
    if (boss) { p.pos.x = boss.pos.x; p.pos.y = boss.pos.y + 3; }
  });
  await page.waitForTimeout(1300);
}, { settle: 80 });

await browser.close();
console.log("done");
