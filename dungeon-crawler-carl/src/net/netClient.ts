import { deserialize, deserializeDynamic } from "../sim/snapshot";
import { revealExplored } from "../sim/game";
import type { Announcement, GameState, HitEvent, Intent, Vec2 } from "../sim/types";

// Browser-side network client for the authoritative server. Receives snapshots
// (15/s; FULL carries map + fog, the recurring DYNAMIC ones don't — we keep the
// cached world and reveal fog locally with the sim's own revealExplored) plus
// per-tick transient events, and produces a smooth display state by lerping
// entity positions between the last two snapshots. Each snapshot is parsed
// exactly ONCE; lerp endpoints live in small id-keyed maps captured at arrival,
// so smoothing mutates the snapshot's positions without corrupting endpoints.
// Sends the local intent on a fixed pump and forwards UI actions (draft picks,
// shop buys, ready-up, equips) as protocol messages — no game logic runs locally.

export interface NetEventBatch {
  events: string[];
  announcements: Announcement[];
  hits: HitEvent[];
}

/** Endpoint positions of everything that moves, keyed p<id>/m<id>/r<id>. */
function capturePositions(s: GameState): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  for (const p of s.players) out.set(`p${p.id}`, { x: p.pos.x, y: p.pos.y });
  for (const m of s.monsters) out.set(`m${m.id}`, { x: m.pos.x, y: m.pos.y });
  for (const pr of s.projectiles) out.set(`r${pr.id}`, { x: pr.pos.x, y: pr.pos.y });
  return out;
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

  private curr: GameState | null = null;
  private world: { map: GameState["map"]; explored: Uint8Array } | null = null;
  private exploredVersion = 0; // client-side fog version (renderer diffing)
  private prevPos = new Map<string, Vec2>();
  private currPos = new Map<string, Vec2>();
  private prevFloor = -1;
  private snapAt = 0;
  private snapInterval = 67; // ms between snapshots; refined from arrivals
  // Auto-reconnect state: the original join args, replayed on unexpected close.
  private args: { url: string; code: string; name: string; rivals: boolean; roam: boolean } | null = null;
  private retryN = 0;
  private everConnected = false; // never auto-retry a join that failed outright

  /** Absorb a snapshot: full replaces the cached world; dynamic rides on it. */
  private absorb(snapshot: string, full: boolean): GameState | null {
    if (full) {
      const s = deserialize(snapshot);
      this.world = { map: s.map, explored: s.explored };
      this.exploredVersion = Math.max(this.exploredVersion + 1, s.exploredVersion);
      s.exploredVersion = this.exploredVersion;
      return s;
    }
    if (!this.world) return null; // dynamic before any full — drop it
    const s = deserializeDynamic(snapshot, this.world.map, this.world.explored);
    // Fog is OURS now: reveal around this snapshot's crawlers, same math
    // as the sim (the mask is monotonic, so local and server never disagree
    // about anything the player has seen).
    if (revealExplored(this.world.map, this.world.explored, s.players)) this.exploredVersion++;
    s.exploredVersion = this.exploredVersion;
    return s;
  }

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
          this.prevPos = new Map(); // never lerp across a (re)join boundary
          this.prevFloor = -1;
          this.curr = this.absorb(msg.snapshot, true);
          this.currPos = capturePositions(this.curr!);
          this.snapAt = performance.now();
          this.connected = true;
          this.everConnected = true;
          this.retryN = 0;
          resolve(this.curr!);
        } else if (msg.t === "snap") {
          const s = this.absorb(msg.snapshot, msg.full === true);
          if (!s) return;
          const now = performance.now();
          if (this.curr) {
            this.prevPos = this.currPos;
            this.prevFloor = this.curr.floor;
            this.snapInterval = this.snapInterval * 0.8 + Math.min(200, now - this.snapAt) * 0.2;
          }
          this.curr = s;
          this.currPos = capturePositions(s);
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
    const { curr, prevPos, currPos } = this;
    if (!curr) return null;
    if (this.prevFloor !== curr.floor || prevPos.size === 0) return curr;
    const t = Math.max(0, Math.min(1, (now - this.snapAt) / this.snapInterval));

    const smooth = (key: string, pos: Vec2) => {
      const a = prevPos.get(key);
      const b = currPos.get(key);
      if (!a || !b) return;
      pos.x = a.x + (b.x - a.x) * t;
      pos.y = a.y + (b.y - a.y) * t;
    };
    for (const p of curr.players) smooth(`p${p.id}`, p.pos);
    for (const m of curr.monsters) smooth(`m${m.id}`, m.pos);
    for (const pr of curr.projectiles) smooth(`r${pr.id}`, pr.pos);
    return curr;
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
