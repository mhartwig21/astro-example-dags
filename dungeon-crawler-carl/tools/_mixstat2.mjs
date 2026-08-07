#!/usr/bin/env node
// Second pass over the sim half: sustained-density percentiles, cues-per-kill,
// and the announcement stream sorted by where main3d.ts's router would put it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const OUT = process.argv[2] || "tools/_shots/mix";
const sim = JSON.parse(readFileSync(join(OUT, "simraw.json"), "utf8"));

// main3d.ts showAnnouncement(): tip -> Mordecai card (or dropped), high ->
// centre banner, levelup -> dropped (world ring instead), rest -> toast if the
// kind is in TICKER_KINDS[notifyLevel] (default "normal" excludes "flavor").
const TICKER_NORMAL = new Set(["boss", "progress", "levelup", "loot", "achievement", "show", "tip"]);
const route = (a) => {
  if (a.kind === "tip") return "card";
  if (a.priority === "high") return "banner";
  if (a.kind === "levelup") return "dropped(levelup)";
  if (!TICKER_NORMAL.has(a.kind)) return "dropped(verbosity)";
  return "toast";
};
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

for (const [name, r] of Object.entries(sim)) {
  const secs = r.seconds;
  const voices = r.trigs.filter((t) => t.audible && t.dur > 0);
  // per-second bins
  const bins = new Array(Math.ceil(secs)).fill(0);
  for (const v of voices) bins[Math.floor(v.t / 1000)]++;
  const sorted = [...bins].sort((a, b) => a - b);
  // kill-adjacent cues: voices within 200ms after each kill
  let adj = 0;
  for (const kt of r.kills) adj += voices.filter((v) => v.t >= kt - 60 && v.t <= kt + 240).length;
  const perKill = r.kills.length ? adj / r.kills.length : 0;
  // announcements by route
  const byRoute = {};
  for (const a of r.anns) byRoute[route(a)] = (byRoute[route(a)] || 0) + 1;
  const perMin = Object.fromEntries(Object.entries(byRoute).map(([k, v]) => [k, +((v / secs) * 60).toFixed(1)]));
  // toast-route text repetition
  const toastTexts = r.anns.filter((a) => route(a) === "toast").map((a) => a.text.replace(/\d+/g, "#"));
  const rep = {};
  for (const t of toastTexts) rep[t] = (rep[t] || 0) + 1;
  const topRep = Object.entries(rep).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t, n]) => `${n}x "${t.slice(0, 46)}"`);
  console.log(`\n== ${name} (${secs.toFixed(0)}s)`);
  console.log(`  voices/s p50=${q(sorted, 0.5)} p90=${q(sorted, 0.9)} p99=${q(sorted, 0.99)} max=${sorted[sorted.length - 1]}  (mean ${(voices.length / secs).toFixed(1)})`);
  console.log(`  cues within [-60,+240]ms of a kill: ${perKill.toFixed(1)} per kill (${r.kills.length} kills)`);
  console.log(`  announcements/min by route: ${JSON.stringify(perMin)}  total ${((r.anns.length / secs) * 60).toFixed(1)}/min`);
  console.log(`  most repeated toast line: ${topRep.join(" | ")}`);
}
