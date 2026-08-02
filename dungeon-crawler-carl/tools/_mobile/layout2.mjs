// LAYOUT & READABILITY probe — acceptance round 2.
//
// Round 1's readability.mjs covered combat + boss. This covers EVERY major
// scene and adds the three questions round 1 could not answer:
//
//   * THUMB OCCLUSION as a hand, not a rect. A finger on a chip is a ~19mm
//     contact pad with a ~55mm finger and a palm behind it; the hand shadow is
//     the union of a disc at the contact and a wedge running back to the grip
//     corner. What of the READ SET (crawler, monsters, boss plate, vitals,
//     cooldown pips, price, DESCEND) falls inside it?
//   * ONE-HANDED PANEL REACH. Every primary control in an open panel, measured
//     in mm from the grip pivot, against 48mm comfortable / 66mm stretch.
//   * IS THIS DESKTOP UI SHRUNK? Row density, list-vs-tile, font size in mm,
//     and whether the phone's grid tracks are the desktop's grid tracks.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = (flag("base", "http://localhost:5420")).replace(/\/$/, "");
const OUT = flag("out", "tools/_mobile/lay2");
mkdirSync(OUT, { recursive: true });

const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance";
const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 }, corner: 47, mmpx: 0.165 },
  "iphone13promax-land": { pw: "iPhone 13 Pro Max landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 }, corner: 47, mmpx: 0.165 },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: { top: 24, right: 0, bottom: 20, left: 0 }, corner: 18, mmpx: 0.192 },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: { top: 0, right: 24, bottom: 0, left: 0 }, corner: 20, mmpx: 0.163 },
};

// ------------------------------------------------------------------ probe
const READ = (arg) => {
  const { safe, corner, mmpx, scene } = arg;
  const VW = innerWidth, VH = innerHeight;
  const R = (e) => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const shown = (e) => {
    if (!e) return false;
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < 0.05) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const mm = (px) => +(px * mmpx).toFixed(1);

  const IDS = ["hud-tl", "hud-tr", "cockpit", "skills", "xpbar", "minimap-frame", "banner",
    "headline", "toasts", "tutorial", "bossbar", "bosscall", "t-stick", "t-stick2", "t-stickzone",
    "t-stairs", "t-cancel", "t-loot", "t-interact", "ticker", "partybar", "ghostrail", "downed",
    "hud-chips", "t-map", "pickstrip", "flask-chip", "show", "draft", "recap", "saferoom",
    "inv", "sheet", "abil", "tsheet"];
  const boxes = {};
  for (const id of IDS) { const e = document.getElementById(id); if (shown(e)) boxes[id] = R(e); }
  const chips = [...document.querySelectorAll("#skills .skill, #flask-chip, #t-map, #t-stairs")]
    .filter(shown).map((c) => Object.assign({ id: c.id || "slot" + (c.dataset.i ?? "?") }, R(c)));

  // ---------------- the read set: what a player must SEE, per scene --------
  const readSet = [];
  const proj = (() => {
    try {
      const cam = window.__dcc.renderer.camera;
      const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      return (wx, wy, wz) => {
        const w = m[3] * wx + m[7] * wy + m[11] * wz + m[15] || 1;
        const cx = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / w;
        const cy = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / w;
        return { x: (cx * 0.5 + 0.5) * VW, y: (-cy * 0.5 + 0.5) * VH };
      };
    } catch (e) { return null; }
  })();
  let player = null;
  if (proj) {
    const st = window.__dcc.state, p = st.players[0];
    const feet = proj(p.pos.x, 0, p.pos.y), head = proj(p.pos.x, 1.8, p.pos.y);
    player = { feet, head, chest: { x: (feet.x + head.x) / 2, y: (feet.y + head.y) / 2 } };
    readSet.push({ k: "crawler", x: player.chest.x, y: player.chest.y });
    for (const m of st.monsters.filter((q) => q.hp > 0 && !q.dormant)) {
      const s = proj(m.pos.x, 0.9, m.pos.y);
      if (s.x > 0 && s.x < VW && s.y > 0 && s.y < VH) readSet.push({ k: m.kind === "boss" ? "boss" : "mob", x: s.x, y: s.y });
    }
  }
  // HUD readables
  for (const id of ["hud-tl", "hud-tr", "bossbar", "xpbar", "toasts", "banner", "pickstrip"]) {
    const b = boxes[id]; if (b) readSet.push({ k: "hud:" + id, x: b.x + b.w / 2, y: b.y + b.h / 2, box: b });
  }
  // cooldown pips live ON the chips; a covered chip is a covered cooldown
  for (const c of chips) readSet.push({ k: "chip:" + c.id, x: c.x + c.w / 2, y: c.y + c.h / 2, box: c });

  // ---------------- hand shadow ------------------------------------------
  // The casting thumb rests on the cluster's centroid; the movement thumb on
  // the stick zone's rest anchor. Each hand occludes a disc of radius 11mm at
  // the contact (finger pad + nail) plus the wedge back to its grip corner
  // (the finger and the web of the hand), width ~22mm.
  const hands = [];
  const clusterChips = chips.filter((c) => /slot|flask/.test(c.id));
  if (clusterChips.length) {
    const cx = clusterChips.reduce((a, c) => a + c.x + c.w / 2, 0) / clusterChips.length;
    const cy = clusterChips.reduce((a, c) => a + c.y + c.h / 2, 0) / clusterChips.length;
    hands.push({ name: "cast", tip: { x: cx, y: cy }, root: { x: VW - 8, y: VH - 8 } });
    // and the worst case: the thumb on the ULTIMATE / topmost chip
    const top = clusterChips.slice().sort((a, b) => a.y - b.y)[0];
    hands.push({ name: "cast-top", tip: { x: top.x + top.w / 2, y: top.y + top.h / 2 }, root: { x: VW - 8, y: VH - 8 } });
  }
  const sz = boxes["t-stickzone"];
  if (sz) hands.push({ name: "move", tip: { x: sz.x + sz.w * 0.5, y: sz.y + sz.h * 0.72 }, root: { x: 8, y: VH - 8 } });

  const TIP_R = 11 / mmpx;      // 11 mm contact+nail disc
  const WEDGE_W = 22 / mmpx;    // 22 mm finger/web band back to the grip
  const inShadow = (px, py) => {
    for (const h of hands) {
      if (Math.hypot(px - h.tip.x, py - h.tip.y) < TIP_R) return h.name;
      // distance from the segment tip->root
      const ax = h.tip.x, ay = h.tip.y, bx = h.root.x, by = h.root.y;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      let t = ((px - ax) * dx + (py - ay) * dy) / L2;
      if (t < 0 || t > 1) continue;
      const qx = ax + dx * t, qy = ay + dy * t;
      if (Math.hypot(px - qx, py - qy) < WEDGE_W / 2) return h.name;
    }
    return null;
  };
  const occluded = readSet.map((r) => ({ k: r.k, hand: inShadow(r.x, r.y) })).filter((r) => r.hand);

  // ---------------- what is actually painted over the read set ------------
  const coveredByHud = readSet.filter((r) => r.k === "mob" || r.k === "boss" || r.k === "crawler")
    .map((r) => {
      const e = document.elementFromPoint(Math.round(r.x), Math.round(r.y));
      const tag = e ? (e.tagName + (e.id ? "#" + e.id : "")) : "none";
      return { k: r.k, under: tag };
    });
  const worldish = (t) => t === "none" || /CANVAS/.test(t) || /#t-stickzone|#t-layer|#touch|#hud-chips/.test(t);

  // ---------------- safe area, incl. the rounded-corner quarter disc -------
  const intrusions = [];
  for (const [id, b] of Object.entries(boxes)) {
    if (id === "t-stickzone" || id === "hud-chips") continue;
    const cuts = [];
    if (b.y < safe.top) cuts.push(`top ${b.y.toFixed(0)}<${safe.top}`);
    if (VH - (b.y + b.h) < safe.bottom) cuts.push(`bottom ${(VH - b.y - b.h).toFixed(0)}<${safe.bottom}`);
    if (b.x < safe.left) cuts.push(`left ${b.x.toFixed(0)}<${safe.left}`);
    if (VW - (b.x + b.w) < safe.right) cuts.push(`right ${(VW - b.x - b.w).toFixed(0)}<${safe.right}`);
    const r = corner;
    for (const [px, py, cx, cy] of [[b.x, b.y, 0, 0], [b.x + b.w, b.y, VW, 0], [b.x, b.y + b.h, 0, VH], [b.x + b.w, b.y + b.h, VW, VH]]) {
      const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
      if (dx < r && dy < r && Math.hypot(r - dx, r - dy) > r) cuts.push(`corner(${cx ? "R" : "L"}${cy ? "B" : "T"}) r=${r}`);
    }
    if (cuts.length) intrusions.push({ id, box: b, cuts });
  }

  // ---------------- HUD box overlaps --------------------------------------
  const inter = (a, b) => {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return x * y;
  };
  const overlaps = [];
  const keys = Object.keys(boxes).filter((k) => k !== "t-stickzone" && k !== "hud-chips" && k !== "touch");
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = boxes[keys[i]], b = boxes[keys[j]];
    const ar = inter(a, b);
    if (ar > 200) overlaps.push({ a: keys[i], b: keys[j], px2: Math.round(ar),
      pctOfSmaller: Math.round((ar / Math.min(a.w * a.h, b.w * b.h)) * 100) });
  }

  // ---------------- text + targets in millimetres -------------------------
  const roots = ["hud-tl", "hud-tr", "cockpit", "bossbar", "skills", "xpbar", "toasts", "ticker",
    "saferoom", "inv", "sheet", "abil", "recap", "menu", "draft", "tsheet", "pickstrip"];
  const textNodes = [];
  for (const id of roots) {
    const root = document.getElementById(id); if (!shown(root)) continue;
    for (const e of root.querySelectorAll("*")) {
      if (!shown(e)) continue;
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)) continue;
      const fs = parseFloat(getComputedStyle(e).fontSize);
      textNodes.push({ t: e.textContent.trim().slice(0, 20), px: +fs.toFixed(1), mm: mm(fs), where: id });
    }
  }
  textNodes.sort((a, b) => a.px - b.px);

  const SEL = "button, .tab, .skill, .t-chip, [data-act], .acard, .bag-cell, .cell, .row, .item, .itile, .gchip, .glyph, .card, input, select, a, .seg, .tp-seg button, .tp-x, .tp-done, .node, .star";
  const targets = [...document.querySelectorAll(SEL)].filter(shown).map((e) => {
    const r = e.getBoundingClientRect();
    return { t: (e.id || (typeof e.className === "string" ? e.className.split(" ")[0] : "") || e.tagName),
      w: Math.round(r.width), h: Math.round(r.height), mmW: mm(r.width), mmH: mm(r.height),
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      where: (e.closest("[id]") || {}).id || "?" };
  });
  const under7 = targets.filter((t) => t.mmW < 7 || t.mmH < 7);

  // ---------------- one-handed reach for the OPEN PANEL -------------------
  const openPanel = ["saferoom", "inv", "sheet", "abil", "draft", "recap", "menu"].find((id) => shown(document.getElementById(id)));
  let panelReach = null;
  if (openPanel) {
    const el = document.getElementById(openPanel);
    const box = el.querySelector(".panel") || el;
    const br = R(box);
    // grip pivots: right-hand corner + a left-hand corner (two-hand slab hold)
    const pivots = [{ n: "R", x: VW - 26, y: VH - 26 }, { n: "L", x: 26, y: VH - 26 }];
    const ctrls = targets.filter((t) => t.where && (el.contains(document.getElementById(t.where)) || el.querySelector(`#${CSS.escape(t.where)}`) || true))
      .filter((t) => {
        const e = document.elementFromPoint(t.x, t.y);
        return e && el.contains(e);
      });
    const dists = ctrls.map((t) => {
      const d = Math.min(...pivots.map((p) => Math.hypot(t.x - p.x, t.y - p.y)));
      return { t: t.t, mm: mm(d), w: t.w, h: t.h };
    });
    panelReach = {
      panel: openPanel, box: br,
      overflow: { scrollX: Math.round(box.scrollWidth - box.clientWidth), scrollY: Math.round(box.scrollHeight - box.clientHeight),
        offTop: Math.round(Math.max(0, -br.y)), offBottom: Math.round(Math.max(0, br.y + br.h - VH)) },
      n: dists.length,
      beyondStretch: dists.filter((d) => d.mm > 66).length,
      beyondComfort: dists.filter((d) => d.mm > 48).length,
      worst: dists.sort((a, b) => b.mm - a.mm).slice(0, 6),
      closers: [...el.querySelectorAll(".tp-x, .tp-done, [data-close], .close")].filter(shown)
        .map((b) => ({ t: b.textContent.trim().slice(0, 10) || b.className, ...R(b) })),
      // "desktop UI shrunk?" tells: multi-column grids and dense rows
      grids: [...box.querySelectorAll("*")].filter(shown).map((e) => {
        const g = getComputedStyle(e);
        if (g.display !== "grid" && g.display !== "inline-grid") return null;
        const cols = g.gridTemplateColumns.split(" ").filter(Boolean);
        return cols.length > 1 ? { sel: (e.id || e.className.toString().split(" ")[0]), cols: g.gridTemplateColumns, w: Math.round(e.getBoundingClientRect().width) } : null;
      }).filter(Boolean).slice(0, 10),
      rowHeights: [...box.querySelectorAll(".row, .item, li, tr")].filter(shown)
        .map((e) => Math.round(e.getBoundingClientRect().height)).slice(0, 20),
    };
  }

  // ---------------- how much screen is HUD --------------------------------
  let hudPx = 0, cells = 0;
  const step = 8;
  for (let y = 0; y < VH; y += step) for (let x = 0; x < VW; x += step) {
    cells++;
    const e = document.elementFromPoint(x, y);
    const isWorld = !e || e.tagName === "CANVAS" || e.id === "t-stickzone" || e.id === "t-layer" || e.id === "touch" || e.id === "hud-chips";
    if (!isWorld) hudPx++;
  }

  return {
    scene, vp: { w: VW, h: VH }, dpr: devicePixelRatio, body: document.body.className,
    uiclass: document.body.dataset.uiclass ?? null,
    boxes, chips, player,
    handShadow: { tipR_mm: 11, wedge_mm: 22, hands: hands.map((h) => ({ n: h.name, tip: { x: Math.round(h.tip.x), y: Math.round(h.tip.y) } })),
      readSetN: readSet.length, occludedN: occluded.length, occluded: occluded.slice(0, 14) },
    monstersUnderHud: coveredByHud.filter((c) => !worldish(c.under)),
    monstersOnScreen: coveredByHud.length,
    overlaps, intrusions,
    smallestText: textNodes.slice(0, 8),
    targets: { n: targets.length, under7mm: under7.length,
      worst: targets.slice().sort((a, b) => Math.min(a.mmW, a.mmH) - Math.min(b.mmW, b.mmH)).slice(0, 10) },
    panelReach,
    hudCoverPct: +((hudPx / cells) * 100).toFixed(1),
  };
};

// ------------------------------------------------------------------ scenes
const ready = async (page) => {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    return !l || getComputedStyle(l).display === "none" || +getComputedStyle(l).opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1200);
};
const alive = (page) => page.evaluate(() => {
  const p = window.__dcc.state.players[0];
  p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing";
}).catch(() => {});

async function openPanelKey(page, key, id, tries = 5) {
  for (let i = 0; i < tries; i++) {
    await alive(page);
    await page.waitForTimeout(250);
    await page.keyboard.press(key);
    await page.waitForTimeout(900);
    const up = await page.evaluate((pid) => {
      const e = document.getElementById(pid);
      if (!e) return false;
      const cs = getComputedStyle(e);
      return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0;
    }, id);
    if (up) { await page.waitForTimeout(700); return true; }
  }
  throw new Error("panel " + id + " never opened");
}

async function toShop(page) {
  await page.evaluate(() => {
    const st = window.__dcc.state, p = st.players[0];
    p.gold = (p.gold ?? 0) + 6000;
    for (const m of st.monsters) m.hp = 0;
    p.alive = true; p.downedT = 0; p.hp = p.maxHp; st.status = "playing";
    p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
    clearInterval(window.__k);
    window.__k = setInterval(() => {
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
  for (let i = 0; i < 24; i++) {
    const st = await page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id);
        return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; };
      return { draft: vis("draft"), shop: vis("saferoom") };
    }).catch(() => ({ draft: false, shop: false }));
    if (st.shop) break;
    if (st.draft) {
      const ok = await page.evaluate(() => { const c = document.querySelector("#draft-cards .reward"); if (!c) return false; c.click(); return true; }).catch(() => false);
      if (!ok) await page.keyboard.press("1");
    }
    await page.waitForTimeout(700);
  }
}

const SCENES = {
  combat: { u: `${TEST}&floor=6&level=14&seed=77`, async go(page) {
    await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
      if (live.length) {
        let best = live[0], bn = -1;
        for (const m of live) { const n = live.filter((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.y - m.pos.y) < 3).length; if (n > bn) { bn = n; best = m; } }
        p.pos.x = best.pos.x + 1.4; p.pos.y = best.pos.y + 0.4;
      }
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
      const up = await page.evaluate(() => { const e = document.getElementById("bossbar");
        return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }).catch(() => false);
      if (up) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
  } },
  shop: { u: `${TEST}&floor=3&level=10&seed=21`, async go(page) {
    await toShop(page);
    await page.evaluate(() => {
      const t = document.querySelector("#sr-shelf .itile:not(.locked):not(.soldout)") ?? document.querySelector("#sr-shelf .itile");
      if (t) t.click();
    }).catch(() => {});
    await page.waitForTimeout(1500);
  } },
  saferoom: { u: `${TEST}&floor=3&level=10&seed=21`, async go(page) {
    await toShop(page);
    await page.evaluate(() => { document.getElementById("sr-tab-rest")?.click(); }).catch(() => {});
    await page.waitForTimeout(1200);
  } },
  socketing: { u: `${TEST}&floor=3&level=10&seed=21`, async go(page) {
    await toShop(page);
    await page.evaluate(() => {
      const p = window.__dcc.state.players[0];
      p.glyphs = p.glyphs ?? { slots: [[], [], [], []], ultimate: [], bench: [] };
      p.glyphs.bench = ["hair_trigger", "accelerant", "splitfang"];
    }).catch(() => {});
    await page.evaluate(() => { document.getElementById("sr-tab-abil")?.click(); });
    await page.waitForTimeout(800);
    await page.evaluate(() => { const g = document.querySelector("#sr-glyphs .gchip"); if (g) g.click(); }).catch(() => {});
    await page.waitForTimeout(900);
  } },
  inventory: { u: `${TEST}&floor=3&level=14&seed=21`, async go(page) { await openPanelKey(page, "i", "inv"); } },
  constellation: { u: `${TEST}&floor=3&level=14&seed=21`, async go(page) { await openPanelKey(page, "t", "abil"); } },
  sheet: { u: `${TEST}&floor=3&level=14&seed=21`, async go(page) { await openPanelKey(page, "p", "sheet"); } },
  postrun: { u: `${TEST}&floor=6&level=16&seed=21`, async go(page) {
    await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      clearInterval(window.__k);
      for (let i = 0; i < 3000 && st.status === "playing"; i++) { p.hp = 0; d.step({ 0: { move: { x: 0, y: 0 }, useStairs: false } }, 1 / 30); }
      if (st.status === "playing") st.status = "dead";
    });
    for (let i = 0; i < 30; i++) {
      const up = await page.evaluate(() => { const e = document.getElementById("recap");
        return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }).catch(() => false);
      if (up) break;
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(1200);
  } },
};

const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const out = [];
const devList = (flag("devices") ?? "iphone13-land,ipadpro11-land,pixel5-land").split(",");
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
      const r = await page.evaluate(READ, { safe: spec.safe, corner: spec.corner, mmpx: spec.mmpx, scene: sn });
      r.device = dn; r.errs = errs.slice(0, 4);
      out.push(r);
      await page.screenshot({ path: join(OUT, `${dn}-${sn}.png`), timeout: 180000 });
      console.log(`${dn}/${sn}: hud ${r.hudCoverPct}% · occluded ${r.handShadow.occludedN}/${r.handShadow.readSetN} · overlaps ${r.overlaps.length} · intrusions ${r.intrusions.length} · under7mm ${r.targets.under7mm}/${r.targets.n} · minText ${r.smallestText[0] ? r.smallestText[0].mm : "?"}mm` +
        (r.panelReach ? ` · panel ${r.panelReach.panel} beyondStretch ${r.panelReach.beyondStretch}/${r.panelReach.n} scrollY ${r.panelReach.overflow.scrollY}` : ""));
    } catch (e) {
      console.log(`${dn}/${sn}: FAILED ${e.message.split("\n")[0]}`);
      out.push({ device: dn, scene: sn, error: e.message.split("\n")[0] });
    }
    await ctx.close();
  }
}
writeFileSync(join(OUT, "layout2.json"), JSON.stringify(out, null, 1));
console.log("->", join(OUT, "layout2.json"));
await browser.close();
