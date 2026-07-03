import { describe, it, expect } from "vitest";
import { DEFAULT_BINDINGS, bindingLabel, keyLabel, rebind } from "../src/input/bindings";

describe("key bindings", () => {
  it("rebinds an action's primary key", () => {
    const b = rebind(DEFAULT_BINDINGS, "slot3", "g");
    expect(b.slot3[0]).toBe("g");
    // Other actions untouched.
    expect(b.slot1).toEqual(DEFAULT_BINDINGS.slot1);
  });

  it("steals a key that was bound elsewhere (no double-binds)", () => {
    const b = rebind(DEFAULT_BINDINGS, "ultimate", "q"); // q was slot3's only key
    expect(b.ultimate[0]).toBe("q");
    expect(b.slot3).not.toContain("q");
    expect(bindingLabel(b, "slot3")).toBe("—"); // shown unbound until reassigned
  });

  it("keeps secondary defaults when rebinding movement", () => {
    const b = rebind(DEFAULT_BINDINGS, "moveUp", "z");
    expect(b.moveUp[0]).toBe("z");
    expect(b.moveUp).toContain("arrowup"); // arrows preserved
  });

  it("labels keys for display", () => {
    expect(keyLabel(" ")).toBe("Space");
    expect(keyLabel("arrowleft")).toBe("←");
    expect(keyLabel("shift")).toBe("Shift");
    expect(keyLabel("q")).toBe("Q");
    expect(bindingLabel(DEFAULT_BINDINGS, "slot2")).toBe("Shift / Ctrl");
  });
});
