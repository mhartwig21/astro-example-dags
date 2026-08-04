// Round-1 fix verification: blockers 1-4, majors 1-6, and the control skin.
// Real CDP touch only. ONE browser. Evidence under tools/_mobile/wr-fix1/.
// r2 of this probe: menus are checked BEFORE any combat (r1 aggroed the floor
// boss and its plate covered the topbar — a staging artifact that read as a
// product FAIL), lock staging verifies the monster HELD its staged spot on
// clear ground, and the cooldown-numeral check picks a slot with a real
// cooldown off live state instead of assuming slot order.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const BASE = "http://localhost:5286";
const OUT = "tools/_mobile/wr-fix1";
mkdirSync(OUT, { recursive: true });
const SPECS = {
  "iphone13-land": { pw: "iPhone 13 landscape", safe: "0,47,21,47" },
  "ipadpro11-land": { pw: "iPad Pro 11 landscape", safe: "24,0,20,0" },
  "pixel5-land": { pw: "Pixel 5 landscape", safe: "0,24,24,0" },
};
const results = [];
const rec = (d, n, v, det) => {
  results.push({ device: d, check: n, verdict: v, detail: det });
  console.log(`[${v}] ${d} :: ${n} — ${det}`);
};

function touchDriver(client) {
  const live = new Map();
  const points = () => [...live.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 1 }));
  let clock = Date.now() / 1000;
  const send = (type) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points(), timestamp: clock });
  return {
    tick(ms) { clock += ms / 1000; return this; },
    async down(id, x, y) { live.set(id, { x, y }); await send("touchStart"); },
    async move(id, x, y) { if (!live.has(id)) return; live.set(id, { x, y }); await send("touchMove"); },
    async up(id) {
      const p = live.get(id); live.delete(id);
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd",
        touchPoints: p ? [{ x: p.x, y: p.y, id, radiusX: 12, radiusY: 12, force: 0 }] : [], timestamp: clock });
    },
    async tap(x, y, id = 1, holdMs = 90) {
      await this.down(id, x, y); this.tick(holdMs);
      await new Promise((r) => setTimeout(r, Math.min(holdMs, 50)));
      await this.up(id);
    },
    async drag(x, y, tx, ty, opts = {}) {
      const { id = 1, steps = 10, holdMs = 24, lift = true, settle = false } = opts;
      await this.down(id, x, y);
      for (let i = 1; i <= steps; i++) {
        this.tick(holdMs);
        await this.move(id, x + ((tx - x) * i) / steps, y + ((ty - y) * i) / steps);
        await new Promise((r) => setTimeout(r, holdMs));
      }
      if (settle) {
        // A finger that stops before lifting starts no fling — without this
        // the release velocity opens a momentum scroll and Chrome consumes
        // the NEXT tap as fling-stop, which read as "taps stopped working".
        this.tick(220);
        await this.move(id, tx, ty);
        await new Promise((r) => setTimeout(r, 200));
      }
      if (lift) await this.up(id);
    },
  };
}

async function ready(page) {
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0;
  }, null, { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const box = await page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return null;
    const r = l.getBoundingClientRect();
    return getComputedStyle(l).display !== "none" && r.width > 0 ? { w: r.width, h: r.height } : null;
  });
  if (box) throw new Error("loading still has a box");
}

// STRICT: only the element itself or a descendant counts. `at.contains(e)`
// certified a row that sat BELOW its clipped panel (the ancestor overlay was
// under the point) — the exact class of lie a previous round shipped.
const hit = async (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return { ok: false, why: "missing" };
  const r = e.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const at = document.elementFromPoint(cx, cy);
  return { ok: !!at && (at === e || e.contains(at)),
    w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(cx), cy: Math.round(cy),
    at: at ? `${at.tagName}#${at.id}.${[...at.classList].join(".")}` : "none",
    on: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight };
}, sel);

const browser = await chromium.launch({ headless: true });
try {
  for (const device of Object.keys(SPECS)) {
    const ctx = await browser.newContext({ ...devices[SPECS[device].pw] });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => rec(device, "pageerror", "FAIL", e.message.slice(0, 160)));
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=2&level=5&seed=9&safe=${SPECS[device].safe}`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);

    // ---------- SKIN: combat frame (dark floor), BEFORE any interaction -----
    await page.screenshot({ path: `${OUT}/${device}-skin-dark.png` });
    const tiers = await page.evaluate(() => {
      const g = (s) => { const e = document.querySelector(s); if (!e) return null;
        const r = e.getBoundingClientRect(); return Math.round(r.width); };
      return { slot0: g('#skills .skill[data-i="0"]'), slot1: g('#skills .skill[data-i="1"]'),
        ult: g('#skills .skill[data-i="4"]'), flask: g("#flask-chip"),
        lock: g("#t-lock"), map: g("#t-map") };
    });
    const tierOk = tiers.ult > tiers.slot1 && tiers.slot0 > tiers.slot1 &&
      tiers.lock < tiers.slot1 && tiers.map < tiers.slot1;
    rec(device, "skin: three size tiers", tierOk ? "PASS" : "FAIL", JSON.stringify(tiers));

    const lockDiag = await page.evaluate(() => {
      const e = document.getElementById("t-lock");
      const r = e.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return { ret: !!e.querySelector(".tl-ret"), word: e.textContent.trim(),
        ctl: window.__dcc.touch.controlAt(cx, cy), cx: Math.round(cx), cy: Math.round(cy) };
    });
    rec(device, "skin: LOCK is an icon and cache agrees",
      lockDiag.ret && lockDiag.word === "" && lockDiag.ctl === "lock" ? "PASS" : "FAIL",
      JSON.stringify(lockDiag));

    // ---------- BLOCKER 2: dropdown taps must not leak (no combat yet) ------
    const tapBefore = await page.evaluate(() => JSON.stringify(window.__dcc.touch.lastWorldTap));
    const tb = await hit(page, "#tb-system");
    await touch.tap(tb.cx, tb.cy, 1, 110);
    await page.waitForTimeout(500);
    const row = await page.evaluate(() => {
      const r = [...document.querySelectorAll("#tm-system .tm-row")].find((x) => x.dataset.act === "keybinds");
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return b.width > 0 ? { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) } : null;
    });
    if (!row) rec(device, "blocker2: menu opened by touch", "FAIL", JSON.stringify(tb));
    else {
      await touch.tap(row.cx, row.cy, 1, 110);
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => ({
        tap: JSON.stringify(window.__dcc.touch.lastWorldTap),
        panelOpen: getComputedStyle(document.getElementById("keys")).display !== "none",
      }));
      rec(device, "blocker2: menu tap opens panel, no world tap",
        after.panelOpen && after.tap === tapBefore ? "PASS" : "FAIL",
        `panel=${after.panelOpen} tapBefore=${tapBefore} after=${after.tap} row=${JSON.stringify(row)}`);

      // ---------- M3: OPTIONS perf row reachable by touch scroll ------------
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll(".kb-tabs button")].map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.textContent.trim(), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
        }));
      const opts = tabs.find((t) => t.label.includes("OPTIONS"));
      if (opts) {
        await touch.tap(opts.cx, opts.cy);
        await page.waitForTimeout(400);
        let pm = await hit(page, "#kb-perfmode");
        for (let i = 0; i < 6 && !(pm.on && pm.ok); i++) {
          // Drag INSIDE the viewport: on touch the panel is a single scrolling
          // document, and a drag origin computed off the (huge) page box can
          // land below the glass, where it scrolls nothing (r1 artifact).
          const mid = await page.evaluate(() => {
            const p = document.querySelector("#keys .panel");
            const r = p.getBoundingClientRect();
            return { cx: Math.round(r.x + r.width / 2),
              cy: Math.round(Math.min(r.y + r.height - 30, innerHeight - 40)) };
          });
          await touch.drag(mid.cx, mid.cy, mid.cx, Math.max(70, mid.cy - 160), { steps: 8, holdMs: 24, settle: true });
          await page.waitForTimeout(300);
          pm = await hit(page, "#kb-perfmode");
        }
        rec(device, "major3: perf row reachable by touch", pm.on && pm.ok ? "PASS" : "FAIL", JSON.stringify(pm));
        if (pm.on && pm.ok) {
          const before = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
          await touch.tap(pm.cx, pm.cy);
          await page.waitForTimeout(400);
          let afterTxt = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
          let cycleRetried = false;
          if (afterTxt === before) {
            cycleRetried = true;
            await touch.tap(pm.cx, pm.cy);
            await page.waitForTimeout(400);
            afterTxt = await page.evaluate(() => document.getElementById("kb-perfmode").textContent);
          }
          rec(device, "major3: perf row cycles on tap", afterTxt !== before ? (cycleRetried ? "WARN" : "PASS") : "FAIL", `${before} -> ${afterTxt} retried=${cycleRetried}`);
        }
      }
      // ---------- M4: CONTROLS rows are .kb-row + peek + persistence --------
      // Re-measure the tab AFTER resetting the panel scroll: on phones the
      // panel is one scrolling document and the OPTIONS drags moved the tab
      // row — the r5 taps landed on whatever had scrolled under the stale
      // coordinates.
      const ctl = await page.evaluate(() => {
        const panel = document.querySelector("#keys .panel");
        if (panel) panel.scrollTop = 0;
        const b = [...document.querySelectorAll(".kb-tabs button")].find((x) => x.textContent.includes("CONTROLS"));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
      });
      if (ctl) {
        await page.waitForTimeout(250);
        await touch.tap(ctl.cx, ctl.cy);
        await page.waitForTimeout(400);
        const ctlOn = await page.evaluate(() => document.getElementById("kb-page-controls").classList.contains("on"));
        if (!ctlOn) { await touch.tap(ctl.cx, ctl.cy); await page.waitForTimeout(400); }
        const rows = await page.evaluate(() => ({
          kbRows: document.querySelectorAll("#kb-page-controls .kb-row").length,
          steps: document.querySelectorAll("#kb-page-controls .ctl-step button").length,
        }));
        rec(device, "major4: CONTROLS rows measurable as .kb-row",
          rows.kbRows >= 12 ? "PASS" : "FAIL", JSON.stringify(rows));
        // ensureVisible: scrollIntoView, then verify the rect is really on the
        // glass and hit-testable; nudge the panel scroller if not.
        const ensureVisible = async (sel) => page.evaluate(async (s) => {
          const b = document.querySelector(s);
          if (!b) return null;
          b.scrollIntoView({ block: "center" });
          await new Promise((r2) => setTimeout(r2, 200));
          let r = b.getBoundingClientRect();
          if (r.y < 60 || r.y + r.height > innerHeight - 10) {
            const p = document.querySelector("#keys .panel");
            p.scrollTop += (r.y + r.height / 2) - innerHeight / 2;
            await new Promise((r2) => setTimeout(r2, 200));
            r = b.getBoundingClientRect();
          }
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
            ok: !!at && (at === b || b.contains(at)) };
        }, sel);
        const step = await ensureVisible('#kb-page-controls [data-tp="stickScale"][data-dir="1"]');
        if (step && step.ok) {
          await touch.down(3, step.cx, step.cy);
          // SwiftShader renders the iPad backbuffer at ~1fps; poll the veil
          // rather than trusting a wall-clock wait to contain a frame.
          const peek = await page.evaluate(async () => {
            const t0 = performance.now();
            let veil = 1;
            while (performance.now() - t0 < 3000) {
              veil = +getComputedStyle(document.querySelector("#keys .panel")).opacity;
              if (veil < 0.35) break;
              await new Promise((r2) => setTimeout(r2, 120));
            }
            return { peek: document.body.classList.contains("peek"), veil };
          });
          await touch.up(3);
          await page.waitForTimeout(500);
          const off = await page.evaluate(() => document.body.classList.contains("peek"));
          rec(device, "major4: stepper hold = live preview veil",
            peek.peek && peek.veil < 0.35 && !off ? "PASS" : "FAIL", JSON.stringify({ ...peek, off }));
        } else rec(device, "major4: stepper hold = live preview veil", "FAIL", `stepper unreachable ${JSON.stringify(step)}`);
        const flipBtn = await ensureVisible('#kb-page-controls [data-tp="handed"][data-set="LEFT"]');
        if (flipBtn && flipBtn.ok) {
          await touch.tap(flipBtn.cx, flipBtn.cy);
          await page.waitForTimeout(500);
          const flip = await page.evaluate(() => ({
            left: document.body.classList.contains("handed-left"),
            store: Object.keys(localStorage).some((k) => /touch/i.test(k) && /left/.test(localStorage.getItem(k) ?? "")),
          }));
          rec(device, "major4: handedness flips + persists", flip.left && flip.store ? "PASS" : "FAIL", JSON.stringify(flip));
          const back = await ensureVisible('#kb-page-controls [data-tp="handed"][data-set="RIGHT"]');
          if (back && back.ok) { await touch.tap(back.cx, back.cy); await page.waitForTimeout(400); }
        } else rec(device, "major4: handedness flips + persists", "FAIL", `flip unreachable ${JSON.stringify(flipBtn)}`);
      }
      const x = await hit(page, "#keys .tp-x");
      if (x.ok) { await touch.tap(x.cx, x.cy); await page.waitForTimeout(400); }
      else await page.keyboard.press("Escape");
    }

    // ---------- M2: the ledger closes by touch (still no combat) ------------
    const tbc = await hit(page, "#tb-crawler");
    await touch.tap(tbc.cx, tbc.cy, 1, 110);
    await page.waitForTimeout(500);
    const lrow = await page.evaluate(async () => {
      const r = [...document.querySelectorAll("#tm-crawler .tm-row")].find((x) => x.dataset.act === "ledger");
      if (!r) return null;
      r.scrollIntoView({ block: "center" });
      await new Promise((res) => setTimeout(res, 200));
      const b = r.getBoundingClientRect();
      if (!(b.width > 0)) return null;
      return { cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
    });
    if (lrow) {
      await touch.tap(lrow.cx, lrow.cy, 1, 110);
      await page.waitForTimeout(700);
      const open = await page.evaluate(() => getComputedStyle(document.getElementById("ledger")).display !== "none");
      const lx = await hit(page, "#ledger .tp-x");
      const ldone = await hit(page, "#ledger .tp-done");
      if (open && lx.ok) {
        await touch.tap(lx.cx, lx.cy);
        await page.waitForTimeout(700);
        let closed = await page.evaluate(() => getComputedStyle(document.getElementById("ledger")).display === "none");
        let retried = false;
        if (!closed) {
          retried = true;
          const lx2 = await hit(page, "#ledger .tp-x");
          if (lx2.ok) { await touch.tap(lx2.cx, lx2.cy); await page.waitForTimeout(700); }
          closed = await page.evaluate(() => getComputedStyle(document.getElementById("ledger")).display === "none");
        }
        rec(device, "major2: ledger opens and ✕ closes by touch",
          closed ? (retried ? "WARN" : "PASS") : "FAIL", JSON.stringify({ open, lx, ldone: ldone.ok, retried }));
      } else {
        rec(device, "major2: ledger touch closers", "FAIL", JSON.stringify({ open, lx, ldone }));
      }
    } else rec(device, "major2: crawler menu ledger row", "FAIL", JSON.stringify(tbc));

    // ---------- BLOCKER 3: tap-to-lock, staged NEXT TO the crawler ----------
    // r1 staged onto screenToGround points that turned out to be inside walls;
    // the sim's separation slid the monster 60-260px between projection and
    // poll. Parking it beside the crawler (ground the crawler stands on)
    // stays put, and projects into the keepout-adjacent world where no chip
    // can be (the crawler keepout bans chips from mid-screen).
    const diag = await page.evaluate(async () => {
      const d = window.__dcc, s = d.state, r = d.renderer;
      const p = s.players[0];
      p.hp = p.maxHp;
      for (const m of s.monsters) {
        m.speed = 0;
        m.windup = 0; m.attackCooldown = 999; m.shootCd = 999; m.blinkCd = 999;
      }
      const m = s.monsters.find((mm) => mm.hp > 0 && !mm.dormant);
      if (!m) return null;
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      for (const [dx, dy] of [[-2.5, -1.5], [-3, 0], [0, -3], [-2, 2], [-1.5, -1.5], [2, -2]]) {
        m.pos.x = p.pos.x + dx; m.pos.y = p.pos.y + dy;
        // stability across RENDERED frames — SwiftShader can run ~1fps on the
        // iPad backbuffer, so wall-clock waits can straddle zero frames.
        const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        await frame();
        const p0 = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
        await frame();
        const p1 = r.worldToScreen(m.pos.x, 0.8, m.pos.y);
        if (!p1.visible || !p0.visible) continue;
        // The sim's own separation slides a monster parked inside a wall or a
        // pack-mate; a moving stage point makes the check measure the harness.
        if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > 10) continue;
        if (d.touch.controlAt(p1.x, p1.y)) continue;
        const e = document.elementFromPoint(p1.x, p1.y);
        if (e && e.closest("#skills, #t-layer, #hud-chips, #banner")) continue;
        return { mob: m.id, x: Math.round(p1.x), y: Math.round(p1.y) };
      }
      return null;
    });
    if (!diag) rec(device, "blocker3: stage", "FAIL", "no stable clear point");
    else {
      // Up to 4 attempts, each re-aimed at the LIVE projection. Forensics
      // (wrfix1h): with monster AND crawler world-static and clickMove null,
      // the projection still sweeps +-40px over seconds — slow camera motion
      // that a 60fps device crosses in ~1px between dispatch and poll, but
      // SwiftShader's ~1fps polling spans a whole second of. Re-aiming per
      // attempt is what a human eye does continuously.
      let v = null, tries = 0;
      for (; tries < 4; tries++) {
        const at = await page.evaluate((mob) => {
          const d = window.__dcc;
          const m = d.state.monsters.find((mm) => mm.id === mob);
          if (!m || m.hp <= 0) return null;
          const p = d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y);
          return { x: Math.round(p.x), y: Math.round(p.y) };
        }, diag.mob);
        if (!at) break;
        await touch.tap(at.x, at.y, 1, 90);
        await page.waitForTimeout(500);
        v = await page.evaluate((mob) => {
          const d = window.__dcc;
          const m = d.state.monsters.find((mm) => mm.id === mob);
          const p = m ? d.renderer.worldToScreen(m.pos.x, 0.8, m.pos.y) : null;
          return { locked: d.touch.lockedTargetId, tap: !!d.touch.lastWorldTap,
            mobNow: p ? { x: Math.round(p.x), y: Math.round(p.y) } : null };
        }, diag.mob);
        if (v.locked === diag.mob) break;
      }
      rec(device, "blocker3: tap locks the staged monster",
        v && v.locked === diag.mob ? (tries > 0 ? "WARN" : "PASS") : "FAIL",
        JSON.stringify({ ...v, diag, retapsUnderCameraSway: tries }));
    }

    // ---------- skin: cooldown numeral, on a slot with a REAL cooldown ------
    const cdSlot = await page.evaluate(() => {
      const p = window.__dcc.state.players[0];
      const want = ["nova", "bolt", "orbit", "crowdsurf", "airstrike", "cutto"];
      for (const a of want) {
        const i = p.abilities.slots.indexOf(a);
        if (i >= 0) return { i, a };
      }
      return null;
    });
    if (!cdSlot) rec(device, "skin: cooldown numeral", "FAIL", "no cd ability in slots");
    else {
      // AIMED cast (drag past the slop, release): a smart-cast tap can refuse
      // without a target; an aimed cast always commits and starts the clock.
      await page.evaluate(() => window.__dcc.touch.clearVerdicts());
      const chip = await hit(page, `#skills .skill[data-i="${cdSlot.i}"]`);
      await touch.drag(chip.cx, chip.cy, chip.cx - 110, chip.cy - 50, { steps: 8, holdMs: 28 });
      await page.waitForTimeout(600);
      const cdnum = await page.evaluate((i) => {
        const c = document.querySelector(`#skills .skill[data-i="${i}"] .cdnum`);
        if (!c) return { has: false };
        const cs = getComputedStyle(c);
        return { has: true, text: c.textContent, shown: cs.display !== "none" };
      }, cdSlot.i);
      const verd = await page.evaluate(() => window.__dcc.touch.verdicts());
      rec(device, "skin: cooldown numeral after a cast",
        cdnum.has && cdnum.text && cdnum.shown ? "PASS" : "FAIL",
        JSON.stringify({ ...cdnum, ...cdSlot, verdicts: verd.slice(-3) }));
    }

    // ---------- skin: aim hold — range ring + telegraph ---------------------
    const aimSlot = await page.evaluate(() => {
      const p = window.__dcc.state.players[0];
      for (const a of ["bolt", "nova", "crowdsurf", "orbit"]) {
        const i = p.abilities.slots.indexOf(a);
        if (i >= 0) return { i, a };
      }
      return { i: 4, a: "ult" };
    });
    const achip = await hit(page, `#skills .skill[data-i="${aimSlot.i}"]`);
    await touch.drag(achip.cx, achip.cy, achip.cx - 120, achip.cy - 60, { steps: 8, holdMs: 30, lift: false });
    await page.waitForTimeout(500);
    const aim = await page.evaluate(() => {
      const s = window.__dcc.renderer.scene;
      let range = null, ind = null;
      (s?.children ?? []).forEach((c) => {
        if (c.name === "aimRange") range = { visible: c.visible, children: c.children.length };
        if (c.name === "aimIndicator") ind = { visible: c.visible, children: c.children.length };
      });
      return { range, ind };
    });
    await page.screenshot({ path: `${OUT}/${device}-aim-hold.png` });
    rec(device, "skin: max-range ring live during aim",
      aim.range?.visible && aim.ind?.visible ? "PASS" : "FAIL", JSON.stringify({ ...aim, ...aimSlot }));
    await touch.up(1);
    await page.waitForTimeout(400);
    const aimOff = await page.evaluate(() => {
      const s = window.__dcc.renderer.scene;
      const g = s?.children.find((c) => c.name === "aimRange");
      return g ? g.visible : "absent";
    });
    rec(device, "skin: range ring clears on lift", aimOff !== true ? "PASS" : "FAIL", String(aimOff));

    // ---------- M1: READY button size (gate staged for CSS truth) -----------
    const readyBox = await page.evaluate(() => {
      const gate = document.getElementById("rushgate");
      gate.classList.add("on");
      const b = document.getElementById("rushgate-ready").getBoundingClientRect();
      gate.classList.remove("on");
      return { w: Math.round(b.width), h: Math.round(b.height) };
    });
    rec(device, "major1: READY >= 44px", readyBox.h >= 44 && readyBox.w >= 44 ? "PASS" : "FAIL",
      JSON.stringify(readyBox));

    // ---------- M5: bosscall top on short screens ----------------------------
    const bc = await page.evaluate(() => {
      const e = document.getElementById("bosscall");
      if (!e) return null;
      const top = parseFloat(getComputedStyle(e).top);
      return { top: Math.round(top), vh: innerHeight, frac: +(top / innerHeight).toFixed(2) };
    });
    rec(device, "major5: bosscall pinned above 40% of glass",
      bc && bc.frac <= 0.4 ? "PASS" : "FAIL", JSON.stringify(bc));

    await ctx.close();
  }

  // ---------- SKIN over the GARDEN (bright band) — iPhone 13 -----------------
  {
    const ctx = await browser.newContext({ ...devices[SPECS["iphone13-land"].pw] });
    const page = await ctx.newPage();
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?test&debug=1&quality=performance&floor=8&level=10&seed=12&safe=${SPECS["iphone13-land"].safe}`,
      { waitUntil: "load", timeout: 120000 });
    await ready(page);
    await page.screenshot({ path: `${OUT}/iphone13-land-skin-garden.png` });
    const z = await page.evaluate(() => window.__dcc.touch.zones.stickAnchor);
    await touch.drag(z.x, z.y, z.x + 40, z.y - 25, { steps: 6, holdMs: 30, lift: false });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/iphone13-land-stick-garden.png` });
    await touch.up(1);
    const u = await hit(page, '#skills .skill[data-i="4"]');
    await touch.drag(u.cx, u.cy, u.cx - 130, u.cy - 40, { steps: 8, holdMs: 30, lift: false });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/iphone13-land-aim-ult-garden.png` });
    await touch.up(1);
    await ctx.close();
  }

  // ---------- BLOCKER 1 + M6: recap rail + sharesheet on the phone -----------
  {
    const ctx = await browser.newContext({ ...devices[SPECS["iphone13-land"].pw] });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => rec("iphone13-land", "recap pageerror", "FAIL", e.message.slice(0, 160)));
    const client = await ctx.newCDPSession(page);
    const touch = touchDriver(client);
    await page.goto(`${BASE}/iso.html?test&debug=1&noassets&quality=performance&floor=6&level=3&gear=0&seed=41&safe=${SPECS["iphone13-land"].safe}`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);
    await page.evaluate(() => {
      const s = window.__dcc.state, p = s.players[0];
      const live = s.monsters.filter((m) => !m.dormant && m.hp > 0);
      if (live.length) { p.pos.x = live[0].pos.x + 0.3; p.pos.y = live[0].pos.y + 0.3; }
      p.hp = 1;
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("recap")).display === "flex", null, { timeout: 90000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/iphone13-land-recap.png` });
    const rail = await page.evaluate(() => {
      const main = document.querySelector("#recap .rfoot.rmain");
      const more = document.querySelector("#recap .rfoot.rmore");
      const mb = main.getBoundingClientRect();
      const cs = getComputedStyle(main);
      const again = document.getElementById("recap-again").getBoundingClientRect();
      return { mainH: Math.round(mb.height), sticky: cs.position === "sticky",
        moreDisplay: getComputedStyle(more).display,
        againOn: again.y > 0 && again.y + again.height <= innerHeight,
        againH: Math.round(again.height) };
    });
    rec("iphone13-land", "major6: pinned rail is one row + note",
      rail.sticky && rail.mainH <= 130 && rail.againOn && rail.againH >= 44 ? "PASS" : "FAIL",
      JSON.stringify(rail));
    // the flow rail must not paint over the ledger line once scrolled to it
    const overlapProbe = await page.evaluate(() => {
      document.getElementById("recap-earned").scrollIntoView({ block: "center" });
      return new Promise((res) => setTimeout(() => {
        const e = document.getElementById("recap-earned").getBoundingClientRect();
        const at = document.elementFromPoint(e.x + e.width / 2, e.y + e.height / 2);
        res({ y: Math.round(e.y), at: at ? `${at.tagName}#${at.id}` : "none",
          visible: e.y > 0 && e.y < innerHeight });
      }, 300));
    });
    rec("iphone13-land", "major6: ledger line scrolls clear of the rail",
      overlapProbe.visible && /recap-earned|BUTTON/.test(overlapProbe.at) ? "PASS" : "FAIL",
      JSON.stringify(overlapProbe));
    let share = await hit(page, "#recap-share");
    if (!(share.on && share.ok)) {
      await page.evaluate(() => document.getElementById("recap-share").scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      share = await hit(page, "#recap-share");
    }
    rec("iphone13-land", "blocker1: SHARE reachable + hit-tested", share.on && share.ok ? "PASS" : "FAIL", JSON.stringify(share));
    await touch.tap(share.cx, share.cy, 1, 100);
    await page.waitForTimeout(900);
    const sheetOn = await page.evaluate(() => document.getElementById("sharesheet").classList.contains("on"));
    if (!sheetOn) rec("iphone13-land", "blocker1: sharesheet opens", "FAIL", "no .on");
    else {
      await page.screenshot({ path: `${OUT}/iphone13-land-sharesheet.png` });
      const btns = {};
      for (const id of ["share-card", "share-copy", "share-save", "share-close"]) btns[id] = await hit(page, `#${id}`);
      const allOn = Object.values(btns).every((b) => b.on && b.ok && b.h >= 44);
      rec("iphone13-land", "blocker1: all sheet actions on-glass, hit-tested, >=44",
        allOn ? "PASS" : "FAIL", JSON.stringify(btns));
      const sx = await hit(page, "#sharesheet .tp-x");
      rec("iphone13-land", "blocker1: sheet has a touch ✕", sx.ok ? "PASS" : "FAIL", JSON.stringify(sx));
      await touch.tap(btns["share-copy"].cx, btns["share-copy"].cy, 1, 90);
      await page.waitForTimeout(500);
      const copyTxt = await page.evaluate(() => document.getElementById("share-copy").textContent);
      rec("iphone13-land", "blocker1: COPY acknowledges", /COPIED|FAILED/.test(copyTxt) ? "PASS" : "FAIL", copyTxt);
      // Backdrop: on a 342px phone the card fills most of the glass, so FIND
      // a point that really is the backdrop before tapping it.
      const back = await page.evaluate(() => {
        const root = document.getElementById("sharesheet");
        for (const [x, y] of [[innerWidth / 2, 5], [5, innerHeight / 2], [innerWidth - 5, innerHeight / 2], [innerWidth / 2, innerHeight - 4]]) {
          if (document.elementFromPoint(x, y) === root) return { x: Math.round(x), y: Math.round(y) };
        }
        return null;
      });
      if (!back) rec("iphone13-land", "blocker1: backdrop tap closes", "INFO", "no exposed backdrop on this viewport; ✕/CLOSE/swipe are the closers");
      else {
        await touch.tap(back.x, back.y, 1, 90);
        await page.waitForTimeout(500);
        const stillOn = await page.evaluate(() => document.getElementById("sharesheet").classList.contains("on"));
        rec("iphone13-land", "blocker1: backdrop tap closes", !stillOn ? "PASS" : "FAIL", `at=${JSON.stringify(back)} on=${stillOn}`);
      }
    }
    await ctx.close();
  }

  // ---------- BLOCKER 4: the RUSH tile on Pixel 5 -----------------------------
  {
    const ctx = await browser.newContext({ ...devices[SPECS["pixel5-land"].pw] });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/iso.html?debug=1&noassets&quality=performance&safe=${SPECS["pixel5-land"].safe}`,
      { waitUntil: "load", timeout: 90000 });
    await ready(page);
    await page.waitForTimeout(1500);
    const rush = await hit(page, "#m-rush");
    await page.screenshot({ path: `${OUT}/pixel5-land-menu.png` });
    rec("pixel5-land", "blocker4: RUSH tile fully hit-tested on compact",
      rush.ok && rush.on ? "PASS" : "FAIL", JSON.stringify(rush));
    const foot = await page.evaluate(() => {
      const f = document.querySelector("#menu .m-foot");
      return f ? getComputedStyle(f).display : "absent";
    });
    rec("pixel5-land", "blocker4: footer stands down on compact", foot === "none" ? "PASS" : "FAIL", foot);
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.verdict === "FAIL");
console.log(`\n${results.length} checks, ${fails.length} FAIL`);
