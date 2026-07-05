import { ARCHETYPES, CONFIG, monsterTempo } from "./config";
import { dist, normalize } from "./combat";
import { isWalkable } from "./floor";
import type { GameState, Monster, Vec2 } from "./types";
import { moveWithCollision } from "./movement";
import { damagePlayerHit, explodeBomber, handlePlayerDeath, nearestPlayer, raiseCorpse, spawnBossWave, summonMinion } from "./game";

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
  m.attackCooldown = CONFIG.monsterAttackCooldown * monsterTempo(state.floor).cooldown;
  const reach = m.attackRange + CONFIG.monsterStrikeGrace;
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue; // dash i-frames dodge the blow
    if (dist(m.pos, player.pos) > reach) continue; // stepped out of the arc — whiff
    const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    if (damagePlayerHit(state, player, m.damage, { dir })) {
      handlePlayerDeath(state, player, `${player.name} died in the dungeon.`);
    }
  }
}

/** Ground Slam lands: a self-centered AoE, no facing/arc — everyone standing
 * within `radius` of the slammer eats it. Brute's whole attack; also a boss ability. */
function resolveSlamStrike(state: GameState, m: Monster, radius: number, dmg: number): void {
  m.attackCooldown = CONFIG.monsterAttackCooldown * monsterTempo(state.floor).cooldown;
  for (const player of state.players) {
    if (!player.alive || player.dashTime > 0) continue; // dash i-frames dodge the blow
    if (dist(m.pos, player.pos) > radius) continue;
    const dir = normalize({ x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y });
    if (damagePlayerHit(state, player, dmg, { dir })) {
      handlePlayerDeath(state, player, `${player.name} stood in the blast radius. The System rolls the replay.`);
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
    spawnEnemyBolt(state, m.pos, { x: player.pos.x - m.pos.x, y: player.pos.y - m.pos.y }, m.damage);
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
    raiseCorpse(state, m); // whiffs harmlessly if the corpse faded mid-ritual
    return;
  }
  if (kind === "slam") {
    // Brute's own attack uses its stat damage as-is; a boss's Ground Slam is an
    // extra ability layered on top of its melee+volley kit, so it's discounted.
    const radius = m.kind === "boss" ? CONFIG.bossSlamRadius : CONFIG.bruteSlamRadius;
    const dmg = m.kind === "boss" ? m.damage * CONFIG.bossSlamDmgMult : m.damage;
    resolveSlamStrike(state, m, radius, dmg);
    return;
  }
  if (kind === "ritual") {
    resolveRitualStrike(state, m);
    return;
  }
  resolveMeleeStrike(state, m);
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
  if (m.attackCooldown > 0) m.attackCooldown = Math.max(0, m.attackCooldown - dt);
  if (m.shootCd > 0) m.shootCd = Math.max(0, m.shootCd - dt);
  if (m.healCd > 0) m.healCd = Math.max(0, m.healCd - dt);
  if (m.blinkCd > 0) m.blinkCd = Math.max(0, m.blinkCd - dt);
  if ((m.affixCd ?? 0) > 0) m.affixCd = Math.max(0, (m.affixCd ?? 0) - dt);
  if ((m.surgeT ?? 0) > 0) m.surgeT = Math.max(0, (m.surgeT ?? 0) - dt);
  if ((m.slamCd ?? 0) > 0) m.slamCd = Math.max(0, (m.slamCd ?? 0) - dt);
  if ((m.ritualCd ?? 0) > 0) m.ritualCd = Math.max(0, (m.ritualCd ?? 0) - dt);
  if (m.hp <= 0) return; // dead-but-unreaped this step (e.g. a detonated bomber)

  // AMBUSH: a dormant monster lies inert until a player strays within trigger
  // range, then springs — and drags its whole cluster up with it, all surging
  // to close the gap. Until sprung it neither moves nor attacks (quiet in fog).
  if (m.dormant) {
    const prey = nearestPlayer(state, m.pos);
    if (!prey || dist(m.pos, prey.pos) > CONFIG.ambushTriggerRadius) return; // still waiting
    springAmbush(state, m);
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
  // Depth tempo: deeper floors telegraph shorter (capped so tells stay readable).
  const windup = ARCHETYPES[m.kind].windup * monsterTempo(state.floor).windup;
  // Ambush surge: freshly-sprung monsters move faster for a beat (the pounce).
  const moveSpeed = m.speed * ((m.surgeT ?? 0) > 0 ? CONFIG.ambushSurgeSpeed : 1);

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
          damage: m.damage * CONFIG.bossHazardDmgMult,
          kind: "blast",
        });
      }
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
    else moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
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

  if (m.kind === "charger") {
    // Charger: in its rush band it LOCKS a direction and telegraphs long —
    // the lane is the danger, sidestep it. Point-blank it just swings.
    if (d > CONFIG.monsterAggroRange * 1.5) return;
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
    if (d > CONFIG.monsterAggroRange * 1.7) return;
    const standoff = m.attackRange;
    if (m.shootCd === 0 && d <= standoff + 2) {
      m.shootCd = CONFIG.spitterCooldown;
      m.spitTarget = { x: player.pos.x, y: player.pos.y };
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
    if (d > CONFIG.monsterAggroRange * 1.7) return;
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
    if (d > CONFIG.monsterAggroRange * 1.7) return;
    if (d < m.attackRange) {
      moveWithCollision(state.map, m.pos, { x: -toPlayer.x, y: -toPlayer.y }, moveSpeed * dt, isWalkable);
    }
    if (
      (m.affixCd ?? 0) === 0 && (m.summons ?? 0) < CONFIG.broodSpawnMax &&
      state.monsters.length < CONFIG.monsterMaxCount * CONFIG.broodPopulationCap
    ) {
      m.affixCd = CONFIG.broodSpawnCooldown;
      m.summons = (m.summons ?? 0) + 1;
      summonMinion(state, m);
      if (m.summons === 1) {
        state.events.push("A broodmother births another mouth. Kill the nest first.");
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
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  if (m.kind === "brute") {
    // Brute: its long, scary windup resolves as a self-centered Ground Slam —
    // an AoE, not a single-target hit. Respect it (back off) or interrupt it.
    if (d > CONFIG.monsterAggroRange) return;
    if (d <= m.attackRange) {
      if (m.attackCooldown === 0) beginWindup(m, "slam", windup);
    } else {
      moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
    }
    return;
  }

  // Melee archetypes (grunt / swarmer).
  if (d > CONFIG.monsterAggroRange) return;
  if (d <= m.attackRange) {
    if (m.attackCooldown === 0) beginWindup(m, "melee", windup);
  } else {
    moveWithCollision(state.map, m.pos, toPlayer, moveSpeed * dt, isWalkable);
  }
}
