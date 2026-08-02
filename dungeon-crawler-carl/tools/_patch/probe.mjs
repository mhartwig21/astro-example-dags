import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message, e.stack?.split("\n")[1]));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });
await page.goto("http://localhost:5360/iso.html?test&debug=1&clean=1&floor=9&level=15&abilities=all&gold=4000&seed=1&eagerassets", { waitUntil: "load", timeout: 240000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 240000 });
await page.waitForFunction(() => { const el = document.getElementById("loading"); return !el || el.style.display === "none" || el.classList.contains("done"); }, null, { timeout: 240000 });
await page.waitForTimeout(1200);
const r = await page.evaluate(() => {
  const st = window.__dcc.state;
  const p = st.players[0];
  const boss = st.monsters.find(m => m.kind === "boss");
  p.pos.x = boss.pos.x + 4; p.pos.y = boss.pos.y + 4;
  for (let i = 0; i < 400; i++) {
    window.__dcc.step({ move: {x:0,y:0}, useStairs: false }, 1/60);
    if (st.encounter) break;
  }
  return { enc: st.encounter ? { name: st.encounter.name, timeLeft: st.encounter.timeLeft, total: st.encounter.total } : null };
});
console.log("after walk:", JSON.stringify(r));
await page.waitForTimeout(300);
const dom = await page.evaluate(() => {
  const e = document.getElementById("bossintro");
  const st = window.__dcc.state;
  return {
    cls: e.className, display: getComputedStyle(e).display, opacity: getComputedStyle(e).opacity,
    fade: getComputedStyle(document.documentElement).getPropertyValue("--bi-fade"),
    name: document.getElementById("bi-name").textContent,
    cine: document.body.classList.contains("cine"),
    enc: !!st.encounter, tl: st.encounter && st.encounter.timeLeft,
  };
});
console.log("dom:", JSON.stringify(dom));
const f1 = await page.evaluate(() => window.__dcc.renderer.frameNo);
await page.waitForTimeout(700);
const f2 = await page.evaluate(() => ({ f: window.__dcc.renderer.frameNo, tl: window.__dcc.state.encounter && window.__dcc.state.encounter.timeLeft, cls: document.getElementById("bossintro").className, menu: document.getElementById("menu") && getComputedStyle(document.getElementById("menu")).display }));
console.log("frames:", f1, JSON.stringify(f2));
await b.close();
