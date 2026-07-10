import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";

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

  const runJob = (kind: string, id: string, prompt: string): void => {
    const job: Job = { id, kind, status: "running", detail: "generating (minutes)…" };
    jobs.set(id, job);
    const args = kind === "creature"
      ? ["orchestrator/creature.py", "--id", id, "--prompt", prompt, "--out", `out/${id}`]
      : ["orchestrator/run.py", "--manifest", `out/__bridge_${id}.json`];
    if (kind !== "creature") {
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
              const { kind, id, prompt } = JSON.parse(body) as { kind: string; id: string; prompt: string };
              if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new Error("id must be kebab-case");
              if (!prompt || prompt.length > 300) throw new Error("prompt required (max 300 chars)");
              if (jobs.get(id)?.status === "running") throw new Error("job already running");
              runJob(kind === "creature" ? "creature" : "prop", id, prompt);
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

export default defineConfig({
  root: ".",
  server: { port: 5280, strictPort: true, open: false },
  plugins: [builderBridge()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"), // 2D top-down slice
        iso: resolve(__dirname, "iso.html"), // 3D isometric view
        builder: resolve(__dirname, "builder.html"), // dungeon/enemy crafting bench (admin)
      },
    },
  },
});
