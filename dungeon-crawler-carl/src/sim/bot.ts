import { CONFIG } from "./config";
import { dist, normalize } from "./combat";
import { buyCatalogItem, chooseReward, chooseUpgrade, setReady, step } from "./game";
import { Tile, type GameState, type Intent, type Monster, type Vec2 } from "./types";

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

function decide(state: GameState, mem: BotMemory, p: GameState["players"][number]): Intent {
  const intent: Intent = { move: { x: 0, y: 0 }, useStairs: false };
  mem.fightId = null;

  // Sponsor Slurp below the comfort line.
  if (p.hp < p.maxHp * COMPETENT.flaskAt && p.flaskCharges > 0) intent.flask = true;

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

  // Respect HEAVY telegraphs (boss slams always; otherwise a hit worth >= ~12%
  // of max HP, or a bomber fuse): back away, dashing through the strike frame
  // if it's about to land. Chaff windups are traded through — retreating from
  // everything lets a pack of swarmers perma-kite the bot off the floor.
  for (const m of state.monsters) {
    if (m.hp <= 0 || m.windup <= 0) continue;
    const heavy = m.kind === "boss" || m.windupKind === "fuse" || m.damage >= p.maxHp * 0.12;
    if (!heavy) continue;
    const reach =
      (m.windupKind === "fuse" ? CONFIG.bomberExplodeRadius : m.attackRange + CONFIG.monsterStrikeGrace) +
      COMPETENT.dodgeBuffer;
    const d = dist(p.pos, m.pos);
    if (d > reach) continue;
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
    const aim = { x: threat.pos.x - p.pos.x, y: threat.pos.y - p.pos.y };
    intent.aim = aim;
    if (d <= CONFIG.playerAttackRange * 0.95) {
      intent.attack = true;
    } else {
      intent.move = normalize(aim);
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

/**
 * Safe-room shopping policy: a straightforward damage-first build path through
 * the System Shop (components combine upward; buyCatalogItem no-ops anything
 * unaffordable/out-of-stock, so this just attempts the ladder in order).
 * Modeling a shopping player matters: gear is where the power curve lives, and
 * a frugal bot would understate player damage against bosses.
 */
const SHOP_LADDER = [
  "honed_edge", "killer_instinct", "primetime_cleaver", "headliner_cleaver",
  "iron_plating", "showstopper_plate", "blastplate_harness",
  "glass_charm", "ratings_magnet",
];

function shop(state: GameState, playerId: number): void {
  const p = state.players[0];
  if (p.hp < p.maxHp * 0.6) buyCatalogItem(state, playerId, "field_ration");
  for (const id of SHOP_LADDER) buyCatalogItem(state, playerId, id);
  if (p.gold > 250) buyCatalogItem(state, playerId, "plating_kit"); // spare gold -> permanent HP
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
 * drafts and sponsor gifts take the first offer; safe rooms ready-up
 * immediately (a frugal bot — gold spending is not modeled).
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
    if (p.pendingRewards.length > 0) chooseReward(state, p.id, 0);
    if (p.pendingUpgrades.length > 0) chooseUpgrade(state, p.id, 0);
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
