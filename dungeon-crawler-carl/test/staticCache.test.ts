import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { GameServer } from "../src/server/gameServer";

/**
 * THE CACHE POLICY IS A CONTRACT WITH EVERY BROWSER THAT EVER LOADED THIS GAME
 * (DEPLOY.md "Cache policy"). `immutable, max-age=31536000` on a url whose
 * bytes can change is not a slow bug — it is an unfixable one, for a year, on a
 * machine you do not own. So the rule the server applies has to be exactly "the
 * url names its own content", and it has to be tested against both shapes of
 * url the build mints and the shapes it must NOT claim.
 *
 * The fixture is a hand-built dist rather than a real `npm run build` so the
 * test states the contract instead of re-deriving it from whatever the build
 * happened to emit today.
 */
describe("static serving: cache policy", () => {
  let server: GameServer;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dcc-static-"));
    mkdirSync(join(dir, "_app"), { recursive: true });
    mkdirSync(join(dir, "assets", "characters"), { recursive: true });
    mkdirSync(join(dir, "icons.1a2b3c4d", "ui"), { recursive: true });
    mkdirSync(join(dir, "audio"), { recursive: true });
    const glb = Buffer.alloc(4096, 7); // compressible: 4KB of one byte
    writeFileSync(join(dir, "iso.html"), "<!doctype html><title>iso</title>");
    writeFileSync(join(dir, "_app", "iso-CxWpyPOz.js"), "console.log(1)");
    writeFileSync(join(dir, "assets", "characters", "skeleton.d48770b5.glb"), glb);
    writeFileSync(join(dir, "assets", "characters", "skeleton.d48770b5.glb.gz"), gzipSync(glb, { level: 9 }));
    writeFileSync(join(dir, "assets", "characters", "legacy.glb"), glb); // unhashed
    writeFileSync(join(dir, "icons.1a2b3c4d", "ui", "eye.svg"), "<svg/>");
    writeFileSync(join(dir, "asset-hashes.json"), "{}");
    server = new GameServer(0, dir);
    await server.ready();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const cc = async (path: string): Promise<string> =>
    (await fetch(`${base}${path}`)).headers.get("cache-control") ?? "";

  it("gives a year + immutable to every url that names its own content", async () => {
    const forever = "public, max-age=31536000, immutable";
    expect(await cc("/_app/iso-CxWpyPOz.js")).toBe(forever); // rollup chunk
    expect(await cc("/assets/characters/skeleton.d48770b5.glb")).toBe(forever); // per-file hash
    expect(await cc("/icons.1a2b3c4d/ui/eye.svg")).toBe(forever); // versioned tree
  });

  it("never lets the entry documents go stale — a deploy must land immediately", async () => {
    expect(await cc("/iso.html")).toBe("no-cache");
  });

  it("keeps the revalidating TTL for an asset whose url does NOT name its content", async () => {
    // A dist built before hashing existed, or a file dropped in by hand: a day,
    // then a conditional request. Never immutable — nothing proves it is stable.
    expect(await cc("/assets/characters/legacy.glb")).toBe("public, max-age=86400, stale-while-revalidate=604800");
    expect(await cc("/asset-hashes.json")).toBe("public, max-age=300");
  });

  it("serves the build's precompressed sidecar, with a length, and never double-encodes", async () => {
    const gz = await fetch(`${base}/assets/characters/skeleton.d48770b5.glb`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    // A real content-length is the tell that the sidecar was served rather than
    // the streaming compressor (which can only answer chunked).
    expect(Number(gz.headers.get("content-length"))).toBeGreaterThan(0);
    expect(Number(gz.headers.get("content-length"))).toBeLessThan(4096);
    expect((await gz.arrayBuffer()).byteLength).toBe(4096); // undici inflates it
  });

  it("gives the two encodings of one url two different validators", async () => {
    // Same url, two representations. One ETag for both and a shared cache can
    // answer an identity request out of a gzipped entry.
    const gz = await fetch(`${base}/assets/characters/skeleton.d48770b5.glb`, {
      headers: { "accept-encoding": "gzip" },
    });
    const raw = await fetch(`${base}/assets/characters/skeleton.d48770b5.glb`, {
      headers: { "accept-encoding": "identity" },
    });
    const gzTag = gz.headers.get("etag")!;
    const rawTag = raw.headers.get("etag")!;
    expect(gzTag).not.toBe(rawTag);
    expect(raw.headers.get("content-encoding")).toBe(null);
    expect(gz.headers.get("vary")).toBe("accept-encoding");

    // ...and each validator only satisfies its own representation.
    const hit = await fetch(`${base}/assets/characters/skeleton.d48770b5.glb`, {
      headers: { "accept-encoding": "gzip", "if-none-match": gzTag },
    });
    expect(hit.status).toBe(304);
    const miss = await fetch(`${base}/assets/characters/skeleton.d48770b5.glb`, {
      headers: { "accept-encoding": "identity", "if-none-match": gzTag },
    });
    expect(miss.status).toBe(200);
  });
});

/**
 * The client half (src/assetUrl.ts). The two halves have to agree: the url the
 * loader ASKS for must be one the server is willing to call immutable, and with
 * no map present it must be the plain path it always was.
 */
describe("assetUrl: the client's half of the same contract", () => {
  const withMap = async (json: string | null) => {
    vi.resetModules();
    const el = json === null ? null : { textContent: json };
    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) => (id === "dcc-asset-hashes" ? el : null),
    };
    return import("../src/assetUrl");
  };

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("puts the hash before the extension, where the server looks for it", async () => {
    const { assetUrl } = await withMap('{"/assets/characters/skeleton.glb":"d48770b5"}');
    const url = assetUrl("/assets/characters/skeleton.glb");
    expect(url).toBe("/assets/characters/skeleton.d48770b5.glb");
    // ...and that is exactly the shape the server's immutable rule matches.
    const base = url.slice(url.lastIndexOf("/") + 1);
    expect(/\.[0-9a-f]{8}\.[A-Za-z0-9]+$/.test(base)).toBe(true);
  });

  it("hands back anything it was not given a hash for, unchanged", async () => {
    const { assetUrl, assetInBuild } = await withMap('{"/audio/sfx/hit.ogg":"aabbccdd"}');
    // Not in this build: the loaders' missing-file fallbacks take it from here.
    expect(assetUrl("/assets/dungeon/nope.glb")).toBe("/assets/dungeon/nope.glb");
    expect(assetInBuild("/assets/generated/index.json")).toBe(false);
    expect(assetInBuild("/audio/sfx/hit.ogg")).toBe(true);
  });

  it("is a no-op with no map at all — dev, tools, and every test above", async () => {
    const { assetUrl, assetInBuild } = await withMap(null);
    expect(assetUrl("/assets/characters/skeleton.glb")).toBe("/assets/characters/skeleton.glb");
    // No map means no information, so nothing may be skipped on its say-so.
    expect(assetInBuild("/assets/generated/index.json")).toBe(true);
  });

  it("survives a mangled map instead of taking the game down with it", async () => {
    const { assetUrl } = await withMap("{not json");
    expect(assetUrl("/assets/characters/skeleton.glb")).toBe("/assets/characters/skeleton.glb");
  });

  it("keeps a query string on the far side of the hash", async () => {
    const { assetUrl } = await withMap('{"/assets/characters/skeleton.glb":"d48770b5"}');
    expect(assetUrl("/assets/characters/skeleton.glb?debug=1"))
      .toBe("/assets/characters/skeleton.d48770b5.glb?debug=1");
  });
});
