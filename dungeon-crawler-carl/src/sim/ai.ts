import { CONFIG } from "./config";
import { dist, normalize, rollDamage } from "./combat";
import { isWalkable } from "./floor";
import type { GameState, Monster, Player, Vec2 } from "./types";
import { moveWithCollision } from "./movement";
import { addHype, explodeBomber, handlePlayerDeath, nearestPlayer } from "./game";

// Monster behavior per archetype. Stats (hp/damage/speed/range) are baked in at
// spawn (see makeMonster); this file decides how each kind *acts*: melee types chase
// and swing, ranged types keep a standoff and shoot, and the boss chases + fires
// periodic radial volleys. Cheap greedy steering — replace with pathfinding later.

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

function meleeSwing(state: GameState, m: Monster, player: Player): void {
  if (m.attackCooldown > 0) return;
  m.attackCooldown = CONFIG.monsterAttackCooldown;
  // Dashing grants brief i-frames.
  if (player.dashTime > 0) return;
  const dmg = rollDamage(state.rng, m.damage);
  player.hp -= dmg;
  player.damageTaken += dmg;
  state.hits.push({ pos: { x: player.pos.x, y: player.pos.y }, amount: dmg, kind: "player" });
  if (player.hp <= 0) {
    handlePlayerDeath(state, player, `${player.name} died in the dungeon.`);
  } else if (player.hp < player.maxHp * CONFIG.show.lowHpFraction) {
    addHype(state, player, CONFIG.show.hypeLowHpHit); // living dangerously = great television
  }
}

export function stepMonster(state: GameState, m: Monster, dt: number): void {
  if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
  if (m.attackCooldown > 0) m.attackCooldown = Math.max(0, m.attackCooldown - dt);
  if (m.shootCd > 0) m.shootCd = Math.max(0, m.shootCd - dt);
  if (m.healCd > 0) m.healCd = Math.max(0, m.healCd - dt);
  if (m.blinkCd > 0) m.blinkCd = Math.max(0, m.blinkCd - dt);
  if (m.hp <= 0) return; // dead-but-unreaped this step (e.g. a detonated bomber)

  // Each monster hunts the nearest living party member.
  const player = nearestPlayer(state, m.pos);
  if (!player) return;
  const d = dist(m.pos, player.pos);
  const toPlayer = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });

  if (m.kind === "boss") {
    // Boss: relentless melee chase + periodic radial volley.
    if (d <= m.attackRange) meleeSwing(state, m, player);
    else moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    if (m.shootCd === 0 && d < CONFIG.monsterAggroRange * 2.5) {
      m.shootCd = CONFIG.bossVolleyCooldown;
      for (let i = 0; i < CONFIG.bossVolleyCount; i++) {
        const a = (i / CONFIG.bossVolleyCount) * Math.PI * 2;
        spawnEnemyBolt(state, m.pos, { x: Math.cos(a), y: Math.sin(a) }, m.damage * 0.6);
      }
    }
    return;
  }

  if (m.kind === "ranged") {
    // Ranged: keep a standoff, kite if crowded, shoot when in band.
    if (d > CONFIG.monsterAggroRange * 1.7) return;
    const standoff = m.attackRange;
    if (d < standoff - 1.5) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, m.speed * dt, isWalkable);
    } else if (d > standoff + 0.5) {
      moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
    }
    if (m.attackCooldown === 0 && d <= standoff + 1.5) {
      m.attackCooldown = CONFIG.monsterAttackCooldown * 1.3;
      spawnEnemyBolt(state, m.pos, toPlayer, m.damage);
    }
    return;
  }

  if (m.kind === "bomber") {
    // Bomber: waddle at the nearest player and detonate on contact. Shot down
    // early, it still cooks off at half radius (see reapDead in game.ts).
    if (d > CONFIG.monsterAggroRange) return;
    if (d <= m.attackRange) explodeBomber(state, m); // full radius; reaped normally
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
    // Phantom: fast, fragile; periodically blinks toward its prey, then melees
    // on contact. The blink slides via moveWithCollision so it never clips walls.
    if (d > CONFIG.monsterAggroRange) return;
    if (d <= m.attackRange) {
      meleeSwing(state, m, player);
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
  if (d <= m.attackRange) meleeSwing(state, m, player);
  else moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
}
