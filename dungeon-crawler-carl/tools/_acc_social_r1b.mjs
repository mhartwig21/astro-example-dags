// Acceptance probe 2: why THE STANDINGS / CAREER did not open from the menu,
// then measure + photograph them at all three viewports once open.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = "shots/acc-social-r1";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });
const report = [];
const push = (k, v) => { report.push([k, v]); console.log(`--- ${k}\n${JSON.stringify(v)}`); };

const fitScan = (rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return { error: "no root" };
  const de = document.documentElement;
  const scrollers = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    if ((["auto", "scroll"].includes(cs.overflowY)) && el.scrollHeight > el.clientHeight + 2)
      scrollers.push({ sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, axis: "y", over: el.scrollHeight - el.clientHeight });
    if ((["auto", "scroll"].includes(cs.overflowX)) && el.scrollWidth > el.clientWidth + 2)
      scrollers.push({ sel: el.id ? `#${el.id}` : `.${String(el.className).split(" ")[0]}`, axis: "x", over: el.scrollWidth - el.clientWidth });
  }
  const frame = root.querySelector(".set-frame") || root;
  const fr = frame.getBoundingClientRect();
  const rootScroll = { over: root.scrollHeight - root.clientHeight, hint: (document.getElementById(root.id + "-more") || {}).className || "" };
  const fitmore = [...root.querySelectorAll(".fitmore")].map((n) => n.textContent.trim().slice(0, 70));
  return { rootScroll, fitmore,
    frame: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) },
    frameOffscreen: { b: Math.round(Math.max(0, fr.bottom - innerHeight)), r: Math.round(Math.max(0, fr.right - innerWidth)) },
    docOver: { x: de.scrollWidth - de.clientWidth, y: de.scrollHeight - de.clientHeight }, liveScrollers: scrollers };
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
    let a = el.parentElement;
    while (a && a !== root.parentElement) {
      const acs = getComputedStyle(a);
      const scrollable = ["auto", "scroll"].includes(acs.overflowY) || ["auto", "scroll"].includes(acs.overflowX);
      if ((acs.overflow !== "visible" || acs.clipPath !== "none") && !scrollable) {
        const ar = a.getBoundingClientRect();
        if (r.right - ar.right > 2 || ar.left - r.left > 2 || r.bottom - ar.bottom > 2)
          bad.push({ kind: "anc", by: a.id ? `#${a.id}` : `.${String(a.className).split(" ")[0]}`, cutR: Math.round(r.right - ar.right), cutB: Math.round(r.bottom - ar.bottom), text: label });
      }
      a = a.parentElement;
    }
  }
  const seen = new Set(); const out = [];
  for (const b of bad) { const k = JSON.stringify(b); if (!seen.has(k)) { seen.add(k); out.push(b); } }
  return out;
};

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
try {
  for (const vp of [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }]) {
    const tag = `${vp.w}x${vp.h}`;
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(240000);
    const cdp = await page.context().newCDPSession(page);
    page.on("pageerror", (e) => push(`pageerror ${tag}`, String(e).slice(0, 200)));
    await page.goto(`${BASE}/iso.html?eagerassets`, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
    await page.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 200000 }).catch(() => {});
    await page.waitForTimeout(3200);

    // LADDER: click, then wait up to 25s for the .on class; time it.
    const t0 = Date.now();
    await page.click("#m-standings");
    const opened = await page.waitForFunction(() => document.getElementById("ladder").classList.contains("on"), null, { timeout: 25000 }).then(() => true).catch(() => false);
    const openMs = Date.now() - t0;
    push(`ladder open ${tag}`, { opened, openMs });
    if (opened) {
      await page.waitForTimeout(1200); // fitPanelSoon + async board fetch
      push(`ladder fit ${tag}`, await page.evaluate(fitScan, "#ladder"));
      push(`ladder clips ${tag}`, await page.evaluate(clipScan, "#ladder"));
      writeFileSync(`${OUT}/ladder-${tag}.png`, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      // BANDS tab — the historically worst fit
      await page.click('#ladder [data-lt="bands"]').catch(() => {});
      await page.waitForTimeout(1000);
      push(`ladder-bands fit ${tag}`, await page.evaluate(fitScan, "#ladder"));
      writeFileSync(`${OUT}/ladder-bands-${tag}.png`, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }

    const t1 = Date.now();
    await page.click("#m-careerset");
    const copened = await page.waitForFunction(() => document.getElementById("career").classList.contains("on"), null, { timeout: 25000 }).then(() => true).catch(() => false);
    push(`career open ${tag}`, { opened: copened, openMs: Date.now() - t1 });
    if (copened) {
      await page.waitForTimeout(1200);
      push(`career fit ${tag}`, await page.evaluate(fitScan, "#career"));
      push(`career clips ${tag}`, await page.evaluate(clipScan, "#career"));
      writeFileSync(`${OUT}/career-${tag}.png`, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/acc-probe2.json`, JSON.stringify(report, null, 1));
console.log("PROBE2 DONE");
