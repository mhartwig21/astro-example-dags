import { deserialize } from "../sim/snapshot";
import type { GameState, HitEvent, Intent } from "../sim/types";

// Browser-side network client for the authoritative server. Receives full
// snapshots (15/s) + per-tick transient events, and produces a smooth display
// state by lerping entity positions between the last two snapshots. Sends the
// local intent on a fixed pump and forwards UI actions (draft picks, shop buys,
// ready-up, equips) as protocol messages — no game logic runs locally.

export interface NetEventBatch {
  events: string[];
  announcements: string[];
  hits: HitEvent[];
}

export class NetClient {
  private ws: WebSocket | null = null;
  playerId = -1;
  connected = false;
  onEvents: ((batch: NetEventBatch) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  private prev: GameState | null = null;
  private curr: GameState | null = null;
  private display_: GameState | null = null;
  private snapAt = 0;
  private snapInterval = 67; // ms between snapshots; refined from arrivals

  /** Connect, join a party, resolve on the welcome snapshot. */
  connect(url: string, code: string, name: string): Promise<GameState> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: "join", code, name }));
      ws.onerror = () => reject(new Error(`Could not reach the server at ${url}`));
      ws.onclose = () => {
        this.connected = false;
        this.onDisconnect?.();
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.t === "welcome") {
          this.playerId = msg.playerId;
          this.curr = deserialize(msg.snapshot);
          this.display_ = deserialize(msg.snapshot);
          this.snapAt = performance.now();
          this.connected = true;
          resolve(this.curr);
        } else if (msg.t === "snap") {
          const now = performance.now();
          if (this.curr) {
            this.prev = this.curr;
            this.snapInterval = this.snapInterval * 0.8 + Math.min(200, now - this.snapAt) * 0.2;
          }
          this.curr = deserialize(msg.snapshot);
          this.display_ = deserialize(msg.snapshot);
          this.snapAt = now;
        } else if (msg.t === "events") {
          this.onEvents?.(msg as NetEventBatch);
        }
      };
    });
  }

  /**
   * The state to render this frame: the latest snapshot with player/monster/
   * projectile positions lerped from the previous one (smooths the 15/s wire
   * rate up to render rate). Same-floor snapshots only — floor changes teleport.
   */
  display(now: number): GameState | null {
    const { prev, curr, display_ } = this;
    if (!curr || !display_) return null;
    if (!prev || prev.floor !== curr.floor) return curr;
    const t = Math.max(0, Math.min(1, (now - this.snapAt) / this.snapInterval));

    const lerp = (a: number, b: number) => a + (b - a) * t;
    for (const dp of display_.players) {
      const a = prev.players.find((p) => p.id === dp.id);
      const b = curr.players.find((p) => p.id === dp.id);
      if (a && b) { dp.pos.x = lerp(a.pos.x, b.pos.x); dp.pos.y = lerp(a.pos.y, b.pos.y); }
    }
    for (const dm of display_.monsters) {
      const a = prev.monsters.find((m) => m.id === dm.id);
      const b = curr.monsters.find((m) => m.id === dm.id);
      if (a && b) { dm.pos.x = lerp(a.pos.x, b.pos.x); dm.pos.y = lerp(a.pos.y, b.pos.y); }
    }
    for (const dpr of display_.projectiles) {
      const a = prev.projectiles.find((p) => p.id === dpr.id);
      const b = curr.projectiles.find((p) => p.id === dpr.id);
      if (a && b) { dpr.pos.x = lerp(a.pos.x, b.pos.x); dpr.pos.y = lerp(a.pos.y, b.pos.y); }
    }
    return display_;
  }

  /** Latest authoritative snapshot (no interpolation) — for UI reads. */
  get authoritative(): GameState | null {
    return this.curr;
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendIntent(intent: Intent): void {
    this.send({ t: "intent", intent });
  }
  choose(kind: "upgrade" | "reward", idx: number): void {
    this.send({ t: "choose", kind, idx });
  }
  buy(idx: number): void {
    this.send({ t: "buy", idx });
  }
  ready(): void {
    this.send({ t: "ready" });
  }
  equip(idx: number): void {
    this.send({ t: "equip", idx });
  }
  /** Safe-room bench: dismantle a bag item or upgrade an item's rarity. */
  craft(action: "dismantle" | "upgrade", where: string | number): void {
    this.send({ t: "craft", action, idx: where, where });
  }
  /** Safe-room loadout change: slot = "0".."3" | "bench" | "ult" | "unult". */
  slot(slot: string, ability: string): void {
    this.send({ t: "slot", slot, ability });
  }
}
