#!/usr/bin/env node
// tools/_mixdiff.mjs — BEFORE vs AFTER for the masking layer. Reads two
// simraw.json dumps from tools/_mixsim.ts and prints the numbers the owner's
// two verdicts are about: sustained voices/second, peak concurrent voices,
// kill-cue starts per second, cues in the 300ms around a kill, and whether the
// cues that MUST read (player_hurt / tell / boss beats / level_up) are still
// silenced or buried. Pure arithmetic over recorded events. Read-only.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const A = process.argv[2] || "tools/_shots/mixbefore";
const B = process.argv[3] || "tools/_shots/mixafter";
const load = (d) => JSON.parse(readFileSync(join(d, "simraw.json"), "utf8"));
const before = load(A), after = load(B);

const IMPACT = new Set(["hit", "crit", "kill", "swing", "weapon_flash", "chain_line"]);
const isBark = (id) => id.startsWith("bark_");
const HITFAM = (id) => IMPACT.has(id) || isBark(id);
const KILLFAM = (id) => id === "kill" || /bark_\w+_death_/.test(id) || id === "crowd";
const WATCH = ["player_hurt", "tell", "boss_intro", "boss_phase", "boss_punish", "level_up", "ident_high", "achievement", "warning", "death"];

function concurrency(voices) {
  const ev = [];
  for (const v of voices) { ev.push({ t: v.t, d: 1 }); ev.push({ t: v.t + v.dur * 1000, d: -1 }); }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, peak = 0;
  for (const e of ev) { cur += e.d; if (cur > peak) peak = cur; }
  return peak;
}
const liveAt = (voices, t) => voices.filter((v) => v.t <= t && t < v.t + v.dur * 1000);
const q = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0);

function stat(r) {
  const secs = r.seconds;
  const voices = r.trigs.filter((t) => t.audible && t.dur > 0);
  const bins = new Array(Math.max(1, Math.ceil(secs))).fill(0);
  for (const v of voices) bins[Math.floor(v.t / 1000)]++;
  const sorted = [...bins].sort((a, b) => a - b);
  let adj = 0;
  for (const kt of r.kills) adj += voices.filter((v) => v.t >= kt - 60 && v.t <= kt + 240).length;
  const out = {
    secs, kills: r.totalKills,
    vps: voices.length / secs,
    p50: q(sorted, 0.5), p99: q(sorted, 0.99), max: sorted[sorted.length - 1],
    peak: concurrency(voices),
    killVps: voices.filter((v) => KILLFAM(v.id)).length / secs,
    killClipVps: voices.filter((v) => v.id === "kill").length / secs,
    perKill: r.kills.length ? adj / r.kills.length : 0,
    throttledShare: 1 - voices.length / r.trigs.length,
    barkShare: voices.filter((v) => isBark(v.id)).length / Math.max(1, voices.length),
    watch: {},
  };
  for (const id of WATCH) {
    const fired = r.trigs.filter((t) => t.id === id);
    if (!fired.length) continue;
    const aud = fired.filter((t) => t.audible);
    let sumLive = 0, buried = 0;
    for (const t of aud) {
      const live = liveAt(voices, t.t + 0.01);
      sumLive += live.length;
      if (live.filter((v) => HITFAM(v.id)).length >= 4) buried++;
    }
    out.watch[id] = {
      fired: fired.length, silenced: fired.length - aud.length,
      avgLive: aud.length ? sumLive / aud.length : 0,
      buried: aud.length ? buried / aud.length : 0,
    };
  }
  return out;
}

const f = (x, n = 1) => x.toFixed(n);
const pc = (x) => (100 * x).toFixed(0) + "%";
console.log("scenario        voices/s        p99/s        peak conc     kill-clip/s   cues per kill  bark share");
for (const name of Object.keys(before)) {
  const a = stat(before[name]), b = stat(after[name]);
  console.log(
    `${name.padEnd(14)} ${f(a.vps).padStart(5)} -> ${f(b.vps).padEnd(5)}  ${String(a.p99).padStart(3)} -> ${String(b.p99).padEnd(3)}  ` +
    `${String(a.peak).padStart(3)} -> ${String(b.peak).padEnd(3)}   ${f(a.killClipVps, 2).padStart(5)} -> ${f(b.killClipVps, 2).padEnd(5)}  ` +
    `${f(a.perKill).padStart(5)} -> ${f(b.perKill).padEnd(5)}   ${pc(a.barkShare).padStart(4)} -> ${pc(b.barkShare)}`,
  );
}
console.log("\nCUES THAT MUST READ  (fired / silenced by the guard / avg voices sounding at onset / share buried under >=4 impact+bark voices)");
for (const name of Object.keys(before)) {
  const a = stat(before[name]), b = stat(after[name]);
  const rows = [];
  for (const id of WATCH) {
    const x = a.watch[id], y = b.watch[id];
    if (!x && !y) continue;
    const z = (v) => (v ? `${v.fired}/${v.silenced} live ${f(v.avgLive)} buried ${pc(v.buried)}` : "-");
    rows.push(`    ${id.padEnd(12)} ${z(x).padEnd(34)} ->  ${z(y)}`);
  }
  if (rows.length) console.log(`  ${name}\n${rows.join("\n")}`);
}
