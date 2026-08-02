import { describe, it, expect } from "vitest";
import {
  buyCatalogItem, createGame, damageMonster, grantGlyph, restoreGame, socketGlyph, step, unsocketGlyph,
} from "../src/sim/game";
import {
  ABILITY_CHANNELS, GLYPH_CHANNELS, GLYPH_IDS, GLYPH_INFO, clampCooldown, defaultGlyphs, glyphDormantReason,
  glyphMatches, glyphSocket2Level, glyphSocketCount, glyphTagMatches, glyphsFor, hasGlyph, totalSocketsOpen,
} from "../src/sim/glyphs";
import {
  ABILITY_INFO, abilityCdrBreakdown, airstrikeParams, boltParams, bulletTimeParams, bulwarkParams,
  cablesParams, cataclysmParams, crowdSurfParams, cutToParams, dashParams, injunctionParams, meleeParams,
  novaParams, orbitParams, overchargeParams, stanceParams, stuntDoubleParams, type AbilityId,
} from "../src/sim/abilities";
import { CONFIG } from "../src/sim/config";
import { deserialize, mergeColdPlayers, serialize, serializeDynamic } from "../src/sim/snapshot";
import type { GameState, Intent } from "../src/sim/types";

// GLYPHS (ITEMIZATION-V2 §3): the PoE2 modifier layer. Sockets live on the
// SLOT; tags gate (dormancy); families exclude; rule 7 clamps CDR; rule 8
// caps per-cast refunds. Everything deterministic + save/net round-trippable.

function idle(): Intent {
  return { move: { x: 0, y: 0 }, attack: false, useStairs: false };
}

function mkMon(over: Partial<import("../src/sim/types").Monster> = {}) {
  return {
    id: 1, kind: "grunt" as const, pos: { x: 0, y: 0 },
    hp: 1, maxHp: 1, damage: 0, speed: 0, attackRange: 1, attackCooldown: 0,
    shootCd: 0, healCd: 0, blinkCd: 0, xp: 5, hitFlash: 0,
    windup: 0, windupTotal: 0, stagger: 0, poiseDmg: 0, ...over,
  };
}

/** A game paused in its first safe room (socketing is a safe-room verb). */
function reachShop(seed: number) {
  const g = createGame(seed);
  g.players[0].pos = { x: g.map.stairs.x, y: g.map.stairs.y };
  step(g, { move: { x: 0, y: 0 }, useStairs: true }, 1 / 60);
  expect(g.safeRoom).toBeTruthy();
  return g;
}

describe("sockets on slots (§3.1)", () => {
  it("unlock cadence is a pure function of level, and second sockets STAGGER", () => {
    // BALANCE CHANGE (§3.5): socket 2 used to open on ALL FOUR active slots at
    // level 11 at once, which outran the glyph drip and left the act-2 rebuild
    // beat staring at four empty wells. Second sockets now open one slot at a
    // time. Socket 1 is unchanged: every slot, level 4.
    for (let slot = 0; slot < CONFIG.glyphSocket2Levels.length; slot++) {
      expect(glyphSocketCount(1, slot)).toBe(0);
      expect(glyphSocketCount(CONFIG.glyphSocket1Level, slot)).toBe(1);
      expect(glyphSocketCount(glyphSocket2Level(slot) - 1, slot)).toBe(1);
      expect(glyphSocketCount(glyphSocket2Level(slot), slot)).toBe(2);
    }
    // Strictly increasing: the kit grows a socket every couple of levels.
    const levels = CONFIG.glyphSocket2Levels;
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
    expect(levels[0]).toBeGreaterThan(CONFIG.glyphSocket1Level);
    // The whole-kit count is the supply contract's denominator.
    expect(totalSocketsOpen(1, false)).toBe(0);
    expect(totalSocketsOpen(CONFIG.glyphSocket1Level, false)).toBe(4);
    expect(totalSocketsOpen(levels[levels.length - 1], true)).toBe(9);
  });

  it("socketing is safe-room gated, level gated, and lossless to unsocket", () => {
    const g = reachShop(101);
    const p = g.players[0];
    p.glyphs!.bench.push("hair_trigger");
    socketGlyph(g, 0, 0, 0, "hair_trigger"); // level 1: socket locked
    expect(p.glyphs!.slots[0][0]).toBeNull();
    p.level = CONFIG.glyphSocket1Level;
    socketGlyph(g, 0, 0, 1, "hair_trigger"); // socket 2 still locked
    expect(p.glyphs!.slots[0][1]).toBeNull();
    socketGlyph(g, 0, 0, 0, "hair_trigger");
    expect(p.glyphs!.slots[0][0]).toBe("hair_trigger");
    expect(p.glyphs!.bench).toHaveLength(0);
    unsocketGlyph(g, 0, 0, 0);
    expect(p.glyphs!.slots[0][0]).toBeNull();
    expect(p.glyphs!.bench).toContain("hair_trigger");
    // Outside a safe room: no rearranging.
    const g2 = createGame(102);
    const p2 = g2.players[0];
    p2.level = 11;
    p2.glyphs!.bench.push("hair_trigger");
    socketGlyph(g2, 0, 0, 0, "hair_trigger");
    expect(p2.glyphs!.slots[0][0]).toBeNull();
  });

  it("the ultimate socket exists only once an ultimate is slotted", () => {
    const g = reachShop(103);
    const p = g.players[0];
    p.level = 11;
    p.glyphs!.bench.push("heavyweight_plate");
    socketGlyph(g, 0, 4, 0, "heavyweight_plate");
    expect(p.glyphs!.ultimate[0]).toBeNull(); // no ultimate yet
    p.abilities.ultimate = "cataclysm";
    socketGlyph(g, 0, 4, 0, "heavyweight_plate");
    expect(p.glyphs!.ultimate[0]).toBe("heavyweight_plate");
  });

  it("DORMANCY: a tag-mismatched glyph sits inert in its socket", () => {
    const g = reachShop(104);
    const p = g.players[0];
    p.level = 4;
    // Slot 0 holds melee; arc_splice is projectile-only.
    expect(p.abilities.slots[0]).toBe("melee");
    p.glyphs!.bench.push("arc_splice");
    socketGlyph(g, 0, 0, 0, "arc_splice"); // socketing a dormant glyph is legal
    expect(p.glyphs!.slots[0][0]).toBe("arc_splice");
    expect(glyphsFor(p, "melee")).toHaveLength(0); // dormant: melee is not a projectile
    expect(hasGlyph(p, "melee", "arc_splice")).toBe(false);
    // Re-slotting bolt over the socket wakes it: the SLOT owns the socket.
    p.abilities.slots[0] = "bolt";
    p.abilities.bench.push("melee");
    expect(hasGlyph(p, "bolt", "arc_splice")).toBe(true);
  });

  it("FAMILY exclusion in a slot; duplicates across slots are legal (rules 1-2)", () => {
    const g = reachShop(105);
    const p = g.players[0];
    p.level = 11; // both sockets open
    p.abilities.slots[0] = "bolt";
    p.glyphs!.bench.push("arc_splice", "splitfang", "brandmark", "brandmark");
    socketGlyph(g, 0, 0, 0, "arc_splice");
    socketGlyph(g, 0, 0, 1, "splitfang"); // same `split` family: refused
    expect(p.glyphs!.slots[0][1]).toBeNull();
    socketGlyph(g, 0, 0, 1, "brandmark");
    expect(p.glyphs!.slots[0][1]).toBe("brandmark");
    // A second Brandmark on a DIFFERENT slot is fine (rule 1 scope is the slot).
    p.level = 11;
    socketGlyph(g, 0, 1, 0, "brandmark");
    expect(p.glyphs!.slots[1][0]).toBe("brandmark");
    // ...but a duplicate copy inside the same slot is not.
    p.glyphs!.bench.push("brandmark");
    unsocketGlyph(g, 0, 0, 0);
    socketGlyph(g, 0, 0, 0, "brandmark");
    expect(p.glyphs!.slots[0][0]).toBeNull();
  });

  it("field pickups auto-fill the first compatible empty socket, else bench", () => {
    const g = createGame(106);
    const p = g.players[0];
    p.level = 4;
    grantGlyph(g, p, "arc_splice"); // bolt sits in slot 2
    expect(p.glyphs!.slots[2][0]).toBe("arc_splice");
    grantGlyph(g, p, "splitfang"); // same family as the filled socket: benches
    expect(p.glyphs!.bench).toContain("splitfang");
    const g2 = createGame(107);
    const p2 = g2.players[0];
    p2.level = 1; // no sockets yet: everything banks
    grantGlyph(g2, p2, "hair_trigger");
    expect(p2.glyphs!.bench).toContain("hair_trigger");
  });
});

describe("numeric glyphs + rule 7 (the CDR clamp)", () => {
  function withGlyph(seed: number, slotAbility: "melee" | "bolt" | "nova", glyph: import("../src/sim/glyphs").GlyphId) {
    const g = createGame(seed);
    const p = g.players[0];
    p.level = 4;
    const slot = p.abilities.slots.indexOf(slotAbility);
    expect(slot).toBeGreaterThanOrEqual(-0); // melee/dash/bolt start slotted
    if (slot < 0) throw new Error("not slotted");
    p.glyphs!.slots[slot][0] = glyph;
    return { g, p };
  }

  it("Heavyweight Plate: more damage, longer cooldown; Hair Trigger mirrors it", () => {
    const base = createGame(1).players[0];
    const { p: heavy } = withGlyph(1, "melee", "heavyweight_plate");
    expect(meleeParams(heavy).damageMult).toBeCloseTo(meleeParams(base).damageMult * CONFIG.glyphHeavyweightDmgMult, 5);
    expect(meleeParams(heavy).cooldown).toBeCloseTo(meleeParams(base).cooldown * (1 + CONFIG.glyphHeavyweightCd), 5);
    const { p: hair } = withGlyph(1, "melee", "hair_trigger");
    expect(meleeParams(hair).damageMult).toBeCloseTo(meleeParams(base).damageMult * CONFIG.glyphHairTriggerDmgMult, 5);
    expect(meleeParams(hair).cooldown).toBeCloseTo(meleeParams(base).cooldown * (1 - CONFIG.glyphHairTriggerCd), 5);
  });

  it("THE TEMPO PAIR is a real tradeoff: neither glyph raises sustained DPS", () => {
    // BALANCE CONTRACT (§3.3). The launch pair was 1.35 dmg / +20% cd and 0.88
    // dmg / -20% cd: each was individually DPS-POSITIVE (+12.5% and +10%), so
    // "tradeoff" was a lie, and with no family they stacked in one slot for a
    // flat +18.8% damage at zero cooldown cost — the auto-include on all nine
    // sockets. Both are now DPS-neutral by construction. If a future tuning
    // pass pushes either past 1.02x, this fails and says why.
    const melee = (p: import("../src/sim/types").Player) => meleeParams(p).damageMult / meleeParams(p).cooldown;
    const bolt = (p: import("../src/sim/types").Player) => boltParams(p).dmg / boltParams(p).cooldown;
    for (const glyph of ["heavyweight_plate", "hair_trigger"] as const) {
      const baseM = createGame(20).players[0];
      const { p: gm } = withGlyph(20, "melee", glyph);
      expect(melee(gm) / melee(baseM)).toBeLessThanOrEqual(1.02);
      const baseB = createGame(21).players[0];
      const { p: gb } = withGlyph(21, "bolt", glyph);
      expect(bolt(gb) / bolt(baseB)).toBeLessThanOrEqual(1.02);
      // ...and each still MOVES both numbers — DPS-neutral, not inert.
      expect(meleeParams(gm).damageMult).not.toBeCloseTo(meleeParams(baseM).damageMult, 5);
      expect(meleeParams(gm).cooldown).not.toBeCloseTo(meleeParams(baseM).cooldown, 5);
    }
    // The pair can never share a slot: same `tempo` family (rule 2). Without
    // this, +30%/-20% damage and +30%/-20% cooldown cancel into free stats.
    expect(GLYPH_INFO.heavyweight_plate.family).toBe(GLYPH_INFO.hair_trigger.family);
    const g = reachShop(22);
    const p = g.players[0];
    p.level = glyphSocket2Level(0);
    p.glyphs!.bench.push("heavyweight_plate", "hair_trigger");
    socketGlyph(g, 0, 0, 0, "heavyweight_plate");
    socketGlyph(g, 0, 0, 1, "hair_trigger");
    expect(p.glyphs!.slots[0][0]).toBe("heavyweight_plate");
    expect(p.glyphs!.slots[0][1]).toBeNull(); // family exclusion held
  });

  it("RULE 7: rank CDR + glyph CDR sum additively and clamp at 40%", () => {
    expect(clampCooldown(10, 0.39)).toBeCloseTo(6.1, 5);
    expect(clampCooldown(10, 0.65)).toBeCloseTo(6, 5); // clamped
    expect(clampCooldown(10, -0.2)).toBeCloseTo(12, 5); // increases pass through
    const { p } = withGlyph(2, "bolt", "hair_trigger");
    p.abilities.ranks["bolt.rapid"] = 3; // 45% rank CDR + 20% glyph = 65% -> clamp
    expect(boltParams(p).cooldown).toBeCloseTo(CONFIG.boltCooldown * (1 - CONFIG.cdrCap), 5);
    // Constellation CDR ALONE also respects the cap now (rule 7 is global).
    const solo = createGame(3).players[0];
    solo.abilities.ranks["bolt.rapid"] = 3;
    expect(boltParams(solo).cooldown).toBeCloseTo(CONFIG.boltCooldown * 0.6, 5);
    // ABILITIES-V2 §5.4 flag 3: Quickstep rank 2+ is a CHARGE, not a second
    // percentage, so ranks alone no longer reach the cap on dash. The rank-CDR
    // ceiling now lives where a rank can still stack past it — bolt, above —
    // and the glyph half is what pushes dash over.
    solo.abilities.ranks["dash.quick"] = 3;
    expect(dashParams(solo).cooldown).toBeCloseTo(CONFIG.dashCooldown * (1 - 0.18), 5);
    expect(dashParams(solo).charges).toBe(CONFIG.dashCharges + 2); // ranks 2 and 3 are charges
    // Collapse's CDR node moved with the rework: Aftershock retired, Rift
    // carries the -10%/rank (and CDR_NODES moved with it).
    const rift = createGame(34).players[0];
    rift.abilities.ranks["nova.rift"] = 2;
    expect(novaParams(rift).cooldown).toBeCloseTo(CONFIG.novaCooldown * 0.8, 5);
  });

  it("RULE 7's REAL floor: the clamp is on % modifiers, class multipliers ride outside", () => {
    // The doc used to print "never below 60% of base, one clamp applied last",
    // but the shipped code clamps the PERCENTAGE sum and then multiplies the
    // weapon-class identity multiplier outside it (an intentional choice —
    // swift/wand are what the weapon IS, not a % cooldown modifier). The old
    // test only covered bare hands, so the true floors were unpinned. They are
    // now: 0.6 x swiftMeleeCdMult on melee, 0.6 x wandBoltCdMult on a wand.
    const swift = createGame(30).players[0];
    swift.equipment.weapon = { id: 1, slot: "weapon", rarity: "magic", name: "Keen Blade", affixes: { damage: 5 } };
    swift.abilities.ranks["melee.swift"] = 9; // way past the cap on its own
    expect(meleeParams(swift).cooldown).toBeCloseTo(
      CONFIG.playerAttackCooldown * (1 - CONFIG.cdrCap) * CONFIG.swiftMeleeCdMult, 5,
    );
    const wand = createGame(31).players[0];
    wand.equipment.weapon = { id: 1, slot: "weapon", rarity: "magic", name: "Keen Wand", affixes: { spell: 5 } };
    wand.abilities.ranks["bolt.rapid"] = 9;
    expect(boltParams(wand).cooldown).toBeCloseTo(
      CONFIG.boltCooldown * (1 - CONFIG.cdrCap) * CONFIG.wandBoltCdMult, 5,
    );
    // And the breakdown the UI reads reports the WASTAGE, not just the result.
    const capped = createGame(32).players[0];
    capped.level = 4;
    capped.abilities.ranks["melee.swift"] = 3; // 36%
    capped.glyphs!.slots[0][0] = "hair_trigger"; // +20% -> 56%, clamped to 40%
    const b = abilityCdrBreakdown(capped, "melee");
    expect(b.capped).toBe(true);
    expect(b.applied).toBeCloseTo(CONFIG.cdrCap, 5);
    // Of the glyph's printed 20%, only 4% survives the cap — the rest is the
    // wastage the tooltip and the sheet now name out loud.
    expect(b.wasted).toBeCloseTo(0.36 + CONFIG.glyphHairTriggerCd - CONFIG.cdrCap, 5);
    // Past the cap on ranks ALONE, the glyph is a pure downgrade: identical
    // cooldown, strictly less damage. That is the trap the warning exists for.
    const over = createGame(33).players[0];
    over.level = 4;
    over.abilities.ranks["melee.swift"] = 4; // 48% > cap before any glyph
    over.glyphs!.slots[0][0] = "hair_trigger";
    const without = createGame(33).players[0];
    without.abilities.ranks["melee.swift"] = 4;
    expect(abilityCdrBreakdown(over, "melee").capped).toBe(true);
    expect(meleeParams(over).cooldown).toBeCloseTo(meleeParams(without).cooldown, 5);
    expect(meleeParams(over).damageMult).toBeLessThan(meleeParams(without).damageMult);
  });

  it("determinism: socket order never changes the numbers", () => {
    const a = createGame(4).players[0];
    a.level = 11;
    a.glyphs!.slots[0] = ["heavyweight_plate", "brandmark"];
    const b = createGame(4).players[0];
    b.level = 11;
    b.glyphs!.slots[0] = ["brandmark", "heavyweight_plate"];
    expect(meleeParams(a).damageMult).toBeCloseTo(meleeParams(b).damageMult, 9);
    expect(meleeParams(a).cooldown).toBeCloseTo(meleeParams(b).cooldown, 9);
  });
});

describe("dormancy is EFFECT-based, not tag-based (§3.2 rule 6)", () => {
  const ULTIMATES: AbilityId[] = ["airstrike", "cataclysm", "bullettime", "injunction"];
  const ALL_ABILITIES = Object.keys(ABILITY_CHANNELS) as AbilityId[];

  /** The numeric params a glyph could move, per ability. Anything a glyph can
   * touch has to appear here — that is what makes "measurably changes a param"
   * checkable instead of a vibe. */
  function probe(p: import("../src/sim/types").Player, a: AbilityId): Record<string, number> {
    switch (a) {
      case "melee": return { d: meleeParams(p).damageMult, c: meleeParams(p).cooldown };
      case "dash": return { d: dashParams(p).shockMult, c: dashParams(p).cooldown };
      case "bolt": return { d: boltParams(p).dmg, c: boltParams(p).cooldown };
      case "nova": return { d: novaParams(p).damageMult, c: novaParams(p).cooldown };
      case "orbit": return { d: orbitParams(p).damageMult, c: orbitParams(p).hurlCooldown };
      case "stance": return { c: stanceParams(p).cooldown };
      case "overcharge": return { c: overchargeParams(p).cooldown };
      case "cutto": return { d: cutToParams(p).dmgMult, c: cutToParams(p).cooldown };
      case "crowdsurf": return { d: crowdSurfParams(p).diveFrac, c: crowdSurfParams(p).cooldown };
      case "stuntdouble": return { c: stuntDoubleParams(p).cooldown };
      case "airstrike": return { d: airstrikeParams(p).dmgMult, c: airstrikeParams(p).cooldown };
      case "cataclysm": return { d: cataclysmParams(p).dmgMult, c: cataclysmParams(p).cooldown };
      case "bullettime": return { c: bulletTimeParams(p).cooldown };
      case "bulwark": return { c: bulwarkParams(p).cooldown };
      case "cables": return { d: cablesParams(p).liveFrac, c: cablesParams(p).cooldown };
      case "injunction": return { c: injunctionParams(p).cooldown };
    }
  }

  /** A crawler with `ability` seated and (optionally) `glyph` in its socket.
   * Damage-node ranks are pre-bought so rank-gated damage consumers (Shockstep,
   * Stage Dive) are non-zero and a change would actually show. */
  function seat(ability: AbilityId, glyph?: import("../src/sim/glyphs").GlyphId) {
    const p = createGame(300).players[0];
    p.level = 20;
    p.attackPower = 50;
    p.spellPower = 50;
    p.abilities.ranks["dash.shock"] = 1;
    p.abilities.ranks["surf.dive"] = 1;
    p.abilities.ranks["cab.live"] = 1; // Live Wire is Stage Cables' damage consumer
    if (ULTIMATES.includes(ability)) {
      p.abilities.ultimate = ability;
      if (glyph) p.glyphs!.ultimate[0] = glyph;
    } else {
      p.abilities.slots[0] = ability;
      if (glyph) p.glyphs!.slots[0][0] = glyph;
    }
    return p;
  }

  it("every (glyph x ability) pair is either DORMANT or moves a real number", () => {
    // The bug this pins: `stance`/`overcharge`/`bullettime`/`stuntdouble` are
    // tagged "buff", and all four "any"-tag glyphs matched them on tags alone —
    // socketing lit the pip gold and did nothing. Heavyweight Plate on Bullet
    // Time was worse than nothing: +cooldown, no damage consumer, presented as
    // a buff. Same story for Reprise on Airstrike (aoe-tagged, no echo) and
    // Arc-Splice on Airstrike (projectile-tagged, but shells aren't
    // projectiles). Dormancy now reads the MACHINERY, so this is enforceable.
    for (const glyph of GLYPH_IDS) {
      for (const ability of ALL_ABILITIES) {
        const active = glyphMatches(glyph, ability);
        const base = probe(seat(ability), ability);
        const withG = probe(seat(ability, glyph), ability);
        const moved = Object.keys(base).some((k) => Math.abs(base[k] - withG[k]) > 1e-9);
        if (glyph === "heavyweight_plate" || glyph === "hair_trigger") {
          // The numeric pair: active MUST move both halves of its trade,
          // dormant MUST move nothing (no silent cooldown tax).
          expect(moved, `${glyph} on ${ability} (active=${active})`).toBe(active);
          if (active) {
            expect(Math.abs(base.d - withG.d), `${glyph}/${ability} damage`).toBeGreaterThan(1e-9);
            expect(Math.abs(base.c - withG.c), `${glyph}/${ability} cooldown`).toBeGreaterThan(1e-9);
          }
        } else if (!active) {
          // A dormant behavior glyph must not quietly move a number either.
          expect(moved, `dormant ${glyph} on ${ability} moved a param`).toBe(false);
        }
        // Dormant pairs always owe the player a plain-language reason.
        if (!active) expect(glyphDormantReason(glyph, ability)).toBeTruthy();
        else expect(glyphDormantReason(glyph, ability)).toBeNull();
      }
    }
  });

  it("the (glyph -> abilities) table is the CONTRACT, written out", () => {
    // Written longhand so a channel edit has to be a deliberate design change,
    // not a silent widening. Ordered by GLYPH_IDS / ABILITY_CHANNELS.
    const expected: Record<string, AbilityId[]> = {
      arc_splice: ["bolt"],
      splitfang: ["bolt"],
      reprise: ["nova", "cataclysm"],
      brandmark: ["melee", "bolt", "orbit", "cutto", "airstrike"],
      accelerant: ["melee", "dash", "bolt", "nova", "orbit", "cutto", "crowdsurf", "cables", "airstrike", "cataclysm"],
      // §5.1: the LENS FAMILY gains `aoe` — but be precise about what that
      // buys. power() short-circuits to spell power the moment this is
      // socketed and SCALING already reads nova/cataclysm as sp: 1, so Arcane
      // Lens on Collapse or Fault Line is a literal NO-OP. It is meaningful
      // only on the ap-scaled AoEs (Sponsor Barrage, Stage Cables).
      arcane_lens: ["melee", "bolt", "nova", "orbit", "cutto", "cables", "airstrike", "cataclysm"],
      // R3 is the systemic win: orbit exposes a COOLDOWN for the first time,
      // so the tempo/rebate glyphs stop reading DORMANT on the roster's #2
      // damage source (glyphs.ts rule 9 excluded all three).
      executioners_rebate: [
        "melee", "dash", "bolt", "nova", "orbit", "stance", "overcharge", "cutto", "crowdsurf",
        "stuntdouble", "bulwark", "cables", "airstrike", "cataclysm", "bullettime", "injunction",
      ],
      heavyweight_plate: [
        "melee", "dash", "bolt", "nova", "orbit", "cutto", "crowdsurf", "cables", "airstrike", "cataclysm",
      ],
      hair_trigger: [
        "melee", "dash", "bolt", "nova", "orbit", "cutto", "crowdsurf", "cables", "airstrike", "cataclysm",
      ],
      // R6: Blindside teleports, so Slipstream and Phase Etch finally read it.
      slipstream: ["dash", "cutto", "crowdsurf"],
      // ---- Phase C (ABILITIES-V2 §5.2) ----
      static_charge: ["melee", "bolt", "orbit", "cutto", "airstrike"],
      demolition_rider: ["nova", "cables", "airstrike", "cataclysm"],
      // The one lens that converts an AoE for the crawler who NEEDS it: the
      // physical build that rolled a 30% AP share (§1.2). Arcane Lens on
      // Collapse or Fault Line is a literal no-op — they are already sp: 1.
      ballistic_lens: ["melee", "bolt", "nova", "orbit", "cutto", "cables", "airstrike", "cataclysm"],
      envenomed: ["melee", "bolt", "orbit", "cutto", "airstrike"],
      cryo_etch: ["bolt", "nova", "cables", "airstrike", "cataclysm"],
      grave_dividend: ["nova", "cables", "airstrike", "cataclysm"],
      culling_edge: ["melee", "bolt", "orbit", "cutto", "airstrike"],
      poise_wrecker: ["melee", "nova", "orbit", "cutto", "cables", "airstrike", "cataclysm"],
      point_blank: ["melee", "bolt", "orbit", "cutto", "airstrike"],
      longshot: ["bolt", "airstrike"],
      blood_price: [
        "melee", "dash", "bolt", "nova", "orbit", "cutto", "crowdsurf", "cables", "airstrike", "cataclysm",
      ],
      phase_etch: ["dash", "cutto", "crowdsurf"],
      understudy_rider: ["stuntdouble"],
      // Both need the new `ultimate` tag, and both ship WITH it (§7 slice 8).
      encore_clause: ["airstrike", "cataclysm", "bullettime", "injunction"],
      cold_open: ["airstrike", "cataclysm", "bullettime", "injunction"],
    };
    for (const glyph of GLYPH_IDS) {
      const live = ALL_ABILITIES.filter((a) => glyphMatches(glyph, a));
      expect([...live].sort(), glyph).toEqual([...expected[glyph]].sort());
      expect(live.length, `${glyph} is dormant everywhere`).toBeGreaterThan(0);
    }
  });

  it("a tag match that is NOT a channel match reads as a no-effect dormancy", () => {
    // Reprise on the Airstrike ultimate: aoe-tagged on both sides, but only
    // nova and cataclysm schedule re-detonations. The player is told which.
    expect(glyphTagMatches("reprise", "airstrike")).toBe(true);
    expect(glyphMatches("reprise", "airstrike")).toBe(false);
    expect(glyphDormantReason("reprise", "airstrike")).toContain("no effect here");
    // ...whereas a plain archetype mismatch says so in the archetype's words.
    expect(glyphDormantReason("arc_splice", "melee")).toContain("wrong archetype");
    // Every glyph's channel list names channels some ability actually exposes.
    const known = new Set(Object.values(ABILITY_CHANNELS).flat());
    for (const chans of Object.values(GLYPH_CHANNELS)) {
      for (const c of chans) expect(known.has(c)).toBe(true);
    }
    // The tag table and the channel table cover the same ability set.
    expect(Object.keys(ABILITY_CHANNELS).sort()).toEqual(Object.keys(ABILITY_INFO).sort());
  });
});

describe("behavior glyphs (§3.3 launch set)", () => {
  it("ARCANE LENS: the bolt deals magic off spell power, trumping the weapon default", () => {
    const g = createGame(5);
    const p = g.players[0];
    p.level = 4;
    p.attackPower = 10;
    p.spellPower = 100;
    const before = boltParams(p);
    expect(before.school).toBe("physical"); // bare hands: physical jab
    p.glyphs!.slots[2][0] = "arcane_lens"; // bolt's slot
    const after = boltParams(p);
    expect(after.school).toBe("magic");
    expect(after.dmg).toBeGreaterThan(before.dmg); // scales off the caster stat now
  });

  it("ACCELERANT ignites and BRANDMARK marks; the brand pays other abilities +12%", () => {
    const g = createGame(6);
    const p = g.players[0];
    p.level = 11;
    p.glyphs!.slots[0] = ["accelerant", "brandmark"]; // melee slot
    g.monsters.length = 0;
    const m = mkMon({ id: 900, pos: { x: p.pos.x + 1, y: p.pos.y }, hp: 100_000, maxHp: 100_000 });
    g.monsters.push(m);
    step(g, { move: { x: 0, y: 0 }, attack: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    expect(m.statuses?.some((s) => s.kind === "burn")).toBe(true); // accelerant
    expect(m.brandT).toBeGreaterThan(0); // brandmark
    expect(m.brandAbility).toBe("melee");
    // The cash-in: identical rng states, one branded target takes more from BOLT.
    const dmgWith = (branded: boolean) => {
      const gg = createGame(7);
      const pp = gg.players[0];
      gg.monsters.length = 0;
      const mm = mkMon({ id: 1, pos: { x: pp.pos.x + 1, y: pp.pos.y }, hp: 100_000, maxHp: 100_000 });
      if (branded) { mm.brandT = 4; mm.brandAbility = "melee"; mm.brandBy = pp.id; }
      gg.monsters.push(mm);
      damageMonster(gg, pp, mm, 1000, { allowCrit: false, ability: "bolt" });
      return 100_000 - mm.hp;
    };
    expect(dmgWith(true)).toBeGreaterThan(dmgWith(false));
    // ...but the SAME ability that branded does not double-dip.
    const dmgSame = (branded: boolean) => {
      const gg = createGame(7);
      const pp = gg.players[0];
      gg.monsters.length = 0;
      const mm = mkMon({ id: 1, pos: { x: pp.pos.x + 1, y: pp.pos.y }, hp: 100_000, maxHp: 100_000 });
      if (branded) { mm.brandT = 4; mm.brandAbility = "melee"; mm.brandBy = pp.id; }
      gg.monsters.push(mm);
      damageMonster(gg, pp, mm, 1000, { allowCrit: false, ability: "melee" });
      return 100_000 - mm.hp;
    };
    expect(dmgSame(true)).toBe(dmgSame(false));
  });

  it("SPLITFANG forks on first impact; forks and bounces never re-fork", () => {
    const g = createGame(8);
    const p = g.players[0];
    p.level = 4;
    p.glyphs!.slots[2][0] = "splitfang"; // bolt slot
    g.monsters.length = 0;
    g.monsters.push(mkMon({ id: 1, pos: { x: p.pos.x + 1.2, y: p.pos.y }, hp: 100_000, maxHp: 100_000 }));
    step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    for (let i = 0; i < 20 && !g.projectiles.some((pr) => pr.forked); i++) step(g, idle(), 1 / 60);
    const forks = g.projectiles.filter((pr) => pr.forked);
    expect(forks.length).toBeGreaterThan(0);
    for (const f of forks) {
      expect(f.hitIds).toBeTruthy(); // never re-hits the impact target
    }
  });

  it("ARC-SPLICE: the hit arcs a fraction to the nearest other enemy (one link)", () => {
    const g = createGame(9);
    const p = g.players[0];
    p.level = 4;
    p.glyphs!.slots[2][0] = "arc_splice";
    g.monsters.length = 0;
    const first = mkMon({ id: 1, pos: { x: p.pos.x + 1.2, y: p.pos.y }, hp: 100_000, maxHp: 100_000 });
    const second = mkMon({ id: 2, pos: { x: p.pos.x + 2.4, y: p.pos.y }, hp: 100_000, maxHp: 100_000 });
    g.monsters.push(first, second);
    for (let i = 0; i < 30 && second.hp === 100_000; i++) {
      step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    }
    expect(second.hp).toBeLessThan(100_000); // the arc landed
  });

  it("REPRISE: the nova re-detonates the same spot at reduced power", () => {
    const g = createGame(10);
    const p = g.players[0];
    p.level = 4;
    p.abilities.slots[3] = "nova";
    p.abilities.ranks; // nova castable once slotted
    p.glyphs!.slots[3][0] = "reprise";
    g.monsters.length = 0;
    const m = mkMon({ id: 1, pos: { x: p.pos.x + 1, y: p.pos.y }, hp: 1_000_000, maxHp: 1_000_000 });
    g.monsters.push(m);
    step(g, { move: { x: 0, y: 0 }, nova: true, useStairs: false }, 1 / 60);
    expect(g.strikes.some((s) => s.kind === "echo")).toBe(true);
    const hpAfterBlast = m.hp;
    for (let i = 0; i < 80; i++) step(g, idle(), 1 / 60); // the echo lands
    expect(m.hp).toBeLessThan(hpAfterBlast);
  });

  it("SLIPSTREAM: dashing opens the surge window (speed + damage riders)", () => {
    const g = createGame(11);
    const p = g.players[0];
    p.level = 4;
    p.glyphs!.slots[1][0] = "slipstream"; // dash slot
    step(g, { move: { x: 1, y: 0 }, dash: true, useStairs: false }, 1 / 60);
    expect(p.slipstreamT).toBeGreaterThan(0);
  });

  it("RULE 8: Executioner's Rebate refunds per kill, capped at 50% of the cast's cooldown", () => {
    const g = createGame(12);
    const p = g.players[0];
    p.level = 4;
    p.abilities.slots[3] = "nova";
    p.glyphs!.slots[3][0] = "executioners_rebate";
    p.spellPower = 99_999;
    g.monsters.length = 0;
    for (let i = 0; i < 6; i++) {
      g.monsters.push(mkMon({ id: 100 + i, pos: { x: p.pos.x + 0.8 + i * 0.1, y: p.pos.y }, hp: 1, maxHp: 1 }));
    }
    const cd0 = novaParams(p).cooldown;
    step(g, { move: { x: 0, y: 0 }, nova: true, useStairs: false }, 1 / 60);
    // 6 kills x 30% would be 180% — the budget stops it at 50%.
    expect(p.cd.nova).toBeGreaterThan(cd0 * (1 - CONFIG.refundCapFraction) - 0.1);
    expect(p.cd.nova).toBeLessThanOrEqual(cd0 * (1 - CONFIG.refundCapFraction));
  });
});

describe("composition with what exists (§3.2 rule 4)", () => {
  /** Total damage a SECOND monster standing beside the bolt's target takes —
   * every path to it (ricochet bounce, arc-splice link) lands on this number. */
  function splashOnNeighbour(seed: number, opts: { ricochet?: boolean; arc?: boolean }): number {
    const g = createGame(seed);
    const p = g.players[0];
    p.level = 4;
    if (opts.ricochet) p.abilities.ranks["bolt.ricochet"] = 1;
    if (opts.arc) p.glyphs!.slots[2][0] = "arc_splice"; // bolt's slot
    g.monsters.length = 0;
    const target = mkMon({ id: 1, pos: { x: p.pos.x + 1.2, y: p.pos.y }, hp: 1e9, maxHp: 1e9 });
    const neighbour = mkMon({ id: 2, pos: { x: p.pos.x + 2.2, y: p.pos.y }, hp: 1e9, maxHp: 1e9 });
    g.monsters.push(target, neighbour);
    step(g, { move: { x: 0, y: 0 }, bolt: true, aim: { x: 1, y: 0 }, useStairs: false }, 1 / 60);
    for (let i = 0; i < 40; i++) step(g, idle(), 1 / 60);
    return 1e9 - neighbour.hp;
  }

  it("RICOCHET capstone + Arc-Splice glyph: the counts ADD, each at its printed fraction", () => {
    const bounce = splashOnNeighbour(200, { ricochet: true });
    const arc = splashOnNeighbour(200, { arc: true });
    const both = splashOnNeighbour(200, { ricochet: true, arc: true });
    expect(bounce).toBeGreaterThan(0);
    expect(arc).toBeGreaterThan(0);
    // Neither replaces the other: with both socketed the neighbour eats both
    // links (60% bounce + 40% arc), never just the bigger one.
    expect(both).toBeGreaterThan(bounce);
    expect(both).toBeGreaterThan(arc);
  });

  it("REPRISE on nova never borrows the ultimate's EXTINCTION chain", () => {
    // Both are scheduled as `echo` strikes; only a CATACLYSM echo may chain.
    const g = createGame(201);
    const p = g.players[0];
    p.level = 11;
    p.abilities.slots[3] = "nova";
    p.abilities.ultimate = "cataclysm";
    p.abilities.ranks["cata.extinction"] = 1; // the capstone is live
    p.glyphs!.slots[3][0] = "reprise";
    g.monsters.length = 0;
    step(g, { move: { x: 0, y: 0 }, nova: true, useStairs: false }, 1 / 60);
    const echo = g.strikes.find((s) => s.kind === "echo");
    expect(echo?.ability).toBe("nova"); // tagged at schedule time, not guessed
  });

  it("a glyph's damage rider is multiplicative with constellation ranks (rule 3)", () => {
    const plain = createGame(202).players[0];
    plain.abilities.ranks["melee.heavy"] = 2;
    const glyphed = createGame(202).players[0];
    glyphed.level = 4;
    glyphed.abilities.ranks["melee.heavy"] = 2;
    glyphed.glyphs!.slots[0][0] = "heavyweight_plate";
    expect(meleeParams(glyphed).damageMult).toBeCloseTo(
      meleeParams(plain).damageMult * CONFIG.glyphHeavyweightDmgMult, 5,
    );
  });
});

describe("acquisition + persistence", () => {
  it("the Glyph Cache is shelved from shop 2 and grants a seeded glyph", () => {
    const g1 = createGame(13);
    g1.players[0].pos = { x: g1.map.stairs.x, y: g1.map.stairs.y };
    step(g1, { move: { x: 0, y: 0 }, useStairs: true }, 1 / 60);
    expect(g1.safeRoom!.available).not.toContain("glyph_cache"); // shop 1: not yet
    const g2 = restoreGame({ seed: 13, floor: 2, player: { hp: 500, level: 5, xp: 0, xpToNext: 999, gold: 500 } });
    g2.monsters.length = 0;
    g2.players[0].pos = { x: g2.map.stairs.x, y: g2.map.stairs.y };
    step(g2, { move: { x: 0, y: 0 }, useStairs: true }, 1 / 60);
    expect(g2.safeRoom!.available).toContain("glyph_cache");
    const p = g2.players[0];
    const owned0 = p.glyphs!.bench.length + p.glyphs!.slots.flat().filter(Boolean).length;
    buyCatalogItem(g2, 0, "glyph_cache");
    const owned1 = p.glyphs!.bench.length + p.glyphs!.slots.flat().filter(Boolean).length;
    expect(owned1).toBe(owned0 + 1);
    expect(p.gold).toBeLessThan(500);
  });

  it("glyphs round-trip the save seam with a default for pre-glyph saves", () => {
    const loadout = defaultGlyphs();
    loadout.slots[2][0] = "arc_splice";
    loadout.bench.push("hair_trigger");
    const g = restoreGame({
      seed: 14, floor: 2,
      player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0, glyphs: loadout },
    });
    expect(g.players[0].glyphs!.slots[2][0]).toBe("arc_splice");
    expect(g.players[0].glyphs!.bench).toContain("hair_trigger");
    // Pre-glyph save: loads with the empty default, never undefined.
    const old = restoreGame({ seed: 15, floor: 2, player: { hp: 100, level: 5, xp: 0, xpToNext: 99, gold: 0 } });
    expect(old.players[0].glyphs).toEqual(defaultGlyphs());
  });

  it("glyphs ride net snapshots (full + cold-block dynamic)", () => {
    const g = createGame(16);
    const p = g.players[0];
    p.glyphs!.slots[0][0] = "heavyweight_plate";
    p.glyphs!.bench.push("reprise");
    const full = deserialize(serialize(g));
    expect(full.players[0].glyphs).toEqual(p.glyphs);
    // Dynamic with a cold cache: the second snapshot omits the block and the
    // client merges it forward — glyphs must survive the round trip.
    const cache = new Map<number, string>();
    const first = JSON.parse(serializeDynamic(g, cache)) as GameState;
    expect(first.players[0].glyphs).toEqual(p.glyphs);
    const second = JSON.parse(serializeDynamic(g, cache)) as GameState;
    expect((second.players[0] as Partial<typeof p>).glyphs).toBeUndefined(); // stripped while unchanged
    mergeColdPlayers(second.players, first.players);
    expect(second.players[0].glyphs).toEqual(p.glyphs);
  });

  it("the shipped set is Phase B + Phase C, tags matching the §3.2 table", () => {
    // ABILITIES-V2 §5.2: the 15 Phase-C rows land WITH the tags and channels
    // they consume — no plumbing ships without a consumer (§7 slice 8).
    expect(GLYPH_IDS).toHaveLength(25);
    expect(new Set(GLYPH_IDS).size).toBe(25); // no duplicates in the roll order
    // Phase B keeps its positions: GLYPH_IDS is the SEEDED roll order, so
    // interleaving would re-roll every existing run's drops.
    expect(GLYPH_IDS.slice(0, 10)).toEqual([
      "arc_splice", "splitfang", "reprise", "brandmark", "accelerant",
      "arcane_lens", "executioners_rebate", "heavyweight_plate", "hair_trigger", "slipstream",
    ]);
    // §5.4 flag 1: Blood Price is a damage-for-cost trade, so it belongs to
    // TEMPO. In `rebate` it would have shared a slot with Heavyweight Plate
    // for +69% damage off two drawbacks that never interact.
    expect(GLYPH_INFO.blood_price.family).toBe("tempo");
    expect(GLYPH_INFO.ballistic_lens.family).toBe(GLYPH_INFO.arcane_lens.family);
    expect(GLYPH_INFO.longshot.family).toBe(GLYPH_INFO.point_blank.family);
    for (const id of GLYPH_IDS) expect(GLYPH_INFO[id].name).toBeTruthy();
    expect(glyphMatches("arc_splice", "bolt")).toBe(true);
    expect(glyphMatches("arc_splice", "melee")).toBe(false);
    expect(glyphMatches("reprise", "nova")).toBe(true);
    expect(glyphMatches("reprise", "bolt")).toBe(false);
    expect(glyphMatches("slipstream", "dash")).toBe(true);
    expect(glyphMatches("slipstream", "bolt")).toBe(false);
    // CHANGED (rule 6): "any" used to mean "matches everything". Heavyweight
    // Plate on Stunt Double is tag-legal but has no damage to amplify, so the
    // trade would be all cost and no payoff — it reads DORMANT now.
    expect(glyphTagMatches("heavyweight_plate", "stuntdouble")).toBe(true);
    expect(glyphMatches("heavyweight_plate", "stuntdouble")).toBe(false);
    expect(glyphMatches("executioners_rebate", "stuntdouble")).toBe(true); // still "any"
  });

  it("SUPPLY CONTRACT (§3.5): glyphs found keep pace with sockets opened", () => {
    // The failure this pins: 9 sockets against a 5%-of-22% drip meant a typical
    // run hit the act-2 rebuild beat with 3-4 glyphs and five empty pips, which
    // is the direct negation of the fast-round-building pillar. Supply is now
    // modelled off the SHIPPED knobs and must cover the sockets open at each
    // cadence beat. 30 kills/floor is the conservative floor: floors 2-12
    // SPAWN 26-93 monsters before any reinforcement, and the balance bot
    // clears most of a floor on its way to the stairs.
    const KILLS_PER_FLOOR = 30;
    const supplyByFloor = (floor: number): number => {
      let glyphs = 0;
      for (let f = 1; f <= floor; f++) {
        if (f < CONFIG.dropGlyphFromFloor) continue;
        const drip = KILLS_PER_FLOOR * CONFIG.lootDropChance * CONFIG.dropGlyphShare;
        glyphs += Math.min(drip, CONFIG.glyphDropsPerFloorCap);
        if (f % 3 === 0) glyphs += 1; // band bosses GUARANTEE one (§3.1)
      }
      // One Glyph Cache bought per shop from the shop the row shelves on —
      // what bot.ts already does whenever the gear plan is funded.
      glyphs += Math.max(0, floor - CONFIG.glyphCacheFromShop);
      return glyphs;
    };
    // Level at floor: the cadence the test URLs and createTestGame use.
    const levelAtFloor = (floor: number) => Math.round(floor * 1.5 + 2);
    for (const floor of [4, 7, 12]) {
      const level = levelAtFloor(floor);
      const sockets = totalSocketsOpen(level, floor >= 7);
      expect(supplyByFloor(floor), `floor ${floor}: ${sockets} sockets open`)
        .toBeGreaterThanOrEqual(sockets);
    }
    // ...and the supply is not SO fat that sockets stop being the constraint:
    // by the last stagger beat you own roughly a loadout, not the whole pool
    // twice over (glyphs are a pivot resource, not a vending machine).
    expect(supplyByFloor(12)).toBeLessThan(GLYPH_IDS.length * 3);
  });
});
