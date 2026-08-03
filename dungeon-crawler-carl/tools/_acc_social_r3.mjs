// Acceptance probe, social r3 — every claim gets its number AND its frame:
//  1. STANDINGS empty at scale: skeleton mirrors .brow geometry at board width
//  2. career zero-data modules: histogram ghost curve, six named split rows,
//     the shelf skeleton — and the raster proof the plot region is not stone
//  3. career at 2560 holds the page (frame height, no hug) on a dressed field
//  4. menu 2560 rhythm: name-row->DESCEND and TEST->footer gaps, board dead band
//  5. mastery rows wear the menu's glyph treatment (plate + shared ink)
//  6. campfire base: black-shard fraction, before (r2 frame) vs after
// Frames land in shots/acc-social-r3/.
import { chromium } from "playwright";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const OUT = "shots/acc-social-r3";
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
      scrollers.push({ sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, axis: "y", over: el.scrollHeight - el.clientHeight });
    if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 2)
      scrollers.push({ sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, axis: "x", over: el.scrollWidth - el.clientWidth });
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
      bad.push({ kind: "self-x", cut: el.scrollWidth - el.clientWidth, text: label });
    if (el.scrollHeight > el.clientHeight + 2 && cs.overflowY !== "visible" && cs.overflowY !== "auto" && cs.overflowY !== "scroll" && cs.webkitLineClamp === "none")
      bad.push({ kind: "self-y", cut: el.scrollHeight - el.clientHeight, text: label });
    let a = el.parentElement;
    while (a && a !== root.parentElement) {
      const acs = getComputedStyle(a);
      const scrollable = acs.overflowY === "auto" || acs.overflowY === "scroll" || acs.overflowX === "auto" || acs.overflowX === "scroll";
      if ((acs.overflow !== "visible" || acs.overflowX !== "visible" || acs.overflowY !== "visible") && !scrollable) {
        const ar = a.getBoundingClientRect();
        if (r.right - ar.right > 2 || ar.left - r.left > 2)
          bad.push({ kind: "anc-x", text: label });
        if (r.bottom - ar.bottom > 2)
          bad.push({ kind: "anc-y", cutB: Math.round(r.bottom - ar.bottom), text: label });
      }
      a = a.parentElement;
    }
  }
  const seen = new Set(); const out = [];
  for (const b of bad) { const k = JSON.stringify(b); if (!seen.has(k)) { seen.add(k); out.push(b); } }
  return out;
};

// Region stats from a PNG (current CDP frame or a supplied baseline file):
// mean luma, lit fraction (>25/255) and BLACK fraction (<12/255).
const regionStats = async (page, b64, rect) =>
  page.evaluate(async ({ b64, r }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = r.w; c.height = r.h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const d = x.getImageData(0, 0, r.w, r.h).data;
    let sum = 0, lit = 0, black = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; if (l > 25) lit++; if (l < 12) black++;
    }
    return { meanLuma: +(sum / n / 2.55).toFixed(2), litFrac: +(lit / n).toFixed(3),
      blackFrac: +(black / n).toFixed(3), px: n };
  }, { b64, r: rect });

const shotTo = async (cdp, path) => {
  const b64 = (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
  writeFileSync(path, Buffer.from(b64, "base64"));
  return b64;
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
    await page.waitForTimeout(1800); // camera glide settles
    const rhythm = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
      const nameRow = b("#menu .m-name-row"), solo = b("#m-solo"), daily = b("#m-daily"),
        test = b("#menu .m-testlink"), foot = b("#menu .m-foot"), panel = b("#menu .panel");
      // Menu board module: dead band under the last VISIBLE ghost.
      const list = document.getElementById("m-board-list");
      const lr = list.getBoundingClientRect();
      const ghosts = [...list.querySelectorAll(".ghost")].filter((g) => getComputedStyle(g).display !== "none");
      const lastGhost = ghosts.length ? Math.max(...ghosts.map((g) => g.getBoundingClientRect().bottom)) : lr.top;
      return {
        gapNameToPrimary: solo && nameRow ? Math.round(solo.y - nameRow.bottom) : null,
        gapTestToFooter: foot && test ? Math.round(foot.y - test.bottom) : null,
        ratioSoloDaily: solo && daily ? +(solo.h / daily.h).toFixed(2) : null,
        soloH: solo?.h, dailyH: daily?.h,
        boardGhostsVisible: ghosts.length,
        boardDeadBelowGhosts: Math.round(lr.bottom - lastGhost),
        boardListH: Math.round(lr.height),
        panel,
      };
    });
    push(`menu rhythm ${tag}`, { gate, ...rhythm });
    push(`menu fit ${tag}`, await page.evaluate(fitScan, "#menu"));
    push(`menu clips ${tag}`, await page.evaluate(clipScan, "#menu"));
    const menuShot = await shotTo(cdp, `${OUT}/menu-${tag}.png`);
    // Campfire base: the shard region right of the flame (fire sits at ~24%
    // frame width; base at ~62-80% height at these poses).
    const fireRect = { x: Math.round(vp.w * 0.17), y: Math.round(vp.h * 0.58), w: Math.round(vp.w * 0.14), h: Math.round(vp.h * 0.22) };
    push(`campfire base AFTER ${tag}`, await regionStats(page, menuShot, fireRect));
    try {
      const before = readFileSync(`shots/acc-social-r2/menu-${tag}.png`).toString("base64");
      push(`campfire base BEFORE(r2) ${tag}`, await regionStats(page, before, fireRect));
    } catch { /* no baseline frame at this size */ }

    // ---------- STANDINGS: the skeleton at panel scale ----------
    await page.evaluate(() => document.getElementById("m-standings").click());
    await page.waitForFunction(() => {
      const b = document.querySelector("#ladder-body");
      const se = b?.querySelector(".set-empty b");
      return (se && se.textContent !== "TUNING IN") || b?.querySelector(".board, .contracts, .contract");
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    const skel = await page.evaluate(() => {
      const frame = document.querySelector("#ladder .set-frame");
      const fr = frame.getBoundingClientRect();
      const cs = getComputedStyle(frame);
      const innerW = fr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const se = document.querySelector("#ladder-body .set-empty");
      const rows = [...document.querySelectorAll("#ladder-body .skelrow")]
        .filter((r) => getComputedStyle(r).display !== "none");
      const sk = document.querySelector("#ladder-body .skelrows");
      const skr = sk ? sk.getBoundingClientRect() : null;
      const brow = document.querySelector(".brow"); // real row, if any tab has one
      // ink height: headline block + skeleton block
      const bTop = se ? se.querySelector("b").getBoundingClientRect().top : 0;
      return {
        state: se ? se.querySelector("b").textContent : "content",
        frame: { w: Math.round(fr.width), h: Math.round(fr.height) },
        hugs: frame.classList.contains("hugs"),
        skelW: skr ? Math.round(skr.width) : 0,
        skelWFracOfInner: skr ? +(skr.width / innerW).toFixed(2) : 0,
        rowsVisible: rows.length,
        rowH: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : 0,
        rowGrid: rows[0] ? getComputedStyle(rows[0]).gridTemplateColumns : "",
        browGrid: brow ? getComputedStyle(brow).gridTemplateColumns : "(no live rows)",
        inkH: skr && se ? Math.round(skr.bottom - bTop) : 0,
        inkFracOfFrame: skr && se ? +(((skr.bottom - bTop) / fr.height)).toFixed(2) : 0,
      };
    });
    push(`ladder skeleton ${tag}`, skel);
    push(`ladder fit ${tag}`, await page.evaluate(fitScan, "#ladder"));
    push(`ladder clips ${tag}`, await page.evaluate(clipScan, "#ladder"));
    await shotTo(cdp, `${OUT}/ladder-${tag}.png`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);

    // ---------- CAREER ----------
    await page.evaluate(() => document.getElementById("m-careerset").click());
    await page.waitForFunction(() => document.querySelector("#career-body .cheadline"), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    const career = await page.evaluate(() => {
      const frame = document.querySelector("#career .set-frame");
      const fr = frame.getBoundingClientRect();
      const histo = document.querySelector("#career .histo");
      const hr = histo ? histo.getBoundingClientRect() : null;
      const mic = document.querySelector("#career .mrow .mic");
      const cols = [...document.querySelectorAll("#career .ccol")].map((c) => {
        const r = c.getBoundingClientRect();
        const last = c.lastElementChild ? c.lastElementChild.getBoundingClientRect() : null;
        return { h: Math.round(r.height), lastBottomGap: last ? Math.round(r.bottom - last.bottom) : null };
      });
      return {
        frame: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) },
        hugs: frame.classList.contains("hugs"),
        frameHFracOfViewport: +(fr.height / innerHeight).toFixed(2),
        histoRect: hr ? { x: Math.round(hr.x), y: Math.round(hr.y), w: Math.round(hr.width), h: Math.round(hr.height) } : null,
        histoGhostBars: document.querySelectorAll("#career .histo .hb.ghost").length,
        histoZeroLabel: document.querySelector("#career .histo .hzero b")?.textContent ?? null,
        splitRows: document.querySelectorAll("#career .splitrow").length,
        splitNames: [...document.querySelectorAll("#career .splitrow .sname")].map((e) => e.textContent),
        shelfSkelRows: document.querySelectorAll("#career .crecent .skelrow").length,
        masteryPlates: document.querySelectorAll("#career .mrow .micbox").length,
        micInk: mic ? getComputedStyle(mic).backgroundColor : null,
        micSize: mic ? Math.round(mic.getBoundingClientRect().width) : null,
        cols,
      };
    });
    push(`career geom ${tag}`, career);
    push(`career fit ${tag}`, await page.evaluate(fitScan, "#career"));
    push(`career clips ${tag}`, await page.evaluate(clipScan, "#career"));
    const carShot = await shotTo(cdp, `${OUT}/career-${tag}.png`);
    // Raster proof, twice: the plot region actually carries ink (ghost bars),
    // and the field beside the frame is a dressed stage, not pure black.
    if (career.histoRect) {
      const h = career.histoRect;
      push(`career histo raster ${tag}`, await regionStats(page, carShot, { x: h.x, y: h.y, w: h.w, h: h.h }));
    }
    const fieldW = Math.max(24, career.frame.x - 30);
    const fieldRect = { x: 4, y: Math.round(vp.h * 0.12), w: fieldW, h: Math.round(vp.h * 0.76) };
    push(`career field raster ${tag}`, await regionStats(page, carShot, fieldRect));
    try {
      const before = readFileSync(`shots/acc-social-r2/career-${tag}.png`).toString("base64");
      push(`career field BEFORE(r2) ${tag}`, await regionStats(page, before, fieldRect));
    } catch { /* no baseline */ }
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/acc-probe.json`, JSON.stringify(report, null, 1));
console.log("ACCEPTANCE PROBE r3 DONE");
