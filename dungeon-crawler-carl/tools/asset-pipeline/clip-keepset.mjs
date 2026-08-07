// THE KEEP-SET, and the reason it is safe.
//
// Every clip a running build can reach is chosen by a regex somewhere in the
// host. There are exactly three consumers (grep `.animations` / `c.name`):
//
//   1. renderer3d.ts  attachClipAnimator's `found` table — 53 slots, each a
//      pick(...) chain of regexes resolved with clips.find().
//   2. charSelect.ts  the lineup flourish (/wave/, /cheer/, /interact/) and
//      the lineup idle (/^idle$/, /idle/).
//   3. builder.ts     the dev preview dropdown (/idle/ then animations[0]).
//
// THE RULE: keep a clip if ANY regex of ANY consumer matches its name — not
// merely the one that wins today.
//
// Why that is drift-proof, which is the whole safety argument: `pick` is
// `clips.find(c => re.test(c.name))`, so a slot's answer is the FIRST array
// element matching. If we kept only today's winner, deleting some other clip
// could slide a surviving slot onto a different clip (the classic hazard:
// `attack: pick(/melee.*attack/i, ...)` sliding from 1H_ to 2H_). Keeping
// every match of every regex means each regex's match-set is IDENTICAL before
// and after, and relative order is preserved, so find() returns the same clip.
// Not "we checked and it didn't drift" — it cannot drift.
//
// This also survives the shared-library layout in assets.ts: rig characters
// animate off `rigClips[rig]`, the CONCATENATION of the rig slot GLBs, and
// heroes get `heroSlots.flat()` appended. Because the rule is per-clip-name
// and library-independent, it is automatically the union over every character
// sharing a rig — never a per-character keep-list, which would be unsound.
//
// What it drops is only clips NO regex in the host can match: the ranged
// reload/bow packs a melee skeleton can never fire, the jump/fishing/lockpick
// verbs nothing calls, the *_Pose duplicates of clips we keep.
import fs from 'node:fs';

/** Every regex the running host can test a clip name against. */
export function consumerRegexes(src = fs.readFileSync('src/render3d/renderer3d.ts', 'utf8')) {
  const start = src.indexOf('const found: Record<string, THREE.AnimationClip | null> = {');
  const end = src.indexOf('\n    };', start);
  if (start < 0 || end < 0) throw new Error('animator slot table not found in renderer3d.ts');
  const block = src.slice(start, end);
  const out = [];
  for (const m of block.matchAll(/^\s*([a-z_]+):\s*pick\(([^)]*(?:\)[^)]*)*?)\),\s*(?:\/\/.*)?$/gim)) {
    for (const r of m[2].matchAll(/\/((?:[^/\\]|\\.)+)\/([a-z]*)/g)) {
      out.push({ slot: m[1], re: new RegExp(r[1], r[2]) });
    }
  }
  if (out.length < 40) throw new Error(`only parsed ${out.length} animator regexes — the table moved`);
  // Consumers 2 and 3, which live outside the slot table.
  for (const [slot, re] of [
    ['charSelect:flourish', /wave/i], ['charSelect:flourish', /cheer/i],
    ['charSelect:flourish', /interact/i],
    ['charSelect:idle', /^idle$/i], ['charSelect:idle', /idle/i],
    ['builder:preview', /idle/i],
  ]) out.push({ slot, re });
  return out;
}

export function keepFilter(regexes = consumerRegexes()) {
  return (name) => regexes.some((r) => r.re.test(name));
}

/** Independent check: pick() over `names` must answer identically after filtering. */
export function driftCheck(names, keep) {
  const src = fs.readFileSync('src/render3d/renderer3d.ts', 'utf8');
  const start = src.indexOf('const found: Record<string, THREE.AnimationClip | null> = {');
  const block = src.slice(start, src.indexOf('\n    };', start));
  const kept = names.filter(keep);
  const drift = [];
  for (const m of block.matchAll(/^\s*([a-z_]+):\s*pick\(([^)]*(?:\)[^)]*)*?)\),\s*(?:\/\/.*)?$/gim)) {
    const res = [...m[2].matchAll(/\/((?:[^/\\]|\\.)+)\/([a-z]*)/g)].map((r) => new RegExp(r[1], r[2]));
    const pick = (list) => { for (const re of res) { const c = list.find((n) => re.test(n)); if (c) return c; } return null; };
    const a = pick(names), b = pick(kept);
    if (a !== b) drift.push(`${m[1]}: ${a} -> ${b ?? 'NONE'}`);
  }
  for (const [slot, chain] of [
    ['charSelect:flourish', [/wave/i, /cheer/i, /interact/i]],
    ['charSelect:idle', [/^idle$/i, /idle/i]],
  ]) {
    const pick = (list) => { for (const re of chain) { const c = list.find((n) => re.test(n)); if (c) return c; } return null; };
    const a = pick(names), b = pick(kept);
    if (a !== b) drift.push(`${slot}: ${a} -> ${b ?? 'NONE'}`);
  }
  return drift;
}
