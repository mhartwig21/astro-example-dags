// r11 — THE EXIT, ON THE GLASS. One browser, port 5287, cold profile.
//
// The finding this answers (critic severity 9): "the tutorial no longer kills
// its players, it strands them ... two of four deaths were collapse-timer
// executions at full HP with zero wayfinding", and "floor 1 is unloseable and
// also unleaveable — mercy has no escalation or diagnosis".
//
// What has to be true in the app, not merely in the unit tests:
//   1. the EXIT BEACON is painted, inside the frame, naming the exit and its
//      range — the affordance a 3D view cannot get from a minimap;
//   2. the CHART marks the same exit (a raster read of the minimap canvas for
//      the marker's own gold, not a DOM read);
//   3. a crawler who has stopped getting closer is handed a DIRECTION — the
//      standing ask becomes a heading and a range;
//   4. the third knockdown ESCORTS them: they wake on the stairs, the System
//      says so, and Mordecai says which key spends it.
//
// Every text read is paired with a geometry read (HANDOFF §0: if a probe reads
// textContent it is measuring the DOM, not the glass), and it shoots frames.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/tutorial-mordecai/dungeon-crawler-carl";
const OUT = path.resolve(ROOT, process.env.TUT_OUT ?? "tools/_shots/tut_r11");
fs.mkdirSync(OUT, { recursive: true });
const URL = "http://localhost:5287/iso.html?debug=1";

const out = { checks: [], fails: [] };
const ok = (name, pass, detail) => {
  out.checks.push({ name, pass, detail });
  if (!pass) out.fails.push(name);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};

/** The beacon as the player sees it: text ONLY when it has a real rect. */
const readMark = (page) => page.evaluate(() => {
  const el = document.getElementById("exitmark");
  if (!el) return { present: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    present: true,
    text: el.textContent.trim(),
    edge: el.classList.contains("edge"),
    x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
    w: Math.round(r.width), h: Math.round(r.height),
    visible: cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.3
      && r.width > 10 && r.height > 10,
    inFrame: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
  };
});

const readAsk = (page) => page.evaluate(() => {
  const el = document.querySelector("#objectives .obj-ask");
  if (!el) return { present: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    present: true, text: el.textContent.trim(), hot: el.classList.contains("hot"),
    w: Math.round(r.width), h: Math.round(r.height),
    visible: cs.display !== "none" && +cs.opacity > 0.5 && r.width > 40 && r.height > 8,
  };
});

const strip = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#tutorial .tut-body")].map((e) => e.textContent.trim()));

/**
 * THE STRIP IS ONE CARD AT A TIME, so a line that painted forty seconds ago is
 * gone by the time a check asks for it. Every wait in this probe pumps through
 * here, which polls the strip and keeps what it saw: the question is "did this
 * reach the glass", not "is it on the glass at the instant I looked".
 */
const said = [];
async function pump(page, ms) {
  const until = Date.now() + ms;
  do {
    for (const c of await strip(page)) if (c && !said.includes(c)) said.push(c);
    await page.waitForTimeout(400);
  } while (Date.now() < until);
}

/** THE CHART, MEASURED AS PIXELS. The debut's stairs mark is drawn in the
 *  Location Scout's exact gold (#ffd700); nothing else on the chart uses it. */
const goldPixels = (page) => page.evaluate(() => {
  const c = document.getElementById("minimap");
  const g = c.getContext("2d");
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 240 && d[i + 1] > 200 && d[i + 1] < 232 && d[i + 2] < 40 && d[i + 3] > 120) n++;
  }
  return n;
});

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5287/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const cold = await page.evaluate(() => ({
    save: localStorage.getItem("dcc:save:v1"), hist: localStorage.getItem("dcc:history:v1"),
  }));
  ok("the profile is genuinely cold", !cold.save && !cold.hist, JSON.stringify(cold));

  await page.evaluate(() => document.getElementById("m-solo")?.click());
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    const g = document.getElementById("m-cast-go");
    if (g && g.getBoundingClientRect().width > 2) g.click();
  });
  await page.waitForTimeout(2600);
  for (let i = 0; i < 8; i++) {
    const open = await page.evaluate(() => {
      const el = document.getElementById("dialogue");
      return !!el && getComputedStyle(el).display !== "none";
    });
    if (!open) break;
    await page.keyboard.press("1");
    await page.waitForTimeout(1100);
  }
  await page.waitForTimeout(3000);

  const debut = await page.evaluate(() => ({
    firstRun: !!window.__dcc.state.firstRun, floor: window.__dcc.state.floor,
  }));
  ok("this is a DEBUT run on floor 1", debut.firstRun && debut.floor === 1, JSON.stringify(debut));

  // ---- 1. the beacon ------------------------------------------------------
  const mark = await readMark(page);
  ok("THE EXIT BEACON is on the glass", mark.visible, `${mark.w}x${mark.h} at ${mark.x},${mark.y} :: "${mark.text}"`);
  ok("...and it names the exit and its range", /EXIT/.test(mark.text) && /\d+\s*paces/.test(mark.text),
    `"${mark.text}"`);
  ok("...inside the frame, wherever the stairs are", mark.inFrame, JSON.stringify(mark));
  await page.screenshot({ path: path.join(OUT, "exit_beacon.png") });

  // ...and it FOLLOWS the world: walking changes the range it reports.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.down("w"); await page.waitForTimeout(520); await page.keyboard.up("w");
    await page.keyboard.down("d"); await page.waitForTimeout(520); await page.keyboard.up("d");
  }
  await page.waitForTimeout(1200);
  const mark2 = await readMark(page);
  ok("...and it re-reads the world as the crawler moves",
    mark2.visible && (mark2.text !== mark.text || mark2.x !== mark.x || mark2.y !== mark.y),
    `"${mark.text}"@${mark.x},${mark.y} -> "${mark2.text}"@${mark2.x},${mark2.y}`);

  // ---- 2. the chart marks the same exit ----------------------------------
  const gold = await goldPixels(page);
  ok("THE CHART carries the stairs mark through the fog", gold > 0, `${gold} marker px`);

  // ---- 3. a crawler who stops getting closer is handed a DIRECTION --------
  // Nothing is pressed from here: this is the measured shape of the failure —
  // a first-timer who does not know where to go, going nowhere.
  const before = await readAsk(page);
  let lost = null;
  for (let i = 0; i < 75; i++) {
    const a = await readAsk(page);
    if (a.visible && /paces/.test(a.text) && /north|south|east|west/i.test(a.text)) { lost = a; break; }
    await pump(page, 1000);
  }
  ok("a crawler going nowhere is given a HEADING, not another checkbox", !!lost?.visible,
    lost ? `"${lost.text}"` : `never (still "${before.text}")`);
  if (lost) {
    ok("...and the heading is a compass reading of the live world",
      /north|south|east|west/i.test(lost.text) && /\d+\s*paces/.test(lost.text), `"${lost.text}"`);
  }
  await page.screenshot({ path: path.join(OUT, "exit_lost_ask.png") });

  // ---- 4. the mercy escalates: the third knockdown is an ESCORT -----------
  // Staged through ?debug=1: two saves already banked, then a lethal frame.
  // The sim's own step loop routes it (p.hp <= 0 && alive), exactly as a
  // monster would, so nothing here is a shortcut around the rule.
  const stairs = await page.evaluate(() => ({ ...window.__dcc.state.map.stairs }));
  const staged = await page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    const already = (p.mercySaves ?? 0) >= 3; // the floor may have got there first
    p.mercySaves = 2;
    p.pos = { x: window.__dcc.state.map.spawn.x, y: window.__dcc.state.map.spawn.y };
    p.hp = -1;
    return { already };
  });
  await pump(page, 4000);
  const after = await page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    return { pos: { ...p.pos }, hp: p.hp, alive: p.alive, saves: p.mercySaves,
      status: window.__dcc.state.status };
  });
  const onStairs = Math.hypot(after.pos.x - stairs.x, after.pos.y - stairs.y) < 0.01;
  ok("THE THIRD KNOCKDOWN WALKS THEM TO THE EXIT", onStairs && after.alive && after.status === "playing",
    `saves=${after.saves} pos=${JSON.stringify(after.pos)} stairs=${JSON.stringify(stairs)}`);
  // The strip is one card at a time and the escort line is a once-ever
  // confirmation, so the honest question is whether it reached the glass AT ALL
  // this session — `said` is everything the strip has carried since boot.
  await pump(page, 12000);
  const escortCard = said.find((c) => /production/i.test(c) && /stairs|standing/i.test(c)) ?? null;
  ok("...and Mordecai says which key spends it", !!escortCard,
    escortCard ? `"${escortCard.slice(0, 150)}"` : JSON.stringify(said).slice(0, 300));
  ok("...and the knockdown was DIAGNOSED, not merely absorbed",
    said.some((c) => /dash|flask|production/i.test(c)),
    JSON.stringify(said.map((c) => c.slice(0, 44))).slice(0, 300));
  if (staged.already) console.log("NOTE: the floor had already escorted this crawler on its own.");
  await page.screenshot({ path: path.join(OUT, "exit_escort.png") });

  fs.writeFileSync(path.join(OUT, "r11_exit.json"), JSON.stringify(out, null, 2));
  console.log(`\n${out.checks.length - out.fails.length}/${out.checks.length} green`);
  if (out.fails.length) console.log("FAILED:", out.fails.join(", "));
} finally {
  await browser.close();
}
