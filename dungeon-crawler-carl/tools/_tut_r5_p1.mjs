// TUTORIAL r5 — PHASE 1: BLOCKER 1 IN MORDECAI'S CHANNEL.
// The r4 critic proved: cold profile, died, pressed R 15ms after the ledger
// write -> ledger=[tut.campfire,tut.runback], verdictFrames=0, asideFrames=0.
// B8 deleted from the profile forever by one impatient keypress.
//
// This phase reproduces that exact sequence against r5 and demands the
// opposite: a cancelled reveal spends NOTHING, and the NEXT honest death
// paints the plate (raster-verified) and only then writes the ledger.
import { chromium } from "playwright";
import {
  SHOTS, check, log, dump, boxStats, boot, spyInit, ledger, snap,
  dlgVisible, assertCold, track404,
} from "./_tut_r5_lib.mjs";

const BASE = process.argv[2] ?? "http://localhost:5284";

/** Watch the aside plate the way a player would: is it on the glass, with text. */
const ASIDE_SPY = () => {
  window.__aside = { frames: 0, first: 0, text: "" };
  setInterval(() => {
    const recap = document.getElementById("recap");
    const el = document.getElementById("recap-guide");
    const line = document.getElementById("recap-guide-line");
    if (!recap || !el || !line) return;
    const visible = getComputedStyle(recap).display !== "none"
      && getComputedStyle(el).display !== "none"
      && (line.textContent ?? "").trim().length > 10;
    if (!visible) return;
    window.__aside.frames++;
    if (!window.__aside.first) window.__aside.first = performance.now();
    window.__aside.text = line.textContent ?? "";
  }, 40);
};

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const P = await ctx.newPage();
const errs = [], m404 = [];
P.on("pageerror", (e) => errs.push(e.message));
track404(P, m404);
await P.addInitScript(spyInit);
await P.addInitScript(ASIDE_SPY);

const aside = () => P.evaluate(() => ({ ...window.__aside }));
const resetAside = () => P.evaluate(() => { window.__aside = { frames: 0, first: 0, text: "" }; });

/** Walk at whatever is nearest; the point is to be reachable, not to win. */
async function playFor(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await snap(P);
    if (s.status !== "playing") return s;
    const d = await P.evaluate(() => {
      const st = window.__dcc?.state; if (!st) return null;
      const p = st.players[0];
      let best = null, bd = 1e9;
      for (const m of st.monsters ?? []) {
        if (m.hp <= 0) continue;
        const dd = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
        if (dd < bd) { bd = dd; best = { dx: m.pos.x - p.pos.x, dy: m.pos.y - p.pos.y, d: dd }; }
      }
      return best;
    });
    const keys = [];
    if (d) {
      if (d.dy < -0.3) keys.push("w"); else if (d.dy > 0.3) keys.push("s");
      if (d.dx < -0.3) keys.push("a"); else if (d.dx > 0.3) keys.push("d");
    }
    if (!keys.length) keys.push("d");
    for (const k of keys) await P.keyboard.down(k);
    await P.waitForTimeout(480);
    for (const k of keys) await P.keyboard.up(k);
    await P.waitForTimeout(60);
  }
  return await snap(P);
}

/** Die honestly: the sim's own damage lands the killing blow. The probe only
 *  makes the crawler frail and stops them running away from it. */
async function dieNow() {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const s = await snap(P);
    if (s.status !== "playing") return s;
    await P.evaluate(() => { window.__dcc.state.players[0].hp = 1; });
    if (s.near > 1.4) await playFor(600);
    else await P.waitForTimeout(500); // stand still and let it happen
  }
  return await snap(P);
}

async function startRun() {
  await P.click("#m-solo");
  await P.waitForTimeout(900);
  if (await dlgVisible(P)) { await P.click('[data-choice="go"]').catch(() => {}); await P.waitForTimeout(700); }
  await P.click("#m-cast-go");
  await P.waitForFunction(() => window.__dcc?.state?.status === "playing", { timeout: 30000 });
}

try {
  await boot(P, `${BASE}/iso.html?debug=1&noassets`);
  await assertCold(P, "R5P1");
  await startRun();

  // ---- DEATH 1: the impatient R, the exact r4 sequence --------------------
  await playFor(9000);
  const dead1 = await dieNow();
  log(`DEATH 1 @ ${JSON.stringify(dead1)}`);
  check("R5P1: death 1 actually happened", dead1.status === "dead", dead1.status);
  // 200ms is well inside the 620ms reveal timer that r4's ledger write raced.
  await P.waitForTimeout(200);
  const ledgerAtR = await ledger(P);
  await P.keyboard.press("r");
  await P.waitForTimeout(1500);
  const a1 = await aside();
  await P.screenshot({ path: `${SHOTS}r5_p1_after_fast_r.png` });
  log(`AFTER FAST R: aside=${JSON.stringify(a1)} ledger@R=${JSON.stringify(ledgerAtR)}`);
  const ledger1 = await ledger(P);
  log(`LEDGER after fast R = ${JSON.stringify(ledger1)}`);
  check("R5P1 BLOCKER 1: the aside plate never painted", a1.frames === 0, `frames=${a1.frames}`);
  check("R5P1 BLOCKER 1: ...so tut.runback was NOT spent",
    !ledger1.includes("tut.runback"), JSON.stringify(ledger1));
  const s2 = await snap(P);
  check("R5P1: the fast R really started run 2", s2.status === "playing" && s2.floor === 1,
    JSON.stringify({ status: s2.status, floor: s2.floor, elapsed: s2.elapsed }));

  // ---- DEATH 2: the honest one. The beat must still be owed --------------
  await resetAside();
  await playFor(9000);
  const dead2 = await dieNow();
  log(`DEATH 2 @ ${JSON.stringify(dead2)}`);
  await P.waitForTimeout(3000);
  const a2 = await aside();
  const file = `${SHOTS}r5_p1_second_death.png`;
  await P.screenshot({ path: file });
  const box = await P.evaluate(() => {
    const el = document.getElementById("recap-guide");
    if (!el || getComputedStyle(el).display === "none") return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  log(`SECOND DEATH aside=${JSON.stringify(a2)} box=${JSON.stringify(box)}`);
  check("R5P1: the aside plate PAINTED on the next honest death",
    a2.frames > 0 && /tuition/i.test(a2.text), `frames=${a2.frames} text="${a2.text.slice(0, 80)}"`);
  if (box) {
    const st = boxStats(file, box);
    check(`R5P1 RASTER: the plate is really on the glass (std ${st.std.toFixed(1)}, warm ${(st.warmFrac * 100).toFixed(1)}%)`,
      st.std > 8 && box.width > 100 && box.height > 20, JSON.stringify(box));
  } else {
    check("R5P1 RASTER: the plate has a box", false, "display:none");
  }
  const ledger2 = await ledger(P);
  log(`LEDGER after honest death = ${JSON.stringify(ledger2)}`);
  check("R5P1: only NOW is tut.runback on the ledger",
    ledger2.includes("tut.runback"), JSON.stringify(ledger2));

  log(`errors ${JSON.stringify(errs)} | 404s ${JSON.stringify(m404)}`);
  check("R5P1: zero page errors", errs.length === 0, errs.join(" | "));
} finally {
  dump("_r5_p1.txt");
  await browser.close();
}
