// DESKTOP DEEP REGRESSION — acceptance round 1, layout/readability seat.
//
// tools/desktopsmoke.mjs passes, but its cast check is `cast || facingChanged`
// and the cast half currently reports FALSE. An OR that can be satisfied by the
// half that is not the claim is not a check. This drives each verb on its own
// and asserts the verb, not a neighbour of it.
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = (flag("base", "http://localhost:5420")).replace(/\/$/, "");
const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance&floor=3&level=14&seed=7";

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${BASE}/iso.html?${TEST}`, { waitUntil: "load", timeout: 180000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => {
  const l = document.getElementById("loading");
  return !l || getComputedStyle(l).display === "none" || getComputedStyle(l).opacity === "0";
}, null, { timeout: 120000 });
await page.waitForTimeout(1500);

const out = [];
const rec = (n, ok, d) => { out.push({ n, ok, d }); console.log(`  [${ok ? "PASS" : "FAIL"}] ${n} — ${d}`); };
const snap = () => page.evaluate(() => {
  const s = window.__dcc.state, p = s.players[0];
  return {
    pos: { x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3) },
    facing: { x: +p.facing.x.toFixed(3), y: +p.facing.y.toFixed(3) },
    cd: JSON.parse(JSON.stringify(p.cd || {})),
    hp: Math.round(p.hp), gold: p.gold, flask: p.flaskCharges,
    monsterHp: s.monsters.reduce((a, m) => a + Math.max(0, m.hp), 0),
    slots: p.abilities ? p.abilities.slots.slice() : [],
    ult: p.abilities ? p.abilities.ultimate : null,
  };
});
const alive = () => page.evaluate(() => {
  const p = window.__dcc.state.players[0];
  p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing";
});
const settle = async (n = 8) => {
  await page.waitForTimeout(120);
  await page.evaluate((k) => new Promise((r) => { let i = 0; const t = () => (++i >= k ? r(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {});
};
// Tag ONE monster and track only its hp: the floor-wide sum drifts (spawns,
// leash regen), which is how the first pass of this probe reported a pack
// GAINING health under a melee hold.
const stageAdjacent = () => page.evaluate(() => {
  const s = window.__dcc.state, p = s.players[0];
  const live = s.monsters.filter((m) => m.hp > 0 && m.kind !== "boss");
  if (!live.length) return null;
  const m = live[0];
  m.dormant = false;
  m.pos.x = p.pos.x + 0.9; m.pos.y = p.pos.y + 0.1;
  m.hp = m.maxHp;
  window.__mark = m;
  return { id: m.id ?? "m0", hp: Math.round(m.hp), n: live.length };
});
const markHp = () => page.evaluate(() => (window.__mark ? Math.round(window.__mark.hp) : -1));

// ---- 1. movement, all four keys ----
for (const [key, label] of [["w", "W"], ["s", "S"], ["a", "A"], ["d", "D"]]) {
  await alive(); const a = await snap();
  await page.keyboard.down(key); await settle(22); await page.keyboard.up(key);
  const b = await snap();
  const dist = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
  rec(`desktop: ${label} moves`, dist > 0.25, `${dist.toFixed(2)} tiles`);
}

/**
 * HOLD, DO NOT PRESS — and the reason the last two rounds of this gate lied.
 *
 * `page.keyboard.press(k)` synthesises a down and an up about 10 ms apart. The
 * host samples the keyboard once per sim step, and under SwiftShader this page
 * runs at roughly 3 fps: a 10 ms key edge therefore lands entirely between two
 * samples and is never seen. That is exactly the gotcha CLAUDE.md documents
 * ("hold keys >= 450 ms"), and this probe was the thing that ignored it.
 *
 * The consequence was two standing FAILs — "ability keys 1-4 each cast" and "F
 * fires the ultimate" — recorded in HANDOFF as "a bindings mismatch that
 * predates this track (verified by stashing)". It is not a bindings mismatch
 * and stashing could never have shown that, because the branch under test was
 * never the variable. Re-driven with a 520 ms hold, all five ability keys fire:
 * Space/melee 2239->2210 mob hp, Shift/dash cd started + charges 2->1, q/bolt
 * 2210->2051, c/stuntdouble cd started, f/injunction cd started.
 *
 * A gate that manufactures FAILs is worse than no gate: it is how a real
 * regression eventually gets waved through.
 */
const HOLD_MS = 520;
const holdKey = async (k) => {
  await page.keyboard.down(k);
  await new Promise((r) => setTimeout(r, HOLD_MS));
  await page.keyboard.up(k);
};

// ---- 2. every ability key starts its own cooldown ----
// DEFAULT_BINDINGS (src/input/bindings.ts): slot1=Space slot2=Shift slot3=Q
// slot4=C ultimate=F flask=X. Not 1/2/3/4 — that was this probe's own bug in
// its first pass, and it is exactly the kind of false blocker a critic owes
// the implementation the courtesy of not filing.
{
  await alive();
  const s0 = await snap();
  const results = [];
  for (const k of [" ", "Shift", "q", "c"]) {
    await alive();
    await page.evaluate(() => { window.__dcc.state.players[0].cd = {}; });
    const a = await snap();
    await holdKey(k);
    await settle(14);
    const b = await snap();
    const started = Object.keys(b.cd).filter((id) => (b.cd[id] ?? 0) > (a.cd[id] ?? 0));
    results.push(`${k}->${started.join("/") || "NOTHING"}`);
  }
  const fired = results.filter((r) => !r.includes("NOTHING")).length;
  rec("desktop: ability keys 1-4 each cast", fired === 4, `${fired}/4 · ${results.join(" ")} · slots=${JSON.stringify(s0.slots)}`);
}

// ---- 3. ultimate + flask keys ----
{
  await alive();
  await page.evaluate(() => { window.__dcc.state.players[0].cd = {}; });
  const a = await snap(); await holdKey("f"); await settle(14); const b = await snap();
  const started = Object.keys(b.cd).filter((id) => (b.cd[id] ?? 0) > (a.cd[id] ?? 0));
  rec("desktop: F fires the ultimate", started.length > 0, `cd started: ${started.join("/") || "none"} (ult=${a.ult})`);
}
{
  await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = Math.max(1, p.maxHp * 0.3); });
  const a = await snap(); await holdKey("x"); await settle(14); const b = await snap();
  rec("desktop: X drinks the flask", b.hp > a.hp || b.flask < a.flask, `hp ${a.hp}->${b.hp}, charges ${a.flask}->${b.flask}`);
}

// ---- 4. LMB actually damages a staged monster ----
{
  await alive();
  const n = await stageAdjacent();
  await settle(4);
  const a = await snap();
  const h0 = await markHp();
  const vp = page.viewportSize();
  // aim at the monster's own screen position, not a guess
  const sp = await page.evaluate(() => {
    const d = window.__dcc, r = d.renderer;
    const m = window.__mark;
    if (!m || !r || !r.camera) return null;
    const cam = r.camera;
    const v = { x: m.pos.x, y: 0.8, z: m.pos.y };
    const e = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
    const w = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15] || 1;
    const cx = (e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12]) / w;
    const cy = (e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]) / w;
    return { x: (cx * 0.5 + 0.5) * innerWidth, y: (-cy * 0.5 + 0.5) * innerHeight };
  }).catch(() => null);
  const px = sp ? sp.x : vp.width * 0.62, py = sp ? sp.y : vp.height * 0.45;
  await page.mouse.move(px, py); await settle(4);
  await page.mouse.down();
  await settle(30);
  await page.mouse.up();
  await settle(10);
  const b = await snap();
  const h1 = await markHp();
  const cast = Object.keys(b.cd).some((k) => (b.cd[k] ?? 0) > (a.cd[k] ?? 0));
  const dmg = h1 < h0;
  rec("desktop: LMB held on a monster DEALS DAMAGE", dmg,
    `marked monster hp ${h0}->${h1} (${JSON.stringify(n)}, cursor ${Math.round(px)},${Math.round(py)}), cdChanged=${cast}`);
}

// ---- 5. mouse aim tracks the cursor to the right quadrant ----
// facing is a SIM field and only moves when an aim reaches step(); cast while
// the cursor sits at each corner and read what the sim believed.
{
  await alive();
  const vp = page.viewportSize();
  const read = async (x, y) => {
    await alive();
    await page.mouse.move(x, y); await settle(6);
    await page.keyboard.down(" "); await settle(10); await page.keyboard.up(" ");
    await settle(6);
    return (await snap()).facing;
  };
  const fL = await read(vp.width * 0.12, vp.height * 0.5);
  const fR = await read(vp.width * 0.88, vp.height * 0.5);
  const fU = await read(vp.width * 0.5, vp.height * 0.1);
  const delta = Math.hypot(fL.x - fR.x, fL.y - fR.y);
  const distinct = new Set([JSON.stringify(fL), JSON.stringify(fR), JSON.stringify(fU)]).size;
  rec("desktop: mouse aim tracks the cursor", delta > 0.8 && distinct === 3,
    `L=${JSON.stringify(fL)} R=${JSON.stringify(fR)} U=${JSON.stringify(fU)} |L-R|=${delta.toFixed(2)}`);
}

// ---- 5b. the touch layer must not latch the aim away from the mouse ----
// sampleIntent(): `mouseAim && input.mouse && !padRecent && !touchRecent`.
// If touch.lastInputAt is ever ahead of lastMouseAt on a desktop session the
// cursor stops aiming, silently and permanently. Report both clocks.
{
  const clocks = await page.evaluate(() => {
    const d = window.__dcc;
    return {
      touchLast: d.touch ? d.touch.lastInputAt : "n/a",
      touchMode: d.touchMode ?? "n/a",
      bodyTouch: document.body.classList.contains("touch"),
    };
  }).catch((e) => ({ err: e.message }));
  rec("desktop: touch clock does not out-rank the mouse", !clocks.bodyTouch, JSON.stringify(clocks));
}

// ---- 6. panels: open by key, close by key AND by Escape ----
for (const [key, id] of [["i", "inv"], ["p", "sheet"], ["t", "abil"], ["k", "keys"]]) {
  await alive();
  const vis = () => page.evaluate((pid) => {
    const e = document.getElementById(pid);
    return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
  }, id);
  await page.keyboard.press(key); await settle(10);
  const opened = await vis();
  await page.keyboard.press("Escape"); await settle(10);
  const closedEsc = !(await vis());
  if (!closedEsc) { await page.keyboard.press(key); await settle(10); }
  rec(`desktop: ${id} opens on '${key}' and closes on Escape`, opened && closedEsc, `opened=${opened} escClosed=${closedEsc}`);
}

// ---- 7. the desktop close affordance is not a touch-only control ----
{
  await alive();
  await page.keyboard.press("i"); await settle(10);
  const info = await page.evaluate(() => {
    const e = document.getElementById("inv");
    const x = e.querySelector(".tp-x"), done = e.querySelector(".tp-done");
    const shown = (n) => !!n && getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 0;
    return { x: shown(x), done: shown(done), panelW: Math.round(e.querySelector(".panel").getBoundingClientRect().width) };
  });
  await page.keyboard.press("Escape"); await settle(6);
  rec("desktop: touch close chrome is NOT injected on a fine pointer", !info.x && !info.done,
    `tp-x=${info.x} tp-done=${info.done} panel=${info.panelW}px`);
}

// ---- 8. the shop: keyboard/mouse purchase still works ----
{
  await alive();
  await page.evaluate(() => {
    const d = window.__dcc, st = d.state, p = st.players[0];
    p.gold = (p.gold ?? 0) + 8000;
    for (const m of st.monsters) m.hp = 0;
    p.alive = true; p.hp = p.maxHp; st.status = "playing";
    p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
  });
  await page.waitForFunction(() => {
    const d = window.__dcc;
    if (!d || d.state.safeRoom) return true;
    d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60);
    return !!d.state.safeRoom;
  }, null, { timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 16; i++) {
    const st = await page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
      return { draft: vis("draft"), shop: vis("saferoom") };
    }).catch(() => ({}));
    if (st.shop) break;
    if (st.draft) await page.evaluate(() => { document.querySelector("#draft-cards .reward")?.click(); }).catch(() => {});
    await page.waitForTimeout(600);
  }
  const shopUp = await page.evaluate(() => {
    const e = document.getElementById("saferoom");
    return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
  });
  const g0 = (await snap()).gold;
  // Real mouse click on a shelf tile, then on the BUY control if there is one.
  const bought = await page.evaluate(async () => {
    const tile = document.querySelector("#sr-shelf .itile:not(.locked):not(.soldout)");
    if (!tile) return "no tile";
    const r = tile.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (bought && bought.x) {
    await page.mouse.click(bought.x, bought.y); await settle(8);
    const buy = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#sr-detail button")].find((n) => /buy|purchase/i.test(n.textContent));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: b.textContent.trim() };
    });
    if (buy) { await page.mouse.click(buy.x, buy.y); await settle(10); }
    const g1 = (await snap()).gold;
    rec("desktop: shop purchase by mouse", shopUp && g1 < g0, `shopUp=${shopUp} gold ${g0}->${g1} buyBtn=${buy ? buy.t : "none"}`);
  } else {
    rec("desktop: shop purchase by mouse", false, `shopUp=${shopUp}, ${JSON.stringify(bought)}`);
  }
}

console.log(errs.length ? `page errors: ${errs.length} :: ${errs.slice(0, 3).join(" | ")}` : "no page errors");
const fails = out.filter((o) => !o.ok);
console.log(fails.length ? `DEEP SMOKE: ${fails.length} FAILED -> ${fails.map((f) => f.n).join("; ")}` : "DEEP SMOKE: all clear");
await browser.close();
