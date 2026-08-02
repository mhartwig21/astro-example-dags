// THE DEFAULT PLAYER (blocker 2). A fresh ANONYMOUS token signs the daily from
// the front door and plays it. Two questions, both measured on the real client
// against a real server that HAS a provider configured:
//   1. does the DOOR still sell the run as CP-scoring?
//   2. does the EXIT hand the player a way to do the thing it demands?
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const API = "http://localhost:5443";
mkdirSync("tools/_r3", { recursive: true });
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await p.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "R3-ANON-NEVER-LINKED-01");
  localStorage.setItem("dcc:name:v1", "Carl");
  localStorage.setItem("dcc:consent:v1", "public");
});
const log = [];
const rec = (k, v) => { log.push(`\n===== ${k} =====\n${v}`); console.log("---", k, "\n" + v); };

await p.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`, { waitUntil: "load", timeout: 120000 });
await p.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => { });
await p.waitForTimeout(2500);
await p.click("#m-daily");
await p.waitForFunction(() => document.getElementById("menu").classList.contains("casting"), null, { timeout: 30000 });
await p.waitForTimeout(1000);
await p.click("#m-cast-go");
await p.waitForFunction(() => window.__dcc?.state?.elapsed > 0.2, null, { timeout: 120000 });
rec("BLOCKER 2 — THE DOOR, for an account the System cannot name",
  await p.evaluate(() => JSON.stringify({
    runEvent: window.__dcc.runEvent,
    contractNote: window.__dcc.runContractNote,
  }, null, 1)));

for (let i = 0; i < 4; i++) {
  await p.keyboard.down("w"); await p.waitForTimeout(600); await p.keyboard.up("w");
}
await p.evaluate(() => {
  const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead";
});
await p.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });
await p.waitForTimeout(12000);
await p.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });
await p.waitForTimeout(300);
rec("BLOCKER 2 — THE EXIT", await p.evaluate(() => {
  const seal = document.getElementById("recap-seal");
  const link = document.getElementById("recap-link");
  return JSON.stringify({
    sealClass: seal.className,
    sealText: seal.innerText.replace(/\n+/g, " | "),
    ladder: document.getElementById("recap-ladder").innerText.replace(/\n+/g, " | "),
    linkButtonExists: !!link,
    linkButtonLabel: link?.textContent ?? null,
    linkButtonBox: link ? (() => { const r = link.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })() : null,
    submitResult: window.__dcc.submitResult,
  }, null, 1);
}));
await p.screenshot({ timeout: 300000, path: "tools/_r3/anon-verdict.png" });
writeFileSync("tools/_r3/anon-dump.txt", log.join("\n"));
await b.close();
console.log("\nwrote tools/_r3/anon-*");
