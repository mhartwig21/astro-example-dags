// Independent acceptance capture — I do not trust the author's captures.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "tools/_acc1";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5430/iso.html";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });

await page.addInitScript(() => {
  localStorage.setItem("dcc:token:v1", "ACCEPTCRAWLER9");
  localStorage.setItem("dcc:name:v1", "Carl");
});

const log = [];
function rec(k, v) { log.push(`\n===== ${k} =====\n${v}`); console.log(`--- ${k} ---`); }

async function settle() {
  await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { } } });
  await page.waitForTimeout(150);
}
async function shot(name, sel) {
  await settle();
  const t = sel ? page.locator(sel) : page;
  await t.screenshot({ timeout: 300000, path: `${OUT}/${name}.png` });
  console.log("saved", name);
}
async function boot(url) {
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => console.error("WARN assets"));
  await page.waitForFunction(() => window.__dcc?.state?.status === "playing", null, { timeout: 120000 });
}
async function die() {
  await page.evaluate(() => { const s = window.__dcc.state; s.players[0].hp = 0; s.players[0].alive = false; s.status = "dead"; });
  await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 });
}
async function dumpRecap(tag) {
  const d = await page.evaluate(() => {
    const r = document.getElementById("recap");
    const vis = (el) => { if (!el) return false; const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0; };
    const panel = r?.querySelector(".panel");
    const walk = (el, depth = 0) => {
      if (!vis(el)) return "";
      let out = "";
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(" ");
      if (own) out += "  ".repeat(depth) + `[${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ").join(".") : ""}] ${own}\n`;
      for (const c of el.children) out += walk(c, depth + 1);
      return out;
    };
    return {
      text: panel ? walk(panel) : "(no panel)",
      scroll: panel ? { sh: panel.scrollHeight, ch: panel.clientHeight } : null,
      classes: r?.className,
    };
  });
  rec(tag, `classes=${d.classes} scrollHeight=${d.scroll?.sh} clientHeight=${d.scroll?.ch}\n${d.text}`);
  return d;
}

// ---------- 1. THE TEN SECONDS: real played run, floor 5, real death ----------
await boot(`${BASE}?debug=1&test&floor=5&level=7&abilities=all&seed=31`);
// play a little so the run has real content
await page.keyboard.down("w"); await page.waitForTimeout(1200); await page.keyboard.up("w");
await page.keyboard.down("j"); await page.waitForTimeout(900); await page.keyboard.up("j");
await die();
// capture the reveal at real offsets by scrubbing the WAAPI timeline
for (const t of [0, 250, 700, 1400, 3000]) {
  await page.evaluate((ms) => {
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = ms; } catch { } }
  }, t);
  await page.waitForTimeout(80);
  await page.locator("#recap").screenshot({ timeout: 300000, path: `${OUT}/A${t}-verdict.png` });
  console.log("saved reveal", t);
}
await dumpRecap("VERDICT floor5 death (default)");
await shot("A-verdict-full");

// TAB drilldown
await page.keyboard.down("Tab"); await page.waitForTimeout(500);
await dumpRecap("VERDICT TAB");
await shot("B-verdict-tab");
await page.keyboard.up("Tab");

// expand earned line
const exp = await page.evaluate(() => {
  const el = document.querySelector("#recap .vearn, #recap .earn, #recap [data-expand]");
  if (el) { el.click(); return el.className; } return null;
});
rec("earn expand target", String(exp));
await page.waitForTimeout(300);
await dumpRecap("VERDICT earned expanded");
await shot("C-verdict-earned");

// ---------- 2. deep + win ----------
await boot(`${BASE}?debug=1&test&floor=15&level=20&abilities=all&gear=15&seed=7`);
await die();
await dumpRecap("VERDICT floor15 death");
await shot("D-verdict-deep");

await boot(`${BASE}?debug=1&test&floor=18&level=24&abilities=all&gear=18&seed=7`);
await page.evaluate(() => { const s = window.__dcc.state; s.status = "won"; });
await page.waitForFunction(() => document.getElementById("recap")?.style.display === "flex", null, { timeout: 60000 }).catch(() => { });
await dumpRecap("VERDICT win");
await shot("E-verdict-win");

// ---------- 3. STANDINGS ----------
await page.evaluate(() => { document.getElementById("recap").style.display = "none"; });
for (const [tab, name] of [["contracts", "F-standings-contracts"], ["alltime", "G-standings-alltime"], ["bands", "H-standings-bands"], ["rivals", "I-standings-rivals"]]) {
  const ok = await page.evaluate((t) => {
    const l = document.getElementById("ladder"); if (!l) return "no #ladder";
    l.style.display = "flex";
    const btns = [...l.querySelectorAll("button,[data-tab],.tab")];
    const b = btns.find(x => (x.dataset?.tab === t) || x.textContent.trim().toLowerCase().includes(t.slice(0, 5)));
    if (b) b.click(); else return "no tab " + t;
    return "ok";
  }, tab);
  await page.waitForTimeout(1200);
  const txt = await page.evaluate(() => document.getElementById("ladder")?.innerText?.slice(0, 3000));
  rec("STANDINGS " + tab + " (" + ok + ")", txt ?? "(none)");
  await shot(name);
}

// ---------- 4. CAREER ----------
const cok = await page.evaluate(() => {
  document.getElementById("ladder").style.display = "none";
  const c = document.getElementById("career"); if (!c) return "no #career"; c.style.display = "flex"; return "ok";
});
await page.waitForTimeout(1200);
rec("CAREER (" + cok + ")", await page.evaluate(() => document.getElementById("career")?.innerText?.slice(0, 3000)));
await shot("J-career");

writeFileSync(`${OUT}/dump.txt`, log.join("\n"));
console.log("\nWROTE", `${OUT}/dump.txt`);
await browser.close();
