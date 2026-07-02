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

  constructor(private sink: AudioSink) {}

  /** Call once per render frame with the frame's buffered feedback. */
  frame(state: GameState, hits: HitEvent[], announcements: string[], localId: number): void {
    const p = state.players.find((pl) => pl.id === localId) ?? state.players[0];
    if (!p) return;

    // Combat feedback: attenuate + pan by position relative to the local player.
    // Screen-x under the fixed iso camera grows with (world x - world y), so a
    // simple (dx - dy) pan matches what the player sees.
    for (const h of hits) {
      const dx = h.pos.x - p.pos.x;
      const dy = h.pos.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > EARSHOT) continue;
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
      boltCd: p.boltCd,
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

    // Music bed follows the run's mood; the engine crossfades on change and
    // no-ops when the requested track isn't present.
    this.sink.music(
      cur.status !== "playing" ? null
      : cur.inSafeRoom ? "music_safe"
      : cur.phase === "collapse" ? "music_collapse"
      : "music_dungeon",
    );
  }
}
