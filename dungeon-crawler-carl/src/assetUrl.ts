/**
 * CONTENT-HASHED ASSET URLS — the client half. (Build half: the
 * `dcc-asset-hashing` plugin in vite.config.ts. Policy: DEPLOY.md.)
 *
 * Vite content-hashes what it BUNDLES; everything under `public/` used to ship
 * under its own name, so no cached copy could ever be told apart from a newer
 * one and the server had to cap models/audio at `max-age=86400` + revalidate.
 * Past a day that is ~380 conditional requests before the first frame — on a
 * phone the bill is round trips, not bytes.
 *
 * The build now renames every file under `assets/` and `audio/` to
 * `name.<8 hex of its own content>.ext` and inlines the map into each HTML
 * document (`<script type="application/json" id="dcc-asset-hashes">`), so the
 * lookup costs no extra request. Hosts keep writing the REAL path — the one
 * ASSETS.md tracks the license of — and pass it through `assetUrl()` at the
 * few places a URL actually reaches the network.
 *
 * No map (dev server, tests, tools, a dist built before this existed) means
 * every path passes through untouched, which is exactly the old behaviour.
 *
 * `/icons/` and `/fonts/` are NOT in this map: their URLs are assembled inline
 * all over main3d.ts and iso.html's CSS, so the build versions those two trees
 * by DIRECTORY (`/icons.<hash>/`) via a literal-prefix rewrite that needs no
 * runtime lookup at all.
 */

let map: Record<string, string> | null | undefined;

function hashes(): Record<string, string> | null {
  if (map !== undefined) return map;
  map = null;
  if (typeof document !== "undefined") {
    const el = document.getElementById("dcc-asset-hashes");
    const text = el?.textContent;
    if (text) {
      try {
        map = JSON.parse(text) as Record<string, string>;
      } catch {
        map = null; // a mangled map must never take the game down with it
      }
    }
  }
  return map;
}

/**
 * The shipped URL for a root-relative asset path. Returns `path` unchanged when
 * the build did not hash it (dev, tools, or a file that is not in this build).
 */
export function assetUrl(path: string): string {
  const m = hashes();
  if (!m) return path;
  const q = path.indexOf("?");
  const bare = q < 0 ? path : path.slice(0, q);
  const h = m[bare];
  if (!h) return path;
  const dot = bare.lastIndexOf(".");
  if (dot < 0) return path;
  return `${bare.slice(0, dot)}.${h}${bare.slice(dot)}${q < 0 ? "" : path.slice(q)}`;
}

/**
 * Did THIS build ship this file? Only ever `false` with a hash map present —
 * without one we cannot know, so callers must treat `true` as "no information"
 * and keep their normal missing-file fallback. One use so far: skipping the
 * request for the generated-asset index in a build that has no generated
 * assets, which was a guaranteed 404 inside the boot gate on every visit.
 */
export function assetInBuild(path: string): boolean {
  const m = hashes();
  return m === null || m[path] !== undefined;
}
