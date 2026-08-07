// Audio loading seam — the sound-side mirror of render3d/assets.ts MODEL_MANIFEST.
// Each sound id the game can trigger maps to a clip under Vite's `public/audio/`.
// Missing files are handled gracefully: the engine decodes what exists and plays
// silence for the rest, so the game runs identically with zero clips present.
// See ASSETS.md ("Audio") for license-tagged sources and drop-in conventions.

// `announcer` (SOUNDPLAN §2.1, added SFX r2): the System's own channel — it
// is the DUCK SOURCE. Any play on it sidechain-ducks music -6dB and sfx -3dB
// (80ms attack, 600ms release, engine.ts) — the show talks over the dungeon,
// never the reverse. The bus itself is never ducked.
export type AudioBus = "sfx" | "music" | "ui" | "announcer";

export interface SoundDef {
  url: string;
  bus: AudioBus;
  volume?: number; // pre-bus gain 0..1 (default 1)
  throttleMs?: number; // min ms between retriggers (default 70; combat can spam)
  loop?: boolean; // music beds loop until replaced
  // AUDIO R2 — stream instead of decoding to an AudioBuffer. The engine's
  // DEFAULT is the bus (`music` streams, everything else stays eager), and
  // this flag is the per-entry override. It exists for loop-ladder rung 3: a
  // BED whose el.loop seam measures badly opts back into sample-accurate
  // looping with `stream: false`. It is declared here rather than cast in
  // engine.ts so that test/audio.test.ts's "no one-shot opts into streaming"
  // assertion is a real assertion instead of a tautology about a field the
  // type system does not have.
  stream?: boolean;
}

export const AUDIO_MANIFEST = {
  // Combat feedback (driven by the sim's HitEvent channel).
  // SFX r2: hit/crit/player_hurt/nova re-leveled -5.2..-5.4dB in-file (they
  // decoded at +1.9..+2.1 dBFS and drove the compressor input to 1.218 in a
  // 20-hit brawl — the §2.2 headroom contract breach). hit's bus volume goes
  // 0.8 -> 1.0 so the net trim on the game's most-heard clip is -3.2dB.
  hit: { url: "/audio/sfx/hit.ogg", bus: "sfx", volume: 1.0 },
  crit: { url: "/audio/sfx/crit.ogg", bus: "sfx" },
  player_hurt: { url: "/audio/sfx/player_hurt.ogg", bus: "sfx" },
  heal: { url: "/audio/sfx/heal.ogg", bus: "sfx" },
  gold: { url: "/audio/sfx/gold.ogg", bus: "sfx", volume: 0.7 },
  item: { url: "/audio/sfx/item.ogg", bus: "sfx" },

  // Combat feel (edge-triggered): the melee whoosh (even on a whiff), the
  // enemy windup tell, and the meatier killing-blow thump layered over `hit`.
  swing: { url: "/audio/sfx/swing.ogg", bus: "sfx", volume: 0.5, throttleMs: 120 },
  tell: { url: "/audio/sfx/tell.ogg", bus: "sfx", volume: 0.55, throttleMs: 150 },
  kill: { url: "/audio/sfx/kill.ogg", bus: "sfx", volume: 0.9, throttleMs: 90 },
  boss_intro: { url: "/audio/sfx/boss_intro.ogg", bus: "announcer", volume: 0.9, throttleMs: 1000 },

  // Status effects (HitEvent.effect — DoT ticks read as their ELEMENT, not as
  // blows). All CC0: fire crackle (AntumDeluge), bubble (farfadet46), freeze
  // (artisticdude) — trimmed to tick length; provenance in ASSETS.md.
  dot_burn: { url: "/audio/sfx/dot_burn.ogg", bus: "sfx", volume: 0.4, throttleMs: 450 },
  dot_poison: { url: "/audio/sfx/dot_poison.ogg", bus: "sfx", volume: 0.38, throttleMs: 450 },
  dot_chill: { url: "/audio/sfx/dot_chill.ogg", bus: "sfx", volume: 0.4, throttleMs: 600 },
  // Status APPLY cues (SOUNDPLAN §1.4 row 1): the moment the status LANDS,
  // distinct from the tick voices above. Generated in-repo
  // (tools/audio/gen-sfx-world.mjs — deterministic, CC0 own work).
  apply_burn: { url: "/audio/sfx/apply_burn.ogg", bus: "sfx", volume: 0.55, throttleMs: 300 },
  apply_poison: { url: "/audio/sfx/apply_poison.ogg", bus: "sfx", volume: 0.55, throttleMs: 300 },
  apply_chill: { url: "/audio/sfx/apply_chill.ogg", bus: "sfx", volume: 0.55, throttleMs: 300 },

  // Breakable smash family (row 5): pots and crates stop popping silently.
  // Same generator script; the director picks clay vs wood from the prop key
  // and adds a hashed rate spread so a storeroom sweep doesn't machine-gun.
  smash_wood: { url: "/audio/sfx/smash_wood.ogg", bus: "sfx", volume: 0.6, throttleMs: 90 },
  smash_clay: { url: "/audio/sfx/smash_clay.ogg", bus: "sfx", volume: 0.6, throttleMs: 90 },

  // New band every 3 floors: a pizzicato flourish from the same Kenney
  // jingle pack the progression sounds already come from.
  band_sting: { url: "/audio/sfx/band_sting.ogg", bus: "sfx", volume: 0.75, throttleMs: 4000 },

  // NO FOOTSTEPS (owner call, audio r2). The step_* family (12 synthesized
  // WAVs, per-band surfaces, appearance r1) is gone — director, entries and
  // files together, so a stale id fails loud instead of silently refetching.
  // "the footsteps are really annoying.. let's not have any footsteps sound
  // effects."

  // Creature barks (SOUNDPLAN §1.4 row 9): five archetype FAMILIES — not 36
  // per-mob voices — x aggro/pain/death x 2 variants. Generated in-repo
  // (tools/audio/gen-sfx-barks.mjs); director maps MonsterKind -> family,
  // gates pain barks per-monster (4s) and picks variants by id hash.
  bark_skel_aggro_a: { url: "/audio/sfx/barks/bark_skel_aggro_a.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_skel_aggro_b: { url: "/audio/sfx/barks/bark_skel_aggro_b.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_skel_pain_a: { url: "/audio/sfx/barks/bark_skel_pain_a.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_skel_pain_b: { url: "/audio/sfx/barks/bark_skel_pain_b.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_skel_death_a: { url: "/audio/sfx/barks/bark_skel_death_a.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_skel_death_b: { url: "/audio/sfx/barks/bark_skel_death_b.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_org_aggro_a: { url: "/audio/sfx/barks/bark_org_aggro_a.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_org_aggro_b: { url: "/audio/sfx/barks/bark_org_aggro_b.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_org_pain_a: { url: "/audio/sfx/barks/bark_org_pain_a.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_org_pain_b: { url: "/audio/sfx/barks/bark_org_pain_b.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_org_death_a: { url: "/audio/sfx/barks/bark_org_death_a.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_org_death_b: { url: "/audio/sfx/barks/bark_org_death_b.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_hum_aggro_a: { url: "/audio/sfx/barks/bark_hum_aggro_a.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_hum_aggro_b: { url: "/audio/sfx/barks/bark_hum_aggro_b.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_hum_pain_a: { url: "/audio/sfx/barks/bark_hum_pain_a.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_hum_pain_b: { url: "/audio/sfx/barks/bark_hum_pain_b.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_hum_death_a: { url: "/audio/sfx/barks/bark_hum_death_a.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_hum_death_b: { url: "/audio/sfx/barks/bark_hum_death_b.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_mech_aggro_a: { url: "/audio/sfx/barks/bark_mech_aggro_a.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_mech_aggro_b: { url: "/audio/sfx/barks/bark_mech_aggro_b.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_mech_pain_a: { url: "/audio/sfx/barks/bark_mech_pain_a.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_mech_pain_b: { url: "/audio/sfx/barks/bark_mech_pain_b.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_mech_death_a: { url: "/audio/sfx/barks/bark_mech_death_a.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_mech_death_b: { url: "/audio/sfx/barks/bark_mech_death_b.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_air_aggro_a: { url: "/audio/sfx/barks/bark_air_aggro_a.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_air_aggro_b: { url: "/audio/sfx/barks/bark_air_aggro_b.ogg", bus: "sfx", volume: 0.5, throttleMs: 250 },
  bark_air_pain_a: { url: "/audio/sfx/barks/bark_air_pain_a.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_air_pain_b: { url: "/audio/sfx/barks/bark_air_pain_b.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bark_air_death_a: { url: "/audio/sfx/barks/bark_air_death_a.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },
  bark_air_death_b: { url: "/audio/sfx/barks/bark_air_death_b.ogg", bus: "sfx", volume: 0.55, throttleMs: 250 },

  // THE ACT — ability cast cues (SOUNDPLAN §1.4 row E-21, audio r2).
  // The inventory used to be built by walking the DIRECTOR'S mappings instead
  // of the ability ROSTER, so 13 of the 16 abilities had no cue of their own:
  // not silent, but speaking in BORROWED clips (the `item` pickup chime via
  // the sim's "weapon" juice poofs, the dash whoosh via "chain" hits, `equip`
  // for Stunt Double, `crit` for Fault Line, `dash` at 0.8 for Bullet Time).
  // Twelve new clips + a regenerated `cast_dash` close it; all from ONE
  // generator (tools/audio/gen-sfx-casts.mjs) so the family is one voice.
  //
  // Loudness (§2.2, two rows added for this family): actives -17 LUFS
  // momentary / peak ≤ -4.5 dBFS — deliberately 2dB UNDER impacts, because
  // the consequence must out-punch the act; ultimates -14.5 / ≤ -3.0, at
  // announcer level because an ultimate IS an event (they stay on `sfx`
  // though: `announcer` is the duck SOURCE and an ultimate must not step on
  // the bed). throttleMs is derived from each ability's cooldown FLOOR.
  //
  // `dash` (Kenney stock) is GONE, not aliased: owner verdict §1.3a. A stale
  // id now fails loud, the same reasoning the step_* removal used, which is
  // what forced HIT_SOUNDS.chain to be re-decided instead of inheriting it.
  cast_dash: { url: "/audio/sfx/cast_dash.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  bolt: { url: "/audio/sfx/bolt.ogg", bus: "sfx", volume: 0.7, throttleMs: 120 },
  nova: { url: "/audio/sfx/nova.ogg", bus: "sfx" },
  cast_orbit: { url: "/audio/sfx/cast_orbit.ogg", bus: "sfx", volume: 0.45, throttleMs: 400 },
  // The quietest and shortest of the family on purpose: a Flow build swaps
  // stance every ~1.8s, so this is the row most at risk of fatigue (§9).
  cast_stance: { url: "/audio/sfx/cast_stance.ogg", bus: "sfx", volume: 0.36, throttleMs: 500 },
  // One file, two moments: the director replays it at rate 1.3 / gain 0.55 on
  // the SPEND edge, so the release of the banked hit is audible too.
  cast_overcharge: { url: "/audio/sfx/cast_overcharge.ogg", bus: "sfx", volume: 0.45, throttleMs: 600 },
  // 250: Second Take makes a double-cut a real play, and both cuts must sound.
  cast_cutto: { url: "/audio/sfx/cast_cutto.ogg", bus: "sfx", volume: 0.45, throttleMs: 250 },
  cast_crowdsurf: { url: "/audio/sfx/cast_crowdsurf.ogg", bus: "sfx", volume: 0.45, throttleMs: 500 },
  cast_stuntdouble: { url: "/audio/sfx/cast_stuntdouble.ogg", bus: "sfx", volume: 0.45, throttleMs: 800 },
  cast_bulwark: { url: "/audio/sfx/cast_bulwark.ogg", bus: "sfx", volume: 0.45, throttleMs: 700 },
  cast_cables: { url: "/audio/sfx/cast_cables.ogg", bus: "sfx", volume: 0.45, throttleMs: 700 },
  // Ultimates.
  cast_airstrike: { url: "/audio/sfx/cast_airstrike.ogg", bus: "sfx", volume: 0.6, throttleMs: 1500 },
  cast_cataclysm: { url: "/audio/sfx/cast_cataclysm.ogg", bus: "sfx", volume: 0.6, throttleMs: 1500 },
  // Played BEFORE muffle(true) in the frame — the engine sweeps a 700Hz
  // master LPF on the same edge, and this clip's energy sits at 374Hz by
  // construction so it survives its own muffle.
  cast_bullettime: { url: "/audio/sfx/cast_bullettime.ogg", bus: "sfx", volume: 0.6, throttleMs: 1500 },
  cast_injunction: { url: "/audio/sfx/cast_injunction.ogg", bus: "sfx", volume: 0.6, throttleMs: 2000 },
  // The taut-line tick for HIT_SOUNDS.chain — four different things emit
  // "chain" hits (including monster grabs) and every one of them used to play
  // the dash whoosh. Room-tone family (-28), so it stays under the impact.
  chain_line: { url: "/audio/sfx/chain_line.ogg", bus: "sfx", volume: 0.7, throttleMs: 200 },
  // The dry steel tick for HIT_SOUNDS.weapon, which was the `item` PICKUP
  // CHIME. That is the round's own thesis finally finished: r2 shipped 13 cast
  // cues and left six of them (orbit, stance, overcharge, bulwark, cutto,
  // crowdsurf) ringing a coin chime underneath their own cue on the cast
  // frame — measured LOUDER than the cue through a 250Hz highpass. And it was
  // never only a cast artifact: `"weapon"` has 30 emitters in src/sim/game.ts
  // and most are monster-side (adds arriving, risers, boss children, the orbit
  // parry, the snare snip), every one of which rang a pickup.
  // Room-tone family so it reads UNDER the impact it accompanies.
  weapon_flash: { url: "/audio/sfx/weapon_flash.ogg", bus: "sfx", volume: 0.7, throttleMs: 90 },
  // `melee` deliberately has NO cast clip: `swing` (above) IS its cast cue,
  // and its consequence is hit/crit/kill. See director.ts CAST_SOUNDS.

  // Progression + world beats.
  level_up: { url: "/audio/sfx/level_up.ogg", bus: "sfx", volume: 0.8 },
  lootbox: { url: "/audio/sfx/lootbox.ogg", bus: "sfx" },
  achievement: { url: "/audio/sfx/achievement.ogg", bus: "sfx" },
  door_unlock: { url: "/audio/sfx/door_unlock.ogg", bus: "sfx" },
  descend: { url: "/audio/sfx/descend.ogg", bus: "sfx" },
  death: { url: "/audio/sfx/death.ogg", bus: "sfx" },
  victory: { url: "/audio/sfx/victory.ogg", bus: "sfx" },

  // The System's stinger language (SOUNDPLAN §4.1 + rows 8/10-17): twelve
  // cues from ONE generator (tools/audio/gen-sfx-announcer.mjs) sharing a
  // bell timbre, so the whole announcer surface is one voice — dry,
  // broadcast, a little too professional. Never a laugh track.
  ident: { url: "/audio/sfx/ident.ogg", bus: "announcer", volume: 0.6, throttleMs: 400 },
  ident_high: { url: "/audio/sfx/ident_high.ogg", bus: "announcer", volume: 0.7, throttleMs: 1000 },
  stamp: { url: "/audio/sfx/stamp.ogg", bus: "announcer", volume: 0.65, throttleMs: 2000 },
  count_tick: { url: "/audio/sfx/count_tick.ogg", bus: "announcer", volume: 0.7, throttleMs: 150 },
  count_go: { url: "/audio/sfx/count_go.ogg", bus: "announcer", volume: 0.85, throttleMs: 1000 },
  ledger_bank: { url: "/audio/sfx/ledger_bank.ogg", bus: "ui", volume: 0.7, throttleMs: 3000 },
  door_close: { url: "/audio/sfx/door_close.ogg", bus: "sfx", volume: 0.8, throttleMs: 2000 },
  draft_pick: { url: "/audio/sfx/draft_pick.ogg", bus: "ui", volume: 0.7 },
  draft_bank: { url: "/audio/sfx/draft_bank.ogg", bus: "ui", volume: 0.6, throttleMs: 500 },
  descend_whoosh: { url: "/audio/sfx/descend_whoosh.ogg", bus: "sfx", volume: 0.6, throttleMs: 1500 },
  verdict: { url: "/audio/sfx/verdict.ogg", bus: "announcer", volume: 0.8, throttleMs: 3000 },
  till: { url: "/audio/sfx/till.ogg", bus: "ui", volume: 0.7, throttleMs: 300 },

  // Boss beats that earned dedicated files (row 15): the phase HIT
  // (band_sting stops doing double duty), the punish-window opener
  // (crowd-gasp + crack), and the DEFEATED low tail under kill+crowd.
  boss_phase: { url: "/audio/sfx/boss_phase.ogg", bus: "sfx", volume: 0.85, throttleMs: 800 },
  boss_punish: { url: "/audio/sfx/boss_punish.ogg", bus: "sfx", volume: 0.9, throttleMs: 800 },
  boss_down: { url: "/audio/sfx/boss_down.ogg", bus: "sfx", volume: 0.9, throttleMs: 2000 },

  // The Show / DCC flavor.
  announce: { url: "/audio/sfx/announce.ogg", bus: "ui", volume: 0.6, throttleMs: 400 },
  sponsor: { url: "/audio/sfx/sponsor.ogg", bus: "ui" },
  crowd: { url: "/audio/sfx/crowd.ogg", bus: "sfx", throttleMs: 1500 },
  warning: { url: "/audio/sfx/warning.ogg", bus: "sfx" },

  // UI clicks (direct host triggers, not sim events).
  buy: { url: "/audio/sfx/buy.ogg", bus: "ui", volume: 0.6 },
  equip: { url: "/audio/sfx/equip.ogg", bus: "ui", volume: 0.6 },

  // Music beds — crossfaded by the director based on game state.
  // The six band beds + the campfire bed (SOUNDPLAN §3, Music r1): generated
  // in-repo by tools/audio/gen-music-beds.mjs (stereo, -23 LUFS-I, loop-fold
  // seams — measured per bed in the generator's commit). The director routes
  // ambience by floorBand(); `music_dungeon` stays the fallback for any band
  // whose file is absent (the silent-fallback philosophy, per-band).
  music_band_undercroft: { url: "/audio/music/band_undercroft.ogg", bus: "music", volume: 0.5, loop: true },
  music_band_sewers: { url: "/audio/music/band_sewers.ogg", bus: "music", volume: 0.5, loop: true },
  music_band_garden: { url: "/audio/music/band_garden.ogg", bus: "music", volume: 0.5, loop: true },
  music_band_ruins: { url: "/audio/music/band_ruins.ogg", bus: "music", volume: 0.5, loop: true },
  music_band_ironworks: { url: "/audio/music/band_ironworks.ogg", bus: "music", volume: 0.5, loop: true },
  music_band_approach: { url: "/audio/music/band_approach.ogg", bus: "music", volume: 0.5, loop: true },
  // The check-in: menu + campfire lineup — the only near-friendly cue in the
  // game. Host-flagged via AudioDirector.setMenu (menus are not sim state).
  music_menu: { url: "/audio/music/menu.ogg", bus: "music", volume: 0.5, loop: true },
  music_dungeon: { url: "/audio/music/dungeon.ogg", bus: "music", volume: 0.5, loop: true },
  // Both re-encoded to OGG (SOUNDPLAN §1.4 rows 19/20): format conversion
  // only, measured LUFS unchanged (-18.0 / -8.1), banked 8.4MB of payload.
  music_safe: { url: "/audio/music/safe_room.ogg", bus: "music", volume: 0.5, loop: true },
  music_collapse: { url: "/audio/music/collapse.ogg", bus: "music", volume: 0.65, loop: true },
  // Battle rotation (regular combat; picked per floor — see director.ts).
  music_battle_a: { url: "/audio/music/battle_theme_a.ogg", bus: "music", volume: 0.5, loop: true },
  music_battle_b: { url: "/audio/music/battle_music.ogg", bus: "music", volume: 0.5, loop: true },
  // TRIMMED 262.45s -> 64.0s (perf-mobile opt8, HANDOFF §3d; the cut lives in
  // tools/audio/fix-beds.mjs and is documented as a derivative in ASSETS.md).
  // Nothing here changes: same id, same url, same volume — it is the FILE that
  // got shorter. Streaming does not make an over-long bed free, because the
  // director picks this one by BATTLE_TRACKS[floor % 3] mid-fight, and the
  // element then fetches and buffers the whole thing: measured 3,654,308 bytes
  // arriving 12.9s into a floor-11 fight, 262.5s buffered ahead, in the scene
  // that already runs at 9.1fps. The bed is dropped 6s after the last blow.
  // Note the floor rule when probing this: index 2 is floors 2/5/8/11/14/17,
  // so the floor-10 combat scene every perf probe drives picks battle_b and
  // can never see this fetch at all.
  music_battle_c: { url: "/audio/music/battle_winter.ogg", bus: "music", volume: 0.5, loop: true },
  // Boss themes: city-boss arenas (floors 6/12) escalate to the final floor.
  music_boss_epic: { url: "/audio/music/boss_epic.ogg", bus: "music", volume: 0.55, loop: true },
  music_boss_tides: { url: "/audio/music/boss_blackmoor.ogg", bus: "music", volume: 0.55, loop: true },
  music_boss_colossal: { url: "/audio/music/boss_colossal.ogg", bus: "music", volume: 0.6, loop: true },
} satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof AUDIO_MANIFEST;
