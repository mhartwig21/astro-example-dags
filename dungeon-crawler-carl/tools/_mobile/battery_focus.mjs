// The focus-branch mobile gate: RESULT CARD + sharesheet on iPhone 13 landscape,
// real CDP touch, hit-tested. Descended from wrsurf3.mjs, corrected to assert
// the SHIPPED r2 recap-rail spec (iso.html CSS + MOBILE.md), which is:
//   - only .rmain pins (RUN IT BACK / NEW CONTRACT on-glass at first paint);
//   - SHARE flows with the body copy and is reached by an ordinary thumb
//     scroll (wrfix1.mjs / ac_wr_surf2.mjs — the WR track's committed
//     evidence batteries — hit-test SHARE after scrolling for exactly this
//     reason; the pre-r2 "whole rail pinned" layout wrsurf3 asserted is gone
//     by design). This probe scrolls with a REAL touch drag, not
//     scrollIntoView, so the claim "a finger can reach it" is captured.
// Base URL comes from argv so this never again rots into a port-hardcoded
// copy: node tools/_mobile/battery_focus.mjs [http://localhost:5280]
import { chromium, devices } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:5280";
let failed = false;
const rec = (n, v, det) => {
  if (v === "FAIL") failed = true;
  console.log(`[${v}] iphone13-land :: ${n} — ${det}`);
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
    async tap(x, y, id = 1, holdMs = 90) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, 50)); await this.up(id);
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 10, holdMs = 26, settleMs = 0 } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (settleMs > 0) { this.tick(settleMs); await new Promise((r) => setTimeout(r, settleMs)); }
      await this.up(id);
    },
  };
}

/** Honest hit test: rect, fully-on-glass, and elementFromPoint at the centre. */
const hit = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return { exists: false };
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  const at = document.elementFromPoint(cx, cy);
  return { exists: true, cx, cy, w: Math.round(r.width), h: Math.round(r.height),
    on: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
    hit: !!at && (at === el || el.contains(at) || at.contains(el)) };
}, sel);

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=6&level=3&gear=0&seed=41&safe=0,47,21,47`,
    { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    const live = s.monsters.filter((m) => !m.dormant && m.hp > 0);
    if (live.length) { p.pos.x = live[0].pos.x + 0.3; p.pos.y = live[0].pos.y + 0.3; }
    p.hp = Math.min(p.hp, 40);
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("recap")).display === "flex", null, { timeout: 60000 });
  await page.waitForTimeout(1200);

  // r2 spec, half 1: the pinned decision row is on the glass at first paint.
  const again = await hit(page, "#recap-again");
  rec("rmain pinned: RUN IT BACK on-glass >=44px",
    again.exists && again.on && again.hit && again.h >= 44 ? "PASS" : "FAIL", JSON.stringify(again));

  // r2 spec, half 2: SHARE flows with the copy — a thumb scroll reaches it.
  let share = await hit(page, "#recap-share");
  let scrolls = 0;
  while (!(share.exists && share.on && share.hit) && scrolls < 4) {
    // Real touch drag up the middle of the panel; settled so it ends dead.
    await touch.drag(375, 240, 375, 80, { steps: 8, holdMs: 30, settleMs: 260 });
    await page.waitForTimeout(400);
    share = await hit(page, "#recap-share");
    scrolls++;
  }
  rec("SHARE reachable by thumb scroll + hit-tested",
    share.exists && share.on && share.hit ? "PASS" : "FAIL",
    `${JSON.stringify(share)} after ${scrolls} drag(s)`);

  await touch.tap(share.cx, share.cy);
  await page.waitForTimeout(800);
  const open = await page.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
  rec("sheet opens", open ? "PASS" : "FAIL", JSON.stringify({ cx: share.cx, cy: share.cy, hit: share.hit }));
  if (open) {
    const g = await page.evaluate(() => {
      const sh = document.getElementById("sharesheet");
      const panel = sh.querySelector(".panel") ?? sh;
      const cs = getComputedStyle(panel);
      const b = document.getElementById("share-copy").getBoundingClientRect();
      return { overflowY: cs.overflowY, scrollH: panel.scrollHeight, clientH: panel.clientHeight,
        copyY: Math.round(b.y), vh: innerHeight, panelTag: panel.id || panel.className };
    });
    rec("sheet geometry", "INFO", JSON.stringify(g));
    await touch.drag(375, 280, 375, 60, { steps: 8, holdMs: 30 });
    await page.waitForTimeout(500);
    const copy = await page.evaluate(() => {
      const el = document.getElementById("share-copy");
      const b = el.getBoundingClientRect();
      const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { y: Math.round(b.y), reachable: b.top >= 0 && b.bottom <= innerHeight && !!at && (at === el || el.contains(at)) };
    });
    rec("drag brings COPY reachable", copy.reachable ? "PASS" : "FAIL", JSON.stringify(copy));
    // Backdrop tap: MEASURE a scrim point (wrsurf3 hardcoded (40,40), which on
    // a 750px-wide device lands ON the 94vw card — a tap that could never
    // close anything, then a fallback that hid the miss). If the card leaves
    // no scrim on this glass, the swipe is the intended exit and says so.
    const scrim = await page.evaluate(() => {
      const sh = document.getElementById("sharesheet");
      const card = sh.querySelector(".card") ?? sh.firstElementChild;
      const r = card.getBoundingClientRect();
      if (r.left < 8) return null; // no tappable gutter on this device
      const x = Math.max(3, Math.round(r.left / 2)), y = Math.round(innerHeight / 2);
      const at = document.elementFromPoint(x, y);
      return at === sh ? { x, y } : null;
    });
    let still = true;
    if (scrim) {
      await touch.tap(scrim.x, scrim.y);
      await page.waitForTimeout(500);
      still = await page.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
      rec("backdrop tap closes", still ? "FAIL" : "PASS", `scrim at (${scrim.x},${scrim.y}), still open=${still}`);
    } else {
      rec("backdrop", "INFO", "card leaves no hit-testable scrim on this glass; swipe-down is the exit");
    }
    if (still) {
      // swipe down on the sheet header
      await touch.drag(375, 60, 375, 300, { steps: 8, holdMs: 30 });
      await page.waitForTimeout(500);
      const still2 = await page.evaluate(() => getComputedStyle(document.getElementById("sharesheet")).display !== "none");
      rec("swipe-down closes", still2 ? "FAIL" : "PASS", `still open=${still2}`);
    }
  }
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
