import {
  createGame, createTestGame, restoreGame, step, equipFromInventory, equipItem, chooseReward, chooseUpgrade,
  buyCatalogItem, hasPassive, sellItem, sellAllItems, sellValue, effectivePrice, missingComponents, setReady, addPlayer, slotAbility, setUltimate,
  type TestSetup,
} from "./sim/game";
import { ACHIEVEMENTS } from "./sim/achievements";
import { affixLines, itemScore, weaponClassOf } from "./sim/items";
import { buildCharacterSheet, type SheetAbilityRow } from "./sim/sheet";
import {
  CATALOG, CATALOG_BY_ID, TIER_UNLOCK_SHOP, buildsInto, consumablePrice, consumableStock, gearAffixes,
  totalCost, type CatalogEntry, type CatalogTier,
} from "./sim/catalog";
import {
  EQUIP_SLOTS, Tile,
  type Announcement, type AnnouncementKind, type GameState, type HitEvent, type Item, type ItemSlot, type Player,
  type Vec2,
} from "./sim/types";
import { CONFIG } from "./sim/config";
import {
  ABILITY_INFO, ABILITY_SLOTS, DISCOVERABLE_ABILITIES, STARTING_ABILITIES, UPGRADES,
  knows, nodeOpen, rank, upgradeDef, type AbilityId,
} from "./sim/abilities";
import { InputController } from "./input/input";
import { GamepadController, isoRotate } from "./input/gamepad";
import { TouchController } from "./input/touch";
import { createClickMove, stepClickMove } from "./input/clickMove";
import {
  ACTION_INFO, DEFAULT_BINDINGS, bindingLabel, loadBindings, loadGamepad, loadMouseAim, loadMouseMove, loadNotify,
  loadTouch, rebind, saveBindings, saveGamepad, saveMouseAim, saveMouseMove, saveNotify, saveTouch,
  type BindableAction, type Bindings, type NotifyLevel, type TouchPref,
} from "./input/bindings";
import { Renderer3D } from "./render3d/renderer3d";
import { AudioEngine } from "./audio/engine";
import { AudioDirector } from "./audio/director";
import { clearRun, loadRun, saveRun, type RunMode } from "./persist/save";
import { careerBests, loadHistory, recordRun } from "./persist/history";
import { dailySeed, dayFromMs } from "./sim/daily";
import { NetClient } from "./net/netClient";
import { registerMobDef } from "./content/mobs";
import { registerRoomTemplate } from "./content/rooms";
import type { CustomMobDef, RoomTemplate } from "./content/types";

// 3D isometric host: runs the exact same deterministic sim as the 2D slice, but
// renders it through the Three.js isometric renderer. Proves the art direction and
// that rendering is fully decoupled from gameplay (same sim, two views).

const SIM_HZ = 60;
const SIM_DT = 1 / SIM_HZ;
const MAX_FRAME = 0.1;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer3D(canvas);

// Audio seam: same consumer pattern as particles/damage numbers, fed from the
// per-frame feedback buffers. Silent until clips exist under public/audio/
// (see ASSETS.md — Audio); missing files simply never play.
const audio = new AudioEngine();
void audio.load();
const audioDirector = new AudioDirector(audio);

// ---- Network mode (?join=CODE[&name=...][&server=ws://host:5281]) ----
// Local mode runs the sim in-page; network mode renders authoritative snapshots
// from the server and forwards intents/actions. Same renderer, same UI.
const params = new URLSearchParams(location.search);
const joinCode = params.get("join");
// RIVALS: ?rivals=1&join=CODE — up to four hostile crawlers race for the boss.
const rivalsMode = params.has("rivals");
// ROAM (multiplayer): ?roam=1&join=CODE — the party campaigns across sessions;
// the server persists characters per account (see PERSISTENCE.md).
const roamMode = params.has("roam");
const net = joinCode ? new NetClient() : null;
const playerName =
  params.get("name") ?? (joinCode ? (prompt("Crawler name?") || "Crawler") : "Carl");
// Server URL: explicit ?server= wins. In dev (vite on :5280) the game server is
// the sibling process on :5281; in production the SAME origin serves both the
// site and the WebSocket, and wss follows https automatically.
const serverUrl =
  params.get("server") ??
  (import.meta.env.DEV
    ? `ws://${location.hostname}:5281`
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
let localId = 0;
const me = (s: GameState) => s.players.find((p) => p.id === localId) ?? s.players[0];

let mouseAim = loadMouseAim();
let mouseClickMove = loadMouseMove();
let notifyLevel = loadNotify();
canvas.style.cursor = mouseAim ? "crosshair" : "default"; // crosshair only when aiming
const clickMove = createClickMove();

function resize(): void {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

function freshSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

// ---- Test mode (?test[&floor=9&level=12&abilities=all&gold=500&seed=42]) ----
// Jump straight to a dungeon stage with a stage-representative crawler. Local
// only, and nothing is loaded or saved — the real run's save is untouched.
const testMode = params.has("test") && !net;
// BUILDER TEST-DRIVE: /builder.html stashes a work-in-progress def in
// localStorage and deep-links here with &testmob / &testroom. Register it
// before the game builds so it actually spawns/stamps. Test mode only —
// nothing persists, and a stale stash just means a plain test run.
if (testMode && params.has("testmob")) {
  try {
    const d = JSON.parse(localStorage.getItem("dcc:test:mob") ?? "") as CustomMobDef;
    registerMobDef({ ...d, bands: [0, 1, 2, 3, 4, 5], weight: 99 }); // force the encounter
  } catch { /* fall through to a plain test run */ }
}
if (testMode && params.has("testroom")) {
  try {
    registerRoomTemplate(JSON.parse(localStorage.getItem("dcc:test:room") ?? "") as RoomTemplate);
  } catch { /* fall through */ }
}
function testSetup(): TestSetup {
  const num = (k: string): number | undefined => {
    const raw = params.get(k);
    if (raw === null || raw === "") return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };
  const ab = params.get("abilities");
  return {
    seed: num("seed"),
    floor: num("floor"),
    level: num("level"),
    gold: num("gold"),
    abilities: ab === "all" ? "all" : ab ? (ab.split(",").filter((a) => a in ABILITY_INFO) as AbilityId[]) : undefined,
    gear: params.get("gear") !== "0",
  };
}
/** In test mode the run is disposable — never write it over the real save. */
function persistRun(g: GameState): void {
  if (!testMode) saveRun(g, runMode);
}

// ---- Run mode (set by the check-in menu; daily runs share one seed per day) ----
let runMode: RunMode = { kind: "random" };
// Race (today's 18-floor descent) vs Roam (SETTLEMENTS.md v1). Orthogonal to
// RunMode: daily/random only ever apply to Race in the menu today.
let currentRunKind: GameState["runKind"] = "race";
let dailySubmitted = false; // one board submission per run end
let hasContinue = false; // a mid-run save was restored; the menu offers CONTINUE

function boot(): GameState {
  if (testMode) return createTestGame(testSetup());
  const save = loadRun();
  if (save && save.status === "playing") {
    runMode = save.mode ?? { kind: "random" };
    hasContinue = true;
    const g = restoreGame(save);
    if (save.player.name) g.players[0].name = save.player.name;
    return g;
  }
  // No run to resume: this state is only the menu's backdrop. Nothing is
  // saved until the crawler signs the waiver (picks a mode).
  return createGame(freshSeed());
}
if (testMode) {
  document.getElementById("banner")!.insertAdjacentHTML("afterbegin", "<b>TEST MODE</b>");
}

let state = net ? createGame(0) : boot(); // net: placeholder until the welcome snapshot

// Test-mode debug hook: lets headless verification (CDP-driven) inspect the
// live sim instead of guessing from pixels. Never set outside ?test.
if (testMode) Object.defineProperty(window, "__dcc", { configurable: true, get: () => ({ state }) });
const log: string[] = [];

/** Start a fresh local run in the given mode (menu choice or R-key rerun). */
function startRun(mode: RunMode, runKind: GameState["runKind"] = "race"): void {
  clearRun();
  runMode = mode;
  currentRunKind = runKind;
  dailySubmitted = false;
  const seed = mode.kind === "daily" && mode.day ? dailySeed(mode.day) : freshSeed();
  state = createGame(seed, "coop", runKind);
  state.players[0].name = crawlerName();
  saveRun(state, runMode);
  log.length = 0;
  clearLogFeed();
  pushLogLine(runKind === "roam"
    ? "Roam mode. No clock, no floor 18 — just the next settlement over."
    : mode.kind === "daily"
    ? `DAILY CRAWL ${mode.day}. Every crawler gets this dungeon. Only the board remembers.`
    : `New run. Descend to floor ${CONFIG.finalFloor}.`);
}

const input = new InputController(canvas);
input.mouseMoveMode = mouseClickMove;

// Controller (Gamepad API): a second Intent producer merged in sampleIntent.
// The most recent device wins AIM; movement and casts simply OR together.
// The K panel's Controller toggle turns the whole thing off (no polling,
// no toasts) for players whose parked pad drifts.
const gamepad = new GamepadController();
let gamepadEnabled = loadGamepad();
let lastMouseAt = 0; // host clock (s) of the last mouse touch — device arbitration
canvas.addEventListener("mousemove", () => { lastMouseAt = performance.now() / 1000; });
canvas.addEventListener("mousedown", () => { lastMouseAt = performance.now() / 1000; });
gamepad.onConnect = (id) => {
  if (!gamepadEnabled) return;
  pushLogLine(`Controller connected: ${id.slice(0, 40)} — sticks move/aim, A·X·B·Y cast.`);
  if (kbOpen) renderKeybinds(); // the K panel grows its controller legend
};
gamepad.onDisconnect = () => {
  if (!gamepadEnabled) return;
  pushLogLine("Controller disconnected.");
  if (kbOpen) renderKeybinds();
};

// Touch controls (Wild Rift-style, see input/touch.ts): AUTO on coarse-pointer
// devices, forceable via ?touch=1 (headless verify) or the K panel. The skill
// chips double as the ability cluster; body.touch drives all layout.
let touchPref: TouchPref = loadTouch();
const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
function touchWanted(): boolean {
  if (params.has("touch")) return params.get("touch") !== "0";
  return touchPref === "on" || (touchPref === "auto" && coarsePointer);
}
let touchMode = touchWanted();
const touch = new TouchController();
const tStickEl = document.getElementById("t-stick")!;
const tStairsEl = document.getElementById("t-stairs")!;
touch.bind(document.getElementById("t-stickzone")!, document.getElementById("skills")!, tStairsEl);
touch.onStick = (origin, nub) => {
  if (!origin) { tStickEl.style.display = "none"; return; }
  tStickEl.style.display = "block";
  tStickEl.style.left = `${origin.x}px`;
  tStickEl.style.top = `${origin.y}px`;
  (tStickEl.firstElementChild as HTMLElement).style.transform = `translate(${nub.x}px, ${nub.y}px)`;
};
function applyTouchMode(): void {
  touchMode = touchWanted();
  document.body.classList.toggle("touch", touchMode);
}
applyTouchMode();
input.onReset = () => {
  if (net) return; // the server owns the run in network mode
  if (testMode) {
    const s = testSetup();
    if (!params.has("seed")) s.seed = freshSeed(); // R rerolls unless pinned
    state = createTestGame(s);
    log.length = 0;
    clearLogFeed();
    pushLogLine(`New run. Descend to floor ${CONFIG.finalFloor}.`);
  } else {
    startRun(runMode, currentRunKind); // rerun keeps the mode: a daily rerun replays today's dungeon
  }
  if (invOpen) toggleInventory(); // close stale panels from the old run
  if (abilOpen) toggleAbilities();
  document.getElementById("saferoom")!.style.display = "none";
  document.getElementById("draft")!.style.display = "none";
  document.getElementById("recap")!.style.display = "none"; // last season's report card
};

// ---- RINGSIDE CHECK-IN (entry menu) + the Daily Crawl board ----
// Shown at page load for local play; ?join= and ?test deep links skip it (they
// already carry a complete decision). While open it freezes the sim (backdrop
// dungeon) and owns the keyboard via input.captureMode, like the rebind panel.
const menuEl = document.getElementById("menu")!;
let menuOpen = false;
const NAME_KEY = "dcc:name:v1";
const nameInput = document.getElementById("m-name") as HTMLInputElement;
try { nameInput.value = localStorage.getItem(NAME_KEY) ?? "Carl"; } catch { nameInput.value = "Carl"; }
function crawlerName(): string {
  return (nameInput.value.trim() || "Carl").slice(0, 24);
}
nameInput.addEventListener("change", () => {
  try { localStorage.setItem(NAME_KEY, crawlerName()); } catch { /* best-effort */ }
});

// Leaderboard API: same origin in production (the game server serves both);
// in dev the Vite client on :5280 talks to the sibling server on :5281.
const API_BASE = import.meta.env.DEV ? `http://${location.hostname}:5281` : "";

async function refreshBoard(): Promise<void> {
  const list = document.getElementById("m-board-list")!;
  try {
    const day = dayFromMs(Date.now());
    const r = await fetch(`${API_BASE}/leaderboard?day=${day}`);
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as { entries: { name: string; floor: number; won: boolean; timeSec: number }[] };
    list.innerHTML = data.entries.length
      ? data.entries.slice(0, 10).map((e, i) =>
          `<li><span class="rank">${i + 1}</span><span class="nm"></span>` +
          `<span class="res${e.won ? " win" : ""}">${e.won ? `CLEAR · ${fmt(e.timeSec)}` : `floor ${e.floor}`}</span></li>`,
        ).join("")
      : '<li class="none">no crawlers on the board yet — be the first</li>';
    // Names are player-supplied: set via textContent, never innerHTML.
    const nms = list.querySelectorAll(".nm");
    data.entries.slice(0, 10).forEach((e, i) => { nms[i].textContent = e.name; });
  } catch {
    list.innerHTML = '<li class="none">board offline — the server keeps the score</li>';
  }
}

/** Submit a finished daily run (win or wipe). Fire-and-forget; the board is a
 *  bonus, never a blocker. */
function submitDaily(s: GameState): void {
  if (net || testMode || runMode.kind !== "daily" || !runMode.day || dailySubmitted) return;
  dailySubmitted = true;
  const p = me(s);
  void fetch(`${API_BASE}/leaderboard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      day: runMode.day, name: p.name, floor: s.floor,
      won: s.status === "won", timeSec: Math.round(s.elapsed), kills: p.kills,
    }),
  }).then(async (r) => {
    if (!r.ok) return;
    const { rank } = (await r.json()) as { rank: number };
    pushLogLine(`DAILY CRAWL: rank #${rank} on today's board.`);
    const note = document.getElementById("recap-note")!;
    note.textContent = `daily board: rank #${rank} today${note.textContent ? ` · ${note.textContent}` : ""}`;
  }).catch(() => { /* offline is fine */ });
}

/** The CAREER panel: personal bests + recent seasons, from the local ledger. */
function renderCareer(): void {
  const panel = document.getElementById("m-career")!;
  const history = loadHistory();
  const bests = careerBests(history);
  if (!bests) {
    panel.style.display = "none"; // no finished runs yet: no empty shrine
    return;
  }
  panel.style.display = "";
  document.getElementById("m-career-sub")!.textContent =
    `${bests.runs} season${bests.runs === 1 ? "" : "s"} · ${bests.wins} escape${bests.wins === 1 ? "" : "s"}`;
  document.getElementById("m-career-bests")!.innerHTML =
    `<div class="best"><b>${bests.bestFloor}</b><small>BEST FLOOR</small></div>` +
    `<div class="best"><b>${bests.fastestClearSec !== null ? fmt(bests.fastestClearSec) : "—"}</b><small>FASTEST CLEAR</small></div>` +
    `<div class="best"><b>${bests.mostKills.toLocaleString()}</b><small>MOST KILLS</small></div>` +
    `<div class="best"><b>${bests.peakViewers.toLocaleString()}</b><small>PEAK VIEWERS</small></div>`;
  document.getElementById("m-career-list")!.innerHTML = history.slice(0, 5).map((r) =>
    `<li><span class="rank">${r.mode === "daily" ? "◆" : "·"}</span>` +
    `<span class="nm">${r.won ? "ESCAPED" : `floor ${r.floor}`}</span>` +
    `<span class="res${r.won ? " win" : ""}">${r.won ? fmt(r.timeSec) : `lvl ${r.level} · ${r.kills} kills`}</span></li>`,
  ).join("");
}

function openMenu(): void {
  menuOpen = true;
  input.captureMode = true; // typing a name must not fire game binds
  menuEl.style.display = "flex";
  const cont = document.getElementById("m-continue")!;
  if (hasContinue) {
    const p = state.players[0];
    cont.style.display = "";
    document.getElementById("m-continue-sub")!.textContent =
      `${p.name} · floor ${state.floor} · level ${p.level} — the cameras never stopped rolling`;
    if (p.name) nameInput.value = p.name;
  }
  document.getElementById("m-board-day")!.textContent = dayFromMs(Date.now());
  void refreshBoard();
  renderCareer();
}
function closeMenu(): void {
  menuOpen = false;
  input.captureMode = false;
  menuEl.style.display = "none";
}

document.getElementById("m-continue")!.addEventListener("click", () => closeMenu());
document.getElementById("m-daily")!.addEventListener("click", () => {
  startRun({ kind: "daily", day: dayFromMs(Date.now()) });
  closeMenu();
});
document.getElementById("m-solo")!.addEventListener("click", () => {
  startRun({ kind: "random" });
  closeMenu();
});

// RACE / ROAM top-level split. RACE shows today's full card set unchanged;
// ROAM (v1 — SETTLEMENTS.md) is solo-only for now: one big floor, one
// settlement, one tribe, one quest, no daily/party/rivals/test yet.
document.getElementById("m-mode-race")!.addEventListener("click", () => {
  document.getElementById("m-race-cards")!.style.display = "";
  document.getElementById("m-roam-cards")!.style.display = "none";
  document.getElementById("m-mode-race")!.classList.add("active");
  document.getElementById("m-mode-roam")!.classList.remove("active");
});
document.getElementById("m-mode-roam")!.addEventListener("click", () => {
  document.getElementById("m-race-cards")!.style.display = "none";
  document.getElementById("m-roam-cards")!.style.display = "";
  document.getElementById("m-mode-roam")!.classList.add("active");
  document.getElementById("m-mode-race")!.classList.remove("active");
});
document.getElementById("m-roam-solo")!.addEventListener("click", () => {
  startRun({ kind: "random" }, "roam");
  closeMenu();
});

// Party crawl: the invite code IS the dungeon seed; the URL is the invite.
const codeInput = document.getElementById("m-code") as HTMLInputElement;
function rollCode(): string {
  // Readable, unambiguous (no 0/O/1/I): good enough to say out loud on a call.
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
document.getElementById("m-party")!.addEventListener("click", () => {
  const form = document.getElementById("m-party-form")!;
  const opening = form.style.display === "none";
  form.style.display = opening ? "flex" : "none";
  if (opening && !codeInput.value) codeInput.value = rollCode();
});
document.getElementById("m-roll")!.addEventListener("click", () => { codeInput.value = rollCode(); });
document.getElementById("m-join")!.addEventListener("click", () => {
  const code = codeInput.value.trim().toUpperCase().slice(0, 32);
  if (!code) { codeInput.focus(); return; }
  location.href = `${location.pathname}?join=${encodeURIComponent(code)}&name=${encodeURIComponent(crawlerName())}`;
});
// RIVALS: a first-class home-screen card with its own race code — same code
// plumbing as co-op, hostile rules. The first joiner arms the race.
const rivalCodeInput = document.getElementById("m-rcode") as HTMLInputElement;
document.getElementById("m-rivals-card")!.addEventListener("click", () => {
  const form = document.getElementById("m-rivals-form")!;
  const opening = form.style.display === "none";
  form.style.display = opening ? "flex" : "none";
  if (opening && !rivalCodeInput.value) rivalCodeInput.value = rollCode();
});
document.getElementById("m-rroll")!.addEventListener("click", () => { rivalCodeInput.value = rollCode(); });
document.getElementById("m-rivals")!.addEventListener("click", () => {
  const code = rivalCodeInput.value.trim().toUpperCase().slice(0, 32);
  if (!code) { rivalCodeInput.focus(); return; }
  location.href = `${location.pathname}?rivals=1&join=${encodeURIComponent(code)}&name=${encodeURIComponent(crawlerName())}`;
});

// Test chamber: builds the existing ?test deep link (createTestGame does the rest).
document.getElementById("m-test")!.addEventListener("click", () => {
  const form = document.getElementById("m-test-form")!;
  form.style.display = form.style.display === "none" ? "flex" : "none";
});
document.getElementById("m-t-go")!.addEventListener("click", () => {
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
  const q = new URLSearchParams();
  q.set("test", "");
  if (val("m-t-floor")) q.set("floor", val("m-t-floor"));
  if (val("m-t-level")) q.set("level", val("m-t-level"));
  if (Number(val("m-t-gold")) > 0) q.set("gold", val("m-t-gold"));
  if (val("m-t-seed")) q.set("seed", val("m-t-seed"));
  if ((document.getElementById("m-t-all") as HTMLInputElement).checked) q.set("abilities", "all");
  location.href = `${location.pathname}?${q.toString().replace("test=", "test")}`;
});

if (!net && !testMode) openMenu();

// HUD elements.
const hudTL = document.getElementById("hud-tl")!;
const hudTR = document.getElementById("hud-tr")!;
const hudLog = document.getElementById("hud-log")!;
const hudLogFeed = document.getElementById("hud-log-feed")!;
const hudLogStatus = document.getElementById("hud-log-status")!;

// HUD log feed: each line gets its own fade lifecycle (was a blunt innerHTML
// overwrite every frame — a burst of 2+ events could evict an unread line
// with zero visual cue). Pops brighter on arrival (.fresh, eased by the
// `color` transition on .log-line), holds, then fades out on its way out;
// overflow past LOG_MAX fades the oldest instead of yanking it.
const LOG_MAX = 5;
const LOG_HOLD_MS = 7000;

function fadeOutLogLine(el: HTMLElement): void {
  el.classList.remove("show");
  setTimeout(() => el.remove(), 350);
}

function pushLogLine(text: string): void {
  log.push(text);
  const el = document.createElement("div");
  el.className = "log-line fresh";
  el.textContent = text;
  hudLogFeed.appendChild(el);
  if (hudLogFeed.children.length > LOG_MAX) fadeOutLogLine(hudLogFeed.firstElementChild as HTMLElement);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => el.classList.remove("fresh"), 900);
  setTimeout(() => fadeOutLogLine(el), LOG_HOLD_MS);
}

function clearLogFeed(): void {
  hudLogFeed.innerHTML = "";
}

pushLogLine(`Entered floor ${state.floor}. Descend to floor ${CONFIG.finalFloor}.`);

// BULLET TIME screen grade: the System dims the house lights. A CSS filter
// desaturates the canvas and a radial vignette closes in; both fade over
// ~220ms so entry/exit feel like a lens, not a light switch. (The audio
// director muffles the mix in parallel — see AudioEngine.muffle.)
const btVignette = document.createElement("div");
btVignette.style.cssText =
  "position:fixed;inset:0;pointer-events:none;z-index:1;opacity:0;" +
  "transition:opacity 220ms ease-out;" +
  "background:radial-gradient(ellipse at center, rgba(20,30,50,0) 52%, rgba(8,12,24,0.6) 100%)";
document.body.appendChild(btVignette);
canvas.style.transition = "filter 220ms ease-out";
let btGradeOn = false;
function updateBulletTimeGrade(s: GameState): void {
  const on = s.bulletTimeLeft > 0;
  if (on === btGradeOn) return;
  btGradeOn = on;
  canvas.style.filter = on ? "saturate(0.4) brightness(1.06) contrast(1.06)" : "";
  btVignette.style.opacity = on ? "1" : "0";
}

const fxLayer = document.getElementById("fx")!;
const toastLayer = document.getElementById("toasts")!;
const minimap = document.getElementById("minimap") as HTMLCanvasElement;
const mmCtx = minimap.getContext("2d")!;
// Touch: tapping the minimap drops a party ping there (inverse of the
// drawMinimap transform: pad 6, uniform tile scale).
minimap.addEventListener("pointerdown", (e) => {
  if (!touchMode) return;
  const r = minimap.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const cx = (e.clientX - r.left) * (minimap.width / r.width);
  const cy = (e.clientY - r.top) * (minimap.height / r.height);
  const pad = 6;
  const sx = (minimap.width - pad * 2) / state.map.w;
  const sy = (minimap.height - pad * 2) / state.map.h;
  touchEdges.ping = {
    x: Math.max(0, Math.min(state.map.w - 1, (cx - pad) / sx)),
    y: Math.max(0, Math.min(state.map.h - 1, (cy - pad) / sy)),
  };
  e.preventDefault();
});

const RARITY_COLORS: Record<string, string> = {
  common: "#b9b2a4", magic: "#5a87c6", rare: "#f2c14e", epic: "#9a6bd0",
};

// ---- The Show: audience bar + sponsor draft ----
const statViewers = document.getElementById("stat-viewers")!;
const statFavorites = document.getElementById("stat-favorites")!;
const statSponsors = document.getElementById("stat-sponsors")!;
const hypeBar = document.getElementById("hype-bar")!;
const hypeFill = document.getElementById("hype-fill") as HTMLElement;
const hypeTick = document.getElementById("hype-tick") as HTMLElement;
// The frenzy line is a fixed fraction of the meter — place it once.
hypeTick.style.left = `${(CONFIG.show.frenzyEnter / CONFIG.show.hypeMax) * 100}%`;
const draftEl = document.getElementById("draft")!;
const draftCards = document.getElementById("draft-cards")!;
const draftBadge = document.getElementById("draft-badge")!;
// Claim-when-ready draft flow: level-up drafts BANK behind the badge instead
// of hijacking the screen mid-fight (in multiplayer the world can't pause;
// in solo it now pauses only while the modal is actually OPEN). Reward drafts
// still auto-open — they fire in safe contexts (the descent entrance room, a
// shrine you chose to touch), and so does anything pending in a safe room.
let draftChain = false; // player is actively claiming: queued drafts flow without re-prompting
let draftIdleSec = 0; // how long picks have sat unclaimed (drives the one nag)
let draftNagged = false; // the System reminds exactly once per run
let prevRewardN = 0;
let prevUpgradeN = 0;
let prevInSafe = false;
let shownSponsors = 0;
let shownViewers = 0;

function openDraftModal(): void {
  renderDraft(state);
  draftEl.style.display = "flex";
}

function dismissDraftModal(): void {
  draftEl.style.display = "none";
  draftChain = false;
}

function bump(el: HTMLElement): void {
  const chip = el.closest(".stat") as HTMLElement | null;
  if (!chip) return;
  chip.classList.remove("bump");
  void chip.offsetWidth; // restart animation
  chip.classList.add("bump");
}

// Boss encounter UI: the ringside intro splash (mirrors the sim's world
// freeze) and a persistent top-center health bar for the engaged menace.
const bossbarEl = document.getElementById("bossbar")!;
const bbIcon = document.getElementById("bb-icon")!;
const bbName = document.getElementById("bb-name")!;
const bbAffix = document.getElementById("bb-affix")!;
const bbFill = document.getElementById("bb-fill") as HTMLElement;
const bossintroEl = document.getElementById("bossintro")!;
const biName = document.getElementById("bi-name")!;
const biAffix = document.getElementById("bi-affix")!;
let introShownFor = -1;

function updateBossBar(s: GameState): void {
  const p = me(s);
  const enc = s.encounter;
  if (enc) {
    if (introShownFor !== enc.monsterId) {
      introShownFor = enc.monsterId;
      biName.textContent = enc.name;
      biAffix.textContent = enc.affix
        ? `${enc.elite ? "ELITE — " : ""}${enc.affix.toUpperCase()}`
        : enc.kind === "boss" ? "BOSS" : "ELITE";
      bossintroEl.classList.remove("show");
      void (bossintroEl as HTMLElement).offsetWidth; // restart the scale-in
      bossintroEl.classList.add("show");
    }
  } else {
    bossintroEl.classList.remove("show");
  }
  // Engaged target: the nearest introduced, living boss/elite within range.
  let target: GameState["monsters"][number] | null = null;
  let best = 16;
  for (const m of s.monsters) {
    if ((m.kind !== "boss" && !m.elite) || !m.introduced || m.hp <= 0) continue;
    const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
    if (d < best) { best = d; target = m; }
  }
  if (!target) {
    bossbarEl.style.display = "none";
    return;
  }
  bossbarEl.style.display = "block";
  bbIcon.innerHTML = target.kind === "boss" ? uic("skull") : "◆";
  bbName.textContent = target.eliteName ?? "THE FLOOR BOSS";
  // Affix tag + status pips (5.11): the bar shows what the menace IS and what
  // the party has stuck to it (burn/poison/chill uptime at a glance).
  bbAffix.innerHTML = (target.affix ? target.affix.toUpperCase() + " " : "") + statusChips(target.statuses);
  bbFill.style.width = `${Math.max(0, Math.min(1, target.hp / target.maxHp)) * 100}%`;
}

function updateShowHud(s: GameState): void {
  const p = me(s);
  const v = Math.round(p.viewers);
  // Crowd Frenzy: the viewer count burns gold while the buff is live.
  statViewers.style.color = p.frenzy ? "#f2c14e" : "";
  statViewers.textContent = v.toLocaleString();
  statFavorites.textContent = Math.floor(p.favorites).toLocaleString();
  statSponsors.textContent = String(p.sponsors);
  if (p.sponsors !== shownSponsors) { shownSponsors = p.sponsors; bump(statSponsors); }
  // Pop the viewer chip on a big surge (exciting moment).
  if (v > shownViewers * 1.25 && v > 500) bump(statViewers);
  shownViewers = v;
  // Live hype meter: the resource the crowd actually reacts to. Past the gold
  // tick the crowd is in Frenzy and the bar burns hot.
  hypeFill.style.width = `${Math.min(1, p.hype / CONFIG.show.hypeMax) * 100}%`;
  hypeBar.classList.toggle("frenzy", p.frenzy);
}

const RARITY_TEXT: Record<string, string> = {
  common: "#b9b2a4", magic: "#8fb0d9", rare: "#f2c14e", epic: "#b08fd9",
};

// Drawn UI icons (game-icons.net, /icons/ui/) — the styleguide's third rule:
// icons are drawn, never typed. Sized to the surrounding text via 1em mask.
const uic = (name: string): string =>
  `<i class="uic" style="mask-image:url(/icons/ui/${name}.svg);-webkit-mask-image:url(/icons/ui/${name}.svg)"></i>`;
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const draftTitle = document.getElementById("draft-title")!;
const draftHint = document.getElementById("draft-hint")!;

// Sponsor gifts have no ability icon; a glyph in the plate carries the read.
// (Engraved geometric marks are fine; true emoji are not — STYLEGUIDE.md.)
const coinIcon = `<i class="uic" style="mask-image:url(/icons/items/gold.svg);-webkit-mask-image:url(/icons/items/gold.svg)"></i>`;
const REWARD_GLYPHS: Record<string, string> = {
  healFull: "✚", maxHp: "♥", damage: uic("party"), crit: "✦", armor: "⛨", item: "▣", gold: coinIcon,
  bonusTime: "⌛", materials: "◆", favor: "★", retrain: "↺",
  shrineBlood: "❖", shrineGreed: coinIcon, shrineDecline: "—",
  revision: "☰", revisionDecline: "—",
};

// One modal serves both drafts; sponsor gifts take priority if ever both pend.
// System Shrine bargains ride the same pendingRewards channel — only the
// header changes (the choice cards are already fully data-driven).
function renderDraft(s: GameState): void {
  const lp = me(s);
  if (lp.pendingRewards.length > 0) {
    const shrine = lp.pendingRewards.some((r) => r.kind.startsWith("shrine"));
    const revision = lp.pendingRewards.some((r) => r.kind.startsWith("revision"));
    const quest = lp.pendingRewards.some((r) => r.source === "quest");
    draftEl.classList.remove("levelup");
    draftTitle.textContent = revision ? "☰ CLASS REVISION" : shrine ? "❖ SYSTEM SHRINE"
      : quest ? "⚑ TRIBE BOUNTY" : "◆ SPONSOR DRAFT";
    draftHint.textContent = revision
      ? "The System offers a permanent recasting. Every role has a curse in the fine print. This offer is not repeated."
      : shrine
        ? "The shrine offers a bargain. Every deal has fine print — pick one, or walk."
        : quest
        ? "The settlement pays what it promised. Take one."
        : "Your sponsors reward a good show. Take one gift down — press its number or click.";
    draftCards.innerHTML = lp.pendingRewards
      .map((r, i) => {
        const tint = r.item ? ` style="--oc:${RARITY_TEXT[r.item.rarity]}"` : "";
        const ribbon = r.item ? `<span class="oribbon">${r.item.rarity}</span>` : "";
        return (
          `<div class="reward" data-idx="${i}"${tint}>` +
          `<div class="oicon"><span class="oglyph">${REWARD_GLYPHS[r.kind] ?? "◆"}</span></div>` +
          `<div class="obody">` +
          `<div class="rtitle"><span>${r.title}</span>${ribbon}</div>` +
          `<div class="rdesc">${r.desc}</div>` +
          `</div>` +
          `<kbd class="okey">${i + 1}</kbd>` +
          `</div>`
        );
      })
      .join("");
  } else {
    draftEl.classList.add("levelup");
    draftTitle.textContent = "◆ LEVEL UP";
    draftHint.textContent = "The System offers an evolution. Take one — press its number or click.";
    draftCards.innerHTML = lp.pendingUpgrades
      .map((u, i) => {
        const info = ABILITY_INFO[u.ability];
        const max = UPGRADES.find((n) => n.id === u.id)?.maxRank ?? u.nextRank;
        // Overrank offers extend the pip row past the printed max with stars.
        const pips = Array.from({ length: Math.max(max, u.nextRank) }, (_, r) =>
          r < u.nextRank ? (r >= max ? "⭑" : "●") : "○").join("");
        const icon = `<i style="mask-image:url(/icons/${u.ability}.svg);-webkit-mask-image:url(/icons/${u.ability}.svg)"></i>`;
        return (
          `<div class="reward${info.tier === "ultimate" ? " ult" : ""}${u.overrank ? " over" : ""}" data-idx="${i}">` +
          `<div class="oicon">${icon}<span class="orank">${pips}</span></div>` +
          `<div class="obody">` +
          `<div class="rtitle"><span>${u.title}</span><span class="oribbon">${u.overrank ? "OVERRANK · " : ""}${info.name}</span></div>` +
          `<div class="rdesc">${u.desc}</div>` +
          `</div>` +
          `<kbd class="okey">${i + 1}</kbd>` +
          `</div>`
        );
      })
      .join("");
  }
}

function chooseDraft(idx: number): void {
  const p = me(state);
  const count = p.pendingRewards.length > 0 ? p.pendingRewards.length : p.pendingUpgrades.length;
  if (idx < 0 || idx >= count) return;
  audio.play("buy");
  if (net) {
    net.choose(p.pendingRewards.length > 0 ? "reward" : "upgrade", idx);
  } else {
    if (p.pendingRewards.length > 0) chooseReward(state, p.id, idx);
    else chooseUpgrade(state, p.id, idx);
    flushFeedback(state);
    persistRun(state);
  }
  draftEl.style.display = "none";
  draftChain = true; // mid-claim: any queued draft opens right behind this one
}

draftCards.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest(".reward") as HTMLElement | null;
  if (!card || card.dataset.idx === undefined) return;
  chooseDraft(Number(card.dataset.idx));
});

// Clicking the banked-draft badge claims, same as the key.
draftBadge.addEventListener("click", () => {
  const p = me(state);
  if (p.pendingRewards.length > 0 || p.pendingUpgrades.length > 0) {
    draftChain = true;
    openDraftModal();
  }
});

// Number keys pick an offer while the draft is up. Capture phase + stop so the
// same digit doesn't also cast the skill bound to it underneath the overlay.
window.addEventListener(
  "keydown",
  (e) => {
    if (draftEl.style.display !== "flex") return;
    const d = Number(e.key);
    if (!Number.isInteger(d) || d < 1 || d > 9) return;
    e.stopPropagation();
    chooseDraft(d - 1);
  },
  true,
);

// ---- Inventory panel (pauses the game while open) ----
const invEl = document.getElementById("inv")!;
const invEquipped = document.getElementById("inv-equipped")!;
const invBag = document.getElementById("inv-bag")!;
let invOpen = false;

function itemCard(item: Item, opts: { bag?: boolean; idx?: number } = {}): string {
  const cls = `item rar-${item.rarity}${opts.bag ? " bag" : ""}`;
  const idx = opts.bag ? ` data-idx="${opts.idx}"` : "";
  return (
    `<div class="${cls}"${idx}>` +
    `<div class="name">${item.name}</div>` +
    `<div class="slot">${item.slot} · ${item.rarity}</div>` +
    `<div class="affixes">${affixLines(item).join(" · ") || "—"}</div>` +
    `</div>`
  );
}

function renderInventory(s: GameState): void {
  const p = me(s);
  invEquipped.innerHTML = EQUIP_SLOTS
    .map((slot) => {
      const it = p.equipment[slot];
      return it
        ? itemCard(it)
        : `<div class="item empty rar-common">${slot}: empty</div>`;
    })
    .join("");
  // Bag sorted best-first so upgrades are easy to spot.
  const bag = p.inventory
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => itemScore(b.item) - itemScore(a.item));
  invBag.innerHTML = bag.length
    ? bag.map(({ item, idx }) => itemCard(item, { bag: true, idx })).join("")
    : `<div class="item empty rar-common">Bag is empty</div>`;
}

function toggleInventory(): void {
  invOpen = !invOpen;
  invEl.style.display = invOpen ? "flex" : "none";
  if (invOpen) renderInventory(state);
}

// Delegated click: equip the clicked bag item, persist, and refresh the panel.
invBag.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest(".item.bag") as HTMLElement | null;
  if (!card || card.dataset.idx === undefined) return;
  const idx = Number(card.dataset.idx);
  audio.play("equip");
  if (net) net.equip(idx);
  else {
    equipFromInventory(state, me(state).id, idx);
    persistRun(state);
  }
  renderInventory(state);
});

// ---- Ability tree panel (pauses the game while open) ----
const abilEl = document.getElementById("abil")!;
const abilGrid = document.getElementById("abil-grid")!;
let abilOpen = false;

function whereIs(p: ReturnType<typeof me>, id: AbilityId): string {
  const idx = p.abilities.slots.indexOf(id);
  if (idx >= 0) return `SLOT ${idx + 1}`;
  if (p.abilities.ultimate === id) return "ULTIMATE";
  return "BENCH";
}

/**
 * One upgrade node as a readable row: rank pips, the CURRENT magnitude when
 * taken (next rank previewed in parens), and plain-language lock reasons —
 * clarity over constellation art.
 */
function nodeRowHtml(p: ReturnType<typeof me>, u: (typeof UPGRADES)[number]): string {
  const r = rank(p, u.id);
  const open = nodeOpen(p, u);
  const locked = !open && r === 0;
  // Rank pips as inset gem SOCKETS (STYLEGUIDE Phase 2): filled gems for
  // taken ranks, empty bronze sockets for the rest, a rotated diamond for
  // capstones, and overrank gems burn hot.
  const pips = u.capstone
    ? `<i class="pip cap${r > 0 ? " on" : ""}"></i>`
    : `<i class="pip on"></i>`.repeat(Math.min(r, u.maxRank)) +
      `<i class="pip over"></i>`.repeat(Math.max(0, r - u.maxRank)) +
      `<i class="pip"></i>`.repeat(Math.max(0, u.maxRank - r));
  let effect: string;
  if (locked) {
    const forked = (u.excludes ?? []).filter((id) => rank(p, id) > 0).map((id) => upgradeDef(id)!.title);
    const unmet = (u.requires ?? []).filter((id) => rank(p, id) === 0).map((id) => upgradeDef(id)!.title);
    effect = forked.length > 0
      ? `fork closed — you took ${forked.join(", ")}`
      : `needs ${unmet.join(", ")}`;
  } else if (r > 0) {
    effect = u.desc(r) +
      (r < u.maxRank ? ` <span class="nnext">· next rank: ${u.desc(r + 1)}</span>` : "") +
      (r === u.maxRank && !u.capstone ? ` <span class="nnext">· MAX</span>` : "") +
      (r > u.maxRank ? ` <span class="nover">· OVERRANK +${r - u.maxRank}</span>` : "");
  } else {
    effect = `${u.desc(1)} <span class="nnext">· from level-up drafts</span>`;
  }
  const cls = ["nrow", r > 0 ? "taken" : locked ? "locked" : "untaken", u.capstone ? "capstone" : ""]
    .filter(Boolean).join(" ");
  return (
    `<div class="${cls}">` +
    `<span class="ntitle">${u.title}</span>` +
    `<span class="npips">${pips}</span>` +
    `<span class="neffect">${effect}</span>` +
    `</div>`
  );
}

function abilityCard(s: GameState, id: AbilityId): string {
  const p = me(s);
  const info = ABILITY_INFO[id];
  if (!knows(p, id)) {
    return (
      `<div class="acard unknown">` +
      `<div class="ahead"><div><div class="ahname">???</div>` +
      `<div class="ahblurb">undiscovered ${info.tier} — find a tome (or buy one in the shop)</div></div></div>` +
      `</div>`
    );
  }
  const where = whereIs(p, id);
  const whereCls = where === "BENCH" ? "bench" : where === "ULTIMATE" ? "ultc" : "";
  const rows = UPGRADES.filter((u) => u.ability === id).map((u) => nodeRowHtml(p, u)).join("");
  // Slot controls are a SAFE-ROOM decision (the sim enforces it; we just hide
  // the buttons elsewhere). Actives get slot 1-4 + bench; ultimates get U.
  let controls = "";
  if (s.safeRoom) {
    if (info.tier === "active") {
      const btns = Array.from({ length: ABILITY_SLOTS }, (_v, i) =>
        `<button class="slot-btn" data-ability="${id}" data-slot="${i}">SLOT ${i + 1}</button>`).join("");
      const benchBtn = where !== "BENCH"
        ? `<button class="slot-btn" data-ability="${id}" data-slot="bench">BENCH</button>` : "";
      controls = `<div class="slot-controls">${btns}${benchBtn}</div>`;
    } else {
      const ultBtn = p.abilities.ultimate === id
        ? `<button class="slot-btn" data-ability="${id}" data-slot="unult">BENCH</button>`
        : `<button class="slot-btn" data-ability="${id}" data-slot="ult">SLOT AS ULT</button>`;
      controls = `<div class="slot-controls">${ultBtn}</div>`;
    }
  }
  return (
    `<div class="acard${info.tier === "ultimate" ? " ult" : ""}">` +
    `<div class="ahead">` +
    `<i class="ii" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>` +
    `<div><div class="ahname">${info.name}</div><div class="ahblurb">${info.blurb} · ${info.tier}</div></div>` +
    `<span class="awhere ${whereCls}">${where}</span>` +
    `</div>` +
    (rows ? `<div class="nrows">${rows}</div>` : "") +
    controls +
    `</div>`
  );
}

// Slotting clicks (sim validates; net mode forwards to the server). Shared by
// the T panel and the safe room's ABILITIES tab.
function handleSlotClick(e: Event, rerender: (s: GameState) => void): void {
  const btn = (e.target as HTMLElement).closest(".slot-btn") as HTMLElement | null;
  if (!btn) return;
  const ability = btn.dataset.ability as AbilityId;
  const slot = btn.dataset.slot!;
  const p = me(state);
  if (net) {
    net.slot(slot, ability);
  } else {
    if (slot === "ult") setUltimate(state, p.id, ability);
    else if (slot === "unult") setUltimate(state, p.id, null);
    else if (slot === "bench") {
      const idx = p.abilities.slots.indexOf(ability);
      if (idx >= 0) slotAbility(state, p.id, idx, null);
    } else slotAbility(state, p.id, Number(slot), ability);
    flushFeedback(state);
    persistRun(state);
  }
  rerender(state);
}

document.getElementById("abil-grid")!.addEventListener("click", (e) => handleSlotClick(e, renderAbilities));

const achGrid = document.getElementById("ach-grid")!;
const achCount = document.getElementById("ach-count")!;
const statsRows = document.getElementById("stats-rows")!;

function renderAbilities(s: GameState): void {
  const all = [...STARTING_ABILITIES, ...DISCOVERABLE_ABILITIES];
  abilGrid.innerHTML = all.map((id) => abilityCard(s, id)).join("");
  document.getElementById("ach-section")!.style.display =
    CONFIG.achievementsEnabled ? "" : "none";
  achCount.textContent = `${me(s).achievements.length} / ${ACHIEVEMENTS.length}`;
  achGrid.innerHTML = ACHIEVEMENTS.map((a) => {
    const got = me(s).achievements.includes(a.id);
    return (
      `<div class="ach${got ? "" : " locked"}">` +
      `<div class="atitle">${got ? "★ " : "☆ "}${a.title}</div>` +
      `<div class="adesc">${a.desc}</div>` +
      `</div>`
    );
  }).join("");
  // Run stats: one row per party member (solo runs show just the local player).
  const localId = me(s).id;
  statsRows.innerHTML = s.players.map((p) => {
    const you = p.id === localId;
    return (
      `<tr class="${[you ? "you" : "", p.alive ? "" : "dead"].filter(Boolean).join(" ")}">` +
      `<td>${p.name}${you ? " (you)" : ""}</td>` +
      `<td>${p.level}</td>` +
      `<td>${p.kills}</td>` +
      `<td>${Math.round(p.damageDealt).toLocaleString()}</td>` +
      `<td>${Math.round(p.damageTaken).toLocaleString()}</td>` +
      `<td>${Math.round(p.viewers).toLocaleString()}</td>` +
      `<td>${p.sponsors}</td>` +
      `</tr>`
    );
  }).join("");
}

function toggleAbilities(): void {
  abilOpen = !abilOpen;
  abilEl.style.display = abilOpen ? "flex" : "none";
  if (abilOpen) renderAbilities(state);
}

// ---- Crawler Profile (pauses the game while open) ----
// The System's personnel file: every number comes from buildCharacterSheet
// (sim/sheet.ts), which derives it from the same math combat runs — the panel
// only formats. Icons: /icons/stats/* (game-icons.net, CSS-mask tinted).
const sheetEl = document.getElementById("sheet")!;
const sheetSub = document.getElementById("sheet-sub")!;
const sheetGear = document.getElementById("sheet-gear")!;
const sheetAttrs = document.getElementById("sheet-attrs")!;
const sheetProgress = document.getElementById("sheet-progress")!;
const sheetDice = document.getElementById("sheet-dice")!;
const sheetDmg = document.getElementById("sheet-dmg")!;
const sheetDef = document.getElementById("sheet-def")!;
const sheetShow = document.getElementById("sheet-show")!;
let sheetOpen = false;

const statIcon = (id: string): string =>
  `mask-image:url(/icons/stats/${id}.svg);-webkit-mask-image:url(/icons/stats/${id}.svg)`;
const abilIcon = (id: string): string =>
  `mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)`;

function gearRowHtml(slot: ItemSlot, it: Item | null): string {
  if (!it) return `<div class="gear-row none rar-common">no ${slot} equipped</div>`;
  const noun = it.name.split(" ").pop()!.toLowerCase();
  const icon = it.catalogId
    ? iconStyle(it.catalogId)
    : `mask-image:url(/icons/nouns/${noun}.svg);-webkit-mask-image:url(/icons/nouns/${noun}.svg)`;
  const tc = it.catalogId ? TIER_COLOR[CATALOG_BY_ID[it.catalogId].tier] : RARITY_TEXT[it.rarity];
  return (
    `<div class="gear-row rar-${it.rarity}">` +
    `<div class="gbox" style="--tc:${tc}"><i class="ii" style="${icon}"></i></div>` +
    `<div><div class="gname" style="color:${tc}">${it.name}</div>` +
    `<div class="gaff">${affixLines(it).join(" · ") || "—"}</div></div>` +
    `<div class="gslot">${slot}</div>` +
    `</div>`
  );
}

function damageRowHtml(row: SheetAbilityRow, critChance: number): string {
  const school = `<span class="school ${row.school === "magic" ? "mag" : "phys"}">${row.school === "magic" ? "MAG" : "PHYS"}</span>`;
  const head =
    `<div class="dic"><i style="${abilIcon(row.id)}"></i></div>` +
    `<div><div class="dnm">${row.name} ${school}</div><div class="dmech">${row.note}</div></div>`;
  if (!row.hit) return `<div class="drow utility${row.ultimate ? " ult" : ""}">${head}</div>`;
  const h = row.hit;
  const critTip = `crit (${Math.round(critChance * 100)}% chance): ${h.critMin}–${h.critMax}`;
  const dpsTip = `sustained: avg roll${h.count > 1 ? ` × ${h.count}` : ""} × crit factor ÷ cooldown`;
  return (
    `<div class="drow${row.ultimate ? " ult" : ""}">` + head +
    `<div class="drange" title="${critTip}"><b>${h.min}–${h.max}</b><small>PER HIT${h.count > 1 ? ` ×${h.count}` : ""}</small></div>` +
    `<div class="dcd">${h.cooldown.toFixed(1)}s<small>CD</small></div>` +
    `<div class="ddps" title="${dpsTip}"><b>≈${Math.round(h.dps)}</b><small>DPS</small></div>` +
    `</div>`
  );
}

function renderSheet(s: GameState): void {
  const p = me(s);
  const sh = buildCharacterSheet(s, p);
  const id = sh.identity;
  const a = sh.attributes;
  const d = sh.defense;
  sheetSub.textContent = `${id.name} · LEVEL ${id.level} · FLOOR ${id.floor}` +
    (id.revisions.length > 0 ? ` · RECAST: ${id.revisions.join(", ")}` : "");
  sheetGear.innerHTML = EQUIP_SLOTS
    .map((slot) => gearRowHtml(slot, p.equipment[slot])).join("");
  const tiles: [string, string, string, string, string][] = [
    ["attack", "#d98e4a", String(a.attackPower), "ATTACK PWR",
      "Physical school: melee, orbit blades, airstrike — and what most weapons throw as bolts."],
    ["spell", "#9a6bd0", String(a.spellPower), "SPELL PWR",
      "Magic school: nova, dash detonations, cataclysm — wands and staffs cast bolts off this."],
    ["crit", "#f2c14e", `${Math.round(a.critChance * 100)}%`, "CRIT",
      `Every hit has this chance to land at ×${a.critMult}.`],
    ["speed", "#7ba3d6", a.speed.toFixed(2), "SPEED", "Movement, in tiles per second."],
    ["armor", "#b9b2a4", String(a.armor), "ARMOR",
      `Every incoming hit is reduced by armor÷(armor+${d.armorK}) — currently ${Math.round(d.reduction * 100)}%, hard-capped at ${Math.round(d.reductionCap * 100)}%.`],
    ["hp", "#d14538", `${Math.ceil(a.hp)}/${a.maxHp}`, "LIFE", "Current / maximum HP."],
  ];
  // PoE-style ledger (STYLEGUIDE Phase 2): small-caps label, dotted leader,
  // tabular value — the icon keeps the scan, ink carries the data.
  sheetAttrs.innerHTML =
    `<table class="ledger">` +
    tiles.map(([ic, c, v, l, tip]) =>
      `<tr title="${tip}">` +
      `<td class="lic"><i class="si" style="${statIcon(ic)};background:${c}"></i></td>` +
      `<td class="lab">${l}</td><td class="dots"></td>` +
      `<td class="val">${v}</td></tr>`).join("") +
    `</table>`;
  sheetProgress.innerHTML =
    `<b>${coinIcon} ${id.gold}</b> gold · XP ${id.xp}/${id.xpToNext} to level ${id.level + 1}` +
    `<div class="bar"><i style="width:${Math.min(100, (id.xp / id.xpToNext) * 100)}%"></i></div>`;
  sheetDice.textContent =
    `${id.weaponName}${id.weaponClass ? ` (${id.weaponClass})` : ""} — every hit rolls ±${Math.round(id.variance * 100)}%`;
  sheetDmg.innerHTML = sh.offense.length
    ? sh.offense.map((row) => damageRowHtml(row, a.critChance)).join("")
    : `<div class="drow utility"><div class="dmech">nothing slotted</div></div>`;
  const redPct = Math.round(d.reduction * 100);
  sheetDef.innerHTML =
    `<div class="def-box">` +
    `<div class="dbig" title="armor ÷ (armor + ${d.armorK}), capped at ${Math.round(d.reductionCap * 100)}%"><b>${d.armor}</b><small>ARMOR · ${redPct}% REDUCTION</small></div>` +
    `<div><div class="def-meter"><i style="width:${Math.min(100, (d.reduction / d.reductionCap) * 100)}%"></i><span class="cap" style="left:100%"></span></div>` +
    `<div class="def-lines" style="margin-top:7px">Effective HP ≈ <b>${d.effectiveHp}</b> · dash i-frames ×${d.dashCharges}<br>` +
    `<span class="ex">A typical floor-${id.floor} hit: <b>${d.exampleRaw}</b> raw → <b>${d.exampleTaken}</b> taken</span></div></div>` +
    `</div>`;
  sheetShow.innerHTML =
    `<span class="show-chip viewers"><b>${sh.show.viewers.toLocaleString()}</b>viewers</span>` +
    `<span class="show-chip favorites"><b>${sh.show.favorites.toLocaleString()}</b>favorites</span>` +
    `<span class="show-chip sponsors"><b>${sh.show.sponsors}</b>sponsors</span>` +
    `<span class="show-chip"><b>${sh.show.kills}</b>kills</span>` +
    `<span class="show-chip"><b>${sh.show.damageDealt.toLocaleString()}</b>dmg dealt</span>` +
    `<span class="show-chip"><b>${sh.show.damageTaken.toLocaleString()}</b>dmg taken</span>`;
}

function toggleSheet(): void {
  sheetOpen = !sheetOpen;
  sheetEl.style.display = sheetOpen ? "flex" : "none";
  if (sheetOpen) renderSheet(state);
}

// ---- Key bindings (rebindable; persisted per browser) ----
let bindings: Bindings = loadBindings();
const keysEl = document.getElementById("keys")!;
const kbRows = document.getElementById("kb-rows")!;
let kbOpen = false;
let listening: BindableAction | null = null;

function applyBindings(): void {
  input.setBindings(bindings);
  const first = (a: BindableAction) => bindingLabel(bindings, a).split(" / ")[0];
  // The two top-bar menus render from the live bindings so rebinds refresh
  // their key hints (the skill bar renders per-frame in updateSkills; full
  // movement/combat reference lives in the K panel).
  const row = (act: BindableAction, label: string) =>
    `<div class="tm-row" data-act="${act}"><span>${label}</span><kbd>${esc(first(act))}</kbd></div>`;
  document.getElementById("tm-system")!.innerHTML =
    row("keybinds", "Key Bindings & Options") +
    row("mute", "Mute / Unmute Sound") +
    (net ? "" : row("newRun", "New Run"));
  document.getElementById("tm-crawler")!.innerHTML =
    row("inventory", "Inventory") +
    row("abilities", "Loadout & Achievements") +
    row("character", "Crawler Profile") +
    row("draft", "Claim Banked Drafts");
  document.getElementById("kb-close-key")!.textContent = first("keybinds");
  document.getElementById("sheet-close-key")!.textContent = first("character");
}

function renderKeybinds(): void {
  kbRows.innerHTML = (Object.keys(ACTION_INFO) as BindableAction[])
    .filter((a) => a !== "flask" || CONFIG.flaskEnabled) // no dead key rows
    .map((a) => {
      const info = ACTION_INFO[a];
      const cls = listening === a ? "kb-key listening" : "kb-key";
      const label = listening === a ? "press a key…" : bindingLabel(bindings, a);
      return (
        `<div class="kb-row"><span class="kb-name">${info.name}` +
        (info.hint ? `<small>${info.hint}</small>` : "") +
        `</span><span class="${cls}" data-action="${a}">${label}</span></div>`
      );
    })
    .concat(gamepadEnabled && gamepad.connected ? [
      `<div class="kb-row kb-pad">Controller — sticks: move / aim · A X B Y: slots 1-4 · ` +
      `RT: ultimate · LB: flask · RB: stairs · LT: ping · Start: inventory · ` +
      `Back: profile · D-pad: draft / abilities</div>`,
    ] : [])
    .join("");
}

function toggleKeybinds(): void {
  kbOpen = !kbOpen;
  keysEl.style.display = kbOpen ? "flex" : "none";
  listening = null;
  input.captureMode = false;
  if (kbOpen) renderKeybinds();
}

kbRows.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest(".kb-key") as HTMLElement | null;
  if (!el || !el.dataset.action) return;
  listening = el.dataset.action as BindableAction;
  input.captureMode = true; // gameplay keys off while we capture
  renderKeybinds();
});

const kbMouseAim = document.getElementById("kb-mouseaim")!;
function renderMouseAim(): void {
  kbMouseAim.textContent = mouseAim ? "ON" : "OFF";
}
kbMouseAim.addEventListener("click", () => {
  mouseAim = !mouseAim;
  saveMouseAim(mouseAim);
  canvas.style.cursor = mouseAim ? "crosshair" : "default";
  renderMouseAim();
  applyBindings(); // refresh the banner hint
});
renderMouseAim();

// Diablo-style mouse movement (see input/clickMove.ts).
const kbMouseMove = document.getElementById("kb-mousemove")!;
function renderMouseMove(): void {
  kbMouseMove.textContent = mouseClickMove ? "ON" : "OFF";
}
kbMouseMove.addEventListener("click", () => {
  mouseClickMove = !mouseClickMove;
  saveMouseMove(mouseClickMove);
  input.mouseMoveMode = mouseClickMove;
  clickMove.target = null; // no stale autopilot across a mode flip
  renderMouseMove();
  applyBindings(); // refresh the banner hint
});
renderMouseMove();

// System-chatter verbosity: cycles the toast filter (see TICKER_KINDS).
const NOTIFY_CYCLE: NotifyLevel[] = ["normal", "critical", "all"];
const kbNotify = document.getElementById("kb-notify")!;
function renderNotify(): void {
  kbNotify.textContent = notifyLevel.toUpperCase();
}
kbNotify.addEventListener("click", () => {
  notifyLevel = NOTIFY_CYCLE[(NOTIFY_CYCLE.indexOf(notifyLevel) + 1) % NOTIFY_CYCLE.length];
  saveNotify(notifyLevel);
  renderNotify();
});
renderNotify();

// Controller on/off (see GamepadController). Toggling ON with a pad already
// plugged in adopts it on the next frame's poll — no reconnect needed.
const kbGamepad = document.getElementById("kb-gamepad")!;
function renderGamepadToggle(): void {
  kbGamepad.textContent = gamepadEnabled ? "ON" : "OFF";
}
kbGamepad.addEventListener("click", () => {
  gamepadEnabled = !gamepadEnabled;
  saveGamepad(gamepadEnabled);
  renderGamepadToggle();
  renderKeybinds(); // legend row appears/disappears with the toggle
});
renderGamepadToggle();

// Touch controls: AUTO (coarse-pointer devices) -> ON -> OFF. Applies live.
const TOUCH_CYCLE: TouchPref[] = ["auto", "on", "off"];
const kbTouch = document.getElementById("kb-touch")!;
function renderTouchToggle(): void {
  kbTouch.textContent = touchPref.toUpperCase();
}
kbTouch.addEventListener("click", () => {
  touchPref = TOUCH_CYCLE[(TOUCH_CYCLE.indexOf(touchPref) + 1) % TOUCH_CYCLE.length];
  saveTouch(touchPref);
  applyTouchMode();
  renderTouchToggle();
});
renderTouchToggle();

document.getElementById("kb-reset")!.addEventListener("click", () => {
  bindings = { ...DEFAULT_BINDINGS };
  saveBindings(bindings);
  applyBindings();
  renderKeybinds();
});

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (listening) {
    e.preventDefault();
    if (k !== "escape") {
      bindings = rebind(bindings, listening, k);
      saveBindings(bindings);
      applyBindings();
    }
    listening = null;
    input.captureMode = false;
    renderKeybinds();
    return;
  }
  if (k === "escape") {
    if (topBars.some((tb) => tb.classList.contains("open"))) closeTopMenus();
    else if (draftEl.style.display === "flex") dismissDraftModal(); // picks bank behind the badge
    else if (invOpen) toggleInventory();
    else if (abilOpen) toggleAbilities();
    else if (sheetOpen) toggleSheet();
    else if (kbOpen) toggleKeybinds();
  }
});

// One dispatcher for panel/utility actions — keyboard binds, controller
// buttons, and the top-bar menus all land here.
function fireAction(a: BindableAction): void {
  if (a === "inventory") toggleInventory();
  else if (a === "abilities") toggleAbilities();
  else if (a === "character") toggleSheet();
  else if (a === "keybinds") toggleKeybinds();
  else if (a === "draft") {
    if (draftEl.style.display === "flex") dismissDraftModal(); // toggle off = dismiss
    else if (me(state).pendingRewards.length > 0 || me(state).pendingUpgrades.length > 0) {
      draftChain = true;
      openDraftModal();
    }
  }
  else if (a === "mute") pushLogLine(`Sound ${audio.toggleMute() ? "muted" : "on"}.`);
  else if (a === "newRun") input.onReset?.();
}
input.onAction = fireAction;
// Controller panel buttons route through the same handler; captureMode (menu
// name field, key rebinding) gates them exactly like keyboard binds.
gamepad.onAction = (a) => {
  if (!input.captureMode) fireAction(a);
};

// The two top-bar menus (SYSTEM / CRAWLER). One open at a time; any click
// outside, an action, or Esc closes.
const topBars = [...document.querySelectorAll<HTMLElement>("#banner .tb")];
function closeTopMenus(): void {
  for (const tb of topBars) tb.classList.remove("open");
}
for (const tb of topBars) {
  tb.querySelector(".topbtn")!.addEventListener("click", () => {
    const was = tb.classList.contains("open");
    closeTopMenus();
    if (!was) tb.classList.add("open");
  });
  tb.querySelector(".topmenu")!.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".tm-row");
    if (!r?.dataset.act) return;
    closeTopMenus();
    fireAction(r.dataset.act as BindableAction);
  });
}
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("#banner")) closeTopMenus();
});
applyBindings();

// ---- The System Shop (safe room between floors; pauses the sim until DESCEND) ----
// One hybrid shop/crafting UI (LoL-style): a tier-sectioned shelf of icon
// tiles, a detail pane with the build tree (BUILDS FROM / BUILDS INTO), and
// the bag for selling. IN STOCK shows today's seeded shelf; ALL ITEMS is the
// full-catalog build planner (locked tiles show what future shops can carry).
const srEl = document.getElementById("saferoom")!;
const srTip = document.getElementById("sr-tip")!;
const srWallet = document.getElementById("sr-wallet")!;
const srShelf = document.getElementById("sr-shelf")!;
const srDetail = document.getElementById("sr-detail")!;
const srEquipped = document.getElementById("sr-equipped")!;
const srBag = document.getElementById("sr-bag")!;
const srReady = document.getElementById("sr-ready")!;
const srDescend = document.getElementById("sr-descend")!;
const srTabStock = document.getElementById("sr-tab-stock")!;
const srTabAll = document.getElementById("sr-tab-all")!;
// Top-level safe-room tabs: SYSTEM SHOP / ABILITIES / ACHIEVEMENTS.
const srTabShop = document.getElementById("sr-tab-shop")!;
const srTabAbil = document.getElementById("sr-tab-abil")!;
const srTabAch = document.getElementById("sr-tab-ach")!;
const srPageShop = document.getElementById("sr-page-shop")!;
const srPageAbil = document.getElementById("sr-page-abil")!;
const srPageAch = document.getElementById("sr-page-ach")!;
const srLoadout = document.getElementById("sr-loadout")!;
const srAbil = document.getElementById("sr-abil")!;
const srAch = document.getElementById("sr-ach")!;
const srAchCount = document.getElementById("sr-ach-count")!;
let srTab: "shop" | "abil" | "ach" = "shop";

const TIERS: CatalogTier[] = ["consumable", "starter", "basic", "advanced", "legendary"];
const TIER_COLOR: Record<CatalogTier, string> = {
  consumable: "#a99f8c", starter: "#b9b2a4", basic: "#8fb0d9", advanced: "#f2c14e", legendary: "#b08fd9",
};
const TIER_LABEL: Record<CatalogTier, string> = {
  consumable: "CONSUMABLES", starter: "STARTER", basic: "BASIC", advanced: "ADVANCED", legendary: "LEGENDARY",
};

let shopView: "stock" | "all" = "stock";
type ShopSel =
  | { kind: "catalog"; id: string }
  | { kind: "bag"; idx: number }
  | { kind: "equipped"; slot: ItemSlot };
let shopSel: ShopSel | null = null;

// Icons by convention: /icons/items/<catalogId>.svg (game-icons.net, CSS-mask tinted).
const iconStyle = (id: string): string =>
  `mask-image:url(/icons/items/${id}.svg);-webkit-mask-image:url(/icons/items/${id}.svg)`;
const coin = `<i class="micon" style="${iconStyle("gold")}"></i>`;
const matIcon = (id: string): string => `<i class="micon" style="${iconStyle(id)}"></i>`;

/** How many of each catalog id the player owns (bag + equipped) — component dots. */
function ownedCatalogCounts(p: Player): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (it: Item | null) => {
    if (it?.catalogId) counts[it.catalogId] = (counts[it.catalogId] ?? 0) + 1;
  };
  p.inventory.forEach((it) => add(it));
  for (const slot of EQUIP_SLOTS) add(p.equipment[slot]);
  return counts;
}

/** Why this entry can't be bought right now, or null if it can. */
function buyBlocker(s: GameState, e: CatalogEntry): string | null {
  const room = s.safeRoom!;
  const p = me(s);
  if (!room.available.includes(e.id)) {
    const unlock = TIER_UNLOCK_SHOP[e.tier];
    return room.nextFloor - 1 < unlock ? `ARRIVES AT SHOP ${unlock}` : "NOT STOCKED TODAY";
  }
  if (e.tier === "consumable" && (room.purchased[e.id] ?? 0) >= consumableStock(e)) return "SOLD OUT";
  if (e.effect === "tome" && (!room.tomeAbility || knows(p, room.tomeAbility))) return "ALREADY MASTERED";
  // Built gear needs its components IN HAND (the BUILDS FROM row shows which).
  if (e.buildsFrom?.length && missingComponents(p, e.id).length > 0) return "NEEDS COMPONENTS";
  if ((e.sponsors ?? 0) > p.sponsors) return `NEEDS ${e.sponsors} SPONSOR${(e.sponsors ?? 0) > 1 ? "S" : ""}`;
  for (const [m, n] of Object.entries(e.materials ?? {})) {
    if (p.materials[m as keyof Player["materials"]] < (n ?? 0)) return "NEEDS MATERIALS";
  }
  if (effectivePrice(p, e.id, room.nextFloor) > p.gold) return "NOT ENOUGH GOLD";
  return null;
}

function shelfTileHtml(s: GameState, e: CatalogEntry, owned: Record<string, number>): string {
  const room = s.safeRoom!;
  const p = me(s);
  const locked = !room.available.includes(e.id);
  const price = effectivePrice(p, e.id, room.nextFloor);
  // Consumable scarcity: show remaining per-shop stock; dim + ✕ when sold out.
  const stock = consumableStock(e);
  const left = Number.isFinite(stock) ? stock - (room.purchased[e.id] ?? 0) : Infinity;
  const soldOut = left <= 0;
  const cls = [
    "itile",
    shopSel?.kind === "catalog" && shopSel.id === e.id ? "sel" : "",
    locked ? "locked" : "",
    soldOut ? "soldout" : "",
    !locked && !soldOut && price > p.gold ? "broke" : "",
    (owned[e.id] ?? 0) > 0 ? "owned" : "",
  ].filter(Boolean).join(" ");
  const stockBadge = Number.isFinite(left) && !soldOut && !locked
    ? `<div class="istock" title="${left} left in stock this shop">×${left}</div>` : "";
  return (
    `<div class="${cls}" data-id="${e.id}" style="--tc:${TIER_COLOR[e.tier]}" title="${e.name}">` +
    `<div class="ibox"><i class="ii" style="${iconStyle(e.id)}"></i>${stockBadge}</div>` +
    `<div class="iprice">${soldOut ? "SOLD OUT" : `${coin}${price}`}</div>` +
    `</div>`
  );
}

/** Small icon tile for build-tree rows and the bag (no price line). */
function miniTileHtml(e: CatalogEntry, extraCls = "", data = ""): string {
  return (
    `<div class="itile ${extraCls}" ${data} style="--tc:${TIER_COLOR[e.tier]}" title="${e.name}">` +
    `<div class="ibox"><i class="ii" style="${iconStyle(e.id)}"></i></div>` +
    `</div>`
  );
}

/** Bag/equipped tile: catalog gear shows its catalog icon; field drops show
 * their NOUN's icon (every generated-item noun has one at /icons/nouns/),
 * tinted by rarity via the tile's --tc mask color. */
function invTileHtml(it: Item, data: string, selected: boolean): string {
  const noun = it.name.split(" ").pop()!.toLowerCase();
  const inner = it.catalogId
    ? `<i class="ii" style="${iconStyle(it.catalogId)}"></i>`
    : `<i class="ii" style="mask-image:url(/icons/nouns/${noun}.svg);-webkit-mask-image:url(/icons/nouns/${noun}.svg)"></i>`;
  const tc = it.catalogId ? TIER_COLOR[CATALOG_BY_ID[it.catalogId].tier] : RARITY_TEXT[it.rarity];
  return (
    `<div class="itile${selected ? " sel" : ""}" ${data} style="--tc:${tc}" title="${it.name}">` +
    `<div class="ibox">${inner}</div>` +
    `</div>`
  );
}

function statLines(it: Pick<Item, "affixes">): string {
  return affixLines(it as Item).join(" · ");
}

function renderShopDetail(s: GameState): void {
  const room = s.safeRoom!;
  const p = me(s);
  if (!shopSel) {
    srDetail.innerHTML = `<div class="dempty">Select an item. Components you own are credited toward anything they build into.</div>`;
    return;
  }
  if (shopSel.kind === "catalog") {
    const e = CATALOG_BY_ID[shopSel.id];
    if (!e) { srDetail.innerHTML = ""; return; }
    let html =
      `<div class="dname" style="--tc:${TIER_COLOR[e.tier]}">${e.name}</div>` +
      `<div class="dkind">${TIER_LABEL[e.tier]}${e.slot ? ` · ${e.slot.toUpperCase()}` : ""}</div>`;
    if (e.tier === "consumable") {
      if (e.effect === "tome") {
        const ab = room.tomeAbility;
        html += ab
          ? `<div class="dstats">Today's print: <b>${ABILITY_INFO[ab].name}</b> — ${ABILITY_INFO[ab].blurb}</div>`
          : `<div class="dstats">Out of print — the party knows everything.</div>`;
      } else if (e.effect === "maxHp") {
        html += `<div class="dstats">+${12 + room.nextFloor * 2} max HP, permanent.</div>`;
      }
      html += `<div class="ddesc">${e.desc}</div>`;
    } else {
      html += `<div class="dstats">${statLines({ affixes: gearAffixes(e, room.nextFloor) })}</div>`;
      if (e.passive) html += `<div class="dpassive">${e.desc}</div>`;
      else html += `<div class="ddesc">${e.desc}</div>`;
    }
    // Build tree: what it's made of (with owned ✓s), and what it feeds.
    if (e.buildsFrom?.length) {
      const have = { ...ownedCatalogCounts(p) };
      const tiles = e.buildsFrom.map((cid) => {
        const c = CATALOG_BY_ID[cid];
        const got = (have[cid] ?? 0) > 0;
        if (got) have[cid]!--;
        return miniTileHtml(c, got ? "have" : "", `data-id="${cid}"`);
      }).join("");
      html += `<div class="dsec">BUILDS FROM</div><div class="dtree">${tiles}</div>`;
    }
    const into = e.slot ? buildsInto(e.id) : [];
    if (into.length) {
      html += `<div class="dsec">BUILDS INTO</div><div class="dtree">${
        into.map((t) => miniTileHtml(t, "", `data-id="${t.id}"`)).join("")}</div>`;
    }
    // Requirements (sponsor backing + the material hunt).
    if (e.sponsors || e.materials) {
      html += `<div class="dsec">REQUIRES</div>`;
      if (e.sponsors) {
        html += `<div class="dreq ${p.sponsors >= e.sponsors ? "met" : "unmet"}">${e.sponsors} sponsor${e.sponsors > 1 ? "s" : ""} (you: ${p.sponsors})</div>`;
      }
      for (const [m, n] of Object.entries(e.materials ?? {})) {
        const has = p.materials[m as keyof Player["materials"]];
        html += `<div class="dreq ${has >= (n ?? 0) ? "met" : "unmet"}">${matIcon(m)} ${n}× ${m.replace("_", " ")} (you: ${has})</div>`;
      }
    }
    // Price: full price struck through when owned components discount it.
    const full = e.tier === "consumable" ? consumablePrice(e, room.nextFloor) : totalCost(e.id);
    const eff = effectivePrice(p, e.id, room.nextFloor);
    html += `<div class="dprice">${eff < full ? `<span class="full">${full}</span>` : ""}<span class="eff">${coin}${eff}</span></div>`;
    const blocker = buyBlocker(s, e);
    html += `<div class="dbtns"><button data-buy="${e.id}" ${blocker ? "disabled" : ""}>${blocker ?? "BUY"}</button></div>`;
    srDetail.innerHTML = html;
    return;
  }
  // Bag / equipped item detail.
  const it = shopSel.kind === "bag" ? p.inventory[shopSel.idx] : p.equipment[shopSel.slot];
  if (!it) { shopSel = null; renderShopDetail(s); return; }
  const tc = it.catalogId ? TIER_COLOR[CATALOG_BY_ID[it.catalogId].tier] : RARITY_TEXT[it.rarity];
  let html =
    `<div class="dname" style="--tc:${tc}">${it.name}</div>` +
    `<div class="dkind">${it.rarity.toUpperCase()} · ${it.slot.toUpperCase()}` +
    `${weaponClassOf(it) ? ` · ${weaponClassOf(it)!.toUpperCase()}` : ""}` +
    `${shopSel.kind === "equipped" ? " · EQUIPPED" : " · BAG"}</div>` +
    `<div class="dstats">${statLines(it)}</div>`;
  if (it.passive) html += `<div class="dpassive">${CATALOG_BY_ID[it.catalogId ?? ""]?.desc ?? ""}</div>`;
  if (!it.catalogId) html += `<div class="ddesc">Field drop — sells flat, never counts as a build component.</div>`;
  if (it.catalogId) {
    const into = buildsInto(it.catalogId);
    if (into.length) {
      html += `<div class="dsec">BUILDS INTO</div><div class="dtree">${
        into.map((t) => miniTileHtml(t, "", `data-id="${t.id}"`)).join("")}</div>`;
    }
  }
  if (shopSel.kind === "bag") {
    html += `<div class="dbtns">` +
      `<button data-equip="${shopSel.idx}">EQUIP</button>` +
      `<button class="sell" data-sell="${shopSel.idx}">SELL +${sellValue(it)}g</button>` +
      `</div>`;
  }
  srDetail.innerHTML = html;
}

function renderSafeRoom(s: GameState): void {
  const room = s.safeRoom;
  if (!room) return;
  const p = me(s);
  srTip.textContent = room.tip;
  srWallet.innerHTML =
    `<span class="chip">${coin}<b>${p.gold}</b></span>` +
    `<span class="chip">${matIcon("elite_trophy")}<b>${p.materials.elite_trophy}</b></span>` +
    `<span class="chip">${matIcon("boss_sigil")}<b>${p.materials.boss_sigil}</b></span>` +
    `<span class="chip" title="sponsors">🤝 <b>${p.sponsors}</b></span>`;
  srReady.textContent = s.players.length > 1 ? `ready ${room.ready.length}/${s.players.length}` : "";
  // Top-level tab dispatch.
  srTabAch.style.display = CONFIG.achievementsEnabled ? "" : "none";
  if (srTab === "ach" && !CONFIG.achievementsEnabled) srTab = "shop";
  srTabShop.classList.toggle("active", srTab === "shop");
  srTabAbil.classList.toggle("active", srTab === "abil");
  srTabAch.classList.toggle("active", srTab === "ach");
  srPageShop.style.display = srTab === "shop" ? "grid" : "none";
  srPageAbil.style.display = srTab === "abil" ? "" : "none";
  srPageAch.style.display = srTab === "ach" ? "" : "none";
  if (srTab === "shop") renderShopPage(s);
  else if (srTab === "abil") renderAbilPage(s);
  else renderAchPage(s);
}

/** The ABILITIES tab: loadout bar (The Five) + per-ability upgrade cards. */
function renderAbilPage(s: GameState): void {
  const p = me(s);
  const slotTile = (id: AbilityId | null, key: string, ult = false): string => {
    const cls = `lslot${ult ? " ult" : ""}${id ? "" : " empty"}`;
    const icon = id
      ? `<i class="ii" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>`
      : "";
    const name = id ? ABILITY_INFO[id].name : "empty";
    return `<div class="${cls}"><div class="ibox"><span class="lkey">${key}</span>${icon}</div><div class="lname">${name}</div></div>`;
  };
  srLoadout.innerHTML =
    p.abilities.slots.map((id, i) => slotTile(id, String(i + 1))).join("") +
    slotTile(p.abilities.ultimate, "U", true);
  const all = [...STARTING_ABILITIES, ...DISCOVERABLE_ABILITIES];
  srAbil.innerHTML = all.map((id) => abilityCard(s, id)).join("");
}

/** The ACHIEVEMENTS tab: what the System has recognized (and what it hasn't). */
function renderAchPage(s: GameState): void {
  const p = me(s);
  srAchCount.textContent =
    `THE SYSTEM RECOGNIZES — ${p.achievements.length} / ${ACHIEVEMENTS.length} UNLOCKED`;
  srAch.innerHTML = ACHIEVEMENTS.map((a) => {
    const got = p.achievements.includes(a.id);
    return (
      `<div class="sr-ach${got ? "" : " locked"}">` +
      `<div class="atitle">${got ? "★" : "☆"} ${a.title}</div>` +
      `<div class="adesc">${a.desc}</div>` +
      `<div class="areward">${got ? "PAID" : "PAYS"} +${a.gold} gold · +${a.hype} hype</div>` +
      `</div>`
    );
  }).join("");
}

/** The SYSTEM SHOP tab: shelf + detail + bag. */
// Bag density thresholds: item counts at which the bag grid steps down a tile
// size (see .bag-grid.dense/.micro in iso.html), sized so each tier fills its
// rows before the bag would crowd the detail pane out of the side column.
const BAG_DENSE_AT = 19; // 40px tiles hold 3 comfortable rows
const BAG_MICRO_AT = 46; // 32px tiles hold ~6 rows
const BAG_SHOW_MAX = 79; // beyond ~8 micro rows, the tail becomes "+K more"

function renderShopPage(s: GameState): void {
  const room = s.safeRoom;
  if (!room) return;
  const p = me(s);
  srTabStock.classList.toggle("active", shopView === "stock");
  srTabAll.classList.toggle("active", shopView === "all");
  // The shelf, tier by tier.
  const avail = new Set(room.available);
  const owned = ownedCatalogCounts(p);
  const shopIndex = room.nextFloor - 1;
  let shelf = "";
  for (const tier of TIERS) {
    const pool = CATALOG.filter((e) => e.tier === tier && (e.id !== "tome" || room.tomeAbility));
    const entries = shopView === "stock" ? pool.filter((e) => avail.has(e.id)) : pool;
    if (entries.length === 0) continue;
    const unlock = TIER_UNLOCK_SHOP[tier];
    const note = shopIndex < unlock
      ? `<span class="tnote">— unlocks at shop ${unlock}</span>`
      : shopView === "all" && entries.some((e) => !avail.has(e.id))
        ? `<span class="tnote">— stock varies by shop</span>`
        : "";
    shelf +=
      `<div class="tier-h" style="--tc:${TIER_COLOR[tier]}">${TIER_LABEL[tier]}${note}</div>` +
      `<div class="igrid">${entries.map((e) => shelfTileHtml(s, e, owned)).join("")}</div>`;
  }
  srShelf.innerHTML = shelf;
  // Equipped + bag.
  srEquipped.innerHTML = EQUIP_SLOTS.map((slot) => {
    const it = p.equipment[slot];
    if (!it) return `<div class="itile" style="--tc:#2c241b"><div class="ibox"><span class="iglyph" style="color:#2c241b">·</span></div></div>`;
    return invTileHtml(it, `data-slot="${slot}"`, shopSel?.kind === "equipped" && shopSel.slot === slot);
  }).join("");
  // The bag TIGHTENS as it fills so the panel always fits the viewport
  // (house rule: no scrollbars): 40px tiles, then 32px, then 26px; past what
  // even micro tiles can hold, the tail collapses into a "+K more" summary.
  const bagN = p.inventory.length;
  srBag.classList.toggle("dense", bagN >= BAG_DENSE_AT && bagN < BAG_MICRO_AT);
  srBag.classList.toggle("micro", bagN >= BAG_MICRO_AT);
  const hidden = Math.max(0, bagN - BAG_SHOW_MAX);
  srBag.innerHTML = bagN
    ? p.inventory.slice(0, BAG_SHOW_MAX)
        .map((it, i) => invTileHtml(it, `data-bag="${i}"`, shopSel?.kind === "bag" && shopSel.idx === i)).join("") +
      (hidden > 0
        ? `<div class="itile more" title="${hidden} more item${hidden === 1 ? "" : "s"} — sell or equip to thin the bag"><div class="ibox">+${hidden}</div></div>`
        : "")
    : `<span class="bempty">empty — buy components, they wait here</span>`;
  renderShopDetail(s);
}

// Clicks happen while the sim is paused, so announcements produced by the action
// (achievement unlocks, NEW ABILITY) would be cleared unseen by the next step —
// surface them immediately.
function flushFeedback(s: GameState): void {
  for (const a of s.announcements) showAnnouncement(a);
  for (const e of s.events) pushLogLine(e);
  s.announcements = [];
  s.events = [];
}

// Shelf: click a tile to inspect it (locked tiles too — that's the planner).
srShelf.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-id]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "catalog", id: tile.dataset.id! };
  renderSafeRoom(state);
});

// Detail pane: BUY / SELL / EQUIP buttons + build-tree navigation.
srDetail.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const buyBtn = el.closest("button[data-buy]") as HTMLButtonElement | null;
  if (buyBtn && !buyBtn.disabled) {
    const id = buyBtn.dataset.buy!;
    audio.play("buy");
    if (net) net.buy(id);
    else {
      buyCatalogItem(state, me(state).id, id);
      flushFeedback(state);
      persistRun(state);
    }
    renderSafeRoom(state);
    return;
  }
  const sellBtn = el.closest("button[data-sell]") as HTMLButtonElement | null;
  if (sellBtn) {
    const idx = Number(sellBtn.dataset.sell);
    if (net) net.sell(idx);
    else {
      sellItem(state, me(state).id, idx);
      flushFeedback(state);
      persistRun(state);
    }
    shopSel = null;
    renderSafeRoom(state);
    return;
  }
  const equipBtn = el.closest("button[data-equip]") as HTMLButtonElement | null;
  if (equipBtn) {
    const idx = Number(equipBtn.dataset.equip);
    audio.play("equip");
    if (net) net.equip(idx);
    else {
      equipFromInventory(state, me(state).id, idx);
      flushFeedback(state);
      persistRun(state);
    }
    shopSel = null;
    renderSafeRoom(state);
    return;
  }
  const nav = el.closest(".itile[data-id]") as HTMLElement | null;
  if (nav) {
    shopSel = { kind: "catalog", id: nav.dataset.id! };
    renderSafeRoom(state);
  }
});

srEquipped.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-slot]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "equipped", slot: tile.dataset.slot as ItemSlot };
  renderSafeRoom(state);
});

srBag.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-bag]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "bag", idx: Number(tile.dataset.bag) };
  renderSafeRoom(state);
});

// SELL ALL: liquidate the bag in one click (equipped gear is safe by design).
document.getElementById("sr-sellall")!.addEventListener("click", () => {
  if (me(state).inventory.length === 0) return;
  audio.play("buy");
  if (net) net.sellAll();
  else {
    sellAllItems(state, me(state).id);
    flushFeedback(state);
    persistRun(state);
  }
  if (shopSel?.kind === "bag") shopSel = null; // the selected tile just sold
  renderSafeRoom(state);
});

// ---- Item hover tooltip (store bag/equipped tiles are icon-only) ----
const itemTipEl = document.getElementById("itemtip")!;

function itemTipHtml(it: Item): string {
  const tc = it.catalogId ? TIER_COLOR[CATALOG_BY_ID[it.catalogId].tier] : RARITY_TEXT[it.rarity];
  const wclass = weaponClassOf(it);
  const into = it.catalogId ? buildsInto(it.catalogId) : [];
  return (
    `<div class="tname" style="color:${tc}">${it.name}</div>` +
    `<div class="tmeta">${it.rarity} ${it.slot}${wclass ? ` · ${wclass}` : ""}</div>` +
    (affixLines(it).map((l) => `<div class="taff">${l}</div>`).join("") || `<div class="taff">—</div>`) +
    (it.passive && it.catalogId ? `<div class="tpass">${CATALOG_BY_ID[it.catalogId].desc}</div>` : "") +
    (into.length ? `<div class="tbuild">component of: ${into.map((e) => e.name).join(", ")}</div>` : "") +
    `<div class="tsell">sells for ${sellValue(it)} gold</div>`
  );
}

function moveItemTip(e: MouseEvent): void {
  const pad = 14;
  const w = itemTipEl.offsetWidth, h = itemTipEl.offsetHeight;
  itemTipEl.style.left = `${Math.min(e.clientX + pad, window.innerWidth - w - 8)}px`;
  itemTipEl.style.top = `${Math.min(e.clientY + pad, window.innerHeight - h - 8)}px`;
}

/** Resolve the Item under a hovered tile in the shop panel, if any. */
function tipItemFor(el: HTMLElement): Item | null {
  const p = me(state);
  const bagTile = el.closest(".itile[data-bag]") as HTMLElement | null;
  if (bagTile) return p.inventory[Number(bagTile.dataset.bag)] ?? null;
  const slotTile = el.closest(".itile[data-slot]") as HTMLElement | null;
  if (slotTile) return p.equipment[slotTile.dataset.slot as ItemSlot];
  return null;
}

for (const container of [srBag, srEquipped]) {
  container.addEventListener("mouseover", (e) => {
    const it = tipItemFor(e.target as HTMLElement);
    if (!it) { itemTipEl.style.display = "none"; return; }
    itemTipEl.innerHTML = itemTipHtml(it);
    itemTipEl.style.display = "block";
    moveItemTip(e as MouseEvent);
  });
  container.addEventListener("mousemove", (e) => {
    if (itemTipEl.style.display === "block") moveItemTip(e as MouseEvent);
  });
  container.addEventListener("mouseleave", () => { itemTipEl.style.display = "none"; });
}
// The tooltip must never outlive the shop screen.
new MutationObserver(() => {
  if (srEl.style.display === "none") itemTipEl.style.display = "none";
}).observe(srEl, { attributes: true, attributeFilter: ["style"] });
// Touch: taps have no mouseleave — tapping a tile shows the tooltip (via the
// emulated mouseover above); tapping anywhere that isn't an item hides it.
document.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  if (!tipItemFor(e.target as HTMLElement)) itemTipEl.style.display = "none";
});

srTabStock.addEventListener("click", () => { shopView = "stock"; renderSafeRoom(state); });
srTabAll.addEventListener("click", () => { shopView = "all"; renderSafeRoom(state); });
srTabShop.addEventListener("click", () => { srTab = "shop"; renderSafeRoom(state); });
srTabAbil.addEventListener("click", () => { srTab = "abil"; renderSafeRoom(state); });
srTabAch.addEventListener("click", () => { srTab = "ach"; renderSafeRoom(state); });
srAbil.addEventListener("click", (e) => handleSlotClick(e, renderSafeRoom));

srDescend.addEventListener("click", () => {
  if (net) {
    net.ready(); // modal stays until the whole party is ready (snapshot clears it)
    return;
  }
  setReady(state, me(state).id);
  flushFeedback(state);
  persistRun(state);
  srEl.style.display = "none";
});

// The Five: skill bar rendered from the loadout (4 slots + ultimate + bench
// count). Structure rebuilds only when the loadout changes; cooldown fills
// update every frame.
const skillsEl = document.getElementById("skills")!;
const xpFill = document.querySelector("#xpbar > i") as HTMLElement;
let skillBarKey = "";
const CD_BASE: Partial<Record<AbilityId, number>> = {
  melee: CONFIG.playerAttackCooldown, dash: CONFIG.dashCooldown, bolt: CONFIG.boltCooldown,
  nova: CONFIG.novaCooldown, stance: CONFIG.stanceSwapCooldown,
  overcharge: CONFIG.overchargeCooldown,
  airstrike: CONFIG.ultAirstrikeCooldown,
  cataclysm: CONFIG.ultCataclysmCooldown, bullettime: CONFIG.ultBulletTimeCooldown,
};

function updateSkills(s: GameState): void {
  const p = me(s);
  const slotActions = ["slot1", "slot2", "slot3", "slot4", "ultimate"] as const;
  const entries: { ability: AbilityId | null; ult: boolean }[] = [
    ...p.abilities.slots.map((a) => ({ ability: a, ult: false })),
    { ability: p.abilities.ultimate, ult: true },
  ];
  const key = entries.map((e) => e.ability ?? "-").join("|") +
    `|d${p.dashCharges}|f${p.flaskCharges}.${p.flaskKillProgress}|s${p.stance}|o${p.overcharged ? 1 : 0}`;
  if (key !== skillBarKey) {
    skillBarKey = key;
    skillsEl.innerHTML = entries
      .map((e, i) => {
        const bind = bindingLabel(bindings, slotActions[i]).split(" / ")[0];
        const label = e.ability
          ? (e.ability === "dash"
            ? `Dash ×${p.dashCharges}` // charge count in the chip
            : e.ability === "stance"
              ? (p.stance === "melee" ? "Brawler" : "Deadeye") // the chip IS the stance indicator
              : e.ability === "overcharge" && p.overcharged
                ? "CHARGED" // banked and waiting for the next attack
                : ABILITY_INFO[e.ability].name.split(" ").pop())
          : "";
        const cls = `skill${e.ult ? " ult" : ""}${e.ability ? "" : " empty"}`;
        // Icon by convention: /icons/<abilityId>.svg (game-icons.net, tinted via CSS mask).
        const icon = e.ability
          ? `<i class="icon" style="mask-image:url(/icons/${e.ability}.svg);-webkit-mask-image:url(/icons/${e.ability}.svg)"></i>`
          : `<i class="icon"></i>`;
        return `<div class="${cls}" data-i="${i}"><span class="key">${bind}</span>${icon}` +
          `<span class="label">${label}</span><span class="sweep"></span></div>`;
      })
      .join("") +
      // Flask chip (cockpit-style): charge count in the label; the radial
      // sweep shows progress toward the next charge (kills refill it).
      (CONFIG.flaskEnabled
        ? `<div class="skill${p.flaskCharges > 0 ? " ready" : " empty"}" id="flask-chip" ` +
          `style="--cd:${p.flaskCharges >= CONFIG.flaskMaxCharges ? 0 : (1 - p.flaskKillProgress / CONFIG.flaskKillsPerCharge).toFixed(3)}">` +
          `<span class="key">${bindingLabel(bindings, "flask").split(" / ")[0]}</span>` +
          `<i class="icon" style="mask-image:url(/icons/flask.svg);-webkit-mask-image:url(/icons/flask.svg)"></i>` +
          `<span class="label">Slurp ×${p.flaskCharges}</span><span class="sweep"></span>` +
          `</div>`
        : "");
  }
  const chips = skillsEl.querySelectorAll(".skill[data-i]");
  entries.forEach((e, i) => {
    const chip = chips[i] as HTMLElement | undefined;
    if (!chip) return;
    if (!e.ability) return;
    const remaining = p.cd[e.ability] ?? 0;
    const base = CD_BASE[e.ability] ?? 1;
    // Dash runs on charges: cd.dash is only the NEXT charge's refill timer, so
    // the chip reads ready whenever a charge is banked (sweep shows the refill).
    const ready = e.ability === "dash" ? p.dashCharges > 0 : remaining === 0;
    const frac = e.ability === "dash" && p.dashCharges >= CONFIG.dashCharges
      ? 0
      : Math.max(0, Math.min(1, remaining / base));
    chip.style.setProperty("--cd", String(frac));
    chip.classList.toggle("ready", ready);
  });
  // XP strip (health lives in the top-left HUD).
  xpFill.style.width = `${Math.max(0, Math.min(1, p.xp / p.xpToNext)) * 100}%`;
}

// Top-down minimap: explored floor only (fog of war), stairs once seen,
// monsters only while inside the vision radius, and the player (cyan).
function drawMinimap(s: GameState): void {
  const map = s.map;
  const W = minimap.width, H = minimap.height, pad = 6;
  const sx = (W - pad * 2) / map.w, sy = (H - pad * 2) / map.h;
  mmCtx.clearRect(0, 0, W, H);
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const i = y * map.w + x;
      if (!s.explored[i]) continue;
      const t = map.tiles[i];
      if (t === Tile.Wall) continue;
      mmCtx.fillStyle =
        t === Tile.StairsDown ? "#c9a24b" :
        t === Tile.DoorLocked ? "#f2c14e" : "#3a2f24";
      mmCtx.fillRect(pad + x * sx, pad + y * sy, Math.ceil(sx), Math.ceil(sy));
    }
  }
  const vis2 = CONFIG.fogVisionRadius * CONFIG.fogVisionRadius;
  for (const m of s.monsters) {
    const dx = m.pos.x - me(s).pos.x, dy = m.pos.y - me(s).pos.y;
    if (dx * dx + dy * dy > vis2) continue;
    mmCtx.fillStyle = m.kind === "boss" ? "#ff3b3b" : "#c0392f";
    const r = m.kind === "boss" ? 3.5 : 2;
    mmCtx.beginPath();
    mmCtx.arc(pad + m.pos.x * sx, pad + m.pos.y * sy, r, 0, Math.PI * 2);
    mmCtx.fill();
  }
  for (const pl of s.players) {
    if (!pl.alive) {
      // Downed crawler: a hollow red ring — go stand inside it.
      mmCtx.strokeStyle = "#c0392f";
      mmCtx.lineWidth = 1.5;
      mmCtx.beginPath();
      mmCtx.arc(pad + pl.pos.x * sx, pad + pl.pos.y * sy, 4, 0, Math.PI * 2);
      mmCtx.stroke();
      continue;
    }
    mmCtx.fillStyle = pl.id === me(s).id ? "#5a87c6" : "#86b86a";
    mmCtx.beginPath();
    mmCtx.arc(pad + pl.pos.x * sx, pad + pl.pos.y * sy, 3, 0, Math.PI * 2);
    mmCtx.fill();
  }
  // Party pings: gold pulses (they pierce fog — that's the point of a ping).
  for (const pg of s.pings) {
    const cycle = 1 - ((pg.t * 1.6) % 1);
    mmCtx.strokeStyle = "#f2c14e";
    mmCtx.lineWidth = 1.5;
    mmCtx.globalAlpha = 0.9 - cycle * 0.6;
    mmCtx.beginPath();
    mmCtx.arc(pad + pg.pos.x * sx, pad + pg.pos.y * sy, 2 + cycle * 4, 0, Math.PI * 2);
    mmCtx.stroke();
    mmCtx.globalAlpha = 1;
  }
  // Location Scout (chase legendary): the stairs are marked from the moment
  // you arrive — a pulsing gold diamond, fog or no fog.
  if (hasPassive(me(s), "pathfinder")) {
    const cx = pad + s.map.stairs.x * sx, cy = pad + s.map.stairs.y * sy;
    const pulse = 4 + Math.sin(performance.now() / 250) * 1.5;
    mmCtx.strokeStyle = "#ffd700";
    mmCtx.lineWidth = 1.5;
    mmCtx.beginPath();
    mmCtx.moveTo(cx, cy - pulse);
    mmCtx.lineTo(cx + pulse, cy);
    mmCtx.lineTo(cx, cy + pulse);
    mmCtx.lineTo(cx - pulse, cy);
    mmCtx.closePath();
    mmCtx.stroke();
    mmCtx.fillStyle = "#ffd700";
    mmCtx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
  }
}

const HIT_COLORS: Record<HitEvent["kind"], string> = {
  enemy: "#ffb347", crit: "#ffe066", player: "#d14538",
  heal: "#6da356", gold: "#f2c14e", weapon: "#9a6bd0",
  chain: "#aab2bd", // iron links; zero-amount events never become numbers anyway
};

// Floating combat numbers: project a world hit to screen and float it upward.
function spawnDamageNumber(h: HitEvent): void {
  const s = renderer.worldToScreen(h.pos.x, 0.7, h.pos.y);
  if (!s.visible) return;
  const el = document.createElement("div");
  el.className = h.kind === "crit" ? "dmg crit" : "dmg";
  el.style.color = HIT_COLORS[h.kind];
  el.style.left = `${s.x}px`;
  el.style.top = `${s.y}px`;
  const sign = h.kind === "heal" || h.kind === "gold" || h.kind === "weapon" ? "+" : "";
  el.textContent = h.kind === "crit" ? `${h.amount}!` : `${sign}${h.amount}`;
  // School tint (DESIGN 5.8): magic hits read arcane-purple so a mixed build
  // can SEE which school each number came from (physical keeps the defaults).
  if (h.school === "magic" && (h.kind === "enemy" || h.kind === "crit")) {
    el.style.color = h.kind === "crit" ? "#c4a8e8" : "#9a6bd0";
  }
  // Status DoT ticks (5.11): each effect owns a color — burn ember-orange,
  // poison toxin-green — so a DoT build can read its uptime mid-fight.
  if (h.effect === "burn") el.style.color = "#ff7a2f";
  else if (h.effect === "poison") el.style.color = "#7ed957";
  // School resist (armored/warded): the number reads muted so the player
  // learns to swap schools without reading a tooltip.
  if (h.resisted) {
    el.style.color = "#8a8272";
    el.style.opacity = "0.85";
    el.textContent = `${el.textContent} ⛨`;
  }
  fxLayer.appendChild(el);
  // Kick off the float+fade on the next frame so the transition applies.
  requestAnimationFrame(() => {
    const drift = (Math.random() - 0.5) * 40;
    el.style.transform = `translate(calc(-50% + ${drift}px), calc(-50% - 46px))`;
    el.style.opacity = "0";
  });
  setTimeout(() => el.remove(), 850);
}

// DCC "System" announcer, routed by priority + kind (backlog #9). High-priority
// lines get the exclusive center banner; everything else goes to a compact
// toast stack anchored just above the action bar, filtered by the player's
// verbosity setting. Every line is also in the HUD log, so filtering loses
// nothing.
const TOAST_MAX = 3; // visible toasts before the oldest is evicted
const TOAST_HOLD_MS = 3200; // anchored near the action bar — doesn't need as long to catch
const BANNER_HOLD_MS = 3400;

// What each verbosity tier lets through to the toast stack (banners are unaffected).
const TICKER_KINDS: Record<NotifyLevel, readonly AnnouncementKind[]> = {
  all: ["boss", "progress", "levelup", "loot", "achievement", "show", "tip", "flavor"],
  normal: ["boss", "progress", "levelup", "loot", "achievement", "show", "tip"],
  // First-contact tips fire once per crawler EVER — they survive even the
  // terse setting, because a rule you never see explained never gets explained.
  critical: ["boss", "progress", "achievement", "tip"],
};

function showAnnouncement(a: Announcement): void {
  if (a.priority === "high") { showBanner(a); return; }
  if (!TICKER_KINDS[notifyLevel].includes(a.kind)) return; // HUD log still has it
  const el = document.createElement("div");
  el.className = `toast toast-${a.kind}`;
  el.textContent = a.text;
  toastLayer.appendChild(el);
  // Fade the oldest out instead of yanking it instantly — a burst of
  // announcements (kill + loot + level-up) shouldn't cut one off mid-read.
  // `if`, not `while`: each call adds exactly one child, and the evicted
  // element lingers (mid-fade) for 350ms before actually leaving the DOM.
  if (toastLayer.children.length > TOAST_MAX) {
    const oldest = toastLayer.firstElementChild as HTMLElement;
    oldest.classList.remove("show");
    setTimeout(() => oldest.remove(), 350);
  }
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  }, TOAST_HOLD_MS);
}

// Headline moments (boss down, new band, wipe): one at a time, front and center.
// #headline, NOT #banner — that id belongs to the keybinds strip at the top.
const bannerLayer = document.getElementById("headline")!;
const bannerQueue: Announcement[] = [];
let bannerActive = false;

function showBanner(a: Announcement): void {
  if (bannerActive) { bannerQueue.push(a); return; }
  bannerActive = true;
  const el = document.createElement("div");
  el.className = "ann banner";
  el.textContent = a.text;
  bannerLayer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
    bannerActive = false;
    const next = bannerQueue.shift();
    if (next) showBanner(next);
  }, BANNER_HOLD_MS);
}

// ---- Run recap (backlog #12): the season report card ----
// Shown once per status edge: won = SEASON FINALE, wipe = IN MEMORIAM. All the
// data already lives on Player/GameState; this only formats it.
const recapEl = document.getElementById("recap")!;
let recapFor: GameState["status"] | null = null;

function renderRecap(s: GameState): void {
  const p = me(s);
  const won = s.status === "won";
  const title = document.getElementById("recap-title")!;
  if (s.mode === "rivals" && won) {
    // The RACE has exactly one winner — everyone gets the same headline moment,
    // just from very different sides of it.
    const iWon = s.winnerId === p.id;
    const winner = s.rivals?.find((r) => r.id === s.winnerId)?.name
      ?? s.players.find((pl) => pl.id === s.winnerId)?.name ?? "A RIVAL";
    title.textContent = iWon ? "CONTRACT SECURED" : `${winner.toUpperCase()} TOOK THE CONTRACT`;
    title.className = iWon ? "win" : "wipe";
    const standings = [...(s.rivals ?? [])]
      .sort((a, b) => b.floor - a.floor || b.level - a.level)
      .map((r, i) => `${i + 1}. ${r.name} (F${r.floor} · L${r.level})`)
      .join("  ·  ");
    document.getElementById("recap-sub")!.textContent =
      `THE RACE IS OVER · run time ${fmt(s.elapsed)} · ${standings}`;
  } else {
    title.textContent = won ? "YOU ESCAPED THE DUNGEON" : "IN MEMORIAM";
    title.className = won ? "win" : "wipe";
    document.getElementById("recap-sub")!.textContent = won
      ? `SEASON FINALE · all ${CONFIG.finalFloor} floors cleared · run time ${fmt(s.elapsed)} · ${p.name}, Crawler`
      : `Season canceled on floor ${s.floor} · run time ${fmt(s.elapsed)} · the crowd demands a rerun`;
  }
  const stats: [string, string][] = [
    [String(p.level), "LEVEL"],
    [p.kills.toLocaleString(), "KILLS"],
    [Math.round(p.damageDealt).toLocaleString(), "DAMAGE DEALT"],
    [Math.round(p.damageTaken).toLocaleString(), "DAMAGE TAKEN"],
    [`${coinIcon} ${p.gold.toLocaleString()}`, "GOLD BANKED"],
    [`${coinIcon} ${p.goldSpent.toLocaleString()}`, "GOLD SPENT"],
  ];
  document.getElementById("recap-stats")!.innerHTML =
    stats.map(([v, l]) => `<div class="rstat"><b>${v}</b><small>${l}</small></div>`).join("");
  document.getElementById("recap-show")!.innerHTML =
    `<div class="rstat viewers"><b>${Math.round(p.viewers).toLocaleString()}</b><small>VIEWERS</small></div>` +
    `<div class="rstat favorites"><b>${Math.floor(p.favorites).toLocaleString()}</b><small>FAVORITES</small></div>` +
    `<div class="rstat sponsors"><b>${p.sponsors}</b><small>SPONSORS</small></div>`;
  const ach = p.achievements
    .map((id) => ACHIEVEMENTS.find((a) => a.id === id)?.title)
    .filter((t): t is string => !!t);
  document.getElementById("recap-ach")!.textContent = ach.length
    ? `★ ${ach.join(" · ★ ")}`
    : "None recorded. The System pretends not to judge.";
  document.getElementById("recap-gear")!.innerHTML =
    EQUIP_SLOTS.map((slot) => gearRowHtml(slot, p.equipment[slot])).join("");
  const held: { id: AbilityId; ult: boolean }[] = [
    ...p.abilities.slots.filter((a): a is AbilityId => a !== null).map((id) => ({ id, ult: false })),
    ...(p.abilities.ultimate ? [{ id: p.abilities.ultimate, ult: true }] : []),
  ];
  document.getElementById("recap-abils")!.innerHTML = held.length
    ? held.map(({ id, ult }) => {
        const ranks = UPGRADES.filter((u) => u.ability === id).reduce((sum, u) => sum + rank(p, u.id), 0);
        return (
          `<div class="rabil${ult ? " ultimate" : ""}">` +
          `<i class="ii" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>` +
          `${ABILITY_INFO[id].name}${ult ? " · ULTIMATE" : ""}` +
          `<span class="rk">${ranks ? `${ranks} rank${ranks === 1 ? "" : "s"}` : "base"}</span></div>`
        );
      }).join("")
    : `<div class="rabil">bare hands and bad intentions</div>`;
  document.getElementById("recap-note")!.textContent = net
    ? "the server hosts the next season"
    : won ? "season two is contractually obligated" : "";
  document.getElementById("recap-again")!.style.display = net ? "none" : "";
}

/** Show the recap when the run ends; re-arm when a new run starts. */
function maybeShowRecap(s: GameState): void {
  if (s.status === "playing") { recapFor = null; return; }
  if (recapFor === s.status) return;
  recapFor = s.status;
  renderRecap(s);
  recapEl.style.display = "flex";
}

document.getElementById("recap-dismiss")!.addEventListener("click", () => {
  recapEl.style.display = "none"; // spectate the arena; R still restarts
});
document.getElementById("recap-again")!.addEventListener("click", () => {
  recapEl.style.display = "none";
  input.onReset?.();
});

// RIVALS: the downed overlay — your 15 seconds, front and center.
const downedEl = document.getElementById("downed")!;
function updateDowned(s: GameState): void {
  const p = me(s);
  if (s.mode === "rivals" && !p.alive && (p.downedT ?? 0) > 0) {
    downedEl.style.display = "block";
    downedEl.innerHTML =
      `<div class="dtitle">YOU ARE DOWN</div>` +
      `<div class="dcount">${Math.ceil(p.downedT ?? 0)}</div>` +
      `<div class="dsub">back on your feet at the floor entry — the race is still running</div>`;
  } else {
    downedEl.style.display = "none";
  }
}

function phaseColor(s: GameState): string {
  return s.phase === "safe" ? "#6da356" : s.phase === "warning" ? "#f2c14e" : "#c0392f";
}
function fmt(t: number): string {
  const c = Math.max(0, t);
  return `${Math.floor(c / 60)}:${Math.floor(c % 60).toString().padStart(2, "0")}`;
}
// Status pips (5.11): tiny colored chips per active effect. Shared by the
// player HUD (debuff row under the HP bar) and the boss bar.
const STATUS_CHIP: Record<string, { label: string; color: string }> = {
  burn: { label: "BURN", color: "#ff7a2f" },
  poison: { label: "PSN", color: "#7ed957" },
  chill: { label: "CHILL", color: "#7fd4ff" },
};
function statusChips(st: { kind: string; stacks: number; remaining: number }[] | undefined): string {
  if (!st || st.length === 0) return "";
  return st.map((e) => {
    const c = STATUS_CHIP[e.kind] ?? { label: e.kind.toUpperCase(), color: "#b9b2a4" };
    const stacks = e.stacks > 1 ? `×${e.stacks}` : "";
    return `<span style="color:${c.color};border:1px solid ${c.color}55;border-radius:3px;` +
      `padding:0 4px;margin-right:4px;font-size:10px;letter-spacing:1px">` +
      `${c.label}${stacks} ${Math.ceil(e.remaining)}s</span>`;
  }).join("");
}

function updateHud(s: GameState): void {
  const p = me(s);
  const tf = Math.max(0, Math.min(1, s.timeRemaining / s.timeBudget));
  hudTL.innerHTML =
    `Floor ${s.floor} / ${CONFIG.finalFloor}<br>` +
    `<span style="color:${phaseColor(s)}">Collapse ${fmt(s.timeRemaining)} · ${s.phase.toUpperCase()}</span>` +
    `<div class="bar"><i style="width:${tf * 100}%;background:${phaseColor(s)}"></i></div>`;
  const rc = RARITY_COLORS[p.weaponRarity] ?? "#b9b2a4";
  hudTR.innerHTML =
    `Level ${p.level} · ${p.gold} gold · ` +
    `<span style="color:${rc}">ATK ${p.attackPower} · MAG ${p.spellPower} (${p.weaponRarity})</span><br>` +
    `HP ${Math.ceil(p.hp)} / ${p.maxHp}` +
    `<div class="bar"><i style="width:${Math.max(0, (p.hp / p.maxHp) * 100)}%;background:#c0392f"></i></div>` +
    `<div class="bar"><i style="width:${(p.xp / p.xpToNext) * 100}%;background:#5a87c6"></i></div>` +
    // Debuff row (5.11): active statuses read right under the health bar.
    ((p.statuses?.length ?? 0) > 0 ? `<div style="margin-top:3px">${statusChips(p.statuses)}</div>` : "");
  // The feed itself (hudLogFeed) is driven event-by-event via pushLogLine, not
  // re-rendered every frame — only this persistent status blurb gets redrawn.
  let status = "";
  if (s.status === "playing" && !p.alive) {
    status += `<b style="color:#c0392f">DOWNED</b> — ` +
      (p.reviveProgress > 0
        ? `stabilizing… ${Math.round(p.reviveProgress * 100)}%`
        : "a teammate standing close can stabilize you (or you rejoin on descent)");
  }
  if (s.status !== "playing") {
    status +=
      `<b style="color:${s.status === "won" ? "#6da356" : "#c0392f"}">` +
      `${s.status === "won" ? "YOU ESCAPED" : "YOU DIED"} — press R for a new run</b>` +
      `<br>Final show: ${Math.round(p.viewers).toLocaleString()} viewers · ` +
      `${Math.floor(p.favorites).toLocaleString()} favorites · ${p.sponsors} sponsors`;
  }
  hudLogStatus.innerHTML = status;
}

// Optional debug hook (enable with ?debug=1). Exposes live state + renderer so tests
// and manual debugging can stage scenarios; off by default, no effect in normal play.
// defineProperty (configurable) rather than assignment: test mode already defined
// a minimal getter-only __dcc, and assigning over it throws — ?test&debug=1 now
// upgrades to the full hook instead of erroring at load.
if (new URLSearchParams(location.search).has("debug")) {
  Object.defineProperty(window, "__dcc", {
    configurable: true,
    get: () => ({
      state,
      renderer,
      addPlayer: (name: string) => addPlayer(state, name),
      step: (intents: Parameters<typeof step>[1], dt: number) => step(state, intents, dt),
      equip: (item: Item) => equipItem(me(state), item), // stage gear for UI tests
    }),
  });
}

let lastFloor = state.floor;
let lastStatus = state.status;
let saveAcc = 0;
let prev = performance.now();
let acc = 0;
// Kill pop (solo only): a few frames of sim freeze on killing blows while the
// renderer keeps running, so particles fly through the freeze. Purely cosmetic —
// the deterministic sim just receives no steps for ~2-7 frames.
let hitStop = 0;

// Network mode: transient feedback arrives as an event stream, buffered here
// until the frame loop consumes it.
const netHits: HitEvent[] = [];
const netAnns: Announcement[] = [];
let netIntentAcc = 0;
let srRefreshAcc = 0;
const partyChip = document.getElementById("party")!;

/** Sample input and aim it at the mouse (screen -> iso ground -> sim coords). */
/** Drag-aim telegraph shape by ability: dashes arrow, AoEs ring, else a line. */
const TELEGRAPH_RING = new Set<AbilityId>(["nova", "cataclysm", "crowdsurf", "airstrike"]);
function telegraphShape(a: AbilityId | null): "line" | "ring" | "arrow" {
  if (a === "dash") return "arrow";
  if (a && TELEGRAPH_RING.has(a)) return "ring";
  return "line";
}

/** Direction to the nearest living monster in reach — controller quick-cast. */
function autoAimDir(range = 8): Vec2 | null {
  const p = me(state);
  let best: Vec2 | null = null;
  let bestD = range * range;
  for (const m of state.monsters) {
    if (m.hp <= 0) continue;
    const dx = m.pos.x - p.pos.x, dy = m.pos.y - p.pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestD && d > 1e-4) { bestD = d; best = { x: dx, y: dy }; }
  }
  return best;
}

// Controller poll runs at FRAME level, not per sim step: panel buttons must
// keep working while an open panel has the local sim paused, and in net mode
// intents sample at 20Hz while we poll at frame rate. Held state is simply
// the latest poll; press edges ACCUMULATE here until sampleIntent eats them.
let padHeld: ReturnType<GamepadController["poll"]> = null;
const padEdges = { flask: false, stairs: false, ping: false };
function pollPad(): void {
  padHeld = gamepadEnabled ? gamepad.poll(performance.now() / 1000) : null;
  if (padHeld) {
    padEdges.flask ||= padHeld.flaskEdge;
    padEdges.stairs ||= padHeld.stairsEdge;
    padEdges.ping ||= padHeld.pingEdge;
  }
}

// Touch runs the same frame-level rhythm as the pad; one-shot drag casts and
// button taps accumulate here until the next sampleIntent consumes them.
let touchHeld: ReturnType<TouchController["sample"]> = null;
const touchEdges: { casts: { slot: number; aim: { x: number; y: number } | null }[]; flask: boolean; stairs: boolean; ping: Vec2 | null } = {
  casts: [], flask: false, stairs: false, ping: null,
};
function pollTouch(): void {
  touchHeld = touchMode ? touch.sample(performance.now() / 1000) : null;
  if (touchHeld) {
    touchEdges.casts.push(...touchHeld.castEdges);
    touchEdges.flask ||= touchHeld.flaskEdge;
    touchEdges.stairs ||= touchHeld.stairsEdge;
  }
}

function sampleIntent(dt: number): ReturnType<InputController["sample"]> {
  const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const intent = input.sample(center, false);
  // Controller merge: sticks arrive in screen space and take one iso rotation
  // into world axes; buttons OR over keyboard state. Edges behave like keys.
  const pad = padHeld;
  if (pad) {
    if (pad.move) intent.move = isoRotate(pad.move);
    if (intent.cast) for (let i = 0; i < pad.cast.length; i++) if (pad.cast[i]) intent.cast[i] = true;
    if (padEdges.flask) intent.flask = true;
    if (padEdges.stairs) intent.useStairs = true;
    if (padEdges.ping) {
      const p = me(state);
      intent.ping = { x: p.pos.x + p.facing.x, y: p.pos.y + p.facing.y };
    }
    padEdges.flask = padEdges.stairs = padEdges.ping = false;
  }
  // Touch merge: stick moves (same iso rotation), the attack chip holds
  // cast[0], and released taps/drag-casts land as one-shot edges. A drag
  // brings its own aim; a tap leaves aim null for the auto-aim below.
  let touchCastAim = false;
  if (touchHeld) {
    if (touchHeld.move) intent.move = isoRotate(touchHeld.move);
    if (intent.cast) {
      if (touchHeld.castHeld[0]) intent.cast[0] = true;
      for (const c of touchEdges.casts) {
        intent.cast[c.slot] = true;
        if (c.aim) { intent.aim = isoRotate(c.aim); touchCastAim = true; }
      }
    }
    if (touchEdges.flask) intent.flask = true;
    if (touchEdges.stairs) intent.useStairs = true;
    if (touchEdges.ping) intent.ping = touchEdges.ping;
    touchEdges.casts.length = 0;
    touchEdges.flask = touchEdges.stairs = false;
    touchEdges.ping = null;
  }
  // AIM is exclusive: an explicit source (touch drag, pad right stick) wins
  // outright; otherwise the mouse aims only if it was touched more recently
  // than pad/touch (device arbitration — a parked cursor must not pin the
  // aim while someone plays on sticks or glass).
  const padRecent = gamepad.lastInputAt > lastMouseAt;
  const touchRecent = touch.lastInputAt > lastMouseAt;
  if (touchCastAim) {
    // drag-cast aim already applied above
  } else if (pad?.aim) {
    intent.aim = isoRotate(pad.aim);
  } else if (mouseAim && input.mouse && !padRecent && !touchRecent) {
    const g = renderer.screenToGround(input.mouse.x, input.mouse.y);
    if (g) {
      const p = me(state);
      const dx = g.x - p.pos.x, dy = g.y - p.pos.y;
      if (dx * dx + dy * dy > 0.04) intent.aim = { x: dx, y: dy };
    }
  }
  // Quick-cast: casting without an explicit aim on pad/touch snaps to the
  // nearest living monster (Wild Rift-style). Facing still covers whiffs.
  if ((padRecent || touchRecent) && !intent.aim && intent.cast?.some(Boolean)) {
    const snap = autoAimDir();
    if (snap) intent.aim = snap;
  }
  // Ping lands where the cursor points (ground raycast); no cursor, ping ahead.
  if (input.pingEdge) {
    input.pingEdge = false;
    const p = me(state);
    const g = input.mouse ? renderer.screenToGround(input.mouse.x, input.mouse.y) : null;
    intent.ping = g ?? { x: p.pos.x + p.facing.x, y: p.pos.y + p.facing.y };
  }
  // Diablo-style mouse movement (opt-in): LMB on ground walks, LMB on a
  // monster attacks. Pure input interpretation — the intent stays ordinary.
  if (mouseClickMove) {
    const p = me(state);
    const g = input.mouse ? renderer.screenToGround(input.mouse.x, input.mouse.y) : null;
    const hover = !!g && state.monsters.some(
      (m) => m.hp > 0 && (m.pos.x - g.x) ** 2 + (m.pos.y - g.y) ** 2 <= 0.55 * 0.55,
    );
    const out = stepClickMove(clickMove, {
      playerPos: p.pos, cursorWorld: g, lmbHeld: input.lmbHeld, hoverMonster: hover,
      keyboardMove: intent.move.x !== 0 || intent.move.y !== 0, dt,
    });
    if (out.move) intent.move = out.move;
    if (out.attack && intent.cast) intent.cast[0] = true;
    // Marker only for the committed autopilot; while steering, the cursor is it.
    renderer.setMoveMarker(clickMove.holding ? null : clickMove.target);
  } else {
    renderer.setMoveMarker(null);
  }
  return intent;
}

async function main(): Promise<void> {
  // SIGNAL ACQUISITION: the loading screen is baked into iso.html (visible
  // from the first paint); here we just feed it real progress while the model
  // manifest streams in, then fade it out. The System narrates its own load —
  // the rotating line is flavor on a timer, the bar is the information.
  const loadingEl = document.getElementById("loading") as HTMLDivElement;
  const loadingFill = document.getElementById("loading-fill") as HTMLElement;
  const loadingCount = document.getElementById("loading-count") as HTMLElement;
  const loadingFlavor = document.getElementById("loading-flavor") as HTMLElement;
  const LOAD_LINES = [
    "DECORATING YOUR DEATHTRAP…",
    "REHEARSING THE MONSTERS…",
    "POLISHING THE LOOT BOXES…",
    "BRIBING THE CAMERA CREW…",
    "SELLING YOUR AD SLOTS…",
    "WARMING UP THE ANNOUNCER…",
  ];
  let loadLine = 0;
  loadingFlavor.textContent = LOAD_LINES[0];
  const flavorTimer = window.setInterval(() => {
    loadLine = (loadLine + 1) % LOAD_LINES.length;
    loadingFlavor.textContent = LOAD_LINES[loadLine];
  }, 1400);
  await renderer.init((loaded, total) => {
    loadingFill.style.width = `${Math.round((loaded / total) * 100)}%`;
    loadingCount.textContent = `${loaded} / ${total} ASSETS`;
  });
  window.clearInterval(flavorTimer);
  loadingEl.classList.add("done");
  window.setTimeout(() => { loadingEl.style.display = "none"; }, 500);

  if (net) {
    try {
      state = await net.connect(serverUrl, joinCode!, playerName, rivalsMode, roamMode);
    } catch (err) {
      hudLog.innerHTML = `<b style="color:#c0392f">${(err as Error).message}</b><br>` +
        `Start it with <b>npm run server</b>, or check ?server=.`;
      return;
    }
    localId = net.playerId;
    renderer.localPlayerId = localId;
    pushLogLine(`Joined party ${joinCode} as ${playerName}.`);
    net.onEvents = (batch) => {
      netHits.push(...batch.hits);
      netAnns.push(...batch.announcements);
      for (const e of batch.events) pushLogLine(e);
    };
    net.onDisconnect = () => {
      pushLogLine("Disconnected from the server. Attempting to reconnect…");
      showAnnouncement({ text: "CONNECTION LOST. The System apologizes for the technical difficulties. Reconnecting…", kind: "flavor", priority: "high" });
    };
    net.onReconnect = () => {
      // The seat may be a restored instance: re-read the id, resume rendering.
      localId = net.playerId;
      renderer.localPlayerId = localId;
      pushLogLine("Reconnected. Your run resumes.");
      showAnnouncement({ text: "SIGNAL RESTORED. The audience missed you.", kind: "flavor", priority: "high" });
    };
    partyChip.style.display = "";
  }

  function frame(now: number): void {
    let dt = (now - prev) / 1000;
    prev = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    acc += dt;
    pollPad(); // frame-level: panel buttons stay live while a panel pauses the sim
    pollTouch();

    // Buffer feedback across every sub-step (step() clears these each call).
    const frameHits: typeof state.hits = [];
    const frameAnns: Announcement[] = [];

    if (net) {
      // Authoritative snapshots drive the world; we pump intent + drain events.
      netIntentAcc += dt;
      if (netIntentAcc >= 0.05) {
        netIntentAcc = 0;
        net.sendIntent(sampleIntent(0.05));
      }
      const disp = net.display(now);
      if (disp) state = disp;
      frameHits.push(...netHits.splice(0));
      frameAnns.push(...netAnns.splice(0));
      // Party chip: co-op shows the roster; RIVALS shows the race standings.
      // (Drawn icons, not emoji — see STYLEGUIDE.md.)
      if (state.mode === "rivals" && state.rivals) {
        const rows = [...state.rivals]
          .sort((a, b) => b.floor - a.floor || b.level - a.level)
          .map((r) => {
            const status = !r.alive
              ? ` <span style="color:#c0392f">${uic("skull")}${Math.ceil(r.downedT)}s</span>`
              : r.shopping ? ` ${uic("shopping")}` : "";
            const you = r.id === localId ? `${uic("marker")} ` : "";
            return `${you}${esc(r.name)} <span style="color:#a99f8c">F${r.floor} · L${r.level}</span>${status}`;
          });
        partyChip.innerHTML = `${uic("race")} ${esc(joinCode ?? "")} &nbsp; ${rows.join(" &nbsp;·&nbsp; ")}`;
      } else {
        partyChip.innerHTML =
          `${uic("party")} ${esc(joinCode ?? "")} · ${state.players.map((p) => esc(p.name)).join(", ")}`;
      }
      // Safe-room stock/ready counts change server-side; refresh while open.
      srRefreshAcc += dt;
      if (state.safeRoom && srEl.style.display === "flex" && srRefreshAcc > 0.3) {
        srRefreshAcc = 0;
        renderSafeRoom(state);
      }
    }

    // Claim-when-ready draft flow. Edge-triggered so an Esc dismissal sticks:
    // reward drafts (sponsor/shrine/revision) auto-open — they fire in safe
    // contexts; level-up drafts auto-open only in a safe room or while the
    // player is mid-claim (draftChain); otherwise they bank behind the badge.
    const lp = me(state);
    const rewardN = lp.pendingRewards.length;
    const upgradeN = lp.pendingUpgrades.length;
    const draftPending = rewardN > 0 || upgradeN > 0;
    const inSafeRoom = state.safeRoom !== null;
    const inSafe = inSafeRoom || !!lp.safeRoom;
    if (rewardN > prevRewardN) { draftChain = true; openDraftModal(); }
    else if (upgradeN > 0 && prevUpgradeN === 0 && (inSafe || draftChain)) openDraftModal();
    else if (inSafe && !prevInSafe && draftPending) { draftChain = true; openDraftModal(); }
    prevRewardN = rewardN;
    prevUpgradeN = upgradeN;
    prevInSafe = inSafe;
    if (draftEl.style.display === "flex" && !draftPending) draftEl.style.display = "none";
    if (!draftPending) draftChain = false;
    // The badge: something is banked and the modal is closed → pulse the claim key.
    if (draftPending && draftEl.style.display !== "flex") {
      // Count DRAFTS, not cards: one open pick per pending set + the owed queue.
      const banked = (rewardN > 0 ? 1 : 0) + (upgradeN > 0 ? 1 : 0) + lp.upgradeDraftsOwed;
      draftBadge.style.display = "flex";
      draftBadge.innerHTML = `◆ DRAFT ×${banked} <kbd>${esc(bindingLabel(bindings, "draft"))}</kbd>`;
      draftIdleSec += dt;
      if (draftIdleSec > 45 && !draftNagged) {
        draftNagged = true; // once per run: banked power is still YOUR power to claim
        showAnnouncement({ text: "NOTICE: you have unclaimed evolutions. They do not accrue interest.", kind: "levelup", priority: "normal" });
      }
    } else {
      draftBadge.style.display = "none";
      draftIdleSec = 0;
    }
    if (srEl.style.display !== "flex" && inSafeRoom && !draftPending) {
      srTab = "shop"; // every safe room opens on today's shelf
      shopView = "stock";
      shopSel = null;
      renderSafeRoom(state);
      srEl.style.display = "flex";
    }
    if (srEl.style.display === "flex" && !inSafeRoom) srEl.style.display = "none";

    if (!net) {
      // Local sim. Panels, an OPEN draft modal, and the safe room pause it (a
      // host UX choice — the networked world never pauses); drop accumulated
      // time. Banked drafts deliberately do NOT pause: the badge flow means
      // the world keeps running until the crawler chooses their moment.
      if (menuOpen || invOpen || abilOpen || sheetOpen || kbOpen || draftEl.style.display === "flex" || inSafeRoom) acc = 0;
      if (hitStop > 0) { hitStop = Math.max(0, hitStop - dt); acc = 0; } // kill pop
      while (acc >= SIM_DT) {
        step(state, sampleIntent(SIM_DT), SIM_DT);
        for (const e of state.events) pushLogLine(e);
        frameHits.push(...state.hits);
        frameAnns.push(...state.announcements);
        acc -= SIM_DT;
        if (state.floor !== lastFloor) { lastFloor = state.floor; persistRun(state); }
        if (state.status !== lastStatus) {
          lastStatus = state.status;
          persistRun(state);
          if (state.status !== "playing") {
            submitDaily(state); // daily runs report to the board
            if (!testMode) recordRun(state, runMode, Date.now()); // the career ledger
          }
        }
      }
      // Killing blows schedule the next freeze: crits pop hardest, player deaths
      // hang for drama, ordinary kills get a couple of frames.
      for (const h of frameHits) {
        if (!h.killed) continue;
        hitStop = Math.min(0.12, hitStop + (h.kind === "crit" ? 0.06 : h.kind === "player" ? 0.09 : 0.035));
      }

      saveAcc += dt;
      if (saveAcc > 3 && state.status === "playing") { saveAcc = 0; persistRun(state); }
    }

    // Touch feedback: the drag-aim ground telegraph + the contextual descend
    // chip (shown only while standing on the stairs tile).
    if (touchMode) {
      const p = me(state);
      if (touchHeld && touchHeld.aimingSlot >= 0 && touchHeld.aimDir) {
        const ab = touchHeld.aimingSlot < 4
          ? p.abilities.slots[touchHeld.aimingSlot]
          : p.abilities.ultimate;
        renderer.setAimIndicator(telegraphShape(ab), p.pos, isoRotate(touchHeld.aimDir));
      } else {
        renderer.setAimIndicator(null);
      }
      const ti = Math.floor(p.pos.y) * state.map.w + Math.floor(p.pos.x);
      tStairsEl.classList.toggle("on", state.map.tiles[ti] === Tile.StairsDown);
    }

    // Controller rumble rides the same hit stream as particles/shake: damage
    // TAKEN thumps the heavy motor (scaled by how much of your health it was);
    // kill confirms tick the light one. Everything else stays still — rumble
    // is punctuation, not weather.
    if (gamepadEnabled && gamepad.connected && frameHits.length > 0) {
      const p = me(state);
      let strong = 0, weak = 0;
      for (const h of frameHits) {
        if (h.kind === "player") {
          const dx = h.pos.x - p.pos.x, dy = h.pos.y - p.pos.y;
          if (dx * dx + dy * dy < 1.5) strong = Math.max(strong, 0.35 + (h.amount / Math.max(1, p.maxHp)) * 2);
        } else if (h.killed) {
          weak = Math.max(weak, h.kind === "crit" ? 0.5 : 0.3);
        }
      }
      if (strong > 0) gamepad.rumble(strong, 0.2, 130);
      else if (weak > 0) gamepad.rumble(0, weak, 60);
    }

    // Particles + shake use world space, so they can fire before the camera moves.
    renderer.emitHits(frameHits);
    audioDirector.frame(state, frameHits, frameAnns, localId);
    updateBulletTimeGrade(state);
    renderer.update(state, now / 1000);
    renderer.render();
    // Damage numbers need the camera positioned (done in update) to project.
    for (const h of frameHits) spawnDamageNumber(h);
    for (const a of frameAnns) showAnnouncement(a);
    updateHud(state);
    updateDowned(state);
    maybeShowRecap(state);
    updateSkills(state);
    updateShowHud(state);
    updateBossBar(state);
    drawMinimap(state);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
