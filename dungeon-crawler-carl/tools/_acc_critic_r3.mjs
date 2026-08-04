// Acceptance critique r3 — independent probe. Menu / ladder / career / abil-ach
// at 1366x768, 1600x900, 2560x1440. Numbers AND frames; frames land in
// shots/acc-critic-r3/ and are inspected by eye afterwards.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = "shots/acc-critic-r3";
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
  await page.waitForTimeout(3200);
  return page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return { loadingGone: true };
    const r = l.getBoundingClientRect();
    return { loadingGone: (r.width === 0 && r.height === 0) || getComputedStyle(l).display === "none" };
  });
};

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
  const panel = root.querySelector(".panel, .set-frame") || root;
  const pr = panel.getBoundingClientRect();
  return {
    docOverX: de.scrollWidth - de.clientWidth, docOverY: de.scrollHeight - de.clientHeight,
    panel: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) },
    voidBelowViewport: Math.round(innerHeight - pr.bottom),
    liveScrollers: scrollers,
  };
};

const clipScan = (rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return { error: "no root" };
  const bad = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!ownText) continue;
    const label = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "visible")
      bad.push({ kind: "self-x", sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, cut: el.scrollWidth - el.clientWidth, text: label });
    if (el.scrollHeight > el.clientHeight + 2 && cs.overflowY !== "visible" && cs.overflowY !== "auto" && cs.overflowY !== "scroll" && cs.webkitLineClamp === "none")
      bad.push({ kind: "self-y", sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, cut: el.scrollHeight - el.clientHeight, text: label });
    let a = el.parentElement;
    while (a && a !== root.parentElement) {
      const acs = getComputedStyle(a);
      const scrollable = acs.overflowY === "auto" || acs.overflowY === "scroll" || acs.overflowX === "auto" || acs.overflowX === "scroll";
      if ((acs.overflow !== "visible" || acs.overflowX !== "visible" || acs.overflowY !== "visible") && !scrollable) {
        const ar = a.getBoundingClientRect();
        const cutR = r.right - ar.right, cutL = ar.left - r.left, cutB = r.bottom - ar.bottom;
        if (cutR > 2 || cutL > 2)
          bad.push({ kind: "anc-x", sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, by: a.id ? `#${a.id}` : `.${String(a.className).split(" ")[0]}`, cutR: Math.round(cutR), cutL: Math.round(cutL), text: label });
        if (cutB > 2)
          bad.push({ kind: "anc-y", sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, by: a.id ? `#${a.id}` : `.${String(a.className).split(" ")[0]}`, cutB: Math.round(cutB), text: label });
      }
      a = a.parentElement;
    }
  }
  const seen = new Set(); const out = [];
  for (const b of bad) { const k = JSON.stringify(b); if (!seen.has(k)) { seen.add(k); out.push(b); } }
  return out;
};

const lumaOf = async (page, cdp, rect) => {
  const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
  return page.evaluate(async ({ b64, r }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = r.w; c.height = r.h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const d = x.getImageData(0, 0, r.w, r.h).data;
    let sum = 0, mx = 0, lit = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; if (l > mx) mx = l; if (l > 25) lit++;
    }
    return { meanLuma: +(sum / n / 2.55).toFixed(1), maxLuma: +(mx / 2.55).toFixed(1),
      litFrac: +(lit / n).toFixed(3), px: n };
  }, { b64: shot, r: rect });
};

const shotTo = async (cdp, path) =>
  writeFileSync(path, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));

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
    await page.waitForTimeout(1800); // camera glide settles
    const menuGeom = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const solo = b("#m-solo"), daily = b("#m-daily");
      const strip = document.querySelector(".m-board-tabs");
      let tabsInfo = null;
      if (strip) {
        const sr = strip.getBoundingClientRect();
        const tabs = [...strip.querySelectorAll(".bt")].map((e) => {
          const r = e.getBoundingClientRect();
          return { t: e.textContent.trim(), y: Math.round(r.y), right: Math.round(r.right), w: Math.round(r.width),
            textClipped: e.scrollWidth > e.clientWidth + 1 };
        });
        const rows = [...new Set(tabs.map((t) => t.y))].length;
        const lastRight = Math.max(...tabs.map((t) => t.right));
        tabsInfo = { tabRows: rows, tabs, stripScrollX: strip.scrollWidth - strip.clientWidth,
          tabSlack: Math.round(sr.right - lastRight),
          allVisible: tabs.every((t) => !t.textClipped && t.right <= Math.round(sr.right) + 1) };
      }
      const clip = solo ? (getComputedStyle(document.querySelector("#m-solo")).clipPath || "none") : "none";
      // mode tile glyph audit: computed color of each tile icon glyph
      const tiles = [...document.querySelectorAll(".m-tile")].map((t) => {
        const icon = t.querySelector(".m-tile-icon");
        const cs = icon ? getComputedStyle(icon) : null;
        return { cls: t.className, iconColor: cs ? cs.color : null, iconBg: cs ? cs.backgroundImage.slice(0, 80) : null };
      });
      // board module: what does the empty state contain?
      const board = document.querySelector(".m-board");
      const boardTxt = board ? board.innerText.replace(/\s+/g, " ").slice(0, 300) : null;
      const ghosts = board ? board.querySelectorAll(".m-ghost-row, .ghost-row, .m-board-ghost, .skel-row").length : 0;
      return { solo, daily, ratioSoloDaily: solo && daily ? +(solo.h / daily.h).toFixed(2) : null,
        primaryClipPath: clip === "none" ? "NONE" : clip.slice(0, 80), tabsInfo, tiles,
        board: b(".m-board"), boardTxt, ghostRows: ghosts, panel: b("#menu .panel") };
    });
    push(`menu geom ${tag}`, { gate, ...menuGeom });
    push(`menu clips ${tag}`, await page.evaluate(clipScan, "#menu"));
    push(`menu fit ${tag}`, await page.evaluate(fitScan, "#menu"));
    if (menuGeom.panel) {
      const hz = { x: 0, y: 0, w: Math.max(40, menuGeom.panel.x - 4), h: vp.h };
      push(`menu hero luma ${tag}`, await lumaOf(page, cdp, hz));
    }
    await shotTo(cdp, `${OUT}/menu-${tag}.png`);
    if (vp.w === 1366) {
      const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
      const g = await page.evaluate(async (b64) => {
        const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const x = c.getContext("2d");
        x.filter = "grayscale(1)"; x.drawImage(img, 0, 0);
        return c.toDataURL("image/png").split(",")[1];
      }, shot);
      writeFileSync(`${OUT}/menu-1366-greyscale.png`, Buffer.from(g, "base64"));
    }

    // ---------- LADDER ----------
    const ack = await page.evaluate(() => new Promise((res) => {
      const t0 = performance.now();
      document.getElementById("m-standings").click();
      const poll = () => {
        const l = document.getElementById("ladder");
        const on = l.classList.contains("on") && getComputedStyle(l).display !== "none";
        const painted = l.querySelector("#ladder-body .set-empty, #ladder-body .board, #ladder-body .contracts");
        if (on && painted) return res({ ackMs: +(performance.now() - t0).toFixed(0),
          firstPaint: painted.classList.contains("set-empty") ? `SKELETON: ${painted.querySelector("b")?.textContent ?? ""}` : "content" });
        if (performance.now() - t0 > 15000) return res({ ackMs: -1, firstPaint: "TIMEOUT" });
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }));
    push(`ladder ack ${tag}`, ack);
    await page.waitForFunction(() => {
      const b = document.querySelector("#ladder-body");
      const se = b?.querySelector(".set-empty b");
      return (se && se.textContent !== "TUNING IN") || b?.querySelector(".board, .contracts, .contract");
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    const ladderSettle = await page.evaluate(() => {
      const f = document.querySelector("#ladder .set-frame").getBoundingClientRect();
      const se = document.querySelector("#ladder-body .set-empty");
      const skelRows = document.querySelectorAll("#ladder-body .skel-row, #ladder-body .set-empty .row, #ladder-body [class*=skel]").length;
      return { frame: { w: Math.round(f.width), h: Math.round(f.height) },
        state: se ? se.querySelector("b")?.textContent : "content",
        emptyTxt: se ? se.innerText.replace(/\s+/g, " ").slice(0, 240) : null, skelRows };
    });
    push(`ladder settled ${tag}`, ladderSettle);
    push(`ladder fit ${tag}`, await page.evaluate(fitScan, "#ladder"));
    push(`ladder clips ${tag}`, await page.evaluate(clipScan, "#ladder"));
    await shotTo(cdp, `${OUT}/ladder-${tag}.png`);
    const bands = await page.evaluate(() => new Promise((res) => {
      const frame = document.querySelector("#ladder .set-frame");
      const h0 = Math.round(frame.getBoundingClientRect().height);
      document.querySelector('[data-lt="bands"]').click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const hLoading = Math.round(frame.getBoundingClientRect().height);
        setTimeout(() => {
          const hSettled = Math.round(frame.getBoundingClientRect().height);
          res({ hBefore: h0, hLoading, hSettled,
            stable: Math.abs(hLoading - h0) <= 6 && Math.abs(hSettled - h0) <= 6 });
        }, 2500);
      }));
    }));
    push(`ladder bands frame ${tag}`, bands);
    push(`ladder bands clips ${tag}`, await page.evaluate(clipScan, "#ladder"));
    await shotTo(cdp, `${OUT}/ladder-bands-${tag}.png`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);

    // ---------- CAREER ----------
    const cack = await page.evaluate(() => new Promise((res) => {
      const t0 = performance.now();
      document.getElementById("m-careerset").click();
      const poll = () => {
        const l = document.getElementById("career");
        const on = l.classList.contains("on") && getComputedStyle(l).display !== "none";
        const painted = l.querySelector("#career-body .set-empty, #career-body .cheadline");
        if (on && painted) return res({ ackMs: +(performance.now() - t0).toFixed(0) });
        if (performance.now() - t0 > 15000) return res({ ackMs: -1 });
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }));
    push(`career ack ${tag}`, cack);
    await page.waitForFunction(() => document.querySelector("#career-body .cheadline, #career-body .chead, #career-body .histo, #career-body [class*=histo]"), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);
    const careerGeom = await page.evaluate(() => {
      const body = document.getElementById("career-body");
      const txt = body ? body.innerText.replace(/\s+/g, " ").slice(0, 400) : null;
      const histoBars = body ? body.querySelectorAll("[class*=hbar], .histo .bar, [class*=histo] div").length : 0;
      return { bodyTxt: txt, histoBars };
    });
    push(`career content ${tag}`, careerGeom);
    push(`career fit ${tag}`, await page.evaluate(fitScan, "#career"));
    push(`career clips ${tag}`, await page.evaluate(clipScan, "#career"));
    await shotTo(cdp, `${OUT}/career-${tag}.png`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);

    // ---------- ABIL / ACHIEVEMENTS pane (finding 3: +100px overflow) ----------
    await page.goto(`${BASE}/iso.html?test&floor=6&level=12&abilities=all&gold=5000&seed=42&eagerassets&clean=1`, { waitUntil: "load", timeout: 120000 });
    await readyGate(page);
    await page.keyboard.press("t");
    await page.waitForFunction(() => document.getElementById("abil")?.classList.contains("on") || getComputedStyle(document.getElementById("abil")).display !== "none", null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#abil .apage[data-page="ach"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await page.waitForTimeout(500);
    const achFit = await page.evaluate(() => {
      const pane = document.getElementById("ach-section");
      if (!pane || getComputedStyle(pane).display === "none") return { error: "ach pane not visible" };
      const grid = pane.querySelector(".sr-ach-grid");
      const g = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0;
      return { paneClient: pane.clientHeight, paneScroll: pane.scrollHeight,
        overflowY: pane.scrollHeight - pane.clientHeight, columns: g,
        cards: pane.querySelectorAll(".sr-ach").length };
    });
    push(`abil ach fit ${tag}`, achFit);
    push(`abil fit ${tag}`, await page.evaluate(fitScan, "#abil"));
    push(`abil clips ${tag}`, await page.evaluate(clipScan, "#abil"));
    await shotTo(cdp, `${OUT}/abil-ach-${tag}.png`);
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/acc-critic-r3.json`, JSON.stringify(report, null, 1));
console.log("ACCEPTANCE CRITIC r3 PROBE DONE");
