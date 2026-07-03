// Audio loading seam — the sound-side mirror of render3d/assets.ts MODEL_MANIFEST.
// Each sound id the game can trigger maps to a clip under Vite's `public/audio/`.
// Missing files are handled gracefully: the engine decodes what exists and plays
// silence for the rest, so the game runs identically with zero clips present.
// See ASSETS.md ("Audio") for license-tagged sources and drop-in conventions.

export type AudioBus = "sfx" | "music" | "ui";

export interface SoundDef {
  url: string;
  bus: AudioBus;
  volume?: number; // pre-bus gain 0..1 (default 1)
  throttleMs?: number; // min ms between retriggers (default 70; combat can spam)
  loop?: boolean; // music beds loop until replaced
}

export const AUDIO_MANIFEST = {
  // Combat feedback (driven by the sim's HitEvent channel).
  hit: { url: "/audio/sfx/hit.ogg", bus: "sfx", volume: 0.8 },
  crit: { url: "/audio/sfx/crit.ogg", bus: "sfx" },
  player_hurt: { url: "/audio/sfx/player_hurt.ogg", bus: "sfx" },
  heal: { url: "/audio/sfx/heal.ogg", bus: "sfx" },
  gold: { url: "/audio/sfx/gold.ogg", bus: "sfx", volume: 0.7 },
  item: { url: "/audio/sfx/item.ogg", bus: "sfx" },

  // Skills (state-edge triggered).
  dash: { url: "/audio/sfx/dash.ogg", bus: "sfx" },
  bolt: { url: "/audio/sfx/bolt.ogg", bus: "sfx", volume: 0.7, throttleMs: 120 },
  nova: { url: "/audio/sfx/nova.ogg", bus: "sfx" },

  // Progression + world beats.
  level_up: { url: "/audio/sfx/level_up.ogg", bus: "sfx" },
  lootbox: { url: "/audio/sfx/lootbox.ogg", bus: "sfx" },
  achievement: { url: "/audio/sfx/achievement.ogg", bus: "sfx" },
  door_unlock: { url: "/audio/sfx/door_unlock.ogg", bus: "sfx" },
  descend: { url: "/audio/sfx/descend.ogg", bus: "sfx" },
  death: { url: "/audio/sfx/death.ogg", bus: "sfx" },
  victory: { url: "/audio/sfx/victory.ogg", bus: "sfx" },

  // The Show / DCC flavor.
  announce: { url: "/audio/sfx/announce.ogg", bus: "ui", volume: 0.6, throttleMs: 400 },
  sponsor: { url: "/audio/sfx/sponsor.ogg", bus: "ui" },
  crowd: { url: "/audio/sfx/crowd.ogg", bus: "sfx", throttleMs: 1500 },
  warning: { url: "/audio/sfx/warning.ogg", bus: "sfx" },

  // UI clicks (direct host triggers, not sim events).
  buy: { url: "/audio/sfx/buy.ogg", bus: "ui", volume: 0.6 },
  equip: { url: "/audio/sfx/equip.ogg", bus: "ui", volume: 0.6 },

  // Music beds — crossfaded by the director based on game state.
  music_dungeon: { url: "/audio/music/dungeon.ogg", bus: "music", volume: 0.5, loop: true },
  music_safe: { url: "/audio/music/safe_room.mp3", bus: "music", volume: 0.5, loop: true },
  music_collapse: { url: "/audio/music/collapse.wav", bus: "music", volume: 0.65, loop: true },
} satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof AUDIO_MANIFEST;
