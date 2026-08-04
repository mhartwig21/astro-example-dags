// THE REAL-GLASS REGRESSION, PINNED IN EMULATION AS FAR AS EMULATION CAN GO.
//
// The owner, on a real iPhone (Safari, landscape, production): "you can't move
// and press an action at the same time." Root cause: iOS fires `gesturestart`
// the moment a SECOND finger lands — on every two-finger moment, regardless of
// touch-action — and touchShell treated that event as "the OS took the finger"
// and suspended ALL gameplay input until 120 ms after gestureend. Chromium
// never fires GestureEvents, so every CDP battery stayed green.
//
// Emulation still cannot fire a native GestureEvent, but it CAN dispatch one:
// the handler is an ordinary listener, so `new Event("gesturestart")` exercises
// the exact code path Safari does. This probe drives real CDP two-finger play
// and storms synthetic gesture events over it, asserting play never suspends —
// plus the compact-preset geometry and the ?touchdebug=1 overlay.
//
//   node tools/_mobile/ios_gesture_probe.mjs [http://localhost:5280]
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
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=12&abilities=all&gear=level&seed=41&safe=0,47,21,47&touchdebug=1`,
    { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForTimeout(1500);
  // Immortality watchdog: a dead crawler no-ops every later check.
  const keepAlive = setInterval(() => {
    page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = Math.max(p.hp, 900); }).catch(() => {});
  }, 800);

  const zones = await page.evaluate(() => {
    const z = window.__dcc.touch.zones;
    return { anchor: z.stickAnchor, slot2: z.controls.slot2, safe: z.safe, preset: z.preset };
  });
  rec("zone table preset is COMPACT by default", zones.preset === "compact" ? "PASS" : "FAIL", zones.preset);

  // ---- CHECK 1: gesturestart mid-move does not suspend or stop the crawler.
  const pos0 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  const A = { x: Math.round(zones.anchor.x), y: Math.round(zones.anchor.y) };
  await touch.down(1, A.x, A.y);
  for (let i = 0; i < 6; i++) { touch.tick(30); await touch.move(1, A.x - 40, A.y - 40 + i); await page.waitForTimeout(30); }
  // The storm: what Safari fires the instant a second finger exists.
  await page.evaluate(() => {
    document.dispatchEvent(new Event("gesturestart", { cancelable: true, bubbles: true }));
    document.dispatchEvent(new Event("gesturechange", { cancelable: true, bubbles: true }));
  });
  const midReasons = await page.evaluate(() => window.__dcc.touch.suspendReasons());
  for (let i = 0; i < 14; i++) { touch.tick(30); await touch.move(1, A.x - 40 - i, A.y - 40); await page.waitForTimeout(30); }
  const fsm1 = await page.evaluate(() => window.__dcc.touch.fsm());
  const pos1 = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  const moved1 = Math.hypot(pos1.x - pos0.x, pos1.y - pos0.y);
  rec("gesturestart mid-move: no suspend reason raised",
    midReasons.length === 0 ? "PASS" : "FAIL", JSON.stringify(midReasons));
  rec("gesturestart mid-move: stick still owns its pointer",
    fsm1.stickDown ? "PASS" : "FAIL", JSON.stringify(fsm1));
  rec("gesturestart mid-move: crawler kept moving",
    moved1 > 0.8 ? "PASS" : "FAIL", `${moved1.toFixed(2)} tiles across the storm`);

  // ---- CHECK 2: second finger casts WHILE the first keeps moving, with a
  // gesture storm at the exact moment the second finger lands.
  await page.evaluate(() => window.__dcc.touch.clearVerdicts());
  const pos2a = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  const S2 = zones.slot2;
  await touch.down(2, Math.round(S2.cx), Math.round(S2.cy));
  await page.evaluate(() => {
    document.dispatchEvent(new Event("gesturestart", { cancelable: true, bubbles: true }));
  });
  touch.tick(90);
  await page.waitForTimeout(90);
  await touch.up(2);
  await page.evaluate(() => document.dispatchEvent(new Event("gestureend", { cancelable: true, bubbles: true })));
  for (let i = 0; i < 12; i++) { touch.tick(30); await touch.move(1, A.x - 40, A.y - 40 - i * 2); await page.waitForTimeout(30); }
  await touch.up(1);
  const verdicts = await page.evaluate(() => window.__dcc.touch.verdicts());
  const pos2b = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  const moved2 = Math.hypot(pos2b.x - pos2a.x, pos2b.y - pos2a.y);
  const cast = verdicts.some((v) => v.kind === "tap" || v.kind === "aimed");
  rec("two fingers + gesture storm: the chip press resolved as a cast",
    cast ? "PASS" : "FAIL", JSON.stringify(verdicts.map((v) => v.kind)));
  rec("two fingers + gesture storm: movement survived the cast",
    moved2 > 0.8 ? "PASS" : "FAIL", `${moved2.toFixed(2)} tiles while casting`);
  const postReasons = await page.evaluate(() => window.__dcc.touch.suspendReasons());
  rec("after the storm: no suspend reason latched",
    postReasons.length === 0 ? "PASS" : "FAIL", JSON.stringify(postReasons));

  // ---- CHECK 3: the ?touchdebug=1 overlay is live and counts real touches.
  await touch.down(3, A.x, A.y);
  await touch.down(4, Math.round(S2.cx), Math.round(S2.cy) - 60);
  await page.waitForTimeout(250);
  const dbg = await page.evaluate(() => ({
    head: document.getElementById("tdbg-head")?.textContent ?? null,
    fsm: document.getElementById("tdbg-fsm")?.textContent ?? null,
    dots: [...document.querySelectorAll(".tdbg-dot")].filter((d) => d.style.display !== "none").length,
  }));
  await touch.up(4); await touch.up(3);
  rec("touchdebug overlay exists and reads TOUCHES 2",
    dbg.head === "TOUCHES 2" ? "PASS" : "FAIL", JSON.stringify(dbg));
  rec("touchdebug overlay paints one dot per touch",
    dbg.dots === 2 ? "PASS" : "FAIL", `${dbg.dots} dots`);

  // ---- CHECK 4: compact vs large footprint, live, same session.
  const bbox = async () => page.evaluate(() => {
    const z = window.__dcc.touch.zones;
    const ids = Object.keys(z.controls);
    const x0 = Math.min(...ids.map((id) => z.controls[id].x));
    const y0 = Math.min(...ids.map((id) => z.controls[id].y));
    const x1 = Math.max(...ids.map((id) => z.controls[id].x + z.controls[id].w));
    const y1 = Math.max(...ids.map((id) => z.controls[id].y + z.controls[id].h));
    return { w: Math.round(x1 - x0), h: Math.round(y1 - y0), area: Math.round((x1 - x0) * (y1 - y0)) };
  });
  const cbox = await bbox();
  await page.evaluate(() => { window.__dcc.touch.prefs.preset = "large"; window.__dcc.touch.relayout(); });
  await page.waitForTimeout(400);
  const lbox = await bbox();
  await page.evaluate(() => { window.__dcc.touch.prefs.preset = "compact"; window.__dcc.touch.relayout(); });
  rec("compact cluster footprint < large",
    cbox.area < lbox.area ? "PASS" : "FAIL",
    `compact ${cbox.w}x${cbox.h} (${cbox.area}) vs large ${lbox.w}x${lbox.h} (${lbox.area})`);

  // ---- CHECK 5: chips clear the bottom safe inset (the home indicator).
  const bottomOK = await page.evaluate(() => {
    const z = window.__dcc.touch.zones;
    const limit = z.viewport.h - 21; // safe=...,21,... override
    const bad = Object.keys(z.controls)
      .filter((id) => z.controls[id].y + z.controls[id].h > limit + 0.5);
    return { bad, limit };
  });
  rec("no control crosses the home-indicator inset",
    bottomOK.bad.length === 0 ? "PASS" : "FAIL", JSON.stringify(bottomOK));

  clearInterval(keepAlive);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
