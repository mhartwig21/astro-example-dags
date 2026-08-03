// Side-by-side 1:1 crops of the same frozen frame under MEDIUM and HIGH, so the
// acutance number can be checked by eye. One browser, all crops.
// Usage: node tools/acc2_crop.mjs <base> <scene> <x> <y> <w> <h>
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const [base, scene, x, y, w, h, zoomArg, tagArg] = process.argv.slice(2);
const zoom = Number(zoomArg || 1);
const tag = tagArg || "SHEET";
const modes = ["low", "medium", "high"];
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  const b64s = Object.fromEntries(modes.map((m) => [m, readFileSync(`${base}_${scene}_${m}.png`).toString("base64")]));
  const data = await page.evaluate(async ({ b64s, modes, x, y, w, h, zoom }) => {
    const load = async (b) => { const i = new Image(); i.src = `data:image/png;base64,${b}`; await i.decode(); return i; };
    const pad = 8, labelH = 30;
    const dw = Math.round(w * zoom), dh = Math.round(h * zoom);
    const c = document.createElement("canvas");
    c.width = dw * modes.length + pad * (modes.length + 1);
    c.height = dh + labelH + pad * 2;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false; // NEAREST: do not invent detail either way
    g.fillStyle = "#101014"; g.fillRect(0, 0, c.width, c.height);
    g.font = "600 20px system-ui, sans-serif";
    for (let i = 0; i < modes.length; i++) {
      const img = await load(b64s[modes[i]]);
      const dx = pad + i * (dw + pad);
      g.drawImage(img, x, y, w, h, dx, labelH + pad, dw, dh);
      g.fillStyle = "#ffe9b0";
      g.fillText(modes[i].toUpperCase(), dx, labelH - 4);
      g.strokeStyle = "#3a3a44"; g.strokeRect(dx, labelH + pad, dw, dh);
    }
    return c.toDataURL("image/png").split(",")[1];
  }, { b64s, modes, x: +x, y: +y, w: +w, h: +h, zoom });
  writeFileSync(`${base}_${scene}_${tag}.png`, Buffer.from(data, "base64"));
  console.log(`wrote ${base}_${scene}_${tag}.png`);
} finally { await browser.close(); }
