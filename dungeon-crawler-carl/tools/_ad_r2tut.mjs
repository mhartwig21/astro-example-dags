// #tutorial, captured honestly. THIRD attempt, and the first two failures are
// the interesting part:
//
//  1. r1/r2 pushed one kind:"tip" announcement and screenshotted 2.5s later.
//     `step()` clears `state.announcements` every tick, so the push was wiped
//     before the host drained it: "card never mounted".
//  2. The retry loop mounted the card, and the gate passed on `.tut-head`
//     being 249x26 with computed opacity 1 — but `.tut` (its PARENT) was still
//     at opacity 0, because `getComputedStyle` reports an element's OWN
//     opacity, not the product of its ancestors'. The frame contained nothing.
//     That is exactly the class of frame this project scores as a lie, so the
//     three shots were renamed MISSED rather than counted.
//
// The gate now multiplies opacity up the ancestor chain, and the harness waits
// for `.tut.show` (the class the reveal transition keys off) before shooting.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] || "shots/ad-r2";
mkdirSync(OUT, { recursive: true });
const report = [];
const push = (k, v) => report.push([k, typeof v === "string" ? v : JSON.stringify(v)]);

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
try {
for (const vp of [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }]) {
  const tag = `${vp.w}x${vp.h}`;
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240000);
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`http://localhost:5284/iso.html?test&floor=6&level=12&abilities=all&seed=42&eagerassets&debug=1`,
    { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
    null, { timeout: 200000 }).catch(() => {});
  await page.waitForFunction(() => {
    const l = document.getElementById("loading"); if (!l) return true;
    const cs = getComputedStyle(l);
    return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, null, { timeout: 200000 }).catch(() => {});
  await page.waitForTimeout(3200);

  const mount = await page.evaluate(async () => {
    const line = "COURTESY EXPLANATION: that stairwell is sealed until the floor boss is dead. The System does not accept complaints about doors.";
    for (let i = 0; i < 250; i++) {
      const s = window.__dcc?.state; if (!s) return "no __dcc";
      if (document.querySelector("#tutorial .tut.show")) return "shown";
      if (!document.querySelector("#tutorial .tut")) s.announcements.push({ text: line, kind: "tip", priority: "normal" });
      await new Promise((r) => setTimeout(r, 40));
    }
    return document.querySelector("#tutorial .tut") ? "mounted but never .show" : "never mounted";
  });
  push(`tutorial mount ${tag}`, mount);
  await page.waitForTimeout(700);

  // EFFECTIVE opacity: the product up the ancestor chain, plus a real
  // visibility check. This is the gate that should have existed the first time.
  const vis = await page.evaluate(() => {
    const e = document.querySelector("#tutorial .tut");
    if (!e) return { ok: false, why: "absent" };
    let op = 1, n = e;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none") return { ok: false, why: `display:none on ${n.className || n.id}` };
      if (cs.visibility === "hidden") return { ok: false, why: `visibility:hidden on ${n.className || n.id}` };
      op *= Number(cs.opacity);
      n = n.parentElement;
    }
    const r = e.getBoundingClientRect();
    return { ok: op > 0.95 && r.width > 20 && r.height > 20 && r.top > -1 && r.left > -1,
      effectiveOpacity: Number(op.toFixed(3)),
      box: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`,
      head: e.querySelector(".tut-head")?.textContent.trim().slice(0, 40),
      hasButton: !!e.querySelector(".tut-dismiss") };
  });
  push(`tutorial visible ${tag}`, vis);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${vis.ok ? "" : "MISSED-"}tutorial-${tag}.png`, Buffer.from(data, "base64"));
  await page.close();
}
} catch (e) { push("RUN ABORTED", String(e.message).split(/\r?\n/)[0]); }
finally {
  await browser.close();
  for (const [k, v] of report) console.log(`\n--- ${k}\n${v}`);
  writeFileSync(`${OUT}/measurements-tutorial.json`, JSON.stringify(report, null, 1));
}
