// trk-screens r1, pass 4: final fit measurements after the border-box /
// height-budget correction, plus a diagnosed attempt at the safe room.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = process.argv[2] || "shots/screens-r1";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }];
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const report = [];
try {
for (const vp of VIEWPORTS) {
  const tag = `${vp.w}x${vp.h}`;
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240000);
  page.on("pageerror", (e) => console.error(`PAGE ERROR [${tag}]:`, e.message));
  const cdp = await page.context().newCDPSession(page);
  const shot = async (n) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${n}-${tag}.png`, Buffer.from(data, "base64"));
  };
  const settled = async () => {
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => {});
    await page.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 180000 }).catch(() => {});
    await page.waitForTimeout(3200);
    const b = await page.evaluate(() => {
      const l = document.getElementById("loading"); if (!l) return null;
      const cs = getComputedStyle(l);
      if (cs.display === "none" || Number(cs.opacity) === 0) return null;
      const r = l.getBoundingClientRect(); return { w: r.width, h: r.height };
    });
    if (b) throw new Error(`ASSERT: #loading still boxed ${JSON.stringify(b)}`);
  };
  const measure = async (sel) => page.evaluate((s) => {
    const p = document.querySelector(s + " .panel"); if (!p) return null;
    const r = p.getBoundingClientRect();
    const bad = [];
    for (const el of [p, ...p.querySelectorAll("*")]) {
      const o = el.scrollHeight - el.clientHeight;
      if (o > 2 && getComputedStyle(el).overflowY !== "visible") {
        bad.push(`${el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]}:+${o}`);
      }
    }
    return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom),
      vh: innerHeight, panelOver: p.scrollHeight - p.clientHeight, scrollers: bad };
  }, sel);

  await page.goto(`${BASE}/iso.html?test&floor=2&level=8&abilities=all&gold=5000&seed=7&eagerassets&debug=1`,
    { waitUntil: "load", timeout: 90000 });
  await settled();

  for (const [key, sel, name] of [["p", "#sheet", "sheet3"], ["i", "#inv", "inv3"],
                                  ["t", "#abil", "abil3"], ["k", "#keys", "keys3"]]) {
    await page.keyboard.press(key, { delay: 500 });
    await page.waitForTimeout(1500);
    await page.evaluate((s) => {
      const e = document.querySelector(s); e.style.animation = "none";
      const p = e.querySelector(".panel"); if (p) p.style.animation = "none";
    }, sel);
    await page.waitForTimeout(300);
    if (name === "sheet3") await shot("sheet3");
    report.push([`${name} ${tag}`, JSON.stringify(await measure(sel))]);
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(900);
  }

  // ---- safe room, diagnosed ----
  const diag = await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return "no __dcc";
    const p = s.players[0];
    const st = s.map.stairs;
    p.pos.x = st.x; p.pos.y = st.y;
    return { stairs: st, pos: { ...p.pos }, floor: s.floor,
      boss: s.monsters.filter((m) => m.kind === "boss").length,
      phase: s.phase, alive: p.alive, status: s.status };
  });
  report.push([`shop diag-pre ${tag}`, JSON.stringify(diag)]);
  await page.waitForTimeout(1200);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("e", { delay: 800 });
    await page.waitForTimeout(2500);
    if (await page.evaluate(() => !!window.__dcc?.state?.safeRoom)) break;
  }
  const post = await page.evaluate(() => {
    const s = window.__dcc?.state;
    return { safeRoom: !!s?.safeRoom, events: (s?.events ?? []).slice(-4),
      dist: s ? Math.hypot(s.players[0].pos.x - s.map.stairs.x, s.players[0].pos.y - s.map.stairs.y) : -1,
      display: getComputedStyle(document.getElementById("saferoom")).display };
  });
  report.push([`shop diag-post ${tag}`, JSON.stringify(post)]);
  if (post.display !== "none") {
    await page.evaluate(() => { document.getElementById("saferoom").style.animation = "none"; });
    await page.waitForTimeout(500);
    await shot("shop");
    report.push([`saferoom ${tag}`, JSON.stringify(await measure("#saferoom")) +
      ` emptyWells=${await page.evaluate(() => document.querySelectorAll("#sr-shelf .itile.well").length)}`]);
    await page.click("#sr-shelf .itile").catch(() => {});
    await page.waitForTimeout(700);
    await page.click("#sr-tab-chase").catch(() => {});
    await page.waitForTimeout(1000);
    await shot("shop-chase");
    report.push([`shop-chase ${tag}`, `detail="${await page.evaluate(() => (document.getElementById("sr-detail").textContent || "").trim().replace(/\s+/g, " ").slice(0, 90))}"`]);
    await page.click("#sr-tab-ach").catch(() => {});
    await page.waitForTimeout(1000);
    await shot("shop-ach");
    report.push([`shop-ach ${tag}`, JSON.stringify(await measure("#saferoom"))]);
  }
  await page.close();
}
} finally { await browser.close(); }
console.log("\n=========== trk-screens r1 pass 4 ===========");
for (const [k, v] of report) console.log(`\n--- ${k}\n${v}`);
