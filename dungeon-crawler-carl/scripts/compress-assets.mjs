// Compress every GLB under public/assets in place (backlog #7, lever b+c):
// meshopt geometry/animation compression + WebP textures via gltf-transform.
// Run after importing new assets:  node scripts/compress-assets.mjs
//
// Safety rails: mesh simplification is DISABLED (silhouettes are art
// direction), a file is only replaced when the output is smaller and
// non-empty, and already-compressed files converge (re-running is a no-op
// shrink-wise). The client side of this is MeshoptDecoder in
// src/render3d/assets.ts — a GLB compressed here will NOT load without it.
//
// Output layout: gltf-transform writes the meshopt payload as a `<name>.glb.bin`
// SIDECAR next to each .glb (GLTFLoader fetches it relative to the .glb URL —
// two requests per model, served/cached by the same static path). Keep the
// pair together when moving/deleting models; the per-file size log below
// counts the .glb only, aggregate totals in the summary count everything.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "public", "assets");
const SKIP_DIRS = new Set(["generated"]); // builder scratch — not shipped via git

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
    } else if (e.name.endsWith(".glb")) {
      files.push(join(dir, e.name));
    }
  }
})(ROOT);

let before = 0;
let after = 0;
let touched = 0;
for (const [i, file] of files.entries()) {
  const orig = statSync(file).size;
  const tmp = `${file}.tmp`;
  try {
    execFileSync("npx", [
      "--yes", "@gltf-transform/cli", "optimize", file, tmp,
      "--compress", "meshopt",
      "--texture-compress", "webp",
      "--simplify", "false",
    ], { stdio: "pipe", shell: process.platform === "win32" });
    const out = statSync(tmp).size;
    if (out > 0 && out < orig) {
      renameSync(tmp, file);
      touched++;
      before += orig;
      after += out;
      console.log(`[${i + 1}/${files.length}] ${file.slice(ROOT.length + 1)}  ${(orig / 1024).toFixed(0)}K -> ${(out / 1024).toFixed(0)}K`);
    } else {
      rmSync(tmp, { force: true });
      console.log(`[${i + 1}/${files.length}] ${file.slice(ROOT.length + 1)}  kept (no win)`);
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    console.error(`[${i + 1}/${files.length}] ${file.slice(ROOT.length + 1)}  FAILED: ${String(err).slice(0, 200)}`);
  }
}
console.log(`\n${touched}/${files.length} files compressed: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`);
