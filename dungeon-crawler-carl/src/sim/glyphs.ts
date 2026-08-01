import { CONFIG } from "./config";
import type { AbilityId } from "./abilities";
import type { Player } from "./types";

// GLYPHS (ITEMIZATION-V2 §3): socketable modifier stones for The Five — the
// PoE2 support-gem layer on LoL's kit-clarity budget. Fiction: System-issued
// firmware patches for your abilities, found in the dungeon (loot), never
// granted by the crowd.
//
// Sockets live on the SLOT, not the ability (owner decision, §3.1): each of
// the 4 active slots has up to 2 sockets (unlocking at levels 4 and 11), the
// ultimate slot has 1 (unlocking with the ultimate). A glyph affects whatever
// ability currently occupies its slot — IF the tags match; otherwise it sits
// DORMANT. Socket/unsocket is a safe-room decision (same gate as re-slotting),
// with a field auto-fill exception for fresh finds (grantGlyph in game.ts).
// Removal is free and lossless; scarcity is in FINDING glyphs.
//
// Everything here is pure data + pure functions over Player — deterministic,
// serializable, host-free.

export type GlyphId =
  | "arc_splice" // projectile hits arc 40% to the nearest other enemy, one link
  | "splitfang" // on first impact the bolt forks into 2 at 45%, continuing outward
  | "reprise" // aoe re-detonates the same spot 0.8s later at 40% power
  | "brandmark" // hits BRAND 4s; branded take +12% from your OTHER abilities
  | "accelerant" // hits IGNITE for 25% of the hit over the burn duration
  | "arcane_lens" // ability deals MAGIC, scales off spell power
  | "executioners_rebate" // kill within 1s of the cast refunds 30% of cooldown (rule 8 cap)
  | "heavyweight_plate" // +35% damage, +20% cooldown (joins the rule 7 sum)
  | "hair_trigger" // -20% cooldown (rule 7 cap), -12% damage
  | "slipstream"; // after movement resolves: +move speed, +damage for 2s

/** Ability archetype tags (§3.2) — what a glyph's tags must intersect. */
export type GlyphTag = "projectile" | "melee" | "aoe" | "movement" | "summon" | "buff" | "any";

/** Two glyphs of the same family can never share a slot (§3.2 rule 2). */
export type GlyphFamily = "split" | "repeat" | "lens" | "range" | "rebate" | "tempo";

export interface GlyphInfo {
  name: string;
  blurb: string;
  tags: GlyphTag[];
  family?: GlyphFamily;
}

/** The Phase-B launch set (§3.3's 10 "B" rows). Phase C adds the other 15. */
export const GLYPH_INFO: Record<GlyphId, GlyphInfo> = {
  arc_splice: {
    name: "Arc-Splice", family: "split", tags: ["projectile"],
    blurb: `Hits arc ${Math.round(CONFIG.glyphArcSpliceFrac * 100)}% of the damage to the nearest other enemy. One link.`,
  },
  splitfang: {
    name: "Splitfang", family: "split", tags: ["projectile"],
    blurb: `On first impact the shot forks into ${CONFIG.glyphSplitfangCount} at ${Math.round(CONFIG.glyphSplitfangFrac * 100)}% damage, continuing outward.`,
  },
  reprise: {
    name: "Reprise", family: "repeat", tags: ["aoe"],
    blurb: `The blast re-detonates on the same spot ${CONFIG.glyphRepriseDelay}s later at ${Math.round(CONFIG.glyphRepriseFrac * 100)}% power.`,
  },
  brandmark: {
    name: "Brandmark", tags: ["melee", "projectile"],
    blurb: `Hits BRAND for ${CONFIG.glyphBrandDuration}s; branded enemies take +${Math.round(CONFIG.glyphBrandBonus * 100)}% from your OTHER abilities.`,
  },
  accelerant: {
    name: "Accelerant", tags: ["any"],
    blurb: `Hits IGNITE for ${Math.round(CONFIG.glyphAccelerantFrac * 100)}% of the hit over ${CONFIG.burnDuration}s.`,
  },
  arcane_lens: {
    name: "Arcane Lens", family: "lens", tags: ["melee", "projectile"],
    blurb: "The ability deals MAGIC damage and scales off spell power. An explicit socket beats a default.",
  },
  executioners_rebate: {
    name: "Executioner's Rebate", family: "rebate", tags: ["any"],
    blurb: `A kill within ${CONFIG.glyphRebateWindow}s of the cast refunds ${Math.round(CONFIG.glyphRebateFrac * 100)}% of the cooldown (per-cast refund cap applies).`,
  },
  heavyweight_plate: {
    name: "Heavyweight Plate", family: "tempo", tags: ["any"],
    blurb: `+${Math.round((CONFIG.glyphHeavyweightDmgMult - 1) * 100)}% damage, +${Math.round(CONFIG.glyphHeavyweightCd * 100)}% cooldown. Same sustained DPS — you are buying the SPIKE (and the poise it breaks).`,
  },
  hair_trigger: {
    name: "Hair Trigger", family: "tempo", tags: ["any"],
    blurb: `-${Math.round(CONFIG.glyphHairTriggerCd * 100)}% cooldown, -${Math.round((1 - CONFIG.glyphHairTriggerDmgMult) * 100)}% damage. Same sustained DPS — you are buying UPTIME.`,
  },
  slipstream: {
    name: "Slipstream", tags: ["movement"],
    blurb: `After the movement resolves: +${Math.round((CONFIG.glyphSlipstreamSpeedMult - 1) * 100)}% move speed and +${Math.round((CONFIG.glyphSlipstreamDmgMult - 1) * 100)}% damage for ${CONFIG.glyphSlipstreamDur}s.`,
  },
};

/** Stable roll order for seeded glyph draws (drops, caches, sponsor gifts). */
export const GLYPH_IDS: GlyphId[] = [
  "arc_splice", "splitfang", "reprise", "brandmark", "accelerant",
  "arcane_lens", "executioners_rebate", "heavyweight_plate", "hair_trigger", "slipstream",
];

/**
 * Ability archetype tags (§3.2 table). Orbit rides the melee tag (the blades
 * are steel); the doc's table only names the launch-relevant rows — "any"
 * glyphs apply everywhere regardless.
 */
export const ABILITY_TAGS: Record<AbilityId, GlyphTag[]> = {
  melee: ["melee"],
  dash: ["movement"],
  bolt: ["projectile"],
  nova: ["aoe"],
  orbit: ["melee"],
  stance: ["buff"],
  overcharge: ["buff"],
  cutto: ["melee"],
  crowdsurf: ["movement"],
  stuntdouble: ["summon"],
  airstrike: ["projectile", "aoe"],
  cataclysm: ["aoe"],
  bullettime: ["buff"],
};

/**
 * CHANNELS (§3.2 rule 6) — the machinery an ability actually exposes to the
 * glyph layer. Tags are FICTION ("this is a projectile"); channels are TRUTH
 * ("this ability's cooldown is routed through glyphCdr"). A tag match that
 * isn't a channel match used to light a socket gold and do nothing: Reprise on
 * Airstrike (aoe-tagged, but only nova/cataclysm schedule re-detonations),
 * Arc-Splice on Airstrike (projectile-tagged, but shells aren't projectiles),
 * Heavyweight Plate on Bullet Time (a cooldown with no damage consumer — a
 * strictly NEGATIVE glyph presenting as a buff). Dormancy now reads both.
 */
export type GlyphChannel =
  | "damage" // its params multiply glyphDamageMult
  | "cooldown" // its cooldown routes through clampCooldown(…, glyphCdr)
  | "onhit" // its damage events carry the casting ability (brand/ignite riders)
  | "bolt" // it spawns player projectiles the projectile step reads
  | "echo" // it can schedule a delayed re-detonation on the same spot
  | "scale" // its damage reads power()/castSchool(), so a lens can convert it
  | "surge"; // it resolves a movement, which is what opens the slipstream window

/** What each ability exposes. Adding a consumer to abilities.ts/game.ts means
 * adding its channel here — the (glyph x ability) contract test reads this. */
export const ABILITY_CHANNELS: Record<AbilityId, GlyphChannel[]> = {
  melee: ["damage", "cooldown", "onhit", "scale"],
  dash: ["damage", "cooldown", "onhit", "surge"], // damage = the Shockstep path
  bolt: ["damage", "cooldown", "onhit", "bolt", "scale"],
  nova: ["damage", "cooldown", "onhit", "echo"],
  orbit: ["damage", "onhit", "scale"], // a persistent aura: no cooldown at all
  stance: ["cooldown"], // a buff toggle: nothing to amplify, a swap timer to cut
  overcharge: ["cooldown"],
  cutto: ["damage", "cooldown", "onhit", "scale"],
  crowdsurf: ["damage", "cooldown", "onhit", "surge"],
  stuntdouble: ["cooldown"], // the double's blows are the DOUBLE's, not yours
  airstrike: ["damage", "cooldown", "onhit", "scale"], // shells, not projectiles
  cataclysm: ["damage", "cooldown", "onhit", "echo", "scale"],
  bullettime: ["cooldown"],
};

/** What each glyph needs — ALL of them, or it sits dormant. Heavyweight/Hair
 * Trigger need BOTH halves of their trade present: an ability that only has a
 * cooldown would take the drawback and skip the payoff (or vice versa). */
export const GLYPH_CHANNELS: Record<GlyphId, GlyphChannel[]> = {
  arc_splice: ["bolt"],
  splitfang: ["bolt"],
  reprise: ["echo"],
  brandmark: ["onhit"],
  accelerant: ["onhit"],
  arcane_lens: ["scale"],
  executioners_rebate: ["cooldown"],
  heavyweight_plate: ["damage", "cooldown"],
  hair_trigger: ["damage", "cooldown"],
  slipstream: ["surge"],
};

/** A glyph applies to an ability when their tag sets intersect (or "any") AND
 * the ability exposes every channel the glyph consumes (rule 6). */
export function glyphMatches(id: GlyphId, ability: AbilityId): boolean {
  return glyphTagMatches(id, ability) && glyphChannelsMet(id, ability);
}

/** The fiction half of the match: archetype tags only. */
export function glyphTagMatches(id: GlyphId, ability: AbilityId): boolean {
  const gt = GLYPH_INFO[id].tags;
  if (gt.includes("any")) return true;
  const at = ABILITY_TAGS[ability] ?? [];
  return gt.some((t) => at.includes(t));
}

/** The machinery half: does the ability consume everything this glyph needs? */
export function glyphChannelsMet(id: GlyphId, ability: AbilityId): boolean {
  const have = ABILITY_CHANNELS[ability] ?? [];
  return GLYPH_CHANNELS[id].every((c) => have.includes(c));
}

/** Plain-language "why is this stone dark", or null when it's live. The sim
 * owns the reason so hosts never re-derive (and never drift from) the rule. */
export function glyphDormantReason(id: GlyphId, ability: AbilityId): string | null {
  if (glyphMatches(id, ability)) return null;
  if (!glyphTagMatches(id, ability)) {
    const at = (ABILITY_TAGS[ability] ?? []).join("/") || "not a match";
    const gt = GLYPH_INFO[id].tags.join(" · ");
    return `wrong archetype — this ability is ${at}, and the glyph only reads ${gt}`;
  }
  const have = ABILITY_CHANNELS[ability] ?? [];
  const missing = GLYPH_CHANNELS[id].filter((c) => !have.includes(c));
  const why: Record<GlyphChannel, string> = {
    damage: "deals no damage of its own to amplify",
    cooldown: "has no cooldown to move",
    onhit: "lands no hits that can carry a rider",
    bolt: "fires no projectiles for the glyph to work on",
    echo: "has nothing to re-detonate",
    scale: "has no damage scaling for the lens to convert",
    surge: "resolves no movement to surge out of",
  };
  return `no effect here — this ability ${why[missing[0]]}`;
}

/** Fresh, empty glyph loadout (4 active slots x 2 sockets + 1 ultimate socket). */
export function defaultGlyphs(): NonNullable<Player["glyphs"]> {
  return { slots: [[null, null], [null, null], [null, null], [null, null]], ultimate: [null], bench: [] };
}

/** The level slot `slotIdx`'s SECOND socket opens at (§3.5): staggered across
 * the four active slots so sockets and glyph supply grow together. The
 * ultimate's single socket opens with the ultimate and never reads this. */
export function glyphSocket2Level(slotIdx: number): number {
  const levels = CONFIG.glyphSocket2Levels;
  return levels[Math.min(Math.max(slotIdx, 0), levels.length - 1)];
}

/** Unlocked sockets for ACTIVE slot `slotIdx` at this level (pure function of
 * level — nothing persisted): socket 1 at glyphSocket1Level for every slot,
 * socket 2 on that slot's own staggered beat. */
export function glyphSocketCount(level: number, slotIdx = 0): number {
  if (level >= glyphSocket2Level(slotIdx)) return 2;
  if (level >= CONFIG.glyphSocket1Level) return 1;
  return 0;
}

/** Total sockets a crawler has open right now (actives + ultimate) — the
 * denominator of the §3.5 supply contract. */
export function totalSocketsOpen(level: number, hasUltimate: boolean): number {
  let n = hasUltimate ? 1 : 0;
  for (let i = 0; i < CONFIG.glyphSocket2Levels.length; i++) n += glyphSocketCount(level, i);
  return n;
}

/** The raw socket array for a slot index (0-3 actives, 4 = ultimate),
 * trimmed to what's UNLOCKED. Missing/short arrays read as empty. */
function unlockedSockets(p: Player, slotIdx: number): (GlyphId | null)[] {
  const g = p.glyphs;
  if (!g) return [];
  if (slotIdx === 4) return p.abilities.ultimate ? (g.ultimate ?? []).slice(0, 1) : [];
  return (g.slots[slotIdx] ?? []).slice(0, glyphSocketCount(p.level, slotIdx));
}

/**
 * The ACTIVE (non-dormant) glyphs affecting an ability right now: socketed in
 * the slot the ability occupies, unlocked, and tag-matched. Deterministic and
 * order-independent — callers fold numbers, never sequence effects off order.
 */
export function glyphsFor(p: Player, ability: AbilityId): GlyphId[] {
  if (!p.glyphs) return [];
  const idx = p.abilities.slots.indexOf(ability);
  const sockets =
    idx >= 0 ? unlockedSockets(p, idx)
    : p.abilities.ultimate === ability ? unlockedSockets(p, 4)
    : [];
  return sockets.filter((id): id is GlyphId => id !== null && glyphMatches(id, ability));
}

/** True when the ability currently benefits from the given glyph. */
export function hasGlyph(p: Player, ability: AbilityId, id: GlyphId): boolean {
  return glyphsFor(p, ability).includes(id);
}

/**
 * RULE 7 — the global CDR sum from glyphs for one ability. Positive = faster.
 * Hair Trigger contributes +0.20; Heavyweight Plate joins the SAME sum as a
 * −0.20 (a cooldown increase), so one clamp at the end settles everything.
 */
export function glyphCdr(p: Player, ability: AbilityId): number {
  let sum = 0;
  for (const id of glyphsFor(p, ability)) {
    if (id === "hair_trigger") sum += CONFIG.glyphHairTriggerCd;
    if (id === "heavyweight_plate") sum -= CONFIG.glyphHeavyweightCd;
  }
  return sum;
}

/**
 * RULE 7's one clamp, applied LAST in each param function: percentage cooldown
 * modifiers (constellation ranks + glyphs) sum additively, and the effective
 * cooldown never drops below (1 - cdrCap) of the printed base. Increases
 * (negative `cdrSum`) pass through unclamped.
 */
export function clampCooldown(base: number, cdrSum: number): number {
  return base * Math.max(1 - CONFIG.cdrCap, 1 - cdrSum);
}

/** Multiplicative damage factor from numeric glyphs (rule 3). */
export function glyphDamageMult(p: Player, ability: AbilityId): number {
  let mult = 1;
  for (const id of glyphsFor(p, ability)) {
    if (id === "heavyweight_plate") mult *= CONFIG.glyphHeavyweightDmgMult;
    if (id === "hair_trigger") mult *= CONFIG.glyphHairTriggerDmgMult;
  }
  return mult;
}

/** Every glyph this crawler owns (socketed anywhere + bench) — pity checks. */
export function ownedGlyphs(p: Player): GlyphId[] {
  const g = p.glyphs;
  if (!g) return [];
  const out: GlyphId[] = [...g.bench];
  for (const arr of g.slots) for (const id of arr) if (id) out.push(id);
  for (const id of g.ultimate) if (id) out.push(id);
  return out;
}

/** Legality check for placing `id` into (slotIdx, socketIdx): duplicate-copy
 * rule (1 per slot) and family exclusion (rule 2). Level/ultimate unlock
 * gating is the CALLER's job (socketGlyph / grantGlyph in game.ts). */
export function socketLegal(p: Player, slotIdx: number, socketIdx: number, id: GlyphId): boolean {
  const g = p.glyphs;
  if (!g) return false;
  const arr = slotIdx === 4 ? g.ultimate : g.slots[slotIdx];
  if (!arr || socketIdx < 0 || socketIdx >= arr.length) return false;
  const fam = GLYPH_INFO[id].family;
  for (let i = 0; i < arr.length; i++) {
    if (i === socketIdx) continue;
    const other = arr[i];
    if (!other) continue;
    if (other === id) return false; // one copy of a glyph per slot
    if (fam && GLYPH_INFO[other].family === fam) return false; // family exclusion
  }
  return true;
}
