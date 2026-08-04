// TUTORIAL r3 fix-round acceptance probe. COLD-PROFILE RULE: every first-run
// claim runs in a FRESH browser context (empty localStorage). RASTER RULE:
// visual claims save a frame and assert the claimed box is non-uniform +
// warm-keyed (the #tutorial card has a history of not painting).
// One Chromium for the whole battery (machine limit).
//
// The round's claims under test:
//  A. MAJOR 1 — once-ever COURTESY cards can no longer burn behind modals:
//     while body.modal holds, the pump displays nothing, the active card's
//     auto-dismiss clock pauses (visible-time only), and the card shows the
//     moment the modal closes. Staged on the REAL collapse card + the bag.
//  B. MAJOR 3a — the collapse card rides "high": it jumps the 9s pacing gap
//     and lands at its moment. 3b — the sim's lowhp lecture waits for the
//     SECOND distinct brush with death (the first carries the flask line).
//  C. MAJOR 2 — the onramp cast confirmation survives to floor 2: draft
//     claimed on floor 1, first cast on floor 2 still teaches the ABILITY.
//     Fold-in c — a cold boot logs zero 404s (inline favicon).
//
// Usage: node tools/_tut_r3.mjs [url-base]   (default http://localhost:5284)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:5284";
const ONLY = process.argv[3] ?? "";
const SHOTS = new URL("./_tut_r3_shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(SHOTS, { recursive: true });

const fails = [];
const notes = [];
function check(name, cond, detail = "") {
  (cond ? notes : fails).push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawB = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = y > 0 && x >= channels ? px[dst - stride + x - channels] : 0;
      let v;
      if (filter === 0) v = rawB;
      else if (filter === 1) v = rawB + a;
      else if (filter === 2) v = rawB + b;
      else if (filter === 3) v = rawB + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}

function boxStats(file, box) {
  const { w, channels, px } = decodePng(readFileSync(file));
  const X0 = Math.max(0, Math.floor(box.x)), Y0 = Math.max(0, Math.floor(box.y));
  const X1 = Math.floor(box.x + box.width), Y1 = Math.floor(box.y + box.height);
  let n = 0, sum = 0, sum2 = 0, warmN = 0;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const o = (y * w + x) * channels;
      const r = px[o], g = px[o + 1] ?? r, b = px[o + 2] ?? r;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l; sum2 += l * l; n++;
      if (r - b > 30 && r > 90) warmN++;
    }
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), warmFrac: warmN / n, n };
}

async function rasterCheck(page, sel, name, minWarm = 0.01) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
  const file = `${SHOTS}${name}.png`;
  await page.screenshot({ path: file });
  if (!box || box.width < 4 || box.height < 4) {
    check(`${name}: ${sel} has a real box`, false, JSON.stringify(box));
    return null;
  }
  const st = boxStats(file, box);
  check(`${name}: ${sel} painted (std ${st.std.toFixed(1)}, warm ${(st.warmFrac * 100).toFixed(1)}%)`,
    st.std > 8 && st.warmFrac > minWarm);
  return { box, st, file };
}

const gotoOpts = { waitUntil: "load", timeout: 90000 };
async function boot(page, url) {
  await page.goto(url, gotoOpts);
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/** Card SHOW log: every .tut node addition, with a frame-clock stamp. */
const cardLogInit = () => {
  window.__tutlog = [];
  const arm = () => {
    const layer = document.getElementById("tutorial");
    if (!layer) { setTimeout(arm, 50); return; }
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList.contains("tut")) {
            window.__tutlog.push({ t: n.textContent ?? "", at: performance.now() });
          }
        }
      }
    }).observe(layer, { childList: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arm);
  else arm();
};
const cardLog = (page) => page.evaluate(() => window.__tutlog ?? []);
const dlgVisible = (page) => page.evaluate(() => {
  const el = document.getElementById("dialogue");
  return !!el && el.style.display === "flex" && el.classList.contains("show");
});
const track404 = (page, sink) => page.on("response", (r) => { if (r.status() === 404) sink.push(r.url()); });

async function coldSoloStart(page) {
  await page.click("#m-solo");
  await page.waitForTimeout(600);
  const b0 = await dlgVisible(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.click("#m-cast-go");
  await page.waitForTimeout(1500);
  const live = await page.evaluate(() => window.__dcc?.state?.status === "playing");
  return { b0, live };
}

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});

try {
  if (!ONLY || ONLY === "A") {
  // ===== CONTEXT A: MAJOR 1 — cards never burn behind a modal ==============
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const A = await ctxA.newPage();
  const errsA = [], m404A = [];
  A.on("pageerror", (e) => errsA.push(e.message));
  track404(A, m404A);
  await A.addInitScript(cardLogInit);
  await boot(A, `${BASE}/iso.html?debug=1&noassets`);
  const sA = await coldSoloStart(A);
  check("A: B0 up, run live", sA.b0 && sA.live);

  // Wait for the FIRST card ('fresh meat detected') to SHOW, then within the
  // input-dismiss grace window: stage the collapse moment (sim tip queues,
  // 'high', behind the ACTIVE card) and open the BAG (body.modal).
  await A.waitForFunction(() => !!document.querySelector("#tutorial .tut"), { timeout: 20000 });
  // Stage + bag INSIDE the card's 1.2s input-dismiss grace, so the 'i' press
  // cannot dismiss the active card (which would let the pump race the modal
  // observer's rAF — a race the paused clock also covers, but the probe
  // stages the clean ordering the organic bug had).
  await A.evaluate(() => { const s = window.__dcc.state; s.timeRemaining = s.timeBudget * 0.25 - 0.5; });
  await A.waitForTimeout(300); // >= a few sim steps: the Safe->Warning edge fires
  const logAtBag = (await cardLog(A)).length;
  await A.keyboard.press("i");
  await A.waitForFunction(() => document.body.classList.contains("modal"), { timeout: 3000 });
  check("A: collapse tip consumed sim-side before the pause",
    await A.evaluate(() => (window.__dcc.state.players[0].tipsSeen ?? []).includes("collapse")));

  // 12s behind the modal. Pre-fix: the start card auto-burned at 7s and the
  // pump displayed the collapse card behind the bag. Post-fix: nothing shows,
  // nothing burns.
  await A.waitForTimeout(12000);
  const logAfterHold = (await cardLog(A)).length;
  check("A1 MAJOR: ZERO card shows while the modal holds", logAfterHold === logAtBag,
    `${logAfterHold - logAtBag} shows during hold`);
  check("A1: the active card survived the hold (auto-clock paused)",
    await A.evaluate(() => !!document.querySelector("#tutorial .tut")));
  check("A1: ...and it is still the START card, unconsumed",
    await A.evaluate(() => /fresh meat/i.test(document.querySelector("#tutorial .tut")?.textContent ?? "")));

  // Close the bag: the start card resumes; dismiss it by hand; the collapse
  // card (queued 'high') must show immediately after — visible, at last.
  const closeAt = await A.evaluate(() => performance.now());
  await A.keyboard.press("Escape");
  await A.waitForFunction(() => !document.body.classList.contains("modal"), { timeout: 3000 });
  await A.waitForTimeout(1500);
  await A.keyboard.press("0"); // any-input dismiss (grace long past)
  await A.waitForFunction(() => (window.__tutlog ?? []).some((e) => /clock has opinions/i.test(e.t)), { timeout: 12000 }).catch(() => {});
  const aAll = await cardLog(A);
  const aCollapse = aAll.find((e) => /clock has opinions/i.test(e.t));
  check("A1: collapse card SHOWS after the modal closes", !!aCollapse);
  if (aCollapse) {
    check(`A1: ...and only after close (+${((aCollapse.at - closeAt) / 1000).toFixed(1)}s)`, aCollapse.at > closeAt);
  }
  await A.waitForTimeout(600);
  await rasterCheck(A, "#tutorial .tut", "a_collapse_after_modal");
  // Give the clock its slack back so the floor doesn't turn mid-battery.
  await A.evaluate(() => { const s = window.__dcc.state; s.timeRemaining = s.timeBudget * 0.9; });
  check("A: zero 404s", m404A.length === 0, m404A.slice(0, 3).join(" | "));
  check("A: zero page errors", errsA.length === 0, errsA.slice(0, 3).join(" | "));
  await ctxA.close();
  }

  if (!ONLY || ONLY === "B") {
  // ===== CONTEXT B: 3a collapse jumps the gap · 3b lowhp second brush ======
  const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const B = await ctxB.newPage();
  const errsB = [], m404B = [];
  B.on("pageerror", (e) => errsB.push(e.message));
  track404(B, m404B);
  await B.addInitScript(cardLogInit);
  await boot(B, `${BASE}/iso.html?debug=1&noassets`);
  const sB = await coldSoloStart(B);
  check("B: B0 up, run live", sB.b0 && sB.live);

  // Let the start card show, dismiss it by hand at +1.5s (inside the 9s
  // politeness window), then stage the collapse moment: the card must show
  // within ~3s of the tip firing (it jumped the gap), not 7.5s later.
  await B.waitForFunction(() => !!document.querySelector("#tutorial .tut"), { timeout: 20000 });
  await B.waitForTimeout(1500);
  await B.keyboard.press("0");
  await B.waitForTimeout(300);
  const stagedAt = await B.evaluate(() => {
    const s = window.__dcc.state;
    s.timeRemaining = s.timeBudget * 0.25 - 0.5;
    return performance.now();
  });
  await B.waitForFunction(() => (window.__tutlog ?? []).some((e) => /clock has opinions/i.test(e.t)), { timeout: 9000 }).catch(() => {});
  const bCollapse = (await cardLog(B)).find((e) => /clock has opinions/i.test(e.t));
  check("B 3a MAJOR: collapse card fired", !!bCollapse);
  if (bCollapse) {
    const lag = (bCollapse.at - stagedAt) / 1000;
    check(`B 3a: it JUMPED the 9s gap (+${lag.toFixed(1)}s from its sim moment < 3.5s)`, lag < 3.5);
  }
  await B.evaluate(() => { const s = window.__dcc.state; s.timeRemaining = s.timeBudget * 0.9; });
  await B.waitForTimeout(1600);
  await B.keyboard.press("0"); // clear the collapse card

  // 3b: FIRST brush with death — set hp under the flask line's 40% AND give a
  // deterministic DoT hit under the sim's 1/3 line: flask lecture fires, the
  // Show's 'EXCELLENT television' does NOT (brush one is armed, not spoken).
  await B.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = Math.floor(p.maxHp * 0.25); // BELOW lowHpFraction (0.30), not at it
    p.statuses = [{ kind: "poison", remaining: 1.2, magnitude: 3, stacks: 1, tick: 0.3, school: "physical" }];
  });
  await B.waitForFunction(() => (window.__dcc.state.players[0].lowHpBrushes ?? 0) >= 1, { timeout: 8000 }).catch(() => {});
  await B.waitForFunction(() => (window.__tutlog ?? []).some((e) => /you are leaking/i.test(e.t)), { timeout: 15000 }).catch(() => {});
  check("B 3b: flask card fired on the first wound", (await cardLog(B)).some((e) => /you are leaking/i.test(e.t)));
  const firstBrush = await B.evaluate(() => ({
    seen: (window.__dcc.state.players[0].tipsSeen ?? []).includes("lowhp"),
    brushes: window.__dcc.state.players[0].lowHpBrushes ?? 0,
  }));
  check("B 3b MAJOR: the sim's lowhp tip did NOT fire on the same wound", !firstBrush.seen,
    `brushes=${firstBrush.brushes}`);
  check("B 3b: brush one is on the books", firstBrush.brushes === 1);

  // Recover over the line, then the SECOND brush: now the Show speaks.
  await B.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = p.maxHp;
    p.statuses = [];
  });
  await B.waitForTimeout(1000);
  await B.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = Math.floor(p.maxHp * 0.25);
    p.statuses = [{ kind: "poison", remaining: 1.2, magnitude: 3, stacks: 1, tick: 0.3, school: "physical" }];
  });
  await B.waitForFunction(() => (window.__dcc.state.players[0].tipsSeen ?? []).includes("lowhp")
    || window.__dcc.state.status !== "playing", { timeout: 8000 }).catch(() => {});
  check("B 3b: the SECOND brush files the explanation",
    await B.evaluate(() => (window.__dcc.state.players[0].tipsSeen ?? []).includes("lowhp")));
  // The card itself is queued behind the 9s courtesy gap (normal priority) —
  // it is the LECTURE that moved, not the pacing. Keep the crawler alive
  // while it waits its turn: a death would open the VERDICT, and (correctly,
  // post-fix) a card must not burn behind that modal either.
  await B.evaluate(() => {
    window.__keep = setInterval(() => {
      const p = window.__dcc?.state?.players?.[0];
      if (p && p.hp > 0 && p.hp < p.maxHp * 0.9) { p.hp = p.maxHp; p.statuses = []; }
    }, 200);
  });
  // The card surface serializes at ~16s per card (7s read + the 9s courtesy
  // gap), and the flask + afflicted cards are ahead of it in the queue — so
  // this wait is generous ON PURPOSE. What is under test is WHICH WOUND the
  // lecture is filed against, not how fast the queue drains.
  // ...and the player READS THEM: dismiss each card as it lands (any input),
  // which is how a real session drains the queue.
  for (let i = 0; i < 40; i++) {
    if (await B.evaluate(() => (window.__tutlog ?? []).some((e) => /EXCELLENT television/i.test(e.t)))) break;
    await B.waitForTimeout(1600);
    if (await B.evaluate(() => !!document.querySelector("#tutorial .tut"))) await B.keyboard.press("0");
  }
  check("B 3b: the crawler survived the staging (no verdict modal in the way)",
    await B.evaluate(() => window.__dcc.state.status === "playing"));
  const bAll = await cardLog(B);
  const bDiag = await B.evaluate(() => ({
    modal: document.body.classList.contains("modal"),
    dlg: document.getElementById("dialogue")?.style.display,
    open: [...document.querySelectorAll('[data-overlay="modal"]')]
      .filter((el) => el.style.display && el.style.display !== "none").map((el) => el.id),
    live: !!document.querySelector("#tutorial .tut"),
    // The announce() text also lands in state.events -> the HUD log: if the
    // line is THERE but never became a card, the host dropped it.
    inLog: /EXCELLENT television/i.test(document.getElementById("hud-log")?.textContent ?? ""),
  }));
  check("B 3b: 'EXCELLENT television' card shows at the second wound, not the first",
    bAll.some((e) => /EXCELLENT television/i.test(e.t)),
    `${bAll.map((e) => e.t.slice(0, 40)).join(" | ")} :: ${JSON.stringify(bDiag)}`);
  await B.evaluate(() => clearInterval(window.__keep));
  await B.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.statuses = []; });
  await B.screenshot({ path: `${SHOTS}b_second_brush.png` });
  check("B: zero 404s", m404B.length === 0, m404B.slice(0, 3).join(" | "));
  check("B: zero page errors", errsB.length === 0, errsB.slice(0, 3).join(" | "));
  await ctxB.close();
  }

  if (!ONLY || ONLY === "C") {
  // ===== CONTEXT C: MAJOR 2 — the cast line survives to floor 2 ===========
  // The critic's organic cold run, replayed: level on floor 1, claim the
  // draft (B3 first), descend WITHOUT casting, cast on floor 2 — the ABILITY
  // confirmation must still arrive, socket named as present tense.
  const ctxC = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const C = await ctxC.newPage();
  const errsC = [], m404C = [];
  C.on("pageerror", (e) => errsC.push(e.message));
  track404(C, m404C);
  await C.addInitScript(cardLogInit);
  await boot(C, `${BASE}/iso.html?debug=1&noassets`);
  const sC = await coldSoloStart(C);
  check("C: B0 up, run live", sC.b0 && sC.live);
  await C.waitForFunction(() => (window.__dcc?.state?.elapsed ?? 0) > 1.5, { timeout: 10000 });

  // Level up: stage the kill, swing at it (LMB = the strike, cast[0] — the
  // 'moved'/'start' lines may fire; the ABILITY line must NOT).
  await C.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.xp = p.xpToNext;
    p.attackPower = 9999;
    const live = s.monsters.filter((x) => x.hp > 0 && x.kind !== "boss");
    live.sort((a, b) => (a.pos.x - p.pos.x) ** 2 + (a.pos.y - p.pos.y) ** 2
      - ((b.pos.x - p.pos.x) ** 2 + (b.pos.y - p.pos.y) ** 2));
    if (live[0]) { live[0].hp = 1; live[0].pos = { x: p.pos.x + 0.5, y: p.pos.y + 0.2 }; }
  });
  await C.mouse.move(760, 450);
  await C.mouse.down();
  await C.waitForTimeout(1200);
  await C.mouse.up();
  await C.waitForFunction(() => window.__dcc.state.players[0].level >= 2, { timeout: 8000 }).catch(() => {});
  check("C: leveled on floor 1 (draft minted)", await C.evaluate(() => window.__dcc.state.players[0].level >= 2));

  // Redeem the draft: B3 (Mordecai) frames it, ESC lands in the draft UI,
  // number 1 claims — the organic first-draft path.
  await C.keyboard.press("v");
  await C.waitForTimeout(1200);
  const b3 = await dlgVisible(C);
  check("C: B3 Mordecai beat before the draft (regression guard)", b3);
  if (b3) {
    check("C: it is Mordecai", await C.evaluate(() => document.getElementById("dlg-name")?.textContent === "Mordecai"));
    await C.keyboard.press("Escape");
    await C.waitForTimeout(600);
  }
  await C.waitForFunction(() => document.getElementById("draft")?.style.display === "flex", { timeout: 6000 }).catch(() => {});
  check("C: draft UI open", await C.evaluate(() => document.getElementById("draft")?.style.display === "flex"));
  await C.keyboard.press("1");
  await C.waitForTimeout(800);
  check("C: draft claimed", await C.evaluate(() =>
    document.getElementById("draft")?.style.display !== "flex"
    && window.__dcc.state.players[0].pendingUpgrades.length === 0));
  check("C: NO ability line on floor 1 (we never cast)", !(await cardLog(C)).some((e) => /that was an ABILITY/i.test(e.t)));

  // Descend without casting, then cast on floor 2.
  await C.evaluate(() => {
    const s = window.__dcc.state;
    s.players[0].pos = { x: s.map.stairs.x, y: s.map.stairs.y };
  });
  await C.waitForTimeout(400);
  await C.keyboard.press("e");
  // Descent routes through the SAFE ROOM (sim pauses until DESCEND). The
  // first safe room may open with B5 (Mordecai) framing it — close the beat,
  // let the shop open, then take the stairs.
  await C.waitForFunction(() => !!window.__dcc.state.safeRoom, { timeout: 8000 }).catch(() => {});
  check("C: safe room reached (descent gate)", await C.evaluate(() => !!window.__dcc.state.safeRoom));
  await C.waitForTimeout(1600);
  if (await dlgVisible(C)) {
    notes.push("C: B5 safe-room beat framed the first safe room");
    await C.keyboard.press("Escape");
    await C.waitForTimeout(900);
  }
  await C.waitForFunction(() => document.getElementById("saferoom")?.style.display === "flex", { timeout: 8000 }).catch(() => {});
  await C.click("#sr-descend");
  await C.waitForFunction(() => window.__dcc.state.floor === 2, { timeout: 10000 }).catch(() => {});
  check("C: on floor 2", await C.evaluate(() => window.__dcc.state.floor === 2));
  await C.waitForTimeout(2000);
  // HOLD the key: a tap can fall between sim samples (CLAUDE.md's headless
  // recipe). Slot 3 = Q = the bolt, a real ability the level-1 kit owns.
  for (let i = 0; i < 4; i++) {
    await C.keyboard.down("q");
    await C.waitForTimeout(500);
    await C.keyboard.up("q");
    await C.waitForTimeout(300);
  }
  notes.push(`C: floor-2 state at cast — ${JSON.stringify(await C.evaluate(() => ({
    slots: window.__dcc.state.players[0].abilities.slots,
    elapsed: Math.round(window.__dcc.state.elapsed), floor: window.__dcc.state.floor,
  })))}`);
  // Drain the card queue like a player (each card is one input away).
  for (let i = 0; i < 25; i++) {
    if (await C.evaluate(() => (window.__tutlog ?? []).some((e) => /that was an ABILITY/i.test(e.t)))) break;
    await C.waitForTimeout(1600);
    if (await C.evaluate(() => !!document.querySelector("#tutorial .tut"))) await C.keyboard.press("0");
  }
  const cCast = (await cardLog(C)).find((e) => /that was an ABILITY/i.test(e.t));
  check("C2 MAJOR: the cast confirmation fired on floor 2", !!cCast);
  if (cCast) {
    check("C2: the socket is named as PRESENT ('This floor's GLYPH SOCKET')",
      /This floor's GLYPH SOCKET/.test(cCast.t), cCast.t.slice(0, 140));
  }
  if (await C.evaluate(() => !!document.querySelector("#tutorial .tut"))) {
    await C.waitForTimeout(400);
    await rasterCheck(C, "#tutorial .tut", "c_cast_floor2");
  } else {
    await C.screenshot({ path: `${SHOTS}c_cast_floor2.png` });
  }
  check("C fold-in c: zero 404s on a cold organic session", m404C.length === 0, m404C.slice(0, 3).join(" | "));
  check("C: zero page errors", errsC.length === 0, errsC.slice(0, 3).join(" | "));
  await ctxC.close();
  }
} finally {
  await browser.close();
}

writeFileSync(`${SHOTS}_report.txt`, [...notes, ...fails].join("\n"));
console.log(`\n${notes.length} pass, ${fails.length} fail. Shots in tools/_tut_r3_shots/`);
if (fails.length > 0) process.exit(1);
