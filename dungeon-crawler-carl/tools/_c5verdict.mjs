// THE TEN SECONDS AFTER A RUN ENDS. Plays the real daily against the real
// server, then walks into a monster on 1 hp so the sim kills the crawler on
// its own terms, and photographs the verdict as a timeline.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_critic5";
const API = process.env.API ?? "http://localhost:5451";
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
const TAG = process.env.TAG ?? "v";
const EXTRA = process.env.EXTRA ?? "";
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`;
mkdirSync(OUT, { recursive: true });

const HISTORY = [];
for (let i = 0; i < 34; i++) {
  const floor = [2, 4, 3, 5, 6, 5, 7, 8, 6, 9, 10, 7, 11, 12, 9, 13, 15, 11, 18, 8][i % 20];
  const w = ((i * 2654435761) % 1009) / 1009;
  HISTORY.push({
    endedAt: Date.now() - (i + 1) * 3600_000 * 6, mode: i % 3 === 0 ? "daily" : "random",
    day: "2026-07-" + String((i % 28) + 1).padStart(2, "0"), name: "Carl", won: floor === 18, floor,
    timeSec: 84 * floor + Math.round(w * 240), level: Math.min(35, 3 + floor * 2),
    kills: floor * 26 + Math.round(w * 44), damageDealt: floor * 980, damageTaken: floor * 245,
    gold: 380, viewers: 9800 + i * 941, favorites: 240 + i * 23, sponsors: i % 4, seed: 2000 + i,
  });
}

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.addInitScript((hist) => {
  localStorage.setItem("dcc:token:v1", "CRITIC5-TOKEN-AAAA01");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
  localStorage.setItem("dcc:consent:v1", "public");
}, HISTORY);

const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}`); console.log("--- " + k + "\n" + (typeof v === "string" ? v : JSON.stringify(v))); };
const shot = async (n) => { await page.screenshot({ timeout: 240000, path: `${OUT}/${TAG}-${n}.png` }); console.log("saved", n); };

await page.goto(BASE + EXTRA, { waitUntil: "load", timeout: 90000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => { });
await page.waitForTimeout(2000);

if (!EXTRA.includes("test")) {
  await page.click("#m-daily"); await page.waitForTimeout(700);
  await page.click("#m-cast-go");
}
await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 120000 });
await page.setViewportSize({ width: 420, height: 260 }); // swiftshader runs ~15x faster small
rec("run started", await page.evaluate(() => ({ floor: window.__dcc.state.floor, mode: window.__dcc.state.mode, runKind: window.__dcc.state.runKind, event: window.__dcc.runEvent ?? null })));

// Let the floor's collapse clock do the killing: a real, recorded, sim-decided
// death with no poking at state. Poll until the run ends.
let last = 0;
for (let i = 0; i < 400; i++) {
  const st = await page.evaluate(() => {
    const s = window.__dcc.state, pl = s.players[0];
    const near = s.monsters.filter((m) => m.hp > 0).map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y })).sort((a, c) => a.d - c.d)[0];
    return { status: s.status, hp: pl.hp, floor: s.floor, elapsed: s.elapsed, kills: s.kills ?? 0,
             dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99 };
  }).catch(() => null);
  if (!st || st.status !== "playing") break;
  if (i % 20 === 0) { console.log("  sim t=" + st.elapsed.toFixed(1) + "s f" + st.floor + " hp" + Math.round(st.hp)); last = st.elapsed; }
  // fight anything nearby so the run has kills on it, otherwise stand still
  if (st.d < 2.6) await page.mouse.click(210, 130).catch(() => { });
  await page.waitForTimeout(700);
}
await page.setViewportSize({ width: W, height: H });
rec("status", await page.evaluate(() => window.__dcc.state.status));

const t0 = Date.now();
for (const m of [0, 700, 1400, 2200, 3200, 5000, 8000, 12000]) {
  const wait = m - (Date.now() - t0); if (wait > 0) await page.waitForTimeout(wait);
  rec(`t+${m}ms`, await page.evaluate(() => {
    const r = document.getElementById("recap");
    const txt = (id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== "none" ? e.innerText.replace(/\s+/g, " ").trim().slice(0, 240) : null; };
    return {
      visible: !!r && getComputedStyle(r).display !== "none", opacity: r ? getComputedStyle(r).opacity : null,
      letter: txt("recap-letter"), score: txt("recap-score"), title: txt("recap-title"), sub: txt("recap-sub"),
      line: txt("recap-line"), parts: txt("recap-parts"), basis: txt("recap-basis"),
      ladder: txt("recap-ladder"), seal: txt("recap-seal"), death: txt("recap-death"),
      mark: txt("recap-mark"), banked: txt("recap-banked"), note: txt("recap-note"),
      again: txt("recap-again"),
      submit: window.__dcc.submitResult ?? null,
    };
  }));
  await shot(`tl-${String(m).padStart(5, "0")}`);
}
// let the server finish verifying and see if the seal MOVES
await page.waitForTimeout(22000);
rec("t+34s (after verification)", await page.evaluate(() => {
  const txt = (id) => { const e = document.getElementById(id); return e ? e.innerText.replace(/\s+/g, " ").trim().slice(0, 300) : null; };
  return { seal: txt("recap-seal"), ladder: txt("recap-ladder"), note: txt("recap-note"), submit: window.__dcc.submitResult ?? null };
}));
await shot("tl-settled");

const FIT = `(() => { const out=[]; const vw=innerWidth, vh=innerHeight;
  for (const el of document.querySelectorAll("body *")) { const cs=getComputedStyle(el);
    if (cs.display==="none"||cs.visibility==="hidden"||Number(cs.opacity)===0) continue;
    const r=el.getBoundingClientRect(); if (r.width<2||r.height<2) continue;
    const sy=el.scrollHeight>el.clientHeight+1, sx=el.scrollWidth>el.clientWidth+1;
    const cy=/auto|scroll/.test(cs.overflowY), cx=/auto|scroll/.test(cs.overflowX);
    const clipped=/hidden|clip/.test(cs.overflowY)&&sy;
    const off=r.bottom>vh+1||r.top<-1||r.right>vw+1||r.left<-1;
    if ((sy&&cy)||(sx&&cx)||clipped||off) out.push({ el:(el.id?"#"+el.id:el.tagName.toLowerCase()+(typeof el.className==="string"&&el.className?"."+el.className.trim().split(/\\s+/).slice(0,2).join("."):"")),
      rect:[Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)],
      ovY:sy?el.scrollHeight-el.clientHeight:0, ovX:sx?el.scrollWidth-el.clientWidth:0, ov:cs.overflowY+"/"+cs.overflowX,
      SCROLLBAR:(sy&&cy)||(sx&&cx), CLIPPED:clipped, OFFSCREEN:off }); }
  return out; })()`;
rec("FIT verdict @" + W + "x" + H, (await page.evaluate(FIT)).filter((x) => x.SCROLLBAR || x.CLIPPED));

await page.keyboard.down("Tab"); await page.waitForTimeout(1500);
await shot("tab");
rec("TAB fit", (await page.evaluate(FIT)).filter((x) => x.SCROLLBAR || x.CLIPPED));
rec("TAB text", await page.evaluate(() => { const e = document.getElementById("recap-tab"); return e ? e.innerText.replace(/\s+/g, " ").slice(0, 1800) : "NO #recap-tab"; }));
await page.keyboard.up("Tab"); await page.waitForTimeout(400);

const e = page.locator("#recap-earned");
if (await e.count()) { await e.click().catch(() => { }); await page.waitForTimeout(900); await shot("earned"); }
const s = page.locator("#recap-share");
if (await s.count()) { await s.click().catch(() => { }); await page.waitForTimeout(2600); await shot("share"); rec("share fit", (await page.evaluate(FIT)).filter((x) => x.SCROLLBAR || x.CLIPPED)); }

writeFileSync(`${OUT}/${TAG}-log.txt`, log.join("\n"));
await browser.close();
console.log("DONE");
