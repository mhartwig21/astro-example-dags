import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.error("PAGEERR:", e.message));
await page.addInitScript(() => {
  window.__errs = [];
  window.addEventListener("error", (ev) => {
    window.__errs.push(String(ev.message) + " :: " + String((ev.error && ev.error.stack) || ""));
  });
});
await page.goto("http://localhost:5360/iso.html?test&debug=1&clean=1&floor=9&level=15&abilities=all&gold=4000&seed=1&eagerassets", { waitUntil: "load", timeout: 240000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 240000 });
await page.waitForFunction(() => { const el = document.getElementById("loading"); return !el || el.style.display === "none" || el.classList.contains("done"); }, null, { timeout: 240000 });
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__raf = 0; const t = () => { window.__raf++; requestAnimationFrame(t); }; requestAnimationFrame(t); });
await page.waitForTimeout(1000);
console.log("pre-walk:", JSON.stringify(await page.evaluate(() => ({ frameNo: window.__dcc.renderer.frameNo, raf: window.__raf, hidden: document.hidden, vis: document.visibilityState }))));
const r = await page.evaluate(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const boss = st.monsters.find((m) => m.kind === "boss");
  p.pos.x = boss.pos.x + 4; p.pos.y = boss.pos.y + 4;
  for (let i = 0; i < 400; i++) {
    window.__dcc.step({ move: { x: 0, y: 0 }, useStairs: false }, 1 / 60);
    if (st.encounter) break;
  }
  return { enc: st.encounter ? st.encounter.name : null };
});
console.log("walk:", JSON.stringify(r));
await page.waitForTimeout(900);
console.log("dom:", JSON.stringify(await page.evaluate(() => {
  const e = document.getElementById("bossintro");
  return {
    frameNo: window.__dcc.renderer.frameNo,
    cls: e.className, display: getComputedStyle(e).display,
    fade: getComputedStyle(document.documentElement).getPropertyValue("--bi-fade"),
    name: document.getElementById("bi-name").textContent,
    errs: window.__errs.slice(0, 4),
  };
})));
await b.close();
