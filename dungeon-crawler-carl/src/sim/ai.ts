import { ARCHETYPES, CONFIG, monsterMemory, monsterTempo } from "./config";
import { dist, normalize } from "./combat";
// Monster movement always uses the settlement-aware check: on Race floors
// (settlementRoomIdx -1) this is identical to isWalkable; on Roam floors it
// additionally blocks monsters from wandering/chasing into the sanctuary.
import { isWalkableForMonster as isWalkable } from "./floor";
import { chance, nextFloat } from "./rng";
import { bandSignatureLabel, bossChassisRule, bossPunishRule } from "./bosses";
import type { BossId, GameState, Monster, Player, Vec2 } from "./types";
import { moveWithCollision } from "./movement";
import { flowDir, flowUphill, tileLos } from "./pathfield";
import { applyStatus } from "./status";
import {
  advanceBossPhase, applyPlayerKnockback, bossBloom, bossBrandActivation, bossCitation,
  bossConveyorRun, bossCrossPromotion, bossDebrisRain, bossDemolition,
  bossEvent, bossExposeCore, bossFissureFan, bossFlameSweep, bossFloodSurge, bossGraveRaise, bossGreasePull,
  bossHedgeRegrow,
  bossLateFee, bossLattice, bossMechanicBeat, bossMotion, bossPunishVent, bossReconvene, bossRootGrasp,
  bossSetback, bossShotList, bossShowSetChange,
  bossSluice, bossStopWork,
  breakResidentScene, damagePlayerHit, decoySoak, explodeBomber, handlePlayerDeath, makeBossAdd, nearestPlayer, raiseCorpse,
  summonMinion, tauntingDecoy,
} from "./game";
import { PURPOSE_PERCEPTION } from "./roomPurposes";
import { smashBlockersAt } from "./game";
import { datan2, dcos, dhypot, dsin } from "./dmath";

/**
 * SEPARATION (pack presence, AI tier 1): monsters softly shove each other
 * apart, so a pack arrives as a crescent instead of nine ghosts stacked on
 * one tile — a cleave should hit the two in front, not the whole pack, and
 * nine overlapping telegraphs should never render as one. Mass decides who
 * yields (a grunt steps around the brute, not vice versa). Winding-up
 * monsters are rooted anchors: their telegraph position is a promise to the
 * player, so they push neighbors but never slide themselves. O(n) via a
 * coarse spatial hash; forces accumulate off the pre-pass positions so
 * iteration order can't bias the result (determinism).
 */
export function separateMonsters(state: GameState, dt: number): void {
  const ms = state.monsters;
  if (ms.length < 2 || dt <= 0) return;
  const R = CONFIG.monsterSeparationRadius;
  const key = (cx: number, cy: number) => cx * 4096 + cy;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.hp <= 0 || (m.vanishT ?? 0) > 0) continue;
    const k = key(Math.floor(m.pos.x), Math.floor(m.pos.y));
    const b = buckets.get(k);
    if (b) b.push(i);
    else buckets.set(k, [i]);
  }
  const push: (Vec2 | null)[] = new Array(ms.length).fill(null);
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.hp <= 0 || m.windup > 0 || (m.vanishT ?? 0) > 0) continue;
    const mass = ARCHETYPES[m.kind].mass;
    const cx = Math.floor(m.pos.x), cy = Math.floor(m.pos.y);
    let fx = 0, fy = 0;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const b = buckets.get(key(cx + ox, cy + oy));
        if (!b) continue;
        for (const j of b) {
          if (j === i) continue;
          const o = ms[j];
          const dx = m.pos.x - o.pos.x, dy = m.pos.y - o.pos.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= R * R) continue;
          const w = (1 - Math.sqrt(d2) / R) * Math.min(2, ARCHETYPES[o.kind].mass / mass);
          if (d2 < 1e-8) {
            // Perfectly stacked: split along an id-derived heading so even a
            // spawn-point pile resolves, deterministically, without the RNG.
            const a = (m.id % 8) * (Math.PI / 4);
            fx += dcos(a) * w;
            fy += dsin(a) * w;
          } else {
            const d = Math.sqrt(d2);
            fx += (dx / d) * w;
            fy += (dy / d) * w;
          }
        }
      }
    }
    if (fx !== 0 || fy !== 0) push[i] = { x: fx, y: fy };
  }
  for (let i = 0; i < ms.length; i++) {
    const f = push[i];
    if (!f) continue;
    const len = dhypot(f.x, f.y);
    if (len < 1e-6) continue;
    const step = Math.min(1, len) * CONFIG.monsterSeparationSpeed * dt;
    moveWithCollision(state.map, ms[i].pos, { x: f.x / len, y: f.y / len }, step, isWalkable);
  }
}

/**
 * LOS AGGRO (AI tier 2): hunters commit when they SEE you — or when hurt, or
 * when a packmate raises the alarm — and remember the hunt for a few seconds
 * after losing sight, chasing through the flow field along the way you went.
 * Fog becomes tactical: walls hide you, breaking contact is a real move, and
 * a pack you never showed yourself to stays parked. Applies to the mass
 * archetypes (generic melee + ranged); named kinds keep their own senses.
 */
export function alertMonster(state: GameState, m: Monster): void {
  const fresh = (m.alertT ?? 0) <= 0;
  m.alertT = monsterMemory(state.floor);
  if (!fresh) return;
  // The alarm spreads through the pack (fresh-transition guard bounds the
  // cascade): one grunt spotting you wakes the room, not just itself. Walls
  // MUFFLE it — no line of sight, no alarm — or a chain of cascades would
  // recruit room after room across the whole floor.
  for (const n of state.monsters) {
    if (n !== m && n.hp > 0 && !n.dormant && dist(m.pos, n.pos) <= CONFIG.packAlertRadius && tileLos(state.map, m.pos, n.pos)) {
      alertMonster(state, n);
    }
  }
}

/** Seen right now (re-arms the memory), or still remembered? */
function hunterAlerted(state: GameState, m: Monster, huntPos: Vec2, d: number, range: number): boolean {
  if (d <= range && tileLos(state.map, m.pos, huntPos)) {
    alertMonster(state, m);
    return true;
  }
  return (m.alertT ?? 0) > 0;
}

/**
 * FLANKING APPROACH (attack slots, AI tier 1): each melee chaser blends a
 * personal tangential bias into its pursuit as it closes, so a pack fans
 * into a crescent — and, with separation pushing the wings outward, a
 * surround — instead of a single-file line to the player's center. The bias
 * is id-derived (deterministic, no coordination, no RNG) and fades with
 * distance, so a far chaser still takes the direct line. AA slot managers
 * do this with claimed positions; the stateless blend gets the same read
 * for a swarm at zero bookkeeping — revisit when flow fields land.
 */
function flankVector(state: GameState, m: Monster, toPlayer: Vec2, d: number): Vec2 {
  const spread = ((m.id % 7) - 3) / 3; // -1..1: this monster's preferred side
  const closeness = Math.max(0, Math.min(1, 1 - (d - m.attackRange) / CONFIG.flankEngageRange));
  // GARDEN band personality (tier 3): the growth ENCIRCLES — wider flanking
  // arcs on floors 7-9, so the foliage floor's packs envelop instead of
  // pressing a crescent.
  const garden = state.floor >= CONFIG.gardenFromFloor && state.floor < CONFIG.ruinsFromFloor
    ? CONFIG.gardenEncircleMult : 1;
  const k = spread * closeness * CONFIG.flankStrength * garden;
  return normalize({ x: toPlayer.x - toPlayer.y * k, y: toPlayer.y + toPlayer.x * k });
}

// FURNITURE-FEEL: the kinds with the frame to remove furniture rather than
// walk around it. Everyone else slips the 45s (see slipAround).
const SMASH_KINDS = new Set<Monster["kind"]>(["brute", "warden", "colossus", "slagbreaker", "foreman", "boss"]);

/** Any blocking furniture within reach of this monster's swing? */
function furnitureWithin(state: GameState, pos: Vec2, r: number): boolean {
  return (state.breakables ?? []).some((b) => b.footprint && dist(pos, b.pos) <= r);
}

/** LOCAL AVOIDANCE (furniture-feel): a stalled chaser tries the two
 *  45-degree slips instead of grinding at a mid-room table like a stuck
 *  vacuum. Parity picks the first side, so a pack SPLITS around the
 *  obstacle instead of conga-lining behind one member. */
function slipAround(state: GameState, m: Monster, toPlayer: Vec2, step: number): void {
  const px = m.pos.x, py = m.pos.y;
  // Try the flank-preferred side FIRST (same id-derived sign as flankVector,
  // same rotation convention) — a slip that opposes the tangential bias
  // deadlocks into a wiggle at the obstacle instead of rounding it. Ids with
  // no flank bias keep the old parity split.
  const spread = (m.id % 7) - 3;
  const first = spread !== 0 ? Math.sign(spread) : m.id % 2 === 0 ? 1 : -1;
  for (const sign of [first, -first]) {
    const c = Math.SQRT1_2, s = sign * Math.SQRT1_2;
    const slip = { x: toPlayer.x * c - toPlayer.y * s, y: toPlayer.x * s + toPlayer.y * c };
    moveWithCollision(state.map, m.pos, slip, step, isWalkable);
    if (dhypot(m.pos.x - px, m.pos.y - py) >= step * 0.5) return;
  }
}

// Monster behavior per archetype. Stats (hp/damage/speed/range) are baked in at
// spawn (see makeMonster); this file decides how each kind *acts*: melee types chase
// and swing, ranged types keep a standoff and shoot, and the boss chases + fires
// periodic radial volleys. Cheap greedy steering — replace with pathfinding later.
//
// ATTACKS TELEGRAPH: nothing lands instantly. An attack begins a windup
// (m.windup, per-archetype length) during which the monster is rooted and hosts
// render the tell; when it expires the strike resolves, re-checking range
// (+monsterStrikeGrace) and dash i-frames. Getting staggered (see damageMonster
// in game.ts) cancels the windup — interrupting a brute mid-slam is a real play.

function spawnEnemyBolt(state: GameState, from: Vec2, dir: Vec2, damage: number): void {
  const d = normalize(dir);
  state.projectiles.push({
    id: state.nextEntityId++,
    pos: { x: from.x + d.x * 0.5, y: from.y + d.y * 0.5 },
    vel: { x: d.x * CONFIG.monsterProjectileSpeed, y: d.y * CONFIG.monsterProjectileSpeed },
    damage,
    ttl: CONFIG.monsterProjectileTtl,
    from: "enemy",
  });
}

/**
 * ROAMING: an off-duty monster patrols instead of standing at its post — the
 * dungeon reads alive, and danger sometimes walks into YOU. Strolls run in
 * short randomized legs (some legs are just standing around), leashed to a
 * patrol post so encounters stay roughly where the floor placed them. The
 * moment a player is back in range, the kind's combat brain takes over.
 */
function wander(state: GameState, m: Monster, dt: number): void {
  if (!m.roams) return; // sentries hold their post — variety IS the behavior
  m.home ??= { x: m.pos.x, y: m.pos.y }; // first off-duty beat sets the post
  m.wanderT = Math.max(0, (m.wanderT ?? 0) - dt);
  if (m.wanderT === 0) {
    if (chance(state.rng, CONFIG.wanderPauseChance)) {
      m.wanderDir = undefined; // loiter a beat
    } else if (dist(m.pos, m.home) > CONFIG.wanderLeash) {
      // Strayed too far: the next leg heads back toward the post.
      m.wanderDir = normalize({ x: m.home.x - m.pos.x, y: m.home.y - m.pos.y });
    } else {
      const a = nextFloat(state.rng) * Math.PI * 2;
      m.wanderDir = { x: dcos(a), y: dsin(a) };
    }
    m.wanderT = CONFIG.wanderLegSeconds * (0.5 + nextFloat(state.rng));
  }
  if (m.wanderDir) {
    moveWithCollision(state.map, m.pos, m.wanderDir, m.speed * CONFIG.wanderSpeedMult * dt, isWalkable);
  }
}

/** Commit to an attack: root the monster and start the tell. */
function beginWindup(m: Monster, kind: NonNullable<Monster["windupKind"]>, seconds: number): void {
  m.windup = seconds;
  m.windupTotal = seconds;
  m.windupKind = kind;
}

/** A boss line, in the System's voice (ai.ts pushes straight to the channel —
 *  game.ts owns the `announce` helper and importing it here would be circular
 *  for no gain). */
function announce2(state: GameState, text: string, priority: "high" | "normal" = "normal"): void {
  state.announcements.push({ text, kind: "boss", priority });
}

/**
 * BOSSES V2 §2.3 — commit a BOSS telegraph. Identical to beginWindup except
 * that it honours the REDACTED mutator: shorter tells, paid for by the System
 * announcing the move in text. Read the ticker instead of the floor. The 0.2s
 * hard rule still holds — redactedTelegraphMult never takes a tell under it.
 */
function beginBossWindup(
  state: GameState, m: Monster, kind: NonNullable<Monster["windupKind"]>, seconds: number, label?: string,
): void {
  let t = seconds;
  // REDACTED, MEASURED (acceptance r5, major). The mutator's note says
  // "shorter telegraphs" and it INVERTED its own difficulty: on The Safety
  // Officer over 60s it measured 29,089 damage taken against 150,554 clean
  // (-81%) and 82 hazards against 183 (-55%). The mechanism was the PUNISH
  // tell — shortening it only got the boss to its own helplessness sooner, and
  // a storm boss that spends the fight staggered has no storm. So:
  //   * the punish windup is never redacted (it is the one tell whose job is
  //     to be READ, and it ends in the boss being wide open either way), and
  //   * the boss pays for the shorter tells by COMMITTING MORE OFTEN (see the
  //     redacted tempo in stepMonster) instead of by doing less.
  if (m.bossMutators?.includes("redacted") && kind !== "punish") {
    t = Math.max(0.25, seconds * CONFIG.mutatorRedactedTell);
    if (label) announce2(state, `[REDACTED FEED] Next: ${label}.`);
  }
  beginWindup(m, kind, t);
  if (label) {
    bossEvent(state, {
      kind: "telegraph", monsterId: m.id, bossId: m.bossId, label,
      duration: t, pos: { x: m.pos.x, y: m.pos.y },
    });
  }
}

/**
 * ATTACK TOKENS (AI tier 1): only a few BASIC melee windups may be in flight
 * at once — the rest of the surround presses and waits its turn. This makes
 * a pack HARDER to read than the old everyone-swings-at-once pile: one
 * sidestep no longer dodges nine synchronized hits, it dodges one, and the
 * next tell is already starting somewhere else on the ring. The cap scales
 * with depth (shallow floors read like duels, deep floors overlap) and with
 * party size. Named kinds, elites, and bosses are the SPICE — they never
 * wait for a token. Gate applies only to the generic grunt/swarmer swing.
 */
function meleeTokenFree(state: GameState, m: Monster): boolean {
  if (m.elite || m.kind === "boss") return true;
  const alive = state.players.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
  const cap = Math.min(CONFIG.meleeTokensMax, CONFIG.meleeTokensBase + Math.floor((state.floor - 1) / CONFIG.meleeTokensEveryFloors)) * Math.max(1, alive);
  let inFlight = 0;
  for (const o of state.monsters) {
    if (o === m || o.hp <= 0 || o.windup <= 0 || o.windupKind !== "melee") continue;
    if (o.elite || o.kind === "boss") continue; // spice swings don't spend tokens
    if (++inFlight >= cap) return false;
  }
  return true;
}

/** A melee strike lands: damage every living player still inside range + grace. */
function resolveMeleeStrike(state: GameState, m: Monster): void {
  m.attackCooldown = CONFIG.monsterAttackCooldown * monsterTempo(state.floor).cooldown;
  const reach = m.attackRange + CONFIG.monsterStrikeGrace;
  // The big frames wreck furniture in the arc (brute smash-through).
  if (SMASH_KINDS.has(m.kind)) smashBlockersAt(state, m.pos, reach + 0.45);
  // A STUNT DOUBLE in reach takes the hit — that is what it is paid for.
  if (decoySoak(state, m.pos, reach, m.damage)) return;
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue; // dash i-frames dodge the blow
    if (dist(m.pos, player.pos) > reach) continue; // stepped out of the arc — whiff
    const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    // EXECUTIONER elites (six-pack) hit wounded crawlers harder — the retreat
    // threshold becomes a real decision, not a vibe.
    const execute = m.affix === "executioner" && player.hp < player.maxHp * CONFIG.executionerThreshold
      ? CONFIG.executionerDmgMult : 1;
    const before = player.hp;
    if (damagePlayerHit(state, player, m.damage * execute, { dir, src: m })) {
      handlePlayerDeath(state, player, `${player.name} died in the dungeon.`);
    }
    // VAMPIRIC elites (six-pack) drink what they hit — starve it by dodging.
    if (m.affix === "vampiric" && before > player.hp && m.hp < m.maxHp) {
      const heal = Math.min(m.maxHp - m.hp, Math.round((before - player.hp) * CONFIG.vampiricHealFraction));
      if (heal > 0) {
        m.hp += heal;
        state.hits.push({ pos: { x: m.pos.x, y: m.pos.y }, amount: heal, kind: "heal" });
      }
    }
  }
}

/** Ground Slam lands: a self-centered AoE, no facing/arc — everyone standing
 * within `radius` of the slammer eats it. Brute's whole attack; also a boss ability. */
function resolveSlamStrike(state: GameState, m: Monster, radius: number, dmg: number): void {
  m.attackCooldown = CONFIG.monsterAttackCooldown * monsterTempo(state.floor).cooldown;
  // The slam wrecks the furniture too (brute smash-through): the table
  // explodes and the fight arrives.
  if (SMASH_KINDS.has(m.kind)) smashBlockersAt(state, m.pos, radius + 0.45);
  // The double dives on the slam too (players in the radius still get spared —
  // one professional sacrifice per blast).
  if (decoySoak(state, m.pos, radius, dmg)) return;
  let caught = 0;
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue; // dash i-frames dodge the blow
    if (dist(m.pos, player.pos) > radius) continue;
    caught++;
    const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    if (damagePlayerHit(state, player, dmg, { dir, src: m })) {
      handlePlayerDeath(state, player, `${player.name} stood in the blast radius. The System rolls the replay.`);
    } else {
      // Slams SHOVE (MOB-CONCEPTS knockback verb): surviving one still costs
      // you your footing — and whatever ground the shove lands you on.
      applyPlayerKnockback(player, dir, m.kind === "boss" ? CONFIG.bossSlamKnockback : CONFIG.slamKnockback);
    }
  }
  // THE READ PAYS (r5 blocker, V4). A boss slam that catches NOBODY is the
  // player having seen it and left, and that is the only thing in this fight
  // that should shorten the wait for the punish window. See bossHeat.
  if (caught === 0) bossWhiff(m);
}

/**
 * A boss committed a telegraphed heavy and it landed on nobody. Under the
 * shipped rule this was worth exactly nothing — the punish window came round
 * on a fixed count whatever the player did, which is why round 5 called it a
 * metronome. It is now the fastest way to open one.
 */
function bossWhiff(m: Monster): void {
  if (m.kind !== "boss") return;
  m.heat = (m.heat ?? 0) + CONFIG.bossPunishWhiffHeat;
  // ...AND IT COUNTS TOWARD THE FIGHT'S ONE MECHANIC EDGE (r6 major). See
  // `readsEarnAPhase` below: §2.2 makes a mechanic-completion phase a HARD
  // rule, one per fight, and it fired on 11 of 18 in real play.
  m.reads = (m.reads ?? 0) + 1;
}

/** Dark Ritual lands (boss tier 3 only): a long-telegraphed, arena-scale AoE —
 * the game's one real "interrupt it or eat a serious hit" stake. Poise-stagger
 * (see damageMonster in game.ts) cancels the windup exactly like anything else;
 * this ability is just dangerous enough that failing to land that stagger costs. */
function resolveRitualStrike(state: GameState, m: Monster): void {
  const dmg = m.damage * CONFIG.ritualDmgMult;
  let caught = 0;
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue;
    if (dist(m.pos, player.pos) > CONFIG.ritualRadius) continue;
    caught++;
    const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    if (damagePlayerHit(state, player, dmg, { dir, src: m })) {
      handlePlayerDeath(state, player, `${player.name} let the ritual finish. The System does not offer refunds.`);
    }
  }
  if (caught > 0) {
    state.announcements.push({ text: "THE RITUAL LANDS. That's going to leave a mark.", kind: "boss", priority: "normal" });
  } else {
    bossWhiff(m); // a channel you walked out of is a window you bought
  }
}

/** The windup expired: resolve whatever this monster committed to. */
function resolveStrike(state: GameState, m: Monster): void {
  const kind = m.windupKind;
  m.windupKind = undefined;
  if (kind === "fuse") {
    explodeBomber(state, m); // full radius, wherever the fuse ran out
    return;
  }
  if (kind === "shot") {
    m.attackCooldown = CONFIG.monsterAttackCooldown * 1.3 * monsterTempo(state.floor).cooldown;
    const player = nearestPlayer(state, m.pos);
    if (!player) return;
    const aimAt = tauntingDecoy(state, m.pos) ?? player; // the double draws fire
    spawnEnemyBolt(state, m.pos, { x: aimAt.pos.x - m.pos.x, y: aimAt.pos.y - m.pos.y }, m.damage);
    return;
  }
  if (kind === "charge") {
    // The rush launches down the direction locked at commit (see stepMonster).
    m.chargeT = CONFIG.chargerRange / CONFIG.chargerDashSpeed;
    m.chargeHits = [];
    return;
  }
  if (kind === "spit") {
    // The lob lands where the player WAS at commit — moving out is the dodge.
    const target = m.spitTarget ?? m.pos;
    m.spitTarget = undefined;
    state.hazards.push({
      id: state.nextEntityId++,
      pos: { x: target.x, y: target.y },
      t: CONFIG.puddleDuration,
      total: CONFIG.puddleDuration,
      radius: CONFIG.puddleRadius,
      damage: m.damage * CONFIG.spitterPuddleDmgMult,
      kind: "puddle",
      tick: 0, // anyone caught at the splash eats the first tick immediately
    });
    return;
  }
  if (kind === "raise") {
    // The crypt boss's Grave Rising channel raises a whole handful; the
    // necromancer raises the one corpse it committed to. Both whiff
    // harmlessly if the bodies faded mid-ritual.
    if (m.kind === "boss") bossGraveRaise(state, m);
    else raiseCorpse(state, m);
    return;
  }
  if (kind === "heal") {
    // The committed patient may have died or topped up mid-channel — whiff.
    const target = state.monsters.find((a) => a.id === m.healId);
    m.healId = undefined;
    if (!target || target.hp <= 0 || target.hp >= target.maxHp) return;
    const amount = Math.min(CONFIG.shamanHeal, target.maxHp - target.hp);
    target.hp += amount;
    state.hits.push({ pos: { x: target.pos.x, y: target.pos.y }, amount, kind: "heal" });
    return;
  }
  if (kind === "summon") {
    // The Line Supervisor's CONVEYOR DELIVERY rides the same channel shape —
    // a boss's summon is a production run, not a single add.
    if (m.kind === "boss") {
      bossConveyorRun(state, m);
      return;
    }
    // Summoner elites + broodmother: the add arrives when the channel ends —
    // kill or stagger the caster inside the window and it never does.
    m.summons = (m.summons ?? 0) + 1;
    summonMinion(state, m);
    if (m.kind === "broodmother" && m.summons === 1) {
      state.events.push("A broodmother births another mouth. Kill the nest first.");
    }
    return;
  }
  if (kind === "slam") {
    // Brute's own attack uses its stat damage as-is; a boss's Ground Slam is an
    // extra ability layered on top of its melee+volley kit, so it's discounted.
    const radius = m.kind === "boss" ? CONFIG.bossSlamRadius : CONFIG.bruteSlamRadius;
    const dmg = m.kind === "boss" ? m.damage * CONFIG.bossSlamDmgMult : m.damage;
    resolveSlamStrike(state, m, radius, dmg);
    // THE FOUNDATION (boss, floor 12): the colossus crack at boss scale and in
    // MULTIPLES — a fan of lanes that leaves wedge-shaped safe ground, then a
    // radial set that asks for one committed decision.
    if (m.kind === "boss" && m.bossId === "foundation") {
      const radial = (m.phase ?? 0) >= 2;
      bossFissureFan(state, m, radial ? CONFIG.foundationRadialLanes : CONFIG.foundationLanes + (m.phase ?? 0), radial);
      return;
    }
    // The Foundation's slam CRACKS the floor: a fissure travels down the
    // locked lane as staggered eruptions — perpendicular movement beats it.
    if (m.kind === "colossus") {
      const dir = m.chargeDir ?? { x: 1, y: 0 };
      m.chargeDir = undefined;
      for (let i = 1; i <= CONFIG.fissureSteps; i++) {
        state.hazards.push({
          id: state.nextEntityId++,
          pos: { x: m.pos.x + dir.x * CONFIG.fissureStepGap * i, y: m.pos.y + dir.y * CONFIG.fissureStepGap * i },
          t: CONFIG.fissureStepDelay * i,
          total: CONFIG.fissureStepDelay * i,
          radius: CONFIG.fissureRadius,
          damage: m.damage * CONFIG.fissureDmgMult,
          kind: "blast",
        });
      }
      if (!m.noticed) {
        m.noticed = true;
        state.events.push("The Foundation CRACKS the floor — the fissure travels. Step OUT of its line, not along it.");
      }
    }
    // The Ossuary Warden's slam SHATTERS: a lingering bone-shard zone —
    // every swing reshapes the room, doorway by doorway.
    if (m.kind === "warden") {
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: m.pos.x, y: m.pos.y },
        t: CONFIG.wardenShardDuration,
        total: CONFIG.wardenShardDuration,
        radius: CONFIG.wardenShardRadius,
        damage: Math.max(1, m.damage * CONFIG.wardenShardDmgMult),
        kind: "shards",
        tick: CONFIG.puddleTickSeconds, // the slam itself was the first hit
      });
    }
    return;
  }
  if (kind === "ritual") {
    resolveRitualStrike(state, m);
    return;
  }
  // ---- BOSSES V2 windups. Four new kinds, and they are deliberately few:
  // everything else the roster does reuses a shipped windup (morph, summon,
  // slam, aim, raise) with a per-boss branch, exactly like the colossus
  // already branches inside "slam".
  if (kind === "punish") {
    // V4 — the over-commit resolves: one scalding beat, then genuinely
    // helpless. THE PUNISH WINDOW every shipped boss was missing.
    bossPunishVent(state, m);
    // The Furnace Marshal CRACKS OPEN if it is forced to vent while it is
    // already reeling — the mechanic phase its whole rhythm builds toward.
    if (m.bossId === "marshal" && (m.phase ?? 0) >= 1 && !m.plates) {
      bossExposeCore(state, m, "furnace_core", "THE FURNACE CORE", CONFIG.bossPunishWindow);
      advanceBossPhase(state, m, "mechanic");
    }
    return;
  }
  if (kind === "latefee") {
    bossLateFee(state, m);
    return;
  }
  if (kind === "bloom") {
    bossBloom(state, m);
    return;
  }
  if (kind === "pull") {
    bossGreasePull(state, m);
    return;
  }
  if (kind === "regrow") {
    // The Topiary Warden re-walls its shield pool. Interrupted mid-channel
    // (poise stagger, like every other channel) it never lands — which is the
    // whole break-the-shield ask made into one decision.
    bossHedgeRegrow(state, m);
    return;
  }
  if (kind === "punch") {
    // Lineworker piston punch: an ordinary melee hit that also LAUNCHES the
    // survivor (knockback verb) — the set dressing behind you is the threat.
    m.attackCooldown = CONFIG.monsterAttackCooldown * monsterTempo(state.floor).cooldown;
    const reach = m.attackRange + CONFIG.monsterStrikeGrace;
    if (decoySoak(state, m.pos, reach, m.damage)) return;
    for (const player of state.players) {
      if (!player.alive || player.dashTime > 0) continue;
      if (dist(m.pos, player.pos) > reach) continue;
      const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
      if (damagePlayerHit(state, player, m.damage, { dir, src: m })) {
        handlePlayerDeath(state, player, `${player.name} met the piston. Quality control approves.`);
      } else {
        // The Pit Digger's club launches FARTHER but hits gentler — it is
        // the knockback tutor, three floors before hazards make it hurt.
        applyPlayerKnockback(player, dir, m.kind === "digger" ? CONFIG.diggerKnockback : CONFIG.punchKnockback);
      }
    }
    return;
  }
  if (kind === "lunge") {
    // Cutpurse: dash down the locked lane, stab whoever it reaches, and go
    // for the PURSE — a hit steals gold into its carry (killing it refunds
    // everything with interest via the generic purse drop in reapDead).
    m.attackCooldown = CONFIG.monsterAttackCooldown * monsterTempo(state.floor).cooldown;
    const dir = m.chargeDir ?? { x: 1, y: 0 };
    m.chargeDir = undefined;
    moveWithCollision(state.map, m.pos, dir, CONFIG.cutpurseLungeRange, isWalkable);
    const reach = m.attackRange + CONFIG.monsterStrikeGrace;
    for (const player of state.players) {
      if (!player.alive || player.dashTime > 0) continue;
      if (dist(m.pos, player.pos) > reach) continue;
      const hitDir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
      if (damagePlayerHit(state, player, m.damage, { dir: hitDir, src: m })) {
        handlePlayerDeath(state, player, `${player.name} was mugged to death. The System bills the estate.`);
        break;
      }
      const steal = Math.min(player.gold, Math.round(CONFIG.cutpurseStealBase + CONFIG.cutpurseStealPerFloor * state.floor));
      if (steal > 0) {
        player.gold -= steal;
        m.carry = (m.carry ?? 0) + Math.round(steal * CONFIG.cutpurseInterest);
        if (!m.noticed) {
          m.noticed = true;
          m.speed *= 1.2; // flush with your money and FASTER for it
          state.events.push(`A cutpurse lifts ${steal} gold from ${player.name}! Catch it — it pays back with interest.`);
        }
      }
      break; // one stab per lunge
    }
    return;
  }
  if (kind === "aim") {
    // Sentinel: the lock-on beam hazard does the damage — the windup only
    // held the aiming pose. Nothing to resolve; the cooldown was paid at cast.
    return;
  }
  if (kind === "vent") {
    // Slagbreaker heat dump: a scalding cloud (burn soaks in), then the
    // machine stalls — the punish window the whole rhythm builds toward.
    const dmg = m.damage * CONFIG.slagVentDmgMult;
    for (const player of state.players) {
      if (!player.alive || player.dashTime > 0) continue;
      if (dist(m.pos, player.pos) > CONFIG.slagVentRadius) continue;
      const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
      if (damagePlayerHit(state, player, dmg, { dir, effect: "burn", src: m })) {
        handlePlayerDeath(state, player, `${player.name} stood in the exhaust. The Ironworks does not do refunds.`);
      } else {
        applyStatus(player, {
          kind: "burn", duration: CONFIG.burnDuration, school: "magic",
          magnitude: Math.max(1, Math.round((dmg * CONFIG.slagVentBurnFraction) / (CONFIG.burnDuration / CONFIG.burnTickSeconds))),
        });
        applyPlayerKnockback(player, dir, 0.6);
      }
    }
    m.heat = 0;
    m.stagger = CONFIG.slagVentSelfStagger; // vented and helpless — unload
    return;
  }
  if (kind === "hook") {
    // Vine Lasher: the whip snaps down the locked lane — anyone snagged is
    // damaged and DRAGGED to the lasher's feet, into whatever the Garden
    // (or the pack) has waiting there. Dash i-frames beat the snag.
    m.attackCooldown = CONFIG.monsterAttackCooldown * monsterTempo(state.floor).cooldown;
    const dir = m.chargeDir ?? { x: 1, y: 0 };
    m.chargeDir = undefined;
    const tip = { x: m.pos.x + dir.x * CONFIG.lasherHookRange, y: m.pos.y + dir.y * CONFIG.lasherHookRange };
    for (const player of state.players) {
      if (!player.alive || player.dashTime > 0) continue;
      // Distance from the player to the whip segment (same math as beams).
      const abx = tip.x - m.pos.x, aby = tip.y - m.pos.y;
      const lenSq = abx * abx + aby * aby;
      const t = lenSq < 1e-8 ? 0 : Math.max(0, Math.min(1, ((player.pos.x - m.pos.x) * abx + (player.pos.y - m.pos.y) * aby) / lenSq));
      const distToLane = dhypot(player.pos.x - (m.pos.x + abx * t), player.pos.y - (m.pos.y + aby * t));
      if (distToLane > CONFIG.lasherHookWidth) continue;
      const toLasher = normalize({ x: m.pos.x - player.pos.x, y: m.pos.y - player.pos.y });
      if (damagePlayerHit(state, player, m.damage * CONFIG.lasherHookDmgMult, { dir: { x: -toLasher.x, y: -toLasher.y }, src: m })) {
        handlePlayerDeath(state, player, `${player.name} took the vine express. No return service.`);
      } else {
        const gap = dist(m.pos, player.pos);
        const drag = Math.max(0, gap - CONFIG.lasherHookLandGap);
        applyPlayerKnockback(player, toLasher, drag, drag); // a PULL: full-length, uncapped
      }
    }
    return;
  }
  if (kind === "morph" && m.kind === "boss") {
    // THE TEMP's TRANSFORMATION CLAUSE (BOSSES-V2 §3.1). The clause is the
    // whole fight: burst it hard enough during the channel — or stagger the
    // channel outright — and it NEVER transforms. Two completely different
    // second halves, decided by the player, not by the HP bar.
    const denied = m.hp <= m.maxHp * (CONFIG.clauseHpFraction * 0.5);
    m.bossCount = denied ? 2 : 1;
    if (denied) {
      announce2(state, "THE CLAUSE LAPSES. It never got to become the other thing. Payroll is relieved.");
      m.speed *= 1.15; // it is furious, and that is all it has
    } else {
      m.damage *= CONFIG.clauseDmgMult;
      m.speed *= CONFIG.clauseSpeedMult;
      m.hp = Math.min(m.maxHp, m.hp + Math.round(m.maxHp * 0.1));
      announce2(state, "THE CLAUSE EXECUTES. Whatever that was, it is not a temp anymore.");
    }
    bossEvent(state, {
      kind: "telegraph", monsterId: m.id, bossId: m.bossId,
      label: denied ? "CLAUSE DENIED" : "CLAUSE EXECUTED", pos: { x: m.pos.x, y: m.pos.y },
    });
    advanceBossPhase(state, m, "mechanic");
    return;
  }

  if (kind === "morph") {
    // The Understudy's transformation clause: it BECOMES a charger — healed,
    // faster, meaner, plated. (Stagger interrupts the windup like anything
    // else; the clause just re-triggers while it's still bleeding.)
    const from = ARCHETYPES.understudy;
    const to = ARCHETYPES.charger;
    m.kind = "charger";
    m.maxHp = Math.round((m.maxHp / from.hpMult) * to.hpMult);
    m.hp = m.maxHp; // the wolf arrives FRESH
    m.damage = (m.damage / from.dmgMult) * to.dmgMult;
    m.speed = (m.speed / from.speedMult) * to.speedMult;
    m.attackRange = to.attackRange;
    m.poiseDmg = 0;
    state.announcements.push({
      text: "The extra's contract has a TRANSFORMATION CLAUSE. The crowd goes feral.",
      kind: "flavor", priority: "normal",
    });
    state.events.push("An understudy transforms — the wolf takes the role.");
    return;
  }
  if (kind === "hex") {
    // Briar Witch: mark the nearest crawler still in reach — +damage taken
    // while it holds. Whiffs if everyone slipped out of range mid-cast.
    const target = nearestPlayer(state, m.pos);
    if (target && dist(m.pos, target.pos) <= CONFIG.hexRange + 1) {
      target.cursedT = CONFIG.hexDuration;
      state.events.push(`${target.name} is MARKED by a briar witch — everything hits harder. Kill her or outlast it.`);
    }
    return;
  }
  if (kind === "consecrate") {
    // The Ruins cleric blesses the ground under its pack: contested ground
    // that mends monsters and burns crawlers (updateHazards owns the zone).
    const anchor = m.consecrateAt ?? m.pos;
    m.consecrateAt = undefined;
    state.hazards.push({
      id: state.nextEntityId++,
      pos: { x: anchor.x, y: anchor.y },
      t: CONFIG.consecrateDuration,
      total: CONFIG.consecrateDuration,
      radius: CONFIG.consecrateRadius,
      damage: Math.max(1, m.damage * CONFIG.consecrateDmgMult) || 4,
      kind: "consecrate",
      tick: CONFIG.puddleTickSeconds,
    });
    if (!m.noticed) {
      m.noticed = true;
      state.events.push("A cleric CONSECRATES the ground — it heals them and burns you. Fight outside the light.");
    }
    return;
  }
  if (kind === "sweep") {
    // The channel ended on its own; the sweeping hazard dies with the windup
    // (updateHazards watches windupKind). Nothing lands here — the beam
    // already did its work, tick by tick.
    return;
  }
  resolveMeleeStrike(state, m);
  // The Slagbreaker's swings BUILD HEAT; the third forces the vent (ai loop).
  if (m.kind === "slagbreaker") m.heat = (m.heat ?? 0) + 1;
  // The Stagehand counts its combo; the second swing cues the smoke bomb.
  if (m.kind === "stagehand") m.heat = (m.heat ?? 0) + 1;
}

/** Charger mid-rush: barrel along the locked line, clipping anyone on it once. */
function stepCharge(state: GameState, m: Monster, dt: number): void {
  m.chargeT = Math.max(0, (m.chargeT ?? 0) - dt);
  const dir = m.chargeDir ?? { x: 0, y: 0 };
  moveWithCollision(state.map, m.pos, dir, CONFIG.chargerDashSpeed * dt, isWalkable);
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue; // dash i-frames dodge the train
    if (m.chargeHits?.includes(player.id)) continue; // one clip per rush
    if (dist(m.pos, player.pos) > CONFIG.chargerHitRadius) continue;
    (m.chargeHits ??= []).push(player.id);
    const away = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    if (damagePlayerHit(state, player, m.damage, { dir: away, src: m })) {
      handlePlayerDeath(state, player, `${player.name} stood on the tracks. The charger did not brake.`);
    }
  }
  if (m.chargeT === 0) {
    m.chargeDir = undefined;
    m.chargeHits = undefined;
    m.attackCooldown = CONFIG.chargerCooldown;
  }
}

/** Spring an ambush: wake this monster and every dormant neighbor in range, all
 * surging to close, and announce it once. Hitting a dormant monster (damageMonster)
 * or revealing one ringside (maybeStartEncounter) also routes here — however the
 * trap is discovered, the whole cluster commits together. */
export function springAmbush(state: GameState, trigger: Monster): void {
  let woke = 0;
  for (const n of state.monsters) {
    if (!n.dormant || n.hp <= 0) continue;
    if (n !== trigger && dist(trigger.pos, n.pos) > CONFIG.ambushWakeRadius) continue;
    n.dormant = false;
    n.surgeT = CONFIG.ambushSurgeSeconds;
    n.attackCooldown = 0; // spring loaded — engage on the first beat
    woke++;
  }
  if (woke > 0) {
    state.announcements.push({
      text: "AMBUSH! The floor was never empty — it was waiting. The crowd LOVES this.",
      kind: "boss",
      priority: "high",
    });
  }
}

// ===========================================================================
// BOSSES V2 — THE BOSS CHASSIS
//
// The audit found ONE brain behind every named boss in the game: ~150 lines
// of `if (m.kind === "boss")` plus a `signature` enum. Adding boss #7 to that
// meant adding another `if` to the monolith, which is exactly why nobody ever
// did. So the shared parts — chase, melee, radial volley, Ground Slam, phase
// bookkeeping, hazard rain — stay shared (they were the good part), and each
// boss supplies ONE ability block keyed off its `bossId`, the same shape the
// trash kinds already use.
// ===========================================================================

interface BossCtx {
  d: number; // distance to the hunted target
  hunt: Player;
  toPlayer: Vec2;
  windup: number; // the floor's depth-scaled base windup
  moveSpeed: number;
  /** This step's dt. Kits that run a clock of their own need it, and a kit
   *  that hardcodes 1/60 is a kit that behaves differently on the server. */
  dt: number;
}

/** A per-boss ability block. Returns true if it committed the step. */
type BossKit = (state: GameState, m: Monster, ctx: BossCtx) => boolean;

/**
 * Cast a band signature THROUGH `m.signature` (acceptance r5, major).
 *
 * RETROFIT's whole promise is "its signature is another band's — a familiar
 * boss with an unfamiliar telegraph", and it mutates exactly one field:
 * `m.signature` (applyBossDraw). The Furnace Marshal's kit called
 * `bossFlameSweep` and `bossDebrisRain` BY NAME and never read that field, so
 * one capture held the contradiction in a single frame — the RETROFIT chip on
 * the name card over a beat line reading FLAME SWEEP. Every kit that fires a
 * band signature routes here now, so a retrofitted boss really does telegraph
 * somebody else's mechanic and the label follows it (bandSignatureLabel keys
 * off the signature, so the fight even has its own WORD for the borrowed one).
 */
function castBandSignature(
  state: GameState, m: Monster, sig: NonNullable<Monster["signature"]>,
): void {
  if (sig === "flood") bossFloodSurge(state, m);
  else if (sig === "roots") bossRootGrasp(state, m);
  else if (sig === "debris") bossDebrisRain(state, m);
  else if (sig === "flamewall") bossFlameSweep(state, m);
  else bossGraveRaise(state, m);
}

/** How many tethered adds are still feeding this boss (V8). */
function liveTethers(state: GameState, boss: Monster): number {
  let n = 0;
  for (const o of state.monsters) {
    if (o.hp > 0 && o.tetherId === boss.id && dist(o.pos, boss.pos) <= CONFIG.tetherRange) n++;
  }
  return n;
}

/**
 * Every roster id must appear here. `bosses.test.ts` asserts it: the round-3
 * acceptance review found the Topiary Warden and the Furnace Marshal — a
 * headline break-the-shield and a headline burst-the-window — falling through
 * to the bare chassis with a band-generic beat line, and nothing in the build
 * said so. A missing kit is now a failing test, not a screenshot.
 */
export const BOSS_KITS: Record<BossId, BossKit> = {
  // THE CRYPT CONCIERGE — ask: kill-the-adds. Its risen FEED it (tethered in
  // bossGraveRaise). Clear the ledger and it panics into a long
  // reconciliation: the mechanic phase, and the punish window.
  concierge(state, m, ctx) {
    // THE LEDGER EMPTIES AGAIN, AND AGAIN (r5 major). Gated on the phase
    // counter this fired exactly once per fight and then never — but the
    // ledger REFILLS every time it checks someone in, so the beat the player
    // earns by clearing it has to be repeatable. Bounded by the punish
    // recovery clock, which is the same beat's own cooldown.
    if ((m.bossCount ?? 0) > 0 && liveTethers(state, m) === 0 && !m.punishArmed &&
        (m.punishCd ?? 0) <= 0) {
      m.punishArmed = true;
      announce2(state, "THE LEDGER IS EMPTY. The Concierge has to RECONCILE, and it cannot do that and fight.");
      bossMechanicBeat(state, m);
      return true;
    }
    // RING FOR SERVICE. The audit's finding on this boss was that with no
    // bodies down it committed 62 melee windups and NOTHING ELSE across 90
    // measured seconds — its whole identity was conditional on the crowd
    // having died first. The bell does not care: no corpse in reach means it
    // checks in STAFF instead, and the staff are tethered like everything else.
    if (
      (m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.monsterAggroRange * 2.5 &&
      !state.corpses.some((c) => dist(m.pos, c.pos) <= CONFIG.graveRaiseRange)
    ) {
      m.sigCd = CONFIG.graveRaiseCooldown;
      m.heat = (m.heat ?? 0) + 1;
      beginBossWindup(state, m, "raise", CONFIG.graveRaiseWindup, "RING FOR SERVICE");
      return true;
    }
    return false;
  },

  // THE RENT COLLECTOR — ask: burst-the-window. Late Fee opens the lockbox
  // plate for a fixed window; break it and the party is refunded with
  // interest. Target-switch under a clock.
  rentcollector(state, m, ctx) {
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.monsterAggroRange * 2) {
      m.sigCd = CONFIG.lateFeeCooldown;
      m.heat = (m.heat ?? 0) + 1;
      beginBossWindup(state, m, "latefee", CONFIG.lateFeeWindup, "LATE FEE");
      return true;
    }
    return false;
  },

  // THE TEMP — ask: burst-the-window (the THRESHOLD variant). One channel,
  // one decision, two completely different second halves.
  temp(state, m, ctx) {
    if ((m.bossCount ?? 0) === 0 && m.hp <= m.maxHp * CONFIG.clauseHpFraction) {
      beginBossWindup(state, m, "morph", CONFIG.clauseWindup, "TRANSFORMATION CLAUSE");
      announce2(state, "THE TEMP IS INVOKING ITS CLAUSE. Break it NOW, or meet whatever has been under there.", "high");
      return true;
    }
    // OVERREACH — the tape measure goes out down a locked lane and DRAGS
    // whoever is standing in it (the shipped lasher hook at boss scale). A
    // boss that only swings until a threshold is a boss with no verb for the
    // whole first half, which is precisely the audit's complaint about floor 3.
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.lasherHookRange) {
      m.sigCd = CONFIG.lateFeeCooldown * ((m.bossCount ?? 0) === 1 ? 0.6 : 1);
      m.heat = (m.heat ?? 0) + 1;
      m.chargeDir = ctx.toPlayer; // the lane is frozen NOW; the windup is the dodge
      beginBossWindup(state, m, "hook", ctx.windup * 1.4, "OVERREACH");
      return true;
    }
    return false;
  },

  // THE SANITATION INSPECTOR — ask: dodge-the-lane. Citations condemn the
  // ground they cross, so clean floor is a resource you SPEND.
  inspector(state, m, ctx) {
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.citationLength) {
      m.sigCd = CONFIG.citationCooldown;
      m.heat = (m.heat ?? 0) + 1;
      bossCitation(state, m);
      return true;
    }
    return false;
  },

  // THE GREASE TRAP — ask: kill-the-adds, around a boss that never moves. It
  // pulls you in; its tethered spawn shove you back. Break the chain and the
  // pit INVERTS, exposing its core for a long punish window.
  greasetrap(state, m, ctx) {
    if ((m.bossCount ?? 0) >= CONFIG.greaseInvertAfter && !m.plates) {
      bossExposeCore(state, m, "trap_core", "THE TRAP CORE", CONFIG.greaseInvertWindow);
      advanceBossPhase(state, m, "mechanic");
      return true;
    }
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.greasePullRange) {
      m.sigCd = CONFIG.greasePullCooldown / (1 + (m.phase ?? 0) * 0.5);
      m.heat = (m.heat ?? 0) + 1;
      beginBossWindup(state, m, "pull", CONFIG.bossPunishWindup, "THE PIT PULLS");
      return true;
    }
    if ((m.affixCd ?? 0) === 0 && liveTethers(state, m) < 5) {
      m.affixCd = CONFIG.greaseAddCooldown;
      for (let i = 0; i < CONFIG.greaseAddsPerWave; i++) {
        const a = (i / CONFIG.greaseAddsPerWave) * Math.PI * 2 + (m.bossCount ?? 0);
        makeBossAdd(state, m, "swarmer", {
          x: m.pos.x + dcos(a) * 1.6, y: m.pos.y + dsin(a) * 1.6,
        }, true);
      }
    }
    return false;
  },

  // THE SUMP KING — ask: use-the-arena. The audit round found this boss running
  // the BARE CHASSIS: its `prop: "drain"` was authored in the roster and never
  // fired, so the headline use-the-arena fight was a generic ring in an empty
  // room. The gates are now the whole verb — they vent, they aim, and killing
  // them is what ends the fight (fireArenaProp beaches him on the last one).
  sumpking(state, m, ctx) {
    const gates = (state.breakables ?? []).reduce(
      (n, b) => n + (b.onBreak === "drain" && b.hp > 0 ? 1 : 0), 0);
    // BEACHED: the mechanic phase, caused entirely by the player's routing.
    if (gates === 0 && (m.bossCount ?? 0) === 0 && (state.breakables ?? []).some((b) => b.onBreak === "drain")) {
      m.bossCount = 1;
      m.punishArmed = true;
      announce2(state, "THE LAST GATE IS DOWN AND THE LEVEL IS GONE. The King is sitting in a dry pit. Go.");
      advanceBossPhase(state, m, "mechanic");
      return true;
    }
    // THE OFF-BEAT. The King's band signature (FLOOD SURGE) still opens every
    // fight and still owns the `sigCd` track untouched — the sluices vent in
    // the GAP between surges, so the rhythm is surge / sluice / surge and the
    // two ground verbs never land on the same frame.
    if (
      gates > 0 && (m.sigCd ?? 0) > 0 && (m.affixCd ?? 0) === 0 &&
      ctx.d <= CONFIG.monsterAggroRange * 2.5
    ) {
      m.affixCd = CONFIG.sluiceCooldown / (1 + (m.phase ?? 0) * 0.3);
      m.heat = (m.heat ?? 0) + 1;
      bossSluice(state, m);
      return true;
    }
    return false;
  },

  // THE PERMIT OFFICE — ask: break-the-shield. Same audit finding: four
  // authored stamps and NO verb, so the plates were sub-HP bars you could
  // ignore. STOP-WORK ORDER makes the plate row the attack pattern — one lane
  // per unbroken stamp — so a stamp you break is a lane that stops existing.
  permitoffice(state, m, ctx) {
    const live = (m.plates ?? []).filter((p) => !p.broken).length;
    // Out of stamps: the Office cannot issue anything and has to re-file.
    if (live === 0 && (m.plates?.length ?? 0) > 0 && !m.punishArmed && (m.bossCount ?? 0) === 0) {
      m.bossCount = 1;
      m.punishArmed = true;
      announce2(state, "EVERY STAMP IS BROKEN. The Office has no authority left and has to RE-FILE. Unload.");
      return true;
    }
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.bossArenaSize / 2) {
      // Fewer stamps = fewer lanes, so the order comes ROUND faster: the fight
      // stays dangerous while visibly rewarding the break. Mechanics, not stats.
      m.sigCd = CONFIG.stopWorkCooldown * (0.6 + 0.1 * live);
      m.heat = (m.heat ?? 0) + 1;
      bossStopWork(state, m);
      return true;
    }
    return false;
  },

  // THE TOPIARY WARDEN — ask: break-the-shield, and now it HAS one.
  //
  // Round 3 acceptance: this entry was four lines of passive shield trickle and
  // a `return false`, so one of only three break-the-shield bosses fell through
  // to the shared chassis and announced the band-generic ENTANGLING ROOTS. A
  // fight with no verb of its own is a reskin, which is the one thing the
  // roster rule forbids.
  //
  // HEDGE REGROWTH is the verb: below the regrow threshold the Warden CHANNELS
  // its wall back up. Stagger it (poise, same as every channel in the game) and
  // the pool stays broken and the fight ends; let it land and the pool is back
  // AND the hedge is standing on you. Past the first phase the channel comes
  // round faster — the window tightens, the numbers do not grow.
  topiary(state, m, ctx) {
    const pool = m.shieldMax ?? 0;
    if (
      pool > 0 && (m.shieldHp ?? 0) <= pool * CONFIG.hedgeRegrowAt &&
      (m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.monsterAggroRange * 2.5
    ) {
      m.sigCd = CONFIG.hedgeRegrowCooldown / (1 + (m.phase ?? 0) * 0.35);
      m.heat = (m.heat ?? 0) + 1;
      beginBossWindup(state, m, "regrow", CONFIG.hedgeRegrowWindup, "HEDGE REGROWTH");
      if (!m.sigUsed) {
        m.sigUsed = true;
        announce2(state, "THE HEDGE IS GROWING BACK. That is the entire threat — break the channel or break the pool, but pick one.", "high");
      }
      return true;
    }
    // THE HEDGE IS DOWN AND STAYING DOWN. The player won the regrow race, so
    // the fight advances on their play, not on their damage (§2.2's rule that
    // at least one phase edge per fight is mechanic-triggered).
    // ...and it can happen AGAIN (r5 major): the hedge regrows, so winning the
    // regrow race is a repeatable achievement and the beat that acknowledges
    // it used to fire once per fight. Bounded by the punish recovery clock.
    if (pool > 0 && (m.shieldHp ?? 0) <= 0 && !m.punishArmed && (m.punishCd ?? 0) <= 0) {
      m.bossCount = (m.bossCount ?? 0) + 1;
      m.punishArmed = true;
      announce2(state, "THE HEDGE IS GONE AND IT CANNOT GROW IT BACK IN TIME. Nothing between you and the Warden. Prune it.");
      bossMechanicBeat(state, m);
      return true;
    }
    return false;
  },

  // THE ZONING BOARD / THE STANDARDS BOARD — ask: kill-the-adds (the kill-ORDER
  // variant). The aides shield the body and each death hands its verb over
  // (reapDead), so killing the wrong one first makes the fight worse. The kit
  // itself is quiet: the aides ARE the mechanic.
  zoningboard(state, m, ctx) {
    const seats = liveTethers(state, m);
    if (seats === 0) {
      if ((m.bossCount ?? 0) === 0) {
        m.bossCount = 1;
        m.bossTimer = CONFIG.boardReconveneDelay;
        announce2(state, "THE BOARD IS ADJOURNED. It has every verb they had, and nobody left to hide behind.");
        advanceBossPhase(state, m, "mechanic");
        return true;
      }
      // ...AND IT RECONVENES (r5). The format's mechanic-completion edge fired
      // exactly once and a 9,000-step driven hunt at 30% HP found no second
      // one — so the beat §2.2 requires ("the player's play advances the
      // story") existed for one moment of one fight. Clearing the board now
      // refills it, one chair fewer each session, behind the same COMMERCIAL
      // BREAK. The last session is a genuine one-on-one.
      m.bossTimer = Math.max(0, (m.bossTimer ?? 0) - ctx.dt);
      if ((m.bossTimer ?? 0) <= 0 && (m.bossCount ?? 1) < CONFIG.boardSessions) {
        const refill = Math.max(1, 3 - (m.bossCount ?? 1));
        m.bossCount = (m.bossCount ?? 1) + 1;
        m.bossTimer = CONFIG.boardReconveneDelay;
        bossReconvene(state, m, refill);
        return true;
      }
    }
    // SETBACK REQUIRED — its OWN verb, and the census said it had none: 0%
    // identity share over 75s, with a renamed borrowed band hazard standing in
    // for the Board's mechanic. Every seated member owns the ground around its
    // own chair, so the kill order becomes a route rather than a list.
    if (seats > 0 && (m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.bossArenaSize) {
      m.sigCd = CONFIG.setbackCooldown / (1 + (m.phase ?? 0) * 0.3);
      m.heat = (m.heat ?? 0) + 1;
      bossSetback(state, m);
      return true;
    }
    return false;
  },

  // THE POLLINATOR — ask: survive-the-storm. Pods seed pods. Clear the garden
  // and it WILTS (mechanic phase + punish window); ignore it and drown in it.
  pollinator(state, m, ctx) {
    const pods = state.hazards.reduce((n, h) => n + (h.kind === "spore" ? 1 : 0), 0);
    if ((m.bossCount ?? 0) > 0 && pods === 0 && !m.punishArmed && (m.punishCd ?? 0) <= 0) {
      m.punishArmed = true;
      announce2(state, "THE GARDEN IS CLEAR. It WILTS. This is the window you bought.");
      bossMechanicBeat(state, m);
      return true;
    }
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.monsterAggroRange * 2.5) {
      m.sigCd = CONFIG.bloomCooldown / (1 + (m.phase ?? 0) * 0.35); // escalates on the clock
      m.bossCount = (m.bossCount ?? 0) + 1;
      m.heat = (m.heat ?? 0) + 1;
      beginBossWindup(state, m, "bloom", CONFIG.bossPunishWindup, "BLOOM");
      return true;
    }
    return false;
  },

  // THE CONDEMNED ARCHITECT — ask: use-the-arena. Its debris eats your COVER
  // for real (shipped breakables + SMASH_KINDS, zero new verbs). When the
  // cover runs out it starts a Controlled Demolition: POSITIONAL phase, an
  // interrupt stake, and a punish window if you win it.
  // ...r6 BLOCKER: it was WAITING for the cover to be gone. `cover <= 2` was
  // its only branch, a fight never destroyed that much cover on its own, and
  // the ablation measured the whole encounter byte-identical with the kit
  // deleted (0% damage delta, 48/48 hazards, the same four labels). A
  // use-the-arena boss whose verb never fires is the chassis wearing a name.
  // The demolition is on a CLOCK now and it takes the cover down itself.
  architect(state, m, ctx) {
    const cover = (state.breakables ?? []).reduce(
      (n, b) => n + (b.footprint && !b.onBreak && b.hp > 0 ? 1 : 0), 0);
    // NOTHING LEFT TO HIDE BEHIND — the positional edge, now genuinely
    // reachable because the boss is the thing that got it there.
    if (cover <= 2 && !m.bossCount && ctx.d <= CONFIG.ritualRange) {
      m.bossCount = 1;
      advanceBossPhase(state, m, "positional");
      beginBossWindup(state, m, "ritual", CONFIG.ritualWindup, "CONTROLLED DEMOLITION");
      announce2(state, "NOTHING LEFT TO HIDE BEHIND. CONTROLLED DEMOLITION — stagger it or wear the building.", "high");
      return true;
    }
    // ON THE OFF-BEAT, like the Sump King's sluices: the band signature keeps
    // `sigCd` (DEBRIS RAIN is still the room coming down on you) and the
    // demolition fires in the GAP between rains, so the two ground verbs never
    // land on the same frame and the rain's own test still holds.
    if (
      (m.sigCd ?? 0) > 0 && (m.affixCd ?? 0) === 0 &&
      ctx.d <= CONFIG.monsterAggroRange * 2.5
    ) {
      m.affixCd = CONFIG.architectDemoCooldown / (1 + (m.phase ?? 0) * 0.3);
      m.heat = (m.heat ?? 0) + 1;
      bossDemolition(state, m);
      return true;
    }
    return false;
  },

  // THE FOUNDATION — ask: dodge-the-lane. Fissure fans, then radial fissures:
  // wedge-shaped safe ground, then pick a gap and COMMIT.
  foundation(state, m, ctx) {
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.monsterAggroRange * 2.5) {
      m.sigCd = CONFIG.foundationCooldown;
      m.heat = (m.heat ?? 0) + 1;
      beginBossWindup(state, m, "slam", CONFIG.bossSlamWindup, "FISSURE");
      return true;
    }
    return false;
  },

  // THE FURNACE MARSHAL — ask: burst-the-window. Round 3 acceptance found this
  // one missing outright: a headline burst-the-window boss with no kit, whose
  // own epithet ("Three sweeps, then it has to breathe. Count with me.")
  // promised a count nothing in the code was keeping.
  //
  // So the COUNT is the kit. Each wall of fire stokes the furnace; the third
  // forces the vent, which is a real self-stagger and the fight's whole rhythm
  // — count, dodge, unload. The arena's wall vents (`prop: "vent"`) can force
  // it EARLY, which is the player moving the beat instead of waiting for it.
  marshal(state, m, ctx) {
    // THAT WAS THREE. The furnace has to breathe, on its own count.
    if ((m.bossCount ?? 0) >= CONFIG.marshalSweepsPerVent) {
      m.bossCount = 0;
      m.punishArmed = true; // the chassis opens the window on the next step
      announce2(state, "THAT WAS THREE. THE FURNACE HAS TO BREATHE — and it cannot do that and fight.", "high");
      return true;
    }
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.monsterAggroRange * 2.5) {
      // The sweep is the band signature, fired BY the kit so the count is the
      // Marshal's own — heat stays out of it deliberately, because two clocks
      // running the same window is exactly how a rhythm stops being readable.
      m.sigCd = CONFIG.marshalSweepCooldown / (1 + (m.phase ?? 0) * 0.25);
      // SIGNATURE STACKING (boss layer 2) is KEPT, and it is kept honest: from
      // phase 1 the Marshal alternates its wall with the band below it, and a
      // BORROWED cast is not a sweep, so it never advances the count. The count
      // the epithet promises is a count of its OWN fire, which is the only way
      // "three sweeps, then it has to breathe" survives the escalation.
      // RETROFIT-AWARE (r5): the sweep is `m.signature`, not the literal
      // bossFlameSweep — so a retrofitted Marshal really does fight with
      // another band's telegraph, and its COUNT counts whatever its own wall
      // has become. The borrowed alternate is still the band below whatever
      // it is wearing, so the escalation reads the same either way.
      const own = m.signature ?? "flamewall";
      if ((m.phase ?? 0) >= 1 && (m.sigAlt = !m.sigAlt)) {
        castBandSignature(state, m, BORROWED[own] ?? "debris");
        return true;
      }
      m.bossCount = (m.bossCount ?? 0) + 1;
      m.heat = (m.heat ?? 0) + 1; // its OWN verb feeds its OWN count (V4)
      castBandSignature(state, m, own);
      return true;
    }
    return false;
  },

  // THE LINE SUPERVISOR — ask: kill-the-adds. The conveyors are the fight;
  // the Supervisor is a paperwork problem behind them.
  linesupervisor(state, m, ctx) {
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.monsterAggroRange * 2.5) {
      m.sigCd = CONFIG.conveyorCooldown;
      m.heat = (m.heat ?? 0) + 1;
      beginBossWindup(state, m, "summon", CONFIG.summonWindup, "PRODUCTION QUOTA");
      return true;
    }
    return false;
  },

  // THE SAFETY OFFICER — ask: survive-the-storm. Lanes that arm IN SEQUENCE,
  // so the arena becomes moving safe cells. Read the order; move early.
  safetyofficer(state, m, ctx) {
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.monsterAggroRange * 2.5) {
      m.sigCd = CONFIG.latticeCooldown;
      m.heat = (m.heat ?? 0) + 1;
      bossLattice(state, m);
      return true;
    }
    return false;
  },

  // THE SHOWRUNNER — ask: use-the-arena. Every phase RE-DRESSES the set into
  // a band you have already beaten, behind an intermission. The whole run was
  // the tutorial, and this is the exam.
  showrunner(state, m, ctx) {
    // The set change is the PHASE beat and stays one-shot per phase; it moved
    // off `bossTimer` because CAMERA MOVE now owns that counter as its cue
    // number (r5 — two beats sharing one scratch field is how the finale ended
    // up with four telegraphs in seventy-five seconds).
    if ((m.bossCount ?? -1) !== (m.phase ?? 0)) {
      m.bossCount = m.phase ?? 0;
      bossShowSetChange(state, m);
      return true;
    }
    // CAMERA MOVE — the finale's own recurring verb. 7% identity share
    // measured; the kit returned false every other step and the shared chassis
    // ran the whole fight. Its ask is USE-THE-ARENA, so the arena is the verb.
    // ON ITS OWN TRACK (r6 blocker). Shipped, CAMERA MOVE spent `sigCd` — the
    // same counter the band signature uses — so every cue the Showrunner
    // called DELETED a band signature that would otherwise have fired, and the
    // ablation measured the finale's own kit making its fight 146% SAFER than
    // the bare chassis. A boss's identity may add to the fight; it must not
    // buy itself out of the fight. Same off-beat pattern as the Sump King's
    // sluices and the Architect's demolition: the cue fires in the GAP.
    if ((m.sigCd ?? 0) > 0 && (m.affixCd ?? 0) === 0 && ctx.d <= CONFIG.bossArenaSize) {
      m.affixCd = CONFIG.showrunnerCueCooldown / (1 + (m.phase ?? 0) * 0.25);
      m.heat = (m.heat ?? 0) + 1;
      bossShotList(state, m);
      return true;
    }
    return false;
  },

  // THE SPONSOR — ask: break-the-shield. Brand Integration flips which school
  // its shield accepts at every phase and refills it. Diablo's "immune to X"
  // in a sponsorship jacket: adapt the rotation, never change genre.
  sponsor(state, m, ctx) {
    if ((m.bossTimer ?? -1) !== (m.phase ?? 0)) {
      m.bossTimer = m.phase ?? 0;
      m.shieldSchool = (m.phase ?? 0) % 2 === 0 ? "physical" : "magic";
      m.shieldHp = m.shieldMax ?? 0;
      announce2(state, `BRAND INTEGRATION: this segment is sponsored by ${m.shieldSchool === "physical" ? "STEEL" : "SORCERY"}. Nothing else scratches it.`, "high");
      bossEvent(state, {
        kind: "telegraph", monsterId: m.id, bossId: m.bossId,
        label: `BRAND: ${m.shieldSchool.toUpperCase()}`, pos: { x: m.pos.x, y: m.pos.y },
      });
      return true;
    }
    // BRAND ACTIVATION — the finale's own recurring verb. Measured identity
    // share before this: 3%, the worst in the roster, on the last boss in the
    // game. The placements are tethered, they pump the pool, and they are the
    // reason break-the-shield finally has somewhere else to look.
    const live = liveTethers(state, m);
    if (live < CONFIG.sponsorPylons && (m.affixCd ?? 0) === 0 && ctx.d <= CONFIG.bossArenaSize) {
      m.affixCd = CONFIG.sponsorPylonCooldown;
      m.heat = (m.heat ?? 0) + 1;
      bossBrandActivation(state, m);
      return true;
    }
    // CROSS-PROMOTION — the beat on the clock. Without it the Sponsor's only
    // verbs were a phase-edge school flip and a placement drop gated on the
    // player having cleared the last one, so a party that ignored the pylons
    // saw the finale commit nothing of its own for the whole fight.
    if ((m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.bossArenaSize) {
      m.sigCd = CONFIG.sponsorSpotCooldown / (1 + (m.phase ?? 0) * 0.25);
      m.heat = (m.heat ?? 0) + 1;
      bossCrossPromotion(state, m);
      return true;
    }
    // While a placement stands the pool refills faster than a correct-school
    // rotation strips it: the shield is not the ask on its own, the ORDER is.
    if (live > 0 && (m.shieldMax ?? 0) > 0 && (m.shieldRegenT ?? 0) <= 0) {
      m.shieldHp = Math.min(m.shieldMax!,
        (m.shieldHp ?? 0) + m.shieldMax! * CONFIG.shieldRegenPerSec *
          (CONFIG.sponsorPylonRegenMult - 1) * ctx.dt);
    }
    return false;
  },
  // THE STANDARDS AND PRACTICES BOARD — ask: kill-the-adds (the finale of the
  // council format). It used to BE the Zoning Board — the floor-18 entry was an
  // ALIAS assignment onto the floor-9 kit OBJECT, i.e. the same function by
  // reference, which is the reskin the anti-reskin rule exists to forbid. A
  // finale must ESCALATE its format, not alias it.
  //
  // The escalation is that the Board is not quiet behind its aides — it FIRES
  // THROUGH them. Every living aide is the muzzle of a lane that runs through
  // the body and out the far side, so there is no safe pocket behind the
  // Board and the kill order rewrites the floor instead of only the verb list.
  // Adjourned, it stops delegating and channels its own FINAL RULING.
  standards(state, m, ctx) {
    const aides = liveTethers(state, m);
    if (aides === 0 && (m.bossCount ?? 0) === 0) {
      m.bossCount = 1;
      m.punishArmed = true; // it has to poll ITSELF, and that takes a moment
      announce2(state, "THE BOARD IS ADJOURNED. No seats, no quorum, and every verb they had is now its problem.", "high");
      advanceBossPhase(state, m, "mechanic");
      return true;
    }
    // IN SESSION: the motion is the fight while any seat is filled.
    if (aides > 0 && (m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.citationLength) {
      m.sigCd = CONFIG.motionCooldown / (1 + (m.phase ?? 0) * 0.25);
      m.heat = (m.heat ?? 0) + 1;
      bossMotion(state, m);
      return true;
    }
    // ADJOURNED, final phase: it rules on you directly. A long channel with an
    // interrupt stake — the finale's version of "stagger it or wear it".
    if ((m.bossCount ?? 0) === 1 && (m.phase ?? 0) >= 2 && (m.ritualCd ?? 0) === 0 && ctx.d <= CONFIG.ritualRange) {
      m.ritualCd = CONFIG.ritualCooldown;
      m.heat = (m.heat ?? 0) + 1;
      beginBossWindup(state, m, "ritual", CONFIG.ritualWindup, "FINAL RULING");
      announce2(state, "THE BOARD IS PREPARING ITS FINAL RULING. Interrupt it, or be found broadly unacceptable.", "high");
      return true;
    }
    // Adjourned but not yet final: it still signs motions, from every side.
    if ((m.bossCount ?? 0) === 1 && (m.sigCd ?? 0) === 0 && ctx.d <= CONFIG.citationLength) {
      m.sigCd = CONFIG.motionCooldown * 0.8;
      m.heat = (m.heat ?? 0) + 1;
      bossMotion(state, m);
      return true;
    }
    return false;
  },
};

/**
 * The tier-3 channel used to announce itself as "DARK RITUAL" for every boss
 * that had one, which put ONE generic label on three different finales at
 * once — the capture round caught all three finale shots carrying the same
 * magenta disc under the same word. The channel is shared (it is chassis), but
 * the NAME is identity, so each boss that can commit one owns its own.
 */
const RITUAL_LABEL: Partial<Record<BossId, string>> = {
  concierge: "LAST CALL",
  greasetrap: "THE DRAIN OPENS",
  topiary: "HARD PRUNE",
  zoningboard: "EXECUTIVE SESSION",
  pollinator: "SEED HEAD",
  architect: "CONTROLLED DEMOLITION",
  permitoffice: "FINAL NOTICE",
  foundation: "LOAD TEST",
  marshal: "FULL BURN",
  linesupervisor: "MANDATORY OVERTIME",
  safetyofficer: "FULL COMPLIANCE",
  showrunner: "SET STRIKE",
  standards: "FINAL RULING",
  sponsor: "AD BREAK",
};

/** Signatures a band boss ALTERNATES with from phase 1 (boss layer 2). */
const BORROWED: Partial<Record<NonNullable<Monster["signature"]>, Monster["signature"]>> = {
  flood: "graverising", roots: "flood", debris: "roots", flamewall: "debris",
};

/**
 * V5 — HARD ENRAGE, on the SEGMENT's clock (r5).
 *
 * Lifted out of `stepBoss` because `stepBoss` is not reached while the boss is
 * staggered, mid-windup or lifted out by an intermission — so the deadline was
 * measuring "seconds the boss spent swinging" rather than "seconds this
 * segment has been on air", which is what OVERTIME is a mutator about. With
 * the r5 punish rework opening genuine windows, the drift was several seconds
 * a minute and the mutator's own test could not reach two stacks in twenty-one.
 */
function tickBossEnrage(state: GameState, m: Monster, dt: number): void {
  if (!m.introduced) return;
  m.fightT = (m.fightT ?? 0) + dt;
  const deadline = CONFIG.bossEnrageDeadline *
    (m.bossMutators?.includes("overtime") ? CONFIG.mutatorOvertimeFraction : 1);
  const over = (m.fightT ?? 0) - deadline;
  if (over <= 0) return;
  const want = Math.min(CONFIG.bossEnrageMaxStacks, 1 + Math.floor(over / CONFIG.bossEnrageStackSeconds));
  while ((m.enrageStacks ?? 0) < want) {
    m.enrageStacks = (m.enrageStacks ?? 0) + 1;
    m.damage *= 1 + CONFIG.bossEnrageDmgPerStack;
    bossEvent(state, {
      kind: "enrage", monsterId: m.id, bossId: m.bossId, value: m.enrageStacks,
      pos: { x: m.pos.x, y: m.pos.y },
    });
    if (m.enrageStacks === 1) {
      announce2(state, "The System is LOSING PATIENCE with this segment. Finish it, Crawlers.", "high");
    }
  }
}

/**
 * THE CHASSIS. Order is the order the player experiences it: intermission,
 * then the fight-length clock, then the sustain layers (shield regen, tether
 * feed), then the punish window, then this boss's OWN verb, and only then the
 * shared kit (signature, ritual, slam, hazard rain, chase/melee/volley).
 */
function stepBoss(state: GameState, m: Monster, dt: number, ctx: BossCtx): void {
  const { d, hunt, toPlayer, windup } = ctx;

  // V6 — INTERMISSION. Untargetable and inert while the arena re-deals.
  if ((m.invulnT ?? 0) > 0) {
    m.invulnT = Math.max(0, (m.invulnT ?? 0) - dt);
    return;
  }

  // V2 — the shield pool regrows once it has been left alone (the regen GAP
  // is the whole counterplay: burst it inside the window, or start over).
  if ((m.shieldMax ?? 0) > 0) {
    if ((m.shieldRegenT ?? 0) > 0) m.shieldRegenT = Math.max(0, (m.shieldRegenT ?? 0) - dt);
    else if ((m.shieldHp ?? 0) < (m.shieldMax ?? 0)) {
      m.shieldHp = Math.min(m.shieldMax!, (m.shieldHp ?? 0) + m.shieldMax! * CONFIG.shieldRegenPerSec * dt);
    }
  }

  // V8 — tethered adds FEED it. Ignoring the wave stalls the fight.
  // The feed is CAPPED at four cords: the ask is "handle the wave", not "out-
  // heal an unbounded stack" — an uncapped Concierge simply never dies.
  // ...AND A CORD FEEDS ONE THING (r6 blocker). The Sponsor's placements were
  // pumping the SHIELD POOL (their stated job), reducing body damage through
  // the council's shield tax, AND healing the body on this shared chassis
  // line — three anchors on one boss. Measured: 230 sim-seconds of a
  // fully-kitted crawler left the last boss in the game at 34,000 / 34,000 HP,
  // i.e. exactly full, because the tether heal alone out-paced everything that
  // got through the school lock. A boss with a shield POOL has its cords
  // feeding that pool; the body is the player's to take.
  const tethers = Math.min(4, liveTethers(state, m));
  if (tethers > 0 && m.hp < m.maxHp && !(m.shieldMax ?? 0)) {
    const heal = m.maxHp * CONFIG.tetherHealPerSec * tethers * dt;
    m.hp = Math.min(m.maxHp, m.hp + heal);
  }

  // SPONSORED (mutator): it defends a spot. Remember where the bubble is the
  // first time it acts — pulling the fight OFF that ground is the counterplay.
  if (m.bossMutators?.includes("sponsored") && !m.home) {
    m.home = { x: m.pos.x, y: m.pos.y };
  }

  // Phase HP gates (the shipped 2/3 and 1/3). Mechanic, timer and positional
  // triggers live in the kits and share this same counter.
  const frac = m.hp / m.maxHp;
  const wantPhase = frac <= 1 / 3 ? 2 : frac <= 2 / 3 ? 1 : 0;
  while ((m.phase ?? 0) < Math.min(wantPhase, m.maxPhase ?? 2)) {
    if (!advanceBossPhase(state, m, "hp")) break;
  }

  // UNDERSTUDIED (mutator): its armour comes back ONCE, at half health — the
  // break-window happens twice, so the skill is repeated, not the stat.
  if (m.bossMutators?.includes("understudied") && !m.tetherRevived && frac <= 0.5) {
    m.tetherRevived = true;
    if (m.plates) for (const pl of m.plates) { pl.broken = false; pl.hp = pl.maxHp; }
    if ((m.shieldMax ?? 0) > 0) { m.shieldHp = m.shieldMax; m.shieldRegenT = 0; }
    // ...AND IT COMES BACK SHARPER (r5, measured). Shipped, the understudy's
    // second armour measured MILDER than no mutator at all on the Topiary
    // Warden (-13% hazards, boss ending at 24% against 41% clean) — because
    // handing a break-the-shield boss its pool back mostly hands the player a
    // second free break window. A repeated ask has to be a repeated ASK: the
    // stand-in resets its own verb and takes the phase-edge step-up, so the
    // second window is fought for at the tempo of the fight it interrupts.
    m.sigCd = 0;
    m.speed *= CONFIG.bossPhaseSpeedMult;
    announce2(state, "THE UNDERSTUDY STEPS IN. It is wearing the armour again, and it has been watching. Do that again.");
  }

  // V4 — THE PUNISH WINDOW, and it is now something the player CAUSES.
  //
  // r5 blocker: this fired off a shared `m.heat` that every slam, ritual and
  // hazard tick incremented, at one threshold, with one label, on all eighteen
  // bosses — 21 windows and 44.7 helpless seconds out of 75 on The Pollinator.
  // Three things changed and they are all here or in bossPunishRule:
  //   * only the boss's OWN verbs and the player's own reads feed the count
  //     (the chassis feeds nothing — see the deleted `m.heat++` lines below),
  //   * the count and the WORD are per boss (BOSS_PUNISH),
  //   * and a window cannot come round again inside bossPunishRecovery, so a
  //     boss is never helpless for most of its own fight.
  // A kit-armed window (the Marshal's own three-sweep count, the Concierge's
  // empty ledger) is a MECHANIC the player completed and skips the cooldown:
  // that path was always the model, and it is never rate-limited.
  if ((m.punishCd ?? 0) > 0) m.punishCd = Math.max(0, (m.punishCd ?? 0) - dt);
  const rule = bossPunishRule(m.bossId);
  // ---- THE WINDOW HAS A CEILING NOW, NOT ONLY A FLOOR (r7 major) -----------
  //
  // Measured over 6 seeds each: The Temp opens 0.3 windows per fight (NO WINDOW
  // AT ALL in 4 of 6) and The Rent Collector 0.5 (none in 3 of 6), against the
  // Furnace Marshal at **8.5 per fight** and the Sponsor at 5.2 — a 28x spread
  // on the beat §7.4 calls the one that most needs to read. `bossPunishRecovery`
  // is a FLOOR on frequency with no ceiling, so a boss whose kit commits often
  // (and the Marshal's epithet is literally a COUNT: "three sweeps, then it has
  // to breathe") opens one every nine seconds forever and the beat stops being
  // a moment.
  //
  // Two symmetrical corrections, both about the beat happening a LEARNABLE
  // number of times:
  //   * a GUARANTEE. Past `bossPunishGuaranteeT` seconds of introduced fight
  //     with no window at all, the next one is armed regardless of the count —
  //     so the teaching band's whole reason to exist cannot be rolled away.
  //   * a DECAY. Each window this fight has already opened lengthens the next
  //     recovery, so a boss that has shown the player the beat four times is
  //     not still doing it at the same tempo at the end of the fight. The
  //     Marshal keeps its count and its rhythm; what it loses is the metronome.
  const opened = m.punishCount ?? 0;
  const recovery = CONFIG.bossPunishRecovery *
    (1 + Math.min(CONFIG.bossPunishFatigueMax, opened * CONFIG.bossPunishFatigue));
  if (m.introduced) m.punishDryT = (m.punishDryT ?? 0) + dt;
  const starved = (m.punishDryT ?? 0) >= CONFIG.bossPunishGuaranteeT &&
    (m.punishCd ?? 0) <= 0;
  if (m.introduced &&
      (m.punishArmed || starved || ((m.heat ?? 0) >= rule.after && (m.punishCd ?? 0) <= 0))) {
    m.punishArmed = false;
    m.heat = 0;
    m.punishDryT = 0;
    m.punishCount = opened + 1;
    m.punishCd = recovery;
    beginBossWindup(state, m, "punish", CONFIG.bossPunishWindup, rule.tell);
    return;
  }

  // §2.2's HARD RULE, FOR THE BOSSES WHOSE KIT CANNOT SATISFY IT (r6 major).
  //
  // "At least one phase per fight must be MECHANIC-COMPLETION triggered, so
  // the player's play — not their damage — advances the story." Measured in
  // real play it fired on 11 of 18: the Sump King, the Inspector, the
  // Architect, the Foundation, the Line Supervisor, the Safety Officer and the
  // Showrunner all showed `phases: hp` only across two seeds and seventy
  // seconds, because their mechanic edges are gated on arena states a real
  // fight rarely reaches (every floodgate down, every conveyor broken, every
  // pillar gone).
  //
  // The shared edge is the READ, which is the one thing every one of those
  // fights actually asks for: `m.reads` counts telegraphed heavies this boss
  // committed that caught NOBODY — dodged lanes, walked-out channels, slams
  // that hit floor. Enough of them and the fight visibly answers. It fires at
  // most ONCE (`readPhase`), it never pre-empts a kit's own mechanic edge (a
  // kit that has already fired one sets `readPhase` itself via
  // bossMechanicBeat), and it is strictly the player's doing, which is the
  // whole point of §2.2.
  if (m.introduced && !m.readPhase && (m.reads ?? 0) >= CONFIG.bossReadsForPhase) {
    m.readPhase = true;
    announce2(state, "IT HAS COMMITTED TO NOTHING BUT AIR. That is a read, and reads move this fight.");
    bossMechanicBeat(state, m);
    return;
  }

  // The boss's OWN verb. This is the whole "chassis + override" split: 18
  // bosses, 18 short blocks, one shared body of bookkeeping.
  const kit = m.bossId ? BOSS_KITS[m.bossId] : undefined;
  if (m.introduced && kit && kit(state, m, ctx)) return;

  // SIGNATURE STACKING (boss layer 2, kept): from phase 1 a band boss
  // ALTERNATES its own signature with the PREVIOUS band's — the fight
  // escalates in MECHANICS, not numbers. Gated on `introduced` so the arena
  // never starts cooking before the ringside reveal.
  if (m.signature && m.introduced && (m.sigCd ?? 0) === 0 &&
      (m.punishQuietT ?? 0) <= 0 && d <= CONFIG.monsterAggroRange * 2.5) {
    let sig = m.signature;
    if ((m.phase ?? 0) >= 1) {
      const borrowed = BORROWED[m.signature];
      if (borrowed && (m.sigAlt = !m.sigAlt)) sig = borrowed;
    }
    if (sig === "graverising") {
      // Only commit when there is actually a body to raise (necromancer rules).
      if (state.corpses.some((c) => dist(m.pos, c.pos) <= CONFIG.graveRaiseRange)) {
        m.sigCd = CONFIG.graveRaiseCooldown;
        m.heat = (m.heat ?? 0) + 1;
        beginBossWindup(state, m, "raise", CONFIG.graveRaiseWindup,
          bandSignatureLabel("graverising", m.bossId));
        if (!m.sigUsed) {
          m.sigUsed = true;
          announce2(state, "The guests are being WOKEN — and they are on the payroll. Interrupt it, or thin the ledger.");
        }
        return;
      }
    } else if (sig === "flood") {
      m.sigCd = CONFIG.floodCooldown;
      m.heat = (m.heat ?? 0) + 1;
      bossFloodSurge(state, m);
    } else if (sig === "roots") {
      m.sigCd = CONFIG.rootsCooldown;
      m.heat = (m.heat ?? 0) + 1;
      bossRootGrasp(state, m);
    } else if (sig === "debris") {
      m.sigCd = CONFIG.debrisCooldown;
      m.heat = (m.heat ?? 0) + 1;
      bossDebrisRain(state, m);
    } else if (sig === "flamewall") {
      m.sigCd = CONFIG.flameCooldown;
      m.heat = (m.heat ?? 0) + 1;
      bossFlameSweep(state, m);
    }
  }
  // Tier 3: Dark Ritual — a long channelled cast, its own cooldown, arena-scale
  // AoE. The one attack worth a genuine "stagger it now or eat a big hit".
  if ((m.bossTier ?? 0) >= 3 && (m.ritualCd ?? 0) === 0 && d <= CONFIG.ritualRange &&
      (m.punishQuietT ?? 0) <= 0) {
    m.ritualCd = CONFIG.ritualCooldown;
    // NO HEAT (r5). The ritual is chassis — every tier-3 boss has one, and a
    // counter that every shared verb feeds is a metronome, not a rhythm. What
    // the ritual CAN do for the count is whiff (see resolveRitualStrike).
    // The channel is chassis; the NAME is identity (see RITUAL_LABEL).
    const label = (m.bossId && RITUAL_LABEL[m.bossId]) || "DARK RITUAL";
    beginBossWindup(state, m, "ritual", CONFIG.ritualWindup, label);
    announce2(state, `${m.eliteName ?? "The boss"} is CHANNELING ${label}. Interrupt it or brace for impact.`, "high");
    return;
  }
  // Tier 1+: Ground Slam — an extra AoE on its own cooldown, layered on top of
  // the regular melee+volley kit. (The Foundation's slam is a fissure fan —
  // see resolveStrike; a stationary boss never commits one at all.)
  if ((m.bossTier ?? 0) >= 1 && (m.slamCd ?? 0) === 0 && d <= CONFIG.bossSlamRange) {
    m.slamCd = CONFIG.bossSlamCooldown * ((m.bossTier ?? 1) >= 2 ? CONFIG.bossSlamHasteT2 : 1);
    // NO HEAT AT COMMIT (r5). A slam that LANDS is the boss winning and must
    // not shorten its own punishment; a slam that catches nobody pays the
    // count in full (resolveSlamStrike -> bossWhiff). Same verb, opposite
    // meaning, and the difference is the read the player made.
    beginBossWindup(state, m, "slam", CONFIG.bossSlamWindup);
    return;
  }
  // Phase 1+: HAZARD RAIN — telegraphed blasts on each crawler's position
  // (healCd is unused on bosses; it paces the rain). Keep moving or eat it.
  // SUPPRESSED while the punish window is open (r5 blocker): the game cannot
  // say "stand here and commit" and "this floor kills you" in the same breath.
  if ((m.phase ?? 0) >= 1 && m.healCd === 0 && (m.punishQuietT ?? 0) <= 0) {
    // ...and the rain answers to the ask too: an ask that gave the volley up
    // gets some of that pressure back as TELEGRAPHED ground instead, which is
    // the trade the whole ablation was asking for (r7 blocker).
    m.healCd = CONFIG.bossHazardCooldown * bossChassisRule(m.bossId).rainMult;
    for (const target of state.players) {
      if (!target.alive || dist(m.pos, target.pos) > CONFIG.monsterAggroRange * 2.5) continue;
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: target.pos.x, y: target.pos.y },
        t: CONFIG.bossHazardDelay,
        total: CONFIG.bossHazardDelay,
        radius: CONFIG.bossHazardRadius,
        flavor: "debris", // phase rain is falling rock (backlog #4)
        damage: m.damage * CONFIG.bossHazardDmgMult,
        kind: "blast",
      });
    }
  }
  // Relentless melee chase + periodic radial volley. ANTI-KITE (soft enrage,
  // shipped): time out of melee reach builds impatience, chase speed ramps
  // toward a cap, and one moment of contact resets it. A STATIONARY boss
  // (The Grease Trap) has speed 0, so the ramp is simply never felt.
  if (d > m.attackRange) {
    m.chaseT = (m.chaseT ?? 0) + dt;
  } else {
    m.chaseT = 0;
    m.chaseVexed = false;
  }
  const overPatience = Math.max(0, (m.chaseT ?? 0) - CONFIG.bossChaseRampDelay);
  const chase = Math.min(CONFIG.bossChaseRampCap, 1 + overPatience * CONFIG.bossChaseRampRate);
  if (chase >= CONFIG.bossChaseRampCap && !m.chaseVexed && m.speed > 0) {
    m.chaseVexed = true;
    announce2(state, "The boss is done chasing politely. Sponsors, mark the footwork clause.");
  }
  // Phase 1+ the Rent Collector stops collecting and starts EVICTING: the
  // same swing, but it launches you (the shipped knockback verb).
  const meleeKind = m.bossId === "rentcollector" && (m.phase ?? 0) >= 1 ? "punch" : "melee";
  // SPONSORED (mutator) — IT DEFENDS THE PLACEMENT (r6 blocker). Shipped, the
  // anti-kite chase walked the boss out of its own bubble unprompted, so on
  // bands 4-6 the bubble held for 3-15% of the fight and the mutator was a
  // fight-lengthener with no verb. Past the leash it turns around: the player
  // CAN pull it off the mark, but only by holding the fight out at the edge,
  // and the moment they disengage it goes home. That is the "move the fight,
  // not just yourself" the counterplay sentence has always claimed.
  const leashed = !!m.bossMutators?.includes("sponsored") && !!m.home &&
    d > m.attackRange && dist(m.pos, m.home) > CONFIG.sponsoredLeash;
  if (d <= m.attackRange && m.attackCooldown === 0) beginWindup(m, meleeKind, windup);
  else if (leashed) {
    const back = normalize({ x: m.home!.x - m.pos.x, y: m.home!.y - m.pos.y });
    moveWithCollision(state.map, m.pos, back, m.speed * dt, isWalkable);
  } else if (d > m.attackRange) moveWithCollision(state.map, m.pos, toPlayer, m.speed * chase * dt, isWalkable);
  // ...and the radial volley is suppressed for the window too. A boss that is
  // "briefly helpless" while a ring of ten bolts leaves its body is not
  // helpless; it is a turret with a reticle on it (r5 blocker).
  // ---- THE VOLLEY IS THE ASK'S, NOT THE CHASSIS'S (r7 blocker) -------------
  //
  // `ch_volley` was the top entry in the threat vector on twelve of eighteen
  // bosses and the #2 on the rest: the single most common thing that happens in
  // a boss fight, identical on a break-the-shield boss and a kill-the-adds one.
  // Its cadence, its density and whether it exists at all now come from the
  // boss's ASK (`ASK_CHASSIS`, bosses.ts) — so a storm boss and an adds boss do
  // not fire one at all (their ask already owns the air), a lane boss fires a
  // thin slow one that cannot bury the line it wants read, and the window boss
  // — whose fight IS pressure-then-relief — fires the densest one on the
  // shortest clock. Nothing here is a new verb; it is the shared verb finally
  // being spoken in eighteen fights' worth of different sentences.
  const chas = bossChassisRule(m.bossId);
  if (chas.volleyCd > 0 && m.shootCd === 0 && (m.punishQuietT ?? 0) <= 0 &&
      d < CONFIG.monsterAggroRange * 2.5) {
    m.shootCd = Math.max(1.2, chas.volleyCd - (m.phase ?? 0) * CONFIG.bossPhaseVolleyHaste);
    const count = chas.volleyCount + (m.phase ?? 0) * CONFIG.bossPhaseVolleyBonus;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      spawnEnemyBolt(state, m.pos, { x: dcos(a), y: dsin(a) }, m.damage * 0.6);
    }
  }
  void hunt;
}

export function stepMonster(state: GameState, m: Monster, dt: number): void {
  if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
  // Drum frenzy (aura verb): the beat makes cooldowns DECAY faster — swings
  // come sooner while the windups stay full-length (tells remain readable).
  // An ENRAGED duo survivor runs the same frenzy, permanently — the grudge
  // does not expire.
  const frenzied = (m.frenzyT ?? 0) > 0 || !!m.enraged;
  if ((m.frenzyT ?? 0) > 0) m.frenzyT = Math.max(0, (m.frenzyT ?? 0) - dt);
  if ((m.shieldT ?? 0) > 0) m.shieldT = Math.max(0, (m.shieldT ?? 0) - dt);
  if ((m.riposteT ?? 0) > 0) m.riposteT = Math.max(0, (m.riposteT ?? 0) - dt);
  if (m.attackCooldown > 0) m.attackCooldown = Math.max(0, m.attackCooldown - dt * (frenzied ? CONFIG.drumFrenzyHaste : 1));
  // REDACTED buys its shorter tells with TEMPO, not with a quieter fight: the
  // boss's own verbs come round faster, so the mutator asks the player to read
  // the ticker under more pressure rather than under less (r5, measured).
  if (m.bossMutators?.includes("redacted")) {
    const extra = dt * (CONFIG.mutatorRedactedTempo - 1);
    if ((m.sigCd ?? 0) > 0) m.sigCd = Math.max(0, (m.sigCd ?? 0) - extra);
    if ((m.slamCd ?? 0) > 0) m.slamCd = Math.max(0, (m.slamCd ?? 0) - extra);
    if ((m.affixCd ?? 0) > 0) m.affixCd = Math.max(0, (m.affixCd ?? 0) - extra);
  }
  if (m.shootCd > 0) m.shootCd = Math.max(0, m.shootCd - dt);
  if (m.healCd > 0) m.healCd = Math.max(0, m.healCd - dt);
  if (m.blinkCd > 0) m.blinkCd = Math.max(0, m.blinkCd - dt);
  if ((m.affixCd ?? 0) > 0) m.affixCd = Math.max(0, (m.affixCd ?? 0) - dt);
  // THE QUIET WINDOW (V4, r5 blocker). While this runs the boss lays no new
  // ground, fires no volley and the ARENA DIRECTOR holds its breath, so the
  // beat the doc calls "the one that most needs to read" is not photographed
  // inside a ten-tile wall of live fire.
  if ((m.punishQuietT ?? 0) > 0) m.punishQuietT = Math.max(0, (m.punishQuietT ?? 0) - dt);
  // The SEGMENT clock, ungated by whatever the boss is currently unable to do.
  if (m.kind === "boss") tickBossEnrage(state, m, dt);
  if ((m.surgeT ?? 0) > 0) m.surgeT = Math.max(0, (m.surgeT ?? 0) - dt);
  if ((m.slamCd ?? 0) > 0) m.slamCd = Math.max(0, (m.slamCd ?? 0) - dt);
  if ((m.ritualCd ?? 0) > 0) m.ritualCd = Math.max(0, (m.ritualCd ?? 0) - dt);
  if ((m.sigCd ?? 0) > 0) m.sigCd = Math.max(0, (m.sigCd ?? 0) - dt);
  if ((m.slipT ?? 0) > 0) m.slipT = Math.max(0, (m.slipT ?? 0) - dt);
  if ((m.regroupT ?? 0) > 0) m.regroupT = Math.max(0, (m.regroupT ?? 0) - dt);
  if ((m.alertT ?? 0) > 0) m.alertT = Math.max(0, (m.alertT ?? 0) - dt);
  // Poise DRAINS toward zero (a fraction of the stagger threshold per second):
  // an interrupt takes a concentrated burst — chip damage banks nothing. The
  // post-stagger grace window on bosses/elites ticks down here too.
  if (m.poiseDmg > 0) {
    const threshold = m.maxHp * ARCHETYPES[m.kind].poise * (m.elite ? CONFIG.elitePoiseMult : 1);
    m.poiseDmg = Math.max(0, m.poiseDmg - threshold * CONFIG.poiseDecayPerSec * dt);
  }
  if ((m.staggerGraceT ?? 0) > 0) m.staggerGraceT = Math.max(0, (m.staggerGraceT ?? 0) - dt);
  if (m.hp <= 0) return; // dead-but-unreaped this step (e.g. a detonated bomber)

  // AMBUSH: a dormant monster lies inert until a player strays within trigger
  // range, then springs — and drags its whole cluster up with it, all surging
  // to close the gap. Until sprung it neither moves nor attacks (quiet in fog).
  if (m.dormant) {
    const prey = nearestPlayer(state, m.pos);
    if (!prey || dist(m.pos, prey.pos) > CONFIG.ambushTriggerRadius) return; // still waiting
    springAmbush(state, m);
  }

  // FRENZY aura (MOB-CONCEPTS verb): a carrier (Drum Sergeant) keeps the beat
  // on every pack-mate in radius. The drum radiates even mid-windup — only
  // death stops the band. Kill-order lesson: the buffED aren't the problem.
  if (m.aura === "frenzy") {
    // SEWERS band personality (tier 3): an ALERTED drummer doesn't just buff
    // — it beats the CHARGE: ONE surge per alarm (not a standing state — a
    // permanent march made floor 4 a wall in the 20-seed probe). The whole
    // aura joins the hunt for one memory window and keeps the long frenzy
    // for one rush; after that the drum is back to its passive linger buff
    // until the alarm is raised fresh.
    const marching = (m.alertT ?? 0) > 0;
    const charge = marching && !m.rushBeaten;
    m.rushBeaten = marching ? true : undefined;
    let bolstered = false;
    for (const ally of state.monsters) {
      if (ally === m || ally.hp <= 0 || ally.aura) continue;
      if (dist(m.pos, ally.pos) > CONFIG.drumAuraRadius) continue;
      if (charge) {
        ally.frenzyT = CONFIG.drumRushLinger;
        if (!ally.dormant) ally.alertT = Math.max(ally.alertT ?? 0, monsterMemory(state.floor));
      } else {
        ally.frenzyT = Math.max(ally.frenzyT ?? 0, CONFIG.drumAuraLinger);
      }
      bolstered = true;
    }
    if (bolstered && !m.noticed) {
      const prey = nearestPlayer(state, m.pos);
      if (prey && dist(m.pos, prey.pos) <= CONFIG.monsterAggroRange * 1.5) {
        m.noticed = true;
        state.events.push("A Drum Sergeant beats the advance — the pack is FRENZIED. Silence the band.");
      }
    }
  }

  // The Darling's stardust (shield aura): her entourage takes half while she
  // lives — she takes MORE (see damageMonster). The kill order, stated aloud.
  if (m.aura === "shield") {
    let sheltered = false;
    for (const ally of state.monsters) {
      if (ally === m || ally.hp <= 0 || ally.aura) continue;
      if (dist(m.pos, ally.pos) > CONFIG.darlingAuraRadius) continue;
      ally.shieldT = CONFIG.darlingAuraLinger;
      sheltered = true;
    }
    if (sheltered && !m.noticed) {
      const prey = nearestPlayer(state, m.pos);
      if (prey && dist(m.pos, prey.pos) <= CONFIG.monsterAggroRange * 1.5) {
        m.noticed = true;
        state.events.push("The DARLING shields her entourage — and takes the spotlight's price herself. You know the kill order.");
      }
    }
  }

  // CHILLING elites (5.11) radiate cold: any crawler inside the aura is
  // slowed (short duration, re-applied every step in range — it fades a beat
  // after you break away). Passive frost: it radiates even mid-windup/stagger.
  if (m.affix === "chilling") {
    for (const pl of state.players) {
      if (!pl.alive || dist(m.pos, pl.pos) > CONFIG.chillingAuraRadius) continue;
      applyStatus(pl, { kind: "chill", duration: 0.8, magnitude: CONFIG.chillingAuraSlow, school: "magic" });
    }
  }

  // Staggered: helpless. The stagger that set this also canceled any windup
  // (and any rush in progress — see damageMonster in game.ts).
  if (m.stagger > 0) {
    m.stagger = Math.max(0, m.stagger - dt);
    return;
  }

  // Mid-rush: the charge overrides everything until it runs its line out.
  if ((m.chargeT ?? 0) > 0) {
    stepCharge(state, m, dt);
    return;
  }

  // Stagehand mid-vanish: the smoke holds until the marked re-entry pops —
  // then it appears AT the mark (the arrival blast is the payoff/punish).
  if ((m.vanishT ?? 0) > 0) {
    m.vanishT = Math.max(0, (m.vanishT ?? 0) - dt);
    if (m.vanishT === 0 && m.reentryAt) {
      m.pos = { x: m.reentryAt.x, y: m.reentryAt.y };
      m.reentryAt = undefined;
      m.surgeT = 0.5; // arrives HOT for a beat
    }
    return; // gone — no moving, no swinging, until the smoke clears
  }

  // Committed to an attack: rooted until the windup expires, then it resolves.
  if (m.windup > 0) {
    m.windup -= dt;
    if (m.windup > 0) return;
    m.windup = 0;
    resolveStrike(state, m);
    return;
  }

  // Each monster hunts the nearest living party member — unless a STUNT
  // DOUBLE in taunt range steals the show (the whole point of hiring one).
  const player = nearestPlayer(state, m.pos);
  if (!player) return;
  const hunt = tauntingDecoy(state, m.pos) ?? player;
  let d = dist(m.pos, hunt.pos);
  // STAGED PERCEPTION (staging v2): an undisturbed resident is absorbed in
  // its act — the barracks SLEEPS, diners are slow to look up, the guardpost
  // is paid to watch. Until someone crosses aggroRange x the purpose's
  // perception, every aggro gate below sees a distance beyond its widest
  // multiplier, so the scene simply continues: sneaking past is a real
  // option, and a stray corridor nova no longer wakes a room that never saw
  // you. Crossing the line breaks the scene HERE, for the whole room.
  if (m.residentOf && !(state.residentAggro ?? []).includes(m.residentOf)) {
    if (d <= CONFIG.monsterAggroRange * (PURPOSE_PERCEPTION[m.residentOf] ?? 1)) {
      breakResidentScene(state, m);
    } else {
      d = Math.max(d, CONFIG.monsterAggroRange * 2.6 + 1);
    }
  }
  const toPlayer = normalize({ x: hunt.pos.x - m.pos.x, y: hunt.pos.y - m.pos.y });
  // Depth tempo: deeper floors telegraph shorter (capped so tells stay readable).
  const windup = ARCHETYPES[m.kind].windup * monsterTempo(state.floor).windup;
  // Ambush surge: freshly-sprung monsters move faster for a beat (the pounce).
  // Drum frenzy stacks on top — a frenzied pack CLOSES.
  const moveSpeed = m.speed * ((m.surgeT ?? 0) > 0 ? CONFIG.ambushSurgeSpeed : 1) *
    (frenzied ? CONFIG.drumFrenzySpeed : 1);

  // Summoner elites call swarmer adds while a player is near (lifetime-capped).
  if (
    m.affix === "summoner" && (m.affixCd ?? 0) === 0 &&
    d <= CONFIG.monsterAggroRange && (m.summons ?? 0) < CONFIG.summonMax
  ) {
    // Telegraphed like everything else: the cast is a channel, not a blink.
    m.affixCd = CONFIG.summonCooldown;
    beginWindup(m, "summon", CONFIG.summonWindup);
  }

  // MORTAR elites (six-pack) lob arcing shells at your position — the shell
  // ignores walls (it goes OVER them), so cover stops being safe. Too close
  // and it can't arc: getting IN its face is the counterplay.
  if (
    m.affix === "mortar" && (m.affixCd ?? 0) === 0 &&
    d >= CONFIG.mortarMinRange && d <= CONFIG.mortarMaxRange
  ) {
    m.affixCd = CONFIG.mortarCooldown;
    state.hazards.push({
      id: state.nextEntityId++,
      pos: { x: hunt.pos.x, y: hunt.pos.y },
      t: CONFIG.mortarDelay,
      total: CONFIG.mortarDelay,
      radius: CONFIG.mortarRadius,
      damage: m.damage * CONFIG.mortarDmgMult,
      kind: "blast",
    });
  }

  // BERSERKING elites (six-pack): below half HP the frenzy self-sustains —
  // the drum-frenzy plumbing, fed by its own wounds. Finish what you start.
  if (m.affix === "berserking" && m.hp < m.maxHp * CONFIG.berserkThreshold) {
    m.frenzyT = Math.max(m.frenzyT ?? 0, 0.5);
    if (!m.noticed) {
      m.noticed = true;
      state.events.push(`${m.eliteName ?? "The elite"} goes BERSERK — wounded and faster for it. Finish what you started.`);
    }
  }

  if (m.kind === "boss") {
    // BOSSES V2: the 150-line boss monolith became a CHASSIS + a per-boss
    // override (§7.1). Chase, volley, slam, phases, plates, shields, tethers
    // and the punish window are shared — they were the good part; each boss
    // supplies only its own ability block, exactly as the trash kinds do.
    stepBoss(state, m, dt, { d, hunt: player, toPlayer, windup, moveSpeed, dt });
    return;
  }

  if (m.kind === "drummer") {
    // Drum Sergeant: hangs a few tiles back and keeps the beat (the aura above
    // radiates passively). Worth ~nothing alone; cornered, it swings weakly.
    if (d > CONFIG.monsterAggroRange * 1.5) { wander(state, m, dt); return; }
    if (d <= m.attackRange && m.attackCooldown === 0) {
      beginWindup(m, "melee", windup);
      return;
    }
    const standoff = 3.5;
    if (d < standoff - 1) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 1) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "filcher" || m.kind === "suitguy") {
    // Repo Rat: never fights. Unnoticed it just scurries its rounds; spotted,
    // it BOLTS away from the nearest crawler, and if it stays clear long
    // enough it ESCAPES with everything it carries. Chase it or write it off.
    // The suitguy runs the same brain — except sparing HIM pays (reapDead).
    if (!m.noticed) {
      if (d <= CONFIG.monsterAggroRange) {
        m.noticed = true;
        state.events.push(`A REPO RAT scurries off with ${m.carry ?? 0} gold of the System's petty cash! Run it down!`);
      } else {
        wander(state, m, dt);
        return;
      }
    }
    if (d > CONFIG.filcherEscapeDist) {
      m.fleeT = (m.fleeT ?? 0) + dt;
      if (m.fleeT >= CONFIG.filcherEscapeSeconds) {
        m.escaped = true;
        m.hp = 0; // reapDead turns this into the escape segment, not a kill
        return;
      }
    } else {
      m.fleeT = 0;
    }
    if (d < CONFIG.monsterAggroRange * 2.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, moveSpeed * dt, isWalkable);
    } else {
      wander(state, m, dt);
    }
    return;
  }

  if (m.kind === "stagehand") {
    // Stagehand: blink in, two fast hits, SMOKE OUT — leaving a marked
    // re-entry blast where you were standing. Hold the mark, punish the pop.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if ((m.heat ?? 0) >= CONFIG.stagehandStrikes) {
      m.heat = 0;
      // Smoke away from the fight...
      const away = { x: -toPlayer.x, y: -toPlayer.y };
      moveWithCollision(state.map, m.pos, away, CONFIG.stagehandRetreat, isWalkable);
      // ...and MARK the re-entry where the prey is standing right now.
      const mark = { x: hunt.pos.x, y: hunt.pos.y };
      m.reentryAt = mark;
      m.vanishT = CONFIG.stagehandVanish;
      state.hazards.push({
        id: state.nextEntityId++,
        pos: mark,
        t: CONFIG.stagehandVanish,
        total: CONFIG.stagehandVanish,
        radius: CONFIG.stagehandArriveRadius,
        damage: m.damage * CONFIG.stagehandArriveDmgMult,
        kind: "blast",
      });
      if (!m.noticed) {
        m.noticed = true;
        state.events.push("The stagehand SMOKES OUT — the mark is where it comes BACK. Hold the spot, meet the entrance.");
      }
      return;
    }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
    } else if (m.blinkCd === 0 && d > m.attackRange + 1) {
      m.blinkCd = 2.5;
      moveWithCollision(state.map, m.pos, toPlayer, Math.min(CONFIG.phantomBlinkDistance, d - 0.6), isWalkable);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "sniper") {
    // Boom Operator: a cross-room lane, locked at cast (a pure position
    // test), then it RELOCATES — the lane never fires twice from one spot.
    if (d > CONFIG.monsterAggroRange * 2) { wander(state, m, dt); return; }
    // Spend the stretch right after the shot displacing — perpendicular by
    // parity, blended with AWAY so a walled flank still slides somewhere
    // (the aim windup eats the first sniperArm seconds of cooldown).
    if (m.shootCd > CONFIG.sniperCooldown - CONFIG.sniperArm - CONFIG.sniperRelocateSecs) {
      const side = m.id % 2 === 0 ? 1 : -1;
      const dirMove = normalize({
        x: -toPlayer.y * side - toPlayer.x * 0.6,
        y: toPlayer.x * side - toPlayer.y * 0.6,
      });
      moveWithCollision(state.map, m.pos, dirMove, m.speed * dt, isWalkable);
      return;
    }
    if (m.shootCd === 0 && d <= CONFIG.sniperLength) {
      m.shootCd = CONFIG.sniperCooldown;
      const arm = CONFIG.sniperArm;
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: m.pos.x, y: m.pos.y },
        end: {
          x: m.pos.x + toPlayer.x * CONFIG.sniperLength,
          y: m.pos.y + toPlayer.y * CONFIG.sniperLength,
        },
        t: arm + CONFIG.beamFadeSeconds,
        total: arm + CONFIG.beamFadeSeconds,
        arm,
        radius: CONFIG.sniperWidth,
        damage: m.damage * CONFIG.sniperDmgMult,
        kind: "beam",
      });
      beginWindup(m, "aim", arm);
      if (!m.noticed) {
        m.noticed = true;
        state.events.push("A sniper lane CROSSES THE ROOM — it's locked from the start. You have until the flash.");
      }
      return;
    }
    return;
  }

  if (m.kind === "duelist") {
    // Featured Extra: a fencer with a FLOURISH — periodically the blade goes
    // up (riposteT), and melee into it gets parried AND returned. Hold the
    // swing, or answer with ranged/magic; the flourish only reads steel.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if ((m.riposteT ?? 0) <= 0 && m.healCd === 0 && d <= m.attackRange + 2) {
      m.healCd = CONFIG.riposteCooldown; // healCd is free on melee kinds
      m.riposteT = CONFIG.riposteWindow;
      return; // the flourish itself is the beat — it stands its ground
    }
    if ((m.riposteT ?? 0) > 0) return; // holding the pose, daring you
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "darling" || m.kind === "canceled") {
    // Darling: her stardust aura (above) is the mechanic; up close she slaps.
    // Canceled: a former favorite running PLAYER verbs — lateral dash
    // sidesteps on a cadence, a nova-slam on a longer one, swings between.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (m.kind === "canceled") {
      if (m.blinkCd === 0 && d <= CONFIG.monsterAggroRange) {
        m.blinkCd = CONFIG.canceledDashCooldown;
        const side = m.id % 2 === 0 ? 1 : -1;
        moveWithCollision(state.map, m.pos, { x: -toPlayer.y * side, y: toPlayer.x * side }, CONFIG.canceledDashDist, isWalkable);
      }
      if ((m.slamCd ?? 0) === 0 && d <= CONFIG.bruteSlamRadius + 0.5) {
        m.slamCd = CONFIG.canceledNovaCooldown;
        beginWindup(m, "slam", windup * 1.3); // its "nova" — shove included
        return;
      }
    }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "foreman") {
    // THE FOREMAN (champion tier): a mini-boss kit without the arena — slam
    // up close, radial volley at range, relentless walk between. A boss
    // fight's rhythm at a floor-14 checkpoint, purple-name dopamine included.
    if (d > CONFIG.monsterAggroRange * 1.5) { wander(state, m, dt); return; }
    if ((m.slamCd ?? 0) === 0 && d <= m.attackRange + 0.5) {
      m.slamCd = CONFIG.foremanSlamCooldown;
      beginWindup(m, "slam", windup);
      return;
    }
    if (m.shootCd === 0 && d <= CONFIG.monsterAggroRange * 1.5) {
      m.shootCd = CONFIG.foremanVolleyCooldown;
      for (let i = 0; i < CONFIG.foremanVolleyCount; i++) {
        const a = (i / CONFIG.foremanVolleyCount) * Math.PI * 2;
        spawnEnemyBolt(state, m.pos, { x: dcos(a), y: dsin(a) }, m.damage * 0.5);
      }
    }
    if (d > m.attackRange) {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    } else if (m.attackCooldown === 0) {
      beginWindup(m, "melee", windup);
    }
    return;
  }

  if (m.kind === "shieldbearer" || m.kind === "colossus") {
    // Shieldbearer: a slow phalanx step behind the tower shield (the guard
    // lives in damageMonster) with an ordinary swing. Colossus: the same
    // patient advance, but its slam sends a FISSURE down a locked lane.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) {
        if (m.kind === "colossus") m.chargeDir = toPlayer; // the crack's lane, frozen NOW
        beginWindup(m, m.kind === "colossus" ? "slam" : "melee", windup);
      }
    } else if (m.kind === "shieldbearer") {
      // RUINS band personality (tier 3): the PHALANX. The shield doesn't
      // chase — it walks the line between the crawler and its backline
      // (nearest caster: cleric consecrating, hexer marking), so reaching
      // the priority target means going through the wall. No backline to
      // hold for -> ordinary advance.
      let ward: Monster | null = null;
      let wd: number = CONFIG.phalanxGuardRange;
      for (const ally of state.monsters) {
        if (ally === m || ally.hp <= 0 || !ARCHETYPES[ally.kind].ranged) continue;
        const ad = dist(m.pos, ally.pos);
        if (ad < wd) { ward = ally; wd = ad; }
      }
      const target = ward
        ? {
            x: ward.pos.x + (hunt.pos.x - ward.pos.x) * CONFIG.phalanxLineFraction,
            y: ward.pos.y + (hunt.pos.y - ward.pos.y) * CONFIG.phalanxLineFraction,
          }
        : hunt.pos;
      const to = normalize({ x: target.x - m.pos.x, y: target.y - m.pos.y });
      if (dist(m.pos, target) > 0.3) moveWithCollision(state.map, m.pos, to, moveSpeed * dt, isWalkable);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "cleric") {
    // Ruins cleric: shaman standoff; blesses the ground under its most
    // wounded packmate (or itself, holding the line) — contested ground.
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    const standoff = m.attackRange;
    if (d < standoff - 1.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    if (m.healCd === 0 && d <= CONFIG.monsterAggroRange * 1.5) {
      let anchor: Vec2 = m.pos;
      let worst = 1;
      for (const ally of state.monsters) {
        if (ally.hp <= 0 || ally === m) continue;
        if (dist(m.pos, ally.pos) > CONFIG.hexRange) continue;
        const frac = ally.hp / ally.maxHp;
        if (frac < worst) { worst = frac; anchor = ally.pos; }
      }
      m.healCd = CONFIG.consecrateCooldown;
      m.consecrateAt = { x: anchor.x, y: anchor.y };
      beginWindup(m, "consecrate", windup);
    }
    return;
  }

  if (m.kind === "archivist") {
    // The Archivist: standoff channeler. Its SWEEPING beam starts aimed away
    // from you and rotates toward you for the whole channel — walk its pace
    // or stagger the channel (the beam dies with it).
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    const standoff = m.attackRange;
    if (d < standoff - 2) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    if (m.shootCd === 0 && d <= CONFIG.sweepLength) {
      m.shootCd = CONFIG.sweepCooldown;
      // Start the beam ~90° off the target and sweep TOWARD them; the sign
      // picks the shorter arc so the pace reads immediately.
      const targetAngle = datan2(toPlayer.y, toPlayer.x);
      const offset = Math.PI / 2;
      const sign = nextFloat(state.rng) < 0.5 ? 1 : -1;
      const startAngle = targetAngle - sign * offset;
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: m.pos.x, y: m.pos.y },
        end: {
          x: m.pos.x + dcos(startAngle) * CONFIG.sweepLength,
          y: m.pos.y + dsin(startAngle) * CONFIG.sweepLength,
        },
        t: CONFIG.sweepDuration,
        total: CONFIG.sweepDuration,
        radius: CONFIG.sweepWidth,
        damage: Math.max(1, m.damage * CONFIG.sweepDmgMult),
        kind: "beam",
        sweep: sign * CONFIG.sweepRate,
        srcId: m.id,
      });
      beginWindup(m, "sweep", CONFIG.sweepDuration); // rooted for the channel
      if (!m.noticed) {
        m.noticed = true;
        state.events.push("The Archivist OPENS THE TEXT — the beam sweeps. Walk its pace, or shut the book with a stagger.");
      }
      return;
    }
    return;
  }

  if (m.kind === "cutpurse") {
    // Cutpurse: circles for a LUNGE (short lane, real telegraph) and goes
    // for the purse. Point-blank it jabs weakly. First skillshot lesson.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (m.shootCd === 0 && d >= 1.2 && d <= CONFIG.cutpurseLungeRange && m.attackCooldown === 0) {
      m.shootCd = CONFIG.cutpurseLungeCooldown;
      m.chargeDir = toPlayer; // lane locked NOW — sidestep the stab
      beginWindup(m, "lunge", windup);
      return;
    }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup * 0.7);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "warden" || m.kind === "digger") {
    // Ossuary Warden: a slow bone golem whose slam SHATTERS into a lingering
    // shard zone (see the slam resolve). Pit Digger: the knockback tutor —
    // the game's slowest tell ends in a launch, not a wound.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, m.kind === "warden" ? "slam" : "punch", windup);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "understudy") {
    // Understudy: a weak shuffler with a TRANSFORMATION CLAUSE — bleeding
    // below half HP commits the morph (interruptible; it re-arms while hurt).
    if ((m.hp < m.maxHp * CONFIG.morphHpFraction) && m.windup <= 0) {
      beginWindup(m, "morph", CONFIG.morphWindup);
      if (!m.noticed) {
        m.noticed = true;
        state.events.push("The understudy is TRANSFORMING — stagger it or meet the wolf.");
      }
      return;
    }
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "lasher") {
    // Vine Lasher: mid-range whip. In its band it locks the HOOK lane (the
    // longest telegraph in the game) and drags whoever's still standing in
    // it. It NEVER brawls — crowd it and it slinks back to whip range,
    // which is exactly how you want to fight it (and how it wants you not to).
    if (d > CONFIG.monsterAggroRange * 1.5) { wander(state, m, dt); return; }
    if (m.shootCd === 0 && d >= 1.6 && d <= CONFIG.lasherHookRange) {
      m.shootCd = CONFIG.lasherHookCooldown;
      m.chargeDir = toPlayer; // the lane is frozen NOW; the windup is the dodge
      beginWindup(m, "hook", windup);
      return;
    }
    if (d < 1.6) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > m.attackRange + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "hexer") {
    // Briar Witch: shaman-style standoff, but her cast MARKS a crawler with
    // a vulnerability curse the whole pack cashes in. Kill-order pressure
    // pointed at the PARTY, not the monsters.
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    const standoff = m.attackRange;
    if (d < standoff - 1.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    if (m.healCd === 0 && d <= CONFIG.hexRange && (player.cursedT ?? 0) <= 0) {
      m.healCd = CONFIG.hexCooldown;
      beginWindup(m, "hex", windup);
    }
    return;
  }

  if (m.kind === "lineworker" || m.kind === "greeter") {
    // Lineworker: grunt chase, but the swing is a PISTON PUNCH (launches the
    // survivor — see resolveStrike "punch"). Greeter: same chassis, same
    // punch, but it spawned dormant among the props (ambush plumbing) and
    // discharges sparks on death (see reapDead).
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "punch", windup);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "sentinel") {
    // Sentinel: turret-bot. Holds a long standoff and paints you with a
    // LOCK-ON beam — the line tracks while arming, freezes for the final
    // lock window, then fires the railshot (updateHazards owns the beam).
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    if (m.shootCd === 0 && d <= m.attackRange + 2) {
      m.shootCd = CONFIG.sentinelBeamCooldown;
      const dir = toPlayer;
      const arm = CONFIG.sentinelBeamArm;
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: m.pos.x, y: m.pos.y },
        end: {
          x: m.pos.x + dir.x * CONFIG.sentinelBeamLength,
          y: m.pos.y + dir.y * CONFIG.sentinelBeamLength,
        },
        t: arm + CONFIG.beamFadeSeconds,
        total: arm + CONFIG.beamFadeSeconds,
        arm,
        radius: CONFIG.sentinelBeamWidth,
        damage: m.damage * CONFIG.sentinelBeamDmgMult,
        kind: "beam",
        trackId: hunt === player ? player.id : undefined, // decoys break the lock
      });
      beginWindup(m, "aim", arm); // hold the aiming pose through the paint
      if (!m.noticed) {
        m.noticed = true;
        state.events.push("A sentinel paints you with a targeting beam. Move when it LOCKS, not before.");
      }
      return;
    }
    const standoff = m.attackRange;
    if (d < standoff - 2) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "slagbreaker") {
    // Slagbreaker: brute rhythm with a heat gauge — three swings, then it
    // MUST vent (scalding cloud + self-stagger). Count, dodge, unload.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if ((m.heat ?? 0) >= CONFIG.slagVentAfterSwings) {
      beginWindup(m, "vent", CONFIG.slagVentWindup);
      return;
    }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "toysoldier") {
    // Wind-Up Battalion: the squad presents muskets TOGETHER and fires as
    // one announced volley — one big dodge, not six points of chip. The
    // lowest-id living member is the squad leader and keeps the cadence;
    // a broken squad (under toysquadSyncMin) degrades to ragged solo shots.
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    const squad = m.squadId !== undefined
      ? state.monsters.filter((s) => s.squadId === m.squadId && s.hp > 0)
      : [m];
    const leader = squad.reduce((a, b) => (a.id < b.id ? a : b));
    if (squad.length >= CONFIG.toysquadSyncMin) {
      if (m === leader && m.shootCd === 0 && d <= m.attackRange + 2) {
        // The whole line presents at once (synced pack windup verb).
        for (const s of squad) {
          if (s.windup <= 0 && s.stagger <= 0) beginWindup(s, "shot", CONFIG.toysquadWindup);
          s.shootCd = CONFIG.toysquadVolleyCooldown;
        }
        if (!m.noticed) {
          m.noticed = true;
          state.announcements.push({
            text: "The Battalion PRESENTS ARMS. One volley, one dodge — make it count.",
            kind: "flavor", priority: "normal",
          });
        }
        return;
      }
    } else if (m.shootCd === 0 && d <= m.attackRange + 1.5) {
      // Ragged survivors: slower, lonelier shots (the squad was the threat).
      m.shootCd = CONFIG.toysquadVolleyCooldown * 1.4;
      beginWindup(m, "shot", CONFIG.toysquadWindup * 0.7);
      return;
    }
    const standoff = m.attackRange;
    if (d < standoff - 1.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "ranged") {
    // Ranged: keep a standoff, aim (windup) then shoot when in band — and
    // fight like a UNIT (tier 2c): spread into a crossfire arc instead of a
    // stacked firing squad, and when closed on, fall back INTO the pack's
    // melee (the archer kites you to its bodyguards, not into open space).
    if (!hunterAlerted(state, m, hunt.pos, d, CONFIG.monsterAggroRange * 1.7)) { wander(state, m, dt); return; }
    const standoff = m.attackRange;
    const seen = tileLos(state.map, m.pos, hunt.pos);
    if (m.attackCooldown === 0 && d <= standoff + 1.5 && seen) {
      beginWindup(m, "shot", windup); // stands still to line up the shot
      return;
    }
    if (d < standoff - 1.5 && seen) {
      // Closed on: retreat biased toward the nearest melee ally in sight.
      let guard: Monster | null = null;
      let guardD: number = CONFIG.rangedGuardRange;
      for (const ally of state.monsters) {
        if (ally === m || ally.hp <= 0 || ARCHETYPES[ally.kind].ranged || ally.kind === "boss") continue;
        const ad = dist(m.pos, ally.pos);
        if (ad < guardD && tileLos(state.map, m.pos, ally.pos)) { guard = ally; guardD = ad; }
      }
      const away = guard
        ? normalize({
            x: -toPlayer.x + (guard.pos.x - m.pos.x) / Math.max(1, guardD) * CONFIG.rangedGuardPull,
            y: -toPlayer.y + (guard.pos.y - m.pos.y) / Math.max(1, guardD) * CONFIG.rangedGuardPull,
          })
        : { x: -toPlayer.x, y: -toPlayer.y };
      moveWithCollision(state.map, m.pos, away, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5 || !seen) {
      // No firing line: reposition along the flow until one opens up.
      const dir = (seen ? null : flowDir(state, m.pos)) ?? toPlayer;
      moveWithCollision(state.map, m.pos, dir, m.speed * dt, isWalkable);
    } else {
      // In band and sighted: claim your own ARC. If a lower-id ranged ally
      // shares this firing bearing, strafe perpendicular (id-parity side)
      // until the crossfire opens — deterministic, and only the later
      // arrival moves, so pairs never oscillate.
      const myBearing = datan2(m.pos.y - hunt.pos.y, m.pos.x - hunt.pos.x);
      let crowded = false;
      for (const ally of state.monsters) {
        if (ally === m || ally.hp <= 0 || !ARCHETYPES[ally.kind].ranged || ally.id >= m.id) continue;
        if (dist(ally.pos, hunt.pos) > standoff + 2.5) continue;
        const ab = datan2(ally.pos.y - hunt.pos.y, ally.pos.x - hunt.pos.x);
        let diff = Math.abs(myBearing - ab);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff < CONFIG.rangedLaneAngle) { crowded = true; break; }
      }
      if (crowded) {
        // Preferred side by parity; a wall in the way flips the strafe
        // rather than pinning the caster mid-lane.
        const px = m.pos.x, py = m.pos.y;
        for (const side of m.id % 2 === 0 ? [1, -1] : [-1, 1]) {
          moveWithCollision(state.map, m.pos, { x: -toPlayer.y * side, y: toPlayer.x * side }, m.speed * dt, isWalkable);
          if (dhypot(m.pos.x - px, m.pos.y - py) >= m.speed * dt * 0.5) break;
        }
      }
    }
    return;
  }

  if (m.kind === "bomber") {
    // Bomber: waddle at the nearest player; on contact it LIGHTS THE FUSE and
    // roots — the detonation lands where the fuse ran out, dodge it or eat it.
    // Shot down early, it still cooks off at half radius (see reapDead in game.ts).
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (d <= m.attackRange) beginWindup(m, "fuse", CONFIG.bomberFuse);
    else moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    return;
  }

  if (m.kind === "shaman") {
    // Shaman: keeps a ranged-style standoff, but instead of shooting it patches
    // up the lowest-HP wounded monster in reach on a cooldown. Priority target.
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    const standoff = m.attackRange;
    if (d < standoff - 1.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    if (m.healCd === 0) {
      let target: Monster | null = null;
      for (const ally of state.monsters) {
        if (ally === m || ally.hp <= 0 || ally.hp >= ally.maxHp) continue;
        if (dist(m.pos, ally.pos) > CONFIG.shamanHealRange) continue;
        if (!target || ally.hp < target.hp) target = ally;
      }
      if (target) {
        // Paid up front — a whiff still costs. The channel is the party's
        // "focus the shaman" window (same shape as the necromancer's raise).
        m.healCd = CONFIG.shamanHealCooldown;
        m.healId = target.id;
        beginWindup(m, "heal", CONFIG.shamanHealWindup);
      }
    }
    return;
  }

  if (m.kind === "charger") {
    // Charger: in its rush band it LOCKS a direction and telegraphs long —
    // the lane is the danger, sidestep it. Point-blank it just swings.
    if (d > CONFIG.monsterAggroRange * 1.5) { wander(state, m, dt); return; }
    if (m.attackCooldown === 0 && d >= CONFIG.chargerMinRange && d <= CONFIG.chargerRange) {
      m.chargeDir = toPlayer; // frozen NOW; the windup is your dodge window
      beginWindup(m, "charge", windup);
      return;
    }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup * 0.6);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "spitter") {
    // Spitter: ranged standoff; lobs acid at where you're STANDING. The puddle
    // is the threat — it lingers, so the floor itself becomes the enemy.
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    const standoff = m.attackRange;
    if (m.shootCd === 0 && d <= standoff + 2) {
      m.shootCd = CONFIG.spitterCooldown;
      m.spitTarget = { x: hunt.pos.x, y: hunt.pos.y };
      beginWindup(m, "spit", windup);
      return;
    }
    if (d < standoff - 1.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "necromancer") {
    // Necromancer: shaman-style standoff, but its cast RAISES a fresh corpse
    // as a weakened minion. Kill it first or the pack never stays dead.
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    const standoff = m.attackRange;
    if (d < standoff - 1.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    if (m.healCd === 0 && (m.summons ?? 0) < CONFIG.necroRaiseMax) {
      let corpse: GameState["corpses"][number] | null = null;
      for (const c of state.corpses) {
        if (dist(m.pos, c.pos) > CONFIG.necroRaiseRange) continue;
        if (!corpse || c.t > corpse.t) corpse = c; // prefers the freshest body
      }
      if (corpse) {
        m.healCd = CONFIG.necroRaiseCooldown; // paid up front — a whiff still costs
        m.raiseId = corpse.id;
        beginWindup(m, "raise", windup);
      }
    }
    return;
  }

  if (m.kind === "broodmother") {
    // Broodmother: a walking nest. She never attacks — she waddles AWAY from
    // trouble and BIRTHS swarmers on a timer, so a pack you ignore grows.
    // Lifetime-capped per mother, plus a global population guard.
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    if (d < m.attackRange) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, moveSpeed * dt, isWalkable);
    }
    if (
      (m.affixCd ?? 0) === 0 && (m.summons ?? 0) < CONFIG.broodSpawnMax &&
      state.monsters.length < CONFIG.monsterMaxCount * CONFIG.broodPopulationCap
    ) {
      // The birth is a channel — the first-summon event moved to the resolve.
      m.affixCd = CONFIG.broodSpawnCooldown;
      beginWindup(m, "summon", CONFIG.summonWindup);
    }
    return;
  }

  if (m.kind === "phantom") {
    // Phantom: fast, fragile; periodically blinks toward its prey, then telegraphs
    // a quick strike. The blink slides via moveWithCollision so it never clips walls.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
    } else if (m.blinkCd === 0 && d > m.attackRange + 0.5) {
      m.blinkCd = CONFIG.phantomBlinkCooldown;
      moveWithCollision(state.map, m.pos, toPlayer, Math.min(CONFIG.phantomBlinkDistance, d - m.attackRange * 0.5), isWalkable);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "brute") {
    // Brute: its long, scary windup resolves as a self-centered Ground Slam —
    // an AoE, not a single-target hit. Respect it (back off) or interrupt it.
    if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "slam", windup);
    } else {
      const px = m.pos.x, py = m.pos.y;
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
      if (dhypot(m.pos.x - px, m.pos.y - py) < moveSpeed * dt * 0.25) {
        // BRUTE SMASH-THROUGH (PHYSICALITY.md §1 v2): stalled against blocking
        // furniture with the prey beyond it? Then the furniture IS the target —
        // the same telegraphed slam, resolved against the room (the resolve
        // clears every footprint piece in the arc). The payoff moment.
        if (m.attackCooldown === 0 && furnitureWithin(state, m.pos, m.attackRange + CONFIG.monsterStrikeGrace + 0.45)) {
          beginWindup(m, "slam", windup);
        } else {
          slipAround(state, m, toPlayer, moveSpeed * dt);
        }
      }
    }
    return;
  }

  // Melee archetypes (grunt / swarmer).
  if (!hunterAlerted(state, m, hunt.pos, d, CONFIG.monsterAggroRange)) { wander(state, m, dt); return; }

  // RETREAT-AND-REGROUP (encounter director, tier 4): a broken survivor —
  // wounded, packmates dead around it, nobody left beside it — BOLTS for
  // reinforcements instead of trading its life. It flees uphill on the flow
  // field (away from every crawler, along walkable topology); the moment it
  // reaches another pack it raises the alarm and turns to fight with them.
  // The fight SPILLS into the next room. Once per monster: a survivor that
  // found nobody dies where its memory runs out.
  if ((m.regroupT ?? 0) > 0) {
    for (const ally of state.monsters) {
      if (ally === m || ally.hp <= 0 || ally.dormant || ally.kind === "boss") continue;
      if (dist(m.pos, ally.pos) <= CONFIG.packAlertRadius && tileLos(state.map, m.pos, ally.pos)) {
        alertMonster(state, ally); // the alarm — its pack cascades awake
        m.regroupT = 0;
        m.alertT = monsterMemory(state.floor);
        break;
      }
    }
    if ((m.regroupT ?? 0) > 0) {
      const dir = flowUphill(state, m.pos) ?? { x: -toPlayer.x, y: -toPlayer.y };
      moveWithCollision(state.map, m.pos, dir, moveSpeed * dt, isWalkable);
      return;
    }
  } else if (
    state.floor >= CONFIG.regroupFromFloor &&
    !m.elite && !m.regrouped && m.hp < m.maxHp * CONFIG.regroupHpFraction &&
    d < CONFIG.monsterAggroRange
  ) {
    let corpses = 0;
    for (const c of state.corpses) if (dist(m.pos, c.pos) <= CONFIG.regroupCorpseRadius) corpses++;
    let alone = true;
    for (const ally of state.monsters) {
      if (ally === m || ally.hp <= 0) continue;
      if (dist(m.pos, ally.pos) <= CONFIG.packAlertRadius) { alone = false; break; }
    }
    if (corpses >= CONFIG.regroupCorpseCount && alone) {
      m.regroupT = CONFIG.regroupSeconds;
      m.regrouped = true;
      state.events.push("A survivor BOLTS for reinforcements — cut it down before the whole floor knows.");
      return;
    }
  }

  if (d <= m.attackRange) {
    if (m.attackCooldown === 0 && meleeTokenFree(state, m)) beginWindup(m, "melee", windup);
  } else {
    const px = m.pos.x, py = m.pos.y;
    // Steering ladder (AI tier 2): clear sight -> flank into the surround;
    // sight blocked by walls, or a recent stall (furniture pocket) -> follow
    // the flow field around the geometry; nothing useful from the field
    // (sealed region) -> old greedy line + 45-degree slips as the last rung.
    const obstructed = (m.slipT ?? 0) > 0 || !tileLos(state.map, m.pos, hunt.pos);
    const dir = (obstructed ? flowDir(state, m.pos) : null)
      ?? ((m.slipT ?? 0) > 0 ? toPlayer : flankVector(state, m, toPlayer, d));
    moveWithCollision(state.map, m.pos, dir, moveSpeed * dt, isWalkable);
    if (dhypot(m.pos.x - px, m.pos.y - py) < moveSpeed * dt * 0.25) {
      m.slipT = 0.6;
      slipAround(state, m, toPlayer, moveSpeed * dt);
    }
  }
}
