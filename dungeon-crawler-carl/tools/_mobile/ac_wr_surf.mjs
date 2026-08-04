// Acceptance r1, part 2: the NEW SURFACES under a thumb. One browser.
//  A. Pixel 5: menu funnel (RUSH tile), ONRAMP first-five-minutes
//  B. Pixel 5: RESULT CARD + sharesheet, CRAWL LEDGER, SYSTEM perf row
//  C. iPhone 13 (touch, Bravo) + desktop ctx (Alpha): STARTING GUN + DEATH DOOR
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const BASE = "http://localhost:5286";
const OUT = "tools/_mobile/ac-wr-r1";
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
    async tap(x, y, id = 1, holdMs = 100) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 60)));
      await this.up(id);
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 8, holdMs = 28, lift = true } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (lift) await this.up(id);
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
  return { ok: !!at && (at === e || e.contains(at)),
    w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(cx), cy: Math.round(cy),
    at: at ? `${at.tagName}#${at.id}` : "none",
    on: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight };
}, sel);

const browser = await chromium.launch({ headless: true });
try {
  // ============ A. Pixel 5 — menu funnel + ONRAMP ==========================
  {
    const ctx = await browser.newContext({ ...devices["Pixel 5 landscape"] });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?debug=1&noassets&quality=performance&safe=0,24,24,0`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/pixel5-menu.png` });
    const rush = await hit(page, "#m-rush");
    rec("pixel5", "RUSH tile on-glass + hit-tested on compact", rush.ok && rush.on ? "PASS" : "FAIL", JSON.stringify(rush));
    const solo = await hit(page, "#m-solo");
    rec("pixel5", "NEW RUN tile hit-tested", solo.ok && solo.on ? "PASS" : "FAIL", JSON.stringify(solo));
    if (solo.ok) {
      await touch.tap(solo.cx, solo.cy);
      await page.waitForTimeout(1200);
      const go = await hit(page, "#m-cast-go");
      rec("pixel5", "campfire DESCEND hit-tested", go.ok && go.on && go.h >= 44 ? "PASS" : "FAIL", JSON.stringify(go));
      await page.screenshot({ path: `${OUT}/pixel5-campfire.png` });
      if (go.ok) {
        await touch.tap(go.cx, go.cy);
        await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2000);
        // ONRAMP: the start line should arrive within a couple sim seconds
        const tip1 = await page.evaluate(() => {
          const t = [...document.querySelectorAll("#ticker .tick, #ticker div, #toasts div, #tutorial")]
            .map((e) => ({ txt: e.textContent ?? "", r: e.getBoundingClientRect(), id: e.id || e.className }))
            .filter((x) => /COURTESY EXPLANATION/.test(x.txt));
          const el = t[0];
          if (!el) return { found: false, tickerRaw: document.getElementById("ticker")?.textContent?.slice(0, 120) ?? null,
            tutRaw: document.getElementById("tutorial")?.textContent?.slice(0, 120) ?? null };
          return { found: true, id: el.id, txt: el.txt.slice(0, 140),
            box: { x: Math.round(el.r.x), y: Math.round(el.r.y), w: Math.round(el.r.width), h: Math.round(el.r.height) },
            onGlass: el.r.width > 0 && el.r.y >= 0 && el.r.y + el.r.height <= innerHeight };
        });
        rec("pixel5", "ONRAMP start line arrives and is on-glass", tip1.found && tip1.onGlass ? "PASS" : "FAIL", JSON.stringify(tip1).slice(0, 320));
        const touchCopy = tip1.found && /glass|chip|drag/i.test(tip1.txt);
        rec("pixel5", "ONRAMP copy names the GLASS controls, not keys", touchCopy ? "PASS" : "FAIL", tip1.txt ?? "");
        // move -> the locomotion line
        const sp = await page.evaluate(() => {
          const d = window.__dcc, z = d.touch.zones;
          for (const [dx, dy] of [[0, 0], [30, -20], [-25, 15]]) {
            const x = z.stickAnchor.x + dx, y = z.stickAnchor.y + dy;
            if (d.touch.controlAt(x, y)) continue;
            const e = document.elementFromPoint(x, y);
            if (e && e.tagName === "CANVAS" && e.id !== "minimap") return { x, y };
          }
          return null;
        });
        if (sp) {
          await touch.drag(sp.x, sp.y, sp.x + 55, sp.y - 25, { steps: 6, holdMs: 60, lift: false });
          await page.waitForTimeout(2500);
          await touch.up(1);
          const tip2 = await page.evaluate(() => {
            const all = [...document.querySelectorAll("#ticker, #toasts, #tutorial")].map((e) => e.textContent ?? "").join(" ");
            return { hasMove: /locomotion/i.test(all), sample: all.slice(0, 200) };
          });
          rec("pixel5", "ONRAMP locomotion line after first move", tip2.hasMove ? "PASS" : "WARN", tip2.sample);
          await page.screenshot({ path: `${OUT}/pixel5-onramp.png` });
        }
      }
    }
    rec("pixel5", "funnel pageerrors", errs.length === 0 ? "PASS" : "FAIL", JSON.stringify(errs));
    await ctx.close();
  }

  // ============ B. Pixel 5 — recap card + sharesheet + ledger + perf row ====
  {
    const ctx = await browser.newContext({ ...devices["Pixel 5 landscape"] });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=6&level=3&gear=0&seed=41&safe=0,24,24,0`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);

    // --- ledger first (needs a live, alive crawler) ---
    const tbc = await hit(page, "#tb-crawler");
    await touch.tap(tbc.cx, tbc.cy, 1, 110);
    await page.waitForTimeout(600);
    const lrow = await page.evaluate(async () => {
      const r = [...document.querySelectorAll("#tm-crawler .tm-row")].find((x) => x.dataset.act === "ledger");
      if (!r) return null;
      r.scrollIntoView({ block: "center" });
      await new Promise((res) => setTimeout(res, 250));
      const b = r.getBoundingClientRect();
      return b.width > 0 ? { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2), h: Math.round(b.height) } : null;
    });
    if (lrow) {
      await touch.tap(lrow.cx, lrow.cy, 1, 110);
      await page.waitForTimeout(900);
      const open = await page.evaluate(() => getComputedStyle(document.getElementById("ledger")).display !== "none");
      await page.screenshot({ path: `${OUT}/pixel5-ledger.png` });
      const lx = await hit(page, "#ledger .tp-x");
      const noScrollX = await page.evaluate(() => {
        const b = document.querySelector("#ledger .panel") ?? document.getElementById("ledger");
        return b.scrollWidth <= b.clientWidth + 1;
      });
      if (open && lx.ok) {
        await touch.tap(lx.cx, lx.cy);
        await page.waitForTimeout(800);
        const closed = await page.evaluate(() => getComputedStyle(document.getElementById("ledger")).display === "none");
        rec("pixel5", "CRAWL LEDGER opens + ✕ closes by touch", closed ? "PASS" : "FAIL", JSON.stringify({ open, lx, noScrollX }));
      } else rec("pixel5", "CRAWL LEDGER opens + ✕ closes by touch", "FAIL", JSON.stringify({ open, lx }));
    } else rec("pixel5", "CRAWL LEDGER row in crawler menu", "FAIL", JSON.stringify(tbc));

    // --- SYSTEM panel perf mode row by touch ---
    const tb = await hit(page, "#tb-system");
    await touch.tap(tb.cx, tb.cy, 1, 110);
    await page.waitForTimeout(500);
    const krow = await page.evaluate(() => {
      const r = [...document.querySelectorAll("#tm-system .tm-row")].find((x) => x.dataset.act === "keybinds");
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return b.width > 0 ? { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) } : null;
    });
    if (krow) {
      await touch.tap(krow.cx, krow.cy, 1, 110);
      await page.waitForTimeout(700);
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll(".kb-tabs button")].map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.textContent.trim(), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
        }));
      const opts = tabs.find((t) => t.label.includes("OPTIONS"));
      if (opts) {
        await touch.tap(opts.cx, opts.cy);
        await page.waitForTimeout(400);
        let pm = await hit(page, "#kb-perfmode");
        for (let i = 0; i < 6 && !(pm.on && pm.ok); i++) {
          const mid = await page.evaluate(() => {
            const p = document.querySelector("#keys .panel");
            const r = p.getBoundingClientRect();
            return { cx: Math.round(r.x + r.width / 2), cy: Math.round(Math.min(r.y + r.height - 30, innerHeight - 40)) };
          });
          await touch.drag(mid.cx, mid.cy, mid.cx, Math.max(60, mid.cy - 150), { steps: 8, holdMs: 24 });
          await page.waitForTimeout(400);
          pm = await hit(page, "#kb-perfmode");
        }
        if (pm.on && pm.ok) {
          const before = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
          await touch.tap(pm.cx, pm.cy);
          await page.waitForTimeout(500);
          const after = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
          rec("pixel5", "SYSTEM perf mode row reachable + cycles by touch", after !== before ? "PASS" : "FAIL", `${before} -> ${after}`);
        } else rec("pixel5", "SYSTEM perf mode row reachable + cycles by touch", "FAIL", JSON.stringify(pm));
      } else rec("pixel5", "OPTIONS tab", "FAIL", JSON.stringify(tabs));
      const x = await hit(page, "#keys .tp-x");
      if (x.ok) { await touch.tap(x.cx, x.cy); await page.waitForTimeout(400); }
    } else rec("pixel5", "keybinds row", "FAIL", "missing");

    // --- stage a death -> RESULT CARD ---
    await page.evaluate(() => {
      const s = window.__dcc.state, p = s.players[0];
      const live = s.monsters.filter((m) => !m.dormant && m.hp > 0);
      if (live.length) { p.pos.x = live[0].pos.x + 0.3; p.pos.y = live[0].pos.y + 0.3; }
      p.hp = 1;
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("recap")).display === "flex", null, { timeout: 90000 });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUT}/pixel5-recap.png` });
    const again = await hit(page, "#recap-again");
    rec("pixel5", "RESULT CARD: RUN IT BACK pinned on-glass >=44", again.ok && again.on && again.h >= 44 ? "PASS" : "FAIL", JSON.stringify(again));
    let share = await hit(page, "#recap-share");
    if (!(share.on && share.ok)) {
      await page.evaluate(() => document.getElementById("recap-share").scrollIntoView({ block: "center" }));
      await page.waitForTimeout(400);
      share = await hit(page, "#recap-share");
    }
    rec("pixel5", "RESULT CARD: SHARE reachable", share.on && share.ok ? "PASS" : "FAIL", JSON.stringify(share));
    if (share.ok) {
      await touch.tap(share.cx, share.cy, 1, 100);
      await page.waitForTimeout(1000);
      const on = await page.evaluate(() => document.getElementById("sharesheet").classList.contains("on"));
      if (on) {
        await page.screenshot({ path: `${OUT}/pixel5-sharesheet.png` });
        const btns = {};
        for (const id of ["share-card", "share-copy", "share-save", "share-close"]) btns[id] = await hit(page, `#${id}`);
        const allOn = Object.values(btns).every((b) => b.on && b.ok && b.h >= 44);
        rec("pixel5", "sharesheet: all four actions on-glass >=44 hit-tested", allOn ? "PASS" : "FAIL", JSON.stringify(btns));
        await touch.tap(btns["share-copy"].cx, btns["share-copy"].cy, 1, 90);
        await page.waitForTimeout(600);
        const copyTxt = await page.evaluate(() => document.getElementById("share-copy").textContent);
        rec("pixel5", "sharesheet COPY acknowledges", /COPIED|FAILED/.test(copyTxt) ? "PASS" : "FAIL", copyTxt);
        const sx = await hit(page, "#sharesheet .tp-x");
        if (sx.ok) { await touch.tap(sx.cx, sx.cy); await page.waitForTimeout(500); }
        const off = await page.evaluate(() => !document.getElementById("sharesheet").classList.contains("on"));
        rec("pixel5", "sharesheet ✕ closes by touch", off ? "PASS" : "FAIL", JSON.stringify(sx));
      } else rec("pixel5", "sharesheet opens", "FAIL", "no .on");
    }
    rec("pixel5", "surfaces pageerrors", errs.length === 0 ? "PASS" : "FAIL", JSON.stringify(errs));
    await ctx.close();
  }

  // ============ C. STARTING GUN + DEATH DOOR (rivals, server) ==============
  {
    const CODE = "ACR" + Math.floor(Math.random() * 90000);
    const actx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const a = await actx.newPage();
    await a.goto(`${BASE}/iso.html?noassets&quality=performance&join=${CODE}&rivals&name=Alpha`, { waitUntil: "load", timeout: 90000 });
    const bctx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
    const b = await bctx.newPage();
    const berrs = [];
    b.on("pageerror", (e) => berrs.push(e.message.slice(0, 140)));
    const bclient = await bctx.newCDPSession(b);
    const btouch = touchDriver(bclient);
    await b.goto(`${BASE}/iso.html?debug=1&noassets&quality=performance&join=${CODE}&rivals&name=Bravo&safe=0,47,21,47`, { waitUntil: "load", timeout: 90000 });
    for (const p of [a, b]) await ready(p);
    await a.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), null, { timeout: 30000 });
    await b.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), null, { timeout: 30000 });
    await b.screenshot({ path: `${OUT}/iphone13-startinggun.png` });
    const gun1 = await b.evaluate(() => ({
      count: document.getElementById("rushgate-count").textContent,
      seats: [...document.querySelectorAll("#rushgate .gseat")].map((e) => e.textContent.trim()),
    }));
    await b.waitForTimeout(2400);
    const gun2 = await b.evaluate(() => document.getElementById("rushgate-count").textContent);
    rec("iphone13-rivals", "STARTING GUN: countdown ticks on the card",
      gun1.count !== gun2 && +gun1.count > 0 ? "PASS" : "FAIL", `${gun1.count} -> ${gun2} seats=${JSON.stringify(gun1.seats)}`);
    const rb = await hit(b, "#rushgate-ready");
    rec("iphone13-rivals", "STARTING GUN: READY >=44 + hit-tested", rb.ok && rb.on && rb.h >= 44 ? "PASS" : "FAIL", JSON.stringify(rb));
    await btouch.tap(rb.cx, rb.cy, 1, 110);
    await b.waitForTimeout(700);
    const held = await b.evaluate(() => document.getElementById("rushgate-ready").textContent);
    rec("iphone13-rivals", "READY acknowledges by touch", /HOLDING/.test(held) ? "PASS" : "FAIL", held);
    await a.click("#rushgate-ready");
    await a.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"), null, { timeout: 30000 });
    await b.waitForFunction(() => !document.getElementById("rushgate").classList.contains("on"), null, { timeout: 30000 });
    rec("iphone13-rivals", "the gun fires for both", "PASS", "gate cleared");

    // Alpha melees Bravo down (both spawn at the floor entry)
    const t0 = Date.now();
    let downed = false;
    const cx = 683, cy = 384;
    outer: while (Date.now() - t0 < 150000) {
      for (const [dx, dy] of [[40, 0], [28, 28], [0, 40], [-28, 28], [-40, 0], [-28, -28], [0, -40], [28, -28]]) {
        await a.mouse.move(cx + dx, cy + dy);
        await a.mouse.down();
        await a.waitForTimeout(900);
        await a.mouse.up();
        const state = await b.evaluate(() => document.getElementById("downed")?.dataset.mode ?? "");
        if (state === "downed" || state === "conceded") { downed = true; break outer; }
      }
    }
    rec("iphone13-rivals", "Bravo is DOWN (pvp)", downed ? "PASS" : "FAIL", `${Math.round((Date.now() - t0) / 1000)}s`);
    if (downed) {
      await b.screenshot({ path: `${OUT}/iphone13-deathdoor.png` });
      const fight = await hit(b, "#downed-fight");
      const conc = await hit(b, "#downed-concede");
      rec("iphone13-rivals", "DEATH DOOR: KEEP FIGHTING >=44 hit-tested", fight.ok && fight.on && fight.h >= 44 ? "PASS" : "FAIL", JSON.stringify(fight));
      rec("iphone13-rivals", "DEATH DOOR: CONCEDE >=44 hit-tested", conc.ok && conc.on && conc.h >= 44 ? "PASS" : "FAIL", JSON.stringify(conc));
      // tap CONCEDE with REAL touch (re-read the rect: the countdown re-centers)
      let conceded = false;
      for (let i = 0; i < 4 && !conceded; i++) {
        const c2 = await hit(b, "#downed-concede");
        if (c2.ok) await btouch.tap(c2.cx, c2.cy, 1, 110);
        await b.waitForTimeout(900);
        conceded = await b.evaluate(() => document.getElementById("downed")?.dataset.mode === "conceded");
      }
      rec("iphone13-rivals", "CONCEDE lands by touch -> SEAT FREED", conceded ? "PASS" : "FAIL", "");
      if (conceded) {
        await b.screenshot({ path: `${OUT}/iphone13-seatfreed.png` });
        const runback = await hit(b, "#downed-runback");
        rec("iphone13-rivals", "RUN IT BACK >=44 hit-tested", runback.ok && runback.on && runback.h >= 44 ? "PASS" : "FAIL", JSON.stringify(runback));
        if (runback.ok) {
          await btouch.tap(runback.cx, runback.cy, 1, 110);
          await b.waitForFunction(() => /[?&]runback=\d+/.test(location.search), null, { timeout: 30000 });
          await ready(b);
          const back = await b.evaluate(() => ({
            url: location.search, menu: getComputedStyle(document.getElementById("menu")).display }));
          rec("iphone13-rivals", "RUN IT BACK by touch -> solo runback, no menu detour",
            /runback=\d+/.test(back.url) && back.menu === "none" ? "PASS" : "FAIL", JSON.stringify(back));
        }
      }
    }
    rec("iphone13-rivals", "rivals pageerrors (Bravo)", berrs.length === 0 ? "PASS" : "FAIL", JSON.stringify(berrs));
    await actx.close();
    await bctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/report-surf.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.verdict === "FAIL");
console.log(`\n${results.length} checks, ${fails.length} FAIL`);
