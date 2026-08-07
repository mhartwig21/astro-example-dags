// THE HOLD (TUTORIAL.md r14) — acceptance battery.
//
// The owner played the integrated build and said the delivery was wrong: "no
// one reads long text while they're actively fighting in an ARPG." This round
// stops the game for a teaching beat. THIS FEATURE'S OWN LAW is that a claim
// about delivery is a claim about PIXELS, so nothing below is asserted from
// CSS or from a module's state alone where a rect can be measured instead.
//
// THE FALSIFYING SENTENCES, written before the probe (HANDOFF §0):
//   A. "it stopped the game while I was getting hit"
//   B. "I pressed space and the whole tutorial vanished"
// Probes 4 (the flush) and 7 (the lull gate) must fail on those two, or the
// instrument is measuring something adjacent again.
//
// Cold profile, ONE headless browser, port 5292, shipping server on dist:
//   STATIC_DIR=dist PORT=5292 npx tsx src/server/gameServer.ts
import { chromium } from "playwright";

const PORT = process.env.DCC_PORT ?? "5292";
const URL = `http://localhost:${PORT}/iso.html?debug=1`;
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) fails.push(msg); };
const info = (msg) => console.log(`INFO ${msg}`);

const held = (page) => page.evaluate(() => document.body.classList.contains("hold"));
const holdState = (page) => page.evaluate(() => window.__dcc?.holdState?.() ?? null);
const rectOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return null;
  const r = el.getBoundingClientRect();
  return r.width < 1 || r.height < 1 ? null : { x: r.x, y: r.y, w: r.width, h: r.height, text: el.textContent };
}, sel);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);

  // Assert the cold profile rather than assuming it (the r4 probe habit).
  const cold = await page.evaluate(() => ({
    tips: localStorage.getItem("dcc:tips:v1"),
    hist: localStorage.getItem("dcc:history:v1"),
  }));
  ok(!cold.hist, `profile is cold (history=${cold.hist})`);

  // ---- 1. THE CAMPFIRE HOLDS, AND IT PAGES -------------------------------
  // B0 rides the CASTING stage (enterCasting → maybeCampfireBeat), which on a
  // cold boot is one click: the folded menu's single door.
  await page.evaluate(() => document.getElementById("m-solo")?.click());
  // ---- 4. THE FLUSH: Space at the moment of opening advances NOTHING -----
  // Falsifying sentence B, and it is the whole anti-accident defence. Sent
  // INSIDE HOLD_DWELL_MS of the opening edge, so the panel must swallow it.
  await page.waitForTimeout(120);
  await page.keyboard.down("Space");
  await page.waitForTimeout(120);
  const flushMid = await holdState(page);
  await page.keyboard.up("Space");
  ok(flushMid.page === 0, `a Space pressed into the opening advances nothing (page=${flushMid.page})`);
  await page.waitForTimeout(1400);
  let st = await holdState(page);
  ok(await held(page), "B0 campfire opened as a HOLD (body.hold on the glass)");
  ok(st && st.pages >= 2, `the beat PAGES rather than scrolling (pages=${st?.pages})`);
  ok(st && st.page === 0, `it opens on page one and WAITS (page=${st?.page})`);

  // ---- AUTOREPEAT IS THE KEYBOARD TALKING, NOT THE PLAYER ---------------
  // r6-fix-1 blocker 2: holding W deleted every teaching card 1.2s after it
  // appeared. A key HELD across a whole beat may turn at most one page.
  await page.keyboard.down("Space");
  await page.waitForTimeout(2500);
  const repeated = await holdState(page);
  await page.keyboard.up("Space");
  ok(repeated.page <= 1 && (await held(page)),
    `a held Space advances at most one page and never ends the beat (page=${repeated.page}, held=${await held(page)})`);
  await page.waitForTimeout(900);

  // ---- 3. THE ADVANCE CONTROL HAS A RECT ON EVERY PAGE -------------------
  // A player who does not know a press is owed is stuck in a paused game, which
  // is strictly worse than the bug this feature fixes. Measured as a RECT.
  st = await holdState(page);
  const chev = await rectOf(page, "#dlg-adv");
  ok(st.last || !!chev,
    `page ${st.page}: the advance chevron is on the glass with a rect (${chev ? `${Math.round(chev.w)}x${Math.round(chev.h)}` : "MISSING"})`);
  info(`chevron reads: ${JSON.stringify(chev?.text)}`);

  while (!(await holdState(page)).last) {
    await page.keyboard.press("Space");
    await page.waitForTimeout(1400);
  }
  st = await holdState(page);
  ok(st.page === st.pages - 1, `Space walked through to the last page (page=${st.page}/${st.pages - 1})`);
  const chev2 = await rectOf(page, "#dlg-adv");
  const choices = await rectOf(page, "#dlg-choices .dlg-choice");
  ok(!!chev2 || !!choices, "the LAST page still advertises its control (chevron or the shipped choices)");
  info(`last-page control: ${JSON.stringify((chev2 ?? choices)?.text)}`);

  // Close B0 through its shipped farewell so the run can start.
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("#dlg-choices .dlg-choice")];
    (btns.find((b) => /let's go/i.test(b.textContent)) ?? btns[btns.length - 1])?.click();
  });
  await page.waitForTimeout(1200);
  ok(!(await held(page)), "the campfire resumed (body.hold gone)");

  // ---- start a run -------------------------------------------------------
  for (let i = 0; i < 4; i++) {
    const clicked = await page.evaluate(() => {
      for (const id of ["m-cast-go", "m-solo"]) {
        const el = document.getElementById(id);
        if (el && el.offsetParent) { el.click(); return id; }
      }
      return null;
    });
    if (clicked) info(`clicked ${clicked}`);
    await page.waitForTimeout(2200);
    if (!(await page.evaluate(() => document.body.classList.contains("checkin")))) break;
  }
  const playing = await page.evaluate(() => window.__dcc?.state?.status);
  ok(playing === "playing", `the run is live (status=${playing})`);

  // ---- 2. THE COLLAPSE CLOCK IS NOT SPENT BY READING ---------------------
  // Wait out obj.move's immediate intro hold, if it is not already up.
  for (let i = 0; i < 30 && !(await held(page)); i++) await page.waitForTimeout(400);
  const inHold = await held(page);
  ok(inHold, "the first step introduction arrives as a HOLD, not as a card");
  if (inHold) {
    const t0 = await page.evaluate(() => window.__dcc.state.timeRemaining);
    const phase = await rectOf(page, ".hh-phase.held");
    ok(!!phase, `the clock says HELD while it is stopped (${JSON.stringify(phase?.text)})`);
    await page.waitForTimeout(6000); // six seconds of reading
    const t1 = await page.evaluate(() => window.__dcc.state.timeRemaining);
    ok(Math.abs(t1 - t0) < 1e-9,
      `the collapse clock did not move across a 6s read (${t0} -> ${t1})`);

    // ---- 8. THE SPOTLIGHT: the pointed-at element is NOT dimmed ----------
    const lit = await page.evaluate(() => {
      const el = document.querySelector(".holdlit");
      if (!el) return null;
      const dimmed = [...document.querySelectorAll("#hud-tl, #hud-tr, #show, #cockpit, #minimap-frame")]
        .filter((x) => !x.classList.contains("holdlit"))
        .map((x) => Number(getComputedStyle(x).opacity));
      return { id: el.id, opacity: Number(getComputedStyle(el).opacity), dimmed };
    });
    if (lit) {
      ok(lit.opacity > 0.95, `the pointed-at #${lit.id} is at full opacity (${lit.opacity})`);
      ok(lit.dimmed.every((o) => o < 0.5), `the rest of the HUD stays dimmed (${lit.dimmed.join(",")})`);
    } else {
      // obj.move's pages point at nothing (walking IS the ask and the world is
      // the illustration), so the end-to-end spotlight needs obj.five, which is
      // three kills deep — out of reach of a ~3fps software-GL harness.
      //
      // What IS measured here is the thing the contract names as the risk:
      // "SPOTLIGHT EXEMPTIONS ARE CSS SPECIFICITY WORK against an existing
      // !important and a blanket dim rule. Easy to get half-right and ship a
      // beat pointing at something at 35% opacity." That is a specificity
      // question, it is answerable on THIS real frame under a real body.hold +
      // body.modal, and it is answered by putting the class on and reading the
      // computed opacity back. The end-to-end pointing is UNPROVEN and is
      // recorded as such in TUTORIAL.md — not reported as measured.
      // (Read AFTER the shipped 0.15s opacity transition has landed — a
      // computed opacity sampled on the same tick as the class change is the
      // value the element is transitioning FROM, which would report a pass or a
      // fail about nothing.)
      const before = await page.evaluate(() => {
        const el = document.getElementById("cockpit");
        el?.classList.add("holdlit");
        return Number(getComputedStyle(el).opacity);
      });
      // Generous: the shipped opacity transition is 0.45s and a software-GL
      // harness runs at ~3fps, so 600ms is one frame and proves nothing.
      await page.waitForTimeout(2600);
      const spec = await page.evaluate((b) => {
        const el = document.getElementById("cockpit");
        const after = Number(getComputedStyle(el).opacity);
        el.classList.remove("holdlit");
        return { before: b, after, modal: document.body.classList.contains("modal") };
      }, before);
      ok(spec && spec.modal && spec.before < 0.5 && spec.after > 0.95,
        `the spotlight out-specifies the blanket dim on a real frame (${JSON.stringify(spec)})`);
      info("end-to-end pointing (obj.five → #cockpit) is UNPROVEN here: three kills deep under software GL");
    }

    // ---- 9. THE OBJECTIVES CARD IS LEGIBLE UNDER body.hold --------------
    const card = await rectOf(page, "#objectives");
    ok(!!card, "the objectives card is on the glass under a hold (a rect, not a CSS claim)");
    const cardOp = await page.evaluate(() => {
      const el = document.getElementById("objectives");
      if (!el) return 0;
      let o = 1;
      for (let n = el; n && n !== document.body; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return o;
    });
    ok(cardOp > 0.9, `...and it is legible, not dimmed to a rumour (effective opacity ${cardOp.toFixed(2)})`);

    // ---- 6. THE REFUSAL COSTS TWO INPUTS, SAFE ANSWER IN SLOT 1 ---------
    await page.waitForTimeout(600);
    const skipBtn = await rectOf(page, "#dlg-choices .dlg-skip");
    ok(!!skipBtn, `"stop stopping the game" is a control OFF the number row (${JSON.stringify(skipBtn?.text)})`);
    const digitsBefore = await page.evaluate(() =>
      document.querySelectorAll("#dlg-choices .dlg-choice").length);
    ok(digitsBefore === 0, `no digit can reach it: the numbered row is empty (${digitsBefore})`);
    await page.click("#dlg-choices .dlg-skip");
    await page.waitForTimeout(700);
    const confirm = await page.evaluate(() =>
      [...document.querySelectorAll("#dlg-choices .dlg-choice")].map((b) => b.textContent));
    ok(confirm.length === 2, `taking it only ASKS (${confirm.length} answers offered)`);
    ok(/^1\s*No/i.test((confirm[0] ?? "").trim()), `the SAFE answer sits in slot 1 (${JSON.stringify(confirm[0])})`);
    // A DESTRUCTIVE ANSWER TAKEN MID-SENTENCE FINISHES THE SENTENCE INSTEAD.
    // The confirmation's whole job is to name its undo BEFORE it takes the
    // answer, and the ask is ~230 characters against a typewriter — so the
    // click that lands early must cost nothing but the rest of the warning.
    await page.evaluate(() =>
      [...document.querySelectorAll("#dlg-choices .dlg-choice")][1]?.click());
    await page.waitForTimeout(400);
    ok(!(await holdState(page)).refused,
      "a destructive click mid-sentence does NOT refuse anything");
    const askFull = await page.evaluate(() => document.getElementById("dlg-text")?.textContent ?? "");
    ok(/KEYS/.test(askFull),
      `...it finishes naming the undo instead (${JSON.stringify(askFull.slice(-90))})`);
    // Back out: slot 1 restores the ORIGINAL page.
    await page.evaluate(() => document.querySelector("#dlg-choices .dlg-choice")?.click());
    await page.waitForTimeout(900);
    ok(!(await holdState(page)).refused, "backing out leaves the holds intact");
    ok(await held(page), "...and the beat is still on the glass where it was");

    // ---- 5. ESC ON PAGE 1 RESUMES, WITH THE BEAT LEDGERED ---------------
    const keyNow = (await holdState(page)).key;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(900);
    ok(!(await held(page)), `ESC skips the beat and resumes the world (was ${keyNow})`);
    const running = await page.evaluate(() => window.__dcc.state.timeRemaining);
    await page.waitForTimeout(1500);
    const running2 = await page.evaluate(() => window.__dcc.state.timeRemaining);
    ok(running2 < running, `the sim is stepping again after the resume (${running} -> ${running2})`);
  }

  // ---- 7. A DUE BEAT WITH A MONSTER IN REACH DOES NOT HOLD --------------
  // Falsifying sentence A. Play forward; whenever a hold is up, assert nothing
  // was within HOLD_LULL_TILES of the crawler at the moment it opened.
  let violations = 0;
  let holds = 1; // the campfire
  let wasHeld = await held(page);
  for (let i = 0; i < 70; i++) {
    const k = ["d", "s", "a", "w"][i % 4];
    await page.keyboard.down(k);
    await page.waitForTimeout(220);
    await page.keyboard.up(k);
    await page.mouse.click(683, 300);
    const now = await held(page);
    if (now && !wasHeld) {
      holds++;
      const near = await page.evaluate(() => {
        const s = window.__dcc.state;
        const p = s.players.find((x) => x.id === s.players[0].id) ?? s.players[0];
        let d = Infinity;
        for (const m of s.monsters) {
          if (m.hp <= 0) continue;
          d = Math.min(d, Math.max(Math.abs(m.pos.x - p.pos.x), Math.abs(m.pos.y - p.pos.y)));
        }
        return { d, hp: p.hp / p.maxHp, phase: s.phase };
      });
      info(`hold #${holds} opened with nearest monster ${near.d.toFixed(1)} tiles, hp ${(near.hp * 100) | 0}%, phase ${near.phase}`);
      if (near.d <= 8 || near.hp <= 0.78 || near.phase === "collapse") violations++;
      await page.waitForTimeout(700);
      await page.keyboard.press("Escape"); // step past it and keep playing
      await page.waitForTimeout(500);
    }
    wasHeld = await held(page);
  }
  ok(violations === 0, `no hold opened inside the lull gate (violations=${violations})`);

  // ---- 1. THE SIX-HOLD CAP ---------------------------------------------
  const opened = (await holdState(page)).opened;
  ok(opened <= 6, `holds opened this session: ${opened} (cap 6)`);

  // ---- 10. UNDER NET, ZERO HOLDS ---------------------------------------
  const ctx2 = await ctx.browser().newContext({ viewport: { width: 1366, height: 768 } });
  const p2 = await ctx2.newPage();
  await p2.goto(`http://localhost:${PORT}/iso.html?debug=1&join=r14probe`, { waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(6000);
  for (let i = 0; i < 12; i++) {
    await p2.keyboard.down("d"); await p2.waitForTimeout(400); await p2.keyboard.up("d");
    if (await held(p2)) break;
  }
  ok(!(await held(p2)), "under ?join= (net) NO hold ever opens — the networked world never pauses");
  const netState = await holdState(p2);
  info(`net holdState: ${JSON.stringify(netState)}`);
  await ctx2.close();

  ok(errs.length === 0, `no page errors (${errs.slice(0, 3).join(" | ")})`);
} finally {
  await browser.close();
}

console.log(fails.length === 0 ? "\nALL PASS" : `\n${fails.length} FAILED:\n - ${fails.join("\n - ")}`);
process.exit(fails.length === 0 ? 0 : 1);
