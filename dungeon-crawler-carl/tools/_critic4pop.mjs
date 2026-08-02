// Populate the boards with REAL runs from REAL accounts. Nothing is poked into
// the world — each rival plays the daily and dies, so every row on the board is
// a proof the server actually re-executed.
import { chromium } from "playwright";
const API = "http://localhost:5442";
const BASE = `http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1&q=low`;

const RIVALS = [
  { token: "RIVAL-A-TOKEN00001", name: "Donut Holes", fight: 26, rounds: 70 },
  { token: "RIVAL-B-TOKEN00001", name: "Princess Posobiec", fight: 18, rounds: 60 },
  { token: "RIVAL-C-TOKEN00001", name: "Katia", fight: 10, rounds: 50 },
];

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

async function playRival(r) {
  const page = await browser.newPage({ viewport: { width: 520, height: 340 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error(r.name, "PAGE ERROR:", e.message));
  await page.addInitScript(([t, n]) => {
    localStorage.setItem("dcc:token:v1", t);
    localStorage.setItem("dcc:name:v1", n);
    localStorage.setItem("dcc:consent:v1", "public");
  }, [r.token, r.name]);
  await page.goto(BASE, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 }).catch(() => { });
  await page.waitForFunction(() => { const l = document.getElementById("loading"); return !l || l.classList.contains("done") || getComputedStyle(l).display === "none"; }, null, { timeout: 300000 }).catch(() => console.error("WARN loading"));
  await page.waitForTimeout(2500);
  await page.click("#m-daily");
  await page.waitForTimeout(800);
  await page.click("#m-cast-go");
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 120000 });
  const read = () => page.evaluate(() => {
    const s = window.__dcc.state, pl = s.players[0];
    const near = s.monsters.filter((m) => m.hp > 0)
      .map((m) => ({ d: Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y), x: m.pos.x, y: m.pos.y }))
      .sort((a, c) => a.d - c.d)[0];
    return { status: s.status, floor: s.floor, dx: near ? near.x - pl.pos.x : 0, dy: near ? near.y - pl.pos.y : 0, d: near ? near.d : 99 };
  });
  for (let i = 0; i < r.rounds; i++) {
    const st = await read().catch(() => null);
    if (!st || st.status !== "playing") break;
    const keys = [];
    if (st.d > 1.1) {
      if (st.dy < -0.4) keys.push("w"); else if (st.dy > 0.4) keys.push("s");
      if (st.dx > 0.4) keys.push("d"); else if (st.dx < -0.4) keys.push("a");
    }
    if (i < r.fight) keys.push(" ");
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(1100);
    for (const k of keys) await page.keyboard.up(k);
  }
  await page.waitForFunction(() => window.__dcc.state.status !== "playing", null, { timeout: 200000 }).catch(() => { });
  await page.waitForTimeout(14000); // let the verify queue answer
  const res = await page.evaluate(() => JSON.stringify(window.__dcc.submitResult ?? null));
  console.log(r.name, "->", res);
  await page.close();
}

for (const r of RIVALS) { try { await playRival(r); } catch (e) { console.error(r.name, 'FAILED', e.message.slice(0,120)); } }
for (const k of ["contracts", "deepest", "fastest", "kills"]) {
  const j = await (await fetch(`${API}/boards/${k}`)).json();
  console.log(k, "verified:", (j.verified ?? []).length, "unproven:", (j.unproven ?? []).length,
    JSON.stringify((j.verified ?? []).map((e) => [e.name, e.floor, e.timeSec, e.state])));
}
await browser.close();
