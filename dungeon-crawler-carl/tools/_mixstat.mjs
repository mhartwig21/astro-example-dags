#!/usr/bin/env node
// tools/_mixstat.mjs — analysis half of the density measurement. Reads
// tools/_shots/mix/simraw.json (sim+director half) and, if present,
// tools/_shots/mix/raw.json (browser half), and prints the numbers.
// Pure arithmetic over recorded events. Read-only.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || "tools/_shots/mix";
const sim = JSON.parse(readFileSync(join(OUT, "simraw.json"), "utf8"));

// families
const IMPACT = new Set(["hit", "crit", "kill", "swing", "weapon_flash", "chain_line"]);
const isBark = (id) => id.startsWith("bark_");
const isDeathBark = (id) => /_die_/.test(id);
const isDot = (id) => id.startsWith("dot_") || id.startsWith("apply_");
const KILLFAM = (id) => id === "kill" || isDeathBark(id) || id === "crowd";
const HITFAM = (id) => IMPACT.has(id) || isBark(id);
// the cues that MUST read through the pile
const IMPORTANT = new Set([
  "tell", "boss_intro", "boss_down", "player_hurt", "level_up", "warning",
  "ident_high", "descend", "band_sting", "death", "lootbox", "achievement",
  "victory", "count_go", "stamp", "verdict",
]);

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");
const f1 = (x) => x.toFixed(1);

function concurrency(voices) {
  // sweep over [t, t+dur*? ) intervals -> peak simultaneous, and a timeline
  const ev = [];
  for (const v of voices) {
    ev.push({ t: v.t, d: +1, v });
    ev.push({ t: v.t + v.dur * 1000, d: -1, v });
  }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, peak = 0, peakAt = 0;
  const live = new Set();
  const samples = [];
  for (const e of ev) {
    cur += e.d;
    if (e.d > 0) live.add(e.v); else live.delete(e.v);
    if (cur > peak) { peak = cur; peakAt = e.t; }
    samples.push({ t: e.t, n: cur });
  }
  return { peak, peakAt, samples };
}

function liveAt(voices, t) {
  return voices.filter((v) => v.t <= t && t < v.t + v.dur * 1000);
}

function windowMax(times, win) {
  // max events inside any `win` ms window
  let best = 0, bestAt = 0, j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[j] > win) j++;
    if (i - j + 1 > best) { best = i - j + 1; bestAt = times[j]; }
  }
  return { n: best, at: bestAt };
}

const report = {};
for (const [name, r] of Object.entries(sim)) {
  const voices = r.trigs.filter((t) => t.audible && t.dur > 0);
  const trigs = r.trigs;
  const secs = r.seconds;
  const byId = {};
  for (const t of trigs) {
    const b = (byId[t.id] ||= { trig: 0, voice: 0, throttled: 0, dur: t.dur });
    b.trig++;
    if (t.audible) b.voice++; else b.throttled++;
  }
  const conc = concurrency(voices);
  const at = liveAt(voices, conc.peakAt + 0.01);
  // self-overlap: a clip starting while the same clip is still sounding
  const overlap = {};
  const byIdVoices = {};
  for (const v of voices) (byIdVoices[v.id] ||= []).push(v);
  let selfOverlaps = 0;
  for (const [id, vs] of Object.entries(byIdVoices)) {
    let n = 0, maxDepth = 1;
    for (let i = 0; i < vs.length; i++) {
      let depth = 1;
      for (let j = i - 1; j >= 0; j--) {
        if (vs[j].t + vs[j].dur * 1000 > vs[i].t) depth++;
        else if (vs[i].t - vs[j].t > 4000) break;
      }
      if (depth > 1) n++;
      maxDepth = Math.max(maxDepth, depth);
    }
    if (n) overlap[id] = { starts: vs.length, overlapping: n, share: pct(n, vs.length), maxDepth };
    selfOverlaps += n;
  }
  // busiest windows
  const vt = voices.map((v) => v.t);
  const w1 = windowMax(vt, 1000), w3 = windowMax(vt, 3000);
  const killT = trigs.filter((t) => t.audible && KILLFAM(t.id)).map((t) => t.t);
  const kw1 = windowMax(killT, 1000);
  // important cues in the pile
  const important = [];
  for (const t of trigs) {
    if (!IMPORTANT.has(t.id) && !t.id.startsWith("cast_")) continue;
    const live = liveAt(voices, t.t + 0.01);
    const nHit = live.filter((v) => HITFAM(v.id)).length;
    const nKill = live.filter((v) => KILLFAM(v.id)).length;
    important.push({ id: t.id, t: t.t, audible: t.audible, live: live.length, nHit, nKill });
  }
  const impBy = {};
  for (const i of important) {
    const b = (impBy[i.id] ||= { n: 0, throttled: 0, sumLive: 0, sumHit: 0, maxLive: 0, buried: 0 });
    b.n++;
    if (!i.audible) b.throttled++;
    b.sumLive += i.live; b.sumHit += i.nHit;
    b.maxLive = Math.max(b.maxLive, i.live);
    if (i.nHit >= 4) b.buried++;
  }
  // announcements
  const annBy = {};
  for (const a of r.anns) {
    const k = `${a.kind}/${a.priority}`;
    annBy[k] = (annBy[k] || 0) + 1;
  }
  const annPerMin = Object.fromEntries(
    Object.entries(annBy).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, +(n / (secs / 60)).toFixed(1)]),
  );

  report[name] = {
    seconds: +secs.toFixed(1),
    kills: r.totalKills,
    killsPerMin: +((r.totalKills / secs) * 60).toFixed(1),
    triggers: trigs.length,
    voices: voices.length,
    voicesPerSec: +(voices.length / secs).toFixed(2),
    throttledShare: pct(trigs.length - voices.length, trigs.length),
    peakConcurrent: conc.peak,
    peakAtSec: +(conc.peakAt / 1000).toFixed(1),
    peakVoices: at.map((v) => v.id),
    busiest1s: w1.n,
    busiest3s: w3.n,
    busiestKill1s: kw1.n,
    impactShareOfVoices: pct(voices.filter((v) => HITFAM(v.id)).length, voices.length),
    killShareOfVoices: pct(voices.filter((v) => KILLFAM(v.id)).length, voices.length),
    dotShareOfVoices: pct(voices.filter((v) => isDot(v.id)).length, voices.length),
    selfOverlapShare: pct(selfOverlaps, voices.length),
    topIds: Object.entries(byId)
      .sort((a, b) => b[1].voice - a[1].voice)
      .slice(0, 12)
      .map(([id, b]) => ({ id, perSec: +(b.voice / secs).toFixed(2), voices: b.voice, throttled: b.throttled, durMs: Math.round(b.dur * 1000) })),
    overlap: Object.entries(overlap).sort((a, b) => b[1].overlapping - a[1].overlapping).slice(0, 10),
    importantCues: Object.entries(impBy).sort((a, b) => b[1].n - a[1].n).map(([id, b]) => ({
      id, fired: b.n, throttledAway: b.throttled,
      avgConcurrentVoices: +(b.sumLive / b.n).toFixed(1),
      avgImpactVoices: +(b.sumHit / b.n).toFixed(1),
      maxConcurrent: b.maxLive,
      buriedShare: pct(b.buried, b.n),
    })),
    annPerMin,
    annTotal: r.anns.length,
    music: r.music.map((m) => `${(m.t / 1000).toFixed(0)}s:${m.id}`),
  };
}

console.log(JSON.stringify(report, null, 1));
if (existsSync(join(OUT, "raw.json"))) console.error("(browser raw.json present — analyse separately)");
