// Dead-simple static server for A/B-ing two production builds.
//
// WHY NOT `vite preview`: its `--outDir` flag is a BUILD option. Preview reads
// `build.outDir` from vite.config.ts (hard-coded "dist" here), so every
// `vite preview --outDir dist-whatever --port N` in this repo silently serves
// `dist` — every port shows the same bundle and an A/B compares a build with
// itself. This was already noted once in this job ("two ports pointed at the
// same dist serve the SAME build") and the --outDir workaround does not fix it.
// Verify with: curl -s localhost:PORT/iso.html | grep -o 'assets/iso-[^"]*'
// Two ports MUST report different hashes.
//
// Usage: node tools/serve.mjs <dir> <port>
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, normalize } from "node:path";

const dir = resolve(process.argv[2]);
const port = Number(process.argv[3]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",   // ES modules 404 the app if this is wrong
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ktx2": "image/ktx2", ".bin": "application/octet-stream", ".wasm": "application/wasm",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    // normalize + prefix check: no path traversal out of the served build.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let file = join(dir, rel);
    if (!file.startsWith(dir)) { res.writeHead(403).end("forbidden"); return; }
    const s = await stat(file).catch(() => null);
    if (s?.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store", // a stale bundle is exactly the bug this file exists to prevent
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
})
  // BIND 127.0.0.1 EXPLICITLY, AND DIE IF THE PORT IS TAKEN. Several agents
  // share this machine and leave servers running. Node's default bind is the
  // IPv6 wildcard, and Windows lets that SUCCEED while another process already
  // owns the same port on IPv4 — so `listen` logs "serving", `curl localhost`
  // (which resolves to 127.0.0.1) reaches the OTHER process, and the A/B
  // silently measures someone else's build. That happened in this job: a
  // "baseline" port served a bundle hash that existed only in another agent's
  // dist-final. Failing loudly here is the whole point.
  .on("error", (e) => {
    console.error(`FATAL: cannot serve ${dir} on ${port}: ${e.message}`);
    process.exit(1);
  })
  .listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port}`));
