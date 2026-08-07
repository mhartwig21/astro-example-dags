// THE CURRICULUM, RE-AUTHORED FOR THE PAUSE (TUTORIAL.md r15) — acceptance.
//
// r14 stopped the game. This round rewrote what is said while it is stopped,
// and the claims are all claims about a PAGE THE PLAYER READS — so they are
// measured as rects and as substituted text on a real frame, never asserted
// from the beat tables (which the unit tests already hold).
//
// THE FALSIFYING SENTENCES, written before the probe (HANDOFF §0):
//   A. "it told me to press {dash}"  — a token reached the glass unsubstituted,
//      which is the one failure a curriculum that names keys can invent.
//   B. "it pointed at nothing"       — the page names a thing and rings nothing,
//      so the pause bought a paragraph instead of an instruction.
// Probes 3 and 5 must fail on those two.
//
// Cold profile, ONE headless browser, port 5292, shipping server on dist:
//   STATIC_DIR=dist PORT=5292 npx tsx src/server/gameServer.ts
import { chromium } from "playwright";

const PORT = process.env.DCC_PORT ?? "5292";
const URL = `http://localhost:${PORT}/iso.html?debug=1`;
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) fails.push(msg); };
const info = (msg) => console.log(`INFO ${msg}`);

const holdState = (page) => page.evaluate(() => window.__dcc?.holdState?.() ?? null);
const pageText = (page) => page.evaluate(() => document.getElementById("dlg-text")?.textContent ?? "");
const caps = (page) => page.evaluate(() => [...document.querySelectorAll("#dlg-text kbd.dlg-key")]
  .map((k) => { const r = k.getBoundingClientRect(); return { t: k.textContent, w: Math.round(r.width), h: Math.round(r.height) }; }));
/**
 * THE POINTER, ASKED THE HONEST QUESTION. `opacity: 1` is not visibility: the
 * panel is z 29 with its own scrim and two 9%-tall letterbox bars, so before
 * r15 a page pointing at the hotbar lit an element the BOTTOM BAR was sitting
 * on and rang it with a ring that was under the bar too — and every one of
 * those reads came back 1.00. `elementFromPoint` is the read that cannot lie
 * about which surface is on top.
 */
const ring = (page) => page.evaluate(() => {
  const el = document.getElementById("holdring");
  if (!el || getComputedStyle(el).display === "none") return null;
  const b = el.querySelector("i.hr-box").getBoundingClientRect();
  const lit = document.querySelector(".holdlit");
  if (!lit) return null;
  const r = lit.getBoundingClientRect();
  // THE TEACHING HUD IS `pointer-events: none` BY DESIGN, so a naive hit test
  // can never return it and would report the scrim as "on top" of a spotlight
  // that is plainly above it (it did, on the frame that proved the fix worked).
  // Hit-testability is not paint order: lend the element a pointer for one
  // synchronous read and give it back.
  const prev = lit.style.pointerEvents;
  lit.style.pointerEvents = "auto";
  const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  lit.style.pointerEvents = prev;
  return { w: Math.round(b.width), h: Math.round(b.height), lit: lit.id,
    litOpacity: Number(getComputedStyle(lit).opacity),
    // What is ACTUALLY on top of the middle of the thing we are pointing at.
    onTop: hit ? (lit.contains(hit) || hit === lit ? "the lit element" : `#${hit.id || hit.className || hit.tagName}`) : "nothing",
    ringZ: Number(getComputedStyle(el).zIndex), panelZ: Number(getComputedStyle(document.getElementById("dialogue")).zIndex) };
});
/**
 * Step the page forward the way a player does — and the shipped double duty is
 * why this is a loop rather than one press: the FIRST press finishes the
 * typewriter, the next turns the page. A probe that assumed one press per page
 * would read page N's prose and call it page N+1's.
 */
/**
 * FINISH THE PAGE THE WAY A PLAYER DOES. Do NOT wait the typewriter out here:
 * `setInterval(16ms)` is dilated to roughly 3fps under this harness's software
 * GL, so a 215-character page takes ~30 REAL seconds to type and a probe that
 * slept on it would read half a sentence and call it the beat (it did — the
 * first run of this file failed "page 2 is the dash" on the word "das").
 * The panel's shipped double duty is the honest instrument: the first press
 * finishes the text, so press until it has.
 */
const finishType = async (page) => {
  for (let i = 0; i < 8; i++) {
    if (!(await page.evaluate(() => document.getElementById("dlg-text")?.classList.contains("typing")))) return;
    await page.keyboard.press("Space");
    await page.waitForTimeout(450);
  }
};
/** ...and THEN one more press turns the page (the other half of the duty). */
const advance = async (page) => {
  const before = (await holdState(page))?.page ?? -1;
  for (let i = 0; i < 10; i++) {
    await finishType(page);
    await page.waitForTimeout(500);
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    const st = await holdState(page);
    if (!st || st.page !== before) return;
  }
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  const cold = await page.evaluate(() => localStorage.getItem("dcc:history:v1"));
  ok(!cold, `profile is cold (history=${cold})`);

  // ---- 1. B0 PAGES, AND ITS MIDDLE PAGE IS THE FEATURE'S OWN ONBOARDING ---
  await page.evaluate(() => document.getElementById("m-solo")?.click());
  await page.waitForTimeout(1600);
  let st = await holdState(page);
  ok(st?.pages === 3, `the campfire pages the delivery contract in (pages=${st?.pages})`);
  const b0 = [];
  for (let i = 0; i < 3; i++) {
    await finishType(page); // the page is READ whole, not mid-sentence
    b0.push(await pageText(page));
    if (i < 2) await advance(page);
  }
  const b0all = b0.join(" ");
  ok(/stop the clock/i.test(b0all) && /Space/.test(b0all) && /Esc/.test(b0all),
    `B0 says the game will stop and names both controls: ${JSON.stringify(b0[1].slice(0, 96))}`);

  // The last page hands over to B0's shipped choices (the skip lives there).
  const choices = await page.evaluate(() => [...document.querySelectorAll("#dlg-choices .dlg-choice .dlabel")].map((e) => e.textContent));
  ok(choices.length >= 2, `the last page carries the beat's own choices (${JSON.stringify(choices)})`);
  await page.keyboard.press("2"); // "Let's go."
  await page.waitForTimeout(900);
  // ...and the casting stage's own control starts the run. B0 rides that
  // screen; it does not launch it.
  await page.evaluate(() => document.getElementById("m-cast-go")?.click());
  await page.waitForTimeout(3500);

  // ---- 2. THE FIRST HOLD OF THE RUN OPENS AT SECOND ZERO ------------------
  st = await holdState(page);
  ok(st?.key === "hold.obj.move", `the run opens on obj.move's hold (key=${st?.key})`);
  ok(st?.pages === 3, `it is three pages: instruction, the dash, the checklist (pages=${st?.pages})`);

  // ---- 3. THE PAGE NAMES THE PLAYER'S OWN KEYS, AS CAPS -------------------
  // Falsifying sentence A. A token that reaches the glass unsubstituted is the
  // one failure a curriculum that names keys can invent.
  await finishType(page);
  const p1 = await pageText(page);
  const p1caps = await caps(page);
  const p1capsTyped = p1caps;
  ok(!/[{}]/.test(p1), `page 1 carries no unsubstituted token: ${JSON.stringify(p1)}`);
  ok(p1capsTyped.length >= 2 && p1capsTyped.every((c) => c.w > 4 && c.h > 4),
    `its controls are KEY CAPS with real rects: ${JSON.stringify(p1capsTyped)}`);
  info(`caps mid-typewriter: ${JSON.stringify(p1caps)}`);

  // ---- 4. THE DASH GETS ITS OWN PAGE, IN THE FIRST HOLD -------------------
  // r13 measured a cold profile 258 seconds into a session without pressing it.
  await advance(page);
  await finishType(page);
  const p2 = await pageText(page);
  const p2caps = await caps(page);
  ok(/dash/i.test(p2) && !/[{}]/.test(p2), `page 2 is the dash, with its live key: ${JSON.stringify(p2)}`);
  ok(p2caps.length === 1, `and exactly one cap on it: ${JSON.stringify(p2caps)}`);

  // ---- 5. IT POINTS AT THE THING IT NAMES, UN-DIMMED ----------------------
  // Falsifying sentence B, and the spotlight exemption is a pixel check: the
  // blanket modal dim takes the cockpit to 35%, and body.hold must beat it.
  const r2 = await ring(page);
  ok(r2 && r2.lit === "cockpit" && r2.w > 40,
    `the dash page rings the hotbar it sits on (${JSON.stringify(r2)})`);
  await page.screenshot({ path: "tools/_tut_r15_shots/dash-page.png" });
  ok(r2 && r2.litOpacity > 0.95 && r2.onTop === "the lit element",
    `...and NOTHING is painted over it — not the scrim, not the letterbox bar (onTop=${r2?.onTop})`);
  ok(r2 && r2.ringZ > r2.panelZ, `the ring outranks the panel that cast it (ring=${r2?.ringZ} panel=${r2?.panelZ})`);

  // ---- 6. THE LAST PAGE HANDS OFF TO THE CHECKLIST ------------------------
  await advance(page);
  await finishType(page);
  const r3 = await ring(page);
  const objCard = await page.evaluate(() => {
    const el = document.getElementById("objectives");
    if (!el || getComputedStyle(el).display === "none") return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), opacity: Number(getComputedStyle(el).opacity), text: el.textContent.replace(/\s+/g, " ").trim() };
  });
  ok(r3 && r3.lit === "objectives", `the last page points at the checklist (${JSON.stringify(r3)})`);
  ok(objCard && objCard.opacity > 0.95 && r3?.onTop === "the lit element",
    `the checklist is legible under body.hold — measured as WHAT IS ON TOP OF IT, not as opacity (onTop=${r3?.onTop}, opacity=${objCard?.opacity})`);
  info(`the checklist the hold handed off to: ${JSON.stringify(objCard?.text)}`);
  await page.screenshot({ path: "tools/_tut_r15_shots/handoff-page.png" });

  // ---- 7. THE CARD TRACKS WHAT THE PAGE ASKED FOR -------------------------
  const asked = await pageText(page);
  ok(/list/i.test(asked), `the hand-off page says so in words too: ${JSON.stringify(asked)}`);
  await advance(page); // BACK TO IT
  await page.waitForTimeout(1400);
  ok(!(await page.evaluate(() => document.body.classList.contains("hold"))), "the world resumed on the last press");

  // ---- 8. AND THE STRIP DOES NOT REPEAT WHAT THE PAUSE JUST SAID ----------
  // The floor-1 script (walk / swing / dash) IS obj.move's pages. Play a while
  // and read every teaching card that paints.
  const seen = new Set();
  for (let i = 0; i < 26; i++) {
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(500);
    await page.keyboard.up("KeyD");
    const card = await page.evaluate(() => document.querySelector("#tutorial .tut-body")?.textContent ?? "");
    if (card) seen.add(card.replace(/\s+/g, " ").trim());
  }
  const dup = [...seen].filter((t) => /Walk with|keep swinging|to dash clear/i.test(t));
  ok(dup.length === 0, `the strip never re-teaches a lesson the pause delivered (${JSON.stringify(dup)})`);
  info(`strip cards seen in ${13}s of play: ${JSON.stringify([...seen])}`);

  // ---- 9. THE SLOT THAT MOVED: B5 IS THE SAFE ROOM'S PAUSED TEACHING -----
  // `obj.saferoom`'s introduction cannot pause — it arms at a counter, and a
  // counter is a modal the lull gate refuses — so the shelf lesson's paused
  // moment is B5, in the gap between the safe room stopping the world and the
  // shop panel opening. The descent is STAGED (the debug hook's whole purpose):
  // a ~3fps software-GL harness cannot walk a floor. The teleport moves the
  // crawler, not the rules.
  await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.pos.x = s.map.stairs.x + 0.05;
    p.pos.y = s.map.stairs.y + 0.05;
  });
  await page.waitForTimeout(700);
  await page.keyboard.press("KeyE"); // the stairs bind (bindings.ts: stairs = e)
  await page.waitForTimeout(900);
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(2500);

  const inRoom = await page.evaluate(() => !!window.__dcc.state.safeRoom);
  ok(inRoom, "the crawler is in a safe room");

  // ---- B5 HOLDS, AND IT PAGES --------------------------------------------
  st = await holdState(page);
  ok(st?.key === "hold.tut.saferoom", `B5 took a hold slot (key=${st?.key})`);
  ok(st?.pages === 3, `and it PAGES rather than dumping the shelf lesson at once (pages=${st?.pages})`);
  ok(await page.evaluate(() => document.body.classList.contains("hold")), "body.hold is on the glass");
  // The world is stopped: the safe room already does that, and the panel must
  // not be sitting over a live floor either way.
  const shopOpen = () => page.evaluate(() => getComputedStyle(document.getElementById("saferoom")).display === "flex");
  ok(!(await shopOpen()), "the shop panel has NOT opened yet — the beat gets the gap it was written for");

  const srPages = [];
  for (let i = 0; i < 3; i++) {
    await finishType(page);
    srPages.push(await pageText(page));
    if (i < 2) await advance(page);
  }
  info(`B5 pages: ${JSON.stringify(srPages.map((t) => t.slice(0, 64)))}`);
  ok(/read it anyway/i.test(srPages.join(" ")),
    "the third page is the one the shelf never had: what to do when you cannot afford it");
  const srChoices = await page.evaluate(() => [...document.querySelectorAll("#dlg-choices .dlg-choice .dlabel")].map((e) => e.textContent));
  ok(srChoices.length >= 2, `the last page hands over to the beat's own choices (${JSON.stringify(srChoices)})`);

  // ---- ...AND IT HANDS THE PLAYER TO THE SHELF ---------------------------
  await page.keyboard.press("1"); // "Open the shop."
  await page.waitForTimeout(2000);
  ok(await shopOpen(), "taking the first choice opens the shelf it was talking about");
  const lesson = await page.evaluate(() => document.querySelector("#saferoom .sr-lesson, #saferoom .shop-lesson, #sr-lesson")?.textContent
    ?? [...document.querySelectorAll("#saferoom *")].map((e) => e.textContent).find((t) => /gold/i.test(t ?? "")) ?? "");
  info(`the shelf's own Mordecai row: ${JSON.stringify((lesson ?? "").slice(0, 160))}`);
  const holds = (await holdState(page)).opened;
  ok(holds <= 6, `holds opened this session: ${holds} of 6`);

  const fin = await holdState(page);
  info(`holds opened across the whole session: ${fin.opened} of 6 · pending=${JSON.stringify(fin.pending)}`);
  ok(fin.opened <= 6, `the six-hold cap held (${fin.opened})`);
  ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);
  await page.screenshot({ path: "tools/_tut_r15_shots/saferoom-shelf.png" });
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED:\n - ${fails.join("\n - ")}` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
