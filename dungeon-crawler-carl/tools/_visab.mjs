// REAL-GPU visual A/B. shot.mjs/beautyshot.mjs run SwiftShader; GTAO's
// depth-reconstructed normals and SMAA both behave differently there, so the
// comparison that matters has to run on ANGLE/D3D11 like gpuprobe does.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const flag = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const out = flag("--out", "tools/_visab");
mkdirSync(out, { recursive: true });
const floor = flag("--floor", "8");
const seed = flag("--seed", "41");

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization", "--disable-frame-rate-limit", "--disable-gpu-vsync"],
});

async function shoot(tag, base, extra = "") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 852 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error(`${tag} PAGE ERROR:`, e.message));
  const url = `${base}/iso.html?test&floor=${floor}&level=16&seed=${seed}&abilities=all&eagerassets&debug=1${extra}`;
  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(Number(flag("--wait", 9000)));
  const info = await page.evaluate(() => {
    const r = window.__dcc?.renderer;
    return {
      preset: r?.quality?.name ?? "n/a",
      pixelRatio: r?.renderer?.getPixelRatio?.(),
      gtao: r?.gtao?.enabled,
      normalVectorType: r?.gtao?.gtaoMaterial?.defines?.NORMAL_VECTOR_TYPE,
      gtaoSamples: r?.gtao?.gtaoMaterial?.defines?.SAMPLES,
      msaa: r?.composer?.renderTarget1?.samples,
      smaa: r?.smaa?.enabled ?? "absent",
    };
  });
  console.log(tag, JSON.stringify(info));
  await page.screenshot({ path: `${out}/${tag}.png` });
  // Also grab an AO-only view where the build supports it (OUTPUT.Denoise = 3).
  await page.evaluate(() => { const g = window.__dcc?.renderer?.gtao; if (g) g.output = 3; });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${tag}-ao.png` });
  await page.close();
  return info;
}

// The deployed reference build (no quality ladder — one fixed config).
await shoot("A-shipped-5291", "http://localhost:5291");
// Mine, pinned to ULTRA (the rung that is supposed to be visually identical).
await shoot("B-mine-ultra", "http://localhost:5294", "&quality=ultra");
await shoot("C-mine-balanced", "http://localhost:5294", "&quality=balanced");
await browser.close();
