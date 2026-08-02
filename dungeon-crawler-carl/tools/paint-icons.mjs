#!/usr/bin/env node
// Paint the flat mask icon set into 3-tone flat-shaded "illustrated object"
// SVGs (AAA r2 icon pass): shared 45-degree key light from top-left — a lit
// rim band, the material base, a shadowed foot band — over a uniform ink
// outline so every icon carries the same silhouette weight. Input: the
// single-path game-icons masks in public/icons/{items,nouns,stats}; output:
// public/icons/painted/{items,nouns,stats}/<name>.svg, referenced as <img>
// by the shop/sheet/bag tiles (main3d.ts). Rarity stays on the tile frame.
//
// Deterministic: same inputs -> byte-identical outputs. Re-run after adding
// any new mask icon:  node tools/paint-icons.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = join(root, "public", "icons");

// Material trios (highlight / base / shade) — mirrors the .mat-* tokens in
// iso.html so the painted files and any CSS-tinted icon share one palette.
const MAT = {
  steel: ["#eef3f8", "#9fb0c2", "#3e4c5c"],
  iron: ["#ded8cd", "#8b857a", "#37332c"],
  leather: ["#eec08a", "#a5713d", "#4a2d14"],
  gold: ["#ffedb0", "#cfa14b", "#795720"],
  wood: ["#e0aa72", "#8f5f34", "#3e2610"],
  arcane: ["#e9d9ff", "#a476dd", "#4a3067"],
  blood: ["#ffb49c", "#c74a34", "#5e180d"],
  verdant: ["#d8eeb2", "#7fa84f", "#31451a"],
  frost: ["#e4f4ff", "#86bbdc", "#2b5068"],
  ember: ["#ffd9a3", "#d98e4a", "#63370f"],
  bone: ["#f8f1e2", "#c9bda2", "#5f5540"],
  screen: ["#d8e6f2", "#7f95ad", "#2c3a4a"],
};

// Catalog item -> material (mirrors ITEM_MAT in main3d.ts).
const ITEM_MAT = {
  backstage_pass: "gold", blastplate_harness: "iron", blood_subscription: "blood",
  bloodsport_maul: "iron", boss_sigil: "arcane", box_seat_crossbow: "wood",
  boxcutter: "steel", cancellation_axe: "steel", cardboard_cuirass: "leather",
  crash_helmet: "ember", crowd_medallion: "gold", cursed_amplifier: "arcane",
  elite_trophy: "gold", encore_treads: "leather", field_ration: "blood",
  focus_bead: "frost", glass_charm: "frost", gold: "gold",
  gyro_stabilizer: "steel", headliner_cleaver: "steel", honed_edge: "steel",
  iron_plating: "iron", killer_instinct: "blood", landlords_ledger: "leather",
  live_feed: "screen", location_scout: "bone", lucky_bottlecap: "gold",
  mosh_pit_helm: "iron", mystery_box: "wood", overtime_clause: "bone",
  ozone_wand: "arcane", padded_lining: "leather", perpetual_encore: "arcane",
  plating_kit: "iron", plot_armor: "gold", primetime_cleaver: "steel",
  ratings_magnet: "ember", roadie_runner: "leather", showstopper_plate: "gold",
  signature_choreography: "bone", stabilizer_rod: "steel", stagedive_harness: "leather",
  standing_ovation: "gold", stormcall_staff: "arcane", sweeps_week_staff: "wood",
  swift_wraps: "bone", system_favor: "gold", tome: "arcane",
  tour_treads: "leather", venom_clause: "verdant", vip_pass: "gold",
  // ITEMIZATION-V2 additions (masks authored by tools/gen-icon-masks.mjs).
  rebar_spear: "iron", sledge_head: "iron", stock_trigger: "wood",
  riot_shim: "steel", field_tourniquet: "blood", dowsing_fork: "wood",
  insulated_gloves: "leather", pikemans_rebuttal: "steel",
  demolition_permit: "ember", court_order: "bone", slumlords_deposit: "leather",
  ambulance_chaser: "blood", grounded_suit: "steel", glyph_cache: "arcane",
  // Boss uniques — drop-only chase gear reads richer than the shelf.
  front_desk_bell: "gold", sump_crown: "verdant", rootcutter_shears: "steel",
  loadbearing_girder: "iron", furnace_draft: "ember", refit_shard: "frost",
};

// Glyph -> material (ITEMIZATION-V2 §3): firmware stones. Arcane is the house
// color; the elemental/behavioral ones take their own so a socket row reads
// as five different stones, not five purple pebbles.
const GLYPH_MAT = {
  arc_splice: "frost", splitfang: "steel", reprise: "arcane",
  brandmark: "blood", accelerant: "ember", arcane_lens: "arcane",
  executioners_rebate: "gold", heavyweight_plate: "iron",
  hair_trigger: "gold", slipstream: "frost",
  // Phase C. The two FAMILY PAIRS are deliberately split across materials so
  // a socket row never asks the player to tell two same-colored pebbles
  // apart: the lenses are arcane vs steel, the range pair ember vs wood.
  static_charge: "gold", demolition_rider: "ember", ballistic_lens: "steel",
  envenomed: "verdant", cryo_etch: "frost", grave_dividend: "bone",
  culling_edge: "steel", poise_wrecker: "iron", point_blank: "ember",
  longshot: "wood", blood_price: "blood", phase_etch: "arcane",
  understudy_rider: "screen", encore_clause: "gold", cold_open: "frost",
};

// Field-drop noun -> material (mirrors NOUN_MAT in main3d.ts).
const NOUN_MAT = {
  aegis: "gold", axe: "steel", band: "gold", blade: "steel",
  boots: "leather", carapace: "iron", charm: "frost", cleaver: "steel",
  crossbow: "wood", crown: "gold", fetish: "bone", greaves: "iron",
  hauberk: "iron", helm: "iron", hood: "leather", idol: "gold",
  locket: "gold", maul: "iron", mug: "wood", pendant: "gold",
  plate: "iron", sigil: "arcane", spear: "steel", staff: "wood",
  striders: "leather", talisman: "arcane", totem: "wood",
  treads: "leather", vest: "leather", visor: "steel", wand: "arcane",
};

// Stat glyphs keep their semantic hues (sheet ledger).
const STAT_MAT = {
  attack: "ember", spell: "arcane", crit: "gold",
  speed: "frost", armor: "steel", hp: "blood",
};

const INK = "#150e07"; // shared outline — uniform silhouette weight
const D = 26; // rim band offset (512 grid): ~2px lit edge at 36px tile size

// Deterministic hex lerp for the gradient stops (no color-mix at bake time).
function mix(a, b, t) {
  const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + ca.map((v, i) =>
    Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

// r3 material pass: beyond the 3 flat bands, each icon now carries a full
// tonal ramp (vertical gradient base), a diagonal specular sweep, a top-left
// key-light pool, and an ambient-occlusion foot — the painted-object read
// (D2R/LoL item fidelity) instead of poster-flat fills. Still deterministic:
// same inputs -> byte-identical outputs.
function paint(srcFile, [lit, base, shade]) {
  const raw = readFileSync(srcFile, "utf8");
  const m = raw.match(/<path[^>]*\sd="([^"]+)"/);
  if (!m) throw new Error(`no path in ${srcFile}`);
  const d = m[1];
  const p = (fill, extra = "") => `<path d="${d}" fill="${fill}"${extra}/>`;
  // hi: the sliver of the shape NOT covered by itself shifted down-right =
  // the top-left rim catching the key light. sh: mirror = shadowed foot.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-16 -16 544 544">` +
    `<defs>` +
    `<linearGradient id="g" x1="0.12" y1="0" x2="0.4" y2="1">` +
    `<stop offset="0" stop-color="${mix(base, lit, 0.45)}"/>` +
    `<stop offset="0.46" stop-color="${base}"/>` +
    `<stop offset="1" stop-color="${mix(base, shade, 0.7)}"/>` +
    `</linearGradient>` +
    `<clipPath id="c"><path d="${d}"/></clipPath>` +
    `<mask id="hi">${p("#fff")}<g transform="translate(${D},${D})">${p("#000")}</g></mask>` +
    `<mask id="sh">${p("#fff")}<g transform="translate(${-D},${-D})">${p("#000")}</g></mask>` +
    `</defs>` +
    `<path d="${d}" fill="none" stroke="${INK}" stroke-width="26" stroke-linejoin="round" stroke-linecap="round"/>` +
    p("url(#g)") +
    `<g clip-path="url(#c)">` +
    `<ellipse cx="168" cy="120" rx="230" ry="190" fill="${lit}" opacity="0.22"/>` +
    `<ellipse cx="256" cy="486" rx="290" ry="130" fill="${mix(shade, "#000000", 0.4)}" opacity="0.3"/>` +
    `<rect x="-140" y="10" width="740" height="104" fill="#fff8e6" opacity="0.17" transform="rotate(24 256 256)"/>` +
    `</g>` +
    `<g mask="url(#hi)">${p(lit)}</g>` +
    `<g mask="url(#sh)">${p(shade)}</g>` +
    `</svg>\n`
  );
}

let n = 0;
function run(setDir, matOf, fallback) {
  const out = join(ICONS, "painted", setDir);
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(join(ICONS, setDir)).filter((f) => f.endsWith(".svg"))) {
    const name = f.replace(/\.svg$/, "");
    const mat = MAT[matOf[name] ?? fallback];
    writeFileSync(join(out, f), paint(join(ICONS, setDir, f), mat));
    n++;
  }
}

run("items", ITEM_MAT, "gold");
run("nouns", NOUN_MAT, "steel");
run("stats", STAT_MAT, "bone");
run("glyphs", GLYPH_MAT, "arcane");
console.log(`painted ${n} icons -> public/icons/painted/`);
