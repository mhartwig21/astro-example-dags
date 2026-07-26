import { ARCHETYPES, CONFIG, monsterTempo } from "./config";
import { dist, normalize } from "./combat";
// Monster movement always uses the settlement-aware check: on Race floors
// (settlementRoomIdx -1) this is identical to isWalkable; on Roam floors it
// additionally blocks monsters from wandering/chasing into the sanctuary.
import { isWalkableForMonster as isWalkable } from "./floor";
import { chance, nextFloat } from "./rng";
import type { GameState, Monster, Vec2 } from "./types";
import { moveWithCollision } from "./movement";
import { applyStatus } from "./status";
import {
  applyPlayerKnockback, bossDebrisRain, bossFlameSweep, bossFloodSurge, bossGraveRaise, bossRootGrasp,
  breakResidentScene, damagePlayerHit, decoySoak, explodeBomber, handlePlayerDeath, nearestPlayer, raiseCorpse,
  spawnBossWave, summonMinion, tauntingDecoy,
} from "./game";
import { PURPOSE_PERCEPTION } from "./roomPurposes";
import { smashBlockersAt } from "./game";

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
  for (const sign of m.id % 2 === 0 ? [1, -1] : [-1, 1]) {
    const c = Math.SQRT1_2, s = sign * Math.SQRT1_2;
    const slip = { x: toPlayer.x * c - toPlayer.y * s, y: toPlayer.x * s + toPlayer.y * c };
    moveWithCollision(state.map, m.pos, slip, step, isWalkable);
    if (Math.hypot(m.pos.x - px, m.pos.y - py) >= step * 0.5) return;
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
      m.wanderDir = { x: Math.cos(a), y: Math.sin(a) };
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
    if (damagePlayerHit(state, player, m.damage * execute, { dir })) {
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
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue; // dash i-frames dodge the blow
    if (dist(m.pos, player.pos) > radius) continue;
    const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    if (damagePlayerHit(state, player, dmg, { dir })) {
      handlePlayerDeath(state, player, `${player.name} stood in the blast radius. The System rolls the replay.`);
    } else {
      // Slams SHOVE (MOB-CONCEPTS knockback verb): surviving one still costs
      // you your footing — and whatever ground the shove lands you on.
      applyPlayerKnockback(player, dir, m.kind === "boss" ? CONFIG.bossSlamKnockback : CONFIG.slamKnockback);
    }
  }
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
    if (damagePlayerHit(state, player, dmg, { dir })) {
      handlePlayerDeath(state, player, `${player.name} let the ritual finish. The System does not offer refunds.`);
    }
  }
  if (caught > 0) {
    state.announcements.push({ text: "THE RITUAL LANDS. That's going to leave a mark.", kind: "boss", priority: "normal" });
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
      if (damagePlayerHit(state, player, m.damage, { dir })) {
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
      if (damagePlayerHit(state, player, m.damage, { dir: hitDir })) {
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
      if (damagePlayerHit(state, player, dmg, { dir, effect: "burn" })) {
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
      const distToLane = Math.hypot(player.pos.x - (m.pos.x + abx * t), player.pos.y - (m.pos.y + aby * t));
      if (distToLane > CONFIG.lasherHookWidth) continue;
      const toLasher = normalize({ x: m.pos.x - player.pos.x, y: m.pos.y - player.pos.y });
      if (damagePlayerHit(state, player, m.damage * CONFIG.lasherHookDmgMult, { dir: { x: -toLasher.x, y: -toLasher.y } })) {
        handlePlayerDeath(state, player, `${player.name} took the vine express. No return service.`);
      } else {
        const gap = dist(m.pos, player.pos);
        const drag = Math.max(0, gap - CONFIG.lasherHookLandGap);
        applyPlayerKnockback(player, toLasher, drag, drag); // a PULL: full-length, uncapped
      }
    }
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
    if (damagePlayerHit(state, player, m.damage, { dir: away })) {
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
  if (m.shootCd > 0) m.shootCd = Math.max(0, m.shootCd - dt);
  if (m.healCd > 0) m.healCd = Math.max(0, m.healCd - dt);
  if (m.blinkCd > 0) m.blinkCd = Math.max(0, m.blinkCd - dt);
  if ((m.affixCd ?? 0) > 0) m.affixCd = Math.max(0, (m.affixCd ?? 0) - dt);
  if ((m.surgeT ?? 0) > 0) m.surgeT = Math.max(0, (m.surgeT ?? 0) - dt);
  if ((m.slamCd ?? 0) > 0) m.slamCd = Math.max(0, (m.slamCd ?? 0) - dt);
  if ((m.ritualCd ?? 0) > 0) m.ritualCd = Math.max(0, (m.ritualCd ?? 0) - dt);
  if ((m.sigCd ?? 0) > 0) m.sigCd = Math.max(0, (m.sigCd ?? 0) - dt);
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
    let bolstered = false;
    for (const ally of state.monsters) {
      if (ally === m || ally.hp <= 0 || ally.aura) continue;
      if (dist(m.pos, ally.pos) > CONFIG.drumAuraRadius) continue;
      ally.frenzyT = CONFIG.drumAuraLinger;
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
    // Phase enrage: crossing 2/3 and 1/3 HP speeds the chase and thickens volleys.
    const frac = m.hp / m.maxHp;
    const wantPhase = frac <= 1 / 3 ? 2 : frac <= 2 / 3 ? 1 : 0;
    while ((m.phase ?? 0) < wantPhase) {
      m.phase = (m.phase ?? 0) + 1;
      m.speed *= CONFIG.bossPhaseSpeedMult;
      spawnBossWave(state, m); // the enrage brings friends (backlog #11)
      state.announcements.push({
        text: m.phase === 1
          ? "The boss is ANGRY now. Phase two — the sponsors love a comeback arc."
          : "The boss is DESPERATE. Everything is a projectile. RATINGS.",
        kind: "boss",
        priority: "normal",
      });
      state.events.push(`Boss phase ${m.phase + 1}.`);
    }
    // THE FINALE'S GREATEST-HITS REEL (boss layer 2 / old backlog #1): the
    // floor-18 boss has no band signature of its own — its phase breaks
    // BORROW earlier bands' instead. Phase 1: the Architect's debris rain.
    // Phase 2: the Marshal's flame sweep. The season recap fights back.
    if (state.floor >= CONFIG.finalFloor) {
      if ((m.phase ?? 0) >= 2 && m.signature !== "flamewall") {
        m.signature = "flamewall";
        m.sigUsed = false;
      } else if ((m.phase ?? 0) === 1 && !m.signature) {
        m.signature = "debris";
        state.announcements.push({
          text: "The boss remembers EVERY FLOOR you cleared. Greatest hits, Crawlers. Duck.",
          kind: "boss", priority: "normal",
        });
      }
    }
    // SIGNATURE STACKING (boss layer 2): from phase 1, a band boss ALTERNATES
    // its own signature with the PREVIOUS band's — the fight escalates in
    // mechanics, not just numbers.
    const BORROWED: Partial<Record<NonNullable<Monster["signature"]>, Monster["signature"]>> = {
      flood: "graverising", roots: "flood", debris: "roots", flamewall: "debris",
    };
    // SIGNATURE mechanic: each band-end boss layers ONE themed ability on the
    // shared kit (see BAND_BOSSES + the boss* helpers in game.ts). Gated on
    // `introduced` so the arena never starts cooking before the ringside
    // reveal. Grave Rising is a windup (interruptible channel); the rest lay
    // telegraphed ground danger and let the boss keep fighting.
    if (m.signature && m.introduced && (m.sigCd ?? 0) === 0 && d <= CONFIG.monsterAggroRange * 2.5) {
      // Past phase 1 the casts alternate own <-> borrowed (finale keeps its
      // current greatest-hit; it swaps whole signatures at phase edges).
      let sig = m.signature;
      if (state.floor < CONFIG.finalFloor && (m.phase ?? 0) >= 1) {
        const borrowed = BORROWED[m.signature];
        if (borrowed && (m.sigAlt = !m.sigAlt)) sig = borrowed;
      }
      if (sig === "graverising") {
        // Only commit when there is actually a body to raise (necromancer rules).
        if (state.corpses.some((c) => dist(m.pos, c.pos) <= CONFIG.graveRaiseRange)) {
          m.sigCd = CONFIG.graveRaiseCooldown;
          beginWindup(m, "raise", CONFIG.graveRaiseWindup);
          if (!m.sigUsed) {
            m.sigUsed = true;
            state.announcements.push({
              text: "The Concierge is WAKING THE GUESTS. Interrupt the ritual or meet the returning residents.",
              kind: "boss", priority: "normal",
            });
          }
          return;
        }
      } else if (sig === "flood") {
        m.sigCd = CONFIG.floodCooldown;
        bossFloodSurge(state, m);
      } else if (sig === "roots") {
        m.sigCd = CONFIG.rootsCooldown;
        bossRootGrasp(state, m);
      } else if (sig === "debris") {
        m.sigCd = CONFIG.debrisCooldown;
        bossDebrisRain(state, m);
      } else if (sig === "flamewall") {
        m.sigCd = CONFIG.flameCooldown;
        bossFlameSweep(state, m);
      }
    }
    // Tier 3: Dark Ritual — a long channelled cast, its own cooldown, arena-scale
    // AoE. This is the one attack in the game worth a genuine "stagger it now or
    // eat a big hit" decision, so it telegraphs unmistakably (see renderer3d.ts).
    if ((m.bossTier ?? 0) >= 3 && (m.ritualCd ?? 0) === 0 && d <= CONFIG.ritualRange) {
      m.ritualCd = CONFIG.ritualCooldown;
      beginWindup(m, "ritual", CONFIG.ritualWindup);
      state.announcements.push({
        text: "The boss is CHANNELING something. Interrupt it or brace for impact.", kind: "boss", priority: "high",
      });
      return;
    }
    // Tier 1+: Ground Slam — an extra AoE on its own cooldown, layered on top
    // of the regular melee+volley kit rather than replacing it. Tier 2+ cycles
    // it faster (the kit escalation between the floor-6 and floor-12 arenas;
    // adds waves + hazard rain are universal boss behavior — backlog #11).
    if ((m.bossTier ?? 0) >= 1 && (m.slamCd ?? 0) === 0 && d <= CONFIG.bossSlamRange) {
      m.slamCd = CONFIG.bossSlamCooldown * ((m.bossTier ?? 1) >= 2 ? CONFIG.bossSlamHasteT2 : 1);
      beginWindup(m, "slam", CONFIG.bossSlamWindup);
      return;
    }
    // Phase 1+: HAZARD RAIN — telegraphed blasts on each crawler's position
    // (healCd is unused on bosses; it paces the rain). Keep moving or eat it.
    if ((m.phase ?? 0) >= 1 && m.healCd === 0) {
      m.healCd = CONFIG.bossHazardCooldown;
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
    // Boss: relentless melee chase (telegraphed slam) + periodic radial volley.
    // ANTI-KITE (backlog #6, movement half): time out of melee reach builds
    // impatience — past a patience delay the chase speed ramps toward a cap,
    // so orbiting the arena forever stops being free. One moment of contact
    // resets it: the counterplay is standing your ground in windows (dodging
    // INTO range), not running laps.
    if (d > m.attackRange) {
      m.chaseT = (m.chaseT ?? 0) + dt;
    } else {
      m.chaseT = 0;
      m.chaseVexed = false;
    }
    const overPatience = Math.max(0, (m.chaseT ?? 0) - CONFIG.bossChaseRampDelay);
    const chase = Math.min(CONFIG.bossChaseRampCap, 1 + overPatience * CONFIG.bossChaseRampRate);
    if (chase >= CONFIG.bossChaseRampCap && !m.chaseVexed) {
      m.chaseVexed = true;
      state.announcements.push({
        text: "The boss is done chasing politely. Sponsors, mark the footwork clause.",
        kind: "boss",
        priority: "normal",
      });
    }
    if (d <= m.attackRange && m.attackCooldown === 0) beginWindup(m, "melee", windup);
    else if (d > m.attackRange) moveWithCollision(state.map, m.pos, toPlayer, m.speed * chase * dt, isWalkable);
    if (m.shootCd === 0 && d < CONFIG.monsterAggroRange * 2.5) {
      m.shootCd = Math.max(1.2, CONFIG.bossVolleyCooldown - (m.phase ?? 0) * CONFIG.bossPhaseVolleyHaste);
      const count = CONFIG.bossVolleyCount + (m.phase ?? 0) * CONFIG.bossPhaseVolleyBonus;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        spawnEnemyBolt(state, m.pos, { x: Math.cos(a), y: Math.sin(a) }, m.damage * 0.6);
      }
    }
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
        spawnEnemyBolt(state, m.pos, { x: Math.cos(a), y: Math.sin(a) }, m.damage * 0.5);
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
      const targetAngle = Math.atan2(toPlayer.y, toPlayer.x);
      const offset = Math.PI / 2;
      const sign = nextFloat(state.rng) < 0.5 ? 1 : -1;
      const startAngle = targetAngle - sign * offset;
      state.hazards.push({
        id: state.nextEntityId++,
        pos: { x: m.pos.x, y: m.pos.y },
        end: {
          x: m.pos.x + Math.cos(startAngle) * CONFIG.sweepLength,
          y: m.pos.y + Math.sin(startAngle) * CONFIG.sweepLength,
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
    // Ranged: keep a standoff, kite if crowded, aim (windup) then shoot when in band.
    if (d > CONFIG.monsterAggroRange * 1.7) { wander(state, m, dt); return; }
    const standoff = m.attackRange;
    if (m.attackCooldown === 0 && d <= standoff + 1.5) {
      beginWindup(m, "shot", windup); // stands still to line up the shot
      return;
    }
    if (d < standoff - 1.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
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
      if (Math.hypot(m.pos.x - px, m.pos.y - py) < moveSpeed * dt * 0.25) {
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
  if (d > CONFIG.monsterAggroRange) { wander(state, m, dt); return; }
  if (d <= m.attackRange) {
    if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
  } else {
    const px = m.pos.x, py = m.pos.y;
    moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    if (Math.hypot(m.pos.x - px, m.pos.y - py) < moveSpeed * dt * 0.25) {
      slipAround(state, m, toPlayer, moveSpeed * dt);
    }
  }
}
