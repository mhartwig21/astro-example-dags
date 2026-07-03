import { ARCHETYPES, CONFIG } from "./config";
import { dist, normalize, rollDamage } from "./combat";
import { isWalkable } from "./floor";
import type { GameState, Monster, Vec2 } from "./types";
import { moveWithCollision } from "./movement";
import { addHype, explodeBomber, handlePlayerDeath, nearestPlayer, summonMinion } from "./game";

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

/** Commit to an attack: root the monster and start the tell. */
function beginWindup(m: Monster, kind: NonNullable<Monster["windupKind"]>, seconds: number): void {
  m.windup = seconds;
  m.windupTotal = seconds;
  m.windupKind = kind;
}

/** A melee strike lands: damage every living player still inside range + grace. */
function resolveMeleeStrike(state: GameState, m: Monster): void {
  m.attackCooldown = CONFIG.monsterAttackCooldown;
  const reach = m.attackRange + CONFIG.monsterStrikeGrace;
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue; // dash i-frames dodge the blow
    if (dist(m.pos, player.pos) > reach) continue; // stepped out of the arc — whiff
    const dmg = rollDamage(state.rng, m.damage);
    player.hp -= dmg;
    player.damageTaken += dmg;
    const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    state.hits.push({
      pos: { x: player.pos.x, y: player.pos.y }, amount: dmg, kind: "player",
      dir, killed: player.hp <= 0,
    });
    if (player.hp <= 0) {
      handlePlayerDeath(state, player, `${player.name} died in the dungeon.`);
    } else if (player.hp < player.maxHp * CONFIG.show.lowHpFraction) {
      addHype(state, player, CONFIG.show.hypeLowHpHit); // living dangerously = great television
    }
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
    m.attackCooldown = CONFIG.monsterAttackCooldown * 1.3;
    const player = nearestPlayer(state, m.pos);
    if (!player) return;
    spawnEnemyBolt(state, m.pos, { x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y }, m.damage);
    return;
  }
  resolveMeleeStrike(state, m);
}

export function stepMonster(state: GameState, m: Monster, dt: number): void {
  if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
  if (m.attackCooldown > 0) m.attackCooldown = Math.max(0, m.attackCooldown - dt);
  if (m.shootCd > 0) m.shootCd = Math.max(0, m.shootCd - dt);
  if (m.healCd > 0) m.healCd = Math.max(0, m.healCd - dt);
  if (m.blinkCd > 0) m.blinkCd = Math.max(0, m.blinkCd - dt);
  if ((m.affixCd ?? 0) > 0) m.affixCd = Math.max(0, (m.affixCd ?? 0) - dt);
  if (m.hp <= 0) return; // dead-but-unreaped this step (e.g. a detonated bomber)

  // Staggered: helpless. The stagger that set this also canceled any windup.
  if (m.stagger > 0) {
    m.stagger = Math.max(0, m.stagger - dt);
    return;
  }

  // Committed to an attack: rooted until the windup expires, then it resolves.
  if (m.windup > 0) {
    m.windup -= dt;
    if (m.windup > 0) return;
    m.windup = 0;
    resolveStrike(state, m);
    return;
  }

  // Each monster hunts the nearest living party member.
  const player = nearestPlayer(state, m.pos);
  if (!player) return;
  const d = dist(m.pos, player.pos);
  const toPlayer = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
  const windup = ARCHETYPES[m.kind].windup;

  // Summoner elites call swarmer adds while a player is near (lifetime-capped).
  if (
    m.affix === "summoner" && (m.affixCd ?? 0) === 0 &&
    d <= CONFIG.monsterAggroRange && (m.summons ?? 0) < CONFIG.summonMax
  ) {
    m.affixCd = CONFIG.summonCooldown;
    m.summons = (m.summons ?? 0) + 1;
    summonMinion(state, m);
  }

  if (m.kind === "boss") {
    // Phase enrage: crossing 2/3 and 1/3 HP speeds the chase and thickens volleys.
    const frac = m.hp / m.maxHp;
    const wantPhase = frac <= 1 / 3 ? 2 : frac <= 2 / 3 ? 1 : 0;
    while ((m.phase ?? 0) < wantPhase) {
      m.phase = (m.phase ?? 0) + 1;
      m.speed *= CONFIG.bossPhaseSpeedMult;
      state.announcements.push({
        text: m.phase === 1
          ? "The boss is ANGRY now. Phase two — the sponsors love a comeback arc."
          : "The boss is DESPERATE. Everything is a projectile. RATINGS.",
        kind: "boss",
        priority: "normal",
      });
      state.events.push(`Boss phase ${m.phase + 1}.`);
    }
    // Boss: relentless melee chase (telegraphed slam) + periodic radial volley.
    if (d <= m.attackRange && m.attackCooldown === 0) beginWindup(m, "melee", windup);
    else if (d > m.attackRange) moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
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

  if (m.kind === "ranged") {
    // Ranged: keep a standoff, kite if crowded, aim (windup) then shoot when in band.
    if (d > CONFIG.monsterAggroRange * 1.7) return;
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
    if (d > CONFIG.monsterAggroRange) return;
    if (d <= m.attackRange) beginWindup(m, "fuse", CONFIG.bomberFuse);
    else moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    return;
  }

  if (m.kind === "shaman") {
    // Shaman: keeps a ranged-style standoff, but instead of shooting it patches
    // up the lowest-HP wounded monster in reach on a cooldown. Priority target.
    if (d > CONFIG.monsterAggroRange * 1.7) return;
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
        m.healCd = CONFIG.shamanHealCooldown;
        const amount = Math.min(CONFIG.shamanHeal, target.maxHp - target.hp);
        target.hp += amount;
        state.hits.push({ pos: { x: target.pos.x, y: target.pos.y }, amount, kind: "heal" });
      }
    }
    return;
  }

  if (m.kind === "phantom") {
    // Phantom: fast, fragile; periodically blinks toward its prey, then telegraphs
    // a quick strike. The blink slides via moveWithCollision so it never clips walls.
    if (d > CONFIG.monsterAggroRange) return;
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
    } else if (m.blinkCd === 0 && d > m.attackRange + 0.5) {
      m.blinkCd = CONFIG.phantomBlinkCooldown;
      moveWithCollision(state.map, m.pos, toPlayer, Math.min(CONFIG.phantomBlinkDistance, d - m.attackRange * 0.5), isWalkable);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    return;
  }

  // Melee archetypes (grunt / swarmer / brute).
  if (d > CONFIG.monsterAggroRange) return;
  if (d <= m.attackRange) {
    if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
  } else {
    moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
  }
}
