// RELEASE CANDIDATE — THREE COLD FIRST SESSIONS, on the integrated build.
//
// WHY THIS EXISTS. `tutorial-pause` (r14 THE HOLD + r15 the re-authored
// curriculum) is code-complete and was NEVER RUN: its workflow died before
// verification, and its predecessor scored 7.0/10 "not shippable". Everything
// r14/r15 claim is a claim about what a cold player experiences, so this is
// measured cold, on the SHIPPING server over `dist`, with NO test mode and NO
// debug flags — which means no `window.__dcc`, and every read below comes off
// the DOM and localStorage the way a player's browser has them.
//
// THE FIVE QUESTIONS, one per report line:
//   1. Did teaching beats actually PAUSE the game, and could they be stepped
//      through and dismissed?  -> the collapse clock is sampled ACROSS a held
//      frame; a pause that is not arithmetic is not a pause.
//   2. Did the curriculum COMPLETE?  -> `dcc:tips:v1` must carry `obj.*`
//      (a step PERFORMED, written under an act) and not merely `hold.*`
//      (a beat SHOWN). This project has been burned by arming-vs-completion
//      twice; the two namespaces are reported separately and never summed.
//   3. Did they reach floor 2?  -> `#hh-floor`.
//   4. Are BOTH teaching systems firing?  -> every hold page's text and every
//      strip card's text are captured, then intersected. A lesson delivered
//      as a page AND as a strip card is the failure this merge was told to
//      prevent.
//   5. Lockup, or a pause that never released?  -> hold durations, and a
//      liveness probe that fails if the clock stops moving while NOT held.
//
// ONE BROWSER, three contexts (a fresh context is the cold profile), closed in
// a finally. Software GL runs this at ~3fps and dilates sim time, so keys are
// held >=450ms and the wall-clock budget buys far less in-game time than it
// would on a real machine — see the report's caveats.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const PORT = process.env.DCC_PORT ?? "5295";
const URL = `http://localhost:${PORT}/iso.html`;
const MINUTES = Number(process.env.DCC_MINUTES ?? "6");
const SHOTS = "tools/_shots/release";
mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log(...a);

/** Everything one sample tells us, read straight off the glass. */
const probe = (page) => page.evaluate(() => {
  const vis = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const dlg = document.getElementById("dialogue");
  const strip = document.getElementById("tutorial");
  const txt = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const stripCard = strip?.querySelector(".tut-card, .card, div");
  return {
    t: Date.now(),
    floor: txt(document.getElementById("hh-floor")),
    time: txt(document.getElementById("hh-time")),
    phase: txt(document.getElementById("hh-phase")),
    held: document.body.classList.contains("hold"),
    dlgOpen: vis(dlg),
    dlgTut: !!dlg?.classList.contains("tut"),
    dlgText: txt(document.getElementById("dlg-text")),
    typing: !!document.getElementById("dlg-text")?.classList.contains("typing"),
    choices: [...document.querySelectorAll("#dialogue .dlg-choice")].map((b) => txt(b)),
    adv: vis(document.getElementById("dlg-adv")),
    ring: vis(document.getElementById("holdring")),
    stripOn: vis(strip) && txt(strip).length > 0,
    stripText: vis(strip) ? txt(stripCard ?? strip) : "",
    banner: [...document.querySelectorAll("#headline .ann.banner, .ann.banner")].map((b) => txt(b)),
    keyBanner: [...document.querySelectorAll(".ann.banner.key")].map((b) => txt(b)),
    toasts: [...document.querySelectorAll("#toasts .toast")].map((b) => txt(b)),
    menu: vis(document.getElementById("menu")) || !!document.body.classList.contains("menu"),
    checkin: document.body.classList.contains("checkin"),
    castGo: (() => { const b = document.getElementById("m-cast-go"); return !!b && vis(b); })(),
    status: document.body.className,
  };
});

const ledger = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("dcc:tips:v1") ?? "[]"); } catch { return []; }
});

/** Hold a key long enough that a ~3fps frame actually observes it. */
async function tap(page, key, ms = 480) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/**
 * THE THREE PLAYERS. Not three speeds of the same script — three different
 * relationships with an interruption, because that is the axis r14 changed.
 */
const PROFILES = [
  {
    name: "novice",
    // Reads every page, presses Space slowly, wanders more than it fights,
    // never uses an ability it was not told about.
    readPauseMs: 1500, advanceEveryMs: 2600, escChance: 0, skipHolds: false,
    act: async (page, i) => {
      const k = ["w", "a", "s", "d"][(i >> 1) % 4];
      await tap(page, k, 700);
      if (i % 5 === 0) await tap(page, "Space", 520);
    },
  },
  {
    name: "average",
    readPauseMs: 700, advanceEveryMs: 1400, escChance: 0, skipHolds: false,
    act: async (page, i) => {
      const k = ["w", "d", "s", "a", "w", "d"][i % 6];
      await tap(page, k, 600);
      await tap(page, "Space", 480);
      if (i % 4 === 0) await tap(page, "1", 480);
      if (i % 7 === 0) await tap(page, "Shift", 480);
    },
  },
  {
    name: "veteran",
    // Impatient: finishes the typewriter and turns the page immediately, and
    // ESCs out of a beat roughly a third of the time (the non-destructive
    // "skip this beat" — NOT the curriculum refusal, which this never takes).
    readPauseMs: 220, advanceEveryMs: 500, escChance: 0.34, skipHolds: false,
    act: async (page, i) => {
      const k = ["d", "w", "a", "s"][i % 4];
      await tap(page, k, 480);
      await tap(page, "Space", 460);
      await tap(page, String((i % 4) + 1), 460);
      if (i % 3 === 0) await tap(page, "Shift", 460);
      if (i % 9 === 0) await tap(page, "r", 460);
    },
  },
];

/** A choice that is NOT the curriculum refusal. Taking "skip the hand-holding"
 *  would destroy the very thing under test, and no cold player is assumed to. */
const REFUSAL = /skip|hand-?holding|stop (stopping|interrupting)|leave me|no thanks|don'?t/i;

async function runProfile(browser, prof) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

  const R = {
    name: prof.name, errs,
    holds: [],            // {textFirst, pages, openMs, clockFrozen, phaseHeld, dismissed}
    stripTexts: new Set(),
    holdTexts: new Set(),
    floorsSeen: new Set(),
    maxFloor: 1,
    bothAtOnce: [],       // samples where a hold AND a strip card were live
    clockStalls: 0,
    longestHoldMs: 0,
    unreleasedHold: false,
    ledgerObj: [], ledgerHold: [], ledgerOther: [],
    samples: 0,
  };

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  // COLD, explicitly — a fresh context is already cold, but say so out loud so
  // a reused profile can never be mistaken for a first session.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const cold = await ledger(page);
  log(`[${prof.name}] cold profile: dcc:tips:v1 = ${JSON.stringify(cold)}`);

  // Into a solo run.
  for (let i = 0; i < 20; i++) {
    const clicked = await page.evaluate(() => {
      const b = document.getElementById("m-solo");
      if (b && getComputedStyle(b).display !== "none") { b.click(); return true; }
      return false;
    });
    if (clicked) break;
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/cold-${prof.name}-01-open.png` });

  const deadline = Date.now() + MINUTES * 60_000;
  let hold = null;
  let lastClock = null, lastClockChangeAt = Date.now();
  let step = 0;
  let shotN = 1;

  while (Date.now() < deadline) {
    const s = await probe(page);
    R.samples++;
    if (s.floor) { R.floorsSeen.add(s.floor); const n = parseInt(s.floor.replace(/\D+/g, ""), 10); if (n) R.maxFloor = Math.max(R.maxFloor, n); }
    if (s.stripOn && s.stripText) R.stripTexts.add(s.stripText);

    // ---- BOTH SYSTEMS AT ONCE? the merge's headline risk -------------------
    if ((s.held || (s.dlgOpen && s.dlgTut)) && s.stripOn && s.stripText) {
      R.bothAtOnce.push({ hold: s.dlgText.slice(0, 90), strip: s.stripText.slice(0, 90) });
    }

    // ---- A TEACHING BEAT IS UP ---------------------------------------------
    if (s.dlgOpen && (s.dlgTut || s.held)) {
      if (!hold) {
        hold = { openedAt: Date.now(), clockAtOpen: s.time, pages: 0, texts: [],
                 phaseHeld: false, frozen: null, dismissed: false };
        if (shotN <= 4) { await page.screenshot({ path: `${SHOTS}/cold-${prof.name}-0${++shotN}-hold.png` }); }
      }
      if (s.phase && /HELD/i.test(s.phase)) hold.phaseHeld = true;
      if (s.dlgText && !hold.texts.includes(s.dlgText)) { hold.texts.push(s.dlgText); hold.pages++; R.holdTexts.add(s.dlgText); }

      // THE PAUSE IS ARITHMETIC OR IT IS NOT A PAUSE: read the clock, wait,
      // read it again, WITHOUT touching the keyboard in between.
      if (hold.frozen === null && hold.pages >= 1) {
        const a = (await probe(page)).time;
        await page.waitForTimeout(2200);
        const b = (await probe(page)).time;
        hold.frozen = (a === b && a !== "");
        hold.clockPair = [a, b];
      }

      await page.waitForTimeout(prof.readPauseMs);
      const now = await probe(page);
      if (now.choices.length > 0 && !now.typing) {
        // Answer, but never with the refusal.
        const idx = now.choices.findIndex((c) => !REFUSAL.test(c));
        const pick = idx >= 0 ? idx : 0;
        await page.evaluate((n) => {
          const b = document.querySelectorAll("#dialogue .dlg-choice")[n];
          if (b) b.click();
        }, pick);
        hold.answered = now.choices[pick];
        await page.waitForTimeout(900);
      } else if (prof.escChance > 0 && Math.random() < prof.escChance && hold.pages >= 1) {
        await tap(page, "Escape", 460);
        hold.dismissed = true;
        await page.waitForTimeout(700);
      } else {
        await tap(page, "Space", 500);
      }
      continue;
    }

    // ---- the beat closed ---------------------------------------------------
    if (hold) {
      const ms = Date.now() - hold.openedAt;
      R.longestHoldMs = Math.max(R.longestHoldMs, ms);
      R.holds.push({ ...hold, ms, textFirst: hold.texts[0]?.slice(0, 120) ?? "" });
      hold = null;
    }

    // ---- THE CAMPFIRE HAND-OFF ---------------------------------------------
    // B0 holds on the CHECK-IN screen, in front of the character select — so
    // when it lets go the crawler is still standing at the fire and a real
    // player clicks DESCEND. A harness that only pressed WASD here would sit
    // at the campfire for six minutes and then report "the tutorial never
    // released", which is a bug in the instrument, not in the build.
    if (s.checkin || s.castGo || s.menu) {
      const went = await page.evaluate(() => {
        for (const id of ["m-cast-go", "m-solo"]) {
          const b = document.getElementById(id);
          if (b && getComputedStyle(b).display !== "none" && b.getBoundingClientRect().width > 2) { b.click(); return id; }
        }
        return null;
      });
      if (went) { R.campfireClicks = (R.campfireClicks ?? 0) + 1; await page.waitForTimeout(2200); continue; }
    }

    // ---- LIVENESS: while NOT held, the clock must move ----------------------
    if (s.time && s.time !== lastClock) { lastClock = s.time; lastClockChangeAt = Date.now(); }
    else if (s.time && Date.now() - lastClockChangeAt > 25_000 && !s.menu && !s.checkin) {
      // The campfire is not a stall: the collapse clock has not started, which
      // is the whole point of a check-in screen.
      R.clockStalls++; lastClockChangeAt = Date.now();
    }

    await prof.act(page, step++);
  }

  // A hold still open at the buzzer that never let go.
  if (hold) {
    const ms = Date.now() - hold.openedAt;
    R.longestHoldMs = Math.max(R.longestHoldMs, ms);
    R.holds.push({ ...hold, ms, textFirst: hold.texts[0]?.slice(0, 120) ?? "", stillOpen: true });
    if (ms > 60_000) R.unreleasedHold = true;
  }

  await page.screenshot({ path: `${SHOTS}/cold-${prof.name}-99-end.png` });
  const led = await ledger(page);
  R.ledgerObj = led.filter((k) => /^obj\./.test(k));
  R.ledgerHold = led.filter((k) => /^hold\./.test(k));
  R.ledgerOther = led.filter((k) => !/^obj\.|^hold\./.test(k));
  await ctx.close();
  return R;
}

const browser = await chromium.launch();
try {
  const out = [];
  for (const p of PROFILES) out.push(await runProfile(browser, p));

  log("\n================ COLD FIRST-SESSION REPORT ================");
  for (const R of out) {
    log(`\n---- ${R.name} (${R.samples} samples, ${MINUTES}min) ----`);
    log(`holds opened            : ${R.holds.length}`);
    for (const h of R.holds) {
      log(`  - ${Math.round(h.ms / 1000)}s, pages=${h.pages}, clockFrozen=${h.frozen} ${JSON.stringify(h.clockPair ?? [])}, HELD chip=${h.phaseHeld}, esc=${!!h.dismissed}${h.answered ? `, answered="${h.answered}"` : ""}${h.stillOpen ? ", STILL OPEN AT BUZZER" : ""}`);
      log(`      p1: ${h.textFirst}`);
    }
    log(`longest hold            : ${Math.round(R.longestHoldMs / 1000)}s   unreleased=${R.unreleasedHold}`);
    log(`floors seen             : ${[...R.floorsSeen].join(" ")}  max=${R.maxFloor}`);
    log(`campfire DESCEND clicks : ${R.campfireClicks ?? 0}`);
    // ARMING IS NOT COMPLETION, and this project has been burned by conflating
    // them twice. `obj.enrolled` is the enrolment marker written at boot and
    // `tut.*` is a beat SHOWN — neither is a step performed. Only the five
    // OBJECTIVE_STEPS ids are written under an ACT (recordTips([res.completed])).
    const STEPS = ["obj.move", "obj.five", "obj.payday", "obj.saferoom", "obj.show"];
    const done = R.ledgerObj.filter((k) => STEPS.includes(k));
    log(`STEPS COMPLETED (${done.length}/5) : ${JSON.stringify(done)}`);
    log(`  ...beats merely SHOWN  : ${JSON.stringify([...R.ledgerObj.filter((k) => !STEPS.includes(k)), ...R.ledgerOther])}`);
    log(`LEDGER hold.*           : ${JSON.stringify(R.ledgerHold)}`);
    log(`strip cards seen        : ${R.stripTexts.size}`);
    for (const t of [...R.stripTexts].slice(0, 12)) log(`      strip: ${t.slice(0, 110)}`);
    log(`BOTH-AT-ONCE samples    : ${R.bothAtOnce.length}`);
    for (const b of R.bothAtOnce.slice(0, 6)) log(`      hold="${b.hold}" | strip="${b.strip}"`);
    // Duplicate delivery: a strip card whose words are a hold page's words.
    const dupes = [];
    for (const st of R.stripTexts) {
      for (const ht of R.holdTexts) {
        const a = st.toLowerCase().replace(/[^a-z ]/g, "");
        const b = ht.toLowerCase().replace(/[^a-z ]/g, "");
        // BOTH sides must be a real sentence. The first cut compared against
        // mid-typewriter hold texts and "The" is a substring of everything, so
        // it reported a duplicate for every strip card on the glass.
        if (a.length > 25 && b.length > 25 && (b.includes(a) || a.includes(b))) {
          dupes.push([st.slice(0, 70), ht.slice(0, 70)]);
        }
      }
    }
    log(`DUPLICATE lesson (strip==hold page): ${dupes.length}`);
    for (const d of dupes.slice(0, 6)) log(`      "${d[0]}" <=> "${d[1]}"`);
    log(`clock stalls (not held) : ${R.clockStalls}`);
    log(`page errors             : ${R.errs.length}`);
    for (const e of R.errs.slice(0, 5)) log(`      ${e.slice(0, 200)}`);
  }
} finally {
  await browser.close();
}
