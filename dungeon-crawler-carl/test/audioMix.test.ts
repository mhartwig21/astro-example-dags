import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AUDIO_MANIFEST, type SoundDef } from "../src/audio/manifest";

// ===========================================================================
// THE MIX, AS PLAYED — and the files actually being there.
//
// Two r2 critic findings share one root: EVERYTHING in that round was verified
// UPSTREAM OF THE ENGINE. The §2.2 compliance table measured encoded files
// while engine.ts:play() multiplies by the manifest volume; the result was
// that the round's headline invariant ("ability casts sit 2 dB UNDER impacts:
// the consequence must out-punch the act") was INVERTED in the shipped mix —
// pressing dash was 2.1dB louder than the hit it caused.
//
// tools/audio/played.mjs is the instrument that measures at the right node.
// This file is the guard that keeps its verdict from drifting.
// ===========================================================================

const ROOT = resolve(__dirname, "..");

describe("audio manifest: every url resolves to a file on disk", () => {
  // A typo'd url ships as a SILENT CUE with a green suite — the exact failure
  // mode the cast round exists to close, and nothing else in the repo checks
  // it (the shape test only regex-matches the `/audio/` prefix).
  it("no manifest entry points at a missing file", () => {
    const missing = Object.entries(AUDIO_MANIFEST)
      .filter(([, def]) => !existsSync(resolve(ROOT, "public" + def.url)))
      .map(([id, def]) => `${id} -> ${def.url}`);
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MEASURED FILE LEVELS — max 400ms windowed RMS of the ENCODED file, dBFS.
// Source: `node tools/audio/played.mjs --bus sfx`. Regenerate this table when
// any of these files is re-rendered; the generators are byte-reproducible
// (tools/audio/gen-*.mjs + enc.mjs with -q:a and +bitexact pinned), so a
// number here only goes stale if someone edits a generator, and the id-set
// assertion below catches a clip added without being measured.
// ---------------------------------------------------------------------------
const MOM_DB: Record<string, number> = {
  // the CONSEQUENCE — the reference the cast family is specified against
  hit: -22.1,
  kill: -14.9,
  // the ACT — actives
  cast_dash: -17.1, cast_orbit: -17.4, cast_stance: -16.9, cast_overcharge: -16.9,
  cast_cutto: -17.2, cast_crowdsurf: -17.3, cast_stuntdouble: -17.0,
  cast_bulwark: -17.0, cast_cables: -17.3,
  // the ACT — ultimates
  cast_airstrike: -14.6, cast_cataclysm: -14.5, cast_bullettime: -14.5, cast_injunction: -14.5,
  // room-tone ticks that ride UNDER an impact
  chain_line: -27.9, weapon_flash: -28.3,
  // progression
  level_up: -19.3,
};

const ULTIMATES = ["cast_airstrike", "cast_cataclysm", "cast_bullettime", "cast_injunction"];
/** As-played level: the file's momentary RMS times the gain engine.play()
 *  applies. `satisfies` narrows each entry to its literal shape, so `volume`
 *  is absent on the entries that omit it — read it through SoundDef. */
const played = (id: string): number => {
  const def = AUDIO_MANIFEST[id as keyof typeof AUDIO_MANIFEST] as SoundDef;
  return MOM_DB[id] + 20 * Math.log10(def.volume ?? 1);
};

describe("SOUNDPLAN §2.2 as PLAYED (not as encoded)", () => {
  it("the measured table covers exactly the cast family and its references", () => {
    // Adding a cast cue without measuring it fails here rather than silently
    // shipping outside the band.
    const casts = Object.keys(AUDIO_MANIFEST).filter((id) => id.startsWith("cast_"));
    for (const id of casts) expect(MOM_DB[id], `${id} is unmeasured`).toBeTypeOf("number");
    for (const id of Object.keys(MOM_DB)) expect(AUDIO_MANIFEST[id as keyof typeof AUDIO_MANIFEST], id).toBeDefined();
  });

  it("the ACT sits under the CONSEQUENCE — every active cast is below `hit`", () => {
    // This is §2.2's headline sentence, and in the first r2 cut it was false:
    // the actives landed -20.0..-22.9 against hit's -22.1, so seven of the
    // nine out-punched the blow they caused.
    const ref = played("hit");
    for (const id of Object.keys(MOM_DB)) {
      if (!id.startsWith("cast_") || ULTIMATES.includes(id)) continue;
      const gap = ref - played(id);
      expect(gap, `${id} plays at ${played(id).toFixed(1)} vs hit ${ref.toFixed(1)}`).toBeGreaterThanOrEqual(1.5);
      expect(gap, `${id} is buried`).toBeLessThanOrEqual(5.0);
    }
  });

  it("an ultimate IS an event — above an ordinary hit, still under a kill", () => {
    // The reach an ultimate gets comes from its own target, never from ducking
    // the bed (it stays on `sfx`; `announcer` is the duck source). But a DEATH
    // must still out-punch the cast that caused it.
    for (const id of ULTIMATES) {
      expect(played(id), id).toBeGreaterThan(played("hit"));
      expect(played(id), id).toBeLessThan(played("kill"));
    }
  });

  it("the ultimates are level-matched to each other within 1.5dB", () => {
    const levels = ULTIMATES.map(played);
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(1.5);
  });

  it("room-tone ticks ride well under the impact they accompany", () => {
    // `chain_line` and `weapon_flash` exist to stop HIT_SOUNDS.chain and
    // HIT_SOUNDS.weapon borrowing the dash whoosh and the pickup chime. They
    // are layers, not events.
    for (const id of ["chain_line", "weapon_flash"]) {
      expect(played("hit") - played(id), id).toBeGreaterThanOrEqual(6);
    }
  });

  it("level_up no longer out-punches the game (owner verdict §1.3a)", () => {
    // The Kenney clip played at -15.3, louder than every impact except `kill`,
    // on `cur.level > prev.level`. Short, dry and near the hit is the trade.
    expect(played("level_up")).toBeLessThan(played("kill") - 3);
    expect(Math.abs(played("level_up") - played("hit"))).toBeLessThanOrEqual(2);
  });
});
