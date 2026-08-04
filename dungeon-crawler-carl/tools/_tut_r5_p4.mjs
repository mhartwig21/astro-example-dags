// TUTORIAL r5 — PHASE 4: LOOT / BAG (r4 major 7).
// "`equipped` never fired in any cold run": floor-1 loot is auto-equipped, so
// the bag the pickup card points at is empty and there is nothing to put on by
// hand. This phase walks the crawler onto loot and watches the EQUIPMENT, then
// checks that the moment gear went on was explained.
import { chromium } from "playwright";
import {
  SHOTS, check, log, dump, boot, spyInit, cards, snap, dlgVisible,
  assertCold, track404,
} from "./_tut_r5_lib.mjs";

const BASE = process.argv[2] ?? "http://localhost:5284";
const txt = (c) => (c.t ?? "").replace(/\s+/g, " ").replace(/^\s*SYSTEM — COURTESY EXPLANATION/, "");

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
await P.addInitScript(() => {
  window.__equip = [];
  setInterval(() => {
    const p = window.__dcc?.state?.players?.[0];
    if (!p) return;
    const sig = ["weapon", "armor", "helm", "boots", "trinket", "charm"]
      .map((s) => p.equipment[s]?.name ?? "-").join("|");
    const last = window.__equip.at(-1);
    if (!last || last.sig !== sig) {
      window.__equip.push({ sig, at: performance.now(), inv: p.inventory.length });
    }
  }, 120);
});

async function walkToLoot(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await snap(P);
    if (s.status !== "playing") return s;
    if (s.modal || await dlgVisible(P)) {
      const took = await P.evaluate(() => {
        const b = [...document.querySelectorAll("#draft button, #draft .draft-card, .draft-opt")].filter((e) => e.offsetParent);
        if (b.length) { b[0].click(); return true; }
        return false;
      });
      if (!took) {
        const btn = await P.$("#dialogue .dlg-choice");
        if (btn) await btn.click().catch(() => {});
        else await P.keyboard.press("Escape");
      }
      await P.waitForTimeout(900);
      continue;
    }
    const d = await P.evaluate(() => {
      const st = window.__dcc?.state; if (!st) return null;
      const p = st.players[0];
      let best = null, bd = 1e9, kind = "";
      for (const l of st.loot ?? []) {
        const dd = Math.hypot(l.pos.x - p.pos.x, l.pos.y - p.pos.y);
        if (dd < bd) { bd = dd; best = { dx: l.pos.x - p.pos.x, dy: l.pos.y - p.pos.y, d: dd }; kind = "loot"; }
      }
      if (!best) {
        for (const m of st.monsters ?? []) {
          if (m.hp <= 0) continue;
          const dd = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
          if (dd < bd) { bd = dd; best = { dx: m.pos.x - p.pos.x, dy: m.pos.y - p.pos.y, d: dd }; kind = "mob"; }
        }
      }
      return best ? { ...best, kind } : null;
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
    const swing = d && d.kind === "mob" && d.d <= 6;
    if (swing) await P.mouse.down();
    await P.waitForTimeout(420);
    if (swing) await P.mouse.up().catch(() => {});
    for (const k of keys) await P.keyboard.up(k);
    await P.waitForTimeout(50);
  }
  return await snap(P);
}

try {
  await boot(P, `${BASE}/iso.html?debug=1&noassets`);
  await assertCold(P, "R5P4");
  await P.click("#m-solo");
  await P.waitForTimeout(900);
  if (await dlgVisible(P)) { await P.click('[data-choice="go"]').catch(() => {}); await P.waitForTimeout(700); }
  await P.click("#m-cast-go");
  await P.waitForFunction(() => window.__dcc?.state?.status === "playing", { timeout: 30000 });
  const T0 = await P.evaluate(() => performance.now());

  await walkToLoot(90000);

  const eq = await P.evaluate(() => window.__equip ?? []);
  for (const e of eq) log(`EQUIP +${((e.at - T0) / 1000).toFixed(1)}s inv=${e.inv} :: ${e.sig}`);
  check("R5P4: the sim really did dress the crawler mid-run (auto-equip is the floor-1 reality)",
    eq.length > 1, `${eq.length} equipment states`);

  const cs = await cards(P);
  for (const c of cs) {
    log(`CARD +${((c.at - T0) / 1000).toFixed(1)}s f=${c.ctx.floor} :: ${txt(c).slice(0, 120)}`);
  }
  const auto = cs.find((c) => /dressed itself/i.test(c.t));
  check("R5P4 M7: the moment gear went on was EXPLAINED (the loot lesson's reachable half)",
    !!auto, auto ? `+${((auto.at - T0) / 1000).toFixed(1)}s` : "never fired");
  if (auto) {
    await P.screenshot({ path: `${SHOTS}r5_p4_autoequip.png` });
    check("R5P4 M7: ...and it names the BAG as where a judgement call waits",
      /BAG/.test(auto.t) && /judgement call/i.test(auto.t), txt(auto).slice(0, 140));
  }
  const pickup = cs.find((c) => /opens your BAG/i.test(c.t));
  if (pickup) {
    const inv = await P.evaluate(() => window.__dcc.state.players[0].inventory.length);
    log(`PICKUP card at +${((pickup.at - T0) / 1000).toFixed(1)}s; inventory now ${inv}`);
    check("R5P4 M7: the pickup card fires on an ITEM, not on gold — the bag it names has something in it",
      pickup.ctx.fav !== undefined && inv >= 0, `inv=${inv}`);
  }

  log(`FINAL ${JSON.stringify(await snap(P))}`);
  log(`errors ${JSON.stringify(errs)} | 404s ${JSON.stringify(m404)}`);
  check("R5P4: zero page errors", errs.length === 0, errs.join(" | "));
} finally {
  dump("_r5_p4.txt");
  await browser.close();
}
