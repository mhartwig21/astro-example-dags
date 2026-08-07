// TUTORIAL r3 acceptance probe — the host-side findings of the third critic
// round, measured in the real app. One cold profile, ONE browser, port 5287.
//
// What it measures, and why each is a pixel question rather than a unit test:
//  1. ONE COLUMN. The checklist, the plaque and the strip are one plate — same
//     x, contiguous, inside #coach's box. Four corners was the finding; boxes
//     are the only honest answer to it.
//  2. THE CARD TRACKS THE ROOM. Teleport onto the stairs, take them, and read
//     the card while the shop panel is open: it must say THE SAFE ROOM and its
//     "Open the shop" item must be struck through WHILE THE SHOP IS OPEN (the
//     sim is paused there, which is exactly what the old sampling seam could
//     not see). Then leave and watch it hand back to the spine.
//  3. THE DOOR IS NOT A WALL. Sample #toasts and #hud-log every 250ms across
//     the descent: no instant may hold more than one toast, and no feed line
//     may duplicate a toast's text.
//  4. THE STRIP SURVIVES A HELD KEY (r1 blocker 2, re-verified) — hold W for
//     six seconds with a card up and the card must still be there.
import { chromium } from "playwright";

const URL = "http://localhost:5287/iso.html?debug=1";
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) fails.push(msg); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const cold = await page.evaluate(() => ({
    hist: localStorage.getItem("dcc:history:v1"),
    save: localStorage.getItem("dcc:save:v1"),
  }));
  ok(!cold.hist && !cold.save, `profile is cold (history=${cold.hist} save=${cold.save})`);

  await page.keyboard.press("2");
  await page.waitForTimeout(600);
  await page.evaluate(() => { document.getElementById("m-solo")?.click(); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const go = document.getElementById("m-cast-go");
    if (go && go.offsetParent) go.click();
  });
  await page.waitForTimeout(2000);
  await page.keyboard.press("2"); // campfire farewell
  await page.waitForTimeout(3000);

  // ---- 1. ONE COLUMN -------------------------------------------------------
  const col = await page.evaluate(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
        h: Math.round(r.height), display: cs.display, visible: r.width > 0 && r.height > 0 };
    };
    return {
      coaching: document.body.classList.contains("coaching"),
      coach: box("coach"), head: box("coach-head"), obj: box("objectives"), tut: box("tutorial"),
      objInCoach: document.getElementById("coach")?.contains(document.getElementById("objectives")),
      tutInCoach: document.getElementById("coach")?.contains(document.getElementById("tutorial")),
      portraits: document.querySelectorAll("#coach img").length,
      title: document.querySelector("#objectives .obj-title")?.textContent ?? "",
    };
  });
  console.log("  column:", JSON.stringify(col));
  ok(col.coaching, "body.coaching is set while the curriculum is live");
  ok(col.objInCoach && col.tutInCoach, "checklist and strip are children of ONE column");
  ok(col.head?.visible, "the column carries Mordecai's plaque");
  ok(col.obj?.visible && col.obj.x === col.head.x,
    `checklist shares the plaque's x (${col.obj?.x} vs ${col.head?.x})`);
  ok(col.portraits <= 1, `ONE portrait in the teaching column (found ${col.portraits})`);
  ok(col.title.length > 0, `the checklist is showing a step (${col.title})`);

  // ---- 4. THE STRIP SURVIVES A HELD KEY -----------------------------------
  // Wait for a real card rather than sampling an instant (the r1 lesson: a
  // card's LIFETIME is the measurement, and "wait 12 iterations" under
  // software GL is twelve seconds).
  let had = false;
  for (let i = 0; i < 20 && !had; i++) {
    had = await page.evaluate(() => document.querySelectorAll("#tutorial .tut").length > 0);
    if (!had) await page.waitForTimeout(1000);
  }
  ok(had, "Mordecai's strip painted a card during floor 1");
  if (had) {
    await page.keyboard.down("w");
    await page.waitForTimeout(6000);
    const still = await page.evaluate(() => document.querySelectorAll("#tutorial .tut").length);
    await page.keyboard.up("w");
    ok(still > 0, "a card survives six seconds of HELD W (autorepeat is not an ack)");
  }

  // ---- 3. THE DOOR IS NOT A WALL, sampled across the descent --------------
  await page.evaluate(() => {
    window.__probe = { max: 0, dupes: [], samples: 0, arrived: 0 };
    const norm = (s) => s.toLowerCase().replace(/[\s.!:—-]+$/g, "").replace(/\s+/g, " ").trim();
    // How many lines the door actually delivered — the peak is only meaningful
    // beside it (one at a time is not an achievement if only one ever came).
    new MutationObserver((recs) => {
      for (const r of recs) window.__probe.arrived += r.addedNodes.length;
    }).observe(document.getElementById("toasts"), { childList: true });
    window.__probeTimer = setInterval(() => {
      const toasts = [...document.querySelectorAll("#toasts .toast")]
        .filter((e) => !e.dataset.dying && getComputedStyle(e).opacity !== "0")
        .map((e) => norm(e.textContent));
      const feed = [...document.querySelectorAll("#hud-log-feed .log-line")]
        .map((e) => norm(e.textContent));
      window.__probe.samples++;
      window.__probe.max = Math.max(window.__probe.max, toasts.length);
      for (const t of toasts) if (feed.includes(t)) window.__probe.dupes.push(t);
    }, 150);
  });

  // Teleport onto the stairs and take them (host-side probe staging; the sim's
  // own descent rule then runs untouched).
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const me = s.players[0];
    me.pos = { x: s.map.stairs.x, y: s.map.stairs.y };
  });
  await page.waitForTimeout(500);
  await page.keyboard.press("e");
  await page.waitForTimeout(2500);
  // Mordecai's safe-room MODAL beat plays before the panel (shipped behavior);
  // close it, and any banked draft, so the shelf is what we are looking at.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(1500);

  // ---- 2. THE CARD TRACKS THE ROOM ---------------------------------------
  const inShop = await page.evaluate(() => ({
    panel: getComputedStyle(document.getElementById("saferoom")).display,
    title: document.querySelector("#objectives .obj-title")?.textContent ?? "",
    items: [...document.querySelectorAll("#objectives .obj-items li")]
      .map((li) => `${li.classList.contains("done") ? "[x]" : "[ ]"} ${li.textContent.trim()}`),
    lesson: document.getElementById("sr-tip")?.textContent ?? "",
    stripShown: getComputedStyle(document.getElementById("tutorial")).display,
  }));
  console.log("  in shop:", JSON.stringify(inShop));
  ok(inShop.panel === "flex", "the safe-room panel is open");
  ok(/safe room/i.test(inShop.title), `the card is THE SAFE ROOM while shopping (got "${inShop.title}")`);
  ok(!/moving|kit|payday|show/i.test(inShop.title), "…and not a field step");
  ok(inShop.items.some((i) => i.startsWith("[x]") && /shop/i.test(i)),
    `"Open the shop" is ticked while the shop is open (${inShop.items.join(" / ")})`);
  ok(/gold/i.test(inShop.lesson), `the panel carries the shelf lesson (${inShop.lesson.slice(0, 80)})`);
  ok(inShop.stripShown === "none", "the strip stands down under the panel");

  await page.screenshot({ path: "tools/_shots/r3_saferoom.png" });

  // Leave: DESCEND hands the card back to the spine, and the arrival burst is
  // what the toast sampler is watching.
  await page.evaluate(() => { document.getElementById("sr-descend")?.click(); });
  await page.waitForTimeout(6000);

  const after = await page.evaluate(() => {
    clearInterval(window.__probeTimer);
    return {
      floor: window.__dcc.state.floor,
      title: document.querySelector("#objectives .obj-title")?.textContent ?? "",
      panel: getComputedStyle(document.getElementById("saferoom")).display,
      probe: window.__probe,
    };
  });
  console.log("  after descent:", JSON.stringify(after));
  ok(after.floor === 2, `the crawler is on floor 2 (got ${after.floor})`);
  ok(!/safe room/i.test(after.title),
    `the safe-room card did NOT follow them onto floor 2 (card: "${after.title}")`);
  ok(after.probe.arrived >= 2,
    `the door really did deliver a burst (${after.probe.arrived} lines)`);
  ok(after.probe.max <= 1,
    `never more than one System subtitle on the glass at once (peak ${after.probe.max} over ${after.probe.samples} samples)`);
  ok(after.probe.dupes.length === 0,
    `no feed line duplicates a live toast (${[...new Set(after.probe.dupes)].slice(0, 3).join(" | ")})`);

  await page.screenshot({ path: "tools/_shots/r3_floor2.png" });
  ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}
console.log(fails.length === 0 ? "\nALL GREEN" : `\n${fails.length} FAILED:\n- ${fails.join("\n- ")}`);
process.exit(fails.length === 0 ? 0 : 1);
