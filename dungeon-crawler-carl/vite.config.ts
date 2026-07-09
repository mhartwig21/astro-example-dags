import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
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
