// WR round 2 verification — the three majors, hit-tested with real touch.
//  A. COURTESY/ONRAMP card reads IN FULL + GOT IT hit-tests (Pixel 5 compact,
//     iPhone 13 phone, iPad Pro 11 tablet) — the 'BOX. It will not' clip.
//  B. Rivals death moment (iPhone 13, then iPad Pro 11): banner stands down
//     while the card is up, card inside the glass, doors >=44 side by side.
//     Plus the standings chip vs the XP plate during the race.
// One browser. Server on :5281 must be running for part B.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const BASE = "http://localhost:5286";
const OUT = "tools/_mobile/ac-wr-r2";
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "";
mkdirSync(OUT, { recursive: true });
const results = [];
const rec = (d, n, v, det) => {
  results.push({ device: d, check: n, verdict: v, detail: det });
  console.log(`[${v}] ${d} :: ${n} — ${det}`);
};

function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; return this; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock });
    },
    async tap(x, y, id = 1, holdMs = 110) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 60)));
      await this.up(id);
    },
  };
}

async function ready(page) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(2200);
}

const hit = async (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return { ok: false, why: "missing" };
  const r = e.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const at = document.elementFromPoint(cx, cy);
  return { ok: !!at && (at === e || e.contains(at) || at.contains(e)),
    cx: Math.round(cx), cy: Math.round(cy), x: Math.round(r.x), y: Math.round(r.y),
    w: Math.round(r.width), h: Math.round(r.height),
    on: r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight };
}, sel);

// The card measurement: full text on the glass, nothing scroll-clipped,
// GOT IT >=44 and hit-tested AT ITS CENTRE.
async function measureTut(page) {
  return page.evaluate(() => {
    const t = document.getElementById("tutorial");
    if (!t || !t.querySelector(".tut")) return { present: false };
    const card = t.querySelector(".tut").getBoundingClientRect();
    const clipped = [...t.querySelectorAll("*")]
      .filter((e) => e.scrollHeight > e.clientHeight + 4)
      .map((e) => `${e.tagName}.${[...e.classList].join(".")} sh=${e.scrollHeight} ch=${e.clientHeight}`);
    const btn = t.querySelector("button.tut-dismiss");
    const br = btn ? btn.getBoundingClientRect() : null;
    const at = br ? document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2) : null;
    const body = t.querySelector(".tut-body");
    return {
      present: true,
      card: { x: Math.round(card.x), y: Math.round(card.y), w: Math.round(card.width), h: Math.round(card.height) },
      cardOnGlass: card.y >= 0 && card.bottom <= innerHeight && card.x >= 0 && card.right <= innerWidth,
      clipped,
      bodyChars: (body?.textContent ?? "").length,
      gotIt: br ? { w: Math.round(br.width), h: Math.round(br.height),
        cx: Math.round(br.x + br.width / 2), cy: Math.round(br.y + br.height / 2),
        onGlass: br.y >= 0 && br.bottom <= innerHeight,
        hit: !!at && (at === btn || btn.contains(at)) } : null,
      text: (t.textContent ?? "").slice(0, 90),
    };
  });
}

const browser = await chromium.launch({ headless: true });
try {
  // ============ A. THE COURTESY CARD, three device classes ============
  const tutDevices = [
    ["pixel5", "Pixel 5 landscape", "0,24,24,0"],
    ["iphone13", "iPhone 13 landscape", "0,47,21,47"],
    ["ipadpro11", "iPad Pro 11 landscape", "24,0,20,0"],
  ];
  for (const [name, desc, safe] of tutDevices) {
    if (ONLY && !name.includes(ONLY)) continue;
    const ctx = await browser.newContext({ ...devices[desc] });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    // Test mode at level 8: the achievement unlock queues the LOOT BOX tip —
    // the exact line r1 photographed clipping mid-word.
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=8&seed=77&safe=${safe}`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);
    await page.waitForFunction(() => {
      const t = document.getElementById("tutorial");
      return !!t && (t.textContent ?? "").includes("COURTESY") &&
        !!t.querySelector(".tut.show");
    }, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600); // let the fade-in transform settle
    const m = await measureTut(page);
    await page.screenshot({ path: `${OUT}/${name}-tipcard.png` });
    if (!m.present) {
      rec(name, "COURTESY card appears", "FAIL", "no card");
    } else {
      rec(name, "COURTESY card: full text, nothing scroll-clipped",
        m.clipped.length === 0 && m.cardOnGlass ? "PASS" : "FAIL",
        `clipped=${JSON.stringify(m.clipped)} card=${JSON.stringify(m.card)} chars=${m.bodyChars}`);
      rec(name, "GOT IT >=44, on glass, hit-tested at centre",
        m.gotIt && m.gotIt.h >= 44 && m.gotIt.onGlass && m.gotIt.hit ? "PASS" : "FAIL",
        JSON.stringify(m.gotIt));
      if (m.gotIt?.hit) {
        const before = m.text;
        await touch.tap(m.gotIt.cx, m.gotIt.cy, 1, 110);
        await page.waitForTimeout(700);
        const after = await page.evaluate(() => {
          const t = document.getElementById("tutorial");
          return { text: (t?.textContent ?? "").slice(0, 90), has: !!t?.querySelector(".tut.show") };
        });
        rec(name, "GOT IT dismisses by touch",
          !after.has || after.text !== before ? "PASS" : "FAIL",
          `before='${before.slice(0, 40)}' after='${after.text.slice(0, 40)}' cardUp=${after.has}`);
      }
    }
    rec(name, "tipcard pageerrors", errs.length === 0 ? "PASS" : "FAIL", JSON.stringify(errs));
    await ctx.close();
  }

  // ============ B. THE DEATH MOMENT + STANDINGS CHIP (rivals) ============
  const rivalDevices = [
    ["iphone13-rivals", "iPhone 13 landscape", "0,47,21,47", 21],
    ["ipadpro11-rivals", "iPad Pro 11 landscape", "24,0,20,0", 20],
  ];
  for (const [name, desc, safe, insetB] of rivalDevices) {
    if (ONLY && !name.includes(ONLY)) continue;
    const CODE = "AWR" + Math.floor(Math.random() * 90000);
    const actx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const a = await actx.newPage();
    await a.goto(`${BASE}/iso.html?noassets&quality=performance&join=${CODE}&rivals&name=Alpha`,
      { waitUntil: "load", timeout: 90000 });
    const bctx = await browser.newContext({ ...devices[desc] });
    const b = await bctx.newPage();
    const berrs = [];
    b.on("pageerror", (e) => berrs.push(e.message.slice(0, 140)));
    const bclient = await bctx.newCDPSession(b);
    const btouch = touchDriver(bclient);
    await b.goto(`${BASE}/iso.html?debug=1&noassets&quality=performance&join=${CODE}&rivals&name=Bravo&safe=${safe}`,
      { waitUntil: "load", timeout: 90000 });
    for (const p of [a, b]) await ready(p);
    await a.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), null, { timeout: 30000 });
    await b.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), null, { timeout: 30000 });
    const rb = await hit(b, "#rushgate-ready");
    await btouch.tap(rb.cx, rb.cy, 1, 110);
    await a.click("#rushgate-ready");
    await a.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"), null, { timeout: 30000 });
    await b.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"), null, { timeout: 30000 });
    await b.waitForTimeout(1500);

    // The standings chip hangs from the measured plaque fact, not a constant:
    // zero intersection with the top-right plaque and the XP under-rail.
    const chip = await b.evaluate(() => {
      const inter = (r1, r2) => Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.x, r2.x)) *
        Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.y, r2.y));
      const party = document.getElementById("party");
      if (!party || getComputedStyle(party).display === "none") return { shown: false };
      const pr = party.getBoundingClientRect();
      const tr = document.getElementById("hud-tr")?.getBoundingClientRect();
      const xp = document.getElementById("xpbar")?.getBoundingClientRect();
      const mmEl = document.getElementById("minimap-frame");
      const mm = mmEl && getComputedStyle(mmEl).display !== "none" ? mmEl.getBoundingClientRect() : null;
      return { shown: true, rect: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) },
        vsPlate: tr ? Math.round(inter(pr, tr)) : 0, vsXp: xp ? Math.round(inter(pr, xp)) : 0,
        vsMinimap: mm ? Math.round(inter(pr, mm)) : 0,
        onGlass: pr.y >= 0 && pr.bottom <= innerHeight && pr.right <= innerWidth };
    });
    rec(name, "standings chip clear of plate + XP rail",
      chip.shown && chip.vsPlate === 0 && chip.vsXp === 0 && (chip.vsMinimap ?? 0) === 0 && chip.onGlass ? "PASS" : "FAIL",
      JSON.stringify(chip));
    await b.screenshot({ path: `${OUT}/${name}-race.png` });

    // Alpha melees Bravo down at the shared spawn.
    const t0 = Date.now();
    let downed = false;
    const cx = 683, cy = 384;
    outer: while (Date.now() - t0 < 240000) {
      for (const [dx, dy] of [[40, 0], [28, 28], [0, 40], [-28, 28], [-40, 0], [-28, -28], [0, -40], [28, -28]]) {
        await a.mouse.move(cx + dx, cy + dy);
        await a.mouse.down();
        await a.waitForTimeout(900);
        await a.mouse.up();
        const state = await b.evaluate(() => document.getElementById("downed")?.dataset.mode ?? "");
        if (state === "downed" || state === "conceded") { downed = true; break outer; }
      }
    }
    rec(name, "Bravo is DOWN (pvp)", downed ? "PASS" : "FAIL", `${Math.round((Date.now() - t0) / 1000)}s`);
    if (downed) {
      await b.waitForTimeout(400);
      const dm = await b.evaluate((inset) => {
        const d = document.getElementById("downed");
        const r = d.getBoundingClientRect();
        const head = document.getElementById("headline");
        const cs = getComputedStyle(head);
        return {
          card: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          inGlass: r.y >= 0 && r.bottom <= innerHeight - inset,
          bodyDowned: document.body.classList.contains("downed"),
          bannerLive: head.children.length > 0,
          bannerVisibility: cs.visibility,
        };
      }, insetB);
      rec(name, "death card fully inside the glass (above home indicator)",
        dm.inGlass ? "PASS" : "FAIL", JSON.stringify(dm.card));
      rec(name, "headline stands down while the card is up",
        dm.bodyDowned && dm.bannerVisibility === "hidden" ? "PASS" : "FAIL",
        `body.downed=${dm.bodyDowned} visibility=${dm.bannerVisibility} bannerChildren=${dm.bannerLive}`);
      const fight = await hit(b, "#downed-fight");
      const conc = await hit(b, "#downed-concede");
      rec(name, "KEEP FIGHTING >=44 hit-tested", fight.ok && fight.on && fight.h >= 44 ? "PASS" : "FAIL", JSON.stringify(fight));
      rec(name, "CONCEDE >=44 hit-tested + on glass", conc.ok && conc.on && conc.h >= 44 ? "PASS" : "FAIL", JSON.stringify(conc));
      rec(name, "the two doors sit side by side (one row)",
        fight.ok && conc.ok && Math.abs(fight.y - conc.y) < 4 ? "PASS" : "FAIL",
        `fight.y=${fight.y} conc.y=${conc.y}`);
      await b.screenshot({ path: `${OUT}/${name}-deathdoor.png` });
      // CONCEDE by touch -> SEAT FREED, banner still standing down
      let conceded = false;
      for (let i = 0; i < 4 && !conceded; i++) {
        const c2 = await hit(b, "#downed-concede");
        if (c2.ok) await btouch.tap(c2.cx, c2.cy, 1, 110);
        await b.waitForTimeout(900);
        conceded = await b.evaluate(() => document.getElementById("downed")?.dataset.mode === "conceded");
      }
      rec(name, "CONCEDE lands by touch -> SEAT FREED", conceded ? "PASS" : "FAIL", "");
      if (conceded) await b.screenshot({ path: `${OUT}/${name}-seatfreed.png` });
    }
    rec(name, "rivals pageerrors", berrs.length === 0 ? "PASS" : "FAIL", JSON.stringify(berrs));
    await actx.close();
    await bctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/report${ONLY ? `-${ONLY}` : ""}.json`, JSON.stringify(results, null, 1));
const fails = results.filter((r) => r.verdict === "FAIL").length;
console.log(`\n${results.length} checks, ${fails} FAIL`);
