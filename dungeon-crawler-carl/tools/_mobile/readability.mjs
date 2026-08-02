// LAYOUT & READABILITY probe — acceptance round 1.
//
// The drive battery answers "did the intent land". This answers the questions
// that seat is blind to:
//   * does your own HAND cover the thing you must read (chip rects vs the
//     crawler's projected screen position, and vs the read band)?
//   * do two HUD cards overlap each other (the boss plate vs the vitals card)?
//   * what does every control measure in MILLIMETRES, not CSS px?
//   * how small is the smallest piece of live text?
//   * does anything cross the hardware inset, including the rounded corner
//     (a corner is a QUARTER DISC, not two straight bands — the r=... test)?
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = (flag("base", "http://localhost:5420")).replace(/\/$/, "");
const OUT = flag("out", "tools/_mobile/ac3");
mkdirSync(OUT, { recursive: true });

const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance";
const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 }, corner: 47, mmpx: 0.165 },
  "iphone13promax-land": { pw: "iPhone 13 Pro Max landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 }, corner: 47, mmpx: 0.165 },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: { top: 24, right: 0, bottom: 20, left: 0 }, corner: 18, mmpx: 0.192 },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: { top: 0, right: 24, bottom: 0, left: 0 }, corner: 20, mmpx: 0.163 },
  iphone13: { pw: "iPhone 13", safe: { top: 47, right: 0, bottom: 34, left: 0 }, corner: 47, mmpx: 0.165 },
};

const READ = (arg) => {
  const { safe, corner, mmpx } = arg;
  const R = (e) => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const shown = (e) => {
    if (!e) return false;
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < 0.05) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const VW = innerWidth, VH = innerHeight;

  // --- every fixed HUD box that is actually on screen ---
  const IDS = ["hud-tl", "hud-tr", "cockpit", "skills", "xpbar", "minimap-frame", "banner",
    "headline", "toasts", "tutorial", "bossbar", "bosscall", "t-stick2", "t-stickzone",
    "t-stairs", "t-cancel", "t-loot", "t-interact", "ticker", "partybar", "ghostrail", "downed"];
  const boxes = {};
  for (const id of IDS) { const e = document.getElementById(id); if (shown(e)) boxes[id] = R(e); }
  // ability chips
  const chips = [...document.querySelectorAll("#skills .skill, #cockpit .skill, .t-chip")]
    .filter(shown).map((c) => Object.assign({ id: c.id || c.className.split(" ")[0] + (c.dataset.i ?? "") }, R(c)));

  // --- the crawler's own screen position, through the renderer's camera ---
  let player = null;
  try {
    const d = window.__dcc, r = d.renderer, p = d.state.players[0];
    const cam = r.camera;
    const proj = (wx, wy, wz) => {
      const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      const w = m[3] * wx + m[7] * wy + m[11] * wz + m[15] || 1;
      const cx = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / w;
      const cy = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / w;
      return { x: (cx * 0.5 + 0.5) * VW, y: (-cy * 0.5 + 0.5) * VH };
    };
    const feet = proj(p.pos.x, 0, p.pos.y);
    const head = proj(p.pos.x, 1.7, p.pos.y);
    player = { feet, head, hp: Math.round(p.hp), maxHp: Math.round(p.maxHp) };
    // what is on top of the crawler right now?
    const el = document.elementFromPoint(Math.round((feet.x + head.x) / 2), Math.round((feet.y + head.y) / 2));
    player.under = el ? (el.tagName + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "")) : null;
    player.inViewport = feet.x > 0 && feet.x < VW && feet.y > 0 && feet.y < VH;
    // nearest live monster, likewise
    const ms = window.__dcc.state.monsters.filter((m) => m.hp > 0);
    player.monstersOnScreen = ms.map((m) => proj(m.pos.x, 0.9, m.pos.y))
      .filter((s) => s.x > 0 && s.x < VW && s.y > 0 && s.y < VH).length;
    player.monstersUnderHud = ms.map((m) => proj(m.pos.x, 0.9, m.pos.y))
      .filter((s) => s.x > 0 && s.x < VW && s.y > 0 && s.y < VH)
      .filter((s) => { const e = document.elementFromPoint(Math.round(s.x), Math.round(s.y)); return e && e.tagName !== "CANVAS"; }).length;
  } catch (e) { player = { error: String(e.message) }; }

  // --- HUD cards overlapping each other ---
  const inter = (a, b) => {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return x * y;
  };
  const overlaps = [];
  const keys = Object.keys(boxes);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      // the stick zone deliberately underlaps everything; skip its pairs
      if (keys[i].startsWith("t-stickzone") || keys[j].startsWith("t-stickzone")) continue;
      const a = boxes[keys[i]], b = boxes[keys[j]];
      const ar = inter(a, b);
      if (ar > 200) overlaps.push({ a: keys[i], b: keys[j], px2: Math.round(ar),
        pctOfSmaller: Math.round((ar / Math.min(a.w * a.h, b.w * b.h)) * 100) });
    }
  }

  // --- safe-area intrusions, INCLUDING the rounded corner quarter-disc ---
  const intrusions = [];
  for (const [id, b] of Object.entries(boxes)) {
    if (id === "t-stickzone") continue;
    const cuts = [];
    if (b.y < safe.top) cuts.push(`top ${b.y.toFixed(0)}<${safe.top}`);
    if (VH - (b.y + b.h) < safe.bottom) cuts.push(`bottom ${(VH - b.y - b.h).toFixed(0)}<${safe.bottom}`);
    if (b.x < safe.left) cuts.push(`left ${b.x.toFixed(0)}<${safe.left}`);
    if (VW - (b.x + b.w) < safe.right) cuts.push(`right ${(VW - b.x - b.w).toFixed(0)}<${safe.right}`);
    // rounded display corner: the display is a rounded rect of radius `corner`.
    // A box corner inside the quarter-disc's excluded region is clipped by GLASS
    // even when both straight insets are respected.
    const r = corner;
    const cor = [[b.x, b.y, 0, 0], [b.x + b.w, b.y, VW, 0], [b.x, b.y + b.h, 0, VH], [b.x + b.w, b.y + b.h, VW, VH]];
    for (const [px, py, cx, cy] of cor) {
      const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
      if (dx < r && dy < r && Math.hypot(r - dx, r - dy) > r) cuts.push(`corner(${cx ? "R" : "L"}${cy ? "B" : "T"}) r=${r}`);
    }
    if (cuts.length) intrusions.push({ id, box: b, cuts });
  }

  // --- smallest live text on the HUD ---
  const textNodes = [];
  const walk = (root) => {
    for (const e of root.querySelectorAll("*")) {
      if (!shown(e)) continue;
      const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!own) continue;
      const cs = getComputedStyle(e);
      const fs = parseFloat(cs.fontSize);
      textNodes.push({ t: e.textContent.trim().slice(0, 22), px: +fs.toFixed(1), mm: +(fs * arg.mmpx).toFixed(2),
        where: (e.closest("[id]") || {}).id || "?" });
    }
  };
  for (const id of ["hud-tl", "hud-tr", "cockpit", "bossbar", "skills", "xpbar", "toasts", "ticker", "saferoom", "inv", "sheet", "abil", "recap", "menu"]) {
    const e = document.getElementById(id); if (shown(e)) walk(e);
  }
  textNodes.sort((a, b) => a.px - b.px);

  // --- touch target census in millimetres ---
  const SEL = "button, .tab, .skill, .t-chip, [data-act], .acard, .bag-cell, .cell, .row, .item, .itile, .gchip, .glyph, .card, input, select, a, .seg, .tp-seg button";
  const targets = [...document.querySelectorAll(SEL)].filter(shown).map((e) => {
    const r = e.getBoundingClientRect();
    return { t: (e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : "") || e.tagName), w: +r.width.toFixed(0), h: +r.height.toFixed(0),
      mmW: +(r.width * arg.mmpx).toFixed(1), mmH: +(r.height * arg.mmpx).toFixed(1),
      where: (e.closest("[id]") || {}).id || "?" };
  });
  const under44 = targets.filter((t) => t.w < 44 || t.h < 44);
  const under7mm = targets.filter((t) => t.mmW < 7 || t.mmH < 7); // ISO 9241-9 / MIT 7mm

  // --- how much of the WORLD is left after the HUD? ---
  let hudPx = 0;
  const grid = [];
  const step = 8;
  for (let y = 0; y < VH; y += step) for (let x = 0; x < VW; x += step) {
    const e = document.elementFromPoint(x, y);
    const isWorld = !e || e.tagName === "CANVAS" || e.id === "t-stickzone" || e.id === "t-layer";
    if (!isWorld) { hudPx++; grid.push([x, y]); }
  }
  const cells = Math.ceil(VW / step) * Math.ceil(VH / step);

  return {
    vp: { w: VW, h: VH }, dpr: devicePixelRatio, body: document.body.className,
    uiclass: document.body.dataset.uiclass ?? null,
    boxes, chips, player, overlaps, intrusions,
    smallestText: textNodes.slice(0, 8),
    targets: { n: targets.length, under44: under44.length, under7mm: under7mm.length,
      worst: targets.slice().sort((a, b) => Math.min(a.mmW, a.mmH) - Math.min(b.mmW, b.mmH)).slice(0, 8) },
    hudCoverPct: +((hudPx / cells) * 100).toFixed(1),
  };
};

const ready = async (page) => {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    return !l || getComputedStyle(l).display === "none" || +getComputedStyle(l).opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1500);
};
const alive = (page) => page.evaluate(() => {
  const p = window.__dcc.state.players[0];
  p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing";
}).catch(() => {});

const SCENES = {
  combat: { u: `${TEST}&floor=6&level=14&seed=77`, async go(page) {
    await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
      if (live.length) { p.pos.x = live[0].pos.x + 1.4; p.pos.y = live[0].pos.y + 0.4; }
      p.hp = p.maxHp * 0.55;
    });
    await page.waitForTimeout(3000);
  } },
  boss: { u: `${TEST}&floor=3&level=14&seed=21`, async go(page) {
    await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      const b = st.monsters.find((m) => m.kind === "boss");
      if (b) { b.dormant = false; p.pos.x = b.pos.x + 2.2; p.pos.y = b.pos.y + 1.2; }
      clearInterval(window.__k);
      window.__k = setInterval(() => {
        const s = window.__dcc.state, q = s.players[0];
        q.hp = q.maxHp * 0.6; q.alive = true; q.downedT = 0;
        const bb = s.monsters.find((m) => m.kind === "boss");
        if (bb && bb.hp > 0) bb.hp = Math.max(bb.maxHp * 0.5, bb.hp);
      }, 150);
    });
    for (let i = 0; i < 40; i++) {
      const up = await page.evaluate(() => {
        const e = document.getElementById("bossbar");
        return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
      }).catch(() => false);
      if (up) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
  } },
};

const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const out = [];
const devList = (flag("devices") ?? "iphone13-land,iphone13promax-land,ipadpro11-land,pixel5-land").split(",");
const sceneList = (flag("scenes") ?? "combat,boss").split(",");
for (const dn of devList) {
  const spec = SPECS[dn];
  for (const sn of sceneList) {
    const sc = SCENES[sn];
    const ctx = await browser.newContext({ ...devices[spec.pw], hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    try {
      const q = `safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;
      await page.goto(`${BASE}/iso.html?${sc.u}&${q}`, { waitUntil: "load", timeout: 180000 });
      await ready(page);
      await alive(page);
      await sc.go(page);
      const r = await page.evaluate(READ, { safe: spec.safe, corner: spec.corner, mmpx: spec.mmpx });
      r.device = dn; r.scene = sn; r.errs = errs;
      out.push(r);
      await page.screenshot({ path: join(OUT, `${dn}-${sn}.png`), timeout: 180000 });
      console.log(`${dn}/${sn}: hudCover ${r.hudCoverPct}% · overlaps ${r.overlaps.length} · intrusions ${r.intrusions.length} · under7mm ${r.targets.under7mm}/${r.targets.n} · player under ${r.player && r.player.under}`);
    } catch (e) {
      console.log(`${dn}/${sn}: FAILED ${e.message}`);
      out.push({ device: dn, scene: sn, error: e.message });
    }
    await ctx.close();
  }
}
writeFileSync(join(OUT, "readability.json"), JSON.stringify(out, null, 1));
console.log("->", join(OUT, "readability.json"));
await browser.close();
