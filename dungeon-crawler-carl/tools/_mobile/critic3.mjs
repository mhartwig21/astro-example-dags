// CRITIC ROUND 1 — pass 3. Focused re-tests where pass 1/2 detectors were weak,
// plus the reach audit against the layer's OWN zone table.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { touchDriver, DEVICE_SPECS } from "../mobileshot.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const BASE = flag("base", "http://localhost:5420");
const OUT = flag("out", "tools/_mobile/c3");
const DEVS = (flag("devices", "iphone13-land")).split(",");
mkdirSync(OUT, { recursive: true });
const URL_ = `${BASE}/iso.html?test&debug=1&abilities=all&noassets&quality=performance&floor=6&level=14&gold=6000&seed=21`;

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
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 300000 });
  await ready(page);
  const V = page.viewportSize();
  const settle = async (frames = 5) => { await page.waitForTimeout(90); await page.evaluate((n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res(null) : requestAnimationFrame(t)); requestAnimationFrame(t); }), frames).catch(() => {}); };
  const keepAlive = () => page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; window.__dcc.state.status = "playing"; }).catch(() => {});
  await page.evaluate(() => { clearInterval(window.__keep); window.__keep = setInterval(() => { const s = window.__dcc && window.__dcc.state; if (!s) return; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; if (!s.safeRoom) s.status = "playing"; }, 120); }).catch(() => {});

  // ---------- ZONE TABLE + REACH AUDIT ----------
  const Z = await page.evaluate(() => {
    const z = window.__dcc.touch.zones;
    if (!z) return null;
    const out = { cls: z.cls, vp: z.viewport, insets: z.insets, safe: z.safe, stickZone: z.stickZone, worldZone: z.worldZone, cancelBand: z.cancelBand, stickRadius: z.stickRadius, aimThrow: z.aimThrow, cancelRadius: z.cancelRadius, mmPerPx: z.mmPerPx, pivot: z.pivot, arcRadius: z.arcRadius, comfortable: z.comfortable, stretch: z.stretch, controls: {} };
    for (const [k, v] of Object.entries(z.controls || {})) out.controls[k] = { x: Math.round(v.x), y: Math.round(v.y), w: Math.round(v.w), h: Math.round(v.h), r: v.r };
    return out;
  });
  rows.push({ name: "zones", verdict: "INFO", detail: JSON.stringify(Z) });
  if (Z) {
    const reach = Object.entries(Z.controls).map(([k, c]) => {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      return { id: k, d: Math.round(Math.hypot(cx - Z.pivot.x, cy - Z.pivot.y)), size: `${c.w}x${c.h}` };
    });
    const beyond = reach.filter((r) => r.d > Z.comfortable);
    rec("reach: every control inside `comfortable` of the pivot", beyond.length === 0 ? "PASS" : "FAIL",
      `comfortable=${Math.round(Z.comfortable)} stretch=${Math.round(Z.stretch)} pivot=(${Math.round(Z.pivot.x)},${Math.round(Z.pivot.y)}); ${reach.map((r) => `${r.id}:${r.d}`).join(" ")}; beyond=${JSON.stringify(beyond)}`);
    const small = Object.entries(Z.controls).filter(([, c]) => c.w < 44 || c.h < 44).map(([k, c]) => `${k} ${c.w}x${c.h}`);
    rec("reach: chip hit rects >= 44px", small.length === 0 ? "PASS" : "FAIL", small.join(" · ") || "all >= 44");
    // cancel band vs stick zone
    const b = Z.cancelBand, s = Z.stickZone;
    const ox = Math.max(0, Math.min(b.x + b.w, s.x + s.w) - Math.max(b.x, s.x));
    const oy = Math.max(0, Math.min(b.y + b.h, s.y + s.h) - Math.max(b.y, s.y));
    rec("layout: CANCEL band overlaps the movement thumb's zone", ox * oy === 0 ? "PASS" : "FAIL",
      `band ${Math.round(b.w)}x${Math.round(b.h)}@${Math.round(b.x)},${Math.round(b.y)} vs stickZone ${Math.round(s.w)}x${Math.round(s.h)}@${Math.round(s.x)},${Math.round(s.y)} → overlap ${Math.round(ox)}x${Math.round(oy)} = ${Math.round((ox * oy * 100) / (b.w * b.h))}% of the band`);
  }

  // ---------- SAFE AREAS: the author's 8 ids vs every fixed HUD box ----------
  {
    const res = await page.evaluate((safe) => {
      const check = (ids) => {
        const bad = [];
        for (const id of ids) {
          const e = document.getElementById(id); if (!e) continue;
          const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
          if (!r.width || cs.display === "none" || cs.visibility === "hidden") continue;
          if (safe.left && r.left < safe.left) bad.push(`${id} left ${Math.round(r.left)}<${safe.left}`);
          if (safe.right && innerWidth - r.right < safe.right) bad.push(`${id} right ${Math.round(innerWidth - r.right)}<${safe.right}`);
          if (safe.top && r.top < safe.top) bad.push(`${id} top ${Math.round(r.top)}<${safe.top}`);
          if (safe.bottom && innerHeight - r.bottom < safe.bottom) bad.push(`${id} bottom ${Math.round(innerHeight - r.bottom)}<${safe.bottom}`);
        }
        return bad;
      };
      const theirs = check(["minimap-frame", "cockpit", "t-stairs", "banner", "hud-tl", "hud-tr", "ticker", "xpbar"]);
      // EVERY fixed-position element with a box, not a chosen list
      const all = [...document.querySelectorAll("body > *")].filter((e) => {
        const cs = getComputedStyle(e);
        return cs.position === "fixed" && cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0" && e.getBoundingClientRect().width > 0 && e.id !== "game" && e.id !== "touch" && !/scrim|backdrop/.test(e.id);
      }).map((e) => e.id || e.className);
      const everything = check(all.filter(Boolean));
      return { theirs, all, everything };
    }, spec.safe);
    rec("safe areas: the harness's 8-id list", res.theirs.length === 0 ? "PASS" : "FAIL", res.theirs.join(" · ") || "clear");
    rec("safe areas: every visible fixed HUD box", res.everything.length === 0 ? "PASS" : "FAIL", `checked ${res.all.length} boxes → ${res.everything.join(" · ") || "clear"}`);
  }

  // ---------- AIMED CAST, detected by HITS not cooldowns ----------
  {
    const results = [];
    for (const k of ["0", "1", "2", "3", "4"]) {
      await keepAlive();
      await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const q of Object.keys(p.cd || {})) p.cd[q] = 0; p.dashCharges = 2; window.__fired = []; });
      const c = await page.evaluate((kk) => { const e = document.querySelector(`#skills .skill[data-i="${kk}"]`); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, k);
      const a = await page.evaluate(() => { const s = window.__dcc.state, p = s.players[0]; return { cd: JSON.parse(JSON.stringify(p.cd || {})), hp: s.monsters.reduce((t, m) => t + Math.max(0, m.hp), 0), proj: (s.projectiles || []).length, pos: { ...p.pos } }; });
      await touch.down(1, c.x, c.y);
      await settle(1);
      for (let i = 1; i <= 10; i++) { touch.tick(16); await touch.move(1, c.x, c.y - i * 10); await settle(1); }
      await touch.up(1);
      await settle(10);
      const b = await page.evaluate(() => { const s = window.__dcc.state, p = s.players[0]; return { cd: JSON.parse(JSON.stringify(p.cd || {})), hp: s.monsters.reduce((t, m) => t + Math.max(0, m.hp), 0), proj: (s.projectiles || []).length, pos: { ...p.pos } }; });
      const cdStarted = Object.keys(b.cd).filter((x) => (b.cd[x] || 0) > (a.cd[x] || 0));
      const dmg = Math.round(a.hp - b.hp);
      const moved = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
      const evidence = cdStarted.length || dmg > 0 || b.proj > a.proj || moved > 0.5;
      results.push(`slot${k}:${evidence ? "FIRED" : "SILENT"}(cd=${cdStarted.join("/") || "-"} dmg=${dmg} proj=${a.proj}->${b.proj} moved=${moved.toFixed(1)})`);
    }
    rec("aim: drag-release fires, all 5 slots (hits/projectiles/cd)", results.every((r) => r.includes("FIRED")) ? "PASS" : "FAIL", results.join(" · "));
  }

  // ---------- CAST WHILE MOVING: the second finger DRAGS (aimed) ----------
  {
    await keepAlive();
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; for (const q of Object.keys(p.cd || {})) p.cd[q] = 0; p.dashCharges = 2; });
    const c = await page.evaluate(() => { const e = document.querySelector(`#skills .skill[data-i="3"]`); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    const ox = Math.round(V.width * 0.2), oy = Math.round(V.height * 0.72);
    await touch.down(1, ox, oy);
    for (let i = 0; i < 6; i++) { touch.tick(16); await touch.move(1, ox + 70, oy); await settle(2); }
    const a = await page.evaluate(() => { const s = window.__dcc.state, p = s.players[0]; return { cd: JSON.parse(JSON.stringify(p.cd || {})), pos: { ...p.pos } }; });
    await touch.down(2, c.x, c.y);
    for (let i = 1; i <= 10; i++) { touch.tick(16); await touch.move(2, c.x, c.y - i * 10); await touch.move(1, ox + 70, oy); await settle(2); }
    const mid = await page.evaluate(() => ({ pos: { ...window.__dcc.state.players[0].pos } }));
    await touch.up(2);
    await settle(8);
    for (let i = 0; i < 6; i++) { touch.tick(16); await touch.move(1, ox + 70, oy); await settle(2); }
    const b = await page.evaluate(() => { const s = window.__dcc.state, p = s.players[0]; return { cd: JSON.parse(JSON.stringify(p.cd || {})), pos: { ...p.pos } }; });
    await touch.up(1);
    const duringAim = Math.hypot(mid.pos.x - a.pos.x, mid.pos.y - a.pos.y);
    const total = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
    const started = Object.keys(b.cd).filter((x) => (b.cd[x] || 0) > (a.cd[x] || 0));
    rec("multi-touch: WALK while the other thumb AIMS", duringAim > 0.4 && started.length ? "PASS" : "FAIL",
      `walked ${duringAim.toFixed(2)} tiles during the aim drag, ${total.toFixed(2)} total; aimed cast fired ${started.join(",") || "NONE"}`);
  }

  // ---------- AIM ROTATION CONSTANCY (measured off the indicator) ----------
  {
    const out = [];
    for (const [dx, dy] of [[1, 0], [0.707, -0.707], [0, -1], [-0.707, -0.707], [-1, 0], [-0.707, 0.707], [0, 1], [0.707, 0.707]]) {
      await keepAlive();
      const c = await page.evaluate(() => { const e = document.querySelector(`#skills .skill[data-i="2"]`); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
      await touch.down(1, c.x, c.y);
      for (let i = 1; i <= 10; i++) { touch.tick(16); await touch.move(1, c.x + dx * i * 9, c.y + dy * i * 9); await settle(1); }
      const rot = await page.evaluate(() => { const ind = window.__dcc.renderer.aimIndicator; return ind && ind.visible ? ind.rotation.y : null; });
      await touch.up(1);
      await settle(3);
      if (rot == null) { out.push("null"); continue; }
      const screenAng = Math.atan2(dy, dx);
      let d = ((-rot - screenAng) * 180) / Math.PI; while (d > 180) d -= 360; while (d < -180) d += 360;
      out.push(Math.round(d));
    }
    const nums = out.filter((n) => n !== "null");
    const spread = nums.length ? Math.max(...nums) - Math.min(...nums) : 999;
    rec("aim: screen→world rotation constant over 8 drag directions", spread <= 10 ? "PASS" : "FAIL", `deltas ${out.join(",")}° spread ${spread}°`);
  }

  // ---------- INDICATOR TRUTHFULNESS ----------
  {
    const t = await page.evaluate(() => {
      const r = window.__dcc.renderer, ind = r.aimIndicator;
      if (!ind) return null;
      const sizes = {};
      ind.traverse((o) => {
        if (!o.geometry) return;
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        sizes[o.name || o.parent.name || o.type] = { w: +(bb.max.x - bb.min.x).toFixed(2), h: +(bb.max.y - bb.min.y).toFixed(2), params: o.geometry.parameters ? JSON.parse(JSON.stringify(o.geometry.parameters)) : null };
      });
      let mat = null; ind.traverse((o) => { if (!mat && o.material) mat = o.material; });
      return { children: ind.children.map((c) => c.name), sizes, mat: mat ? { color: "#" + mat.color.getHexString(), opacity: mat.opacity, depthTest: mat.depthTest, depthWrite: mat.depthWrite } : null };
    });
    rec("indicator: geometry comes from the ability", "INFO", JSON.stringify(t));
  }

  // ---------- WALK COVERAGE: does the whole left side drive the stick? ----------
  {
    const grid = [];
    for (const fx of [0.08, 0.18, 0.3, 0.42]) {
      for (const fy of [0.3, 0.5, 0.7, 0.9]) {
        await keepAlive();
        const px = Math.round(V.width * fx), py = Math.round(V.height * fy);
        const rt = await page.evaluate(([a, b]) => { const t = window.__dcc.touch; return t.route ? t.route(a, b) : null; }, [px, py]);
        const a = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
        await touch.down(1, px, py);
        for (let i = 0; i < 8; i++) { touch.tick(16); await touch.move(1, px + 60, py); await settle(2); }
        const b = await page.evaluate(() => ({ ...window.__dcc.state.players[0].pos }));
        await touch.up(1);
        await settle(2);
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        grid.push(`${fx},${fy}:${d > 0.3 ? "MOVE" : "DEAD"}(${d.toFixed(1)},${rt && rt.zone})`);
      }
    }
    const dead = grid.filter((g) => g.includes("DEAD"));
    rec("walk: every point of the left half drives the stick", dead.length === 0 ? "PASS" : "FAIL", `${dead.length}/16 dead — ${grid.join(" ")}`);
  }

  // ---------- FLASK ----------
  {
    await page.evaluate(() => { clearInterval(window.__keep); const p = window.__dcc.state.players[0]; p.alive = true; p.downedT = 0; p.hp = Math.max(1, Math.round(p.maxHp * 0.3)); p.flaskCharges = 3; });
    const c = await page.evaluate(() => { const e = document.getElementById("flask-chip"); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }; });
    const a = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { hp: Math.round(p.hp), f: p.flaskCharges }; });
    await touch.tap(c.x, c.y, 1, 160);
    await settle(12);
    const b = await page.evaluate(() => { const p = window.__dcc.state.players[0]; return { hp: Math.round(p.hp), f: p.flaskCharges }; });
    rec("potion: flask chip", b.f < a.f || b.hp > a.hp ? "PASS" : "FAIL", `chip ${c.w}x${c.h}@(${c.x},${c.y}); charges ${a.f}->${b.f}, hp ${a.hp}->${b.hp}`);
    await page.evaluate(() => { window.__keep = setInterval(() => { const s = window.__dcc && window.__dcc.state; if (!s) return; const p = s.players[0]; p.hp = p.maxHp; p.alive = true; p.downedT = 0; if (!s.safeRoom) s.status = "playing"; }, 120); });
  }

  // ---------- PANELS: is anything off-screen actually reachable? ----------
  {
    for (const [id, key] of [["abil", "t"], ["keys", "k"]]) {
      let up = false;
      for (let i = 0; i < 3 && !up; i++) { await keepAlive(); await page.keyboard.press(key); await page.waitForTimeout(650); up = await page.evaluate((p) => { const e = document.getElementById(p); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; }, id); }
      if (!up) { rec(`panel ${id}: scroll reachability`, "FAIL", "never opened"); continue; }
      const g = await page.evaluate((pid) => {
        const p = document.getElementById(pid);
        const shown = (e) => { const cs = getComputedStyle(e); return cs.display !== "none" && cs.visibility !== "hidden" && e.getBoundingClientRect().width > 0; };
        const inter = [...p.querySelectorAll("button, .tab, [data-act], .acard, .row, input, select")].filter(shown);
        const off = inter.filter((e) => { const r = e.getBoundingClientRect(); return r.top > innerHeight || r.bottom < 0; });
        const scrollable = (e) => { let n = e.parentElement; while (n && n !== document.body) { const cs = getComputedStyle(n); if ((n.scrollHeight - n.clientHeight > 8) && /auto|scroll/.test(cs.overflowY)) return n.id || n.className; n = n.parentElement; } return null; };
        return { n: inter.length, off: off.length, offScrollable: off.map(scrollable).filter(Boolean).length, sample: off.slice(0, 3).map((e) => (e.textContent || "").trim().slice(0, 24)) };
      }, id);
      rec(`panel ${id}: off-screen controls are scroll-reachable`, g.off === 0 || g.off === g.offScrollable ? "PASS" : "FAIL",
        `${g.n} interactive, ${g.off} off-screen, ${g.offScrollable} of those inside a scrollable ancestor; e.g. ${JSON.stringify(g.sample)}`);
      await page.keyboard.press(key); await page.waitForTimeout(400);
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
