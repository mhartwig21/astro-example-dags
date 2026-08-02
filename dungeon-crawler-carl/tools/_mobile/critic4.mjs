// CRITIC ROUND 1 — pass 4. Corrected for two of my own measurement bugs:
//  * the harness injects ?safe=t,r,b,l because Chromium reports env() as 0 —
//    a safe-area verdict taken without it measures nothing.
//  * a stick probe that always pushes +x scores "dead" against a wall.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { touchDriver, DEVICE_SPECS } from "../mobileshot.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const BASE = flag("base", "http://localhost:5420");
const OUT = flag("out", "tools/_mobile/c4");
const DEVS = (flag("devices", "iphone13-land")).split(",");
mkdirSync(OUT, { recursive: true });

async function ready(page) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 300000 });
  await page.waitForFunction(() => !!(window.__dcc && window.__dcc.state), null, { timeout: 180000 });
  await page.waitForFunction(() => { const l = document.getElementById("loading"); if (!l) return true; const cs = getComputedStyle(l); return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0; }, null, { timeout: 300000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function run(devKey, browser) {
  const spec = DEVICE_SPECS[devKey];
  const ctx = await browser.newContext({ ...devices[spec.pw] });
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  const touch = touchDriver(client);
  const rows = [];
  const rec = (name, verdict, detail) => { rows.push({ name, verdict, detail }); console.log(`  [${verdict}] ${name} — ${detail}`); };
  const url = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=14&gold=6000&seed=21&safe=${spec.safe.top},${spec.safe.right},${spec.safe.bottom},${spec.safe.left}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300000 });
  await ready(page);
  const V = page.viewportSize();
  const settle = async (frames = 5) => { await page.waitForTimeout(90); await page.evaluate((n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), frames).catch(() => {}); };
  await page.evaluate(() => { clearInterval(window.__keep); window.__keep = setInterval(() => { const s = window.__dcc && window.__dcc.state; if (!s) return; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; if (!s.safeRoom) s.status = "playing"; }, 120); }).catch(() => {});
  const pos = () => page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
  // Park the crawler in the middle of the widest open area we can find, and
  // clear the pack, so a stick probe measures INPUT and not a wall.
  const openGround = () => page.evaluate(() => {
    const s = window.__dcc.state, m = s.map, p = s.players[0];
    for (const mo of s.monsters) mo.hp = 0;
    const blocked = (x, y) => { const i = Math.floor(y) * m.w + Math.floor(x); return !!(m.blocked && m.blocked[i]) || (m.tiles && m.tiles[i] === 0); };
    let best = null;
    for (const r of (m.rooms || [])) {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const area = r.w * r.h;
      if (!best || area > best.area) best = { x: cx, y: cy, area };
    }
    if (best) { p.pos.x = best.x; p.pos.y = best.y; }
    return { x: p.pos.x, y: p.pos.y, blockedHere: blocked(p.pos.x, p.pos.y) };
  }).catch(() => null);

  const Z = await page.evaluate(() => {
    const z = window.__dcc.touch.zones; if (!z) return null;
    const o = { cls: z.cls, safe: z.safe, stickZone: z.stickZone, worldZone: z.worldZone, cancelBand: z.cancelBand, stickRadius: z.stickRadius, aimThrow: z.aimThrow, cancelRadius: z.cancelRadius, mmPerPx: z.mmPerPx, pivot: z.pivot, arcRadius: z.arcRadius, comfortable: z.comfortable, stretch: z.stretch, controls: {} };
    for (const [k, v] of Object.entries(z.controls || {})) o.controls[k] = { x: Math.round(v.x), y: Math.round(v.y), w: Math.round(v.w), h: Math.round(v.h) };
    return o;
  });
  rows.push({ name: "zones", verdict: "INFO", detail: JSON.stringify(Z) });

  // ---------- SAFE AREAS, with the insets actually published ----------
  {
    const bad = await page.evaluate((safe) => {
      const ids = ["minimap-frame", "cockpit", "t-stairs", "banner", "hud-tl", "hud-tr", "ticker", "xpbar", "toasts", "tutorial", "t-map", "show", "bossbar", "flask-chip"];
      const out = [];
      for (const id of ids) {
        const e = document.getElementById(id); if (!e) continue;
        const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        if (!r.width || cs.display === "none" || cs.visibility === "hidden") continue;
        if (safe.left && r.left < safe.left) out.push(`${id} left ${Math.round(r.left)}<${safe.left}`);
        if (safe.right && innerWidth - r.right < safe.right) out.push(`${id} right ${Math.round(innerWidth - r.right)}<${safe.right}`);
        if (safe.top && r.top < safe.top) out.push(`${id} top ${Math.round(r.top)}<${safe.top}`);
        if (safe.bottom && innerHeight - r.bottom < safe.bottom) out.push(`${id} bottom ${Math.round(innerHeight - r.bottom)}<${safe.bottom}`);
      }
      return out;
    }, spec.safe);
    rec("safe areas (insets published via ?safe=)", bad.length === 0 ? "PASS" : "FAIL", bad.join(" · ") || "every HUD box clears the hardware inset");
  }

  // ---------- STICK COVERAGE, four pushes per point, open ground ----------
  {
    const og = await openGround();
    const dead = [];
    const grid = [];
    for (const fx of [0.06, 0.18, 0.32, 0.44]) {
      for (const fy of [0.25, 0.5, 0.75, 0.95]) {
        const px = Math.round(V.width * fx), py = Math.round(V.height * fy);
        let best = 0, zone = null;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.alive = true; });
          const rt = await page.evaluate(([a, b]) => { const t = window.__dcc.touch; return t.route ? t.route(a, b) : null; }, [px, py]);
          zone = rt && rt.zone;
          const a = await pos();
          await touch.down(1, px, py);
          for (let i = 0; i < 8; i++) { touch.tick(16); await touch.move(1, px + dx * 60, py + dy * 60); await settle(2); }
          const b = await pos();
          await touch.up(1);
          await settle(1);
          best = Math.max(best, Math.hypot(b.x - a.x, b.y - a.y));
          if (best > 0.4) break;
        }
        grid.push(`${fx},${fy}:${best > 0.4 ? "OK" : "DEAD"}(${best.toFixed(1)}/${zone})`);
        if (best <= 0.4) dead.push(`${px},${py}(${zone})`);
      }
    }
    rec("walk: every point of the thumb side drives the stick", dead.length === 0 ? "PASS" : "FAIL", `open ground ${JSON.stringify(og)}; ${dead.length}/16 dead: ${dead.join(" ")} · full grid ${grid.join(" ")}`);
  }

  // ---------- WALK WHILE AIMING (two fingers, the second one drags) ----------
  {
    await openGround();
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const q of Object.keys(p.cd || {})) p.cd[q] = 0; });
    const c = await page.evaluate(() => { const e = document.querySelector('#skills .skill[data-i="3"]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    const sx = Math.round(V.width * 0.18), sy = Math.round(V.height * 0.6);
    // pick a push direction that actually moves in open ground
    let dir = null;
    for (const [dx, dy] of [[1, 0], [0, -1], [-1, 0], [0, 1]]) {
      const a = await pos();
      await touch.down(1, sx, sy);
      for (let i = 0; i < 6; i++) { touch.tick(16); await touch.move(1, sx + dx * 60, sy + dy * 60); await settle(2); }
      const b = await pos();
      await touch.up(1); await settle(1);
      if (Math.hypot(b.x - a.x, b.y - a.y) > 0.4) { dir = [dx, dy]; break; }
    }
    if (!dir) rec("multi-touch: walk while the other thumb aims", "N/A", "could not find a free push direction");
    else {
      await touch.down(1, sx, sy);
      for (let i = 0; i < 6; i++) { touch.tick(16); await touch.move(1, sx + dir[0] * 60, sy + dir[1] * 60); await settle(2); }
      const a = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { pos: { ...p.pos }, cd: JSON.parse(JSON.stringify(p.cd || {})) }; });
      await touch.down(2, c.x, c.y);
      for (let i = 1; i <= 10; i++) { touch.tick(16); await touch.move(2, c.x, c.y - i * 10); await touch.move(1, sx + dir[0] * 60, sy + dir[1] * 60); await settle(2); }
      const mid = await pos();
      await touch.up(2);
      await settle(8);
      const b = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { pos: { ...p.pos }, cd: JSON.parse(JSON.stringify(p.cd || {})) }; });
      await touch.up(1);
      const during = Math.hypot(mid.x - a.pos.x, mid.y - a.pos.y);
      const started = Object.keys(b.cd).filter((x) => (b.cd[x] || 0) > (a.cd[x] || 0));
      rec("multi-touch: walk while the other thumb aims", during > 0.4 && started.length ? "PASS" : "FAIL", `pushed ${JSON.stringify(dir)}; walked ${during.toFixed(2)} tiles during the aim drag; aimed cast fired ${started.join(",") || "NONE"}`);
    }
  }

  // ---------- START WALKING WHILE THE CANCEL BAND IS UP ----------
  if (Z) {
    await openGround();
    const b = Z.cancelBand, s = Z.stickZone;
    const ox1 = Math.max(b.x, s.x), ox2 = Math.min(b.x + b.w, s.x + s.w);
    const oy1 = Math.max(b.y, s.y), oy2 = Math.min(b.y + b.h, s.y + s.h);
    if (ox2 - ox1 < 8 || oy2 - oy1 < 8) rec("conflict: walk while the CANCEL band is up", "PASS", "band and stick zone do not overlap");
    else {
      const px = Math.round((ox1 + ox2) / 2), py = Math.round((oy1 + oy2) / 2);
      const c = await page.evaluate(() => { const e = document.querySelector('#skills .skill[data-i="3"]'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const q of Object.keys(p.cd || {})) p.cd[q] = 0; });
      // raise the band
      await touch.down(2, c.x, c.y);
      for (let i = 1; i <= 8; i++) { touch.tick(16); await touch.move(2, c.x, c.y - i * 12); await settle(1); }
      const rt = await page.evaluate(([a, bb]) => { const t = window.__dcc.touch; return t.route ? t.route(a, bb) : null; }, [px, py]);
      let best = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
        const a = await pos();
        await touch.down(1, px, py);
        for (let i = 0; i < 8; i++) { touch.tick(16); await touch.move(1, px + dx * 60, py + dy * 60); await settle(2); }
        const bb = await pos();
        await touch.up(1);
        best = Math.max(best, Math.hypot(bb.x - a.x, bb.y - a.y));
        if (best > 0.4) break;
      }
      const st = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { cd: JSON.parse(JSON.stringify(p.cd || {})) }; });
      await touch.up(2);
      await settle(6);
      const after = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { cd: JSON.parse(JSON.stringify(p.cd || {})) }; });
      rec("conflict: walk while the CANCEL band is up", best > 0.4 ? "PASS" : "FAIL",
        `overlap ${Math.round(ox2 - ox1)}x${Math.round(oy2 - oy1)} px = ${Math.round(((ox2 - ox1) * (oy2 - oy1) * 100) / (b.w * b.h))}% of the band; a fresh finger at (${px},${py}) routes to ${JSON.stringify(rt)} and moved ${best.toFixed(2)} tiles; the aim resolved as ${JSON.stringify(after.cd.bulwark ? "cast" : "cancel/none")}`);
    }
  }

  // ---------- FLASK ----------
  {
    await page.evaluate(() => { clearInterval(window.__keep); const p = window.__dcc.state.players[0]; p.alive = true; p.downedT = 0; p.hp = Math.max(1, Math.round(p.maxHp * 0.4)); p.flaskCharges = 3; });
    const c = await page.evaluate(() => { const e = document.getElementById("flask-chip"); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; });
    const a = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { hp: Math.round(p.hp), f: p.flaskCharges }; });
    await touch.tap(c.x, c.y, 1, 160);
    await settle(12);
    const b = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { hp: Math.round(p.hp), f: p.flaskCharges }; });
    rec("potion: flask chip", b.f < a.f || b.hp > a.hp ? "PASS" : "FAIL", `chip ${c.w}x${c.h}; charges ${a.f}->${b.f}, hp ${a.hp}->${b.hp}`);
    await page.evaluate(() => { window.__keep = setInterval(() => { const s = window.__dcc && window.__dcc.state; if (!s) return; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; if (!s.safeRoom) s.status = "playing"; }, 120); });
  }

  // ---------- SHOP: buy, verified against stock ----------
  {
    await page.evaluate(() => {
      const st = window.__dcc.state, p = st.players[0];
      p.gold = (p.gold ?? 0) + 6000;
      for (const m of st.monsters) m.hp = 0;
      p.alive = true; p.downedT = 0; p.hp = p.maxHp; st.status = "playing";
      p.pos.x = st.map.stairs.x + 0.5; p.pos.y = st.map.stairs.y + 0.5;
      clearInterval(window.__keep);
      window.__keep = setInterval(() => { const d = window.__dcc; if (!d) return; const q = d.state.players[0]; if (!d.state.safeRoom) { q.hp = q.maxHp; q.alive = true; q.downedT = 0; } }, 200);
    });
    await page.waitForFunction(() => { const d = window.__dcc; if (!d || d.state.safeRoom) return true; d.step({ 0: { move: { x: 0, y: 0 }, useStairs: true } }, 1 / 60); return !!d.state.safeRoom; }, null, { timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      const st = await page.evaluate(() => { const vis = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }; return { draft: vis("draft"), shop: vis("saferoom") }; }).catch(() => ({}));
      if (st.shop) break;
      if (st.draft) await page.evaluate(() => { const c = document.querySelector("#draft-cards .reward"); if (c) c.click(); }).catch(() => {});
      await page.waitForTimeout(600);
    }
    const open = await page.evaluate(() => { const e = document.getElementById("saferoom"); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; });
    if (!open) rec("shop: open", "FAIL", "safe room never appeared");
    else {
      const tile = await page.evaluate(() => {
        const t = [...document.querySelectorAll("#saferoom .itile")].filter((e) => e.getBoundingClientRect().width > 0 && !e.classList.contains("locked") && !e.classList.contains("soldout"))[0];
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), txt: t.textContent.trim().slice(0, 30) };
      });
      let ok = false, detail = "no shelf tile";
      if (tile) {
        await touch.tap(tile.x, tile.y, 1, 130);
        await settle(8);
        const detailUp = await page.evaluate(() => { const d = document.getElementById("sr-detail"); return d ? d.textContent.trim().slice(0, 50) : null; });
        const buy = await page.evaluate(() => {
          const b = [...document.querySelectorAll("#saferoom [data-buy]")].filter((e) => e.getBoundingClientRect().width > 0)[0];
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), txt: b.textContent.trim(), dis: !!b.disabled, id: b.dataset.buy };
        });
        const a = await page.evaluate(() => { const s = window.__dcc.state, p = s.players[0]; return { gold: p.gold, bag: (p.bag || []).length, stock: JSON.stringify(s.shop ?? s.safeRoom ?? {}).length }; });
        if (buy && !buy.dis) {
          await touch.tap(buy.x, buy.y, 1, 140);
          await settle(12);
          const b2 = await page.evaluate(() => { const s = window.__dcc.state, p = s.players[0]; return { gold: p.gold, bag: (p.bag || []).length, stock: JSON.stringify(s.shop ?? s.safeRoom ?? {}).length, stamp: (document.getElementById("sr-stamp") || {}).textContent }; });
          ok = b2.gold !== a.gold || b2.bag !== a.bag || b2.stock !== a.stock;
          detail = `tile "${tile.txt}" ${tile.w}x${tile.h} → detail "${detailUp}" → BUY ${buy.w}x${buy.h} "${buy.txt}" (id ${buy.id}); gold ${a.gold}→${b2.gold}, bag ${a.bag}→${b2.bag}, stamp "${b2.stamp}"`;
        } else detail = `tile tapped, detail "${detailUp}", BUY = ${JSON.stringify(buy)}`;
      }
      rec("shop: buy with a finger", ok ? "PASS" : "FAIL", detail);
      // and can a finger reach the whole shelf?
      const shelf = await page.evaluate(() => {
        const tiles = [...document.querySelectorAll("#saferoom .itile")].filter((e) => e.getBoundingClientRect().width > 0);
        const off = tiles.filter((e) => { const r = e.getBoundingClientRect(); return r.top > innerHeight || r.bottom < 0; });
        const scrollable = (e) => { let n = e.parentElement; while (n && n !== document.body) { const cs = getComputedStyle(n); if ((n.scrollHeight - n.clientHeight > 8) && /auto|scroll/.test(cs.overflowY)) return true; n = n.parentElement; } return false; };
        return { n: tiles.length, off: off.length, offReachable: off.filter(scrollable).length };
      });
      rec("shop: the whole shelf is reachable", shelf.off === shelf.offReachable ? "PASS" : "FAIL", `${shelf.n} tiles, ${shelf.off} off-screen, ${shelf.offReachable} of those inside a scroller`);
    }
  }

  await page.screenshot({ path: `${OUT}/${devKey}.png` });
  await ctx.close();
  return { device: devKey, rows };
}

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const all = [];
for (const d of DEVS) { console.log(`\n=== ${d} ===`); try { all.push(await run(d, browser)); } catch (e) { console.log(`  [ERROR] ${d}: ${e.message}`); all.push({ device: d, error: e.message }); } }
await browser.close();
writeFileSync(`${OUT}/report-${DEVS.join("_")}.json`, JSON.stringify(all, null, 2));
console.log("\nwrote report");
