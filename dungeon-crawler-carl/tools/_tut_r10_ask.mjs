// r10 — THE STANDING ASK, ON THE GLASS. One browser, port 5287, cold profile.
//
// The root-cause finding this answers: "the coach prose slot teaches the wrong
// thing, once, and never again." The four properties that have to be true in
// the app, not merely in the unit tests:
//
//   1. the current ask is PAINTED prose, with a real rect, on the persistent
//      card — not a card that was queued once and spent;
//   2. it FOLLOWS the player: check an item, and the prose is for the next one;
//   3. a player who stalls is ESCALATED to the concrete form (.obj-ask.hot)
//      instead of hearing nothing;
//   4. a BANKED DRAFT pre-empts everything and names its key.
//
// Every text read is paired with a geometry read (rect + computed display), so
// this measures the glass and not the DOM (HANDOFF §0), and it shoots frames.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/tutorial-mordecai/dungeon-crawler-carl";
const OUT = path.resolve(ROOT, process.env.TUT_OUT ?? "tools/_shots/tut_r10");
fs.mkdirSync(OUT, { recursive: true });
const URL = "http://localhost:5287/iso.html?debug=1";

const out = { checks: [], fails: [] };
const ok = (name, pass, detail) => {
  out.checks.push({ name, pass, detail });
  if (!pass) out.fails.push(name);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
};

/** The ask as the player sees it: text ONLY when it has a real rect. */
const readAsk = (page) => page.evaluate(() => {
  const el = document.querySelector("#objectives .obj-ask");
  if (!el) return { present: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    present: true,
    text: el.textContent.trim(),
    caps: [...el.querySelectorAll("kbd")].map((k) => k.textContent),
    hot: el.classList.contains("hot"),
    w: Math.round(r.width), h: Math.round(r.height),
    visible: cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.5
      && r.width > 40 && r.height > 8,
  };
});
const strip = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#tutorial .tut-body")].map((e) => e.textContent.trim()));

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
    tips: localStorage.getItem("dcc:tips:v1"),
    save: localStorage.getItem("dcc:save:v1"),
    hist: localStorage.getItem("dcc:history:v1"),
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

  // ---- 1. the ask is painted, with the control drawn as a cap -------------
  const first = await readAsk(page);
  ok("the standing ask is ON THE GLASS at the first ask", first.visible,
    `${first.w}x${first.h} :: "${first.text}"`);
  ok("...and it names a control, drawn as a key cap", first.caps?.length > 0,
    JSON.stringify(first.caps));
  await page.screenshot({ path: path.join(OUT, "ask_first.png") });

  // ---- 2. a stalled player is escalated rather than left in silence -------
  // Nothing is pressed here: this is the measured shape of the failure the
  // round is fixing — a first-timer who does not know what to do, doing
  // nothing, and hearing nothing back.
  let hot = null;
  for (let i = 0; i < 70; i++) {
    const a = await readAsk(page);
    if (a.hot) { hot = a; break; }
    await page.waitForTimeout(1000);
  }
  ok("a stalled ask ESCALATES to the concrete form", !!hot?.visible,
    hot ? `"${hot.text}"` : "never escalated in 70s");
  if (hot) {
    ok("...and the escalation says MORE than the ask did",
      hot.text.length > first.text.length, `${first.text.length} -> ${hot.text.length}`);
  }
  // ...IN PLACE. r8's finding 3 is still binding: the same sentence twice in
  // one column is two teaching surfaces wearing one plate. The escalation
  // changes the prose where the player is already reading and does not open a
  // card, so the strip must NOT be carrying a copy of it.
  const cards = await strip(page);
  ok("...delivered IN PLACE, with no duplicate card under it",
    !cards.some((c) => hot && c.slice(0, 40) === hot.text.slice(0, 40)),
    JSON.stringify(cards).slice(0, 220));
  await page.screenshot({ path: path.join(OUT, "ask_escalated.png") });

  // ---- 3. the ask FOLLOWS the world --------------------------------------
  for (let i = 0; i < 6; i++) {
    await page.keyboard.down("w"); await page.waitForTimeout(500); await page.keyboard.up("w");
    await page.keyboard.down("d"); await page.waitForTimeout(500); await page.keyboard.up("d");
  }
  await page.waitForTimeout(1500);
  const moved = await readAsk(page);
  ok("checking an item hands the prose to the NEXT one",
    moved.visible && moved.text !== first.text && !moved.hot,
    `"${moved.text}" (hot=${moved.hot})`);

  // ---- 4. a banked draft pre-empts everything ----------------------------
  // Staged through the ?debug=1 hook: the sim mints the pending pick itself on
  // the next step, exactly as a level-up does, and banks it behind the badge
  // because the crawler is not in a safe room.
  await page.evaluate(() => { window.__dcc.state.players[0].upgradeDraftsOwed = 1; });
  await page.waitForTimeout(3000);
  const banked = await page.evaluate(() => window.__dcc.state.players[0].pendingUpgrades.length);
  const draftAsk = await readAsk(page);
  ok("a banked draft PRE-EMPTS the step's ask and names its key",
    banked > 0 && draftAsk.visible && /draft/i.test(draftAsk.text) && draftAsk.caps.length > 0,
    `banked=${banked} caps=${JSON.stringify(draftAsk.caps)} :: "${draftAsk.text}"`);
  await page.screenshot({ path: path.join(OUT, "ask_draft.png") });

  fs.writeFileSync(path.join(OUT, "r10_ask.json"), JSON.stringify(out, null, 2));
  console.log(`\n${out.checks.length - out.fails.length}/${out.checks.length} green`);
  if (out.fails.length) console.log("FAILED:", out.fails.join(", "));
} finally {
  await browser.close();
}
