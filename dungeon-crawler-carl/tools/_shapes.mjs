// Silhouette probe: fire one named signature per shape at the crawler's feet
// and shoot it. This exists because the acceptance review's core finding was
// that the ASKS were indistinguishable as shapes — so the shapes need a rig
// that photographs them alone, without a fight on top.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] || "tools/_shapes";
mkdirSync(OUT, { recursive: true });
const PORT = process.env.DCC_PORT || "5360";
const LABELS = [
  ["lanes", "CITATION", 4],
  ["cords", "MOTION CARRIED", 4],
  ["shell", "STOP-WORK ORDER", 4],
  ["props", "SLUICE GATE", 4],
  ["cells", "COMPLIANCE LATTICE", 7],
  ["set", "SET", 1],
  ["ring", "FLOOD SURGE", 1],
];
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });
await page.goto(`http://localhost:${PORT}/iso.html?test&debug=1&clean=1&floor=6&level=12&seed=3&eagerassets`,
  { waitUntil: "load", timeout: 240000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 120000 });
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || el.style.display === "none" || el.classList.contains("done");
}, null, { timeout: 180000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const raf = window.requestAnimationFrame.bind(window);
  let t = performance.now();
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.4)));
});
for (const [name, label, value] of LABELS) {
  await page.evaluate(([lbl, val]) => {
    const st = window.__dcc.state;
    const p = st.players[0];
    window.__dcc.bossBeat({
      kind: "telegraph", monsterId: -1, bossId: "sumpking", label: lbl,
      value: val, pos: { x: p.pos.x, y: p.pos.y },
    });
  }, [label, value]);
  await page.evaluate(() => {
    let left = 380;
    const step = () => { if (left <= 0) return; window.__vt.advance(16); left -= 16; requestAnimationFrame(step); };
    step();
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 240000 });
  console.log("saved " + name);
  await page.evaluate(() => { let l = 2200; const s = () => { if (l <= 0) return; window.__vt.advance(60); l -= 60; requestAnimationFrame(s); }; s(); });
  await page.waitForTimeout(900);
}
await browser.close();
