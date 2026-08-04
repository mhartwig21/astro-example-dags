// NEW-SURFACES TOUCH AUDIT (mobile-wr round): every surface shipped since the
// last touch pass, driven with REAL CDP touch on emulated devices, hit-TESTED
// (elementFromPoint at the target centre), never rect-trusted.
//
// Surfaces: menu RUSH tile, THE RUSH queue -> READY card (#rushgate) +
// STARTING GUN countdown, DEATH IS A DOOR (#downed), THE RESULT CARD
// (#recap + ledger line + #sharesheet), THE ONRAMP, SYSTEM panel performance
// row + touch customisation rows, quality auto-select on a phone.
//
// ONE Chromium (machine rule). Expects vite :5286 + game server :5281.
// usage: node tools/_mobile/wrsurf.mjs
import { chromium, devices } from "playwright";

const BASE = "http://localhost:5286";
const OUT = "tools/_mobile/wr-surf";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: "0,47,21,47", mmpx: 0.165, cls: "phone" },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: "0,24,0,0", mmpx: 0.163, cls: "compact" },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: "24,0,20,0", mmpx: 0.192, cls: "tablet-s" },
};

const results = [];
const rec = (device, name, verdict, detail) => {
  results.push({ device, name, verdict, detail });
  console.log(`[${verdict}] ${device} :: ${name} — ${detail}`);
};

// ---- touch driver (the corrected one: touchEnd carries the RELEASED point)
function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });
  const api = {
    tick(ms) { clock += ms / 1000; return api; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [],
        timestamp: clock,
      });
    },
    async tap(x, y, id = 1, holdMs = 80) {
      await api.down(id, x, y); api.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 50)));
      await api.up(id);
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 10, holdMs = 24, release = true } = opts;
      await api.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        api.tick(holdMs);
        await api.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (release) await api.up(id);
    },
  };
  return api;
}

// ---- hit-test: rect AND elementFromPoint at the centre must agree ---------
const HIT_FN = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { exists: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const at = document.elementFromPoint(cx, cy);
  const hit = !!at && (at === el || el.contains(at) || at.contains(el));
  return {
    exists: true, w: Math.round(r.width), h: Math.round(r.height),
    cx: Math.round(cx), cy: Math.round(cy),
    visible: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0,
    onScreen: r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
    hit, coveredBy: hit ? null : (at ? `${at.tagName}#${at.id || ""}.${[...at.classList].join(".")}` : "nothing"),
    text: (el.textContent ?? "").trim().slice(0, 80),
  };
};

async function hit(page, sel) { return page.evaluate(HIT_FN, sel); }

function judgeTarget(device, name, h, minPx = 44) {
  const mm = SPECS[device].mmpx;
  if (!h.exists || !h.visible) return rec(device, name, "FAIL", `absent/invisible: ${JSON.stringify(h)}`);
  if (!h.onScreen) return rec(device, name, "FAIL", `off-screen at (${h.cx},${h.cy}) ${h.w}x${h.h}`);
  if (!h.hit) return rec(device, name, "FAIL", `occluded by ${h.coveredBy} at centre (${h.cx},${h.cy})`);
  const small = Math.min(h.w, h.h) < minPx;
  rec(device, name, small ? "FAIL" : "PASS",
    `${h.w}x${h.h}px (${(h.w * mm).toFixed(1)}x${(h.h * mm).toFixed(1)}mm) at (${h.cx},${h.cy}), hit-tested clean${small ? ` — UNDER ${minPx}px floor` : ""}`);
  return h;
}

const noScroll = (page) => page.evaluate(() => ({
  x: document.documentElement.scrollWidth <= innerWidth + 1,
  y: document.documentElement.scrollHeight <= innerHeight + 1,
}));

async function ready(page, { menu = false } = {}) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const box = await page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return null;
    const r = l.getBoundingClientRect();
    return getComputedStyle(l).display !== "none" && r.width > 0 ? { w: r.width, h: r.height } : null;
  });
  if (box) throw new Error(`#loading still has a box: ${JSON.stringify(box)}`);
}

async function bootCtx(browser, device, url) {
  const ctx = await browser.newContext({ ...devices[SPECS[device].pw] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror ${device}]`, String(e.message).slice(0, 160)));
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  return { ctx, page, touch };
}

const browser = await chromium.launch({ headless: true });
const DAY = new Date().toISOString().slice(0, 10);

try {
  // =============== S1: MENU — RUSH tile + campfire on glass =================
  for (const device of ["iphone13-land", "pixel5-land"]) {
    const { ctx, page } = await bootCtx(browser, device,
      `${BASE}/iso.html?noassets&safe=${SPECS[device].safe}`);
    await ready(page, { menu: true });
    const ns = await noScroll(page);
    rec(device, "menu: no scrollbars", ns.x && ns.y ? "PASS" : "FAIL", JSON.stringify(ns));
    const rush = judgeTarget(device, "menu: RUSH tile tappable", await hit(page, "#m-rush"));
    judgeTarget(device, "menu: NEW RUN tile tappable", await hit(page, "#m-solo"));
    const sub = await page.evaluate(() => document.getElementById("m-rush-sub")?.textContent ?? "");
    rec(device, "menu: RUSH sub honest without/with server", /rotates|claims a seat|FORMING/i.test(sub) ? "PASS" : "FAIL", sub.slice(0, 90));
    await page.screenshot({ path: `${OUT}/${device}-menu.png` });
    await ctx.close();
  }

  // =============== S2: READY CARD + STARTING GUN (server) ===================
  // Two seats in one race; A READYs (ack must be instant), B READYs (gun).
  for (const device of ["iphone13-land", "pixel5-land", "ipadpro11-land"]) {
    const CODE = `DAILY-${DAY}-WR${Math.floor(Math.random() * 90000)}`;
    const a = await bootCtx(browser, device,
      `${BASE}/iso.html?noassets&join=${CODE}&rivals&name=WRA&safe=${SPECS[device].safe}`);
    await ready(a.page);
    const gateOn = await a.page.waitForFunction(
      () => document.getElementById("rushgate")?.classList.contains("on"), null, { timeout: 30000 })
      .then(() => true).catch(() => false);
    rec(device, "rushgate: READY card appears", gateOn ? "PASS" : "FAIL", `join=${CODE}`);
    if (gateOn) {
      const count = await hit(a.page, "#rushgate-count");
      rec(device, "rushgate: countdown visible + numeric", count.visible && /^\d+$/.test(count.text) ? "PASS" : "FAIL",
        `text="${count.text}" at (${count.cx},${count.cy})`);
      const rule = await hit(a.page, "#rushgate-rule");
      rec(device, "rushgate: TODAY'S RULE printed on the card", rule.exists && rule.visible && rule.text.length > 10 ? "PASS" : "FAIL",
        rule.text?.slice(0, 70) ?? "absent");
      const fit = await a.page.evaluate(() => {
        const g = document.getElementById("rushgate").getBoundingClientRect();
        return { top: Math.round(g.top), bottom: Math.round(g.bottom), vh: innerHeight, fits: g.top >= -1 && g.bottom <= innerHeight + 1 };
      });
      rec(device, "rushgate: card fits the viewport", fit.fits ? "PASS" : "FAIL", JSON.stringify(fit));
      const btn = judgeTarget(device, "rushgate: READY button tappable", await hit(a.page, "#rushgate-ready"));
      await a.page.screenshot({ path: `${OUT}/${device}-rushgate.png` });
      if (btn && btn.hit) {
        await a.touch.tap(btn.cx, btn.cy);
        const ack = await a.page.evaluate(() => {
          const b = document.getElementById("rushgate-ready");
          return { disabled: b.disabled, text: b.textContent };
        });
        rec(device, "rushgate: READY acknowledges instantly", ack.disabled && /HOLDING/i.test(ack.text) ? "PASS" : "FAIL",
          JSON.stringify(ack));
      }
      // Seat B fires the gun (same browser, second page — machine rule holds).
      const b = await bootCtx(browser, device,
        `${BASE}/iso.html?noassets&join=${CODE}&rivals&name=WRB&safe=${SPECS[device].safe}`);
      await ready(b.page);
      await b.page.waitForFunction(() => document.getElementById("rushgate")?.classList.contains("on"), null, { timeout: 20000 }).catch(() => {});
      const btnB = await hit(b.page, "#rushgate-ready");
      if (btnB.hit) await b.touch.tap(btnB.cx, btnB.cy);
      const gun = await a.page.waitForFunction(
        () => !document.getElementById("rushgate").classList.contains("on"), null, { timeout: 15000 })
        .then(() => true).catch(() => false);
      rec(device, "startinggun: both READY fires the gun", gun ? "PASS" : "FAIL", "gate cleared on seat A");
      if (gun) await a.page.screenshot({ path: `${OUT}/${device}-postgun.png` });

      // ---------- S3: DEATH IS A DOOR (iphone13 only, post-gun) ----------
      if (device === "iphone13-land" && gun) {
        const V = a.page.viewportSize();
        const deadline = Date.now() + 150000;
        let downed = false;
        while (Date.now() < deadline) {
          // walk toward the nearest live monster with the real stick
          const dir = await a.page.evaluate(() => {
            const s = window.__dcc?.state; if (!s) return null;
            const p = s.players[0]; if (!p) return null;
            if (p.alive === false || (p.downedT ?? 0) > 0) return "downed";
            const live = (s.monsters ?? []).filter((m) => !m.dormant && m.hp > 0);
            if (!live.length) return null;
            live.sort((x, y) => Math.hypot(x.pos.x - p.pos.x, x.pos.y - p.pos.y) - Math.hypot(y.pos.x - p.pos.x, y.pos.y - p.pos.y));
            const m = live[0];
            return { dx: m.pos.x - p.pos.x, dy: m.pos.y - p.pos.y };
          });
          if (dir === "downed") { downed = true; break; }
          if (!dir) { await a.page.waitForTimeout(700); continue; }
          // iso-inverse-ish: screen drag = world dir rotated -45deg (good enough to close distance)
          const ang = Math.atan2(dir.dy, dir.dx) - Math.PI / 4;
          const sx = Math.round(V.width * 0.22), sy = Math.round(V.height * 0.62);
          await a.touch.drag(sx, sy, sx + Math.cos(ang) * 70, sy + Math.sin(ang) * 70, { steps: 4, holdMs: 40, release: false, id: 9 });
          await a.page.waitForTimeout(1400);
          await a.touch.up(9);
        }
        if (!downed) {
          rec(device, "deathdoor: reach the downed screen", "UNESTABLISHED", "crawler did not die within 150s of walking into packs");
        } else {
          await a.page.waitForTimeout(400);
          const fight = judgeTarget(device, "deathdoor: KEEP FIGHTING tappable", await hit(a.page, "#downed-fight"));
          const conc = judgeTarget(device, "deathdoor: CONCEDE tappable", await hit(a.page, "#downed-concede"));
          await a.page.screenshot({ path: `${OUT}/${device}-downed.png` });
          if (conc && conc.hit) {
            await a.touch.tap(conc.cx, conc.cy);
            const seat = await a.page.waitForFunction(
              () => document.getElementById("downed")?.dataset.mode === "conceded", null, { timeout: 10000 })
              .then(() => true).catch(() => false);
            rec(device, "deathdoor: CONCEDE flips to SEAT FREED", seat ? "PASS" : "FAIL", "dataset.mode=conceded");
            if (seat) {
              judgeTarget(device, "deathdoor: RUN IT BACK tappable", await hit(a.page, "#downed-runback"));
              await a.page.screenshot({ path: `${OUT}/${device}-conceded.png` });
            }
          }
        }
      }
      await b.ctx.close();
    }
    await a.ctx.close();
  }

  // =============== S4: RESULT CARD + LEDGER LINE + SHARESHEET ===============
  for (const device of ["iphone13-land", "ipadpro11-land"]) {
    const { ctx, page, touch } = await bootCtx(browser, device,
      `${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=6&level=3&gear=0&seed=41&safe=${SPECS[device].safe}`);
    await ready(page);
    // die honestly: walk the level-3 unarmed crawler onto the nearest pack
    await page.evaluate(() => {
      const s = window.__dcc.state, p = s.players[0];
      const live = s.monsters.filter((m) => !m.dormant && m.hp > 0);
      if (live.length) { p.pos.x = live[0].pos.x + 0.3; p.pos.y = live[0].pos.y + 0.3; }
      p.hp = Math.min(p.hp, 40);
    });
    const dead = await page.waitForFunction(
      () => window.__dcc.state.status === "dead" || getComputedStyle(document.getElementById("recap")).display === "flex",
      null, { timeout: 60000 }).then(() => true).catch(() => false);
    if (!dead) { rec(device, "resultcard: stage a death", "UNESTABLISHED", "crawler survived 60s in a pack"); await ctx.close(); continue; }
    await page.waitForFunction(() => getComputedStyle(document.getElementById("recap")).display === "flex", null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const fit = await page.evaluate(() => {
      const r = document.querySelector("#recap .panel, #recap")?.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
    });
    rec(device, "resultcard: recap on screen", fit.bottom > 0 ? "PASS" : "FAIL", JSON.stringify(fit));
    const earned = await hit(page, "#recap-earned");
    rec(device, "resultcard: CRAWL LEDGER line visible + on-screen", earned.exists && earned.visible && earned.onScreen && earned.text.length > 5 ? "PASS" : "FAIL",
      `"${earned.text}" at (${earned.cx},${earned.cy})`);
    const death = await hit(page, "#recap-death-head");
    rec(device, "resultcard: named death visible", death.visible && death.text.length > 3 ? "PASS" : "FAIL", `"${death.text}"`);
    const share = judgeTarget(device, "resultcard: SHARE tappable", await hit(page, "#recap-share"));
    await page.screenshot({ path: `${OUT}/${device}-recap.png` });
    if (share && share.hit) {
      await touch.tap(share.cx, share.cy);
      await page.waitForTimeout(700);
      const sheet = await page.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
      rec(device, "sharesheet: opens from a finger", sheet ? "PASS" : "FAIL", "");
      if (sheet) {
        const txt = await page.evaluate(() => (document.getElementById("share-text")?.textContent ?? "").trim());
        rec(device, "sharesheet: card text present", txt.length > 20 ? "PASS" : "FAIL", txt.slice(0, 70));
        judgeTarget(device, "sharesheet: COPY CARD tappable", await hit(page, "#share-copy"));
        judgeTarget(device, "sharesheet: SAVE tappable", await hit(page, "#share-save"));
        const close = judgeTarget(device, "sharesheet: CLOSE tappable", await hit(page, "#share-close"));
        const ns2 = await noScroll(page);
        rec(device, "sharesheet: no scrollbars", ns2.x && ns2.y ? "PASS" : "FAIL", JSON.stringify(ns2));
        await page.screenshot({ path: `${OUT}/${device}-sharesheet.png` });
        if (close && close.hit) {
          await touch.tap(close.cx, close.cy);
          await page.waitForTimeout(500);
          const gone = await page.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display === "none");
          rec(device, "sharesheet: CLOSE closes", gone ? "PASS" : "FAIL", "");
        }
      }
    }
    await ctx.close();
  }

  // =============== S5: THE ONRAMP (fresh meat, touch) ========================
  for (const device of ["iphone13-land", "pixel5-land"]) {
    const { ctx, page, touch } = await bootCtx(browser, device,
      `${BASE}/iso.html?noassets&safe=${SPECS[device].safe}`);
    await ready(page, { menu: true });
    const solo = await hit(page, "#m-solo");
    if (!solo.hit) { rec(device, "onramp: NEW RUN reachable", "FAIL", JSON.stringify(solo)); await ctx.close(); continue; }
    await touch.tap(solo.cx, solo.cy);
    await page.waitForTimeout(900);
    const go = judgeTarget(device, "onramp: casting GO button tappable", await hit(page, "#m-cast-go"));
    if (go && go.hit) {
      await touch.tap(go.cx, go.cy);
      await page.waitForTimeout(2500);
      const card = await page.evaluate(() => {
        const t = document.getElementById("tutorial");
        if (!t) return { present: false };
        const cs = getComputedStyle(t);
        const r = t.getBoundingClientRect();
        const zone = document.getElementById("t-stickzone")?.getBoundingClientRect();
        const overlap = zone && r.width > 0
          ? Math.max(0, Math.min(r.bottom, zone.bottom) - Math.max(r.top, zone.top)) *
            Math.max(0, Math.min(r.right, zone.right) - Math.max(r.left, zone.left))
          : 0;
        return {
          present: cs.display !== "none" && r.width > 0,
          text: (t.textContent ?? "").trim().slice(0, 120),
          top: Math.round(r.top), left: Math.round(r.left),
          stickOverlapPx: Math.round(overlap),
        };
      });
      rec(device, "onramp: start line appears on the glass", card.present ? "PASS" : "FAIL", card.text ?? "");
      if (card.present) {
        rec(device, "onramp: line names the glass (not a keyboard)",
          /glass|thumb|left half|touch|drag/i.test(card.text) && !/WASD|W A S D/i.test(card.text) ? "PASS" : "FAIL", card.text);
        rec(device, "onramp: card clear of the movement thumb", card.stickOverlapPx === 0 ? "PASS" : "FAIL",
          `overlap ${card.stickOverlapPx}px^2 with #t-stickzone (card at ${card.left},${card.top})`);
      }
      // natural stick point must still be the stick zone, not a card button
      const V = page.viewportSize();
      const under = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName}#${el.id || ""}.${[...el.classList].join(".")}` : "none";
      }, [Math.round(V.width * 0.18), Math.round(V.height * 0.72)]);
      rec(device, "onramp: natural stick point unoccluded", /stickzone|CANVAS|CANVAS#c3d|BODY/i.test(under) ? "PASS" : "FAIL", under);
      const before = await page.evaluate(() => ({ ...window.__dcc?.state?.players?.[0]?.pos ?? {} }));
      await touch.drag(Math.round(V.width * 0.18), Math.round(V.height * 0.68),
        Math.round(V.width * 0.18) + 60, Math.round(V.height * 0.68) - 30, { steps: 8, holdMs: 40, release: false, id: 3 });
      await page.waitForTimeout(1200);
      await touch.up(3);
      const after = await page.evaluate(() => ({ ...window.__dcc?.state?.players?.[0]?.pos ?? {} }));
      const d = before.x !== undefined ? Math.hypot((after.x ?? 0) - before.x, (after.y ?? 0) - before.y) : -1;
      rec(device, "onramp: first drag moves the crawler", d > 0.3 ? "PASS" : (d < 0 ? "UNESTABLISHED" : "FAIL"),
        d < 0 ? "no debug state (no ?test) — position unreadable" : `moved ${d.toFixed(2)} tiles`);
      await page.screenshot({ path: `${OUT}/${device}-onramp.png` });
    }
    await ctx.close();
  }

  // =============== S6+S7: SYSTEM PANEL, PERF ROW, CUSTOMISATION, AUTO QUALITY =
  for (const device of ["iphone13-land", "ipadpro11-land"]) {
    const { ctx, page, touch } = await bootCtx(browser, device,
      `${BASE}/iso.html?test&debug=1&noassets&floor=2&level=3&seed=9&safe=${SPECS[device].safe}`);
    await ready(page);
    // quality auto-select: no ?quality pin -> what did the tuner land on?
    const q = await page.evaluate(() => {
      const r = window.__dcc?.renderer;
      return r ? { setting: r.qualitySetting, live: r.qualityProfile?.label } : null;
    });
    rec(device, "quality: auto preset on this class", q ? "INFO" : "FAIL", JSON.stringify(q));
    // open SYSTEM top menu by touch
    const tb = await hit(page, "#tb-system");
    judgeTarget(device, "system: SYSTEM top button tappable", tb);
    if (tb.hit) {
      await touch.tap(tb.cx, tb.cy, 1, 120);
      await page.waitForTimeout(700);
      const row = await page.evaluate(() => {
        const r = [...document.querySelectorAll("#tm-system .tm-row")].find((x) => x.dataset.act === "keybinds");
        if (!r) return null;
        const b = r.getBoundingClientRect();
        const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2), h: Math.round(b.height), hit: !!at && r.contains(at) };
      });
      rec(device, "system: Key Bindings & Options row tappable", row?.hit && row.h >= 44 ? "PASS" : "FAIL", JSON.stringify(row));
      if (row?.hit) {
        await touch.tap(row.cx, row.cy);
        await page.waitForTimeout(900);
        const open = await page.evaluate(() => getComputedStyle(document.getElementById("keys")).display !== "none");
        rec(device, "system: K panel opens by touch", open ? "PASS" : "FAIL", "");
        if (open) {
          // which page opened first on coarse? then the perf row
          const perf = await hit(page, "#kb-perfmode");
          if (!perf.onScreen || !perf.hit) {
            // it may live on another page: tap the OPTIONS tab
            const tab = await page.evaluate(() => {
              const t = [...document.querySelectorAll(".kb-tabs button")].map((b) => {
                const r = b.getBoundingClientRect();
                return { label: b.textContent.trim(), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), h: Math.round(r.height) };
              });
              return t;
            });
            rec(device, "system: K panel tabs present", tab.length >= 3 ? "PASS" : "FAIL", JSON.stringify(tab));
            const opts = tab.find((t) => /OPTION|KEY/i.test(t.label));
            if (opts) { await touch.tap(opts.cx, opts.cy); await page.waitForTimeout(500); }
          }
          const perf2 = await hit(page, "#kb-perfmode");
          judgeTarget(device, "system: performance-mode row tappable", perf2);
          if (perf2.hit) {
            const beforeQ = perf2.text;
            await touch.tap(perf2.cx, perf2.cy);
            await page.waitForTimeout(400);
            const afterQ = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
            rec(device, "system: perf row cycles on tap", afterQ !== beforeQ ? "PASS" : "FAIL", `"${beforeQ}" -> "${afterQ}"`);
          }
          // CONTROLS page: customisation rows
          const ctab = await page.evaluate(() => {
            const b = [...document.querySelectorAll(".kb-tabs button")].find((x) => /CONTROLS/i.test(x.textContent));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
          });
          if (ctab) {
            await touch.tap(ctab.cx, ctab.cy);
            await page.waitForTimeout(600);
            const rows = await page.evaluate(() => {
              return [...document.querySelectorAll("#kb-page-controls .kb-row")].slice(0, 20).map((r) => {
                const b = r.getBoundingClientRect();
                const key = r.querySelector(".kb-key");
                const kb = key?.getBoundingClientRect();
                const at = kb ? document.elementFromPoint(kb.x + kb.width / 2, kb.y + kb.height / 2) : null;
                return {
                  name: (r.querySelector(".kb-name")?.childNodes[0]?.textContent ?? "").trim().slice(0, 24),
                  rowH: Math.round(b.height), keyW: kb ? Math.round(kb.width) : 0, keyH: kb ? Math.round(kb.height) : 0,
                  onScreen: b.bottom <= innerHeight + 1 && b.top >= -1,
                  hit: !!at && !!key && (key.contains(at) || at === key),
                };
              });
            });
            const bad = rows.filter((r) => r.keyH && (r.keyH < 44 || !r.hit));
            rec(device, "customisation: rows tappable at >=44px",
              rows.length && bad.length === 0 ? "PASS" : "FAIL",
              `rows=${rows.length}; offenders: ${JSON.stringify(bad.slice(0, 6))}`);
            await page.screenshot({ path: `${OUT}/${device}-controlspage.png` });
            // mirror: tap Handedness -> layout must flip
            const handed = await page.evaluate(() => {
              const r = [...document.querySelectorAll("#kb-page-controls .kb-row")].find((x) => /Handedness/i.test(x.textContent));
              const k = r?.querySelector(".kb-key");
              if (!k) return null;
              const b = k.getBoundingClientRect();
              return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
            });
            if (handed) {
              const chipBefore = await page.evaluate(() => document.querySelector("#skills .skill")?.getBoundingClientRect().x ?? -1);
              await touch.tap(handed.cx, handed.cy);
              await page.waitForTimeout(600);
              const flipped = await page.evaluate(() => document.body.classList.contains("handed-left"));
              // close the panel to measure the live cluster
              rec(device, "customisation: handedness toggles", flipped ? "PASS" : "FAIL", `body.handed-left=${flipped}`);
              // persistence: value must survive a reload
              const val = await page.evaluate(() => localStorage.getItem("dcc:touch") ?? localStorage.getItem("dcc:touchPrefs") ?? Object.keys(localStorage).filter(k => /touch/i.test(k)).map(k => `${k}=${localStorage.getItem(k)?.slice(0, 60)}`).join("|"));
              rec(device, "customisation: prefs persisted", val && /left/i.test(String(val)) ? "PASS" : "FAIL", String(val).slice(0, 100));
              // flip back
              await touch.tap(handed.cx, handed.cy);
              await page.waitForTimeout(300);
              void chipBefore;
            }
          }
        }
      }
    }
    // LEDGER by touch: Crawler menu -> The Crawl Ledger
    const tbc = await hit(page, "#tb-crawler");
    if (tbc.hit) {
      await touch.tap(tbc.cx, tbc.cy, 1, 120);
      await page.waitForTimeout(700);
      const row = await page.evaluate(() => {
        const r = [...document.querySelectorAll("#tm-crawler .tm-row")].find((x) => x.dataset.act === "ledger");
        if (!r) return null;
        const b = r.getBoundingClientRect();
        const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2), h: Math.round(b.height), hit: !!at && r.contains(at) };
      });
      rec(device, "ledger: menu row exists + tappable", row?.hit ? "PASS" : "FAIL", JSON.stringify(row));
      if (row?.hit) {
        await touch.tap(row.cx, row.cy);
        await page.waitForTimeout(800);
        const led = await page.evaluate(() => {
          const e = document.getElementById("ledger");
          const cs = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          const closers = [...e.querySelectorAll("button, .tp-x, .tp-done, [data-close]")].map((b) => `${b.className}:${(b.textContent ?? "").trim().slice(0, 12)}`);
          return { open: cs.display !== "none", fits: r.bottom <= innerHeight + 1, closers, note: (document.getElementById("ledger-body")?.textContent ?? "").trim().slice(0, 80) };
        });
        rec(device, "ledger: opens by touch + fits", led.open && led.fits ? "PASS" : "FAIL", JSON.stringify({ fits: led.fits, note: led.note }));
        rec(device, "ledger: has a touch close control", led.closers.length ? "PASS" : "FAIL", led.closers.join(", ") || "NONE");
        await page.screenshot({ path: `${OUT}/${device}-ledger.png` });
      }
    }
    await ctx.close();
  }
  // =============== S8: tap-to-lock, isolated re-drive =======================
  // The full battery FAILed this on 3 of 4 devices; re-drive with zero delay
  // between projection read and tap, and record the monster's CURRENT
  // projection at verdict time so a re-stage/camera race is visible.
  for (const device of ["iphone13-land", "ipadpro11-land"]) {
    const { ctx, page, touch } = await bootCtx(browser, device,
      `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=14&seed=77&safe=${SPECS[device].safe}`);
    await ready(page);
    for (let attempt = 0; attempt < 3; attempt++) {
      const mob = await page.evaluate(() => {
        const d = window.__dcc, s = d.state, r = d.renderer;
        const p0 = s.players[0];
        p0.hp = p0.maxHp;
        const z = d.touch.zones.worldZone;
        for (const m of s.monsters) m.speed = 0;
        const g = r.screenToGround(z.x + z.w * 0.5, z.y + z.h * 0.5);
        const m = s.monsters.find((m) => m.hp > 0 && !m.dormant);
        if (!g || !m) return null;
        m.pos.x = g.x; m.pos.y = g.y;
        const p = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
        if (!p.visible || d.touch.controlAt(p.x, p.y)) return null;
        return { id: m.id, x: Math.round(p.x), y: Math.round(p.y) };
      });
      if (!mob) { await page.waitForTimeout(500); continue; }
      await touch.tap(mob.x, mob.y, 1, 110);
      await page.waitForTimeout(700);
      const v = await page.evaluate((id) => {
        const d = window.__dcc;
        const m = d.state.monsters.find((m) => m.id === id);
        const p = m ? d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y) : null;
        return {
          locked: d.touch.lockedTargetId,
          tap: d.touch.lastWorldTap,
          nowAt: p ? { x: Math.round(p.x), y: Math.round(p.y), visible: p.visible } : null,
          alive: m ? m.hp > 0 && !m.dormant : false,
        };
      }, mob.id);
      const drift = v.nowAt ? Math.hypot(v.nowAt.x - mob.x, v.nowAt.y - mob.y) : -1;
      rec(device, `lock-retest[${attempt}]`, v.locked === mob.id ? "PASS" : "FAIL",
        `tapped #${mob.id} at (${mob.x},${mob.y}); locked=${v.locked}; drift since read=${drift.toFixed(0)}px; alive=${v.alive}; tap=${JSON.stringify(v.tap)}`);
      if (v.locked === mob.id) break;
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

import { writeFileSync } from "node:fs";
writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.verdict === "FAIL");
console.log(`\n${results.length} checks, ${fails.length} FAIL, ${results.filter((r) => r.verdict === "UNESTABLISHED").length} unestablished`);
