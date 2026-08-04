// Acceptance probe, social r1 — independent measurements for #menu, #ladder,
// #career, #abil/ach at 1366/1600/2560. Clip detection the numeric fit gate
// cannot see, fit numbers, hero luminance, screenshots.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = "shots/acc-social-r1";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });
const report = [];
const push = (k, v) => { report.push([k, v]); console.log(`--- ${k}\n${JSON.stringify(v)}`); };

const readyGate = async (page) => {
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
  await page.waitForFunction(() => {
    const l = document.getElementById("loading"); if (!l) return true;
    const cs = getComputedStyle(l);
    return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, null, { timeout: 200000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return { loadingGone: true };
    const r = l.getBoundingClientRect();
    return { loadingGone: r.width === 0 && r.height === 0 || getComputedStyle(l).display === "none" };
  });
};

// Clip scan: leaf-ish text elements sheared by their own box or a clipping
// ancestor. Horizontal clips always reported; vertical only without line-clamp.
const clipScan = (rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return { error: "no root" };
  const bad = [];
  const els = [root, ...root.querySelectorAll("*")];
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!ownText) continue;
    const label = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    // self horizontal shear
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "visible")
      bad.push({ kind: "self-x", sel: el.id ? `#${el.id}` : el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : el.tagName, cut: el.scrollWidth - el.clientWidth, text: label });
    // self vertical shear (skip intentional line-clamp)
    if (el.scrollHeight > el.clientHeight + 2 && cs.overflowY !== "visible" && cs.overflowY !== "auto" && cs.overflowY !== "scroll" && cs.webkitLineClamp === "none")
      bad.push({ kind: "self-y", sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, cut: el.scrollHeight - el.clientHeight, text: label });
    // ancestor clip
    let a = el.parentElement;
    while (a && a !== root.parentElement) {
      const acs = getComputedStyle(a);
      const clips = acs.overflow !== "visible" || acs.overflowX !== "visible" || acs.overflowY !== "visible" || acs.clipPath !== "none";
      if (clips) {
        const ar = a.getBoundingClientRect();
        const cutR = r.right - ar.right, cutL = ar.left - r.left, cutB = r.bottom - ar.bottom;
        const scrollable = acs.overflowY === "auto" || acs.overflowY === "scroll" || acs.overflowX === "auto" || acs.overflowX === "scroll";
        if (!scrollable && (cutR > 2 || cutL > 2))
          bad.push({ kind: "anc-x", sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, by: a.id ? `#${a.id}` : `.${String(a.className).split(" ")[0]}`, cutR: Math.round(cutR), cutL: Math.round(cutL), text: label });
        if (!scrollable && cutB > 2)
          bad.push({ kind: "anc-y", sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, by: a.id ? `#${a.id}` : `.${String(a.className).split(" ")[0]}`, cutB: Math.round(cutB), text: label });
      }
      a = a.parentElement;
    }
  }
  // de-dupe
  const seen = new Set(); const out = [];
  for (const b of bad) { const k = JSON.stringify(b); if (!seen.has(k)) { seen.add(k); out.push(b); } }
  return out;
};

// Fit scan: viewport scrollbars + live internal scrollbars + panel rect.
const fitScan = (rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return { error: "no root" };
  const de = document.documentElement;
  const scrollers = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const oy = cs.overflowY, ox = cs.overflowX;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 2)
      scrollers.push({ sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, axis: "y", over: el.scrollHeight - el.clientHeight, client: el.clientHeight });
    if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 2)
      scrollers.push({ sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, axis: "x", over: el.scrollWidth - el.clientWidth, client: el.clientWidth });
  }
  const panel = root.querySelector(".panel") || root;
  const pr = panel.getBoundingClientRect();
  return {
    docOverX: de.scrollWidth - de.clientWidth, docOverY: de.scrollHeight - de.clientHeight,
    panel: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) },
    panelOffscreen: { r: Math.round(Math.max(0, pr.right - innerWidth)), b: Math.round(Math.max(0, pr.bottom - innerHeight)), t: Math.round(Math.max(0, -pr.top)), l: Math.round(Math.max(0, -pr.left)) },
    liveScrollers: scrollers,
  };
};

const lumaOf = async (page, cdp, rect) => {
  const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
  return page.evaluate(async ({ b64, r }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = r.w; c.height = r.h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const d = x.getImageData(0, 0, r.w, r.h).data;
    let sum = 0, mx = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; if (l > mx) mx = l;
    }
    return { meanLuma: +(sum / n / 2.55).toFixed(1), maxLuma: +(mx / 2.55).toFixed(1), px: n };
  }, { b64: shot, r: rect });
};

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
try {
  for (const vp of [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }]) {
    const tag = `${vp.w}x${vp.h}`;
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(240000);
    const cdp = await page.context().newCDPSession(page);

    // ---------- MENU ----------
    await page.goto(`${BASE}/iso.html?eagerassets`, { waitUntil: "load", timeout: 120000 });
    const gate = await readyGate(page);
    const menuGeom = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const solo = b("#m-solo"), daily = b("#m-daily");
      const tiles = [...document.querySelectorAll(".m-modes .m-tile")].map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      const tabs = [...document.querySelectorAll(".m-board-tabs .bt")].map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), w: Math.round(r.width) }; });
      const strip = document.querySelector(".m-board-tabs");
      const sr = strip ? strip.getBoundingClientRect() : null;
      const rows = [...new Set(tabs.map((t) => t.y))].length;
      const board = b(".m-board"), list = b("#m-board-list");
      const empty = document.querySelector("#m-board-list li.none");
      const er = empty ? empty.getBoundingClientRect() : null;
      const ics = [...document.querySelectorAll(".m-modes .m-tile-ic")].map((e) => { const cs = getComputedStyle(e); return { mask: (cs.webkitMaskImage || cs.maskImage || "").split("/").pop().slice(0, 20), color: cs.backgroundColor }; });
      const panel = b("#menu .panel") || b("#menu > div");
      return { solo, daily, ratioSoloDaily: solo && daily ? +(solo.h / daily.h).toFixed(2) : null,
        tiles, tabRows: rows, tabs, stripRight: sr ? Math.round(sr.right) : null,
        stripScroll: strip ? strip.scrollWidth - strip.clientWidth : null,
        board, list, empty: er ? { w: Math.round(er.width), h: Math.round(er.height), text: (empty.textContent || "").trim().slice(0, 60) } : null,
        voidBelow: list && er ? Math.round((list.y + list.h) - er.bottom) : null, ics, panel };
    });
    push(`menu geom ${tag}`, { gate, ...menuGeom });
    push(`menu clips ${tag}`, await page.evaluate(clipScan, "#menu"));
    push(`menu fit ${tag}`, await page.evaluate(fitScan, "#menu"));
    if (menuGeom.panel) {
      const hz = { x: 0, y: 0, w: Math.max(40, menuGeom.panel.x - 4), h: vp.h };
      push(`menu hero luma ${tag}`, await lumaOf(page, cdp, hz));
    }
    writeFileSync(`${OUT}/menu-${tag}.png`, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

    // ---------- LADDER ----------
    await page.click("#m-standings").catch((e) => push(`ladder open fail ${tag}`, String(e)));
    await page.waitForTimeout(1600);
    const ladderVis = await page.evaluate(() => { const l = document.getElementById("ladder"); const cs = l ? getComputedStyle(l) : null; return cs ? cs.display !== "none" : false; });
    if (ladderVis) {
      push(`ladder fit ${tag}`, await page.evaluate(fitScan, "#ladder"));
      push(`ladder clips ${tag}`, await page.evaluate(clipScan, "#ladder"));
      writeFileSync(`${OUT}/ladder-${tag}.png`, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
    } else push(`ladder ${tag}`, "DID NOT OPEN");

    // ---------- CAREER ----------
    await page.click("#m-careerset").catch((e) => push(`career open fail ${tag}`, String(e)));
    await page.waitForTimeout(1600);
    const careerVis = await page.evaluate(() => { const l = document.getElementById("career"); const cs = l ? getComputedStyle(l) : null; return cs ? cs.display !== "none" : false; });
    if (careerVis) {
      push(`career fit ${tag}`, await page.evaluate(fitScan, "#career"));
      push(`career clips ${tag}`, await page.evaluate(clipScan, "#career"));
      writeFileSync(`${OUT}/career-${tag}.png`, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    } else push(`career ${tag}`, "DID NOT OPEN");
    await page.close();

    // ---------- ABIL / ACHIEVEMENTS ----------
    const p2 = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    p2.setDefaultTimeout(240000);
    const cdp2 = await p2.context().newCDPSession(p2);
    await p2.goto(`${BASE}/iso.html?test&floor=6&level=12&abilities=all&gold=5000&seed=42&eagerassets&clean=1`, { waitUntil: "load", timeout: 120000 });
    await readyGate(p2);
    await p2.keyboard.press("t");
    await p2.waitForTimeout(700);
    await p2.click('#abil .apage[data-page="ach"]').catch((e) => push(`ach tab fail ${tag}`, String(e)));
    await p2.waitForTimeout(700);
    const achFit = await p2.evaluate(() => {
      const s = document.getElementById("ach-section");
      if (!s || getComputedStyle(s).display === "none") return { error: "ach pane not shown" };
      const grid = document.getElementById("ach-grid");
      const cards = grid ? grid.children.length : 0;
      const xs = grid ? [...new Set([...grid.children].map((c) => Math.round(c.getBoundingClientRect().x)))].length : 0;
      const c0 = grid && grid.children[0] ? grid.children[0].getBoundingClientRect() : null;
      return { paneOver: s.scrollHeight - s.clientHeight, paneClient: s.clientHeight, cards, cols: xs,
        card: c0 ? `${Math.round(c0.width)}x${Math.round(c0.height)}` : null,
        scrollbarVisible: s.scrollHeight > s.clientHeight + 2 && ["auto", "scroll"].includes(getComputedStyle(s).overflowY) };
    });
    push(`abil-ach fit ${tag}`, achFit);
    push(`abil clips ${tag}`, await p2.evaluate(clipScan, "#abil"));
    writeFileSync(`${OUT}/abil-ach-${tag}.png`, Buffer.from((await cdp2.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await p2.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/acc-probe.json`, JSON.stringify(report, null, 1));
console.log("ACCEPTANCE PROBE DONE");
