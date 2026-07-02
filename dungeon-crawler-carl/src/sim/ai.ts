import { CONFIG } from "./config";
import { dist, normalize, rollDamage } from "./combat";
import { isWalkable } from "./floor";
import type { GameState, Monster, Vec2 } from "./types";
import { moveWithCollision } from "./movement";

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

function meleeSwing(state: GameState, m: Monster): void {
  if (m.attackCooldown > 0) return;
  const player = state.player;
  m.attackCooldown = CONFIG.monsterAttackCooldown;
  // Dashing grants brief i-frames.
  if (player.dashTime > 0) return;
  const dmg = rollDamage(state.rng, m.damage);
  player.hp -= dmg;
  state.hits.push({ pos: { x: player.pos.x, y: player.pos.y }, amount: dmg, kind: "player" });
  if (player.hp <= 0) {
    player.hp = 0;
    player.alive = false;
    state.status = "dead";
    state.events.push("You died in the dungeon.");
  }
}

export function stepMonster(state: GameState, m: Monster, dt: number): void {
  if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
  if (m.attackCooldown > 0) m.attackCooldown = Math.max(0, m.attackCooldown - dt);
  if (m.shootCd > 0) m.shootCd = Math.max(0, m.shootCd - dt);

  const player = state.player;
  if (!player.alive) return;
  const d = dist(m.pos, player.pos);
  const toPlayer = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });

  if (m.kind === "boss") {
    // Boss: relentless melee chase + periodic radial volley.
    if (d <= m.attackRange) meleeSwing(state, m);
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

  // Melee archetypes (grunt / swarmer / brute).
  if (d > CONFIG.monsterAggroRange) return;
  if (d <= m.attackRange) meleeSwing(state, m);
  else moveWithCollision(state.map, m.pos, toPlayer, m.speed * dt, isWalkable);
}
