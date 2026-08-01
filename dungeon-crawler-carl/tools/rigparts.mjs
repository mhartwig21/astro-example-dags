// CAN MONSTER RIGS BE MERGED? The census says monsters are 248 draw calls a
// frame — the single biggest category — because each KayKit character is 8-13
// separate SkinnedMeshes (Body, Head, Jaw, ArmLeft, ArmRight, Legs, Cloak,
// Eyes...). Merging them into one SkinnedMesh per material is only legal if
// the parts share a skeleton, share materials, carry no morph targets, and are
// never individually toggled.
//
// This walks the live monster meshes and reports, per rig: part count, distinct
// skeletons, distinct materials, morph usage, and whether any part is hidden —
// i.e. exactly the preconditions.
//
// Usage: node tools/rigparts.mjs "<url>"
import { chromium } from "playwright";

const url = process.argv[2]?.startsWith("http") ? process.argv[2]
  : "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-vsync"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", { timeout: 240000 }).catch(() => {});
await page.waitForFunction(() => { const e = document.getElementById("loading"); return !e || e.classList.contains("done"); }, { timeout: 240000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.keyboard.down("w"); await page.waitForTimeout(2500); await page.keyboard.up("w");
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const R = window.__dcc.renderer;
  const rigs = [];
  const seenKeys = new Set();
  const containers = [R.monsters, R.playerMeshes].filter(Boolean);
  for (const map of containers) {
    for (const root of map.values()) {
      const skinned = [], plain = [];
      root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); else if (o.isMesh) plain.push(o); });
      if (!skinned.length && !plain.length) continue;
      const skels = new Set(skinned.map((m) => m.skeleton));
      const mats = new Set([...skinned, ...plain].map((m) => Array.isArray(m.material) ? "ARRAY" : m.material));
      const key = root.userData?.key ?? root.name ?? "?";
      const morph = [...skinned, ...plain].filter((m) => m.morphTargetInfluences?.length).length;
      const hidden = [...skinned, ...plain].filter((m) => !m.visible).length;
      const matArrays = [...skinned, ...plain].filter((m) => Array.isArray(m.material)).length;
      const row = {
        key, skinnedParts: skinned.length, plainParts: plain.length,
        skeletons: skels.size, materials: mats.size, morphParts: morph,
        hiddenParts: hidden, arrayMaterialParts: matArrays,
        partNames: skinned.map((m) => m.name).slice(0, 14),
        matNames: [...mats].map((m) => (typeof m === "string" ? m : `${m.type}:${m.name || "-"}:${m.uuid.slice(0, 6)}`)).slice(0, 8),
      };
      if (!seenKeys.has(key)) { seenKeys.add(key); rigs.push(row); }
    }
  }
  // Totals across every live rig, not just the distinct ones.
  let totalParts = 0, totalRigs = 0, mergeableParts = 0;
  for (const map of containers) {
    for (const root of map.values()) {
      const meshes = []; root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
      if (!meshes.length) continue;
      totalRigs++; totalParts += meshes.length;
      mergeableParts += new Set(meshes.map((m) => (Array.isArray(m.material) ? m : m.material))).size;
    }
  }
  return { totalRigs, totalParts, partsIfMergedByMaterial: mergeableParts, distinctRigs: rigs };
});
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
await browser.close();
