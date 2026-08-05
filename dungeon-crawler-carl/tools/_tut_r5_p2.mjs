// TUTORIAL r5 — PHASE 2: BLOCKER 1 IN THE ONRAMP CHANNEL.
// The r4 critic proved: low-HP prompt painted, player pressed the flask inside
// the pacing gap, the confirmation queued and never painted, the run ended, R
// was pressed — and BOTH halves of the flask lesson were gone for the session,
// silently, because Onramp.note() marked the event fired at GENERATION and
// these lines carry no tipId for the ledger rule to catch.
//
// r5's claim: a dropped line is UNSPENT. Run 2's flask press must teach it.
import { chromium } from "playwright";
import {
  SHOTS, check, log, dump, boot, spyInit, cards, snap, dlgVisible,
  assertCold, track404,
} from "./_tut_r5_lib.mjs";

const BASE = process.argv[2] ?? "http://localhost:5284";
const txt = (c) => (c.t ?? "").replace(/\s+/g, " ");

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

/** Walk at the nearest monster and FIGHT it — the crawler has to take damage
 *  for the flask lesson to have a moment at all. */
async function chase(ms, { fight = true } = {}) {
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
      await P.mouse.move(
        Math.max(20, Math.min(1340, 683 + (d.dx - d.dy) * 34)),
        Math.max(20, Math.min(740, 384 + (d.dx + d.dy) * 17)),
      );
    }
    if (!keys.length) keys.push("d");
    for (const k of keys) await P.keyboard.down(k);
    const swing = fight && d && d.d <= 6;
    if (swing) await P.mouse.down();
    await P.waitForTimeout(420);
    if (swing) await P.mouse.up().catch(() => {});
    for (const k of keys) await P.keyboard.up(k);
    await P.waitForTimeout(50);
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

const cardUp = () => P.evaluate(() => !!document.querySelector("#tutorial .tut"));

try {
  await boot(P, `${BASE}/iso.html?debug=1&noassets`);
  await assertCold(P, "R5P2");
  await startRun();

  // ---- RUN 1: take the low-HP prompt, press the flask behind it, then die --
  // A real fight first; then the probe opens a WOUND (the crawler is put at
  // 45% — the state the lesson exists for) rather than waiting on the RNG to
  // produce one. Everything downstream is the shipped code's own decision.
  await chase(15000);
  await P.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = Math.max(1, Math.round(p.maxHp * 0.45));
  });
  let low = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const s = await chase(900, { fight: false });
    if (s.status !== "playing") break;
    const cs = await cards(P);
    if (cs.some((c) => /drinks the flask|FLASK chip/i.test(c.t))) { low = s; break; }
  }
  const cs1 = await cards(P);
  log(`RUN1 cards so far: ${cs1.map((c) => txt(c).slice(0, 48)).join(" | ")}`);
  check("R5P2: the low-HP prompt reached the glass in run 1",
    cs1.some((c) => /drinks the flask|FLASK chip/i.test(c.t)),
    JSON.stringify(low));
  const lowCard = cs1.find((c) => /drinks the flask|FLASK chip/i.test(c.t));
  if (lowCard) {
    log(`LOWHP card painted at hp=${lowCard.ctx.hp}% flask=${lowCard.ctx.flask}`);
    check("R5P2 M6: the flask lesson arrives with room to use it (hp > 40%)",
      lowCard.ctx.hp > 40, `hp=${lowCard.ctx.hp}%`);
  }

  // ---- THE DROP, driven by an ordinary player sequence -------------------
  // Press the flask, then open the BAG to look at the loot — a thing players do
  // constantly. body.modal blocks the card surface (the r3 rule), the
  // confirmation waits, and its 12s moment expires behind the panel. r4 would
  // have marked `drink` fired at the press and destroyed the lesson here.
  const upBefore = await cardUp();
  const before = await snap(P);
  await P.keyboard.press("x");
  await P.waitForTimeout(120);
  await P.keyboard.press("i"); // the bag: the surface is now blocked
  await P.waitForTimeout(500);
  const after = await snap(P);
  const blocked = await P.evaluate(() => document.body.classList.contains("modal"));
  log(`FLASK press: card-up=${upBefore} charges ${before.flask} -> ${after.flask}; bag open (modal)=${blocked}`);
  check("R5P2: the flask was actually drunk in run 1", after.flask < before.flask,
    `${before.flask} -> ${after.flask}`);
  check("R5P2: the bag really blocks the card surface", blocked);
  const queuedWhileBlocked = await P.evaluate(() => window.__dcc.tut().queue);
  log(`QUEUE while blocked: ${JSON.stringify(queuedWhileBlocked)}`);
  check("R5P2: the confirmation is QUEUED, unpainted, behind the panel",
    queuedWhileBlocked.some((q) => /flask consumed/i.test(q.text)),
    JSON.stringify(queuedWhileBlocked));
  await P.screenshot({ path: `${SHOTS}r5_p2_bag_blocks.png` });

  // Sit in the bag past the confirmation's moment (12s), then close it.
  await P.waitForTimeout(15000);
  await P.keyboard.press("Escape");
  await P.waitForTimeout(2500);
  const afterBag = await P.evaluate(() => window.__dcc.tut());
  log(`AFTER BAG: ${JSON.stringify(afterBag)}`);
  const drinkPainted1 = (await cards(P)).some((c) => /flask consumed/i.test(c.t));
  check("R5P2 M4: a card whose moment expired behind a panel is DROPPED, not delivered late",
    !drinkPainted1 && !afterBag.queue.some((q) => /flask consumed/i.test(q.text)),
    `painted=${drinkPainted1} queue=${JSON.stringify(afterBag.queue)}`);

  // ...and DROPPED means UNSPENT: the next press teaches it.
  await P.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = Math.max(1, Math.round(p.maxHp * 0.5));
  });
  await P.waitForTimeout(400);
  const b2 = await snap(P);
  await P.keyboard.press("x");
  await P.waitForTimeout(6000);
  const a2 = await snap(P);
  const drinkCard = (await cards(P)).find((c) => /flask consumed/i.test(c.t));
  log(`SECOND PRESS: flask ${b2.flask} -> ${a2.flask}; drink card = ${drinkCard ? txt(drinkCard).slice(0, 90) : "NONE"}`);
  await P.screenshot({ path: `${SHOTS}r5_p2_drink_reteach.png` });
  check("R5P2 BLOCKER 1: the dropped line was UNSPENT — the next press teaches it",
    !!drinkCard && a2.flask < b2.flask,
    `flask ${b2.flask}->${a2.flask} card=${drinkCard ? "yes" : "no"}`);

  // ---- THE RUN BOUNDARY: what is still queued is handed back --------------
  const linesBefore = (await P.evaluate(() => window.__dcc.tut())).onrampLines;
  const dEnd = Date.now() + 90000;
  while (Date.now() < dEnd) {
    const s = await snap(P);
    if (s.status !== "playing") break;
    await P.evaluate(() => { window.__dcc.state.players[0].hp = 1; });
    if (s.near > 1.4) await chase(600);
    else await P.waitForTimeout(500); // stand still and let the sim land it
  }
  const dead = await snap(P);
  log(`RUN 1 ENDS (status=${dead.status}) @ ${JSON.stringify(dead)}`);
  await P.keyboard.press("r");
  await P.waitForFunction(() => window.__dcc?.state?.status === "playing", { timeout: 30000 });
  await P.waitForTimeout(1500);
  const n1 = (await cards(P)).length;
  const afterR = await P.evaluate(() => window.__dcc.tut());
  log(`AFTER R: ${JSON.stringify(afterR)} (lines before death = ${linesBefore})`);
  check("R5P2 BLOCKER 2 (r4, kept): the run boundary empties the queue",
    afterR.queue.length === 0, JSON.stringify(afterR.queue));

  // ---- RUN 2: nothing leaks in -------------------------------------------
  await chase(8000);
  const leaked = (await cards(P)).slice(n1);
  log(`RUN2 cards: ${leaked.map((c) => txt(c).slice(0, 60)).join(" | ") || "(none)"}`);
  check("R5P2 BLOCKER 2: no run-1 card painted over run 2's context",
    !leaked.some((c) => /flask consumed|You are leaking|FAVORITES/i.test(c.t)),
    leaked.map((c) => txt(c).slice(0, 40)).join(" | "));

  for (const c of await cards(P)) {
    log(`CARD hp=${c.ctx.hp}% f=${c.ctx.floor} e=${c.ctx.elapsed}s :: ${txt(c).slice(0, 130)}`);
  }
  log(`errors ${JSON.stringify(errs)} | 404s ${JSON.stringify(m404)}`);
  check("R5P2: zero page errors", errs.length === 0, errs.join(" | "));
} finally {
  dump("_r5_p2.txt");
  await browser.close();
}
