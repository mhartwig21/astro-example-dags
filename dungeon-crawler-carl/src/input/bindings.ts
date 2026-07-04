// Rebindable controls. Bindings map game actions to KeyboardEvent.key values
// (lowercased). Persisted per browser in localStorage; the InputController and
// all key hints in the UI read from here so a rebind updates everything.

export type BindableAction =
  | "moveUp" | "moveDown" | "moveLeft" | "moveRight"
  | "slot1" | "slot2" | "slot3" | "slot4" | "ultimate" | "flask"
  | "stairs" | "inventory" | "abilities" | "keybinds" | "newRun" | "mute";

export type Bindings = Record<BindableAction, string[]>;

export const ACTION_INFO: Record<BindableAction, { name: string; hint?: string }> = {
  moveUp: { name: "Move up" },
  moveDown: { name: "Move down" },
  moveLeft: { name: "Move left" },
  moveRight: { name: "Move right" },
  slot1: { name: "Ability slot 1", hint: "also left-click" },
  slot2: { name: "Ability slot 2" },
  slot3: { name: "Ability slot 3", hint: "also right-click" },
  slot4: { name: "Ability slot 4" },
  ultimate: { name: "Ultimate" },
  flask: { name: "Drink flask", hint: "heals; kills refill it" },
  stairs: { name: "Use stairs / descend" },
  inventory: { name: "Inventory" },
  abilities: { name: "Abilities & achievements" },
  keybinds: { name: "Key bindings" },
  newRun: { name: "New run (solo)" },
  mute: { name: "Mute sound" },
};

export const DEFAULT_BINDINGS: Bindings = {
  moveUp: ["w", "arrowup"],
  moveDown: ["s", "arrowdown"],
  moveLeft: ["a", "arrowleft"],
  moveRight: ["d", "arrowright"],
  slot1: [" "],
  slot2: ["shift", "control"],
  slot3: ["q"],
  slot4: ["c"],
  ultimate: ["f"],
  flask: ["x"],
  stairs: ["e"],
  inventory: ["i"],
  abilities: ["t"],
  keybinds: ["k"],
  newRun: ["r"],
  mute: ["m"],
};

// v2: per-SLOT binds replaced per-ability binds (The Five). Old v1 bindings are
// intentionally not migrated — defaults land the starting kit on the old keys.
const STORE_KEY = "dcc:keys:v2";

/** Pretty label for a key value ("w" -> "W", " " -> "Space"). */
export function keyLabel(key: string): string {
  switch (key) {
    case " ": return "Space";
    case "arrowup": return "↑";
    case "arrowdown": return "↓";
    case "arrowleft": return "←";
    case "arrowright": return "→";
    case "control": return "Ctrl";
    case "escape": return "Esc";
    default: return key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  }
}

export function bindingLabel(b: Bindings, action: BindableAction): string {
  return b[action].length ? b[action].map(keyLabel).join(" / ") : "—";
}

/**
 * Rebind an action's PRIMARY key (secondary defaults like arrows stay). If the
 * key is bound elsewhere it is stolen — that action becomes unbound (shown as
 * "—") until the player assigns it a new key. No silent double-binds.
 */
export function rebind(b: Bindings, action: BindableAction, key: string): Bindings {
  const next: Bindings = { ...b };
  for (const a of Object.keys(next) as BindableAction[]) {
    next[a] = next[a].filter((k) => k !== key);
  }
  next[action] = [key, ...next[action].slice(1)];
  return next;
}

export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const saved = JSON.parse(raw) as Partial<Bindings>;
    // Merge over defaults so new actions added later still get keys.
    const merged = { ...DEFAULT_BINDINGS } as Bindings;
    for (const a of Object.keys(merged) as BindableAction[]) {
      if (Array.isArray(saved[a]) && saved[a]!.length > 0) merged[a] = saved[a]!;
    }
    return merged;
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

export function saveBindings(b: Bindings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(b));
  } catch {
    /* best-effort */
  }
}

// Mouse-aim preference: when on, attacks/bolts target the cursor; when off,
// they fire along movement facing (classic keyboard-only feel). Default on.
const AIM_KEY = "dcc:mouseaim:v1";

export function loadMouseAim(): boolean {
  try {
    return localStorage.getItem(AIM_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveMouseAim(on: boolean): void {
  try {
    localStorage.setItem(AIM_KEY, on ? "on" : "off");
  } catch {
    /* best-effort */
  }
}

// Announcer verbosity: how much System chatter reaches the side ticker.
// Headline banners always show; the HUD log always keeps everything.
export type NotifyLevel = "all" | "normal" | "critical";

const NOTIFY_KEY = "dcc:notify:v1";

export function loadNotify(): NotifyLevel {
  try {
    const v = localStorage.getItem(NOTIFY_KEY);
    return v === "all" || v === "critical" ? v : "normal";
  } catch {
    return "normal";
  }
}

export function saveNotify(level: NotifyLevel): void {
  try {
    localStorage.setItem(NOTIFY_KEY, level);
  } catch {
    /* best-effort */
  }
}
