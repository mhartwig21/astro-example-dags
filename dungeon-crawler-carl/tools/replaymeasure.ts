/**
 * PROTOTYPE MEASUREMENT (COMPETITIVE.md 2): how big is a full-run input
 * stream, and how long does a headless replay take?
 *
 * Records the exact (quantized) Intent fed to step() every tick plus the
 * out-of-band actions (drafts, shop, ready), then REPLAYS the stream into a
 * fresh game from the same seed and asserts serialize() matches byte-for-byte.
 *
 * Quantization happens BEFORE the sim sees the intent - the load-bearing
 * design choice: the sim only ever consumes values that survive the wire
 * format, so record/replay is exact by construction rather than by luck.
 *
 * Run: npx tsx tools/replaymeasure.ts [seedList] [floors]
 */
import { gzipSync, brotliCompressSync, constants as zc } from "node:zlib";
import {
  createGame, createTestGame, step, chooseReward, chooseUpgrade, setReady,
  buyCatalogItem, dismantleItem, refitItem, refitCost, socketGlyph,
} from "../src/sim/game";
import { botIntent, freshMemory } from "../src/sim/bot";
import { glyphSocketCount, glyphMatches, socketLegal } from "../src/sim/glyphs";
import { ABILITY_SLOTS } from "../src/sim/abilities";
import { serialize } from "../src/sim/snapshot";
import type { GameState, Intent } from "../src/sim/types";

const DT = 1 / 60;

// One tick = 4 bytes: [flags, castBits, moveDir, aimDir]. Directions are
// 1/256 of a turn (~1.4 deg) - finer than any human input.
const FLAG_MOVE = 1, FLAG_ATTACK = 2, FLAG_STAIRS = 4, FLAG_FLASK = 8,
  FLAG_DASH = 16, FLAG_BOLT = 32, FLAG_NOVA = 64, FLAG_AIM = 128;

function qdir(x: number, y: number): number {
  return Math.round((Math.atan2(y, x) / (Math.PI * 2)) * 256) & 255;
}
function dqdir(q: number): { x: number; y: number } {
  const a = (q / 256) * Math.PI * 2;
  return { x: Math.cos(a), y: Math.sin(a) };
}

function encodeIntent(i: Intent, out: Uint8Array, o: number): void {
  let flags = 0, cast = 0;
  const moving = i.move.x !== 0 || i.move.y !== 0;
  if (moving) flags |= FLAG_MOVE;
  if (i.attack) flags |= FLAG_ATTACK;
  if (i.useStairs) flags |= FLAG_STAIRS;
  if (i.flask) flags |= FLAG_FLASK;
  if (i.dash) flags |= FLAG_DASH;
  if (i.bolt) flags |= FLAG_BOLT;
  if (i.nova) flags |= FLAG_NOVA;
  if (i.aim) flags |= FLAG_AIM;
  for (let s = 0; s < 5; s++) if (i.cast?.[s]) cast |= 1 << s;
  out[o] = flags;
  out[o + 1] = cast;
  out[o + 2] = moving ? qdir(i.move.x, i.move.y) : 0;
  out[o + 3] = i.aim ? qdir(i.aim.x, i.aim.y) : 0;
}

function decodeIntent(buf: Uint8Array, o: number): Intent {
  const flags = buf[o], cast = buf[o + 1];
  const i: Intent = {
    move: flags & FLAG_MOVE ? dqdir(buf[o + 2]) : { x: 0, y: 0 },
    useStairs: !!(flags & FLAG_STAIRS),
  };
  if (flags & FLAG_ATTACK) i.attack = true;
  if (flags & FLAG_FLASK) i.flask = true;
  if (flags & FLAG_DASH) i.dash = true;
  if (flags & FLAG_BOLT) i.bolt = true;
  if (flags & FLAG_NOVA) i.nova = true;
  if (flags & FLAG_AIM) i.aim = dqdir(buf[o + 3]);
  if (cast) {
    const c: boolean[] = [];
    for (let s = 0; s < 5; s++) c.push(!!(cast & (1 << s)));
    i.cast = c;
  }
  return i;
}

/** Round-trip an intent through the wire format - what the sim actually eats. */
function canonical(i: Intent): Intent {
  const b = new Uint8Array(4);
  encodeIntent(i, b, 0);
  return decodeIntent(b, 0);
}

/** RLE over identical 4-byte frames: [varint runLen][4-byte frame]. */
function rle(frames: Uint8Array, ticks: number): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < ticks) {
    let n = 1;
    while (i + n < ticks && n < 0xffff
      && frames[(i + n) * 4] === frames[i * 4]
      && frames[(i + n) * 4 + 1] === frames[i * 4 + 1]
      && frames[(i + n) * 4 + 2] === frames[i * 4 + 2]
      && frames[(i + n) * 4 + 3] === frames[i * 4 + 3]) n++;
    let v = n;
    while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v);
    out.push(frames[i * 4], frames[i * 4 + 1], frames[i * 4 + 2], frames[i * 4 + 3]);
    i += n;
  }
  return new Uint8Array(out);
}

type Action = [tick: number, op: string, ...args: (number | string)[]];

const SHOP_LADDER = [
  "honed_edge", "killer_instinct", "primetime_cleaver", "headliner_cleaver",
  "iron_plating", "showstopper_plate", "blastplate_harness",
  "glass_charm", "ratings_magnet", "crash_helmet", "mosh_pit_helm",
];

function applyAction(state: GameState, pid: number, a: Action): void {
  switch (a[1]) {
    case "reward": chooseReward(state, pid, a[2] as number); break;
    case "upgrade": chooseUpgrade(state, pid, a[2] as number); break;
    case "buy": buyCatalogItem(state, pid, a[2] as string); break;
    case "dismantle": dismantleItem(state, pid, a[2] as number); break;
    case "refit": refitItem(state, pid, a[2] as string as never); break;
    case "socket": socketGlyph(state, pid, a[2] as number, a[3] as number, a[4] as never); break;
    case "ready": setReady(state, pid); break;
  }
}

/** The safe-room routine the bot runs, emitting actions instead of calling directly. */
function shopActions(state: GameState, pid: number, tick: number, emit: (a: Action) => void): void {
  const p = state.players[0];
  const doIt = (a: Action): void => { emit(a); applyAction(state, pid, a); };
  if (p.hp < p.maxHp * 0.6) doIt([tick, "buy", "field_ration"]);
  for (let i = p.inventory.length - 1; i >= 0; i--) {
    if (!p.inventory[i].catalogId) doIt([tick, "dismantle", i]);
  }
  for (const id of SHOP_LADDER) doIt([tick, "buy", id]);
  const w = p.equipment.weapon;
  if (w?.catalogId) {
    const cost = refitCost(w);
    if (cost && cost.sigils === 0 && (p.materials.refit_shard ?? 0) >= cost.shards && p.gold >= cost.gold + 80) {
      doIt([tick, "refit", "weapon"]);
    }
  }
  if (p.gold > 200 && glyphSocketCount(p.level) > 0) doIt([tick, "buy", "glyph_cache"]);
  const g = p.glyphs;
  if (g) {
    for (const id of [...g.bench]) {
      let placed = false;
      for (let slot = 0; slot <= ABILITY_SLOTS && !placed; slot++) {
        const ability = slot === ABILITY_SLOTS ? p.abilities.ultimate : p.abilities.slots[slot];
        if (!ability || !glyphMatches(id, ability)) continue;
        const sockets = slot === ABILITY_SLOTS ? 1 : glyphSocketCount(p.level, slot);
        for (let s = 0; s < sockets && !placed; s++) {
          const arr = slot === ABILITY_SLOTS ? g.ultimate : g.slots[slot];
          if (arr[s] !== null || !socketLegal(p, slot === ABILITY_SLOTS ? 4 : slot, s, id)) continue;
          doIt([tick, "socket", slot, s, id]);
          placed = arr[s] === id;
        }
      }
    }
  }
  if (p.gold > 250) doIt([tick, "buy", "plating_kit"]);
}

// GEARED=<level>: start from a stage-representative crawler so the bot can
// actually reach floor 18 (createTestGame is deterministic, so replay
// reproduces the same starting character from the same opts).
const GEARED = Number(process.env.GEARED ?? 0);
const GEARFLOOR = Number(process.env.GEARFLOOR ?? 12);
function newGame(seed: number): GameState {
  return GEARED > 0
    ? createTestGame({ seed, floor: 1, level: GEARED, abilities: "all", gearFloor: GEARFLOOR, gold: 400 })
    : createGame(seed);
}

interface Recording {
  seed: number;
  frames: Uint8Array;
  ticks: number;
  actions: Action[];
  finalFloor: number;
  status: string;
  wallMs: number;
  finalHash: string;
}

function record(seed: number, maxFloors: number, maxSteps = 400000): Recording {
  const state = newGame(seed);
  const pid = state.players[0].id;
  const mem = freshMemory();
  const frames = new Uint8Array(maxSteps * 4);
  const actions: Action[] = [];
  let tick = 0;
  const t0 = performance.now();
  while (tick < maxSteps && state.status === "playing" && state.floor < 1 + maxFloors) {
    if (state.safeRoom) {
      shopActions(state, pid, tick, (a) => actions.push(a));
      actions.push([tick, "ready"]);
      setReady(state, pid);
      continue;
    }
    const p = state.players[0];
    if (p.pendingRewards.length > 0) { actions.push([tick, "reward", 0]); chooseReward(state, pid, 0); }
    if (p.pendingUpgrades.length > 0) { actions.push([tick, "upgrade", 0]); chooseUpgrade(state, pid, 0); }
    const intent = canonical(botIntent(state, mem));
    encodeIntent(intent, frames, tick * 4);
    step(state, intent, DT);
    tick++;
  }
  const wallMs = performance.now() - t0;
  return {
    seed, frames, ticks: tick, actions,
    finalFloor: state.floor, status: state.status, wallMs,
    finalHash: serialize(state),
  };
}

function replay(rec: Recording): { wallMs: number; ok: boolean } {
  const t0 = performance.now();
  const state = newGame(rec.seed);
  const pid = state.players[0].id;
  let ai = 0;
  for (let tick = 0; tick < rec.ticks; tick++) {
    while (ai < rec.actions.length && rec.actions[ai][0] === tick) applyAction(state, pid, rec.actions[ai++]);
    step(state, decodeIntent(rec.frames, tick * 4), DT);
  }
  while (ai < rec.actions.length && rec.actions[ai][0] === rec.ticks) applyAction(state, pid, rec.actions[ai++]);
  const wallMs = performance.now() - t0;
  return { wallMs, ok: serialize(state) === rec.finalHash };
}

const seeds = (process.argv[2] ?? "11,47,101,555,2024,90210,7,1234").split(",").map(Number);
const floors = Number(process.argv[3] ?? 18);

console.log("replay measurement - " + seeds.length + " seeds, up to " + floors + " floors, dt=1/60\n");
const rows: Record<string, number>[] = [];
for (const seed of seeds) {
  const rec = record(seed, floors);
  const raw4 = rec.ticks * 4;
  const packed = rle(rec.frames, rec.ticks);
  const gz = gzipSync(Buffer.from(packed), { level: 9 }).length;
  const br = brotliCompressSync(Buffer.from(packed), {
    params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: packed.length },
  }).length;
  const gzRaw = gzipSync(Buffer.from(rec.frames.subarray(0, raw4)), { level: 9 }).length;
  const actionsJson = JSON.stringify(rec.actions).length;
  const naive = rec.ticks * JSON.stringify({
    move: { x: 0.7071067811865476, y: -0.7071067811865475 }, attack: true,
    aim: { x: 0.5, y: 0.86 }, useStairs: false, cast: [true, false, false, false, false],
  }).length;
  const rp = replay(rec);
  const simSec = rec.ticks / 60;
  rows.push({
    seed, floor: rec.finalFloor, ticks: rec.ticks, simMin: +(simSec / 60).toFixed(1),
    naiveKB: +(naive / 1024).toFixed(0),
    raw4KB: +(raw4 / 1024).toFixed(1),
    rleKB: +(packed.length / 1024).toFixed(1),
    gzKB: +(gz / 1024).toFixed(1),
    brKB: +(br / 1024).toFixed(1),
    gzRawKB: +(gzRaw / 1024).toFixed(1),
    actB: actionsJson,
    acts: rec.actions.length,
    recMs: Math.round(rec.wallMs),
    replayMs: Math.round(rp.wallMs),
    xRealtime: +(simSec / (rp.wallMs / 1000)).toFixed(0),
    usPerTick: +((rp.wallMs * 1000) / rec.ticks).toFixed(1),
    exact: rp.ok ? 1 : 0,
  });
  console.log("seed " + seed + ": floor " + rec.finalFloor + " (" + rec.status + ") " + rec.ticks
    + " ticks / " + (simSec / 60).toFixed(1) + " sim-min - replay " + Math.round(rp.wallMs) + "ms ("
    + (simSec / (rp.wallMs / 1000)).toFixed(0) + "x realtime) - exact=" + rp.ok + " - gz "
    + (gz / 1024).toFixed(1) + "KB + " + actionsJson + "B actions");
}
console.table(rows);

console.log("\nper-tick sim cost by depth (createTestGame, 3000 ticks of combat):");
const depth: Record<string, number>[] = [];
for (const f of [1, 5, 9, 13, 16, 18]) {
  const g = createTestGame({ floor: f, level: Math.min(30, f * 2), abilities: "all", seed: 4242 });
  const idle: Intent = { move: { x: 1, y: 0 }, useStairs: false, attack: true, aim: { x: 1, y: 0 } };
  step(g, idle, DT);
  const t0 = performance.now();
  for (let i = 0; i < 3000; i++) step(g, idle, DT);
  const ms = performance.now() - t0;
  depth.push({ floor: f, monsters: g.monsters.length, usPerTick: +((ms * 1000) / 3000).toFixed(1), msPer1kTicks: +(ms / 3).toFixed(2) });
}
console.table(depth);


