import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE COMPETITIVE PANELS FIT THE WINDOW (the owner's standing no-scrollbars
 * rule).
 *
 * Measured on the shipped build before the round-1 pass, `scrollHeight -
 * clientHeight` on the open panel, at 1366x768 / 1600x900 / 2560x1440:
 *
 *   THE CRAWLER   730 / 598 /  58 px over — clipped a ledger row through its
 *                                           own baseline and drew MORE BELOW
 *                                           across a milestone
 *   ALL-TIME       37 /   0 /   0
 *   RIVALS         29 /   0 /   0
 *
 * ...and, in the other direction, dead stone inside a frame that had already
 * ended: 764 / 636 / 644 px under CONTRACTS / ALL-TIME / RIVALS at 2560x1440.
 *
 * The fix is layout (three balanced columns, short-viewport compaction, a
 * frame that sizes to its content between a floor and the window) plus a
 * measured `fitPanel` pass as the guarantee. None of that can be asserted
 * without a browser, so what this file guards is the set of source-level
 * invariants the pass depends on — the things a later edit could quietly
 * break, and the browser measurement would only catch on someone's laptop.
 *
 * ROUND 2 — AND IT GUARDS THE PANEL IT USED TO EXCLUDE. Round 1 shipped under
 * the commit message "the panels fit the window" while THE VERDICT — the only
 * one of the three with a hard `max-height` AND a suppressed scrollbar, and
 * the screen every single run terminates on — had no fit assertion of any kind
 * at any viewport. Measured on a fresh load at 1366x768 afterwards: 745px of
 * content in a 707px panel, the HOLD TAB hint cut off the bottom, and a
 * 232px-wide GRADED AGAINST plate laid into a 148px column, 28px of it under
 * an opaque grade tile. A guard scoped to what a round fixed is a guard that
 * cannot fail on what it did not.
 */

const HOST = readFileSync(
  fileURLToPath(new URL("../src/main3d.ts", import.meta.url)), "utf8",
);
const HTML = readFileSync(
  fileURLToPath(new URL("../iso.html", import.meta.url)), "utf8",
);

describe("the standings and the career panel fit the window", () => {
  it("every trimmable list declares a floor and a noun, so the pass can never empty one", () => {
    // `class="... fitlist ..."` on an element, plus whatever attributes ride
    // with it on the same authored fragment.
    const lists = HOST.match(/class="[^"]*\bfitlist\b[^"]*"[^>]*/g) ?? [];
    expect(lists.length).toBeGreaterThanOrEqual(4); // boards, unproven, milestones, last runs
    for (const list of lists) {
      expect(list, `fitlist without a floor: ${list}`).toMatch(/data-fitmin="\d+"/);
      expect(list, `fitlist without a noun: ${list}`).toMatch(/data-fitnoun="[^"]+"/);
      expect(Number(/data-fitmin="(\d+)"/.exec(list)![1])).toBeGreaterThanOrEqual(1);
    }
  });

  it("what the pass held back is stated, and is one click from coming back", () => {
    // A shortened list that does not admit it was shortened is a worse lie
    // than the scrollbar the house rule bans - and a ranked board whose tail
    // is unreachable is a straight downgrade on what the panel is for.
    expect(HOST).toMatch(/note\.className = "fitmore"/);
    expect(HOST).toMatch(/btn\.dataset\.fittoggle/);
    expect(HOST).toMatch(/function toggleFitList/);
    // Both panels route clicks into it, or one of them has a dead button.
    expect(HOST).toMatch(/toggleFitList\(el, ladderEl\)/);
    expect(HOST).toMatch(/toggleFitList\(el, careerEl\)/);
  });

  it("both panels run the pass after every render, and after a resize", () => {
    expect(HOST).toMatch(/fitPanel\(ladderEl\)/);
    expect(HOST).toMatch(/fitPanel\(careerEl\)/);
    expect(HOST).toMatch(/window\.addEventListener\("resize", \(\) => \{ fitPanel\(ladderEl\); fitPanel\(careerEl\); \}\)/);
  });

  it("the WHERE YOU DIE bars are a share of their track, never a pixel height", () => {
    // The bar heights used to be authored against an assumed 108px track, so
    // the first short-viewport rule that shortened the track drew all eighteen
    // of them straight through the floor axis and the band strip.
    const bar = /class="hb\$\{[^}]*\}" style="height:\$\{h\}(px|%)"/.exec(HOST)
      ?? /style="height:\$\{h\}(px|%)"/.exec(HOST);
    expect(bar, "the histogram bar markup moved — re-point this guard").not.toBeNull();
    expect(bar![1]).toBe("%");
    expect(HTML).toMatch(/\.histo \{[^}]*height:/); // ...and the track owns the height
  });

  it("the frame is bounded on BOTH sides: a floor to sit on, the window as a ceiling", () => {
    // Pinned to `100vh` it is dead stone by construction whenever the content
    // is shorter than the screen; with no floor at all it breathed ~400px
    // between tabs. It needs both, and `min()`/`max()` is how it says so.
    const rule = /#ladder \.set-frame, #career \.set-frame \{\s*\n?\s*min-height: ([^;]+);/.exec(HTML);
    expect(rule, "the set-frame sizing rule moved — re-point this guard").not.toBeNull();
    expect(rule![1]).toContain("min(");
    expect(rule![1]).toContain("100vh");
    expect(rule![1]).toContain("max(");
  });

  it("...and the ceiling is the SAME expression as the floor, or the tabs breathe", () => {
    // A floor bounds nothing from above. Measured frame heights at 2560x1440
    // under the floor-only rule: CONTRACTS 998, ALL-TIME 1394, BANDS 835,
    // RIVALS 835 — a 559px range, worse than the ~400px the rule's own comment
    // cites as the problem it solved. Two different expressions here is the
    // same bug wearing a `max-height`.
    const sized = [...HTML.matchAll(
      /#ladder \.set-frame, #career \.set-frame \{\s*\n?\s*min-height: ([^;]+);\s*\n?\s*max-height: ([^;]+);/g)];
    // Two: the base rule and the short-viewport one. Both are sizing rules and
    // both have to be bounded, or a 1366x768 laptop gets the old behaviour.
    expect(sized.length, "every set-frame sizing rule needs a floor AND a ceiling")
      .toBeGreaterThanOrEqual(2);
    for (const h of sized) expect(h[2].trim()).toBe(h[1].trim());
    // ...and the valve that drops the floor drops the ceiling with it, or a
    // hugging frame is still holding a 1400px box open.
    expect(HTML).toMatch(/\.set-frame\.hugs[^{]*\{[^}]*min-height: 0;[^}]*max-height: none;/);
  });

  it("THE VERDICT is measured too, and its scrollbar is no longer suppressed", () => {
    // The three things that let an 18/38px overflow ship on the screen every
    // run terminates on: no fit pass, a hidden elevator, and a guard that
    // named the other two panels.
    expect(HOST).toMatch(/function fitRecap\(\)/);
    expect(HOST).toMatch(/function fitRecapSoon\(\)/);
    expect(HOST).toMatch(/window\.addEventListener\("resize", fitRecap\)/);
    // It runs on every render of the card, not once at open: the seal
    // resolves, the board lands and the grade changes height under it.
    expect(HOST).toMatch(/fitRecap\(\);\s*\r?\n\s*fitRecapSoon\(\);/);
    const panel = /#recap \.panel \{([^}]*)\}/.exec(HTML);
    expect(panel, "the #recap .panel rule moved — re-point this guard").not.toBeNull();
    expect(panel![1], "the verdict panel must not hide its own elevator")
      .not.toMatch(/scrollbar-width:\s*none/);
    expect(HTML, "the verdict panel must not hide its own elevator")
      .not.toMatch(/#recap \.panel::-webkit-scrollbar/);
    // The density lever the pass actually turns, and its floor.
    expect(panel![1]).toMatch(/--vd:\s*var\(--vd0\)/);
    expect(HOST).toMatch(/Math\.max\(0\.55, d - 0\.04\)/);
  });

  it("the GRADED AGAINST plate is laid INTO its track, never across it", () => {
    // Blocker 2: `min-width: 210px` on the plate against a track authored at
    // 168px and narrowed to 148px by the short-viewport rule. Measured at
    // 1366x768: plate rect x=15 w=232 r=247, first grade tile x=219 — 41px out
    // past the panel's padding edge and 28px under an opaque tile. One number
    // now governs both, and the plate is a share of it.
    expect(HTML).toMatch(/#recap \.verdict \{[^}]*grid-template-columns: var\(--vtrack\)/);
    const basis = /#recap \.vbasis \{([^}]*)\}/.exec(HTML);
    expect(basis, "the .vbasis rule moved — re-point this guard").not.toBeNull();
    expect(basis![1]).toMatch(/width: 100%/);
    expect(basis![1]).toMatch(/min-width: 0/);
    expect(basis![1]).toMatch(/box-sizing: border-box/);
    // ...and no rule anywhere may set the track without the plate following,
    // which is only possible if nothing hard-codes the column any more.
    expect(HTML).not.toMatch(/#recap \.verdict \{[^}]*grid-template-columns: \d/);
    const short = HTML.slice(HTML.indexOf("@media (max-height: 830px)"));
    expect(short.slice(0, 600)).not.toMatch(/#recap \.verdict \{[^}]*grid-template-columns/);
  });

  it("padding invented to fill a board is spent BEFORE a ranked row is", () => {
    // ALL-TIME hid 16 of 25 rows at 1600x900 and spent ~190px below them on
    // the era note and THE OTHER MUSEUMS — both added by this track to fill
    // space. The fit pass trimmed the board and never the filler.
    expect(HOST).toMatch(/function fitPri\(/);
    expect(HOST).toMatch(/data-fitpri="3"/); // the all-time footnote block
    expect(HOST).toMatch(/data-fitpri="4"/); // the museums inside it
    // Highest priority is chosen first on the way down...
    expect(HOST).toMatch(/const top = Math\.max\(\.\.\.room\.map\(fitPri\)\)/);
    // ...and lowest first on the way back, or a footnote returns before a row.
    expect(HOST).toMatch(/fitPri\(a\) - fitPri\(b\)/);
  });

  it("a cut only counts in the column that is setting the height", () => {
    // THE CRAWLER held back 4 milestones and 3 runs at 1600x900 while column 1
    // bottomed out 110px above the frame. One global `scrollHeight` cannot see
    // three independent columns.
    expect(HOST).toMatch(/function tallestColumnLists\(/);
    expect(HOST).toMatch(/tallestColumnLists\(room\.filter/);
    expect(HOST).toMatch(/l\.closest<HTMLElement>\("\.ccol"\)/);
  });

  it("the career panel keeps the two ledgers apart and the eighteen-bar chart whole", () => {
    // Round 1 was allowed to move these, never to drop them: the sealed /
    // this-browser split is the honesty of the whole surface, and the
    // histogram is the best chart the game draws.
    expect(HOST).toContain("THE SEALED RECORD");
    expect(HOST).toContain("THIS BROWSER'S LEDGER");
    expect(HOST).toMatch(/for \(let f = 1; f <= CONFIG\.finalFloor; f\+\+\)/);
  });
});
