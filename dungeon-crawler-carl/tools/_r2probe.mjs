import { chromium } from "playwright";
const API = "http://localhost:5439";
const b = await chromium.launch({ args: ["--use-angle=swiftshader","--enable-unsafe-swiftshader","--disable-gpu-sandbox"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on("pageerror", e => console.error("PAGE ERROR:", e.message));
p.on("console", m => console.log("[" + m.type() + "]", m.text()));
await p.addInitScript(() => { localStorage.setItem("dcc:token:v1","PROBE-TOKEN-0001"); localStorage.setItem("dcc:name:v1","Carl"); });
await p.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`, { waitUntil: "load", timeout: 120000 });
await p.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(()=>{});
await p.waitForTimeout(2500);
console.log("challengeDay in URL?", await p.evaluate(() => location.search));
console.log("fetch events from page:", await p.evaluate(async (api) => {
  try { const r = await fetch(api + "/events/current"); return JSON.stringify((await r.json()).daily); }
  catch (e) { return "THREW: " + e.message; }
}, API));
console.log("anon token:", await p.evaluate(async (api) => {
  try { const r = await fetch(api + "/auth/anon", {method:"POST"}); return JSON.stringify(await r.json()); } catch(e){ return "THREW: "+e.message; }
}, API));
await p.click("#m-daily");
await p.waitForFunction(() => document.getElementById("menu").classList.contains("casting"), null, {timeout:30000});
await p.waitForTimeout(1200);
await p.click("#m-cast-go");
await p.waitForFunction(() => document.getElementById("menu").style.display === "none", null, {timeout:30000});
await p.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 90000 });
for (const t of [500,1500,4000,8000]) { await p.waitForTimeout(t===500?500:t/2); console.log(t, await p.evaluate(() => JSON.stringify({seed: window.__dcc.state.seed, runEvent: window.__dcc.runEvent, note: window.__dcc.runContractNote, floor: window.__dcc.state.floor}))); }
console.log("run:", await p.evaluate(() => JSON.stringify({ seed: window.__dcc.state.seed, mode: window.__dcc.state.mode, runEvent: window.__dcc.runEvent, note: window.__dcc.runContractNote })));
await b.close();
