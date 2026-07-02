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
    boss: { color: 0xff3b3b, scale: 2.7 },
  },
  projectilePlayer: 0x6fe3ff,
  projectileEnemy: 0xff8a3c,

  gold: 0xf2c14e,
  heal: 0x5fd08a,
  weaponLoot: 0xb98bff,

  // Camera: fixed pitched orthographic view = the ARPG "isometric" look.
  // Direction the camera sits, relative to its target (normalized internally).
  camDir: { x: 1, y: 1.15, z: 1 },
  camOrthoHalfHeight: 8.5, // tiles visible vertically; smaller = more zoomed in
} as const;
