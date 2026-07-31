// Debug the quest-beat banner: accept a quest via dialogue, then dump
// #headline / body.modal over time.
import { chromium } from "playwright";

const base = "http://localhost:5285";
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`${base}/iso.html?debug=1&noassets`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 120000 });
await page.waitForTimeout(1500);
await page.click("#m-roam-solo");
await page.waitForTimeout(600);
await page.click("#m-cast-go");
await page.waitForFunction(() => {
  const s = window.__dcc?.state;
  return s && s.runKind === "roam" && s.status === "playing" && (s.npcs?.length ?? 0) > 0;
}, null, { timeout: 60000 });
await page.waitForTimeout(1200);

await page.evaluate(() => {
  const s = window.__dcc.state;
  const q = s.quests.find((x) => x.key === "cull") ?? s.quests[0];
  const n = (s.npcs ?? []).find((x) => x.id === q.giverNpcId);
  s.players[0].pos = { x: n.pos.x + 0.9, y: n.pos.y };
});
await page.waitForTimeout(400);
await page.keyboard.press("e");
await page.waitForFunction(() => !!window.__dcc.state.dialogue, null, { timeout: 8000 });
await page.waitForTimeout(800);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".dlg-choice")].find((b) => (b.dataset.choice || "").startsWith("accept:"));
  btn?.click();
});
await page.waitForTimeout(400);
console.log("after accept:", await page.evaluate(() => ({
  quests: window.__dcc.state.quests.map((q) => `${q.key}:${q.state}`),
  modal: document.body.className,
  headline: document.getElementById("headline").innerHTML.slice(0, 200), beat: window.__beatlog,
})));
await page.keyboard.press("Escape");
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(400);
  console.log(`t+${(i + 1) * 400}ms:`, await page.evaluate(() => ({
    modal: document.body.className,
    dlg: document.getElementById("dialogue").style.display,
    headline: document.getElementById("headline").innerHTML.slice(0, 240), beat: window.__beatlog,
  })));
}
await browser.close();
