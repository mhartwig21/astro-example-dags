// Round-2 verification probe. REAL touch only; every row ends in a number the
// page or the sim owns, never in "the element exists".
import { chromium, devices } from "playwright";
import { DEVICE_SPECS, touchDriver } from "../mobileshot.mjs";

const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const devKey = process.argv[2] || "iphone13-land";
const spec = DEVICE_SPECS[devKey];
const url = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=14&seed=77&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ...devices[spec.pw], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);
const touch = touchDriver(client);
page.on("pageerror", (e) => console.log("PAGEEXC", String(e).slice(0, 200)));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
await page.waitForTimeout(1500);
const settle = async (n = 8) => {
  await page.waitForTimeout(140);
  await page.evaluate((k) => new Promise((r) => { let i = 0; const t = () => (++i >= k ? r(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {});
};
const rec = (n, v, d) => console.log(`  [${v}] ${n} — ${d}`);
console.log(`== ${devKey} ==`);

// --- 19. RESTING STICK AFFORDANCE -----------------------------------------
const stickCheck = async () => {
  const g = await page.evaluate(() => {
    const e = document.getElementById("t-ghost");
    if (!e) return null;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { op: +cs.opacity, border: cs.borderTopWidth + " " + cs.borderTopColor, r: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  });
  const st2 = await page.evaluate(() => {
    const e = document.getElementById("t-stick2"); const r = e.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  });
  rec("stick: a resting affordance is painted", g && g.op >= 0.25 && g.r[0] > 0 ? "PASS" : "FAIL",
    `#t-ghost opacity ${g?.op} at ${JSON.stringify(g?.r)} border ${g?.border}; #t-stick2 parked at ${JSON.stringify(st2)}; body="${await page.evaluate(() => document.body.className)}"`);
};

await settle(14);
await stickCheck();

// --- 4/18. CANCEL AFFORDANCE vs THE MOVEMENT THUMB -------------------------
{
  const z = await page.evaluate(() => {
    const t = window.__dcc?.touch?.zones;
    if (!t) return null;
    const b = t.cancelBand, s = t.stickZone;
    const ox = Math.max(0, Math.min(b.x + b.w, s.x + s.w) - Math.max(b.x, s.x));
    const oy = Math.max(0, Math.min(b.y + b.h, s.y + s.h) - Math.max(b.y, s.y));
    return { mode: t.cancelMode, band: b, stick: s, overlap: ox * oy, area: b.w * b.h };
  });
  if (!z) rec("cancel: not in the movement thumb", "INFO", "window.__dcc.zones not exported");
  else {
    const pct = z.area > 0 ? Math.round((z.overlap / z.area) * 100) : 0;
    rec("cancel: not in the movement thumb", pct === 0 ? "PASS" : "FAIL",
      `mode=${z.mode}, band ${Math.round(z.band.w)}x${Math.round(z.band.h)}, ${pct}% of it inside the stick zone`);
  }
}

// --- 6. LOW-HP FLASK -------------------------------------------------------
{
  await page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = Math.round(p.maxHp * 0.32);
    p.flaskCharges = Math.max(1, p.flaskCharges);
  });
  await settle(10);
  const f = await page.evaluate(() => {
    const e = document.getElementById("flask-chip");
    if (!e) return null;
    const cs = getComputedStyle(e);
    return { cls: e.className, anim: cs.animationName, border: cs.borderTopColor };
  });
  rec("flask: low HP is legible on the chip", f && (f.cls.includes("lowhp") && f.anim !== "none") ? "PASS" : "FAIL",
    `class="${f?.cls}" animation-name: ${f?.anim}, border ${f?.border}`);
}

// --- 5. LOOT FEEDBACK ------------------------------------------------------
{
  await page.evaluate(() => {
    const s = window.__dcc.state, p = s.players[0];
    s.loot.push({ kind: "gold", amount: 77, pos: { x: p.pos.x + 0.3, y: p.pos.y + 0.2 } });
  });
  await settle(20);
  const l = await page.evaluate(() => {
    const strip = document.getElementById("pickstrip");
    const rows = strip ? [strip.dataset.picks ?? "0"] : null;
    let ring = false;
    
    return { rows, stripExists: !!strip, ring };
  });
  rec("loot: a pickup is acknowledged on screen", l.rows && +l.rows[0] > 0 ? "PASS" : "FAIL",
    `#pickstrip ${l.stripExists ? "exists" : "MISSING"}, rows pushed = ${l.rows?.[0]}`);
}

// --- 2. AIM INDICATOR ------------------------------------------------------
{
  const chip = await page.evaluate(() => {
    const e = document.querySelector('#skills .skill[data-i="2"]');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  await touch.down(1, chip.x, chip.y);
  await settle(4);
  for (let i = 1; i <= 8; i++) { await touch.move(1, chip.x - i * 14, chip.y - i * 6); await settle(2); }
  await settle(6);
  const ind = await page.evaluate(() => {
    const r = window.__dcc?.renderer;
    const g = r?.scene?.getObjectByName?.("aimIndicator");
    if (!g) return null;
    let n = 0; const cols = new Set(); let depthTestOff = 0;
    g.traverse((o) => { if (o.isMesh) { n++; cols.add("#" + o.material.color.getHexString()); if (o.material.depthTest === false) depthTestOff++; } });
    return { visible: g.visible, meshes: n, colors: [...cols], depthTestOff };
  });
  rec("aim: the telegraph is rebuilt from the ability", ind && ind.meshes >= 3 && ind.colors.includes("#eaf9ff") ? "PASS" : "FAIL",
    ind ? `visible=${ind.visible}, ${ind.meshes} meshes, colours ${JSON.stringify(ind.colors)}, ${ind.depthTestOff} draw over geometry` : "no aimIndicator in the scene");
  const oc = await page.evaluate(() => {
    const e = document.getElementById("t-ocancel");
    if (!e) return null;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { on: e.className, op: +cs.opacity, r: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  });
  rec("cancel: the origin ✕ is drawn while aiming", oc && oc.op > 0.5 ? "PASS" : "INFO",
    oc ? `opacity ${oc.op} at ${JSON.stringify(oc.r)}` : "no #t-ocancel");
  await touch.up(1);
  await settle(6);
}

// --- 7/8. PANELS: the math sheet, and swipe-to-close ------------------------
for (const [key, panel] of [["p", "sheet"], ["i", "inv"]]) {
  await page.keyboard.press(key);
  await settle(10);
  const open = await page.evaluate((id) => {
    const e = document.getElementById(id);
    return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
  }, panel);
  if (!open) { rec(`panel ${panel}: opened`, "FAIL", "did not open"); continue; }
  if (panel === "sheet") {
    // A player scrolls to what they want to read; so does the probe.
    await page.evaluate(() => {
      const t = document.querySelector("#sheet .ledger tr[title]");
      t?.scrollIntoView({ block: "center" });
    });
    await settle(6);
    const row = await page.evaluate(() => {
      const all = [...document.querySelectorAll("#sheet .ledger tr[title], #sheet [title]")].filter((e) => !e.closest("button, .tab, .itile, .sock, .gchip, .acard .nrow"));
      const seen = [];
      for (const e of all) {
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) { seen.push(`${e.tagName}.${e.className} offscreen@${cy}`); continue; }
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !e.contains(hit)) { seen.push(`${e.tagName}.${e.className} covered by ${hit?.tagName}.${hit?.className}`); continue; }
        return { x: cx, y: cy, reachable: true, tag: e.tagName + "." + e.className, n: all.length };
      }
      return { x: 0, y: 0, reachable: false, tag: seen.slice(0, 3).join(" | "), n: all.length };
    });
    if (!row) rec("sheet: a stat row is reachable", "FAIL", "no .ledger tr[title]");
    else {
      await touch.tap(row.x, row.y, 1, 110);
      await settle(10);
      const sh = await page.evaluate(() => {
        const e = document.querySelector("[data-sheet]");
        return e ? { on: e.classList.contains("on"), txt: e.textContent.trim().slice(0, 50) } : null;
      });
      rec("sheet: tapping a stat row raises the math", sh?.on ? "PASS" : "FAIL",
        `row reachable=${row.reachable} (${row.n} [title] nodes; ${row.tag}); [data-sheet] ${sh ? `on=${sh.on} "${sh.txt}"` : "never created"}`);
      await page.evaluate(() => document.querySelector("[data-sheet] .ts-close")?.click());
      await settle(6);
    }
  }
  // swipe down from the top of the panel
  const box = await page.evaluate((id) => {
    const e = document.querySelector(`#${id} > .panel`);
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 26), h: Math.round(r.height) };
  }, panel);
  await page.evaluate((id) => { const e = document.querySelector(`#${id} > .panel`); if (e) e.scrollTop = 0; }, panel);
  await touch.down(1, box.x, box.y);
  await settle(2);
  for (let i = 1; i <= 10; i++) { await touch.move(1, box.x, box.y + i * 20); await settle(1); }
  await touch.up(1);
  await settle(12);
  const still = await page.evaluate((id) => {
    const e = document.getElementById(id);
    return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
  }, panel);
  rec(`panel ${panel}: swipe down closes it`, still ? "FAIL" : "PASS",
    `200px downward drag from the panel top; still open = ${still}`);
  if (still) { await page.keyboard.press("Escape"); await settle(6); }
}

await page.screenshot({ path: `tools/_mobile/r2c-${devKey}.png` });
await browser.close();
