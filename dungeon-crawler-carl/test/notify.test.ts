import { describe, expect, it } from "vitest";
import { CLIMAX_YIELD_MS, NOTIF_DEFAULTS, NotifMix, type NotifOp, annKey, shapeKey } from "../src/ui/notify";
import type { Announcement, AnnouncementKind } from "../src/sim/types";

// ===========================================================================
// THE NOTIFICATION MIX (src/ui/notify.ts) — owner verdict #2 ("in late levels
// notifications... they're a total mess!") and AAA-AUDIT.md gap #7.
//
// These assert the POLICY, not the paint: the module is DOM-free on purpose so
// the rules can be pinned without a browser. The glass itself is verified by
// tools/_mixbrowser.mjs over the shipping build.
// ===========================================================================

function ann(text: string, kind: AnnouncementKind = "show", priority: "high" | "normal" = "normal"): Announcement {
  return { text, kind, priority };
}

const toasts = (ops: NotifOp[]) => ops.filter((o) => o.op === "toast");
const drops = (ops: NotifOp[]) => ops.filter((o) => o.op === "drop");

describe("notification mix: keys", () => {
  it("collapses a sentence's numbers but keeps its identity", () => {
    expect(shapeKey("7-KILL COMBO by Carl! The crowd is on its feet."))
      .toBe(shapeKey("12-KILL COMBO by Carl! The crowd is on its feet"));
    expect(shapeKey("A TIMED VAULT is sealed on this floor."))
      .not.toBe(shapeKey("The vault SEALS."));
  });

  it("annKey stays the EXACT-sentence key (numbers are not presentation there)", () => {
    expect(annKey("Descending to floor 2.")).toBe(annKey("Descending to floor 2"));
    expect(annKey("Descending to floor 2")).not.toBe(annKey("Descending to floor 3"));
  });
});

describe("notification mix: the cap and the queue", () => {
  it("never puts more than `max` lines on the glass, however big the burst", () => {
    const mix = new NotifMix();
    let t = 1000;
    // The floor-transition shape: a dozen DISTINCT lines in ONE frame. (They
    // have to be distinct — `line 1`/`line 2` are one shape, which is rule 3
    // doing its job and not what this test is about.)
    for (const w of "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(" ")) {
      mix.offer(ann(`the ${w} drops`, "loot"), t);
    }
    let released = 0;
    for (let i = 0; i < 400; i++) {
      t += 50;
      released += toasts(mix.pump(t)).length;
      expect(mix.liveCount()).toBeLessThanOrEqual(NOTIF_DEFAULTS.max);
    }
    expect(released).toBeGreaterThan(0);
  });

  it("releases at most one line per pump, no faster than the gap", () => {
    const mix = new NotifMix();
    let t = 1000;
    for (const w of ["alpha", "bravo", "charlie", "delta", "echo"]) mix.offer(ann(`the ${w} drops`, "loot"), t);
    expect(toasts(mix.pump(t)).length).toBe(1);
    expect(toasts(mix.pump(t + 1)).length).toBe(0); // inside the gap
    t += NOTIF_DEFAULTS.gapMs + 1;
    expect(toasts(mix.pump(t)).length).toBe(1);
  });

  it("spills the CHEAPEST waiting line past the queue cap, never the news", () => {
    const mix = new NotifMix({ queueMax: 3 });
    let t = 1000;
    mix.offer(ann("floor news", "progress"), t);
    const spilled: NotifOp[] = [];
    const noise = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    noise.forEach((w, i) => spilled.push(...drops(mix.offer(ann(`the crowd chants ${w}`, "show"), t + i))));
    // The cap bit, and every line it dropped was chatter.
    expect(spilled.length).toBeGreaterThan(0);
    expect(spilled.every((o) => o.op === "drop" && o.a.kind === "show")).toBe(true);
    // ...and the first thing on the glass is the news, not the chatter.
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      for (const o of toasts(mix.pump(t))) if (o.op === "toast") seen.push(o.a.text);
      t += NOTIF_DEFAULTS.gapMs + 1;
    }
    expect(seen[0]).toBe("floor news");
  });

  it("drops a held line once it has stopped being news", () => {
    const mix = new NotifMix({ staleMs: 5000 });
    const t = 1000;
    mix.setClimax("boss", t); // rank-0 chatter is held, not painted
    mix.offer(ann("the crowd is on its feet", "show"), t);
    expect(mix.pending()).toBe(1);
    expect(drops(mix.pump(t + 4000)).length).toBe(0); // still news
    const late = drops(mix.pump(t + 6000));
    expect(late.some((o) => o.op === "drop" && o.why === "stale")).toBe(true);
    expect(mix.pending()).toBe(0);
  });
});

describe("notification mix: coalescing (rule 3)", () => {
  it("a repeated sentence takes a COUNT, not a second slot", () => {
    const mix = new NotifMix();
    let t = 1000;
    const combo = (n: number) => ann(`${n}-KILL COMBO by Carl! The crowd is on its feet.`, "show");
    mix.offer(combo(3), t);
    const first = toasts(mix.pump(t));
    expect(first.length).toBe(1);
    // Twelve more combos in the next two seconds — the measured floor-13 rate.
    let bumps = 0;
    for (let i = 4; i < 16; i++) {
      t += 150;
      for (const o of mix.offer(combo(i), t)) if (o.op === "bump") bumps++;
      expect(toasts(mix.pump(t)).length).toBe(0); // nothing new was queued
    }
    expect(bumps).toBe(12);
    expect(mix.liveCount()).toBe(1);
    expect(mix.pending()).toBe(0);
  });

  it("...but a coalesced line cannot own its slot forever", () => {
    // Measured in this round's first browser pass: ONE "6-KILL COMBO" toast
    // held a slot for 445 consecutive frames (~10s) because every repeat
    // refreshed its hold, and it was the sole reason 100% of that scenario's
    // boss-bar frames still carried an unrelated line.
    const mix = new NotifMix();
    let t = 1000;
    const combo = (n: number) => ann(`${n}-KILL COMBO by Carl!`, "show");
    mix.offer(combo(2), t);
    mix.pump(t);
    for (let i = 0; i < 100; i++) {
      t += 200; // a repeat every 200ms, well inside the hold
      mix.offer(combo(i), t);
    }
    expect(t - 1000).toBeGreaterThan(NOTIF_DEFAULTS.maxLifeMs);
    mix.pump(t);
    // The line let go at its ceiling; the stream did not pin the slot.
    expect(mix.liveCount()).toBeLessThanOrEqual(1);
    const born = mix.offer(combo(999), t + 10);
    // ...and after it expires a fresh repeat opens a NEW line rather than
    // bumping a node that is no longer there.
    expect(born.some((o) => o.op === "bump")).toBe(false);
  });

  it("...and a burst that arrives while the line is WAITING coalesces too", () => {
    const mix = new NotifMix();
    const t = 1000;
    mix.setClimax("boss", t); // rank-0 chatter is held
    for (let i = 0; i < 9; i++) mix.offer(ann(`${i}-KILL COMBO by Carl!`, "show"), t + i * 10);
    expect(mix.pending()).toBe(1);
    mix.setClimax(null, t);
    const out = toasts(mix.pump(t + 5000));
    expect(out.length).toBe(1);
    expect(out[0].op === "toast" && out[0].count).toBe(9);
  });
});

describe("notification mix: the climax lock (AAA-AUDIT #7)", () => {
  it("holds normal chatter while a boss bar is up, and drains it after", () => {
    const mix = new NotifMix();
    let t = 1000;
    mix.setClimax("boss", t);
    mix.offer(ann("FIRST BLOOD — the crowd pays out", "achievement"), t);
    mix.offer(ann("A GLYPH drops", "loot"), t);
    mix.offer(ann("the crowd chants CARL", "show"), t);
    for (let i = 0; i < 20; i++) { t += 200; expect(toasts(mix.pump(t)).length).toBe(0); }
    expect(mix.pending()).toBe(3);
    // The fight's OWN news still gets through — it is about the thing on screen.
    mix.offer(ann("The Safety Officer OVER-COMMITS. It is wide open.", "boss"), t);
    const during = toasts(mix.pump(t + 1));
    expect(during.length).toBe(1);
    expect(during[0].op === "toast" && during[0].a.kind).toBe("boss");
    // Fight over: the backlog drains, highest rank first.
    mix.setClimax(null, t);
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      t += NOTIF_DEFAULTS.gapMs + 1;
      for (const o of toasts(mix.pump(t))) if (o.op === "toast") seen.push(o.a.kind);
    }
    expect(seen[0]).toBe("achievement"); // rank 2 before rank 1 before rank 0
    expect(seen).toContain("loot");
  });

  it("the INSTANT of death is a hard cut: the glass clears and nothing queues", () => {
    const mix = new NotifMix();
    const t = 1000;
    mix.offer(ann("a glyph drops", "loot"), t);
    mix.pump(t);
    expect(mix.liveCount()).toBe(1);
    mix.offer(ann("the crowd chants", "show"), t);
    // ...the census's restatement of #7: the IN MEMORIAM card was already
    // clean; what was unprotected was the moment, which arrived under a PARTY
    // WIPE banner AND a "succumbed to the poison" toast.
    const ops = mix.setClimax("death", t);
    expect(ops.some((o) => o.op === "retire")).toBe(true);
    expect(ops.some((o) => o.op === "drop" && o.why === "death")).toBe(true);
    expect(mix.liveCount()).toBe(0);
    expect(mix.pending()).toBe(0);
    // ...and NOTHING gets on the glass while the beat plays, at any rank.
    mix.offer(ann("PHASE 2", "boss"), t + 100);
    for (let i = 0; i < 20; i++) expect(toasts(mix.pump(t + 200 + i * 200)).length).toBe(0);
    // The banner is the one surface the moment keeps.
    const wipe = mix.offer(ann("PARTY WIPE", "progress", "high"), t + 300);
    expect(wipe.some((o) => o.op === "banner")).toBe(true);
  });

  it("entering a BOSS climax shortens a live line, but never yanks it", () => {
    const mix = new NotifMix();
    const t = 1000;
    mix.offer(ann("a glyph drops", "loot"), t);
    mix.pump(t);
    const ops = mix.setClimax("boss", t);
    // A glance to finish — not a retire, and not a full seven-second ride
    // across the fight (the browser pass measured exactly that).
    expect(ops.some((o) => o.op === "retire")).toBe(false);
    const held = ops.find((o) => o.op === "hold");
    expect(held && held.op === "hold" && held.holdMs).toBe(CLIMAX_YIELD_MS);
    expect(mix.liveCount()).toBe(1);
    mix.pump(t + CLIMAX_YIELD_MS + 1);
    expect(mix.liveCount()).toBe(0);
  });

  it("...but the FIGHT'S OWN line is not asked to yield", () => {
    const mix = new NotifMix();
    const t = 1000;
    mix.offer(ann("The Safety Officer OVER-COMMITS.", "boss"), t);
    mix.pump(t);
    expect(mix.setClimax("boss", t)).toEqual([]);
    mix.pump(t + CLIMAX_YIELD_MS + 1);
    expect(mix.liveCount()).toBe(1);
  });

  it("a descent delivers its news ONE line at a time (r3 finding 2)", () => {
    const mix = new NotifMix();
    let t = 1000;
    mix.setClimax("descend", t);
    // The three subtitles the audit caught stacked, all authored in one frame.
    mix.offer(ann("A TIMED VAULT is sealed on this floor.", "loot"), t);
    mix.offer(ann("NEIGHBORHOOD BOSS: The Block Captain holds the great hall.", "boss"), t);
    mix.offer(ann("The stairs district is LOCKED.", "progress"), t);
    let max = 0;
    for (let i = 0; i < 60; i++) {
      t += 120;
      mix.pump(t);
      max = Math.max(max, mix.liveCount());
    }
    expect(max).toBe(1);
  });
});

describe("notification mix: one sentence, one surface (rule 5)", () => {
  it("the ticker cannot print what the banner is showing", () => {
    const mix = new NotifMix();
    const t = 1000;
    mix.offer(ann("Now entering THE IRONWORKS.", "progress", "high"), t);
    const echo = mix.offer(ann("Now entering THE IRONWORKS.", "progress"), t + 10);
    expect(echo.some((o) => o.op === "drop" && o.why === "banner")).toBe(true);
    expect(mix.pending()).toBe(0);
  });

  it("...and a banner retires the quieter copy that is already up", () => {
    const mix = new NotifMix();
    const t = 1000;
    mix.offer(ann("The vault SEALS.", "loot"), t);
    mix.pump(t);
    expect(mix.liveCount()).toBe(1);
    const ops = mix.offer(ann("The vault SEALS.", "loot", "high"), t + 500);
    expect(ops.some((o) => o.op === "retire")).toBe(true);
    expect(ops.some((o) => o.op === "banner")).toBe(true);
    expect(mix.liveCount()).toBe(0);
  });

  it("one banner per shape — a replayed net batch does not queue behind itself", () => {
    const mix = new NotifMix();
    const t = 1000;
    const a = ann("BOSS DOWN — floor 15 is yours.", "boss", "high");
    expect(mix.offer(a, t).filter((o) => o.op === "banner").length).toBe(1);
    expect(mix.offer(a, t + 40).filter((o) => o.op === "banner").length).toBe(0);
    // ...but the claim expires with the banner, so the line can be said again.
    expect(mix.offer(a, t + NOTIF_DEFAULTS.bannerMs + 1).filter((o) => o.op === "banner").length).toBe(1);
  });
});

describe("notification mix: what it must NOT do", () => {
  it("a lone line still paints immediately — quiet play is untouched", () => {
    const mix = new NotifMix();
    const t = 50_000;
    mix.offer(ann("A SYSTEM SHRINE hums on this floor.", "flavor"), t);
    const out = toasts(mix.pump(t));
    expect(out.length).toBe(1);
    expect(out[0].op === "toast" && out[0].count).toBe(1);
  });

  it("a new run inherits no backlog", () => {
    const mix = new NotifMix();
    mix.setClimax("boss", 1000);
    for (const w of ["alpha", "bravo", "charlie", "delta"]) mix.offer(ann(`the crowd chants ${w}`, "show"), 1000);
    expect(mix.pending()).toBeGreaterThan(0);
    mix.reset();
    expect(mix.pending()).toBe(0);
    expect(mix.liveCount()).toBe(0);
    expect(mix.climaxNow()).toBe(null);
  });
});
