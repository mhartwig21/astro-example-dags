#!/usr/bin/env node
/**
 * FONT SUBSET + WOFF2 — public/fonts/*.ttf -> public/fonts/*.woff2
 *
 * The four TTFs shipped 928 KB raw / 446 KB gzipped on the wire, and roughly
 * half of every Alegreya Sans file is script coverage this game cannot render:
 * full Cyrillic (184 cps), Greek Extended / polytonic (233), Latin Extended
 * Additional / Vietnamese (164), IPA Extensions (66). The UI is English; the
 * only free text a player can enter is a 24-char crawler name.
 *
 * KEEP SET (deliberately generous — the risky glyphs are the cheap ones):
 *   U+0020..U+00FF  Basic Latin + Latin-1 Supplement (accented European names)
 *   U+0100..U+017F  Latin Extended-A (the rest of European Latin: š ż ā ő …)
 *   U+0300..U+036F  Combining diacriticals (so a decomposed name still stacks)
 *   U+2000..U+FFFF  EVERY symbol the font actually has above U+2000.
 *                   This is the important one. iso.html and main3d.ts type
 *                   — § · → ─ × … ✕ ◆ ± ≈ ° ≤ ≥ │ ▼ ™ ← ▶ ☰ ↔ ● ┌ ┐ └ ┘ and
 *                   more directly into the DOM. Dropping one would silently
 *                   swap that character to a fallback font mid-sentence, which
 *                   is exactly the visible degradation the owner rejects. All
 *                   of them together are ~120 glyphs, so keeping the lot costs
 *                   almost nothing and removes the whole class of mistake.
 *
 * What we drop is only ever a whole script the game has no way to display.
 *
 * LICENSE (ASSETS.md): Cinzel and Alegreya Sans are OFL 1.1 with NO Reserved
 * Font Name, so subsetting is permitted. It IS a modification, so ASSETS.md
 * records it and the family names in the `name` table are preserved unchanged.
 *
 * TOOLING: this worktree's node_modules is a junction shared with sibling
 * worktrees, so `subset-font` (harfbuzzjs + wawoff2) is NOT a dependency here.
 * Install it once in a scratch directory and point this script at it:
 *
 *   mkdir -p ~/.dcc-fonttool && cd ~/.dcc-fonttool && npm i subset-font
 *   SUBSET_FONT_DIR=~/.dcc-fonttool node tools/subset-fonts.mjs
 *
 * Re-run only when a font file changes; the .woff2 outputs are committed.
 *
 * The unmodified upstream TTFs live in `tools/fonts-src/`, NOT in `public/` —
 * they are build input, and 900 KB of never-requested bytes has no business in
 * the served tree (or in the deploy image, or in the precompression pass).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const SRC_DIR = resolve(process.cwd(), "tools/fonts-src");
const OUT_DIR = resolve(process.cwd(), "public/fonts");

const extra = process.env.SUBSET_FONT_DIR;
let subsetFont;
for (const base of [process.cwd(), extra].filter(Boolean)) {
  try {
    const p = join(resolve(base), "node_modules/subset-font/index.js");
    statSync(p);
    subsetFont = (await import(pathToFileURL(p).href)).default;
    break;
  } catch {
    /* try the next one */
  }
}
if (!subsetFont) {
  console.error(
    "subset-font not found. Do NOT `npm i` in this worktree (node_modules is a\n" +
      "shared junction). Instead:\n" +
      "  mkdir -p ~/.dcc-fonttool && cd ~/.dcc-fonttool && npm i subset-font\n" +
      "  SUBSET_FONT_DIR=~/.dcc-fonttool node tools/subset-fonts.mjs",
  );
  process.exit(1);
}

/** Codepoints a TTF's cmap maps (format 4 + 12). */
function coverage(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let cmapOff = 0;
  for (let i = 0, n = dv.getUint16(4); i < n; i++) {
    const o = 12 + i * 16;
    if (String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]) === "cmap") cmapOff = dv.getUint32(o + 8);
  }
  let best = 0;
  for (let i = 0, n = dv.getUint16(cmapOff + 2); i < n; i++) {
    const o = cmapOff + 4 + i * 8;
    const pid = dv.getUint16(o);
    const eid = dv.getUint16(o + 2);
    if ((pid === 3 && (eid === 1 || eid === 10)) || pid === 0) best = cmapOff + dv.getUint32(o + 4);
  }
  const fmt = dv.getUint16(best);
  const cps = new Set();
  if (fmt === 4) {
    const segX2 = dv.getUint16(best + 6);
    for (let s = 0; s < segX2 / 2; s++) {
      const end = dv.getUint16(best + 14 + s * 2);
      const start = dv.getUint16(best + 16 + segX2 + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c < 0xffff; c++) cps.add(c);
    }
  } else if (fmt === 12) {
    for (let g = 0, ng = dv.getUint32(best + 12); g < ng; g++) {
      const o = best + 16 + g * 12;
      for (let c = dv.getUint32(o), e = dv.getUint32(o + 4); c <= e; c++) cps.add(c);
    }
  }
  return cps;
}

const KEEP_RANGES = [
  [0x0020, 0x00ff],
  [0x0100, 0x017f],
  [0x0300, 0x036f],
  [0x2000, 0xffff], // "everything symbolic the font happens to have"
];
const keeps = (cp) => KEEP_RANGES.some(([a, b]) => cp >= a && cp <= b);

const rows = [];
for (const name of readdirSync(SRC_DIR).filter((f) => f.endsWith(".ttf")).sort()) {
  const src = readFileSync(join(SRC_DIR, name));
  const have = coverage(src);
  const keep = [...have].filter(keeps).sort((a, b) => a - b);
  const text = keep.map((c) => String.fromCodePoint(c)).join("");
  const out = await subsetFont(src, text, { targetFormat: "woff2" });
  const dest = name.replace(/\.ttf$/, ".woff2");
  writeFileSync(join(OUT_DIR, dest), out);
  rows.push({
    name,
    dest,
    cpsBefore: have.size,
    cpsAfter: keep.length,
    ttf: src.length,
    ttfGz: gzipSync(src, { level: 9 }).length,
    woff2: out.length,
  });
}

const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(28)} ${String(r.cpsBefore).padStart(5)} -> ${String(r.cpsAfter).padStart(4)} cps   ` +
      `${(r.ttf / 1024).toFixed(1).padStart(7)} KB ttf (${(r.ttfGz / 1024).toFixed(1)} gz) -> ` +
      `${(r.woff2 / 1024).toFixed(1)} KB woff2`,
  );
}
console.log(
  `TOTAL  raw ${(sum("ttf") / 1024).toFixed(1)} KB / wire ${(sum("ttfGz") / 1024).toFixed(1)} KB gz` +
    `  ->  woff2 ${(sum("woff2") / 1024).toFixed(1)} KB  ` +
    `(-${(100 - (sum("woff2") / sum("ttfGz")) * 100).toFixed(1)}% on the wire)`,
);
