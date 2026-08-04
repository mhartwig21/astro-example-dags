import { CONFIG, floorBand } from "../sim/config";
// The signature TABLE only (bossSignatures.ts imports nothing but types) —
// the audio director must not drag three.js into the 2D host's bundle to
// find out how a boss's tell is pitched.
import { signatureFor } from "../render3d/bossSignatures";
import type { Announcement, BossEvent, GameState, HitEvent, HitKind, MonsterKind, StatusKind } from "../sim/types";
import type { AudioSink } from "./engine";
import type { SoundId } from "./manifest";

// Maps sim feedback to sound triggers. This is the ONLY audio integration point:
// the host feeds it the same per-frame hit/announcement buffers it already gives
// the particle system, plus the state itself for edge-detection (phase changes,
// skills, doors, music selection). Pure logic over the sim's public data — no
// WebAudio here, so it's unit-testable with a fake sink and works identically
// in solo and network mode (server-relayed events arrive in the same buffers).

const HIT_SOUNDS: Record<HitKind, SoundId> = {
  enemy: "hit",
  crit: "crit",
  player: "player_hurt",
  heal: "heal",
  gold: "gold",
  weapon: "item",
  chain: "dash", // the chain whips out; the arrival's weapon flash adds the clink
};

// DoT ticks read as their ELEMENT, not as blows — burn crackles, venom
// bubbles, frost chimes (throttled in the manifest; ticks come fast).
const STATUS_SOUNDS: Record<StatusKind, SoundId> = {
  burn: "dot_burn",
  poison: "dot_poison",
  chill: "dot_chill",
};

// The moment a status LANDS (SOUNDPLAN §1.4 row 1): apply cues, distinct
// from the tick voices — ignition catch, splat, crystallize. Edge-detected
// from entity status lists (the sim emits no apply event; the lists are
// deterministic data, so replays cue identically).
const STATUS_APPLY_SOUNDS: Record<StatusKind, SoundId> = {
  burn: "apply_burn",
  poison: "apply_poison",
  chill: "apply_chill",
};

/** Hits farther than this (in tiles) from the local player are inaudible. */
const EARSHOT = 24;

/** Breakable prop keys that shatter (ceramic/glass) rather than splinter. */
const CLAY_KEY = /pot|plate|dish|bottle|goblet|mug|vase|jar|potion|glass|gem/;

// Creature bark FAMILIES (SOUNDPLAN §1.4 row 9): every archetype speaks as
// one of five species — skeletal rattle, organic beast/plant, humanoid
// show-cast, machine servo, airy phantom/witch. Bosses are deliberately
// absent: the boss-beat channel owns their voice. Unmapped kinds (crafted
// defs, future mobs) stay silent rather than guessing wrong.
type BarkFamily = "skel" | "org" | "hum" | "mech" | "air";
const BARK_FAMILY: Partial<Record<MonsterKind, BarkFamily>> = {
  grunt: "skel", swarmer: "skel", ranged: "skel", cutpurse: "skel", warden: "skel",
  brute: "org", charger: "org", spitter: "org", broodmother: "org", lasher: "org",
  understudy: "org", filcher: "org", suitactor: "org",
  bomber: "hum", drummer: "hum", digger: "hum", shieldbearer: "hum", cleric: "hum",
  duelist: "hum", sniper: "hum", stagehand: "hum", darling: "hum", canceled: "hum",
  suitguy: "hum", archivist: "hum", colossus: "hum",
  lineworker: "mech", sentinel: "mech", slagbreaker: "mech", toysoldier: "mech",
  greeter: "mech", foreman: "mech",
  phantom: "air", shaman: "air", necromancer: "air", hexer: "air",
};
/** One pain bark per monster per this many seconds (§2.4). */
const BARK_PAIN_GAP = 4;

// Footsteps (appearance r1: the world reacts to being walked through).
// Every player in earshot strides: distance walked accumulates and each
// STRIDE tiles drops one footfall, surfaced per band (the same six bands the
// art direction uses) and varied per step — three clip variants cycled plus
// deterministic rate/gain jitter hashed from (player, step count), so a run
// replays with identical audio and no two strides read machine-stamped.
// UNDERCROFT stone, SEWERS wet, GARDEN grass, RUINS stone, IRONWORKS metal,
// THE APPROACH stone.
const STEP_SURFACE = ["stone", "wet", "grass", "stone", "metal", "stone"] as const;
const STEP_VARIANTS = ["a", "b", "c"] as const;
const STRIDE = 1.15; // tiles per footfall (~4 steps/s at run speed)
/** Own steps sit under the mix; a squad mate's steps also pan + attenuate. */
const STEP_EARSHOT = 18;

// Soundtrack pools. Regular fights rotate the battle bed per floor so runs
// don't wear one track out; boss arenas get dedicated themes that escalate
// toward the final floor.
// Ambience is PER BAND (SOUNDPLAN §3, Music r1): the six generated beds,
// indexed by floorBand() — same six bands the art direction reskins by.
// `music_dungeon` is the graceful-degradation fallback for any band whose
// bed didn't decode (sink.has), mirroring the model loader's stand-ins.
const BAND_BEDS: SoundId[] = [
  "music_band_undercroft", "music_band_sewers", "music_band_garden",
  "music_band_ruins", "music_band_ironworks", "music_band_approach",
];
const BATTLE_TRACKS: SoundId[] = ["music_battle_a", "music_battle_b", "music_battle_c"];
const CITY_BOSS_TRACKS: SoundId[] = ["music_boss_epic", "music_boss_tides"];
// A pack inside aggro range is actively hunting you (sim rule), so it reads
// as a fight even before first blood.
const PACK_RADIUS = CONFIG.monsterAggroRange;
const PACK_SIZE = 3;
const BATTLE_LINGER = 6; // seconds of quiet before battle music stands down
const BOSS_EARSHOT = 26; // a living boss within this range owns the soundtrack
// BOSSES V2 §5.1 — THE APPROACH. A boss that exists but has not been
// introduced yet, this close, means the party is in the corridor. The bed
// ducks to a drone and stays there until the ringside reveal.
const APPROACH_RANGE = 34;
const APPROACH_DUCK = 0.22;

/**
 * BOSSES V2 §5.4 — the boss beat sound map. Semantic reuse of shipped clips,
 * because the game has no boss-specific audio and inventing files is not this
 * round's job. What makes them read as DIFFERENT beats is the pairing plus
 * the per-boss playback rate on the telegraph.
 */
const BEAT_SOUNDS: Record<BossEvent["kind"], SoundId | null> = {
  intro: "boss_intro",
  phase: "boss_phase", // dedicated phase HIT (row 15 — band_sting retired from double duty)
  intermission: "sponsor", // THE COMMERCIAL BREAK, and the clip is literally a jingle
  punish: "boss_punish", // the unload window OPENS: crowd-gasp + crack
  plate: "item", // armour coming off, metal on stone
  shieldbreak: "door_unlock", // a lock giving way
  enrage: "warning",
  prop: "door_unlock",
  telegraph: "tell", // pitched per boss — see signatureFor()
};

/** The final floor gets the colossal theme; city-boss arenas rotate the rest. */
function bossTrack(floor: number): SoundId {
  if (floor >= CONFIG.finalFloor) return "music_boss_colossal";
  const arena = Math.max(0, Math.floor(floor / CONFIG.bossFloorEvery) - 1);
  return CITY_BOSS_TRACKS[arena % CITY_BOSS_TRACKS.length];
}

interface Prev {
  phase: GameState["phase"];
  floor: number;
  status: GameState["status"];
  inSafeRoom: boolean;
  locked: boolean;
  level: number;
  lootBoxes: number;
  achievements: number;
  pendingRewards: boolean;
  dashTime: number;
  novaFlash: number;
  boltCd: number;
  attackSwing: number;
  frenzy: boolean;
  encounter: boolean;
  bulletTime: boolean;
  cataCd: number;
  flask: number;
  doubleCd: number;
  conceded: boolean;
}

export class AudioDirector {
  private prev: Prev | null = null;
  // The check-in menu is host UI, not sim state, so the host flags it here.
  // While it's up the campfire bed owns the room (SOUNDPLAN §3 row 7).
  private menuOpen = false;
  // Monsters currently winding up an attack — a new id is a fresh "tell".
  private winding = new Set<number>();
  // Pings already chimed (same pattern as winding: a new id is a fresh mark).
  private pinged = new Set<number>();
  // Loot drops already chimed (worthy drops ring once; cleared on descent).
  private chimed = new Set<number>();
  private battleUntil = 0; // state.elapsed until which the battle bed persists
  private ducked = false; // §5.1: the approach duck is riding
  // Footstep stride accumulators, per player id (see STEP_SURFACE above).
  private stride = new Map<number, { x: number; y: number; acc: number; n: number }>();
  // Status-apply edges: keys "m:<id>:<kind>" / "p:<id>:<kind>" currently
  // afflicted. A key appearing = the status landed. Primed on first frame so
  // a mid-run join doesn't replay every ongoing affliction.
  private afflicted = new Set<string>();
  // Breakables last seen, by id: gone = smashed (pop), hp dropped = cracked.
  private crockery = new Map<number, { x: number; y: number; hp: number; clay: boolean }>();
  // Creature bark bookkeeping: last seen state per monster id.
  private mobs = new Map<number, { fam: BarkFamily; x: number; y: number; hp: number; flash: boolean; engaged: boolean; painAt: number }>();

  constructor(private sink: AudioSink) {}

  /** Host hook: the RINGSIDE CHECK-IN (menu/campfire) opened or closed. */
  setMenu(open: boolean): void {
    this.menuOpen = open;
  }

  /** The band's ambient bed, degrading to the generic dungeon ambience when
   *  the band's file didn't decode (per-band silent-fallback philosophy). */
  private ambientBed(floor: number): SoundId {
    const bed = BAND_BEDS[floorBand(floor)] ?? "music_dungeon";
    return (this.sink.has?.(bed) ?? true) ? bed : "music_dungeon";
  }

  /** One creature bark: family voice, variant + rate hashed from the monster
   *  id (a given creature keeps ITS voice; replays sound identical). */
  private bark(p: { pos: { x: number; y: number } }, id: number, fam: BarkFamily, ev: "aggro" | "pain" | "death", x: number, y: number): void {
    const dx = x - p.pos.x, dy = y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > EARSHOT) return;
    const h = Math.imul(id + 1, 0x9e3779b1) >>> 0;
    this.sink.play(`bark_${fam}_${ev}_${(h & 1) === 0 ? "a" : "b"}` as SoundId, {
      gain: 0.85 / (1 + d / 5),
      pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      rate: 0.94 + (((h >> 8) & 0xff) / 255) * 0.12,
    });
  }

  /** One breakable voicing: material clip, positioned, hash-jittered rate
   *  (deterministic per id — replays sound identical). Cracks (hp chipped,
   *  still standing) play lighter and higher than the pop. */
  private smashAt(p: { pos: { x: number; y: number } }, id: number, x: number, y: number, clay: boolean, cracked: boolean): void {
    const dx = x - p.pos.x, dy = y - p.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > EARSHOT) return;
    const h = Math.imul(id + 1, 2654435761) >>> 0;
    this.sink.play(clay ? "smash_clay" : "smash_wood", {
      gain: (cracked ? 0.45 : 1) / (1 + d / 6),
      pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      rate: (cracked ? 1.12 : 0.92) + ((h & 0xff) / 255) * 0.16,
    });
  }

  /**
   * Call once per render frame with the frame's buffered feedback.
   * `bossEvents` is the BOSSES-V2 §7.4 channel, buffered by the host across
   * sub-steps exactly like hits and announcements.
   */
  frame(
    state: GameState, hits: HitEvent[], announcements: Announcement[], localId: number,
    bossEvents: BossEvent[] = [],
  ): void {
    const p = state.players.find((pl) => pl.id === localId) ?? state.players[0];
    if (!p) return;

    // Combat feedback: attenuate + pan by position relative to the local player.
    // Screen-x under the fixed iso camera grows with (world x - world y), so a
    // simple (dx - dy) pan matches what the player sees.
    let combat = false; // a real blow landed in earshot this frame
    for (const h of hits) {
      const dx = h.pos.x - p.pos.x;
      const dy = h.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > EARSHOT) continue;
      // DoT ticks don't count as combat (they linger after a fight and would
      // pin the battle bed up) and sound as their element instead of a blow.
      if (!h.effect && (h.kind === "enemy" || h.kind === "crit" || h.kind === "player")) combat = true;
      const opts = {
        gain: 1 / (1 + d / 6),
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      };
      this.sink.play(h.effect ? STATUS_SOUNDS[h.effect] : HIT_SOUNDS[h.kind], opts);
      // Killing blows on monsters get a meatier thump layered on top.
      if (h.killed && h.kind !== "player") this.sink.play("kill", opts);
    }

    // Enemy windup tells: one cue per attack, positioned like the hits, so
    // danger is audible even when the telegraph starts off-screen.
    const winding = new Set<number>();
    for (const m of state.monsters) {
      if (m.windup <= 0) continue;
      winding.add(m.id);
      if (this.winding.has(m.id)) continue; // already announced this attack
      const dx = m.pos.x - p.pos.x;
      const dy = m.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > EARSHOT) continue;
      this.sink.play("tell", {
        gain: 0.9 / (1 + d / 6),
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      });
    }
    this.winding = winding;

    // Footsteps: distance-driven, so cadence tracks actual speed (a slowed
    // crawler audibly trudges). A frame-to-frame jump longer than any honest
    // stride is a teleport (descent, respawn, Blindside) — reset, don't step.
    {
      const surface = STEP_SURFACE[floorBand(state.floor)] ?? "stone";
      const seen = new Set<number>();
      for (const pl of state.players) {
        seen.add(pl.id);
        const st = this.stride.get(pl.id);
        if (!st) {
          this.stride.set(pl.id, { x: pl.pos.x, y: pl.pos.y, acc: 0, n: pl.id % 2 });
          continue;
        }
        const mx = pl.pos.x - st.x, my = pl.pos.y - st.y;
        st.x = pl.pos.x; st.y = pl.pos.y;
        const moved = Math.hypot(mx, my);
        if (!pl.alive || moved <= 0) continue;
        if (moved > 1.2) { st.acc = 0; continue; } // teleport, not a stride
        st.acc += moved;
        if (st.acc < STRIDE) continue;
        st.acc %= STRIDE;
        st.n++;
        // A dash is a whoosh, not four footfalls in 200ms.
        if (pl.dashTime > 0) continue;
        const rx = pl.pos.x - p.pos.x, ry = pl.pos.y - p.pos.y;
        const dist = Math.hypot(rx, ry);
        if (dist > STEP_EARSHOT) continue;
        // Deterministic per-step jitter: hash (id, step) instead of RNG so a
        // replay sounds byte-identical and tests can pin it.
        const h = (Math.imul(pl.id + 1, 374761393) + Math.imul(st.n, 668265263)) >>> 0;
        this.sink.play(`step_${surface}_${STEP_VARIANTS[st.n % 3]}`, {
          gain: (0.72 + ((h & 0xff) / 255) * 0.28) / (1 + dist / 5),
          pan: Math.min(1, Math.max(-1, (rx - ry) * 0.12)),
          rate: 0.92 + (((h >> 8) & 0xff) / 255) * 0.16,
        });
      }
      for (const id of this.stride.keys()) if (!seen.has(id)) this.stride.delete(id);
    }

    // Status APPLY cues (row 1): a key appearing in the afflicted set = the
    // status landed this frame. Primed on the first frame so a mid-run join
    // or load doesn't replay every ongoing affliction as a fresh cue.
    {
      const primed = this.prev !== null;
      const seen = new Set<string>();
      const cue = (key: string, kind: StatusKind, x: number, y: number) => {
        const fresh = !this.afflicted.has(key);
        seen.add(key);
        if (!primed || !fresh) return;
        const dx = x - p.pos.x, dy = y - p.pos.y;
        const d = Math.hypot(dx, dy);
        if (d > EARSHOT) return;
        this.sink.play(STATUS_APPLY_SOUNDS[kind], {
          gain: 0.9 / (1 + d / 6),
          pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
        });
      };
      for (const pl of state.players) {
        if (pl.statuses) for (const s of pl.statuses) cue(`p:${pl.id}:${s.kind}`, s.kind, pl.pos.x, pl.pos.y);
      }
      for (const m of state.monsters) {
        if (m.statuses) for (const s of m.statuses) cue(`m:${m.id}:${s.kind}`, s.kind, m.pos.x, m.pos.y);
      }
      this.afflicted = seen;
    }

    // Breakable smashes (row 5): the pot pops the frame it leaves the list,
    // voiced by material (clay vs wood from the prop key), rate-spread by a
    // hash of the id so a storeroom sweep isn't a machine gun. A floor
    // change replaces the whole list — that is a descent, not a demolition.
    {
      const floorChanged = !this.prev || this.prev.floor !== state.floor;
      const seen = new Set<number>();
      for (const b of state.breakables ?? []) {
        seen.add(b.id);
        const known = this.crockery.get(b.id);
        if (!known || floorChanged) {
          this.crockery.set(b.id, { x: b.pos.x, y: b.pos.y, hp: b.hp, clay: CLAY_KEY.test(b.key) });
          continue;
        }
        if (b.hp < known.hp) this.smashAt(p, b.id, b.pos.x, b.pos.y, known.clay, true); // cracked
        known.hp = b.hp;
        known.x = b.pos.x;
        known.y = b.pos.y;
      }
      for (const [id, c] of this.crockery) {
        if (seen.has(id)) continue;
        this.crockery.delete(id);
        if (!floorChanged) this.smashAt(p, id, c.x, c.y, c.clay, false); // the pop
      }
    }

    // Creature barks (row 9): the roster finally has voices. Aggro = the
    // moment a monster first comes hunting (once per lifetime), pain = the
    // hitFlash edge gated per-monster (§2.4: one per 4s), death = the id
    // leaving the list (layers under the `kill` thump). Same floor-change
    // guard as smashes: a descent is not a massacre.
    {
      const floorChanged = !this.prev || this.prev.floor !== state.floor;
      const seen = new Set<number>();
      for (const m of state.monsters) {
        seen.add(m.id);
        const fam = BARK_FAMILY[m.kind];
        if (!fam) continue;
        const known = this.mobs.get(m.id);
        const dNear = state.players.reduce((best, pl) => {
          if (!pl.alive) return best;
          return Math.min(best, Math.hypot(m.pos.x - pl.pos.x, m.pos.y - pl.pos.y));
        }, Infinity);
        const flash = m.hitFlash > 0;
        if (!known || floorChanged) {
          this.mobs.set(m.id, { fam, x: m.pos.x, y: m.pos.y, hp: m.hp, flash, engaged: false, painAt: -Infinity });
          continue;
        }
        if (!known.engaged && !m.dormant && m.hp > 0 && dNear <= PACK_RADIUS) {
          known.engaged = true;
          this.bark(p, m.id, fam, "aggro", m.pos.x, m.pos.y);
        }
        if (flash && !known.flash && m.hp > 0 && state.elapsed - known.painAt >= BARK_PAIN_GAP) {
          known.painAt = state.elapsed;
          this.bark(p, m.id, fam, "pain", m.pos.x, m.pos.y);
        }
        if (m.hp <= 0 && known.hp > 0) this.bark(p, m.id, fam, "death", m.pos.x, m.pos.y);
        known.x = m.pos.x;
        known.y = m.pos.y;
        known.hp = m.hp;
        known.flash = flash;
      }
      for (const [id, k] of this.mobs) {
        if (seen.has(id)) continue;
        this.mobs.delete(id);
        // Reaped between frames without a seen hp<=0 edge: still a death.
        if (!floorChanged && k.hp > 0) this.bark(p, id, k.fam, "death", k.x, k.y);
      }
    }

    // Party pings: one soft System chime per fresh mark, panned toward it.
    const pinged = new Set<number>();
    for (const pg of state.pings) {
      pinged.add(pg.id);
      if (this.pinged.has(pg.id)) continue;
      const dx = pg.pos.x - p.pos.x;
      const dy = pg.pos.y - p.pos.y;
      this.sink.play("announce", {
        gain: 0.55,
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      });
    }
    this.pinged = pinged;

    // BOSSES V2 §5.4 — the boss beats. Each one is a single, unmissable cue,
    // positioned like combat hits so an off-screen telegraph is still audible
    // (the 0.2s rule is easier to hit with sound than with pixels, which is
    // exactly why every named signature gets its own pitch).
    for (const be of bossEvents) {
      const id = BEAT_SOUNDS[be.kind];
      if (!id) continue;
      const bx = be.pos?.x ?? p.pos.x, by = be.pos?.y ?? p.pos.y;
      const dx = bx - p.pos.x, dy = by - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > EARSHOT * 1.6) continue;
      const opts = {
        gain: 1 / (1 + d / 14),
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
        force: true, // one cue per sim beat; the caller IS the rate limit
        rate: be.kind === "telegraph" ? signatureFor(be.label, be.bossId).rate : 1,
      };
      this.sink.play(id, opts);
      // Crowd swell on the beats the crowd would actually react to: the
      // reveal's downbeat, a phase the PLAYER caused, and the punish window.
      if (
        be.kind === "intro" ||
        be.kind === "punish" ||
        (be.kind === "phase" && be.reason === "mechanic")
      ) this.sink.play("crowd");
      // The kill: the sim marks it as a phase edge labelled DEFEATED. The
      // low tail (boss_down) settles the building over the corpse (row 15).
      if (be.kind === "phase" && be.label === "DEFEATED") {
        this.sink.play("kill", { gain: 1, force: true });
        this.sink.play("boss_down", { force: true });
        this.sink.play("crowd");
      }
    }

    // A multi-kill this step: the crowd loves it. (Throttled in the engine.)
    if (state.killsThisStep >= 3) this.sink.play("crowd");
    // The System speaks — one IDENT regardless of how many lines queued
    // (row 8): normal lines get the 2-note blip, a headline anywhere in the
    // batch upgrades it to the heavy ident. TODAY'S RULE additionally gets
    // its paper stamp — bureaucracy, audible (row 11).
    if (announcements.length > 0) {
      this.sink.play(announcements.some((a) => a.priority === "high") ? "ident_high" : "ident");
      if (announcements.some((a) => a.text.startsWith("TODAY'S RULE"))) this.sink.play("stamp");
      // Row 6, the pickup half: a room going OPEN FOR BUSINESS rings the
      // same till the purchases use — the System's cash register is ONE
      // sound, whichever direction the money moves.
      if (announcements.some((a) => a.text.startsWith("OPEN FOR BUSINESS"))) this.sink.play("till");
    }

    const cur: Prev = {
      phase: state.phase,
      floor: state.floor,
      status: state.status,
      inSafeRoom: state.safeRoom !== null,
      locked: state.map.locked,
      level: p.level,
      lootBoxes: state.lootBoxes,
      achievements: p.achievements.length,
      pendingRewards: p.pendingRewards.length > 0,
      dashTime: p.dashTime,
      novaFlash: p.novaFlash,
      boltCd: p.cd.bolt ?? 0,
      attackSwing: p.attackSwing,
      frenzy: p.frenzy,
      encounter: state.encounter !== null,
      bulletTime: state.bulletTimeLeft > 0,
      cataCd: p.cd.cataclysm ?? 0,
      flask: p.flaskCharges,
      doubleCd: p.cd.stuntdouble ?? 0,
      conceded: p.conceded === true,
    };

    const prev = this.prev;
    this.prev = cur;
    if (prev) {
      // BULLET TIME: the mix goes underwater while the world is slowed.
      if (cur.bulletTime !== prev.bulletTime) this.sink.muffle?.(cur.bulletTime);
      // World beats (state edges the hit channel doesn't carry).
      if (prev.phase === "safe" && cur.phase === "warning") this.sink.play("warning");
      if (cur.floor !== prev.floor) {
        this.sink.play("descend");
        this.sink.play("descend_whoosh"); // row 17: the portal swallows you
        // Crossing into a new 3-floor band: the season enters a new act.
        if (Math.floor((cur.floor - 1) / 3) !== Math.floor((prev.floor - 1) / 3)) {
          this.sink.play("band_sting");
        }
      }
      if (prev.status === "playing" && cur.status === "dead") this.sink.play("death");
      // DEATH IS A DOOR (row 14): the concede is a single cold door-close.
      // Terminal, dry, no musical comment — the race forgets nobody.
      if (cur.conceded && !prev.conceded) this.sink.play("door_close", { force: true });
      if (prev.status === "playing" && cur.status === "won") this.sink.play("victory");
      if (prev.locked && !cur.locked) this.sink.play("door_unlock");
      // Local player beats.
      if (cur.level > prev.level) this.sink.play("level_up");
      if (cur.lootBoxes > prev.lootBoxes) this.sink.play("lootbox");
      if (cur.achievements > prev.achievements) this.sink.play("achievement");
      if (!prev.pendingRewards && cur.pendingRewards) this.sink.play("sponsor");
      // Crowd Frenzy kicks in: the arena roars.
      if (cur.frenzy && !prev.frenzy) this.sink.play("crowd");
      // Ringside introduction: the boss sting over the frozen reveal.
      if (cur.encounter && !prev.encounter) this.sink.play("boss_intro");
      // Skills fire on rising edges of their transient state.
      // The melee whoosh triggers on the swing itself — a whiff still sounds.
      if (cur.attackSwing > prev.attackSwing + 1e-6) this.sink.play("swing");
      if (cur.dashTime > 0 && prev.dashTime <= 0) this.sink.play("dash");
      if (cur.novaFlash > 0 && prev.novaFlash <= 0) this.sink.play("nova");
      if (cur.boltCd > prev.boltCd) this.sink.play("bolt"); // cooldown jumps on cast
      // Ability-specific layers over the shared cues (all existing clips —
      // semantic reuse, no new files): Cataclysm's earth-crack layers the
      // heavy crit impact under its nova whoosh; the flask gets the bottle
      // clink under the heal; the Stunt Double's bow gets the equip flourish
      // (the professional clocks in); Bullet Time enters on a whoosh beneath
      // the low-pass sweep.
      if (cur.cataCd > prev.cataCd) this.sink.play("crit", { gain: 0.85 });
      if (cur.flask < prev.flask) this.sink.play("item");
      if (cur.doubleCd > prev.doubleCd) this.sink.play("equip");
      if (cur.bulletTime && !prev.bulletTime) this.sink.play("dash", { gain: 0.8 });
    }

    // Worthwhile drops CHIME as they hit the floor (the loot-beam moment):
    // gear above common + tomes, positioned like combat hits; commons stay
    // quiet so the chime keeps meaning. Seen-set clears on descent.
    if (prev && state.floor !== prev.floor) this.chimed.clear();
    for (const l of state.loot) {
      if (this.chimed.has(l.id)) continue;
      const worthy = (l.kind === "item" && l.rarity && l.rarity !== "common") || l.kind === "tome";
      if (!worthy) continue;
      this.chimed.add(l.id);
      const dx = l.pos.x - p.pos.x, dy = l.pos.y - p.pos.y;
      if (Math.hypot(dx, dy) > EARSHOT) continue;
      this.sink.play("equip", { gain: 0.8, pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)) });
    }

    // Battle/boss detection. Blows landing in earshot (or a pack closing in)
    // raise the battle bed and keep it up; it stands down after a quiet spell.
    // A living boss nearby owns the soundtrack outright.
    let pack = 0;
    let bossNear = false;
    let approaching = false; // §5.1: a boss we have not been introduced to yet
    let finalPhase = false; // §5.4: the low-HP layer
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
      if (m.kind === "boss") {
        if (d <= BOSS_EARSHOT) bossNear = true;
        if (!m.introduced && d <= APPROACH_RANGE) approaching = true;
        if (m.introduced && (m.phase ?? 0) >= (m.maxPhase ?? 2)) finalPhase = true;
      }
      if (d <= PACK_RADIUS) pack++;
    }
    if (combat || pack >= PACK_SIZE) this.battleUntil = state.elapsed + BATTLE_LINGER;

    // §5.1 — THE APPROACH. Ambient ducks to a single drone in the corridor
    // into an arena, and comes back up the instant the reveal fires. This is
    // the run's last quiet moment, and quiet is the whole point of it.
    const wantDuck = approaching && !bossNear && state.encounter === null;
    if (wantDuck !== this.ducked) {
      this.ducked = wantDuck;
      this.sink.duck?.(wantDuck ? APPROACH_DUCK : 1);
    }

    // Music bed follows the run's mood; the engine crossfades on change and
    // no-ops when the requested track isn't present. The campfire check-in
    // outranks everything — while the menu is up (fresh season, mid-run
    // resume screen, even over a corpse) the player is AT the campfire, and
    // the bed says so; the run's mood takes back over the moment it closes.
    this.sink.music(
      this.menuOpen && (this.sink.has?.("music_menu") ?? true) ? "music_menu"
      : cur.status !== "playing" ? null
      : cur.inSafeRoom ? "music_safe"
      // §5.4 — the LOW-HP LAYER: on the final phase every boss escalates to
      // the colossal bed, whatever floor it is on. The finale's theme stops
      // being the finale's and starts meaning "this one is nearly over".
      : bossNear ? (finalPhase ? "music_boss_colossal" : bossTrack(state.floor))
      : cur.phase === "collapse" ? "music_collapse"
      : state.elapsed < this.battleUntil ? BATTLE_TRACKS[state.floor % BATTLE_TRACKS.length]
      : this.ambientBed(state.floor),
    );
  }
}
