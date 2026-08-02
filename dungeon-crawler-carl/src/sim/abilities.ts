import { CONFIG } from "./config";
import { hasPassive, weaponClassOf } from "./items";
import { clampCooldown, glyphCdr, glyphDamageMult, hasGlyph } from "./glyphs";
import { chance, createRng, nextFloat, nextInt, pick, type Rng } from "./rng";
import type { Player } from "./types";

// Ability system (DESIGN.md 5.7 "The Five"): a build is exactly 4 active slots
// + 1 ultimate slot. Abilities are tagged by tier; discovering one auto-slots it
// if a matching slot is open, otherwise it goes to the BENCH; rearranging the
// loadout is a safe-room decision (slotAbility/setUltimate in game.ts). Upgrade
// drafts offer ranks only for SLOTTED abilities. Everything derives from
// Player.abilities, so numbers stay pure/deterministic/serializable.
//
// Adding a new ability = one entry here (+ its cast/passive behavior in
// game.ts's castAbility switch) — the loadout, drafts, tomes, HUD, and net
// protocol all pick it up from this registry.

export type AbilityId =
  | "melee" | "dash" | "bolt" | "nova" | "orbit" | "stance" | "overcharge"
  | "cutto" | "crowdsurf" | "stuntdouble"
  // ABILITIES-V2 §3.2: the three additions, one per remaining archetype hole.
  // IDS ARE SAVE DATA — the display names moved (Nova -> Collapse, Overcharge
  // -> Breaker, Cataclysm -> Fault Line, Airstrike -> Sponsor Barrage) but the
  // ids never do.
  | "bulwark" | "cables"
  | "airstrike" | "cataclysm" | "bullettime" | "injunction";

/**
 * ABILITIES-V2 §6.4: the role rule the contract tests stand on. Exactly ONE
 * per ability, assigned in the design, never inferred per test — a test whose
 * exemption list covers every failing case is not falsifiable. `ultimate` is
 * the axis for the ultimates whose job is "change what the room IS"; Fault
 * Line carries `zone` because terrain is the specific thing it changes.
 */
export type AbilityRole =
  | "beat" | "burst" | "clear" | "control" | "mobility" | "sustain" | "summon" | "zone" | "ultimate";

// Battle Stance: which attack TYPE the crawler currently favors. Melee swings
// and orbit blades are melee-type; bolts are ranged-type; everything else is
// stance-neutral. Extensible — a third stance is a union member away.
export type StanceId = "melee" | "ranged";

// Damage schools (DESIGN 5.8). Orthogonal to stance: stance judges RANGE,
// school decides which power stat feeds the hit (and, later, what resists it).
export type School = "physical" | "magic";

/**
 * School routing per ability: weights applied to attackPower/spellPower.
 * Magnitude coefficients stay in CONFIG (novaDamageMult etc.) — this table only
 * says WHICH stat an ability eats. Hybrids are both keys nonzero. Bolt is the
 * one deliberate absentee: its school comes from the equipped WEAPON
 * (boltParams) — a crossbow throws bolts, a staff throws magic missiles.
 */
export const SCALING: Partial<Record<AbilityId, { ap?: number; sp?: number }>> = {
  melee: { ap: 1 },
  orbit: { ap: 1 },
  cutto: { ap: 1 }, // the arrival strike is steel
  crowdsurf: { ap: 1 }, // the chain is hardware (Gavel Drop's blast stays arcane)
  stuntdouble: { ap: 1 }, // mirrors swings; the farewell blast is pyrotechnics
  airstrike: { ap: 1 }, // sponsor ordnance is extremely physical
  cables: { ap: 1 }, // steel cable and a winch
  // V2 R2: Shockstep is a MELEE build's escape tool; pure sp made a physical
  // crawler's detonation a rounding error (30 damage at floor 12). Hybrid now.
  dash: { ap: 0.5, sp: 0.5 },
  nova: { sp: 1 },
  cataclysm: { sp: 1 },
};

/** Abilities that GATHER — bodies end up next to the player (§2.2's cap, which
 * §6.4.8 counts in the registry rather than asserting in prose). */
export const GATHER_ABILITIES: AbilityId[] = ["nova", "crowdsurf"];

/** Effective spell power: Grounded Suit (V2 §2.3) runs it hotter above the
 * HP threshold. The one read point every SP consumer shares. */
export function effectiveSpellPower(p: Player): number {
  const grounded = hasPassive(p, "grounded") && p.hp > p.maxHp * CONFIG.groundedHpFraction;
  return p.spellPower * (grounded ? CONFIG.groundedSpellMult : 1);
}

/** The power an ability scales from (defaults to physical for the untabled).
 * The ARCANE LENS glyph (rule 5) converts the whole scale to spell power —
 * an explicit socket beats a default. */
export function power(p: Player, ability: AbilityId): number {
  if (hasGlyph(p, ability, "arcane_lens")) return effectiveSpellPower(p);
  // BALLISTIC LENS (V2 §5.1): the mirror image, and the one that matters for
  // §1.2's finding — Arcane Lens on Collapse or Fault Line is a literal no-op
  // (they are already sp:1). The physical crawler who rolled a 30% AP share
  // and wants his AoE to work needs THIS one. It mitigates the school lottery
  // with a socket tax; it does not fix it.
  if (hasGlyph(p, ability, "ballistic_lens")) return p.attackPower;
  const s = SCALING[ability] ?? { ap: 1 };
  return p.attackPower * (s.ap ?? 0) + effectiveSpellPower(p) * (s.sp ?? 0);
}

/** Dominant school of an ability AS CAST by this player (lens-aware). */
export function castSchool(p: Player, ability: AbilityId): School {
  if (hasGlyph(p, ability, "arcane_lens")) return "magic";
  if (hasGlyph(p, ability, "ballistic_lens")) return "physical";
  return abilitySchool(ability);
}

/** Dominant school of an ability's damage (hit tinting + future resists). */
export function abilitySchool(ability: AbilityId): School {
  const s = SCALING[ability] ?? { ap: 1 };
  return (s.sp ?? 0) > (s.ap ?? 0) ? "magic" : "physical";
}

/**
 * The player's damage-roll variance: the equipped WEAPON sets the dice for
 * every hit they land (swift ±10% metronome … chaotic ±40% slot machine).
 * Bare hands roll the default. The character sheet prints these same bounds.
 */
export function damageVariance(p: Player): number {
  const wc = weaponClassOf(p.equipment.weapon);
  return (wc && CONFIG.weaponVariance[wc]) || 0.15;
}

export type AbilityTier = "active" | "ultimate";

export const ABILITY_SLOTS = 4; // active slots (the ultimate has its own slot)

/** Abilities every crawler starts with (slotted 0..2; slot 3 + ultimate empty). */
export const STARTING_ABILITIES: AbilityId[] = ["melee", "dash", "bolt"];
/** Abilities that must be discovered (tomes/boxes/shop) before they can slot. */
export const DISCOVERABLE_ABILITIES: AbilityId[] = [
  "nova", "orbit", "stance", "overcharge", "airstrike", "cataclysm", "bullettime",
  // The fun-kit wave (mobility/utility/combo — see ABILITY-CONCEPTS.md).
  "cutto", "crowdsurf", "stuntdouble",
  // ABILITIES-V2 §3.2: control, defense, and the run-clock ultimate.
  "bulwark", "cables", "injunction",
];

export const ABILITY_INFO: Record<AbilityId, {
  name: string; blurb: string; tier: AbilityTier; role: AbilityRole; passive?: boolean;
}> = {
  melee: { name: "Melee", blurb: "Your trusty swing", tier: "active", role: "beat" },
  dash: { name: "Dash", blurb: "Blink with i-frames", tier: "active", role: "mobility" },
  bolt: { name: "Bolt", blurb: "Ranged projectile", tier: "active", role: "beat" },
  nova: { name: "Collapse", blurb: "Implode: the room is dragged onto your feet, then detonated", tier: "active", role: "clear" },
  orbit: { name: "Orbit", blurb: "Blades grind what's close — and press to HURL the ring", tier: "active", role: "clear" },
  stance: { name: "Battle Stance", blurb: "Swap footing for a free strike: matching attacks hit harder, mismatched softer", tier: "active", role: "beat" },
  overcharge: { name: "Breaker", blurb: "Bank a hit: it lands much harder and SHATTERS the windup it interrupts", tier: "active", role: "control" },
  cutto: { name: "Blindside", blurb: "Teleport onto an enemy, already swinging — unaware targets eat a crit", tier: "active", role: "burst" },
  crowdsurf: { name: "Extradition", blurb: "One chain: the light are transferred to you, you to the heavy", tier: "active", role: "mobility" },
  stuntdouble: { name: "Stunt Double", blurb: "A taunting double soaks hits, mirrors your swings, exits with a bang", tier: "active", role: "summon" },
  bulwark: { name: "Bulwark", blurb: "Brace: take the hit on purpose, then get paid for it", tier: "active", role: "sustain" },
  cables: { name: "Stage Cables", blurb: "Pin a line: nothing crosses, and the ground stays slow", tier: "active", role: "control" },
  airstrike: { name: "Sponsor Barrage", blurb: "Stop fighting and walk artillery across the room", tier: "ultimate", role: "ultimate" },
  cataclysm: { name: "Fault Line", blurb: "Crack the floor — and the floor keeps working", tier: "ultimate", role: "zone" },
  bullettime: { name: "Bullet Time", blurb: "The world slows; you do not", tier: "ultimate", role: "ultimate" },
  injunction: { name: "Injunction", blurb: "The collapse clock STAYS — and the dungeon fights back for every second", tier: "ultimate", role: "ultimate" },
};

export interface UpgradeDef {
  id: string; // "bolt.split"
  ability: AbilityId;
  title: string;
  maxRank: number;
  /** Overrank headroom: chase-able ranks past maxRank that only ever appear
   * through the draft lottery (rollUpgradeDraft) — never guaranteed. */
  over?: number;
  /** Human description of what the NEXT rank grants. */
  desc: (nextRank: number) => string;
  /** Node ids that must all hold rank > 0 before this node can be offered. */
  requires?: string[];
  /** Fork exclusivity: holding rank in any of these locks THIS node (and vice versa). */
  excludes?: string[];
  /** Hand-authored constellation position (0-100 space) for the T-panel graph. */
  pos: { x: number; y: number };
  /** Capstone: a build-defining behavior change, not a number (drawn as a diamond). */
  capstone?: boolean;
}

// Each ability's nodes form a small constellation: an entry node, an exclusive
// FORK (pick a side — that choice is the build), and a CAPSTONE that changes
// behavior rather than numbers. Level-up drafts (Hades) roll from what the
// graph says is reachable (PoE): requires gate, excludes lock the road not taken.
//
// `over` is each node's OVERRANK headroom: ranks past the printed max that only
// the draft lottery can offer (backlog #7 — OP builds exist, but hitting one is
// a run-to-run chase, not a guarantee). Cooldown nodes get 1 (they compound the
// hardest); other numeric nodes get 2; capstones are behavior bits and get none.
export const UPGRADES: UpgradeDef[] = [
  // ---- MELEE — the healthiest tree; the one filler node fixed (V2 §4.3) ----
  { id: "melee.arc", ability: "melee", title: "Wide Arc", maxRank: 2, over: 2, desc: (r) => `Swing arc +${r * 22}°; +${r} target${r === 1 ? "" : "s"} on the hit list`, pos: { x: 50, y: 12 } },
  // The fork sides carry an IDENTITY, not just a number: Heavy's killing
  // swings splash their overkill, Swift's connecting swings stack momentum.
  { id: "melee.heavy", ability: "melee", title: "Heavy Blows", maxRank: 3, over: 2, desc: (r) => `Melee damage +${r * 20}%${r === 1 ? "; killing-swing overkill splashes nearby" : ""}`, requires: ["melee.arc"], excludes: ["melee.swift"], pos: { x: 22, y: 48 } },
  { id: "melee.swift", ability: "melee", title: "Swift Strikes", maxRank: 3, over: 1, desc: (r) => `Melee cooldown -${r * 12}%; momentum stacks to +${r * CONFIG.meleeMomentumStacksPerRank * Math.round(CONFIG.meleeMomentumPerStack * 100)}%`, requires: ["melee.arc"], excludes: ["melee.heavy"], pos: { x: 78, y: 48 } },
  { id: "melee.bleed", ability: "melee", title: "Ragged Edge", maxRank: 1, over: 1, desc: (r) => `Crits apply ${r} POISON stack${r === 1 ? "" : "s"}`, requires: ["melee.arc"], pos: { x: 50, y: 62 } },
  { id: "melee.execute", ability: "melee", title: "EXECUTIONER", maxRank: 1, desc: () => "Melee deals +60% to enemies below 30% HP", requires: ["melee.arc"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- DASH — Shockstep is the entry; the false fork gets identities (V2 R2) ----
  { id: "dash.shock", ability: "dash", title: "Shockstep", maxRank: 3, over: 2, desc: (r) => `Arrival burst: ${r * 50}% damage along the path (hybrid: half steel, half arcane)`, pos: { x: 50, y: 12 } },
  { id: "dash.quick", ability: "dash", title: "Quickstep", maxRank: 2, over: 1, desc: (r) => (r >= 2 ? "A THIRD dash charge" : `Dash recharge -${r * 18}%`), requires: ["dash.shock"], excludes: ["dash.blink"], pos: { x: 22, y: 48 } },
  { id: "dash.blink", ability: "dash", title: "Long Blink", maxRank: 2, over: 2, desc: (r) => `Dash distance +${r * 30}%; enemies you pass through take 40% of Shockstep`, requires: ["dash.shock"], excludes: ["dash.quick"], pos: { x: 78, y: 48 } },
  { id: "dash.veil", ability: "dash", title: "Smoke Break", maxRank: 1, over: 1, desc: () => `The dash leaves a blind puff: monsters inside DROP their target for ${CONFIG.dashVeilSeconds}s`, requires: ["dash.shock"], pos: { x: 50, y: 62 } },
  { id: "dash.after", ability: "dash", title: "AFTERSHOCK", maxRank: 1, desc: () => "Your dash also detonates at the arrival point", requires: ["dash.shock"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- BOLT — the dead gate now changes your feet ----
  { id: "bolt.rapid", ability: "bolt", title: "Rapid Bolts", maxRank: 3, over: 1, desc: (r) => (r >= 3 ? "Bolt cooldown -45%; fire at FULL MOVEMENT SPEED (no animation lock)" : `Bolt cooldown -${r * 15}%`), pos: { x: 50, y: 12 } },
  { id: "bolt.split", ability: "bolt", title: "Split Shot", maxRank: 2, over: 2, desc: (r) => `Fire ${1 + r} bolts in a fan`, requires: ["bolt.rapid"], excludes: ["bolt.pierce"], pos: { x: 22, y: 48 } },
  { id: "bolt.pierce", ability: "bolt", title: "Piercing Bolts", maxRank: 2, over: 2, desc: (r) => `Bolts pierce ${r} extra ${r === 1 ? "enemy" : "enemies"}`, requires: ["bolt.rapid"], excludes: ["bolt.split"], pos: { x: 78, y: 48 } },
  { id: "bolt.frost", ability: "bolt", title: "Frost Bolts", maxRank: 1, over: 1, desc: (r) => `Bolts CHILL: −${Math.round(Math.min(CONFIG.chillSlowMax, r * CONFIG.chillSlowPerRank) * 100)}% move & attack speed for ${CONFIG.chillDuration}s`, requires: ["bolt.rapid"], pos: { x: 50, y: 62 } },
  { id: "bolt.ricochet", ability: "bolt", title: "RICOCHET", maxRank: 1, desc: () => "Bolts bounce to a nearby enemy on hit (60% damage)", requires: ["bolt.rapid"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- COLLAPSE (was Nova) — rebuilt around the GATHER (V2 R1) ----
  { id: "nova.bang", ability: "nova", title: "Event Horizon", maxRank: 2, over: 2, desc: (r) => `Gather radius +${r * 25}% (blast radius rides along at half)`, pos: { x: 50, y: 12 } },
  { id: "nova.crush", ability: "nova", title: "Crush", maxRank: 3, over: 2, desc: (r) => `Dragged targets land STAGGERED; the blast deals +${r * 25}% to anything it dragged`, requires: ["nova.bang"], excludes: ["nova.rift"], pos: { x: 22, y: 48 } },
  { id: "nova.rift", ability: "nova", title: "Rift", maxRank: 2, over: 1, desc: (r) => `The implosion point stays a SINGULARITY for ${CONFIG.novaRiftSeconds}s; cooldown -${r * 10}%`, requires: ["nova.bang"], excludes: ["nova.crush"], pos: { x: 78, y: 48 } },
  { id: "nova.scorch", ability: "nova", title: "Afterburn", maxRank: 1, over: 1, desc: (r) => `Collapse IGNITES: burn for ${Math.round(r * CONFIG.novaScorchFracPerRank * 100)}% of its damage over ${CONFIG.burnDuration}s`, requires: ["nova.bang"], pos: { x: 50, y: 62 } },
  { id: "nova.singular", ability: "nova", title: "SINGULARITY", maxRank: 1, desc: () => "The collapse pulls PROJECTILES too — enemy shots bend into the crater and are consumed", requires: ["nova.bang"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- ORBIT — the tree was fine; it now hangs off a verb (V2 R3) ----
  { id: "orbit.blade", ability: "orbit", title: "Extra Blade", maxRank: 2, over: 2, desc: (r) => `${CONFIG.orbitBladesBase + r} orbiting blades`, pos: { x: 50, y: 14 } },
  { id: "orbit.razor", ability: "orbit", title: "Razor's Edge", maxRank: 3, over: 2, desc: (r) => `Blade damage +${r * 35}%; hurled blades PIERCE`, requires: ["orbit.blade"], excludes: ["orbit.wide"], pos: { x: 25, y: 48 } },
  {
    id: "orbit.wide", ability: "orbit", title: "Corkscrew", maxRank: 2, over: 1,
    desc: (r) => `Blades spiral ${CONFIG.orbitSpiralInner}–${(CONFIG.orbitRadius + CONFIG.orbitSpiralPerRank * r).toFixed(1)} tiles; the hurl travels ${Math.round(CONFIG.orbitHurlWideBonus * 100)}% further`,
    requires: ["orbit.blade"], excludes: ["orbit.razor"], pos: { x: 75, y: 48 },
  },
  { id: "orbit.guard", ability: "orbit", title: "Crossguard", maxRank: 1, over: 1, desc: () => `While the ring is home it PARRIES: the first enemy melee hit every ${CONFIG.orbitGuardCooldown}s is negated`, requires: ["orbit.blade"], pos: { x: 50, y: 62 } },
  { id: "orbit.guillotine", ability: "orbit", title: "GUILLOTINE", maxRank: 1, desc: () => `Blades CANCEL non-elites below ${Math.round(CONFIG.orbitGuillotineThreshold * 100)}% HP`, requires: ["orbit.blade"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- BATTLE STANCE — keep the best fork in the game; the base now ACTS (V2 R4) ----
  { id: "stance.edge", ability: "stance", title: "Honed Edge", maxRank: 2, over: 2, desc: (r) => (r >= 2 ? "The stance also covers LENS-CONVERTED abilities" : "The stance covers your ABILITIES of that school, not just basic attacks"), pos: { x: 50, y: 12 } },
  { id: "stance.discipline", ability: "stance", title: "Discipline", maxRank: 3, over: 2, desc: (r) => `Settled (${CONFIG.stanceSettleSeconds}s+ in one stance): matching damage +${r * 10}%`, requires: ["stance.edge"], excludes: ["stance.flow"], pos: { x: 22, y: 48 } },
  { id: "stance.flow", ability: "stance", title: "Flow", maxRank: 3, over: 2, desc: (r) => `For ${CONFIG.stanceSurgeSeconds}s after a swap: matching damage +${r * 15}%. Every swap strikes, settled or not (${Math.round(CONFIG.stanceFlowStrikeMult * 100)}% power)`, requires: ["stance.edge"], excludes: ["stance.discipline"], pos: { x: 78, y: 48 } },
  { id: "stance.footwork", ability: "stance", title: "Footwork", maxRank: 1, over: 1, desc: (r) => `The free swap-strike refunds ${(r * CONFIG.stanceFootworkRefund).toFixed(1)}s of the swapped-to attack's cooldown`, requires: ["stance.edge"], pos: { x: 50, y: 62 } },
  { id: "stance.perfect", ability: "stance", title: "PERFECT FORM", maxRank: 1, desc: () => "While settled, BOTH attack types count as matching", requires: ["stance.discipline"], capstone: true, pos: { x: 22, y: 86 } },
  { id: "stance.moment", ability: "stance", title: "MOMENTUM", maxRank: 1, desc: () => "Swapping stances primes a guaranteed crit on your next matching attack", requires: ["stance.flow"], capstone: true, pos: { x: 78, y: 86 } },

  // ---- BREAKER (was Overcharge) — the interrupt is BASE; the tree is what
  // the break BUYS (V2 R5) ----
  { id: "overcharge.surge", ability: "overcharge", title: "Surge", maxRank: 3, over: 2, desc: (r) => `The banked hit reaches further: +${r} target on a swing, +${r} pierce on a bolt`, pos: { x: 50, y: 12 } },
  { id: "overcharge.volley", ability: "overcharge", title: "Overcharged Volley", maxRank: 2, over: 1, desc: (r) => `Overcharged bolt casts fire ${r} extra bolt${r === 1 ? "" : "s"}`, requires: ["overcharge.surge"], excludes: ["overcharge.echo"], pos: { x: 22, y: 48 } },
  { id: "overcharge.echo", ability: "overcharge", title: "Echo Strike", maxRank: 2, over: 1, desc: (r) => `Overcharged swings strike twice (echo at ${r * 40}% damage)`, requires: ["overcharge.surge"], excludes: ["overcharge.volley"], pos: { x: 78, y: 48 } },
  { id: "overcharge.window", ability: "overcharge", title: "Open Season", maxRank: 1, over: 1, desc: (r) => `Enemies you break take +${Math.round(r * CONFIG.overchargeWindowBonus * 100)}% from EVERYTHING for ${CONFIG.overchargeWindowSeconds}s`, requires: ["overcharge.surge"], pos: { x: 50, y: 62 } },
  { id: "overcharge.chain", ability: "overcharge", title: "CHAIN REACTION", maxRank: 1, desc: () => `A banked hit that staggers propagates the stagger ${CONFIG.overchargeChainRadius} tiles`, requires: ["overcharge.surge"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- BLINDSIDE — fix the dominated fork side (V2 R6) ----
  { id: "cut.range", ability: "cutto", title: "Long Reach", maxRank: 2, over: 2, desc: (r) => `Blindside range +${r * 15}%; the cut can target a corpse or a party ping`, pos: { x: 50, y: 12 } },
  { id: "cut.encore", ability: "cutto", title: "Second Take", maxRank: 2, over: 1, desc: (r) => `Blindside gains ${r} extra charge${r === 1 ? "" : "s"}, recharging one at a time`, requires: ["cut.range"], excludes: ["cut.smash"], pos: { x: 22, y: 48 } },
  { id: "cut.smash", ability: "cutto", title: "Sucker Punch", maxRank: 2, over: 1, desc: (r) => `Arrival strike +${r * 30}%; non-elites arrive STAGGERED`, requires: ["cut.range"], excludes: ["cut.encore"], pos: { x: 78, y: 48 } },
  { id: "cut.mark", ability: "cutto", title: "Continuity", maxRank: 1, over: 1, desc: () => `The arrival target is BRANDED ${CONFIG.cutBrandSeconds}s: +${Math.round(CONFIG.cutBrandBonus * 100)}% from your other abilities (does not stack with Brandmark — strongest wins)`, requires: ["cut.range"], pos: { x: 50, y: 62 } },
  { id: "cut.match", ability: "cutto", title: "REPEAT OFFENDER", maxRank: 1, desc: () => `Kill the target within ${CONFIG.cutToMatchWindow}s of arriving: Blindside resets`, requires: ["cut.range"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- EXTRADITION — the base hits and drags three (V2 R7) ----
  { id: "surf.chain", ability: "crowdsurf", title: "Long Arm", maxRank: 2, over: 2, desc: (r) => `Chain range +${r * 20}%; +${r} more ${r === 1 ? "body" : "bodies"} dragged`, pos: { x: 50, y: 12 } },
  { id: "surf.grip", ability: "crowdsurf", title: "Contempt", maxRank: 2, over: 1, desc: (r) => `Pulled enemies land staggered +${(r * CONFIG.surfStaggerPerRank).toFixed(1)}s longer`, requires: ["surf.chain"], excludes: ["surf.dive"], pos: { x: 22, y: 48 } },
  { id: "surf.dive", ability: "crowdsurf", title: "Gavel Drop", maxRank: 2, over: 1, desc: (r) => `Pulling YOURSELF detonates on arrival (+${Math.round(r * CONFIG.surfDiveFracPerRank * 100)}% power on top of the base hit)`, requires: ["surf.chain"], excludes: ["surf.grip"], pos: { x: 78, y: 48 } },
  { id: "surf.hook", ability: "crowdsurf", title: "Writ of Attachment", maxRank: 1, over: 1, desc: () => "The chain can pull a HAZARD toward you and extinguish it — or pull YOU out of one", requires: ["surf.chain"], pos: { x: 50, y: 62 } },
  { id: "surf.wave", ability: "crowdsurf", title: "CLASS ACTION", maxRank: 1, desc: () => "The chain drags EVERYTHING it passes through, no cap", requires: ["surf.chain"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- STUNT DOUBLE — the double can die, so its tree is a choice (V2 R8) ----
  { id: "double.break", ability: "stuntdouble", title: "Big Break", maxRank: 2, over: 2, desc: (r) => `Contract +${r}s; double HP +${Math.round(r * CONFIG.doubleHpPerBreakRank * 100)}%`, pos: { x: 50, y: 12 } },
  { id: "double.method", ability: "stuntdouble", title: "Method Actor", maxRank: 2, over: 1, desc: (r) => `Taunt radius +${r * 25}%; the double mirrors your ABILITIES, not just swings`, requires: ["double.break"], excludes: ["double.pyro"], pos: { x: 22, y: 48 } },
  { id: "double.pyro", ability: "stuntdouble", title: "Pyrotechnic Exit", maxRank: 2, over: 1, desc: (r) => `The farewell blast leaves BURNING GROUND for ${CONFIG.doublePyroBurnSeconds}s, radius and burn scaled by what it absorbed (+${r * 40}% radius)`, requires: ["double.break"], excludes: ["double.method"], pos: { x: 78, y: 48 } },
  { id: "double.cue", ability: "stuntdouble", title: "Cue", maxRank: 1, desc: () => "Once per contract you may SWAP PLACES with your double", requires: ["double.break"], pos: { x: 50, y: 62 } },
  { id: "double.award", ability: "stuntdouble", title: "AWARD SEASON", maxRank: 1, desc: () => `A double that DIES on the clock refunds ${Math.round(CONFIG.doubleAwardRefund * 100)}% of the cooldown. One that expires unharmed refunds nothing.`, requires: ["double.break"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- BULWARK [new tree] — the missing defensive window (V2 N1) ----
  { id: "bul.dig", ability: "bulwark", title: "Dig In", maxRank: 2, over: 2, desc: (r) => `The brace also covers allies (and your double) within ${CONFIG.bulwarkAllyRadius + r * CONFIG.bulwarkAllyPerRank} tiles`, pos: { x: 50, y: 12 } },
  { id: "bul.rally", ability: "bulwark", title: "Rally", maxRank: 2, over: 1, desc: (r) => `The heal fires IMMEDIATELY at ${Math.round(CONFIG.bulwarkRallyFrac * 100)}% value (+${r * 10}% absorbed)`, requires: ["bul.dig"], excludes: ["bul.grit"], pos: { x: 22, y: 48 } },
  { id: "bul.grit", ability: "bulwark", title: "Grit", maxRank: 2, over: 1, desc: (r) => `Mitigation ${Math.round(CONFIG.bulwarkMitigation * 100)}% -> ${Math.round(CONFIG.bulwarkGritMitigation * 100)}%, but the heal only pays if you were hit at least ${1 + r} times`, requires: ["bul.dig"], excludes: ["bul.rally"], pos: { x: 78, y: 48 } },
  { id: "bul.shove", ability: "bulwark", title: "Shove", maxRank: 1, over: 1, desc: () => `The brace expiry knocks back and staggers everything within ${CONFIG.bulwarkShoveRadius} tiles`, requires: ["bul.dig"], pos: { x: 50, y: 62 } },
  { id: "bul.spite", ability: "bulwark", title: "SPITE", maxRank: 1, desc: () => `Damage absorbed during the brace is added to your next attack (capped at ${CONFIG.bulwarkSpiteCap}x attack power)`, requires: ["bul.dig"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- STAGE CABLES [new tree] — hard control + zone denial (V2 N2) ----
  { id: "cab.span", ability: "cables", title: "Span", maxRank: 2, over: 2, desc: (r) => `+${(r * CONFIG.cablesSpanPerRank).toFixed(1)} tiles of line`, pos: { x: 50, y: 12 } },
  { id: "cab.taut", ability: "cables", title: "Taut", maxRank: 2, over: 1, desc: (r) => `The line RE-ARMS ${r} more time${r === 1 ? "" : "s"} after the first pin drops`, requires: ["cab.span"], excludes: ["cab.live"], pos: { x: 22, y: 48 } },
  { id: "cab.live", ability: "cables", title: "Live Wire", maxRank: 2, over: 1, desc: (r) => `The cables deal ${(r * CONFIG.cablesLiveFrac).toFixed(1)}x power per second while anything is pinned in them`, requires: ["cab.span"], excludes: ["cab.taut"], pos: { x: 78, y: 48 } },
  { id: "cab.snap", ability: "cables", title: "Snapback", maxRank: 1, over: 1, desc: () => "When a pin ends, the enemy is yanked back to THE LINE once — never toward you", requires: ["cab.span"], pos: { x: 50, y: 62 } },
  { id: "cab.curtain", ability: "cables", title: "CURTAIN CALL", maxRank: 1, desc: () => "Pinned enemies that die leave the cables live: the field re-pins once more", requires: ["cab.span"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- SPONSOR BARRAGE (was Airstrike) — the fork is WHAT it is for (V2 U2) ----
  { id: "air.payload", ability: "airstrike", title: "Bigger Payload", maxRank: 2, over: 2, desc: (r) => `+${r} shell${r === 1 ? "" : "s"} per barrage`, pos: { x: 50, y: 12 } },
  { id: "air.saturation", ability: "airstrike", title: "Saturation Barrage", maxRank: 2, over: 1, desc: (r) => `The barrage covers a moving ${(CONFIG.barrageBandWidth * r).toFixed(1)}-tile BAND instead of a point`, requires: ["air.payload"], excludes: ["air.precision"], pos: { x: 22, y: 48 } },
  { id: "air.precision", ability: "airstrike", title: "Precision Strike", maxRank: 2, over: 1, desc: (r) => `Shells TRACK the nearest elite/boss within ${(CONFIG.barrageTrackRadius * r).toFixed(1)} tiles of your aim`, requires: ["air.payload"], excludes: ["air.saturation"], pos: { x: 78, y: 48 } },
  { id: "air.smoke", ability: "airstrike", title: "Smokescreen", maxRank: 1, desc: () => "The impact zone blocks enemy ranged line of sight for 3s", requires: ["air.payload"], pos: { x: 50, y: 62 } },
  { id: "air.loyalty", ability: "airstrike", title: "SPONSOR LOYALTY", maxRank: 1, desc: () => `Every barrage kill refunds ${Math.round(CONFIG.ultAirstrikeLoyaltyRefund * 100)}% of the cooldown`, requires: ["air.payload"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- FAULT LINE (was Cataclysm) — duration vs violence, both landing in
  // the same fissure (V2 U1) ----
  { id: "cata.epicenter", ability: "cataclysm", title: "Epicenter", maxRank: 2, over: 2, desc: (r) => `Radius +${Math.round(r * CONFIG.ultCataclysmEpicenterRadius * 100)}%; the fissure lasts +${(r * CONFIG.faultLineEpicenterSeconds).toFixed(1)}s`, pos: { x: 50, y: 12 } },
  { id: "cata.aftermath", ability: "cataclysm", title: "Aftermath", maxRank: 2, over: 1, desc: (r) => `The fissure ticks ${Math.round(r * CONFIG.faultLineAftermathBonus * 100)}% harder`, requires: ["cata.epicenter"], excludes: ["cata.upheaval"], pos: { x: 22, y: 48 } },
  { id: "cata.upheaval", ability: "cataclysm", title: "Upheaval", maxRank: 2, over: 1, desc: (r) => `Hurl +${Math.round(r * CONFIG.ultCataclysmUpheavalKnock * 100)}%; the blast crushes poise — and they land back in the fissure`, requires: ["cata.epicenter"], excludes: ["cata.aftermath"], pos: { x: 78, y: 48 } },
  { id: "cata.chasm", ability: "cataclysm", title: "Chasm", maxRank: 1, over: 1, desc: () => "The fissure BLOCKS enemy pathing at its center for its duration — a hole, not just a burn", requires: ["cata.epicenter"], pos: { x: 50, y: 62 } },
  { id: "cata.extinction", ability: "cataclysm", title: "EXTINCTION EVENT", maxRank: 1, desc: () => "Enemies killed by Fault Line DETONATE, chaining the blast outward", requires: ["cata.epicenter"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- BULLET TIME — barely touched; the entry is a grammar fix (V2 §4.3) ----
  { id: "bt.focus", ability: "bullettime", title: "Deep Focus", maxRank: 2, over: 2, desc: (r) => (r >= 2 ? "Hazard tick rates and boss phase timers slow too" : "Enemy projectiles already in flight slow too"), pos: { x: 50, y: 12 } },
  { id: "bt.adrenaline", ability: "bullettime", title: "Adrenaline", maxRank: 2, over: 1, desc: (r) => `YOUR cooldowns tick ${Math.round(r * CONFIG.ultBulletTimeAdrenaline * 100)}% faster inside; dash charges refund instantly on use`, requires: ["bt.focus"], excludes: ["bt.deadeye"], pos: { x: 22, y: 48 } },
  { id: "bt.deadeye", ability: "bullettime", title: "Dead Eye", maxRank: 2, over: 1, desc: (r) => `+${Math.round(r * CONFIG.ultBulletTimeDeadeyeCrit * 100)}% crit chance inside; crits inside do not consume the Breaker bank`, requires: ["bt.focus"], excludes: ["bt.adrenaline"], pos: { x: 78, y: 48 } },
  { id: "bt.reel", ability: "bullettime", title: "Second Wind", maxRank: 1, desc: () => `The first kill inside pauses the world an extra ${CONFIG.ultBulletTimeSecondWind}s`, requires: ["bt.focus"], pos: { x: 50, y: 62 } },
  { id: "bt.encore", ability: "bullettime", title: "EXTENSION", maxRank: 1, desc: () => `Kills inside extend bullet time ${CONFIG.ultBulletTimeEncoreExtend}s. Extensions are granted automatically.`, requires: ["bt.focus"], capstone: true, pos: { x: 50, y: 86 } },

  // ---- INJUNCTION [new tree] — every node changes what the window is FOR;
  // none changes its price. The debt is always injunctionDebtRatio x the
  // freeze, structurally, so no node can make the trade profitable (V2 N3).
  { id: "inj.notice", ability: "injunction", title: "Notice Period", maxRank: 2, over: 2, desc: (r) => (r >= 2 ? "Boss arena and phase timers freeze too" : "Hazard spread and puddle growth freeze too"), pos: { x: 50, y: 12 } },
  { id: "inj.crunch", ability: "injunction", title: "Crunch Time", maxRank: 2, over: 1, desc: () => `The stay is SHORTER (${CONFIG.injunctionCrunchFreeze}s, debt ${(CONFIG.injunctionCrunchFreeze * CONFIG.injunctionDebtRatio).toFixed(1)}s) and you hit +${Math.round(CONFIG.injunctionCrunchBonus * 100)}% harder inside`, requires: ["inj.notice"], excludes: ["inj.recess"], pos: { x: 22, y: 48 } },
  { id: "inj.recess", ability: "injunction", title: "Recess", maxRank: 2, over: 1, desc: () => `The stay is LONGER (${CONFIG.injunctionRecessFreeze}s, debt ${(CONFIG.injunctionRecessFreeze * CONFIG.injunctionDebtRatio).toFixed(1)}s) with no damage bonus`, requires: ["inj.notice"], excludes: ["inj.crunch"], pos: { x: 78, y: 48 } },
  { id: "inj.contempt", ability: "injunction", title: "Contempt", maxRank: 1, desc: () => "An enraged monster you STAGGER inside the freeze loses the enrage for the rest of the window", requires: ["inj.notice"], pos: { x: 50, y: 62 } },
  { id: "inj.dismissed", ability: "injunction", title: "DISMISSED WITH PREJUDICE", maxRank: 1, desc: () => `If nothing is alive within ${CONFIG.injunctionDismissedRadius} tiles when the freeze ends, the debt drops ${Math.round(CONFIG.injunctionDismissedRelief * 100)}% — never cancelled`, requires: ["inj.notice"], capstone: true, pos: { x: 50, y: 86 } },
];

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export function upgradeDef(id: string): UpgradeDef | undefined {
  return BY_ID.get(id);
}

export function rank(p: Player, id: string): number {
  return p.abilities.ranks[id] ?? 0;
}

/** Known = anywhere in the loadout: a slot, the ultimate slot, or the bench. */
export function knows(p: Player, ability: AbilityId): boolean {
  return (
    p.abilities.slots.includes(ability) ||
    p.abilities.ultimate === ability ||
    p.abilities.bench.includes(ability)
  );
}

/** Slotted = currently castable (drafts and the cast path read this). */
export function slotted(p: Player, ability: AbilityId): boolean {
  return p.abilities.slots.includes(ability) || p.abilities.ultimate === ability;
}

/**
 * Deterministic per-run pacing: the player LEVEL each discoverable ability
 * unlocks at (every discovery pool — tome drops, safe-room tomes, loot-box
 * skill chips — reads this via unknownAbilities). Order is shuffled and
 * spacing jittered 1-3 levels (~2 avg) per seed, so a crawler doesn't just
 * vacuum up the whole constellation in the first few floors, and no two runs
 * feel identically paced. Pure function of the run seed — nothing to persist
 * or sync in multiplayer, just recomputed on demand.
 */
export function tomeSchedule(seed: number): Partial<Record<AbilityId, number>> {
  const rng = createRng((seed ^ 0x7ab1e77) >>> 0);
  const order = [...DISCOVERABLE_ABILITIES];
  for (let i = order.length - 1; i > 0; i--) {
    const j = nextInt(rng, 0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const schedule: Partial<Record<AbilityId, number>> = {};
  let level = 1;
  // V2 §4.4: the step SCALES WITH THE POOL. Appending abilities without this
  // pushed the mean last unlock from level 21.2 to 27.2 while an on-curve
  // crawler ends the run at 23 — 2.28 abilities per run that never unlock at
  // all. A pillar-1 regression disguised as an array append; §6.4.12 pins it.
  const pace = 10 / DISCOVERABLE_ABILITIES.length;
  for (const a of order) {
    level += (1 + nextFloat(rng) * 2) * pace; // ~2 levels at a 10-ability pool
    schedule[a] = Math.max(2, Math.round(level));
  }
  return schedule;
}

/**
 * Abilities not yet discovered (tomes can drop for these). Gated two ways:
 * the level pacing above (tomeSchedule), and — on top of that — ultimates
 * stay out of EVERY discovery pool until `CONFIG.ultimateMinFloor` regardless
 * of level; finding one should feel like an act break, not an early lottery.
 */
export function unknownAbilities(
  p: Player, floor: number, seed: number, runKind: "race" | "roam" = "race",
): AbilityId[] {
  const schedule = tomeSchedule(seed);
  return DISCOVERABLE_ABILITIES.filter(
    (a) =>
      !knows(p, a) &&
      p.level >= (schedule[a] ?? 0) &&
      (ABILITY_INFO[a].tier !== "ultimate" || floor >= CONFIG.ultimateMinFloor) &&
      // V2 N3: an ultimate about the RUN CLOCK does not belong in a mode with
      // no run clock. It is not offered there — the crawler gets one of the
      // other three rather than a numbers-not-rules fallback.
      !(a === "injunction" && runKind === "roam"),
  );
}

/** Fresh loadout for a new crawler. */
export function startingLoadout(): Player["abilities"] {
  return {
    slots: [...STARTING_ABILITIES, null] as (AbilityId | null)[],
    ultimate: null,
    bench: [],
    ranks: {},
  };
}

// ---- Effective ability parameters (pure; read CONFIG + node ranks) ----

/** The constellation nodes that print a % COOLDOWN REDUCTION, per ability, as
 * [node id, reduction per rank]. The single source the param functions and the
 * cap readout below both spend — if a node is added, it goes here too. */
const CDR_NODES: Partial<Record<AbilityId, [string, number]>> = {
  melee: ["melee.swift", 0.12],
  // V2 §4.3: Quickstep's rank 2 is a CHARGE, not a percentage — only rank 1
  // contributes to the rule-7 sum (see dashParams).
  dash: ["dash.quick", 0.18],
  bolt: ["bolt.rapid", 0.15],
  nova: ["nova.rift", 0.10],
  // cutto's CDR node retired: Second Take grants a CHARGE (V2 §5.4 flag 3).
  // orbit takes glyph CDR only — no rank CDR node on the hurl.
};

/**
 * RULE 7's ledger, for the UI: where an ability's cooldown reduction comes
 * from and how much of it the cap is EATING. A crawler at the cap keeps a
 * glyph's damage drawback while its cooldown line does nothing — a hidden trap
 * unless the panel says so, which is what `wasted` is for.
 */
export function abilityCdrBreakdown(p: Player, ability: AbilityId): {
  rank: number; glyph: number; total: number; applied: number; wasted: number; capped: boolean;
} {
  const node = CDR_NODES[ability];
  const rankCdr = node ? rank(p, node[0]) * node[1] : 0;
  const glyph = glyphCdr(p, ability);
  const total = rankCdr + glyph;
  const applied = Math.min(total, CONFIG.cdrCap);
  // A cooldown INCREASE (Heavyweight's negative) is never "capped" — rule 7
  // clamps the floor, not the ceiling.
  const capped = total > CONFIG.cdrCap;
  return { rank: rankCdr, glyph, total, applied, wasted: Math.max(0, total - applied), capped };
}

export function meleeParams(p: Player) {
  // Weapon-class hooks (DESIGN 5.8): swift swings faster, heavy hits harder
  // (and staggers harder) but slower, reach extends the arc's radius. The Mug
  // does a little of everything, badly. Arcane/ballistic weapons swing as a
  // POMMEL BASH (offclassMeleeDmgMult) — the melee mirror of bolt's thrown
  // sidearm: the wrong tool works, reduced.
  const wc = weaponClassOf(p.equipment.weapon);
  const classDmg =
    wc === "heavy" ? CONFIG.heavyMeleeDmgMult
    : wc === "chaotic" ? 1.15
    : wc === "arcane" || wc === "ballistic" ? CONFIG.offclassMeleeDmgMult
    : 1;
  const classCd = wc === "swift" ? CONFIG.swiftMeleeCdMult : wc === "heavy" ? CONFIG.heavyMeleeCdMult : wc === "chaotic" ? 0.95 : 1;
  // RULE 7 (V2 §3.2): rank CDR + glyph CDR sum ADDITIVELY, one clamp at 40%.
  // Weapon-class multipliers are identity, not "% cooldown modifiers" — they
  // stay outside the sum (as do frenzy/tempo, which are temporal buffs).
  return {
    damageMult: (1 + rank(p, "melee.heavy") * 0.2) * classDmg * glyphDamageMult(p, "melee"),
    cooldown: clampCooldown(CONFIG.playerAttackCooldown, rank(p, "melee.swift") * 0.12 + glyphCdr(p, "melee")) * classCd,
    arc: CONFIG.playerAttackArc + rank(p, "melee.arc") * (22 * Math.PI / 180),
    // Wide Arc is an ENTRY: it changes what the swing TOUCHES (V2 §4.1), so
    // it carries a target cap alongside the arc.
    targetCap: CONFIG.meleeBaseTargets + rank(p, "melee.arc"),
    range: CONFIG.playerAttackRange + (wc === "reach" ? CONFIG.reachRangeBonus : wc === "chaotic" ? 0.25 : 0),
    poiseMult: wc === "heavy" ? CONFIG.heavyPoiseMult : 1,
    // Ragged Edge: crits bleed (shipped poison rules; no new status).
    bleed: rank(p, "melee.bleed"),
  };
}

export function dashParams(p: Player) {
  // THE HEAVY (class revision): mass keeps its own schedule — dash recharges slower.
  const heavy = (p.revisions ?? []).includes("heavy") ? CONFIG.revisionHeavyDashCdMult : 1;
  // V2 §4.3: Quickstep rank 1 is the -18% recharge; rank 2+ is a CHARGE, and a
  // charge is an identity where a second percentage was not.
  const quick = rank(p, "dash.quick");
  return {
    // Rule 7: rank + glyph CDR sum, clamped once at the cap.
    cooldown: clampCooldown(CONFIG.dashCooldown, Math.min(quick, 1) * 0.18 + glyphCdr(p, "dash")) * heavy,
    charges: CONFIG.dashCharges + Math.max(0, quick - 1),
    distance: CONFIG.dashDistance * (1 + rank(p, "dash.blink") * 0.3),
    shockMult: rank(p, "dash.shock") * 0.5 * glyphDamageMult(p, "dash"), // fraction of dash power dealt along the path
    // Long Blink: the long dash is a PLAY, not a retreat — bodies you cross
    // eat a share of Shockstep.
    passFrac: rank(p, "dash.blink") > 0 ? CONFIG.dashBlinkPassFrac : 0,
    veil: rank(p, "dash.veil") > 0,
  };
}

/**
 * Bolt is the weapon's projectile (DESIGN 5.8): what pressing BOLT throws —
 * and which school pays for it — comes from the equipped weapon. Crossbows
 * loose real bolts (attack power, fast, pierce at rare+); wands/staffs cast
 * magic missiles (spell power; wand = faster casts, staff pays out on nova);
 * melee-class weapons fall back to a weak thrown sidearm; bare hands throw a
 * plain 0.8× jab. The Mug throws whatever's strongest, poorly.
 */
export function boltParams(p: Player) {
  const w = p.equipment.weapon;
  const wc = weaponClassOf(w);
  const rareUp = w && (w.rarity === "rare" || w.rarity === "epic");
  const sp = effectiveSpellPower(p);
  const profile =
    wc === "ballistic" ? { dmg: p.attackPower * CONFIG.boltBallisticMult, school: "physical" as School, speedMult: CONFIG.boltBallisticSpeedMult, bonusPierce: rareUp ? 1 : 0, cdMult: 1 }
    : wc === "arcane" ? { dmg: sp * CONFIG.boltArcaneMult, school: "magic" as School, speedMult: 1, bonusPierce: 0, cdMult: /Wand$/.test(w!.name) ? CONFIG.wandBoltCdMult : 1 }
    : wc === "chaotic" ? { dmg: Math.max(p.attackPower, sp) * CONFIG.chaoticBoltMult, school: (sp > p.attackPower ? "magic" : "physical") as School, speedMult: 1.15, bonusPierce: 0, cdMult: 0.95 }
    : wc !== null ? { dmg: p.attackPower * CONFIG.boltSidearmMult, school: "physical" as School, speedMult: 1, bonusPierce: 0, cdMult: 1 } // melee-class sidearm
    : { dmg: p.attackPower * CONFIG.boltDamageMult, school: "physical" as School, speedMult: 1, bonusPierce: 0, cdMult: 1 }; // bare hands
  // ARCANE LENS glyph (rule 5): an explicit socket beats the weapon's default
  // profile — the bolt deals MAGIC and scales off spell power, whatever's held.
  const lens = hasGlyph(p, "bolt", "arcane_lens");
  return {
    count: 1 + rank(p, "bolt.split"),
    // Standing Ovation (chase legendary): +2 pierce on top of tree + weapon.
    pierce: rank(p, "bolt.pierce") + profile.bonusPierce + (hasPassive(p, "skewer") ? CONFIG.skewerBonusPierce : 0),
    // Rule 7: rank + glyph CDR sum additively, one clamp; class cdMult stays identity.
    cooldown: clampCooldown(CONFIG.boltCooldown, rank(p, "bolt.rapid") * 0.15 + glyphCdr(p, "bolt")) * profile.cdMult,
    dmg: (lens ? sp * CONFIG.boltArcaneMult : profile.dmg) * glyphDamageMult(p, "bolt"),
    school: lens ? ("magic" as School) : profile.school,
    speedMult: profile.speedMult,
    // Frost Bolts (5.11): impacts chill by this slow fraction (0 = node untaken).
    chill: Math.min(CONFIG.chillSlowMax, rank(p, "bolt.frost") * CONFIG.chillSlowPerRank),
  };
}

/**
 * COLLAPSE (V2 R1). The cast GATHERS first and detonates second; the buff over
 * shipped Nova is entirely in N, not in per-target damage. Event Horizon moves
 * the GATHER radius (the blast rides along at half), which is what makes the
 * entry a "what does it touch" node instead of a printed number.
 */
export function novaParams(p: Player) {
  // Staff hook: the caster's weapon pays out on the AoE, not the missile.
  const w = p.equipment.weapon;
  const staff = weaponClassOf(w) === "arcane" && /Staff$/.test(w!.name);
  const bang = rank(p, "nova.bang");
  const radius = CONFIG.novaRadius * (1 + bang * 0.125) * (staff ? CONFIG.staffAoeRadiusMult : 1);
  return {
    radius,
    gatherRadius: radius * CONFIG.novaGatherMult * (1 + bang * 0.25),
    cooldown: clampCooldown(CONFIG.novaCooldown, rank(p, "nova.rift") * 0.10 + glyphCdr(p, "nova")),
    damageMult: CONFIG.novaDamageMult * glyphDamageMult(p, "nova"),
    // Crush rewards the SETUP: staggered landings, and a bonus that only pays
    // on bodies the gather actually moved.
    crush: rank(p, "nova.crush"),
    crushBonus: rank(p, "nova.crush") * CONFIG.novaCrushBonusPerRank,
    rift: rank(p, "nova.rift") > 0,
    // SINGULARITY: the answer to toysoldier volleys and boss radial fire.
    singularity: rank(p, "nova.singular") > 0,
  };
}

/**
 * Battle Stance damage multiplier for an attack of the given type. Neutral (1)
 * unless stance is slotted; then matching attacks are boosted and mismatched
 * ones penalized. Discipline rewards settling in (stanceTime past the settle
 * threshold); Flow rewards the beats right after a swap (stanceSwapWindow);
 * PERFECT FORM makes a settled crawler transcend the tradeoff entirely.
 */
export function stanceMult(p: Player, kind: StanceId): number {
  if (!slotted(p, "stance")) return 1;
  const settled = p.stanceTime >= CONFIG.stanceSettleSeconds;
  const match = p.stance === kind || (settled && rank(p, "stance.perfect") > 0);
  if (!match) return CONFIG.stanceWrongMult;
  // V2 §4.3: Honed Edge stopped being "+8% matching damage" (an illegal entry)
  // and became REACH — see stanceCoversAbility. The multiplier itself is the
  // shipped one, so no fork side was silently rebalanced.
  let mult = CONFIG.stanceRightMult;
  if (settled) mult *= 1 + rank(p, "stance.discipline") * 0.1;
  if (p.stanceSwapWindow > 0) mult *= 1 + rank(p, "stance.flow") * 0.15;
  return mult;
}

/**
 * Honed Edge (V2 §4.3): the stance stops being a number on two buttons and
 * becomes a commitment that covers the whole kit. Rank 1 extends the stance
 * multiplier to your ABILITIES of that school; rank 2 to lens-converted ones
 * too. Rank 0 = basic attacks only, exactly as shipped.
 */
export function stanceCoversAbility(p: Player, ability: AbilityId): boolean {
  const edge = rank(p, "stance.edge");
  if (edge < 1) return false;
  if (hasGlyph(p, ability, "arcane_lens") || hasGlyph(p, ability, "ballistic_lens")) return edge >= 2;
  return true;
}

/** The stance kind an ability's damage reads as (melee-type vs ranged-type). */
export function stanceKindOf(ability: AbilityId): StanceId {
  return ABILITY_TAGS_RANGED.includes(ability) ? "ranged" : "melee";
}
const ABILITY_TAGS_RANGED: AbilityId[] = ["bolt", "nova", "cataclysm", "airstrike", "injunction"];

/** Battle Stance's own numbers. The buff abilities are full citizens of the
 * glyph layer (V2 §3.2 rule 6): their swap timer routes through the same rule-7
 * clamp everything else does, so a cooldown-only glyph works here too. */
export function stanceParams(p: Player) {
  return {
    cooldown: clampCooldown(CONFIG.stanceSwapCooldown, glyphCdr(p, "stance")),
    // R4: Discipline USES the strike (it requires being settled); Flow SPAMS
    // it (ungated, 60% power). The gate is what keeps the roster's best fork
    // from being eaten by its own base rework.
    flow: rank(p, "stance.flow") > 0,
    footworkRefund: rank(p, "stance.footwork") * CONFIG.stanceFootworkRefund,
  };
}

/** What a swap pays out right now: 0 = nothing (unsettled, no Flow). */
export function stanceStrikePower(p: Player): number {
  if (!slotted(p, "stance")) return 0;
  if (p.stanceTime >= CONFIG.stanceSettleSeconds) return 1;
  return rank(p, "stance.flow") > 0 ? CONFIG.stanceFlowStrikeMult : 0;
}

/** What the banked Overcharge does when the next attack spends it. */
/** BREAKER (V2 R5): the poise shatter is BASE. Surge no longer prints damage —
 * it changes what the banked hit TOUCHES (§4.1's entry rule). */
export function overchargeParams(p: Player) {
  return {
    cooldown: clampCooldown(CONFIG.overchargeCooldown, glyphCdr(p, "overcharge")),
    mult: CONFIG.overchargeDamageMult,
    extraTargets: rank(p, "overcharge.surge"),
    extraBolts: rank(p, "overcharge.volley"),
    echoFrac: rank(p, "overcharge.echo") * 0.4,
    shatter: true, // SYSTEM SHOCK promoted: the game finally owns an interrupt
    bossPoiseMult: CONFIG.overchargeBossPoiseMult,
    window: rank(p, "overcharge.window") * CONFIG.overchargeWindowBonus,
    chain: rank(p, "overcharge.chain") > 0,
  };
}

export function orbitParams(p: Player) {
  // Perpetual Encore (chase legendary): one more blade, spinning to a faster
  // damage beat — the orbit build's payoff you shop three floors toward.
  const encore = hasPassive(p, "encore");
  const wide = rank(p, "orbit.wide");
  return {
    blades: CONFIG.orbitBladesBase + rank(p, "orbit.blade") + (encore ? 1 : 0),
    radius: CONFIG.orbitRadius,
    damageMult: CONFIG.orbitDamageMult * (1 + rank(p, "orbit.razor") * 0.35) * glyphDamageMult(p, "orbit"),
    spiralRank: wide,
    tickSeconds: CONFIG.orbitTickSeconds * (encore ? CONFIG.encoreOrbitTickMult : 1),
    // THE HURL (V2 R3): the ability's damage moves from the passive to the
    // press. Orbit finally exposes a cooldown, which un-dormants Hair Trigger,
    // Heavyweight Plate and Executioner's Rebate on the roster's #2 source.
    hurlCooldown: clampCooldown(CONFIG.orbitHurlCooldown, glyphCdr(p, "orbit")),
    hurlRange: CONFIG.orbitHurlRange * (1 + wide * CONFIG.orbitHurlWideBonus),
    hurlPassMult: CONFIG.orbitHurlPassMult,
    hurlPierce: rank(p, "orbit.razor") > 0,
    guard: rank(p, "orbit.guard") > 0,
  };
}

/**
 * Where ORBIT's hurled ring is RIGHT NOW, or null if the ring is home.
 *
 * THE ONE SOURCE OF TRUTH for the throw (V2 R3). `orbitHurlT` counts DOWN
 * across two legs -- `[2*travel .. travel]` outbound, then `[travel .. 0]`
 * inbound down the same line -- and this is the only place that arithmetic
 * lives. `updateOrbitHurl` (the damage pass), the 3D host and the 2D host all
 * read it, so the steel a player watches is the steel the sim is swinging.
 * Before this existed the 3D renderer carried a private copy and the 2D host
 * carried none at all: the 2D ring calmly orbited the crawler for the whole
 * ~1.1s the blades were 5.5 tiles downrange, rendering the ability's entire
 * counterplay window ("you spent your bodyguard") as its exact opposite.
 */
export function orbitHurlPoint(p: Player): { x: number; y: number; back: boolean } | null {
  const t = p.orbitHurlT ?? 0;
  if (t <= 0) return null;
  const travel = orbitParams(p).hurlRange / CONFIG.orbitHurlSpeed;
  const dir = p.orbitHurlDir ?? p.facing;
  const outbound = t > travel;
  const along = (outbound ? 2 * travel - t : t) * CONFIG.orbitHurlSpeed;
  return { x: p.pos.x + dir.x * along, y: p.pos.y + dir.y * along, back: !outbound };
}

/**
 * World position of orbit blade `i`. With Corkscrew (orbit.wide) taken, the
 * blade radius oscillates between the inner spiral radius and a rank-scaled
 * outer reach (blades phase-offset so they cover different ranges at once).
 * `angleBack`/`phaseBack` rewind the rotation and spiral by that many radians —
 * the sim's damage tick uses this to test the SWEPT path since the last tick,
 * and renderers call it with no rewind so visuals match hits exactly.
 *
 * HURL BRANCH: while the ring is away the blades are NOT orbiting the crawler
 * -- they are a saw tightened around the travelling point. Every host that
 * draws blades from this function therefore shows the aura LEAVE the body for
 * free. The sim's ambient grind never reaches this branch (`updateOrbit` hands
 * off to `updateOrbitHurl` before its tick), so hit tests are unchanged.
 */
export function orbitBladePos(p: Player, i: number, angleBack = 0, phaseBack = 0): { x: number; y: number } {
  const op = orbitParams(p);
  const offset = (i * Math.PI * 2) / op.blades;
  const hurl = orbitHurlPoint(p);
  if (hurl) {
    const ha = p.orbitAngle * 2.2 - angleBack + offset;
    const hr = CONFIG.orbitHurlHitRadius;
    return { x: hurl.x + Math.cos(ha) * hr, y: hurl.y + Math.sin(ha) * hr };
  }
  const a = p.orbitAngle - angleBack + offset;
  let rad = op.radius;
  if (op.spiralRank > 0) {
    const outer = CONFIG.orbitRadius + CONFIG.orbitSpiralPerRank * op.spiralRank;
    const ph = p.orbitSpiral - phaseBack + offset;
    rad = CONFIG.orbitSpiralInner + (outer - CONFIG.orbitSpiralInner) * 0.5 * (1 - Math.cos(ph));
  }
  return { x: p.pos.x + Math.cos(a) * rad, y: p.pos.y + Math.sin(a) * rad };
}

// ---- Ultimate constellation params (pure; read CONFIG + node ranks) ----

/**
 * SPONSOR BARRAGE (V2 U2). Not six shells scattered once: a 3s DIRECTED
 * channel that walks with your cursor at 70% move speed and no attacking. The
 * crawler who parks it on the necromancer wins; the one who presses it and
 * keeps swinging (today's optimal play) gets nothing. Per-shell damage pays
 * for the shell count (ultAirstrikeDmgMult 2.5 -> 1.7).
 */
export function airstrikeParams(p: Player) {
  const shells = Math.max(1, Math.round(CONFIG.barrageSeconds / CONFIG.barrageInterval))
    + rank(p, "air.payload"); // Bigger Payload is +1 SHELL per rank now
  return {
    shells,
    channel: CONFIG.barrageSeconds,
    interval: CONFIG.barrageSeconds / shells,
    moveMult: CONFIG.barrageMoveMult,
    spread: CONFIG.ultAirstrikeSpread * CONFIG.barrageSpreadMult,
    // Two different JOBS, not two settings of one dial: a band for wave clear,
    // tracking for single target.
    band: rank(p, "air.saturation") * CONFIG.barrageBandWidth,
    track: rank(p, "air.precision") * CONFIG.barrageTrackRadius,
    smoke: rank(p, "air.smoke") > 0,
    dmgMult: CONFIG.ultAirstrikeDmgMult * glyphDamageMult(p, "airstrike"),
    cooldown: clampCooldown(CONFIG.ultAirstrikeCooldown, glyphCdr(p, "airstrike")),
    loyalty: rank(p, "air.loyalty") > 0,
  };
}

/**
 * FAULT LINE (V2 U1). The blast is the opener; the GROUND is the ultimate.
 * Knockback and zone now cooperate — Upheaval hurls them out, and they walk
 * back through the fissure (today Upheaval threw targets clear of Aftermath's
 * echo, a fork anti-synergistic within one ability).
 */
export function cataclysmParams(p: Player) {
  const epi = rank(p, "cata.epicenter");
  const after = rank(p, "cata.aftermath");
  const up = rank(p, "cata.upheaval");
  return {
    radius: CONFIG.ultCataclysmRadius * (1 + epi * CONFIG.ultCataclysmEpicenterRadius),
    knockback: CONFIG.ultCataclysmKnockback * (1 + up * CONFIG.ultCataclysmUpheavalKnock),
    poiseMult: up > 0 ? CONFIG.ultCataclysmUpheavalPoise : 1,
    fissureSeconds: CONFIG.faultLineSeconds + epi * CONFIG.faultLineEpicenterSeconds,
    fissureTickFrac: CONFIG.faultLineTickFrac * (1 + after * CONFIG.faultLineAftermathBonus),
    fissureSlow: CONFIG.faultLineSlow,
    chasm: rank(p, "cata.chasm") > 0,
    dmgMult: CONFIG.ultCataclysmDmgMult * glyphDamageMult(p, "cataclysm"),
    cooldown: clampCooldown(CONFIG.ultCataclysmCooldown, glyphCdr(p, "cataclysm")),
    extinction: rank(p, "cata.extinction") > 0,
  };
}

export function bulletTimeParams(p: Player) {
  return {
    cooldown: clampCooldown(CONFIG.ultBulletTimeCooldown, glyphCdr(p, "bullettime")),
    duration: CONFIG.ultBulletTimeDuration,
    cdTickMult: 1 + rank(p, "bt.adrenaline") * CONFIG.ultBulletTimeAdrenaline,
    critBonus: rank(p, "bt.deadeye") * CONFIG.ultBulletTimeDeadeyeCrit,
    // Deep Focus is REACH now, not duration (V2 §4.3): rank 1 slows enemy
    // shots already in flight, rank 2 hazard ticks and boss phase timers.
    reach: rank(p, "bt.focus"),
    freeDashes: rank(p, "bt.adrenaline") > 0,
    keepBank: rank(p, "bt.deadeye") > 0,
    secondWind: rank(p, "bt.reel") > 0,
    encore: rank(p, "bt.encore") > 0,
  };
}

// ---- Fun-kit wave params (pure; read CONFIG + node ranks) ----

/** BLINDSIDE (V2 R6): the roster's single-target BURST. Base 1.9x, and the
 * arrival strike CRITS a target that is not currently aggroed on you — behind
 * the caster that is ~3.8x a melee swing in one frame (§6.4.7 measures it as a
 * WINDOW against a stationary boss, not as sustained DPS). */
export function cutToParams(p: Player) {
  return {
    range: CONFIG.cutToRange * (1 + rank(p, "cut.range") * 0.15),
    cooldown: clampCooldown(CONFIG.cutToCooldown, glyphCdr(p, "cutto")),
    charges: 1 + rank(p, "cut.encore"), // Second Take: a charge, not a % cut
    dmgMult: CONFIG.cutToDmgMult * (1 + rank(p, "cut.smash") * 0.3) * glyphDamageMult(p, "cutto"),
    smash: rank(p, "cut.smash") > 0, // arrival staggers non-elites
    corpseTarget: rank(p, "cut.range") > 0, // Long Reach: repositioning, too
    brand: rank(p, "cut.mark") > 0, // Continuity
    match: rank(p, "cut.match") > 0,
  };
}

/** EXTRADITION (V2 R7): the chain does something on its own. The base HITS,
 * and CLASS ACTION's spirit lives in the base at half strength (the nearest
 * two light bodies come along); the capstone then upgrades to everything. */
export function crowdSurfParams(p: Player) {
  return {
    range: CONFIG.surfRange * (1 + rank(p, "surf.chain") * 0.2),
    cooldown: clampCooldown(CONFIG.surfCooldown, glyphCdr(p, "crowdsurf")),
    stagger: CONFIG.surfStagger + rank(p, "surf.grip") * CONFIG.surfStaggerPerRank,
    hitFrac: CONFIG.surfBaseHitFrac * glyphDamageMult(p, "crowdsurf"),
    diveFrac: rank(p, "surf.dive") * CONFIG.surfDiveFracPerRank * glyphDamageMult(p, "crowdsurf"),
    drag: CONFIG.surfBaseDrag + rank(p, "surf.chain"), // extra light bodies
    hook: rank(p, "surf.hook") > 0, // Writ of Attachment: hazards are targets
    wave: rank(p, "surf.wave") > 0,
  };
}

/** STUNT DOUBLE (V2 R8): the double has HP, so the ability is honest and its
 * tree is finally a choice (Method survives longer; Pyro dies louder). */
export function stuntDoubleParams(p: Player) {
  const brk = rank(p, "double.break");
  return {
    contract: CONFIG.doubleContract + brk,
    cooldown: clampCooldown(CONFIG.doubleCooldown, glyphCdr(p, "stuntdouble")),
    tauntRadius: CONFIG.doubleTauntRadius * (1 + rank(p, "double.method") * 0.25),
    mirrorFrac: CONFIG.doubleMirrorFrac,
    mirrorsAbilities: rank(p, "double.method") > 0,
    hpFrac: CONFIG.doubleHpFraction * (1 + brk * CONFIG.doubleHpPerBreakRank),
    explodeFrac: CONFIG.doubleExplodeFrac,
    pyro: rank(p, "double.pyro"), // burning ground, radius scaled by absorbed
    cue: rank(p, "double.cue") > 0, // swap places, once per contract
    award: rank(p, "double.award") > 0,
  };
}

// ---- ABILITIES-V2 additions: Bulwark, Stage Cables, Injunction ----

/** BULWARK (N1): 1.5s of mitigation, paid back as a heal. No i-frames — that
 * is dash's job and the two must never be interchangeable. */
export function bulwarkParams(p: Player) {
  const grit = rank(p, "bul.grit");
  return {
    cooldown: clampCooldown(CONFIG.bulwarkCooldown, glyphCdr(p, "bulwark")),
    duration: CONFIG.bulwarkSeconds,
    mitigation: grit > 0 ? CONFIG.bulwarkGritMitigation : CONFIG.bulwarkMitigation,
    healFrac: CONFIG.bulwarkHealFrac * (1 + rank(p, "bul.rally") * 0.1),
    healCap: CONFIG.bulwarkHealCap,
    // The fork is EXCLUSIVE, which is why the kit still reads in one breath
    // (§2.3): Rally's safety and Grit's greed can never both be held.
    rally: rank(p, "bul.rally") > 0,
    gritHits: grit > 0 ? 1 + grit : 0, // hits required before Grit pays out
    allyRadius: rank(p, "bul.dig") > 0
      ? CONFIG.bulwarkAllyRadius + rank(p, "bul.dig") * CONFIG.bulwarkAllyPerRank : 0,
    shove: rank(p, "bul.shove") > 0,
    spite: rank(p, "bul.spite") > 0,
  };
}

/** STAGE CABLES (N2): PIN a line. The cables never MOVE a body — that is what
 * keeps them out of the gather budget (§2.2's two-owner cap, machine-checked
 * in §6.4.8). A pin is control, not a stun: windups still resolve. */
export function cablesParams(p: Player) {
  return {
    cooldown: clampCooldown(CONFIG.cablesCooldown, glyphCdr(p, "cables")),
    length: CONFIG.cablesLength + rank(p, "cab.span") * CONFIG.cablesSpanPerRank,
    width: CONFIG.cablesWidth,
    pin: CONFIG.cablesPinSeconds,
    bossPin: CONFIG.cablesBossPinSeconds,
    fieldSeconds: CONFIG.cablesFieldSeconds,
    fieldSlow: CONFIG.cablesFieldSlow,
    rearms: rank(p, "cab.taut"), // Taut: timing, not duration
    liveFrac: rank(p, "cab.live") * CONFIG.cablesLiveFrac * glyphDamageMult(p, "cables"),
    snap: rank(p, "cab.snap") > 0,
    curtain: rank(p, "cab.curtain") > 0,
  };
}

/**
 * INJUNCTION (N3). The debt is DERIVED from the freeze, never a free knob, so
 * no node and no retune can make the trade profitable: net clock delta is
 * freeze − debt = −(2/3) x freeze at every rank (§6.4.4 asserts it).
 */
export function injunctionParams(p: Player) {
  const crunch = rank(p, "inj.crunch") > 0;
  const recess = rank(p, "inj.recess") > 0;
  const freeze = crunch ? CONFIG.injunctionCrunchFreeze
    : recess ? CONFIG.injunctionRecessFreeze
    : CONFIG.injunctionFreeze;
  return {
    cooldown: clampCooldown(CONFIG.injunctionCooldown, glyphCdr(p, "injunction")),
    freeze,
    debt: freeze * CONFIG.injunctionDebtRatio,
    damageBonus: recess ? 0 : crunch ? CONFIG.injunctionCrunchBonus : CONFIG.injunctionDamageBonus,
    reach: rank(p, "inj.notice"),
    contempt: rank(p, "inj.contempt") > 0,
    dismissed: rank(p, "inj.dismissed") > 0,
  };
}

// ---- Level-up draft ----

export interface UpgradeOffer {
  id: string; // upgrade node id
  ability: AbilityId;
  title: string;
  desc: string;
  nextRank: number;
  /** Lottery offer past the node's printed max — hosts style it as a jackpot. */
  overrank?: boolean;
}

/** The true rank ceiling: printed max plus overrank headroom. */
export function effectiveMaxRank(u: UpgradeDef): number {
  return u.maxRank + (u.over ?? 0);
}

/** True when the node's graph position allows investment: prerequisites taken,
 * and no rank held in a node it forks against (the road not taken is CLOSED). */
export function nodeOpen(p: Player, u: UpgradeDef): boolean {
  if (u.requires && !u.requires.every((id) => rank(p, id) > 0)) return false;
  if (u.excludes && u.excludes.some((id) => rank(p, id) > 0)) return false;
  return true;
}

/** Nodes still below max rank for abilities the player has SLOTTED, respecting
 * the graph: prerequisites gate, exclusive forks lock. Drafts roll from this. */
export function availableUpgrades(p: Player): UpgradeDef[] {
  return UPGRADES.filter((u) => slotted(p, u.ability) && rank(p, u.id) < u.maxRank && nodeOpen(p, u));
}

/** Nodes eligible for the overrank lottery: at printed max, headroom left. */
export function overrankUpgrades(p: Player): UpgradeDef[] {
  return UPGRADES.filter(
    (u) => slotted(p, u.ability) && nodeOpen(p, u) && rank(p, u.id) >= u.maxRank && rank(p, u.id) < effectiveMaxRank(u),
  );
}

/** Odds that a draft on this floor dangles an overrank (deeper = luckier). */
export function overrankChance(floor: number): number {
  return Math.min(CONFIG.overrankChanceMax, CONFIG.overrankChanceBase + floor * CONFIG.overrankChancePerFloor);
}

/**
 * Roll a level-up draft: up to `count` distinct node rank-ups, seeded from the
 * sim's RNG stream so replays reproduce the same offers. At most ONE slot may
 * carry an overrank — a rare, floor-weighted lottery rank past a node's printed
 * max. Missing the roll leaves overranked power on the table; that scarcity is
 * the design (backlog #7).
 */
export function rollUpgradeDraft(rng: Rng, p: Player, count: number, floor = 1): UpgradeOffer[] {
  const offers: UpgradeOffer[] = [];
  const overPool = overrankUpgrades(p);
  if (overPool.length > 0 && chance(rng, overrankChance(floor))) {
    const won = pick(rng, overPool);
    const next = rank(p, won.id) + 1;
    offers.push({ id: won.id, ability: won.ability, title: won.title, desc: won.desc(next), nextRank: next, overrank: true });
  }
  const pool = availableUpgrades(p);
  while (offers.length < count && pool.length > 0) {
    const drawn = pool.splice(nextInt(rng, 0, pool.length - 1), 1)[0];
    const next = rank(p, drawn.id) + 1;
    offers.push({ id: drawn.id, ability: drawn.ability, title: drawn.title, desc: drawn.desc(next), nextRank: next });
  }
  return offers;
}
