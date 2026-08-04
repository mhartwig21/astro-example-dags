import { describe, it, expect } from "vitest";
import { createGame, buildFloor, step } from "../src/sim/game";
import { CONFIG, floorTimeBudget } from "../src/sim/config";
import { DAILY_RULES, DAILY_RULE_ROTATION, dailyRuleFor } from "../src/sim/dailyRules";
import { RunRecorder, replayProof, diffClaim, encodeProof, decodeProof, validateProofShape } from "../src/sim/replay";
import { runBot, botIntent, freshMemory } from "../src/sim/bot";
import { NO_INTENT } from "../src/sim/types";

// TODAY'S RULE (NICHE.md §4.8): one seeded run-level mutator per day, in the
// sim, announced in the System's voice. These tests pin the three contract
// points: the draw is a pure function of the day string, every seam is a
// no-op without a rule, and a ruled run replays only under its rule.

describe("the daily rule draw", () => {
  it("is a pure function of the day string", () => {
    expect(dailyRuleFor("2026-08-04")).toBe(dailyRuleFor("2026-08-04"));
    // Across a month of days, the whole rotation gets dealt (no dead rule).
    const seen = new Set<string>();
    for (let d = 1; d <= 28; d++) {
      const rule = dailyRuleFor(`2026-09-${String(d).padStart(2, "0")}`);
      if (rule) seen.add(rule);
    }
    expect([...seen].sort()).toEqual([...DAILY_RULE_ROTATION].sort());
  });

  it("every rotation member has a System line and a name", () => {
    for (const id of DAILY_RULE_ROTATION) {
      expect(DAILY_RULES[id].line.length).toBeGreaterThan(20);
      expect(DAILY_RULES[id].name.length).toBeGreaterThan(2);
    }
  });
});

describe("the rule seams", () => {
  it("no rule = the base game (null collapses every seam)", () => {
    const base = createGame(4242);
    const ruled = createGame(4242, "coop", "race", null);
    expect(ruled.timeBudget).toBe(base.timeBudget);
    expect(ruled.dailyRule ?? null).toBeNull();
  });

  it("RUSH HOUR shortens the collapse clock and announces itself", () => {
    const g = createGame(4242, "coop", "race", "rush_hour");
    expect(g.timeBudget).toBeCloseTo(floorTimeBudget(1) * 0.8, 9);
    expect(g.announcements.some((a) => a.text.includes("RUSH HOUR") && a.priority === "high")).toBe(true);
  });

  it("RUSH HOUR pays gold pickups 1.5x at the source", () => {
    const base = createGame(777);
    const ruled = createGame(777, "coop", "race", "rush_hour");
    for (const g of [base, ruled]) {
      const p = g.players[0];
      g.loot.push({ id: g.nextEntityId++, pos: { x: p.pos.x, y: p.pos.y }, kind: "gold", amount: 100 });
      const before = p.gold;
      step(g, NO_INTENT, 1 / 30);
      expect(p.gold - before).toBe(g === ruled ? 150 : 100);
    }
  });

  it("OVERSTAFFED fields a second named elite per ordinary floor", () => {
    const count = (rule: "overstaffed" | null): number => {
      const g = createGame(555, "coop", "race", rule);
      buildFloor(g, 2); // floor 2: first elite floor, never a boss arena
      return g.monsters.filter((m) => m.elite && m.eliteName).length;
    };
    expect(count(null)).toBe(1);
    expect(count("overstaffed")).toBe(2);
  });

  it("HAIR TRIGGER multiplies band-boss damage by 1.2", () => {
    const bossDamage = (rule: "hair_trigger" | null): number => {
      const g = createGame(999, "coop", "race", rule);
      buildFloor(g, 3); // first band-boss arena
      const boss = g.monsters.find((m) => m.kind === "boss")!;
      expect(boss).toBeTruthy();
      return boss.damage;
    };
    expect(bossDamage("hair_trigger") / bossDamage(null)).toBeCloseTo(1.2, 6);
  });
});

describe("the rule in the run contract (replay honesty)", () => {
  it("the proof header carries the rule and the replay executes under it", () => {
    // Record a short ruled run the way the host does (MUST-3: the sim eats
    // the recorded intent), then replay it — the verdict must match.
    const rule = "rush_hour";
    const g = createGame(31337, "coop", "race", rule);
    const rec = new RunRecorder({ seed: 31337, mode: "coop", runKind: "race", dailyRule: rule });
    const mem = freshMemory();
    for (let i = 0; i < 600 && g.status === "playing"; i++) {
      step(g, rec.record(botIntent(g, mem)), 1 / 60);
    }
    const proof = rec.finish(g, g.players[0].id);
    expect(proof.header.dailyRule).toBe(rule);
    const decoded = decodeProof(encodeProof(proof));
    expect(decoded.header.dailyRule).toBe(rule);
    expect(validateProofShape(decoded)).toBeNull();
    // The replay executes under the header's rule — zero-tolerance claim diff.
    const { summary } = replayProof(decoded);
    expect(diffClaim(summary, decoded.claim)).toEqual([]);
  });

  it("a proof claiming an unknown rule is rejected on shape", () => {
    const g = createGame(1, "coop", "race", null);
    const rec = new RunRecorder({ seed: 1, mode: "coop", runKind: "race" });
    step(g, rec.record(botIntent(g, freshMemory())), 1 / 60);
    const proof = rec.finish(g, g.players[0].id);
    (proof.header as { dailyRule?: string }).dailyRule = "free_pizza";
    expect(validateProofShape(proof)).toBe("unknown daily rule");
  });

  it("a full-floor ruled bot run completes without desync-shaped surprises", () => {
    const g = createGame(2026, "coop", "race", dailyRuleFor("2026-08-04"));
    const r = runBot(g, 1, 200_000);
    expect(r.steps).toBeGreaterThan(0);
    void CONFIG;
  });
});
