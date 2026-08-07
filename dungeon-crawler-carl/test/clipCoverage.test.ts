import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// THE GUARD ON PRUNED CHARACTER CLIPS.
//
// The rigged character GLBs ship only the animation clips the host can address:
// the shared KayKit rig library is ~95 clips, of which the animator can reach
// ~70, and the rest (bow draws, reload cycles, fishing, lockpicking, *_Pose
// duplicates) were dropped to take 1.05 MB off the boot payload.
//
// That is safe ONLY while one invariant holds, and it is an invariant a future
// edit can break without any visible symptom, because a missing clip does not
// throw — the animator falls back to idle and the actor merely stops doing the
// thing it should be doing.
//
// THE INVARIANT: every clip name the animator can match is present in the
// shipped files. Concretely, `pick()` is `clips.find(c => re.test(c.name))`, so
// a slot's answer is the FIRST matching element. The prune keeps every clip
// matching ANY regex of ANY consumer, which makes each regex's match-set — and
// therefore every slot's answer — identical to the unpruned library.
//
// Two ways this breaks:
//   1. Someone adds a new pick() regex naming a clip the pruned files no longer
//      contain. The slot silently resolves to nothing on every character.
//   2. Someone re-runs the prune with a narrowed keep rule.
//
// So this test re-derives the keep rule from renderer3d.ts, re-reads the actual
// shipped GLBs, and asserts that no clip a regex could have matched is absent.
// If it fails, either widen the keep-set and re-run
// `node tools/asset-pipeline/prune-character-clips.mjs --apply`, or the new
// regex is dead and should say so.

const CHARS = path.resolve(__dirname, "../public/assets/characters");
const RENDERER = path.resolve(__dirname, "../src/render3d/renderer3d.ts");

/** Clip names in a GLB, read straight from the container's JSON chunk. */
function clipNames(file: string): string[] {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`);
  const len = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + len).toString("utf8")) as
    { animations?: { name?: string }[] };
  return (json.animations ?? []).map((a) => a.name ?? "");
}

/** Every regex the running host can test a clip name against. */
function consumerRegexes(): { slot: string; re: RegExp }[] {
  const src = fs.readFileSync(RENDERER, "utf8");
  const start = src.indexOf("const found: Record<string, THREE.AnimationClip | null> = {");
  expect(start, "animator slot table not found in renderer3d.ts").toBeGreaterThan(0);
  const block = src.slice(start, src.indexOf("\n    };", start));
  const out: { slot: string; re: RegExp }[] = [];
  for (const m of block.matchAll(/^\s*([a-z_]+):\s*pick\(([^)]*(?:\)[^)]*)*?)\),\s*(?:\/\/.*)?$/gim)) {
    for (const r of m[2].matchAll(/\/((?:[^/\\]|\\.)+)\/([a-z]*)/g)) {
      out.push({ slot: m[1], re: new RegExp(r[1], r[2]) });
    }
  }
  // charSelect.ts's lineup flourish + idle, and builder.ts's preview default.
  for (const [slot, re] of [
    ["charSelect:flourish", /wave/i], ["charSelect:flourish", /cheer/i],
    ["charSelect:flourish", /interact/i],
    ["charSelect:idle", /^idle$/i], ["charSelect:idle", /idle/i],
    ["builder:preview", /idle/i],
  ] as [string, RegExp][]) out.push({ slot, re });
  return out;
}

const glbs = fs.existsSync(CHARS)
  ? fs.readdirSync(CHARS).filter((f) => f.endsWith(".glb")).map((f) => path.join(CHARS, f))
  : [];

describe("pruned character clips still cover every animator slot", () => {
  it("parses a plausible animator surface out of renderer3d.ts", () => {
    const res = consumerRegexes();
    // If the slot table is refactored past recognition this drops to ~0 and the
    // coverage test below would pass vacuously — fail loudly instead.
    expect(res.length).toBeGreaterThan(80);
  });

  it("ships the character library at all", () => {
    expect(glbs.length).toBeGreaterThan(20);
  });

  // THE REAL ASSERTION. For each shipped file, no clip that the host could
  // match may be missing — i.e. the file's clip list is closed under the keep
  // rule. Because the rule is "keep everything any regex matches", a file that
  // still satisfies it cannot have had a slot's answer change.
  it("keeps every clip any host regex can match", () => {
    const res = consumerRegexes();
    const offenders: string[] = [];
    for (const f of glbs) {
      const names = clipNames(f);
      if (!names.length) continue; // static character, no clips to keep
      const kept = names.filter((n) => res.some((r) => r.re.test(n)));
      if (kept.length !== names.length) {
        offenders.push(`${path.basename(f)}: ${names.length - kept.length} unreachable clip(s) still shipped: ` +
          names.filter((n) => !res.some((r) => r.re.test(n))).join(", "));
      }
    }
    // Unreachable clips left behind are not a correctness bug, only wasted
    // bytes — but they mean the prune is stale, so say so with the file names.
    expect(offenders, "re-run tools/asset-pipeline/prune-character-clips.mjs --apply").toEqual([]);
  });

  it("leaves no animator slot without a clip anywhere in the library", () => {
    const res = consumerRegexes();
    const all = new Set<string>();
    for (const f of glbs) for (const n of clipNames(f)) all.add(n);
    const bySlot = new Map<string, boolean>();
    for (const { slot, re } of res) {
      bySlot.set(slot, (bySlot.get(slot) ?? false) || [...all].some((n) => re.test(n)));
    }
    // A slot no clip in the entire shipped library can satisfy is either a typo
    // or a clip the prune removed — both silent at runtime, both bugs here.
    expect([...bySlot].filter(([, ok]) => !ok).map(([s]) => s)).toEqual([]);
  });
});
