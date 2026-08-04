// #tutorial, photographed with a raster PROOF — a blank frame FAILS.
//
// Why every previous frame was blank (social r1, measured):
//  1. `?clean=1` SUPPRESSES tip cards entirely (main3d.ts cleanMode) — any
//     harness that carried the flag photographed an empty layer while probing
//     an element that was never allowed to mount. This tool refuses the flag.
//  2. With no clean flag the card mounts, but a CDP captureScreenshot of the
//     live WebGL canvas under SwiftShader measured 10.4-11.1s — and the card
//     auto-dismisses after 7s ("a courtesy, not a squatter"). Every DOM gate
//     passed BEFORE the capture; the compositor produced its frame AFTER the
//     card left. The DOM told the truth and the frame told a different one.
//
// So this capture (a) holds the courtesy TIMER — only the clock, never the
// pixels: what is photographed is exactly what a player sees during the 7s —
// and (b) proves the card is IN the raster: the card rect is cropped from the
// frame with the card up and from a baseline frame after dismissal, and the
// two crops must disagree across most of the rect. DOM say-so is not
// acceptance; the pixels are.
//
// Usage: node tools/tutorialshot.mjs [outdir]   (exit 1 if any frame fails)
//        HWGL=1 node tools/tutorialshot.mjs [outdir]
//   HWGL=1 runs HEADFUL on the machine's real GPU (ANGLE/D3D11) instead of
//   headless SwiftShader. Social r2: the 2560x1440 frame failed the raster
//   proof under SwiftShader (diffFrac 0.005, shotMs 34.8s) while 1366/1600
//   passed — before anyone calls that a shipping bug for real 1440p users,
//   or a harness artifact, the same proof must run on hardware GL. This
//   flag is that run.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const HWGL = process.env.HWGL === "1";
const OUT = process.argv[2] || "shots/tutorial";
const BASE = "http://localhost:5284";
const URL = `${BASE}/iso.html?test&floor=6&level=12&abilities=all&seed=42&eagerassets`;
if (/[?&]clean\b/.test(URL)) throw new Error("clean=1 suppresses tip cards — this URL must never carry it");
mkdirSync(OUT, { recursive: true });

const TIP = "COURTESY EXPLANATION: that stairwell is sealed until the floor boss is dead. The System does not accept complaints about doors.";
const report = [];
const push = (k, v) => { report.push([k, v]); console.log(`--- ${k}\n${JSON.stringify(v)}`); };
let failed = false;

const browser = await chromium.launch(HWGL
  ? { headless: false, args: ["--use-angle=d3d11", "--window-position=0,0"] }
  : { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
console.log(`GL backend: ${HWGL ? "HARDWARE (ANGLE/D3D11, headful)" : "SwiftShader (headless)"}`);
try {
  for (const vp of [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }]) {
    const tag = `${vp.w}x${vp.h}`;
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(240000);
    const cdp = await page.context().newCDPSession(page);
    await page.goto(URL, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
    await page.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 200000 }).catch(() => {});
    await page.waitForTimeout(3200);

    // Hold the courtesy clock (the 7s auto-dismiss), nothing else: SwiftShader
    // needs ~11s to composite a frame this tool must take inside a 7s window.
    // The player's card and this card are pixel-identical; only its lifetime
    // is pinned, and the held timer is released by the explicit dismiss below.
    await page.evaluate(() => {
      const orig = window.setTimeout.bind(window);
      window.__heldDismiss = [];
      window.setTimeout = (fn, ms, ...a) => {
        if (ms === 7000) { window.__heldDismiss.push(fn); return -1; }
        return orig(fn, ms, ...a);
      };
    });

    const mount = await page.evaluate(async (line) => {
      for (let i = 0; i < 250; i++) {
        const s = window.__dcc?.state; if (!s) return "no __dcc — is this a debug/test build?";
        if (document.querySelector("#tutorial .tut.show")) return "shown";
        if (!document.querySelector("#tutorial .tut")) s.announcements.push({ text: line, kind: "tip", priority: "normal" });
        await new Promise((r) => setTimeout(r, 40));
      }
      return "never mounted";
    }, TIP);
    await page.waitForTimeout(600); // reveal transition is 0.3s; give it slack
    const vis = await page.evaluate(() => {
      const e = document.querySelector("#tutorial .tut");
      if (!e) return { ok: false, why: "absent" };
      let op = 1, n = e;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden") return { ok: false, why: "hidden" };
        op *= Number(cs.opacity); n = n.parentElement;
      }
      const r = e.getBoundingClientRect();
      return { ok: op > 0.95 && r.width > 40 && r.height > 40,
        effOpacity: +op.toFixed(2), box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    });

    // Frame WITH the card…
    const t0 = Date.now();
    const withCard = (await cdp.send("Page.captureScreenshot", { format: "png" })).data;
    const shotMs = Date.now() - t0;
    const stillShown = await page.evaluate(() => !!document.querySelector("#tutorial .tut.show"));
    // …then release the held timer / dismiss, and take the BASELINE frame.
    await page.evaluate(() => {
      document.querySelector("#tutorial .tut")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (const fn of window.__heldDismiss ?? []) { try { fn(); } catch { /* already dismissed */ } }
    });
    await page.waitForFunction(() => !document.querySelector("#tutorial .tut"), null, { timeout: 10000 }).catch(() => {});
    const baseline = (await cdp.send("Page.captureScreenshot", { format: "png" })).data;

    // THE RASTER PROOF: the card rect, with-card vs baseline. If the card is
    // actually in the frame, most of its rect cannot match the dungeon that
    // was behind it. Identical crops = a blank frame = FAIL, whatever any
    // getComputedStyle said.
    const proof = vis.box ? await page.evaluate(async ({ a, b, r }) => {
      const load = async (b64) => {
        const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
        const c = document.createElement("canvas"); c.width = r.w; c.height = r.h;
        const x = c.getContext("2d", { willReadFrequently: true });
        x.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        return x.getImageData(0, 0, r.w, r.h).data;
      };
      const [da, db] = [await load(a), await load(b)];
      let sum = 0, hot = 0; const n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        const d = (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])) / 3;
        sum += d; if (d > 12) hot++;
      }
      return { meanDiff: +(sum / n).toFixed(1), diffFrac: +(hot / n).toFixed(3), px: n };
    }, { a: withCard, b: baseline, r: vis.box }) : null;

    // THE GATE SITS WHERE THE MEASURED DISTRIBUTIONS SEPARATE. A blank frame
    // measures diffFrac ~0.005 (r1, SwiftShader 2560). A painted card
    // measures 0.42-0.62 depending on GL backend (SwiftShader 0.50-0.55;
    // hardware D3D11 0.425/0.47/0.584 at 1366/1600/2560 — the card body is
    // translucent dark stone over a dark dungeon corner, so under hardware
    // lighting fewer body pixels clear the 12-step hot threshold even though
    // the card is plainly legible in the frame, human-checked). 0.3 is two
    // orders of magnitude above every blank ever measured and below every
    // painted card ever measured.
    const ok = vis.ok && stillShown && proof && proof.diffFrac > 0.3 && proof.meanDiff > 8;
    writeFileSync(`${OUT}/${ok ? "" : "MISSED-"}tutorial-${tag}.png`, Buffer.from(withCard, "base64"));
    push(`tutorial ${tag}`, { mount, vis, shotMs, stillShownAfterShot: stillShown, proof, PASS: ok });
    if (!ok) failed = true;
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}/tutorial-proof.json`, JSON.stringify(report, null, 1));
if (failed) { console.error("TUTORIAL CAPTURE FAILED THE RASTER PROOF"); process.exit(1); }
console.log("ALL FRAMES CARRY THE CARD");
