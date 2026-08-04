// Acceptance probe, social r2 — every r2 claim gets its number AND its frame:
//  1. tab strip: five visible tabs, one row, measured slack, no live x-scroller
//  2. hero: mean luminance of the region left of the panel (campfire reframe)
//  3. primary: prow clip present; a greyscale menu frame for the silhouette
//  4. ladder: ack latency of the nav click (frame first, fetch into it)
//  5. bands tab: the frame must NOT collapse when the tab is loading/empty
//  6. panel void below at tall viewports
// Frames land in shots/acc-critic-r2/.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = "shots/acc-critic-r2";
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
    // extra settle: the backdrop camera glides to its trucked pose (~1s)
    await page.waitForTimeout(1500);
    const menuGeom = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const solo = b("#m-solo"), daily = b("#m-daily");
      const strip = document.querySelector(".m-board-tabs");
      const sr = strip.getBoundingClientRect();
      const tabs = [...strip.querySelectorAll(".bt")].map((e) => {
        const r = e.getBoundingClientRect();
        return { t: e.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y),
          right: Math.round(r.right), w: Math.round(r.width),
          textClipped: e.scrollWidth > e.clientWidth + 1 };
      });
      const rows = [...new Set(tabs.map((t) => t.y))].length;
      const lastRight = Math.max(...tabs.map((t) => t.right));
      const clip = getComputedStyle(document.querySelector("#m-solo")).clipPath || "";
      return { solo, daily, ratioSoloDaily: solo && daily ? +(solo.h / daily.h).toFixed(2) : null,
        tabRows: rows, tabs, stripBox: { x: Math.round(sr.x), right: Math.round(sr.right), w: Math.round(sr.width) },
        stripScroll: strip.scrollWidth - strip.clientWidth,
        tabSlack: Math.round(sr.right - lastRight),
        allTabsVisible: tabs.every((t) => !t.textClipped && t.right <= Math.round(sr.right) + 1),
        primaryClip: clip.includes("50%") ? "PROW" : clip.slice(0, 60),
        board: b(".m-board"), panel: b("#menu .panel") };
    });
    push(`menu geom ${tag}`, { gate, ...menuGeom });
    push(`menu clips ${tag}`, await page.evaluate(clipScan, "#menu"));
    push(`menu fit ${tag}`, await page.evaluate(fitScan, "#menu"));
    if (menuGeom.panel) {
      const hz = { x: 0, y: 0, w: Math.max(40, menuGeom.panel.x - 4), h: vp.h };
      push(`menu hero luma ${tag}`, await lumaOf(page, cdp, hz));
    }
    await shotTo(cdp, `${OUT}/menu-${tag}.png`);
    // greyscale evidence for the silhouette claim (finding 7)
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

    // ---------- LADDER: ack latency, settle, bands stability ----------
    const ack = await page.evaluate(() => new Promise((res) => {
      const t0 = performance.now();
      document.getElementById("m-standings").click();
      const poll = () => {
        const l = document.getElementById("ladder");
        const on = l.classList.contains("on") && getComputedStyle(l).display !== "none";
        const painted = l.querySelector("#ladder-body .set-empty, #ladder-body .board, #ladder-body .contracts");
        if (on && painted) {
          return res({ ackMs: +(performance.now() - t0).toFixed(0),
            firstPaint: painted.classList.contains("set-empty")
              ? `SKELETON: ${painted.querySelector("b")?.textContent ?? ""}` : "content" });
        }
        if (performance.now() - t0 > 15000) return res({ ackMs: -1, firstPaint: "TIMEOUT" });
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }));
    push(`ladder ack ${tag}`, ack);
    // settle: offline state or content
    await page.waitForFunction(() => {
      const b = document.querySelector("#ladder-body");
      const se = b?.querySelector(".set-empty b");
      return (se && se.textContent !== "TUNING IN") || b?.querySelector(".board, .contracts, .contract");
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    const ladderSettle = await page.evaluate(() => {
      const f = document.querySelector("#ladder .set-frame").getBoundingClientRect();
      const se = document.querySelector("#ladder-body .set-empty");
      return { frame: { w: Math.round(f.width), h: Math.round(f.height) },
        state: se ? se.querySelector("b").textContent : "content",
        hugs: document.querySelector("#ladder .set-frame").classList.contains("hugs") };
    });
    push(`ladder settled ${tag}`, ladderSettle);
    push(`ladder fit ${tag}`, await page.evaluate(fitScan, "#ladder"));
    push(`ladder clips ${tag}`, await page.evaluate(clipScan, "#ladder"));
    await shotTo(cdp, `${OUT}/ladder-${tag}.png`);
    // BANDS tab: the frame must hold its size through loading/empty
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
    await page.waitForFunction(() => document.querySelector("#career-body .cheadline"), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    push(`career fit ${tag}`, await page.evaluate(fitScan, "#career"));
    push(`career clips ${tag}`, await page.evaluate(clipScan, "#career"));
    await shotTo(cdp, `${OUT}/career-${tag}.png`);
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/acc-probe.json`, JSON.stringify(report, null, 1));
console.log("ACCEPTANCE PROBE r2 DONE");
