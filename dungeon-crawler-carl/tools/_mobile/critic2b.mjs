// CRITIC ROUND 2, part B — the things part A could not settle:
//   the corner-grip cancel affordance (#t-ocancel), the context chip, tap-to-move,
//   aim-indicator legibility measured as a PIXEL DIFF against the scene's own churn,
//   the panel surfaces (shop / sheet / inventory) opened and closed BY FINGER.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DCC_BASE ?? "http://localhost:5420";
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "tools/_mobile/c2b";

const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  "iphone13promax-land": { pw: "iPhone 13 Pro Max landscape", safe: { top: 0, right: 47, bottom: 21, left: 47 } },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: { top: 24, right: 0, bottom: 20, left: 0 } },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: { top: 0, right: 24, bottom: 0, left: 0 } },
};

function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });
  const api = {
    tick(ms) { clock += ms / 1000; return api; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock });
    },
    async tap(x, y, id = 1, holdMs = 90) { await api.down(id, x, y); api.tick(holdMs); await new Promise((r) => setTimeout(r, Math.min(holdMs, 60))); await api.up(id); },
  };
  return api;
}

const SNAP = () => {
  const s = window.__dcc.state, p = s.players[0];
  return {
    pos: { x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3) },
    hp: Math.round(p.hp), cd: JSON.parse(JSON.stringify(p.cd || {})),
    gold: p.gold ?? 0, bag: (p.inventory || []).length,
    locked: (window.__dcc.touch && window.__dcc.touch.lockedTargetId) ?? null,
    clickTarget: (window.__dcc.touch && window.__dcc.touch.clickMoveTarget) ?? null,
    lastWorldTap: (window.__dcc.touch && window.__dcc.touch.lastWorldTap) ?? null,
  };
};

async function ready(page) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 120000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading"); if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

/** Decode two PNGs in the page (no native deps) and diff inside a CSS-px box. */
async function meanDelta(page, bufA, bufB, box) {
  return page.evaluate(async ([a, b, bx]) => {
    const load = async (b64) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(img, 0, 0);
      return { d: cx.getImageData(0, 0, cv.width, cv.height).data, w: img.width, h: img.height };
    };
    const A = await load(a), B = await load(b);
    if (A.w !== B.w) return { error: "size mismatch" };
    const sx = A.w / bx.vw, sy = A.h / bx.vh, pad = 6;
    const x0 = Math.max(0, Math.floor(bx.x0 * sx) - pad), x1 = Math.min(A.w - 1, Math.ceil(bx.x1 * sx) + pad);
    const y0 = Math.max(0, Math.floor(bx.y0 * sy) - pad), y1 = Math.min(A.h - 1, Math.ceil(bx.y1 * sy) + pad);
    let sum = 0, n = 0, over = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * A.w + x) * 4;
      const d = (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2])) / 3;
      sum += d; n++; if (d > 24) over++;
    }
    return { mean: +(sum / Math.max(1, n)).toFixed(1), pctOver24: +((over / Math.max(1, n)) * 100).toFixed(1), px: n };
  }, [bufA.toString("base64"), bufB.toString("base64"), box]);
}

async function run(dname) {
  const spec = SPECS[dname];
  const ctx = await browser.newContext({ ...devices[spec.pw], hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const touch = touchDriver(client);
  const out = [];
  const rec = (name, verdict, detail) => { out.push({ name, verdict, detail }); console.log(`  [${verdict}] ${name} — ${detail}`); };
  const settle = async (n = 6) => {
    await page.waitForTimeout(180);
    await page.evaluate((k) => new Promise((res) => { let i = 0; const t = () => (++i >= k ? res(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), n).catch(() => {});
  };
  const snap = () => page.evaluate(SNAP);
  const at = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect(); if (!r.width) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  }, sel);

  const url = `${BASE}/iso.html?test&debug=1&abilities=all&eagerassets&quality=performance&floor=6&level=14&seed=77&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await ready(page);
  const V = page.viewportSize();
  await page.evaluate(() => {
    clearInterval(window.__c2keep);
    window.__c2keep = setInterval(() => {
      const s = window.__dcc && window.__dcc.state; if (!s) return;
      const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; if (!s.safeRoom) s.status = "playing";
    }, 120);
  });
  await page.evaluate(() => {
    const st = window.__dcc.state, p = st.players[0];
    const live = st.monsters.filter((m) => !m.dormant && m.hp > 0);
    live.sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))
      .slice(0, 6).forEach((m, k) => {
        const a = (k / 6) * Math.PI * 2 + 2.6;
        m.pos.x = p.pos.x + Math.cos(a) * (2.2 + (k % 2) * 0.6);
        m.pos.y = p.pos.y + Math.sin(a) * (2.2 + (k % 2) * 0.6);
      });
  });
  await settle(10);

  const chip = {};
  for (const k of ["1", "2", "3", "4"]) chip[k] = await at(`#skills .skill[data-i="${k}"]`);

  // ---- 1. THE CORNER-GRIP CANCEL AFFORDANCE (#t-ocancel) -----------------
  {
    const c = chip["2"];
    await touch.down(1, c.x, c.y);
    await settle(2);
    for (let i = 1; i <= 10; i++) { await touch.move(1, c.x - i * 11, c.y - i * 5); await settle(1); }
    await settle(4);
    const ring = await page.evaluate(() => {
      const g = (id) => {
        const e = document.getElementById(id); if (!e) return null;
        const cs = getComputedStyle(e), r = e.getBoundingClientRect();
        let op = 1, n = e;
        while (n && n !== document.body) { op *= +getComputedStyle(n).opacity; n = n.parentElement; }
        return { id, display: cs.display, opacity: cs.opacity, effOpacity: +op.toFixed(3), cls: e.className, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), bg: cs.backgroundColor, border: cs.border, text: (e.textContent || "").trim() };
      };
      return { ocancel: g("t-ocancel"), cancel: g("t-cancel"), mode: window.__dcc.touch.zones.cancelMode };
    });
    // now walk the finger BACK into the cancel radius and see if it arms
    for (let i = 10; i >= 1; i--) { await touch.move(1, c.x - i * 3, c.y - i * 1); await settle(1); }
    await settle(3);
    const armed = await page.evaluate(() => {
      const e = document.getElementById("t-ocancel");
      return e ? { cls: e.className, opacity: getComputedStyle(e).opacity, bg: getComputedStyle(e).backgroundColor } : null;
    });
    await touch.up(1);
    await settle(6);
    const okDrawn = ring.ocancel && ring.ocancel.display !== "none" && ring.ocancel.effOpacity > 0.15 && ring.ocancel.w >= 44;
    rec("cancel affordance is DRAWN while aiming", okDrawn ? "PASS" : "FAIL",
      `mode=${ring.mode}; #t-ocancel=${JSON.stringify(ring.ocancel)}; #t-cancel=${JSON.stringify(ring.cancel)}; on re-entry: ${JSON.stringify(armed)}`);
  }

  // ---- 2. AIM INDICATOR: shape, projected size, and the LEGIBILITY DIFF ---
  for (const slot of ["1", "2", "4"]) {
    const c = chip[slot];
    if (!c) continue;
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; for (const k in p.cd) p.cd[k] = 0; });
    await touch.down(1, c.x, c.y);
    await settle(2);
    for (let i = 1; i <= 12; i++) { await touch.move(1, c.x - i * 10, c.y - i * 5); await settle(1); }
    await settle(6);
    const info = await page.evaluate(() => {
      const d = window.__dcc, r = d.renderer, ind = r.aimIndicator;
      if (!ind) return null;
      const cam = r.camera;
      const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0;
      const names = [];
      const proj = (o) => {
        o.updateWorldMatrix(true, true);
        o.traverse((q) => {
          if (!q.visible) return;
          const g = q.geometry; if (!g || !g.attributes || !g.attributes.position) return;
          const pos = g.attributes.position, e = q.matrixWorld.elements;
          for (let i = 0; i < pos.count; i++) {
            const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
            const wx = e[0] * vx + e[4] * vy + e[8] * vz + e[12];
            const wy = e[1] * vx + e[5] * vy + e[9] * vz + e[13];
            const wz = e[2] * vx + e[6] * vy + e[10] * vz + e[14];
            const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15] || 1;
            const cx = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
            const cy = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;
            const sx = (cx * 0.5 + 0.5) * innerWidth, sy = (-cy * 0.5 + 0.5) * innerHeight;
            minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy); n++;
          }
        });
      };
      for (const ch of ind.children) if (ch.visible) { names.push(ch.name || ch.type); proj(ch); }
      const mats = [];
      ind.traverse((o) => { if (o.visible && o.material) mats.push({ c: "#" + o.material.color.getHexString(), o: +o.material.opacity.toFixed(2), t: o.material.type }); });
      const p = window.__dcc.state.players[0];
      return {
        children: names, verts: n,
        box: n ? { x0: Math.round(minX), y0: Math.round(minY), x1: Math.round(maxX), y1: Math.round(maxY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) } : null,
        mats: mats.slice(0, 5),
        ability: p.abilities.slots[+"SLOT"] ?? null,
      };
    });
    if (!info || !info.box) { rec(`aim indicator slot ${slot}`, "FAIL", "no projectable geometry while the finger is down"); await touch.up(1); continue; }
    // shoot ON, then hide the indicator and shoot OFF twice for the churn floor
    const bOn = await page.screenshot({ path: join(OUT, `${dname}-aim${slot}-on.png`) });
    await page.evaluate(() => { window.__dcc.renderer.aimIndicator.visible = false; });
    await settle(5);
    const bOff1 = await page.screenshot({ path: join(OUT, `${dname}-aim${slot}-off1.png`) });
    await settle(5);
    const bOff2 = await page.screenshot();
    await page.evaluate(() => { window.__dcc.renderer.aimIndicator.visible = true; });
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const box = {
      x0: cl(info.box.x0, 0, V.width), y0: cl(info.box.y0, 0, V.height),
      x1: cl(info.box.x1, 0, V.width), y1: cl(info.box.y1, 0, V.height), vw: V.width, vh: V.height,
    };
    const full = { x0: 0, y0: 0, x1: V.width, y1: V.height, vw: V.width, vh: V.height };
    const degenerate = box.x1 - box.x0 < 8 || box.y1 - box.y0 < 8;
    const use = degenerate ? full : box;
    let sig = null, floor = null, sigFull = null, floorFull = null;
    try {
      sig = await meanDelta(page, bOn, bOff1, use); floor = await meanDelta(page, bOff1, bOff2, use);
      sigFull = await meanDelta(page, bOn, bOff1, full); floorFull = await meanDelta(page, bOff1, bOff2, full);
    } catch (e) { sig = { err: e.message }; }
    await touch.up(1);
    await settle(4);
    const ratio = sig && floor && floor.mean > 0 ? +(sig.mean / floor.mean).toFixed(2) : null;
    rec(`aim indicator slot ${slot}: legibility vs scene churn`,
      ratio !== null && ratio >= 2 ? "PASS" : "FAIL",
      `shape=${info.children.join("+")} box ${info.box.w}x${info.box.h} at (${info.box.x0},${info.box.y0}); mats=${JSON.stringify(info.mats)}; ` +
      `box used=${JSON.stringify(use)}${degenerate ? " (projected box was off-screen; fell back to the whole frame)" : ""}; ` +
      `indicator on→off Δ${sig && sig.mean} (${sig && sig.pctOver24}% over 24) vs churn floor Δ${floor && floor.mean}; ratio=${ratio}; ` +
      `full-frame Δ${sigFull && sigFull.mean} vs floor Δ${floorFull && floorFull.mean}`);
  }

  // ---- 3. THE CONTEXT CHIP -----------------------------------------------
  {
    const diag = await page.evaluate(() => {
      const d = window.__dcc, st = d.state, p = st.players[0];
      const s = st.map.stairs;
      p.pos.x = s.x; p.pos.y = s.y;
      for (const m of st.monsters) m.hp = 0;
      return { stairs: s, pos: { x: p.pos.x, y: p.pos.y }, w: st.map.w };
    });
    await settle(20);
    const chipState = await page.evaluate(() => {
      const e = document.getElementById("t-stairs");
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      return { cls: e.className, display: cs.display, text: e.textContent, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), body: document.body.className };
    });
    let verdict = "FAIL", detail = `standing on the stairs at ${JSON.stringify(diag.pos)} the chip is ${JSON.stringify(chipState)}`;
    if (chipState.display !== "none" && chipState.w > 0) {
      await page.evaluate(() => clearInterval(window.__c2keep));
      const a = await snap();
      await touch.tap(chipState.x, chipState.y, 1, 110);
      await settle(24);
      const sr = await page.evaluate(() => ({ safeRoom: !!window.__dcc.state.safeRoom, panel: (() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; })() }));
      verdict = sr.safeRoom || sr.panel ? "PASS" : "FAIL";
      detail = `chip ${chipState.w}x${chipState.h} "${chipState.text}"; after tap safeRoom=${sr.safeRoom} panel=${sr.panel}`;
    }
    rec("interact: context chip descends", verdict, detail);
  }

  // ---- 4. THE SHOP, BY FINGER --------------------------------------------
  {
    const shopUp = await page.evaluate(() => {
      const e = document.getElementById("saferoom");
      return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
    });
    if (!shopUp) rec("shop: buy with a finger", "N/A", "the safe room never opened, so nothing to drive");
    else {
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.gold = (p.gold ?? 0) + 8000; });
      await settle(6);
      const geom = await page.evaluate(() => {
        const panel = document.getElementById("saferoom");
        const r = panel.getBoundingClientRect();
        const tiles = [...document.querySelectorAll("#sr-shelf .itile")].map((t) => {
          const b = t.getBoundingClientRect();
          const cx = Math.round(b.x + b.width / 2), cy = Math.round(b.y + b.height / 2);
          const hit = document.elementFromPoint(cx, cy);
          return { x: cx, y: cy, w: Math.round(b.width), h: Math.round(b.height), reachable: !!(hit && (hit === t || t.contains(hit))), hit: hit ? `${hit.tagName}#${hit.id || ""}.${(typeof hit.className === "string" ? hit.className.split(" ")[0] : "")}` : "nothing" };
        });
        const closers = [...panel.querySelectorAll(".tp-x, .tp-done, [data-close]")].map((e) => {
          const b = e.getBoundingClientRect();
          return { cls: e.className, w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), vis: getComputedStyle(e).display !== "none" };
        });
        const small = [...panel.querySelectorAll("button, .itile, .tab, [role=button], .srtab")].filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && (b.width < 44 || b.height < 44);
        }).map((e) => `${e.tagName}.${(typeof e.className === "string" ? e.className.split(" ")[0] : "")} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
        return {
          panel: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
          overflowY: panel.scrollHeight - panel.clientHeight, tiles, closers, small: small.slice(0, 12), smallN: small.length,
        };
      });
      const reach = geom.tiles.filter((t) => t.reachable);
      const a = await snap();
      let bought = null;
      if (reach.length) {
        await touch.tap(reach[0].x, reach[0].y, 1, 110);
        await settle(10);
        const buy = await page.evaluate(() => {
          const b = document.querySelector("#sr-detail [data-buy], #sr-detail .buy, #sr-buy, [data-buy]");
          if (!b) return null;
          const r = b.getBoundingClientRect();
          const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
          const hit = document.elementFromPoint(cx, cy);
          return { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), reachable: !!(hit && (hit === b || b.contains(hit))), text: (b.textContent || "").trim().slice(0, 30) };
        });
        if (buy && buy.reachable) { await touch.tap(buy.x, buy.y, 1, 110); await settle(12); }
        bought = buy;
      }
      const b = await snap();
      rec("shop: buy with a finger", b.gold < a.gold || b.bag > a.bag ? "PASS" : "FAIL",
        `panel ${geom.panel.w}x${geom.panel.h} at (${geom.panel.x},${geom.panel.y}) overflowY=${geom.overflowY}; ` +
        `tiles ${geom.tiles.length} (${reach.length} hit-testable); buy=${JSON.stringify(bought)}; gold ${a.gold}->${b.gold}, bag ${a.bag}->${b.bag}`);
      rec("shop: touch targets + close control", geom.closers.some((c) => c.vis && c.w >= 44 && c.h >= 40) && geom.smallN === 0 ? "PASS" : "FAIL",
        `closers=${JSON.stringify(geom.closers)}; under-44 controls (${geom.smallN}): ${geom.small.join(" · ") || "none"}`);
      // close it with a finger
      const closer = geom.closers.find((c) => c.vis);
      if (closer) {
        await touch.tap(closer.x, closer.y, 1, 110);
        await settle(12);
        const still = await page.evaluate(() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
        rec("shop: closes by finger", !still ? "PASS" : "FAIL", `tapped ${closer.cls} ${closer.w}x${closer.h}; still open=${still}`);
      } else rec("shop: closes by finger", "FAIL", "no visible close control in the panel");
    }
  }

  // ---- 5. CHARACTER SHEET / INVENTORY, opened the way a phone must --------
  {
    // Is there ANY touch path to the sheet? The chips are combat-only; the
    // documented route is the top banner menus.
    const routes = await page.evaluate(() => {
      const g = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), vis: cs.display !== "none" && +cs.opacity > 0 }; };
      return { system: g("#tb-system"), crawler: g("#tb-crawler") };
    });
    let opened = false, how = "";
    if (routes.crawler && routes.crawler.vis) {
      await touch.tap(routes.crawler.x, routes.crawler.y, 1, 110);
      await settle(8);
      const items = await page.evaluate(() => [...document.querySelectorAll("#tm-crawler button, #tm-crawler .mi, #tm-crawler > *")].map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || "").trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }).filter((e) => e.w > 0));
      const sheetItem = items.find((i) => /crawler profile|character|sheet|stats/i.test(i.t));
      how = `#tb-crawler ${routes.crawler.w}x${routes.crawler.h}; menu items ${JSON.stringify(items.slice(0, 8))}`;
      if (sheetItem) {
        await touch.tap(sheetItem.x, sheetItem.y, 1, 110);
        await settle(10);
        opened = await page.evaluate(() => { const e = document.getElementById("sheet"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
      }
    }
    if (!opened) { await page.keyboard.press("p"); await settle(10); }
    const sheet = await page.evaluate(() => {
      const e = document.getElementById("sheet");
      if (!e) return null;
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      if (cs.display === "none" || !r.width) return { open: false };
      const inner = e.querySelector(".panel") || e;
      const closers = [...e.querySelectorAll(".tp-x, .tp-done")].map((q) => { const b = q.getBoundingClientRect(); return { cls: q.className, w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), vis: getComputedStyle(q).display !== "none" }; });
      const scrollers = [...e.querySelectorAll("*")].filter((q) => q.scrollWidth - q.clientWidth > 4).map((q) => `${q.tagName}.${(typeof q.className === "string" ? q.className.split(" ")[0] : "")} +${q.scrollWidth - q.clientWidth}px`);
      return {
        open: true, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
        scrollY: inner.scrollHeight - inner.clientHeight, xOverflow: scrollers.slice(0, 6),
        closers, hoverText: /hover/i.test(e.textContent || ""),
      };
    });
    rec("character sheet: reachable by finger", opened ? "PASS" : "FAIL", `${how}; opened by touch=${opened}; sheet=${JSON.stringify(sheet)}`);
    if (sheet && sheet.open) {
      const closer = sheet.closers.find((c) => c.vis);
      if (!closer) rec("character sheet: closes by finger", "FAIL", "no visible close control");
      else {
        await touch.tap(closer.x, closer.y, 1, 110);
        await settle(10);
        const still = await page.evaluate(() => { const e = document.getElementById("sheet"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
        rec("character sheet: closes by finger", !still ? "PASS" : "FAIL", `tapped ${closer.cls} ${closer.w}x${closer.h}; still open=${still}`);
      }
      rec("character sheet: content fits", sheet.xOverflow.length === 0 ? "PASS" : "FAIL",
        `horizontal overflow: ${sheet.xOverflow.join(" · ") || "none"}; vertical ${sheet.scrollY}px; says "hover"=${sheet.hoverText}`);
    }
  }

  await page.screenshot({ path: join(OUT, `${dname}-end.png`) }).catch(() => {});
  rec("page errors", errs.length === 0 ? "PASS" : "FAIL", errs.slice(0, 3).join(" | ") || "none");
  await ctx.close();
  return { device: dname, viewport: V, checks: out, errs };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const devs = (process.argv.includes("--devices") ? process.argv[process.argv.indexOf("--devices") + 1] : Object.keys(SPECS).join(",")).split(",");
const report = [];
for (const d of devs) {
  console.log("== " + d);
  try { report.push(await run(d)); } catch (e) { console.error("FAILED", d, e.message); report.push({ device: d, error: e.message }); }
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log("-> " + join(OUT, "report.json"));
await browser.close();
