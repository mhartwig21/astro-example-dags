// BRUTEPROBE — inspect a live brute's materials to find the fullbright bug.
import { chromium } from "playwright";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE:", m.text().slice(0, 300)); });
await page.goto("http://localhost:5285/iso.html?test&debug=1&clean=1&floor=6&level=14&seed=77&eagerassets", { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 150000 });
await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 90000 });
await page.waitForTimeout(3000);

const out = await page.evaluate(() => {
  const dcc = window.__dcc;
  const st = dcc.state;
  const r = dcc.renderer;
  // Teleport near a brute so its mesh instantiates.
  const brute = st.monsters.find((m) => m.kind === "brute" && m.hp > 0);
  const p = st.players[0];
  if (brute) { p.pos.x = brute.pos.x + 1.5; p.pos.y = brute.pos.y; }
  return { hasBrute: !!brute, kinds: [...new Set(st.monsters.map((m) => m.kind))] };
});
console.log("state:", JSON.stringify(out));
await page.waitForTimeout(3500);

const probe = await page.evaluate(() => {
  const dcc = window.__dcc;
  const st = dcc.state;
  const r = dcc.renderer;
  const brute = st.monsters.find((m) => m.kind === "brute" && m.hp > 0);
  if (!brute) return { err: "no brute" };
  const mesh = r.monsters && r.monsters.get ? r.monsters.get(brute.id) : null;
  if (!mesh) return { err: "no mesh for brute id " + brute.id, ids: r.monsters ? [...r.monsters.keys()] : null };
  const mats = [];
  mesh.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      mats.push({
        node: o.name, type: m.type, std: !!m.isMeshStandardMaterial,
        color: m.color ? "#" + m.color.getHexString() : null,
        map: m.map ? { src: (m.map.image && (m.map.image.src || m.map.image.currentSrc || m.map.image.constructor.name)) || "?", cs: m.map.colorSpace, flipY: m.map.flipY, minF: m.map.minFilter, magF: m.map.magFilter, mips: !!m.map.generateMipmaps } : null,
        emissive: m.emissive ? "#" + m.emissive.getHexString() : null,
        emissiveIntensity: m.emissiveIntensity,
        hasOBC: Object.prototype.hasOwnProperty.call(m, "onBeforeCompile"),
        cacheKey: m.customProgramCacheKey ? m.customProgramCacheKey() : null,
        vertexColors: m.vertexColors,
      });
    }
  });
  // Also check model registry entry
  const modelKeys = Object.keys(r.models || {}).filter((k) => k.includes("brute"));
  return { bruteId: brute.id, elite: !!brute.elite, ud: { hasFlashMats: !!mesh.userData.flashMats, flashEnv: mesh.userData.flashEnv, charShade: mesh.userData.charShade }, mats, modelKeys };
});
console.log(JSON.stringify(probe, null, 1));
await page.screenshot({ path: "C:/Users/hartw/.claude/jobs/3a9dd2e4/tmp/shots/bruteprobe.png" });
await browser.close();
