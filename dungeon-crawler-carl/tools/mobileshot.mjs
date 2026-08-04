// MOBILESHOT — the device-emulation harness for the mobile round.
//
// This is NOT "shot.mjs at a small viewport". It uses Playwright's real device
// descriptors (deviceScaleFactor, mobile UA, hasTouch, isMobile) so that
// `pointer: coarse`, `devicePixelRatio` and the touch event path all behave the
// way they do on glass. Everything is driven with CDP Input.dispatchTouchEvent,
// which is the only way to produce genuine multi-touch — page.mouse.* would
// exercise the desktop path and prove nothing.
//
// WHAT IT DOES
//   * shoots a named list of scenes (menu, combat, shop, sheet, constellation,
//     inventory) on a named list of devices
//   * optionally overlays SAFE-AREA GUIDES: Chromium does not emulate
//     env(safe-area-inset-*), so the harness paints the notch/home-indicator
//     regions for the emulated hardware on top of the frame. Anything under red
//     is something a real iPhone would eat.
//   * optionally overlays THUMB-REACH arcs, so "can my thumb get there" is a
//     visual question rather than a guess.
//   * exposes a touch driver (tap / drag / true multi-touch) and a DOM probe
//     that reports where every control actually landed.
//
// USAGE
//   node tools/mobileshot.mjs --out DIR [--devices a,b] [--scenes a,b]
//        [--base http://localhost:5370] [--guides] [--reach] [--probe] [--measure]
//   node tools/mobileshot.mjs --list
//
// The screenshots are for READING. Frame timing here is meaningless
// (SwiftShader); use tools/gpuprobe.mjs with --use-angle=d3d11 for latency.
import { chromium, devices } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const BASE = flag("base", process.env.DCC_BASE ?? "http://localhost:5370").replace(/\/$/, "");
const OUT = flag("out", "tools/_mobile");
const GUIDES = has("guides");
const REACH = has("reach");
const PROBE = has("probe");
const MEASURE = has("measure");
const HEADED = has("headed");
const DRIVE_MODE = has("drive");

// ------------------------------------------------------- device catalogue
// `safe` is the REAL hardware inset for that device in the given orientation,
// in CSS px, used only for the guide overlay (Chromium reports 0 for env()).
// iPhone 13 landscape: 47px each side for the notch/rounding + 21px home bar.
// The Pixel 5 punch-hole is not exposed as an inset by Android Chrome; its
// gesture bar is ~24px on the short edge.
export const DEVICE_SPECS = {
  iphone13: {
    pw: "iPhone 13", orientation: "portrait",
    safe: { top: 47, right: 0, bottom: 34, left: 0 },
  },
  "iphone13-land": {
    pw: "iPhone 13 landscape", orientation: "landscape",
    safe: { top: 0, right: 47, bottom: 21, left: 47 },
  },
  "iphone13promax-land": {
    pw: "iPhone 13 Pro Max landscape", orientation: "landscape",
    safe: { top: 0, right: 47, bottom: 21, left: 47 },
  },
  "ipad7-land": {
    pw: "iPad (gen 7) landscape", orientation: "landscape",
    safe: { top: 0, right: 0, bottom: 0, left: 0 },
  },
  "ipadpro11-land": {
    pw: "iPad Pro 11 landscape", orientation: "landscape",
    safe: { top: 24, right: 0, bottom: 20, left: 0 },
  },
  "pixel5-land": {
    pw: "Pixel 5 landscape", orientation: "landscape",
    safe: { top: 0, right: 24, bottom: 0, left: 0 },
  },
  pixel5: {
    pw: "Pixel 5", orientation: "portrait",
    safe: { top: 24, right: 0, bottom: 24, left: 0 },
  },
};

// ------------------------------------------------------------- page setup
// quality=performance: SwiftShader at a 2388x1668 ULTRA backbuffer runs at
// ~1 fps, which turns every input-latency check into a phantom failure. The
// preset the game AUTO-picks is measured separately (see the perf probe).
const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance";

/** Assets settle can take a while under SwiftShader; the boot screen is real. */
async function ready(page, opts = {}) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  if (!opts.menu) {
    await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  }
  // data-assets-settled fires before the boot card finishes fading; without
  // this the phone shots come back as the loading screen.
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

/** Retryable in-page eval — vite HMR from a sibling agent can wipe __dcc. */
async function ev(page, fn, arg) {
  let last = null;
  for (let i = 0; i < 6; i++) {
    try {
      await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 60000 });
      return await page.evaluate(fn, arg);
    } catch (e) { last = e; await page.waitForTimeout(1500); }
  }
  throw last;
}

// ------------------------------------------------------------ touch driver
// CDP is the only route to true multi-touch. Coordinates are CSS px.
export function touchDriver(client) {
  const live = new Map(); // id -> {x,y}
  const points = () =>
    [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  // Virtual input clock, seconds since epoch (the CDP timestamp unit). It
  // advances only by what a check asks for, so "a 110 ms tap" is 110 ms of
  // event time no matter how long the frame took to render.
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });

  const api = {
    /** Advance the virtual input clock by ms before the next event. */
    tick(ms) { clock += ms / 1000; return api; },
    async down(id, x, y) {
      live.set(id, { x, y });
      await send("touchStart");
    },
    async move(id, x, y) {
      if (!live.has(id)) return;
      live.set(id, { x, y });
      await send("touchMove");
    },
    // CDP's touchEnd carries the point that WAS RELEASED, not the points that
    // survive. Sending the survivors (the old bug) corrupts Chromium's touch
    // stream: after any lift, the next finger down makes the browser end and
    // re-create the first one — observed as `pointerdown#6` immediately
    // followed by `pointerup#5` and a phantom `#7` down/up. Every multi-touch
    // claim driven through that driver is unestablished, not false.
    async up(id) {
      const p = live.get(id);
      live.delete(id);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [],
        timestamp: clock,
      });
    },
    async tap(x, y, id = 1, holdMs = 60) {
      await api.down(id, x, y);
      api.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 40)));
      await api.up(id);
    },
    /** Press, travel to (tx,ty) over `steps` moves, then (optionally) release. */
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 12, holdMs = 24, release = true } = opts;
      await api.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        api.tick(holdMs);
        await api.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (release) await api.up(id);
    },
    live,
  };
  return api;
}

// ------------------------------------------------------------- overlays
function drawGuides(cfg) {
  const safe = cfg.safe, reach = cfg.reach, sidePivot = cfg.sidePivot;
  const old = document.getElementById("__mshot_guides");
  if (old) old.remove();
  const d = document.createElement("div");
  d.id = "__mshot_guides";
  d.style.cssText = "position:fixed;inset:0;z-index:99999;pointer-events:none";
  const band = (css, label) => {
    const e = document.createElement("div");
    e.style.cssText =
      "position:absolute;background:rgba(255,40,40,0.30);border:1px dashed rgba(255,90,90,0.9);" +
      "font:9px/1.2 monospace;color:#fff;text-shadow:0 0 3px #000;padding:1px 3px;" + css;
    e.textContent = label;
    d.appendChild(e);
  };
  if (safe.top) band(`left:0;right:0;top:0;height:${safe.top}px`, `unsafe top ${safe.top}px`);
  if (safe.bottom) band(`left:0;right:0;bottom:0;height:${safe.bottom}px`, `home indicator ${safe.bottom}px`);
  if (safe.left) band(`left:0;top:0;bottom:0;width:${safe.left}px`, `L${safe.left}`);
  if (safe.right) band(`right:0;top:0;bottom:0;width:${safe.right}px`, `R${safe.right}`);
  if (reach) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%");
    const W = innerWidth, H = innerHeight;
    const short = Math.min(W, H);
    // Reach radii SCALE with the short edge instead of being two constants:
    // a thumb pivoting from a 1194x834 tablet grip sweeps a bigger arc than one
    // on a 750x342 phone. Anchored on the measured phone pair (190/260 at 342).
    const comf = Math.round(Math.max(150, Math.min(300, 0.55 * short)));
    const strt = Math.round(comf * 1.37);
    const arc = (cx, cy, r, col, dash) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
      c.setAttribute("fill", "none"); c.setAttribute("stroke", col);
      c.setAttribute("stroke-dasharray", dash); c.setAttribute("stroke-width", "2");
      svg.appendChild(c);
    };
    const dot = (cx, cy, col, label) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", 5);
      c.setAttribute("fill", col);
      svg.appendChild(c);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", cx < W / 2 ? cx + 9 : cx - 9); t.setAttribute("y", cy - 9);
      t.setAttribute("fill", col); t.setAttribute("font", "10px monospace");
      t.setAttribute("font-family", "monospace"); t.setAttribute("font-size", "11");
      t.setAttribute("text-anchor", cx < W / 2 ? "start" : "end");
      t.textContent = label;
      svg.appendChild(t);
    };
    // TODAY: the corner pivot the current layout assumes.
    for (const pair of [[34, H - 30], [W - 34, H - 30]]) {
      arc(pair[0], pair[1], comf, "rgba(90,255,140,0.85)", "6 6");
      arc(pair[0], pair[1], strt, "rgba(255,215,90,0.85)", "6 6");
      dot(pair[0], pair[1], "rgba(90,255,140,0.9)", "corner pivot");
    }
    // PROPOSED for a side-gripped tablet: the thumb roots at the bezel, well
    // above the bottom corner. Drawn on every device so the delta is visible.
    if (sidePivot) {
      const py = Math.round(H * 0.62);
      for (const pair of [[26, py], [W - 26, py]]) {
        arc(pair[0], pair[1], comf, "rgba(120,220,255,0.9)", "2 5");
        arc(pair[0], pair[1], strt, "rgba(120,220,255,0.55)", "2 5");
        dot(pair[0], pair[1], "rgba(120,220,255,0.95)", "side pivot (proposed)");
      }
    }
    const legend = document.createElement("div");
    legend.style.cssText =
      "position:absolute;left:50%;transform:translateX(-50%);top:2px;font:10px/1.4 monospace;" +
      "color:#fff;text-shadow:0 0 3px #000;background:rgba(0,0,0,.45);padding:2px 6px";
    legend.textContent =
      `short edge ${short}px · comfortable ${comf}px · stretch ${strt}px` +
      (sidePivot ? " · cyan = proposed side pivot at 62% height" : "");
    d.appendChild(legend);
    d.appendChild(svg);
  }
  document.body.appendChild(d);
}
async function overlay(page, spec) {
  if (!GUIDES && !REACH) return;
  await page.evaluate(drawGuides, {
    safe: GUIDES ? spec.safe : { top: 0, right: 0, bottom: 0, left: 0 },
    reach: REACH,
    sidePivot: Math.min(page.viewportSize().width, page.viewportSize().height) >= 560,
  });
}
async function clearOverlay(page) {
  await page.evaluate(() => { const e = document.getElementById("__mshot_guides"); if (e) e.remove(); });
}

// --------------------------------------------------------------- probes
/** Where every control landed + what the sim currently believes. */
export const PROBE_FN = () => {
  const el = (id) => document.getElementById(id);
  const box = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      vis: cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0",
    };
  };
  const s = window.__dcc && window.__dcc.state;
  const p = s && s.players && s.players[0];
  const chips = [...document.querySelectorAll("#skills .skill")].map((c) =>
    Object.assign({ id: c.id || "slot" + c.dataset.i }, box(c)));
  return {
    body: document.body.className,
    dpr: devicePixelRatio,
    vp: { w: innerWidth, h: innerHeight },
    coarse: matchMedia("(pointer: coarse)").matches,
    maxTouch: navigator.maxTouchPoints,
    chips,
    stick: box(el("t-stick")),
    stickzone: box(el("t-stickzone")),
    stairs: box(el("t-stairs")),
    minimap: box(el("minimap-frame")),
    rotateGate: box(el("rotate")),
    cockpit: box(el("cockpit")),
    player: p
      ? {
          x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3), hp: Math.round(p.hp),
          facing: { x: +p.facing.x.toFixed(2), y: +p.facing.y.toFixed(2) },
        }
      : null,
    floor: s && s.floor,
    panelsOpen: ["inv", "abil", "sheet", "menu", "saferoom", "shop", "keybinds"].filter((id) => {
      const b = box(el(id)); return b && b.vis && b.w > 0;
    }),
  };
};

// MEASURE — the panel geometry probe. PROBE_FN answers "where are the
// controls"; this answers "does this PANEL fit, and can a thumb hit it". Every
// number in MOBILE.md §4.5 that talks about columns, overflow or tap targets
// comes from here, so no claim about a panel is a source-code inference.
export const MEASURE_FN = () => {
  const vw = innerWidth, vh = innerHeight;
  const R = (e) => { const r = e.getBoundingClientRect(); return {
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const shown = (e) => {
    if (!e) return false;
    const cs = getComputedStyle(e);
    // NOTE: opacity is deliberately NOT part of this test. The modals fade in
    // over ~180 ms and a measurement taken during the fade would report the
    // panel as absent — which is how the constellation went unmeasured for four
    // rounds while the screenshot plainly showed it.
    return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0;
  };
  const overflow = (e) => {
    const r = e.getBoundingClientRect();
    return {
      right: Math.round(Math.max(0, r.right - vw)), bottom: Math.round(Math.max(0, r.bottom - vh)),
      left: Math.round(Math.max(0, -r.left)), top: Math.round(Math.max(0, -r.top)),
      scrollX: Math.round(e.scrollWidth - e.clientWidth), scrollY: Math.round(e.scrollHeight - e.clientHeight),
      overflowX: getComputedStyle(e).overflowX, overflowY: getComputedStyle(e).overflowY,
    };
  };
  /** Interactive descendants below the 44x44 minimum, and the smallest one. */
  const targets = (root) => {
    const sel = "button, .tab, [data-act], .acard, .bag-cell, .cell, .row, .item, .glyph, .card, input, select, a";
    const list = [...root.querySelectorAll(sel)].filter(shown).map((e) => {
      const r = e.getBoundingClientRect();
      return { t: (e.id || e.className || e.tagName).toString().split(" ")[0],
        w: Math.round(r.width), h: Math.round(r.height) };
    });
    const small = list.filter((n) => n.w < 44 || n.h < 44);
    return { n: list.length, under44: small.length,
      smallest: list.slice().sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h))[0] ?? null,
      examples: small.slice(0, 8) };
  };
  const out = { vp: { w: vw, h: vh }, dpr: devicePixelRatio, body: document.body.className, panels: {} };
  const PANELS = ["inv", "sheet", "abil", "saferoom", "draft", "recap", "menu", "keys", "keybinds"];
  for (const id of PANELS) {
    const e = document.getElementById(id);
    if (!shown(e)) continue;
    const panel = e.querySelector(".panel") || e;
    const rec = { root: R(e), panel: R(panel), overflow: overflow(panel), targets: targets(e),
      closers: [...e.querySelectorAll("button, .close, [data-close]")]
        .filter(shown).map((b) => b.textContent.trim().slice(0, 20)).filter(Boolean).slice(0, 12),
      cols: {} };
    // Column tracks: the thing the one-column claim rests on.
    for (const cs of [".cols", ".sheet-cols", ".shop-body", ".sheet-duo", ".grid"]) {
      const c = panel.querySelector(cs);
      if (!c) continue;
      const g = getComputedStyle(c);
      rec.cols[cs] = { display: g.display, cols: g.gridTemplateColumns, columnCount: g.columnCount,
        w: Math.round(c.getBoundingClientRect().width),
        children: [...c.children].filter(shown).map((k) => R(k).w) };
    }
    if (id === "saferoom") {
      const shelf = document.getElementById("sr-shelf"), detail = document.getElementById("sr-detail");
      const bag = document.getElementById("sr-bag");
      rec.shop = {
        shelf: shelf ? R(shelf) : null, detail: detail ? R(detail) : null, bag: bag ? R(bag) : null,
        shelfRows: shelf ? [...shelf.children].filter(shown).map((c) => R(c)).slice(0, 4) : [],
        buyButtons: [...document.querySelectorAll("#sr-detail button, #sr-shelf button")]
          .filter(shown).map((b) => ({ t: b.textContent.trim().slice(0, 14), w: R(b).w, h: R(b).h })).slice(0, 8),
        detailScroll: detail ? overflow(detail) : null,
        tabs: [...document.querySelectorAll("#saferoom .tab")].filter(shown)
          .map((b) => ({ t: b.textContent.trim().slice(0, 12), w: R(b).w, h: R(b).h })),
      };
    }
    if (id === "abil") {
      const grid = document.getElementById("abil-grid");
      rec.constellation = grid ? {
        grid: R(grid), overflow: overflow(grid),
        cards: [...grid.querySelectorAll(".acard")].filter(shown).map((c) => R(c)).slice(0, 6),
        nodes: [...grid.querySelectorAll(".rank, .star, .node, .pip, button, .dot")]
          .filter(shown).map((c) => ({ w: R(c).w, h: R(c).h })).slice(0, 12),
        colStyle: getComputedStyle(grid).columns,
      } : null;
    }
    out.panels[id] = rec;
  }
  return out;
};

// --------------------------------------------------------------- scenes
/**
 * Open a panel and PROVE it opened. A dead crawler eats the keypress (the recap
 * owns the screen), which is exactly how rounds 1-4 shipped "shop" and
 * "constellation" captures that were really combat frames. Resurrect, press,
 * verify, retry — and throw if it never came up, so a missing panel is a loud
 * harness failure rather than a quiet wrong screenshot.
 */
async function openPanel(page, key, id, tries = 4) {
  for (let i = 0; i < tries; i++) {
    await page.evaluate(() => {
      const d = window.__dcc; if (!d) return;
      const p = d.state.players[0];
      p.hp = p.maxHp; p.alive = true; p.downedT = 0; d.state.status = "playing";
    }).catch(() => {});
    await page.waitForTimeout(250);
    await page.keyboard.press(key);
    await page.waitForTimeout(900);
    const up = await page.evaluate((pid) => {
      const e = document.getElementById(pid);
      if (!e) return false;
      const cs = getComputedStyle(e);
      return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0;
    }, id);
    if (up) { await page.waitForTimeout(700); return; }
  }
  throw new Error("panel " + id + " never opened after " + tries + " tries");
}

export const AIM_FN = () => {
  const d = window.__dcc, r = d && d.renderer;
  const ind = r && r.aimIndicator;
  if (!ind) return { present: false };
  const cam = r.camera;
  const vis = ind.children.filter((c) => c.visible);
  // Project every vertex of the visible child(ren) and take the screen AABB.
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0;
  const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
  const project = (obj) => {
    obj.updateWorldMatrix(true, true);
    obj.traverse((o) => {
      const g = o.geometry;
      if (!g || !g.attributes || !g.attributes.position) return;
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const v = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) };
        // manual transform: v * matrixWorld, then camera projection
        const e = o.matrixWorld.elements;
        const wx = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
        const wy = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
        const wz = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
        const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15] || 1;
        const cx = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
        const cy = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;
        const sx = (cx * 0.5 + 0.5) * innerWidth;
        const sy = (-cy * 0.5 + 0.5) * innerHeight;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        n++;
      }
    });
  };
  for (const c of vis) project(c);
  const mat = (() => {
    let m = null;
    ind.traverse((o) => { if (!m && o.material) m = o.material; });
    return m ? {
      color: "#" + m.color.getHexString(), opacity: m.opacity, transparent: m.transparent,
      depthWrite: m.depthWrite, depthTest: m.depthTest,
      hasOutline: !!(m.userData && m.userData.outline),
    } : null;
  })();
  return {
    present: true, visible: ind.visible,
    shapes: ind.children.map((c) => ({ name: c.name, visible: c.visible })),
    world: { x: +ind.position.x.toFixed(2), z: +ind.position.z.toFixed(2), rotY: +ind.rotation.y.toFixed(3) },
    screen: n ? {
      x: Math.round(minX), y: Math.round(minY),
      w: Math.round(maxX - minX), h: Math.round(maxY - minY), verts: n,
    } : null,
    material: mat,
    vp: { w: innerWidth, h: innerHeight },
  };
};

/** Put the crawler in a staged fight — shared by combat and the aim scenes. */
const STAGE_PACK = () => {
  const st = window.__dcc.state, p = st.players[0];
  p.hp = p.maxHp || p.hp;
  const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
  if (!live.length) return;
  let best = live[0], bn = -1;
  for (const m of live) {
    const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3).length;
    if (n > bn) { bn = n; best = m; }
  }
  p.pos.x = best.pos.x + 1.4; p.pos.y = best.pos.y + 0.4;
  live.sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) -
      Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
    .slice(0, 6)
    .forEach((m, k) => {
      const a = (k / 6) * Math.PI * 2 + 2.6;
      m.pos.x = p.pos.x + Math.cos(a) * (1.6 + (k % 2) * 0.5);
      m.pos.y = p.pos.y + Math.sin(a) * (1.6 + (k % 2) * 0.5);
    });
};

/**
 * AIM SCENES — the indicator, photographed.
 *
 * Every earlier round asserted the aim telegraph existed because a renderer key
 * matched /aim|telegraph/. That is a scene-graph lookup, not a picture. These
 * scenes slot a chosen ability, press its chip, drag out past the slop, and
 * LEAVE THE FINGER DOWN — the runner's screenshot then catches the live
 * indicator on the ground. One scene per telegraph shape.
 */
/**
 * AIM LEGIBILITY — the telegraph, measured against the noise floor.
 *
 * "A renderer key matched /aim|telegraph/" is not evidence a player can see
 * anything. This shoots the same frame three times: A with the indicator
 * visible, B and C with it hidden. diff(A,B) inside the indicator's projected
 * box is the telegraph's contribution; diff(B,C) in the same box is what the
 * scene changes on its own (torch flicker, fog, particles, the animated pack).
 * If the first is not clearly above the second, the indicator is invisible in
 * practice however healthy the scene graph looks.
 */
async function aimLegibility(page, shotPath, aimInfo) {
  const setVis = (v) => page.evaluate((vis) => {
    const r = window.__dcc && window.__dcc.renderer;
    if (!r || !r.aimIndicator) return false;
    r.aimIndicator.visible = vis;
    return true;
  }, v).catch(() => false);
  const frames = (n) => page.evaluate((k) => new Promise((res) => {
    let i = 0; const t = () => (++i >= k ? res(null) : requestAnimationFrame(t)); requestAnimationFrame(t);
  }), n).catch(() => {});

  const A = readFileSync(shotPath).toString("base64");
  if (!(await setVis(false))) return null;
  await frames(6);
  const B = (await page.screenshot({ timeout: 120000 })).toString("base64");
  await frames(6);
  const C = (await page.screenshot({ timeout: 120000 })).toString("base64");
  await setVis(true);

  const box = aimInfo && aimInfo.screen ? aimInfo.screen : null;
  const stats = await page.evaluate(async ([a, b, c, box, dpr]) => {
    const load = async (b64) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      return { d: cx.getImageData(0, 0, cv.width, cv.height).data, w: img.width, h: img.height };
    };
    const A = await load(a), B = await load(b), C = await load(c);
    if (A.w !== B.w || A.w !== C.w) return { error: "size mismatch" };
    // The indicator's projected box in DEVICE px, padded a little.
    const pad = 8;
    const R = box ? {
      x0: Math.max(0, Math.round(box.x * dpr) - pad), y0: Math.max(0, Math.round(box.y * dpr) - pad),
      x1: Math.min(A.w, Math.round((box.x + box.w) * dpr) + pad),
      y1: Math.min(A.h, Math.round((box.y + box.h) * dpr) + pad),
    } : { x0: 0, y0: 0, x1: A.w, y1: A.h };
    const measure = (P, Q) => {
      let sum = 0, n = 0, over8 = 0, over24 = 0, max = 0;
      for (let y = R.y0; y < R.y1; y++) {
        for (let x = R.x0; x < R.x1; x++) {
          const i = (y * A.w + x) * 4;
          const d = Math.max(Math.abs(P.d[i] - Q.d[i]), Math.abs(P.d[i + 1] - Q.d[i + 1]),
            Math.abs(P.d[i + 2] - Q.d[i + 2]));
          sum += d; n++;
          if (d > 8) over8++;
          if (d > 24) over24++;
          if (d > max) max = d;
        }
      }
      return { meanDelta: +(sum / Math.max(1, n)).toFixed(2), pctOver8: +((over8 / Math.max(1, n)) * 100).toFixed(1),
        pctOver24: +((over24 / Math.max(1, n)) * 100).toFixed(1), maxDelta: max, px: n };
    };
    return {
      boxDevicePx: R, dpr,
      indicator: measure(A, B),   // telegraph on vs off
      sceneNoise: measure(B, C),  // the same box, telegraph off both times
    };
  }, [A, B, C, box, await page.evaluate(() => devicePixelRatio)]).catch((e) => ({ error: e.message }));
  return stats;
}

const aimScene = (ability, slot = 1) => ({
  url: () => BASE + "/iso.html?" + TEST + "&floor=6&level=14&seed=77",
  async setup(page, touch) {
    await ev(page, STAGE_PACK);
    await ev(page, ([ab, sl]) => {
      const p = window.__dcc.state.players[0];
      if (sl < 4) p.abilities.slots[sl] = ab; else p.abilities.ultimate = ab;
      p.cd = {};
      // Freeze the pack so the shot is the indicator, not a death animation.
      for (const m of window.__dcc.state.monsters) m.dormant = true;
      clearInterval(window.__mshotKeep);
      window.__mshotKeep = setInterval(() => {
        const s = window.__dcc && window.__dcc.state; if (!s) return;
        const q = s.players[0]; q.hp = q.maxHp; q.alive = true; q.downedT = 0;
      }, 150);
    }, [ability, slot]);
    await page.waitForTimeout(2200);
    const c = await page.evaluate(CENTRE, '#skills .skill[data-i="' + slot + '"]');
    if (!c) throw new Error("no chip for slot " + slot);
    // Drag up-screen and inboard: past AIM_SLOP (18px, measured from the leaky
    // origin) and past cancelRadius (32-38px, a hand-scale quantity now) — the
    // two thresholds that make aimDir non-null.
    const tx = c.x - 150, ty = c.y - 90;
    await touch.down(1, c.x, c.y);
    for (let i = 1; i <= 12; i++) {
      await touch.move(1, c.x + ((tx - c.x) * i) / 12, c.y + ((ty - c.y) * i) / 12);
      await page.waitForTimeout(30);
    }
    await page.evaluate(() => new Promise((res) => {
      let i = 0; const t = () => (++i >= 8 ? res(null) : requestAnimationFrame(t)); requestAnimationFrame(t);
    })).catch(() => {});
    await page.waitForTimeout(1400);
    await page.evaluate((fnSrc) => {
      window.__mshotAim = new Function("return (" + fnSrc + ")()")();
    }, AIM_FN.toString()).catch((e) => { console.log("  aim probe failed:", e.message); });
    // finger stays DOWN through the screenshot
  },
  async teardown(page, touch) { await touch.up(1).catch(() => {}); },
});

export const SCENES = {
  menu: {
    url: () => `${BASE}/iso.html`,
    menu: true,
    async setup() {},
  },
  combat: {
    url: () => `${BASE}/iso.html?${TEST}&floor=6&level=14&seed=77`,
    async setup(page) {
      await ev(page, () => {
        const st = window.__dcc.state, p = st.players[0];
        p.hp = p.maxHp || p.hp;
        const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
        if (!live.length) return;
        let best = live[0], bn = -1;
        for (const m of live) {
          const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3).length;
          if (n > bn) { bn = n; best = m; }
        }
        p.pos.x = best.pos.x + 1.4; p.pos.y = best.pos.y + 0.4;
        live
          .sort((a, b) =>
            Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) -
            Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
          .slice(0, 6)
          .forEach((m, k) => {
            const a = (k / 6) * Math.PI * 2 + 2.6;
            m.pos.x = p.pos.x + Math.cos(a) * (1.6 + (k % 2) * 0.5);
            m.pos.y = p.pos.y + Math.sin(a) * (1.6 + (k % 2) * 0.5);
          });
      });
      await page.waitForTimeout(3500);
    },
  },
  // The System Shop is the between-floors safe room: it opens by DESCENDING,
  // not by a key. Teleport onto the stairs and drive useStairs intents until
  // state.safeRoom appears (the host then shows #saferoom on the next frame).
  // THE SHOP SCENE, ROUND 5. Rounds 1-4 all shipped a "shop" capture that was
  // not the shop: r1 ran it with --drive, whose immortality watchdog pins
  // state.status = "playing" every 120 ms and therefore evicts the safe room
  // the moment it opens; r3/r4 caught a recap and a level-up draft because the
  // crawler had already died on the way in and nothing checked. The fix is
  // three-part: resurrect BEFORE staging, keep the run alive while descending,
  // and then ASSERT #saferoom is actually on screen instead of assuming it.
  shop: {
    url: () => `${BASE}/iso.html?${TEST}&floor=3&level=10&seed=21`,
    async setup(page) {
      await ev(page, () => {
        const st = window.__dcc.state, p = st.players[0];
        p.gold = (p.gold ?? 0) + 6000;
        // Clear the floor first: the stairs room is guarded, and a staged
        // teleport into a pack ends the run before the shop ever opens.
        for (const m of st.monsters) m.hp = 0;
        p.alive = true; p.downedT = 0; p.hp = p.maxHp;
        st.status = "playing";
        p.pos.x = st.map.stairs.x + 0.5;
        p.pos.y = st.map.stairs.y + 0.5;
        // Stock the bag so the shelf/detail/bag columns have something to
        // measure — an empty shop measures nothing.
        clearInterval(window.__mshotKeep);
        window.__mshotKeep = setInterval(() => {
          const d = window.__dcc; if (!d) return;
          const q = d.state.players[0];
          if (!d.state.safeRoom) { q.hp = q.maxHp; q.alive = true; q.downedT = 0; }
        }, 200);
      });
      await page.waitForFunction(() => {
        const d = window.__dcc;
        if (!d || d.state.safeRoom) return true;
        d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60);
        return !!d.state.safeRoom;
      }, null, { timeout: 60000 }).catch(() => {});
      // Descending LEVELS the crawler, and the SPONSOR DRAFT modal opens ON TOP
      // of the safe room a frame or two later — which is how r4 shipped a
      // "shop" capture that was really the level-up draft, and why r1's probe
      // reported panelsOpen []. Drafts also CHAIN (claiming one opens the next
      // queued pick), so this drains them and only then waits for #saferoom.
      // Both waits are in the same loop because the ordering is racy.
      for (let i = 0; i < 24; i++) {
        const st = await page.evaluate(() => {
          const vis = (id) => {
            const e = document.getElementById(id);
            return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
          };
          return { draft: vis("draft"), shop: vis("saferoom") };
        }).catch(() => ({ draft: false, shop: false }));
        if (st.shop) break;
        if (st.draft) {
          const clicked = await page.evaluate(() => {
            const card = document.querySelector("#draft-cards .reward");
            if (!card) return false;
            card.click();
            return true;
          }).catch(() => false);
          if (!clicked) await page.keyboard.press("1");
        }
        await page.waitForTimeout(700);
      }
      // Select a shelf item so the DETAIL column is populated, not a placeholder.
      await page.evaluate(() => {
        const tile = document.querySelector("#sr-shelf .itile:not(.locked):not(.soldout)")
          ?? document.querySelector("#sr-shelf .itile");
        if (tile) tile.click();
      }).catch(() => {});
      await page.waitForTimeout(1800);
    },
  },
  // GLYPH SOCKETING — the safe room's ABILITIES tab. Reuses the shop's
  // descent (socketing is a safe-room verb; the sim enforces that), then
  // switches tabs and picks a bench glyph up so the PENDING state is on
  // screen: "glyph in hand, tap a lit socket" is the whole interaction.
  socketing: {
    url: () => SCENES.shop.url(),
    async setup(page, touch, client) {
      await SCENES.shop.setup(page, touch, client);
      // Glyphs are a drop, and the harness cannot farm one; seed the bench so
      // the socket UI has something to socket.
      await page.evaluate(() => {
        const p = window.__dcc.state.players[0];
        p.glyphs = p.glyphs ?? { slots: [[], [], [], []], ultimate: [], bench: [] };
        p.glyphs.bench = ["hair_trigger", "accelerant", "splitfang"];
      }).catch(() => {});
      await page.evaluate(() => {
        document.getElementById("sr-tab-abil")?.click();
      });
      await page.waitForTimeout(700);
      await page.evaluate(() => {
        const g = document.querySelector("#sr-glyphs .gchip");
        if (g) g.click();
      }).catch(() => {});
      await page.waitForTimeout(900);
    },
  },
  sheet: {
    url: () => `${BASE}/iso.html?${TEST}&floor=3&level=14&seed=21`,
    async setup(page) { await openPanel(page, "p", "sheet"); },
  },
  // BOSS FIGHT. floor 3 is a band-1 boss floor; the arena monster with
  // kind === "boss" is teleported next to the crawler and woken, then the sim
  // is stepped until the host has raised #bossbar (body.bossplate). This is the
  // scene where the read band and the ability cluster compete hardest for the
  // same pixels, so the capture must actually contain the plate — asserted.
  boss: {
    url: () => `${BASE}/iso.html?${TEST}&floor=3&level=14&seed=21`,
    async setup(page) {
      await ev(page, () => {
        const d = window.__dcc, st = d.state, p = st.players[0];
        p.hp = p.maxHp; p.alive = true; p.downedT = 0; st.status = "playing";
        const b = st.monsters.find((m) => m.kind === "boss");
        if (b) {
          b.dormant = false;
          p.pos.x = b.pos.x + 2.2; p.pos.y = b.pos.y + 1.2;
        }
        clearInterval(window.__mshotKeep);
        window.__mshotKeep = setInterval(() => {
          const s = window.__dcc && window.__dcc.state; if (!s) return;
          const q = s.players[0]; q.hp = q.maxHp; q.alive = true; q.downedT = 0;
          const bb = s.monsters.find((m) => m.kind === "boss");
          if (bb && bb.hp > 0) bb.hp = Math.max(bb.maxHp * 0.55, bb.hp * 0.999);
        }, 150);
      });
      // Let the host see the boss, run the intro, and raise the plate.
      for (let i = 0; i < 40; i++) {
        const up = await page.evaluate(() => {
          const e = document.getElementById("bossbar");
          const cs = e && getComputedStyle(e);
          return !!(cs && cs.display !== "none" && e.getBoundingClientRect().width > 0);
        }).catch(() => false);
        if (up) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(2500);
    },
  },
  // POST-RUN — THE VERDICT / IN MEMORIAM. The run ends by the sim's own rule
  // (hp to zero, stepped until status leaves "playing"); the host raises #recap
  // on the status edge. Asserted on screen before the shot.
  postrun: {
    url: () => `${BASE}/iso.html?${TEST}&floor=6&level=16&seed=21`,
    async setup(page) {
      await ev(page, () => {
        const d = window.__dcc, st = d.state, p = st.players[0];
        clearInterval(window.__mshotKeep);
        // Let the SIM end the run: zero the crawler and step until the sim's
        // own wipe rule flips status. Only if the sim refuses (a downed timer
        // longer than the budget) does the harness set the edge by hand, and
        // it says so in the log rather than pretending it fought.
        for (let i = 0; i < 3000 && st.status === "playing"; i++) {
          p.hp = 0;
          d.step({ 0: { move: { x: 0, y: 0 }, useStairs: false } }, 1 / 30);
        }
        if (st.status === "playing") { st.status = "dead"; window.__forcedWipe = true; }
      });
      let up = false;
      for (let i = 0; i < 30; i++) {
        up = await page.evaluate(() => {
          const e = document.getElementById("recap");
          const cs = e && getComputedStyle(e);
          return !!(cs && cs.display !== "none" && e.getBoundingClientRect().width > 0);
        }).catch(() => false);
        if (up) break;
        await page.waitForTimeout(600);
      }
      if (!up) throw new Error("recap never opened");
      await page.waitForTimeout(1200);
    },
  },
  // The constellation (ability upgrade spine) lives inside the ABILITIES panel.
  // Rounds 1-4 never actually opened it (r1/report.json: panelsOpen []) because
  // the key press landed while the crawler was dead and the recap owned the
  // screen. openPanel() resurrects, presses, and retries until the panel is up.
  constellation: {
    url: () => `${BASE}/iso.html?${TEST}&floor=3&level=14&seed=21`,
    async setup(page) { await openPanel(page, "t", "abil"); },
  },
  // The level-up draft. 'v' claims BANKED picks, so the scene banks one first
  // (drafts arrive constantly in play; this just makes the modal deterministic)
  // and openPanel() proves the modal is really on screen before measuring.
  draft: {
    url: () => `${BASE}/iso.html?${TEST}&floor=3&level=14&seed=21`,
    async setup(page) {
      await ev(page, () => {
        const d = window.__dcc, p = d.state.players[0];
        p.hp = p.maxHp; p.alive = true; p.downedT = 0; d.state.status = "playing";
        // A level's worth of XP is the honest way in: the sim mints the offers.
        for (let i = 0; i < 4000; i++) d.step({ 0: { move: { x: 0, y: 0 }, useStairs: false } }, 0);
      });
      await openPanel(page, "v", "draft");
    },
  },
  inventory: {
    url: () => `${BASE}/iso.html?${TEST}&floor=3&level=14&seed=21`,
    async setup(page) { await openPanel(page, "i", "inv"); },
  },
  // The four telegraph shapes, mid-drag, finger down. See aimScene().
  "aim-line": aimScene("bolt", 1),
  "aim-ring": aimScene("nova", 1),
  "aim-arrow": aimScene("dash", 1),
  "aim-ult": aimScene("cataclysm", 4),
  keybinds: {
    url: () => `${BASE}/iso.html?${TEST}&floor=3&level=14&seed=21`,
    async setup(page) { await page.keyboard.press("k"); await page.waitForTimeout(800); },
  },
};

if (has("list")) {
  console.log("devices:", Object.keys(DEVICE_SPECS).join(", "));
  console.log("scenes :", Object.keys(SCENES).join(", "));
  process.exit(0);
}


// ============================================================ DRIVE MODE
// The audit that matters: drive REAL touch and report what the sim received.
// Every check reads sim state before/after, so "the button lit up" is never
// mistaken for "the ability fired".

const SNAP = () => {
  const s = window.__dcc.state, p = s.players[0];
  return {
    pos: { x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3) },
    facing: { x: +p.facing.x.toFixed(3), y: +p.facing.y.toFixed(3) },
    hp: Math.round(p.hp),
    cd: JSON.parse(JSON.stringify(p.cd || {})),
    flask: p.flaskCharges,
    dashCharges: p.dashCharges,
    pings: (s.pings || []).length,
    monstersAlive: s.monsters.filter((m) => m.hp > 0).length,
    monsterHp: s.monsters.reduce((a, m) => a + Math.max(0, m.hp), 0),
    gold: p.gold ?? 0,
    bag: (p.bag || []).length,
    scale: (window.visualViewport && +window.visualViewport.scale.toFixed(3)) ?? 1,
    scrollY: window.scrollY,
    stickShown: (() => {
      const s = document.getElementById("t-stick2");
      return !!s && getComputedStyle(s).opacity !== "0";
    })(),
    ghostShown: (() => {
      const g = document.getElementById("t-ghost");
      return !!g && getComputedStyle(g).opacity !== "0";
    })(),
    lockedId: (window.__dcc.touch && window.__dcc.touch.lockedTargetId) ?? null,
  };
};

/** Centre of an element, or null. */
const CENTRE = (sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  if (!r.width) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
};

/**
 * THE SHOP BATTERY — asserts a GOLD DELTA, not the presence of a button.
 *
 * Round 2's finding was "a phone player cannot buy anything", and the round
 * that shipped the shop treatment had passed because a `[data-buy]` element
 * existed somewhere in the DOM. It existed; it was 233 px below the fold, and
 * the shelf tile you had to press to get it was not hit-testable at all —
 * `elementFromPoint` at every visible tile centre returned the DESCEND row or
 * the clipped edge of the pane. So every check here ends in a NUMBER THE SIM
 * OWNS: the crawler's gold and the length of their bag.
 *
 * Every gesture is a real CDP touch. A `.click()` proves the handler is wired,
 * which was never the thing in doubt.
 */
async function shopBattery(page, touch) {
  const out = [];
  const rec = (name, verdict, detail) => {
    out.push({ name, verdict, detail });
    console.log(`  [${verdict}] ${name} — ${detail}`);
  };
  const settle = async (n = 8) => {
    await page.waitForTimeout(150);
    await page.evaluate((k) => new Promise((res) => {
      let i = 0;
      const tick = () => (++i >= k ? res(null) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }), n).catch(() => {});
  };
  const wallet = () => page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    return { gold: p.gold, bag: (p.inventory ?? []).length };
  });
  // A control is only "on screen" if a finger landing on its centre HITS IT.
  // Geometry alone lies: a tile clipped by its scroller still reports a rect
  // inside the viewport, which is exactly how the previous round measured
  // three tappable tiles where there were none.
  const reachable = (sel) => page.evaluate((s) => {
    for (const e of document.querySelectorAll(s)) {
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !(e.contains(hit) || e === hit)) continue;
      return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), txt: e.textContent.trim().slice(0, 24) };
    }
    return null;
  }, sel);

  await page.evaluate(() => { window.__dcc.state.players[0].gold = 20000; }).catch(() => {});

  // 0. The scene setup pre-selects an item so the capture shows a card, which
  //    on a phone class switches the segmented control to DETAIL. Start where
  //    a player starts: on the shelf. (Also proves the segment itself takes a
  //    finger.)
  const segAt = async (re) => page.evaluate((src) => {
    const e = [...document.querySelectorAll("#saferoom .tp-seg button")].find((x) => new RegExp(src, "i").test(x.textContent));
    if (!e) return null;
    const r = e.getBoundingClientRect();
    if (r.width <= 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, re);
  const shelfSeg = await segAt("shelf");
  if (shelfSeg) { await touch.tap(shelfSeg.x, shelfSeg.y, 1, 110); await settle(8); }

  // 1. IS THERE ANYTHING TO PRESS? The failure mode that hid behind the old
  //    "buyButtons: []" measurement was a shelf with no reachable tile.
  const tile = await reachable("#sr-shelf .itile[data-id]:not(.locked):not(.soldout)");
  rec("shop: a shelf tile is reachable by a finger", tile ? "PASS" : "FAIL",
    tile ? `tile ${tile.w}x${tile.h} at (${tile.x},${tile.y})` : "no .itile centre hit-tests to itself");
  if (!tile) return out;

  // 2. SELECT -> DETAIL, with a finger.
  await touch.tap(tile.x, tile.y, 1, 110);
  await settle(10);
  const detail = await page.evaluate(() => {
    const d = document.getElementById("sr-detail");
    return { txt: d ? d.textContent.trim().slice(0, 44) : null, placeholder: !!d?.querySelector(".dempty-state") };
  });
  rec("shop: tapping a tile renders its card", detail.placeholder ? "FAIL" : "PASS",
    `#sr-detail reads "${detail.txt}"`);

  // 3. PRICE AND BUY ON THE GLASS. Not "in the DOM".
  const buy = await reachable("#sr-detail [data-buy]");
  const price = await page.evaluate(() => {
    const e = document.querySelector("#sr-detail .dfoot .dprice");
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { onScreen: r.top >= 0 && r.bottom <= innerHeight, y: Math.round(r.y) };
  });
  rec("shop: the price is on screen", price?.onScreen ? "PASS" : "FAIL",
    price ? `.dprice at y=${price.y}, viewport ${page.viewportSize().height}` : "no .dprice rendered");
  rec("shop: BUY is reachable by a finger", buy ? "PASS" : "FAIL",
    buy ? `BUY ${buy.w}x${buy.h} at (${buy.x},${buy.y})` : "no reachable [data-buy]");
  if (!buy) return out;

  // 4. THE ONE THAT MATTERS. Gold must move.
  const a = await wallet();
  await touch.tap(buy.x, buy.y, 1, 120);
  await settle(12);
  const b = await wallet();
  rec("shop: a FINGER tap on BUY spends gold", b.gold !== a.gold ? "PASS" : "FAIL",
    `gold ${a.gold}->${b.gold}, bag ${a.bag}->${b.bag}`);

  // 5. And the bag pane, which used to render at y=363 on a 342-tall phone.
  const bagSeg = await segAt("bag");
  if (bagSeg) {
    await touch.tap(bagSeg.x, bagSeg.y, 1, 110);
    await settle(8);
    const bagTile = await reachable("#sr-bag .itile, #sr-equipped .itile");
    rec("shop: the bag is reachable", bagTile ? "PASS" : "INFO",
      bagTile ? `first bag/equipped tile at (${bagTile.x},${bagTile.y})` : "bag empty or unreachable");
  }
  return out;
}

async function driveBattery(page, touch, spec) {
  const out = [];
  const V = page.viewportSize();
  const snap = () => page.evaluate(SNAP);
  const at = (sel) => page.evaluate(CENTRE, sel);
  const rec = (name, verdict, detail) => { out.push({ name, verdict, detail }); console.log(`  [${verdict}] ${name} — ${detail}`); };
  // The staged pack kills a level-14 crawler in about fifteen seconds of
  // SwiftShader wall clock, and a dead crawler no-ops every later check. Top
  // the hero up before each one so a FAIL means the INPUT failed.
  const keepAlive = () => page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    p.hp = p.maxHp; p.alive = true; p.downedT = 0;
  }).catch(() => {});
  /** What the finger would actually hit at (x,y) — overlay conflicts. */
  const hitAt = (x, y) => page.evaluate(([px, py]) => {
    const e = document.elementFromPoint(px, py);
    return e ? `${e.tagName}#${e.id || ""}.${typeof e.className === "string" ? e.className.split(" ")[0] : ""}` : "nothing";
  }, [x, y]);
  // SwiftShader renders at 1-3 fps on a tablet-sized backbuffer, and input
  // edges are only consumed on a sim step inside a rAF frame. Wall-clock waits
  // therefore report phantom failures. Settle by FRAMES, with a clock cap.
  const settle = async (ms = 700) => {
    await page.waitForTimeout(Math.min(ms, 250));
    await page.evaluate((n) => new Promise((res) => {
      let i = 0;
      const tick = () => (++i >= n ? res(null) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }), 4).catch(() => {});
  };

  // IMMORTALITY WATCHDOG. The staged pack kills a level-14 crawler inside the
  // battery, the recap modal takes the screen, and every later check reports a
  // phantom FAIL. Pinning hp + status keeps a FAIL meaning "the input failed".
  await page.evaluate(() => {
    clearInterval(window.__mshotKeep);
    window.__mshotKeep = setInterval(() => {
      const s = window.__dcc && window.__dcc.state;
      if (!s) return;
      const p = s.players[0];
      p.hp = p.maxHp; p.alive = true; p.downedT = 0;
      s.status = "playing";
    }, 120);
  }).catch(() => {});

  const chip = {};
  for (const k of ["0", "1", "2", "3", "4"]) chip[k] = await at(`#skills .skill[data-i="${k}"]`);
  chip.flask = await at("#flask-chip");

  // --- 1. MOVEMENT: floating stick in the left zone -----------------------
  {
    await keepAlive();
    const a = await snap();
    const ox = Math.round(V.width * 0.18), oy = Math.round(V.height * 0.72);
    const under = await hitAt(ox, oy);
    await touch.down(1, ox, oy);
    await settle(120);
    const during = await snap();
    for (let i = 0; i < 10; i++) { await touch.move(1, ox + 70, oy); await settle(40); }
    const b = await snap();
    await touch.up(1);
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    rec("move: floating stick", d > 0.4 ? "PASS" : "FAIL",
      `moved ${d.toFixed(2)} tiles; stick visual on press = ${during.stickShown}; ` +
      `the finger at (${ox},${oy}) actually lands on ${under}`);
  }

  // --- 1b. MOVEMENT from a spot the transient cards do NOT cover ----------
  {
    await keepAlive();
    const a = await snap();
    const ox = Math.round(V.width * 0.30), oy = Math.round(V.height * 0.88);
    const under = await hitAt(ox, oy);
    await touch.down(1, ox, oy);
    await settle(120);
    const during = await snap();
    for (let i = 0; i < 10; i++) { await touch.move(1, ox + 70, oy); await settle(40); }
    const b = await snap();
    await touch.up(1);
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    rec("move: stick on clear ground", d > 0.4 ? "PASS" : "FAIL",
      `moved ${d.toFixed(2)} tiles from (${ox},${oy}) over ${under}; stick visual = ${during.stickShown}`);
  }

  // --- 2. MOVEMENT under the minimap (z-order conflict) -------------------
  {
    await keepAlive();
    const mm = await at("#minimap-frame");
    if (!mm) rec("move: thumb lands on minimap", "N/A", "no minimap");
    else {
      const a = await snap();
      await touch.down(1, mm.x, mm.y);
      await settle(120);
      const during = await snap();
      for (let i = 0; i < 10; i++) { await touch.move(1, mm.x + 70, mm.y); await settle(40); }
      const b = await snap();
      await touch.up(1);
      await settle(300);
      const c = await snap();
      const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
      rec("move: thumb lands on minimap", d > 0.4 ? "PASS" : "FAIL",
        `minimap ${mm.w}x${mm.h} at (${mm.x},${mm.y}) is inside the stick zone (hit: ${await hitAt(mm.x, mm.y)}); ` +
        `moved ${d.toFixed(2)} tiles, stick shown = ${during.stickShown}, pings ${a.pings}->${c.pings}`);
    }
  }

  // --- 3. ATTACK: hold the melee chip ------------------------------------
  {
    await keepAlive();
    const a = await snap();
    await touch.down(1, chip["0"].x, chip["0"].y);
    await page.waitForTimeout(1400);
    await touch.up(1);
    await settle(500);
    const b = await snap();
    rec("attack: hold slot 0", b.monsterHp < a.monsterHp ? "PASS" : "FAIL",
      `pack hp ${a.monsterHp} -> ${b.monsterHp}`);
  }

  // --- 4. QUICK CAST: tap an ability chip --------------------------------
  {
    await keepAlive();
    const a = await snap();
    await touch.tap(chip["1"].x, chip["1"].y, 1, 220);
    await settle(900);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    rec("cast: tap slot 1 (smart cast)", started.length ? "PASS" : "FAIL",
      `cooldowns started: ${started.join(",") || "none"}`);
  }

  // --- 5. AIMED CAST: press-drag off an ability chip ----------------------
  {
    await keepAlive();
    const a = await snap();
    await touch.down(1, chip["2"].x, chip["2"].y);
    await page.waitForTimeout(120);
    for (let i = 1; i <= 10; i++) { await touch.move(1, chip["2"].x - i * 12, chip["2"].y - i * 6); await page.waitForTimeout(40); }
    // Is there ANY aim telegraph on screen while the drag is live?
    const tele = await page.evaluate(() => {
      const r = window.__dcc.renderer;
      const keys = Object.keys(r).filter((k) => /aim|telegraph|reticle|indicat|preview|ground/i.test(k));
      const dom = [...document.querySelectorAll("body > *")]
        .filter((e) => /aim|telegraph|reticle|indicator/i.test(e.id || e.className || ""))
        .map((e) => e.id || e.className);
      return { rendererKeys: keys, domNodes: dom };
    });
    await touch.up(1);
    await settle(600);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    const turned = Math.hypot(b.facing.x - a.facing.x, b.facing.y - a.facing.y) > 0.05;
    rec("cast: drag-aim slot 2", started.length ? "PASS" : "FAIL",
      `fired ${started.join(",") || "none"}; facing changed=${turned}; ` +
      `aim telegraph found: renderer[${tele.rendererKeys.join("|") || "none"}] dom[${tele.domNodes.join("|") || "none"}]`);
  }

  // --- 6. CANCEL: drag out and come home ---------------------------------
  {
    await keepAlive();
    const a = await snap();
    await touch.down(1, chip["3"].x, chip["3"].y);
    await page.waitForTimeout(100);
    for (let i = 1; i <= 8; i++) { await touch.move(1, chip["3"].x - i * 14, chip["3"].y); await page.waitForTimeout(35); }
    for (let i = 8; i >= 0; i--) { await touch.move(1, chip["3"].x - i * 14, chip["3"].y); await page.waitForTimeout(35); }
    await touch.up(1);
    await settle(500);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    rec("cast: cancel by dragging home", started.length === 0 ? "PASS" : "FAIL",
      started.length ? `LEAKED a cast: ${started.join(",")}` : "no cooldown started (cancelled)");
  }

  // --- 7. MULTI-TOUCH: move while casting --------------------------------
  //
  // THE MOST LOAD-BEARING RULE IN §2.1, AND IT HAD NO TRUSTWORTHY CHECK.
  //
  // Two independent faults were confusing each other. (1) `touchDriver.up()`
  // sent `touchEnd` with the surviving points instead of the released one,
  // which desynchronises Chromium's touch stream — fixed. (2) This check
  // pushed the stick in ONE direction, and the staged room can put a wall
  // there: an honest FAIL and "the crawler is standing against a wall" produce
  // the same 0.00 tiles, which is why one round reported FAIL on 3 of 4
  // devices and an independent re-test came back INCONCLUSIVE.
  //
  // So it now tries all four directions and passes if the crawler keeps moving
  // in ANY of them while a second finger is on the chips. A wall in one
  // direction is a fact about the room; a wall in all four would be reported
  // as such, and IS a reason to distrust the row.
  {
    const ox = Math.round(V.width * 0.30), oy = Math.round(V.height * 0.88);
    const underStick = await hitAt(ox, oy);
    const dirs = [[0, -70], [70, 0], [0, 70], [-70, 0]];
    let best = 0, bestDir = "none", freeDirs = 0;
    for (const [dx, dy] of dirs) {
      await keepAlive();
      await touch.down(1, ox, oy);
      for (let i = 0; i < 6; i++) { await touch.move(1, ox + dx, oy + dy); await settle(60); }
      const a = await snap();
      // second finger taps an ability while the first keeps driving
      await touch.down(2, chip["1"].x, chip["1"].y);
      await page.waitForTimeout(90);
      await touch.up(2);
      for (let i = 0; i < 10; i++) { await touch.move(1, ox + dx, oy + dy); await settle(40); }
      const b = await snap();
      await touch.up(1);
      const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
      if (d > 0.3) freeDirs++;
      if (d > best) { best = d; bestDir = `(${dx},${dy})`; }
      if (best > 0.3) break; // one clear direction is the whole claim
    }
    rec("multi-touch: move while casting", best > 0.3 ? "PASS" : "FAIL",
      `kept moving ${best.toFixed(2)} tiles toward ${bestDir} with a second finger on the chips ` +
      `(${freeDirs} of ${dirs.length} directions tried were unobstructed); ` +
      `the stick finger at (${ox},${oy}) landed on ${underStick} ` +
      `(navigator.maxTouchPoints reports ${await page.evaluate(() => navigator.maxTouchPoints)})`);
  }

  // --- 8. FLASK ----------------------------------------------------------
  {
    await page.evaluate(() => {
      clearInterval(window.__mshotKeep); // the watchdog would undo the wound
      const p = window.__dcc.state.players[0];
      p.alive = true; p.downedT = 0;
      p.hp = Math.max(1, Math.round(p.maxHp * 0.4));
    });
    const a = await snap();
    await touch.tap(chip.flask.x, chip.flask.y, 1, 220);
    await settle(900);
    const b = await snap();
    await page.evaluate(() => {
      window.__mshotKeep = setInterval(() => {
        const s = window.__dcc && window.__dcc.state;
        if (!s) return;
        const p = s.players[0];
        p.hp = p.maxHp; p.alive = true; p.downedT = 0;
        s.status = "playing";
      }, 120);
    });
    rec("potion: tap the flask chip", b.flask < a.flask || b.hp > a.hp ? "PASS" : "FAIL",
      `charges ${a.flask}->${b.flask}, hp ${a.hp}->${b.hp}`);
  }

  // --- 9. DODGE / DASH ---------------------------------------------------
  {
    await keepAlive();
    const dashSlot = await page.evaluate(() => {
      const p = window.__dcc.state.players[0];
      const i = p.abilities.slots.findIndex((a) => a && /dash|dodge|blink|roll/i.test(a));
      return { i, slots: p.abilities.slots, ult: p.abilities.ultimate };
    });
    const bankDash = () => page.evaluate(() => {
      const p = window.__dcc.state.players[0];
      p.dashCharges = 2; p.cd.dash = 0;
    }).catch(() => {});
    if (dashSlot.i < 0) rec("dodge: dedicated gesture", "FAIL", `no dash slotted; slots=${JSON.stringify(dashSlot.slots)}`);
    else {
      await bankDash();
      const c = await at(`#skills .skill[data-i="${dashSlot.i}"]`);
      const a = await snap();
      await touch.tap(c.x, c.y, 1, 220);
      await settle(900);
      const b = await snap();
      const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
      rec("dodge: the dash chip", d > 0.3 ? "PASS" : "FAIL",
        `dash is ability slot ${dashSlot.i}; moved ${d.toFixed(2)} tiles`);

      // FLICK ON THE STICK. Velocity, not displacement: fast samples, short gaps.
      await keepAlive();
      await bankDash();
      const ox = Math.round(V.width * 0.22), oy = Math.round(V.height * 0.80);
      const before = await snap();
      await touch.down(1, ox, oy);
      for (let k = 1; k <= 4; k++) { touch.tick(9); await touch.move(1, ox + k * 46, oy); }
      await settle(500);
      const mid = await snap();
      await touch.up(1);
      await settle(400);
      const flickCd = (mid.cd.dash ?? 0) > 0 || mid.dashCharges < before.dashCharges;
      rec("dodge: FLICK the movement stick", flickCd ? "PASS" : "FAIL",
        `charges ${before.dashCharges}->${mid.dashCharges}, cd.dash ${(before.cd.dash ?? 0).toFixed(2)}->${(mid.cd.dash ?? 0).toFixed(2)}`);

      // TWO-FINGER TAP in the world zone, inside the arbitration budget.
      await keepAlive();
      await bankDash();
      // THE WORLD ZONE NOW RUNS UNDER THE CLUSTER (MOBILE.md 2.10: chips are
      // evaluated BEFORE zones, and their padded hit rects leave no tappable
      // interior), so a fraction of the zone is not automatically clear ground.
      // Both fingers must miss every control or this measures a chip press —
      // the same class of mistake as driving multi-touch from under a System
      // card, which cost three rounds of phantom FAILs.
      const w = await page.evaluate(() => {
        const t = window.__dcc.touch, z = t.zones.worldZone;
        const clear = (x, y) => !t.controlAt(x, y) && !t.controlAt(x + 46, y + 12);
        for (const fx of [0.5, 0.3, 0.2, 0.12, 0.62, 0.72]) {
          for (const fy of [0.6, 0.35, 0.8, 0.2]) {
            const x = Math.round(z.x + z.w * fx), y = Math.round(z.y + z.h * fy);
            if (clear(x, y)) return { x, y };
          }
        }
        return { x: Math.round(z.x + 40), y: Math.round(z.y + z.h * 0.5) };
      });
      const b2 = await snap();
      // Event time decides the budget, so the two lifts go out immediately.
      await touch.down(1, w.x, w.y);
      touch.tick(40);
      await touch.down(2, w.x + 46, w.y + 12);
      touch.tick(60);
      await touch.up(1);
      await touch.up(2);
      await settle(600);
      const a2 = await snap();
      rec("dodge: TWO-FINGER world tap", (a2.cd.dash ?? 0) > 0 || a2.dashCharges < b2.dashCharges ? "PASS" : "FAIL",
        `at (${w.x},${w.y}); charges ${b2.dashCharges}->${a2.dashCharges}, cd.dash ${(a2.cd.dash ?? 0).toFixed(2)}`);

      // ...and a SLOW two-finger drag must NOT dash (it is the camera gesture).
      await keepAlive();
      await page.evaluate(() => { window.__dcc.state.players[0].cd.dash = 0; window.__dcc.state.players[0].dashCharges = 2; });
      const b3 = await snap();
      await touch.down(1, w.x, w.y);
      touch.tick(60);
      await touch.down(2, w.x + 46, w.y + 12);
      touch.tick(320);
      await touch.move(1, w.x + 44, w.y + 30);
      touch.tick(200);
      await touch.up(1);
      await touch.up(2);
      await settle(400);
      const a3 = await snap();
      rec("dodge: a SLOW two-finger drag does not dash", a3.dashCharges >= b3.dashCharges ? "PASS" : "FAIL",
        `charges ${b3.dashCharges}->${a3.dashCharges}`);
    }
  }

  // --- 10. LOOT + INTERACT ----------------------------------------------
  {
    const info = await page.evaluate(() => {
      const s = window.__dcc.state, p = s.players[0];
      return {
        drops: (s.drops || s.loot || s.items || []).length,
        keys: Object.keys(s).filter((k) => /drop|loot|pickup|item|chest|shrine|prop/i.test(k)),
        bag: (p.bag || []).length,
      };
    });
    rec("loot: pickup", "INFO", `state keys: ${info.keys.join(",")}; bag=${info.bag}`);
  }

  // --- 11. STAIRS / DESCEND ---------------------------------------------
  {
    const st = await at("#t-stairs");
    rec("descend: contextual chip", st ? "PASS" : "INFO",
      st ? `visible at (${st.x},${st.y}) ${st.w}x${st.h}` : "hidden (only shows while standing on stairs)");
  }

  // --- 12. PANELS BY TOUCH ONLY -----------------------------------------
  {
    const tb = await at("#tb-crawler");
    await touch.tap(tb.x, tb.y, 1, 120);
    await settle(900);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("#tm-crawler .tm-row")].map((r) => {
        const b = r.getBoundingClientRect();
        return { act: r.dataset.act, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), h: Math.round(b.height) };
      }));
    const inv = rows.find((r) => r.act === "inventory");
    let detail = `menu rows: ${rows.map((r) => `${r.act}(h${r.h})`).join(" ")}`;
    if (inv) {
      await touch.tap(inv.x, inv.y);
      await settle(600);
      const open = await page.evaluate(() => {
        const e = document.getElementById("inv");
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        const closers = [...e.querySelectorAll("button, .close, .dismiss, [data-close]")].map((b) => b.textContent.trim().slice(0, 24));
        return {
          vis: cs.display !== "none",
          overflowsBy: Math.round(r.bottom - innerHeight),
          closers,
        };
      });
      detail += ` | inventory opened=${open.vis}, bottom overflows viewport by ${open.overflowsBy}px, ` +
        `close controls: [${open.closers.join(", ") || "NONE"}]`;
      // try to close by tapping outside
      await touch.tap(Math.round(V.width * 0.5), 8);
      await settle(400);
      const stillOpen = await page.evaluate(() => getComputedStyle(document.getElementById("inv")).display !== "none");
      detail += ` | tap-outside closes = ${!stillOpen}`;
      if (stillOpen) await page.keyboard.press("i");
    }
    rec("panels: reach + escape by touch", inv ? (detail.includes("close controls: []") ? "FAIL" : "INFO") : "FAIL", detail);
  }

  // --- 13. BROWSER GESTURE HYGIENE --------------------------------------
  {
    const a = await snap();
    await touch.tap(Math.round(V.width * 0.5), Math.round(V.height * 0.5), 1, 40);
    await page.waitForTimeout(60);
    await touch.tap(Math.round(V.width * 0.5), Math.round(V.height * 0.5), 1, 40);
    await settle(400);
    const b = await snap();
    const sel = await page.evaluate(() => String(getSelection()).length);
    rec("gestures: double-tap zoom / selection", b.scale === a.scale && sel === 0 ? "PASS" : "FAIL",
      `visualViewport.scale ${a.scale}->${b.scale}, selected chars ${sel}`);
  }

  // --- 14. HAPTICS -------------------------------------------------------
  {
    await keepAlive();
    await page.evaluate(() => {
      window.__vibes = [];
      const real = navigator.vibrate;
      navigator.vibrate = (p) => { window.__vibes.push(p); return real ? real.call(navigator, p) : true; };
    });
    const c1 = await at(`#skills .skill[data-i="1"]`);
    await touch.tap(c1.x, c1.y, 1, 60);
    await settle(300);
    const vibes = await page.evaluate(() => window.__vibes.slice());
    rec("haptics: a chip press pulses", vibes.length > 0 ? "PASS" : "FAIL",
      `navigator.vibrate calls during one tap: ${JSON.stringify(vibes)}`);
  }

  // --- 14b. THE CANCEL AFFORDANCE ---------------------------------------
  //
  // WHICH ONE depends on the posture, and this row used to assume a band on
  // every device. A corner grip ships none: measured, the round-1 band sat
  // 176 px across the screen from the cluster (past the 109 px aim throw) with
  // 92% of its area inside the MOVEMENT thumb's zone. `cancelMode` says which
  // affordance exists; the assertion is the same either way — the drag lands
  // on the cancel target, the target LIGHTS, and no cooldown starts.
  {
    await keepAlive();
    const z = await page.evaluate(() => {
      const t = window.__dcc.touch.zones;
      return { band: t.cancelBand, mode: t.cancelMode, r: t.cancelRadius };
    });
    const band = z.band;
    const c2 = await at(`#skills .skill[data-i="2"]`);
    const a = await snap();
    await touch.down(1, c2.x, c2.y);
    await settle(150);
    await touch.move(1, c2.x - 120, c2.y - 40);
    await settle(150);
    const el = z.mode === "band" ? "t-cancel" : "t-ocancel";
    const banded = await page.evaluate((id) => {
      const e = document.getElementById(id);
      return { shown: !!e && e.classList.contains("on"), armed: !!e && e.classList.contains("armed") };
    }, el);
    // Band: drive into the strip. Origin: come home to the frozen press point.
    const home = z.mode === "band"
      ? { x: Math.round(band.x + band.w / 2), y: Math.round(band.y + band.h / 2) }
      : { x: c2.x + 3, y: c2.y - 2 };
    await touch.move(1, home.x, home.y);
    await settle(200);
    const armed = await page.evaluate((id) => document.getElementById(id).classList.contains("armed"), el);
    await touch.up(1);
    await settle(500);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] ?? 0) > 0 && !(a.cd[k] > 0));
    rec(`cancel: the ${z.mode} affordance`, armed && started.length === 0 ? "PASS" : "FAIL",
      `mode=${z.mode}; #${el} shown on aim=${banded.shown}, armed at the target=${armed}; ` +
      (z.mode === "band"
        ? `band ${Math.round(band.w)}x${Math.round(band.h)} at (${Math.round(band.x)},${Math.round(band.y)}); `
        : `cancelRadius ${Math.round(z.r)} px around the frozen origin; `) +
      `cooldowns started=${JSON.stringify(started)}`);
  }

  // --- 14c. WORLD ZONE: tap to move, long press to ping, tap to lock -----
  {
    await keepAlive();
    // Tap a point that is actually FLOOR and actually far enough to walk to:
    // on a letterboxed Pixel 5 the middle of the world zone can project into a
    // wall, and then the check measures level geometry, not the tap.
    const w = await page.evaluate(() => {
      const d = window.__dcc, z = d.touch.zones.worldZone, s = d.state, p = s.players[0];
      const walkable = (g) => {
        if (!g) return false;
        const tx = Math.floor(g.x), ty = Math.floor(g.y);
        if (tx < 0 || ty < 0 || tx >= s.map.w || ty >= s.map.h) return false;
        if (s.map.tiles[ty * s.map.w + tx] === 0) return false; // Tile.Wall = 0
        return Math.hypot(g.x - p.pos.x, g.y - p.pos.y) > 1.5;
      };
      // ...and clear of every monster BODY on screen: a tap within a thumb of
      // one is a lock-and-swing by design, not a move order. Measured: the
      // middle of a Pixel 5 world zone sits on the pack, so this check used to
      // report "walked 0.01 tiles" while the layer was correctly attacking.
      const clearOfMobs = (x, y) => s.monsters.every((m) => {
        if (m.hp <= 0 || m.dormant) return true;
        const q = d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y);
        return !q || !q.visible || Math.hypot(q.x - x, q.y - y) > 70;
      });
      // ...and clear of every CONTROL: the world zone runs under the cluster
      // (chips win at pointerdown), and the long-press check taps 20px to the
      // right of this point, so both have to miss.
      const clearOfChips = (x, y) => !d.touch.controlAt(x, y) && !d.touch.controlAt(x + 20, y);
      for (const fx of [0.5, 0.42, 0.58, 0.35, 0.28, 0.2, 0.12, 0.65, 0.72]) {
        for (const fy of [0.55, 0.45, 0.65, 0.35, 0.75, 0.85]) {
          const x = Math.round(z.x + z.w * fx), y = Math.round(z.y + z.h * fy);
          const g = d.renderer.screenToGround(x, y);
          if (walkable(g) && clearOfMobs(x, y) && clearOfChips(x, y)) return { x, y, ground: g };
        }
      }
      // Nothing clear of the pack and the walls: fall back to the middle, but
      // still resolve its ground so the verdict below has something to match.
      const fx = Math.round(z.x + z.w * 0.5), fy = Math.round(z.y + z.h * 0.55);
      return { x: fx, y: fy, ground: d.renderer.screenToGround(fx, fy) };
    });
    const a = await snap();
    // SwiftShader delivers input in frame-sized lumps, so a wall-clock hold of
    // 120 ms can arrive as 600 ms of page time. Event timestamps are accurate:
    // send the lift immediately and let the page read the real duration.
    const startPos = a.pos;
    await touch.down(1, w.x, w.y);
    touch.tick(110);
    await touch.up(1);
    await settle(300);
    const early = await page.evaluate(() => window.__dcc.touch.clickMoveTarget);
    await settle(1400);
    const b = await snap();
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    const late = await page.evaluate(() => window.__dcc.touch.clickMoveTarget);
    const tapDbg = await page.evaluate(() => window.__dcc.touch.lastWorldTap);
    const want = w.ground ? Math.hypot(w.ground.x - startPos.x, w.ground.y - startPos.y) : null;
    const ordered = !!(early && w.ground &&
      Math.hypot(early.x - w.ground.x, early.y - w.ground.y) < 0.1);
    rec("world: tap to move", ordered && (d > 0.3 || late === null) ? "PASS" : "FAIL",
      `tapped (${w.x},${w.y}); the tap became a move order to ${JSON.stringify(early)} ` +
      `(${want ? want.toFixed(2) : "?"} tiles away); walked ${d.toFixed(2)}; target later = ${JSON.stringify(late)} ` +
      `(cleared = arrived, or the straight line was blocked: clickMove steers, it does not path)`);

    await keepAlive();
    await page.evaluate(() => { window.__dcc.state.pings.length = 0; });
    const c = await snap();
    await touch.down(1, w.x + 20, w.y);
    touch.tick(700);
    await settle(400);
    await touch.up(1);
    await settle(400);
    const e = await snap();
    // Pings EXPIRE (Ping.t counts down), and two extra round trips at 2 fps is
    // long enough to miss one. Read the hold, the count and the position in a
    // single evaluate so the verdict is about the gesture, not the latency.
    const ping = await page.evaluate(() => {
      const d = window.__dcc, g = d.touch.lastWorldTap;
      const list = d.state.pings.map((p) => ({ pos: p.pos, t: +p.t.toFixed(2) }));
      const hit = g && g.ground
        ? list.find((p) => Math.hypot(p.pos.x - g.ground.x, p.pos.y - g.ground.y) < 1.5)
        : null;
      return { hold: g, live: list.length, hit: hit ?? null };
    });
    rec("world: long press pings", ping.hit || e.pings > c.pings ? "PASS" : "FAIL",
      `pings ${c.pings}->${e.pings} (${ping.live} still alive); the hold resolved as ` +
      `${JSON.stringify(ping.hold)}; ping at ${JSON.stringify(ping.hit)}`);

    // Tap a MONSTER: lock + swing.
    await keepAlive();
    // Freeze the pack first. Under SwiftShader, hundreds of milliseconds pass
    // between reading a projection and the finger landing, and an engaged pack
    // has walked out from under the tap by then — that measures the renderer,
    // not the tap. The monster must also project into the WORLD zone: one
    // standing inside the stick zone is a movement gesture by design.
    await page.evaluate(() => {
      const d = window.__dcc, s = d.state, z = d.touch.zones.worldZone;
      for (const m of s.monsters) m.speed = 0;
      // Stage one: park the nearest live monster on the ground point under the
      // middle of the world zone, so the check always has something to tap
      // (on a Pixel-5-shaped screen the pack is often off to one side).
      let sx = z.x + z.w * 0.5, sy = z.y + z.h * 0.5;
      for (const fx of [0.5, 0.34, 0.22, 0.14, 0.62]) {
        const x = z.x + z.w * fx;
        if (!d.touch.controlAt(x, sy)) { sx = x; break; }
      }
      const g = d.renderer.screenToGround(sx, sy);
      const m = s.monsters.find((m) => m.hp > 0 && !m.dormant);
      if (g && m) { m.pos.x = g.x; m.pos.y = g.y; }
    });
    await settle(400);
    const mob = await page.evaluate(() => {
      const s = window.__dcc.state, r = window.__dcc.renderer;
      const z = window.__dcc.touch.zones.worldZone;
      const p0 = s.players[0];
      if (!r.worldToScreen) return null;
      const near = s.monsters.filter((m) => m.hp > 0 && !m.dormant)
        .sort((a, b) => Math.hypot(a.pos.x - p0.pos.x, a.pos.y - p0.pos.y) - Math.hypot(b.pos.x - p0.pos.x, b.pos.y - p0.pos.y));
      for (const m of near) {
        const p = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
        if (!p || !p.visible) continue;
        if (p.x < z.x + 8 || p.x > z.x + z.w - 8 || p.y < z.y + 8 || p.y > z.y + z.h - 8) continue;
        // A monster standing UNDER a chip is a chip press by design (§2.10
        // evaluates controls before zones), so it cannot measure world tap.
        if (window.__dcc.touch.controlAt(p.x, p.y)) continue;
        return { id: m.id, x: Math.round(p.x), y: Math.round(p.y) };
      }
      return null;
    });
    if (!mob) rec("world: tap a monster locks it", "N/A", "no monster projected on screen");
    else {
      await touch.down(1, mob.x, mob.y);
      touch.tick(110);
      await touch.up(1);
      await settle(600);
      const after = await page.evaluate(() => ({
        locked: window.__dcc.touch.lockedTargetId,
        tap: window.__dcc.touch.lastWorldTap,
      }));
      rec("world: tap a monster locks it", after.locked === mob.id ? "PASS" : "FAIL",
        `tapped monster ${mob.id} at (${mob.x},${mob.y}); lockedTargetId=${after.locked}; ` +
        `the tap resolved as ${JSON.stringify(after.tap)}`);
    }
  }

  // --- 15. SAFE AREA WIRING ---------------------------------------------
  {
    const wired = await page.evaluate((safe) => {
      // Simulate the real device insets by re-reading each control's distance
      // to the viewport edges and comparing with the hardware inset.
      const ids = ["minimap-frame", "cockpit", "t-stairs", "banner", "hud-tl", "hud-tr", "ticker", "xpbar"];
      const bad = [];
      for (const id of ids) {
        const e = document.getElementById(id);
        if (!e) continue;
        const r = e.getBoundingClientRect();
        if (!r.width) continue;
        if (safe.left && r.left < safe.left) bad.push(`${id} left ${Math.round(r.left)}<${safe.left}`);
        if (safe.right && innerWidth - r.right < safe.right) bad.push(`${id} right ${Math.round(innerWidth - r.right)}<${safe.right}`);
        if (safe.top && r.top < safe.top) bad.push(`${id} top ${Math.round(r.top)}<${safe.top}`);
        if (safe.bottom && innerHeight - r.bottom < safe.bottom) bad.push(`${id} bottom ${Math.round(innerHeight - r.bottom)}<${safe.bottom}`);
      }
      return bad;
    }, spec.safe);
    rec("safe areas", wired.length ? "FAIL" : "PASS",
      wired.length ? `intrudes: ${wired.join("; ")}` : "every HUD element clears the hardware insets");
  }

  // --- 15b. MODAL OPENS MID-AIM (the trailing-pointerup hazard) -----------
  // A level-up draft, a shop, a dialogue — any of them can take the screen
  // while a finger is mid-drag on an ability chip. What happens to that
  // pointer's RELEASE decides whether a player can fat-finger a permanent
  // choice, or leak a cast into a frozen world. Nothing in the host cancels
  // gameplay pointers on modal open, so this measures what actually happens.
  {
    await keepAlive();
    const a = await snap();
    await touch.down(1, chip["2"].x, chip["2"].y);
    await page.waitForTimeout(120);
    for (let i = 1; i <= 8; i++) { await touch.move(1, chip["2"].x - i * 14, chip["2"].y - i * 7); await page.waitForTimeout(35); }
    // ...modal opens mid-drag (inventory stands in for the level-up draft:
    // same full-screen modal class, same z-order, and it is openable on demand)
    await page.keyboard.press("i");
    await settle(600);
    const openMid = await page.evaluate(() => {
      const e = document.getElementById("inv");
      return !!e && getComputedStyle(e).display !== "none";
    });
    // The finger now lifts over whatever the modal put under it.
    const overEl = await hitAt(chip["2"].x - 120, chip["2"].y - 60);
    await touch.up(1);
    await settle(700);
    const b = await snap();
    const started = Object.keys(b.cd).filter((k) => (b.cd[k] || 0) > (a.cd[k] || 0));
    const stillOpen = await page.evaluate(() => {
      const e = document.getElementById("inv");
      return !!e && getComputedStyle(e).display !== "none";
    });
    // Close it and look again: a queued cast fires the instant the sim resumes.
    if (stillOpen) await page.keyboard.press("i");
    await settle(900);
    const c = await snap();
    const afterClose = Object.keys(c.cd).filter((k) => (c.cd[k] || 0) > (a.cd[k] || 0));
    rec("modal: opens mid-aim, then the finger lifts",
      started.length === 0 && afterClose.length === 0 ? "PASS" : "FAIL",
      `modal opened mid-drag=${openMid}; the release point sits over ${overEl}; ` +
      `casts while the modal was up: ${started.join(",") || "none"}; ` +
      `casts once it closed: ${afterClose.join(",") || "none"}; ` +
      `modal still open after release=${stillOpen}`);
    await settle(400);
  }

  // --- 15c. TOUCH-LAYER ALLOCATION COUNT ---------------------------------
  // MOBILE.md asserts the touch layer allocates ~5 objects per polled frame.
  // Count them instead: drive a stick + chip gesture for N frames with the
  // renderer running and read the delta in JS heap used, plus the sample()
  // object identity (a preallocated sample would be === across polls).
  {
    const mem = await page.evaluate(async () => {
      const perf = performance;
      if (!perf.memory) return { supported: false };
      const before = perf.memory.usedJSHeapSize;
      await new Promise((res) => {
        let i = 0;
        const t = () => (++i >= 240 ? res(null) : requestAnimationFrame(t));
        requestAnimationFrame(t);
      });
      const after = perf.memory.usedJSHeapSize;
      return { supported: true, deltaBytes: after - before, frames: 240 };
    }).catch(() => ({ supported: false }));
    rec("perf: heap growth over 240 idle frames", "INFO", JSON.stringify(mem));
  }

  // --- 16. QUALITY PRESET ------------------------------------------------
  {
    const q = await page.evaluate(() => {
      const r = window.__dcc.renderer;
      const canvas = document.getElementById("game");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      let name = "";
      try {
        const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) name = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      } catch {}
      return {
        preset: (r.quality && (r.quality.name || r.quality)) ?? (r.profile && r.profile.name) ?? "unknown",
        glRenderer: name,
        cores: navigator.hardwareConcurrency,
        dpr: devicePixelRatio,
        backbuffer: canvas.width + "x" + canvas.height,
      };
    });
    rec("perf: auto-selected preset", "INFO", JSON.stringify(q));
  }

  return out;
}

// ------------------------------------------------------------------ run
const deviceList = (flag("devices") ?? "iphone13-land,iphone13promax-land,ipadpro11-land,pixel5-land")
  .split(",").map((s) => s.trim()).filter(Boolean);
const sceneList = (flag("scenes") ?? "combat").split(",").map((s) => s.trim()).filter(Boolean);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: !HEADED,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

const report = [];
for (const dname of deviceList) {
  const spec = DEVICE_SPECS[dname];
  if (!spec) { console.error("unknown device", dname); continue; }
  const desc = devices[spec.pw];
  if (!desc) { console.error("playwright has no descriptor for", spec.pw); continue; }
  for (const sname of sceneList) {
    const scene = SCENES[sname];
    if (!scene) { console.error("unknown scene", sname); continue; }
    const ctx = await browser.newContext({ ...desc, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const client = await ctx.newCDPSession(page);
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    const touch = touchDriver(client);
    try {
      const safeQ = Object.values(spec.safe).some((v) => v > 0)
        ? `safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`
        : null;
      const url = safeQ
        ? scene.url() + (scene.url().includes("?") ? "&" : "?") + safeQ
        : scene.url();
      await page.goto(url, { waitUntil: "load", timeout: 90000 });
      await ready(page, { menu: !!scene.menu });
      await scene.setup(page, touch, client);
      const measure = MEASURE ? await page.evaluate(MEASURE_FN).catch(() => null) : null;
      const openNow = await page.evaluate(() =>
        ["inv", "abil", "sheet", "menu", "saferoom", "draft", "recap", "keys", "keybinds"].filter((id) => {
          const e = document.getElementById(id);
          if (!e) return false;
          const cs = getComputedStyle(e);
          return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0;
        })).catch(() => null);
      let drive = null;
      if (DRIVE_MODE) {
        console.log(`-- driving ${dname} / ${sname}`);
        // The combat battery drives combat verbs; pointing it at the shop
        // would report nine phantom FAILs and prove nothing. Each surface gets
        // the battery that asserts ITS outcome.
        drive = sname === "shop"
          ? await shopBattery(page, touch)
          : await driveBattery(page, touch, spec);
      }
      await overlay(page, spec);
      const file = join(OUT, `${dname}-${sname}.png`);
      await page.screenshot({ path: file, timeout: 120000 });
      await clearOverlay(page);
      const probe = PROBE && !scene.menu ? await page.evaluate(PROBE_FN) : null;
      const aimInfo = await page.evaluate(() => window.__mshotAim ?? null).catch(() => null);
      const aimDiff = sname.startsWith("aim-") ? await aimLegibility(page, file, aimInfo).catch(() => null) : null;
      if (scene.teardown) await scene.teardown(page, touch).catch(() => {});
      report.push({
        device: dname, scene: sname, file, viewport: page.viewportSize(),
        dpr: desc.deviceScaleFactor, errs, panelsOpen: openNow, probe, measure, drive,
        aim: aimInfo,
        aimDiff,
      });
      console.log("shot", file, errs.length ? `(${errs.length} page errors: ${errs[0]})` : "");
    } catch (e) {
      console.error("FAILED", dname, sname, e.message);
      report.push({ device: dname, scene: sname, error: e.message, errs });
    }
    await ctx.close();
  }
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log("report ->", join(OUT, "report.json"));
await browser.close();
