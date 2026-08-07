#!/usr/bin/env node
/**
 * tools/_crop.mjs — magnify a region of a captured PNG so a frame can be READ
 * rather than glanced at. No image library in the tree, so this uses the one
 * renderer we already depend on: draw the file into a canvas at scale and
 * screenshot the result. Read-only; ONE browser, closed in a finally.
 *
 * Usage: node tools/_crop.mjs IN.png OUT.png X Y W H [SCALE]
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [inp, outp, x, y, w, h, scale = "3"] = process.argv.slice(2);
const S = Number(scale), X = Number(x), Y = Number(y), W = Number(w), H = Number(h);
const b64 = readFileSync(resolve(inp)).toString("base64");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: Math.ceil(W * S), height: Math.ceil(H * S) } });
  await page.setContent(`<style>html,body{margin:0;background:#000}canvas{display:block}</style><canvas id=c></canvas>`);
  await page.evaluate(async ({ b64, X, Y, W, H, S }) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.getElementById("c");
    c.width = W * S; c.height = H * S;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.drawImage(img, X, Y, W, H, 0, 0, W * S, H * S);
  }, { b64, X, Y, W, H, S });
  await page.screenshot({ path: resolve(outp) });
  console.error(`wrote ${outp} (${W}x${H} @${S}x)`);
} finally {
  await browser.close();
}
