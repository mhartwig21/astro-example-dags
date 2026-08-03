// trk-screens r3 verification capture. ONE viewport per invocation (machine
// limit: at most one Chromium alive at a time).
// usage: node tools/_ad_r3.mjs 1366 768
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const W = Number(process.argv[2] || 1366), H = Number(process.argv[3] || 768);
const TAG = `${W}x${H}`;
const OUT = "shots/acc-r3";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });

const report = [];
const log = (k, v) => { report.push(`[${TAG}] ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); console.log(report.at(-1)); };

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240000);
  page.on("pageerror", (e) => console.error(`PAGE ERROR [${TAG}]:`, e.message));
  const cdp = await page.context().newCDPSession(page);
  const shot = async (n) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${n}-${TAG}.png`, Buffer.from(data, "base64"));
  };
  const settled = async (label) => {
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => log(label + " settleflag", "TIMEOUT"));
    await page.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 200000 }).catch(() => log(label + " loadinggone", "TIMEOUT"));
    await page.waitForTimeout(3200);
    const b = await page.evaluate(() => {
      const l = document.getElementById("loading"); if (!l) return null;
      const cs = getComputedStyle(l);
      if (cs.display === "none" || Number(cs.opacity) === 0) return null;
      const r = l.getBoundingClientRect(); return { w: r.width, h: r.height };
    });
    if (b) throw new Error(`ASSERT ${label}: #loading still boxed ${JSON.stringify(b)}`);
  };

  const fit = async (sel, name) => {
    const m = await page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return { err: "no element" };
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return { err: "hidden", display: cs.display };
      const p = e.querySelector(".panel") || e;
      const pr = p.getBoundingClientRect();
      const scrollers = [];
      for (const el of [e, ...e.querySelectorAll("*")]) {
        const o = el.scrollHeight - el.clientHeight;
        const ecs = getComputedStyle(el);
        if (o > 2 && ecs.overflowY !== "visible") {
          scrollers.push(`${el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]}=+${o}(${ecs.overflowY})`);
        }
      }
      return {
        rootOver: e.scrollHeight - e.clientHeight,
        panelOver: p.scrollHeight - p.clientHeight,
        panelBox: [Math.round(pr.width), Math.round(pr.height)],
        panelTop: Math.round(pr.top), panelBottom: Math.round(pr.bottom), vh: innerHeight,
        clipped: pr.top < -1 || pr.bottom > innerHeight + 1,
        scrollers,
      };
    }, sel);
    log(`FIT ${name}`, m);
    return m;
  };
  const census = async (sel, name) => {
    const c = await page.evaluate((s) => {
      const e = document.querySelector(s); if (!e) return null;
      const p = e.querySelector(".panel") || e;
      const pcs = getComputedStyle(p);
      const h = e.querySelector("h1,h2,.m-kicker,.l-title,b");
      const hcs = h ? getComputedStyle(h) : null;
      const sizes = {};
      for (const el of e.querySelectorAll("*")) {
        const t = (el.textContent || "").trim();
        if (!t || el.children.length) continue;
        const cs = getComputedStyle(el);
        const k = `${cs.fontSize}/${cs.fontFamily.split(",")[0].replace(/["']/g, "")}`;
        sizes[k] = (sizes[k] || 0) + 1;
      }
      return {
        panelPad: pcs.padding, panelRadius: pcs.borderRadius, panelBorder: pcs.border,
        panelShadow: pcs.boxShadow.slice(0, 46),
        title: h ? { txt: (h.textContent || "").trim().slice(0, 26), size: hcs.fontSize, fam: hcs.fontFamily.split(",")[0].replace(/["']/g, "") } : null,
        typeScale: Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 7),
      };
    }, sel);
    log(`CENSUS ${name}`, c);
  };
  // Which leaf text elements are NOT on a rung of the type scale, named.
  const offscale = async (sel, name) => {
    const r = await page.evaluate((s) => {
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const rungs = new Set();
      for (const t of ["stamp", "micro", "fine", "small", "body", "lead", "head", "hero"]) {
        probe.style.fontSize = "var(--t-" + t + ")";
        rungs.add(getComputedStyle(probe).fontSize);
      }
      probe.remove();
      const e = document.querySelector(s); if (!e) return null;
      const out = {};
      for (const el of e.querySelectorAll("*")) {
        const txt = (el.textContent || "").trim();
        if (!txt || el.children.length) continue;
        const fs2 = getComputedStyle(el).fontSize;
        if (rungs.has(fs2)) continue;
        const k = fs2 + " " + el.tagName.toLowerCase() + "." + (String(el.className).split(" ")[0] || "-");
        out[k] = (out[k] || 0) + 1;
      }
      return { rungs: [...rungs], off: Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 8) };
    }, sel);
    log("OFFSCALE " + name, r);
  };
  const panelTop = async (sel) => page.evaluate((s) => {
    const p = document.querySelector(s + " .panel"); if (!p) return null;
    return Math.round(p.getBoundingClientRect().top);
  }, sel);

  // ---------- 1. LOADING (captured EARLY, deliberately) ----------
  await page.goto(`${BASE}/iso.html?eagerassets&clean=1`, { waitUntil: "commit", timeout: 90000 });
  await page.waitForTimeout(2500);
  log("loading-visible-at-capture", await page.evaluate(() => {
    const l = document.getElementById("loading"); if (!l) return null;
    const r = l.getBoundingClientRect(); const cs = getComputedStyle(l);
    return { w: Math.round(r.width), h: Math.round(r.height), op: cs.opacity, disp: cs.display,
      txt: (l.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) };
  }));
  await shot("loading");
  await fit("#loading", "loading");

  // ---------- 2. MENU (the front door) ----------
  await settled("menu-boot");
  await page.waitForTimeout(2500);
  await shot("menu");
  await fit("#menu", "menu");
  await census("#menu", "menu");
  await offscale("#menu", "menu");

  // ---------- 3. IN-GAME SETS ----------
  await page.goto(`${BASE}/iso.html?test&floor=4&level=11&abilities=all&gold=5000&seed=7&eagerassets&debug=1`,
    { waitUntil: "load", timeout: 120000 });
  await settled("game-boot");
  // r3: the card fades in over 300ms and r2's fixed 1200ms wait photographed it
  // mid-transition at 1600/2560 — a frame that does not visibly contain the
  // thing it claims. Poll the INK, and mark MISSED if it never arrives.
  await page.waitForFunction(() => {
    const t = document.querySelector("#tutorial .tut");
    return !!t && Number(getComputedStyle(t).opacity) > 0.98;
  }, null, { timeout: 20000 }).catch(() => log("tutorial", "opacity never reached 1"));
  await page.waitForTimeout(600);
  const tutEarly = await page.evaluate(() => {
    const t = document.getElementById("tutorial"); const r = t.getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top),
      txt: (t.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90) };
  });
  log("tutorial", tutEarly);
  const tutOp = await page.evaluate(() => {
    const t = document.querySelector("#tutorial .tut");
    return t ? Number(getComputedStyle(t).opacity) : 0;
  });
  log("tutorial-ink", tutOp);
  if (tutEarly.h > 4 && tutOp > 0.98) { await shot("tutorial"); await census("#tutorial", "tutorial"); }
  else log("tutorial", "MISSED — h " + tutEarly.h + " opacity " + tutOp);
  await page.waitForTimeout(6000);
  await shot("hud");

  const openPanel = async (key, sel, name, extra) => {
    await page.keyboard.press(key, { delay: 500 });
    await page.waitForTimeout(1600);
    await page.evaluate((s) => {
      const e = document.querySelector(s); if (!e) return;
      e.style.animation = "none";
      const p = e.querySelector(".panel"); if (p) p.style.animation = "none";
    }, sel);
    await page.waitForTimeout(400);
    await shot(name);
    await fit(sel, name);
    await census(sel, name);
    await offscale(sel, name);
    if (extra) await extra();
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(1000);
  };

  await openPanel("i", "#inv", "inv");
  await openPanel("p", "#sheet", "sheet");
  await openPanel("k", "#keys", "keys");
  await openPanel("t", "#abil", "abil", async () => {
    const tops = [await panelTop("#abil")];
    for (const [dsel, nm, psel] of [
      ['#abil .amode[data-view="graph"]', "abil-chart", "#abil"],
      ['#abil .apage[data-page="ach"]', "abil-ach", "#abil"],
      ['#abil .apage[data-page="stats"]', "abil-stats", "#abil"],
    ]) {
      await page.click(dsel).catch(() => log("click fail", dsel));
      await page.waitForTimeout(1300);
      await shot(nm);
      await fit(psel, nm);
      tops.push(await panelTop("#abil"));
    }
    log("abil-panelTop-per-tab", { tops, jump: Math.max(...tops) - Math.min(...tops) });
  });

  // ---------- 4. DRAFT ----------
  await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return;
    s.players[0].upgradeDraftsOwed = (s.players[0].upgradeDraftsOwed || 0) + 1;
  });
  await page.waitForTimeout(3000);
  let drDisp = await page.evaluate(() => getComputedStyle(document.getElementById("draft")).display);
  if (drDisp === "none") {
    await page.click("#draft-badge").catch(() => {});
    await page.waitForTimeout(1500);
    drDisp = await page.evaluate(() => getComputedStyle(document.getElementById("draft")).display);
  }
  if (drDisp !== "none") {
    // r2 lost 1600/2560 to the entry animation still running. Poll the ink.
    let ink = null;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1200);
      ink = await page.evaluate(() => {
        const d = document.getElementById("draft");
        const c = d.querySelector(".reward");
        return { panelOp: getComputedStyle(d.querySelector(".panel")).opacity,
          cardOp: c ? getComputedStyle(c).opacity : null,
          cards: d.querySelectorAll(".reward").length,
          kicker: (document.getElementById("draft-kicker").textContent || "").trim(),
          title: (document.getElementById("draft-title").textContent || "").trim() };
      });
      if (Number(ink.panelOp) > 0.98 && Number(ink.cardOp) > 0.98) break;
    }
    log("draft-ink", ink);
    if (Number(ink.panelOp) > 0.98 && Number(ink.cardOp) > 0.98) {
      await shot("draft"); await fit("#draft", "draft"); await census("#draft", "draft");
    } else log("draft", "MISSED — panelOp " + ink.panelOp + " cardOp " + ink.cardOp);
    await page.click("#draft .reward").catch(() => page.keyboard.press("1"));
    await page.waitForTimeout(1500);
  } else log("draft", "MISSED — never opened");

  // ---------- 5. SAFE ROOM ----------
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => { const s = window.__dcc?.state; if (s) { const p = s.players[0]; p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y; } });
    await page.keyboard.press("e", { delay: 800 });
    await page.waitForTimeout(2500);
    if (await page.evaluate(() => !!window.__dcc?.state?.safeRoom)) break;
  }
  const srDisp = await page.evaluate(() => getComputedStyle(document.getElementById("saferoom")).display);
  log("saferoom-display", srDisp);
  if (srDisp !== "none") {
    await page.evaluate(() => { const e = document.getElementById("saferoom"); e.style.animation = "none"; e.querySelector(".panel").style.animation = "none"; });
    await page.waitForTimeout(600);
    const tops = [await panelTop("#saferoom")];
    await shot("shop");
    await fit("#saferoom", "shop");
    await census("#saferoom", "shop");
    await offscale("#saferoom", "shop");
    // The tier rail is the r3 blocker fix: prove every tier is reachable and
    // that SIGNATURE actually renders.
    log("shop-tier-rail", await page.evaluate(() => {
      const rail = [...document.querySelectorAll("#sr-tiers .aidx")].map((b) => ({
        t: b.dataset.tier, txt: (b.textContent || "").replace(/\s+/g, " ").trim(),
        on: b.classList.contains("on"),
      }));
      const shelf = document.getElementById("sr-shelf");
      return { rail, shelfOver: shelf.scrollHeight - shelf.clientHeight,
        tiles: shelf.querySelectorAll(".itile").length,
        header: (shelf.querySelector(".tier-h")?.textContent || "").trim().slice(0, 60) };
    }));
    for (const t of ["advanced", "legendary"]) {
      await page.click(`#sr-tiers .aidx[data-tier="${t}"]`).catch(() => log("tier click fail", t));
      await page.waitForTimeout(900);
      await shot(`shop-tier-${t}`);
      log(`shop-tier-${t}`, await page.evaluate(() => {
        const shelf = document.getElementById("sr-shelf");
        const prices = [...shelf.querySelectorAll(".iprice")].map((e) => e.textContent.trim()).slice(0, 12);
        return { over: shelf.scrollHeight - shelf.clientHeight,
          tiles: shelf.querySelectorAll(".itile").length,
          header: (shelf.querySelector(".tier-h")?.textContent || "").trim().slice(0, 70), prices };
      }));
      tops.push(await panelTop("#saferoom"));
    }
    await page.click("#sr-shelf .itile").catch(() => {});
    await page.waitForTimeout(900);
    await shot("shop-detail");
    log("shop-detail-fit", await page.evaluate(() => {
      const d = document.getElementById("sr-detail");
      const secs = [...d.querySelectorAll(".dsec")].map((e) => {
        const r = e.getBoundingClientRect(), dr = d.getBoundingClientRect();
        return { txt: e.textContent.trim().slice(0, 24), fullyInside: r.top >= dr.top - 1 && r.bottom <= dr.bottom + 1 };
      });
      return { over: d.scrollHeight - d.clientHeight, h: Math.round(d.getBoundingClientRect().height), secs };
    }));
    for (const [t, nm] of [["#sr-tab-chase", "shop-chase"], ["#sr-tab-abil", "shop-abil"], ["#sr-tab-ach", "shop-ach"]]) {
      await page.click(t).catch(() => log("click fail", t));
      await page.waitForTimeout(1400);
      await shot(nm);
      await fit("#saferoom", nm);
      tops.push(await panelTop("#saferoom"));
    }
    log("shop-panelTop-per-tab", { tops, jump: Math.max(...tops) - Math.min(...tops) });
  } else log("shop", "MISSED — safe room never entered");

  await page.close();

  // ---------- 6. ROTATE, honestly ----------
  // r2 forced `display:flex` on #rotate inside a 1366x768 desktop page and
  // photographed a 17px strip — the gate is behind `@media (orientation:
  // portrait)` AND `body.phone`, and a desktop landscape viewport can satisfy
  // neither. Those frames showed the LOADING screen. The gate only exists on a
  // portrait phone, so it is captured on one: a real touch/mobile context, once
  // per run (not once per desktop viewport, because it has no desktop form).
  if (W === 1366) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
      hasTouch: true, isMobile: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const mp = await ctx.newPage();
    mp.setDefaultTimeout(240000);
    const mcdp = await ctx.newCDPSession(mp);
    await mp.goto(`${BASE}/iso.html?test&floor=2&level=5&abilities=all&eagerassets&clean=1`,
      { waitUntil: "load", timeout: 120000 });
    await mp.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
    await mp.waitForFunction(() => document.body.classList.contains("ingame"), null, { timeout: 90000 }).catch(() => {});
    await mp.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 90000 }).catch(() => {});
    await mp.waitForTimeout(3500);
    const rot = await mp.evaluate(() => {
      const r = document.getElementById("rotate"); const cs = getComputedStyle(r);
      const b = r.getBoundingClientRect();
      return { bodyClass: document.body.className, uiclass: document.body.dataset.uiclass,
        display: cs.display, w: Math.round(b.width), h: Math.round(b.height),
        portrait: matchMedia("(orientation: portrait)").matches,
        txt: (r.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
        loadingGone: getComputedStyle(document.getElementById("loading")).display === "none" ||
          Number(getComputedStyle(document.getElementById("loading")).opacity) === 0 };
    });
    log("rotate-390x844-portrait-phone", rot);
    if (rot.display !== "none" && rot.h > 200 && rot.loadingGone) {
      const { data } = await mcdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${OUT}/rotate-390x844-portrait.png`, Buffer.from(data, "base64"));
      log("rotate", "CAPTURED — portrait phone, #rotate boxed 390x844, loading gone");
    } else log("rotate", "MISSED — " + JSON.stringify(rot));
    await ctx.close();
  }
} finally { await browser.close(); }
console.log("\n===== r3 REPORT " + TAG + " =====");
for (const r of report) console.log(r);
