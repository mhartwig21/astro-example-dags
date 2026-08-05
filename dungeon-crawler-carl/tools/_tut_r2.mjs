// TUTORIAL r2 fix-round acceptance probe. COLD-PROFILE RULE: every first-run
// claim runs in a FRESH browser context (empty localStorage). RASTER RULE:
// visual claims save a frame and assert the claimed box is non-uniform +
// warm-keyed (the #tutorial card has a history of not painting).
// One Chromium for the whole battery (machine limit).
//
// The round's claims under test:
//  1. BLOCKER — the onramp names the LIVE Five ("Left click or Space",
//     "Shift, Q, C", "F is the ultimate"), never the unbound digits.
//  2. MAJOR — "Skip the hand-holding" silences the sim's COURTESY cards too
//     (draftBanked + collapse fire nothing after the skip).
//  3. MAJOR — card pacing: >=~9s between COURTESY card SHOWS; the lowhp
//     flask line is the one card allowed to jump the gap.
//  4. MAJOR — the pickup card names the BAG bind ("BAG (I)").
//  5. MAJOR — the onramp runs under net (rush/join): a cold browser in a
//     server world still gets the System's lines.
//  6. MINORS — B8 skips wins without consuming; first death shows the
//     reworded (collapse-safe) line. draftBanked names the DRAFT badge, no
//     "cockpit", no Mordecai idiom.
//
// Usage: node tools/_tut_r2.mjs [url-base]   (default http://localhost:5284)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:5284";
const ONLY = process.argv[3] ?? ""; // "A" | "B" | "C" to run one context
const API = BASE.replace(/:\d+$/, ":5281");
const SHOTS = new URL("./_tut_r2_shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});

try {
  if (!ONLY || ONLY === "A") {
  // ========== CONTEXT A: cold organic first session (labels + pacing) ======
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const A = await ctxA.newPage();
  const errsA = [];
  A.on("pageerror", (e) => errsA.push(e.message));
  await A.addInitScript(cardLogInit);
  await boot(A, `${BASE}/iso.html?debug=1&noassets`);
  await A.click("#m-solo");
  await A.waitForTimeout(600);
  check("A: B0 campfire up (r1 regression)", await dlgVisible(A));
  await A.keyboard.press("Escape");
  await A.waitForTimeout(300);
  await A.click("#m-cast-go");
  await A.waitForTimeout(1500);
  check("A: run live", await A.evaluate(() => window.__dcc?.state?.status === "playing"));

  // Walk: 'start' then 'moved' — the moved line is the Five blocker's fix.
  for (let i = 0; i < 6; i++) {
    await A.keyboard.down("w");
    await A.waitForTimeout(300);
    await A.keyboard.up("w");
    await A.waitForTimeout(200);
  }
  await A.waitForFunction(() => (window.__tutlog ?? []).some((e) => /locomotion confirmed/i.test(e.t)), { timeout: 25000 }).catch(() => {});
  const logMoved = (await cardLog(A)).find((e) => /locomotion confirmed/i.test(e.t));
  check("A1 BLOCKER: 'moved' card fired", !!logMoved);
  if (logMoved) {
    check("A1: names the live strike (Left click or Space)", /Left click or Space/.test(logMoved.t), logMoved.t.slice(0, 120));
    check("A1: names the live slots (Shift, Q, C)", /Shift, Q, C/.test(logMoved.t));
    check("A1: names the ultimate (F is the ultimate)", /F is the ultimate/.test(logMoved.t));
    check("A1: never the unbound digits", !/1–4|1-4/.test(logMoved.t));
  }
  // Photograph whatever card is up right now (the surface paints).
  await A.waitForFunction(() => !!document.querySelector("#tutorial .tut"), { timeout: 12000 }).catch(() => {});
  if (await A.evaluate(() => !!document.querySelector("#tutorial .tut"))) {
    await A.waitForTimeout(500);
    await rasterCheck(A, "#tutorial .tut", "a_card");
  }

  // Cast an ability (slot 3 = Q) + a pickup (gold delta) + the collapse tip:
  // three more cards into the queue — the pacing claim needs a crowd. The
  // waits below span minutes of sim time, so a keep-alive heal guards the
  // player (staying above the 40% lowhp threshold, which must stay unfired
  // until the deliberate drop below).
  await A.keyboard.press("q");
  await A.evaluate(() => {
    window.__heal = setInterval(() => {
      const p = window.__dcc?.state?.players?.[0];
      if (p && p.hp > 0 && p.hp < p.maxHp * 0.65) p.hp = p.maxHp;
    }, 800);
  });
  await A.evaluate(() => { window.__dcc.state.players[0].gold += 25; });
  await A.evaluate(() => {
    const s = window.__dcc.state;
    s.timeRemaining = s.timeBudget * 0.25 - 0.5;
  });
  // Wait for the pickup card (queued behind the gap — allow generously).
  await A.waitForFunction(() => (window.__tutlog ?? []).some((e) => /loot is a raise/i.test(e.t)), { timeout: 45000 }).catch(() => {});
  const logPickup = (await cardLog(A)).find((e) => /loot is a raise/i.test(e.t));
  check("A4 MAJOR: pickup card fired", !!logPickup);
  if (logPickup) check("A4: names the BAG bind — BAG (I)", /BAG \(I\)/.test(logPickup.t), logPickup.t.slice(0, 140));
  await A.waitForFunction(() => (window.__tutlog ?? []).some((e) => /clock has opinions/i.test(e.t)), { timeout: 70000 }).catch(() => {});
  check("A: collapse card still fires on the un-skipped path", (await cardLog(A)).some((e) => /clock has opinions/i.test(e.t)));
  // The collapse tip's moment has been photographed; give the clock back its
  // slack so the floor doesn't actually turn lethal mid-battery.
  await A.evaluate(() => { const s = window.__dcc.state; s.timeRemaining = s.timeBudget * 0.9; });

  // A3: pacing — every consecutive SHOW gap >= 8.4s (the lowhp jump comes later).
  const shows = await cardLog(A);
  const gaps = shows.slice(1).map((e, i) => (e.at - shows[i].at) / 1000);
  check(`A3 MAJOR: ${shows.length} cards, min gap ${Math.min(...gaps).toFixed(1)}s >= 8.4s`,
    shows.length >= 4 && gaps.every((g) => g >= 8.4),
    gaps.map((g) => g.toFixed(1)).join(", "));

  // A-lowhp: the flask line may jump the gap. Drop hp while the gap would
  // otherwise hold the queue; the line must show < 8.4s after the previous
  // show (i.e. it did NOT wait out the politeness window).
  const before = (await cardLog(A)).length;
  await A.evaluate(() => {
    clearInterval(window.__heal); // the deliberate drop must stick
    const p = window.__dcc.state.players[0];
    p.hp = Math.floor(p.maxHp * 0.3);
  });
  await A.waitForFunction((n) => (window.__tutlog ?? []).length > n
    && (window.__tutlog ?? []).some((e) => /you are leaking/i.test(e.t)), before, { timeout: 20000 }).catch(() => {});
  const all = await cardLog(A);
  const low = all.find((e) => /you are leaking/i.test(e.t));
  check("A: lowhp flask card fired", !!low);
  if (low) {
    const prev = all.filter((e) => e.at < low.at).pop();
    const gap = prev ? (low.at - prev.at) / 1000 : 99;
    check(`A: lowhp jumped the pacing gap (${gap.toFixed(1)}s since previous show)`, gap < 8.4);
  }

  // A6 MINOR: a WIN shows no B8 plate and does not consume the beat...
  // (heal first — the plate test needs the WIN edge, not an organic death)
  await A.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = p.maxHp;
    window.__dcc.state.status = "won";
  });
  await A.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", { timeout: 10000 });
  await A.waitForTimeout(1200);
  check("A6: WIN verdict has NO Mordecai plate", await A.evaluate(() =>
    document.getElementById("recap-guide")?.style.display === "none"));
  check("A6: the win did NOT consume tut.runback", await A.evaluate(() =>
    !JSON.parse(localStorage.getItem("dcc:tips:v1") ?? "[]").includes("tut.runback")));
  await A.screenshot({ path: `${SHOTS}a_win_recap.png` });
  // ...and the first DEATH still earns it, with the collapse-safe line.
  await A.keyboard.press("r");
  await A.waitForTimeout(1500);
  check("A6: R started a fresh run after the win", await A.evaluate(() => window.__dcc.state.status === "playing"));
  for (let i = 0; i < 10 && !(await A.evaluate(() => window.__dcc.state.status === "dead")); i++) {
    await A.evaluate(() => {
      const s = window.__dcc.state;
      const p = s.players[0];
      p.hp = 2;
      // Park on top of the NEAREST live monster and let it swing.
      const live = s.monsters.filter((x) => x.hp > 0);
      live.sort((a, b) => (a.pos.x - p.pos.x) ** 2 + (a.pos.y - p.pos.y) ** 2
        - ((b.pos.x - p.pos.x) ** 2 + (b.pos.y - p.pos.y) ** 2));
      if (live[0]) p.pos = { x: live[0].pos.x + 0.4, y: live[0].pos.y };
    });
    await A.waitForFunction(() => window.__dcc.state.status === "dead", { timeout: 4000 }).catch(() => {});
  }
  check("A6: death staged", await A.evaluate(() => window.__dcc.state.status === "dead"));
  await A.waitForTimeout(1400);
  check("A6: first DEATH shows the plate", await A.evaluate(() =>
    document.getElementById("recap-guide")?.style.display === "flex"));
  check("A6: the reworded line (no 'still standing' lie after a collapse)",
    await A.evaluate(() => {
      const t = document.getElementById("recap-guide-line")?.textContent ?? "";
      return /Run it back and collect/.test(t) && !/still standing/i.test(t);
    }));
  await rasterCheck(A, "#recap-guide", "a_death_plate");
  check("A: zero page errors", errsA.length === 0, errsA.slice(0, 3).join(" | "));
  await ctxA.close();
  }

  if (!ONLY || ONLY === "B") {
  // ========== CONTEXT B: cold profile, the global skip silences BOTH ======
  const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const B = await ctxB.newPage();
  const errsB = [];
  B.on("pageerror", (e) => errsB.push(e.message));
  await B.addInitScript(cardLogInit);
  await boot(B, `${BASE}/iso.html?debug=1&noassets`);
  await B.click("#m-solo");
  await B.waitForTimeout(600);
  check("B: B0 up", await dlgVisible(B));
  await B.keyboard.press("3"); // "Skip the hand-holding."
  await B.waitForTimeout(1000);
  await B.keyboard.press("1"); // the one goodbye left
  await B.waitForTimeout(400);
  check("B: tut.skipAll ledgered", await B.evaluate(() =>
    JSON.parse(localStorage.getItem("dcc:tips:v1") ?? "[]").includes("tut.skipAll")));
  await B.click("#m-cast-go");
  await B.waitForTimeout(1500);
  check("B: run live", await B.evaluate(() => window.__dcc?.state?.status === "playing"));

  // The critic's CTX-S repro: draftBanked landed 17s after the skip. Stage
  // the SAME sim moment (level-up mints a draft) + the collapse tip.
  await B.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.xp = p.xpToNext; // next kill levels
    p.attackPower = 9999;
    const mon = s.monsters.find((x) => x.kind !== "boss" && x.hp > 0);
    if (mon) { mon.hp = 1; mon.pos = { x: p.pos.x + 0.5, y: p.pos.y + 0.2 }; }
  });
  // Swing at it (LMB toward the monster's side).
  await B.mouse.move(760, 450);
  await B.mouse.down();
  await B.waitForTimeout(1200);
  await B.mouse.up();
  await B.waitForTimeout(400);
  const leveled = await B.evaluate(() => window.__dcc.state.players[0].level >= 2);
  check("B setup: leveled (draftBanked's sim moment reached)", leveled);
  check("B setup: the sim DID mark the tip explained", await B.evaluate(() =>
    (window.__dcc.state.players[0].tipsSeen ?? []).includes("draftBanked")));
  await B.evaluate(() => {
    const s = window.__dcc.state;
    s.timeRemaining = s.timeBudget * 0.25 - 0.5; // the collapse tip's moment
  });
  // 20s of play: NOT ONE card of any kind (was: draftBanked at +17s).
  for (let i = 0; i < 20; i++) {
    await B.keyboard.down("w");
    await B.waitForTimeout(400);
    await B.keyboard.up("w");
    await B.waitForTimeout(600);
  }
  const bCards = await cardLog(B);
  check("B2 MAJOR: zero COURTESY cards after the skip (onramp AND sim tips)",
    bCards.length === 0, bCards.map((e) => e.t.slice(0, 50)).join(" | "));
  await B.screenshot({ path: `${SHOTS}b_skip_silence.png` });
  check("B: zero page errors", errsB.length === 0, errsB.slice(0, 3).join(" | "));
  await ctxB.close();
  }

  if (!ONLY || ONLY === "C") {
  // ========== CONTEXT C: cold NET arrival (the rush path) =================
  // A fresh browser whose first click is THE RUSH: the onramp must run in
  // the server's world. Join code comes from GET /rush like the tile does;
  // if the rush queue is unreachable, a private ?join= party is the same
  // code path (net non-null) and still proves the fix.
  let code = null;
  try {
    const r = await fetch(`${API}/rush`);
    if (r.ok) { const v = await r.json(); code = v.forming?.[0]?.code ?? v.code ?? null; }
  } catch { /* private party fallback */ }
  const joinUrl = code
    ? `${BASE}/iso.html?debug=1&noassets&rivals=1&public=1&join=${code}&name=ProbeRush`
    : `${BASE}/iso.html?debug=1&noassets&join=PRB${Math.floor(Math.random() * 900 + 100)}&name=ProbeRush`;
  notes.push(`C: joining via ${code ? `rush code ${code}` : "private party fallback"}`);
  const ctxC = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const C = await ctxC.newPage();
  const errsC = [];
  C.on("pageerror", (e) => errsC.push(e.message));
  await C.addInitScript(cardLogInit);
  await boot(C, joinUrl);
  await C.waitForTimeout(1500);
  const netUp = await C.evaluate(() => window.__dcc?.state?.status === "playing");
  check("C: net world live", netUp);
  // A rush race holds at the READY gate — click READY like a player would,
  // then wait for the gun (the onramp correctly stays quiet until the world
  // actually elapses).
  await C.waitForTimeout(1000);
  const gateBtn = await C.$("#rushgate-ready");
  if (gateBtn && await gateBtn.isVisible()) await gateBtn.click();
  await C.waitForFunction(() => (window.__dcc?.state?.elapsed ?? 0) > 1.5, { timeout: 150000 }).catch(() => {});
  check("C: the gun fired (world elapsing)", await C.evaluate(() => window.__dcc.state.elapsed > 1.5));
  // Move + fish for the first two onramp lines in the server's world.
  for (let i = 0; i < 20 && !(await C.evaluate(() => (window.__tutlog ?? []).length >= 2)); i++) {
    await C.keyboard.down("w");
    await C.waitForTimeout(350);
    await C.keyboard.up("w");
    await C.waitForTimeout(350);
  }
  const cCards = await cardLog(C);
  check("C5 MAJOR: onramp speaks under net (fresh meat line)",
    cCards.some((e) => /fresh meat/i.test(e.t)), cCards.map((e) => e.t.slice(0, 40)).join(" | "));
  check("C5: the moved line under net names the live binds",
    cCards.some((e) => /locomotion confirmed/i.test(e.t) && /Shift, Q, C/.test(e.t)) || cCards.length < 2,
    "moved line optional if the walk didn't register two events yet");
  if (await C.evaluate(() => !!document.querySelector("#tutorial .tut"))) {
    await C.waitForTimeout(400);
    await rasterCheck(C, "#tutorial .tut", "c_net_card");
  } else {
    await C.screenshot({ path: `${SHOTS}c_net.png` });
  }
  check("C: no Mordecai under net (guide seam has no wire)", !(await dlgVisible(C)));
  check("C: zero page errors", errsC.length === 0, errsC.slice(0, 3).join(" | "));
  await ctxC.close();
  }

  if (!ONLY || ONLY === "D") {
  // ========== CONTEXT D: B9 waits a beat before speaking (r2 minor) =======
  // A returning player (1 finished run on the ledger) opens the menu: the
  // check-in must NOT modal the menu on the same frame — 1.6s of seeing the
  // menu first. Cold context; the history row is the only seeded state.
  const ctxD = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const D = await ctxD.newPage();
  const errsD = [];
  D.on("pageerror", (e) => errsD.push(e.message));
  await D.addInitScript(() => {
    localStorage.setItem("dcc:history:v1", JSON.stringify([{
      endedAt: Date.now() - 3600e3, mode: "solo", name: "Probe", won: false,
      floor: 2, timeSec: 300, level: 4, kills: 12, damageDealt: 900,
      damageTaken: 400, gold: 30, viewers: 100, favorites: 0, sponsors: 0, seed: 7,
    }]));
    // Stamp when the guide beat actually becomes visible.
    window.__dlgShownAt = null;
    const iv = setInterval(() => {
      const el = document.getElementById("dialogue");
      if (el && el.style.display === "flex" && el.classList.contains("show") && window.__dlgShownAt === null) {
        window.__dlgShownAt = performance.now();
        clearInterval(iv);
      }
    }, 60);
  });
  await D.goto(`${BASE}/iso.html?debug=1&noassets`, gotoOpts);
  await D.waitForFunction(() => window.__dlgShownAt !== null, { timeout: 30000 }).catch(() => {});
  const shownAt = await D.evaluate(() => window.__dlgShownAt);
  check("D: B9 fires for the returning player", shownAt !== null);
  if (shownAt !== null) {
    check(`D: ...but only after a beat (${(shownAt / 1000).toFixed(1)}s from load >= 1.5s)`, shownAt >= 1500);
  }
  check("D: it is Mordecai", await D.evaluate(() => document.getElementById("dlg-name")?.textContent === "Mordecai"));
  await D.waitForTimeout(1500);
  await rasterCheck(D, "#dialogue .dlg-stage", "d_b9_delay");
  check("D: zero page errors", errsD.length === 0, errsD.slice(0, 3).join(" | "));
  await ctxD.close();
  }
} finally {
  await browser.close();
}

writeFileSync(`${SHOTS}_report.txt`, [...notes, ...fails].join("\n"));
console.log(`\n${notes.length} pass, ${fails.length} fail. Shots in tools/_tut_r2_shots/`);
if (fails.length > 0) process.exit(1);
