// trk-screens r1 verification: ONE browser, sequential, three viewports.
// Captures the screens this track owns and MEASURES panel fit
// (scrollHeight - clientHeight) before saving any frame.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] || "shots/screens-r1";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { w: 1366, h: 768 },
  { w: 1600, h: 900 },
  { w: 2560, h: 1440 },
];

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

const report = [];
// SwiftShader runs the 3D host at 1-3fps; a screenshot of a live canvas can
// take well over Playwright's 30s default. Every capture below gets a real
// budget, and the browser is closed in a finally so a failure never leaves a
// headless Chromium alive on the owner's laptop.
const SHOT = { timeout: 240000 };

async function settle(page, { loading = false } = {}) {
  await page.waitForFunction(
    () => document.documentElement.dataset.assetsSettled === "1",
    null, { timeout: 180000 },
  ).catch(() => {});
  if (loading) return;
  // data-assets-settled is NOT playable: shader precompile keeps running behind
  // the boot card. Poll until #loading has actually left, then hold.
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(3200);
  const box = await page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return null;
    const r = l.getBoundingClientRect();
    const cs = getComputedStyle(l);
    return cs.display === "none" || Number(cs.opacity) === 0 ? null : { w: r.width, h: r.height };
  });
  if (box) throw new Error(`ASSERT FAILED: #loading still has a box ${JSON.stringify(box)}`);
}

async function fit(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return "hidden";
    return {
      over: el.scrollHeight - el.clientHeight,
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    };
  }, sel);
}

/** every scrollable descendant that actually overflows */
async function overflowers(page, root) {
  return page.evaluate((r) => {
    const out = [];
    const host = document.querySelector(r);
    if (!host) return out;
    for (const el of [host, ...host.querySelectorAll("*")]) {
      const o = el.scrollHeight - el.clientHeight;
      if (o > 2 && getComputedStyle(el).overflowY !== "visible") {
        out.push({ sel: el.id ? `#${el.id}` : el.className.toString().slice(0, 40), over: o });
      }
    }
    return out;
  }, root);
}

try {
for (const vp of VIEWPORTS) {
  const tag = `${vp.w}x${vp.h}`;
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240000);
  page.on("pageerror", (e) => console.error(`PAGE ERROR [${tag}]:`, e.message));

  // ---- 1. LOADING (captured deliberately early) ----
  if (vp.w === 2560) {
    await page.goto(`${BASE}/iso.html?eagerassets`, { waitUntil: "commit", timeout: 60000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ ...SHOT, path: `${OUT}/loading-${tag}.png` });
    const lf = await page.evaluate(() => {
      const f = document.querySelector("#loading .l-frame");
      const t = document.querySelector("#loading .l-title");
      if (!f || !t) return null;
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(t);
      return {
        card: `${Math.round(r.width)}x${Math.round(r.height)}`,
        titleFont: cs.fontFamily.split(",")[0], titleSize: cs.fontSize,
        ground: getComputedStyle(document.getElementById("loading")).backgroundColor,
      };
    });
    report.push([`loading ${tag}`, JSON.stringify(lf)]);
  }

  // ---- 2. MENU ----
  await page.goto(`${BASE}/iso.html?eagerassets&clean=1`, { waitUntil: "load", timeout: 60000 });
  await settle(page);
  await page.evaluate(() => { for (const a of document.getAnimations()) a.pause(); }).catch(() => {});
  await page.screenshot({ ...SHOT, path: `${OUT}/menu-${tag}.png` });
  const menuProbe = await page.evaluate(() => {
    const p = document.querySelector("#menu .panel");
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    const f = (s) => { const e = document.querySelector(s); if (!e) return "-"; const c = getComputedStyle(e); return `${c.fontFamily.split(",")[0].replace(/"/g, "")} ${c.fontSize}`; };
    const tiles = [...document.querySelectorAll(".m-tile")].filter((t) => getComputedStyle(t).display !== "none")
      .map((t) => { const b = t.getBoundingClientRect(); return `${t.id}:${Math.round(b.width)}x${Math.round(b.height)}@${Math.round(b.x)},${Math.round(b.y)}`; });
    return {
      panel: `${Math.round(r.width)}x${Math.round(r.height)} @x=${Math.round(r.x)}`,
      freeLeft: Math.round(r.x), pctFire: Math.round((r.x / innerWidth) * 100),
      overflow: p.scrollHeight - p.clientHeight,
      bg: cs.backgroundColor,
      fonts: { h1: f("#menu h1"), tileB: f(".m-tile b"), go: f(".m-go"), mini: f(".m-mini"), testlink: f(".m-testlink") },
      tiles,
    };
  });
  report.push([`menu ${tag}`, JSON.stringify(menuProbe, null, 1)]);

  // menu with the party form open (cause/effect)
  await page.click("#m-party");
  await page.waitForTimeout(250);
  await page.screenshot({ ...SHOT, path: `${OUT}/menu-party-${tag}.png` });
  const partyProbe = await page.evaluate(() => {
    const f = document.getElementById("m-party-form").getBoundingClientRect();
    const t = document.getElementById("m-party").getBoundingClientRect();
    return { formW: Math.round(f.width), formY: Math.round(f.y), tileY: Math.round(t.y), tileX: Math.round(t.x), formX: Math.round(f.x) };
  });
  report.push([`menu-party ${tag}`, JSON.stringify(partyProbe)]);
  await page.click("#m-party");

  // ---- 3. IN-RUN PANELS via test mode ----
  await page.goto(`${BASE}/iso.html?test&floor=6&level=10&abilities=all&gold=5000&seed=42&eagerassets&clean=1`,
    { waitUntil: "load", timeout: 60000 });
  await settle(page);
  await page.evaluate(() => { for (const a of document.getAnimations()) a.pause(); }).catch(() => {});

  const panels = [
    { key: "abil", press: "t", sel: "#abil" },
    { key: "inv", press: "i", sel: "#inv" },
    { key: "sheet", press: "p", sel: "#sheet" },
    { key: "keys", press: "k", sel: "#keys" },
  ];
  for (const p of panels) {
    await page.keyboard.press(p.press, { delay: 500 });
    await page.waitForTimeout(900);
    await page.evaluate(() => { for (const a of document.getAnimations()) a.finish(); }).catch(() => {});
    await page.waitForTimeout(200);
    const shown = await page.evaluate((s) => {
      const e = document.querySelector(s);
      const cs = getComputedStyle(e);
      return { display: cs.display, opacity: cs.opacity };
    }, p.sel);
    if (shown.display === "none" || Number(shown.opacity) < 0.9) {
      report.push([`${p.key} ${tag}`, `MISSED — ${JSON.stringify(shown)}`]);
      continue;
    }
    await page.screenshot({ ...SHOT, path: `${OUT}/${p.key}-${tag}.png` });
    report.push([`${p.key} ${tag}`, `panel=${JSON.stringify(await fit(page, `${p.sel} .panel`))} inner=${JSON.stringify(await overflowers(page, p.sel))}`]);
    if (p.key === "abil") {
      const rail = await page.evaluate(() => {
        const r = document.querySelector("#abil .tp-rail");
        if (!r) return "absent";
        return { display: getComputedStyle(r).display, kids: r.children.length };
      });
      report.push([`abil tp-rail ${tag}`, JSON.stringify(rail)]);
      await page.click('#abil .apage[data-page="ach"]').catch(() => {});
      await page.waitForTimeout(300);
      await page.screenshot({ ...SHOT, path: `${OUT}/abil-ach-${tag}.png` });
      report.push([`abil-ach ${tag}`, `inner=${JSON.stringify(await overflowers(page, "#abil"))}`]);
      await page.click('#abil .amode[data-view="list"]').catch(() => {});
      await page.waitForTimeout(300);
    }
    if (p.key === "keys") {
      for (const t of ["prefs", "credits"]) {
        await page.click(`#keys .kb-tabs [data-kbtab="${t}"]`).catch(() => {});
        await page.waitForTimeout(250);
        await page.screenshot({ ...SHOT, path: `${OUT}/keys-${t}-${tag}.png` });
        report.push([`keys-${t} ${tag}`, `inner=${JSON.stringify(await overflowers(page, "#keys"))}`]);
      }
      await page.click(`#keys .kb-tabs [data-kbtab="keys"]`).catch(() => {});
    }
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(700);
  }

  // ---- 4. SAFE ROOM ----
  await page.evaluate(() => (window.__dccOpenSafeRoom ? window.__dccOpenSafeRoom() : null)).catch(() => {});
  await page.waitForTimeout(400);
  const srOpen = await page.evaluate(() => getComputedStyle(document.getElementById("saferoom")).display !== "none");
  if (srOpen) {
    await page.screenshot({ ...SHOT, path: `${OUT}/shop-${tag}.png` });
    report.push([`saferoom ${tag}`, `inner=${JSON.stringify(await overflowers(page, "#saferoom"))}`]);
  } else {
    report.push([`saferoom ${tag}`, "MISSED — no host hook to open it"]);
  }

  await page.close();
}

} finally {
  await browser.close();
}
console.log("\n=========== trk-screens r1 measurements ===========");
for (const [k, v] of report) console.log(`\n--- ${k}\n${v}`);
