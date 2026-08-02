// Minimal before/after probe for the CONSTANT panel overflow (blocker 12).
import { chromium } from "playwright";
const API = "http://localhost:5444";
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`;
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "R4PANEL-TOKEN-0001");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
});
for (const [w, h] of [[1366, 768], [1600, 900], [2560, 1440]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.goto(BASE, { waitUntil: "load", timeout: 90000 });
  await p.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(1800);
  await p.click("#m-standings");
  await p.waitForTimeout(1800);
  await p.click('[data-lt="rivals"]');
  await p.waitForTimeout(1400);
  const m = await p.evaluate(() => {
    const el = document.getElementById("ladder");
    const more = document.getElementById("ladder-more");
    return {
      overflowY: el.scrollHeight - el.clientHeight,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      moreBelow: more.classList.contains("on"),
    };
  });
  console.log(`${w}x${h} RIVALS ${JSON.stringify(m)}`);
}
await b.close();
