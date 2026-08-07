// TUTORIAL FIX ROUND 1 — the r1 critic's blockers, checked in the real app.
// Port 5287 ONLY, one browser, closed at the end.
//
// What it asserts, and why each one is the bug rather than something adjacent
// to it (HANDOFF §0):
//  1. THE FIVE PAINTS. Seed a profile with obj.move already on the ledger and
//     every obj.five fact pre-true (strike/dash/cast are run-cumulative), then
//     check the card SHOWS "The Five" and the ledger does NOT hold obj.five.
//     The old build wrote the key on the arming call and the step was gone.
//  2. AUTOREPEAT DOES NOT DELETE A CARD. Dispatch keydown{repeat:true} at a
//     painted card and assert it survives; then a real keydown inside the read
//     budget must also leave it standing.
//  3. THE CAMPFIRE SKIP IS OFF THE NUMBER ROW. Two presses of "2" must not
//     consume the curriculum.
//  4. THE COLD MENU BOARD SHOWS NO SKELETON under a resolved-empty answer.
//  5. THE OBJECTIVES CARD SURVIVES A MODAL (the panel a step points at must
//     not hide the step).
import { chromium } from "playwright";

const URL = "http://localhost:5287/iso.html";
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) fails.push(msg); };

const browser = await chromium.launch();
try {
  // ---- 3 + 4: cold profile, the campfire and the cover shot ---------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4500);

    const board = await page.evaluate(() => {
      const list = document.getElementById("m-board-list");
      return {
        html: list?.innerHTML ?? "",
        ghosts: list?.querySelectorAll("li.none .ghost").length ?? 0,
        text: (list?.textContent ?? "").slice(0, 90),
      };
    });
    // The in-flight "TUNING IN" state legitimately keeps its ghosts; a settled
    // answer must not. Either the board resolved (no ghosts) or it is still
    // tuning in, and the probe says which rather than passing on ambiguity.
    const tuning = /TUNING IN/i.test(board.text);
    console.log(`INFO board: "${board.text.trim()}" ghosts=${board.ghosts}`);
    ok(tuning || board.ghosts === 0,
      `resolved-empty board carries no skeleton rows (ghosts=${board.ghosts}, tuning=${tuning})`);

    // The campfire beat (B0) rides the CASTING stage, not the front page, so
    // the probe has to get there before it can look at the choice list.
    await page.evaluate(() => {
      const go = document.getElementById("m-cast-go");
      if (go && go.offsetParent) { go.click(); return; }
      document.getElementById("m-daily")?.click();
    });
    await page.waitForTimeout(2500);

    // The campfire beat: the skip must not wear a number.
    const camp = await page.evaluate(() => {
      const el = document.getElementById("dlg-choices");
      return {
        open: document.getElementById("dialogue")?.style.display === "flex",
        numbered: [...(el?.querySelectorAll(".dlg-choice") ?? [])].map((b) => b.textContent.trim()),
        skips: [...(el?.querySelectorAll(".dlg-skip") ?? [])].map((b) => b.textContent.trim()),
      };
    });
    console.log("INFO campfire:", JSON.stringify(camp));
    if (camp.open) {
      ok(camp.skips.length === 1, `the skip is an unnumbered control (skips=${camp.skips.length})`);
      ok(!camp.numbered.some((t) => /skip/i.test(t)),
        `no numbered choice is the skip (${camp.numbered.join(" | ")})`);
      // Answer 1 (the reply), then press 2 twice — the old build's data-loss path.
      await page.keyboard.press("1");
      await page.waitForTimeout(700);
      await page.keyboard.press("2");
      await page.waitForTimeout(400);
      await page.keyboard.press("2");
      await page.waitForTimeout(600);
      const tips = await page.evaluate(() => localStorage.getItem("dcc:tips:v1") ?? "");
      ok(!tips.includes("tut.skipAll"),
        `double-tapping 2 at the campfire does not skip the curriculum (tips=${tips})`);
    } else {
      ok(false, "the campfire beat did not open on a cold profile");
    }
    ok(errs.length === 0, `no page errors on the cold path (${errs.slice(0, 2).join(" | ")})`);
    await ctx.close();
  }

  // ---- 1 + 2 + 5: THE FIVE, in a live run --------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    // A profile that has done step one and nothing else — exactly the state
    // in which obj.five used to be born completed.
    await page.addInitScript(() => {
      localStorage.setItem("dcc:tips:v1", JSON.stringify(["obj.enrolled", "obj.move", "tut.campfire"]));
    });
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      const go = document.getElementById("m-cast-go");
      if (go && go.offsetParent) { go.click(); return; }
      document.getElementById("m-daily")?.click();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const go = document.getElementById("m-cast-go");
      if (go && go.offsetParent) go.click();
    });
    await page.waitForTimeout(2500);

    // Make every obj.five fact true the way a first fight would: swing, dash,
    // cast. (Held keys, ≥450ms — software GL runs the sim slowly.)
    for (const k of ["Space", "Shift", "q"]) {
      await page.keyboard.down(k);
      await page.waitForTimeout(500);
      await page.keyboard.up(k);
    }
    for (let i = 0; i < 4; i++) {
      await page.keyboard.down("d"); await page.waitForTimeout(450); await page.keyboard.up("d");
      await page.keyboard.down("Space"); await page.waitForTimeout(450); await page.keyboard.up("Space");
    }

    const five = await page.evaluate(() => ({
      objText: document.getElementById("objectives")?.textContent ?? "",
      tips: localStorage.getItem("dcc:tips:v1") ?? "",
      tut: window.__dcc?.tut?.() ?? null,
    }));
    console.log("INFO five:", JSON.stringify(five).slice(0, 400));
    ok(/The Five/i.test(five.objText),
      `THE FIVE is on the glass (card="${five.objText.replace(/\s+/g, " ").slice(0, 80)}")`);
    ok(!five.tips.includes("obj.five"),
      `THE FIVE is not spent before it has been read (tips=${five.tips})`);

    // ---- 2: autorepeat must not delete a painted card --------------------
    // Waits for a card that has JUST painted (`.tut.show`), so the measurement
    // cannot be a card that was already on its way out — the first version of
    // this probe measured exactly that and reported a false failure.
    // CDP does not send autorepeat, so the repeat flag is synthesised; the
    // handler's branch is the thing under test either way.
    // MEASURE THE CARD'S LIFETIME, not a boolean at an arbitrary instant. The
    // first version of this probe asserted "still there after N iterations",
    // which under software GL (~3fps, setTimeout starved) was 12 SECONDS — so
    // it kept catching the card's own honest auto-dismiss at 7s and reporting
    // it as an input kill. A held key used to end a card at 1.2s; the auto-
    // hold is >= 7s. Lifetime separates those two answers cleanly.
    const repeat = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const live = () => document.querySelector("#tutorial .tut.show");
      // Wait for the 0 -> 1 EDGE, so the card under test is freshly painted.
      for (let i = 0; i < 200 && live(); i++) await wait(150);
      for (let i = 0; i < 400 && !live(); i++) await wait(150);
      if (!live()) return { painted: false };
      const card = live();
      const t0 = performance.now();
      // Held-key autorepeat plus one deliberate press, from the instant it
      // paints — everything a player holding W and swinging actually sends.
      let deliberateAt = 0;
      while (card.isConnected && card.classList.contains("show")) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", repeat: true, bubbles: true }));
        if (!deliberateAt && performance.now() - t0 > 300) {
          deliberateAt = performance.now() - t0;
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", repeat: false, bubbles: true }));
        }
        if (performance.now() - t0 > 20000) break;
        await wait(30);
      }
      return { painted: true, lifeMs: Math.round(performance.now() - t0), deliberateAt: Math.round(deliberateAt) };
    });
    if (repeat.painted) {
      console.log(`INFO card lifetime under held-key input: ${repeat.lifeMs}ms ` +
        `(first deliberate press at ${repeat.deliberateAt}ms)`);
      // The old build's answer here was ~1200ms. The auto-hold floor is 7000ms.
      ok(repeat.lifeMs >= 5000,
        `held-key input does not delete the card (lived ${repeat.lifeMs}ms, old build: ~1200ms)`);
      ok(repeat.deliberateAt > 0 && repeat.deliberateAt < repeat.lifeMs,
        `a deliberate keypress inside the read budget did not end it either ` +
        `(pressed at ${repeat.deliberateAt}ms, card lived ${repeat.lifeMs}ms)`);
    } else {
      ok(false, "no strip card painted in two minutes of play — the strip is mute");
    }

    // ---- 5: the card survives the panel it points at ---------------------
    const modal = await page.evaluate(async () => {
      document.getElementById("inv")?.style.setProperty("display", "flex");
      document.body.classList.add("modal");
      await new Promise((r) => setTimeout(r, 250));
      const el = document.getElementById("objectives");
      const cs = getComputedStyle(el);
      const out = { display: cs.display, opacity: cs.opacity, vis: cs.visibility, z: cs.zIndex };
      document.body.classList.remove("modal");
      document.getElementById("inv")?.style.setProperty("display", "none");
      return out;
    });
    console.log("INFO under modal:", JSON.stringify(modal));
    ok(modal.display !== "none" && modal.visibility !== "hidden" && Number(modal.opacity) > 0.5,
      `the objectives card stays mounted under a modal (${JSON.stringify(modal)})`);
    ok(Number(modal.z) >= 26, `...and above the in-run panels' scrims (z=${modal.z})`);
    ok(errs.length === 0, `no page errors in the run (${errs.slice(0, 2).join(" | ")})`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(fails.length === 0 ? "R1 FIX GREEN" : `R1 FIX RED: ${fails.length} failures`);
process.exit(fails.length === 0 ? 0 : 1);
