/**
 * tools/_mixsim.ts — THE MIX, half one: density measured at the SIM+DIRECTOR
 * seam, headless, deterministic, read-only.
 *
 * Why this exists next to the browser probe: the browser can only run a
 * handful of short fights before SwiftShader/timing noise dominates, and it
 * cannot replay. This harness runs the REAL sim (createTestGame + bot.ts) and
 * the REAL src/audio/director.ts against a recording sink, then applies the
 * engine's own throttle rule (engine.ts play(): per-id, def.throttleMs ?? 70,
 * bypassed by force) to turn director TRIGGERS into audible VOICES, and the
 * clips' real decoded durations (ffprobe over public/audio) to turn voices
 * into CONCURRENCY. Nothing in src/ is touched or imported-and-patched.
 *
 * Usage: npx tsx tools/_mixsim.ts [--seconds 150] [--out tools/_shots/mix]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createTestGame, step, chooseReward, chooseUpgrade, setReady } from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { AudioDirector } from "../src/audio/director";
import { AUDIO_MANIFEST } from "../src/audio/manifest";
import type { GameState, Announcement } from "../src/sim/types";

const argv = process.argv.slice(2);
const argNum = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const SECONDS = argNum("--seconds", 150);
const OUT = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "tools/_shots/mix";
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- durations
const ROOT = process.cwd();
const durCache = new Map<string, number>();
function durationOf(id: string): number {
  if (durCache.has(id)) return durCache.get(id)!;
  const def = (AUDIO_MANIFEST as Record<string, { url: string }>)[id];
  let d = 0;
  if (def) {
    const p = join(ROOT, "public", def.url.replace(/^\//, ""));
    if (existsSync(p)) {
      try {
        d = Number(execFileSync("ffprobe", [
          "-v", "error", "-show_entries", "format=duration",
          "-of", "default=nw=1:nk=1", p,
        ], { encoding: "utf8" }).trim());
      } catch { d = 0; }
    }
  }
  if (!Number.isFinite(d)) d = 0;
  durCache.set(id, d);
  return d;
}

// ------------------------------------------------------------ recording sink
interface Trig { t: number; id: string; gain: number; force: boolean; audible: boolean; dur: number }
class RecSink {
  trigs: Trig[] = [];
  music: string | null = null;
  musicChanges: { t: number; id: string | null }[] = [];
  private last = new Map<string, number>();
  now = 0; // ms of sim time; the engine uses performance.now(), we use sim time
  play(id: string, opts: { gain?: number; force?: boolean } = {}): void {
    const def = (AUDIO_MANIFEST as Record<string, { volume?: number; throttleMs?: number }>)[id];
    const thr = def?.throttleMs ?? 70;
    const prev = this.last.get(id) ?? -Infinity;
    const audible = !!opts.force || this.now - prev >= thr;
    if (audible) this.last.set(id, this.now);
    this.trigs.push({
      t: this.now, id, force: !!opts.force, audible,
      gain: (def?.volume ?? 1) * Math.min(1, Math.max(0, opts.gain ?? 1)),
      dur: durationOf(id),
    });
  }
  musicSet(id: string | null): void {
    if (id === this.music) return;
    this.music = id;
    this.musicChanges.push({ t: this.now, id });
  }
  has(): boolean { return true; }
}

// --------------------------------------------------------------- scenarios
type Kind = "natural" | "pack" | "boss" | "elite";
interface Scen { name: string; floor: number; level: number; kind: Kind; pull?: number; seconds?: number }
const SCENS: Scen[] = [
  { name: "f03_natural", floor: 3, level: 5, kind: "natural" },
  { name: "f13_natural", floor: 13, level: 24, kind: "natural" },
  { name: "f15_natural", floor: 15, level: 28, kind: "natural" },
  { name: "f17_natural", floor: 17, level: 32, kind: "natural" },
  { name: "f03_pack", floor: 3, level: 5, kind: "pack", pull: 8, seconds: 60 },
  { name: "f13_pack", floor: 13, level: 24, kind: "pack", pull: 16, seconds: 60 },
  { name: "f15_pack", floor: 15, level: 28, kind: "pack", pull: 16, seconds: 60 },
  { name: "f17_pack", floor: 17, level: 32, kind: "pack", pull: 16, seconds: 60 },
  { name: "f15_elite", floor: 15, level: 28, kind: "elite", pull: 10, seconds: 60 },
  { name: "f15_boss", floor: 15, level: 28, kind: "boss", seconds: 90 },
];

const DT = 1 / 60;

interface AnnRec { t: number; kind: string; priority: string; text: string }

function runScenario(sc: Scen) {
  const state: GameState = createTestGame({
    seed: 7, floor: sc.floor, level: sc.level, abilities: "all", gold: 800,
  });
  const sink = new RecSink();
  const director = new AudioDirector({
    play: (id: string, opts?: object) => sink.play(id, opts ?? {}),
    music: (id: string | null) => sink.musicSet(id),
    has: () => true,
    // The mix layer's voice budget asks the sink how long a clip sounds; the
    // real engine answers from its decoded AudioBuffer, and here it answers
    // from ffprobe over the same file. Without this the harness would measure
    // the policy against a nominal 500ms instead of the shipped clip lengths.
    duration: (id: string) => durationOf(id) || undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const mem = freshMemory();
  const p = state.players[0];
  const anns: AnnRec[] = [];
  const kills: number[] = [];
  const secs = sc.seconds ?? SECONDS;
  const steps = Math.floor(secs / DT);
  let lastKills = p.kills;
  const floorTrail: { t: number; floor: number }[] = [{ t: 0, floor: state.floor }];
  const combatants: { t: number; alive: number; near: number }[] = [];

  // staging: keep the bot ALIVE and the fight ON, the same way probe.mjs and
  // the browser half stage theirs — this measures the mix under pressure, not
  // the bot's survival.
  const stage = (i: number) => {
    if (sc.kind === "natural") return;
    if (i % 15 !== 0) return; // 4x/sec
    p.hp = p.maxHp;
    if (sc.kind === "boss") {
      const b = state.monsters.find((m) => m.kind === "boss" && m.hp > 0);
      if (b) {
        b.dormant = false;
        if (Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) > 4) {
          p.pos.x = b.pos.x + 1.6; p.pos.y = b.pos.y + 1.6;
        }
      }
      for (const m of state.monsters.filter((m) => m.kind !== "boss" && m.hp > 0).slice(0, 6)) m.dormant = false;
      return;
    }
    const want = state.monsters
      .filter((m) => m.hp > 0 && (sc.kind !== "elite" || m.elite || m.affix || m.veteran))
      .slice(0, sc.pull ?? 12);
    want.forEach((m, k) => {
      const a = (k / Math.max(1, want.length)) * Math.PI * 2;
      const r = 1.2 + (k % 3) * 0.5;
      m.pos.x = p.pos.x + Math.cos(a) * r;
      m.pos.y = p.pos.y + Math.sin(a) * r;
      m.dormant = false;
      m.stagger = 0;
      m.attackCooldown = Math.min(m.attackCooldown, 0.2);
    });
  };

  for (let i = 0; i < steps && state.status === "playing"; i++) {
    sink.now = i * DT * 1000;
    if (state.safeRoom) setReady(state, p.id);
    if (p.pendingRewards.length > 0) chooseReward(state, p.id, 0);
    if (p.pendingUpgrades.length > 0) chooseUpgrade(state, p.id, 0);
    stage(i);
    const before = state.floor;
    step(state, botIntent(state, mem), DT);
    if (state.floor !== before) floorTrail.push({ t: sink.now, floor: state.floor });
    for (const a of state.announcements as Announcement[]) {
      anns.push({ t: sink.now, kind: String(a.kind), priority: String(a.priority ?? "normal"), text: a.text });
    }
    if (p.kills > lastKills) { for (let k = lastKills; k < p.kills; k++) kills.push(sink.now); lastKills = p.kills; }
    director.frame(state, state.hits, state.announcements, p.id, state.bossEvents ?? []);
    if (i % 30 === 0) {
      const alive = state.monsters.filter((m) => m.hp > 0);
      combatants.push({
        t: sink.now,
        alive: alive.length,
        near: alive.filter((m) => Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) < 12).length,
      });
    }
  }
  return {
    scenario: sc,
    seconds: sink.now / 1000,
    trigs: sink.trigs,
    anns,
    kills,
    music: sink.musicChanges,
    floorTrail,
    combatants,
    status: state.status,
    totalKills: p.kills,
  };
}

const out: Record<string, unknown> = {};
for (const sc of SCENS) {
  const r = runScenario(sc);
  const aud = r.trigs.filter((t) => t.audible);
  console.error(
    `${sc.name.padEnd(13)} ${r.seconds.toFixed(0)}s  trig=${r.trigs.length} voice=${aud.length} ` +
    `(${(aud.length / r.seconds).toFixed(1)}/s)  kills=${r.totalKills} anns=${r.anns.length} status=${r.status}`,
  );
  out[sc.name] = r;
}
writeFileSync(join(OUT, "simraw.json"), JSON.stringify(out));
console.error(`wrote ${join(OUT, "simraw.json")}`);
