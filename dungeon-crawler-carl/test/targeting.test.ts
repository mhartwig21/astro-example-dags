import { describe, it, expect } from "vitest";
import { LAST_HIT_WINDOW, pickTarget, tapTarget, type TargetCandidate } from "../src/input/targeting";

/**
 * The smart-cast priority ladder. The thing it replaces picked the nearest
 * living monster, full stop — no lock, no last-hit bias, no range respect, and
 * it happily aimed at a dormant ambusher that had not woken up yet.
 */

const mob = (id: number, x: number, y: number, over: Partial<TargetCandidate> = {}): TargetCandidate =>
  ({ id, pos: { x, y }, hp: 100, maxHp: 100, ...over });

const HERE = { x: 0, y: 0 };

describe("targeting: the priority ladder", () => {
  it("1. the lock wins while it is alive and in range", () => {
    const cands = [mob(1, 1, 0), mob(2, 6, 0, { hp: 4 })];
    expect(pickTarget(cands, { from: HERE, range: 8, lockedId: 2 })?.id).toBe(2);
  });

  it("...and stops winning the moment it leaves range or dies", () => {
    const far = [mob(1, 1, 0), mob(2, 20, 0)];
    expect(pickTarget(far, { from: HERE, range: 8, lockedId: 2 })?.id).toBe(1);
    const dead = [mob(1, 1, 0), mob(2, 2, 0, { hp: 0 })];
    expect(pickTarget(dead, { from: HERE, range: 8, lockedId: 2 })?.id).toBe(1);
  });

  it("2. what you damaged in the last 3 s beats a healthier neighbour", () => {
    const cands = [mob(1, 1, 0), mob(2, 5, 0)];
    expect(pickTarget(cands, { from: HERE, range: 8, lastDamagedId: 2, lastDamagedAge: 1.2 })?.id).toBe(2);
    // ...and the memory expires.
    expect(pickTarget(cands, { from: HERE, range: 8, lastDamagedId: 2, lastDamagedAge: LAST_HIT_WINDOW + 0.1 })?.id).toBe(1);
  });

  it("3. inside range, the lowest HP FRACTION is the finisher", () => {
    const cands = [mob(1, 1.5, 0), mob(2, 3, 0, { hp: 8 })];
    expect(pickTarget(cands, { from: HERE, range: 8 })?.id).toBe(2);
  });

  it("...and fraction, not absolute HP: a chunky elite at half is not a finish", () => {
    const cands = [mob(1, 2, 0, { hp: 500, maxHp: 1000 }), mob(2, 2, 0, { hp: 20, maxHp: 100 })];
    expect(pickTarget(cands, { from: HERE, range: 8 })?.id).toBe(2);
  });

  it("4. an all-healthy field falls back to the nearest", () => {
    const cands = [mob(1, 5, 0), mob(2, 1.5, 0), mob(3, 7, 0)];
    expect(pickTarget(cands, { from: HERE, range: 8 })?.id).toBe(2);
  });

  it("facing breaks a tie toward what the crawler is looking at", () => {
    const cands = [mob(1, 4, 0), mob(2, -4, 0)];
    expect(pickTarget(cands, { from: HERE, facing: { x: 1, y: 0 }, range: 8 })?.id).toBe(1);
    expect(pickTarget(cands, { from: HERE, facing: { x: -1, y: 0 }, range: 8 })?.id).toBe(2);
  });

  it("elites and bosses get a modest bump, not a veto", () => {
    const tie = [mob(1, 3, 0), mob(2, 3, 0, { elite: true })];
    expect(pickTarget(tie, { from: HERE, range: 8 })?.id).toBe(2);
    // ...but a nearly-dead trash mob still wins the finish.
    const finish = [mob(1, 3, 0, { hp: 3 }), mob(2, 3, 0, { elite: true })];
    expect(pickTarget(finish, { from: HERE, range: 8 })?.id).toBe(1);
  });

  it("dormant ambushers are furniture until they wake", () => {
    const cands = [mob(1, 1, 0, { dormant: true }), mob(2, 6, 0)];
    expect(pickTarget(cands, { from: HERE, range: 8 })?.id).toBe(2);
    expect(pickTarget([mob(1, 1, 0, { dormant: true })], { from: HERE, range: 8 })).toBeNull();
  });

  it("the ABILITY range is the range: nothing outside it is ever chosen", () => {
    const cands = [mob(1, 4, 0)];
    expect(pickTarget(cands, { from: HERE, range: 8 })?.id).toBe(1);
    expect(pickTarget(cands, { from: HERE, range: 1.3 })).toBeNull(); // a melee swing
  });

  it("nothing in range = null, so the cast falls back to facing (keyboard behaviour)", () => {
    expect(pickTarget([], { from: HERE, range: 8 })).toBeNull();
    expect(pickTarget([mob(1, 0, 0)], { from: HERE, range: 8 })).toBeNull(); // zero distance
  });
});

describe("targeting: world taps", () => {
  it("a tap grabs the body it landed on", () => {
    const cands = [mob(1, 3, 3), mob(2, 8, 8)];
    expect(tapTarget(cands, { x: 3.3, y: 2.8 })?.id).toBe(1);
  });

  it("a tap on empty ground grabs nothing (that is a move order)", () => {
    expect(tapTarget([mob(1, 3, 3)], { x: 6, y: 6 })).toBeNull();
  });

  it("corpses and sleepers are not tappable targets", () => {
    expect(tapTarget([mob(1, 3, 3, { hp: 0 })], { x: 3, y: 3 })).toBeNull();
    expect(tapTarget([mob(1, 3, 3, { dormant: true })], { x: 3, y: 3 })).toBeNull();
  });
});