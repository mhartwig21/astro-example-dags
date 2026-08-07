import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, renameSync } from "node:fs";

/**
 * DCC builder bridge — DEV ONLY. Lets /builder.html kick off Meshy pipeline
 * runs on this machine (the pipeline is Python + Blender; a browser can't
 * shell out). Finished assets land in public/assets/generated/ with an
 * index.json the game's loader consumes, so nothing here ships to prod:
 * the deployed builder page simply detects the bridge is absent.
 *
 * Routes: GET /__builder/ping · GET /__builder/jobs ·
 *         POST /__builder/generate {kind: "prop"|"creature", id, prompt}
 */
function builderBridge(): Plugin {
  interface Job { id: string; kind: string; status: "running" | "done" | "failed"; detail: string }
  const jobs = new Map<string, Job>();
  const pipeline = resolve(__dirname, "tools/asset-pipeline");
  const genDir = resolve(__dirname, "public/assets/generated");
  const indexPath = join(genDir, "index.json");
  const readIndex = (): Record<string, unknown> =>
    existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : {};
  const writeIndex = (ix: Record<string, unknown>): void => {
    mkdirSync(genDir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify(ix, null, 2));
  };

  const runJob = (kind: string, id: string, prompt: string, extra?: { clips?: string; source?: string }): void => {
    const job: Job = { id, kind, status: "running", detail: "generating (minutes)…" };
    jobs.set(id, job);
    const args = kind === "creature"
      ? ["orchestrator/creature.py", "--id", id, "--prompt", prompt, "--out", `out/${id}`,
        ...(extra?.clips ? ["--clips", extra.clips] : [])]
      : kind === "retexture"
        ? ["orchestrator/retexture.py", "--input", join(genDir, `${extra?.source}.glb`),
          "--prompt", prompt, "--out", `out/${id}/${id}.glb`]
        : ["orchestrator/run.py", "--manifest", `out/__bridge_${id}.json`];
    if (kind === "prop") {
      // One-off manifest for the prop runner.
      mkdirSync(join(pipeline, "out"), { recursive: true });
      writeFileSync(join(pipeline, `out/__bridge_${id}.json`), JSON.stringify({
        defaults: { art_style: "realistic", target_polycount: 2500, topology: "triangle", max_tris: 8000 },
        assets: [{ id, type: "prop", prompt: `${prompt}, stylized game asset, chunky proportions, flat colors`, target_height: 1.0 }],
      }));
    }
    const child = spawn("python", args, { cwd: pipeline, env: process.env });
    let log = "";
    child.stdout.on("data", (c) => (log += c));
    child.stderr.on("data", (c) => (log += c));
    child.on("close", (code) => {
      try {
        if (code !== 0) throw new Error(log.slice(-400));
        const ix = readIndex();
        if (kind === "creature") {
          const outDir = join(pipeline, "out", id);
          const destDir = join(genDir, id);
          mkdirSync(destDir, { recursive: true });
          const clips: string[] = [];
          for (const f of readdirSync(outDir)) {
            if (!f.endsWith(".glb") || f.endsWith("_raw.glb")) continue;
            copyFileSync(join(outDir, f), join(destDir, f));
            if (f.startsWith("clip_")) clips.push(`/assets/generated/${id}/${f}`);
          }
          ix[id] = { url: `/assets/generated/${id}/${id}.glb`, clips };
        } else {
          mkdirSync(genDir, { recursive: true });
          copyFileSync(join(pipeline, "out", id, `${id}.glb`), join(genDir, `${id}.glb`));
          ix[id] = { url: `/assets/generated/${id}.glb` };
        }
        writeIndex(ix);
        job.status = "done";
        job.detail = "ready — reload the page to use it";
      } catch (e) {
        job.status = "failed";
        job.detail = String(e).slice(0, 400);
      }
    });
  };

  return {
    name: "dcc-builder-bridge",
    apply: "serve", // dev server only; never part of a build
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/__builder", (req, res) => {
        const url = req.url ?? "";
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && url.startsWith("/ping")) { res.end('{"ok":true}'); return; }
        if (req.method === "GET" && url.startsWith("/jobs")) { res.end(JSON.stringify([...jobs.values()])); return; }
        // Zip import: search + extract props from the owner's collection zip.
        if (req.method === "GET" && url.startsWith("/zip-search")) {
          const q = new URL(url, "http://x").searchParams.get("q") ?? "";
          const r = spawnSync("python", [join(pipeline, "zip_tool.py"), "search", q], { encoding: "utf8", env: process.env });
          if (r.status !== 0) { res.statusCode = 500; res.end(JSON.stringify({ error: r.stderr.slice(0, 300) })); return; }
          res.end(r.stdout.trim());
          return;
        }
        if (req.method === "POST" && url.startsWith("/zip-extract")) {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const { path } = JSON.parse(body) as { path: string };
              if (typeof path !== "string" || path.includes("..")) throw new Error("bad path");
              const key = path.split("/").pop()!.replace(/\.(gltf|glb)$/i, "")
                .toLowerCase().replace(/[^a-z0-9]+/g, "_");
              const tmp = join(pipeline, "out", `__zip_${key}`);
              const ex = spawnSync("python", [join(pipeline, "zip_tool.py"), "extract", path, tmp], { encoding: "utf8", env: process.env });
              if (ex.status !== 0) throw new Error(ex.stderr.slice(0, 300));
              const main = (JSON.parse(ex.stdout.trim()) as { main: string }).main;
              mkdirSync(genDir, { recursive: true });
              const dest = join(genDir, `${key}.glb`);
              if (main.toLowerCase().endsWith(".glb")) {
                copyFileSync(main, dest);
              } else {
                const cv = spawnSync("npx", ["-y", "gltf-pipeline", "-i", main, "-o", dest], { encoding: "utf8", shell: true, env: process.env });
                if (cv.status !== 0) throw new Error(cv.stderr.slice(0, 300));
              }
              const ix = readIndex();
              ix[key] = { url: `/assets/generated/${key}.glb` };
              writeIndex(ix);
              res.end(JSON.stringify({ ok: true, key }));
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
          return;
        }
        // Ship a builder creation INTO the game source: write the content
        // file and (rooms/mobs) register it in the explicit index.ts. The
        // result is a reviewable git diff, not a hidden side channel.
        if (req.method === "POST" && url.startsWith("/ship")) {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const { kind, data } = JSON.parse(body) as { kind: string; data: { id?: string } };
              const id = data?.id ?? "";
              if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new Error("id must be kebab-case (2-40 chars)");
              const files: string[] = [];
              const registerInIndex = (indexPath: string, typeName: string): void => {
                const camel = id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
                let src = readFileSync(indexPath, "utf8");
                if (src.includes(`"./${id}.json"`)) return; // re-ship = file overwrite only
                const anchor = src.lastIndexOf('.json";');
                const lineEnd = src.indexOf("\n", anchor);
                src = `${src.slice(0, lineEnd + 1)}import ${camel} from "./${id}.json";\n${src.slice(lineEnd + 1)}`;
                src = src.replace(/^\];/m, `  ${camel} as ${typeName},\n];`);
                writeFileSync(indexPath, src);
                files.push(indexPath);
              };
              if (kind === "room" || kind === "mob") {
                const dir = resolve(__dirname, `src/content/${kind === "room" ? "rooms" : "mobs"}`);
                const file = join(dir, `${id}.json`);
                writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
                files.push(file);
                registerInIndex(join(dir, "index.ts"), kind === "room" ? "RoomTemplate" : "CustomMobDef");
              } else if (kind === "purpose") {
                const file = resolve(__dirname, "src/sim/roomPurposes.data.json");
                const list = JSON.parse(readFileSync(file, "utf8")) as { id: string; variants?: unknown }[];
                const ix = list.findIndex((p) => p.id === id);
                if (ix >= 0) {
                  // Upsert keeping authored variants unless the payload brings its own.
                  const keep = list[ix].variants;
                  list[ix] = { ...(data as { id: string; variants?: unknown }) };
                  if (list[ix].variants === undefined && keep !== undefined) list[ix].variants = keep;
                } else {
                  list.push(data as { id: string });
                }
                writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
                files.push(file);
              } else {
                throw new Error("kind must be room | mob | purpose");
              }
              res.end(JSON.stringify({ ok: true, files: files.map((f) => f.replace(/\\/g, "/").split("/dungeon-crawler-carl/")[1] ?? f) }));
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
          return;
        }
        if (req.method === "POST" && url.startsWith("/generate")) {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const { kind, id, prompt, clips, source } = JSON.parse(body) as
                { kind: string; id: string; prompt: string; clips?: string; source?: string };
              if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new Error("id must be kebab-case");
              if (!prompt || prompt.length > 300) throw new Error("prompt required (max 300 chars)");
              if (jobs.get(id)?.status === "running") throw new Error("job already running");
              if (clips && !/^[A-Za-z0-9_]+:\d+(,[A-Za-z0-9_]+:\d+)*$/.test(clips)) {
                throw new Error("clips must be Name:actionId,Name:actionId");
              }
              if (kind === "retexture") {
                if (!source || !/^[a-z0-9_-]{2,60}$/.test(source) || !existsSync(join(genDir, `${source}.glb`))) {
                  throw new Error("source must name an existing generated .glb");
                }
                runJob("retexture", id, prompt, { source });
              } else {
                runJob(kind === "creature" ? "creature" : "prop", id, prompt, { clips });
              }
              res.end('{"ok":true}');
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
          return;
        }
        res.statusCode = 404;
        res.end('{"error":"not found"}');
      });
    },
  };
}

/**
 * CONTENT-HASHED STATIC ASSETS — BUILD SIDE. (Client side: src/assetUrl.ts.
 * Policy + why one machine still serves it: DEPLOY.md "Cache policy".)
 *
 * Vite content-hashes what it BUNDLES. Everything under `public/` — 32 MB of
 * models, 23 MB of audio, the icons, the fonts — shipped under its own name, so
 * no cached copy could be told apart from a newer one and the server had to cap
 * it at `max-age=86400` + revalidate. Past a day, a visit spends ~400 round
 * trips proving nothing changed before the first frame.
 *
 * Two schemes, because the URLs are built two different ways:
 *
 *  - `assets/` and `audio/` get a PER-FILE hash (`skeleton.1a2b3c4d.glb`).
 *    Their URLs are assembled from parts at runtime (`/assets/dungeon/${name}
 *    .glb`), so no build-time string rewrite can see them; the map is inlined
 *    into each HTML document and `assetUrl()` resolves it at the handful of
 *    places a URL reaches the network. Per-file is what makes a deploy cheap:
 *    change one model, re-download one model.
 *
 *  - `icons/` and `fonts/` get a PER-TREE version (`/icons.1a2b3c4d/`). Those
 *    URLs are written inline in dozens of template literals and in iso.html's
 *    CSS, but always off a literal prefix — so rewriting the prefix reaches
 *    every one with no runtime lookup. The rewrite happens in `transform` /
 *    `transformIndexHtml`, i.e. BEFORE rollup hashes the chunks, so a chunk's
 *    own hash accounts for the icon version it points at. (Rewriting emitted
 *    JS instead would leave a chunk whose name no longer matches its bytes —
 *    served immutable, that is a permanently stale bundle.) 300 small files
 *    that ship together; re-fetching the few a session touches is free.
 *
 * `public/` itself is never touched: ASSETS.md stays the license index, keyed
 * by the real filenames, and a rename is not a modification of the work.
 */
function assetHashing(): Plugin {
  const HASH_TREES = ["assets", "audio"]; // per-file
  const VERSION_TREES = ["icons", "fonts"]; // per-tree
  const short = (data: Buffer | string): string =>
    createHash("sha256").update(data).digest("hex").slice(0, 8);

  const walk = (abs: string, rel: string, visit: (abs: string, rel: string) => void): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r, visit);
      else visit(a, r);
    }
  };

  // Hashes come off public/ up front — dist/ is a byte-for-byte copy of it, so
  // everything downstream (the HTML map, the prefix rewrites, the renames) can
  // agree on one set of names computed exactly once.
  const pub = resolve(__dirname, "public");
  const files: Record<string, string> = {}; // "/assets/x.glb" -> content hash
  const dirs: Record<string, string> = {}; // "/icons/" -> "/icons.<hash>/"
  for (const tree of HASH_TREES) {
    if (!existsSync(join(pub, tree))) continue;
    walk(join(pub, tree), tree, (abs, rel) => {
      const base = rel.slice(rel.lastIndexOf("/") + 1);
      // Extensionless and dotfiles (.gitkeep) have nowhere sensible to put a
      // hash, and nothing requests them anyway.
      if (base.lastIndexOf(".") <= 0) return;
      // `assets/tex/` is the deduplicated shared-texture pool
      // (tools/dedupe-textures.mjs). Those files are ALREADY content-addressed
      // — `t.<8 hex of their own sha256>.webp` — and, unlike every other asset,
      // their URLs are not assembled by a host: they are relative `../tex/…`
      // URIs baked INSIDE the GLBs that reference them, where neither
      // assetUrl() nor any build-time rewrite can reach. Renaming them here
      // would leave 218 GLBs pointing at names that no longer exist. Skipping
      // the rename costs nothing: the name already changes when the bytes do,
      // which is the whole point of the hash, and gameServer's `selfDescribing`
      // test matches `t.<8hex>.webp` so they still serve immutable for a year.
      if (rel.startsWith("assets/tex/")) return;
      files[`/${rel}`] = short(readFileSync(abs));
    });
  }
  for (const tree of VERSION_TREES) {
    if (!existsSync(join(pub, tree))) continue;
    const parts: string[] = [];
    walk(join(pub, tree), tree, (abs, rel) => parts.push(`${rel}:${short(readFileSync(abs))}`));
    dirs[`/${tree}/`] = `/${tree}.${short(parts.sort().join("\n"))}/`;
  }
  const versionPrefixes = (src: string): string => {
    for (const [from, to] of Object.entries(dirs)) src = src.split(from).join(to);
    return src;
  };
  // Inlined, not fetched: the first model request must not wait on a round trip
  // to learn its own name, and the document it rides in is `no-cache` anyway.
  const mapTag = (): string =>
    `<script type="application/json" id="dcc-asset-hashes">` +
    `${JSON.stringify(files).replace(/</g, "\\u003c")}</script>`;

  return {
    name: "dcc-asset-hashing",
    apply: "build",
    // Every module we author, INCLUDING the CSS Vite extracts out of iso.html's
    // inline <style> (an `?html-proxy…css` id). That block is where the fonts
    // and a good share of the icon masks live, and it is re-injected into the
    // document AFTER transformIndexHtml — so patching the html string alone
    // silently left those two behind. Learned the hard way; do not re-narrow
    // this filter to a file-extension test.
    transform(code, id) {
      if (id.includes("node_modules")) return null;
      const out = versionPrefixes(code);
      return out === code ? null : { code: out, map: null };
    },
    transformIndexHtml(html) {
      return versionPrefixes(html).replace("</head>", `${mapTag()}\n</head>`);
    },
    closeBundle() {
      const dist = resolve(__dirname, "dist");
      if (!existsSync(dist)) return;
      for (const [url, hash] of Object.entries(files)) {
        const rel = url.slice(1);
        const abs = join(dist, rel);
        if (!existsSync(abs)) continue; // never copied (shouldn't happen) — leave it
        const dot = rel.lastIndexOf(".");
        renameSync(abs, join(dist, `${rel.slice(0, dot)}.${hash}${rel.slice(dot)}`));
      }
      for (const [from, to] of Object.entries(dirs)) {
        const abs = join(dist, from.slice(1, -1));
        if (existsSync(abs)) renameSync(abs, join(dist, to.slice(1, -1)));
      }
      // The receipt: what this build claims is immutable, for anyone debugging a
      // cache question from outside the browser.
      writeFileSync(join(dist, "asset-hashes.json"), JSON.stringify({ files, dirs }));
      const n = Object.keys(files).length;

      // PRECOMPRESS, because the server was doing this per request. gameServer
      // gzips GLB/JS/CSS/HTML on the fly, and it is worth a lot (the shipped
      // character GLBs are ~80% air: skeleton_warrior 2,629,440 -> 541,097) —
      // but that is level-6 deflate over ~32 MB of models for every cold
      // visitor, on the one machine that is also ticking the worlds. The bytes
      // are immutable now, so compressing them once at build time is strictly
      // better: no per-request CPU, level 9 instead of 6, and a real
      // content-length where the streamed path could only send chunked.
      // Files that DON'T shrink (already-compressed audio, and any GLB a future
      // mesh-compression round makes incompressible) get no sidecar at all, so
      // this stays honest as the assets change under it.
      let gzCount = 0, gzIn = 0, gzOut = 0;
      walk(dist, "", (abs, rel) => {
        if (!/\.(glb|js|css|html|json|svg|txt|ttf|wav)$/.test(rel)) return;
        const raw = readFileSync(abs);
        if (raw.length < 1024) return; // a round trip costs more than the bytes
        const gz = gzipSync(raw, { level: 9 });
        if (gz.length > raw.length * 0.9) return; // not worth the disk or the disk read
        writeFileSync(`${abs}.gz`, gz);
        gzCount++; gzIn += raw.length; gzOut += gz.length;
      });
      const mb = (b: number): string => (b / 1e6).toFixed(1);
      console.log(`dcc-asset-hashing: ${n} files content-hashed, ${Object.keys(dirs).length} trees versioned`);
      console.log(`dcc-asset-hashing: ${gzCount} files precompressed, ${mb(gzIn)}MB -> ${mb(gzOut)}MB on the wire`);
    },
  };
}

export default defineConfig({
  root: ".",
  server: { port: 5280, strictPort: true, open: false },
  plugins: [builderBridge(), assetHashing()],
  build: {
    outDir: "dist",
    // Bundled chunks live under /_app/, NOT the default /assets/ — that shared
    // the one directory with public/assets/ (the models), which made "is this
    // URL a rollup chunk or a model?" unanswerable from the path alone. Both
    // the hashing plugin and the server's cache policy ask that question.
    assetsDir: "_app",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"), // 2D top-down slice
        iso: resolve(__dirname, "iso.html"), // 3D isometric view
        builder: resolve(__dirname, "builder.html"), // dungeon/enemy crafting bench (admin)
      },
    },
  },
});
