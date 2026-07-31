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
// Output layout: ONE self-contained .glb per model, everything embedded.
// The temp output MUST end in ".glb" — gltf-transform picks the container
// from the extension, and any other suffix silently switches to JSON glTF
// with EXTERNAL resources named from the texture slot ("baseColor.webp").
// Those names collide across models in a directory, so a batch run makes
// every model overwrite its neighbors' textures with its own — this is not
// hypothetical, it blacked out every textured prop in the July 2026 diet.
// The verify() guard below rejects any output that isn't a binary GLB or
// that references external URIs, so the failure mode is loud now.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "public", "assets");
const SKIP_DIRS = new Set(["generated"]); // builder scratch — not shipped via git

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
    } else if (e.name.endsWith(".glb") && !e.name.endsWith(".tmp.glb")) {
      // .tmp.glb = leftovers from an interrupted run, not models
      files.push(join(dir, e.name));
    }
  }
})(ROOT);

/**
 * A compressed model must be a SELF-CONTAINED binary GLB: "glTF" magic and a
 * JSON chunk with no buffer/image `uri` entries. External resources are how
 * the texture-collision disaster happened (header comment).
 */
function verify(file) {
  const buf = readFileSync(file);
  if (buf.length < 20 || buf.toString("latin1", 0, 4) !== "glTF") {
    throw new Error("output is not a binary GLB container");
  }
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  for (const b of json.buffers ?? []) {
    if (b.uri) throw new Error(`output references external buffer ${b.uri}`);
  }
  for (const img of json.images ?? []) {
    if (img.uri) throw new Error(`output references external image ${img.uri}`);
  }
}

let before = 0;
let after = 0;
let touched = 0;
for (const [i, file] of files.entries()) {
  const orig = statSync(file).size;
  const tmp = file.replace(/\.glb$/, ".tmp.glb"); // MUST end in .glb (header comment)
  try {
    execFileSync("npx", [
      "--yes", "@gltf-transform/cli", "optimize", file, tmp,
      "--compress", "meshopt",
      "--texture-compress", "webp",
      "--simplify", "false",
    ], { stdio: "pipe", shell: process.platform === "win32" });
    verify(tmp);
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
