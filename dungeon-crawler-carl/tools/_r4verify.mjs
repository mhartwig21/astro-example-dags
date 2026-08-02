// ROUND 4 VISUAL VERIFICATION. Measures the three presentation blockers that
// are only true on a real viewport: the constant panel overflow (12), the seal
// beat that never happened (6), and the verdict's action-row hierarchy (13).
//
//   node tools/_r4verify.mjs           # standings overflow at three sizes
//   MODE=verdict node tools/_r4verify.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "tools/_r4";
const API = process.env.API ?? "http://localhost:5444";
const MODE = process.env.MODE ?? "panels";
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`;
mkdirSync(OUT, { recursive: true });

const HISTORY = [];
for (let i = 0; i < 31; i++) {
  const floor = [2, 3, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 11, 12, 13, 15, 18][i % 20];
  HISTORY.push({
    endedAt: Date.now() - (i + 1) * 3600_000 * 7, mode: i % 3 === 0 ? "daily" : "random",
    day: "2026-07-" + String((i % 28) + 1).padStart(2, "0"), name: "Carl",
    won: floor === 18, floor, timeSec: 90 * floor, level: Math.min(35, 3 + floor * 2),
    kills: floor * 28, damageDealt: floor * 900, damageTaken: floor * 260,
    gold: 400, viewers: 11_400 + i * 873, favorites: 287, sponsors: 1, seed: 1000 + i,
  });
}

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

await page.addInitScript((hist) => {
  localStorage.setItem("dcc:token:v1", "R4VERIFY-TOKEN-0001");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:history:v1", JSON.stringify(hist));
  localStorage.setItem("dcc:consent:v1", "public");
}, HISTORY);

// THE BEAT IS 1.2 SECONDS LONG AND THE HARNESS IS SLOWER THAN THAT. Under
// SwiftShader a `waitForFunction` poll plus one screenshot costs hundreds of ms,
// so sampling from the driver misses the window it is trying to measure. This
// samples INSIDE the page at 60ms, from boot, against the real element.
await page.addInitScript(() => {
  window.__sealTrace = [];
  const tick = () => {
    const e = document.getElementById("recap-seal");
    const r = document.getElementById("recap");
    if (e && r && getComputedStyle(r).display !== "none") {
      const row = {
        t: Math.round(performance.now()),
        cls: e.className,
        word: e.querySelector(".vw")?.textContent ?? "",
        op: +(+getComputedStyle(e).opacity).toFixed(2),
      };
      const last = window.__sealTrace[window.__sealTrace.length - 1];
      if (!last || last.cls !== row.cls || last.word !== row.word || last.op !== row.op) {
        window.__sealTrace.push(row);
      }
    }
    setTimeout(tick, 60);
  };
  setTimeout(tick, 60);
});

async function boot(q = "") {
  await page.goto(BASE + q, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    return !l || l.classList.contains("done") || getComputedStyle(l).display === "none";
  }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

const measure = (id) => page.evaluate((sel) => {
  const p = document.getElementById(sel);
  if (!p) return null;
  const frame = p.querySelector(".set-frame");
  const more = document.getElementById(sel + "-more");
  const fr = frame?.getBoundingClientRect();
  // The lowest painted content inside the frame, so "dead space" is measurable.
  let lowest = 0;
  frame?.querySelectorAll("*").forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.height > 0 && r.width > 0) lowest = Math.max(lowest, r.bottom);
  });
  return {
    overflowY: p.scrollHeight - p.clientHeight,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    frameH: fr ? Math.round(fr.height) : null,
    deadSpaceBelowContent: fr ? Math.round(fr.bottom - lowest) : null,
    moreBelowFiring: !!more && more.classList.contains("on"),
  };
}, id);

if (MODE === "panels") {
  for (const [w, h] of [[1366, 768], [1600, 900], [2560, 1440]]) {
    await page.setViewportSize({ width: w, height: h });
    await boot();
    await page.click("#m-standings");
    await page.waitForTimeout(2200);
    for (const tab of ["contracts", "alltime", "bands", "rivals"]) {
      const b = page.locator(`[data-lt="${tab}"]`);
      if (await b.count()) { await b.click(); await page.waitForTimeout(1400); }
      const m = await measure("ladder");
      console.log(`${w}x${h}  STANDINGS/${tab.padEnd(9)} ${JSON.stringify(m)}`);
      await page.screenshot({ path: `${OUT}/standings-${tab}-${w}x${h}.png` });
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    const cs = page.locator("#m-careerset");
    if (await cs.count()) {
      await cs.click();
      await page.waitForTimeout(2400);
      console.log(`${w}x${h}  CAREER              ${JSON.stringify(await measure("career"))}`);
      await page.screenshot({ path: `${OUT}/career-${w}x${h}.png` });
    }
  }
} else {
  // THE SEAL BEAT + THE ACTION ROW.
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot();
  await page.click("#m-daily");
  await page.waitForTimeout(900);
  await page.click("#m-cast-go");
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
  const read = () => page.evaluate(() => {
    const s = window.__dcc.state, pl = s.players[0];
    const near = s.monsters.filter((m) => m.hp > 0)
      .map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y }))
      .sort((a, c) => a.d - c.d)[0];
    return { status: s.status, floor: s.floor, dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99 };
  });
  for (let i = 0; i < 60; i++) {
    const st = await read().catch(() => null);
    if (!st || st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.1) {
      if (st.dy < -0.4) keys.push("w"); else if (st.dy > 0.4) keys.push("s");
      if (st.dx > 0.4) keys.push("d"); else if (st.dx < -0.4) keys.push("a");
    }
    if (i < 12) keys.push(" ");
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(1100);
    for (const k of keys) await page.keyboard.up(k);
  }
  // t0 IS THE STATUS EDGE. A viewport resize between the death and the first
  // sample costs seconds under SwiftShader and hides the whole beat.
  await page.waitForFunction(() => window.__dcc.state.status !== "playing", null, { timeout: 180000 }).catch(() => {});
  const t0 = Date.now();
  const seen = [];
  for (const m of [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3400, 4000, 5000, 7000, 10000]) {
    const wait = m - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const s = await page.evaluate(() => {
      const r = document.getElementById("recap");
      const seal = document.getElementById("recap-seal");
      const foot = document.querySelector("#recap .rfoot");
      return {
        recapVisible: !!r && getComputedStyle(r).display !== "none",
        recapOpacity: r ? +getComputedStyle(r).opacity : null,
        sealClass: seal ? seal.className : null,
        sealWord: seal ? (seal.querySelector(".vw")?.textContent ?? "") : null,
        sealOpacity: seal ? +getComputedStyle(seal).opacity : null,
        footButtons: foot ? [...foot.querySelectorAll("button")].map((b) => b.textContent.trim().split("\n")[0].slice(0, 26)) : [],
      };
    });
    seen.push({ t: m, ...s });
    console.log(`t+${String(m).padStart(5)}ms  ${s.sealWord ?? "-"} | ${s.sealClass ?? "-"} | opacity ${s.sealOpacity} | recap ${s.recapOpacity}`);
    await page.screenshot({ path: `${OUT}/verdict-t${String(m).padStart(5, "0")}.png` });
  }
  const pendingFrames = seen.filter((s) => s.recapVisible && s.recapOpacity > 0.9
    && /pending|verifying/.test(s.sealClass ?? "") && (s.sealOpacity ?? 0) > 0.9);
  console.log("\nVISIBLE PENDING FRAMES:", pendingFrames.length,
    pendingFrames.map((f) => `t+${f.t} ${f.sealWord}`).join(", "));
  console.log("FOOTER BUTTONS:", JSON.stringify(seen[seen.length - 1].footButtons));
  const trace = await page.evaluate(() => window.__sealTrace ?? []);
  console.log("SEAL TRACE (in-page, 60ms):");
  for (const r of trace) console.log(`  t=${r.t} op=${r.op} ${r.word} | ${r.cls}`);
  // A frame counts only if the PENDING block was actually painted AND opaque.
  const visiblePending = trace.filter((r) => /pending|verifying/.test(r.cls) && r.op > 0.9);
  const firstTerminal = trace.find((r) => /verified|claimed|rejected|aged|blocked/.test(r.cls) && r.op > 0.9);
  const lastPending = visiblePending[visiblePending.length - 1];
  console.log("VISIBLE PENDING SAMPLES:", visiblePending.length);
  if (visiblePending.length && firstTerminal) {
    console.log("PENDING VISIBLE FOR:", firstTerminal.t - visiblePending[0].t, "ms",
      `(${visiblePending[0].word} -> ${firstTerminal.word})`);
  }
  void lastPending;
}

await browser.close();
