// Follow-up probe: (a) K panel pages — flip tabs, measure the perf row and the
// CONTROLS rows properly; (b) sharesheet escape paths on a phone; (c) recap
// scroll-to-ledger-line by touch; (d) tap-to-lock diagnosis: where does the
// world tap go? ONE browser.
import { chromium, devices } from "playwright";

const BASE = "http://localhost:5286";
const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: "0,47,21,47", mmpx: 0.165 },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: "24,0,20,0", mmpx: 0.192 },
};
const rec = (d, n, v, det) => console.log(`[${v}] ${d} :: ${n} — ${det}`);

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
    async tap(x, y, id = 1, holdMs = 90) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 50)));
      await this.up(id);
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 10, holdMs = 24 } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
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
  await page.waitForTimeout(1200);
}

const browser = await chromium.launch({ headless: true });
try {
  for (const device of ["iphone13-land", "ipadpro11-land"]) {
    const ctx = await browser.newContext({ ...devices[SPECS[device].pw] });
    const page = await ctx.newPage();
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&floor=2&level=3&seed=9&safe=${SPECS[device].safe}`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);

    // ---- (a) K panel pages, done right --------------------------------------
    const tb = await page.evaluate(() => {
      const b = document.getElementById("tb-system").getBoundingClientRect();
      return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
    });
    await touch.tap(tb.cx, tb.cy, 1, 120);
    await page.waitForTimeout(600);
    const row = await page.evaluate(() => {
      const r = [...document.querySelectorAll("#tm-system .tm-row")].find((x) => x.dataset.act === "keybinds");
      const b = r.getBoundingClientRect();
      return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
    });
    await touch.tap(row.cx, row.cy);
    await page.waitForTimeout(800);
    const pages = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".kb-tabs button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { label: b.textContent.trim(), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const vis = [...document.querySelectorAll(".kb-page")].map((p) => ({ id: p.id, visible: getComputedStyle(p).display !== "none" }));
      return { tabs, vis };
    });
    rec(device, "kpanel: tabs + first page on coarse", "INFO", JSON.stringify(pages));
    const smallTabs = pages.tabs.filter((t) => t.h < 44);
    rec(device, "kpanel: tab touch size >=44px", smallTabs.length ? "FAIL" : "PASS",
      pages.tabs.map((t) => `${t.label} ${t.w}x${t.h}`).join(", "));
    // flip to the page that holds the perf row (OPTIONS)
    for (const want of ["OPTIONS", "CONTROLS"]) {
      const t = pages.tabs.find((x) => x.label.toUpperCase().includes(want));
      if (!t) { rec(device, `kpanel: ${want} tab`, "FAIL", "no such tab"); continue; }
      await touch.tap(t.cx, t.cy);
      await page.waitForTimeout(500);
      if (want === "OPTIONS") {
        const perf = await page.evaluate(() => {
          const el = document.getElementById("kb-perfmode");
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          const rowEl = el.closest(".kb-row");
          const rr = rowEl ? rowEl.getBoundingClientRect() : null;
          return { w: Math.round(r.width), h: Math.round(r.height), onScreen: r.bottom <= innerHeight && r.top >= 0,
            hit: !!at && (at === el || el.contains(at)), text: el.textContent,
            rowH: rr ? Math.round(rr.height) : 0, rowBottom: rr ? Math.round(rr.bottom) : 0, vh: innerHeight };
        });
        rec(device, "kpanel: perf row measured on OPTIONS", perf.w > 0 ? "INFO" : "FAIL", JSON.stringify(perf));
        if (perf.w > 0 && perf.hit) {
          const r0 = await page.evaluate(() => {
            const r = document.getElementById("kb-perfmode").getBoundingClientRect();
            return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
          });
          const before = perf.text;
          await touch.tap(r0.cx, r0.cy);
          await page.waitForTimeout(400);
          const after = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
          rec(device, "kpanel: perf row cycles on a finger tap", after !== before ? "PASS" : "FAIL", `"${before}" -> "${after}"`);
          const small = Math.min(perf.w, perf.h) < 44;
          rec(device, "kpanel: perf row hit target size", small ? "FAIL" : "PASS", `${perf.w}x${perf.h}px`);
        }
      } else {
        const rows = await page.evaluate(() => {
          const page = document.getElementById("kb-page-controls");
          if (!page) return { pageExists: false };
          const all = [...page.querySelectorAll("*")].filter((e) => e.children.length === 0).length;
          const rows = [...page.querySelectorAll(".kb-row")].map((r) => {
            const key = r.querySelector(".kb-key");
            const kb = key ? key.getBoundingClientRect() : null;
            const at = kb ? document.elementFromPoint(kb.x + kb.width / 2, kb.y + kb.height / 2) : null;
            return { name: (r.querySelector(".kb-name")?.childNodes[0]?.textContent ?? "").trim().slice(0, 22),
              keyW: kb ? Math.round(kb.width) : 0, keyH: kb ? Math.round(kb.height) : 0,
              hit: !!at && !!key && (key.contains(at) || at === key),
              onScreen: kb ? kb.bottom <= innerHeight && kb.top >= 0 : false };
          });
          return { pageExists: true, visible: getComputedStyle(page).display !== "none", leafCount: all, rows };
        });
        if (!rows.pageExists || !rows.rows.length) {
          rec(device, "kpanel: CONTROLS rows", "FAIL", JSON.stringify(rows).slice(0, 200));
        } else {
          const bad = rows.rows.filter((r) => r.keyH && (r.keyH < 44 || !r.hit || !r.onScreen));
          rec(device, "kpanel: CONTROLS rows tappable >=44px", bad.length ? "FAIL" : "PASS",
            `${rows.rows.length} rows; offenders: ${JSON.stringify(bad.slice(0, 8))}`);
          // handedness toggle + persistence
          const handed = rows.rows.findIndex((r) => /Handedness/i.test(r.name));
          if (handed >= 0) {
            const pt = await page.evaluate((i) => {
              const r = [...document.querySelectorAll("#kb-page-controls .kb-row")][i].querySelector(".kb-key").getBoundingClientRect();
              return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
            }, handed);
            await touch.tap(pt.cx, pt.cy);
            await page.waitForTimeout(600);
            const flip = await page.evaluate(() => ({
              left: document.body.classList.contains("handed-left"),
              store: Object.keys(localStorage).filter((k) => /touch/i.test(k)).map((k) => `${k}=${(localStorage.getItem(k) ?? "").slice(0, 90)}`),
            }));
            rec(device, "kpanel: handedness flips + persists", flip.left && flip.store.some((s) => /left/.test(s)) ? "PASS" : "FAIL",
              JSON.stringify(flip).slice(0, 220));
            await touch.tap(pt.cx, pt.cy); // flip back
            await page.waitForTimeout(300);
          }
        }
      }
    }

    // ---- (d) tap-to-lock diagnosis ------------------------------------------
    // close the panel first (touch ✕ if present)
    await page.evaluate(() => {
      const x = document.querySelector("#keys .tp-x, #keys button.tp-x");
      if (x) x.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(500);
    const diag = await page.evaluate(() => {
      const d = window.__dcc, s = d.state, r = d.renderer;
      const z = d.touch.zones;
      const p0 = s.players[0];
      p0.hp = p0.maxHp;
      for (const m of s.monsters) { m.speed = 0; }
      const g = r.screenToGround(z.worldZone.x + z.worldZone.w * 0.45, z.worldZone.y + z.worldZone.h * 0.55);
      const m = s.monsters.find((m) => m.hp > 0 && !m.dormant);
      if (!g || !m) return null;
      m.pos.x = g.x; m.pos.y = g.y;
      const p = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
      return {
        mob: m.id, x: Math.round(p.x), y: Math.round(p.y),
        inWorldZone: p.x >= z.worldZone.x && p.x <= z.worldZone.x + z.worldZone.w && p.y >= z.worldZone.y && p.y <= z.worldZone.y + z.worldZone.h,
        zones: { world: z.worldZone, stick: z.stickZone },
        control: d.touch.controlAt(p.x, p.y) ?? null,
        elem: (() => { const e = document.elementFromPoint(p.x, p.y); return e ? `${e.tagName}#${e.id}.${[...e.classList].join(".")}` : "none"; })(),
      };
    });
    rec(device, "lockdiag: staged point", "INFO", JSON.stringify(diag));
    if (diag) {
      await touch.tap(diag.x, diag.y, 1, 100);
      await page.waitForTimeout(600);
      const v = await page.evaluate((id) => {
        const d = window.__dcc;
        const m = d.state.monsters.find((m) => m.id === id);
        const p = m ? d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y) : null;
        return { locked: d.touch.lockedTargetId, tap: d.touch.lastWorldTap,
          mobNow: p ? { x: Math.round(p.x), y: Math.round(p.y) } : null,
          mobPos: m ? { x: +m.pos.x.toFixed(1), y: +m.pos.y.toFixed(1) } : null };
      }, diag.mob);
      const drift = v.mobNow ? Math.hypot(v.mobNow.x - diag.x, v.mobNow.y - diag.y) : -1;
      rec(device, "lockdiag: tap verdict", v.locked === diag.mob ? "PASS" : "FAIL",
        `locked=${v.locked}; tapDelivered=${!!v.tap}; drift=${drift.toFixed(0)}px; ${JSON.stringify(v).slice(0, 220)}`);
    }

    // ---- (b)+(c) phone only: sharesheet escape + recap scroll ---------------
    if (device === "iphone13-land") {
      const p2 = await ctx.newPage();
      const c2 = await ctx.newCDPSession(p2);
      const t2 = touchDriver(c2);
      await p2.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=6&level=3&gear=0&seed=41&safe=${SPECS[device].safe}`,
        { waitUntil: "load", timeout: 90000 });
      await ready(p2);
      await p2.evaluate(() => {
        const s = window.__dcc.state, p = s.players[0];
        const live = s.monsters.filter((m) => !m.dormant && m.hp > 0);
        if (live.length) { p.pos.x = live[0].pos.x + 0.3; p.pos.y = live[0].pos.y + 0.3; }
        p.hp = Math.min(p.hp, 40);
      });
      await p2.waitForFunction(() => getComputedStyle(document.getElementById("recap")).display === "flex", null, { timeout: 60000 });
      await p2.waitForTimeout(1200);
      // (c) can a drag scroll the recap to the ledger line?
      const before = await p2.evaluate(() => {
        const e = document.getElementById("recap-earned").getBoundingClientRect();
        const sc = document.querySelector("#recap .panel") ?? document.getElementById("recap");
        return { y: Math.round(e.y), scrollTop: sc.scrollTop, scroller: sc.id || sc.className };
      });
      await t2.drag(375, 260, 375, 80, { steps: 8, holdMs: 30 });
      await p2.waitForTimeout(500);
      const after = await p2.evaluate(() => {
        const e = document.getElementById("recap-earned").getBoundingClientRect();
        const vis = e.top >= 0 && e.bottom <= innerHeight;
        return { y: Math.round(e.y), visible: vis };
      });
      rec(device, "recap: touch drag scrolls to the ledger line",
        after.y < before.y - 20 || after.visible ? (after.visible ? "PASS" : "INFO") : "FAIL",
        `earned y ${before.y} -> ${after.y}, visible=${after.visible}, scroller=${before.scroller}`);
      // (b) open sharesheet, try backdrop tap then swipe-down to escape
      const share = await p2.evaluate(() => {
        const r = document.getElementById("recap-share").getBoundingClientRect();
        return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), visible: r.width > 0 && r.top >= 0 && r.bottom <= innerHeight };
      });
      if (share.visible) {
        await t2.tap(share.cx, share.cy);
        await p2.waitForTimeout(700);
        const open = await p2.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
        if (open) {
          const sheetInfo = await p2.evaluate(() => {
            const sh = document.getElementById("sharesheet");
            const panel = sh.querySelector(".panel") ?? sh;
            const r = panel.getBoundingClientRect();
            const btn = document.getElementById("share-copy").getBoundingClientRect();
            return { panel: { y: Math.round(r.y), h: Math.round(r.height) }, vh: innerHeight,
              copyY: Math.round(btn.y), scrollable: panel.scrollHeight > panel.clientHeight + 2, overflowY: getComputedStyle(panel).overflowY };
          });
          rec(device, "sharesheet: geometry", "INFO", JSON.stringify(sheetInfo));
          // does an inner drag bring the buttons up?
          await t2.drag(375, 280, 375, 60, { steps: 8, holdMs: 30 });
          await p2.waitForTimeout(400);
          const copyNow = await p2.evaluate(() => {
            const b = document.getElementById("share-copy").getBoundingClientRect();
            const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
            const el = document.getElementById("share-copy");
            return { y: Math.round(b.y), reachable: b.top >= 0 && b.bottom <= innerHeight && !!at && (at === el || el.contains(at)) };
          });
          rec(device, "sharesheet: drag brings COPY on screen", copyNow.reachable ? "PASS" : "FAIL", JSON.stringify(copyNow));
          // backdrop tap escape
          await t2.tap(40, 40);
          await p2.waitForTimeout(500);
          let still = await p2.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
          rec(device, "sharesheet: backdrop tap closes", still ? "FAIL" : "PASS", `still open=${still}`);
        }
      } else {
        rec(device, "sharesheet: escape checks", "UNESTABLISHED", "SHARE button not visible on this staging");
      }
      await p2.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
