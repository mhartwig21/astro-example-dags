import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * EVERY OVERLAY AT z >= 20 IS REGISTERED WITH THE INPUT AUTHORITY, OR RED.
 *
 * MOBILE.md §2.9a, contradiction 6. The shipped fix for §1.7 was a boolean
 * driven by a hand-maintained list of nine element IDs in main3d.ts — `inv`,
 * `abil`, `sheet`, `keys`, `recap`, `saferoom`, `draft`, `menu`, `dialogue`.
 * Checked against the screen-zone map in iso.html it missed SIX live surfaces:
 *
 *   #ladder / #career / #consent  z 28   THE STANDINGS, THE CRAWLER, consent
 *   #loading                      z 29   SIGNAL ACQUISITION over a live finger
 *   #recap-tab                    z 27   the held-TAB drill-down
 *   #rotate                       z 40   the orientation gate — the ONE overlay
 *                                        that deliberately outranks everything,
 *                                        and therefore the one an ID list of
 *                                        "modals" was never going to contain
 *
 * A list a human maintains is the wrong shape. This test replaces it: it reads
 * the CSS in iso.html, takes every `#id` rule with a z-index of 20 or more,
 * and asserts the element DECLARES what it is with `data-overlay` in the
 * markup. Adding a new panel without registering it turns this red — which is
 * the only kind of guarantee that survives the next agent.
 *
 * Parsing the shipped HTML rather than a fixture is deliberate: the screen-zone
 * map is the source of truth, and a test that reads a copy of it tests the
 * copy.
 */

const HTML = readFileSync(
  fileURLToPath(new URL("../iso.html", import.meta.url)), "utf8",
);

/** Every `#id { ... z-index: N ... }` rule with N >= 20, as id -> max z. */
function overlaysAtOrAbove(z: number): Map<string, number> {
  const out = new Map<string, number>();
  // Selector list up to the opening brace, then the declaration block.
  const rule = /(^|[\s}])((?:#[\w-]+(?:\s*,\s*#[\w-]+)*))\s*\{([^{}]*)\}/g;
  for (let m = rule.exec(HTML); m; m = rule.exec(HTML)) {
    const zi = /z-index:\s*(-?\d+)/.exec(m[3]);
    if (!zi) continue;
    const n = Number(zi[1]);
    if (n < z) continue;
    for (const sel of m[2].split(",")) {
      const id = sel.trim().slice(1);
      out.set(id, Math.max(out.get(id) ?? 0, n));
    }
  }
  return out;
}

const PANEL_TOUCH = readFileSync(
  fileURLToPath(new URL("../src/ui/panelTouch.ts", import.meta.url)), "utf8",
);

/**
 * `data-overlay="..."` as authored on `<div id="...">`, or the equivalent
 * `dataset` assignment for an overlay the code creates rather than the markup.
 */
function declaredRole(id: string): string | null {
  const tag = new RegExp(`<div id="${id}"([^>]*)>`).exec(HTML);
  if (tag) {
    const attr = /data-overlay="([\w-]+)"/.exec(tag[1]);
    if (attr) return attr[1];
  }
  const made = new RegExp(`\\.id = "${id}";([\\s\\S]{0,600})`).exec(PANEL_TOUCH);
  if (made) {
    if (/dataset\.sheet\s*=/.test(made[1])) return "sheet";
    const ds = /dataset\.overlay\s*=\s*"([\w-]+)"/.exec(made[1]);
    if (ds) return ds[1];
  }
  return null;
}

/** Roles the touch layer understands. `none` is an explicit opt-out. */
const ROLES = new Set(["modal", "sheet", "rotate-gate", "none"]);

/**
 * Ids whose z >= 20 rule is CONDITIONAL on an already-registered overlay being
 * open, so they inherit its reason and must not raise one of their own.
 * Each entry names the overlay that covers it; an unexplained entry here is
 * the same hand-maintained list this test exists to abolish.
 */
const COVERED_BY: Record<string, string> = {
  // `body.mapbig #minimap-frame` lifts the puck to z 26 on top of
  // #mapbig-scrim (z 25, registered). At every other time it is the HUD puck
  // at z 5, and registering it as a modal would leave body.modal on forever.
  "minimap-frame": "mapbig-scrim",
};

describe("panels: the screen-zone map and the input authority agree", () => {
  const overlays = overlaysAtOrAbove(20);

  it("finds the overlays the old ID list missed (a self-check on the parser)", () => {
    for (const id of ["ladder", "career", "consent", "loading", "recap-tab", "rotate"]) {
      expect(overlays.has(id), `${id} not found in the screen-zone map`).toBe(true);
    }
    expect(overlays.get("rotate")).toBe(40);
    expect(overlays.size).toBeGreaterThanOrEqual(15);
  });

  it("every overlay at z >= 20 declares a data-overlay role", () => {
    for (const [id, z] of overlays) {
      const cover = COVERED_BY[id];
      if (cover) {
        expect.soft(declaredRole(cover), `${id}'s cover ${cover} is itself unregistered`)
          .toBe("modal");
        continue;
      }
      const role = declaredRole(id);
      expect.soft(role, `#${id} (z ${z}) has no data-overlay — register it in iso.html`)
        .not.toBeNull();
      if (role) {
        expect.soft(ROLES.has(role), `#${id} declares unknown role "${role}"`).toBe(true);
      }
    }
  });

  it("the six surfaces the boolean missed now raise a suspend reason", () => {
    // Five are ordinary modals; the sixth is the gate that outranks them.
    for (const id of ["ladder", "career", "consent", "loading", "recap-tab"]) {
      expect.soft(declaredRole(id), id).toBe("modal");
    }
    expect(declaredRole("rotate")).toBe("rotate-gate");
  });

  it("the nine the boolean DID cover are still covered", () => {
    for (const id of ["inv", "abil", "sheet", "keys", "recap", "saferoom", "draft",
      "menu", "dialogue"]) {
      expect.soft(declaredRole(id), id).toBe("modal");
    }
  });

  /**
   * `none` is not a loophole: it is only for overlays that cannot take a
   * finger. Anything that opts out must actually be `pointer-events: none`,
   * or it is a surface pretending not to be one.
   */
  it("every `none` opt-out is genuinely pointer-events: none", () => {
    for (const [id] of overlays) {
      if (declaredRole(id) !== "none") continue;
      const block = new RegExp(`#${id}\\s*\\{([^{}]*)\\}`).exec(HTML);
      expect.soft(block?.[1] ?? "", `#${id} opted out but can be pressed`)
        .toContain("pointer-events: none");
    }
  });

  it("the bottom sheet declares data-sheet, since it never sets body.modal", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/ui/panelTouch.ts", import.meta.url)), "utf8",
    );
    expect(src).toMatch(/dataset\.sheet\s*=/);
  });

  it("main3d no longer carries a hand-maintained modal ID list", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/main3d.ts", import.meta.url)), "utf8",
    );
    // The exact literal that shipped, and the shape of the bug.
    expect(src).not.toContain('["inv", "abil", "sheet", "keys", "recap", "saferoom"');
    expect(src).toContain('[data-overlay="modal"]');
  });
});
