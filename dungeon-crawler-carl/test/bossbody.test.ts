import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { BOSS_POOL } from "../src/sim/bosses";

// ---------------------------------------------------------------------------
// THE BOSS HAS A BODY.
//
// r6 blocker, and it cost the round its most important frame: the capture
// review found The Rent Collector's approach — the reveal of the first boss
// most players ever meet — was an empty white seal over bare floor with a
// point light in the middle and NO MESH, at hp=100. It was not a shader bug,
// a cull, a fog problem or a framing problem. `monster_bossid_rentcollector`
// pointed at `/assets/characters/extradition.glb`, which ASSETS.md itself
// documents as "armature + animation only, no mesh" — a HERO CLIP, retargeted
// onto the adventurer rig to animate crowd-surf. `monster_bossid_temp` pointed
// at `stuntdouble_cast.glb`, the same kind of file. Two of the three
// teaching-band bosses had no body at all and nothing in the build said so,
// because a clip file loads, binds and animates perfectly well — it simply
// draws nothing.
//
// This reads the manifest as TEXT on purpose: it costs no three.js import, it
// runs in the sim test env, and it checks the two things a screenshot would
// have to catch otherwise — that every roster id has a row, that the row's
// file EXISTS, and that it is not one of the clip-only rigs.
// ---------------------------------------------------------------------------

const SRC = readFileSync("src/render3d/assets.ts", "utf8");

/** Every `/assets/...` path listed inside a *_CLIP_MANIFEST block. */
function clipOnlyPaths(): Set<string> {
  const out = new Set<string>();
  for (const name of ["HERO_CLIP_MANIFEST", "RIG_CLIP_MANIFEST"]) {
    const at = SRC.indexOf(`const ${name}`);
    if (at < 0) continue;
    // Read to the end of the declaration (the first `];` at column 0-ish).
    const end = SRC.indexOf("\n};", at) >= 0 && SRC.indexOf("\n};", at) < SRC.indexOf("\n];", at)
      ? SRC.indexOf("\n};", at) : SRC.indexOf("\n];", at);
    const block = SRC.slice(at, end < 0 ? SRC.length : end);
    for (const m of block.matchAll(/"(\/assets\/[^"]+)"/g)) out.add(m[1]);
  }
  return out;
}

function bossBodies(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of SRC.matchAll(/monster_bossid_(\w+):\s*"([^"]+)"/g)) out.set(m[1], m[2]);
  return out;
}

describe("every boss has a body (r6 blocker)", () => {
  const bodies = bossBodies();
  const clips = clipOnlyPaths();
  const roster = Object.values(BOSS_POOL).flat();

  it("the clip-only rigs are actually detected (the guard guards something)", () => {
    expect(clips.size).toBeGreaterThan(3);
    expect(clips.has("/assets/characters/extradition.glb")).toBe(true);
    expect(clips.has("/assets/characters/stuntdouble_cast.glb")).toBe(true);
  });

  it("every roster id has a manifest row", () => {
    for (const def of roster) {
      expect(bodies.get(def.id), `${def.id} has no monster_bossid_ row`).toBeTruthy();
    }
  });

  it("no boss body is a clip-only rig — a clip file draws NOTHING", () => {
    for (const def of roster) {
      const file = bodies.get(def.id)!;
      expect(
        clips.has(file),
        `${def.id} (${def.name}) is bodied by ${file}, which is an animation-only clip`,
      ).toBe(false);
    }
  });

  it("every boss body file is on disk", () => {
    for (const def of roster) {
      const file = bodies.get(def.id)!;
      expect(existsSync("public" + file), `${def.id}: missing ${file}`).toBe(true);
    }
  });

  it("eighteen bosses are still eighteen distinct bodies", () => {
    const used = roster.map((d) => bodies.get(d.id));
    expect(new Set(used).size).toBe(roster.length);
  });
});
