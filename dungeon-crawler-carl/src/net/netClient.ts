import { deserialize } from "../sim/snapshot";
import type { Announcement, GameState, HitEvent, Intent } from "../sim/types";

// Browser-side network client for the authoritative server. Receives full
// snapshots (15/s) + per-tick transient events, and produces a smooth display
// state by lerping entity positions between the last two snapshots. Sends the
// local intent on a fixed pump and forwards UI actions (draft picks, shop buys,
// ready-up, equips) as protocol messages — no game logic runs locally.

export interface NetEventBatch {
  events: string[];
  announcements: Announcement[];
  hits: HitEvent[];
}

// Account token (PERSISTENCE.md P1): an anonymous bearer id the server keys
// character saves off. Minted server-side on first join, echoed in the
// welcome, kept here so the same browser gets the same character back.
const TOKEN_KEY = "dcc:token:v1";
function loadToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined; // no storage (private mode / non-browser): session-only identity
  }
}
function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Best-effort, like the run save.
  }
}

// Reconnect cadence: fast at first (a deploy restart is seconds), then backed
// off, giving up after ~3 minutes of dead air. The server persists the world
// on shutdown, so riding this out means resuming the same run.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
const RECONNECT_MAX_ATTEMPTS = 20;
const RECONNECT_CAP_MS = 10_000;

export class NetClient {
  private ws: WebSocket | null = null;
  playerId = -1;
  connected = false;
  onEvents: ((batch: NetEventBatch) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  /** Fired when an automatic rejoin lands: playerId may have changed (the
   *  world can be a restored instance) — hosts must re-read it. */
  onReconnect: ((snapshot: GameState) => void) | null = null;

  private prev: GameState | null = null;
  private curr: GameState | null = null;
  private display_: GameState | null = null;
  private snapAt = 0;
  private snapInterval = 67; // ms between snapshots; refined from arrivals
  // Auto-reconnect state: the original join args, replayed on unexpected close.
  private args: { url: string; code: string; name: string; rivals: boolean; roam: boolean } | null = null;
  private retryN = 0;
  private everConnected = false; // never auto-retry a join that failed outright

  /** Connect, join a party, resolve on the welcome snapshot.
   * `rivals` opts the instance into the competitive race (first joiner decides);
   * `roam` starts the party as a Roam campaign the same way. */
  connect(url: string, code: string, name: string, rivals = false, roam = false): Promise<GameState> {
    this.args = { url, code, name, rivals, roam };
    return this.open();
  }

  private open(): Promise<GameState> {
    const { url, code, name, rivals, roam } = this.args!;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({
        t: "join", code, name,
        rivals: rivals || undefined,
        roam: roam || undefined,
        token: loadToken(),
      }));
      ws.onerror = () => reject(new Error(`Could not reach the server at ${url}`));
      ws.onclose = () => {
        const hadSeat = this.connected;
        this.connected = false;
        if (hadSeat) this.onDisconnect?.();
        // Unexpected drop mid-run (deploy, network blip): quietly rejoin with
        // the same code/token — the server gives this account its seat back.
        if (hadSeat && this.everConnected) this.scheduleReconnect();
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.t === "welcome") {
          this.playerId = msg.playerId;
          if (typeof msg.token === "string") storeToken(msg.token);
          this.prev = null; // never lerp across a (re)join boundary
          this.curr = deserialize(msg.snapshot);
          this.display_ = deserialize(msg.snapshot);
          this.snapAt = performance.now();
          this.connected = true;
          this.everConnected = true;
          this.retryN = 0;
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

  private scheduleReconnect(): void {
    if (this.retryN >= RECONNECT_MAX_ATTEMPTS) return; // the System gave up on us
    const delay = RECONNECT_DELAYS_MS[this.retryN] ?? RECONNECT_CAP_MS;
    this.retryN++;
    setTimeout(() => {
      if (this.connected) return; // a manual reconnect beat us to it
      this.open().then(
        (snap) => this.onReconnect?.(snap),
        () => this.scheduleReconnect(), // dial failed; keep trying on the backoff
      );
    }, delay);
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
  /** System Shop purchase by catalog id (the sim re-validates gate + costs). */
  buy(id: string): void {
    this.send({ t: "buy", id });
  }
  /** Sell a bag item back to the System Shop. */
  sell(idx: number): void {
    this.send({ t: "sell", idx });
  }
  /** Liquidate the whole bag (equipped gear is safe). */
  sellAll(): void {
    this.send({ t: "sellAll" });
  }
  ready(): void {
    this.send({ t: "ready" });
  }
  equip(idx: number): void {
    this.send({ t: "equip", idx });
  }
  /** Safe-room loadout change: slot = "0".."3" | "bench" | "ult" | "unult". */
  slot(slot: string, ability: string): void {
    this.send({ t: "slot", slot, ability });
  }
}
