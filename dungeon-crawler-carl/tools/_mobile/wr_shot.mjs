// WR-arrangement visual check: capture the rebuilt corner cluster on a real
// gameplay frame (iPhone 13 landscape emulation, REAL GPU — headless:false,
// d3d11), dump the live control rects, and save frames for the composite.
//   node tools/_mobile/wr_shot.mjs [http://localhost:5280] [outdir]
import { chromium, devices } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:5280";
const OUT = process.argv[3] ?? "tools/_mobile/wr-arr";
import { mkdirSync } from "fs";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--window-size=1200,700", "--window-position=40,40"],
});
try {
  const ctx = await browser.newContext({ ...devices["iPhone 13 landscape"] });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/iso.html?test&debug=1&eagerassets&floor=4&level=8&abilities=all&gear=level&seed=17&safe=0,47,21,47`,
    { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForTimeout(2500);
  // Wait out the boot cinematic / warmup and stand the courtesy cards down.
  await page.waitForFunction(() => !document.body.classList.contains("cine"), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);
  // Drain the courtesy-card queue: each GOT IT may reveal the next card.
  for (let i = 0; i < 6; i++) {
    const had = await page.evaluate(() => {
      const b = document.querySelector("#tutorial .tut-dismiss");
      if (!b || !(b instanceof HTMLElement) || b.offsetWidth === 0) return false;
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    });
    if (!had) break;
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(1200);
  const fan = await page.evaluate(() => {
    const el = document.getElementById("t-fanarc");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { on: el.classList.contains("on"), display: cs.display, prev: el.previousElementSibling?.id ?? null,
      next: el.nextElementSibling?.id ?? null, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
      mask: (cs.webkitMaskImage || cs.maskImage || "").slice(0, 60) };
  });
  console.log("fanarc", JSON.stringify(fan));
  // Stage a live combat beat near the crawler so the frame is a real fight.
  await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    p.hp = Math.max(p.hp, 600);
    const live = s.monsters.filter((m) => !m.dormant && m.hp > 0);
    for (let i = 0; i < Math.min(3, live.length); i++) {
      live[i].pos.x = p.pos.x + 1.5 + i * 0.8;
      live[i].pos.y = p.pos.y - 1 + i * 0.9;
    }
  });
  await page.waitForTimeout(900);
  const rects = await page.evaluate(() => {
    const z = window.__dcc.touch.zones;
    const out = { preset: z.preset, cls: z.cls, pivot: z.pivot, arcRadius: z.arcRadius, controls: {} };
    for (const id of Object.keys(z.controls)) {
      const c = z.controls[id];
      out.controls[id] = { cx: Math.round(c.cx), cy: Math.round(c.cy), w: Math.round(c.w), vis: Math.round(c.vis) };
    }
    return out;
  });
  console.log(JSON.stringify(rects, null, 1));
  await page.screenshot({ path: `${OUT}/combat.png` });
  // A second frame holding an aimed drag so the cooldown/aim skin shows too.
  const s2 = rects.controls.slot2;
  const cdp = await ctx.newCDPSession(page);
  const pt = (x, y, force = 1) => [{ x, y, id: 1, radiusX: 12, radiusY: 12, force }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(s2.cx, s2.cy) });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(s2.cx - i * 14, s2.cy - i * 8) });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/aiming.png` });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
} finally {
  await browser.close();
}
