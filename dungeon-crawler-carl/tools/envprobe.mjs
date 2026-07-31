// Env-track debug probe: one page load, several screenshots with live
// scene-graph toggles via ?debug=1 window.__dcc — identifies which layer
// paints the unexplored murk. Usage: node tools/envprobe.mjs [outDir]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots";
const URL = "http://localhost:5285/iso.html?test&debug=1&floor=2&level=4&seed=41&eagerassets";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(URL, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 180000 });
await page.waitForTimeout(6000);

async function shot(name, js) {
  if (js) await page.evaluate(js);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 240000 });
  console.log("saved", name);
}

await shot("envprobe-base", null);
// Silhouette source test: turn the world-lit fog dark RED.
await shot("envprobe-reddark", `(() => {
  const r = window.__dcc.renderer;
  r.wl.uWlDark.value.setRGB(1.0, 0.0, 0.0);
})()`);
// Fog bank planes off.
await shot("envprobe-nobank", `(() => {
  const r = window.__dcc.renderer;
  r.wl.uWlDark.value.setRGB(0.0036, 0.003, 0.0078);
  r.fogBank.group.visible = false;
})()`);
// Grade shadow lift off.
await shot("envprobe-nograde", `(() => {
  const r = window.__dcc.renderer;
  r.fogBank.group.visible = true;
  r.gradePass.uniforms.uShadow.value.setRGB(0, 0, 0);
})()`);
await browser.close();
