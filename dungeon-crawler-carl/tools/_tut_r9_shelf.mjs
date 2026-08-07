// r9 — THE FIRST SHELF, ON THE GLASS. A STAGED UI CHECK, NOT A COLD OUTCOME.
//
// The cold battery (_tut_r7_cold.mjs) is the outcome instrument and nothing
// here may be reported as one of its numbers: this script boots a genuine cold
// profile and then uses the ?debug=1 hook to STAGE the safe room (the hook's
// stated purpose — "stage scenarios"), because reaching the stairs organically
// takes 2-6 minutes of browser and the question being asked is only "does the
// panel say the true thing now".
//
// What it asserts, all read from the rendered panel:
//   * the shop lesson names an EMPTY SLOT and the tile that fills it
//   * no shelf copy anywhere calls a COMPONENTS tile a deferred part
//   * tiles that fill an empty slot carry the `fits` marking
//   * the sub-tab count at the first shelf (THE CHASE folded)
//   * the bag's empty copy no longer says components "wait here"
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/tutorial-mordecai/dungeon-crawler-carl";
const OUT = path.resolve(ROOT, "tools/_shots/tut_r9");
fs.mkdirSync(OUT, { recursive: true });
const URL = "http://localhost:5287/iso.html?debug=1";

const out = { checks: [], fails: [] };
const ok = (name, pass, detail) => {
  out.checks.push({ name, pass, detail });
  if (!pass) out.fails.push(name);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};

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
  await page.waitForTimeout(2500);

  // STAGE: stand the crawler on the stairs and take them, the way the taught
  // key does. Nothing else is written; the shelf that generates is the shelf
  // the seeded run was always going to generate.
  await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y;
  });
  const panelOpen = () => page.evaluate(() => {
    const e = document.getElementById("saferoom");
    return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 2;
  });
  for (let i = 0; i < 12 && !(await panelOpen()); i++) {
    await page.keyboard.down("e"); await page.waitForTimeout(320); await page.keyboard.up("e");
    await page.waitForTimeout(900);
    // Mordecai's safe-room beat (B5) takes the glass first, and its first
    // choice IS "Open the shop." — a first-timer answers it, so we answer it.
    for (let j = 0; j < 4; j++) {
      const dlg = await page.evaluate(() => {
        const el = document.getElementById("dialogue");
        return !!el && getComputedStyle(el).display !== "none";
      });
      if (!dlg) break;
      await page.keyboard.press("1");
      await page.waitForTimeout(1100);
    }
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "shelf_first.png") });

  const shelf = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll("#sr-shelf .itile")].map((t) => ({
      id: t.dataset.id, ready: t.classList.contains("ready"), fits: t.classList.contains("fits"),
      title: t.getAttribute("title") ?? "",
    }));
    return {
      open: getComputedStyle(document.getElementById("saferoom")).display !== "none",
      lesson: (document.getElementById("sr-tip")?.textContent ?? "").trim(),
      gold: window.__dcc.state.players[0].gold,
      tiles, ready: tiles.filter((t) => t.ready).length, fits: tiles.filter((t) => t.fits).length,
      fitTitles: tiles.filter((t) => t.fits).map((t) => t.title).slice(0, 4),
      emptySlots: [...document.querySelectorAll("#sr-equipped .itile.eslot")].length,
      bagEmpty: (document.querySelector("#sr-bag .bempty")?.textContent ?? "").trim(),
      subTabs: [...document.querySelectorAll(".shop-subtabs .tab")]
        .filter((b) => getComputedStyle(b).display !== "none").map((b) => b.textContent.trim()),
      objTitle: (document.querySelector("#objectives .obj-title")?.textContent ?? "").trim(),
    };
  });
  out.shelf = shelf;
  console.log(JSON.stringify(shelf, null, 2).slice(0, 2000));

  ok("the safe room opened on a cold, enrolled profile", shelf.open);
  ok("the shop lesson is on the panel", shelf.lesson.length > 40, shelf.lesson.slice(0, 200));
  ok("the lesson names an EMPTY SLOT the purchase fills",
    /slot is empty/.test(shelf.lesson), shelf.lesson.slice(0, 160));
  ok("no copy on this panel defers a COMPONENTS tile",
    !/parts rather than gear|build into the real thing/i.test(shelf.lesson + " " + shelf.bagEmpty));
  ok("COMPONENTS are named as gear you wear today",
    /gear you wear today/i.test(shelf.lesson));
  ok("tiles that fill an empty slot are marked", shelf.fits > 0,
    `fits=${shelf.fits} of ready=${shelf.ready}; e.g. ${shelf.fitTitles[0] ?? ""}`);
  ok("a marked tile says WHICH slot it fills in its own hover text",
    shelf.fitTitles.some((t) => /FILLS YOUR EMPTY \w+ SLOT/.test(t)), shelf.fitTitles[0] ?? "");
  ok("THE CHASE is folded at the first shelf while the curriculum is live",
    !shelf.subTabs.includes("THE CHASE"), `subTabs=[${shelf.subTabs.join(", ")}]`);
  ok("the bag no longer claims components wait in it",
    !/wait here/.test(shelf.bagEmpty) || /goes straight on/.test(shelf.bagEmpty), shelf.bagEmpty);
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, "shelf.json"), JSON.stringify(out, null, 2));
console.log(`\n=== ${out.checks.length - out.fails.length}/${out.checks.length} checks green ===`);
if (out.fails.length) { console.log("FAILED: " + out.fails.join(" | ")); process.exitCode = 1; }
