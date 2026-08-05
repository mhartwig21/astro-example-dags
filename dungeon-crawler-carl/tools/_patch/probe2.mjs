import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.error("PAGEERR:", e.message));
await page.goto("http://localhost:5360/iso.html?test&debug=1&clean=1&floor=9&level=15&abilities=all&gold=4000&seed=1&eagerassets", { waitUntil: "load", timeout: 240000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 240000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const raf = window.requestAnimationFrame.bind(window);
  let t = performance.now();
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb(t += 0.4));
});
const snap = () => page.evaluate(() => {
  const st = window.__dcc.state;
  const e = document.getElementById("bossintro");
  return {
    frameNo: window.__dcc.renderer.frameNo,
    enc: st.encounter ? st.encounter.timeLeft.toFixed(2) : null,
    cls: e.className, disp: getComputedStyle(e).display,
    fade: getComputedStyle(document.documentElement).getPropertyValue("--bi-fade"),
    cine: document.body.classList.contains("cine"),
    name: document.getElementById("bi-name").textContent,
  };
});
await page.evaluate(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const boss = st.monsters.find((m) => m.kind === "boss");
  p.pos.x = boss.pos.x + 4; p.pos.y = boss.pos.y + 4;
  for (let i = 0; i < 400; i++) {
    window.__dcc.step({ move: { x: 0, y: 0 }, useStairs: false }, 1 / 60);
    if (st.encounter) break;
  }
});
console.log("A after walk:", JSON.stringify(await snap()));
await page.screenshot({ path: "tools/_patch/probe-a.png" });
console.log("B after 1st shot:", JSON.stringify(await snap()));
await page.evaluate(() => { let l = 420; const s = () => { if (l <= 0) return; window.__vt.advance(16); l -= 16; requestAnimationFrame(s); }; s(); });
await page.waitForTimeout(420);
console.log("C after age:", JSON.stringify(await snap()));
await page.screenshot({ path: "tools/_patch/probe-c.png" });
console.log("D after 2nd shot:", JSON.stringify(await snap()));
await b.close();
