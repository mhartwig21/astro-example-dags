// ABILITIES-V2 evidence set, captured as ONE VINTAGE.
//
// The acceptance review's last finding was that fx-collapse, fx-cables and
// fx-orbit-hurl predated the hotbar CHIP_LABEL fix and still showed the
// ultimate chip reading "Line" -- sending a reader chasing a bug that was
// already closed. Ad-hoc capture is how an evidence set drifts, so this is a
// script: every shot in the set comes out of one run, off one build.
//
// Usage: node tools/av2shots.mjs [outDir] [filter]
//   SHOT_BASE=http://localhost:5340/iso.html (default)
import { chromium } from "playwright";
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? join(root, "..", "_shots_av2");
const only = process.argv[3] ?? "";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5340/iso.html";
mkdirSync(OUT, { recursive: true });


// ONE BROWSER PER SHOT. SwiftShader plus a dozen live WebGL contexts is a
// reliable way to lose the whole run to a renderer crash halfway through --
// which is how an evidence set ends up half one vintage and half another.
let browser = null;
async function launch() {
  browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
  });
}
async function shutdown() {
  if (browser) { try { await browser.close(); } catch (e) { /* already gone */ } }
  browser = null;
}

/** Boot a test floor and wait for the loading screen to actually go away. */
async function open(query, prep) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });
  if (prep) await page.addInitScript(prep);
  await page.goto(BASE + "?" + query, { waitUntil: "load", timeout: 60000 });
  try {
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 120000 });
  } catch { console.error("WARN: assets never settled"); }
  try {
    await page.waitForFunction(() => {
      const l = document.getElementById("loading");
      return !l || l.style.display === "none";
    }, null, { timeout: 120000 });
  } catch { console.error("WARN: loading screen never dismissed"); }
  await page.waitForTimeout(1200);
  return page;
}

/**
 * Drop the crawler into the densest pack on the floor and hand them slot4
 * (bound to C) plus the ultimate (bound to F). Every FX shot starts here, so
 * the abilities are photographed in the situation they were designed for
 * rather than in an empty corridor.
 */
const PLANT = (opts) => {
  const s = window.__dcc.state;
  const p = s.players[0];

  // AWAKE bodies only. An ambush pack holds `dormant_floor` -- a heap of bones
  // on the ground that never walks into a cable line and never reads as a
  // crowd. It is the densest cluster on several floors and it is the wrong
  // subject for every shot in this set.
  const live = s.monsters.filter((m) => m.hp > 0 && !m.dormant);
  let best = null, bestN = -1;
  for (const m of live) {
    let n = 0;
    for (const o of live) {
      if (Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 4.5) n++;
    }
    if (n > bestN) { bestN = n; best = m; }
  }
  if (best) {
    // Stand back along -x from a body in the knot: guaranteed floor, the pack
    // ends up downrange of the facing every ability aims down, and the caster's
    // own bloom is off the subject (the enrage tint has to read on the BODIES).
    p.pos.x = best.pos.x - 3.6;
    p.pos.y = best.pos.y;
  }
  p.facing = { x: 1, y: 0 };
  if (opts.slot4) { p.abilities.slots[3] = opts.slot4; p.cd[opts.slot4] = 0; }
  if (opts.ult) { p.abilities.ultimate = opts.ult; p.cd[opts.ult] = 0; }
  p.hp = p.maxHp;
};


/**
 * Hold a transient sim field at a chosen value so the peak frame survives a
 * screenshot. Cosmetic only -- the cast itself was real.
 *
 * BOUNDED, deliberately: an unbounded re-arm keeps the FX layer spawning the
 * cast's particles every frame forever, and under SwiftShader that ends as a
 * lost WebGL context rather than a screenshot.
 */
const FREEZE = (o) => {
  const s = window.__dcc.state;
  const id = setInterval(() => { s.players[0][o.field] = o.value; }, 8);
  setTimeout(() => clearInterval(id), o.ms ?? 2500);
};


async function shot(name, fn) {
  if (only && !name.includes(only)) return;
  const t0 = Date.now();
  // Two attempts on a fresh browser each: HMR reload storms and SwiftShader
  // context loss are both transient, and a retry is cheaper than a rerun.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await launch();
      await fn(join(OUT, name + ".png"));
      console.log(name + ": ok (" + ((Date.now() - t0) / 1000).toFixed(1) + "s)");
      await shutdown();
      return;
    } catch (e) {
      await shutdown();
      if (attempt === 2) console.error(name + ": FAILED -- " + e.message);
      else console.error(name + ": retrying after -- " + e.message);
    }
  }
}

/** Screenshot with a budget SwiftShader can actually meet. */
const snap = (page, path) => page.screenshot({ path, timeout: 90000 });


// Floor 5 (sewers band), not 7 (garden): the garden's canopy is beautiful and
// it occludes exactly the ground-level tells this set exists to photograph.
// `view=close` is the shipped CLOSE framing -- a third tighter, which is the
// difference between "there is a pin decal" and "I can see which body it is on".



// `view=close` is the shipped CLOSE framing -- a third tighter. It is the
// difference between "there is a pin decal somewhere" and "I can see which
// body it is on", which is the entire subject of half this set.
const FLOOR = "test&floor=7&level=14&seed=4207&abilities=all&gold=8000&debug=1&view=close";
const PANEL = "test&floor=7&level=14&seed=4207&abilities=all&gold=8000&debug=1";

/**
 * Cast a slot with an EXPLICIT aim at the pack, through the debug step hook.
 *
 * A keyboard press fires down whatever the host's aim happens to be (facing,
 * in a headless page with no mouse), and by the time a pack has taken two
 * steps toward the crawler that is no longer where the pack is -- which is how
 * you photograph a cable line with nothing on it. Aiming at the live centroid
 * puts the ability on its subject every time.
 */
const FIRE = (o) => {
  const d = window.__dcc;
  const s = d.state;
  const p = s.players[0];
  const live = s.monsters.filter((m) => m.hp > 0 && !m.dormant);
  let cx = 0, cy = 0, n = 0;
  for (const m of live) {
    if (Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) > 9) continue;
    cx += m.pos.x; cy += m.pos.y; n++;
  }
  const aim = n > 0
    ? { x: cx / n - p.pos.x, y: cy / n - p.pos.y }
    : { x: p.facing.x * 5, y: p.facing.y * 5 };
  const len = Math.hypot(aim.x, aim.y) || 1;
  p.facing = { x: aim.x / len, y: aim.y / len };
  const cast = [false, false, false, false, false];
  cast[o.slot] = true;
  d.step({ move: { x: 0, y: 0 }, useStairs: false, cast, aim }, 1 / 60);
};

// ---- R1 COLLAPSE: the gather, then the blast -------------------------------
await shot("fx-collapse", async (out) => {
  const page = await open(FLOOR);
  await page.evaluate(PLANT, { slot4: "nova", ult: "cataclysm" });
  await page.waitForTimeout(400);
  await page.evaluate(FIRE, { slot: 3 });
  await page.waitForTimeout(90);
  await page.evaluate(FREEZE, { field: "novaFlash", value: 0.19 });
  await page.waitForTimeout(500);
  await snap(page, out);
  await page.close();
});

// ---- N2 STAGE CABLES: the line, and WHICH bodies it is holding -------------
await shot("fx-cables", async (out) => {
  const page = await open(FLOOR);
  await page.evaluate(PLANT, { slot4: "cables", ult: "cataclysm" });
  await page.waitForTimeout(400);
  await page.evaluate(FIRE, { slot: 3 });

  // Let the pack walk into the line the way it does in play, then make sure
  // the frame contains BOTH states: the review's whole point is that you
  // could not tell a pinned body from a free one.
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const hz = s.hazards.find((h) => h.kind === "cables");
    if (!hz || !hz.end) return;
    const a = { x: hz.pos.x * 2 - hz.end.x, y: hz.pos.y * 2 - hz.end.y };
    const dx = hz.end.x - a.x, dy = hz.end.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    for (const m of s.monsters) {
      if (m.hp <= 0) continue;
      const t = Math.max(0, Math.min(1, ((m.pos.x - a.x) * dx + (m.pos.y - a.y) * dy) / len2));
      const px = a.x + dx * t, py = a.y + dy * t;
      // Exactly the sim's own contact rule: inside the field's half-width.
      if (Math.hypot(m.pos.x - px, m.pos.y - py) <= hz.radius + 0.55) m.pinnedT = 1.6;
    }
  });
  await page.waitForTimeout(350);
  await snap(page, out);
  await page.close();
});

// ---- R3 ORBIT: the ring is AWAY, and the body is unguarded -----------------
await shot("fx-orbit-hurl", async (out) => {
  const page = await open(FLOOR);
  await page.evaluate(PLANT, { slot4: "orbit", ult: "cataclysm" });
  await page.waitForTimeout(400);

  await page.evaluate(FIRE, { slot: 3 });
  await page.waitForTimeout(120);
  // Hold the ring at the far end of the outbound leg: t just above one leg's
  // travel time (orbitHurlRange / orbitHurlSpeed = 5.5 / 10).
  await page.evaluate(FREEZE, { field: "orbitHurlT", value: 0.58 });
  await page.waitForTimeout(450);
  await snap(page, out);
  await page.close();
});

// ---- U1 FAULT LINE: the blast is the opener, the GROUND is the ultimate ----
await shot("fx-fissure", async (out) => {
  const page = await open(FLOOR);
  await page.evaluate(PLANT, { slot4: "nova", ult: "cataclysm" });
  await page.waitForTimeout(400);
  await page.evaluate(FIRE, { slot: 4 });
  await page.waitForTimeout(1400);
  await snap(page, out);
  await page.close();
});

// ---- N3 INJUNCTION: the clock STAYS and the floor goes violent -------------
await shot("fx-injunction", async (out) => {
  const page = await open(FLOOR);
  await page.evaluate(PLANT, { slot4: "nova", ult: "injunction" });
  await page.waitForTimeout(400);

  await page.evaluate(FIRE, { slot: 4 });
  await page.waitForTimeout(1500);
  // Clear the System's onboarding card so the frame is the ABILITY, not a
  // tutorial the reader has already read.
  await page.evaluate(() => {
    for (const b of Array.from(document.querySelectorAll("button"))) {
      if ((b.textContent || "").trim().toUpperCase() === "GOT IT") b.click();
    }
  });
  await page.waitForTimeout(400);
  await snap(page, out);
  await page.close();
});

// ---- N1 BULWARK: the plate, and what is walking into it --------------------
await shot("fx-bulwark", async (out) => {
  const page = await open(FLOOR);
  await page.evaluate(PLANT, { slot4: "bulwark", ult: "cataclysm" });
  await page.waitForTimeout(400);
  await page.evaluate(FIRE, { slot: 3 });
  await page.waitForTimeout(700);
  await snap(page, out);
  await page.close();
});

// ---- The hotbar: five chips, every label legible at ~58px ------------------
await shot("hotbar", async (out) => {
  const page = await open(FLOOR);
  await page.evaluate((o) => {
    const p = window.__dcc.state.players[0];
    for (let i = 0; i < o.slots.length; i++) p.abilities.slots[i] = o.slots[i];
    p.abilities.ultimate = o.ult;
  }, { slots: ["melee", "dash", "cables", "bulwark"], ult: "cataclysm" });
  await page.waitForTimeout(700);
  await snap(page, out);
  await page.locator("#skills").screenshot({ path: out.replace("hotbar.png", "hotbar-crop.png"), timeout: 90000 });
  await page.close();
});

// ---- The constellation panel (T), both views -------------------------------
const setView = (v) => "try { localStorage.setItem('dcc.abilView', '" + v + "'); } catch (e) {}";

await shot("panel-list", async (out) => {
  const page = await open(PANEL, setView("list"));
  await page.keyboard.press("t");
  await page.waitForTimeout(900);
  await snap(page, out);
  await page.close();
});

await shot("panel-graph", async (out) => {
  const page = await open(PANEL, setView("graph"));
  await page.keyboard.press("t");
  await page.waitForTimeout(900);
  await snap(page, out);
  await page.close();
});

/** Scroll the open panel so the named ability's card is the frame. */
async function panelAt(page, needle) {
  await page.evaluate((n) => {
    const cards = Array.from(document.querySelectorAll("#abil-grid > *"));
    const card = cards.find((c) => (c.textContent || "").toUpperCase().includes(n));
    if (card) card.scrollIntoView({ block: "start" });
  }, needle);
  await page.waitForTimeout(500);
}

// The three NEW abilities' trees and the reworked kits' trees: the two halves
// of the 4.3 graph a reader has to be able to check against the document.
await shot("panel-graph-new", async (out) => {
  const page = await open(PANEL, setView("graph"));
  await page.keyboard.press("t");
  await page.waitForTimeout(900);
  await panelAt(page, "BULWARK");
  await snap(page, out);
  await page.close();
});

await shot("panel-graph-newkits", async (out) => {
  const page = await open(PANEL, setView("graph"));
  await page.keyboard.press("t");
  await page.waitForTimeout(900);
  await panelAt(page, "COLLAPSE");
  await snap(page, out);
  await page.close();
});

// ---- The safe room's ability page: sockets, dormancy, free re-socketing ----
await shot("saferoom-glyphs", async (out) => {
  const page = await open(PANEL, setView("list"));
  await page.evaluate(() => {
    const s = window.__dcc.state;
    s.safeRoom = {
      nextFloor: s.floor + 1, available: [], ready: [], purchased: {},
      tip: "Next floor runs cables-heavy. Bring something that answers a line you cannot cross.",
    };
  });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const el = document.getElementById("sr-tab-abil");
    if (el) el.click();
  });
  await page.waitForTimeout(900);
  await snap(page, out);
  await page.close();
});

// ---- Contact sheets: the ability icons, and the glyph icon set -------------
function sheet(title, files, base) {
  const css = "body{margin:0;background:#12100d;color:#e8ddc8;font:12px ui-monospace,monospace;padding:18px}" +
    "h2{font:600 15px ui-monospace,monospace;letter-spacing:.14em;color:#c9a24b;margin:0 0 12px}" +
    ".g{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:12px}" +
    "figure{margin:0;text-align:center}" +
    ".box{width:88px;height:88px;margin:0 auto;display:grid;place-items:center;" +
    "background:linear-gradient(180deg,#241b10,#12100d);border:1px solid #4a3820;border-radius:4px}" +
    ".box img{width:72px;height:72px}.pip{width:26px;height:26px;margin:6px auto 4px}" +
    ".pip img{width:100%;height:100%}figcaption{color:#9a8f7c;font-size:10px;word-break:break-all}";
  const cells = files.map((f) =>
    "<figure><div class=box><img src=\"" + base + "/" + f + "\"></div>" +
    "<div class=pip><img src=\"" + base + "/" + f + "\"></div>" +
    "<figcaption>" + f.replace(".svg", "") + "</figcaption></figure>").join("");
  return "<!doctype html><meta charset=utf-8><style>" + css + "</style><h2>" + title +
    "</h2><div class=g>" + cells + "</div>";
}

async function contact(name, html, out) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  const tmp = join(OUT, "_" + name + ".html");
  writeFileSync(tmp, html);
  await page.goto("file:///" + tmp.split(String.fromCharCode(92)).join("/"), { waitUntil: "load" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: out, fullPage: true, timeout: 90000 });
  await page.close();
}

await shot("abilicons", async (out) => {
  const dir = join(root, "public", "icons");
  const base = "file:///" + dir.split(String.fromCharCode(92)).join("/");
  const files = readdirSync(dir).filter((f) => f.endsWith(".svg")).sort();
  await contact("abilicons", sheet("ability icons (" + files.length + ")", files, base), out);
});

await shot("iconsheet", async (out) => {
  const dir = join(root, "public", "icons", "painted", "glyphs");
  const base = "file:///" + dir.split(String.fromCharCode(92)).join("/");
  const files = readdirSync(dir).filter((f) => f.endsWith(".svg")).sort();
  await contact("iconsheet", sheet("glyph icons (" + files.length + ")", files, base), out);
});


await shutdown();
console.log("\nshots -> " + OUT);
