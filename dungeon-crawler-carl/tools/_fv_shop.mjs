// FINAL VERIFICATION — surface (a): THE SHOP shelf. One browser, closed at the end.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const OUT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/polish/dungeon-crawler-carl/shots/_fv";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5311/iso.html";

const browser = await chromium.launch({
  args: ["--use-angle=d3d11", "--force_high_performance_gpu"],
});
const results = {};
for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await page.goto(`${BASE}?test&floor=8&level=16&gold=900&seed=41&debug=1&eagerassets`,
    { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 180000 });
  await page.waitForFunction(() => !!window.__dcc?.state, { timeout: 120000 });
  await page.waitForTimeout(2000);
  // Walk onto the stairs and take them: the safe room sits between floors.
  await page.evaluate(() => {
    const s = window.__dcc.state;
    s.players[0].pos.x = s.map.stairs.x;
    s.players[0].pos.y = s.map.stairs.y;
  });
  await page.waitForTimeout(600);
  await page.keyboard.down("e");
  await page.waitForTimeout(500);
  await page.keyboard.up("e");
  await page.waitForFunction(() => {
    const el = document.getElementById("saferoom");
    return !!el && getComputedStyle(el).display !== "none";
  }, { timeout: 60000 });
  await page.waitForTimeout(2500);

  const per = {};
  for (const view of ["stock", "all", "chase"]) {
    await page.evaluate((v) => {
      document.getElementById({ stock: "sr-tab-stock", all: "sr-tab-all", chase: "sr-tab-chase" }[v]).click();
    }, view);
    await page.waitForTimeout(900);
    per[view] = await page.evaluate(() => {
      const shelf = document.querySelector(".shop-shelf");
      const sr = shelf.getBoundingClientRect();
      const secs = [...shelf.querySelectorAll("section.tier")].map((sec) => {
        const h = sec.querySelector(".tier-h");
        const lbl = h?.querySelector(".tlabel");
        const note = h?.querySelector(".tnote");
        const hr = h.getBoundingClientRect();
        const lcs = getComputedStyle(lbl || h);
        return {
          header: (lbl?.innerText || h.innerText || "").replace(/\s+/g, " ").trim(),
          note: (note?.innerText || "").replace(/\s+/g, " ").trim(),
          tierColor: getComputedStyle(sec).getPropertyValue("--tc").trim(),
          tiles: sec.querySelectorAll(".itile:not(.well)").length,
          wells: sec.querySelectorAll(".itile.well").length,
          headerFontPx: +parseFloat(lcs.fontSize).toFixed(2),
          headerColor: lcs.color,
          headerBoxW: +hr.width.toFixed(1),
          headerLeft: +(hr.left - sr.left).toFixed(1),
          sectionTop: +(sec.getBoundingClientRect().top - sr.top).toFixed(1),
          sectionH: +sec.getBoundingClientRect().height.toFixed(1),
        };
      });
      // The old flat form (a bare .tier-h that is not inside a section.tier).
      const looseHeaders = [...shelf.querySelectorAll(":scope > .tier-h")]
        .map((h) => h.innerText.replace(/\s+/g, " ").trim());
      return {
        sections: secs,
        looseHeaders,
        dense: shelf.classList.contains("dense"),
        shelfClientH: shelf.clientHeight,
        shelfScrollH: shelf.scrollHeight,
        overflowPx: shelf.scrollHeight - shelf.clientHeight,
        tileW: shelf.querySelector(".itile") ? +getComputedStyle(shelf.querySelector(".itile")).width.replace("px", "") : null,
        totalTiles: shelf.querySelectorAll(".itile:not(.well)").length,
        totalWells: shelf.querySelectorAll(".itile.well").length,
        // Does a bottom fade mask still exist?
        maskImage: getComputedStyle(shelf).webkitMaskImage,
      };
    });
    const cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/shop-${view}-${vp.width}.png`, Buffer.from(data, "base64"));
  }
  results[`${vp.width}x${vp.height}`] = per;
  await page.close();
}
writeFileSync(`${OUT}/shop.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
