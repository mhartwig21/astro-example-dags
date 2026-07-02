import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Asset loading seam. The renderer prefers real glTF models when they are present
// under /public/assets (see ASSETS.md + scripts/fetch-assets.sh for the CC0 packs
// this expects), and otherwise falls back to procedural low-poly meshes so the game
// always renders. This lets us confirm art direction now and swap in artwork later
// without touching gameplay or scene-graph wiring.

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

// Optional model manifest. Paths are relative to the site root (Vite `public/`).
// Missing files are handled gracefully — the renderer uses procedural stand-ins.
export const MODEL_MANIFEST: Record<string, string> = {
  player: "/assets/characters/adventurer.glb",
  skeleton: "/assets/characters/skeleton.glb",
  // Per-archetype monster skins (fall back to `skeleton` when absent).
  monster_swarmer: "/assets/characters/skeleton_rogue.glb",
  monster_brute: "/assets/characters/skeleton_warrior.glb",
  monster_ranged: "/assets/characters/skeleton_mage.glb",
  monster_boss: "/assets/characters/skeleton_warrior.glb",
  wall: "/assets/dungeon/wall.glb",
  floor: "/assets/dungeon/floor.glb",
  stairs: "/assets/dungeon/stairs.glb",
};

export async function loadModels(): Promise<Record<string, LoadedModel>> {
  const loader = new GLTFLoader();
  const out: Record<string, LoadedModel> = {};
  await Promise.all(
    Object.entries(MODEL_MANIFEST).map(async ([key, url]) => {
      try {
        const gltf = await loader.loadAsync(url);
        out[key] = { scene: gltf.scene, animations: gltf.animations };
      } catch {
        // File absent or failed to parse — leave it out; renderer falls back.
      }
    }),
  );
  return out;
}
