// Art-direction palette and tunables for the 3D isometric renderer. Kept in one
// place so the whole look can be retuned without touching scene-graph code. These
// values define the placeholder low-poly style that stands in until the CC0 glTF
// packs listed in ASSETS.md are dropped into /public/assets.

export const THEME = {
  // Scene mood. Fog is tuned around the orthographic camera distance (camDist):
  // meshes sit ~camDist units from the camera, so fog must start beyond that or the
  // whole scene fogs to the background color.
  background: 0x0a0a12,
  fog: 0x0a0a12,
  camDist: 28, // orthographic camera pullback (does not affect zoom, only fog/clipping)
  fogNear: 26,
  fogFar: 52,

  // Lighting (moody dungeon, but readable mid-floor)
  ambient: 0x33334d,
  ambientIntensity: 0.7,
  hemiSky: 0x5a5a82,
  hemiGround: 0x1a1a12,
  hemiIntensity: 0.65,
  keyLight: 0xfff1d0,
  keyIntensity: 1.2,
  torchColor: 0xff9a3c,
  torchIntensity: 2.4,
  torchDistance: 7,

  // Materials (low-poly, flat-shaded)
  floor: 0x2a2740,
  floorAlt: 0x322d4a,
  wall: 0x1a1826,
  wallTop: 0x272337,
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
    boss: { color: 0xff3b3b, scale: 2.7 },
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
