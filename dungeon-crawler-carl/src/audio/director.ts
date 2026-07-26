import { CONFIG } from "../sim/config";
import type { Announcement, GameState, HitEvent, HitKind, StatusKind } from "../sim/types";
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

/** Hits farther than this (in tiles) from the local player are inaudible. */
const EARSHOT = 24;

// Soundtrack pools. Regular fights rotate the battle bed per floor so runs
// don't wear one track out; boss arenas get dedicated themes that escalate
// toward the final floor.
const BATTLE_TRACKS: SoundId[] = ["music_battle_a", "music_battle_b", "music_battle_c"];
const CITY_BOSS_TRACKS: SoundId[] = ["music_boss_epic", "music_boss_tides"];
// A pack inside aggro range is actively hunting you (sim rule), so it reads
// as a fight even before first blood.
const PACK_RADIUS = CONFIG.monsterAggroRange;
const PACK_SIZE = 3;
const BATTLE_LINGER = 6; // seconds of quiet before battle music stands down
const BOSS_EARSHOT = 26; // a living boss within this range owns the soundtrack

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
}

export class AudioDirector {
  private prev: Prev | null = null;
  // Monsters currently winding up an attack — a new id is a fresh "tell".
  private winding = new Set<number>();
  // Pings already chimed (same pattern as winding: a new id is a fresh mark).
  private pinged = new Set<number>();
  // Loot drops already chimed (worthy drops ring once; cleared on descent).
  private chimed = new Set<number>();
  private battleUntil = 0; // state.elapsed until which the battle bed persists

  constructor(private sink: AudioSink) {}

  /** Call once per render frame with the frame's buffered feedback. */
  frame(state: GameState, hits: HitEvent[], announcements: Announcement[], localId: number): void {
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

    // A multi-kill this step: the crowd loves it. (Throttled in the engine.)
    if (state.killsThisStep >= 3) this.sink.play("crowd");
    // The System speaks — one chime regardless of how many lines queued.
    if (announcements.length > 0) this.sink.play("announce");

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
        // Crossing into a new 3-floor band: the season enters a new act.
        if (Math.floor((cur.floor - 1) / 3) !== Math.floor((prev.floor - 1) / 3)) {
          this.sink.play("band_sting");
        }
      }
      if (prev.status === "playing" && cur.status === "dead") this.sink.play("death");
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
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
      if (m.kind === "boss" && d <= BOSS_EARSHOT) bossNear = true;
      if (d <= PACK_RADIUS) pack++;
    }
    if (combat || pack >= PACK_SIZE) this.battleUntil = state.elapsed + BATTLE_LINGER;

    // Music bed follows the run's mood; the engine crossfades on change and
    // no-ops when the requested track isn't present.
    this.sink.music(
      cur.status !== "playing" ? null
      : cur.inSafeRoom ? "music_safe"
      : bossNear ? bossTrack(state.floor)
      : cur.phase === "collapse" ? "music_collapse"
      : state.elapsed < this.battleUntil ? BATTLE_TRACKS[state.floor % BATTLE_TRACKS.length]
      : "music_dungeon",
    );
  }
}
