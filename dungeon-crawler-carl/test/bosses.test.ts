import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restoreGame, step, damageMonster } from "../src/sim/game";
import { serialize, deserialize } from "../src/sim/snapshot";
import { CONFIG } from "../src/sim/config";
import { createRng } from "../src/sim/rng";
import {
  BOSS_MUTATORS, BOSS_POOL, allBossDefs, bandForBossFloor, bossDef, bossHash,
  drawBossEncounter, pickBandBoss, rollBossMutators,
} from "../src/sim/bosses";
import type { BossId, GameState, Monster } from "../src/sim/types";

// BOSSES V2 (BOSSES-V2.md). The problem this file guards is the one the audit
// measured: three consecutive runs x six boss floors produced ONE name, ONE
// signature, ONE HP value and ONE arena shape per slot. Variety across runs
// was not "low" — it was zero. Everything here exists to keep it non-zero, and
// to keep the mechanics that pay for it honest.

const DT = 1 / 60;
const idle = () => ({ move: { x: 0, y: 0 }, useStairs: false });

/** The floor a band's boss holds. */
function floorForBand(band: number): number {
  return band === 6 ? CONFIG.finalFloor : band * CONFIG.bossFloorEvery;
}

/** A seed whose (pure) draw produces this boss. */
function seedForBoss(id: BossId, floor: number, avoidMutators = false): number {
  const band = bandForBossFloor(floor);
  for (let seed = 1; seed < 100_000; seed++) {
    const def = pickBandBoss(seed, band);
    if (def.id !== id) continue;
    if (avoidMutators && rollBossMutators(seed, floor, def).length > 0) continue;
    return seed;
  }
  throw new Error(`no seed draws ${id} on floor ${floor}`);
}

/** That boss's arena, crowd cleared, intro already played, crawler in range. */
function stageBoss(id: BossId, opts: { level?: number; hp?: number } = {}) {
  const def = bossDef(id)!;
  const floor = floorForBand(def.band);
  const g = restoreGame({
    seed: seedForBoss(id, floor), floor,
    player: {
      hp: opts.hp ?? 900, level: opts.level ?? 16, xp: 0, xpToNext: 99999, gold: 0,
      bonusMaxHp: 600, bonusDamage: 120,
    },
  });
  const boss = g.monsters.find((m) => m.kind === "boss")!;
  expect(boss.bossId, `staged ${id}`).toBe(id);
  // Keep the boss's own aides/adds; retire the ordinary arena crowd.
  g.monsters = g.monsters.filter((m) => m.kind === "boss" || m.tetherId === boss.id);
  boss.introduced = true;
  g.players[0].pos = { x: boss.pos.x + 5, y: boss.pos.y };
  return { g, boss, def, floor };
}

/** Run the sim, keeping the crawler alive and in range (we are measuring the
 *  BOSS, not the bot). Returns everything the boss did. */
function observe(g: GameState, boss: Monster, seconds: number) {
  const windups = new Set<string>();
  const events: string[] = [];
  let staggered = false;
  let biggestHit = 0;
  const p = g.players[0];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    // A genuinely immortal observer: a downed crawler stops the world (status
    // flips and step() early-returns), which silently turns "the boss did
    // nothing for 60s" into a passing test.
    p.hp = p.maxHp;
    p.alive = true;
    p.downedT = 0;
    g.status = "playing";
    if (boss.hp > 0 && Math.hypot(p.pos.x - boss.pos.x, p.pos.y - boss.pos.y) > 6) {
      p.pos = { x: boss.pos.x + 4, y: boss.pos.y };
    }
    step(g, idle(), DT);
    // Per-HIT, not per-step: two hazards landing on the same frame are two
    // mistakes, and the budget in §6.2 is about a single telegraphed hit.
    for (const h of g.hits) if (h.kind === "player" && h.amount > biggestHit) biggestHit = h.amount;
    if (boss.windupKind) windups.add(boss.windupKind);
    if (boss.stagger > 0) staggered = true;
    for (const e of g.bossEvents ?? []) events.push(e.kind + (e.label ? ":" + e.label : ""));
  }
  return { windups, events, staggered, biggestHit };
}

/**
 * Clear whatever beat the chassis is mid-way through, so the NEXT frame is
 * free for the verb under test. A boss parked in a punish windup, a stagger or
 * an intermission is doing exactly what it should — it is just not doing the
 * thing this assertion is about, and a test that measures the wrong two
 * seconds reports "no verb" for a boss that has one.
 */
function clearBossBeat(boss: Monster): void {
  boss.windup = 0;
  boss.windupKind = undefined;
  boss.stagger = 0;
  boss.invulnT = 0;
  boss.heat = 0;
  boss.punishArmed = false;
}

describe("V9 — seeded boss selection (the fix for 'the same boss every run')", () => {
  it("the draw is PURE: same seed, same lineup — always", () => {
    for (const seed of [1, 7, 909, 123456]) {
      const a = [1, 2, 3, 4, 5, 6].map((b) => drawBossEncounter(seed, floorForBand(b)));
      const b = [1, 2, 3, 4, 5, 6].map((band) => drawBossEncounter(seed, floorForBand(band)));
      expect(a.map((d) => [d.def.id, d.mutators, d.arena]))
        .toEqual(b.map((d) => [d.def.id, d.mutators, d.arena]));
    }
  });

  it("consumes NO rng — the floor's spawn stream is untouched by the draw", () => {
    // The whole discipline of the round: pulling from state.rng would shift
    // every downstream spawn draw and re-roll every existing fixture.
    const rng = createRng(4242);
    const before = rng.state;
    for (let band = 1; band <= 6; band++) drawBossEncounter(4242, floorForBand(band));
    expect(rng.state).toBe(before);
    // Belt and braces: the module physically cannot reach the RNG.
    const src = readFileSync(join(__dirname, "..", "src", "sim", "bosses.ts"), "utf8");
    expect(/from "\.\/rng"/.test(src), "bosses.ts must not import the seeded RNG").toBe(false);
  });

  it("actually VARIES: across seeds every band serves all three of its bosses", () => {
    for (let band = 1; band <= 6; band++) {
      const seen = new Set<BossId>();
      for (let seed = 1; seed <= 400; seed++) seen.add(pickBandBoss(seed, band).id);
      expect(seen.size, `band ${band} draws its whole pool`).toBe(BOSS_POOL[band].length);
    }
  });

  it("18 named bosses, three per band, every band covering at least three asks", () => {
    expect(allBossDefs()).toHaveLength(18);
    for (let band = 1; band <= 6; band++) {
      const pool = BOSS_POOL[band];
      expect(pool, `band ${band}`).toHaveLength(3);
      // §3.8, the anti-reskin check: whichever boss a run draws, the band
      // still plays differently from its neighbours. The UNDERCROFT is the
      // deliberate exception — it is the TEACHING band, where two of the three
      // candidates both teach "recognise the window and unload", on purpose.
      const asks = new Set(pool.map((d) => d.ask)).size;
      expect(asks, `band ${band} ask spread`).toBeGreaterThanOrEqual(band === 1 ? 2 : 3);
      for (const d of pool) {
        expect(d.band).toBe(band);
        expect(d.name.length).toBeGreaterThan(3);
        expect(d.epithet.length).toBeGreaterThan(3); // the name card needs both
        expect(d.line.length).toBeGreaterThan(10); // one System line per boss
        expect(d.arenas.length).toBeGreaterThan(0);
      }
    }
    // The finale is NAMED. The audit's most embarrassing finding was that the
    // last boss in the game was literally called "THE BOSS".
    for (const d of BOSS_POOL[6]) expect(d.name).not.toBe("THE BOSS");
  });

  it("anti-repeat: it will not serve the same band boss two runs running", () => {
    // §4.1 — pure seeding will happily repeat, and the player will not care
    // that it was statistically fair. This is the highest-value line in the doc.
    let steppedOff = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (let band = 1; band <= 6; band++) {
        const plain = pickBandBoss(seed, band);
        const avoided = pickBandBoss(seed, band, plain.id);
        expect(avoided.id, `seed ${seed} band ${band}`).not.toBe(plain.id);
        // Someone ELSE's last run must not perturb an unrelated draw.
        const other = BOSS_POOL[band].find((d) => d.id !== plain.id)!.id;
        expect(pickBandBoss(seed, band, other).id).toBe(plain.id);
        steppedOff++;
      }
    }
    expect(steppedOff).toBe(1200);
  });

  it("the lineup a run played is recorded, and a save hands it to the next one", () => {
    const g = restoreGame({
      seed: 31337, floor: 6,
      player: { hp: 300, level: 10, xp: 0, xpToNext: 999, gold: 0 },
    });
    const boss = g.monsters.find((m) => m.kind === "boss")!;
    expect(g.bossLineup?.["2"]).toBe(boss.bossId);
    // Next run, same seed, carrying that lineup: floor 6 serves someone else.
    const next = restoreGame({
      seed: 31337, floor: 6,
      player: { hp: 300, level: 10, xp: 0, xpToNext: 999, gold: 0 },
      bosses: { lastLineup: { "2": boss.bossId! } },
    });
    expect(next.monsters.find((m) => m.kind === "boss")!.bossId).not.toBe(boss.bossId);
  });

  it("the hash avalanches (no band or seed correlation in the draw)", () => {
    const counts = new Map<number, number>();
    for (let seed = 1; seed <= 3000; seed++) counts.set(bossHash(seed, 2, 7) % 3, (counts.get(bossHash(seed, 2, 7) % 3) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBeGreaterThan(3000 / 3 * 0.8);
  });
});

describe("the roster runs: every boss, every legal mutator", () => {
  it("every boss spawns, survives 60 sim-seconds, and never throws", () => {
    for (const def of allBossDefs()) {
      const { g, boss } = stageBoss(def.id);
      expect(() => observe(g, boss, 60)).not.toThrow();
    }
  });

  it("every boss commits a NON-MELEE windup or telegraph inside 60s", () => {
    // The assertion that would have caught the Crypt Concierge: measured over
    // 90 seconds it committed 62 melee windups and ZERO of anything else. A
    // boss that only swings is a big monster with more HP.
    for (const def of allBossDefs()) {
      const { g, boss } = stageBoss(def.id);
      const { windups, events } = observe(g, boss, 60);
      const nonMelee = [...windups].filter((k) => k !== "melee" && k !== "punch");
      const telegraphs = events.filter((e) => e.startsWith("telegraph"));
      expect(
        nonMelee.length + telegraphs.length,
        `${def.id} committed only melee in 60s: ${[...windups].join(",")}`,
      ).toBeGreaterThan(0);
    }
  });

  it("every boss has a PUNISH WINDOW — it over-commits and becomes helpless", () => {
    // §2.4 counterplay #6, missing on every shipped boss. The slagbreaker
    // TRASH mob had one; the headliners did not.
    for (const def of allBossDefs()) {
      const { g, boss } = stageBoss(def.id);
      const { staggered, events } = observe(g, boss, 90);
      expect(
        staggered || events.some((e) => e.startsWith("punish")),
        `${def.id} never opened a punish window in 90s`,
      ).toBe(true);
    }
  });

  it("every boss reaches its phases, and at least one edge is MECHANIC-driven", () => {
    // §2.2's rule: the player's PLAY advances the story, not just their DPS.
    let mechanicBosses = 0;
    for (const def of allBossDefs()) {
      const { g, boss } = stageBoss(def.id);
      const reasons: string[] = [];
      for (let i = 0; i < 60 * 60; i++) {
        g.players[0].hp = g.players[0].maxHp;
        g.players[0].alive = true;
        g.players[0].downedT = 0;
        g.status = "playing";
        step(g, idle(), DT);
        for (const e of g.bossEvents ?? []) if (e.kind === "phase" && e.reason) reasons.push(e.reason);
        // Walk it down the HP gates by hand — this measures the phase MACHINE.
        if (boss.hp > boss.maxHp * 0.1) boss.hp -= boss.maxHp * 0.0006;
        if (boss.hp <= 0) break;
      }
      expect(boss.phase ?? 0, `${def.id} never left phase 0`).toBeGreaterThanOrEqual(1);
      expect(reasons.length, `${def.id} emitted no phase events`).toBeGreaterThan(0);
      if (reasons.includes("mechanic") || reasons.includes("positional") || reasons.includes("timer")) {
        mechanicBosses++;
      }
    }
    // Some bosses advance on a non-HP trigger all by themselves (the
    // Concierge's ledger, the Pollinator's garden, the Architect's cover); the
    // rest need the PLAYER to do the thing, which a passive observer by
    // definition never does — those are driven explicitly in "the new verbs".
    expect(mechanicBosses, "bosses that self-advance on a non-HP trigger").toBeGreaterThanOrEqual(2);
  });

  it("every legal mutator runs on every boss without throwing", () => {
    for (const def of allBossDefs()) {
      for (const mut of BOSS_MUTATORS) {
        if (mut.legal && !mut.legal(def)) continue;
        const { g, boss } = stageBoss(def.id);
        boss.bossMutators = [mut.id];
        boss.home = undefined;
        expect(() => observe(g, boss, 30), `${def.id} + ${mut.id}`).not.toThrow();
      }
    }
  });

  it("damage budget: no single hit the BOSS lands exceeds 25% of a crawler's pool", () => {
    // §6.2. Two mistakes must be survivable; three must not be. Everything V2
    // added competes for the SAME movement budget the shipped kit already ate.
    // Adds are suppressed here on purpose: this measures the BOSS's own
    // telegraphed hits and its own ground danger. (Trash-mob damage at depth
    // is its own contract and predates this round — a floor-15 battalion bolt
    // lands ~247, which is why it would otherwise swamp the measurement.)
    for (const def of allBossDefs()) {
      const { g, boss } = stageBoss(def.id);
      const cap = g.players[0].maxHp * 0.25;
      const p = g.players[0];
      let biggest = 0;
      for (let i = 0; i < 60 * 60; i++) {
        p.hp = p.maxHp; p.alive = true; p.downedT = 0; g.status = "playing";
        g.monsters = g.monsters.filter((m) => m.kind === "boss");
        g.projectiles = g.projectiles.filter(() => true);
        if (Math.hypot(p.pos.x - boss.pos.x, p.pos.y - boss.pos.y) > 6) {
          p.pos = { x: boss.pos.x + 4, y: boss.pos.y };
        }
        step(g, idle(), DT);
        for (const h of g.hits) if (h.kind === "player" && h.amount > biggest) biggest = h.amount;
      }
      expect(biggest, `${def.id} biggest single hit`).toBeLessThanOrEqual(cap);
    }
  });

  it("damage budget, statically: every boss ability multiplier fits the band's budget", () => {
    // The config-level half of §6.2 — no simulation, no noise. Every ability a
    // boss can commit is a multiple of its own damage stat, so the budget can
    // be checked against the band's damage directly.
    const common = Math.max(
      CONFIG.bossHazardDmgMult, CONFIG.bossSlamDmgMult, CONFIG.flameDmgMult,
      CONFIG.debrisDmgMult, CONFIG.slagVentDmgMult, CONFIG.citationDmgMult,
      CONFIG.latticeDmgMult, CONFIG.bloomDmgMult, CONFIG.audienceDmgMult,
      CONFIG.fissureDmgMult, CONFIG.spitterPuddleDmgMult,
    );
    // The era's natural crawler pool (BOSSES-V2 §6.1 measured 238 / 275 / 316
    // / 370 / 466 / 442 across the six boss floors).
    const pools = [238, 275, 316, 370, 466, 442];
    for (let band = 1; band <= 6; band++) {
      // Dark Ritual is the crown: tier 3 (the finale) plus the Condemned
      // Architect's Controlled Demolition. Nothing else can commit one.
      const ritual = band === 4 || band === 6;
      const worst = ritual ? Math.max(common, CONFIG.ritualDmgMult) : common;
      const stat = band === 6
        ? CONFIG.bossDamage
        : CONFIG.bossDamage * CONFIG.bandBossDmgMult[band - 1];
      expect((stat * worst) / pools[band - 1], `band ${band} worst single hit`).toBeLessThanOrEqual(0.25);
    }
  });
});

describe("the new verbs", () => {
  it("V1 plates: the plate eats the hit, and breaking one is a MECHANIC phase", () => {
    const { g, boss } = stageBoss("permitoffice");
    expect(boss.plates).toHaveLength(CONFIG.permitPlates);
    const plate = boss.plates![0];
    expect(plate.school).toBeDefined(); // four stamps, two schools: the build check
    const bodyBefore = boss.hp;
    // Matching-school damage does NOTHING to the plate that resists it...
    const wrong = boss.plates!.find((pl) => pl.school === "magic")!;
    const hpWas = wrong.hp;
    damageMonster(g, g.players[0], boss, 400, { school: "magic", allowCrit: false });
    expect(wrong.hp, "a magic plate ignores magic").toBe(hpWas);
    expect(boss.hp, "the body is shielded while plates stand").toBeGreaterThan(bodyBefore - 400);
    // ...and burning one down is a phase the player CAUSED.
    for (let i = 0; i < 400 && !plate.broken; i++) {
      damageMonster(g, g.players[0], boss, 500, { school: "magic", allowCrit: false });
    }
    expect(plate.broken).toBe(true);
    expect(boss.phase ?? 0).toBeGreaterThanOrEqual(1);
    expect(boss.phaseReason).toBe("mechanic");
    expect((g.bossEvents ?? []).some((e) => e.kind === "plate")).toBe(true);
  });

  it("V1 plates: the Rent Collector's lockbox refunds WITH INTEREST", () => {
    const { g, boss } = stageBoss("rentcollector");
    const p = g.players[0];
    p.gold = 500;
    boss.lockbox = 0;
    observe(g, boss, 20); // let it collect at least once
    expect(boss.lockbox ?? 0, "Late Fee seized nothing").toBeGreaterThan(0);
    const held = boss.lockbox!;
    const goldOnFloor = () => g.loot.filter((l) => l.kind === "gold").reduce((n, l) => n + l.amount, 0);
    const before = goldOnFloor();
    const box = boss.plates!.find((pl) => pl.key === "lockbox")!;
    for (let i = 0; i < 400 && !box.broken; i++) damageMonster(g, p, boss, 400, { allowCrit: false });
    expect(box.broken).toBe(true);
    expect(goldOnFloor() - before).toBe(Math.round(held * CONFIG.lateFeeInterest));
  });

  it("V2 shield: it absorbs, it REGROWS in the gap, and breaking it is a phase", () => {
    const { g, boss } = stageBoss("topiary");
    expect(boss.shieldMax).toBeGreaterThan(0);
    expect(boss.shieldHp).toBe(boss.shieldMax);
    const hp0 = boss.hp;
    damageMonster(g, g.players[0], boss, 300, { allowCrit: false });
    expect(boss.shieldHp!).toBeLessThan(boss.shieldMax!);
    expect(boss.hp, "the pool eats it before the health bar does").toBe(hp0);
    const dented = boss.shieldHp!;
    for (let i = 0; i < 60 * 6; i++) step(g, idle(), DT);
    expect(boss.shieldHp!, "the hedge regrew").toBeGreaterThan(dented);
    for (let i = 0; i < 600 && (boss.shieldHp ?? 0) > 0; i++) {
      damageMonster(g, g.players[0], boss, 900, { allowCrit: false });
    }
    expect(boss.shieldHp).toBe(0);
    expect(boss.phaseReason).toBe("mechanic");
    expect((g.bossEvents ?? []).some((e) => e.kind === "shieldbreak")).toBe(true);
  });

  it("V2 shield: The Sponsor's brand only breaks to ONE school", () => {
    const { g, boss } = stageBoss("sponsor");
    step(g, idle(), DT); // the kit brands the opening segment
    const school = boss.shieldSchool!;
    const other = school === "physical" ? "magic" : "physical";
    const pool = boss.shieldHp!;
    damageMonster(g, g.players[0], boss, 2000, { school: other, allowCrit: false });
    expect(boss.shieldHp, "the wrong school does nothing to the brand").toBe(pool);
    damageMonster(g, g.players[0], boss, 2000, { school, allowCrit: false });
    expect(boss.shieldHp!).toBeLessThan(pool);
  });

  it("V4 punish window: the count runs out, it over-commits, it is helpless", () => {
    const { g, boss } = stageBoss("marshal");
    boss.heat = CONFIG.bossPunishAfter;
    const seen: string[] = [];
    for (let i = 0; i < 60 * 8; i++) {
      g.players[0].hp = g.players[0].maxHp;
      g.players[0].alive = true;
      step(g, idle(), DT);
      for (const e of g.bossEvents ?? []) seen.push(e.kind);
      if (boss.stagger > 0) break;
    }
    expect(seen).toContain("punish");
    expect(boss.stagger).toBeGreaterThan(0);
    expect(boss.staggerGraceT ?? 0, "the window is EARNED — no composure grace").toBe(0);
    expect(boss.heat).toBe(0);
  });

  it("V5 hard enrage: past the deadline the System stops being patient", () => {
    const { g, boss } = stageBoss("foundation");
    boss.fightT = CONFIG.bossEnrageDeadline;
    const dmg0 = boss.damage;
    observe(g, boss, CONFIG.bossEnrageStackSeconds * 2 + 1);
    expect(boss.enrageStacks ?? 0).toBeGreaterThanOrEqual(2);
    expect(boss.damage).toBeGreaterThan(dmg0);
    expect(CONFIG.mutatorOvertimeFraction, "OVERTIME moves the CLOCK, not the numbers").toBeLessThan(1);
  });

  it("V6 intermission: a phase edge sweeps the board instead of compounding it", () => {
    const { g, boss } = stageBoss("architect");
    const p = g.players[0];
    for (let i = 0; i < 60 * 30 && g.hazards.length === 0; i++) {
      p.hp = p.maxHp; p.alive = true; g.status = "playing";
      step(g, idle(), DT);
    }
    expect(g.hazards.length, "no ground danger to sweep").toBeGreaterThan(0);
    const doomed = new Set(g.hazards.filter((h) => h.kind !== "beam").map((h) => h.id));
    boss.hp = Math.floor(boss.maxHp * 0.5);
    step(g, idle(), DT);
    expect(boss.invulnT ?? 0, "briefly untargetable").toBeGreaterThan(0);
    // Every zone that was live when the break landed is GONE — the board is
    // re-dealt, not compounded. (Anything the room lays afterwards is the
    // next phase's problem, which is the point of the beat.)
    expect(g.hazards.filter((h) => doomed.has(h.id))).toHaveLength(0);
    const hp = boss.hp;
    damageMonster(g, g.players[0], boss, 5000, { allowCrit: false });
    expect(boss.hp, "untargetable means untargetable").toBe(hp);
  });

  it("V8 tether: adds FEED the boss, and cutting the cords is a phase", () => {
    const { g, boss } = stageBoss("concierge");
    observe(g, boss, 14); // it rings for service
    expect(g.monsters.filter((m) => m.tetherId === boss.id && m.hp > 0).length).toBeGreaterThan(0);
    boss.hp = Math.floor(boss.maxHp * 0.5);
    const wounded = boss.hp;
    for (let i = 0; i < 120; i++) step(g, idle(), DT);
    expect(boss.hp, "the tether feeds it").toBeGreaterThan(wounded);
    for (const m of g.monsters) if (m.tetherId === boss.id) m.hp = 0;
    for (let i = 0; i < 60 * 6; i++) {
      boss.invulnT = 0; // skip the intermission; the ledger beat is the point
      g.players[0].hp = g.players[0].maxHp;
      g.players[0].alive = true;
      step(g, idle(), DT);
      if (boss.phaseReason === "mechanic") break;
    }
    expect(boss.phaseReason, "the empty ledger is a phase the PLAYER caused").toBe("mechanic");
  });

  it("V3 props: the arena is the counterplay, and the boss cannot eat it", () => {
    for (const id of ["sumpking", "marshal", "linesupervisor"] as const) {
      const { g, boss } = stageBoss(id);
      const props = (g.breakables ?? []).filter((b) => b.onBreak);
      expect(props.length, `${id} arena has no props`).toBeGreaterThan(0);
      expect(props.every((b) => b.footprint && b.footprint.length > 0)).toBe(true);
      observe(g, boss, 20);
      expect(
        (g.breakables ?? []).filter((b) => b.onBreak).length,
        `${id} solved its own mechanic by flattening the props`,
      ).toBe(props.length);
    }
  });

  it("V3 props: breaking the LAST conveyor is a mechanic phase (attack the SYSTEM)", () => {
    const { g, boss } = stageBoss("linesupervisor");
    const props = (g.breakables ?? []).filter((b) => b.onBreak === "shutdown");
    expect(props.length).toBeGreaterThan(0);
    const p = g.players[0];
    for (const b of props) {
      for (let i = 0; i < 240 && (g.breakables ?? []).includes(b); i++) {
        p.hp = p.maxHp; p.alive = true; g.status = "playing";
        p.pos = { x: b.pos.x - 0.6, y: b.pos.y };
        p.facing = { x: 1, y: 0 };
        step(g, { move: { x: 0, y: 0 }, useStairs: false, attack: true, aim: { x: 1, y: 0 } }, DT);
      }
    }
    expect((g.breakables ?? []).some((b) => b.onBreak === "shutdown")).toBe(false);
    expect(boss.phase ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("V10 — mutators change the ASK, never the numbers", () => {
  it("gating mirrors the shipped floor-1-stays-pristine rule", () => {
    for (const def of BOSS_POOL[1]) {
      for (let seed = 1; seed <= 200; seed++) {
        expect(rollBossMutators(seed, 3, def), "the teaching band stays clean").toEqual([]);
      }
    }
    for (let seed = 1; seed <= 200; seed++) {
      for (const floor of [6, 9, 12]) {
        const def = pickBandBoss(seed, bandForBossFloor(floor));
        expect(rollBossMutators(seed, floor, def).length).toBe(1);
      }
      for (const floor of [15, CONFIG.finalFloor]) {
        const def = pickBandBoss(seed, bandForBossFloor(floor));
        expect(rollBossMutators(seed, floor, def).length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("never draws two that both add bodies, and never one it cannot apply", () => {
    for (let seed = 1; seed <= 500; seed++) {
      for (const def of allBossDefs()) {
        const floor = def.band === 6 ? CONFIG.finalFloor : def.band * CONFIG.bossFloorEvery;
        const rolled = rollBossMutators(seed, floor, def, true);
        expect(new Set(rolled).size, "no duplicates").toBe(rolled.length);
        const adds = rolled.filter((m) => BOSS_MUTATORS.find((x) => x.id === m)?.addsPressure);
        expect(adds.length, `${def.id} drew two adds mutators`).toBeLessThanOrEqual(1);
        for (const id of rolled) {
          const info = BOSS_MUTATORS.find((x) => x.id === id)!;
          expect(!info.legal || info.legal(def), `${id} illegal on ${def.id}`).toBe(true);
        }
      }
    }
  });

  it("every mutator carries one sentence of counterplay for the name card", () => {
    expect(BOSS_MUTATORS).toHaveLength(8);
    for (const m of BOSS_MUTATORS) {
      expect(m.label).toBe(m.label.toUpperCase());
      expect(m.note.length, `${m.id} has no counterplay sentence`).toBeGreaterThan(20);
    }
  });

  it("RETROFIT swaps the telegraph on a familiar body", () => {
    const marshal = bossDef("marshal")!;
    let checked = 0;
    for (let seed = 1; seed <= 4000 && checked === 0; seed++) {
      if (!rollBossMutators(seed, 15, marshal).includes("retrofit")) continue;
      if (pickBandBoss(seed, 5).id !== "marshal") continue;
      const g = restoreGame({
        seed, floor: 15, player: { hp: 900, level: 16, xp: 0, xpToNext: 9999, gold: 0 },
      });
      const boss = g.monsters.find((m) => m.kind === "boss")!;
      expect(boss.signature, "RETROFIT kept the same telegraph").not.toBe(marshal.signature);
      expect(boss.signature).toBeDefined();
      checked++;
    }
    expect(checked, "no seed produced a RETROFIT marshal").toBe(1);
  });

  it("UNDERSTUDIED gives the break-window back, exactly once", () => {
    const { g, boss } = stageBoss("topiary");
    boss.bossMutators = ["understudied"];
    boss.shieldHp = 0;
    boss.hp = Math.floor(boss.maxHp * 0.45);
    step(g, idle(), DT);
    expect(boss.shieldHp, "the armour came back once").toBe(boss.shieldMax);
    expect(boss.tetherRevived, "and only once").toBe(true);
  });

  it("SPONSORED defends a SPOT — moving the fight is the counterplay", () => {
    const { g, boss } = stageBoss("foundation");
    boss.bossMutators = ["sponsored"];
    boss.home = undefined;
    step(g, idle(), DT);
    expect(boss.home, "it never claimed its bubble").toBeDefined();
    const inside = boss.hp;
    damageMonster(g, g.players[0], boss, 1000, { allowCrit: false });
    const tookInside = inside - boss.hp;
    boss.home = { x: boss.pos.x + 40, y: boss.pos.y + 40 }; // pulled off its ground
    const outside = boss.hp;
    damageMonster(g, g.players[0], boss, 1000, { allowCrit: false });
    expect(outside - boss.hp, "the bubble did nothing").toBeGreaterThan(tookInside);
  });

  it("UNION RULES: its adds get back up ONCE, on a delay", () => {
    const { g, boss } = stageBoss("greasetrap");
    boss.bossMutators = ["unionrules"];
    observe(g, boss, 10);
    const add = g.monsters.find((m) => m.tetherId === boss.id && m.hp > 0)!;
    expect(add, "no tethered add to test").toBeDefined();
    add.hp = 0;
    step(g, idle(), DT);
    expect(g.monsters.includes(add), "it should have got back up").toBe(true);
    expect(add.hp).toBeGreaterThan(0);
    expect(add.stagger, "down, but not out, on a delay").toBeGreaterThan(0);
    add.hp = 0;
    step(g, idle(), DT);
    expect(g.monsters.includes(add), "twice is not once").toBe(false);
  });

  it("OVERTIME moves the CLOCK; LIVE AUDIENCE makes the ROOM act", () => {
    expect(CONFIG.bossEnrageDeadline * CONFIG.mutatorOvertimeFraction)
      .toBeLessThan(CONFIG.bossEnrageDeadline);
    const { g, boss } = stageBoss("inspector");
    boss.bossMutators = ["liveaudience"];
    g.arenaT = 0;
    let thrown = 0;
    const p = g.players[0];
    for (let i = 0; i < Math.round((CONFIG.audienceInterval + 2) * 60); i++) {
      p.hp = p.maxHp; p.alive = true; g.status = "playing";
      const before = g.hazards.length;
      step(g, idle(), DT);
      if (g.hazards.length > before) thrown++;
    }
    expect(thrown, "the crowd never threw anything").toBeGreaterThan(0);
  });
});

describe("§4.3 arena variants + §4.4 escalation on repeat", () => {
  it("the arena drawn is always one the boss is legal in", () => {
    for (let seed = 1; seed <= 500; seed++) {
      for (let band = 1; band <= 6; band++) {
        const draw = drawBossEncounter(seed, floorForBand(band));
        expect(draw.def.arenas, `${draw.def.id} drew an illegal arena`).toContain(draw.arena);
      }
    }
    // The constraints §3 states, verbatim.
    expect(bossDef("inspector")!.arenas).not.toContain("pillared"); // lanes need sightlines
    expect(bossDef("greasetrap")!.arenas).not.toContain("open"); // it needs anchors
    expect(bossDef("architect")!.arenas).toEqual(["pillared"]); // it eats the cover
    expect(bossDef("pollinator")!.arenas).toEqual(["open"]); // the storm IS the problem
  });

  it("a PILLARED arena contains destructible cover; the audit measured 0", () => {
    const pillared = stageBoss("architect");
    expect(pillared.g.arenaVariant).toBe("pillared");
    const cover = (pillared.g.breakables ?? []).filter((b) => b.key === "pillar");
    expect(cover.length, "the Architect has nothing to demolish").toBeGreaterThan(0);
    expect(stageBoss("pollinator").g.arenaVariant).toBe("open");
  });

  it("the Architect DEMOLISHES the arena's cover over the fight (zero new verbs)", () => {
    const { g } = stageBoss("architect");
    const count = () => (g.breakables ?? []).filter((b) => b.key === "pillar").length;
    const before = count();
    expect(before).toBeGreaterThan(0);
    const pillar = (g.breakables ?? []).find((b) => b.key === "pillar")!;
    for (let i = 0; i < 60 * 60; i++) {
      const p = g.players[0];
      p.hp = p.maxHp; p.alive = true; p.downedT = 0; g.status = "playing";
      p.pos = { x: pillar.pos.x + 0.9, y: pillar.pos.y }; // stand in its way
      step(g, idle(), DT);
      if (count() < before) break;
    }
    expect(count(), "the cover survived a whole fight untouched").toBeLessThan(before);
  });

  it("a boss you have beaten opens at the phase-2 kit, with a shorter intro", () => {
    const seed = seedForBoss("sumpking", 6);
    const mk = (defeats?: Record<string, number>) => restoreGame({
      seed, floor: 6,
      player: { hp: 400, level: 11, xp: 0, xpToNext: 999, gold: 0 },
      bosses: defeats ? { defeats } : undefined,
    });
    const fresh = mk();
    const veteran = mk({ sumpking: CONFIG.bossRepeatEscalateAt });
    const a = fresh.monsters.find((m) => m.kind === "boss")!;
    const b = veteran.monsters.find((m) => m.kind === "boss")!;
    expect(a.bossId).toBe("sumpking");
    expect(b.bossId).toBe("sumpking");
    expect(a.phase ?? 0).toBe(0);
    expect(b.phase, "it does not wait to respect you").toBe(1);
    expect(b.maxHp, "escalation is MECHANICS, never stats").toBe(a.maxHp);
    expect(b.damage).toBe(a.damage);
    for (const g of [fresh, veteran]) {
      const boss = g.monsters.find((m) => m.kind === "boss")!;
      g.players[0].pos = { x: boss.pos.x + 3, y: boss.pos.y };
      step(g, idle(), DT);
    }
    expect(veteran.encounter!.total).toBeLessThan(fresh.encounter!.total);
    expect(fresh.encounter!.repeat).toBe(0);
    expect(veteran.encounter!.repeat).toBe(CONFIG.bossRepeatEscalateAt);
  });

  it("five defeats in, it brings a free mutator", () => {
    const def = bossDef("sumpking")!;
    const seed = seedForBoss("sumpking", 6);
    expect(rollBossMutators(seed, 6, def, false)).toHaveLength(1);
    expect(rollBossMutators(seed, 6, def, true).length).toBeGreaterThan(1);
  });

  it("killing a boss records the defeat for the next run", () => {
    const { g, boss } = stageBoss("sumpking");
    boss.hp = 0;
    step(g, idle(), DT);
    expect(g.bossDefeats?.sumpking).toBe(1);
  });

  it("the name card ships as DATA (title, epithet, ask, mutators, one line)", () => {
    const { g, boss } = stageBoss("safetyofficer");
    boss.introduced = false;
    g.encounter = null;
    g.players[0].pos = { x: boss.pos.x + 3, y: boss.pos.y };
    step(g, idle(), DT);
    const card = g.encounter!;
    expect(card.bossId).toBe("safetyofficer");
    expect(card.name).toBe(bossDef("safetyofficer")!.name);
    expect(card.epithet).toBe(bossDef("safetyofficer")!.epithet);
    expect(card.ask).toBe("storm");
    expect(card.line).toBe(bossDef("safetyofficer")!.line);
    expect(card.mutators?.length ?? 0).toBeGreaterThan(0); // floor 15 draws two
  });
});

describe("snapshot + save round-trip", () => {
  it("boss identity, mutators, plates and shield survive serialization", () => {
    const { g, boss } = stageBoss("permitoffice");
    boss.bossMutators = ["liveaudience"];
    boss.shieldHp = 12;
    boss.shieldMax = 40;
    boss.invulnT = 0.5;
    observe(g, boss, 3);
    const back = deserialize(serialize(g));
    const copy = back.monsters.find((m: Monster) => m.kind === "boss")!;
    expect(copy.bossId).toBe("permitoffice");
    expect(copy.bossMutators).toEqual(boss.bossMutators);
    expect(copy.plates?.length).toBe(boss.plates?.length);
    expect(copy.plates?.[0].hp).toBe(boss.plates?.[0].hp);
    expect(copy.shieldHp).toBe(boss.shieldHp);
    expect(copy.maxPhase).toBe(boss.maxPhase);
    expect(back.arenaVariant).toBe(g.arenaVariant);
    expect(back.bossLineup).toEqual(g.bossLineup);
  });

  // -------------------------------------------------------------------------
  // ACCEPTANCE ROUND: the three bosses whose kits were missing or aliased.
  // Every one of these guards a finding the capture review filed, so a
  // regression here is a regression to a shipped screenshot.
  // -------------------------------------------------------------------------

  it("THE PERMIT OFFICE has a verb: its stamps ARE the attack pattern", () => {
    const { g, boss } = stageBoss("permitoffice");
    expect(boss.plates?.length, "four authored stamps").toBe(CONFIG.permitPlates);
    const full = observe(g, boss, 12);
    expect(full.events.some((e) => e === "telegraph:STOP-WORK ORDER"),
      "the Office issued nothing in twelve seconds").toBe(true);

    // ONE LANE PER UNBROKEN STAMP. Measured on the cast frame itself — the
    // lanes are beams and they expire, so counting them "some time later" was
    // measuring the fade, not the pattern.
    const cast = () => {
      g.hazards.length = 0;
      clearBossBeat(boss);
      boss.sigCd = 0;
      boss.bossCount = 0;
      observe(g, boss, 0.4);
      return g.hazards.filter((h) => h.kind === "beam").length;
    };
    boss.plates!.forEach((p) => { p.broken = false; p.hp = p.maxHp; });
    const wide = cast();
    expect(wide, "no lanes at all").toBeGreaterThan(0);
    boss.plates![0].broken = true;
    boss.plates![1].broken = true;
    const narrow = cast();
    expect(narrow, "breaking stamps must delete lanes").toBeLessThan(wide);
  });

  it("THE SUMP KING actually uses its floodgates (prop: drain fires)", () => {
    const { g, boss } = stageBoss("sumpking");
    const gates = (g.breakables ?? []).filter((b) => b.onBreak === "drain");
    expect(gates.length, "the roster authored a drain prop; the arena must stock it")
      .toBeGreaterThan(0);
    const seen = observe(g, boss, 20);
    expect(seen.events.some((e) => e === "telegraph:SLUICE GATE"),
      "the King never opened a sluice").toBe(true);
    // The surge is anchored on the GATE, not on the King — that is what makes
    // the prop the thing you read AND the thing you break.
    g.hazards.length = 0;
    clearBossBeat(boss);
    boss.sigCd = 5; // FLOOD SURGE on cooldown: this is the sluice's off-beat
    boss.affixCd = 0;
    observe(g, boss, 0.4);
    const pools = g.hazards.filter((h) => h.kind === "sludge");
    expect(pools.length, "the sluice vented nothing").toBeGreaterThan(0);
    const reach = CONFIG.sluicePools * 2.2;
    const nearAGate = pools.some((h) => gates.some((gate) =>
      Math.hypot(h.pos.x - gate.pos.x, h.pos.y - gate.pos.y) <= reach));
    expect(nearAGate, "the sluice must vent from a gate").toBe(true);
    // The band signature is UNTOUCHED: FLOOD SURGE still owns the sigCd track.
    expect(seen.events.some((e) => e === "telegraph:FLOOD SURGE")).toBe(true);
  });

  it("THE STANDARDS BOARD is its own fight, not the Zoning Board by reference", () => {
    // The alias was literally `BOSS_KITS` dot `standards` assigned the floor-9
    // kit object. Guard the assignment, not the mention: an ALIAS is an
    // assignment to the property, so that is what the regex looks for.
    const src = readFileSync(join(__dirname, "..", "src", "sim", "ai.ts"), "utf8");
    const alias = new RegExp("^\s*BOSS_KITS\.[a-z]+\s*=", "m");
    expect(alias.test(src),
      "a finale must not alias another band's kit object").toBe(false);
    const { g, boss } = stageBoss("standards");
    const seen = observe(g, boss, 20);
    expect(seen.events.some((e) => e === "telegraph:MOTION CARRIED"),
      "the Board never moved a motion").toBe(true);
    // Every lane is fired FROM a seat and runs THROUGH the body: no safe pocket.
    g.hazards.length = 0;
    clearBossBeat(boss);
    boss.sigCd = 0;
    observe(g, boss, 0.4);
    const lanes = g.hazards.filter((h) => h.kind === "beam" && h.end);
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      const through = Math.hypot(lane.end!.x - boss.pos.x, lane.end!.y - boss.pos.y);
      expect(through, "the motion must overshoot the Board it protects")
        .toBeLessThanOrEqual(CONFIG.motionOvershoot + 3);
    }
    // And the Zoning Board still plays its own (quieter) version.
    const zb = stageBoss("zoningboard");
    const zseen = observe(zb.g, zb.boss, 20);
    expect(zseen.events.some((e) => e === "telegraph:MOTION CARRIED"),
      "the floor-9 council must NOT inherit the finale's verb").toBe(false);
  });

  it("every boss that can channel names its OWN ritual (no shared DARK RITUAL)", () => {
    // One generic label serving three finales was the capture round's finding.
    const labels = new Set<string>();
    for (const id of ["showrunner", "standards", "sponsor"] as BossId[]) {
      const { g, boss } = stageBoss(id);
      boss.bossTier = 3;
      boss.ritualCd = 0;
      boss.phase = 2;
      boss.bossCount = 1;
      const seen = observe(g, boss, 25);
      const ritual = seen.events.filter((e) => e.startsWith("telegraph:"))
        .map((e) => e.slice(10));
      expect(ritual.includes("DARK RITUAL"),
        `${id} still speaks the generic label`).toBe(false);
      for (const r of ritual) labels.add(`${id}:${r}`);
    }
    expect(labels.size).toBeGreaterThan(0);
  });

  it("THE CONDEMNED ARCHITECT always gets pillars to eat (§4 layer 3)", () => {
    // BOSSES-V2.md §4 promises the Architect only ever draws PILLARED "because
    // it eats them". A capture showed bare dirt, which makes its use-the-arena
    // ask unanswerable.
    const { g } = stageBoss("architect");
    expect(g.arenaVariant).toBe("pillared");
    const cover = (g.breakables ?? []).filter((b) => b.footprint && !b.onBreak);
    expect(cover.length, "no cover in the Architect's arena").toBeGreaterThan(2);
  });

  it("a restored snapshot steps identically (the determinism guarantee holds)", () => {
    const { g, boss } = stageBoss("greasetrap");
    observe(g, boss, 2);
    const a = deserialize(serialize(g));
    const b = deserialize(serialize(g));
    for (let i = 0; i < 240; i++) {
      step(a, idle(), DT);
      step(b, idle(), DT);
    }
    expect(serialize(a)).toBe(serialize(b));
  });
});
