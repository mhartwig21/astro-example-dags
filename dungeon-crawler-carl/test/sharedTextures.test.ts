import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SHARED_TEXTURES } from "../src/render3d/sharedTextures";

// THE GUARD ON DEDUPLICATED PROP TEXTURES.
//
// A KayKit pack ships one atlas, so the same image was embedded in every prop
// that used it — the dungeon atlas in 57 separate GLBs, a banner atlas in 32, a
// cliff atlas in 29. WebP is already compressed and each GLB is gzipped on its
// own, so transport compression could not see those copies: they were 1.78 MB
// of real wire cost. The shared images now live once under `public/assets/tex/`
// and the models reference them by a relative `../tex/…` URI.
//
// That leans on three contracts a future asset drop could break silently, none
// of which throws at runtime — a broken texture reference just renders the prop
// untextured, which no exception and no test of the sim would ever notice:
//
//  1. Every `../tex/` URI resolves to a file that exists.
//  2. Every file in `assets/tex/` is named `t.<first 8 hex of its own sha256>`.
//     The name IS the cache key: `vite.config.ts` deliberately SKIPS this tree
//     in its content-hash rename (the URIs are baked inside the GLBs, where no
//     build-time rewrite can reach them), and gameServer's `selfDescribing`
//     test is what grants `immutable` for a year. A hand-renamed file would be
//     served stale forever, or would break all its referencing models.
//  3. `SHARED_TEXTURES` (which the loader prewarms so the duplicate requests
//     are cache hits rather than downloads) matches what is actually on disk.
//
// Regenerate all three with: node tools/asset-pipeline/dedupe-textures.mjs --apply

const ROOT = path.resolve(__dirname, "..");
const TEX = path.join(ROOT, "public/assets/tex");
const ASSETS = path.join(ROOT, "public/assets");

function glbs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "tex") glbs(p, out); }
    else if (e.name.endsWith(".glb")) out.push(p);
  }
  return out;
}
function imagesOf(file: string): { uri?: string; bufferView?: number }[] {
  const buf = fs.readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), s = off + 8;
    if (type === 0x4e4f534a) {
      return (JSON.parse(buf.slice(s, s + len).toString("utf8")).images ?? []) as { uri?: string }[];
    }
    off = s + len;
    if (off % 4) off += 4 - (off % 4);
  }
  return [];
}

describe("deduplicated shared prop textures", () => {
  const files = glbs(ASSETS);

  it("every ../tex/ reference in every GLB resolves to a file that exists", () => {
    const missing: string[] = [];
    let refs = 0;
    for (const f of files) {
      for (const img of imagesOf(f)) {
        if (!img.uri) continue;
        // The URI must stay RELATIVE: three's LoaderUtils.resolveURL does not
        // special-case a root-absolute path, it returns `path + url`, so
        // "/assets/tex/x" would resolve to "/assets/dungeon//assets/tex/x".
        expect(img.uri.startsWith("../tex/"), `${path.basename(f)} has non-relative image uri ${img.uri}`).toBe(true);
        refs++;
        if (!fs.existsSync(path.join(TEX, img.uri.slice("../tex/".length)))) {
          missing.push(`${path.basename(f)} -> ${img.uri}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(refs).toBeGreaterThan(0); // the scheme is in use at all
  });

  it("every shared texture is named by 8 hex of its own content hash", () => {
    const wrong: string[] = [];
    for (const n of fs.readdirSync(TEX)) {
      const want = crypto.createHash("sha256").update(fs.readFileSync(path.join(TEX, n))).digest("hex").slice(0, 8);
      const ext = n.slice(n.lastIndexOf("."));
      if (n !== `t.${want}${ext}`) wrong.push(`${n} should be t.${want}${ext}`);
    }
    expect(wrong).toEqual([]);
  });

  it("the loader's prewarm list matches the files on disk", () => {
    const onDisk = fs.readdirSync(TEX).map((n) => `/assets/tex/${n}`).sort();
    expect([...SHARED_TEXTURES].sort()).toEqual(onDisk);
  });

  it("no shared texture is orphaned — each is referenced by 2+ models", () => {
    const used = new Map<string, number>();
    for (const f of files) {
      for (const img of imagesOf(f)) {
        if (!img.uri?.startsWith("../tex/")) continue;
        const n = img.uri.slice("../tex/".length);
        used.set(n, (used.get(n) ?? 0) + 1);
      }
    }
    // Externalising a single-use image would cost a round trip and save no
    // bytes, so the pipeline only ever extracts images shared by 2 or more.
    const bad = [...fs.readdirSync(TEX)].filter((n) => (used.get(n) ?? 0) < 2)
      .map((n) => `${n} used by ${used.get(n) ?? 0} model(s)`);
    expect(bad).toEqual([]);
  });
});
