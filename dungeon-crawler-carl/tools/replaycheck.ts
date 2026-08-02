/**
 * REPLAY MEASUREMENT + ROUND-TRIP PROOF, against the SHIPPING codec
 * (src/sim/replay.ts) rather than the prototype in tools/replaymeasure.ts.
 *
 * Records a scripted-bot run through RunRecorder, encodes the artifact, decodes
 * it, replays it through ReplaySession, and asserts serialize(state) matches
 * byte-for-byte. Prints the numbers COMPETITIVE.md 2.3 quotes: artifact size in
 * four encodings, replay CPU, and microseconds per tick.
 *
 * Run: npx tsx tools/replaycheck.ts [seeds] [floors]
 *      GEARED=22 GEARFLOOR=13 npx tsx tools/replaycheck.ts   (reach the deep floors)
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
import {
  RunRecorder, ReplaySession, encodeProof, decodeProof, REPLAY_DT, diffClaim,
  type RunProof,
} from "../src/sim/replay";
import { RULES_HASH } from "../src/sim/rulesHash";
import type { GameState } from "../src/sim/types";

const SHOP_LADDER = [
  "honed_edge", "killer_instinct", "primetime_cleaver", "headliner_cleaver",
  "iron_plating", "showstopper_plate", "blastplate_harness",
  "glass_charm", "ratings_magnet", "crash_helmet", "mosh_pit_helm",
];

/** The bot safe-room routine, emitting recorder actions beside each sim call. */
function shopTurn(state: GameState, pid: number, rec: RunRecorder): void {
  const p = state.players[0];
  if (p.hp < p.maxHp * 0.6) { rec.action("buy", "field_ration"); buyCatalogItem(state, pid, "field_ration"); }
  for (let i = p.inventory.length - 1; i >= 0; i--) {
    if (!p.inventory[i].catalogId) { rec.action("dismantle", i); dismantleItem(state, pid, i); }
  }
  for (const id of SHOP_LADDER) { rec.action("buy", id); buyCatalogItem(state, pid, id); }
  const w = p.equipment.weapon;
  if (w?.catalogId) {
    const cost = refitCost(w);
    if (cost && cost.sigils === 0 && (p.materials.refit_shard ?? 0) >= cost.shards && p.gold >= cost.gold + 80) {
      rec.action("refit", "weapon"); refitItem(state, pid, "weapon");
    }
  }
  if (p.gold > 200 && glyphSocketCount(p.level) > 0) { rec.action("buy", "glyph_cache"); buyCatalogItem(state, pid, "glyph_cache"); }
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
          rec.action("socket", slot, s, id); socketGlyph(state, pid, slot, s, id);
          placed = arr[s] === id;
        }
      }
    }
  }
  if (p.gold > 250) { rec.action("buy", "plating_kit"); buyCatalogItem(state, pid, "plating_kit"); }
  rec.action("ready"); setReady(state, pid);
}

const GEARED = Number(process.env.GEARED ?? 0);
const GEARFLOOR = Number(process.env.GEARFLOOR ?? 12);
function newGame(seed: number): GameState {
  return GEARED > 0
    ? createTestGame({ seed, floor: 1, level: GEARED, abilities: "all", gearFloor: GEARFLOOR, gold: 400 })
    : createGame(seed);
}

export interface Recorded { proof: RunProof; finalWorld: string; recMs: number; }

export function recordBotRun(seed: number, maxFloors = 18, maxSteps = 400000): Recorded {
  const state = newGame(seed);
  const pid = state.players[0].id;
  const mem = freshMemory();
  const testOpts = GEARED > 0
    ? { seed, floor: 1, level: GEARED, abilities: "all" as const, gearFloor: GEARFLOOR, gold: 400 }
    : undefined;
  const rec = new RunRecorder({
    seed, mode: state.mode, runKind: state.runKind, clientBuild: "replaycheck",
    startKind: testOpts ? "test" : "fresh", test: testOpts,
  });
  const t0 = performance.now();
  while (rec.ticks < maxSteps && state.status === "playing" && state.floor < 1 + maxFloors) {
    if (state.safeRoom) { shopTurn(state, pid, rec); continue; }
    const p = state.players[0];
    if (p.pendingRewards.length > 0) { rec.action("reward", 0); chooseReward(state, pid, 0); }
    if (p.pendingUpgrades.length > 0) { rec.action("upgrade", 0); chooseUpgrade(state, pid, 0); }
    step(state, rec.record(botIntent(state, mem)), REPLAY_DT);
  }
  const recMs = performance.now() - t0;
  return { proof: rec.finish(state, pid), finalWorld: serialize(state), recMs };
}

function main(): void {
  const seeds = (process.argv[2] ?? "11,47,101,555,2024,90210,7,1234").split(",").map(Number);
  const floors = Number(process.argv[3] ?? 18);
  console.log("rules era " + RULES_HASH.slice(0, 12) + " - " + seeds.length + " seeds, up to " + floors + " floors\n");
  const rows: Record<string, number | string>[] = [];
  for (const seed of seeds) {
    const { proof, finalWorld, recMs } = recordBotRun(seed, floors);
    const container = encodeProof(proof);
    const gz = gzipSync(Buffer.from(container), { level: 9 }).length;
    const br = brotliCompressSync(Buffer.from(container), {
      params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: container.length },
    }).length;

    const decoded = decodeProof(container);
    const t0 = performance.now();
    const s = new ReplaySession(decoded);
    while (!s.advance(4096));
    const replayMs = performance.now() - t0;
    const summary = s.summary();
    const lies = diffClaim(summary, decoded.claim);
    const exact = serialize(s.state) === finalWorld;

    const simSec = proof.header.ticks / 60;
    rows.push({
      seed,
      floor: summary.floor,
      status: summary.status,
      ticks: proof.header.ticks,
      simMin: +(simSec / 60).toFixed(1),
      rawKB: +((proof.header.ticks * 4) / 1024).toFixed(1),
      containerKB: +(container.length / 1024).toFixed(1),
      gzKB: +(gz / 1024).toFixed(1),
      brKB: +(br / 1024).toFixed(1),
      acts: proof.actions.length,
      recMs: Math.round(recMs),
      replayMs: Math.round(replayMs),
      xRealtime: +(simSec / (replayMs / 1000)).toFixed(0),
      usPerTick: +((replayMs * 1000) / Math.max(1, proof.header.ticks)).toFixed(1),
      exact: exact ? "yes" : "NO",
      claim: lies.length ? lies.join("/") : "true",
      death: summary.death ? summary.death.by : "-",
    });
    if (!exact) console.error("SEED " + seed + ": REPLAY DIVERGED");
    if (lies.length) console.error("SEED " + seed + ": claim mismatch " + lies.join(","));
  }
  console.table(rows);
}

if (process.argv[1] && process.argv[1].endsWith("replaycheck.ts")) main();
