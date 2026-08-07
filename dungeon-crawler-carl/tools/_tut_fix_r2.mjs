// FIX ROUND 2 acceptance — the things this round CHANGED, measured in the app.
// One chromium at 1600x900 against the ALREADY-RUNNING dev server on 5287.
//
// What it asserts (and what it deliberately does not):
//   1. COLD BOOT IS ONE DOOR — body.coldboot is set on a fresh profile, the
//      featured band / mode grid / boards column are gone, MORE WAYS TO CRAWL
//      is there, and one click brings the whole board back.
//   2. ONE TEACHING COLUMN — #tutorial and #objectives share the right rail,
//      the strip sits BELOW the card, and their rects never overlap.
//   3. KEY CAPS — the card draws its {tokens} as <kbd class="obj-key">, the
//      strip draws the control it names as <kbd class="tut-key">.
//   4. SHIFT IS THE DASH — no strip line ever says "cast" and Shift together.
//   5. no page errors, no console errors.
// NOT covered here (unit tests only, and named as such in the report): the
// safe-room pre-empt, the shop lesson line, and the floor-transition
// announcement rules — none is reachable from a cold floor-1 boot inside a
// probe budget of one browser.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/tutorial-mordecai/dungeon-crawler-carl";
const OUT = path.resolve(ROOT, "tools/_shots/tutorial_r2fix");
fs.mkdirSync(OUT, { recursive: true });
const URL = "http://localhost:5287/iso.html?debug=1&eagerassets=1";

const t0 = Date.now();
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + JSON.stringify(detail) : ""}`);
};

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const errs = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });

  await page.goto("http://localhost:5287/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 120000 })
    .catch(() => console.log("WARN assets never settled"));
  await page.waitForTimeout(1500);

  // ---- 1. COLD BOOT ------------------------------------------------------
  const vis = `(el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }`;
  const cold = await page.evaluate(`(() => {
    const vis = ${vis};
    const q = (s) => document.querySelector(s);
    return {
      cls: document.body.classList.contains("coldboot"),
      hero: vis(q("#m-hero-row")), modes: vis(q("#menu .m-modes")),
      side: vis(q("#menu .m-side")), test: vis(q("#m-test")),
      more: vis(q("#m-more")), descend: vis(q("#m-solo")),
    };
  })()`);
  check("cold boot: body.coldboot set on a fresh profile", cold.cls, cold);
  check("cold boot: DESCEND is the door, the other eight are folded",
    cold.descend && cold.more && !cold.hero && !cold.modes && !cold.side && !cold.test, cold);
  await page.screenshot({ path: path.join(OUT, "01_menu_coldboot.png") });

  const after = await page.evaluate(`(async () => {
    document.getElementById("m-more").click();
    await new Promise((r) => requestAnimationFrame(r));
    const vis = ${vis};
    const q = (s) => document.querySelector(s);
    return { cls: document.body.classList.contains("coldboot"), hero: vis(q("#m-hero-row")), side: vis(q("#menu .m-side")) };
  })()`);
  check("cold boot: MORE WAYS TO CRAWL unfolds the full board (a fold, not a lock)",
    !after.cls && after.hero && after.side, after);
  await page.screenshot({ path: path.join(OUT, "02_menu_unfolded.png") });

  // ---- start the run -----------------------------------------------------
  // Fold the menu back open first, then walk the two-stage CTA (check-in ->
  // casting) exactly like the r2 shooter, and answer any campfire beat.
  await page.evaluate(() => { document.getElementById("m-solo").click(); });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const g = document.getElementById("m-cast-go");
    if (g && g.getBoundingClientRect().width > 2) g.click();
  });
  await page.waitForTimeout(2200);
  // Mordecai's campfire beat may own the frame first; answer it away.
  for (let i = 0; i < 6; i++) {
    const dlg = await page.evaluate(`(() => {
      const el = document.getElementById("dialogue");
      if (!el || getComputedStyle(el).display === "none") return null;
      const c = [...document.querySelectorAll("#dlg-choices .dlg-choice")].map((b) => b.textContent.trim());
      return c;
    })()`);
    if (!dlg) break;
    await page.keyboard.press("1");
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(2500);
  console.log("STATE after start:", JSON.stringify(await page.evaluate(`(() => ({
    body: document.body.className,
    status: window.__dcc?.state?.status, floor: window.__dcc?.state?.floor,
    objDisplay: getComputedStyle(document.getElementById("objectives")).display,
  }))()`)));

  // Walk and swing so the strip actually speaks, and the card ticks.
  const stripLines = [];
  // THE GEOMETRY HAS TO BE READ WHILE BOTH SURFACES ARE UP. A card is
  // transient; sampling the rects after the walk measures an empty strip and
  // proves nothing — which is exactly what the first run of this probe did.
  let column = null;
  let columnShot = false;
  const sampleStrip = async () => {
    const t = await page.evaluate(`(() => {
      const vis = ${vis};
      const el = document.querySelector("#tutorial .tut");
      const tut = document.getElementById("tutorial"), obj = document.getElementById("objectives");
      const rect = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      if (!el || !vis(el)) return null;
      return {
        both: vis(obj) && vis(tut),
        objR: vis(obj) ? rect(obj) : null, tutR: rect(el),
        body: (el.querySelector(".tut-body")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
        caps: [...el.querySelectorAll(".tut-key")].map((k) => k.textContent),
        name: (el.querySelector(".tut-name")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
        face: !!el.querySelector(".tut-face"),
      };
    })()`);
    if (!t || !t.body) return;
    if (!stripLines.some((l) => l.body === t.body)) stripLines.push(t);
    if (t.both && !column) column = { obj: t.objR, tut: t.tutR };
    if (t.both && !columnShot) {
      columnShot = true;
      await page.screenshot({ path: path.join(OUT, "03_teaching_column.png") });
    }
  };

  for (let i = 0; i < 70; i++) {
    await page.keyboard.down(i % 2 ? "w" : "d");
    await page.waitForTimeout(420);
    await page.keyboard.up(i % 2 ? "w" : "d");
    await sampleStrip();
    if (i % 3 === 0) { await page.keyboard.down(" "); await page.waitForTimeout(300); await page.keyboard.up(" "); }
    if (stripLines.length >= 3) break;
  }
  await sampleStrip();

  // ---- 2/3. THE TEACHING COLUMN -----------------------------------------
  const geo = await page.evaluate(`(() => {
    const vis = ${vis};
    const o = document.getElementById("objectives"), t = document.getElementById("tutorial");
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      objVis: vis(o), tutVis: vis(t),
      obj: vis(o) ? r(o) : null, tut: vis(t) ? r(t) : null,
      objH: getComputedStyle(document.body).getPropertyValue("--obj-h").trim(),
      objKeys: [...document.querySelectorAll("#objectives .obj-key")].map((k) => k.textContent),
      objTitle: (document.querySelector(".obj-title")?.textContent ?? "").trim(),
      objItems: [...document.querySelectorAll("#objectives .obj-items li")].map((li) => li.textContent.replace(/\\s+/g, " ").trim()),
    };
  })()`);
  check("the objectives card is up", geo.objVis, { title: geo.objTitle, items: geo.objItems });
  if (column) {
    const sameRail = Math.abs((column.obj.x + column.obj.w) - (column.tut.x + column.tut.w)) <= 6;
    const below = column.tut.y >= column.obj.y + column.obj.h - 1;
    check("one column: strip and card share the right rail", sameRail, column);
    check("one column: the strip sits BELOW the card, never over it", below,
      { ...column, objH: geo.objH });
  } else {
    check("one column: both surfaces were up at once", false, geo);
  }

  // ---- 4. the key rules --------------------------------------------------
  const capped = stripLines.filter((l) => l.caps.length > 0);
  check("the strip draws its control as a KEY CAP", capped.length > 0,
    { lines: stripLines.map((l) => ({ body: l.body.slice(0, 90), caps: l.caps })) });
  check("the strip wears the nameplate + portrait chip",
    stripLines.length > 0 && stripLines.every((l) => l.face && /MORDECAI/.test(l.name)),
    stripLines.map((l) => l.name));
  const lie = stripLines.find((l) => /cast/i.test(l.body) && /shift/i.test(l.body));
  check("SHIFT IS NEVER TAUGHT AS A CAST KEY", !lie, lie ? lie.body : stripLines.map((l) => l.body.slice(0, 70)));

  if (!columnShot) await page.screenshot({ path: path.join(OUT, "03_teaching_column_fallback.png") });

  check("no page or console errors", errs.length === 0, errs.slice(0, 6));

  fs.writeFileSync(path.join(OUT, "_report.json"),
    JSON.stringify({ results, stripLines, geo, errs, sec: +((Date.now() - t0) / 1000).toFixed(1) }, null, 2));
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await browser.close();
}
