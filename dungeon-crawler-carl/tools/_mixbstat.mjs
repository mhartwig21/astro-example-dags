#!/usr/bin/env node
// Analysis of the browser half (tools/_shots/mix/raw.json). Read-only.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || "tools/_shots/mix";
const raw = JSON.parse(readFileSync(join(OUT, "raw.json"), "utf8"));
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");

const IMPACT = new Set(["hit", "crit", "kill", "swing", "weapon_flash", "chain_line"]);
const isBark = (id) => id.startsWith("bark_");
const isKillFam = (id) => id === "kill" || /_die_|_death_/.test(id) || id === "crowd";

for (const [name, r] of Object.entries(raw)) {
  if (!r.frames || !r.plays) continue;
  const f = r.frames;
  const wall = (f[f.length - 1].t - f[0].t) / 1000;
  const sim = f[f.length - 1].e - f[0].e;
  const dil = sim / wall;
  // ---- audio: engine ring (ids) zipped with real voices (durations)
  const audible = r.plays.filter((p) => !p.throttled && !p.skipped);
  const voices = r.voices;
  // zip in order: engine calls src.start() then record(); n-th audible ring
  // entry corresponds to the n-th voice (music streams, so no extra sources).
  const n = Math.min(audible.length, voices.length);
  const zipped = [];
  for (let i = 0; i < n; i++) zipped.push({ id: audible[i].id, t: voices[i].at, dur: voices[i].dur / (voices[i].rate || 1) });
  // concurrency sweep
  const ev = [];
  for (const v of zipped) { ev.push({ t: v.t, d: 1, v }); ev.push({ t: v.t + v.dur * 1000, d: -1, v }); }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, peak = 0, peakAt = 0;
  for (const e of ev) { cur += e.d; if (cur > peak) { peak = cur; peakAt = e.t; } }
  const liveAtPeak = zipped.filter((v) => v.t <= peakAt + 0.01 && peakAt + 0.01 < v.t + v.dur * 1000);
  // self-overlap
  const byId = {};
  for (const v of zipped) (byId[v.id] ||= []).push(v);
  let selfOv = 0;
  const ovRows = [];
  for (const [id, vs] of Object.entries(byId)) {
    let k = 0, depth = 1;
    for (let i = 0; i < vs.length; i++) {
      let d = 1;
      for (let j = i - 1; j >= 0; j--) if (vs[j].t + vs[j].dur * 1000 > vs[i].t) d++;
      if (d > 1) k++;
      depth = Math.max(depth, d);
    }
    selfOv += k;
    if (k) ovRows.push([id, `${k}/${vs.length} (${pct(k, vs.length)}, depth ${depth})`]);
  }
  ovRows.sort((a, b) => Number(b[1].split("/")[0]) - Number(a[1].split("/")[0]));
  // per-id rate, per SIM second
  const idCount = {};
  for (const p of r.plays) {
    const b = (idCount[p.id] ||= { play: 0, thr: 0, skip: 0 });
    if (p.throttled) b.thr++; else if (p.skipped) b.skip++; else b.play++;
  }
  const top = Object.entries(idCount).sort((a, b) => b[1].play - a[1].play).slice(0, 12)
    .map(([id, b]) => `${id}:${(b.play / sim).toFixed(2)}/s(thr${b.thr})`);

  // ---- notifications
  const lines = r.nodes.filter((x) => x.zone !== "feed");
  const feed = r.nodes.filter((x) => x.zone === "feed");
  const byKind = {};
  for (const l of lines) {
    const k = `${l.zone}:${l.kind || "-"}`;
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const perMin = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, +((v / sim) * 60).toFixed(1)]));
  const feedPerMin = +((feed.length / sim) * 60).toFixed(1);
  // occupancy: share of frames with >=1 / >=2 / >=3 overlay lines up
  const occ1 = f.filter((x) => x.toasts + x.banners + x.cards >= 1).length;
  const occ2 = f.filter((x) => x.toasts + x.banners + x.cards >= 2).length;
  const occ3 = f.filter((x) => x.toasts + x.banners + x.cards >= 3).length;
  const maxStack = Math.max(...f.map((x) => x.toasts + x.banners + x.cards));
  const bossFrames = f.filter((x) => x.boss);
  const bossOverlap = bossFrames.filter((x) => x.toasts + x.banners + x.cards >= 1).length;
  const deadFrames = f.filter((x) => x.dead);
  const deadOverlap = deadFrames.filter((x) => x.toasts + x.banners + x.cards >= 1).length;

  console.log(`\n=== ${name}  sim ${sim.toFixed(1)}s / wall ${wall.toFixed(1)}s (dilation ${dil.toFixed(2)}, ${(f.length / wall).toFixed(0)}fps)`);
  console.log(`  kills=${r.kills} status=${r.status} music=${r.music}`);
  console.log(`  AUDIO plays=${r.plays.length} audible=${audible.length} throttled=${r.plays.filter((p) => p.throttled).length} (${pct(r.plays.filter((p) => p.throttled).length, r.plays.length)}) voicesCaptured=${voices.length}`);
  console.log(`  voices/simSec=${(audible.length / sim).toFixed(2)}  peakConcurrent=${peak}  impactShare=${pct(zipped.filter((v) => IMPACT.has(v.id) || isBark(v.id)).length, zipped.length)}  killCueShare=${pct(zipped.filter((v) => isKillFam(v.id)).length, zipped.length)}`);
  console.log(`  peak stack ids: ${liveAtPeak.map((v) => v.id).join(",")}`);
  console.log(`  selfOverlap=${pct(selfOv, zipped.length)}  ${ovRows.slice(0, 6).map(([i, s]) => i + " " + s).join(" | ")}`);
  console.log(`  headroom peakPre=${r.peakPre.toFixed(3)} peakPost=${r.peakPost.toFixed(3)}  ${r.peakPre > 1 ? "*** COMPRESSOR INPUT OVER FULL SCALE ***" : ""}`);
  console.log(`  top ids/simSec: ${top.join(" ")}`);
  console.log(`  NOTIF lines=${lines.length} (${(lines.length / sim * 60).toFixed(1)}/simMin) feed=${feed.length} (${feedPerMin}/simMin)`);
  console.log(`  by kind/min: ${JSON.stringify(perMin)}`);
  console.log(`  maxSimultaneousOnScreen=${maxStack}  occupancy >=1:${pct(occ1, f.length)} >=2:${pct(occ2, f.length)} >=3:${pct(occ3, f.length)}`);
  console.log(`  bossBarFrames=${pct(bossFrames.length, f.length)}  ofThoseWithOverlays=${pct(bossOverlap, bossFrames.length)}  deathFrames=${deadFrames.length} withOverlays=${pct(deadOverlap, deadFrames.length)}`);
  const dwell = lines.filter((l) => l.rm).map((l) => l.rm - l.add);
  if (dwell.length) {
    dwell.sort((a, b) => a - b);
    console.log(`  line dwell ms: median=${Math.round(dwell[dwell.length >> 1])} max=${Math.round(dwell[dwell.length - 1])}`);
  }
  const sample = lines.slice(0, 8).map((l) => `${l.zone}/${l.kind || "-"}: ${l.text.slice(0, 60)}`);
  console.log(`  sample lines:\n    ${sample.join("\n    ")}`);
}

for (const key of ["climax_boss", "climax_death"]) {
  const c = raw[key];
  if (!c) continue;
  console.log(`\n=== ${key} (held frame)  bossbar=${c.bossbar} status=${c.status}`);
  console.log(`  toasts: ${JSON.stringify(c.toasts)}`);
  console.log(`  banners: ${JSON.stringify(c.banners)}`);
  console.log(`  cards: ${JSON.stringify(c.cards)}`);
  console.log(`  feed tail: ${JSON.stringify(c.feed)}`);
  if (c.frames) {
    const f = c.frames;
    const bossF = f.filter((x) => x.boss);
    const deadF = f.filter((x) => x.dead);
    const stack = f.map((x) => x.toasts + x.banners + x.cards);
    console.log(`  frames=${f.length} maxStack=${Math.max(...stack)} bossFrames=${bossF.length} bossWithOverlay=${bossF.filter((x) => x.toasts + x.banners + x.cards >= 1).length} deadFrames=${deadF.length} deadWithOverlay=${deadF.filter((x) => x.toasts + x.banners + x.cards >= 1).length}`);
    console.log(`  lines during: ${(c.nodes || []).filter((n) => n.zone !== "feed").map((n) => n.zone + "/" + (n.kind || "-") + ":" + n.text.slice(0, 50)).join(" | ")}`);
  }
}
