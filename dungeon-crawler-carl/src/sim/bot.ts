import { CONFIG } from "./config";
import { dist, normalize } from "./combat";
import {
  buyCatalogItem, chooseReward, chooseUpgrade, dismantleItem, refitCost, refitItem,
  setReady, setUltimate, slotAbility, socketGlyph, unsocketGlyph, step,
} from "./game";
import { glyphSocketCount, glyphMatches, hasGlyph, socketLegal, type GlyphId } from "./glyphs";
import { weaponClassOf } from "./items";
import {
  ABILITY_INFO, ABILITY_SLOTS, SCALING, boltParams, crowdSurfParams, cutToParams,
  effectiveSpellPower, orbitParams, rank, upgradeDef,
  type AbilityId, type AbilityRole, type School, type UpgradeOffer,
} from "./abilities";
import { Tile, type GameState, type Intent, type Monster, type Player, type Reward, type Vec2 } from "./types";

// Scripted balance bot: a deterministic policy over public sim state that plays
// the game the way a cautious-but-competent crawler would. It exists so balance
// is MEASURED, not vibed:
//   - test/balance.test.ts asserts playability invariants (floors 1-2 clearable
//     before collapse, the dungeon still bites) across fixed seeds, so tuning
//     changes fail loudly instead of shipping a wall or a cakewalk;
//   - runBot() emits per-floor metrics for tuning sweeps;
//   - the policy is the scripted-agent half of the future RL env / MP load tests.
//
// Everything here is pure over (state, memory) — no randomness, no wall clock —
// so runs are exactly reproducible per seed.

/** How the bot plays. Tune these to model different skill levels. */
export interface BotProfile {
  flaskAt: number; // drink when hp falls below this fraction of maxHp
  engageRange: number; // fight monsters within this range of the current path
  dodgeBuffer: number; // extra tiles of respect around a winding-up attacker
}

export const COMPETENT: BotProfile = { flaskAt: 0.4, engageRange: 6, dodgeBuffer: 0.6 };

// ---- THE BUILD (ABILITIES-V2 pillar 1) ----
// The bot is the balance INSTRUMENT, and a roster it cannot equip is a roster
// the contract cannot measure. Before this landed it never called slotAbility
// once in its life: three starting abilities fill slots 0-2, the first tome
// fills slot 3, and every ability discovered after that sat on the bench until
// the run ended. A 100-seed sweep showed it exactly — melee/dash/bolt in 100%
// of final loadouts, every other ability in under 15% — so "Bulwark is
// balanced" was a claim about an ability the measurement never pressed.
//
// So the bot commits to a BUILD. It reads the crawler it actually rolled (which
// school its gear pays, what it has discovered), slots the four actives and the
// ultimate that serve that crawler, then spends every draft rank and every
// glyph on the same two trees. Recomputed each safe room because gear moves,
// but stable by construction: same inputs, same build, and a slot only changes
// when the ability replacing it genuinely scores higher.

export interface Identity {
  school: School;
  actives: AbilityId[]; // desired slot contents, best first
  ultimate: AbilityId | null;
  primary: AbilityId; // the tree drafts and glyphs feed first
  secondary: AbilityId | null;
}

/** Everything this crawler could slot: the loadout plus the bench. */
function knownAbilities(p: Player): AbilityId[] {
  const out: AbilityId[] = [];
  for (const a of p.abilities.slots) if (a) out.push(a);
  if (p.abilities.ultimate) out.push(p.abilities.ultimate);
  for (const a of p.abilities.bench) out.push(a);
  return out;
}

/**
 * 0..1: how well an ability's damage rides the stat this crawler actually has.
 * An ap:1 kit on a spell-power crawler is a rounding error (V2 §1.2) and the
 * reverse is just as true, so the bot slots by SCALING — the same table the sim
 * charges the damage through — rather than a second opinion that can drift.
 */
function schoolFit(p: Player, a: AbilityId): number {
  const sp = effectiveSpellPower(p);
  const best = Math.max(1, p.attackPower, sp);
  // Bolt is the deliberate absentee from SCALING: its school comes from the
  // equipped WEAPON, so ask boltParams what pressing it would actually throw.
  if (a === "bolt") return Math.min(1, boltParams(p).dmg / best);
  const s = SCALING[a] ?? { ap: 1 };
  return Math.min(1, (p.attackPower * (s.ap ?? 0) + sp * (s.sp ?? 0)) / best);
}

/** Abilities whose value is their EFFECT, not their damage. The school term
 * must not touch these, or a spell-power crawler stops bracing. */
const SCHOOL_BLIND: AbilityId[] = ["stance", "overcharge", "bulwark", "stuntdouble", "bullettime", "injunction"];

/** What each ability is worth to the POLICY below — how much work the bot can
 * actually get out of it, not a design tier list. */
const ABILITY_BASE: Record<AbilityId, number> = {
  melee: 62, dash: 58, bolt: 44, nova: 50, orbit: 46, stance: 30,
  overcharge: 38, cutto: 46, crowdsurf: 36, stuntdouble: 34, bulwark: 42, cables: 34,
  airstrike: 58, cataclysm: 68, bullettime: 62, injunction: 30,
};

/**
 * A deterministic per-RUN TASTE, 0..botTasteSpread. This crawler always likes
 * the same tools; a different seed likes different ones.
 *
 * It exists because a bot is only an instrument if it covers the shelf. Ranked
 * on value alone, every one of 100 seeds converged on the same three or four
 * abilities and NEVER slotted Battle Stance, Stage Cables or Extradition —
 * which is the unfalsifiable state this whole policy exists to end, just moved
 * from "cannot equip it" to "would never pick it". The spread is small enough
 * that melee and dash still anchor almost every build, and large enough that
 * the bottom of the roster gets played and measured.
 *
 * Seeded off state, not randomness: a given seed always plays the same build.
 */
function tasteBonus(seed: number, a: AbilityId): number {
  let h = seed >>> 0;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a.charCodeAt(i), 0x01000193) >>> 0;
  return ((h % 1024) / 1024) * CONFIG.botTasteSpread;
}

function abilityValue(state: GameState, p: Player, a: AbilityId): number {
  // An ultimate about the RUN CLOCK is worth nothing in a mode with no clock.
  if (a === "injunction" && state.runKind === "roam") return 0;
  const base = ABILITY_BASE[a];
  const fitted = SCHOOL_BLIND.includes(a) ? base : base * (0.55 + 0.45 * schoolFit(p, a));
  return fitted + tasteBonus(state.seed, a);
}

/** The build this crawler should be playing right now. Pure and total-ordered
 * (ties break on id) so the same run always produces the same build. */
export function identityOf(state: GameState, p: Player): Identity {
  const seen = new Set<AbilityId>();
  const actives: AbilityId[] = [];
  const ults: AbilityId[] = [];
  for (const a of knownAbilities(p)) {
    if (seen.has(a)) continue;
    seen.add(a);
    (ABILITY_INFO[a].tier === "ultimate" ? ults : actives).push(a);
  }
  const byValue = (x: AbilityId, y: AbilityId) => {
    const d = abilityValue(state, p, y) - abilityValue(state, p, x);
    return d !== 0 ? d : x < y ? -1 : x > y ? 1 : 0;
  };
  actives.sort(byValue);
  ults.sort(byValue);
  const chosen = actives.slice(0, ABILITY_SLOTS);
  // Dash is excluded from CARRYING the build: it is the dodge button, and a
  // crawler whose identity is "I move" has not built anything.
  const carries = chosen.filter((a) => a !== "dash");
  const ult = ults.find((a) => abilityValue(state, p, a) > 0) ?? null;
  return {
    school: effectiveSpellPower(p) > p.attackPower ? "magic" : "physical",
    actives: chosen,
    ultimate: ult,
    primary: carries[0] ?? chosen[0] ?? "melee",
    secondary: carries[1] ?? null,
  };
}

/** Re-slot into the identity's build. Safe-room gated by the sim (slotAbility /
 * setUltimate no-op elsewhere), and deliberately low-churn: an ability already
 * sitting in a slot that belongs in the build STAYS there, because sockets
 * belong to the SLOT and shuffling them costs the whole glyph board. */
function chooseLoadout(state: GameState, playerId: number, id: Identity): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p) return;
  if (id.ultimate && p.abilities.ultimate !== id.ultimate) setUltimate(state, playerId, id.ultimate);
  const keep = p.abilities.slots.map((a) => (a && id.actives.includes(a) ? a : null));
  const missing = id.actives.filter((a) => !keep.includes(a));
  for (let i = 0; i < ABILITY_SLOTS && missing.length > 0; i++) {
    if (keep[i]) continue;
    slotAbility(state, playerId, i, missing.shift()!);
  }
}

// ---- THE CAST POLICY (ABILITIES-V2 §6.2) ----
// The policy is a TABLE KEYED BY ROLE, not a pile of per-ability branches, so
// adding an ability adds a row rather than a special case. Where a specific
// ability's VERB changes the right decision — a channel you cannot swing
// through, a line that only pays if bodies cross it, an ultimate that buys
// clock at 5:3 — the role case says so in one line with the reason next to it.
// Anything with no specific opinion is still pressed opportunistically (rule
// 6), which is what stops a newly shipped ability being silently dead weight.

/** What the bot can see about the current moment, computed once per step. */
interface Situation {
  threat: Monster | null;
  dist: number; // to the threat
  nearby: number; // living monsters within 5 tiles
  packed8: number; // living monsters within 8 tiles
  cluster: number; // biggest knot of bodies inside ultimate reach
  clusterAt: Vec2 | null; // and where it is — the point an ultimate is FOR
  heavyWindup: Monster | null; // a brute/boss/charger telegraph in reach
  support: Monster | null; // a shaman/necro/hexer/drummer/cleric behind the pack
  big: Monster | null; // a boss or elite in reach: the OCCASION
  incoming: number; // enemy shots on a collision course with us
  hpFrac: number;
  losing: boolean; // the collapse clock is running out
  barraging: boolean; // a Sponsor Barrage channel is live
}

/** Kill-the-support-first puzzles the AI roster is full of and the bot ignored. */
const SUPPORT_KINDS: Monster["kind"][] = [
  "shaman", "necromancer", "hexer", "drummer", "cleric", "broodmother", "darling", "archivist",
];

/** Abilities that land ON or NEXT TO the caster — the ones Point Blank's bonus
 * half actually reads, and the ones Longshot's penalty half would eat. */
const CLOSE_RANGE_ABILITIES: AbilityId[] = ["melee", "orbit", "cutto", "nova", "cables", "crowdsurf"];

/** True when this monster's telegraph is worth answering rather than walking away from. */
function isHeavyWindup(m: Monster, p: Player): boolean {
  return m.windup > 0 && (m.kind === "boss" || m.windupKind === "fuse" || m.windupKind === "slam"
    || m.windupKind === "ritual" || m.windupKind === "vent" || m.windupKind === "charge"
    || m.damage >= p.maxHp * 0.12);
}

/** The densest knot of bodies within ultimate reach, and how many are in it.
 * An ultimate spent on "an enemy somewhere" is the on-cooldown spam §6.2 rules
 * out; this is what "an occasion" means in numbers. */
function bestCluster(state: GameState, p: Player): { at: Vec2 | null; count: number } {
  let at: Vec2 | null = null;
  let count = 0;
  for (const m of state.monsters) {
    if (m.hp <= 0 || dist(p.pos, m.pos) > CONFIG.ultAirstrikeRange) continue;
    let n = 0;
    for (const o of state.monsters) {
      if (o.hp > 0 && dist(m.pos, o.pos) <= 3) n++;
    }
    // Strictly-greater keeps the FIRST knot on a tie: monsters are walked in
    // creation order, so the pick is deterministic and stable while it holds.
    if (n > count) { count = n; at = m.pos; }
  }
  return { at, count };
}

/** Enemy shots that will pass through us inside the next second. */
function incomingShots(state: GameState, p: Player): number {
  let n = 0;
  for (const pr of state.projectiles) {
    if (pr.from !== "enemy") continue;
    const speed = Math.hypot(pr.vel.x, pr.vel.y);
    if (speed < 1e-3) continue;
    const rel = { x: p.pos.x - pr.pos.x, y: p.pos.y - pr.pos.y };
    const closing = (rel.x * pr.vel.x + rel.y * pr.vel.y) / speed;
    if (closing < 0) continue;
    const t = closing / speed;
    if (t > 1) continue;
    const cx = pr.pos.x + pr.vel.x * t - p.pos.x;
    const cy = pr.pos.y + pr.vel.y * t - p.pos.y;
    if (Math.hypot(cx, cy) <= 1.2) n++;
  }
  return n;
}

function buildSituation(state: GameState, p: Player, threat: Monster | null, d: number): Situation {
  let nearby = 0;
  let packed8 = 0;
  let support: Monster | null = null;
  let heavyWindup: Monster | null = null;
  let big: Monster | null = null;
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    const md = dist(p.pos, m.pos);
    if (md <= 5) nearby++;
    if (md <= 8) {
      packed8++;
      if (!support && SUPPORT_KINDS.includes(m.kind)) support = m;
      if (!big && (m.kind === "boss" || m.elite)) big = m;
      if (!heavyWindup && isHeavyWindup(m, p) && md <= m.attackRange + 2.5) heavyWindup = m;
    }
  }
  const knot = bestCluster(state, p);
  return {
    threat, dist: d, nearby, packed8, heavyWindup, support, big,
    cluster: knot.count, clusterAt: knot.at,
    incoming: incomingShots(state, p),
    hpFrac: p.maxHp > 0 ? p.hp / p.maxHp : 1,
    losing: state.timeRemaining < 45,
    barraging: (p.barrageT ?? 0) > 0,
  };
}

/**
 * Should the bot press the ability in this slot right now? One case per ROLE.
 * Returning false never means "never" — rule 6's opportunistic fallback lives
 * in the caller, so an ability with no opinion is still measured.
 */
function wantsCast(state: GameState, p: Player, ability: AbilityId, s: Situation): boolean {
  // Charge abilities carry their own budget; the rest are cooldown-gated.
  if (ability === "cutto") {
    if ((p.cutCharges ?? cutToParams(p).charges) <= 0) return false;
  } else if (ability !== "dash" && (p.cd[ability] ?? 0) > 0) return false;
  // BLOOD PRICE (glyph): every cast costs max HP. A bot that ignores its own
  // firmware kills itself proving the stone is strong — so under a third HP
  // only the ability that HEALS is still worth its price.
  if (s.hpFrac < 0.3 && hasGlyph(p, ability, "blood_price") && ABILITY_INFO[ability].role !== "sustain") return false;
  const role: AbilityRole = ABILITY_INFO[ability].role;
  switch (role) {
    case "sustain":
      // (1) BRACE INTO the heavy telegraph instead of retreating from it. This
      // is what Bulwark is FOR, and it is measurable: damage-taken should drop.
      // The second clause is the other half of its job — the heal is a floor
      // under a pack fight, not only an answer to one big swing.
      if ((p.bulwarkT ?? 0) > 0) return false; // already braced
      return (s.heavyWindup !== null && s.dist < 4) || (s.hpFrac < 0.55 && s.nearby >= 2);
    case "control":
      // (2) Interrupt the windup. The bot used to back away from every heavy
      // telegraph, which is exactly why the roster's control gap never showed
      // up in the numbers. Cables want the LANE — a line only pays if bodies
      // cross it, so either the pack is thick or the heavy thing has not
      // arrived yet (pin it at range, never on our own feet). Breaker wants the
      // bank ready, and re-banking a bank it holds is a wasted press.
      if (ability === "cables") return s.packed8 >= 3 || (s.heavyWindup !== null && s.dist > 2.5);
      if (p.overcharged) return false;
      return s.heavyWindup !== null || s.nearby >= 2;
    case "clear":
      // (3) GATHER BEFORE AoE. §6.2.3 says "never at fewer than 2"; the
      // measured gather contract (§6.4.2, mean >= 2.5 caught) is what settles
      // the actual number at 3 — a cast into a thin crowd is the same wasted
      // press §1.0b measured, no matter how wide the pull reaches.
      if (ability === "nova") {
        // SINGULARITY (capstone) makes the collapse eat enemy shots, so a
        // volley in the air becomes its own reason to cast. The NODE changes
        // the right decision, which the instrument has to know or the capstone
        // measures as a damage node that got worse.
        if (rank(p, "nova.singular") > 0 && s.incoming >= 2) return true;
        return s.nearby >= 3;
      }
      // Orbit's hurl is a LINE out and back (R3): it wants a body inside the
      // throw, not merely an enemy somewhere on the floor.
      return s.threat !== null && s.dist <= orbitParams(p).hurlRange;
    case "burst":
      // (4) Close on the support kinds with the burst tool, not by walking.
      // Blindside is a TELEPORT INTO the room, though: diving a pack on fumes
      // is how a burst tool becomes a suicide button.
      if (s.hpFrac < 0.35 && s.nearby >= 2) return false;
      return (s.support !== null && s.dist > 2)
        || (s.threat !== null && s.dist > 2 && s.dist < cutToParams(p).range);
    case "mobility":
      if (ability === "crowdsurf") return s.support !== null || (s.threat !== null && s.dist > 3);
      // SLIPSTREAM / PHASE ETCH turn the dodge button into an OPENER: both pay
      // on the movement RESOLVING, so with either socketed a dash into the pack
      // is damage and a speed window instead of a spent charge. One charge is
      // always held back for the dodge policy above.
      if ((hasGlyph(p, "dash", "slipstream") || hasGlyph(p, "dash", "phase_etch"))
        && p.dashCharges > 1 && s.threat !== null && s.dist > 2 && s.dist < 6) return true;
      return false; // dash otherwise keeps its own dodge policy
    case "summon":
      // The double is a body that soaks — it wants a fight to soak in.
      return s.nearby >= 3 || (s.hpFrac < 0.5 && s.nearby >= 1);
    case "beat":
      // Battle Stance: swap only when SETTLED, so the free strike actually
      // pays (R4) and Discipline is not thrown away for a 3s metronome.
      if (ability === "stance") return p.stanceTime >= 5.5 && s.threat !== null;
      return s.threat !== null;
    case "zone":
    case "ultimate": {
      // (5) Spend the ultimate on an OCCASION — a named body, or a knot worth
      // changing the room over. "Off cooldown with something alive nearby" is
      // the spam the design rules out, and it also makes every ultimate
      // constellation node measure the same.
      if (!(s.big !== null || s.cluster >= 4 || s.packed8 >= 5)) return false;
      if (ability === "injunction") {
        // It BUYS clock at 5:3 and ENRAGES the whole floor for the duration
        // (N3). Worth twelve seconds only for a real fight, only with the HP to
        // survive an enraged room, and never when the clock is already lost —
        // the debt lands after the window, on a floor that cannot pay it.
        if (state.runKind === "roam" || s.losing) return false;
        return s.hpFrac > 0.55 && (s.big !== null || s.cluster >= 5);
      }
      if (ability === "airstrike") {
        // A 3s CHANNEL at 70% move speed with no attacking (U2). Pressing it
        // with a slam already in the air is how a crawler dies holding a
        // fire-control handset.
        return s.hpFrac > 0.5 && s.heavyWindup === null && (s.big !== null || s.cluster >= 4);
      }
      return true;
    }
  }
}


/** Path cache + counters the policy carries between steps (deterministic). */
export interface BotMemory {
  path: Vec2[];
  targetKey: string;
  repathIn: number;
  // Wedge escape: greedy movement can hook on geometry (walls between the bot
  // and a visible-looking target, corner clips). When we ask to move and go
  // nowhere for ~0.75s, drop the grudge and sidestep out.
  lastPos: Vec2 | null;
  triedMove: boolean;
  stuckSteps: number;
  fightId: number | null;
  avoid: Record<number, number>; // monster id -> steps left to ignore it
  sidestep: number; // steps remaining of perpendicular escape
  sidestepDir: 1 | -1;
}

export function freshMemory(): BotMemory {
  return {
    path: [], targetKey: "", repathIn: 0,
    lastPos: null, triedMove: false, stuckSteps: 0,
    fightId: null, avoid: {}, sidestep: 0, sidestepDir: 1,
  };
}

const walkableTile = (state: GameState, x: number, y: number): boolean => {
  const { map } = state;
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
  const t = map.tiles[y * map.w + x];
  return t === Tile.Floor || t === Tile.StairsDown;
};

/** BFS over tile centers from `from` to `to`. Returns waypoints (may be empty). */
function findPath(state: GameState, from: Vec2, to: Vec2): Vec2[] {
  const { map } = state;
  const sx = Math.floor(from.x), sy = Math.floor(from.y);
  const tx = Math.floor(to.x), ty = Math.floor(to.y);
  if (sx === tx && sy === ty) return [];
  const prev = new Int32Array(map.w * map.h).fill(-1);
  const start = sy * map.w + sx;
  const goal = ty * map.w + tx;
  prev[start] = start;
  const queue = [start];
  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    if (i === goal) break;
    const x = i % map.w, y = (i / map.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (!walkableTile(state, nx, ny)) continue;
      const ni = ny * map.w + nx;
      if (prev[ni] !== -1) continue;
      prev[ni] = i;
      queue.push(ni);
    }
  }
  if (prev[goal] === -1) return []; // unreachable (e.g. behind locked doors)
  const path: Vec2[] = [];
  for (let i = goal; i !== start; i = prev[i]) {
    path.push({ x: (i % map.w) + 0.5, y: ((i / map.w) | 0) + 0.5 });
  }
  path.reverse();
  return path;
}

/** The floor's current objective: key stuff while locked, boss while sealed, else stairs. */
function objective(state: GameState): { key: string; pos: Vec2 } {
  if (state.map.locked) {
    const key = state.loot.find((l) => l.kind === "key");
    if (key) return { key: `key${key.id}`, pos: key.pos };
    const carrier = state.monsters.find((m) => m.hasKey);
    if (carrier) return { key: `carrier${carrier.id}`, pos: carrier.pos };
  }
  const boss = state.monsters.find((m) => m.kind === "boss");
  if (boss) return { key: `boss${boss.id}`, pos: boss.pos };
  return { key: "stairs", pos: state.map.stairs };
}

/** Straight-line visibility between two points (sampled every quarter tile).
 * Without this the bot deadlocks fighting monsters through walls. */
function hasLos(state: GameState, a: Vec2, b: Vec2): boolean {
  const d = dist(a, b);
  const steps = Math.max(1, Math.ceil(d * 4));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!walkableTile(state, Math.floor(x), Math.floor(y))) return false;
  }
  return true;
}

/** Nearest living, VISIBLE, non-blacklisted monster to `pos` within `range`.
 * The blacklist exists for unreachable-through-walls targets — a monster in
 * arm's reach is ALWAYS a valid target, or a faster chaser (elite swarmers
 * outrun the player) nibbles an "ignoring" bot to death. */
function nearestThreat(state: GameState, pos: Vec2, range: number, avoid: Record<number, number>): Monster | null {
  let best: Monster | null = null;
  let bestD = range;
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    const d = dist(pos, m.pos);
    if (avoid[m.id] && d > 2) continue; // blacklist never applies point-blank
    if (d < bestD && hasLos(state, pos, m.pos)) { bestD = d; best = m; }
  }
  return best;
}

/**
 * One step of policy: what a cautious, aggressive crawler does right now.
 * Priorities: don't stand in heavy telegraphs > drink when low > fight what's
 * close > follow the path to the floor objective > take the stairs. A wedge
 * detector blacklists unreachable targets and sidesteps off geometry.
 */
export function botIntent(state: GameState, mem: BotMemory): Intent {
  const p = state.players[0];
  if (!p.alive) return { move: { x: 0, y: 0 }, useStairs: false };

  // Wedge bookkeeping: we asked to move last step and went nowhere.
  if (mem.lastPos && mem.triedMove && dist(p.pos, mem.lastPos) < 0.02) mem.stuckSteps++;
  else mem.stuckSteps = 0;
  mem.lastPos = { x: p.pos.x, y: p.pos.y };
  for (const id of Object.keys(mem.avoid)) {
    if (--mem.avoid[+id] <= 0) delete mem.avoid[+id];
  }
  if (mem.stuckSteps > 45) {
    if (mem.fightId !== null) mem.avoid[mem.fightId] = 600; // that one's a wall
    mem.fightId = null;
    mem.path = [];
    mem.repathIn = 0;
    mem.stuckSteps = 0;
    mem.sidestep = 20;
    mem.sidestepDir = mem.sidestepDir === 1 ? -1 : 1; // alternate escape sides
  }

  const intent = decide(state, mem, p);
  // Perpendicular escape overrides the intended heading briefly.
  if (mem.sidestep > 0 && (intent.move.x !== 0 || intent.move.y !== 0)) {
    const m = intent.move;
    intent.move = { x: -m.y * mem.sidestepDir, y: m.x * mem.sidestepDir };
    mem.sidestep--;
  }
  mem.triedMove = intent.move.x !== 0 || intent.move.y !== 0;
  return intent;
}

/**
 * Fill `intent.cast` from the role table. Slots the policy has no opinion on
 * are still pressed opportunistically at a valid target (§6.2 rule 6) so a
 * newly shipped ability can never be silently dead weight in a measurement —
 * the sim no-ops anything on cooldown, so being greedy here is free.
 */
function applyCastPolicy(state: GameState, p: Player, intent: Intent, s: Situation): void {
  const cast = [false, false, false, false, false];
  for (let i = 0; i < ABILITY_SLOTS; i++) {
    const ability = p.abilities.slots[i];
    if (!ability) continue;
    // Every ROLE has an opinion and none of them is "never" — that is what
    // makes rule 6 hold without a per-ability escape hatch. The strict cases
    // stay strict: Collapse genuinely refuses to fire into fewer than three.
    cast[i] = wantsCast(state, p, ability, s);
  }
  if (p.abilities.ultimate) cast[ABILITY_SLOTS] = wantsCast(state, p, p.abilities.ultimate, s);
  intent.cast = cast;
}

/** Is there a tool in the kit that can reach the SUPPORT right now? Only then
 * is it worth spending the step's one aim on a body six tiles away. */
function reachesSupport(p: Player, support: Monster): boolean {
  const d = dist(p.pos, support.pos);
  for (const a of p.abilities.slots) {
    if (a === "cutto" && (p.cutCharges ?? cutToParams(p).charges) > 0 && d <= cutToParams(p).range) return true;
    if (a === "crowdsurf" && (p.cd.crowdsurf ?? 0) <= 0 && d <= crowdSurfParams(p).range) return true;
  }
  return false;
}

function decide(state: GameState, mem: BotMemory, p: GameState["players"][number]): Intent {
  const intent: Intent = { move: { x: 0, y: 0 }, useStairs: false };
  mem.fightId = null;

  // Sponsor Slurp below the comfort line.
  if (p.hp < p.maxHp * COMPETENT.flaskAt && p.flaskCharges > 0) intent.flask = true;

  // THE BARRAGE IS A CHANNEL (V2 U2): shells drop wherever the cursor is on
  // every step of the 3s window, including the frames this policy spends
  // dodging. Aim is therefore set up front and left alone — a barrage that
  // walks off the pack because the bot sidestepped a bolt is the ultimate
  // measuring as a dud.
  if ((p.barrageT ?? 0) > 0) {
    const knot = bestCluster(state, p);
    if (knot.at) intent.aim = { x: knot.at.x - p.pos.x, y: knot.at.y - p.pos.y };
  }

  // Dodge incoming enemy projectiles: if one's closest approach passes within
  // grazing range in the next half second, sidestep perpendicular to it.
  for (const pr of state.projectiles) {
    if (pr.from !== "enemy") continue;
    const speed = Math.hypot(pr.vel.x, pr.vel.y);
    if (speed < 1e-3) continue;
    const rel = { x: p.pos.x - pr.pos.x, y: p.pos.y - pr.pos.y };
    const closing = (rel.x * pr.vel.x + rel.y * pr.vel.y) / speed;
    if (closing < 0) continue; // already past us
    const t = closing / speed;
    if (t > 0.55) continue; // not imminent
    const cx = pr.pos.x + pr.vel.x * t - p.pos.x;
    const cy = pr.pos.y + pr.vel.y * t - p.pos.y;
    if (Math.hypot(cx, cy) > 0.9) continue; // misses anyway
    // Step to whichever side of the projectile's line we're already on.
    const side = rel.x * pr.vel.y - rel.y * pr.vel.x >= 0 ? 1 : -1;
    intent.move = normalize({ x: (pr.vel.y / speed) * side, y: (-pr.vel.x / speed) * side });
    return intent;
  }

  // Step out of LIVE damaging pools (spitter acid, boss sludge): those tick
  // repeatedly, so standing in one is strictly bad. One-shot telegraph
  // circles are NOT dodged here — the bot's constant strafing already beats
  // most of them, and measured runs show fleeing every ring gets it swarmed
  // on dense tempo floors (kiting through a pack costs more than the blast).
  let inHazard: GameState["hazards"][number] | null = null;
  let inHazardD = Infinity;
  for (const hz of state.hazards) {
    const ticking =
      (hz.kind === "puddle" && hz.damage > 0) ||
      (hz.kind === "sludge" && hz.total - hz.t >= (hz.arm ?? 0)); // live, not arming
    if (!ticking) continue;
    const d = dist(p.pos, hz.pos);
    if (d > hz.radius + 0.35) continue;
    if (d < inHazardD) { inHazardD = d; inHazard = hz; }
  }
  if (inHazard) {
    intent.move = inHazardD > 1e-3
      ? normalize({ x: p.pos.x - inHazard.pos.x, y: p.pos.y - inHazard.pos.y })
      : { x: 1, y: 0 }; // dead center: any exit beats no exit
    // Keep swinging on the way out — retreating with the sword down is how a
    // pack turns one puddle into a rout.
    for (const m of state.monsters) {
      if (m.hp <= 0) continue;
      if (dist(p.pos, m.pos) > CONFIG.playerAttackRange) continue;
      intent.attack = true;
      if ((p.barrageT ?? 0) <= 0) intent.aim = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y };
      break;
    }
    return intent;
  }

  // Respect HEAVY telegraphs (boss slams always; otherwise a hit worth >= ~12%
  // of max HP, or a bomber fuse): back away, dashing through the strike frame
  // if it's about to land. Chaff windups are traded through — retreating from
  // everything lets a pack of swarmers perma-kite the bot off the floor.
  // BULWARK is the exception the ability exists for: with a brace ready, the
  // right answer is to stand IN it and get paid, so the retreat is skipped and
  // the cast policy below presses the brace instead.
  const braceReady = p.abilities.slots.includes("bulwark") && (p.cd.bulwark ?? 0) <= 0
    && (p.bulwarkT ?? 0) <= 0;
  for (const m of state.monsters) {
    if (m.hp <= 0 || m.windup <= 0) continue;
    const heavy = m.kind === "boss" || m.windupKind === "fuse" || m.damage >= p.maxHp * 0.12;
    if (!heavy) continue;
    const reach =
      (m.windupKind === "fuse" ? CONFIG.bomberExplodeRadius : m.attackRange + CONFIG.monsterStrikeGrace) +
      COMPETENT.dodgeBuffer;
    const d = dist(p.pos, m.pos);
    if (d > reach) continue;
    // A fuse is a bomb, not a swing: bracing a detonation is still a bad trade.
    // The distance gate has to match isHeavyWindup's, or the bot skips the
    // retreat for a telegraph the cast policy will not see and eats it standing
    // still — worse than either answer.
    if (braceReady && m.windupKind !== "fuse" && d <= m.attackRange + 2.5) break;
    const away = normalize({ x: p.pos.x - m.pos.x, y: p.pos.y - m.pos.y });
    intent.move = away;
    if (m.windup < 0.18 && p.dashCharges > 0) intent.dash = true; // through the strike frame
    return intent;
  }

  // Fight whatever is close: melee in arm's reach, bolt at range while closing.
  const threat = nearestThreat(state, p.pos, COMPETENT.engageRange, mem.avoid);
  if (threat) {
    mem.fightId = threat.id;
    const d = dist(p.pos, threat.pos);
    const s = buildSituation(state, p, threat, d);
    const inMelee = d <= CONFIG.playerAttackRange * 0.95;
    // ONE aim serves every cast in the step, so choosing it is a real decision.
    // The swing never loses it — an arc pointed at a caster six tiles away
    // misses the body in your face — but otherwise the reach tools get to pick
    // the support they exist to answer, which is the whole kill-the-shaman
    // puzzle the roster is built around.
    const aimAt = s.barraging ? (s.clusterAt ?? threat.pos)
      : !inMelee && s.support && reachesSupport(p, s.support) ? s.support.pos
      : threat.pos;
    intent.aim = { x: aimAt.x - p.pos.x, y: aimAt.y - p.pos.y };
    applyCastPolicy(state, p, intent, s);
    if (s.barraging) {
      // Directing the barrage costs the feet AND the sword: give ground rather
      // than stand in the pack holding a handset you cannot swing.
      intent.move = d < 4
        ? normalize({ x: p.pos.x - threat.pos.x, y: p.pos.y - threat.pos.y })
        : { x: 0, y: 0 };
      return intent;
    }
    if (inMelee) {
      intent.attack = true;
    } else {
      intent.move = normalize({ x: threat.pos.x - p.pos.x, y: threat.pos.y - p.pos.y });
      if (d > 2) intent.bolt = true; // soften it on the way in
    }
    return intent;
  }

  // No fight: follow the path to the floor objective (repath periodically and
  // whenever the objective changes — key drops, doors open, boss dies).
  const obj = objective(state);
  if (dist(p.pos, state.map.stairs) <= 0.9 && obj.key === "stairs") {
    intent.useStairs = true;
    return intent;
  }
  mem.repathIn--;
  if (obj.key !== mem.targetKey || mem.repathIn <= 0 || mem.path.length === 0) {
    mem.targetKey = obj.key;
    mem.path = findPath(state, p.pos, obj.pos);
    mem.repathIn = 30; // recompute every half second of sim time
  }
  while (mem.path.length > 0 && dist(p.pos, mem.path[0]) < 0.45) mem.path.shift();
  const waypoint = mem.path[0] ?? obj.pos;
  intent.move = normalize({ x: waypoint.x - p.pos.x, y: waypoint.y - p.pos.y });
  return intent;
}

export interface FloorMetrics {
  floor: number;
  cleared: boolean; // reached the safe room / won
  simSeconds: number; // sim time spent on the floor
  timeRemaining: number; // collapse budget left when it cleared (can be < 0)
  damageTaken: number;
  kills: number;
}

/** One boss/elite fight, measured from ringside introduction to the kill. */
export interface EncounterMetric {
  floor: number;
  kind: "boss" | "elite";
  name: string;
  maxHp: number;
  ttk: number; // sim seconds from introduction to death (intro freeze excluded)
  playerLevel: number;
  playerDamage: number; // effective baseDamage when the fight started
  hpLost: number; // player HP lost across the fight
}

// ---- THE CONSTELLATION (ABILITIES-V2 §4.1) ----
// Taking the first offer is not a build, it is a coin — and a coin flipped at
// every fork means the sweep was measuring the average of both sides of every
// tree in the game rather than any build a person would play. The bot now
// commits: ENTRY first (it opens the tree), then the fork side the identity
// wants, then riders, then the capstone, and it feeds the same two trees all
// run.

/** The fork side each tree COMMITS to for this crawler. Exclusivity is real —
 * taking one side locks the other forever — so this is the build decision. */
function forkPreference(p: Player, school: School): Set<string> {
  const wc = weaponClassOf(p.equipment.weapon);
  return new Set<string>([
    // A swift weapon already swings fast; stacking momentum beats +20% on a
    // slow swing, and the reverse for a heavy one.
    wc === "swift" || wc === "chaotic" ? "melee.swift" : "melee.heavy",
    "dash.quick", // a third charge is more dodges, and this policy dodges
    school === "magic" ? "bolt.split" : "bolt.pierce",
    "nova.crush", // the policy only casts into 3+, so the dragged bonus pays
    "orbit.razor",
    "stance.discipline", // it swaps only when SETTLED, so Flow would be wasted
    school === "magic" ? "overcharge.volley" : "overcharge.echo",
    "cut.encore", // charges, like dash's — the policy spends charges
    school === "magic" ? "surf.grip" : "surf.dive",
    "double.method", // a double that survives soaks more than one that dies loud
    "bul.rally", // the brace timing is coarse; take the guaranteed heal
    "cab.live",
    "air.saturation", // the barrage answers packs; the boss answer is elsewhere
    "cata.aftermath",
    "bt.adrenaline",
    "inj.crunch", // shorter stay, smaller debt, more damage inside
  ]);
}

function draftScore(p: Player, offer: UpgradeOffer, id: Identity, pref: Set<string>): number {
  // Which TREE: the identity's two carries take the ranks, the ultimate takes
  // what is left, and everything else is a consolation prize.
  let score = offer.ability === id.primary ? 60
    : offer.ability === id.secondary ? 42
    : offer.ability === p.abilities.ultimate ? 34
    : 12;
  const def = upgradeDef(offer.id);
  if (!def) return score;
  if (def.capstone) score += 26; // a behavior, not a number (§4.1)
  else if (def.excludes) score += pref.has(offer.id) ? 22 : -60; // commit to ONE side
  else if (!def.requires) score += 24; // the ENTRY: nothing else in the tree opens without it
  else score += 10; // rider
  if (offer.overrank) score += 16; // headroom past the printed max is free power
  return score;
}

/** Index of the offer this build wants. Ties keep the lowest index, so the
 * pick is a pure function of the draft. */
function draftPick(p: Player, id: Identity): number {
  const pref = forkPreference(p, id.school);
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < p.pendingUpgrades.length; i++) {
    const s = draftScore(p, p.pendingUpgrades[i], id, pref);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

/** Sponsor gifts, shrines and service rooms all ride pendingRewards. Index 0
 * used to win by default, which quietly meant the bot declined glyphs it was
 * offered and staked gold on the house's card game. */
function rewardScore(p: Player, r: Reward): number {
  const hurt = 1 - (p.maxHp > 0 ? p.hp / p.maxHp : 1);
  switch (r.kind) {
    case "glyph": return 92; // the modifier layer IS the build (V2 §3)
    case "favor": return 82; // an owed draft is a constellation rank
    case "item": return 70;
    case "damage": return 68;
    case "svcTemper": return 60;
    case "maxHp": return 58;
    case "crit": return 54;
    case "armor": return 50;
    case "svcPlans": return 46; // free seconds on the collapse clock
    case "materials": return 44;
    case "bonusTime": return 40;
    case "shrineDraft": return 38;
    case "gold": return 30;
    case "revision": return 30; // a curse with a build attached — still content
    case "revisionDecline": return 28;
    case "shrineLiquidate": return 26;
    case "retrain": return 22;
    case "shrineLoan": return 20;
    case "svcMap": return 18;
    case "shrineDecline": return 14;
    case "shrineGreed": return 10;
    case "svcWager": return 4; // the house deals
    // Healing is worth exactly what is missing: a full heal at full HP is a
    // wasted draft, and at 20% it is the best card on the table.
    case "healFull": case "svcDraught": case "shrinePremium": return 20 + hurt * 110;
    case "shrineBlood": return hurt < 0.2 ? 34 : 8; // pay HP only while healthy
    default: return 15;
  }
}

function rewardPick(p: Player): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < p.pendingRewards.length; i++) {
    const s = rewardScore(p, p.pendingRewards[i]);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

// ---- THE GLYPH BOARD (ITEMIZATION-V2 §3 / ABILITIES-V2 §5) ----
// Sockets belong to the SLOT and re-socketing in a safe room is free and
// lossless, so a competent crawler re-cuts the board every time the loadout
// moves. The old policy dropped each stone into the first legal socket, which
// is how Arcane Lens ends up on Collapse (already sp:1 — a literal no-op that
// eats the only socket the slot had) and Longshot ends up on a melee swing
// taking the penalty half of its own trade forever.

/** Baseline worth of each stone, before the socket it is going into is known. */
const GLYPH_BASE: Record<GlyphId, number> = {
  arc_splice: 55, splitfang: 50, reprise: 60, brandmark: 55, accelerant: 50,
  arcane_lens: 0, executioners_rebate: 45, heavyweight_plate: 36, hair_trigger: 36,
  slipstream: 42, static_charge: 50, demolition_rider: 0, ballistic_lens: 0,
  envenomed: 45, cryo_etch: 46, grave_dividend: 40, culling_edge: 55,
  poise_wrecker: 40, point_blank: 0, longshot: 0, blood_price: 40,
  phase_etch: 46, understudy_rider: 50, encore_clause: 58, cold_open: 44,
};

/** Ability priority: the primary tree gets the good stones. */
function abilityWeight(p: Player, ability: AbilityId, id: Identity): number {
  if (ability === id.primary) return 1;
  if (ability === id.secondary) return 0.8;
  if (ability === p.abilities.ultimate) return 0.7;
  return 0.45;
}

/** Does this build put a burn or a poison on anything? Demolition Rider eats
 * DoTs, so without a source it is a socket spent on nothing. */
function hasDotSource(p: Player): boolean {
  if (rank(p, "nova.scorch") > 0 || rank(p, "melee.bleed") > 0) return true;
  for (const a of p.abilities.slots) {
    if (a && (hasGlyph(p, a, "accelerant") || hasGlyph(p, a, "envenomed"))) return true;
  }
  return false;
}

/**
 * What a stone is worth IN THIS SOCKET. glyphMatches already says it may go
 * here; this says whether it should. A non-positive score means "never socket
 * this here" — the board is better with an empty socket than with a stone that
 * pays nothing (or pays its drawback only).
 */
function glyphValue(p: Player, gid: GlyphId, ability: AbilityId, id: Identity): number {
  let v = GLYPH_BASE[gid];
  // THE LENSES. On an ability already scaling off the school you have, a lens
  // is a no-op (V2 §1.2) — Arcane Lens on Collapse converts sp:1 to sp:1. Each
  // is worth a lot exactly where it converts something, and nothing elsewhere.
  if (gid === "arcane_lens") v = id.school === "magic" && (SCALING[ability]?.sp ?? 0) < 1 ? 95 : -1;
  if (gid === "ballistic_lens") v = id.school === "physical" && (SCALING[ability]?.sp ?? 0) > 0 ? 95 : -1;
  // THE RANGE FAMILY. Both halves are real: the bonus only lands if the
  // ability is cast at the range it rewards, and the penalty lands regardless.
  if (gid === "point_blank") v = CLOSE_RANGE_ABILITIES.includes(ability) ? 58 : -1;
  if (gid === "longshot") v = ability === "bolt" || ability === "airstrike" ? 56 : -1;
  if (gid === "demolition_rider") v = hasDotSource(p) ? 58 : 12;
  // Blood Price is damage bought with max HP; a crawler already bleeding out
  // is not the crawler who should be buying.
  if (gid === "blood_price" && p.maxHp > 0 && p.hp < p.maxHp * 0.5) v = 10;
  return v * abilityWeight(p, ability, id);
}

/**
 * The safe-room glyph pass: reclaim, then place. Dormant stones (the loadout
 * moved under them) and stones sitting in a socket they pay nothing in go back
 * to the bench; then every open socket takes the best stone the bench can
 * offer, best pair first, re-checking legality each round because family
 * exclusion moves as the board fills.
 */
function manageGlyphs(state: GameState, playerId: number, id: Identity): void {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p?.glyphs) return;
  const g = p.glyphs;
  const abilityAt = (slot: number): AbilityId | null =>
    slot === ABILITY_SLOTS ? p.abilities.ultimate : p.abilities.slots[slot];
  const socketsAt = (slot: number): number =>
    slot === ABILITY_SLOTS ? (p.abilities.ultimate ? 1 : 0) : glyphSocketCount(p.level, slot);
  const arrAt = (slot: number): (GlyphId | null)[] =>
    slot === ABILITY_SLOTS ? g.ultimate : g.slots[slot];

  // 1. Reclaim. Removal is free and lossless, so a dead stone in a live socket
  //    is pure loss — there is nothing to weigh against pulling it.
  for (let slot = 0; slot <= ABILITY_SLOTS; slot++) {
    const ability = abilityAt(slot);
    const arr = arrAt(slot);
    for (let s = 0; s < arr.length; s++) {
      const gid = arr[s];
      if (!gid) continue;
      if (!ability || !glyphMatches(gid, ability) || glyphValue(p, gid, ability, id) <= 0) {
        unsocketGlyph(state, playerId, slot, s);
      }
    }
  }

  // 2. Place, best pair first.
  for (;;) {
    let bestVal = 0;
    let best: { gid: GlyphId; slot: number; socket: number } | null = null;
    for (const gid of g.bench) {
      for (let slot = 0; slot <= ABILITY_SLOTS; slot++) {
        const ability = abilityAt(slot);
        if (!ability || !glyphMatches(gid, ability)) continue;
        const arr = arrAt(slot);
        const open = Math.min(socketsAt(slot), arr.length);
        for (let s = 0; s < open; s++) {
          if (arr[s] !== null || !socketLegal(p, slot, s, gid)) continue;
          const v = glyphValue(p, gid, ability, id);
          if (v > bestVal) { bestVal = v; best = { gid, slot, socket: s }; }
        }
      }
    }
    if (!best) return;
    socketGlyph(state, playerId, best.slot, best.socket, best.gid);
    // If the sim refused the placement for a reason this policy did not model,
    // stop rather than spin on it forever.
    if (arrAt(best.slot)[best.socket] !== best.gid) return;
  }
}

/**
 * Safe-room shopping policy: a straightforward damage-first build path through
 * the System Shop (components combine upward; buyCatalogItem no-ops anything
 * unaffordable/out-of-stock, so this just attempts the ladder in order).
 * Modeling a shopping player matters: gear is where the power curve lives, and
 * a frugal bot would understate player damage against bosses.
 */
const SHOP_LADDER = [
  // The completed-work-by-shop-3 line (V2 §2.6): components first, the combine
  // clicks the moment the boss-3 trophy gold lands, then the chase ladder.
  "honed_edge", "killer_instinct", "primetime_cleaver", "headliner_cleaver",
  "iron_plating", "showstopper_plate", "blastplate_harness",
  "glass_charm", "ratings_magnet",
  // Depth padding: a second completed work + support sockets keep late gold live.
  "crash_helmet", "mosh_pit_helm",
];

function shop(state: GameState, playerId: number): void {
  const p = state.players[0];
  if (p.hp < p.maxHp * 0.6) buyCatalogItem(state, playerId, "field_ration");
  // Bench first (V2 §2.4): junk commodity drops become refit shards, so the
  // dismantle economy is priced into the balance contract.
  for (let i = p.inventory.length - 1; i >= 0; i--) {
    if (!p.inventory[i].catalogId) dismantleItem(state, playerId, i);
  }
  for (const id of SHOP_LADDER) buyCatalogItem(state, playerId, id);
  // REFIT the worn weapon when the shards allow — the "my item stays alive"
  // verb, exercised so the contract measures the real power curve.
  const w = p.equipment.weapon;
  if (w?.catalogId) {
    const cost = refitCost(w);
    if (cost && cost.sigils === 0 && (p.materials.refit_shard ?? 0) >= cost.shards && p.gold >= cost.gold + 80) {
      refitItem(state, playerId, "weapon");
    }
  }
  // A GLYPH CACHE once the gear plan is funded (V2 §3.1): the modifier layer
  // is real power, so a competent player buys into it — the balance contract
  // must measure a crawler who has firmware, not one who ignored the shelf.
  if (p.gold > 200 && glyphSocketCount(p.level) > 0) buyCatalogItem(state, playerId, "glyph_cache");
  if (p.gold > 250) buyCatalogItem(state, playerId, "plating_kit"); // spare gold -> permanent HP
  // THE BUILD, after the shopping: the identity reads the weapon, so re-slotting
  // before the purchase would commit to the crawler of the previous floor.
  const id = identityOf(state, p);
  chooseLoadout(state, playerId, id);
  manageGlyphs(state, playerId, id);
}

export interface BotRunResult {
  floorsCleared: number; // floors fully cleared (descended from)
  died: boolean;
  won: boolean;
  totalDamageTaken: number;
  totalKills: number;
  floors: FloorMetrics[];
  encounters: EncounterMetric[]; // every boss/elite fight finished (killed)
  steps: number;
}

/**
 * Drive a game with the bot until it clears `floors`, dies, wins, or runs out
 * of the step budget. Handles the non-intent surfaces a host would: level-up
 * drafts and sponsor gifts are scored against the build, and safe rooms shop,
 * re-slot the loadout, re-cut the glyph board and ready up.
 */
export function runBot(state: GameState, floors: number, maxSteps = 150_000): BotRunResult {
  const dt = 1 / 60;
  const mem = freshMemory();
  const p = state.players[0];
  const result: BotRunResult = {
    floorsCleared: 0, died: false, won: false,
    totalDamageTaken: 0, totalKills: 0, floors: [], encounters: [], steps: 0,
  };
  let floorStart = { elapsed: state.elapsed, damage: p.damageTaken, kills: p.kills };
  const startFloor = state.floor;
  const targetFloor = startFloor + floors;
  // Boss/elite fights in progress: keyed by monster id, opened at introduction.
  const fights = new Map<number, { start: number; hp0: number; m: Monster; level: number; dmg: number }>();

  while (result.steps < maxSteps && state.status === "playing" && state.floor < targetFloor) {
    if (state.safeRoom) {
      // Descending: record the floor we just finished, shop, then ready up.
      result.floors.push({
        floor: state.floor,
        cleared: true,
        simSeconds: state.elapsed - floorStart.elapsed,
        timeRemaining: state.timeRemaining,
        damageTaken: p.damageTaken - floorStart.damage,
        kills: p.kills - floorStart.kills,
      });
      result.floorsCleared++;
      fights.clear(); // anything left alive was bypassed, not fought
      shop(state, p.id);
      setReady(state, p.id);
      floorStart = { elapsed: state.elapsed, damage: p.damageTaken, kills: p.kills };
      continue;
    }
    // Both drafts are BUILD decisions, so neither is taken on index order:
    // the reward picker weighs the card against the crawler's state and the
    // upgrade picker feeds the identity's two trees (see draftScore).
    if (p.pendingRewards.length > 0) chooseReward(state, p.id, rewardPick(p));
    if (p.pendingUpgrades.length > 0) chooseUpgrade(state, p.id, draftPick(p, identityOf(state, p)));
    step(state, botIntent(state, mem), dt);
    result.steps++;

    // Encounter tracking: open on introduction, close on the kill.
    for (const m of state.monsters) {
      if ((m.kind === "boss" || m.elite) && m.introduced && !fights.has(m.id)) {
        fights.set(m.id, { start: state.elapsed, hp0: p.damageTaken, m, level: p.level, dmg: p.attackPower });
      }
    }
    for (const [id, f] of fights) {
      if (state.monsters.includes(f.m) && f.m.hp > 0) continue;
      fights.delete(id);
      if (f.m.hp > 0) continue; // vanished without dying (floor edge) — skip
      result.encounters.push({
        floor: state.floor,
        kind: f.m.kind === "boss" ? "boss" : "elite",
        name: f.m.eliteName ?? "THE FLOOR BOSS",
        maxHp: f.m.maxHp,
        ttk: state.elapsed - f.start,
        playerLevel: f.level,
        playerDamage: f.dmg,
        hpLost: p.damageTaken - f.hp0,
      });
    }
  }

  result.died = state.status === "dead";
  result.won = state.status === "won";
  if (result.won) result.floorsCleared = Math.max(result.floorsCleared, floors);
  if (!result.died && !result.won && state.floor < targetFloor && result.steps < maxSteps) {
    // loop exited without meeting any end condition — should be unreachable
    result.died = true;
  }
  result.totalDamageTaken = p.damageTaken;
  result.totalKills = p.kills;
  return result;
}
