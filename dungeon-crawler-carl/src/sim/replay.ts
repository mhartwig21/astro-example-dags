/**
 * RunProof v1 - the replay codec (COMPETITIVE.md 2.2 / MUST-1).
 *
 * A whole run is a seed plus the input stream that produced it: ~27 KB for a
 * 13-minute descent, against 7.0 MB for the naive "JSON-log the Intent every
 * tick" strawman. That artifact is the spine of the entire competitive layer -
 * the server re-executes it to certify a leaderboard row, the client re-executes
 * it to race a ghost, and a link to it reproduces a run exactly.
 *
 * THE LOAD-BEARING DESIGN CHOICE: quantize BEFORE the sim, not at record time.
 * The host builds an Intent, runs it through encode/decode here, and feeds the
 * DECODED value to step(). The sim therefore only ever consumes values that
 * survive the wire format, so record and replay agree BY CONSTRUCTION rather
 * than by luck. This is free: move is normalized inside the sim anyway, and
 * 1/256 of a turn (~1.4 degrees) of aim resolution is finer than a hand holds.
 * Free-position input (ping) rides the action list at full precision instead.
 *
 * This module lives INSIDE src/sim/ deliberately: the purity guard and the
 * rules hash both have to cover the codec, because a codec change is a rules
 * change - it changes what the sim eats.
 *
 * Nothing here touches wall-clock time, Math.random, or the DOM.
 */
import { CONFIG, FLOOR_BANDS, floorBand } from "./config";
import {
  buyCatalogItem, chooseReward, chooseUpgrade, claimAchievementLootBox, createGame, createTestGame,
  dismantleItem, equipFromInventory, refitItem, sellAllItems, sellItem, setReady,
  setUltimate, slotAbility, socketGlyph, step, unsocketGlyph,
} from "./game";
import { datan2, dcos, dsin, DTAU } from "./dmath";
import { RULES_HASH } from "./rulesHash";
import type { AbilityId } from "./abilities";
import type { GlyphId } from "./glyphs";
import type { TestSetup } from "./game";
import type { GameState, Intent, ItemSlot, LastHitSrc, Player, Vec2 } from "./types";

/** Artifact format version. Bump only for a WIRE change (this file's layout);
 *  a rules change moves RULES_HASH instead, and the two are different axes. */
export const REPLAY_VERSION = 1;

/** The host's fixed timestep. main3d.ts already runs `while (acc >= SIM_DT)`
 *  at 60 Hz, so recording is "write down the intent you just built" and the
 *  sim needs no change at all. Expressed as a RATIO because 1/60 must be the
 *  same double on the recorder and the verifier - it is (exact division). */
export const REPLAY_DT_NUM = 1;
export const REPLAY_DT_DEN = 60;
export const REPLAY_DT = REPLAY_DT_NUM / REPLAY_DT_DEN;

/** Hard caps, checked before any replay starts (COMPETITIVE.md 2.5 step 1).
 *  These bound a replay bomb: an attacker cannot buy more CPU than this. */
export const MAX_TICKS = 6 * 3600 * REPLAY_DT_DEN; // 6 hours of sim
export const MAX_ACTIONS = 20000;
export const MAX_PROOF_BYTES = 128 * 1024;

// Frame layout: [flags][castBits][moveDir][aimDir], 4 bytes per tick.
const FLAG_MOVE = 1;
const FLAG_ATTACK = 2;
const FLAG_STAIRS = 4;
const FLAG_FLASK = 8;
const FLAG_DASH = 16;
const FLAG_BOLT = 32;
const FLAG_NOVA = 64;
const FLAG_AIM = 128;

const CAST_SLOTS = 5; // 4 ability slots + the ultimate

/** Direction quantized to 1/256 of a turn. Uses the SIM's deterministic math
 *  (dmath), so the quantization itself is engine-independent - a codec that
 *  quantized with Math.atan2 would reintroduce the exact hole dmath closes. */
function qdir(x: number, y: number): number {
  return Math.round((datan2(y, x) / DTAU) * 256) & 255;
}
function dqdir(q: number): Vec2 {
  const a = (q / 256) * DTAU;
  return { x: dcos(a), y: dsin(a) };
}

/** Encode one Intent into `out` at byte offset `o`. */
export function encodeIntent(i: Intent, out: Uint8Array, o: number): void {
  let flags = 0;
  let cast = 0;
  const moving = i.move.x !== 0 || i.move.y !== 0;
  if (moving) flags |= FLAG_MOVE;
  if (i.attack) flags |= FLAG_ATTACK;
  if (i.useStairs) flags |= FLAG_STAIRS;
  if (i.flask) flags |= FLAG_FLASK;
  if (i.dash) flags |= FLAG_DASH;
  if (i.bolt) flags |= FLAG_BOLT;
  if (i.nova) flags |= FLAG_NOVA;
  if (i.aim) flags |= FLAG_AIM;
  for (let s = 0; s < CAST_SLOTS; s++) if (i.cast?.[s]) cast |= 1 << s;
  out[o] = flags;
  out[o + 1] = cast;
  out[o + 2] = moving ? qdir(i.move.x, i.move.y) : 0;
  out[o + 3] = i.aim ? qdir(i.aim.x, i.aim.y) : 0;
}

/** Decode one Intent from `buf` at byte offset `o`. */
export function decodeIntent(buf: Uint8Array, o: number): Intent {
  const flags = buf[o];
  const cast = buf[o + 1];
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
    for (let s = 0; s < CAST_SLOTS; s++) c.push(!!(cast & (1 << s)));
    i.cast = c;
  }
  return i;
}

/**
 * Round-trip an Intent through the wire format. THE HOST MUST FEED THE RESULT
 * OF THIS TO step() - see the module header. `ping` is deliberately dropped
 * here and re-emitted as an action, because a world position does not survive
 * an 8-bit direction and a ping is not a per-tick input.
 */
export function canonicalIntent(i: Intent): Intent {
  const b = new Uint8Array(4);
  encodeIntent(i, b, 0);
  return decodeIntent(b, 0);
}

/** RLE over identical 4-byte frames: [varint runLength][4-byte frame]. Beats
 *  gzip-alone by ~3x here because a crawler holds one direction for whole
 *  seconds; gzip on TOP of this is what gets a 13-minute run to 20 KB. */
export function rleFrames(frames: Uint8Array, ticks: number): Uint8Array {
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

/** Inverse of rleFrames. Throws on a truncated or over-long stream rather than
 *  returning a short buffer - a malformed artifact must fail loudly. */
export function unrleFrames(packed: Uint8Array, ticks: number): Uint8Array {
  if (ticks < 0 || ticks > MAX_TICKS) throw new ReplayFormatError("tick count out of range");
  const out = new Uint8Array(ticks * 4);
  let p = 0;
  let t = 0;
  while (p < packed.length) {
    let n = 0;
    let shift = 0;
    for (;;) {
      if (p >= packed.length) throw new ReplayFormatError("truncated run length");
      const b = packed[p++];
      n |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw new ReplayFormatError("run length overflow");
    }
    if (p + 4 > packed.length) throw new ReplayFormatError("truncated frame");
    const a = packed[p], b2 = packed[p + 1], c = packed[p + 2], d = packed[p + 3];
    p += 4;
    if (t + n > ticks) throw new ReplayFormatError("frame stream longer than tick count");
    for (let k = 0; k < n; k++) {
      const o = (t + k) * 4;
      out[o] = a; out[o + 1] = b2; out[o + 2] = c; out[o + 3] = d;
    }
    t += n;
  }
  if (t !== ticks) throw new ReplayFormatError("frame stream shorter than tick count");
  return out;
}

// ---------------------------------------------------------------------------
// Out-of-band actions
// ---------------------------------------------------------------------------

/** Every non-per-tick call a host can make into the sim during a run. The set
 *  is CLOSED: verification rejects an op outside it before replaying anything,
 *  so a proof can never invoke a function the design did not sanction. */
export const REPLAY_OPS = [
  "reward", "upgrade", "buy", "sell", "sellAll", "equip", "slot", "ult",
  "socket", "unsocket", "dismantle", "refit", "ready", "claim", "ping",
] as const;
export type ReplayOp = (typeof REPLAY_OPS)[number];
const OP_SET: ReadonlySet<string> = new Set(REPLAY_OPS);

/** `[tick, op, ...args]`. Ticks are non-decreasing; args are plain scalars. */
export type ReplayAction = [tick: number, op: ReplayOp, ...args: (number | string | null)[]];

/**
 * Apply one recorded action. This is the ONLY bridge from an artifact into the
 * sim's out-of-band API, and it is deliberately a closed switch rather than a
 * dispatch table keyed by a string the artifact controls.
 *
 * Note every one of these is already defensive (each starts by finding the
 * player and bailing on an illegal state), so a nonsense action from a forged
 * artifact is a no-op, not a crash - and a no-op cannot fake a result, because
 * the claim is checked against the REPLAYED world, not the artifact.
 */
export function applyReplayAction(state: GameState, playerId: number, a: ReplayAction): void {
  const n = (i: number): number => Math.floor(Number(a[i]) || 0);
  const s = (i: number): string => String(a[i] ?? "");
  switch (a[1]) {
    case "reward": chooseReward(state, playerId, n(2)); break;
    case "upgrade": chooseUpgrade(state, playerId, n(2)); break;
    case "buy": buyCatalogItem(state, playerId, s(2)); break;
    case "sell": sellItem(state, playerId, n(2)); break;
    case "sellAll": sellAllItems(state, playerId); break;
    case "equip": equipFromInventory(state, playerId, n(2)); break;
    case "slot": slotAbility(state, playerId, n(2), (a[3] == null ? null : s(3)) as AbilityId | null); break;
    case "ult": setUltimate(state, playerId, (a[2] == null ? null : s(2)) as AbilityId | null); break;
    case "socket": socketGlyph(state, playerId, n(2), n(3), s(4) as GlyphId); break;
    case "unsocket": unsocketGlyph(state, playerId, n(2), n(3)); break;
    case "dismantle": dismantleItem(state, playerId, n(2)); break;
    case "refit": refitItem(state, playerId, (typeof a[2] === "number" ? a[2] : s(2)) as number | ItemSlot); break;
    case "ready": setReady(state, playerId); break;
    case "claim": claimAchievementLootBox(state, playerId, s(2)); break;
    // A ping is free-position input, so it rides here at full precision rather
    // than being crushed into the frame's 8-bit direction. It is a one-tick
    // intent flag, applied by the caller on the tick it belongs to.
    case "ping": break;
  }
}

/** Pings are the one action that must reach step() as part of an Intent. */
function pingAt(actions: readonly ReplayAction[], idx: number): Vec2 | null {
  const a = actions[idx];
  return a[1] === "ping" ? { x: Number(a[2]) || 0, y: Number(a[3]) || 0 } : null;
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/** How the world the proof replays into was created. Only `fresh` may rank -
 *  a createTestGame start is never eligible, which makes today's polite
 *  client-side testMode exclusion structural (COMPETITIVE.md 2.5 step 2). */
export type ReplayStartKind = "fresh" | "test";

export interface RunProofHeader {
  v: number;
  /** The sim build this run was PLAYED under. The verifier must execute it
   *  under this hash or not at all - never "in the current sim to see". */
  rulesHash: string;
  seed: number;
  mode: GameState["mode"];
  runKind: GameState["runKind"];
  startKind: ReplayStartKind;
  ticks: number;
  dtNum: number;
  dtDen: number;
  /** Opaque client build string - diagnostics only, never trusted. */
  clientBuild: string;
  /** Set for a seeded event entry; the seed must then match the event's. */
  eventId?: string;
  /** Display name at record time. Carried so a replay reproduces the world
   *  EXACTLY, including the announcer copy - it feeds no rule. */
  playerName?: string;
  /** Present only when startKind is "test": the deterministic createTestGame
   *  opts the run started from. A test start is EXECUTABLE (tools and the
   *  balance harness measure against it) but never RANKABLE - the eligibility
   *  rule lives in the server, not in the codec (COMPETITIVE.md 2.5 step 2). */
  test?: TestSetup;
  /** Signed attempt ticket from POST /events/:id/start (COMPETITIVE.md 3.2A).
   *  The START is observed, which is what makes an attempt count honest. */
  ticket?: string;
}

/** What the CLIENT says happened. Checked with zero tolerance against the
 *  replayed world; every field here is a claim, none of it is evidence. */
export interface RunClaim {
  status: GameState["status"];
  won: boolean;
  floor: number;
  ticks: number;
  kills: number;
  level: number;
  ultimate: string | null;
}

export interface RunProof {
  header: RunProofHeader;
  /** RLE-packed frames (see rleFrames). */
  frames: Uint8Array;
  actions: ReplayAction[];
  claim: RunClaim;
}

/** A malformed artifact. Distinct from an era refusal - this one is garbage. */
export class ReplayFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayFormatError";
  }
}

/**
 * THE ERA GATE (COMPETITIVE.md 2.6f). A proof recorded under rules era X is
 * executable only by a sim that computes X's numbers. Stepping a foreign proof
 * into the current sim does not throw - the artifact decodes and the sim runs -
 * it quietly diverges and renders a wrong ghost with a wrong split delta, and
 * the player has no way to detect it. So: refuse, loudly, with the era named.
 */
export class ReplayEraError extends Error {
  constructor(readonly proofHash: string, readonly available: readonly string[]) {
    super("RECORDED UNDER RULES ERA " + proofHash.slice(0, 7)
      + " - NOT PLAYABLE ON ERA " + (available[0] ?? "unknown").slice(0, 7));
    this.name = "ReplayEraError";
  }
}

/**
 * Gate a proof before executing it. `available` defaults to the single era this
 * bundle carries; the sim-eras build step (COMPETITIVE.md 2.6b) widens it to
 * four. A gate that refuses everything foreign is correct from day one -
 * multi-era playback is the upgrade that makes it refuse LESS.
 */
export function assertPlayableEra(proof: RunProof, available: readonly string[] = [RULES_HASH]): void {
  if (!available.includes(proof.header.rulesHash)) {
    throw new ReplayEraError(proof.header.rulesHash, available);
  }
}

// ---------------------------------------------------------------------------
// Container: one self-describing byte string per run
// ---------------------------------------------------------------------------
//
// [0..3]  magic "DCCR"
// [4]     container version
// [5..7]  reserved (zero)
// then four length-prefixed sections, little-endian u32 lengths:
//   header JSON | frames (RLE) | actions JSON | claim JSON
// Compression is deliberately NOT in here: gzip belongs to the transport
// (node:zlib on the server, CompressionStream in the browser), so the sim
// stays free of a platform dependency and the codec stays pure.

const MAGIC = 0x44434352; // "DCCR"
const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeProof(proof: RunProof): Uint8Array {
  const h = enc.encode(JSON.stringify(proof.header));
  const a = enc.encode(JSON.stringify(proof.actions));
  const c = enc.encode(JSON.stringify(proof.claim));
  const f = proof.frames;
  const total = 8 + 16 + h.length + f.length + a.length + c.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, false);
  out[4] = REPLAY_VERSION;
  let o = 8;
  for (const part of [h, f, a, c]) {
    dv.setUint32(o, part.length, true);
    out.set(part, o + 4);
    o += 4 + part.length;
  }
  return out;
}

export function decodeProof(bytes: Uint8Array): RunProof {
  if (bytes.length < 24) throw new ReplayFormatError("artifact too short");
  if (bytes.length > MAX_PROOF_BYTES) throw new ReplayFormatError("artifact over size cap");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== MAGIC) throw new ReplayFormatError("bad magic");
  if (bytes[4] !== REPLAY_VERSION) throw new ReplayFormatError("unknown container version " + bytes[4]);
  const parts: Uint8Array[] = [];
  let o = 8;
  for (let i = 0; i < 4; i++) {
    if (o + 4 > bytes.length) throw new ReplayFormatError("truncated section header");
    const len = dv.getUint32(o, true);
    if (o + 4 + len > bytes.length) throw new ReplayFormatError("truncated section body");
    parts.push(bytes.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  let header: RunProofHeader;
  let actions: ReplayAction[];
  let claim: RunClaim;
  try {
    header = JSON.parse(dec.decode(parts[0])) as RunProofHeader;
    actions = JSON.parse(dec.decode(parts[2])) as ReplayAction[];
    claim = JSON.parse(dec.decode(parts[3])) as RunClaim;
  } catch {
    throw new ReplayFormatError("section is not valid JSON");
  }
  return { header, frames: parts[1], actions, claim };
}

/**
 * SHAPE VALIDATION - the cheap rejects, run on the request thread BEFORE
 * anything is queued (COMPETITIVE.md 2.5 step 1). Everything here is O(actions)
 * and costs microseconds; the expensive check is the replay itself.
 * Returns null when the proof is well-formed, or the reason it is not.
 */
export function validateProofShape(proof: RunProof): string | null {
  const h = proof.header;
  if (!h || typeof h !== "object") return "no header";
  if (h.v !== REPLAY_VERSION) return "unknown proof version";
  if (typeof h.rulesHash !== "string" || !/^[0-9a-f]{64}$/.test(h.rulesHash)) return "bad rules hash";
  if (!Number.isInteger(h.seed) || h.seed < 0 || h.seed > 0xffffffff) return "bad seed";
  if (!Number.isInteger(h.ticks) || h.ticks < 0 || h.ticks > MAX_TICKS) return "tick count out of range";
  if (h.dtNum !== REPLAY_DT_NUM || h.dtDen !== REPLAY_DT_DEN) return "unsupported timestep";
  if (h.startKind !== "fresh" && h.startKind !== "test") return "bad start kind";
  if (!Array.isArray(proof.actions)) return "actions is not an array";
  if (proof.actions.length > MAX_ACTIONS) return "too many actions";
  let last = -1;
  for (const a of proof.actions) {
    if (!Array.isArray(a) || a.length < 2) return "malformed action";
    const t = a[0];
    if (!Number.isInteger(t) || t < 0 || t > h.ticks) return "action tick out of range";
    if (t < last) return "actions out of order";
    last = t;
    if (typeof a[1] !== "string" || !OP_SET.has(a[1])) return "unknown action op";
    if (a.length > 6) return "action has too many arguments";
    for (let i = 2; i < a.length; i++) {
      const v = a[i];
      if (v !== null && typeof v !== "number" && typeof v !== "string") return "bad action argument";
      if (typeof v === "string" && v.length > 48) return "action argument too long";
      if (typeof v === "number" && !Number.isFinite(v)) return "non-finite action argument";
    }
  }
  const c = proof.claim;
  if (!c || typeof c !== "object") return "no claim";
  if (!Number.isInteger(c.floor) || c.floor < 1 || c.floor > CONFIG.finalFloor) return "claimed floor out of range";
  if (!Number.isInteger(c.kills) || c.kills < 0 || c.kills > 1e6) return "claimed kills out of range";
  if (!Number.isInteger(c.level) || c.level < 1 || c.level > 200) return "claimed level out of range";
  if (c.ticks !== h.ticks) return "claim disagrees with header on tick count";
  return null;
}

// ---------------------------------------------------------------------------
// Recording (the seam MUST-3's host drives)
// ---------------------------------------------------------------------------

export interface RecorderOptions {
  seed: number;
  mode: GameState["mode"];
  runKind: GameState["runKind"];
  startKind?: ReplayStartKind;
  /** Required when startKind is "test" - see RunProofHeader.test. */
  test?: TestSetup;
  clientBuild?: string;
  /** Display name at record time - carried so a replay reproduces the world
   *  exactly, including announcer copy. Feeds no rule. */
  playerName?: string;
  eventId?: string;
  ticket?: string;
  /** Stop recording past this many ticks (memory guard). 4 B/tick means a
   *  60-minute run is 864 KB; the default ceiling is the artifact cap. */
  maxTicks?: number;
}

/**
 * Records a run as it is played. The host's ONLY obligations:
 *
 *   const intent = rec.record(sampleIntent(dt));   // quantize, then...
 *   step(state, intent, REPLAY_DT);                // ...feed the DECODED value
 *
 * and one rec.action(...) beside each out-of-band sim call. That is the whole
 * integration, and the round-trip is what guarantees brief rule 1 (recording
 * must not change sim behaviour): the host feeds step() the decoded intent
 * whether or not anyone is recording, so there is no second code path to drift.
 */
export class RunRecorder {
  private frames: Uint8Array;
  private cap: number;
  private tickN = 0;
  private acts: ReplayAction[] = [];
  private truncatedAt: number | null = null;
  readonly opts: RecorderOptions;

  constructor(opts: RecorderOptions) {
    this.opts = opts;
    this.cap = Math.min(opts.maxTicks ?? MAX_TICKS, MAX_TICKS);
    // Start at 4 minutes and grow geometrically - most runs die early and the
    // ones that do not can afford a couple of copies.
    this.frames = new Uint8Array(Math.min(this.cap, 14400) * 4);
  }

  get ticks(): number { return this.tickN; }
  get actionCount(): number { return this.acts.length; }
  /** True once the run outgrew its ceiling: the proof is no longer submittable. */
  get truncated(): boolean { return this.truncatedAt !== null; }
  /** Bytes the frame buffer currently holds (before RLE + gzip). */
  get rawBytes(): number { return this.tickN * 4; }

  /** Quantize an intent, record it, and return what the sim must be fed. */
  record(intent: Intent): Intent {
    if (this.tickN >= this.cap) {
      if (this.truncatedAt === null) this.truncatedAt = this.tickN;
      return canonicalIntent(intent);
    }
    if ((this.tickN + 1) * 4 > this.frames.length) {
      const grown = new Uint8Array(Math.min(this.cap * 4, this.frames.length * 2));
      grown.set(this.frames);
      this.frames = grown;
    }
    const o = this.tickN * 4;
    encodeIntent(intent, this.frames, o);
    this.tickN++;
    // Ping is free-position and cannot survive the frame: re-emit it here.
    if (intent.ping) this.acts.push([this.tickN - 1, "ping", intent.ping.x, intent.ping.y]);
    return decodeIntent(this.frames, o);
  }

  /** Record an out-of-band sim call at the current tick. Call it BESIDE the
   *  real call, in the same order, and the replay reproduces the same world. */
  action(op: ReplayOp, ...args: (number | string | null)[]): void {
    if (this.acts.length >= MAX_ACTIONS) {
      if (this.truncatedAt === null) this.truncatedAt = this.tickN;
      return;
    }
    this.acts.push([this.tickN, op, ...args]);
  }

  /** Seal the recording against the world it produced. */
  finish(state: GameState, playerId: number): RunProof {
    const p = state.players.find((pl) => pl.id === playerId) ?? state.players[0];
    return {
      header: {
        v: REPLAY_VERSION,
        rulesHash: RULES_HASH,
        seed: this.opts.seed,
        mode: this.opts.mode,
        runKind: this.opts.runKind,
        startKind: this.opts.startKind ?? "fresh",
        test: this.opts.test,
        ticks: this.tickN,
        dtNum: REPLAY_DT_NUM,
        dtDen: REPLAY_DT_DEN,
        clientBuild: (this.opts.clientBuild ?? "").slice(0, 40),
        playerName: this.opts.playerName,
        eventId: this.opts.eventId,
        ticket: this.opts.ticket,
      },
      frames: rleFrames(this.frames, this.tickN),
      actions: this.acts,
      claim: {
        status: state.status,
        won: state.status === "won",
        floor: state.floor,
        ticks: this.tickN,
        kills: p?.kills ?? 0,
        level: p?.level ?? 1,
        ultimate: p?.abilities.ultimate ?? null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Replay + what the verifier DERIVES while it runs
// ---------------------------------------------------------------------------

/** The build a run ended on - derived from the replayed world, never claimed.
 *  A build page is therefore a read-only view of a verified run: a receipt,
 *  not an aggregate guess (COMPETITIVE.md 8.2). */
export interface RunBuild {
  level: number;
  ultimate: string | null;
  slots: (string | null)[];
  ranks: Record<string, number>;
  glyphs: { slots: (string | null)[][]; ultimate: (string | null)[] } | null;
  gear: { slot: string; name: string; rarity: string }[];
  revisions: string[];
}

/**
 * Everything the verifier learns by replaying, written onto the run row at
 * certification time rather than recomputed on read (COMPETITIVE.md 2.5.5).
 * That single decision is what lets a row stay informative after its proof
 * stops being executable: the splits, the build and the named death are DATA
 * ON THE ROW, and only WATCH and RACE depend on the film still running.
 */
export interface RunSummary {
  status: GameState["status"];
  won: boolean;
  floor: number;
  ticks: number;
  elapsedSec: number;
  kills: number;
  level: number;
  ultimate: string | null;
  /** Tick each floor was ENTERED, index 0 = floor 1. Unreached floors are -1. */
  floorEntryTicks: number[];
  /** Ticks spent in each of the six themed bands - the per-band boards (3.3)
   *  fall out of this for free, because the verifier already knows every
   *  floor-transition tick as it replays. */
  bandSplitTicks: number[];
  /**
   * Did the run actually TRAVERSE each band, or merely die inside it? A band
   * split is only a RECORD when every floor in the band was entered AND the
   * band's last floor was LEFT - otherwise "enter the band and die on the
   * threshold" is the optimal strategy for a band record, and the top of that
   * board fills with eight-second deaths. The verifier is the only honest place
   * to decide this, because it is the only place that knows the tick of every
   * floor transition. Index matches bandSplitTicks.
   */
  bandComplete: boolean[];
  /** Who landed the killing blow, straight off Player.lastHitSrc. */
  death: LastHitSrc | null;
  build: RunBuild;
  damageDealt: number;
  damageTaken: number;
  goldSpent: number;
}

function buildOf(p: Player): RunBuild {
  const gear: RunBuild["gear"] = [];
  for (const [slot, item] of Object.entries(p.equipment)) {
    if (item) gear.push({ slot, name: item.name, rarity: item.rarity });
  }
  return {
    level: p.level,
    ultimate: p.abilities.ultimate,
    slots: [...p.abilities.slots],
    ranks: { ...p.abilities.ranks },
    glyphs: p.glyphs
      ? { slots: p.glyphs.slots.map((s) => [...s]), ultimate: [...p.glyphs.ultimate] }
      : null,
    gear,
    revisions: [...(p.revisions ?? [])],
  };
}

export interface ReplaySessionOptions {
  /** Sample the crawler transform this often (Hz) into a ghost track. Omitted
   *  or 0 skips it. RACE uses 10 Hz and lerps on the main thread, so the
   *  frame cost of a ghost becomes an array index and a lerp - not 4% of a
   *  frame this project does not have (COMPETITIVE.md 4.1). */
  ghostHz?: number;
  /** Rules eras this executor can run. Defaults to the bundle own era. */
  availableEras?: readonly string[];
}

/** 10 Hz keyframes of the ghost crawler: x, y, floor. No render state and no
 *  interaction - a ghost is a rival TRAJECTORY, never a shared world. */
export interface GhostTrack {
  hz: number;
  x: number[];
  y: number[];
  floor: number[];
}

/**
 * A replay in progress. advance(n) runs at most n ticks and returns true when
 * the stream is exhausted. That chunking is what lets the verify worker hold a
 * duty cycle (COMPETITIVE.md 2.4 rule 4) and what makes a ghost seek an index.
 */
export class ReplaySession {
  readonly state: GameState;
  readonly playerId: number;
  readonly ghost: GhostTrack | null;
  private proof: RunProof;
  private frames: Uint8Array;
  private tickN = 0;
  private ai = 0;
  private floorEntry: number[] = [];
  private lastFloor = 0;
  private ghostEvery = 0;
  private finished = false;

  constructor(proof: RunProof, opts: ReplaySessionOptions = {}) {
    assertPlayableEra(proof, opts.availableEras);
    const shape = validateProofShape(proof);
    if (shape) throw new ReplayFormatError(shape);
    this.proof = proof;
    this.frames = unrleFrames(proof.frames, proof.header.ticks);
    // ALWAYS from the seed, never from a deserialized checkpoint: iteration
    // over materials and cooldowns is insertion order, which createGame
    // reproduces exactly and a restored snapshot might not (COMPETITIVE.md 2.1).
    this.state = proof.header.startKind === "test" && proof.header.test
      ? createTestGame(proof.header.test)
      : createGame(proof.header.seed, proof.header.mode, proof.header.runKind);
    if (proof.header.playerName) this.state.players[0].name = proof.header.playerName;
    this.playerId = this.state.players[0].id;
    this.lastFloor = this.state.floor;
    this.floorEntry[this.state.floor - 1] = 0;
    if (opts.ghostHz && opts.ghostHz > 0) {
      this.ghostEvery = Math.max(1, Math.round(REPLAY_DT_DEN / opts.ghostHz));
      this.ghost = { hz: REPLAY_DT_DEN / this.ghostEvery, x: [], y: [], floor: [] };
    } else {
      this.ghost = null;
    }
  }

  get tick(): number { return this.tickN; }
  /** What the submitter CLAIMED - kept beside the replay so the verifier
   *  never has to be handed the two halves separately and mismatch them. */
  get proofClaim(): RunClaim { return this.proof.claim; }
  get header(): RunProofHeader { return this.proof.header; }
  get totalTicks(): number { return this.proof.header.ticks; }
  get done(): boolean { return this.finished; }

  /** Run up to maxTicks more ticks. Returns true when the run is complete. */
  advance(maxTicks: number): boolean {
    if (this.finished) return true;
    const end = Math.min(this.proof.header.ticks, this.tickN + Math.max(1, maxTicks));
    const acts = this.proof.actions;
    while (this.tickN < end) {
      let ping: Vec2 | null = null;
      while (this.ai < acts.length && acts[this.ai][0] === this.tickN) {
        ping = pingAt(acts, this.ai) ?? ping;
        applyReplayAction(this.state, this.playerId, acts[this.ai]);
        this.ai++;
      }
      const intent = decodeIntent(this.frames, this.tickN * 4);
      // A ping is free-position input: it rides the action list at full
      // precision and is re-attached to the intent on its own tick.
      if (ping) intent.ping = ping;
      step(this.state, intent, REPLAY_DT);
      this.tickN++;
      this.markFloor();
      if (this.ghost && this.tickN % this.ghostEvery === 0) {
        const p = this.state.players[0];
        this.ghost.x.push(p.pos.x);
        this.ghost.y.push(p.pos.y);
        this.ghost.floor.push(this.state.floor);
      }
    }
    if (this.tickN >= this.proof.header.ticks) {
      // Trailing actions land on the final tick: a shop purchase on the last
      // frame is still part of the run.
      while (this.ai < acts.length && acts[this.ai][0] === this.tickN) {
        applyReplayAction(this.state, this.playerId, acts[this.ai]);
        this.ai++;
      }
      // ...and an action CAN move the floor: the last thing a run does is often
      // ready up in a safe room, which descends. Without this the summary
      // reports floor N while claiming floor N was never entered - and the band
      // that floor N-1 belongs to then looks unfinished, costing an honest run
      // a record it earned.
      this.markFloor();
      this.finished = true;
    }
    return this.finished;
  }

  /** Record the tick a floor was first entered. Called after every step AND
   *  after the trailing actions, because both can change the floor. */
  private markFloor(): void {
    if (this.state.floor === this.lastFloor) return;
    this.lastFloor = this.state.floor;
    if (this.floorEntry[this.state.floor - 1] === undefined) {
      this.floorEntry[this.state.floor - 1] = this.tickN;
    }
  }

  /** What the verifier certifies. Only meaningful once done. */
  summary(): RunSummary {
    const p = this.state.players.find((pl) => pl.id === this.playerId) ?? this.state.players[0];
    const floorEntry: number[] = [];
    for (let f = 0; f < CONFIG.finalFloor; f++) floorEntry.push(this.floorEntry[f] ?? -1);
    const bands = new Array<number>(FLOOR_BANDS.length).fill(0);
    for (let f = 0; f < CONFIG.finalFloor; f++) {
      const entered = floorEntry[f];
      if (entered < 0) continue;
      let left = this.tickN;
      for (let g = f + 1; g < CONFIG.finalFloor; g++) {
        if (floorEntry[g] >= 0) { left = floorEntry[g]; break; }
      }
      bands[floorBand(f + 1)] += left - entered;
    }
    // TRAVERSAL, not attendance. Ticks accumulate for any floor entered, which
    // is right for a ledger and catastrophic for a board: a run that steps into
    // THE APPROACH and dies on the threshold would otherwise hold an eight
    // second record for floors 16-18. A band counts only when every floor in it
    // was entered AND its last floor was left - i.e. the run reached the first
    // floor of the NEXT band, or won on the final one.
    const complete = new Array<boolean>(FLOOR_BANDS.length).fill(false);
    for (let b = 0; b < FLOOR_BANDS.length; b++) {
      const first = b * 3 + 1;
      const last = Math.min(CONFIG.finalFloor, first + 2);
      let allEntered = true;
      for (let f = first; f <= last; f++) {
        if ((floorEntry[f - 1] ?? -1) < 0) { allEntered = false; break; }
      }
      if (!allEntered) continue;
      complete[b] = last >= CONFIG.finalFloor
        ? this.state.status === "won"
        : (floorEntry[last] ?? -1) >= 0; // floorEntry is 0-indexed: [last] is floor last+1
    }
    return {
      status: this.state.status,
      won: this.state.status === "won",
      floor: this.state.floor,
      ticks: this.tickN,
      elapsedSec: this.tickN * REPLAY_DT,
      kills: p.kills,
      level: p.level,
      ultimate: p.abilities.ultimate,
      floorEntryTicks: floorEntry,
      bandSplitTicks: bands,
      bandComplete: complete,
      death: p.alive ? null : (p.lastHitSrc ?? null),
      build: buildOf(p),
      damageDealt: p.damageDealt,
      damageTaken: p.damageTaken,
      goldSpent: p.goldSpent,
    };
  }
}

/** Run a proof to completion in one go (tests, tools, the ghost worker). */
export function replayProof(proof: RunProof, opts: ReplaySessionOptions = {}): {
  summary: RunSummary; session: ReplaySession;
} {
  const s = new ReplaySession(proof, opts);
  while (!s.advance(4096)) { /* chunked so a huge proof never blocks forever */ }
  return { summary: s.summary(), session: s };
}

/**
 * ZERO TOLERANCE claim comparison (COMPETITIVE.md 2.5 step 4). Note what is
 * NOT in here: elapsed time. Elapsed is ticks * dt, and the replay runs exactly
 * the ticks the artifact carries - SO YOU CANNOT CLAIM A 4-MINUTE CLEAR WITHOUT
 * SUBMITTING 14,400 TICKS THAT ACTUALLY CLEAR IT. That is the entire anti-cheat,
 * and it is airtight in a way no heuristic ever is.
 * Returns [] when the claim is true, or the list of fields that lied.
 */
export function diffClaim(summary: RunSummary, claim: RunClaim): string[] {
  const bad: string[] = [];
  if (summary.status !== claim.status) bad.push("status");
  if (summary.won !== claim.won) bad.push("won");
  if (summary.floor !== claim.floor) bad.push("floor");
  if (summary.ticks !== claim.ticks) bad.push("ticks");
  if (summary.kills !== claim.kills) bad.push("kills");
  if (summary.level !== claim.level) bad.push("level");
  if ((summary.ultimate ?? null) !== (claim.ultimate ?? null)) bad.push("ultimate");
  return bad;
}
