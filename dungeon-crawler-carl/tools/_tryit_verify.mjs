// TRY-IT INTEGRATION VERIFY — one browser, the PRODUCTION build, the SHIPPING
// server (vite preview is banned on this project: it serves GLB
// identity-encoded without the precompressed sidecars).
//
//   node tools/_tryit_verify.mjs
//
// Confirms, on http://localhost:5290/iso.html:
//   * boots to the menu on a genuinely cold profile
//   * a fresh run reaches floor 1 with Mordecai's strip + the objectives card
//   * every .glb/.woff2/.ogg the page asks for came back 200 (a broken decoder
//     shows as ABSENT GEOMETRY, not an error, so the mesh count is read too)
//   * the four subset faces actually loaded (tofu = a face that never loaded)
//   * no console errors
// and then the same on the floor-10 test URL.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://localhost:5290";
const OUT = path.resolve(process.cwd(), "tools/_shots/tryit");
fs.mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(m);
const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();

const errors = [];
const bad = [];
const net = { glb: 0, woff2: 0, ogg: 0, png: 0 };
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 300)));
page.on("response", (r) => {
  const u = new URL(r.url()).pathname;
  const ext = (u.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (ext in net) net[ext]++;
  if (r.status() >= 400) bad.push(`${r.status()} ${u}`);
});

const shot = async (name) => {
  const f = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: f });
  log(`  shot -> ${f}`);
};

// Everything the scene actually put on the GPU, read from the renderer's own
// scene graph rather than inferred from network traffic: a GLB that arrives
// but fails to decode is a 200 with no geometry.
const SCENE = `(() => {
  const rr = window.__dcc?.renderer;
  const r = rr?.scene ?? rr?.["scene"] ?? null;
  let meshes = 0, skinned = 0, tris = 0;
  const walk = (o) => {
    if (!o) return;
    if (o.isSkinnedMesh) skinned++;
    if (o.isMesh || o.isInstancedMesh) {
      meshes++;
      const g = o.geometry;
      const n = g && (g.index ? g.index.count : g.attributes?.position?.count) || 0;
      tris += (n / 3) * (o.isInstancedMesh ? (o.count || 1) : 1);
    }
    (o.children || []).forEach(walk);
  };
  if (r) walk(r);
  return { hasScene: !!r, meshes, skinned, tris: Math.round(tris) };
})()`;

const FONTS = `(async () => {
  await document.fonts.ready;
  const faces = [...document.fonts].map(f => ({ family: f.family, weight: f.weight, style: f.style, status: f.status }));
  // Tofu detection that does not need pixels: measure a glyph in the webfont
  // and in a guaranteed-different fallback. Equal widths across MANY glyphs
  // means the webfont never applied and the fallback is drawing everything.
  const measure = (font, text) => {
    const c = document.createElement("canvas").getContext("2d");
    c.font = font; return c.measureText(text).width;
  };
  const probe = "THE SYSTEM — RINGSIDE INTRODUCTIONS · 1234567890";
  return {
    faces,
    status: document.fonts.status,
    cinzelApplied: measure('700 40px Cinzel, monospace', probe) !== measure('700 40px monospace', probe),
    alegreyaApplied: measure('400 40px "Alegreya Sans", monospace', probe) !== measure('400 40px monospace', probe),
    checks: {
      cinzel: document.fonts.check('700 40px Cinzel'),
      alegreya: document.fonts.check('400 40px "Alegreya Sans"'),
      alegreyaBold: document.fonts.check('700 40px "Alegreya Sans"'),
      alegreyaItalic: document.fonts.check('italic 400 40px "Alegreya Sans"'),
    },
  };
})()`;

async function settle(url, label) {
  log(`\n== ${label}: ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
    null, { timeout: 240000 }).catch(() => log("  WARN assets never settled"));
  await page.waitForFunction(() => {
    const l = document.getElementById("loading");
    return !l || l.classList.contains("done") || getComputedStyle(l).display === "none";
  }, null, { timeout: 240000 }).catch(() => log("  WARN loading never cleared"));
  await page.waitForTimeout(3000);
}

// ---------------------------------------------------------------- COLD BOOT
await ctx.clearCookies();
await page.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
await settle(`${BASE}/iso.html?debug=1&eagerassets`, "COLD BOOT (fresh profile)");

const cold = await page.evaluate(() => ({
  save: localStorage.getItem("dcc:save:v1"),
  hist: localStorage.getItem("dcc:history:v1"),
}));
log(`  cold profile: save=${cold.save} history=${cold.hist}`);
const fonts = await page.evaluate(FONTS);
log(`  fonts: status=${fonts.status} loadedFaces=${fonts.faces.filter(f => f.status === "loaded").length}/${fonts.faces.length}`);
log(`  fonts applied: Cinzel=${fonts.cinzelApplied} AlegreyaSans=${fonts.alegreyaApplied}  checks=${JSON.stringify(fonts.checks)}`);
await shot("01_menu");

// -------------------------------------------------------------- START A RUN
await page.evaluate(() => document.getElementById("m-solo")?.click());
await page.waitForTimeout(2000);
await shot("02_casting");
await page.evaluate(() => {
  const g = document.getElementById("m-cast-go");
  if (g && g.getBoundingClientRect().width > 2) g.click();
});
await page.waitForTimeout(3000);

for (let i = 0; i < 10; i++) {
  const open = await page.evaluate(() => {
    const el = document.getElementById("dialogue");
    return !!el && getComputedStyle(el).display !== "none";
  });
  if (!open) break;
  if (i === 0) await shot("03_campfire");
  await page.keyboard.press("1");
  await page.waitForTimeout(1200);
}
await page.waitForTimeout(4000);

const teach = await page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 2;
  const objEl = document.getElementById("objectives");
  const tutEl = document.getElementById("tutorial");
  return {
    objectivesVisible: vis(objEl),
    objTitle: (document.querySelector("#objectives .obj-title")?.textContent ?? "").trim(),
    objItems: [...document.querySelectorAll("#objectives .obj-items li")].map((e) => e.textContent.trim()),
    stripVisible: vis(tutEl),
    strip: [...document.querySelectorAll("#tutorial .tut")].map((e) => e.textContent.trim().slice(0, 220)),
    floor: (document.querySelector("#hud-floor, .hud-floor")?.textContent ?? "").trim(),
  };
});
log(`  objectives card visible=${teach.objectivesVisible} title=${JSON.stringify(teach.objTitle)}`);
log(`  objectives items: ${JSON.stringify(teach.objItems)}`);
log(`  Mordecai strip visible=${teach.stripVisible} lines=${JSON.stringify(teach.strip)}`);
await shot("04_floor1_tutorial");

const s1 = await page.evaluate(SCENE);
log(`  scene: ${JSON.stringify(s1)}`);

// ------------------------------------------------------------- FLOOR 10 TEST
await settle(`${BASE}/iso.html?test&floor=10&level=14&abilities=all&gold=500&seed=42&debug=1&eagerassets`, "FLOOR 10 TEST MODE");
await page.waitForTimeout(2500);
await shot("05_floor10");
// walk into the room so the fight is on screen, then shoot again
for (const k of ["KeyW", "KeyD"]) {
  await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k);
}
await page.waitForTimeout(1500);
await page.keyboard.press("Space");
await page.waitForTimeout(1200);
await shot("06_floor10_combat");
const s2 = await page.evaluate(SCENE);
log(`  scene: ${JSON.stringify(s2)}`);

// -------------------------------------------------------------------- VERDICT
log(`\n== NETWORK: ${JSON.stringify(net)}`);
log(`== FAILED RESPONSES (${bad.length}): ${JSON.stringify(bad.slice(0, 20))}`);
log(`== CONSOLE ERRORS (${errors.length}):`);
for (const e of errors.slice(0, 20)) log(`   ${e}`);

await browser.close();
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(
  { cold, fonts, teach, scene: { menu: s1, floor10: s2 }, net, bad, errors }, null, 2));
log(`\nreport -> ${path.join(OUT, "report.json")}`);
process.exit(errors.length || bad.length ? 1 : 0);
