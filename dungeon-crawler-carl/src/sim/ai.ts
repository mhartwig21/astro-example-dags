import { CONFIG } from "./config";
import { dist, normalize, rollDamage } from "./combat";
import { isWalkable } from "./floor";
import type { GameState, Monster } from "./types";
import { moveWithCollision } from "./movement";

/**
 * Monster behavior for one step: if the player is within aggro range, chase and
 * attack when in melee range. Simple greedy steering with wall sliding — enough
 * for the slice, and cheap to replace with pathfinding later.
 */
export function stepMonster(state: GameState, m: Monster, dt: number): void {
  if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
  if (m.attackCooldown > 0) m.attackCooldown = Math.max(0, m.attackCooldown - dt);

  const player = state.player;
  if (!player.alive) return;

  const d = dist(m.pos, player.pos);
  if (d > CONFIG.monsterAggroRange) return;

  if (d <= CONFIG.monsterAttackRange) {
    // In range: attack on cooldown.
    if (m.attackCooldown === 0) {
      const dmg = rollDamage(state.rng, m.damage);
      player.hp -= dmg;
      m.attackCooldown = CONFIG.monsterAttackCooldown;
      if (player.hp <= 0) {
        player.hp = 0;
        player.alive = false;
        state.status = "dead";
        state.events.push("You died in the dungeon.");
      }
    }
    return;
  }

  // Chase: step toward the player, sliding along walls if blocked.
  const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
  moveWithCollision(state.map, m.pos, dir, m.speed * dt, isWalkable);
}
