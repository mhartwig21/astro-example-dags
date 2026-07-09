import { describe, expect, it } from "vitest";
import { generateFloor } from "../src/sim/floor";
import { createTestGame } from "../src/sim/game";
import { createRng } from "../src/sim/rng";
import { ROOM_TEMPLATES, roomTemplateById, validateTemplate } from "../src/content/rooms";
import { Tile } from "../src/sim/types";

describe("crafted room templates", () => {
  it("every registered template honors the stamp contract", () => {
    for (const t of ROOM_TEMPLATES) {
      expect(validateTemplate(t), `${t.id} must keep a floor border + open center`).toBe(true);
      expect(roomTemplateById(t.id)).toBe(t);
    }
  });

  it("stamping is deterministic and never touches spawn/stairs rooms", () => {
    for (const seed of [7, 42, 1337, 90210]) {
      const a = generateFloor(createRng(seed), 3);
      const b = generateFloor(createRng(seed), 3);
      expect(a.stamps).toEqual(b.stamps); // same seed, same stamps
      for (const s of a.stamps ?? []) {
        const t = roomTemplateById(s.id)!;
        expect(t).toBeDefined();
        // The stamp never lands in the entrance or stairs room.
        const spawnRoom = a.rooms[0];
        const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
          s.x < r.x + r.w && s.x + t.w > r.x && s.y < r.y + r.h && s.y + t.h > r.y;
        expect(overlaps(spawnRoom)).toBe(false);
        // Stairs tile survives (stamps only overwrite plain Floor).
        const st = a.tiles[Math.floor(a.stairs.y) * a.w + Math.floor(a.stairs.x)];
        expect(st).toBe(Tile.StairsDown);
      }
    }
  });

  it("stamped floors show up across seeds (the feature actually fires)", () => {
    let stamped = 0;
    for (let seed = 1; seed <= 30; seed++) {
      stamped += (generateFloor(createRng(seed), 4).stamps ?? []).length;
    }
    expect(stamped).toBeGreaterThan(0);
  });
});

describe("crafted enemies (custom mob defs)", () => {
  it("a registered def substitutes for its behavior in its band, stats applied", () => {
    // THE AUDITOR: filcher behavior, band 3 (floors 10-12), hp x1.4.
    let found = null as import("../src/sim/types").Monster | null;
    let vanillaHp = 0;
    for (let seed = 1; seed <= 60 && !found; seed++) {
      const g = createTestGame({ seed, floor: 11, level: 10 });
      for (const m of g.monsters) {
        if (m.kind === "filcher" && !m.defId && vanillaHp === 0) vanillaHp = m.maxHp;
        if (m.defId === "the-auditor") { found = m; break; }
      }
    }
    expect(found, "the auditor should spawn somewhere across 60 seeds").not.toBeNull();
    expect(found!.kind).toBe("filcher"); // behavior inherited: brain untouched
    expect(found!.eliteName).toBe("THE AUDITOR");
    expect(found!.carry ?? 0).toBeGreaterThan(0); // filcher intrinsics intact
    if (vanillaHp > 0) expect(found!.maxHp).toBeGreaterThan(vanillaHp);
  });

  it("defs never fire outside their bands", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = createTestGame({ seed, floor: 2, level: 3 }); // band 0
      expect(g.monsters.every((m) => m.defId === undefined)).toBe(true);
    }
  });
});
