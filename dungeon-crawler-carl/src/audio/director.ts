import { CONFIG } from "../sim/config";
import type { GameState, HitEvent, HitKind } from "../sim/types";
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
  const arena = Math.max(0, Math.floor(floor / CONFIG.cityBossEvery) - 1);
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
}

export class AudioDirector {
  private prev: Prev | null = null;
  private battleUntil = 0; // state.elapsed until which the battle bed persists

  constructor(private sink: AudioSink) {}

  /** Call once per render frame with the frame's buffered feedback. */
  frame(state: GameState, hits: HitEvent[], announcements: string[], localId: number): void {
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
      if (h.kind === "enemy" || h.kind === "crit" || h.kind === "player") combat = true;
      this.sink.play(HIT_SOUNDS[h.kind], {
        gain: 1 / (1 + d / 6),
        pan: Math.min(1, Math.max(-1, (dx - dy) * 0.12)),
      });
    }

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
    };

    const prev = this.prev;
    this.prev = cur;
    if (prev) {
      // World beats (state edges the hit channel doesn't carry).
      if (prev.phase === "safe" && cur.phase === "warning") this.sink.play("warning");
      if (cur.floor !== prev.floor) this.sink.play("descend");
      if (prev.status === "playing" && cur.status === "dead") this.sink.play("death");
      if (prev.status === "playing" && cur.status === "won") this.sink.play("victory");
      if (prev.locked && !cur.locked) this.sink.play("door_unlock");
      // Local player beats.
      if (cur.level > prev.level) this.sink.play("level_up");
      if (cur.lootBoxes > prev.lootBoxes) this.sink.play("lootbox");
      if (cur.achievements > prev.achievements) this.sink.play("achievement");
      if (!prev.pendingRewards && cur.pendingRewards) this.sink.play("sponsor");
      // Skills fire on rising edges of their transient state.
      if (cur.dashTime > 0 && prev.dashTime <= 0) this.sink.play("dash");
      if (cur.novaFlash > 0 && prev.novaFlash <= 0) this.sink.play("nova");
      if (cur.boltCd > prev.boltCd) this.sink.play("bolt"); // cooldown jumps on cast
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
