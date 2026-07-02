import { describe, it, expect } from "vitest";
import { DEFAULT_BINDINGS, bindingLabel, keyLabel, rebind } from "../src/input/bindings";

describe("key bindings", () => {
  it("rebinds an action's primary key", () => {
    const b = rebind(DEFAULT_BINDINGS, "bolt", "g");
    expect(b.bolt[0]).toBe("g");
    // Other actions untouched.
    expect(b.attack).toEqual(DEFAULT_BINDINGS.attack);
  });

  it("steals a key that was bound elsewhere (no double-binds)", () => {
    const b = rebind(DEFAULT_BINDINGS, "nova", "q"); // q was bolt's only key
    expect(b.nova[0]).toBe("q");
    expect(b.bolt).not.toContain("q");
    expect(bindingLabel(b, "bolt")).toBe("—"); // shown unbound until reassigned
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
    expect(bindingLabel(DEFAULT_BINDINGS, "dash")).toBe("Shift / Ctrl");
  });
});
