import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  canonicalIntent, decodeIntent, decodeProof, diffClaim, encodeIntent, encodeProof,
  MAX_PROOF_BYTES, ReplayEraError, ReplayFormatError, ReplaySession, replayProof,
  REPLAY_DT, rleFrames, unrleFrames, validateProofShape, RunRecorder,
} from "../src/sim/replay";
import { RULES_HASH } from "../src/sim/rulesHash";
import { computeRulesHash } from "../scripts/simhash";
import { serialize } from "../src/sim/snapshot";
import { recordBotRun } from "../tools/replaycheck";
import type { Intent } from "../src/sim/types";

const SIM = join(__dirname, "..", "src", "sim");

describe("RunProof codec", () => {
  it("round-trips an intent through the 4-byte frame", () => {
    const i: Intent = {
      move: { x: 0.6, y: -0.8 }, useStairs: true, attack: true, flask: true,
      aim: { x: -0.3, y: 0.95 }, cast: [true, false, true, false, true],
    };
    const buf = new Uint8Array(4);
    encodeIntent(canonicalIntent(i), buf, 0);
    const back = decodeIntent(buf, 0);
    // Quantization happens BEFORE the sim, so a second pass is a fixed point -
    // that is the property that makes record and replay agree by construction.
    expect(canonicalIntent(back)).toEqual(back);
    expect(back.useStairs).toBe(true);
    expect(back.attack).toBe(true);
    expect(back.flask).toBe(true);
    expect(back.cast).toEqual([true, false, true, false, true]);
    expect(Math.atan2(back.move.y, back.move.x)).toBeCloseTo(Math.atan2(-0.8, 0.6), 1);
  });

  it("RLE survives a round trip and refuses a truncated stream", () => {
    const ticks = 5000;
    const frames = new Uint8Array(ticks * 4);
    for (let t = 0; t < ticks; t++) frames[t * 4] = t < 3000 ? 1 : 3;
    const packed = rleFrames(frames, ticks);
    expect(packed.length).toBeLessThan(64); // two runs, that is the whole point
    expect(unrleFrames(packed, ticks)).toEqual(frames);
    expect(() => unrleFrames(packed.subarray(0, 3), ticks)).toThrow(ReplayFormatError);
    expect(() => unrleFrames(packed, ticks - 1)).toThrow(ReplayFormatError);
  });

  it("rejects a malformed artifact rather than trying to run it", () => {
    expect(() => decodeProof(new Uint8Array(4))).toThrow(ReplayFormatError);
    expect(() => decodeProof(new Uint8Array(64))).toThrow(ReplayFormatError);
    expect(() => decodeProof(new Uint8Array(MAX_PROOF_BYTES + 1))).toThrow(ReplayFormatError);
  });
});

describe("replay determinism: record -> replay is byte-identical", () => {
  // The whole verification spine rests on this. Recorded with the SHIPPING
  // codec, replayed from the seed, and compared on the full serialized world -
  // not on a summary that could agree by luck.
  for (const seed of [11, 47, 101, 13, 2024]) {
    it(`seed ${seed} replays to the same world`, () => {
      const { proof, finalWorld } = recordBotRun(seed, 4);
      const decoded = decodeProof(encodeProof(proof));
      const { summary, session } = replayProof(decoded);
      expect(serialize(session.state)).toBe(finalWorld);
      expect(diffClaim(summary, decoded.claim)).toEqual([]);
      expect(summary.elapsedSec).toBeCloseTo(proof.header.ticks * REPLAY_DT, 9);
    }, 60_000);
  }

  it("derives splits, the named death and the final build without asking the client", () => {
    const { proof } = recordBotRun(101, 6);
    const { summary } = replayProof(decodeProof(encodeProof(proof)));
    expect(summary.floorEntryTicks[0]).toBe(0);
    expect(summary.bandSplitTicks.reduce((a, b) => a + b, 0)).toBe(summary.ticks);
    expect(summary.build.level).toBe(summary.level);
    if (summary.status === "dead") {
      // The one-field ride-along: state.hits is wiped every step, so this can
      // only come from Player.lastHitSrc.
      expect(summary.death).not.toBeNull();
      expect(typeof summary.death?.by).toBe("string");
      expect(summary.death?.maxHp).toBeGreaterThan(0);
    }
  }, 60_000);

  it("keeps a full-depth artifact under the size ceiling", () => {
    // A regression guard: a future sim change that makes intents unrepresentable
    // must fail loudly here instead of silently breaking verification.
    const { proof } = recordBotRun(7, 8);
    const bytes = encodeProof(proof);
    expect(bytes.length).toBeLessThan(MAX_PROOF_BYTES);
    expect(gzipSync(Buffer.from(bytes)).length).toBeLessThan(64 * 1024);
  }, 60_000);
});

describe("shape validation runs before anything expensive", () => {
  function base(): ReturnType<typeof decodeProof> {
    const rec = new RunRecorder({ seed: 5, mode: "coop", runKind: "race" });
    rec.record({ move: { x: 1, y: 0 }, useStairs: false });
    rec.action("reward", 0);
    return decodeProof(encodeProof({
      header: {
        v: 1, rulesHash: RULES_HASH, seed: 5, mode: "coop", runKind: "race",
        startKind: "fresh", ticks: 1, dtNum: 1, dtDen: 60, clientBuild: "test",
      },
      frames: rleFrames(new Uint8Array(4), 1),
      actions: [[0, "reward", 0]],
      claim: { status: "playing", won: false, floor: 1, ticks: 1, kills: 0, level: 1, ultimate: null },
    }));
  }

  it("accepts a well-formed proof", () => {
    expect(validateProofShape(base())).toBeNull();
  });

  it("refuses an unknown op, out-of-order actions and a bad timestep", () => {
    const p1 = base();
    p1.actions = [[0, "exec" as never, "rm -rf"]];
    expect(validateProofShape(p1)).toBe("unknown action op");

    const p2 = base();
    p2.header.ticks = 10;
    p2.claim.ticks = 10;
    p2.actions = [[5, "ready"], [2, "ready"]];
    expect(validateProofShape(p2)).toBe("actions out of order");

    const p3 = base();
    p3.header.dtDen = 30;
    expect(validateProofShape(p3)).toBe("unsupported timestep");

    const p4 = base();
    p4.actions = [[999, "ready"]];
    expect(validateProofShape(p4)).toBe("action tick out of range");
  });
});

describe("the era gate (COMPETITIVE.md 2.6f)", () => {
  it("refuses a foreign proof loudly instead of running it into the current sim", () => {
    const { proof } = recordBotRun(13, 2);
    proof.header.rulesHash = "f".repeat(64);
    expect(() => new ReplaySession(proof)).toThrow(ReplayEraError);
    try {
      new ReplaySession(proof);
    } catch (err) {
      // The player is told WHICH era, not handed a silently disabled button.
      expect(String(err)).toContain("NOT PLAYABLE ON ERA");
    }
  }, 60_000);

  it("runs a proof whose era is one this build carries", () => {
    const { proof } = recordBotRun(13, 2);
    const s = new ReplaySession(proof, { availableEras: ["a".repeat(64), RULES_HASH] });
    expect(s.totalTicks).toBe(proof.header.ticks);
  }, 60_000);
});

describe("chunked replay (the verify worker's duty cycle)", () => {
  it("chunked advance produces the same world as one shot", () => {
    const { proof, finalWorld } = recordBotRun(555, 3);
    const s = new ReplaySession(proof);
    while (!s.advance(37)) { /* deliberately ugly chunk size */ }
    expect(serialize(s.state)).toBe(finalWorld);
  }, 60_000);
});

describe("the rules hash (COMPETITIVE.md 2.6a)", () => {
  it("the committed constant is not stale", () => {
    // A sim change that forgets `npx tsx scripts/simhash.ts --write` cannot merge.
    expect(RULES_HASH).toBe(computeRulesHash());
  });

  it("a comment, a type annotation or a reformat does NOT move it", () => {
    const file = join(SIM, "movement.ts");
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, "// a doc rewrite nobody should pay an era for\n"
        + original.replace(/\n/g, "\n") + "\n/* trailing block comment */\n");
      expect(computeRulesHash()).toBe(RULES_HASH);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("a CONFIG number DOES move it - a balance change is a rules change", () => {
    const file = join(SIM, "config.ts");
    const original = readFileSync(file, "utf8");
    try {
      // Regex, not a literal: the knob's VALUE moves with balance passes and
      // this test must not silently no-op when it does (it did once — the
      // step-0 retune moved 1.08 to 1.048 and the replace found nothing).
      const bumped = original.replace(/monsterScaleCompound: [\d.]+/, "monsterScaleCompound: 9.99");
      expect(bumped).not.toBe(original); // the needle must have matched
      writeFileSync(file, bumped);
      expect(computeRulesHash()).not.toBe(RULES_HASH);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("bot.ts is outside the hash - tuning the balance bot never evicts a proof", () => {
    const file = join(SIM, "bot.ts");
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, original + "\nexport const BOT_TWEAK = 42;\n");
      expect(computeRulesHash()).toBe(RULES_HASH);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("a tips.ts STRING does not move it, but a tip KEY does", () => {
    const file = join(SIM, "tips.ts");
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, original.replace(
        "COURTESY EXPLANATION: your broadcast flatlined",
        "COURTESY EXPLANATION: your broadcast went flat",
      ));
      expect(computeRulesHash()).toBe(RULES_HASH);
      writeFileSync(file, original.replace("  interference:", "  brandNewTip:\n    \"x\",\n  interference:"));
      expect(computeRulesHash()).not.toBe(RULES_HASH);
    } finally {
      writeFileSync(file, original);
    }
  });
});

