import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("http://localhost:5285/iso.html?test&debug=1&clean=1&floor=14&level=18&seed=51&eagerassets", { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 150000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
await page.waitForTimeout(2500);
// Find a group prop entry with a >2-tile-wide child (the channel) and teleport there.
const spot = await page.evaluate(() => {
  const r = window.__dcc.renderer;
  const st = window.__dcc.state;
  for (const e of r.propEntries ?? []) {
    let found = null;
    e.obj.traverse((m) => {
      if (m.isMesh && m.geometry?.type === "PlaneGeometry" && m.material?.emissiveMap) found = true;
    });
    if (found && !e.obj.userData.modelKey) return { x: e.obj.position.x, y: e.obj.position.z };
  }
  return null;
});
if (spot) {
  await page.evaluate((s) => {
    const st = window.__dcc.state;
    st.players[0].pos.x = s.x + 1.5;
    st.players[0].pos.y = s.y + 2.0;
  }, spot);
  await page.waitForTimeout(4000);
}
console.log("channel at:", JSON.stringify(spot));
await page.screenshot({ path: "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots/probe-f14-channel.png", timeout: 240000 });
await browser.close();
