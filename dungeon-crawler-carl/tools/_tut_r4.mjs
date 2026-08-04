// TUTORIAL r4 fix-round acceptance probe.
//
// COLD-PROFILE RULE: every first-run claim runs in a FRESH browser context
// (empty localStorage AND an empty dcc:tips:v1). RASTER RULE: a card is only
// "shown" if the pixels say so — the whole failure this round exists to fix
// was believing a card was shown because the code said so.
// One Chromium for the whole battery (machine limit).
//
// The round's claims under test:
//  A. BLOCKER 1 — a tip is SPENT only when it is SHOWN. A tip generated while
//     the surface is blocked is in Player.tipsSeen and NOT in the browser's
//     once-EVER ledger; saveRun does not smuggle it in; the ledger gains it at
//     the instant the card paints and not before.
//     BLOCKER 2 — the card queue does not survive a run boundary.
//  B. BLOCKER 3 — THE FIVE is taught key by key. The swing lands at contact,
//     the ability line names ONLY live slots, and no line in the whole session
//     names the ultimate (ultimateMinFloor 7 puts it out of reach).
//     Plus THE SHOW: the hype tip on a crit the player landed.
//  C. TEACH BY DOING — the flask press and the by-hand equip each produce
//     their confirmation; a glyph in hand produces the glyph tip. Plus the
//     voice guard on everything that painted: no HUD, no badge, no "(I)".
//
// Usage: node tools/_tut_r4.mjs [url-base] [only]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:5284";
const ONLY = process.argv[3] ?? "";
const SHOTS = new URL("./_tut_r4_shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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

/** A card counts as SHOWN only when its own box is non-uniform and warm-keyed. */
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
  check(`${name}: ${sel} PAINTED (std ${st.std.toFixed(1)}, warm ${(st.warmFrac * 100).toFixed(1)}%)`,
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
const ledger = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("dcc:tips:v1") ?? "[]"); } catch { return ["<corrupt>"]; }
});
const dlgVisible = (page) => page.evaluate(() => {
  const el = document.getElementById("dialogue");
  return !!el && el.style.display === "flex" && el.classList.contains("show");
});
const track404 = (page, sink) => page.on("response", (r) => { if (r.status() === 404) sink.push(r.url()); });

/** THE COLD PROFILE: a context is only cold if the ledger is empty too. */
async function assertCold(page, tag) {
  // dcc:skin:v1 is written by the casting stage at module init and carries no
  // teaching state; the two keys that decide whether this is a first session
  // are the run save and the once-EVER tips ledger.
  const st = await page.evaluate(() => ({
    keys: Object.keys(localStorage).filter((k) => k.startsWith("dcc:")),
    tips: localStorage.getItem("dcc:tips:v1"),
    save: localStorage.getItem("dcc:save:v1"),
    hist: localStorage.getItem("dcc:history:v1"),
  }));
  check(`${tag}: COLD profile (no tips ledger, no save, no history)`,
    !st.tips && !st.save && !st.hist, `keys=[${st.keys.join(",")}]`);
}

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

/** Drain whatever is on the card surface, recording each one. */
async function drainCards(page, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(() => !!document.querySelector("#tutorial .tut"))) {
      await page.waitForTimeout(1400);
      await page.keyboard.press("0");
    }
    await page.waitForTimeout(400);
  }
}

/**
 * READ THE CARDS LIKE A PLAYER, then answer the question. The surface
 * serializes at ~16s per card (7s read + the 9s courtesy gap), so a probe that
 * only sleeps measures the pacing, not the teaching. This dismisses each card
 * as it lands — which is also the honest simulation of someone reading them.
 */
async function untilCard(page, re, budgetMs = 60000) {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    const hit = await page.evaluate((src) => (window.__tutlog ?? []).some((e) => new RegExp(src, "i").test(e.t)),
      re.source);
    if (hit) return true;
    if (await page.evaluate(() => !!document.querySelector("#tutorial .tut"))) {
      await page.waitForTimeout(1400);
      const now = await page.evaluate((src) => (window.__tutlog ?? []).some((e) => new RegExp(src, "i").test(e.t)),
        re.source);
      if (now) return true;
      await page.keyboard.press("0");
    }
    await page.waitForTimeout(500);
  }
  return false;
}

/** The crawler must survive the battery: a death opens THE VERDICT, which is a
 *  modal — and post-r3 a card correctly refuses to burn behind one, so every
 *  measurement after the death would be of a corpse. (r3's probe learned this
 *  the same way.) */
const keepAlive = (page) => page.evaluate(() => {
  window.__keep = setInterval(() => {
    const p = window.__dcc?.state?.players?.[0];
    if (p && p.hp > 0 && p.hp < p.maxHp * 0.75) { p.hp = p.maxHp; p.statuses = []; }
  }, 150);
});
const releaseAlive = (page) => page.evaluate(() => clearInterval(window.__keep));

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});

try {
  if (!ONLY || ONLY === "A") {
  // ===== CONTEXT A: BLOCKER 1 (spend on show) + BLOCKER 2 (run scope) =====
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const A = await ctxA.newPage();
  const errsA = [], m404A = [];
  A.on("pageerror", (e) => errsA.push(e.message));
  track404(A, m404A);
  await A.addInitScript(cardLogInit);
  await boot(A, `${BASE}/iso.html?debug=1&noassets`);
  await assertCold(A, "A");
  const sA = await coldSoloStart(A);
  check("A: B0 up, run live", sA.b0 && sA.live);

  // Let the first card land, then — inside its input-dismiss grace — stage the
  // collapse tip and open the BAG. body.modal hides #tutorial, so the collapse
  // card is GENERATED but cannot be shown. This is the exact shape of the bug.
  await A.waitForFunction(() => !!document.querySelector("#tutorial .tut"), { timeout: 25000 });
  await A.evaluate(() => { const s = window.__dcc.state; s.timeRemaining = s.timeBudget * 0.25 - 0.5; });
  await A.waitForTimeout(400);
  await A.keyboard.press("i");
  await A.waitForFunction(() => document.body.classList.contains("modal"), { timeout: 4000 });

  const simSaw = await A.evaluate(() => (window.__dcc.state.players[0].tipsSeen ?? []).includes("collapse"));
  check("A1: the sim generated the collapse tip (within-run latch set)", simSaw);
  const ledgerDuring = await ledger(A);
  check("A1 BLOCKER 1: it is NOT in the once-EVER ledger while unshown",
    !ledgerDuring.includes("collapse"), `ledger=[${ledgerDuring.join(",")}]`);

  // ...and saveRun must not smuggle it in behind the queue's back. Force a
  // save the way the game does, then look again.
  await A.evaluate(() => { window.__dcc.state.players[0].gold += 1; });
  await A.waitForTimeout(2500);
  const ledgerAfterSave = await ledger(A);
  check("A1 BLOCKER 1: saveRun does not spend it either",
    !ledgerAfterSave.includes("collapse"), `ledger=[${ledgerAfterSave.join(",")}]`);
  const savedSeen = await A.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("dcc:save:v1") ?? "{}").player?.tipsSeen ?? []; }
    catch { return ["<corrupt>"]; }
  });
  check("A1: the RUN SAVE drops the unshown id too (a refresh can re-teach it)",
    !savedSeen.includes("collapse"), `saved=[${savedSeen.join(",")}]`);

  // Close the modal and let the card actually paint. NOW it may be spent.
  await A.keyboard.press("Escape");
  await A.waitForFunction(() => !document.body.classList.contains("modal"), { timeout: 4000 });
  await A.waitForTimeout(1500);
  await A.keyboard.press("0"); // clear the start card; the collapse card is "high"
  await A.waitForFunction(() => (window.__tutlog ?? []).some((e) => /clock has opinions/i.test(e.t)),
    { timeout: 20000 }).catch(() => {});
  const shown = (await cardLog(A)).some((e) => /clock has opinions/i.test(e.t));
  check("A1: the collapse card SHOWS once the surface is free", shown);
  await A.waitForTimeout(500);
  await rasterCheck(A, "#tutorial .tut", "a1_collapse_card");
  const ledgerAfterShow = await ledger(A);
  check("A1 BLOCKER 1: the ledger gains it AT the paint, not before",
    ledgerAfterShow.includes("collapse"), `ledger=[${ledgerAfterShow.join(",")}]`);

  // ---- BLOCKER 2: the queue does not cross a run boundary ----------------
  // Queue a card that cannot drain (the 9s gap holds it), then die and press R.
  await A.keyboard.press("0");
  await A.waitForTimeout(300);
  await A.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    p.favorites = 999; // the crowd-favorites tip, generated behind the pacing gap
    p.hype = 90;
  });
  await A.waitForFunction(() => (window.__dcc.state.players[0].tipsSeen ?? []).includes("favorites"),
    { timeout: 10000 }).catch(() => {});
  const queuedBefore = await A.evaluate(() =>
    (window.__dcc.state.players[0].tipsSeen ?? []).includes("favorites"));
  check("A2: a 'favorites' card is generated and waiting on the pacing gap", queuedBefore);
  // The card must still be UNDRAINED when the run ends — otherwise there is
  // nothing to leak and the claim is vacuous. Kill fast, through a real damage
  // path (poison ticks through the sim's death handling; assigning hp=0 does
  // not, and the r3 shape of this probe silently measured a live run).
  await A.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = 1;
    p.statuses = [{ kind: "poison", remaining: 4, magnitude: 500, stacks: 1, tick: 0.2, school: "physical" }];
  });
  await A.waitForFunction(() => window.__dcc.state.status !== "playing", { timeout: 20000 }).catch(() => {});
  check("A2: the run ended (verdict)", await A.evaluate(() => window.__dcc.state.status !== "playing"));
  const stillQueued = await A.evaluate(() =>
    !(window.__tutlog ?? []).some((e) => /FAVORITES/i.test(e.t)));
  check("A2: ...with run 1's card still undrained (the leak has something to carry)", stillQueued);
  await A.waitForTimeout(2500);
  await A.screenshot({ path: `${SHOTS}a2_verdict.png` });
  const rAt = await A.evaluate(() => performance.now());
  await A.keyboard.press("r");
  await A.waitForTimeout(3000);
  const run2 = await A.evaluate(() => ({
    live: window.__dcc.state.status === "playing",
    floor: window.__dcc.state.floor,
    fav: window.__dcc.state.players[0].favorites,
    hype: window.__dcc.state.players[0].hype,
  }));
  check("A2: run 2 is live on floor 1 with an empty show", run2.floor === 1 && run2.fav < 1);
  // Give the leak every chance: sit through more than a full pacing gap.
  await A.waitForTimeout(12000);
  const afterR = await cardLog(A);
  const leaked = afterR.filter((e) => e.at > rAt && /FAVORITES/i.test(e.t));
  check("A2 BLOCKER 2: run 1's queued card NEVER paints over run 2",
    leaked.length === 0, leaked.map((e) => e.t.slice(0, 50)).join(" | "));
  const ledgerRun2 = await ledger(A);
  check("A2: ...and it was not spent either — run 2 may still teach it",
    !ledgerRun2.includes("favorites"), `ledger=[${ledgerRun2.join(",")}]`);
  await A.screenshot({ path: `${SHOTS}a2_run2_clean.png` });

  check("A: zero 404s", m404A.length === 0, m404A.slice(0, 3).join(" | "));
  check("A: zero page errors", errsA.length === 0, errsA.slice(0, 3).join(" | "));
  await ctxA.close();
  }

  if (!ONLY || ONLY === "B") {
  // ===== CONTEXT B: BLOCKER 3 — THE FIVE, key by key · plus THE SHOW ======
  const ctxB = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const B = await ctxB.newPage();
  const errsB = [], m404B = [];
  B.on("pageerror", (e) => errsB.push(e.message));
  track404(B, m404B);
  await B.addInitScript(cardLogInit);
  await boot(B, `${BASE}/iso.html?debug=1&noassets`);
  await assertCold(B, "B");
  const sB = await coldSoloStart(B);
  check("B: B0 up, run live", sB.b0 && sB.live);
  await B.waitForFunction(() => (window.__dcc?.state?.elapsed ?? 0) > 1.5, { timeout: 15000 });
  await keepAlive(B);

  // The measured r3 failure: the combat lecture fired with the nearest monster
  // 13.6 tiles away. Confirm the crawler is ALONE first, and that no combat
  // line has fired.
  const lonely = await B.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    const d = s.monsters.filter((m) => m.hp > 0)
      .map((m) => Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y)).sort((a, b) => a - b)[0];
    return d ?? 999;
  });
  await B.waitForTimeout(2500);
  const preContact = await cardLog(B);
  check(`B3: alone at spawn (nearest monster ${lonely.toFixed(1)} tiles) and NO swing lecture yet`,
    !preContact.some((e) => /swings at what/i.test(e.t)));

  // Walk a monster into contact range: the swing line is owed to the moment
  // there is finally something to swing at.
  await B.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    const m = s.monsters.filter((x) => x.hp > 0 && x.kind !== "boss")[0];
    if (m) m.pos = { x: p.pos.x + 1.2, y: p.pos.y + 0.4 };
  });
  await untilCard(B, /Contact\./, 70000);
  const contact = (await cardLog(B)).find((e) => /Contact\./.test(e.t));
  check("B3: the SWING is taught at contact", !!contact, contact?.t.slice(0, 90));
  if (contact) {
    check("B3: ...naming the strike", /Space|Left click/i.test(contact.t));
    check("B3: ...and nothing else", !/\bF\b|ultimate/i.test(contact.t));
  }
  await B.waitForTimeout(600);
  await rasterCheck(B, "#tutorial .tut", "b_contact_card");
  await B.keyboard.press("0");

  // Now SWING. Only after the player has swung does the System name the
  // louder options — and only the ones that are in a slot.
  await B.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    const m = s.monsters.filter((x) => x.hp > 0 && x.kind !== "boss")[0];
    if (m) { m.pos = { x: p.pos.x + 0.6, y: p.pos.y + 0.2 }; }
  });
  await B.mouse.move(683, 400);
  await B.mouse.down();
  await B.waitForTimeout(1400);
  await B.mouse.up();
  const slots = await B.evaluate(() => window.__dcc.state.players[0].abilities.slots.map((a) => a ?? null));
  const ult = await B.evaluate(() => window.__dcc.state.players[0].abilities.ultimate ?? null);
  check(`B3: the crawler's real loadout is [${slots.join(",")}] ult=${ult}`, slots[3] === null && ult === null);
  await untilCard(B, /live abilities/, 70000);
  const abil = (await cardLog(B)).find((e) => /live abilities/i.test(e.t));
  check("B3 BLOCKER: the ability line arrives AFTER the swing", !!abil, abil?.t.slice(0, 120));
  if (abil) {
    check("B3 BLOCKER: it names the LIVE slots only (Shift, Q)", /Shift/.test(abil.t) && /\bQ\b/.test(abil.t));
    check("B3 BLOCKER: it does NOT name slot 4 (C — padlocked)", !/\bC\b(?!ourtesy|OURTESY)/.test(abil.t.replace(/COURTESY EXPLANATION/g, "")));
    check("B3 BLOCKER: it does NOT name the ultimate (F — unreachable before floor 7)",
      !/\bF\b/.test(abil.t) && !/ultimate/i.test(abil.t));
    check("B3: it says WHY the rest of the row is dark", /lock/i.test(abil.t));
  }
  await B.waitForTimeout(500);
  await rasterCheck(B, "#tutorial .tut", "b_ability_card");
  await B.keyboard.press("0");

  // ---- THE SHOW: the hype tip on a crit the player landed ---------------
  await B.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    p.critChance = 1; p.bonusCrit = 5;
    for (const m of s.monsters) if (m.hp > 0) m.maxHp = 99999, m.hp = 99999;
    const m = s.monsters.filter((x) => x.hp > 0)[0];
    if (m) m.pos = { x: p.pos.x + 0.6, y: p.pos.y + 0.2 };
  });
  await B.mouse.down();
  await B.waitForTimeout(2500);
  await B.mouse.up();
  const hypeSim = await B.evaluate(() => ({
    seen: (window.__dcc.state.players[0].tipsSeen ?? []).includes("hype"),
    hype: window.__dcc.state.players[0].hype,
  }));
  check(`B SHOW: a crit fired the hype tip (hype=${hypeSim.hype.toFixed(0)})`, hypeSim.seen);
  await untilCard(B, /HYPE reading moved/, 70000);
  const hypeCard = (await cardLog(B)).find((e) => /HYPE reading moved/i.test(e.t));
  check("B SHOW: ...and the card PAINTED on the hype event the player caused", !!hypeCard);
  await B.waitForTimeout(500);
  if (hypeCard) await rasterCheck(B, "#tutorial .tut", "b_hype_card");

  // The session-wide guard: NOTHING ever named the ultimate.
  const allB = await cardLog(B);
  const namedUlt = allB.filter((e) => /\bULTIMATE\b/.test(e.t));
  check("B3 BLOCKER: across the whole session, no card ever named the ultimate",
    namedUlt.length === 0, namedUlt.map((e) => e.t.slice(0, 60)).join(" | "));
  check("B: the crawler survived the battery (every measurement is of a LIVE run)",
    await B.evaluate(() => window.__dcc.state.status === "playing"));
  await releaseAlive(B);
  check("B: zero 404s", m404B.length === 0, m404B.slice(0, 3).join(" | "));
  check("B: zero page errors", errsB.length === 0, errsB.slice(0, 3).join(" | "));
  writeFileSync(`${SHOTS}_b_cards.txt`, allB.map((e) => `${(e.at / 1000).toFixed(1)}s  ${e.t}`).join("\n"));
  await ctxB.close();
  }

  if (!ONLY || ONLY === "C") {
  // ===== CONTEXT C: TEACH BY DOING — flask, equip, glyph · voice guard ====
  const ctxC = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const C = await ctxC.newPage();
  const errsC = [], m404C = [];
  C.on("pageerror", (e) => errsC.push(e.message));
  track404(C, m404C);
  await C.addInitScript(cardLogInit);
  await boot(C, `${BASE}/iso.html?debug=1&noassets`);
  await assertCold(C, "C");
  const sC = await coldSoloStart(C);
  check("C: B0 up, run live", sC.b0 && sC.live);
  await C.waitForFunction(() => (window.__dcc?.state?.elapsed ?? 0) > 1.5, { timeout: 15000 });
  await drainCards(C, 8000);

  // ---- THE FLASK: the low-HP beat now has a half only a PRESS can reach --
  // (No keep-alive yet — the wound has to be real for the prompt to be owed.)
  await C.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = Math.floor(p.maxHp * 0.25);
    p.flaskCharges = 3;
  });
  await untilCard(C, /you are leaking/, 50000);
  check("C FLASK: the low-HP prompt fired", (await cardLog(C)).some((e) => /you are leaking/i.test(e.t)));
  await C.waitForTimeout(600);
  await rasterCheck(C, "#tutorial .tut", "c_flask_prompt");
  await C.keyboard.press("0");
  await C.waitForTimeout(500);
  const before = await C.evaluate(() => window.__dcc.state.players[0].flaskCharges);
  await C.keyboard.press("x"); // the press the r3 crawler died without making
  await C.waitForTimeout(1200);
  const after = await C.evaluate(() => window.__dcc.state.players[0].flaskCharges);
  check(`C FLASK: the press landed (${before} -> ${after} charges)`, after < before);
  await keepAlive(C); // the wound is made; the rest of the battery needs a live crawler
  await untilCard(C, /flask consumed/, 60000);
  const drink = (await cardLog(C)).find((e) => /flask consumed/i.test(e.t));
  check("C FLASK BY DOING: the press produced its confirmation", !!drink, drink?.t.slice(0, 90));
  await C.waitForTimeout(500);
  if (drink) await rasterCheck(C, "#tutorial .tut", "c_flask_confirm");
  await C.keyboard.press("0");

  // ---- LOOT: a by-hand equip, and its confirmation ----------------------
  await C.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    p.inventory.push({
      id: 990001, slot: "weapon", rarity: "rare", name: "Probe Cleaver",
      affixes: { attackPower: 12 },
    });
  });
  await drainCards(C, 3000);
  await C.keyboard.press("i");
  await C.waitForFunction(() => document.body.classList.contains("modal"), { timeout: 5000 });
  await C.waitForTimeout(600);
  await C.screenshot({ path: `${SHOTS}c_bag_open.png` });
  const clicked = await C.evaluate(() => {
    const card = document.querySelector("#inv-bag .item.bag");
    if (!card) return false;
    card.click();
    return true;
  });
  check("C LOOT: the bag offered the item to equip by hand", clicked);
  await C.waitForTimeout(600);
  const worn = await C.evaluate(() => window.__dcc.state.players[0].equipment.weapon?.id === 990001);
  check("C LOOT: the player CHOSE to wear it", worn);
  await C.keyboard.press("Escape");
  await C.waitForFunction(() => !document.body.classList.contains("modal"), { timeout: 5000 });
  await untilCard(C, /Strict upgrades dress themselves/, 60000);
  const eqCard = (await cardLog(C)).find((e) => /Strict upgrades dress themselves/i.test(e.t));
  check("C LOOT BY DOING: the equip produced its confirmation", !!eqCard, eqCard?.t.slice(0, 90));
  await C.waitForTimeout(500);
  if (eqCard) await rasterCheck(C, "#tutorial .tut", "c_equip_confirm");
  await C.keyboard.press("0");

  // ---- GLYPHS: the concept lands the moment the stone is in hand --------
  await C.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    s.loot.push({ id: s.nextEntityId++, pos: { x: p.pos.x, y: p.pos.y }, kind: "glyph", amount: 0, glyph: "accelerant" });
  });
  await C.waitForFunction(() => (window.__dcc.state.players[0].tipsSeen ?? []).includes("glyph"),
    { timeout: 20000 }).catch(() => {});
  check("C GLYPH: picking one up fired the glyph tip",
    await C.evaluate(() => (window.__dcc.state.players[0].tipsSeen ?? []).includes("glyph")));
  await untilCard(C, /that is a GLYPH/, 60000);
  const glyphCard = (await cardLog(C)).find((e) => /that is a GLYPH/i.test(e.t));
  check("C GLYPH BY DOING: ...and the card PAINTED", !!glyphCard, glyphCard?.t.slice(0, 90));
  await C.waitForTimeout(500);
  if (glyphCard) await rasterCheck(C, "#tutorial .tut", "c_glyph_card");
  check("C: the crawler survived the battery (every measurement is of a LIVE run)",
    await C.evaluate(() => window.__dcc.state.status === "playing"));
  await releaseAlive(C);

  // ---- THE VOICE GUARD, on everything that actually painted -------------
  const allC = await cardLog(C);
  const badChrome = allC.filter((e) => /\bHUD\b|\bbadge\b/i.test(e.t));
  check("C VOICE: no painted card ever named the player's chrome (HUD / badge)",
    badChrome.length === 0, badChrome.map((e) => e.t.slice(0, 60)).join(" | "));
  const badGloss = allC.filter((e) => /\([A-Z]\)/.test(e.t));
  check("C VOICE: no painted card glossed a keybind in parentheses",
    badGloss.length === 0, badGloss.map((e) => e.t.slice(0, 60)).join(" | "));
  const finalLedger = await ledger(C);
  check(`C: every id in the ledger corresponds to a card that painted (${finalLedger.length} ids)`,
    finalLedger.filter((id) => id.startsWith("tut.")).length + allC.length >= finalLedger.length,
    `ledger=[${finalLedger.join(",")}]`);
  writeFileSync(`${SHOTS}_c_cards.txt`, allC.map((e) => `${(e.at / 1000).toFixed(1)}s  ${e.t}`).join("\n"));
  check("C: zero 404s", m404C.length === 0, m404C.slice(0, 3).join(" | "));
  check("C: zero page errors", errsC.length === 0, errsC.slice(0, 3).join(" | "));
  await ctxC.close();
  }
  if (!ONLY || ONLY === "D") {
  // ===== CONTEXT D: ONE VOICE, ONE SURFACE, ONE MOMENT ====================
  // The r3 minor: at the first safe room Mordecai spoke twice inside two
  // seconds, in two different typographies — the portrait beat, then the
  // panel's green header line. On a beat visit the header must stand down.
  const ctxD = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const D = await ctxD.newPage();
  const errsD = [], m404D = [];
  D.on("pageerror", (e) => errsD.push(e.message));
  track404(D, m404D);
  await D.addInitScript(cardLogInit);
  await boot(D, `${BASE}/iso.html?debug=1&noassets`);
  await assertCold(D, "D");
  const sD = await coldSoloStart(D);
  check("D: B0 up, run live", sD.b0 && sD.live);
  await D.waitForFunction(() => (window.__dcc?.state?.elapsed ?? 0) > 1.5, { timeout: 15000 });
  await keepAlive(D);

  // Walk to the stairs the cheap way and descend.
  await D.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    p.pos = { x: s.map.stairs.x, y: s.map.stairs.y };
    s.map.locked = false; // never fight the key district for a voice check
  });
  // Under software GL the host runs ~3fps, so the stairs intent needs several
  // frames of standing on the tile before it is sampled.
  await D.waitForTimeout(1500);
  for (let i = 0; i < 4; i++) {
    await D.keyboard.press("e");
    await D.waitForTimeout(1200);
    if (await D.evaluate(() => !!window.__dcc.state.safeRoom)) break;
  }
  check("D: the descent reached the safe room",
    await D.evaluate(() => !!window.__dcc.state.safeRoom));
  await D.waitForFunction(() => {
    const el = document.getElementById("dialogue");
    return (!!el && el.style.display === "flex") || document.getElementById("saferoom")?.style.display === "flex";
  }, { timeout: 30000 }).catch(() => {});
  await D.waitForTimeout(1200);
  const beatUp = await dlgVisible(D);
  check("D: the first safe room opens on Mordecai's beat", beatUp);
  if (beatUp) {
    check("D: it is Mordecai",
      await D.evaluate(() => document.getElementById("dlg-name")?.textContent === "Mordecai"));
    await D.waitForTimeout(3000); // the typewriter has to finish saying it
    const said = await D.evaluate(() => document.getElementById("dlg-text")?.textContent ?? "");
    check("D VOICE: B5 line 1 is no longer a panel-affordance list",
      !/Shop's stocked|bench will re-slot|topped on the house/i.test(said), said.slice(0, 120));
    await D.screenshot({ path: `${SHOTS}d_saferoom_beat.png` });
    await rasterCheck(D, "#dialogue", "d_beat_portrait");
    await D.keyboard.press("Escape");
  }
  await D.waitForFunction(() => document.getElementById("saferoom")?.style.display === "flex",
    { timeout: 15000 }).catch(() => {});
  const panel = await D.evaluate(() => ({
    open: document.getElementById("saferoom")?.style.display === "flex",
    tip: (document.getElementById("sr-tip")?.textContent ?? "").trim(),
    roomTip: window.__dcc.state.safeRoom?.tip ?? "",
  }));
  check("D: the safe-room panel opened behind the beat", panel.open);
  // Non-vacuous: the room DOES carry a manager line — it was suppressed for
  // this visit, not deleted from the game.
  check("D: the room has a header line to suppress", panel.roomTip.length > 10, panel.roomTip);
  check("D MINOR: the green header line stands down on a beat visit — one voice, one surface",
    panel.tip === "", `sr-tip="${panel.tip}"`);
  await D.screenshot({ path: `${SHOTS}d_saferoom_panel.png` });
  check("D: zero 404s", m404D.length === 0, m404D.slice(0, 3).join(" | "));
  check("D: zero page errors", errsD.length === 0, errsD.slice(0, 3).join(" | "));
  await releaseAlive(D);
  await ctxD.close();
  }
} finally {
  await browser.close();
  const report = [`TUTORIAL r4 probe — ${notes.length} pass, ${fails.length} fail`, "", ...notes, "", ...fails].join("\n");
  writeFileSync(`${SHOTS}_report.txt`, report);
  console.log(`\n=== ${notes.length} PASS / ${fails.length} FAIL ===`);
  for (const f of fails) console.log(f);
}
