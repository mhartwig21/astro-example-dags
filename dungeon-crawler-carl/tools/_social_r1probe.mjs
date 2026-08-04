// screens-social r1 PROBE: measure before touching anything.
//  A. menu: primary vs secondary geometry (the silhouette/ratio complaint),
//     board-tab wrap, board empty state, hero-region luminance.
//  B. #abil ACHIEVEMENTS page overflow at all three viewports.
//  C. #tutorial paint truth at 1366: DOM gate -> CDP frame -> raster crop of
//     the card rect analysed for actual pixels; then the same with
//     backdrop-filter disabled to isolate the compositing suspect.
// ONE browser, closed in finally.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] || "shots/social-r1";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });
const report = [];
const push = (k, v) => { report.push([k, typeof v === "string" ? v : JSON.stringify(v)]); console.log(`--- ${k}\n${typeof v === "string" ? v : JSON.stringify(v)}`); };
const SHOT = { timeout: 240000 };

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

async function settle(page) {
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    if (!l) return true;
    const cs = getComputedStyle(l);
    return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, null, { timeout: 200000 }).catch(() => {});
  await page.waitForTimeout(3200);
  const box = await page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return null;
    const r = l.getBoundingClientRect();
    const cs = getComputedStyle(l);
    return cs.display === "none" || Number(cs.opacity) === 0 ? null : { w: r.width, h: r.height };
  });
  if (box) throw new Error(`#loading still boxed ${JSON.stringify(box)}`);
}

/** mean/max luma + stddev of a crop of a png buffer, computed in-page. */
async function rasterStats(page, pngB64, rect) {
  return page.evaluate(async ({ b64, r }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, Math.round(r.x), Math.round(r.y), c.width, c.height, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, sum2 = 0, max = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; sum2 += l * l; if (l > max) max = l;
    }
    const mean = sum / n;
    return { meanLuma: +(mean / 255 * 100).toFixed(1), maxLuma: +(max / 255 * 100).toFixed(1),
      stddev: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1), px: n };
  }, { b64: pngB64, r: rect });
}

try {
  for (const vp of [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }]) {
    const tag = `${vp.w}x${vp.h}`;
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(240000);
    const cdp = await page.context().newCDPSession(page);

    // ---- A. MENU ----
    await page.goto(`${BASE}/iso.html?eagerassets&clean=1`, { waitUntil: "load", timeout: 120000 });
    await settle(page);
    await page.waitForTimeout(600); // let the board fetch fail over to its empty state
    const geo = await page.evaluate(() => {
      const b = (s) => { const e = document.querySelector(s); if (!e) return null;
        const cs = getComputedStyle(e); if (cs.display === "none") return "hidden";
        const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
      const solo = b("#m-solo"), daily = b("#m-daily"), tile = b("#m-party");
      const tabs = [...document.querySelectorAll(".m-board-tabs .bt")].map((t) => ({ t: t.textContent, y: Math.round(t.getBoundingClientRect().y) }));
      const wrapped = new Set(tabs.map((t) => t.y)).size > 1;
      const list = b("#m-board-list");
      const none = document.querySelector("#m-board-list li.none");
      const noneBox = none ? none.getBoundingClientRect() : null;
      const panel = b("#menu .panel");
      const ics = [...document.querySelectorAll(".m-modes .m-tile-ic")].map((i) => {
        const cs = getComputedStyle(i);
        return { mask: (cs.webkitMaskImage || cs.maskImage || "").match(/[\w-]+\.svg/)?.[0], color: cs.backgroundColor };
      });
      return { solo, daily, tile, ratioSoloTile: solo && tile ? +(solo.h / tile.h).toFixed(2) : null,
        ratioSoloDaily: solo && daily ? +(solo.h / daily.h).toFixed(2) : null,
        tabsWrapped: wrapped, tabRows: [...new Set(tabs.map((t) => t.y))].length, tabs,
        board: b(".m-board"), list, emptyText: none?.textContent?.trim() ?? null,
        emptyBox: noneBox ? { w: Math.round(noneBox.width), h: Math.round(noneBox.height) } : null,
        voidBelow: list && noneBox ? Math.round(list.h - (noneBox.bottom - (noneBox.top - (noneBox.top - list.y)) + 0)) : null,
        panel, ics };
    });
    push(`menu geometry ${tag}`, geo);
    const { data: menuPng } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/menu-${tag}.png`, Buffer.from(menuPng, "base64"));
    // hero region: everything left of the panel, central band vertically
    const hero = { x: 0, y: vp.h * 0.2, w: Math.max(1, (geo.panel?.x ?? vp.w * 0.55) - 8), h: vp.h * 0.65 };
    push(`menu hero luminance ${tag}`, await rasterStats(page, menuPng, hero));

    // ---- B. #abil ACHIEVEMENTS overflow ----
    await page.goto(`${BASE}/iso.html?test&floor=6&level=10&abilities=all&gold=5000&seed=42&eagerassets&clean=1`, { waitUntil: "load", timeout: 120000 });
    await settle(page);
    await page.keyboard.press("t", { delay: 500 });
    await page.waitForTimeout(900);
    await page.click('#abil .apage[data-page="ach"]');
    await page.waitForTimeout(400);
    const achFit = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("#abil, #abil *")) {
        const o = el.scrollHeight - el.clientHeight;
        if (o > 2 && getComputedStyle(el).overflowY !== "visible")
          out.push({ sel: el.id ? `#${el.id}` : String(el.className).slice(0, 30), over: o, client: el.clientHeight });
      }
      const grid = document.getElementById("ach-grid");
      const cards = grid ? grid.children.length : 0;
      const first = grid?.firstElementChild?.getBoundingClientRect();
      const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0;
      return { overflowers: out, cards, cols, card: first ? `${Math.round(first.width)}x${Math.round(first.height)}` : null,
        pane: document.getElementById("ach-section")?.clientHeight };
    });
    push(`abil-ach fit ${tag}`, achFit);
    const { data: achPng } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/abil-ach-${tag}.png`, Buffer.from(achPng, "base64"));

    // ---- C. TUTORIAL raster truth (1366 only) ----
    if (vp.w === 1366) {
      await page.keyboard.press("Escape", { delay: 450 });
      await page.waitForTimeout(700);
      for (const variant of ["stock", "nobackdrop"]) {
        if (variant === "nobackdrop") {
          await page.addStyleTag({ content: ".tut { backdrop-filter: none !important; }" });
        }
        const mount = await page.evaluate(async () => {
          const line = "COURTESY EXPLANATION: that stairwell is sealed until the floor boss is dead. The System does not accept complaints about doors.";
          for (let i = 0; i < 250; i++) {
            const s = window.__dcc?.state; if (!s) return "no __dcc";
            if (document.querySelector("#tutorial .tut.show")) return "shown";
            if (!document.querySelector("#tutorial .tut")) s.announcements.push({ text: line, kind: "tip", priority: "normal" });
            await new Promise((r) => setTimeout(r, 40));
          }
          return "never mounted";
        });
        const vis = await page.evaluate(() => {
          const e = document.querySelector("#tutorial .tut");
          if (!e) return { ok: false, why: "absent" };
          let op = 1, n = e;
          while (n && n !== document.documentElement) { const cs = getComputedStyle(n); op *= Number(cs.opacity); n = n.parentElement; }
          const r = e.getBoundingClientRect();
          return { op: +op.toFixed(2), box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
        });
        const t0 = Date.now();
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        const shotMs = Date.now() - t0;
        const after = await page.evaluate(() => !!document.querySelector("#tutorial .tut.show"));
        writeFileSync(`${OUT}/tutorial-${variant}-${tag}.png`, Buffer.from(data, "base64"));
        const stats = vis.box ? await rasterStats(page, data, { x: vis.box.x, y: vis.box.y, w: vis.box.w, h: vis.box.h }) : null;
        push(`tutorial ${variant} ${tag}`, { mount, vis, shotMs, stillShownAfterShot: after, raster: stats });
        // dismiss before next variant
        await page.evaluate(() => document.querySelector("#tutorial .tut")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        await page.waitForTimeout(600);
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/probe.json`, JSON.stringify(report, null, 1));
console.log("\nDONE");
