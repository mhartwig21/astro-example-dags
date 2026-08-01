#!/usr/bin/env node
// Author the flat SINGLE-PATH mask icons the paint pipeline consumes
// (tools/paint-icons.mjs reads the first <path d="…"> out of
// public/icons/{items,nouns,stats,glyphs}/<name>.svg and bakes the 3-tone
// painted object into public/icons/painted/…).
//
// The shipped masks came from game-icons.net; the ITEMIZATION-V2 additions
// (new components/completed works/boss uniques, the refit shard, and the ten
// Phase-B GLYPHS) have no upstream art, so they are composed here out of
// primitives into one compound `d` — chunky silhouettes that survive the 26px
// ink stroke and still read at the 10px socket-pip size.
//
// Deterministic: same source -> byte-identical SVGs. Run, then re-run the
// painter:  node tools/gen-icon-masks.mjs && node tools/paint-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = join(root, "public", "icons");

// ---- geometry helpers (512 grid, y down; content inside 40..472) ----
const n = (v) => (Math.round(v * 10) / 10).toString();

// WINDING CONTRACT: fills are NONZERO, so a cut-out only cuts when it winds
// against its solid. Canonical direction here — SOLID = clockwise on screen
// (positive shoelace with y pointing down), HOLE = counter-clockwise. Every
// primitive below obeys it, so any solid + any hole compose correctly.
/** Signed area (screen coords, y down): positive = clockwise. */
const area2 = (pts) =>
  pts.reduce((s, [x, y], i) => {
    const [x2, y2] = pts[(i + 1) % pts.length];
    return s + (x * y2 - x2 * y);
  }, 0);
const draw = (pts) => `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join("L")}Z`;

// Both helpers normalize direction, so a hand-listed polygon can be written
// in whatever order reads clearest and still cuts (or fills) correctly.
/** Closed solid polygon. */
const poly = (pts) => draw(area2(pts) >= 0 ? pts : [...pts].reverse());
/** Closed cut-out inside a solid. */
const hole = (pts) => draw(area2(pts) <= 0 ? pts : [...pts].reverse());

const rect = (x, y, w, h) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
const rectHole = (x, y, w, h) => hole([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

/** Rounded rect, clockwise. */
function rrect(x, y, w, h, r) {
  return `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}` +
    `V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
    `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}` +
    `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
}

const circle = (cx, cy, r) => // clockwise = solid
  `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 1 ${n(r * 2)} 0a${n(r)} ${n(r)} 0 1 1 ${n(-r * 2)} 0Z`;
const circleHole = (cx, cy, r) => // counter-clockwise = cut-out
  `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(r * 2)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-r * 2)} 0Z`;
/** Solid annulus (outer ring, inner hole). */
const ring = (cx, cy, ro, ri) => circle(cx, cy, ro) + circleHole(cx, cy, ri);

/** A thick bar between two points (a quad, so it joins cleanly under the ink stroke). */
function bar(x1, y1, x2, y2, w) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * (w / 2), py = (dx / len) * (w / 2);
  return poly([[x1 + px, y1 + py], [x2 + px, y2 + py], [x2 - px, y2 - py], [x1 - px, y1 - py]]);
}

/** Arrow head: an isoceles triangle pointing from (x1,y1) toward (x2,y2). */
function head(x1, y1, x2, y2, w) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * (w / 2), py = (dx / len) * (w / 2);
  return poly([[x2, y2], [x1 - px, y1 - py], [x1 + px, y1 + py]]);
}

const rad = (deg) => (deg * Math.PI) / 180;
const on = (cx, cy, r, deg) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];

/** A band sector (open ring) from a0 to a1 degrees, clockwise on screen. */
function arcBand(cx, cy, ro, ri, a0, a1) {
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const [ox0, oy0] = on(cx, cy, ro, a0), [ox1, oy1] = on(cx, cy, ro, a1);
  const [ix1, iy1] = on(cx, cy, ri, a1), [ix0, iy0] = on(cx, cy, ri, a0);
  return `M${n(ox0)} ${n(oy0)}A${n(ro)} ${n(ro)} 0 ${large} 1 ${n(ox1)} ${n(oy1)}` +
    `L${n(ix1)} ${n(iy1)}A${n(ri)} ${n(ri)} 0 ${large} 0 ${n(ix0)} ${n(iy0)}Z`;
}

/** Plus/cross as one 12-point polygon (reversible into a clean cut-out). */
function plus(cx, cy, len, w) {
  const h = len / 2, t = w / 2;
  return [
    [cx - t, cy - h], [cx + t, cy - h], [cx + t, cy - t], [cx + h, cy - t],
    [cx + h, cy + t], [cx + t, cy + t], [cx + t, cy + h], [cx - t, cy + h],
    [cx - t, cy + t], [cx - h, cy + t], [cx - h, cy - t], [cx - t, cy - t],
  ];
}

/** One flame tongue: round base, drawn tip, curled to the left like a real one. */
const tongue = (cx, cy, s) =>
  `M${n(cx + 18 * s)} ${n(cy - 200 * s)}` +
  `C${n(cx + 96 * s)} ${n(cy - 96 * s)} ${n(cx + 140 * s)} ${n(cy - 52 * s)} ${n(cx + 140 * s)} ${n(cy + 30 * s)}` +
  `A${n(140 * s)} ${n(140 * s)} 0 0 1 ${n(cx - 140 * s)} ${n(cy + 30 * s)}` +
  `C${n(cx - 140 * s)} ${n(cy - 40 * s)} ${n(cx - 84 * s)} ${n(cy - 58 * s)} ${n(cx - 52 * s)} ${n(cy - 128 * s)}` +
  `C${n(cx - 40 * s)} ${n(cy - 60 * s)} ${n(cx - 6 * s)} ${n(cy - 84 * s)} ${n(cx + 18 * s)} ${n(cy - 200 * s)}Z`;
/** Fire = a big tongue plus a smaller one licking off the side (a lone
 * teardrop reads as a water drop at 40px; two tongues read as fire). */
const fire = (cx, cy, s) => tongue(cx, cy, s) + tongue(cx - 118 * s, cy + 52 * s, 0.52 * s);

// ---- the icons ----
// Each entry: a compound `d` built from the primitives above. Comments name
// the read we're going for, because at 40px the silhouette IS the item.
const ITEMS = {
  // Components (V2 §2.3)
  rebar_spear: // ribbed bar with a drawn point — "formerly load-bearing"
    bar(108, 442, 368, 146, 58) +
    head(336, 182, 452, 46, 132) +
    bar(146, 392, 214, 356, 28) + bar(202, 328, 270, 292, 28) + bar(258, 264, 326, 228, 28),
  sledge_head: // maul head off its handle, haft socket empty
    poly([[112, 168], [204, 140], [204, 118], [402, 118], [402, 394], [204, 394], [204, 372], [112, 344]]) +
    circleHole(300, 256, 44),
  stock_trigger: // crossbow stock + rail + trigger, no bolts included
    poly([[52, 330], [140, 252], [300, 226], [456, 226], [456, 300], [312, 306], [258, 344], [230, 416], [122, 424], [56, 380]]) +
    rect(232, 300, 34, 92) +
    rectHole(316, 244, 122, 26) +
    poly([[140, 252], [176, 300], [96, 330], [86, 292]]),
  riot_shim: // wedge plate, riveted
    poly([[104, 118], [408, 152], [366, 400], [142, 362]]) +
    circleHole(176, 202, 26) + circleHole(326, 222, 26) + circleHole(252, 322, 26),
  field_tourniquet: // strap loop tightened by a windlass rod
    ring(256, 268, 152, 96) +
    bar(96, 132, 416, 132, 44) +
    poly([[236, 116], [276, 116], [288, 176], [224, 176]]),
  dowsing_fork: // Y-rod pointing at money
    bar(256, 456, 256, 272, 52) +
    bar(256, 292, 138, 96, 46) + bar(256, 292, 374, 96, 46) +
    circle(256, 286, 46),
  insulated_gloves: // gauntlet, rated for the voltage
    rrect(140, 158, 236, 214, 44) +
    poly([[152, 236], [76, 274], [102, 344], [162, 322]]) +
    rrect(166, 86, 54, 90, 24) + rrect(238, 74, 54, 102, 24) + rrect(310, 100, 54, 80, 24) +
    rrect(126, 350, 260, 110, 22),

  // Completed works (V2 §2.3)
  pikemans_rebuttal: // winged spear — the hallway is a weapon
    bar(256, 466, 256, 176, 44) +
    head(178, 194, 256, 42, 156) +
    poly([[120, 236], [232, 196], [232, 250], [148, 292]]) +
    poly([[392, 236], [280, 196], [280, 250], [364, 292]]),
  demolition_permit: // sledgehammer, stamped and approved
    bar(118, 452, 332, 188, 36) +
    poly([[314, 80], [446, 186], [386, 260], [254, 154]]) +
    circle(140, 424, 40),
  court_order: // a served document with a bolt through it
    rrect(122, 92, 268, 336, 12) +
    rectHole(166, 152, 180, 22) + rectHole(166, 210, 180, 22) + rectHole(166, 268, 118, 22) +
    bar(60, 452, 402, 122, 28) + head(370, 152, 456, 74, 92),
  slumlords_deposit: // rent pouch
    rrect(104, 194, 304, 254, 92) +
    rect(184, 138, 144, 68) +
    rect(168, 186, 176, 34) +
    circleHole(214, 330, 34) + circleHole(300, 330, 34),
  ambulance_chaser: // field charm, cross cut out
    rrect(92, 92, 328, 328, 62) +
    hole(plus(256, 240, 200, 66)) +
    poly([[236, 424], [276, 424], [256, 478]]),
  grounded_suit: // grounded chestplate, bolt vented
    poly([[128, 108], [384, 108], [424, 202], [402, 424], [256, 474], [110, 424], [88, 202]]) +
    hole([[318, 152], [176, 288], [246, 288], [196, 424], [340, 274], [266, 274]]),
  glyph_cache: // sealed firmware crate
    rrect(88, 138, 336, 306, 18) +
    rectHole(88, 200, 336, 20) +
    hole([[256, 262], [326, 328], [256, 394], [186, 328]]) +
    rect(196, 108, 120, 40),

  // Boss uniques (V2 §2.5) — drop-only chase
  front_desk_bell: // checkout is immediate
    `M124 372A132 132 0 0 1 388 372Z` +
    rrect(88, 366, 336, 58, 16) +
    rect(240, 176, 32, 62) + circle(256, 166, 38),
  sump_crown: // royalty of the standing water
    poly([[96, 412], [76, 168], [172, 256], [256, 128], [340, 256], [436, 168], [416, 412]]) +
    circleHole(180, 344, 24) + circleHole(256, 328, 26) + circleHole(332, 344, 24) +
    rect(96, 412, 320, 44),
  rootcutter_shears: // pruning is a lifestyle
    bar(166, 62, 300, 296, 44) + bar(346, 62, 212, 296, 44) +
    ring(178, 402, 68, 34) + ring(334, 402, 68, 34) +
    circle(256, 300, 34) + circleHole(256, 300, 14),
  loadbearing_girder: // the building disagrees
    poly([[88, 106], [424, 106], [424, 178], [300, 178], [300, 334], [424, 334], [424, 406],
      [88, 406], [88, 334], [212, 334], [212, 178], [88, 178]]) +
    circleHole(146, 142, 18) + circleHole(366, 142, 18) +
    circleHole(146, 370, 18) + circleHole(366, 370, 18),
  furnace_draft: // fire is a rumor that travels
    fire(272, 224, 0.94) +
    rect(96, 404, 320, 48) +
    rectHole(140, 416, 34, 24) + rectHole(238, 416, 34, 24) + rectHole(336, 416, 34, 24),

  // Material: refit shards ("Scrap Certification")
  refit_shard:
    poly([[262, 46], [340, 222], [296, 442], [214, 442], [180, 222]]) +
    poly([[124, 198], [186, 282], [148, 436], [92, 414], [84, 268]]) +
    poly([[392, 236], [434, 322], [396, 440], [340, 424], [344, 292]]),
};

// The ten Phase-B glyphs (V2 §3.3). Sockets render these at ~10px, so each one
// is one bold gesture: link, fork, loop, mark, flame, lens, rebate, weight,
// trigger, slipstream.
const GLYPHS = {
  arc_splice: // one link arcing to the next body
    circle(112, 146, 56) + circle(400, 366, 56) +
    bar(150, 184, 258, 244, 36) + bar(258, 244, 210, 306, 36) + bar(210, 306, 366, 336, 36),
  splitfang: // the shot forks on impact
    bar(64, 256, 246, 256, 48) +
    bar(238, 256, 386, 128, 42) + bar(238, 256, 386, 384, 42) +
    head(360, 152, 452, 74, 104) + head(360, 360, 452, 438, 104),
  reprise: // it happens again, a beat later
    arcBand(256, 262, 168, 106, 130, 400) +
    head(216, 82, 320, 116, 118) +
    circle(256, 262, 44),
  brandmark: // branded: everything else hits harder
    ring(256, 220, 148, 84) +
    poly(plus(256, 220, 232, 44)) +
    bar(256, 368, 256, 470, 52),
  accelerant: // it catches
    fire(272, 208, 0.9) +
    poly([[152, 400], [256, 352], [360, 400], [360, 444], [256, 396], [152, 444]]),
  arcane_lens: // the ability refracts into MAGIC
    poly([[256, 74], [412, 256], [256, 438], [100, 256]]) +
    hole([[256, 168], [336, 256], [256, 344], [176, 256]]) +
    rect(30, 240, 54, 32) + rect(428, 240, 54, 32) +
    rect(240, 20, 32, 40) + rect(240, 452, 32, 40),
  executioners_rebate: // the kill refunds the cast
    circle(288, 320, 132) + circleHole(288, 320, 58) +
    arcBand(230, 232, 186, 130, 168, 330) +
    head(70, 300, 60, 174, 116),
  heavyweight_plate: // more damage, more weight
    ring(256, 256, 186, 74) +
    bar(256, 108, 256, 404, 46) + bar(108, 256, 404, 256, 46),
  hair_trigger: // faster, and it costs you
    arcBand(238, 296, 148, 104, 340, 200) +
    poly([[220, 200], [268, 200], [268, 306], [214, 296]]) +
    poly([[352, 40], [286, 168], [340, 168], [300, 262], [418, 132], [356, 132]]),
  slipstream: // the exit surge
    poly([[186, 84], [318, 256], [186, 428], [268, 428], [400, 256], [268, 84]]) +
    rect(60, 130, 118, 44) + rect(28, 234, 150, 44) + rect(60, 338, 118, 44),
};

function writeSet(dir, set) {
  const out = join(ICONS, dir);
  mkdirSync(out, { recursive: true });
  for (const [name, d] of Object.entries(set)) {
    writeFileSync(
      join(out, `${name}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#fff" d="${d}"/></svg>\n`,
    );
  }
  return Object.keys(set).length;
}

const a = writeSet("items", ITEMS);
const b = writeSet("glyphs", GLYPHS);
console.log(`wrote ${a} item masks + ${b} glyph masks -> public/icons/`);
