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
  | "slipstream" // after movement resolves: +move speed, +damage for 2s
  // ---- PHASE C (ABILITIES-V2 §5.2) ----
  | "static_charge" // every 3rd CAST is empowered: +60% damage, 2x poise
  | "demolition_rider" // the blast consumes burn/poison, dealing the rest at once
  | "ballistic_lens" // ability deals PHYSICAL, scales off attack power
  | "envenomed" // hits have a chance to inject a poison stack
  | "cryo_etch" // hits CHILL
  | "grave_dividend" // consumes corpses under the cast; +15% damage each
  | "culling_edge" // +50% damage below 25% HP
  | "poise_wrecker" // 2x poise damage; your staggers last +0.3s
  | "point_blank" // +30% inside 2 tiles, -15% beyond
  | "longshot" // +30% beyond 4 tiles, -15% within 2
  | "blood_price" // casts cost 3% max HP; +30% damage
  | "phase_etch" // +i-frames; passed-through enemies take ability power
  | "understudy_rider" // the double's contract +2s; its farewell blast chills
  | "encore_clause" // kills inside the ultimate's window refund cooldown
  | "cold_open"; // the ult cast CHILLS everything within 6 tiles

/**
 * Ability archetype tags (§3.2). ABILITIES-V2 §5.1 adds two, and both have a
 * consumer in the same slice — no tag ships as dead plumbing:
 * - `ultimate` — Encore Clause and Cold Open both need "ultimates only", and
 *   `GlyphTag` had no way to say it.
 * - `control` — Collapse and Stage Cables want glyphs that read "affects
 *   things that grab enemies".
 */
export type GlyphTag =
  | "projectile" | "melee" | "aoe" | "movement" | "summon" | "buff"
  | "ultimate" | "control" | "any";

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
    // V2 §5.1 adds `aoe` to the LENS FAMILY — and is precise about what that
    // buys: power() short-circuits to spell power the moment this is socketed
    // and SCALING already reads nova/cataclysm as sp: 1, so Arcane Lens on
    // Collapse or Fault Line is a literal NO-OP. It is meaningful only on the
    // ap-scaled AoEs; Ballistic Lens is the one that converts for the crawler
    // who needs it. §1.2 is MITIGATED by a socket tax, not fixed.
    name: "Arcane Lens", family: "lens", tags: ["melee", "projectile", "aoe"],
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
  // ---- PHASE C: the 15 rows from ITEMIZATION-V2 §3.3, finalized in
  // ABILITIES-V2 §5.2 against the reworked roster. ----
  static_charge: {
    name: "Static Charge", family: "repeat", tags: ["melee", "projectile"],
    blurb: `Every ${CONFIG.glyphStaticEvery}rd cast is EMPOWERED: +${Math.round((CONFIG.glyphStaticDmgMult - 1) * 100)}% damage and ${CONFIG.glyphStaticPoiseMult}x poise.`,
  },
  demolition_rider: {
    name: "Demolition Rider", tags: ["aoe"],
    blurb: `The blast CONSUMES burn and poison on up to ${CONFIG.glyphDemolitionTargets} enemies it hits, dealing the remaining damage instantly.`,
  },
  ballistic_lens: {
    name: "Ballistic Lens", family: "lens", tags: ["melee", "projectile", "aoe"],
    blurb: "The ability deals PHYSICAL damage and scales off attack power. The one lens that converts an AoE for a crawler who rolled steel.",
  },
  envenomed: {
    name: "Envenomed", tags: ["melee", "projectile"],
    blurb: `Hits have a ${Math.round(CONFIG.glyphEnvenomedChance * 100)}% chance to inject a POISON stack.`,
  },
  cryo_etch: {
    name: "Cryo-Etch", tags: ["aoe", "projectile"],
    blurb: `Hits CHILL for ${Math.round(CONFIG.glyphCryoChill * 100)}% over ${CONFIG.glyphCryoDuration}s.`,
  },
  grave_dividend: {
    name: "Grave Dividend", tags: ["aoe"],
    blurb: `Consumes up to ${CONFIG.glyphGraveCorpses} corpses under the cast; +${Math.round(CONFIG.glyphGraveBonus * 100)}% damage each.`,
  },
  culling_edge: {
    name: "Culling Edge", tags: ["melee", "projectile"],
    blurb: `+${Math.round(CONFIG.glyphCullingBonus * 100)}% damage to enemies below ${Math.round(CONFIG.glyphCullingThreshold * 100)}% HP. Stacks ADDITIVELY with EXECUTIONER and GUILLOTINE.`,
  },
  poise_wrecker: {
    name: "Poise Wrecker", tags: ["melee", "aoe"],
    blurb: `${CONFIG.glyphPoiseWreckerMult}x poise damage; your staggers last +${CONFIG.glyphPoiseWreckerStagger}s.`,
  },
  point_blank: {
    name: "Point Blank", family: "range", tags: ["melee", "projectile"],
    blurb: `+${Math.round(CONFIG.glyphPointBlankBonus * 100)}% damage within ${CONFIG.glyphPointBlankRange} tiles, −${Math.round(CONFIG.glyphPointBlankPenalty * 100)}% beyond.`,
  },
  longshot: {
    name: "Longshot", family: "range", tags: ["projectile"],
    blurb: `+${Math.round(CONFIG.glyphLongshotBonus * 100)}% damage beyond ${CONFIG.glyphLongshotRange} tiles, −${Math.round(CONFIG.glyphLongshotPenalty * 100)}% within ${CONFIG.glyphPointBlankRange}.`,
  },
  blood_price: {
    // §5.4 flag 1: this lives in TEMPO, not rebate. It is not a refund, it is
    // a damage-for-cost trade — exactly the axis tempo exists to police. Left
    // in rebate it would share a slot with Heavyweight Plate for +69% damage
    // off two drawbacks that never interact.
    name: "Blood Price", family: "tempo", tags: ["any"],
    blurb: `Casts cost ${Math.round(CONFIG.glyphBloodPriceHpFrac * 100)}% of your max HP; +${Math.round((CONFIG.glyphBloodPriceDmgMult - 1) * 100)}% damage.`,
  },
  phase_etch: {
    name: "Phase Etch", tags: ["movement"],
    blurb: `+${CONFIG.glyphPhaseEtchIframes}s of i-frames; enemies you pass through take ${Math.round(CONFIG.glyphPhaseEtchFrac * 100)}% ability power.`,
  },
  understudy_rider: {
    name: "Understudy's Rider", tags: ["summon"],
    blurb: `The double's contract lasts +${CONFIG.glyphUnderstudyContract}s, and its farewell blast CHILLS.`,
  },
  encore_clause: {
    name: "Encore Clause", family: "rebate", tags: ["ultimate"],
    blurb: `Kills inside the ultimate's active window refund ${Math.round(CONFIG.glyphEncoreRefund * 100)}% of its cooldown each (per-cast refund cap applies).`,
  },
  cold_open: {
    name: "Cold Open", tags: ["ultimate"],
    blurb: `The ultimate's cast CHILLS everything within ${CONFIG.glyphColdOpenRadius} tiles by ${Math.round(CONFIG.glyphColdOpenChill * 100)}% for ${CONFIG.glyphColdOpenDuration}s.`,
  },
};

/** Stable roll order for seeded glyph draws (drops, caches, sponsor gifts). */
export const GLYPH_IDS: GlyphId[] = [
  "arc_splice", "splitfang", "reprise", "brandmark", "accelerant",
  "arcane_lens", "executioners_rebate", "heavyweight_plate", "hair_trigger", "slipstream",
  // Phase C — appended, never interleaved: GLYPH_IDS is the seeded roll order,
  // so inserting in the middle would re-roll every existing run's drops.
  "static_charge", "demolition_rider", "ballistic_lens", "envenomed", "cryo_etch",
  "grave_dividend", "culling_edge", "poise_wrecker", "point_blank", "longshot",
  "blood_price", "phase_etch", "understudy_rider", "encore_clause", "cold_open",
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
  // V2 R1: Collapse GRABS — the control tag is what routes control glyphs to
  // the two abilities that grab enemies.
  nova: ["aoe", "control"],
  orbit: ["melee"],
  stance: ["buff"],
  overcharge: ["buff"],
  // V2 R6: Blindside teleports. Phase Etch and Slipstream should have read it
  // as movement all along; they do now.
  cutto: ["melee", "movement"],
  crowdsurf: ["movement", "control"],
  stuntdouble: ["summon"],
  bulwark: ["buff"],
  cables: ["aoe", "control"],
  airstrike: ["projectile", "aoe", "ultimate"],
  cataclysm: ["aoe", "ultimate"],
  bullettime: ["buff", "ultimate"],
  injunction: ["buff", "ultimate"],
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
  | "surge" // it resolves a movement, which is what opens the slipstream window
  // ABILITIES-V2 §5.1 — both land WITH their consumers (§7 slice 8):
  | "cast" // it resolves as a discrete cast with a counter (Static Charge,
           // Blood Price, Cold Open, Encore Clause). Without this, Static
           // Charge on Orbit's AURA would silently do nothing — the exact
           // failure rule 6 exists to stop.
  | "zone"; // it creates or consumes GROUND (Grave Dividend, Demolition Rider)

/** What each ability exposes. Adding a consumer to abilities.ts/game.ts means
 * adding its channel here — the (glyph x ability) contract test reads this. */
export const ABILITY_CHANNELS: Record<AbilityId, GlyphChannel[]> = {
  melee: ["damage", "cooldown", "onhit", "scale", "cast"],
  dash: ["damage", "cooldown", "onhit", "surge", "cast"], // damage = the Shockstep path
  bolt: ["damage", "cooldown", "onhit", "bolt", "scale", "cast"],
  nova: ["damage", "cooldown", "onhit", "echo", "scale", "cast", "zone"],
  // V2 R3: the hurl gives orbit a COOLDOWN for the first time — which is what
  // un-dormants Hair Trigger, Heavyweight Plate and Executioner's Rebate on
  // the roster's #2 damage source (rule 9 excluded all three).
  orbit: ["damage", "cooldown", "onhit", "scale", "cast"],
  stance: ["cooldown", "cast"], // R4: the swap now FIRES something
  overcharge: ["cooldown", "cast"],
  cutto: ["damage", "cooldown", "onhit", "scale", "cast", "surge"],
  crowdsurf: ["damage", "cooldown", "onhit", "surge", "scale", "cast"],
  stuntdouble: ["cooldown", "cast"], // the double's blows are the DOUBLE's, not yours
  bulwark: ["cooldown", "cast"], // no damage of its own to amplify
  cables: ["damage", "cooldown", "onhit", "scale", "cast", "zone"],
  airstrike: ["damage", "cooldown", "onhit", "scale", "cast", "zone"], // shells, not projectiles
  cataclysm: ["damage", "cooldown", "onhit", "echo", "scale", "cast", "zone"],
  bullettime: ["cooldown", "cast"],
  injunction: ["cooldown", "cast"],
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
  // ---- Phase C ----
  static_charge: ["cast", "damage"],
  demolition_rider: ["zone", "onhit"],
  ballistic_lens: ["scale"],
  envenomed: ["onhit"],
  cryo_etch: ["onhit"],
  grave_dividend: ["zone", "damage"],
  culling_edge: ["damage", "onhit"],
  poise_wrecker: ["onhit"],
  point_blank: ["damage", "onhit"],
  longshot: ["damage", "onhit"],
  blood_price: ["cast", "damage"],
  phase_etch: ["surge"],
  understudy_rider: ["cooldown"],
  encore_clause: ["cooldown", "cast"],
  cold_open: ["cast"],
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
    cast: "never resolves as a discrete cast the glyph can count",
    zone: "creates and consumes no ground for the glyph to work with",
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

/** Multiplicative damage factor from UNCONDITIONAL numeric glyphs (rule 3).
 * Conditional ones (Culling Edge, Point Blank, Longshot, Static Charge) are
 * resolved at hit time by glyphHitMult — a param function cannot know how far
 * away the body is or how much HP it has left. */
export function glyphDamageMult(p: Player, ability: AbilityId): number {
  let mult = 1;
  for (const id of glyphsFor(p, ability)) {
    if (id === "heavyweight_plate") mult *= CONFIG.glyphHeavyweightDmgMult;
    if (id === "hair_trigger") mult *= CONFIG.glyphHairTriggerDmgMult;
    if (id === "blood_price") mult *= CONFIG.glyphBloodPriceDmgMult;
  }
  return mult;
}

/** The context one hit resolves in: how far the body is and how hurt it is. */
export interface GlyphHitContext {
  /** Tiles between the caster and the body. */
  range?: number;
  /** Target HP as a fraction of its max, BEFORE this hit. */
  hpFrac?: number;
  /** True while this cast is Static Charge's empowered one. */
  empowered?: boolean;
}

/**
 * Conditional glyph damage, folded at the ONE monster choke point
 * (damageMonster). Culling Edge stacks ADDITIVELY with EXECUTIONER and
 * GUILLOTINE by design (§5.2) — the chase build is legitimate and the balance
 * sweep looks at it on purpose (§5.4 flag 5).
 */
export function glyphHitMult(p: Player, ability: AbilityId, ctx: GlyphHitContext): number {
  let mult = 1;
  for (const id of glyphsFor(p, ability)) {
    if (id === "culling_edge" && (ctx.hpFrac ?? 1) <= CONFIG.glyphCullingThreshold) {
      mult *= 1 + CONFIG.glyphCullingBonus;
    }
    if (id === "point_blank" && ctx.range !== undefined) {
      mult *= ctx.range <= CONFIG.glyphPointBlankRange
        ? 1 + CONFIG.glyphPointBlankBonus : 1 - CONFIG.glyphPointBlankPenalty;
    }
    if (id === "longshot" && ctx.range !== undefined) {
      if (ctx.range >= CONFIG.glyphLongshotRange) mult *= 1 + CONFIG.glyphLongshotBonus;
      else if (ctx.range <= CONFIG.glyphPointBlankRange) mult *= 1 - CONFIG.glyphLongshotPenalty;
    }
    if (id === "static_charge" && ctx.empowered) mult *= CONFIG.glyphStaticDmgMult;
  }
  return mult;
}

/** Extra poise multiplier a glyph puts on this hit (Poise Wrecker, and Static
 * Charge's empowered cast). */
export function glyphPoiseMult(p: Player, ability: AbilityId, empowered = false): number {
  let mult = 1;
  for (const id of glyphsFor(p, ability)) {
    if (id === "poise_wrecker") mult *= CONFIG.glyphPoiseWreckerMult;
    if (id === "static_charge" && empowered) mult *= CONFIG.glyphStaticPoiseMult;
  }
  return mult;
}

/**
 * ENCORE CLAUSE's bounded window (§5.4 flag 2). "During the ultimate" is not a
 * definition: Bullet Time and Injunction have durations, Sponsor Barrage has a
 * 3s channel, Fault Line's fissure lasts 10s, and Cataclysm-as-cast is one
 * frame. The window is the ultimate's own ACTIVE duration, or a fixed fallback
 * when it has none — and rule 8's per-cast refund budget does the rest. On
 * floor 15 the raw refund would be 4% x ~20 kills = 80% of a 40s cooldown; the
 * budget clamps it to 20s. The clamp is doing all the work, so §6.4.10 pins it.
 */
export function glyphWindow(_ability: AbilityId, activeDuration?: number): number {
  return activeDuration && activeDuration > 0 ? activeDuration : CONFIG.glyphEncoreFallbackWindow;
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
