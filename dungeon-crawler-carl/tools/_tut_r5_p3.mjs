// TUTORIAL r5 — PHASE 3: BLOCKER 3 + THE METRONOME.
// The r4 critic's deterministic repro: a fresh player who holds the mouse
// button from the first frame (the single most common instinct) got
// "Swinging is the floor, not the ceiling" at +0.9s with the nearest monster
// TWENTY TILES AWAY, eleven seconds ahead of "WASD walks". Same input here.
//
// Also the pacing measurements r4 failed: 14 cards on floor 1 at ~10s
// intervals, median act->card lag 30.4s, hype card 47.6s behind its crit.
import { chromium } from "playwright";
import {
  SHOTS, check, log, dump, boot, spyInit, cards, snap, dlgVisible,
  assertCold, track404,
} from "./_tut_r5_lib.mjs";

const BASE = process.argv[2] ?? "http://localhost:5284";
const PLAY_MS = Number(process.argv[3] ?? 200000);
const txt = (c) => (c.t ?? "").replace(/\s+/g, " ").replace(/^\s*SYSTEM — COURTESY EXPLANATION/, "");

/** Timestamp the SIM's decision to teach (the latch) and every TOAST paint, so
 *  "generated" and "delivered" can be compared instead of conflated. */
const LAG_SPY = () => {
  window.__latchAt = {};
  window.__toasts = [];
  setInterval(() => {
    const p = window.__dcc?.state?.players?.[0];
    for (const id of p?.tipsSeen ?? []) {
      if (!(id in window.__latchAt)) window.__latchAt[id] = performance.now();
    }
  }, 100);
  const arm = () => {
    const layer = document.getElementById("toasts");
    if (!layer) { setTimeout(arm, 50); return; }
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList?.contains("toast")) {
            const r = n.getBoundingClientRect();
            window.__toasts.push({
              t: n.textContent ?? "", cls: n.className, at: performance.now(),
              box: { w: r.width, h: r.height },
            });
          }
        }
      }
    }).observe(layer, { childList: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arm);
  else arm();
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
await P.addInitScript(LAG_SPY);

const NAV = () => {
  window.__nav = () => {
    const s = window.__dcc?.state; if (!s) return null;
    const p = s.players[0], map = s.map, W = map.w, H = map.h;
    const walk = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const t = map.tiles[y * W + x];
      if (t === 0 || t === 3) return false;
      if (map.blocked && map.blocked[y * W + x]) return false;
      return true;
    };
    const goals = new Map();
    const add = (x, y, kind) => { const k = `${Math.floor(x)},${Math.floor(y)}`; if (!goals.has(k)) goals.set(k, kind); };
    for (const l of s.loot ?? []) add(l.pos.x, l.pos.y, "loot");
    for (const m of s.monsters ?? []) if (m.hp > 0) add(m.pos.x, m.pos.y, "mob");
    if (map.stairs) add(map.stairs.x, map.stairs.y, "stairs");
    const sx = Math.floor(p.pos.x), sy = Math.floor(p.pos.y);
    const prev = new Int32Array(W * H).fill(-1);
    const q = [sy * W + sx]; prev[sy * W + sx] = sy * W + sx;
    let hit = -1, hitKind = "", head = 0, best = 99;
    const rank = { loot: 0, mob: 1, stairs: 2 };
    while (head < q.length) {
      const cur = q[head++], cx = cur % W, cy = (cur / W) | 0;
      const g = goals.get(`${cx},${cy}`);
      if (g && rank[g] < best) { best = rank[g]; hit = cur; hitKind = g; if (best === 0) break; }
      if (hit >= 0 && q.length - head > 900) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (!walk(nx, ny)) continue;
        const ni = ny * W + nx;
        if (prev[ni] !== -1) continue;
        prev[ni] = cur; q.push(ni);
      }
    }
    if (hit < 0) return null;
    const path = [];
    let cur = hit;
    while (prev[cur] !== cur) { path.push(cur); cur = prev[cur]; }
    path.reverse();
    const step = path[Math.min(2, path.length - 1)] ?? hit;
    return {
      kind: hitKind, dist: path.length,
      dx: (step % W) + 0.5 - p.pos.x, dy: ((step / W) | 0) + 0.5 - p.pos.y,
      tdx: (hit % W) + 0.5 - p.pos.x, tdy: ((hit / W) | 0) + 0.5 - p.pos.y,
    };
  };
};
await P.addInitScript(NAV);

try {
  await boot(P, `${BASE}/iso.html?debug=1&noassets`);
  await assertCold(P, "R5P3");
  await P.click("#m-solo");
  await P.waitForTimeout(900);
  if (await dlgVisible(P)) { await P.click('[data-choice="go"]').catch(() => {}); await P.waitForTimeout(700); }
  await P.click("#m-cast-go");
  await P.waitForFunction(() => window.__dcc?.state?.status === "playing", { timeout: 30000 });
  const T0 = await P.evaluate(() => performance.now());

  // ---- THE INSTINCT: the button goes down and STAYS down ------------------
  await P.mouse.move(683, 384);
  await P.mouse.down();
  log("MOUSE BUTTON HELD from the first frame of play (r4's deterministic repro)");

  const t0 = Date.now();
  let bagTried = false, lastStairs = 0, i = 0;
  let bagResult = null;
  while (Date.now() - t0 < PLAY_MS) {
    i++;
    const s = await snap(P);
    if (s.status !== "playing") { log(`RUN ENDED status=${s.status}`); break; }
    if (s.modal || await dlgVisible(P)) {
      await P.mouse.up().catch(() => {});
      const took = await P.evaluate(() => {
        const b = [...document.querySelectorAll("#draft button, #draft .draft-card, .draft-opt")].filter((e) => e.offsetParent);
        if (b.length) { b[0].click(); return b[0].textContent?.replace(/\s+/g, " ").slice(0, 60); }
        return null;
      });
      if (!took) {
        const btn = await P.$("#dialogue .dlg-choice");
        if (btn) await btn.click().catch(() => {});
        else await P.keyboard.press("Escape");
      } else log(`DRAFT taken: ${took}`);
      await P.waitForTimeout(1000);
      await P.mouse.down().catch(() => {});
      continue;
    }
    const cs = await cards(P);
    if (!bagTried && cs.some((c) => /opens your BAG/i.test(c.t))) {
      bagTried = true;
      await P.mouse.up().catch(() => {});
      await P.keyboard.press("i");
      await P.waitForTimeout(1500);
      bagResult = await P.evaluate(() => {
        const btns = [...document.querySelectorAll("button, .inv-item, .item-row, .inv-row")]
          .filter((b) => b.offsetParent && /equip|wear/i.test(b.textContent ?? ""));
        return { inv: window.__dcc.state.players[0].inventory.length, offers: btns.length,
          label: btns[0]?.textContent?.replace(/\s+/g, " ").slice(0, 50) ?? null };
      });
      await P.screenshot({ path: `${SHOTS}r5_p3_bag_on_cue.png` });
      log(`BAG ON CUE: ${JSON.stringify(bagResult)}`);
      await P.keyboard.press("Escape");
      await P.waitForTimeout(600);
      await P.mouse.down().catch(() => {});
      continue;
    }
    const nav = await P.evaluate(() => window.__nav?.());
    const keys = [];
    if (nav) {
      if (nav.dy < -0.3) keys.push("w"); else if (nav.dy > 0.3) keys.push("s");
      if (nav.dx < -0.3) keys.push("a"); else if (nav.dx > 0.3) keys.push("d");
      await P.mouse.move(
        Math.max(20, Math.min(1340, 683 + (nav.tdx - nav.tdy) * 34)),
        Math.max(20, Math.min(740, 384 + (nav.tdx + nav.tdy) * 17)),
      );
    }
    if (!keys.length) keys.push("d");
    for (const k of keys) await P.keyboard.down(k);
    await P.waitForTimeout(430);
    for (const k of keys) await P.keyboard.up(k);
    if (s.sr) {
      // A safe room stops the clock; close it and keep crawling rather than
      // measuring the tutorial against a paused world.
      await P.mouse.up().catch(() => {});
      await P.keyboard.press("Escape");
      await P.waitForTimeout(900);
      await P.mouse.down().catch(() => {});
      continue;
    }
    if (nav && nav.kind === "stairs" && nav.dist <= 2 && Date.now() - lastStairs > 6000) {
      lastStairs = Date.now();
      await P.keyboard.press("e");
      await P.waitForTimeout(1500);
      log(`STAIRS @ ${JSON.stringify(await snap(P))}`);
    }
    await P.waitForTimeout(50);
  }
  await P.mouse.up().catch(() => {});

  // ---- MEASURE ------------------------------------------------------------
  const cs = await cards(P);
  const latchAt = await P.evaluate(() => ({ ...window.__latchAt }));
  const toasts = await P.evaluate(() => window.__toasts ?? []);
  const at = (c) => (c.at - T0) / 1000;
  for (const c of cs) {
    log(`CARD +${at(c).toFixed(1)}s f=${c.ctx.floor} near=${c.ctx.near} hp=${c.ctx.hp}% lvl=${c.ctx.lvl} `
      + `dwell=${c.gone ? ((c.gone - c.at) / 1000).toFixed(1) : "up"}s :: ${txt(c).slice(0, 120)}`);
  }
  for (const t of toasts.filter((x) => /toast-tip/.test(x.cls))) {
    log(`TICKER-TIP +${((t.at - T0) / 1000).toFixed(1)}s box=${t.box.w}x${t.box.h} :: ${t.t.replace(/\s+/g, " ").slice(0, 90)}`);
  }

  const first = cs[0];
  check("R5P3 BLOCKER 3: the FIRST card a button-holding fresh crawler sees is the movement line",
    /fresh meat/i.test(first?.t ?? ""), `${at(first ?? { at: T0 }).toFixed(1)}s :: ${txt(first ?? {}).slice(0, 80)}`);

  const abil = cs.find((c) => /live abilities/i.test(c.t));
  const contact = cs.find((c) => /swings at what the mouse points at|STRIKE chip/i.test(c.t));
  check("R5P3 BLOCKER 3: the ability lesson exists at all", !!abil,
    abil ? `+${at(abil).toFixed(1)}s` : "never fired");
  if (abil) {
    check("R5P3 BLOCKER 3: ...and it lands in a FIGHT (nearest monster inside reach)",
      abil.ctx.near <= 3.5, `near=${abil.ctx.near} tiles at +${at(abil).toFixed(1)}s`);
    check("R5P3 BLOCKER 3: ...after the movement line, never ahead of it",
      at(abil) > at(first), `movement +${at(first).toFixed(1)}s, ability +${at(abil).toFixed(1)}s`);
    if (contact) {
      check("R5P3 BLOCKER 3: ...and after the swing lesson it builds on",
        at(abil) >= at(contact), `contact +${at(contact).toFixed(1)}s, ability +${at(abil).toFixed(1)}s`);
    }
    check("R5P3 (r4, kept): the ability line names only LIVE slots",
      !/\bC\b/.test(abil.t) && !/\bF\b/.test(abil.t) && !/ultimate/i.test(abil.t),
      txt(abil).slice(0, 110));
  }

  // THE SHOW: the crit -> the card.
  const hypeCard = cs.find((c) => /HYPE reading moved/i.test(c.t));
  if (latchAt.hype && hypeCard) {
    const lag = (hypeCard.at - latchAt.hype) / 1000;
    log(`HYPE: sim taught at +${((latchAt.hype - T0) / 1000).toFixed(1)}s, card painted at +${at(hypeCard).toFixed(1)}s (lag ${lag.toFixed(1)}s)`);
    check("R5P3 M5: THE SHOW is taught on the crit that caused it (r4 measured 47.6s)",
      lag <= 8, `lag ${lag.toFixed(1)}s`);
  } else {
    log(`HYPE: latch=${latchAt.hype ? "yes" : "no"} card=${hypeCard ? "yes" : "no"}`);
  }

  // THE METRONOME: card count and act->card lag on the sim's tips.
  const f1 = cs.filter((c) => c.ctx.floor === 1);
  const f1secs = f1.length > 1 ? (f1[f1.length - 1].at - f1[0].at) / 1000 : 0;
  log(`FLOOR 1 CARDS: ${f1.length} over ${f1secs.toFixed(0)}s (r4 measured 14 at ~10.4s intervals)`);
  check("R5P3 M4: floor 1 is not a conveyor belt (<= 9 cards)", f1.length <= 9, `${f1.length} cards`);
  const gaps = [];
  for (let k = 1; k < f1.length; k++) gaps.push((f1[k].at - f1[k - 1].at) / 1000);
  log(`FLOOR 1 GAPS (s): ${gaps.map((g) => g.toFixed(1)).join(", ")}`);
  // The metronome's signature was UNIFORMITY: fourteen cards, every gap ~10.4s,
  // because the pacing constant was short enough that a fight could always fill
  // the next slot. The fix is meant to produce the opposite shape — moments
  // arriving fast, evergreen rules spaced wide.
  const fast = gaps.filter((g) => g < 6).length;
  const wide = gaps.filter((g) => g >= 12).length;
  check("R5P3 M4: the gaps are not a metronome tick — moments jump, rules wait",
    fast >= 1 && wide >= 1, `${fast} gaps < 6s, ${wide} gaps >= 12s, of ${gaps.length}`);
  const simLags = Object.entries(latchAt).map(([id, tAt]) => {
    const card = cs.find((c) => c.at >= tAt - 500 && c.at - tAt < 90000 && cardMatchesTip(c.t, id));
    const toast = toasts.find((t) => t.at >= tAt - 500 && t.at - tAt < 90000 && cardMatchesTip(t.t, id));
    return { id, card: card ? (card.at - tAt) / 1000 : null, toast: toast ? (toast.at - tAt) / 1000 : null };
  });
  log(`SIM TIP DELIVERY: ${JSON.stringify(simLags)}`);
  const delivered = simLags.filter((x) => x.card !== null || x.toast !== null);
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
  const med = median(delivered.map((x) => x.card ?? x.toast));
  log(`MEDIAN sim-tip act->paint lag: ${Number.isFinite(med) ? med.toFixed(1) : "n/a"}s (r4 measured 30.4s across the surface)`);
  if (Number.isFinite(med)) {
    check("R5P3 M4: median sim-tip delivery lag is under 10s", med < 10, `${med.toFixed(1)}s`);
  }

  if (bagResult) {
    check("R5P3 M7: the BAG the pickup card points at is not empty",
      bagResult.inv > 0 || bagResult.offers > 0, JSON.stringify(bagResult));
  }
  const autoEq = cs.find((c) => /dressed itself/i.test(c.t));
  check("R5P3 M7: the loot lesson's other half is REACHABLE (the auto-equip explains itself)",
    !!autoEq, autoEq ? `+${at(autoEq).toFixed(1)}s` : "never fired");

  log(`FINAL ${JSON.stringify(await snap(P))}`);
  log(`errors ${JSON.stringify(errs)} | 404s ${JSON.stringify(m404)}`);
  check("R5P3: zero page errors", errs.length === 0, errs.join(" | "));
  await P.screenshot({ path: `${SHOTS}r5_p3_final.png` });
} finally {
  dump("_r5_p3.txt");
  await browser.close();
}

function cardMatchesTip(text, id) {
  const probe = {
    hype: /HYPE reading moved/i, collapse: /this floor is on a clock/i,
    draftBanked: /minted a DRAFT/i, glyph: /that is a GLYPH/i,
    favorites: /crowd has FAVORITES/i, sponsors: /hype converts viewers/i,
    stagger: /you STAGGERED it/i, staggerGrace: /keeps its COMPOSURE/i,
    bolt: /your BOLT is thrown/i, afflicted: /you are AFFLICTED/i,
    achievementClaim: /queued a LOOT BOX/i, lowhp: /EXCELLENT television/i,
    interference: /broadcast flatlined/i, service: /OPEN FOR BUSINESS/i,
    overrank: /an OVERRANK is/i, extradition: /too heavy to move/i,
  }[id];
  return !!probe && probe.test(text);
}
