// FINAL VERIFICATION — shop follow-up: is the IN STOCK overflow systemic, and
// do the gutter labels break mid-word as the type token scales up?
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/polish/dungeon-crawler-carl/shots/_fv";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5311/iso.html";

const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--force_high_performance_gpu"] });
const out = [];
for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
  for (const seed of [41, 12, 77]) {
    const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    await page.goto(`${BASE}?test&floor=8&level=16&gold=900&seed=${seed}&debug=1&eagerassets`,
      { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 });
    await page.waitForFunction(() => !!window.__dcc?.state, { timeout: 120000 });
    page.setDefaultTimeout(120000);
    await page.waitForTimeout(2500);
    const srOpen = () => page.evaluate(() => {
      const el = document.getElementById("saferoom");
      return !!el && getComputedStyle(el).display !== "none";
    });
    // Under a slow frame the stairs press can be eaten; re-stage and re-press.
    for (let attempt = 0; attempt < 6 && !(await srOpen()); attempt++) {
      await page.evaluate(() => {
        const s = window.__dcc.state;
        s.players[0].pos.x = s.map.stairs.x; s.players[0].pos.y = s.map.stairs.y;
      });
      await page.waitForTimeout(700);
      await page.keyboard.down("e"); await page.waitForTimeout(700); await page.keyboard.up("e");
      await page.waitForTimeout(1800);
    }
    if (!(await srOpen())) { console.log(`${vp.width} seed=${seed}: SAFE ROOM NEVER OPENED — skipped`); await page.close(); continue; }
    await page.waitForTimeout(1800);
    const m = await page.evaluate(() => {
      const shelf = document.querySelector(".shop-shelf");
      const labels = [...shelf.querySelectorAll("section.tier .tier-h .tlabel")].map((l) => {
        const cs = getComputedStyle(l);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
        const lines = Math.round(l.getBoundingClientRect().height / lh);
        // A mid-word break: the rendered text wraps somewhere other than a space.
        const words = l.innerText.trim().split(/\s+/);
        return { text: l.innerText.trim(), fontPx: +parseFloat(cs.fontSize).toFixed(2),
          boxW: +l.getBoundingClientRect().width.toFixed(1),
          lines, words: words.length,
          midWordBreak: lines > words.length };
      });
      // The last section's visible fraction on the view the shop OPENS on.
      const secs = [...shelf.querySelectorAll("section.tier")];
      const last = secs[secs.length - 1];
      let lastVisibleFrac = null;
      if (last) {
        const lr = last.getBoundingClientRect(), sr = shelf.getBoundingClientRect();
        const vis = Math.max(0, Math.min(lr.bottom, sr.bottom) - Math.max(lr.top, sr.top));
        lastVisibleFrac = +(vis / lr.height).toFixed(3);
      }
      return {
        view: [...document.querySelectorAll(".shop-subtabs .tab")].find((t) => t.classList.contains("active"))?.innerText.trim(),
        dense: shelf.classList.contains("dense"),
        clientH: shelf.clientHeight, scrollH: shelf.scrollHeight,
        overflow: shelf.scrollHeight - shelf.clientHeight,
        sections: secs.length,
        lastSection: last?.querySelector(".tlabel")?.innerText.trim(),
        lastVisibleFrac,
        labels,
      };
    });
    out.push({ vp: `${vp.width}x${vp.height}`, seed, ...m });
    await page.close();
  }
}
writeFileSync(`${OUT}/shop2.json`, JSON.stringify(out, null, 2));
for (const r of out) {
  console.log(`${r.vp} seed=${r.seed} view=${r.view} dense=${r.dense} clientH=${r.clientH} scrollH=${r.scrollH} overflow=${r.overflow} last=${r.lastSection} visible=${(r.lastVisibleFrac * 100).toFixed(0)}%`);
  const bad = r.labels.filter((l) => l.midWordBreak);
  if (bad.length) console.log("   MID-WORD BREAKS:", bad.map((l) => `${l.text}@${l.fontPx}px/${l.boxW}px→${l.lines} lines`).join(" | "));
}
await browser.close();
