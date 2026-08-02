// ROUND 3 — flick-to-dash, with the event stream itself on the record.
//
// Round 2's battery reported "1 of 4 profiles fires" on both devices. This one
// keeps the same four profiles and adds the two things that battery could not
// see: how many pointermove events the PAGE actually received for each gesture
// (Chromium coalesces), and what the driver's virtual clock did between
// profiles (FLICK_DEBOUNCE_MS is judged on EVENT time, so a harness whose
// clock does not advance debounces every profile after the first).
import { chromium, devices } from "playwright";

const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

function td(client) {
  const live = new Map();
  const pts = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (t) => client.send("Input.dispatchTouchEvent", { type: t, touchPoints: pts(), timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; },
    now() { return clock; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [],
        timestamp: clock,
      });
    },
  };
}

const PROFILES = [
  { name: "4 x 34px @16ms (2125 px/s)", steps: 4, px: 34, ms: 16 },
  { name: "3 x 60px @12ms (5000 px/s)", steps: 3, px: 60, ms: 12 },
  { name: "6 x 25px @ 8ms (3125 px/s)", steps: 6, px: 25, ms: 8 },
  { name: "5 x 40px @16ms (2500 px/s)", steps: 5, px: 40, ms: 16 },
  { name: "2 x 90px @16ms (5625 px/s)", steps: 2, px: 90, ms: 16 },
];

const ONLY = process.argv[2];
const DEVS = ["iPhone 13 landscape", "iPad Pro 11 landscape"].filter((d) => !ONLY || d.includes(ONLY));
for (const dev of DEVS) {
  const ctx = await browser.newContext({ ...devices[dev], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const t = td(client);
  await page.goto(`${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=14&seed=77`, { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForTimeout(2000);

  // The event tap: count moves and the samples the browser merged into them.
  await page.evaluate(() => {
    window.__tap = { moves: 0, coalesced: 0, stamps: [] };
    document.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") return;
      window.__tap.moves++;
      const c = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      window.__tap.coalesced += Math.max(1, c.length);
      window.__tap.stamps.push(Math.round(e.timeStamp));
    }, { capture: true });
  });

  const V = page.viewportSize();
  const R = await page.evaluate(() => window.__dcc.touch.zones.stickRadius);
  const clear = await page.evaluate(([w, h]) => {
    const d = window.__dcc;
    for (const fy of [0.86, 0.78, 0.66]) for (const fx of [0.30, 0.22, 0.38]) {
      const x = Math.round(w * fx), y = Math.round(h * fy);
      if (!d.touch.controlAt(x, y) && d.touch.route(x, y).zone === "stick") return { x, y };
    }
    return { x: Math.round(w * 0.3), y: Math.round(h * 0.86) };
  }, [V.width, V.height]);
  const settle = async (n = 6) => {
    await page.waitForTimeout(150);
    await page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r(null) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n).catch(() => {});
  };

  console.log(`\n== ${dev} R=${R.toFixed(1)} clear=(${clear.x},${clear.y}) threshold ${(12 * R).toFixed(0)} px/s, ${(0.25 * R).toFixed(0)} px/sample`);
  let pass = 0;
  for (const p of PROFILES) {
    await page.evaluate(() => {
      const q = window.__dcc.state.players[0];
      q.hp = q.maxHp; q.dashCharges = 2; for (const k in q.cd) q.cd[k] = 0;
      window.__tap.moves = 0; window.__tap.coalesced = 0; window.__tap.stamps = [];
    });
    // THE FIX THE ROUND-2 BATTERY NEEDED. FLICK_DEBOUNCE_MS is judged on EVENT
    // time; the driver's clock only advances when `tick()` is called, so back
    // to back profiles landed inside 350 ms of each other in the page's view
    // and every one after the first was correctly debounced. Advancing the
    // virtual clock is what a real thumb does between two dodges.
    t.tick(900);
    await settle(4);
    const a = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { dc: q.dashCharges, cd: q.cd.dash || 0 }; });
    await t.down(1, clear.x, clear.y);
    await settle(2);
    for (let i = 1; i <= p.steps; i++) { t.tick(p.ms); await t.move(1, clear.x + i * p.px, clear.y); }
    await settle(6);
    await t.up(1);
    await settle(4);
    const b = await page.evaluate(() => {
      const q = window.__dcc.state.players[0];
      return { dc: q.dashCharges, cd: q.cd.dash || 0, tap: window.__tap,
        susp: window.__dcc.touch.suspendReasons() };
    });
    const fired = b.dc < a.dc || b.cd > a.cd;
    if (fired) pass++;
    const st = b.tap.stamps;
    const gaps = st.slice(1).map((v, i) => v - st[i]);
    console.log(`  [${fired ? "DASH" : "no  "}] ${p.name} — ${p.steps} dispatched, ` +
      `${b.tap.moves} pointermove delivered, ${b.tap.coalesced} raw samples, ` +
      `stamp gaps [${gaps.join(",")}]ms, charges ${a.dc}->${b.dc}` +
      (b.susp.length ? ` SUSPENDED[${b.susp}]` : ""));
  }
  console.log(`  ${pass}/${PROFILES.length} profiles fired`);

  // FALSE POSITIVE GUARD: ordinary steering must never dash.
  await page.evaluate(() => { const q = window.__dcc.state.players[0]; q.dashCharges = 2; for (const k in q.cd) q.cd[k] = 0; });
  t.tick(900);
  const a2 = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { dc: q.dashCharges, cd: q.cd.dash || 0 }; });
  await t.down(1, clear.x, clear.y);
  for (let i = 0; i < 24; i++) { t.tick(16); const ang = (i / 24) * Math.PI * 2; await t.move(1, clear.x + Math.cos(ang) * 55, clear.y + Math.sin(ang) * 55); await new Promise((r) => setTimeout(r, 16)); }
  await settle(6);
  await t.up(1);
  await settle(4);
  const b2 = await page.evaluate(() => { const q = window.__dcc.state.players[0]; return { dc: q.dashCharges, cd: q.cd.dash || 0 }; });
  console.log(`  [${b2.dc < a2.dc || b2.cd > a2.cd ? "FALSE POSITIVE" : "clean"}] ordinary circling steer ~215 px/s`);
  await ctx.close();
}
await browser.close();
