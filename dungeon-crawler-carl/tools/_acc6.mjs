// Contrast + geometry measurements on the verdict's default state.
import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", e => console.error("PAGE ERROR:", e.message));
await page.addInitScript(() => { localStorage.setItem("dcc:token:v1", "SHOTCRAWLER"); localStorage.setItem("dcc:name:v1", "Carl"); localStorage.setItem("dcc:consent:v1", "public"); });
await page.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent("http://localhost:5431")}&noassets&test&floor=3&level=4&seed=9`, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
await page.evaluate(() => { const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead"; });
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });

const r = await page.evaluate(() => {
  const lum = (c) => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const bgOf = (el) => { let e = el; while (e) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return parse(b); e = e.parentElement; } return [10, 8, 6]; };
  const ratio = (el) => { const f = parse(getComputedStyle(el).color); const b = bgOf(el); const L1 = lum(f), L2 = lum(b); const [a, c] = L1 > L2 ? [L1, L2] : [L2, L1]; return +(((a + 0.05) / (c + 0.05)).toFixed(2)); };
  const info = (sel, label) => { const el = document.querySelector(sel); if (!el) return { label, missing: true }; const cs = getComputedStyle(el); const b = el.getBoundingClientRect(); return { label, text: el.innerText?.trim().slice(0, 44), fs: cs.fontSize, color: cs.color, contrast: ratio(el), h: Math.round(b.height), y: Math.round(b.y) }; };
  const p = document.querySelector("#recap .panel").getBoundingClientRect();
  return {
    panel: { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) },
    viewport: { w: innerWidth, h: innerHeight },
    items: [
      info("#recap-basis", "grade basis (vs ...)"),
      info("#recap .rfoot .dismiss", "dismiss"),
      info("#recap .rhint", "HOLD TAB hint"),
      info("#recap-share", "SHARE THIS RUN"),
      info("#recap-line", "commentary"),
      info("#recap-death-head", "death headline"),
      info("#recap .vpart .pd", "meter detail"),
      info("#recap-again", "RUN IT BACK"),
      info("#recap .eline .caret", "SHOW THE MATH"),
      info("#recap-ladder .lnote", "ladder note"),
    ],
    secondaryRow: [...document.querySelectorAll("#recap .rfoot button, #recap .rsecondary button")].map(b => ({ t: b.innerText.trim().slice(0, 24), fs: getComputedStyle(b).fontSize, c: ratio(b) })),
  };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ timeout: 300000, path: "tools/_acc5/verdict-f3.png" });
await browser.close();
