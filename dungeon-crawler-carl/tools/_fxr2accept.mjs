// FX r2 acceptance: cast-commit read, anchor ring in a dense f15 mob, melee
// glint + x-ray arc, Fault Line fissure sustain, crown clamp, incoming slash.
// Real input path, real Intel GPU, bringToFront (harness note #8), one browser.
import { chromium } from "playwright";
import { census } from "./trk_census.mjs";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "C:/Users/hartw/astro-example-dags/.claude/worktrees/trk-look/dungeon-crawler-carl/tools/_fxr2";
mkdirSync(OUT, { recursive: true });
console.log("[census BEFORE]", JSON.stringify(census()));
const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

const PIN = () => {
  const pin = () => {
    const st = window.__dcc?.state;
    if (st) for (const p of st.players) { p.hp = p.maxHp; p.alive = true; }
    requestAnimationFrame(pin);
  };
  requestAnimationFrame(pin);
};

async function boot(url, pinEarly) {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!window.__dcc?.state, null, { timeout: 240000 });
  if (pinEarly) await page.evaluate(PIN);
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 240000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    return !l || l.classList.contains("done") || l.style.display === "none" ||
      getComputedStyle(l).opacity === "0" || l.getBoundingClientRect().width === 0;
  }, null, { timeout: 120000 });
  await page.waitForFunction(() => !!window.__dcc.renderer, null, { timeout: 90000 });
  if (!pinEarly) await page.evaluate(PIN);
  await page.bringToFront();
  await page.waitForTimeout(3000);
  const gpu = await page.evaluate(() => {
    const g = window.__dcc.renderer.renderer.getContext();
    const d = g.getExtension("WEBGL_debug_renderer_info");
    return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  if (!/Intel/i.test(gpu)) throw new Error("not Intel: " + gpu);
  console.log("GPU ok:", gpu.slice(0, 40));
}

const STAGE = (range) => `(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  let pick = live[0], bestScore = -1e9;
  for (const m of live) {
    const n = live.filter((o) => o !== m && Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4).length;
    const score = -n;
    if (score > bestScore) { bestScore = score; pick = m; }
  }
  p.pos.x = pick.pos.x + ${range}; p.pos.y = pick.pos.y + 0.3;
  p.facing.x = -1; p.facing.y = 0;
  window.__pickId = pick.id;
  const s = window.__dcc.renderer.worldToScreen(pick.pos.x, 0.9, pick.pos.y);
  return { sx: s.x, sy: s.y, vis: s.visible, hp: pick.hp };
})()`;

// Stage INTO the densest pack (the actor-findability test).
const STAGE_DENSE = `(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  let best = live[0], bestN = -1;
  for (const m of live) {
    const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3).length;
    if (n > bestN) { bestN = n; best = m; }
  }
  p.pos.x = best.pos.x + 0.8; p.pos.y = best.pos.y + 0.3;
  p.facing.x = -1; p.facing.y = 0;
  return { n: bestN };
})()`;

const pickHp = () => page.evaluate(() => {
  const m = window.__dcc.state.monsters.find((m) => m.id === window.__pickId);
  return m ? m.hp : -1;
});

// ---- floor 15, MEDIUM ----
await boot("http://localhost:5282/iso.html?test&debug=1&clean=1&floor=15&level=26&abilities=all&seed=41&eagerassets&quality=medium", true);

// E: bolt cast — the commit read must be AT THE CASTER in the first frames.
for (const off of [60, 120, 260]) {
  await page.waitForTimeout(1500);
  const aim = await page.evaluate(STAGE(5.5));
  await page.waitForTimeout(150);
  if (aim.vis) await page.mouse.move(aim.sx, aim.sy);
  const p0 = await page.evaluate(() => window.__dcc.state.projectiles.length);
  await page.keyboard.down("q");
  await page.waitForTimeout(Math.min(off, 50));
  if (off <= 50) {
    await page.screenshot({ path: `${OUT}/E-bolt-${off}ms.png`, timeout: 60000 });
    await page.keyboard.up("q");
  } else {
    await page.keyboard.up("q");
    await page.waitForTimeout(off - 50);
    await page.screenshot({ path: `${OUT}/E-bolt-${off}ms.png`, timeout: 60000 });
  }
  const p1 = await page.evaluate(() => window.__dcc.state.projectiles.length);
  const hp = await pickHp();
  console.log(`E-bolt-${off}: proj ${p0}->${p1}, target hp ${aim.hp} -> ${hp}`);
}

// F: melee swing, real input, adjacent.
for (const off of [40, 90, 150]) {
  await page.waitForTimeout(1400);
  const aim = await page.evaluate(STAGE(1.3));
  await page.waitForTimeout(150);
  if (aim.vis) await page.mouse.move(aim.sx, aim.sy);
  await page.keyboard.down(" ");
  await page.waitForTimeout(off);
  await page.screenshot({ path: `${OUT}/F-melee-${off}ms.png`, timeout: 60000 });
  await page.keyboard.up(" ").catch(() => {});
  const hp = await pickHp();
  console.log(`F-melee-${off}: target hp ${aim.hp} -> ${hp}`);
}

// H: dense-mob standing frames — is the crawler findable (anchor ring)?
for (const i of [0, 1, 2]) {
  const d = await page.evaluate(STAGE_DENSE);
  await page.waitForTimeout(900 + i * 700);
  await page.screenshot({ path: `${OUT}/H-dense-${i}.png`, timeout: 60000 });
  console.log(`H-dense-${i}: pack n=${d.n}`);
}

// ---- floor 6 (Fault Line) ----
await boot("http://localhost:5282/iso.html?test&debug=1&clean=1&floor=6&level=14&abilities=all&seed=77&eagerassets&quality=medium", false);
const aim = await page.evaluate(STAGE(4.0));
await page.waitForTimeout(200);
if (aim.vis) await page.mouse.move(aim.sx, aim.sy);
await page.keyboard.down("f");
await page.waitForTimeout(150);
await page.keyboard.up("f");
for (const [i, wait] of [[0, 100], [1, 300], [2, 400], [3, 500], [4, 700]].values()) {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}/G-fault-${i}.png`, timeout: 60000 });
}
console.log("saved G-fault 0..4; hazards:", await page.evaluate(() => window.__dcc.state.hazards.map((h) => h.kind).join(",")));

await browser.close();
console.log("[census AFTER]", JSON.stringify(census()));
