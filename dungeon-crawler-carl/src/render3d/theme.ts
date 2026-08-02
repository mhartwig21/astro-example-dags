// Art-direction palette and tunables for the 3D isometric renderer. Kept in one
// place so the whole look can be retuned without touching scene-graph code. These
// values define the placeholder low-poly style that stands in until the CC0 glTF
// packs listed in ASSETS.md are dropped into /public/assets.

/**
 * Cinematic per-band lighting + grade. Each 3-floor district gets a full
 * 3-point rig (colored ambient fill, warm key, cool rim), an environment
 * gradient for material sheen, and a display-space color grade (split-tone +
 * vignette) applied by the renderer's post chain. Darks lift toward a HUE —
 * deep blue-purple undercroft, green-black sewers — never true black.
 */
export interface BandMood {
  ambient: number; ambientIntensity: number;
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  key: number; keyIntensity: number;
  rim: number; rimIntensity: number; // cool accent from behind-left
  envHorizon: number; // PMREM gradient horizon tint (sky/ground derive from the rig)
  envIntensity: number;
  gradeShadow: number; // darks lift toward this hue (never true black)
  gradeHighlight: number; // brights tint toward this (normalized to luma 1)
  gradeSaturation: number; // 1 = neutral
  vignette: number; // 0..1 film-vignette strength
  voidInner: number; // out-of-bounds ground gradient, near the play space
  voidOuter: number; // ...falling off to this at the horizon (also vignette tint)
  fogDark: number; // unexplored instanced tiles multiply toward this (colored dark)
  // THE SECOND HUE POLE. Everything above describes the LIT world, which on
  // every band is one warm illuminant — measured, the shipping frame held ONE
  // hue cluster across a 45-degree arc with 43% of the playfield black to the
  // eye. `atmo` is the colour of the AIR: a smooth, textureless radiance that
  // unlit and distant space settles onto instead of falling to zero. It is the
  // cold end of the frame and it must be a real, saturated hue against the
  // torches — that opposition is what turns a tint into a design.
  atmo: number;
  // Scene-linear PEAK radiance of the air, just past the lit frontier; it decays
  // exponentially with distance from there (renderer3d.worldLit). ~0.011-0.016
  // is the readable band on this pipeline (ACES at exposure 1.22): below it the
  // far dark goes back to black, above it the unexplored map floods into one
  // flat sheet of colour, which is worse than the black was.
  atmoLevel: number;
}

export const DEFAULT_MOOD: BandMood = {
  ambient: 0x2e2a52, ambientIntensity: 0.6,
  hemiSky: 0x4a4a78, hemiGround: 0x241a10, hemiIntensity: 0.45,
  key: 0xffe8c4, keyIntensity: 1.7,
  rim: 0x6a8cff, rimIntensity: 0.55,
  envHorizon: 0xffb060, envIntensity: 0.35,
  gradeShadow: 0x16132b, gradeHighlight: 0xfff2dc, gradeSaturation: 1.05,
  vignette: 0.32,
  voidInner: 0x171733, voidOuter: 0x0b0c1c,
  fogDark: 0x0b0a18,
  atmo: 0x4a6ee0, atmoLevel: 0.0135,
};

export const THEME = {
  // Scene mood. Fog is tuned around the orthographic camera distance (camDist):
  // meshes sit ~camDist units from the camera, so fog must start beyond that or the
  // whole scene fogs to the background color.
  background: 0x0a0a12,
  fog: 0x0a0a12,
  camDist: 28, // orthographic camera pullback (does not affect zoom, only fog/clipping)
  fogNear: 26,
  fogFar: 52,

  // Filmic pipeline: ACES tone map + exposure (post chain lives in renderer3d).
  toneExposure: 1.22,

  // Lighting (moody dungeon, but readable mid-floor). These are the FALLBACK
  // rig values — per-band moods (floorThemes.ts) override them on floor build.
  ambient: 0x33334d,
  ambientIntensity: 0.55,
  hemiSky: 0x5a5a82,
  hemiGround: 0x1a1a12,
  hemiIntensity: 0.5,
  keyLight: 0xfff1d0,
  keyIntensity: 1.5,
  torchColor: 0xff9a3c,
  torchIntensity: 2.4,
  // Short throw: the dynamic lights are FILL over the baked shadowed pools
  // (lightGrid.ts) — a long unshadowed throw would wash through walls.
  torchDistance: 6.5,

  // Materials (low-poly, flat-shaded). The wall fill is REAL STONE albedo —
  // a mid-value violet-grey the key light and torch pools can actually paint
  // (a near-black fill box reads as unlit placeholder geometry; the per-band
  // instance tint + the wall-base gradient carry the darkening).
  floor: 0x2a2740,
  floorAlt: 0x322d4a,
  wall: 0x8d8798, // mid-value stone the key/torch light can visibly paint
  wallTop: 0x847e94,
  stairs: 0xc9a24b,

  player: 0x4fd1ff,
  playerTrim: 0xeaf6ff,
  weapon: 0xd8dde6,
  monster: 0xe2574c,
  monsterTrim: 0x2a0f0d,

  // Enemy archetype colors + relative body scale.
  archetype: {
    grunt: { color: 0xe2574c, scale: 1.0 },
    swarmer: { color: 0x8bd450, scale: 0.7 },
    brute: { color: 0x9a6bff, scale: 1.45 },
    ranged: { color: 0xe8a13c, scale: 0.95 },
    bomber: { color: 0xff5a2e, scale: 0.9 }, // orange-red: reads as "about to explode"
    shaman: { color: 0x3fbf6f, scale: 1.0 }, // green: the healer, shoot it first
    phantom: { color: 0xbfe4ff, scale: 0.85 }, // pale blue: ghostly blink-striker
    charger: { color: 0xd97b29, scale: 1.25 }, // rust orange: the freight train
    spitter: { color: 0xa4c93f, scale: 0.95 }, // acid green: don't stand in it
    necromancer: { color: 0x8a5cff, scale: 1.05 }, // violet: kill the caster first
    broodmother: { color: 0xd45db8, scale: 1.4 }, // magenta: the nest — kill it first
    drummer: { color: 0xc9822e, scale: 1.05 }, // war-drum bronze: silence the band
    filcher: { color: 0xf2c14e, scale: 0.8 }, // gold: it IS the loot — chase it
    lineworker: { color: 0x8fa3ad, scale: 1.1 }, // industrial steel: the piston
    sentinel: { color: 0xff4d6d, scale: 1.0 }, // targeting-laser red: watch the lock
    slagbreaker: { color: 0xd96b2b, scale: 1.5 }, // furnace orange: count to three
    toysoldier: { color: 0xc94f4f, scale: 0.85 }, // parade red: the volley line
    greeter: { color: 0x9a7fb8, scale: 1.05 }, // showroom mauve: it was a prop
    lasher: { color: 0x3f9142, scale: 1.05 }, // vine green: watch the lane
    understudy: { color: 0x8d7a6a, scale: 0.95 }, // understudy beige: for now
    hexer: { color: 0xa64ca6, scale: 1.0 }, // briar purple: kill the witch
    cutpurse: { color: 0xcfd45d, scale: 0.85 }, // coin-glint yellow: guard the purse
    warden: { color: 0xd8d0c0, scale: 1.5 }, // ossuary bone: the vault furniture
    digger: { color: 0xb08968, scale: 1.15 }, // pit-clay brown: respect the club
    shieldbearer: { color: 0xc0c8d8, scale: 1.15 }, // temple steel: go around
    cleric: { color: 0xe8c96a, scale: 1.0 }, // consecration gold: kill it first
    archivist: { color: 0x6a8fd8, scale: 1.0 }, // manuscript blue: shut the book
    colossus: { color: 0x9a948a, scale: 1.55 }, // masonry grey: the furniture fights
    stagehand: { color: 0x4a4a5c, scale: 0.9 }, // backstage black: watch the mark
    sniper: { color: 0x8f6a3c, scale: 0.95 }, // long-lens brown: never the same spot
    duelist: { color: 0xd8b8e8, scale: 1.0 }, // stage-light lilac: hold your swing
    darling: { color: 0xff9ad5, scale: 0.95 }, // spotlight pink: the stated kill order
    canceled: { color: 0x3c6e8f, scale: 1.1 }, // faded-hero teal: the mirror match
    suitactor: { color: 0x7a5c8f, scale: 1.2 }, // costume violet: fine television
    suitguy: { color: 0xd8c8a8, scale: 0.85 }, // office beige: LET HIM GO
    foreman: { color: 0xd94f2e, scale: 1.7 }, // champion vermilion: the checkpoint fight
    // Boss reads ~3x the crawler (r6 major: the menace must own its frame —
    // LoL-objective presence, never smaller than its own damage numbers).
    boss: { color: 0xff3b3b, scale: 3.0 },
  },
  projectilePlayer: 0x6fe3ff,
  projectileEnemy: 0xff8a3c,

  gold: 0xf2c14e,
  heal: 0x5fd08a,
  weaponLoot: 0xb98bff,
  rarity: { common: 0xc9c9d4, magic: 0x5a9bff, rare: 0xf2c14e, epic: 0xb98bff } as Record<string, number>,

  // Camera: fixed pitched orthographic view = the ARPG "isometric" look.
  // Direction the camera sits, relative to its target (normalized internally).
  camDir: { x: 1, y: 1.15, z: 1 },
  camOrthoHalfHeight: 8.5, // tiles visible vertically; smaller = more zoomed in
} as const;
