import {
  createGame, createTestGame, restoreGame, step, equipFromInventory, equipItem, chooseReward, chooseUpgrade,
  buyCatalogItem, hasPassive, sellItem, sellAllItems, sellValue, effectivePrice, missingComponents, setReady, addPlayer, slotAbility, setUltimate,
  claimAchievementLootBox, dismantleItem, dismantleYield, refitCost, refitItem, socketGlyph, unsocketGlyph,
  isCrawlerSkin, type CrawlerSkin, type TestSetup,
} from "./sim/game";
import { ACHIEVEMENTS } from "./sim/achievements";
import { affixLines, itemScore, weaponClassOf } from "./sim/items";
import { buildCharacterSheet, type SheetAbilityRow } from "./sim/sheet";
import {
  CATALOG, CATALOG_BY_ID, BOSS_UNIQUES, TIER_UNLOCK_SHOP, buildsInto, consumablePrice, consumableStock, gearAffixes,
  totalCost, type CatalogEntry, type CatalogTier,
} from "./sim/catalog";
import {
  GLYPH_INFO, glyphDormantReason, glyphMatches, glyphSocket2Level, glyphSocketCount, glyphsFor, socketLegal,
  type GlyphId,
} from "./sim/glyphs";
import {
  EQUIP_SLOTS, Tile,
  type Affixes, type Announcement, type AnnouncementKind, type GameState, type HitEvent, type Item, type ItemSlot, type Player,
  type BossEvent, type DialogueSession, type Quest, type Rarity, type SafeRoom, type Vec2,
} from "./sim/types";
import { bossMutatorInfo } from "./sim/bosses";
import { ASK_LABEL, ASK_PAL, ASK_TO_FAMILY, bossFamily } from "./render3d/bossSignatures";
import { chooseDialogue, closeDialogue, npcsOf, settlementAt, settlementShopFor } from "./sim/npc";

import { CONFIG, FLOOR_BANDS, naturalFloorForLevel } from "./sim/config";
import {
  ABILITY_INFO, ABILITY_SLOTS, DISCOVERABLE_ABILITIES, STARTING_ABILITIES, UPGRADES,
  abilityCdrBreakdown, knows, nodeOpen, rank, upgradeDef, type AbilityId, type UpgradeDef,
} from "./sim/abilities";
import { ABILITY_TAGS, GLYPH_IDS } from "./sim/glyphs";
import { InputController } from "./input/input";
import { GamepadController, isoRotate } from "./input/gamepad";
import { TouchController } from "./input/touch";
import { TouchShell } from "./input/touchShell";
import { HudLayout, parseSafeOverride } from "./ui/hudLayout";
import {
  Segmented, attachPanel, hideSheet, showSheet, sheetOpen as mathSheetOpen,
} from "./ui/panelTouch";
import { Haptics } from "./input/haptics";
import { pickTarget, tapTarget } from "./input/targeting";
import { aimAnchor, aimSpecFor, castRange } from "./input/aimSpec";
import { accumulateTouch, applyTouchEdges, createTouchEdges } from "./input/touchIntent";
import { createClickMove, stepClickMove } from "./input/clickMove";
import {
  ACTION_INFO, DEFAULT_BINDINGS, bindingLabel, loadBindings, loadCamView, loadGamepad, loadMouseAim, loadMouseMove, loadNotify,
  loadTouch, loadTouchPrefs, rebind, saveBindings, saveCamView, saveGamepad, saveMouseAim, saveMouseMove, saveNotify, saveTouch,
  saveTouchPrefs,
  type BindableAction, type Bindings, type CamView, type NotifyLevel, type TouchPref, type TouchPrefs,
} from "./input/bindings";
import { Renderer3D } from "./render3d/renderer3d";
import { AudioEngine } from "./audio/engine";
import { AudioDirector } from "./audio/director";
import { clearRun, loadRun, saveRun, seedTips, type RunMode } from "./persist/save";

import { careerBests, episodeCount, loadHistory, recordRun } from "./persist/history";
import { dailySeed, dayFromMs } from "./sim/daily";
// THE COMPETITIVE LAYER (COMPETITIVE.md). The sim owns the codec and the era
// gate; net/ owns the wire and the ghost worker; ui/social.ts owns the
// arithmetic. This file owns the screens and the one seam that matters:
// feeding step() an intent that has already been through the wire format.
import { RunRecorder, REPLAY_DT, canonicalIntent, type RunProof } from "./sim/replay";
import { RULES_HASH } from "./sim/rulesHash";
import { CompetitiveClient, precomputeGhost } from "./net/competitiveClient";
import * as social from "./ui/social";
import { NetClient, loadToken, storeToken } from "./net/netClient";
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
// LOOK EXPERIMENT flag (see renderer3d): ?look=lived densifies the dungeon
// with Dungeon Remastered modular pieces. Camera zoom is a real SETTING
// (K panel, persisted); ?view=close still works as a URL override.
// (Reads the URL directly — `params` is declared further down.)
const lookParams = new URLSearchParams(location.search);
// PHONE = coarse pointer + a short edge under 500 CSS px (iPhones are 375-440;
// iPads start at 744). Compact touch chrome, the landscape gate, and a CLOSE
// camera default all key off this; ?phone=1 forces it for headless verify.
const isPhone = lookParams.has("phone")
  ? lookParams.get("phone") !== "0"
  : (window.matchMedia?.("(pointer: coarse)").matches ?? false) &&
    Math.min(screen.width, screen.height) < 500;
if (isPhone) document.body.classList.add("phone");
// HEADLESS VERIFICATION HOOKS (MOBILE.md 4.1 / 4.3). Chromium reports env()
// as 0 under device emulation, so ?safe=t,r,b,l seeds the four --sa-* values
// the whole HUD derives from — which is how the battery can assert "given the
// browser reports inset N, does every HUD rect clear N". ?uiclass= forces a
// device class. Neither does anything unless the URL asks.
HudLayout.applySafeOverride(parseSafeOverride(lookParams.get("safe")));
// A small screen defaults to the CLOSE framing (readability) — an explicit
// saved choice or ?view= override still wins.
let camView: CamView = lookParams.get("view") === "close"
  ? "close"
  : loadCamView(isPhone ? "close" : "default");
const renderer = new Renderer3D(canvas, {
  look: lookParams.get("look") === "lived" ? "lived" : undefined,
  view: camView === "close" ? "close" : undefined,
});

// Audio seam: same consumer pattern as particles/damage numbers, fed from the
// per-frame feedback buffers. Silent until clips exist under public/audio/
// (see ASSETS.md — Audio); missing files simply never play. The clips now
// front-load on the boot screen (perf round: longer up-front load is the
// accepted trade for a hitch-free session) — see main() below.
const audio = new AudioEngine();
const audioDirector = new AudioDirector(audio);

// ---- Network mode (?join=CODE[&name=...][&server=ws://host:5281]) ----
// Local mode runs the sim in-page; network mode renders authoritative snapshots
// from the server and forwards intents/actions. Same renderer, same UI.
const params = new URLSearchParams(location.search);
// CLEAN CAPTURE: ?clean=1 suppresses tutorial cards + courtesy toast chatter
// (showcase/marketing frames — see tools/beautyshot.mjs). Gameplay untouched.
const cleanMode = params.has("clean");
const joinCode = params.get("join");
// RIVALS: ?rivals=1&join=CODE — up to four hostile crawlers race for the boss.
const rivalsMode = params.has("rivals");
// ROAM (multiplayer): ?roam=1&join=CODE — the party campaigns across sessions;
// the server persists characters per account (see PERSISTENCE.md).
const roamMode = params.has("roam");
// QUICK JOIN: ?public=1&join=CODE — only matters the first time this code is
// seen; flags the new instance discoverable via GET /open-parties.
const publicMode = params.has("public");
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

// RENDER SCALE (SYSTEM menu, K panel): the 3D framebuffer renders at a
// fraction of display resolution — the DOM HUD stays native-crisp. Persisted
// per browser; applied before the first frame.
const RENDERSCALE_KEY = "dcc:renderscale:v1";
function loadRenderScale(): number {
  try {
    const v = Number(localStorage.getItem(RENDERSCALE_KEY));
    return v === 0.75 || v === 0.9 ? v : 1;
  } catch {
    return 1;
  }
}
let renderScale = loadRenderScale();
if (renderScale !== 1) renderer.setRenderScale(renderScale);

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
  // gear=0 none, gear=level dresses for the crawler's LEVEL (not the floor
  // they're dropped onto), gear=N rolls floor-N loot; default = the floor's.
  const gear = params.get("gear");
  return {
    seed: num("seed"),
    floor: num("floor"),
    level: num("level"),
    gold: num("gold"),
    abilities: ab === "all" ? "all" : ab ? (ab.split(",").filter((a) => a in ABILITY_INFO) as AbilityId[]) : undefined,
    gear: gear !== "0",
    gearFloor: gear === "level" ? naturalFloorForLevel(num("level") ?? 1) : num("gear"),
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

// ---- RUN PROOF RECORDING (COMPETITIVE.md MUST-3) ----
// A proof is the whole run in ~30 KB: the quantized intent of every tick plus
// every out-of-band sim call. Two hard rules live here.
//
//  1. RECORDING MUST NOT CHANGE SIM BEHAVIOUR (brief rule 1). It cannot, by
//     construction: the loop below feeds step() the DECODED intent whether or
//     not a recorder exists (canonicalIntent is the same round trip with no
//     tape), so there is no second code path to drift.
//  2. A PROOF ALWAYS STARTS FROM THE SEED. A restored save cannot be replayed
//     - Object.entries iteration order over materials/cooldowns is insertion
//     order, which createGame reproduces and a deserialized world may not - so
//     CONTINUE deliberately runs unrecorded and the post-run screen says so.
let rec: RunRecorder | null = null;
/** Why this run has no proof, in words the post-run screen prints verbatim. */
let recBlocked = "";
/** Ticks of the local run, kept even when nothing is recording - the ghost
 *  split delta and the band ledger both index off it. */
let runTicks = 0;
/** Tick each floor was ENTERED, index 0 = floor 1; -1 for unreached. Same
 *  shape the verifier derives, so the preview and the sealed row agree. */
let floorEntryTicks: number[] = [];
/** Drafts the System offered vs drafts you actually claimed - the EXECUTION
 *  half of the grade, and the most common quiet mistake in the game. */
let draftsOffered = 0;
let draftsClaimed = 0;
/** Set by the CONTRACTS screen immediately before a ticketed event run. The
 *  START is what makes an attempt count honest (3.2A). */
let pendingTicket: { eventId: string; ticket: string; attemptNo: number; scoresCp: boolean } | null = null;
/**
 * Why an about-to-start run on the DAY'S SEED is carrying no ticket.
 *
 * There used to be two doors to the daily and the front one was silently
 * unranked: the menu's gold headline tile called `startRun({kind:'daily'})`,
 * which resolves the SAME seed as the server's daily contract, while
 * `pendingTicket` was set in exactly one place - the STANDINGS' ENTER THE
 * CONTRACT button. So the most prominent button in the product played today's
 * contract dungeon with `runEvent === null`, submitted with no event, earned no
 * attempt number, and had the ladder line - the LP line of the whole design -
 * tell the player "free seed: contract points come from contracts", which was
 * false about the run they had just played. Both doors are ticketed now, and
 * when the signing genuinely cannot happen this says which one and why.
 */
let pendingContractNote: string | null = null;
let runContractNote: string | null = null;

let runEvent: { eventId: string; attemptNo: number; scoresCp: boolean } | null = null;
/** RUN IT BACK / ACCEPT CHALLENGE pin the next seed instead of rolling one. */
let forcedSeed: number | null = null;
/** The sealed artifact of the run that just ended, kept for SHARE and for the
 *  retry that races your own ghost. */
let runProof: RunProof | null = null;

/**
 * Arm (or deliberately refuse to arm) the recorder for a run that is starting.
 * The refusals are as important as the recording: each one produces a sentence
 * the post-run screen prints, because an unsealed run that never explains
 * itself is how a player decides the ladder is rigged.
 */
function beginRecording(seed: number, runKind: GameState["runKind"], mode: GameState["mode"]): void {
  rec = null;
  recBlocked = "";
  runTicks = 0;
  runProof = null;
  runEvent = null;

  // The floor the run STARTS on was entered at tick 0. Without this the very
  // first split has no left-hand side, and the ghost chip reads NO SPLIT YET
  // for the whole of floor 1 - which is exactly the floor you race hardest.
  floorEntryTicks = new Array<number>(CONFIG.finalFloor).fill(-1);
  if (state.floor >= 1) floorEntryTicks[state.floor - 1] = 0;
  draftsOffered = 0;
  draftsClaimed = 0;
  const ticket = pendingTicket;
  const contractNote = pendingContractNote;
  pendingTicket = null;
  pendingContractNote = null;
  runContractNote = contractNote;
  if (net) {
    recBlocked = "party runs are hosted by the server — the solo descent is what carries a proof";
    return;
  }
  if (testMode) {
    recBlocked = "TEST CHAMBER. A test start is structurally ineligible for a board.";
    return;
  }
  if (runKind !== "race") {
    recBlocked = "ROAM has no clock and no board. Nothing to prove, nothing to seal.";
    return;
  }
  if (ticket) runEvent = { eventId: ticket.eventId, attemptNo: ticket.attemptNo, scoresCp: ticket.scoresCp };
  rec = new RunRecorder({
    seed,
    mode,
    runKind,
    startKind: "fresh",
    playerName: crawlerName(),
    clientBuild: RULES_HASH.slice(0, 7),
    eventId: ticket?.eventId,
    ticket: ticket?.ticket,
  });
}

/** One line beside each out-of-band sim call, in the same order the sim sees
 *  them. Wrapped so the 15 call sites read as one word rather than a null
 *  check each (COMPETITIVE.md MUST-3, the host contract). */
const recAct: RunRecorder["action"] = (op, ...args) => { rec?.action(op, ...args); };

function boot(): GameState {
  if (testMode) return createTestGame(testSetup());
  const save = loadRun();
  if (save && save.status === "playing") {
    runMode = save.mode ?? { kind: "random" };
    hasContinue = true;
    const g = restoreGame(save);
    currentRunKind = g.runKind; // a resumed Roam campaign stays Roam (BACKLOG #11)
    if (save.player.name) g.players[0].name = save.player.name;
    seedTips(g.players[0]); // the ledger may know tips from other runs
    return g;
  }
  // No run to resume: this state is only the menu's backdrop. Nothing is
  // saved until the crawler signs the waiver (picks a mode).
  const g = createGame(freshSeed());
  seedTips(g.players[0]);
  return g;
}
if (testMode) {
  // A quiet diegetic stamp (styled in iso.html), not red alarm text.
  document.getElementById("banner")!.insertAdjacentHTML("afterbegin", "<b>Test Chamber</b>");
}

let state = net ? createGame(0) : boot(); // net: placeholder until the welcome snapshot
// A run that did not start at floor 1 in this browser cannot be replayed from
// its seed, so it is never recorded (COMPETITIVE.md 2.1: proofs always start
// from createGame, never from a deserialized checkpoint).
recBlocked = net
  ? "party runs are hosted by the server — the solo descent is what carries a proof"
  : testMode
    ? "TEST CHAMBER. A test start is structurally ineligible for a board."
    : hasContinue
      ? "resumed from a save — a proof has to start at floor 1"

      : "";
// A resumed or test-chamber run never passes through beginRecording, so the
// starting floor is stamped here too (a test start is not floor 1).
floorEntryTicks = new Array<number>(CONFIG.finalFloor).fill(-1);
if (state.floor >= 1 && state.floor <= CONFIG.finalFloor) floorEntryTicks[state.floor - 1] = 0;

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
  telemetrySubmitted = false;

  const seed = forcedSeed ?? (mode.kind === "daily" && mode.day ? dailySeed(mode.day) : freshSeed());
  forcedSeed = null;
  consentEl.classList.remove("on"); // a stale offer never survives into a new run
  closeSets();
  state = createGame(seed, "coop", runKind);
  state.players[0].name = crawlerName();
  state.players[0].skin = chosenSkin; // the campfire decision walks in with you
  seedTips(state.players[0]); // first-contact tips are once EVER, not once per run
  beginRecording(seed, runKind, state.mode);
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
const touchPrefs: TouchPrefs = loadTouchPrefs();
const touch = new TouchController();
const haptics = new Haptics();
haptics.level = touchPrefs.haptics;
const tStairsEl = document.getElementById("t-stairs")!;
// ONE router, bound at the document in the capture phase: the world zone owns
// no element, so a per-element binding could never see a tap on the dungeon
// floor. Mouse events are never claimed, so desktop play is untouched.
touch.bind(document, document.body);
touch.castModes = [...touchPrefs.castMode];
touch.flickDash = touchPrefs.flickDash;
touch.twoFingerDash = touchPrefs.twoFingerDash;
touch.stick.recenter = touchPrefs.stickRecenter;
// A chip on cooldown REFUSES at pointerdown (buzz + shake) instead of running
// the whole gesture and silently doing nothing.
touch.canCast = (slot) => {
  const p = me(state);
  if (slot === 0) return true; // the basic attack chip is hold-to-repeat
  const ab = slot < ABILITY_SLOTS ? p.abilities.slots[slot] : p.abilities.ultimate;
  if (!ab) return false;
  if (ab === "dash") return p.dashCharges > 0;
  return (p.cd[ab] ?? 0) <= 0;
};
// Transient System cards park inside the movement thumb arc on a phone. A
// gameplay press dismisses them rather than being eaten by one.
touch.onGameplayInput = () => {
  const card = document.getElementById("tutorial");
  if (card && card.style.display !== "none" && card.childElementCount > 0) {
    (card.querySelector(".tut-dismiss") as HTMLElement | null)?.click();
  }
};
// THE HUD'S HALF OF THE ZONE TABLE. The cluster, the map chip and the XP rail
// are placed from the SAME table the touch zones come from, so the paint and
// the hit-testing cannot disagree (src/ui/hudLayout.ts).
const hud = new HudLayout({
  opacity: touchPrefs.opacity,
  onMap: () => toggleMinimapExpand(),
});
const touchShell = new TouchShell({
  controller: touch, haptics, prefs: touchPrefs, opacity: touchPrefs.opacity,
  onLayout: (z) => {
    hud.apply(z, touchPrefs.opacity);
    const forced = lookParams.get("uiclass");
    if (forced) document.body.dataset.uiclass = forced;
  },
});
function applyTouchMode(): void {
  touchMode = touchWanted();
  document.body.classList.toggle("touch", touchMode);
  document.documentElement.style.setProperty("--hud-pad", `${touchPrefs.hudInset}px`);
  document.body.classList.toggle("handed-left", touchPrefs.handed === "left");
  touch.setEnabled(touchMode); // OFF must not queue casts (touch-screen laptops)
  if (touchMode) touchShell.relayout();
}
applyTouchMode();
/** Re-read every touch pref into the live layer (called by the K panel). */
function applyTouchPrefs(): void {
  saveTouchPrefs(touchPrefs);
  haptics.level = touchPrefs.haptics;
  touch.castModes = [...touchPrefs.castMode];
  touch.flickDash = touchPrefs.flickDash;
  touch.twoFingerDash = touchPrefs.twoFingerDash;
  touch.stick.recenter = touchPrefs.stickRecenter;
  stickyLock = touchPrefs.stickyLock;
  touchShell.setPrefs(touchPrefs, touchPrefs.opacity);
  hud.setOpacity(touchPrefs.opacity);
  document.documentElement.style.setProperty("--hud-pad", `${touchPrefs.hudInset}px`);
  document.body.classList.toggle("handed-left", touchPrefs.handed === "left");
}
// Bare-canvas touches must NOT become compatibility mouse events: the browser
// would synthesize mousedown (the LMB = slot-1 alias — a phantom attack) and
// mousemove (pinning stale mouse aim + flipping device arbitration to "mouse").
// Canceling pointerdown suppresses the whole compat stream, touch only.
canvas.addEventListener("pointerdown", (e) => {
  if (touchMode && e.pointerType === "touch") e.preventDefault();
});
// Safari (iOS + macOS trackpads) pinch-zooms the PAGE through proprietary
// GestureEvents that ignore touch-action entirely — two-thumb play (stick +
// ability chip) reads as a pinch and lurches the viewport. Snuff the stream.
for (const g of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(g, (e) => e.preventDefault(), { passive: false });
}
input.onReset = () => {
  if (net) return; // the server owns the run in network mode
  /**
   * THE KEY THE SCREEN ADVERTISES RUNS THE ACTION THE SCREEN ADVERTISES.
   *
   * The verdict's primary CTA renders `RUN IT BACK <kbd>R</kbd>` and calls
   * runItBack(): same seed, this run's own proof armed as a ghost. R routed
   * here instead - a fresh seed, no forcedSeed, no ghost, i.e. NEW CONTRACT -
   * and then hid the verdict with the comment "last season's report card".
   * COMPETITIVE.md 6.2 Beat 6 names RUN IT BACK the biggest retry driver in
   * the design and says to bind it to the key the player already
   * reflex-presses. Shipped, the reflex press silently threw away the seed and
   * the ghost, so the flagship retry loop was unreachable by the one input the
   * highest-leverage screen in the product tells you to use.
   *
   * The test chamber keeps its own R (reroll the stage), because there is no
   * verdict to run back there and no proof to arm.
   */
  if (!testMode && recapFor !== null && state.status !== "playing") {
    void runItBack();
    return;
  }
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

// THE CAMPFIRE: who are you this season? Cosmetic pick, kept per browser and
// carried into runs, saves, and party joins (netClient reads the same key).
const SKIN_KEY = "dcc:skin:v1";
let chosenSkin: CrawlerSkin = "knight";
try {
  const stored = localStorage.getItem(SKIN_KEY);
  if (isCrawlerSkin(stored)) chosenSkin = stored;
} catch { /* seeded fallback covers it */ }
let charSelect: ReturnType<Renderer3D["createCharSelect"]> | null = null;
const skinNameEl = () => document.getElementById("m-skin-name");
function applySkinPick(skin: CrawlerSkin): void {
  chosenSkin = skin;
  try { localStorage.setItem(SKIN_KEY, skin); } catch { /* best-effort */ }
  const el = skinNameEl();
  if (el) el.textContent = skin === "hooded" ? "THE HOODED ONE" : `THE ${skin.toUpperCase()}`;
}
// THE CASTING CALL: stage 2 of check-in. Picking a mode hides the panel and
// dollies the camera into the full campfire scene; pick a crawler, CHECK IN
// launches whatever the panel decided, BACK returns to the panel.
let pendingLaunch: (() => void) | null = null;
function enterCasting(modeLabel: string, launch: () => void): void {
  pendingLaunch = launch;
  document.getElementById("m-cast-mode")!.textContent = modeLabel;
  menuEl.classList.add("casting");
  if (charSelect) charSelect.mode = "casting";
}
function exitCasting(): void {
  pendingLaunch = null;
  menuEl.classList.remove("casting");
  if (charSelect) charSelect.mode = "backdrop";
}
document.getElementById("m-cast-back")!.addEventListener("click", exitCasting);
document.getElementById("m-cast-go")!.addEventListener("click", () => {
  const launch = pendingLaunch;
  exitCasting();
  closeMenu();
  launch?.();
});
window.addEventListener("keydown", (e) => {
  if (!menuOpen || !charSelect || charSelect.mode !== "casting") return;
  if (document.activeElement instanceof HTMLInputElement) return; // typing a name
  if (e.key === "ArrowLeft") charSelect.cycle(-1);
  else if (e.key === "ArrowRight") charSelect.cycle(1);
  else if (e.key === "Enter") document.getElementById("m-cast-go")!.click();
  else if (e.key === "Escape") exitCasting();
});

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

// ?api=<origin> overrides it, which is how a second dev server (or a
// production board read from a local build) gets driven during verification.
const API_BASE = params.get("api")
  ?? (import.meta.env.DEV ? `http://${location.hostname}:5281` : "");
/** The competitive wire: proofs out, boards/profiles/events/tickets in. */
const competitive = new CompetitiveClient(API_BASE);

// ---- Daily challenge links (launch polish #2) ----
// ?daily=YYYY-MM-DD[&by=&floor=&t=&won=1] turns the DAILY CRAWL card into an
// accepted challenge: same day = same seed = the same dungeon the challenger
// ran. Everything but the day is display flavor (names go through textContent).
const challengeDay = /^\d{4}-\d{2}-\d{2}$/.test(params.get("daily") ?? "")
  ? params.get("daily")!
  : null;

// Participation streak: finishing a daily (win OR wipe — showing up counts)
// extends it; a missed day resets. Local to the browser, like the career.
const STREAK_KEY = "dcc:dailystreak:v1";
function loadStreak(): { last: string; n: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(STREAK_KEY) ?? "null") as { last: string; n: number } | null;
    return v && typeof v.last === "string" && typeof v.n === "number" ? v : null;
  } catch {
    return null;
  }
}
function dayBefore(day: string): string {
  return dayFromMs(Date.parse(`${day}T12:00:00Z`) - 86_400_000);
}
function bumpStreak(day: string): number {
  const cur = loadStreak();
  const n = cur?.last === day ? cur.n : cur?.last === dayBefore(day) ? cur.n + 1 : 1;
  try { localStorage.setItem(STREAK_KEY, JSON.stringify({ last: day, n })); } catch { /* best-effort */ }
  return n;
}
/** The streak shown on the menu card: alive if it includes today or yesterday. */
function currentStreak(): number {
  const cur = loadStreak();
  const today = dayFromMs(Date.now());
  return cur && (cur.last === today || cur.last === dayBefore(today)) ? cur.n : 0;
}

// Board tabs: TODAY (the daily) + the all-time category boards.
let boardTab = "today";
document.querySelectorAll<HTMLElement>(".m-board-h .bt").forEach((el) => {
  el.addEventListener("click", () => {
    boardTab = el.dataset.bt ?? "today";
    document.querySelectorAll(".m-board-h .bt").forEach((b) => b.classList.toggle("active", b === el));
    void refreshBoard();
  });
});

/** Result column per all-time category — each board brags differently. */
function alltimeRes(cat: string, e: { floor: number; won: boolean; timeSec: number; kills: number }): string {
  if (cat === "fastest" || cat === "contracts") return `CLEAR · ${fmt(e.timeSec)}`;
  if (cat === "kills") return social.count(e.kills, "kill");
  return e.won ? `CLEAR · ${fmt(e.timeSec)}` : `floor ${e.floor}`;
}

/**
 * The campfire board. It reads the SAME rows THE STANDINGS does, because a
 * menu that disagrees with the ladder is worse than a menu with no board: the
 * legacy /leaderboard endpoint still answers, but it knows nothing about seals,
 * eras or accounts, so a row here would silently contradict the row there.
 * Falls through to the legacy shape only when the competitive API is dark.
 */
async function refreshBoard(): Promise<void> {
  const list = document.getElementById("m-board-list")!;
  const dayEl = document.getElementById("m-board-day")!;
  try {
    const kind = boardTab === "today" ? "deepest" : boardTab;
    const page = (await competitive.board(kind, {
      event: boardTab === "today" ? "daily" : undefined, limit: 8,
    })) as social.BoardPage;
    dayEl.textContent = boardTab === "today" ? (challengeDay ?? dayFromMs(Date.now())) : "ALL-TIME";
    if (page.entries.length === 0) {
      list.innerHTML = '<li class="none">no crawlers on this board yet — be the first</li>';
      return;
    }
    list.innerHTML = page.entries.map((r, i) => {
      const chip = social.sealChip(r.state, r.rulesEra, r.private);
      return `<li><span class="rank">${i + 1}</span><span class="nm"></span>` +
        `<span class="${chip.cls}" title="${esc(chip.title)}">${chip.label}</span>` +
        `<span class="res${r.won ? " win" : ""}">${boardResult(kind, r)}</span></li>`;
    }).join("");
    // Names are player-supplied: set via textContent, never innerHTML.
    const nms = list.querySelectorAll(".nm");
    page.entries.forEach((r, i) => { nms[i].textContent = r.name; });
    return;
  } catch { /* the competitive API is dark: fall back to the legacy board */ }
  if (boardTab !== "today") {
    try {
      const r = await fetch(`${API_BASE}/leaderboard?cat=${boardTab}`);
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as { entries: { name: string; floor: number; won: boolean; timeSec: number; kills: number }[] };
      // UNSEALED · LEGACY. These rows predate verification and were
      // self-reported; they are shown only when the sealed boards are dark, and
      // they are never allowed to look like the sealed ones.
      dayEl.textContent = "ALL-TIME · UNSEALED LEGACY";
      list.innerHTML = (data.entries.length
        ? data.entries.slice(0, 10).map((e, i) =>
            `<li><span class="rank">${i + 1}</span><span class="nm"></span>` +
            `<span class="seal claimed" title="self-reported, from before verification — never replayed">UNSEALED</span>` +
            `<span class="res${e.won ? " win" : ""}">${alltimeRes(boardTab, e)}</span></li>`,
          ).join("")
        : '<li class="none">nobody has claimed this board yet</li>')
        + '<li class="none">THE STANDINGS are offline — these are legacy, self-reported rows</li>';
      const nms = list.querySelectorAll(".nm");
      data.entries.slice(0, 10).forEach((e, i) => { nms[i].textContent = e.name; });
    } catch {
      list.innerHTML = '<li class="none">board offline — the server keeps the score</li>';
    }
    return;
  }
  try {
    // A challenge link shows the CHALLENGER'S board day, not today's.
    const day = challengeDay ?? dayFromMs(Date.now());
    dayEl.textContent = day;
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
    // Yesterday's champion header (skipped on challenge-day views).
    if (!challengeDay) {
      const yr = await fetch(`${API_BASE}/leaderboard?day=${dayBefore(day)}`);
      if (yr.ok) {
        const ydata = (await yr.json()) as typeof data;
        const champ = ydata.entries[0];
        if (champ) {
          const li = document.createElement("li");
          li.className = "yday";
          const label = document.createElement("span");
          label.textContent = "YESTERDAY'S CHAMPION: ";
          const nm = document.createElement("b");
          nm.textContent = champ.name;
          const res = document.createElement("span");
          res.textContent = champ.won ? ` — CLEAR · ${fmt(champ.timeSec)}` : ` — floor ${champ.floor}`;
          li.append(label, nm, res);
          list.prepend(li);
        }
      }
    }
  } catch {
    list.innerHTML = '<li class="none">board offline — the server keeps the score</li>';
  }
}

/**
 * THE SELF-REPORTED SUBMITTERS ARE GONE (COMPETITIVE.md 1.2).
 *
 * They posted a name and a set of numbers to an unauthenticated endpoint, which
 * meant a devtools one-liner could do the same with better numbers. The server
 * now answers that route with 410, and a finished run travels exactly one way:
 * sealRun() hands the recorded input stream to the verifier, the server REPLAYS
 * it, and the row it certifies is the only row that exists.
 *
 * The daily STREAK is local and stays local - it never needed a board round
 * trip, and it is a nudge rather than a score.
 */
function noteDailyStreak(s: GameState): void {
  if (net || testMode || runMode.kind !== "daily" || !runMode.day || dailySubmitted) return;
  dailySubmitted = true;
  void s;
  const streak = bumpStreak(runMode.day);
  if (streak > 1) pushLogLine(`DAILY CRAWL: ${streak}-day streak. The System notices consistency.`);
}

/** Every finished SOLO run reports its build to usage_events (fire-and-forget)
 *  — round 1 of BALANCE-NOTES.md found the balance record only saw multiplayer
 *  while nearly all real runs happen right here in the browser. Same summary
 *  shape the server logs for party runs, so mining treats both uniformly. */
let telemetrySubmitted = false;
function submitTelemetry(s: GameState): void {
  if (net || testMode || telemetrySubmitted) return;
  telemetrySubmitted = true;
  const p = me(s);
  void fetch(`${API_BASE}/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "run_end",
      token: ensureToken(),
      data: {
        status: s.status, floor: s.floor, mode: "solo", runKind: s.runKind,
        elapsed: Math.round(s.elapsed),
        players: [{
          name: p.name, level: p.level, slots: p.abilities.slots,
          ultimate: p.abilities.ultimate,
          ranks: Object.values(p.abilities.ranks).reduce((a, b) => a + b, 0),
          weapon: p.equipment.weapon?.name ?? null,
          maxHp: p.maxHp, armor: p.armor,
          attackPower: p.attackPower, spellPower: p.spellPower,
          crit: +p.critChance.toFixed(3), kills: p.kills,
          damageDealt: Math.round(p.damageDealt),
          damageTaken: Math.round(p.damageTaken),
          gold: p.gold, sponsors: p.sponsors, alive: p.alive,
        }],
      },
    }),
  }).catch(() => { /* offline is fine — the record is a bonus, never a blocker */ });
}

// ---- Account (release infra): anonymous token + optional OAuth identity ----
// The token is the account. Solo players may never have joined a server, so
// mint one locally when needed — the server accepts any well-formed id.
function ensureToken(): string {
  let t = loadToken();
  if (!t) {
    t = crypto.randomUUID();
    storeToken(t);
  }
  return t;
}

const SIGNIN_KEY = "dcc:signin:v1";
function loadSignin(): { who: string; provider: string } | null {
  try {
    return JSON.parse(localStorage.getItem(SIGNIN_KEY) ?? "null");
  } catch {
    return null;
  }
}

// Consume the OAuth callback hash BEFORE anything else reads the URL:
// #auth=<account>&who=<display>&provider=<p> (or #autherr=<why>).
{
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (h.get("auth")) {
    storeToken(h.get("auth")!);
    try {
      localStorage.setItem(SIGNIN_KEY, JSON.stringify({ who: h.get("who") ?? "Crawler", provider: h.get("provider") ?? "" }));
    } catch { /* best-effort */ }
    history.replaceState(null, "", location.pathname + location.search);
  } else if (h.get("autherr")) {
    console.warn("sign-in failed:", h.get("autherr"));
    history.replaceState(null, "", location.pathname + location.search);
  }
}

/** Wire the menu account row: sign-in buttons per enabled provider, the
 *  signed-in chip with cross-device career stats, sign-out, delete. */
/**
 * THE PROVIDERS THIS BUILD CAN ACTUALLY SIGN YOU IN WITH.
 *
 * Cached at boot because the VERDICT needs them too, not just the menu:
 * COMPETITIVE.md 6.2 Beat 5 specifies the unlinked case as a refusal WITH A
 * BUTTON, and the only sign-in control in the product lived on the menu behind
 * `display:none`. A screen that demands an action has to be able to offer it.
 */
let authProviders: string[] = [];
/** Send the crawler to a provider, keeping the account token so the identity
 *  links to the career they already have rather than starting a new one. */
export function beginSignIn(provider: string): void {
  location.href = `${API_BASE}/auth/login/${provider}?token=${encodeURIComponent(ensureToken())}`;
}

async function initAccountUi(): Promise<void> {
  const row = document.getElementById("m-account")!;
  const status = document.getElementById("m-acct-status")!;
  let providers: string[] = [];
  try {
    const r = await fetch(`${API_BASE}/auth/providers`);
    providers = r.ok ? ((await r.json()) as { providers: string[] }).providers : [];
  } catch { /* server unreachable: keep the menu quiet */ }
  authProviders = providers;
  const signin = loadSignin();
  if (providers.length === 0 && !signin) return; // nothing to offer
  row.style.display = "flex";
  const show = (id: string, on: boolean) => { document.getElementById(id)!.style.display = on ? "" : "none"; };
  if (signin) {
    status.innerHTML = `◆ <b></b>`;
    status.querySelector("b")!.textContent = `${signin.who} · ${signin.provider}`;
    show("m-signin-discord", false);
    show("m-signin-google", false);
    show("m-signout", true);
    show("m-forget", true);
    // Cross-device career, from the server's aggregate (profiles).
    try {
      const r = await fetch(`${API_BASE}/auth/whoami?token=${encodeURIComponent(ensureToken())}`);
      if (r.ok) {
        const { stats } = (await r.json()) as { stats: { runs: number; wins: number; deepest: number; kills: number } | null };
        if (stats && stats.runs > 0) {
          status.append(` — ${stats.runs} runs · ${stats.wins} wins · deepest F${stats.deepest} · ${social.count(stats.kills, "kill")}`);
        }
      }
    } catch { /* stats are garnish */ }
  } else {
    status.textContent = "sync your crawler across devices:";
    show("m-signin-discord", providers.includes("discord"));
    show("m-signin-google", providers.includes("google"));
    show("m-signout", false);
    show("m-forget", false);
  }
}
for (const [btn, prov] of [["m-signin-discord", "discord"], ["m-signin-google", "google"]] as const) {
  document.getElementById(btn)!.addEventListener("click", () => beginSignIn(prov));
}
document.getElementById("m-signout")!.addEventListener("click", () => {
  // Full sign-out (shared computers): the identity chip AND the token go.
  try { localStorage.removeItem(SIGNIN_KEY); localStorage.removeItem("dcc:token:v1"); } catch { /* ok */ }
  void initAccountUi();
});
document.getElementById("m-forget")!.addEventListener("click", () => {
  if (!confirm("Delete your account? Cross-device saves, identities, and career stats are erased from the server. Local progress stays on this device.")) return;
  void fetch(`${API_BASE}/auth/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The crawler name rides along so the deletion can reach the retired
    // name-keyed JSON boards: those rows predate accounts, so for a crawler
    // with no sealed run this browser is the only thing that knows the link.
    body: JSON.stringify({ token: ensureToken(), names: [crawlerName()] }),
  }).catch(() => { /* best-effort */ });
  try { localStorage.removeItem(SIGNIN_KEY); localStorage.removeItem("dcc:token:v1"); } catch { /* ok */ }
  void initAccountUi();
});
void initAccountUi();

/**
 * The CAREER panel: personal bests + recent EPISODES, from the local ledger.
 *
 * "Season" is load-bearing in a competitive layer and it was doing three jobs:
 * the 6-8 week ladder period, one run, and this list. It now means exactly one
 * thing - the ladder period. A single run is an EPISODE, which fits the game
 * show fiction better than "season" ever did anyway.
 */
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
    `${bests.runs} episode${bests.runs === 1 ? "" : "s"} · ${bests.wins} escape${bests.wins === 1 ? "" : "s"}`;
  document.getElementById("m-career-bests")!.innerHTML =
    `<div class="best"><b>${bests.bestFloor}</b><small>BEST FLOOR</small></div>` +
    `<div class="best"><b>${bests.fastestClearSec !== null ? fmt(bests.fastestClearSec) : "—"}</b><small>FASTEST CLEAR</small></div>` +
    `<div class="best"><b>${bests.mostKills.toLocaleString()}</b><small>MOST KILLS</small></div>` +
    `<div class="best"><b>${bests.peakViewers.toLocaleString()}</b><small>PEAK VIEWERS</small></div>`;
  document.getElementById("m-career-list")!.innerHTML = history.slice(0, 5).map((r) =>
    `<li><span class="rank">${r.mode === "daily" ? "◆" : "·"}</span>` +
    `<span class="nm">${r.won ? "ESCAPED" : `floor ${r.floor}`}</span>` +
    `<span class="res${r.won ? " win" : ""}">${r.won ? fmt(r.timeSec) : `lvl ${r.level} · ${social.count(r.kills, "kill")}`}</span></li>`,
  ).join("");
}

function openMenu(): void {
  menuOpen = true;
  input.captureMode = true; // typing a name must not fire game binds
  menuEl.style.display = "flex";
  document.body.classList.add("checkin"); // hide the game HUD behind the campfire
  // The campfire owns the canvas while checked in (frame() renders it).
  if (!charSelect) {
    charSelect = renderer.createCharSelect(chosenSkin);
    charSelect.onSelect = applySkinPick;
    // Debug/verify hook (harmless in prod: enumerable state only).
    (window as unknown as Record<string, unknown>).__charSelect = charSelect;
  }
  charSelect.enabled = true;
  applySkinPick(chosenSkin); // seed the label
  const cont = document.getElementById("m-continue")!;
  if (hasContinue) {
    const p = state.players[0];
    cont.style.display = "";
    document.getElementById("m-continue-sub")!.textContent =
      `${p.name} · floor ${state.floor} · level ${p.level} — right where you left it`;
    if (p.name) nameInput.value = p.name;
  }
  // ROAM card: a live campaign turns the poster into its save slot — floor,
  // open contracts, the campfire still lit. Clicking it RESUMES (see handler).
  {
    const roamTile = document.getElementById("m-roam-solo")!;
    const roamCampaign = hasContinue && state.runKind === "roam";
    roamTile.classList.toggle("continues", roamCampaign);
    if (roamCampaign) {
      const p = state.players[0];
      const open = state.quests.filter((q) => q.state === "active").length;
      const settled = state.quests.filter((q) => q.state === "complete").length;
      const bits = [`floor ${state.floor}`, `level ${p.level}`];
      if (open > 0) bits.push(`${open} contract${open === 1 ? "" : "s"} open`);
      if (settled > 0) bits.push(`${settled} settled`);
      document.getElementById("m-roam-title")!.textContent = "ROAM — CAMPAIGN CONTINUES";
      document.getElementById("m-roam-sub")!.textContent = `${bits.join(" · ")} — the campfire is still lit`;
      cont.style.display = "none"; // one resume affordance: the campaign card IS the save
    } else {
      document.getElementById("m-roam-title")!.textContent = "ROAM";
      document.getElementById("m-roam-sub")!.textContent =
        "no clock — settlements, residents, contracts · solo campaign";
    }
  }
  document.getElementById("m-board-day")!.textContent = challengeDay ?? dayFromMs(Date.now());
  void refreshBoard();
  renderCareer();
}
function closeMenu(): void {
  menuOpen = false;
  input.captureMode = false;
  menuEl.style.display = "none";
  menuEl.classList.remove("casting"); // next open starts back at the panel
  document.body.classList.remove("checkin");
  if (charSelect) {
    charSelect.enabled = false;
    charSelect.mode = "backdrop";
  }
}

// CONTINUE resumes an existing character — no casting call, they already are
// somebody. Every NEW run routes through the campfire pick first.
document.getElementById("m-continue")!.addEventListener("click", () => closeMenu());
document.getElementById("m-daily")!.addEventListener("click", () =>
  // ONE DOOR, AND IT SIGNS FOR THE CONTRACT. This is the same run the
  // STANDINGS' ENTER THE CONTRACT starts, so it takes the same ticket.
  enterCasting("DAILY CRAWL", () => { void enterDailyContract(challengeDay); }));
// Challenge links re-dress the card; a live streak decorates the subtitle.
{
  const sub = document.getElementById("m-daily-sub")!;
  if (challengeDay) {
    const by = (params.get("by") ?? "a rival crawler").slice(0, 24);
    const floorN = Math.max(1, Math.min(99, Number(params.get("floor")) || 0));
    const t = Number(params.get("t")) || 0;
    const feat = params.get("won") === "1" && t > 0
      ? `cleared it in ${fmt(t)}`
      : floorN > 0 ? `reached floor ${floorN}` : "laid down a run";
    sub.textContent = `${by} ${feat} on ${challengeDay} — same dungeon, beat it`;
    document.querySelector("#m-daily b")!.textContent = "ACCEPT CHALLENGE";
  } else {
    const streak = currentStreak();
    if (streak > 0) sub.textContent = `${sub.textContent} · your streak: ${streak} day${streak === 1 ? "" : "s"}`;
  }
}
document.getElementById("m-solo")!.addEventListener("click", () =>
  enterCasting("NEW RUN", () => startRun({ kind: "random" })));

// ROAM (SETTLEMENTS.md) is solo-only for now: settlements, residents, and the
// contract board, no daily/party/rivals/test yet. With a live Roam save the
// card IS the save slot — clicking resumes the campaign (no casting call:
// like CONTINUE, that crawler already exists). Otherwise it starts one.
document.getElementById("m-roam-solo")!.addEventListener("click", () => {
  if (hasContinue && state.runKind === "roam") { closeMenu(); return; }
  enterCasting("ROAM", () => startRun({ kind: "random" }, "roam"));
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

// ---- Party friction (launch polish #7): links beat codes ----
// A join URL carries everything but the NAME (each crawler picks their own at
// check-in). Clipboard API needs a secure context (prod + localhost are);
// the legacy path covers anything else.
function inviteUrl(code: string, rivals: boolean): string {
  const q = new URLSearchParams({ join: code });
  if (rivals) q.set("rivals", "1");
  if (roamMode) q.set("roam", "1");
  return `${location.origin}${location.pathname}?${q}`;
}
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
/** Copy an invite and flash the button so the click visibly DID something. */
function wireInvite(btnId: string, input: HTMLInputElement, rivals: boolean): void {
  const btn = document.getElementById(btnId)!;
  btn.addEventListener("click", async () => {
    if (!input.value.trim()) input.value = rollCode();
    const code = input.value.trim().toUpperCase().slice(0, 32);
    const ok = await copyText(inviteUrl(code, rivals));
    const label = btn.textContent;
    btn.textContent = ok ? "COPIED" : "COPY FAILED";
    setTimeout(() => { btn.textContent = label; }, 1400);
  });
}

// One-tap rejoin: remember the last party this browser sat in (a week keeps
// weekend groups alive without resurrecting ancient codes forever).
const LASTPARTY_KEY = "dcc:lastparty:v1";
function rememberParty(): void {
  try {
    localStorage.setItem(LASTPARTY_KEY, JSON.stringify({ code: joinCode, rivals: rivalsMode, roam: roamMode, at: Date.now() }));
  } catch { /* best-effort */ }
}
function offerRejoin(): void {
  try {
    const raw = localStorage.getItem(LASTPARTY_KEY);
    if (!raw || net) return; // already in a party: nothing to offer
    const last = JSON.parse(raw) as { code: string; rivals: boolean; roam?: boolean; at: number };
    if (!last.code || Date.now() - last.at > 7 * 86400_000) return;
    const btn = document.getElementById("m-rejoin")!;
    document.getElementById("m-rejoin-code")!.textContent = last.code.slice(0, 12);
    document.getElementById("m-rejoin-sub")!.textContent = last.rivals
      ? "the race is still live — your rivals kept descending"
      : last.roam ? "your Roam campaign kept the campfire lit" : "your party is still out there";
    btn.style.display = "";
    btn.addEventListener("click", () => {
      enterCasting(`${last.rivals ? "RIVALS" : "PARTY"} ${last.code}`, () => {
        const q = new URLSearchParams({ join: last.code, name: crawlerName() });
        if (last.rivals) q.set("rivals", "1");
        if (last.roam) q.set("roam", "1");
        location.href = `${location.pathname}?${q}`;
      });
    });
  } catch { /* best-effort */ }
}
offerRejoin();
document.getElementById("m-party")!.addEventListener("click", () => {
  const form = document.getElementById("m-party-form")!;
  const opening = form.style.display === "none";
  form.style.display = opening ? "flex" : "none";
  if (opening && !codeInput.value) codeInput.value = rollCode();
  if (opening) showPartyTab("code"); // always reopen on the default tab
});
document.getElementById("m-roll")!.addEventListener("click", () => { codeInput.value = rollCode(); });
wireInvite("m-invite", codeInput, false);
document.getElementById("m-join")!.addEventListener("click", () => {
  const code = codeInput.value.trim().toUpperCase().slice(0, 32);
  if (!code) { codeInput.focus(); return; }
  // Pick your look BEFORE the page navigates into the party (netClient sends
  // the stored skin with the join).
  enterCasting(`PARTY ${code}`, () => {
    location.href = `${location.pathname}?join=${encodeURIComponent(code)}&name=${encodeURIComponent(crawlerName())}`;
  });
});

// Party tile, two paths to the same intent: share a code, or browse open
// ones (GET /open-parties) — a tab switch inside ONE tile, not a second
// sibling mode card (that's the mistake this replaces).
function showPartyTab(tab: "code" | "open"): void {
  document.getElementById("m-party-tab-code")!.classList.toggle("active", tab === "code");
  document.getElementById("m-party-tab-open")!.classList.toggle("active", tab === "open");
  document.getElementById("m-party-tab-code-body")!.style.display = tab === "code" ? "flex" : "none";
  document.getElementById("m-party-tab-open-body")!.style.display = tab === "open" ? "flex" : "none";
  if (tab === "open") void refreshOpenParties(); // lazy: don't fetch until the tab is actually opened
}
document.getElementById("m-party-tab-code")!.addEventListener("click", () => showPartyTab("code"));
document.getElementById("m-party-tab-open")!.addEventListener("click", () => showPartyTab("open"));
async function refreshOpenParties(): Promise<void> {
  const list = document.getElementById("m-open-list")!;
  try {
    const r = await fetch(`${API_BASE}/open-parties`);
    if (!r.ok) throw new Error(String(r.status));
    const parties = (await r.json()) as { code: string; players: number; cap: number; floor: number }[];
    list.innerHTML = parties.length
      ? parties.map(() => `<li><span class="cd"></span><span class="meta"></span></li>`).join("")
      : '<li class="none">no open parties right now — be the first</li>';
    // Codes are player-supplied (a Quick-Join host can mint any string) and
    // now shown to strangers for the first time — same textContent-not-
    // interpolated guard refreshBoard() uses for player names, just for codes.
    list.querySelectorAll("li").forEach((li, i) => {
      const p = parties[i];
      li.querySelector(".cd")!.textContent = p.code;
      li.querySelector(".meta")!.textContent = `${p.players}/${p.cap} · floor ${p.floor}`;
      li.addEventListener("click", () => enterCasting(`PARTY ${p.code}`, () => {
        location.href = `${location.pathname}?join=${encodeURIComponent(p.code)}&name=${encodeURIComponent(crawlerName())}`;
      }));
    });
  } catch {
    list.innerHTML = '<li class="none">couldn\'t reach the party list</li>';
  }
}
document.getElementById("m-quickjoin-host")!.addEventListener("click", () => {
  const code = rollCode();
  enterCasting(`PARTY ${code}`, () => {
    location.href = `${location.pathname}?join=${encodeURIComponent(code)}&name=${encodeURIComponent(crawlerName())}&public=1`;
  });
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
wireInvite("m-rinvite", rivalCodeInput, true);
document.getElementById("m-rivals")!.addEventListener("click", () => {
  const code = rivalCodeInput.value.trim().toUpperCase().slice(0, 32);
  if (!code) { rivalCodeInput.focus(); return; }
  enterCasting(`RIVALS ${code}`, () => {
    location.href = `${location.pathname}?rivals=1&join=${encodeURIComponent(code)}&name=${encodeURIComponent(crawlerName())}`;
  });
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

// ---- Icon integrity net (AAA r3 major): every drawn icon is a CSS mask, and
// a mask whose fetch fails renders as NOTHING (Blink treats a failed mask as
// fully transparent) — a blank tile with a price tag under it. Each distinct
// icon URL is probed ONCE via an Image (shares the HTTP cache; also catches a
// dev server answering a missing file with SPA-fallback HTML, which decodes
// as a broken image). Only a CONFIRMED failure touches any style — every bad
// mask is swapped for an engraved diamond fallback glyph, so a missing sprite
// can never ship as a void. The success path changes nothing (no repaint
// churn: under software raster a late mask swap can blank icons at capture).
const FALLBACK_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2 L20 12 L12 22 L4 12 Z M12 6.2 L7.4 12 L12 17.8 L16.6 12 Z' fill='%23000' fill-rule='evenodd'/%3E%3C/svg%3E\")";
const maskUrlRe = /url\("?([^")]+)"?\)/;
const maskProbe = new Map<string, "pending" | "ok" | "bad">();
function applyMaskFallback(el: HTMLElement): void {
  el.style.setProperty("mask-image", FALLBACK_MASK);
  el.style.setProperty("-webkit-mask-image", FALLBACK_MASK);
}
function swapBadMasks(url: string): void {
  document.querySelectorAll<HTMLElement>("[style*=\"mask-image\"]").forEach((el) => {
    const m = maskUrlRe.exec(el.style.getPropertyValue("mask-image"));
    if (m && m[1] === url) applyMaskFallback(el);
  });
}
function armIconMask(el: HTMLElement): void {
  const m = maskUrlRe.exec(el.style.getPropertyValue("mask-image"));
  if (!m || m[1].startsWith("data:") || m[1].startsWith("blob:")) return;
  const url = m[1];
  const known = maskProbe.get(url);
  if (known === "bad") { applyMaskFallback(el); return; }
  if (known) return;
  maskProbe.set(url, "pending");
  const img = new Image();
  img.onload = () => maskProbe.set(url, "ok");
  img.onerror = () => { maskProbe.set(url, "bad"); swapBadMasks(url); };
  img.src = url;
}
new MutationObserver((muts) => {
  for (const mu of muts) {
    mu.addedNodes.forEach((n) => {
      if (!(n instanceof HTMLElement)) return;
      if (maskUrlRe.test(n.style.getPropertyValue("mask-image"))) armIconMask(n);
      n.querySelectorAll<HTMLElement>("[style*=\"mask-image\"]").forEach(armIconMask);
    });
  }
}).observe(document.body, { childList: true, subtree: true });
document.querySelectorAll<HTMLElement>("[style*=\"mask-image\"]").forEach(armIconMask);

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
const LOG_MAX = 3; // HUD chrome caps at three lines (render critic r2)
const LOG_HOLD_MS = 5000;

/** The log frame only shows chrome while it has content (audit r2: no bare
 *  wireframe box bottom-left during combat). Lines mid-fade-out don't count —
 *  the chrome fades WITH the last line, not 350ms after it. */
function updateLogChrome(): void {
  const liveLines = [...hudLogFeed.children]
    .filter((c) => !(c as HTMLElement).dataset.dying).length;
  hudLog.classList.toggle("live", liveLines > 0 || hudLogStatus.innerHTML !== "");
}

function fadeOutLogLine(el: HTMLElement): void {
  el.classList.remove("show");
  el.dataset.dying = "1";
  updateLogChrome();
  setTimeout(() => { el.remove(); updateLogChrome(); }, 350);
}

function pushLogLine(text: string): void {
  log.push(text);
  // The ringside title card owns the boss-intro moment — no third echo in the
  // visible feed (the line stays in the archive `log` array).
  if (text.includes("RINGSIDE INTRODUCTION")) return;
  // COURTESY EXPLANATIONs own the top-left tutorial card — echoing the same
  // paragraph into the visible feed doubles UI noise during play (r4 major:
  // one canonical surface per system message). The archive keeps the line.
  if (text.startsWith("COURTESY EXPLANATION")) return;
  const el = document.createElement("div");
  el.className = "log-line fresh";
  el.textContent = text;
  hudLogFeed.appendChild(el);
  updateLogChrome();
  if (hudLogFeed.children.length > LOG_MAX) fadeOutLogLine(hudLogFeed.firstElementChild as HTMLElement);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => el.classList.remove("fresh"), 900);
  setTimeout(() => fadeOutLogLine(el), LOG_HOLD_MS);
}

function clearLogFeed(): void {
  hudLogFeed.innerHTML = "";
  updateLogChrome();
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
/**
 * The screen grade belongs to BULLET TIME and nothing else. A run-end variant
 * (grayscale 0.66, brightness 0.6, held for as long as the verdict was up) was
 * added and reverted: with the scrim already at 82% it drained the dungeon to
 * near-black, so the world the player had just been fighting in stopped
 * existing behind the card.
 */
let gradeApplied = "";
function applyScreenGrade(): void {
  const want = btGradeOn ? "saturate(0.4) brightness(1.06) contrast(1.06)" : "";
  if (want === gradeApplied) return;
  gradeApplied = want;
  canvas.style.filter = want;
  btVignette.style.opacity = btGradeOn ? "1" : "0";
}
function updateBulletTimeGrade(s: GameState): void {
  const on = s.bulletTimeLeft > 0;
  if (on === btGradeOn) return;
  btGradeOn = on;
  applyScreenGrade();
}

const fxLayer = document.getElementById("fx")!;
const toastLayer = document.getElementById("toasts")!;
const minimap = document.getElementById("minimap") as HTMLCanvasElement;
const mmCtx = minimap.getContext("2d")!;
// The minimap USED to eat the movement thumb: it sits inside the left stick
// zone on a phone, and a stick gesture there dropped a party ping instead of
// walking (measured: 0.05 tiles of movement, pings 0 -> 1, every device). The
// ping moved to a world-zone long press, and the touch router now claims the
// minimap rectangle for the stick. Mouse play never had this binding.

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

// ---- Overlay motion (audit #3): fast 130-160ms scale/fade on panels.
// Opening is free — a display:none -> flex flip restarts the CSS panel-in
// animation (iso.html). Closing adds .closing for ~130ms before hiding; the
// timer is tracked so a rapid re-open never gets eaten by a stale close.
const overlayTimers = new Map<HTMLElement, number>();
/**
 * A PANEL OPENED ON TOP OF ANOTHER PANEL MUST BE ON TOP OF IT.
 *
 * Measured on an iPhone 13 and an iPad Pro 11: with `#saferoom` up and
 * `#sheet` opened over it, the sheet's own 46x46 ✕ at (653,54) was tapped with
 * real touch and the sheet stayed open — while the same control closes the
 * same panel from a clean playing state. The cause is one authored number:
 * `#sheet` is z 20 and `#saferoom` is z 24, so the "stacked" panel opened
 * UNDERNEATH the shop and every tap on it landed on the shop's scrim. Checking
 * your sheet before you buy is the normal case in a safe room, not an edge.
 *
 * The repair is not a bigger constant — that is how the stack got authored by
 * hand in the first place, and the next panel would collide again. Opening
 * raises the panel above whatever is already visible, once, on the open path
 * every panel already goes through. `#rotate` (z 40) is deliberately excluded:
 * the orientation gate outranks everything, by design.
 */
const STACK_CEILING = 39; // one below #rotate, which must stay on top
function raiseAboveOpenOverlays(el: HTMLElement): void {
  let top = 0;
  for (const other of document.querySelectorAll<HTMLElement>('[data-overlay="modal"]')) {
    if (other === el) continue;
    if (other.style.display === "none" || other.classList.contains("closing")) continue;
    if (other.offsetWidth === 0 && other.offsetHeight === 0) continue;
    const z = Number.parseInt(getComputedStyle(other).zIndex, 10);
    if (Number.isFinite(z)) top = Math.max(top, z);
  }
  const own = Number.parseInt(getComputedStyle(el).zIndex, 10);
  // Only ever a PROMOTION, and only when something is genuinely above us: a
  // panel that opens alone keeps its authored place in the screen-zone map.
  if (top > 0 && (!Number.isFinite(own) || own <= top)) {
    el.style.zIndex = String(Math.min(STACK_CEILING, top + 1));
  }
}

function showOverlay(el: HTMLElement): void {
  const t = overlayTimers.get(el);
  if (t !== undefined) { clearTimeout(t); overlayTimers.delete(el); }
  el.classList.remove("closing");
  el.style.display = "flex";
  raiseAboveOpenOverlays(el);
}
function hideOverlay(el: HTMLElement): void {
  if (el.style.display === "none" || overlayTimers.has(el)) return;
  el.classList.add("closing");
  overlayTimers.set(el, window.setTimeout(() => {
    overlayTimers.delete(el);
    el.classList.remove("closing");
    el.style.display = "none";
    // Back to the authored z the moment it is gone, so the promotion cannot
    // accumulate across a session and quietly re-order the whole map.
    el.style.zIndex = "";
  }, 130));
}

// Modal focus (AAA r3 blocker): while ANY full-screen panel is open, the
// transient HUD chatter (log feed, toasts, tutorial cards, headline banners)
// is fully suppressed — nothing readable may bleed behind a modal scrim.
// A style-attribute observer catches every open/close path (showOverlay,
// direct display writes, net snapshot toggles) without touching call sites.
//
// THE ID LIST IS DELETED (MOBILE.md 2.9a). It was a hand-maintained list of
// nine element ids and it missed six live surfaces — #ladder, #career,
// #consent, #loading, #recap-tab and #rotate, the one overlay that
// deliberately outranks everything. Overlays now DECLARE themselves in the
// markup with `data-overlay`, and test/panels.test.ts reads the screen-zone
// map and fails on any z >= 20 overlay that has not: a new panel is either
// registered or red.
//
// This block only writes `body.modal`. The touch layer's suspend authority
// observes that class and nothing else (touchShell.bindAuthority).
{
  const modalEls = [...document.querySelectorAll<HTMLElement>('[data-overlay="modal"]')];
  const visible = (el: HTMLElement): boolean => {
    // `.closing` is the 130ms fade-out; `.done` is SIGNAL ACQUISITION retiring.
    if (el.classList.contains("closing") || el.classList.contains("done")) return false;
    const st = el.style.display;
    if (st === "none") return false;
    if (st !== "") return true;
    // Overlays whose visibility is driven by a body class (#mapbig-scrim) have
    // no inline style to read. Reading a box is a layout, so it happens here,
    // on a mutation, and never per frame.
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    // THE RETIRED-OVERLAY IDIOM, and the reason this predicate is not just a
    // display check. `#loading.done` sets `opacity: 0; pointer-events: none`
    // and NEVER leaves the layout — measured on iPad Pro 11, that pinned
    // body.modal on forever and killed the whole touch layer after boot
    // (tools/_mobile/i3.log: the stick finger "landed on DIV#loading").
    // Opacity alone is not the test — lesson 4 in §0 is that a modal mid-fade
    // reads as absent — so both halves have to hold.
    if (cs.pointerEvents === "none" && parseFloat(cs.opacity) === 0) return false;
    return el.offsetWidth > 0 || el.offsetHeight > 0;
  };
  let wasModal: boolean | null = null;
  const syncModal = (): void => {
    const open = modalEls.some(visible);
    // Only WRITE on a change: the observer below watches body's own class
    // list, and re-setting the attribute would feed itself forever.
    if (open === wasModal) return;
    wasModal = open;
    document.body.classList.toggle("modal", open);
  };
  const modalObserver = new MutationObserver(syncModal);
  for (const el of modalEls) {
    modalObserver.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
  }
  // body.mapbig drives #mapbig-scrim from CSS, so the body's own class list is
  // part of the signal.
  modalObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  syncModal();
}

function openDraftModal(): void {
  renderDraft(state);
  showOverlay(draftEl);
}

function dismissDraftModal(): void {
  hideOverlay(draftEl);
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
const bbGhost = document.getElementById("bb-ghost") as HTMLElement;
const bbPips = document.getElementById("bb-pips")!;
// ---- BOSSES V2 §5.3 plate rows: mutators, shield pool, plates, live beat.
const bbMuts = document.getElementById("bb-muts")!;
const bbShield = document.getElementById("bb-shield") as HTMLElement;
const bbShieldFill = document.getElementById("bb-shield-fill") as HTMLElement;
const bbShieldTag = document.getElementById("bb-shield-tag")!;
const bbPlates = document.getElementById("bb-plates")!;
const bbBeat = document.getElementById("bb-beat")!;
const bossCallEl = document.getElementById("bosscall")!;
const bcWord = document.getElementById("bc-word")!;
const bcSub = document.getElementById("bc-sub")!;
const bossintroEl = document.getElementById("bossintro")!;
const hypeRowEl = document.querySelector<HTMLElement>("#show .hyperow");
const letterboxEl = document.getElementById("letterbox")!;
const bossSpotEl = document.getElementById("bossspot")!;
const biName = document.getElementById("bi-name")!;
const biAffix = document.getElementById("bi-affix")!;
const biKicker = document.getElementById("bi-kicker")!;
const biEpithet = document.getElementById("bi-epithet")!;
const biMuts = document.getElementById("bi-muts")!;
const biLine = document.getElementById("bi-line")!;
let introShownFor = -1;
// Broadcast cut: while the letterbox rides the title card, ALL HUD chrome +
// minimap leave the frame entirely (r2: no half-dimmed panels under a
// cinematic). body.cine gates it in CSS.
//
// r3 BLOCKER — the cut used to end on a 3.5s wall-clock timeout while the card
// it belongs to faded on a 3s CSS animation, and the ringside freeze under
// BOTH of them runs on the sim's encounter timer. On any client slower than
// the animation the marquee beat of the encounter was simply gone: eight of
// eighteen capture intros had no card at all, several with the full HUD back
// up and the boss clipped behind the Hype bar. The cut now begins and ends
// with `state.encounter`, and the card's opacity is driven from the same
// timer (see setIntroFade), so the beat holds exactly as long as the sim says.
function enterCine(): void {
  document.body.classList.add("cine");
}
function exitCine(): void {
  document.body.classList.remove("cine");
  document.documentElement.style.removeProperty("--bi-fade");
}
/**
 * The card / letterbox / key-light opacity, from the sim's own ringside clock.
 * Full for the body of the freeze, then a half-second fall-off on the way out —
 * the same shape the CSS used to draw, on a clock that cannot outrun the beat.
 */
function setIntroFade(timeLeft: number): void {
  // A capture HOLD pins the beat wide open (see __dcc.hold): the review's fix
  // for a harness that was racing a 3s animation with a 20s shutter.
  const fade = hudNow < captureHold ? 1 : Math.max(0, Math.min(1, timeLeft / 0.5));
  document.documentElement.style.setProperty("--bi-fade", fade.toFixed(3));
}
/**
 * CAPTURE HOLD (r3 blocker, the harness half). Every boss beat now expires on
 * the frame clock, which a capture harness can freeze — but a SwiftShader
 * shutter still takes 12-21 seconds of wall time, during which the page keeps
 * presenting frames. `__dcc.hold(seconds)` pushes every live beat deadline out
 * past the shutter so the frame that gets composited is the frame that was
 * staged. It changes no sim state and invents no beat: it only refuses to let
 * one END while the camera is open.
 */
let captureHold = 0;
// Damage-lag ghost on the boss bar (audit #6): white trail that holds a beat,
// then chases the live fill. Reset per engaged target.
let bossGhostFor = -1;
let bossGhost = 1;
let bossGhostHold = 0;
let bossPrevFrac = 1;
let bossPipKey = "";
let bossLastNow = 0;
// BOSSES V2: the live-beat line under the plate — what the boss is DOING right
// now, in its own words. A named signature owns it for its windup; the punish
// window owns it outright and outranks anything already showing. (The REDACTED
// mutator's "next move" ticker is a System ANNOUNCEMENT, not a boss event, so
// it rides the announcement channel and never fights this line for the space.)
let bossBeatUntil = 0;
let bossBeatKey = "";
/**
 * The RENDER clock, stamped at the top of every frame. The boss beat line and
 * the call-out both expire against this rather than performance.now(), for the
 * same reason every CSS animation in the game runs off the frame clock: a beat
 * should last N frames' worth of presented time, not N seconds of wall time
 * that may include a stall. (It also means a capture harness that freezes the
 * frame clock gets a beat that actually holds still while it composites —
 * round 2 lost several call-outs to a multi-second screenshot.)
 */
let hudNow = 0;
// Cache keys so the plate's HTML rows only rebuild when their content moves —
// this runs every frame, next to a fight.
let bossMutKey = "";
let bossPlateKey = "";

/**
 * BOSSES V2 §5.3 — post a beat to the boss plate's live line. `strong` is the
 * punish window: bigger, hotter, and it outranks anything already showing,
 * because §7.4 calls it the one beat that most needs to read.
 */
// ---- THE CALL-OUT ---------------------------------------------------------
// §7.4 calls the punish window "the one beat that most needs to read", and the
// capture round found it rendered as a dim grey line INSIDE the boss panel,
// clipped by the panel's own bottom edge. The three beats the fight most needs
// the player to see — the punish window, the intermission, and a phase edge
// the PLAYER caused — get their own centre-screen layer at announcement
// contrast. The plate's beat line keeps the running commentary; this layer
// keeps the moments, and it is never underneath any panel.
let bossCallUntil = 0;
/**
 * CALL-OUT RANK (r3 blocker). Three beats share this layer and they are not
 * equal: a capture caught two shots of the PUNISH window showing the phase
 * call-out instead, because a phase edge crossed while the window was live and
 * `postBossCall` overwrote it unconditionally. The punish window is the beat
 * §7.4 says most needs to read and it lasts two seconds; a phase edge will
 * still be true a moment later. So the layer is ranked, and a live higher rank
 * refuses to be clobbered by a lower one.
 */
const CALL_RANK = { phase: 1, intermission: 2, punish: 3, defeat: 4 } as const;
type CallRank = keyof typeof CALL_RANK;
let bossCallRank = 0;
/** Minimum hold for a call-out. A headline beat that is gone inside two
 *  seconds is a beat the player blinked past — these three are the moments the
 *  fight is FOR, so they get a full read even when the sim's own window
 *  (a 2.2s punish) is shorter than one. */
const CALL_MIN_SECONDS = 3;
function postBossCall(
  word: string, sub: string, seconds: number, cool = false, rank: CallRank = "phase",
): void {
  const want = CALL_RANK[rank];
  // A live call-out of equal-or-higher rank keeps the layer. Same rank always
  // re-posts (a second punish window is a new moment, not a duplicate).
  if (bossCallUntil > hudNow && bossCallRank > want) return;
  bossCallRank = want;
  bossCallUntil = hudNow + Math.max(seconds, CALL_MIN_SECONDS) * 1000;
  bcWord.textContent = word;
  bcSub.textContent = sub;
  bossCallEl.classList.toggle("cool", cool);
  bossCallEl.classList.remove("on");
  void (bossCallEl as HTMLElement).offsetWidth; // restart the punch
  bossCallEl.classList.add("on");
}

function postBossBeat(text: string, seconds: number, strong = false): void {
  const now = hudNow;
  if (!strong && now < bossBeatUntil && bossBeatKey === "punish") return;
  bossBeatKey = strong ? "punish" : text;
  bossBeatUntil = now + seconds * 1000;
  bbBeat.textContent = text;
  bbBeat.classList.toggle("punish", strong);
  bbBeat.classList.remove("pop");
  void bbBeat.offsetWidth; // restart the pop
  bbBeat.classList.add("pop");
}

// ---- §5.7 THE LOOT PAYOFF -------------------------------------------------
// "The sigil, glyph and any TITLE BELT unique must land ringside in a readable
// arc rather than under the body where they are missed." The sim owns where
// loot lands (coop authority, save/resume, determinism) — so the host owns the
// READ instead: for a couple of seconds after a boss falls, every fresh drop
// near the corpse gets a rarity-colored arc thrown to it from the body and a
// lit landing spot. The eye follows the arc out, which is the whole point.
let payoffAt: { x: number; y: number; until: number } | null = null;
const payoffSeen = new Set<number>();
/**
 * While this is in the future the kill beat owns the frame: combat numerals are
 * suppressed so the corpse, the twin sweeps and the ringside arcs are the whole
 * image (r3 blocker — the kill captures were a pile of numerals over an empty
 * floor, with no visible loot at all).
 */
let killBeatUntil = 0;
const PAYOFF_HUE: Record<string, number> = {
  common: 0xc9c9d4, magic: 0x5a9bff, rare: 0xf2c14e, epic: 0xb98bff,
};

function stageBossPayoff(s: GameState, events: BossEvent[]): void {
  for (const e of events) {
    if (e.kind === "phase" && e.label === "DEFEATED" && e.pos) {
      // On the FRAME CLOCK, like every other boss beat. On the wall clock the
      // window could expire before a slow client had even presented the frame
      // the boss died on, which is why the capture round found real drops in
      // the log (54, 27, 25 items) and not one arc on screen.
      payoffAt = { x: e.pos.x, y: e.pos.y, until: hudNow + 3200 };
      payoffSeen.clear();
    }
  }
  if (!payoffAt) return;
  if (hudNow > payoffAt.until) { payoffAt = null; return; }
  for (const l of s.loot) {
    if (payoffSeen.has(l.id)) continue;
    const dx = l.pos.x - payoffAt.x, dy = l.pos.y - payoffAt.y;
    if (dx * dx + dy * dy > 36) continue; // not this boss's payout
    payoffSeen.add(l.id);
    const hue = l.kind === "material" ? 0xffd98a
      : l.kind === "tome" ? 0xb98bff
      : l.kind === "gold" ? 0xf2c14e
      : PAYOFF_HUE[l.rarity ?? "common"] ?? 0xc9c9d4;
    renderer.bossLootArc(payoffAt.x, payoffAt.y, l.pos.x, l.pos.y, hue);
  }
}

/**
 * §7.4 — route one frame of typed boss beats into the HUD. The renderer gets
 * the same buffer for world FX and the audio director gets it for stingers;
 * this half is only the chrome that has to say a WORD.
 */
function applyBossEvents(events: BossEvent[]): void {
  for (const e of events) {
    switch (e.kind) {
      case "telegraph":
        // A named signature holds the line for its own windup plus a beat, so
        // the label is still up while the thing it named is happening. The
        // label is half of why a fight has an identity; a line that has
        // already gone by the time the hazard lands names nothing.
        if (e.label) postBossBeat(e.label, Math.max(2.6, (e.duration ?? 0) + 1.6));
        break;
      case "punish":
        // The unload window. It owns the CALL-OUT layer outright, at
        // announcement contrast, outside every panel — the beat that most
        // needs to read is never printed under the furniture again.
        postBossCall("UNLOAD", e.label ?? "EXPOSED CORE", e.duration ?? 2.2, false, "punish");
        postBossBeat(e.label ? `${e.label} — UNLOAD` : "EXPOSED — UNLOAD",
          e.duration ?? 2.2, true);
        break;
      case "plate":
        postBossBeat(`${e.label ?? "PLATE"} BROKEN`, 1.8);
        break;
      case "shieldbreak":
        postBossBeat("SHIELD DOWN", 1.6);
        break;
      case "intermission":
        // COOL, so it can never be mistaken for the punish window's gold.
        postBossCall("THE COMMERCIAL BREAK", "THE BOARD IS BEING RE-DEALT",
          e.duration ?? 2, true, "intermission");
        postBossBeat("THE COMMERCIAL BREAK", e.duration ?? 2);
        break;
      case "prop":
        if (e.label) postBossBeat(`${e.label} FIRED`, 1.4);
        break;
      case "enrage":
        postBossBeat(`OVERTIME ×${e.value ?? 1}`, 1.8);
        break;
      case "phase":
        // A mechanic-triggered phase is the player's own doing (§2.2) and
        // must read louder than an HP gate ever does.
        if (e.label === "DEFEATED") {
          postBossCall("DEFEATED", "THE SEAL OPENS", 2.5, false, "defeat");
          postBossBeat("DEFEATED", 2.5, true);
          // THE KILL BEAT owns the frame (r3 blocker): for its duration the
          // floating damage numbers stand down, so the last image of the fight
          // is the corpse, the sweeps and the loot — not eight numerals, several
          // of them reading "0!", stacked over the body.
          killBeatUntil = hudNow + 2600;
        } else if (e.reason === "mechanic") {
          postBossCall("YOU DID THAT", `PHASE ${(e.phase ?? 0) + 1}`, 1.8, false, "phase");
          postBossBeat("YOU DID THAT", 1.8, true);
        } else postBossBeat(`PHASE ${(e.phase ?? 0) + 1}`, 1.4);
        break;
      default:
        break;
    }
  }
}

function updateBossBar(s: GameState): void {
  const p = me(s);
  const enc = s.encounter;
  // The call-out layer runs on its own clock and outside the plate, so it is
  // retired here rather than inside the plate's own bookkeeping (which
  // early-returns the moment nothing is engaged).
  if (bossCallUntil > 0 && hudNow > bossCallUntil) {
    bossCallUntil = 0;
    bossCallRank = 0;
    bossCallEl.classList.remove("on");
  }
  // ONE MARQUEE PER MOMENT (the rule the hype row already follows): during the
  // ringside freeze the NAME CARD owns the introduction, so the health plate
  // stays down until the fight actually starts. It was colliding with the
  // System's line over the card — and the plate has nothing to say yet anyway.
  if (enc) {
    if (introShownFor !== enc.monsterId) {
      introShownFor = enc.monsterId;
      dismissTutorialForTransition(); // the title card owns the screen now
      biName.textContent = enc.name;
      // ---- BOSSES V2 §5.3 — THE NAME CARD. Title, epithet, the fight's ASK,
      // this run's mutators, and the System's one line. The old card was a
      // name in a banner; §5.3's complaint was that a solid skeleton was
      // being under-dressed, and this is the dressing.
      const repeat = enc.repeat ?? 0;
      biKicker.textContent = repeat > 0
        ? `◆ WE HAVE MET ${repeat === 1 ? "ONCE" : `${repeat} TIMES`} ◆`
        : "◆ RINGSIDE INTRODUCTION ◆";
      biEpithet.textContent = enc.epithet ?? "";
      // The affix plate states the ASK when the sim gave us one: a boss whose
      // ask you cannot name in four words is a big monster with more HP.
      biAffix.textContent = enc.ask
        ? ASK_LABEL[enc.ask]
        : enc.affix
          ? `${enc.elite ? "ELITE — " : ""}${enc.affix.toUpperCase()}`
          : enc.kind === "boss" ? "BOSS" : "ELITE";
      if (enc.ask) {
        const pal = ASK_PAL[ASK_TO_FAMILY[enc.ask]];
        (biAffix as HTMLElement).style.color = `#${pal.core.toString(16).padStart(6, "0")}`;
        (biAffix as HTMLElement).style.borderColor = `#${pal.mid.toString(16).padStart(6, "0")}`;
      } else {
        (biAffix as HTMLElement).style.color = "";
        (biAffix as HTMLElement).style.borderColor = "";
      }
      // MUTATORS: the answer to "why is this run's version different?", with
      // the counterplay sentence on the tooltip. This is the whole variety
      // promise made visible at the one moment the player is reading.
      biMuts.innerHTML = (enc.mutators ?? []).map((m) => {
        const info = bossMutatorInfo(m);
        return `<i title="${esc(info.note)}">${esc(info.label)}</i>`;
      }).join("");
      biLine.textContent = enc.line ?? "";
      bossintroEl.classList.remove("show");
      letterboxEl.classList.remove("on");
      bossSpotEl.classList.remove("on");
      void (bossintroEl as HTMLElement).offsetWidth; // restart the scale-in
      bossintroEl.classList.add("show");
      letterboxEl.classList.add("on"); // broadcast cut: letterbox rides the card
      // Intro key light (r3 major): a warm radial lift projected at the star
      // of the introduction — the cut sells the monster, not a silhouette.
      const star = s.monsters.find((m) => m.id === enc.monsterId);
      if (star) {
        const sp = renderer.worldToScreen(star.pos.x, 1.1, star.pos.y);
        if (sp.visible) {
          bossSpotEl.style.left = `${sp.x}px`;
          bossSpotEl.style.top = `${sp.y}px`;
          bossSpotEl.classList.remove("on");
          void (bossSpotEl as HTMLElement).offsetWidth;
          bossSpotEl.classList.add("on");
        }
      }
      enterCine();
    }
    // The card, the letterbox and the key light all breathe on the SIM's
    // ringside clock now — not on a CSS animation racing the wall clock.
    setIntroFade(enc.timeLeft);
    // ...and the key light is measured, not declared: on a bright arena floor
    // (floor 9's forest was the case that broke) a screen-blended disc over the
    // boss is what saturates the silhouette it exists to reveal.
    document.documentElement.style.setProperty(
      "--bi-spot", renderer.bossExposureScale.toFixed(3));
  } else {
    bossintroEl.classList.remove("show");
    letterboxEl.classList.remove("on");
    bossSpotEl.classList.remove("on");
    exitCine();
  }
  // Engaged target: the nearest introduced, living boss/elite within range —
  // except that A BOSS ALWAYS OUTRANKS AN ELITE. A capture caught the
  // Pollinator's fight plate titled THE ENTOURAGE with no phase pips, no ask
  // and no mutator row: the ENTOURAGED mutator's champion escort had walked a
  // step closer than the boss, and "nearest" handed it the marquee. The boss
  // is the encounter; the escort is furniture in it.
  let target: GameState["monsters"][number] | null = null;
  let best = 16;
  let bestIsBoss = false;
  for (const m of s.monsters) {
    if ((m.kind !== "boss" && !m.elite) || !m.introduced || m.hp <= 0) continue;
    const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
    if (d >= 16) continue;
    const isBoss = m.kind === "boss";
    if (bestIsBoss && !isBoss) continue;
    if (isBoss && !bestIsBoss) { best = d; target = m; bestIsBoss = true; continue; }
    if (d < best) { best = d; target = m; bestIsBoss = isBoss; }
  }
  // The boss plate SUPPRESSES the Hype row while it owns top-center (r6
  // major: the "Hype" label clipped behind the boss health plate) — one
  // marquee element per zone, never a stack.
  const hypeRow = hypeRowEl;
  if (!target || enc) {
    bossbarEl.style.display = "none";
    document.body.classList.remove("bossplate");
    if (hypeRow) { hypeRow.style.opacity = ""; hypeRow.style.visibility = ""; }
    bossGhostFor = -1;
    bbBeat.textContent = "";
    bossMutKey = bossPlateKey = "";
    return;
  }
  if (hypeRow) { hypeRow.style.opacity = "0"; hypeRow.style.visibility = "hidden"; }
  bossbarEl.style.display = "block";
  // The V2 plate is taller than the old one (mutators, shield rail, plate
  // chips, the live beat), so the System's headline band steps down out of
  // its way — two marquee elements must never share pixels.
  document.body.classList.add("bossplate");
  bbIcon.innerHTML = target.kind === "boss" ? uic("skull") : "◆";
  bbName.textContent = target.eliteName ?? "THE FLOOR BOSS";
  // Affix tag + status pips (5.11): the bar shows what the menace IS and what
  // the party has stuck to it (burn/poison/chill uptime at a glance).
  bbAffix.innerHTML = (target.affix ? target.affix.toUpperCase() + " " : "") + statusChips(target.statuses);
  const frac = Math.max(0, Math.min(1, target.hp / target.maxHp));
  const now = performance.now();
  const dt = bossLastNow > 0 ? Math.min(0.1, (now - bossLastNow) / 1000) : 0.016;
  bossLastNow = now;
  if (target.id !== bossGhostFor) {
    bossGhostFor = target.id;
    bossGhost = frac;
    bossPrevFrac = frac;
    bossGhostHold = 0;
  }
  if (frac < bossPrevFrac - 1e-4) bossGhostHold = 0.3; // fresh damage: hold, then trail
  bossPrevFrac = frac;
  if (bossGhost > frac + 1e-4) {
    if (bossGhostHold > 0) bossGhostHold -= dt;
    else bossGhost = Math.max(frac, bossGhost - dt * (0.3 + (bossGhost - frac) * 2.5));
  } else bossGhost = frac;
  bbFill.style.width = `${frac * 100}%`;
  bbGhost.style.width = `${bossGhost * 100}%`;
  // Phase pips + break notches: bosses enrage at 2/3 and 1/3 HP (sim config);
  // elites have no phases, so the ornament hides (.elite).
  const isBoss = target.kind === "boss";
  bossbarEl.classList.toggle("elite", !isBoss);
  // PHASE PIPS now mirror the REAL phase machine (§5.3): band bosses run 0..2,
  // the finales 0..3, and a mechanic-triggered edge fills a pip exactly like
  // an HP gate does — the player never has to know which kind moved it.
  const maxPhase = target.maxPhase ?? 2;
  const pipKey = isBoss ? `${target.id}:${target.phase ?? 0}:${maxPhase}` : "";
  if (pipKey !== bossPipKey) {
    bossPipKey = pipKey;
    bbPips.innerHTML = isBoss
      ? Array.from({ length: maxPhase + 1 },
        (_v, i) => `<i class="${i <= (target.phase ?? 0) ? "on" : ""}"></i>`).join("")
      : "";
  }

  // ---- BOSSES V2 plate rows ------------------------------------------------
  // MUTATORS (§4.2): what is different about this run's version of this boss.
  const mutKey = isBoss ? `${target.id}:${(target.bossMutators ?? []).join(",")}` : "";
  if (mutKey !== bossMutKey) {
    bossMutKey = mutKey;
    bbMuts.innerHTML = isBoss
      ? (target.bossMutators ?? []).map((m) => {
        const info = bossMutatorInfo(m);
        return `<i title="${esc(info.note)}">${esc(info.label)}</i>`;
      }).join("")
      : "";
  }
  // SHIELD POOL (V2): absorb-HP above the health bar, plus the SCHOOL LOCK
  // tag when only one school erodes it — The Sponsor's entire fight is
  // "find out which", so the answer belongs on the plate the moment it flips.
  const shieldMax = target.shieldMax ?? 0;
  const shieldOn = isBoss && shieldMax > 0 && (target.shieldHp ?? 0) > 0;
  bbShield.classList.toggle("on", shieldOn);
  if (shieldOn) {
    const sf = Math.max(0, Math.min(1, (target.shieldHp ?? 0) / shieldMax));
    bbShieldFill.style.width = `calc(${(sf * 100).toFixed(1)}% - 2px)`;
    bbShield.classList.toggle("school-magic", target.shieldSchool === "magic");
    bbShield.classList.toggle("school-physical", target.shieldSchool === "physical");
    bbShieldTag.textContent = target.shieldSchool
      ? `${target.shieldSchool.toUpperCase()} ONLY`
      : "";
  }
  // PLATES (V1): one chip per weak point. Broken chips STAY, struck through —
  // "three down, one to go" is the read, and a chip that vanishes loses it.
  const plates = isBoss ? target.plates ?? [] : [];
  const plateKey = plates.map((pl) =>
    `${pl.key}:${pl.broken ? "x" : Math.round((pl.hp / Math.max(1, pl.maxHp)) * 8)}`).join("|");
  if (plateKey !== bossPlateKey) {
    bossPlateKey = plateKey;
    bbPlates.innerHTML = plates.map((pl) => {
      const cls = [pl.broken ? "broken" : "", pl.school ? `school-${pl.school}` : ""]
        .filter(Boolean).join(" ");
      const title = pl.school
        ? `${pl.label} — immune to ${pl.school} damage`
        : `${pl.label} — a bonus objective, not a gate`;
      return `<i class="${cls}" title="${esc(title)}">${esc(pl.label)}</i>`;
    }).join("");
  }
  // ENRAGE + INTERMISSION read on the FRAME, not as another chip in the stack.
  bossbarEl.classList.toggle("enraged", (target.enrageStacks ?? 0) > 0);
  bossbarEl.classList.toggle("intermission", (target.invulnT ?? 0) > 0);
  // The live beat expires on its own clock (a punish window that has closed
  // must stop saying UNLOAD).
  if (bbBeat.textContent && hudNow > bossBeatUntil) {
    bbBeat.textContent = "";
    bbBeat.classList.remove("punish");
    bossBeatKey = "";
  }
  // The name plate names the DRAWN boss, not "THE FLOOR BOSS" — the audit's
  // most embarrassing finding was that the last boss in the game had no name.
  if (isBoss) {
    const pal = ASK_PAL[bossFamily(target.bossId)];
    (bbIcon as HTMLElement).style.color = `#${pal.mid.toString(16).padStart(6, "0")}`;
  } else {
    (bbIcon as HTMLElement).style.color = "";
  }
}

let shownFavVis: boolean | null = null;
let shownSponVis: boolean | null = null;
function updateShowHud(s: GameState): void {
  const p = me(s);
  const v = Math.round(p.viewers);
  // Crowd Frenzy: the viewer count burns gold while the buff is live.
  statViewers.style.color = p.frenzy ? "#f2c14e" : "";
  statViewers.textContent = v.toLocaleString();
  statFavorites.textContent = Math.floor(p.favorites).toLocaleString();
  statSponsors.textContent = String(p.sponsors);
  // Zero-value audience chips stay hidden until first earned.
  const favVis = Math.floor(p.favorites) > 0;
  if (favVis !== shownFavVis) {
    shownFavVis = favVis;
    (statFavorites.parentElement as HTMLElement).style.display = favVis ? "" : "none";
  }
  const sponVis = p.sponsors > 0;
  if (sponVis !== shownSponVis) {
    shownSponVis = sponVis;
    (statSponsors.parentElement as HTMLElement).style.display = sponVis ? "" : "none";
  }
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

// Sponsor gifts have no ability icon; a DRAWN mark in the plate carries the
// read (STYLEGUIDE.md rule three: icons are drawn, never typed — the old
// dingbat set read as emoji at a glance). All masks, tinted by --oc.
const coinIcon = `<i class="uic" style="mask-image:url(/icons/items/gold.svg);-webkit-mask-image:url(/icons/items/gold.svg)"></i>`;
const mic = (rel: string): string =>
  `<i class="uic" style="mask-image:url(/icons/${rel}.svg);-webkit-mask-image:url(/icons/${rel}.svg)"></i>`;
const REWARD_GLYPHS: Record<string, string> = {
  healFull: mic("stats/hp"), maxHp: mic("stats/hp"), damage: uic("party"),
  crit: mic("stats/crit"), armor: mic("stats/armor"), item: mic("items/mystery_box"),
  gold: coinIcon, bonusTime: mic("items/stabilizer_rod"), materials: "◆",
  favor: uic("star"), retrain: uic("retrain"),
  shrineBlood: mic("items/blood_subscription"), shrineGreed: coinIcon, shrineDecline: "—",
  revision: mic("items/landlords_ledger"), revisionDecline: "—",
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
    draftTitle.textContent = revision ? "◆ CLASS REVISION" : shrine ? "◆ SYSTEM SHRINE"
      : quest ? "◆ TRIBE BOUNTY" : "◆ SPONSOR DRAFT";
    draftHint.textContent = revision
      ? "The System offers a permanent recasting. Every role has a curse in the fine print. This offer is not repeated."
      : shrine
        ? "The shrine offers a bargain. Every deal has fine print — pick one, or walk."
        : quest
        ? "The settlement pays what it promised. Take one."
        : "Your sponsors reward a good show. Take one gift down — press its number or click.";
    draftCards.innerHTML = lp.pendingRewards
      .map((r, i) => {
        // V2 §2.1 on the gift card too: a catalog identity is named art with
        // quality gems; a commodity drop is its rolled rarity and nothing more.
        const tint = r.item ? ` style="--oc:${itemColor(r.item)}"`
          : r.glyph ? ` style="--oc:#b08fd9"` : "";
        const ribbon = r.item
          ? (isCatalog(r.item)
            ? `<span class="oribbon">${TIER_LABEL[CATALOG_BY_ID[r.item.catalogId!].tier].replace(/S$/, "")}</span>${qualityPipsHtml(r.item)}`
            : `<span class="oribbon">${r.item.rarity}</span>`)
          : r.glyph ? `<span class="oribbon">glyph</span>` : "";
        // Real art wherever there is real art: catalog gear, glyph stones.
        const art = r.item && r.item.catalogId
          ? `<img class="ii" src="/icons/painted/items/${r.item.catalogId}.svg" alt="">`
          : r.glyph ? glyphIconHtml(r.glyph)
          : `<span class="oglyph">${REWARD_GLYPHS[r.kind] ?? "◆"}</span>`;
        return (
          `<div class="reward" data-idx="${i}"${tint}>` +
          `<div class="oicon">${art}</div>` +
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
          r < u.nextRank ? (r >= max ? "✦" : "●") : "○").join("");
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

    // Recorded BESIDE the real call, in the same order, so the replay
    // reproduces the same world (COMPETITIVE.md MUST-3 host contract).
    if (p.pendingRewards.length > 0) { recAct("reward", idx); chooseReward(state, p.id, idx); }
    else { recAct("upgrade", idx); chooseUpgrade(state, p.id, idx); }
    draftsClaimed++;
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

/**
 * EQUIPPED and BAG stayed side by side at 301px each even on a 750px phone,
 * with 32px item rows and 160px of hidden scroll (MOBILE.md 1.3). Same fix as
 * the shop: full-size panes, one at a time, gated to the phone classes.
 */
let invSeg: Segmented | null = null;
function ensureInvSegments(): void {
  if (invSeg) return;
  const cols = invEl.querySelector(".cols") as HTMLElement | null;
  const panes = cols ? Array.from(cols.children) as HTMLElement[] : [];
  if (!cols || panes.length < 2) return;
  invSeg = new Segmented([
    { id: "eq", label: "EQUIPPED", pane: panes[0] },
    { id: "bag", label: "BAG", pane: panes[1] },
  ]);
  cols.parentElement?.insertBefore(invSeg.el, cols);
}

function toggleInventory(): void {
  invOpen = !invOpen;
  ensureInvSegments();
  if (invOpen) { renderInventory(state); showOverlay(invEl); }
  else hideOverlay(invEl);
}

// Delegated click: equip the clicked bag item, persist, and refresh the panel.
invBag.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest(".item.bag") as HTMLElement | null;
  if (!card || card.dataset.idx === undefined) return;
  const idx = Number(card.dataset.idx);
  audio.play("equip");

  if (net) net.equip(idx);
  else {
    recAct("equip", idx);
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

/** All still-undiscovered abilities collapse into ONE teaser row (audit r2:
 *  seven identical "???" placeholder cards were dead weight). */
function discoverTeaserHtml(s: GameState): string {
  const p = me(s);
  const unknown = [...STARTING_ABILITIES, ...DISCOVERABLE_ABILITIES].filter((id) => !knows(p, id));
  if (unknown.length === 0) return "";
  const actives = unknown.filter((id) => ABILITY_INFO[id].tier === "active").length;
  const ults = unknown.length - actives;
  const breakdown = [
    actives > 0 ? `${actives} active${actives === 1 ? "" : "s"}` : "",
    ults > 0 ? `${ults} ultimate${ults === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  return (
    `<div class="acard discover"><span class="dstar">✦</span>` +
    `<div><div class="ahname">${unknown.length} ${unknown.length === 1 ? "ability" : "abilities"} left to discover</div>` +
    `<div class="ahblurb">${breakdown} — tomes drop in the dungeon, or buy one in the shop</div></div>` +
    `</div>`
  );
}

/**
 * ROLE + TAGS, on the card. The registry now carries a single machine-checked
 * `role` per ability and a tag set the glyph layer routes on — and both are
 * things a player is expected to reason about (roles are how you notice your
 * loadout is four `beat` abilities; tags are how you predict where a stone
 * will light up). Neither was on screen. They are now.
 */
function abilityChipsHtml(id: AbilityId): string {
  const role = ABILITY_INFO[id].role;
  // A tag that repeats the role is noise: Bullet Time printing
  // "ULTIMATE · BUFF · ULTIMATE" makes the player look twice to learn nothing.
  const tags = ABILITY_TAGS[id].filter((t) => t !== "any" && t !== role);
  return `<div class="achips"><span class="achip role">${role}</span>` +
    tags.map((t) => `<span class="achip tag">${t}</span>`).join("") + `</div>`;
}

/**
 * THE COMPOSED READ (pillar 2's actual test): one sentence that states what
 * this ability does RIGHT NOW — base verb, the forks you took, the live
 * numbers off the character sheet, and the glyphs seated in its slot. A kit
 * that cannot be said in one breath after modification has failed the pillar,
 * so this line is where that failure would be visible, and it is generated
 * from state rather than authored per ability precisely so it cannot lie.
 */
function composedText(s: GameState, id: AbilityId): string {
  const p = me(s);
  const row = buildCharacterSheet(s, p).offense.find((r) => r.id === id);
  const parts: string[] = [ABILITY_INFO[id].blurb.toLowerCase().replace(/\.$/, "")];
  if (row?.hit) {
    parts.push(`${row.hit.min}–${row.hit.max} per hit every ${row.hit.cooldown.toFixed(1)}s`);
  } else if (row?.note) {
    parts.push(row.note.toLowerCase().replace(/\.$/, ""));
  }
  // Only nodes actually TAKEN, with rank when it is above one — the point is
  // "what is my build", not "what does the tree contain".
  const taken = UPGRADES.filter((u) => u.ability === id && rank(p, u.id) > 0)
    .map((u) => (rank(p, u.id) > 1 ? `${u.title} ${rank(p, u.id)}` : u.title));
  if (taken.length > 0) parts.push(taken.join(", "));
  const slotIdx = slotIndexOf(p, id);
  if (slotIdx >= 0) {
    const live = glyphsFor(p, id).map((gid) => GLYPH_INFO[gid].name);
    if (live.length > 0) parts.push(`running ${live.join(" + ")}`);
  }
  return parts.join(" · ");
}

/** Which socket row an ability's glyphs live on (-1 = benched, no sockets). */
function slotIndexOf(p: Player, id: AbilityId): number {
  const i = p.abilities.slots.indexOf(id);
  if (i >= 0) return i;
  return p.abilities.ultimate === id ? ULT_SLOT : -1;
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
  // the buttons elsewhere). Roam: a settlement's walls count as safety — the
  // sim's slotAbility accepts playerInSettlement, so the buttons show there too.
  let controls = "";
  if (s.safeRoom || settlementShopFor(s, me(s))) {
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
  // MODIFIERS (V2 §3): the glyphs this ability is actually running, read off
  // the slot it occupies. A benched ability says so — sockets are the slot's.
  const slotIdx = slotIndexOf(p, id);
  let mods = "";
  if (slotIdx >= 0) {
    const live = glyphsFor(p, id);
    const label = live.length
      ? live.map((gid) => GLYPH_INFO[gid].name).join(" + ")
      : "no glyphs seated in this slot";
    // Rule 7's cap, on the card the player actually reads while building.
    const cdr = abilityCdrBreakdown(p, id);
    const capNote = cdr.capped && cdr.glyph > 0 && live.includes("hair_trigger")
      ? `<span class="amodcap">CDR AT CAP — Hair Trigger's -${Math.round(CONFIG.glyphHairTriggerCd * 100)}% is wasted here</span>`
      : "";
    mods = `<div class="amods">${socketRowHtml(p, slotIdx, false)}` +
      `<span class="amodtext">${label}</span>${capNote}</div>`;
  } else if ((p.glyphs?.bench.length ?? 0) > 0) {
    mods = `<div class="amods"><span class="amodtext dim">benched — glyphs live on the SLOT, so this inherits whatever it lands in</span></div>`;
  }
  return (
    `<div class="acard${info.tier === "ultimate" ? " ult" : ""}" data-ab="${id}">` +
    `<div class="ahead">` +
    `<i class="ii" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>` +
    `<div><div class="ahname">${info.name}</div><div class="ahblurb">${info.blurb} · ${info.tier}</div></div>` +
    `<span class="awhere ${whereCls}">${where}</span>` +
    `</div>` +
    abilityChipsHtml(id) +
    `<div class="acomposed"><span class="clbl">AS BUILT</span>${esc(composedText(s, id))}</div>` +
    mods +
    (rows ? `<div class="nrows">${rows}</div>` : "") +
    controls +
    `</div>`
  );
}

// ---- THE CONSTELLATION, drawn (ABILITIES-V2 §4.3) ------------------------
// The list view answers "what does this node give me". It cannot answer "is
// this tree a real decision", because a flat list renders an EXCLUSIVE FORK
// and a free rider as the same kind of row. §4.3 rebuilt all sixteen graphs
// around one shape — ENTRY, then FORK xor FORK, then a RIDER, then a CAPSTONE
// — and that shape is the product. So it gets drawn: `pos` has been carried on
// every UpgradeDef since the tree shipped, waiting for exactly this.
//
// Nothing here decides anything. The sim owns rank/nodeOpen/excludes; this is
// a projection of them, which is why a fork can never draw as open on a card
// where the sim would refuse the draft.
type NodeState = "taken" | "open" | "forked" | "needs";

function nodeStateOf(p: Player, u: UpgradeDef): NodeState {
  if (rank(p, u.id) > 0) return "taken";
  if ((u.excludes ?? []).some((x) => rank(p, x) > 0)) return "forked";
  return nodeOpen(p, u) ? "open" : "needs";
}

/** Rank pips, reused by both views so a node reads identically in each. */
function nodePipsHtml(p: Player, u: UpgradeDef): string {
  const r = rank(p, u.id);
  if (u.capstone) return `<i class="pip cap${r > 0 ? " on" : ""}"></i>`;
  return `<i class="pip on"></i>`.repeat(Math.min(r, u.maxRank)) +
    `<i class="pip over"></i>`.repeat(Math.max(0, r - u.maxRank)) +
    `<i class="pip"></i>`.repeat(Math.max(0, u.maxRank - r));
}

/** One ability's star chart: SVG edges under absolutely-placed node tiles, so
 * the lines scale with the card and the text stays crisp at any width. */
function constellationCardHtml(s: GameState, id: AbilityId): string {
  const p = me(s);
  const info = ABILITY_INFO[id];
  const nodes = UPGRADES.filter((u) => u.ability === id);
  if (nodes.length === 0) return "";
  const byId = new Map(nodes.map((u) => [u.id, u]));
  let edges = "";
  for (const u of nodes) {
    for (const reqId of u.requires ?? []) {
      const from = byId.get(reqId);
      if (!from) continue;
      // An edge is LIVE once its parent is taken, and DEAD once the fork it
      // feeds has been decided the other way — the road not taken stays on
      // the chart, greyed, because knowing what you gave up is the decision.
      const live = rank(p, reqId) > 0;
      const dead = (u.excludes ?? []).some((x) => rank(p, x) > 0);
      edges += `<line x1="${from.pos.x}" y1="${from.pos.y}" x2="${u.pos.x}" y2="${u.pos.y}" ` +
        `class="cedge${dead ? " dead" : live ? " live" : ""}"/>`;
    }
  }
  const marks: string[] = [];
  const seen = new Set<string>();
  for (const u of nodes) {
    for (const x of u.excludes ?? []) {
      const key = [u.id, x].sort().join("|");
      if (seen.has(key) || !byId.has(x)) continue;
      seen.add(key);
      const o = byId.get(x)!;
      const decided = rank(p, u.id) > 0 || rank(p, x) > 0;
      edges += `<line x1="${u.pos.x}" y1="${u.pos.y}" x2="${o.pos.x}" y2="${o.pos.y}" ` +
        `class="cxbar${decided ? " decided" : ""}"/>`;
      marks.push(`<div class="cxor${decided ? " decided" : ""}" ` +
        `style="left:${(u.pos.x + o.pos.x) / 2}%;top:${(u.pos.y + o.pos.y) / 2}%">` +
        `${decided ? "LOCKED IN" : "PICK ONE"}</div>`);
    }
  }
  const tiles = nodes.map((u) => {
    const st = nodeStateOf(p, u);
    const r = rank(p, u.id);
    const why = st === "forked"
      ? `fork closed — you took ${(u.excludes ?? []).filter((x) => rank(p, x) > 0)
        .map((x) => upgradeDef(x)!.title).join(", ")}`
      : st === "needs"
        ? `needs ${(u.requires ?? []).filter((x) => rank(p, x) === 0)
          .map((x) => upgradeDef(x)!.title).join(", ")}`
        : u.desc(Math.max(1, r));
    return `<div class="cnode ${st}${u.capstone ? " cap" : ""}" ` +
      `style="left:${u.pos.x}%;top:${u.pos.y}%" title="${esc(`${u.title} — ${why}`)}">` +
      `<i class="cgem"></i><span class="cname">${u.title}</span>` +
      `<span class="npips">${nodePipsHtml(p, u)}</span></div>`;
  }).join("");
  const where = whereIs(p, id);
  return (
    `<div class="ccard${info.tier === "ultimate" ? " ult" : ""}">` +
    `<div class="ahead">` +
    `<i class="ii" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>` +
    `<div><div class="ahname">${info.name}</div><div class="ahblurb">${info.blurb}</div></div>` +
    `<span class="awhere ${where === "BENCH" ? "bench" : where === "ULTIMATE" ? "ultc" : ""}">${where}</span>` +
    `</div>` +
    abilityChipsHtml(id) +
    `<div class="cgraph">` +
    `<svg class="cedges" viewBox="0 0 100 100" preserveAspectRatio="none">${edges}</svg>` +
    tiles + marks.join("") +
    `</div>` +
    `<div class="acomposed"><span class="clbl">AS BUILT</span>${esc(composedText(s, id))}</div>` +
    `</div>`
  );
}

/** LIST vs CONSTELLATION, remembered per browser. Two views of one truth:
 * the list is for reading magnitudes, the chart is for reading SHAPE. */
type AbilView = "list" | "graph";
let abilView: AbilView = ((): AbilView => {
  try { return localStorage.getItem("dcc.abilView") === "graph" ? "graph" : "list"; } catch { return "list"; }
})();

function setAbilView(v: AbilView): void {
  abilView = v;
  try { localStorage.setItem("dcc.abilView", v); } catch { /* private mode */ }
  for (const el of document.querySelectorAll(".amode")) {
    el.classList.toggle("on", (el as HTMLElement).dataset.view === v);
  }
  if (abilOpen) renderAbilities(state);
  if (document.getElementById("saferoom")!.style.display !== "none") renderAbilPage(state);
}

/** The known roster in either view, plus the undiscovered teaser. */
function abilBodyHtml(s: GameState): string {
  const p = me(s);
  const known = [...STARTING_ABILITIES, ...DISCOVERABLE_ABILITIES].filter((id) => knows(p, id));
  const body = abilView === "graph"
    ? known.map((id) => constellationCardHtml(s, id)).join("")
    : known.map((id) => abilityCard(s, id)).join("");
  return body + discoverTeaserHtml(s);
}

for (const el of document.querySelectorAll(".amode")) {
  el.addEventListener("click", () => setAbilView((el as HTMLElement).dataset.view as AbilView));
}

// ---- Glyph socketing: click a bench glyph, then click a lit socket. Clicking
// a FILLED socket pulls its glyph back to the bench (free and lossless — the
// cheapest pivot in the game by design). The sim owns every legality rule;
// a rejected click simply doesn't change anything. ----
function handleGlyphClick(e: Event): boolean {
  const el = e.target as HTMLElement;
  const chip = el.closest(".gchip[data-glyph]") as HTMLElement | null;
  if (chip) {
    const id = chip.dataset.glyph as GlyphId;
    heldGlyph = heldGlyph === id ? null : id;
    renderSafeRoom(state);
    // Picking a glyph up lights every socket that can take it — and on a phone
    // the bench you just tapped is BELOW those sockets, so the whole point of
    // the pending state is off screen at the moment it turns on. Follow it.
    if (heldGlyph && document.body.classList.contains("touch")) {
      srLoadout.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    return true;
  }
  const sock = el.closest(".sock.live") as HTMLElement | null;
  if (!sock) return false;
  const slotIdx = Number(sock.dataset.slot), socketIdx = Number(sock.dataset.socket);
  const p = me(state);
  if (sock.classList.contains("locked")) return true; // nothing to do, tooltip explains
  if (heldGlyph && !sock.dataset.glyph) {
    const id = heldGlyph;
    audio.play("equip");
    if (net) net.socket(slotIdx, socketIdx, id);

    else {
      recAct("socket", slotIdx, socketIdx, id);
      socketGlyph(state, p.id, slotIdx, socketIdx, id); flushFeedback(state); persistRun(state);
    }
    heldGlyph = null;
  } else if (sock.dataset.glyph) {
    audio.play("equip");
    if (net) net.socket(slotIdx, socketIdx, null);

    else {
      recAct("unsocket", slotIdx, socketIdx);
      unsocketGlyph(state, p.id, slotIdx, socketIdx); flushFeedback(state); persistRun(state);
    }
  }
  renderSafeRoom(state);
  return true;
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

    if (slot === "ult") { recAct("ult", ability); setUltimate(state, p.id, ability); }
    else if (slot === "unult") { recAct("ult", null); setUltimate(state, p.id, null); }
    else if (slot === "bench") {
      const idx = p.abilities.slots.indexOf(ability);
      if (idx >= 0) { recAct("slot", idx, null); slotAbility(state, p.id, idx, null); }
    } else { recAct("slot", Number(slot), ability); slotAbility(state, p.id, Number(slot), ability); }
    flushFeedback(state);
    persistRun(state);
  }
  rerender(state);
}

document.getElementById("abil-grid")!.addEventListener("click", (e) => handleSlotClick(e, renderAbilities));

const achGrid = document.getElementById("ach-grid")!;
const achCount = document.getElementById("ach-count")!;
const statsRows = document.getElementById("stats-rows")!;

/**
 * THE CONSTELLATION'S REAL FAILURE WAS NAVIGATION.
 *
 * Four rounds called this "a fixed-size spine scaled down until it is
 * unreadable". Measured, that was wrong on both counts: `#abil .grid` is a
 * two-column block flow of 332px ability cards, entirely legible, and its only
 * interactive elements — the SLOT/BENCH buttons — already clear 44px. The 8x8
 * rank pips are display only; ranks come from level-up drafts, not from
 * tapping the chart.
 *
 * What actually broke was reach: a 1,492px card grid inside a 295px panel,
 * 1,847px of total scroll once achievements and run stats are counted, and no
 * way to get to a named ability except thumbing through everything. So the fix
 * is an index, not a canvas rewrite and not pan-and-pinch: a sticky rail of
 * every ability you know, one tap to its card.
 */
let abilRail: HTMLElement | null = null;
function buildAbilRail(): void {
  const panel = abilEl.querySelector(".panel");
  if (!panel) return;
  if (!abilRail) {
    abilRail = document.createElement("div");
    abilRail.className = "tp-rail";
    abilRail.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-jump]") as HTMLElement | null;
      if (!b) return;
      e.preventDefault();
      const card = abilGrid.querySelector(`.acard[data-ab="${b.dataset.jump}"]`);
      card?.scrollIntoView({ block: "start", behavior: "smooth" });
      for (const k of Array.from(abilRail!.children)) k.classList.toggle("on", k === b);
    });
    panel.insertBefore(abilRail, abilGrid);
  }
  const known = Array.from(abilGrid.querySelectorAll<HTMLElement>(".acard[data-ab]"))
    .map((c) => c.dataset.ab!);
  abilRail.innerHTML = known.map((id) =>
    `<button type="button" data-jump="${id}" aria-label="${ABILITY_INFO[id as AbilityId].name}" ` +
    `title="${ABILITY_INFO[id as AbilityId].name}">` +
    `<i style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>` +
    `</button>`).join("");
}

function renderAbilities(s: GameState): void {
  abilGrid.classList.toggle("graphs", abilView === "graph");
  abilGrid.innerHTML = abilBodyHtml(s);
  document.getElementById("ach-section")!.style.display =
    CONFIG.achievementsEnabled ? "" : "none";
  achCount.textContent = `${me(s).achievements.length} / ${ACHIEVEMENTS.length}`;
  achGrid.innerHTML = ACHIEVEMENTS.map((a) => {
    const got = me(s).achievements.includes(a.id);
    return (
      `<div class="ach${got ? "" : " locked"}">` +
      `<div class="atitle">${got ? uic("star") : uic("star_open")} ${a.title}</div>` +
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
  if (abilOpen) { renderAbilities(state); buildAbilRail(); showOverlay(abilEl); }
  else hideOverlay(abilEl);
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
const sheetMods = document.getElementById("sheet-mods")!;
const sheetDice = document.getElementById("sheet-dice")!;
const sheetDmg = document.getElementById("sheet-dmg")!;
const sheetDef = document.getElementById("sheet-def")!;
const sheetShow = document.getElementById("sheet-show")!;
let sheetOpen = false;

const abilIcon = (id: string): string =>
  `mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)`;

function gearRowHtml(slot: ItemSlot, it: Item | null): string {
  if (!it) return `<div class="gear-row none rar-common">no ${slot} equipped</div>`;
  const noun = it.name.split(" ").pop()!.toLowerCase();
  const icon = it.catalogId ? itemIconHtml(it.catalogId) : nounIconHtml(noun);
  const tc = itemColor(it);
  return (
    `<div class="gear-row rar-${it.rarity}">` +
    `<div class="gbox" style="--tc:${tc}">${icon}</div>` +
    `<div><div class="gname" style="color:${tc}">${it.name}${qualityPipsHtml(it)}</div>` +
    `<div class="gaff">${affixLines(it).join(" · ") || "<i style=\"color:var(--ink-faint)\">unenchanted</i>"}</div></div>` +
    `<div class="gslot">${slot}</div>` +
    `</div>`
  );
}

/** The MODIFIERS block (V2 §3.4): the two layers that aren't stat lines —
 * item passives (what your gear DOES) and socketed glyphs (what your abilities
 * do differently). Both are build identity; neither shows up in the ledger. */
function modifierBlockHtml(p: Player): string {
  const passives = EQUIP_SLOTS
    .map((slot) => p.equipment[slot])
    .filter((it): it is Item => !!it?.passive && !!it.catalogId);
  // Only slots that actually CARRY firmware earn a row; open sockets are
  // summarized in one line so the block stays a readout, not a form.
  const slotRows: string[] = [];
  let openSockets = 0;
  for (let i = 0; i <= ULT_SLOT; i++) {
    const ability = abilityInSlot(p, i);
    const views = socketViews(p, i);
    openSockets += views.filter((v) => !v.locked && !v.glyph && ability).length;
    if (!views.some((v) => v.glyph)) continue;
    const live = ability ? glyphsFor(p, ability) : [];
    const dormant = views.filter((v) => v.dormant).map((v) => GLYPH_INFO[v.glyph!].name);
    const text = live.length
      ? live.map((gid) => GLYPH_INFO[gid].name).join(" + ")
      : `<i style="color:var(--ink-faint)">dormant</i>`;
    // Rule 7's cap, on the sheet as well as the tooltip: a capped slot holding
    // Hair Trigger is paying damage for nothing, and the ledger has to say so.
    const cdr = ability ? abilityCdrBreakdown(p, ability) : null;
    const capNote = cdr?.capped && cdr.glyph > 0 && live.includes("hair_trigger")
      ? ` <span class="mcap">CDR AT CAP — Hair Trigger's -${Math.round(CONFIG.glyphHairTriggerCd * 100)}% is wasted, ` +
        `the -${Math.round((1 - CONFIG.glyphHairTriggerDmgMult) * 100)}% damage is not</span>`
      : "";
    slotRows.push(
      `<div class="mod-row">${socketRowHtml(p, i, false)}` +
      `<div><div class="mname">${i === ULT_SLOT ? "ULTIMATE" : `SLOT ${i + 1}`} · ${ability ? ABILITY_INFO[ability].name : "empty"}</div>` +
      `<div class="mdesc">${text}${dormant.length ? ` <span class="mdorm">${dormant.join(", ")} DORMANT</span>` : ""}${capNote}</div></div></div>`,
    );
  }
  // The open-socket nudge only earns its line when the block is still short;
  // a full loadout's rows already say everything (panels FIT the viewport).
  if (openSockets > 0 && slotRows.length < 4) {
    slotRows.push(`<div class="mod-open">${openSockets} open socket${openSockets === 1 ? "" : "s"} — ` +
      `glyphs seat in the safe room.</div>`);
  }
  let html = "";
  if (passives.length) {
    html += passives.map((it) =>
      `<div class="mod-row">` +
      `<div class="mbox" style="--tc:${itemColor(it)}">${itemIconHtml(it.catalogId!)}</div>` +
      `<div><div class="mname" style="color:${itemColor(it)}">${it.name}</div>` +
      `<div class="mdesc">${CATALOG_BY_ID[it.catalogId!]?.desc ?? ""}</div></div></div>`).join("");
  }
  html += slotRows.join("");
  if (!html) {
    html = `<div class="mod-empty">No passives, no glyphs. Completed works carry behavior, ` +
      `and glyphs seat into your ability slots from level ${CONFIG.glyphSocket1Level}.</div>`;
  }
  return html;
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
    tiles.map(([ic, , v, l, tip]) =>
      `<tr title="${tip}">` +
      `<td class="lic"><img class="si" src="/icons/painted/stats/${ic}.svg" alt=""></td>` +
      `<td class="lab">${l}</td><td class="dots"></td>` +
      `<td class="val">${v}</td></tr>`).join("") +
    `</table>`;
  sheetProgress.innerHTML =
    `<b>${coinIcon} ${id.gold}</b> gold` +
    ((p.materials.refit_shard ?? 0) > 0 ? ` · <b>${matIcon("refit_shard")} ${p.materials.refit_shard}</b> shards` : "") +
    ` · XP ${id.xp}/${id.xpToNext} to level ${id.level + 1}` +
    `<div class="bar"><i style="width:${Math.min(100, (id.xp / id.xpToNext) * 100)}%"></i></div>`;
  sheetMods.innerHTML = modifierBlockHtml(p);
  sheetDice.textContent =
    `${id.weaponName}${id.weaponClass ? ` (${id.weaponClass})` : ""} — every hit rolls ±${Math.round(id.variance * 100)}%`;
  sheetDmg.innerHTML = sh.offense.length
    ? sh.offense.map((row) => damageRowHtml(row, a.critChance)).join("")
    : `<div class="drow utility"><div class="dmech">nothing slotted</div></div>`;
  const redPct = Math.round(d.reduction * 100);
  sheetDef.innerHTML =
    `<div class="def-box">` +
    `<div class="dbig" title="armor ÷ (armor + ${d.armorK}), capped at ${Math.round(d.reductionCap * 100)}%"><b>${d.armor}</b><small>ARMOR · ${redPct}% REDUCTION</small></div>` +
    `<div><div class="def-meter"><i style="width:${Math.min(100, (d.reduction / d.reductionCap) * 100)}%"></i><span class="ticks"></span></div>` +
    `<div class="def-lines" style="margin-top:7px">Effective HP ≈ <b>${d.effectiveHp}</b> · dash i-frames ×${d.dashCharges}<br>` +
    `<span class="ex">A typical floor-${id.floor} hit: <b>${d.exampleRaw}</b> raw → <b>${d.exampleTaken}</b> taken</span></div></div>` +
    `</div>`;
  // Zero-states render an honest dimmed "0", never an em-dash — a dash reads
  // as unbound placeholder data shipped to screen (r3 major reversal).
  const chip = (cls: string, n: number, label: string): string =>
    `<span class="show-chip${cls ? ` ${cls}` : ""}${n > 0 ? "" : " zero"}">` +
    `<b>${Math.round(n).toLocaleString()}</b>${label}</span>`;
  sheetShow.innerHTML =
    chip("viewers", sh.show.viewers, "viewers") +
    chip("favorites", sh.show.favorites, "favorites") +
    chip("sponsors", sh.show.sponsors, "sponsors") +
    chip("", sh.show.kills, "kills") +
    chip("", sh.show.damageDealt, "dmg dealt") +
    chip("", sh.show.damageTaken, "dmg taken");
}

function toggleSheet(): void {
  sheetOpen = !sheetOpen;
  if (sheetOpen) { renderSheet(state); showOverlay(sheetEl); }
  else hideOverlay(sheetEl);
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
    // In a party: invites from anywhere, one tap/click (not a bindable
    // action — the menu dispatch special-cases it).
    (net ? `<div class="tm-row" data-act="invite"><span>Copy Party Invite Link</span></div>` : row("newRun", "New Run"));
  document.getElementById("tm-crawler")!.innerHTML =
    row("inventory", "Inventory") +
    row("abilities", "Loadout & Achievements") +

    row("character", "Crawler Profile") +
    row("draft", "Claim Banked Drafts") +
    `<div class="tm-row" data-act="standings"><span>The Standings</span></div>` +
    `<div class="tm-row" data-act="careerset"><span>Career &amp; Mastery</span></div>`;
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

// ---- CONTROLS tab: the touch customisation surface (MOBILE.md 6) ----------
// Rendered into the K panel with the panel's own row classes, so it inherits
// the styling and adds no CSS. Every control is a 44px-tall row on touch.
let kbTouchCfg: HTMLElement | null = null;

function touchSettingRows(): { id: string; name: string; hint: string; value: string }[] {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const onOff = (v: boolean): string => (v ? "ON" : "OFF");
  const rows = [
    { id: "handed", name: "Handedness", hint: "mirrors the stick, the cluster and every HUD anchor", value: touchPrefs.handed.toUpperCase() },
    { id: "stickScale", name: "Stick size", hint: "floating stick radius", value: pct(touchPrefs.stickScale) },
    { id: "buttonScale", name: "Button size", hint: "ability chips and the cancel band", value: pct(touchPrefs.buttonScale) },
    { id: "opacity", name: "Control opacity", hint: "idle only — controls go full while pressed", value: pct(touchPrefs.opacity) },
    { id: "hudInset", name: "Safe-area padding", hint: "extra margin on top of the notch inset", value: `${touchPrefs.hudInset}px` },
    { id: "thumbMm", name: "Thumb reach", hint: "how far your thumb sweeps — the cluster arc is drawn from it", value: `${touchPrefs.thumbMm}mm` },
    { id: "haptics", name: "Haptics", hint: "LIGHT keeps only press / cast / cancel", value: touchPrefs.haptics.toUpperCase() },
    { id: "tapToMove", name: "Tap to move", hint: "tap ground to walk, tap a monster to lock and swing", value: onOff(touchPrefs.tapToMove) },
    { id: "stickRecenter", name: "Stick recentring", hint: "the origin follows a thumb that drifts", value: onOff(touchPrefs.stickRecenter) },
    { id: "flickDash", name: "Flick to dash", hint: "flick the movement stick to dash", value: onOff(touchPrefs.flickDash) },
    { id: "twoFingerDash", name: "Two-finger dash", hint: "tap the world with two fingers to dash", value: onOff(touchPrefs.twoFingerDash) },
    { id: "stickyLock", name: "Sticky target lock", hint: "the LOCK chip keeps its target through taps", value: onOff(touchPrefs.stickyLock) },
  ];
  // Slot 0 is the basic attack: hold-to-repeat, no mode to choose.
  const slotName = ["", "Slot 2", "Slot 3", "Slot 4", "Ultimate"];
  for (let i = 1; i < 5; i++) {
    rows.push({
      id: `castMode${i}`, name: `Cast mode — ${slotName[i]}`,
      hint: i === 4 ? "AIM-ONLY forces a drag: an ultimate you cannot fat-finger" : "tap-release shows the range, release fires",
      value: touchPrefs.castMode[i].toUpperCase(),
    });
  }
  return rows;
}

/**
 * Split the K panel into KEYS and CONTROLS pages.
 *
 * Everything that was already in the panel keeps its markup and its handlers —
 * the rows are MOVED, not rebuilt — so the desktop keybinding UI is unchanged
 * and nothing that queries `.kb-row` or `#kb-rows` has to know this happened.
 * On a coarse pointer CONTROLS opens first, because a player on glass did not
 * come here to rebind W.
 */
let kbPages: { tabs: HTMLElement; keys: HTMLElement; controls: HTMLElement } | null = null;
function ensureKbPages(): { keys: HTMLElement; controls: HTMLElement } | null {
  if (kbPages) return kbPages;
  const panel = keysEl.querySelector(".panel") as HTMLElement | null;
  const hint = panel?.querySelector(".hint");
  if (!panel || !hint) return null;
  const page = (id: string): HTMLElement => {
    const e = document.createElement("div");
    e.className = "kb-page";
    e.id = id;
    return e;
  };
  const keys = page("kb-page-keys");
  const controls = page("kb-page-controls");
  // Everything between the hint and the credits is keyboard/settings content.
  const moving: HTMLElement[] = [];
  for (let n = hint.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.classList.contains("credits")) break;
    moving.push(n as HTMLElement);
  }
  for (const n of moving) keys.appendChild(n);
  const tabs = document.createElement("div");
  tabs.className = "kb-tabs";
  for (const [id, label] of [["keys", "KEY BINDINGS"], ["controls", "CONTROLS"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.kbtab = id;
    b.textContent = label;
    tabs.appendChild(b);
  }
  tabs.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-kbtab]") as HTMLElement | null;
    if (b) { e.preventDefault(); showKbPage(b.dataset.kbtab!); }
  });
  hint.after(tabs, keys, controls);
  kbPages = { tabs, keys, controls };
  // A player on glass came for the control layout, not for W.
  showKbPage(document.body.classList.contains("touch") ? "controls" : "keys");
  return kbPages;
}

function showKbPage(id: string): void {
  if (!kbPages) return;
  kbPages.keys.classList.toggle("on", id === "keys");
  kbPages.controls.classList.toggle("on", id === "controls");
  for (const b of Array.from(kbPages.tabs.children) as HTMLElement[]) {
    b.classList.toggle("on", b.dataset.kbtab === id);
  }
}

function renderTouchSettings(): void {
  const pages = ensureKbPages();
  if (!kbTouchCfg) {
    kbTouchCfg = document.createElement("div");
    kbTouchCfg.id = "kb-touchcfg";
    (pages?.controls ?? keysEl.querySelector(".panel"))?.appendChild(kbTouchCfg);
    kbTouchCfg.addEventListener("click", (e) => {
      const key = (e.target as HTMLElement).closest<HTMLElement>("[data-tp]");
      if (!key) return;
      e.preventDefault();
      // A stepper says which way; a pick says which value. Everything else
      // still cycles, which is right for the per-slot cast modes (three
      // states, and the label explains what each one costs you).
      if (key.dataset.set !== undefined) setTouchPref(key.dataset.tp!, key.dataset.set);
      else stepTouchPref(key.dataset.tp!, Number(key.dataset.dir ?? 1));
      applyTouchPrefs();
      renderTouchSettings();
    });
  }
  // Thumb length varies more than screen size does, so the layout is a
  // setting rather than a constant. Numeric prefs get a real -/+ stepper with
  // 46px targets instead of a value you cycle by tapping it eleven times, and
  // the two-state prefs get a pair of pick buttons where the CURRENT state is
  // visible without reading — a cycling label tells you where you are but
  // never where you can go.
  const NUMERIC = new Set(["stickScale", "buttonScale", "opacity", "hudInset", "thumbMm"]);
  const PICKS: Record<string, string[]> = {
    handed: ["RIGHT", "LEFT"],
    haptics: ["OFF", "LIGHT", "FULL"],
    tapToMove: ["ON", "OFF"], stickRecenter: ["ON", "OFF"],
    flickDash: ["ON", "OFF"], twoFingerDash: ["ON", "OFF"], stickyLock: ["ON", "OFF"],
  };
  kbTouchCfg.innerHTML =
    `<div class="ctl-note">` +
    (touchMode
      ? "Changes apply live — the cluster behind this panel moves as you set it."
      : "Touch controls are currently OFF; these still save.") +
    `</div>` +
    touchSettingRows().map((r) => {
      const control = NUMERIC.has(r.id)
        ? `<span class="ctl-val">${r.value}</span>` +
          `<span class="ctl-step">` +
          `<button type="button" data-tp="${r.id}" data-dir="-1" aria-label="less">−</button>` +
          `<button type="button" data-tp="${r.id}" data-dir="1" aria-label="more">+</button></span>`
        : PICKS[r.id]
          ? `<span class="ctl-pick">` + PICKS[r.id].map((v) =>
            `<button type="button" data-tp="${r.id}" data-set="${v}"` +
            `${v === r.value ? ' class="on"' : ""}>${v}</button>`).join("") + `</span>`
          : `<span class="ctl-pick"><button type="button" data-tp="${r.id}">${r.value}</button></span>`;
      return `<div class="ctl-row"><span class="ctl-name">${r.name}<small>${r.hint}</small></span>` +
        control + `</div>`;
    }).join("");
}

/** A named pick, straight from a button. The pref is the source of truth. */
function setTouchPref(id: string, raw: string | undefined): void {
  if (raw === undefined) return;
  const v = raw.toLowerCase();
  if (id === "handed") touchPrefs.handed = v === "left" ? "left" : "right";
  else if (id === "haptics" && (v === "off" || v === "light" || v === "full")) {
    touchPrefs.haptics = v;
  } else if (id === "tapToMove") touchPrefs.tapToMove = v === "on";
  else if (id === "stickRecenter") touchPrefs.stickRecenter = v === "on";
  else if (id === "flickDash") touchPrefs.flickDash = v === "on";
  else if (id === "twoFingerDash") touchPrefs.twoFingerDash = v === "on";
  else if (id === "stickyLock") touchPrefs.stickyLock = v === "on";
}

/**
 * One press moves one pref one notch. `dir` is +1 or -1 so a stepper can walk
 * BACK — the old cycle-only version made "I went one too far on button size"
 * a ten-tap round trip, which is exactly the kind of thing that stops a player
 * tuning their layout at all.
 */
function stepTouchPref(id: string, dir = 1): void {
  const cycle = <T>(list: T[], cur: T): T =>
    list[(list.indexOf(cur) + (dir >= 0 ? 1 : list.length - 1)) % list.length];
  const step = (v: number, lo: number, hi: number, by: number): number => {
    const n = v + by * (dir >= 0 ? 1 : -1);
    // Clamp rather than wrap: a stepper that jumps from 140% to 70% because
    // you pressed + once too often is a bug you feel, not a feature.
    return Math.round(Math.min(hi, Math.max(lo, n)) * 100) / 100;
  };
  if (id === "handed") touchPrefs.handed = touchPrefs.handed === "right" ? "left" : "right";
  else if (id === "stickScale") touchPrefs.stickScale = step(touchPrefs.stickScale, 0.7, 1.4, 0.1);
  else if (id === "buttonScale") touchPrefs.buttonScale = step(touchPrefs.buttonScale, 0.7, 1.4, 0.1);
  else if (id === "opacity") touchPrefs.opacity = step(touchPrefs.opacity, 0.35, 1, 0.05);
  else if (id === "hudInset") touchPrefs.hudInset = step(touchPrefs.hudInset, 0, 32, 4);
  else if (id === "thumbMm") touchPrefs.thumbMm = step(touchPrefs.thumbMm, 38, 62, 2);
  else if (id === "haptics") touchPrefs.haptics = cycle(["off", "light", "full"] as const, touchPrefs.haptics);
  else if (id === "tapToMove") touchPrefs.tapToMove = !touchPrefs.tapToMove;
  else if (id === "stickRecenter") touchPrefs.stickRecenter = !touchPrefs.stickRecenter;
  else if (id === "flickDash") touchPrefs.flickDash = !touchPrefs.flickDash;
  else if (id === "twoFingerDash") touchPrefs.twoFingerDash = !touchPrefs.twoFingerDash;
  else if (id === "stickyLock") touchPrefs.stickyLock = !touchPrefs.stickyLock;
  else if (id.startsWith("castMode")) {
    const i = Number(id.slice("castMode".length));
    touchPrefs.castMode[i] = cycle(["tap-release", "tap", "aim-only"] as const, touchPrefs.castMode[i]);
  }
}

function toggleKeybinds(): void {
  kbOpen = !kbOpen;
  if (kbOpen) { renderKeybinds(); renderTouchSettings(); showOverlay(keysEl); }
  else hideOverlay(keysEl);
  listening = null;
  input.captureMode = false;
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

// Camera zoom: STANDARD (classic iso framing) vs CLOSE (a third tighter —
// promoted from the look experiment). Applies instantly; persisted.
const kbCamZoom = document.getElementById("kb-camzoom")!;
function renderCamZoom(): void {
  kbCamZoom.textContent = camView === "close" ? "CLOSE" : "STANDARD";
}
kbCamZoom.addEventListener("click", () => {
  camView = camView === "close" ? "default" : "close";
  saveCamView(camView);
  renderer.setCloseView(camView === "close");
  renderer.resize(window.innerWidth, window.innerHeight);
  renderCamZoom();
});
renderCamZoom();

// Render scale: 100% -> 90% -> 75% of display resolution for the 3D frame
// (backing buffer + composer targets only; the DOM HUD stays native-crisp).
// Applies instantly; persisted per browser.
const RS_CYCLE = [1, 0.9, 0.75];
const kbRenderScale = document.getElementById("kb-renderscale")!;
function renderRenderScale(): void {
  kbRenderScale.textContent = `${Math.round(renderScale * 100)}%`;
}
kbRenderScale.addEventListener("click", () => {
  renderScale = RS_CYCLE[(RS_CYCLE.indexOf(renderScale) + 1) % RS_CYCLE.length];
  try { localStorage.setItem(RENDERSCALE_KEY, String(renderScale)); } catch { /* best-effort */ }
  renderer.setRenderScale(renderScale);
  renderRenderScale();
});
renderRenderScale();

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
    // The derivation sheet is the innermost thing on screen, so it unwinds
    // first — Escape must never skip a layer.
    if (mathSheetOpen()) { hideSheet(); return; }
    if (ladderEl.classList.contains("on") || careerEl.classList.contains("on")) closeSets();
    else if (consentEl.classList.contains("on")) consentEl.classList.remove("on");
    else if (topBars.some((tb) => tb.classList.contains("open"))) closeTopMenus();
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
  tb.querySelector(".topmenu")!.addEventListener("click", async (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".tm-row");
    if (!r?.dataset.act) return;
    closeTopMenus();

    if (r.dataset.act === "invite") {
      const ok = await copyText(inviteUrl(joinCode!, rivalsMode));
      pushLogLine(ok ? "Invite link copied — paste it to your crawlers." : "Copy failed — the code is " + joinCode);
      return;
    }
    if (r.dataset.act === "standings") { await openLadder(); return; }
    if (r.dataset.act === "careerset") { await openCareerSet(); return; }
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
const srTabChase = document.getElementById("sr-tab-chase")!;
// Top-level safe-room tabs: SYSTEM SHOP / ABILITIES / ACHIEVEMENTS.
const srTabShop = document.getElementById("sr-tab-shop")!;
const srTabAbil = document.getElementById("sr-tab-abil")!;
const srTabAch = document.getElementById("sr-tab-ach")!;
const srPageShop = document.getElementById("sr-page-shop")!;
const srPageAbil = document.getElementById("sr-page-abil")!;
const srPageAch = document.getElementById("sr-page-ach")!;
const srLoadout = document.getElementById("sr-loadout")!;
const srGlyphs = document.getElementById("sr-glyphs")!;
const srAbil = document.getElementById("sr-abil")!;
const srAch = document.getElementById("sr-ach")!;
const srAchCount = document.getElementById("sr-ach-count")!;
let srTab: "shop" | "abil" | "ach" = "shop";

const TIERS: CatalogTier[] = ["consumable", "starter", "basic", "advanced", "legendary"];
const TIER_COLOR: Record<CatalogTier, string> = {
  consumable: "#a99f8c", starter: "#b9b2a4", basic: "#8fb0d9", advanced: "#f2c14e", legendary: "#b08fd9",
};
const TIER_LABEL: Record<CatalogTier, string> = {
  consumable: "CONSUMABLES", starter: "STARTER", basic: "COMPONENTS", advanced: "COMPLETED WORKS", legendary: "SIGNATURE",
};

// ---- ITEMIZATION V2 §2.1: identity first, quality on top ----
// One loot system now, but TWO display registers that must never be confused:
// a CATALOG item keeps its name (identity) and wears its quality roll as gem
// pips; a COMMODITY drop has no identity, so its rolled rarity IS its story —
// prefix in the name, tint on the frame. Quality compares within a path only.
const QUALITY_PIPS: Record<Rarity, number> = { common: 0, magic: 1, rare: 2, epic: 3 };
const QUALITY_LABEL: Record<Rarity, string> = {
  common: "STANDARD ISSUE", magic: "CERTIFIED", rare: "OVERBUILT", epic: "MASTERWORK",
};

/** Quality gems — CATALOG ITEMS ONLY (a commodity drop wears its roll in its
 * prefix and tint instead; §2.1 forbids reading the two scales as one). */
function qualityPipsHtml(it: Item): string {
  if (!isCatalog(it)) return "";
  const n = QUALITY_PIPS[it.rarity];
  if (n === 0) return "";
  return `<span class="qpips" style="--qc:${RARITY_TEXT[it.rarity]}" title="${QUALITY_LABEL[it.rarity]} quality (${it.rarity})">` +
    `<i class="qpip"></i>`.repeat(n) + `</span>`;
}

/** True when this item is a catalog identity (quality path, not commodity). */
const isCatalog = (it: Item): boolean => !!it.catalogId && !!CATALOG_BY_ID[it.catalogId];

/** The frame/text color for any item: catalog gear by SHOP TIER, commodity by
 * rolled rarity. Two scales, deliberately — see §2.1. */
function itemColor(it: Item): string {
  return isCatalog(it) ? TIER_COLOR[CATALOG_BY_ID[it.catalogId!].tier] : RARITY_TEXT[it.rarity];
}

/** The kind line under an item's name: identity + quality, or rolled rarity.
 * Kept to ONE line — a common catalog item is just the item, so its quality
 * goes unspoken; only a hot roll earns the extra word. */
function itemKindLine(it: Item): string {
  const wc = weaponClassOf(it);
  const tail = `${it.slot.toUpperCase()}${wc ? ` · ${wc.toUpperCase()}` : ""}`;
  if (!isCatalog(it)) return `${it.rarity.toUpperCase()} · ${tail} · SALVAGE`;
  const e = CATALOG_BY_ID[it.catalogId!];
  const q = it.rarity === "common" ? "" : ` · ${QUALITY_LABEL[it.rarity]}`;
  return `${TIER_LABEL[e.tier].replace(/S$/, "")} · ${tail}${q}`;
}

// Painted glyph art: /icons/painted/glyphs/<glyphId>.svg (same pipeline as
// item art — tools/gen-icon-masks.mjs then tools/paint-icons.mjs).
const glyphIconHtml = (id: GlyphId): string =>
  `<img class="ii" src="/icons/painted/glyphs/${id}.svg" alt="" draggable="false">`;

// Band bosses by floor — presentation copy for the chase showcase (the sim
// owns who actually drops what; this only names the fight you go earn it in).
const BOSS_NAME_BY_FLOOR: Record<number, string> = {
  3: "The Crypt Concierge", 6: "The Sump King", 9: "The Topiary Warden",
  12: "The Condemned Architect", 15: "The Furnace Marshal",
};
const CHASE_ENTRIES: { floor: number; entry: CatalogEntry }[] = Object.entries(BOSS_UNIQUES)
  .map(([floor, id]) => ({ floor: Number(floor), entry: CATALOG_BY_ID[id] }))
  .filter((x) => !!x.entry)
  .sort((a, b) => a.floor - b.floor);

let shopView: "stock" | "all" | "chase" = "stock";
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

// ---- Painted item art (AAA icon pass): every shelf/bag/gear icon is a
// pre-painted 3-tone flat-shaded SVG (tools/paint-icons.mjs — shared 45°
// key light, material palette baked in, uniform ink silhouette), rendered
// as an <img>. Rarity stays on the tile frame (--tc border + glow).
const itemIconHtml = (id: string): string =>
  `<img class="ii" src="/icons/painted/items/${id}.svg" alt="" draggable="false">`;
const nounIconHtml = (noun: string): string =>
  `<img class="ii" src="/icons/painted/nouns/${noun}.svg" alt="" draggable="false">`;

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

/** The store panel serves BOTH shop kinds: the between-floor safe room, and
 * — Roam — the settlement outfitter the player is standing in (same SafeRoom
 * shape sim-side; buy/sell/reslot route through shopRoomFor unchanged). */
function shopRoomOf(s: GameState): SafeRoom | null {
  return s.safeRoom ?? settlementShopFor(s, me(s));
}

/** Why this entry can't be bought right now, or null if it can. */
function buyBlocker(s: GameState, e: CatalogEntry): string | null {
  const room = shopRoomOf(s)!;
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

/**
 * SHELF LINKAGE (r5 minor): 40 anonymous icons priced within 20 gold of each
 * other carry no signal at a glance — you had to hover all 17 components to
 * learn which one feeds the completed work you want. Selecting a COMPLETED
 * WORK now lights its components in the grid (owned = claimed, missing = the
 * thing to buy next), and selecting a component lights what it builds into.
 * This is the LoL shop's "recommended" read without a recommendation engine.
 */
function shelfLinkClass(s: GameState, e: CatalogEntry): string {
  const sel = shopSel?.kind === "catalog" ? CATALOG_BY_ID[shopSel.id] : undefined;
  if (!sel || sel.id === e.id) return "";
  const p = me(s);
  if ((sel.buildsFrom ?? []).includes(e.id)) {
    return (ownedCatalogCounts(p)[e.id] ?? 0) > 0 ? "linked have" : "linked need";
  }
  if ((e.buildsFrom ?? []).includes(sel.id)) return "linked into";
  return "";
}

function shelfTileHtml(s: GameState, e: CatalogEntry, owned: Record<string, number>): string {
  const room = shopRoomOf(s)!;
  const p = me(s);
  const locked = !room.available.includes(e.id);
  const price = effectivePrice(p, e.id, room.nextFloor);
  // Consumable scarcity: show remaining per-shop stock; dim + ✕ when sold out.
  const stock = consumableStock(e);
  const left = Number.isFinite(stock) ? stock - (room.purchased[e.id] ?? 0) : Infinity;
  const soldOut = left <= 0;
  const cls = [
    "itile",
    `tier-${e.tier}`, // rarity grading on the tile frame (r4 major)
    shopSel?.kind === "catalog" && shopSel.id === e.id ? "sel" : "",
    locked ? "locked" : "",
    soldOut ? "soldout" : "",
    !locked && !soldOut && price > p.gold ? "broke" : "",
    (owned[e.id] ?? 0) > 0 ? "owned" : "",
    // BUYABLE RIGHT NOW: gold in hand, components in the bag, stock on the
    // shelf. The one state the shop never showed and the only one that answers
    // "what can I actually click?" — the tempo read, at a glance.
    buyBlocker(s, e) === null ? "ready" : "",
    shelfLinkClass(s, e),
  ].filter(Boolean).join(" ");
  const stockBadge = Number.isFinite(left) && !soldOut && !locked
    ? `<div class="istock" title="${left} left in stock this shop">×${left}</div>` : "";
  // The tile's hover text now carries the NAME plus why it can't be bought —
  // the grid stops being 40 anonymous icons even before the card renders.
  const blocker = buyBlocker(s, e);
  return (
    `<div class="${cls}" data-id="${e.id}" style="--tc:${TIER_COLOR[e.tier]}" ` +
    `title="${esc(e.name)}${blocker ? ` — ${blocker}` : " — READY TO BUY"}">` +
    `<div class="ibox">${itemIconHtml(e.id)}${stockBadge}<b class="gem"></b></div>` +
    `<div class="iprice">${soldOut ? "SOLD OUT" : `${coin}${price}`}</div>` +
    `</div>`
  );
}

/** Small icon tile for build-tree rows and the bag (no price line). */
function miniTileHtml(e: CatalogEntry, extraCls = "", data = ""): string {
  return (
    `<div class="itile tier-${e.tier} ${extraCls}" ${data} style="--tc:${TIER_COLOR[e.tier]}" title="${e.name}">` +
    `<div class="ibox">${itemIconHtml(e.id)}<b class="gem"></b></div>` +
    `</div>`
  );
}

/** Bag/equipped tile: catalog gear shows its catalog icon; field drops show
 * their NOUN's icon (every generated-item noun has one at /icons/nouns/),
 * tinted by rarity via the tile's --tc mask color. */
function invTileHtml(it: Item, data: string, selected: boolean): string {
  const noun = it.name.split(" ").pop()!.toLowerCase();
  const inner = it.catalogId ? itemIconHtml(it.catalogId) : nounIconHtml(noun);
  const tc = itemColor(it);
  // Rarity grading rides the tile frame: catalog gear by shop tier, field
  // drops map rare->advanced glow, epic->legendary breathe (r4 major).
  const tier = it.catalogId ? CATALOG_BY_ID[it.catalogId].tier
    : it.rarity === "epic" ? "legendary" : it.rarity === "rare" ? "advanced" : "basic";
  // V2 §2.1: a HOT catalog roll is the Diablo moment — the item you already
  // wanted, but better. Quality gems ride the tile corner so a rare Honed
  // Edge reads different from the common one at a glance, in the bag.
  const q = isCatalog(it) && QUALITY_PIPS[it.rarity] > 0
    ? `<span class="qtile" style="--qc:${RARITY_TEXT[it.rarity]}">` +
      `<i></i>`.repeat(QUALITY_PIPS[it.rarity]) + `</span>`
    : "";
  const chase = isCatalog(it) && CATALOG_BY_ID[it.catalogId!].dropOnly ? " chase" : "";
  return (
    `<div class="itile tier-${tier}${chase}${selected ? " sel" : ""}" ${data} style="--tc:${tc}" title="${it.name}">` +
    `<div class="ibox">${inner}${q}<b class="gem"></b></div>` +
    `</div>`
  );
}

// ---- Item card stat block (audit r2): labeled rows with green/red deltas
// vs whatever is equipped in the same slot — the LoL-shop comparison read. ----
const AFFIX_ROWS: { k: keyof Affixes; label: string; fmt: (v: number) => string }[] = [
  { k: "damage", label: "ATK", fmt: (v) => String(Math.round(v)) },
  { k: "spell", label: "MAG", fmt: (v) => String(Math.round(v)) },
  { k: "maxHp", label: "HP", fmt: (v) => String(Math.round(v)) },
  { k: "armor", label: "ARM", fmt: (v) => String(Math.round(v)) },
  { k: "speed", label: "SPD", fmt: (v) => v.toFixed(2) },
  { k: "crit", label: "CRIT", fmt: (v) => `${Math.round(v * 100)}%` },
];

function statRowsHtml(next: Affixes, cur: Affixes | null): string {
  let out = "";
  for (const { k, label, fmt } of AFFIX_ROWS) {
    const nv = next[k] ?? 0;
    const cv = cur?.[k] ?? 0;
    if (nv === 0 && cv === 0) continue;
    const d = nv - cv;
    const dd = cur && Math.abs(d) > 1e-9
      ? `<span class="dd ${d > 0 ? "dd-up" : "dd-down"}">${d > 0 ? "▲" : "▼"} ${fmt(Math.abs(d))} vs equipped</span>`
      : "";
    out += `<div class="dstat-row"><span class="lab">${label}</span><span class="val">+${fmt(nv)}</span>${dd}</div>`;
  }
  return out;
}

/** The big item render at the top of the detail card. */
function detailArtHtml(tc: string, iconHtml: string): string {
  return `<div class="dart" style="--tc:${tc}">${iconHtml}` +
    `<b class="gem"></b><b class="gem g2"></b></div>`;
}

// ---- The BUILD PATH (V2 pillar 2: LoL's component -> completed spike curve
// made visible). One ladder, read bottom-up: what feeds this item, the item
// itself, and what it feeds. Owned rungs get the green check; the missing
// ones carry their price, so the pane always answers "what do I buy next".
function rungHtml(s: GameState, cid: string, have: Record<string, number>, self = false): string {
  const room = shopRoomOf(s)!;
  const p = me(s);
  const c = CATALOG_BY_ID[cid];
  if (!c) return "";
  const got = !self && (have[cid] ?? 0) > 0;
  if (got) have[cid]!--;
  const price = c.tier === "consumable"
    ? consumablePrice(c, room.nextFloor) : effectivePrice(p, cid, room.nextFloor);
  const cost = self ? "" : got ? `<div class="pcost owned">HAVE</div>` : `<div class="pcost">${coin}${price}</div>`;
  return `<div class="prung${self ? " self" : ""}">` +
    miniTileHtml(c, got ? "have" : self ? "self" : "", `data-id="${cid}"`) + cost + `</div>`;
}

/** The selected entry's build path, on ONE line (the LoL tooltip read):
 * components ▸ THIS ▸ what it upgrades into. Owned rungs read HAVE, missing
 * ones carry their price — so the card always answers "what do I buy next". */
function buildPathHtml(s: GameState, e: CatalogEntry): string {
  const p = me(s);
  const parents = e.slot ? buildsInto(e.id) : [];
  const comps = e.buildsFrom ?? [];
  if (comps.length === 0 && parents.length === 0) return "";
  const have = { ...ownedCatalogCounts(p) };
  const arrow = `<i class="parrow"></i>`;
  let row = "";
  if (comps.length) row += comps.map((cid) => rungHtml(s, cid, have)).join("") + arrow;
  row += rungHtml(s, e.id, have, true);
  if (parents.length) row += arrow + parents.map((x) => rungHtml(s, x.id, have)).join("");
  return `<div class="dsec">BUILD PATH</div><div class="dpath">${row}</div>`;
}

function renderShopDetail(s: GameState): void {
  const room = shopRoomOf(s)!;
  const p = me(s);
  if (!shopSel) {
    // Never a void (AAA r2 major): the unselected pane shows the System's
    // engraved sigil + Mordecai's featured picks for the floor below.
    const avail = room.available
      .map((id) => CATALOG_BY_ID[id])
      .filter((e): e is CatalogEntry => !!e && e.id !== "tome");
    const priceOf = (e: CatalogEntry): number => effectivePrice(p, e.id, room.nextFloor);
    // Best affordable gear first (priciest = biggest upgrade), then the
    // cheapest aspirational stock if the wallet is thin.
    const picks = avail.filter((e) => !buyBlocker(s, e)).sort((a, b) => priceOf(b) - priceOf(a)).slice(0, 4);
    if (picks.length < 4) {
      for (const e of avail.filter((x) => !picks.includes(x)).sort((a, b) => priceOf(a) - priceOf(b))) {
        picks.push(e);
        if (picks.length >= 4) break;
      }
    }
    // Featured spotlight (AAA r3 major): the idle rail SELLS — the floor's
    // headline pick gets the full item-card art treatment, the rest ride
    // below as Mordecai's picks. Never 60% dead brown.
    const feat = picks[0];
    const featHtml = feat
      ? `<div class="dfeat" data-id="${feat.id}">` +
        `<div class="dsec">FEATURED — FLOOR ${room.nextFloor}</div>` +
        detailArtHtml(TIER_COLOR[feat.tier], itemIconHtml(feat.id)) +
        `<div class="dname" style="--tc:${TIER_COLOR[feat.tier]}">${feat.name}</div>` +
        `<div class="dkindrow"><span class="dkind" style="--tc:${TIER_COLOR[feat.tier]}">${TIER_LABEL[feat.tier]}</span></div>` +
        `<div class="dprice"><span class="eff">${coin}${priceOf(feat)}</span></div>` +
        `</div>`
      : `<div class="dsigil"></div>`;
    srDetail.innerHTML =
      `<div class="dempty-state">` +
      `<div class="dsys">THE SYSTEM PROVIDES</div>` +
      featHtml +
      (picks.length > 1
        ? `<div class="dsec">MORDECAI'S PICKS</div>` +
          `<div class="dtree">${picks.slice(1).map((e) => miniTileHtml(e, "", `data-id="${e.id}"`)).join("")}</div>`
        : "") +
      `<div class="dempty">Select anything on the shelf. Components you own are credited toward whatever they build into.</div>` +
      `</div>`;
    return;
  }
  if (shopSel.kind === "catalog") {
    const e = CATALOG_BY_ID[shopSel.id];
    if (!e) { srDetail.innerHTML = ""; return; }
    const tc = TIER_COLOR[e.tier];
    const ownedN = ownedCatalogCounts(p)[e.id] ?? 0;
    // CHASE UNIQUES (§2.5): drop-only, one per band boss. The card is a
    // WANTED poster, not a listing — no price, no BUY, just where it lives.
    const chaseFloor = CHASE_ENTRIES.find((c) => c.entry.id === e.id)?.floor ?? null;
    let flavor = ""; // plain flavor sits at the bottom of the card, in italics
    let html =
      detailArtHtml(tc, itemIconHtml(e.id)) +
      `<div class="dname" style="--tc:${tc}">${e.name}</div>` +
      `<div class="dkindrow"><span class="dkind" style="--tc:${tc}">${e.dropOnly ? "CHASE UNIQUE" : TIER_LABEL[e.tier]}${e.slot ? ` · ${e.slot.toUpperCase()}` : ""}</span></div>` +
      (ownedN > 0 ? `<div class="dhave">in your kit ×${ownedN}</div>` : "");
    if (e.dropOnly) {
      html += `<div class="dchase">Drops only from <b>${BOSS_NAME_BY_FLOOR[chaseFloor ?? 0] ?? "a band boss"}</b>` +
        ` on <b>floor ${chaseFloor}</b>. The System does not stock it, and neither will anyone else.</div>`;
    }
    if (e.tier === "consumable") {
      if (e.effect === "tome") {
        const ab = room.tomeAbility;
        html += ab
          ? `<div class="dstats">Today's print: <b>${ABILITY_INFO[ab].name}</b> — ${ABILITY_INFO[ab].blurb}</div>`
          : `<div class="dstats">Out of print — the party knows everything.</div>`;
      } else if (e.effect === "maxHp") {
        html += `<div class="dstats">+${12 + room.nextFloor * 2} max HP, permanent.</div>`;
      }
      // Scarcity is a stat (r3 major: no half-empty consumable cards).
      const stock = consumableStock(e);
      if (Number.isFinite(stock)) {
        const left = Math.max(0, stock - (room.purchased[e.id] ?? 0));
        html += `<div class="dstat-block"><div class="dstat-row"><span class="lab">STOCK</span>` +
          `<span class="val">${left} left this shop</span></div></div>`;
      }
      flavor = e.desc;
    } else {
      const next = gearAffixes(e, room.nextFloor);
      const cur = e.slot ? p.equipment[e.slot]?.affixes ?? null : null;
      html += `<div class="dstat-block">${statRowsHtml(next, cur)}</div>`;
      if (e.passive) html += `<div class="dpassive">${e.desc}</div>`;
      else flavor = e.desc;
    }
    // The LoL read: one ladder showing what feeds this and what it feeds.
    html += buildPathHtml(s, e);
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
    if (flavor) html += `<div class="ddesc">${flavor}</div>`;
    // The footer is STICKY (see .dfoot): the price and the button are the two
    // things that must never sit below the fold, whatever the card carries.
    if (e.dropOnly) {
      // No price, no button: the only currency here is the fight.
      html += `<div class="dfoot"><div class="dbtns"><button disabled>EARN IT ON FLOOR ${chaseFloor}</button></div></div>`;
    } else {
      // Price: full price struck through when owned components discount it.
      const full = e.tier === "consumable" ? consumablePrice(e, room.nextFloor) : totalCost(e.id);
      const eff = effectivePrice(p, e.id, room.nextFloor);
      const blocker = buyBlocker(s, e);
      html += `<div class="dfoot">` +
        `<div class="dprice">${eff < full ? `<span class="full">${full}</span>` : ""}<span class="eff">${coin}${eff}</span></div>` +
        `<div class="dbtns"><button data-buy="${e.id}" ${blocker ? "disabled" : ""}>${blocker ?? "BUY"}</button></div></div>`;
    }
    // Persuasion below the fold (r3 major: the pane never dies at the BUY
    // button) — shelf-mates in the same slot or tier, one click away. An item
    // WITH a build path already has its next step on the card; the alternates
    // row would only push the ladder out of the pane.
    const shelfMates = (e.buildsFrom?.length || buildsInto(e.id).length) ? [] : room.available
      .map((id) => CATALOG_BY_ID[id])
      .filter((x): x is CatalogEntry => !!x && x.id !== e.id && x.id !== "tome" &&
        ((!!e.slot && x.slot === e.slot) || x.tier === e.tier))
      .slice(0, 4);
    if (shelfMates.length) {
      html += `<div class="dsec">ALSO ON THE SHELF</div><div class="dtree">${
        shelfMates.map((t) => miniTileHtml(t, "", `data-id="${t.id}"`)).join("")}</div>`;
    }
    srDetail.innerHTML = html;
    return;
  }
  // Bag / equipped item detail.
  const it = shopSel.kind === "bag" ? p.inventory[shopSel.idx] : p.equipment[shopSel.slot];
  if (!it) { shopSel = null; renderShopDetail(s); return; }
  const tc = itemColor(it);
  const noun = it.name.split(" ").pop()!.toLowerCase();
  const artIcon = it.catalogId ? itemIconHtml(it.catalogId) : nounIconHtml(noun);
  // Bag items compare against whatever currently holds their slot.
  const curEq = shopSel.kind === "bag" ? p.equipment[it.slot]?.affixes ?? null : null;
  let html =
    detailArtHtml(tc, artIcon) +
    `<div class="dname" style="--tc:${tc}">${it.name}${qualityPipsHtml(it)}</div>` +
    `<div class="dkindrow"><span class="dkind" style="--tc:${tc}">${itemKindLine(it)}` +
    `${shopSel.kind === "equipped" ? " · EQUIPPED" : " · BAG"}</span></div>` +
    `<div class="dstat-block">${statRowsHtml(it.affixes, curEq)}</div>`;
  if (it.passive) html += `<div class="dpassive">${CATALOG_BY_ID[it.catalogId ?? ""]?.desc ?? ""}</div>`;
  if (!it.catalogId) html += `<div class="ddesc">Field salvage — no identity, no build path. Worth wearing for a floor, worth dismantling after.</div>`;
  if (isCatalog(it)) html += buildPathHtml(s, CATALOG_BY_ID[it.catalogId!]);
  // ---- THE BENCH (V2 §2.4): refit an owned identity up a quality step, or
  // break salvage down into the shards that pay for it. Both are safe-room
  // verbs, and both preview their exact cost before you commit.
  // ---- THE BENCH (V2 §2.4) rides the sticky footer with the other verbs:
  // every way to spend this item — wear it, sell it, upgrade it, break it for
  // shards — is one row, always on screen, each with its price on the button.
  const refit = refitCost(it);
  const shards = p.materials.refit_shard ?? 0;
  const bench: string[] = [];
  let benchNote = "";
  if (refit) {
    const canPay = shards >= refit.shards && p.gold >= refit.gold &&
      (refit.sigils === 0 || p.materials.boss_sigil >= refit.sigils);
    const ref = shopSel.kind === "bag" ? String(shopSel.idx) : shopSel.slot;
    const cost = `${matIcon("refit_shard")}${refit.shards} ${coin}${refit.gold}` +
      (refit.sigils ? ` ${matIcon("boss_sigil")}${refit.sigils}` : "");
    benchNote = `REFIT rerolls its bonus lines and rescales the base to floor ${room.nextFloor} — ` +
      `strictly better than re-buying it.`;
    bench.push(`<button class="bench-btn" data-refit="${ref}" ${canPay ? "" : "disabled"}>` +
      `REFIT <b style="color:${RARITY_TEXT[refit.to]}">${refit.to.toUpperCase()}</b> · ${cost}</button>`);
  } else if (isCatalog(it)) {
    benchNote = `Certified MASTERWORK — nothing left for the bench to add.`;
  }
  if (shopSel.kind === "bag") {
    const y = dismantleYield(it);
    if (!benchNote) benchNote = `Shards buy refits; gold buys the next item. That call is the safe room.`;
    bench.push(`<button class="bench-btn scrap" data-dismantle="${shopSel.idx}">` +
      `DISMANTLE · +${y}${matIcon("refit_shard")}</button>`);
  }
  html += `<div class="dfoot">`;
  if (benchNote) html += `<div class="bnote">${benchNote}</div>`;
  if (shopSel.kind === "bag") {
    html += `<div class="dbtns">` +
      `<button data-equip="${shopSel.idx}">EQUIP</button>` +
      `<button class="sell" data-sell="${shopSel.idx}">SELL +${sellValue(it)}g</button>` +
      `</div>`;
  }
  if (bench.length) html += `<div class="dbtns bench">${bench.join("")}</div>`;
  html += `</div>`;
  srDetail.innerHTML = html;
}

/**
 * ONE PANE AT A TIME, where two do not fit.
 *
 * `.shop-body` is a two-track grid with the bag nested in the right track. On
 * a 342-tall iPhone that put `#sr-bag` at y=363 — the player's own inventory
 * 21px BELOW the viewport — while the detail pane hid 178px of its 176px-tall
 * box (MOBILE.md 1.3). Shrinking the tracks until everything "fits" makes all
 * three illegible; a segmented control keeps them full size and shows one.
 * CSS gates it to the two phone classes, so a tablet is untouched.
 */
let shopSeg: Segmented | null = null;
function ensureShopSegments(): void {
  if (shopSeg) return;
  const body = srEl.querySelector(".shop-body") as HTMLElement | null;
  const shelf = srEl.querySelector(".shelf-col") as HTMLElement | null;
  const detail = srEl.querySelector(".shop-detail") as HTMLElement | null;
  const bag = srEl.querySelector(".shop-bag") as HTMLElement | null;
  if (!body || !shelf || !detail || !bag) return;
  shopSeg = new Segmented([
    { id: "shelf", label: "SHELF", pane: shelf },
    { id: "detail", label: "DETAIL", pane: detail },
    { id: "bag", label: "BAG", pane: bag },
  ]);
  body.parentElement?.insertBefore(shopSeg.el, body);
}

/** Selecting anything on the shelf is a request to READ it: follow the tap. */
function shopFocusDetail(): void {
  shopSeg?.show("detail");
}

function renderSafeRoom(s: GameState): void {
  const room = shopRoomOf(s);
  if (!room) return;
  ensureShopSegments();
  const p = me(s);
  // Settlement outfitter: same panel, the settlement's voice on the chrome —
  // and no DESCEND (you're mid-floor; the exit is the door you came in by).
  const roamShop = !s.safeRoom;
  const settlement = roamShop ? settlementAt(s, p.pos) : null;
  srEl.querySelector("h2")!.textContent = roamShop
    ? `◆ ${(settlement?.name ?? "SETTLEMENT").toUpperCase()} — OUTFITTER`
    : "◆ SAFE ROOM";
  srDescend.textContent = roamShop ? "BACK TO THE STREET" : "DESCEND ▼";
  srTip.textContent = room.tip ||
    (roamShop ? "The System franchises, the settlement retails. Prices final, exits free." : "");
  // Zero-value currencies stay off the header until first earned — three
  // dead 0-chips are noise, not information.
  const wchips = [`<span class="chip">${coin}<b>${p.gold}</b></span>`];
  // Refit shards join the wallet the moment the bench economy is live (V2 §2.4).
  if ((p.materials.refit_shard ?? 0) > 0) wchips.push(`<span class="chip" title="refit shards — bench currency">${matIcon("refit_shard")}<b>${p.materials.refit_shard}</b></span>`);
  if (p.materials.elite_trophy > 0) wchips.push(`<span class="chip" title="elite trophies">${matIcon("elite_trophy")}<b>${p.materials.elite_trophy}</b></span>`);
  if (p.materials.boss_sigil > 0) wchips.push(`<span class="chip" title="boss sigils">${matIcon("boss_sigil")}<b>${p.materials.boss_sigil}</b></span>`);
  if (p.sponsors > 0) wchips.push(`<span class="chip" title="sponsors"><i class="micon" style="mask-image:url(/icons/ui/rosette.svg);-webkit-mask-image:url(/icons/ui/rosette.svg)"></i><b>${p.sponsors}</b></span>`);
  srWallet.innerHTML = wchips.join("");
  srReady.textContent = !roamShop && s.players.length > 1 ? `ready ${room.ready.length}/${s.players.length}` : "";
  // Top-level tab dispatch.
  srTabAch.style.display = CONFIG.achievementsEnabled ? "" : "none";
  if (srTab === "ach" && !CONFIG.achievementsEnabled) srTab = "shop";
  // The segmented pane control only makes sense on the SHOP page.
  srEl.classList.toggle("sr-shop", srTab === "shop");
  srTabShop.classList.toggle("active", srTab === "shop");
  srTabAbil.classList.toggle("active", srTab === "abil");
  srTabAch.classList.toggle("active", srTab === "ach");
  // NEVER `"grid"` HERE. An inline display beats every stylesheet rule, so
  // hardcoding it silently defeated the whole one-pane-at-a-time treatment:
  // measured on an iPhone 13, `.shop-body` stayed a `244px 348px` grid inside a
  // 606px container, which meant the SHELF was squeezed into 40% of the panel,
  // its first tile row centred below the pane's clip, and NOT ONE `.itile`
  // was hit-testable — `elementFromPoint` at every tile centre returned
  // something else. That is the real cause of "a phone player cannot buy
  // anything": not the select→detail→BUY chain (which works), but a shelf with
  // nothing a finger can reach. The empty column is `.shop-side`, held open by
  // the grid track while its contents were `display: none`d by the segmenting
  // rules — the "acres of blank stone" in the phone shop captures.
  srPageShop.style.display = srTab === "shop" ? "" : "none";
  srPageAbil.style.display = srTab === "abil" ? "" : "none";
  srPageAch.style.display = srTab === "ach" ? "" : "none";
  if (srTab === "shop") renderShopPage(s);
  else if (srTab === "abil") renderAbilPage(s);
  else renderAchPage(s);
}

// ---- GLYPHS (ITEMIZATION-V2 §3): the modifier layer, on screen ----
// Sockets belong to the SLOT, not the ability, so "slot 3 is my projectile
// slot" is itself a build decision — the UI has to make that legible. Every
// number and every legality check below comes from sim/glyphs.ts; the host
// only asks questions and paints answers.

/** The glyph picked up off the bench, waiting for a socket (click-to-assign). */
let heldGlyph: GlyphId | null = null;

const ULT_SLOT = ABILITY_SLOTS; // index 4: the ultimate's single socket

/** Which ability currently occupies a socket row (null = the slot is empty). */
function abilityInSlot(p: Player, slotIdx: number): AbilityId | null {
  return slotIdx === ULT_SLOT ? p.abilities.ultimate : p.abilities.slots[slotIdx] ?? null;
}

interface SocketView {
  glyph: GlyphId | null;
  locked: boolean;
  reason: string; // why it's locked, in plain language
  dormant: boolean; // socketed but the slot's ability doesn't accept its tags
}

/** The two sockets of an active slot (one for the ultimate), unlock state and
 * dormancy resolved exactly the way glyphsFor does it. */
function socketViews(p: Player, slotIdx: number): SocketView[] {
  const g = p.glyphs;
  const ability = abilityInSlot(p, slotIdx);
  const count = slotIdx === ULT_SLOT ? 1 : 2;
  const unlocked = slotIdx === ULT_SLOT
    ? (p.abilities.ultimate ? 1 : 0) : glyphSocketCount(p.level, slotIdx);
  const arr = (slotIdx === ULT_SLOT ? g?.ultimate : g?.slots[slotIdx]) ?? [];
  return Array.from({ length: count }, (_v, i) => {
    const glyph = (arr[i] ?? null) as GlyphId | null;
    const locked = i >= unlocked;
    const reason = !locked ? ""
      : slotIdx === ULT_SLOT ? "Opens with your ultimate"
      : `Opens at level ${i === 0 ? CONFIG.glyphSocket1Level : glyphSocket2Level(slotIdx)}`;
    return {
      glyph, locked, reason,
      dormant: !!glyph && !!ability && !glyphMatches(glyph, ability),
    };
  });
}

/** Human list of the abilities a glyph can modify ("any" = everything). */
function glyphTagLine(id: GlyphId): string {
  const tags = GLYPH_INFO[id].tags;
  if (tags.includes("any")) return "any ability";
  return tags.join(" · ");
}

/**
 * RULE 7's cap, said out loud. A maxed Swift Strikes (-36%) plus Hair Trigger
 * (-20%) sums to 56% and clamps to 40%: the glyph's cooldown line does NOTHING
 * and you still eat its damage drawback. That is a trap unless the panel names
 * it, which is exactly the breakpoint clarity the PoE2 pillar is asking for.
 * Returns "" when there's nothing being wasted (`glyph` scopes the callout to
 * a stone that actually contributes cooldown).
 */
function cdrCapWarningHtml(p: Player, ability: AbilityId, glyph?: GlyphId): string {
  const cdr = abilityCdrBreakdown(p, ability);
  if (!cdr.capped || cdr.glyph <= 0) return "";
  if (glyph && glyph !== "hair_trigger") return "";
  return `<div class="tcap">CDR AT CAP (${Math.round(CONFIG.cdrCap * 100)}%) — ` +
    `you are ${Math.round(cdr.wasted * 100)}% over, so Hair Trigger's cooldown line is doing nothing here. ` +
    `You keep the -${Math.round((1 - CONFIG.glyphHairTriggerDmgMult) * 100)}% damage. ` +
    `Move it to a slot that isn't capped.</div>`;
}

/** The composed read: what this glyph does, and what the ability does WITH the
 * glyphs it already carries (numbers straight off the character sheet, which
 * calls the same param functions combat does). */
function glyphTipHtml(s: GameState, id: GlyphId, slotIdx: number | null, dormant: boolean): string {
  const p = me(s);
  const info = GLYPH_INFO[id];
  const ability = slotIdx === null ? null : abilityInSlot(p, slotIdx);
  let html =
    `<div class="tname" style="color:#b08fd9">${info.name}</div>` +
    `<div class="tmeta">GLYPH · ${glyphTagLine(id)}${info.family ? ` · ${info.family} family` : ""}</div>` +
    `<div class="taff">${info.blurb}</div>`;
  if (info.family) {
    html += `<div class="tbuild">One ${info.family}-family glyph per slot — they don't share.</div>`;
  }
  if (ability && dormant) {
    // The SIM owns the reason (glyphs.ts) — dormancy is a rule, and rules do
    // not live in a host. It now covers "wrong archetype" AND "right archetype,
    // no machinery" (Reprise on Airstrike, Heavyweight on Bullet Time).
    html += `<div class="tdormant">DORMANT — ${ABILITY_INFO[ability].name} ` +
      `${esc(glyphDormantReason(id, ability) ?? "")}. Re-slot the ability or move the glyph.</div>`;
  } else if (ability) {
    const row = buildCharacterSheet(s, p).offense.find((r) => r.id === ability);
    const live = glyphsFor(p, ability).map((gid) => GLYPH_INFO[gid].name).join(" + ");
    html += `<div class="tpass">On ${ABILITY_INFO[ability].name}${live ? ` (${live})` : ""}: ` +
      (row?.hit
        ? `<b>${row.hit.min}–${row.hit.max}</b> per hit · <b>${row.hit.cooldown.toFixed(1)}s</b> cooldown</div>`
        : `${row?.note ?? "utility"}</div>`);
    html += cdrCapWarningHtml(p, ability, id);
  }
  return html;
}

/** One socket well. Interactive in a safe room; a read-only pip elsewhere. */
function socketHtml(v: SocketView, slotIdx: number, socketIdx: number, interactive: boolean): string {
  const held = heldGlyph;
  const p = me(state);
  const legal = held && !v.locked &&
    (slotIdx === ULT_SLOT ? !!p.abilities.ultimate : true) &&
    socketLegal(p, slotIdx, socketIdx, held);
  const cls = [
    "sock",
    v.locked ? "locked" : v.glyph ? "filled" : "empty",
    v.dormant ? "dormant" : "",
    interactive && legal ? "target" : "",
    interactive ? "live" : "",
  ].filter(Boolean).join(" ");
  const data = `data-slot="${slotIdx}" data-socket="${socketIdx}"${v.glyph ? ` data-glyph="${v.glyph}"` : ""}`;
  const title = v.locked ? v.reason : v.glyph ? GLYPH_INFO[v.glyph].name : "empty socket";
  return `<i class="${cls}" ${data} title="${esc(title)}">${v.glyph ? glyphIconHtml(v.glyph) : ""}</i>`;
}

function socketRowHtml(p: Player, slotIdx: number, interactive: boolean): string {
  const views = socketViews(p, slotIdx);
  if (views.every((v) => v.locked) && !views.some((v) => v.glyph)) {
    return `<div class="socks locked-row" title="${esc(views[0].reason)}">` +
      views.map((v, i) => socketHtml(v, slotIdx, i, interactive)).join("") + `</div>`;
  }
  return `<div class="socks">${views.map((v, i) => socketHtml(v, slotIdx, i, interactive)).join("")}</div>`;
}

/**
 * Which of your five slots this glyph would actually DO something in, said as
 * slot numbers. With ten stones the bench was a list you could read; at
 * twenty-five it is a wall, and "where does this go" stops being obvious —
 * so the panel answers it per chip instead of making the player socket a
 * stone into each slot in turn to find out. The answer comes from the sim's
 * own socketLegal + glyphMatches, so it can never disagree with the click.
 */
function glyphFitsHtml(p: Player, id: GlyphId): string {
  const fits: string[] = [];
  for (let slot = 0; slot <= ULT_SLOT; slot++) {
    const ability = abilityInSlot(p, slot);
    if (!ability || !glyphMatches(id, ability)) continue;
    // Any open socket on that row will take it (family exclusivity is per
    // socket, so ask the sim about each one rather than guessing).
    const views = socketViews(p, slot);
    const ok = views.some((v, i) => !v.locked && !v.glyph && socketLegal(p, slot, i, id));
    fits.push(`<span class="gfit${ok ? " open" : " full"}">${slot === ULT_SLOT ? "ULT" : slot + 1}</span>`);
  }
  if (fits.length === 0) return `<div class="gfits none">dormant in every slot you have</div>`;
  // An "any"-tagged stone lists all five, which wraps the chip to two rows and
  // breaks the grid for no information. Say it once instead.
  if (fits.length > ULT_SLOT) return `<div class="gfits">fits <span class="gfit open">EVERY SLOT</span></div>`;
  return `<div class="gfits">fits ${fits.join("")}</div>`;
}

/** The glyph bench: everything found and not currently socketed. */
function glyphBenchHtml(p: Player, interactive: boolean): string {
  const bench = (p.glyphs?.bench ?? []) as GlyphId[];
  const found = new Set<GlyphId>([
    ...bench,
    ...(p.glyphs?.slots ?? []).flat().filter(Boolean) as GlyphId[],
    ...(p.glyphs?.ultimate ?? []).filter(Boolean) as GlyphId[],
  ]);
  const seen = `<span class="gcount">${found.size} / ${GLYPH_IDS.length} STONES SEEN</span>`;
  if (bench.length === 0) {
    return seen + `<div class="gbench empty">No loose glyphs. They drop in the dungeon, ` +
      `fall out of band bosses, and the System sells a sealed cache when it feels generous.</div>`;
  }
  // FITTING FIRST. The bench is sorted by whether a stone has anywhere to go
  // right now, then by family (so the two lenses, the two range stones and
  // the three tempo stones land next to the choice they are competing for),
  // then by name. Sorting a copy — bench order is save data.
  const fitsAny = (id: GlyphId): boolean => {
    for (let slot = 0; slot <= ULT_SLOT; slot++) {
      const a = abilityInSlot(p, slot);
      if (a && glyphMatches(id, a)) return true;
    }
    return false;
  };
  const order = bench.map((id, i) => ({ id, i })).sort((a, b) =>
    Number(fitsAny(b.id)) - Number(fitsAny(a.id)) ||
    (GLYPH_INFO[a.id].family ?? "~").localeCompare(GLYPH_INFO[b.id].family ?? "~") ||
    GLYPH_INFO[a.id].name.localeCompare(GLYPH_INFO[b.id].name));
  return seen + `<div class="gbench">` + order.map(({ id, i }) => {
    const info = GLYPH_INFO[id];
    const dead = !fitsAny(id);
    return `<div class="gchip${heldGlyph === id ? " held" : ""}${interactive ? " live" : ""}` +
      `${dead ? " dormant" : ""}" data-bench="${i}" data-glyph="${id}">` +
      `<div class="gbox">${glyphIconHtml(id)}</div>` +
      `<div class="gname">${info.name}</div>` +
      `<div class="gtags">${glyphTagLine(id)}</div>` +
      (info.family ? `<div class="gfam">${info.family} family</div>` : `<div class="gfam none">—</div>`) +
      glyphFitsHtml(p, id) +
      `</div>`;
  }).join("") + `</div>`;
}

/** The ABILITIES tab: loadout bar (The Five) + glyph bench + upgrade cards. */
function renderAbilPage(s: GameState): void {
  const p = me(s);
  const canSocket = !!s.safeRoom || !!settlementShopFor(s, p);
  const slotTile = (id: AbilityId | null, key: string, slotIdx: number, ult = false): string => {
    const cls = `lslot${ult ? " ult" : ""}${id ? "" : " empty"}`;
    const icon = id
      ? `<i class="ii" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>`
      : "";
    const name = id ? ABILITY_INFO[id].name : "empty";
    return `<div class="${cls}" data-slotidx="${slotIdx}">` +
      `<div class="ibox"><span class="lkey">${key}</span>${icon}</div>` +
      `<div class="lname">${name}</div>${socketRowHtml(p, slotIdx, canSocket)}</div>`;
  };
  srLoadout.innerHTML =
    p.abilities.slots.map((id, i) => slotTile(id, String(i + 1), i)).join("") +
    slotTile(p.abilities.ultimate, "U", ULT_SLOT, true);
  // ONE VERB PER INPUT DEVICE. The iPad rendered "CLICK A LIT SOCKET" and the
  // chip's own "IN HAND — TAP A LIT SOCKET" at the same time, on the same
  // screen, about the same gesture. The word pair is the same one the panel
  // hints use, so the two can never drift.
  const verb = `<span class="clickword">click</span><span class="tapword">tap</span>`;
  const hint = heldGlyph
    ? `<b style="color:#b08fd9">${GLYPH_INFO[heldGlyph].name}</b> in hand — ${verb} a lit socket to seat it, ` +
      `or ${verb} the glyph again to put it down.`
    : "Glyphs seat into SLOTS, not abilities: re-slot an ability and it inherits whatever that slot carries. Removal is free.";
  srGlyphs.innerHTML =
    `<div class="sec-label">GLYPH BENCH <span class="ghint">${hint}</span></div>` +
    glyphBenchHtml(p, canSocket);
  srAbil.classList.toggle("graphs", abilView === "graph");
  srAbil.innerHTML = abilBodyHtml(s);
}

/** The ACHIEVEMENTS tab: what the System has recognized (and what it hasn't). */
function renderAchPage(s: GameState): void {
  const p = me(s);
  const unclaimed = p.unclaimedAchievements?.length ?? 0;
  srAchCount.textContent =
    `THE SYSTEM RECOGNIZES — ${p.achievements.length} / ${ACHIEVEMENTS.length} UNLOCKED` +
    (unclaimed > 0 ? ` · ${unclaimed} LOOT BOX${unclaimed === 1 ? "" : "ES"} WAITING` : "");
  srAch.innerHTML = ACHIEVEMENTS.map((a) => {
    const got = p.achievements.includes(a.id);
    const unopened = (p.unclaimedAchievements ?? []).includes(a.id);
    return (
      `<div class="sr-ach${got ? "" : " locked"}${unopened ? " unclaimed" : ""}">` +
      `<div class="atitle">${got ? uic("star") : uic("star_open")} ${a.title}</div>` +
      `<div class="adesc">${a.desc}</div>` +
      (unopened
        ? `<button class="claim-btn" data-claim="${a.id}">◆ OPEN LOOT BOX</button>`
        : `<div class="areward">${got ? "PAID" : "PAYS"} +${a.gold} gold · +${a.hype} hype</div>`) +
      `</div>`
    );
  }).join("");
}

// ACHIEVEMENTS tab: open a claimed-but-unopened achievement's loot box.
srAch.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button[data-claim]") as HTMLButtonElement | null;
  if (!btn) return;
  const id = btn.dataset.claim!;
  audio.play("buy");
  if (net) net.claimAchievement(id);
  else {

    recAct("claim", id);
    claimAchievementLootBox(state, me(state).id, id);
    flushFeedback(state);
    persistRun(state);
  }
  renderAchPage(state);
});

/** The SYSTEM SHOP tab: shelf + detail + bag. */
// Bag density thresholds: item counts at which the bag grid steps down a tile
// size (see .bag-grid.dense/.micro in iso.html), sized so each tier fills its
// rows before the bag would crowd the detail pane out of the side column.
const BAG_DENSE_AT = 19; // 40px tiles hold 3 comfortable rows
const BAG_MICRO_AT = 46; // 32px tiles hold ~6 rows
const BAG_SHOW_MAX = 79; // beyond ~8 micro rows, the tail becomes "+K more"

function renderShopPage(s: GameState): void {
  const room = shopRoomOf(s);
  if (!room) return;
  const p = me(s);
  srTabStock.classList.toggle("active", shopView === "stock");
  srTabAll.classList.toggle("active", shopView === "all");
  srTabChase.classList.toggle("active", shopView === "chase");
  const avail = new Set(room.available);
  const owned = ownedCatalogCounts(p);
  const shopIndex = room.nextFloor - 1;
  // THE CHASE (V2 §2.5): its own case, because it is not inventory. Five
  // drop-only boss uniques behind glass — the run's want-list, and the reason
  // the floor-3 boss means something. No prices: the currency is the fight.
  if (shopView === "chase") {
    srShelf.innerHTML =
      `<div class="tier-h chase-h" style="--tc:#c0392f">DROP-ONLY — ONE PER BAND BOSS` +
      `<span class="tnote">the System does not stock these, and neither will anyone else</span></div>` +
      `<div class="chase-list">` +
      CHASE_ENTRIES.map(({ floor, entry }) => {
        const got = (owned[entry.id] ?? 0) > 0;
        const sel = shopSel?.kind === "catalog" && shopSel.id === entry.id ? " sel" : "";
        return (
          `<div class="chase-row${got ? " owned" : ""}${sel}" data-id="${entry.id}">` +
          `<div class="itile tier-legendary chase ${got ? "owned" : "sealed"}" style="--tc:#c0392f">` +
          `<div class="ibox">${itemIconHtml(entry.id)}<b class="gem"></b></div></div>` +
          `<div class="cbody"><div class="cname">${entry.name}` +
          `<span class="cstate">${got ? "CLAIMED" : "UNCLAIMED"}</span></div>` +
          `<div class="cdesc">${entry.desc}</div>` +
          `<div class="cboss">FLOOR ${floor} · ${(BOSS_NAME_BY_FLOOR[floor] ?? "").toUpperCase()}</div></div>` +
          `</div>`
        );
      }).join("") + `</div>`;
    renderShopSide(s);
    return;
  }
  // The shelf, tier by tier.
  let shelf = "";
  for (const tier of TIERS) {
    const pool = CATALOG.filter((e) => e.tier === tier && (e.id !== "tome" || room.tomeAbility));
    const entries = shopView === "stock" ? pool.filter((e) => avail.has(e.id)) : pool;
    if (entries.length === 0) continue;
    const unlock = TIER_UNLOCK_SHOP[tier];
    // The shelf says how many of this tier you can actually click right now —
    // the number that decides the next 30 seconds of the safe room.
    const readyN = entries.filter((e) => buyBlocker(s, e) === null).length;
    const note = shopIndex < unlock
      ? `<span class="tnote">— unlocks at shop ${unlock}</span>`
      : readyN > 0
        ? `<span class="tnote ready">— ${readyN} ready to buy</span>`
        : shopView === "all" && entries.some((e) => !avail.has(e.id))
          ? `<span class="tnote">— stock varies by shop</span>`
          : "";
    // Curated case, never a half-stocked shelf (r4 minor): sparse tiers
    // complete their row with recessed diamond-socket wells. 11 tiles fit a
    // shelf row at 56px+8 gap; pad only to the end of the partial row so the
    // shelf never grows a whole row of dead sockets (panels fit the viewport).
    const perRow = 11;
    const wells = (perRow - (entries.length % perRow)) % perRow;
    shelf +=
      `<div class="tier-h" style="--tc:${TIER_COLOR[tier]}">${TIER_LABEL[tier]}${note}</div>` +
      `<div class="igrid">${entries.map((e) => shelfTileHtml(s, e, owned)).join("")}` +
      `<div class="itile well"><div class="ibox"></div></div>`.repeat(wells) + `</div>`;
  }
  srShelf.innerHTML = shelf;
  renderShopSide(s);
}

/** The side column (equipped + bag + detail) — shared by every shelf view. */
function renderShopSide(s: GameState): void {
  const p = me(s);
  // Equipped + bag.
  srEquipped.innerHTML = EQUIP_SLOTS.map((slot) => {
    const it = p.equipment[slot];
    if (!it) return `<div class="itile eslot" title="${slot}: empty"><div class="ibox"></div></div>`;
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
// Purchase/bench confirmation stamp: a transient plate inside the safe-room
// panel (no new screen zone — it lives in #saferoom, z 24). Every gold-spending
// verb ends with a legible "this happened", so a combine reads as an EVENT.
const srStamp = document.getElementById("sr-stamp")!;
let stampTimer = 0;
function shopStamp(verb: string, name: string, color: string): void {
  srStamp.innerHTML = `<span class="verb">${verb}</span><span class="what">${esc(name)}</span>`;
  srStamp.style.setProperty("--sc", color);
  srStamp.classList.remove("show");
  void srStamp.offsetWidth; // restart the animation
  srStamp.classList.add("show");
  window.clearTimeout(stampTimer);
  stampTimer = window.setTimeout(() => srStamp.classList.remove("show"), 2400);
}

function flushFeedback(s: GameState): void {
  for (const a of s.announcements) showAnnouncement(a);
  for (const e of s.events) pushLogLine(e);
  s.announcements = [];
  s.events = [];
}

// Shelf: click a tile to inspect it (locked tiles too — that's the planner).
srShelf.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-id], .chase-row[data-id]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "catalog", id: tile.dataset.id! };
  shopFocusDetail();
  renderSafeRoom(state);
});

// Detail pane: BUY / SELL / EQUIP buttons + build-tree navigation.
srDetail.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const buyBtn = el.closest("button[data-buy]") as HTMLButtonElement | null;
  if (buyBtn && !buyBtn.disabled) {
    const id = buyBtn.dataset.buy!;
    const entry = CATALOG_BY_ID[id];
    audio.play("buy");
    if (net) net.buy(id);
    else {

      recAct("buy", id);
      buyCatalogItem(state, me(state).id, id);
      flushFeedback(state);
      persistRun(state);
    }
    renderSafeRoom(state);
    // Purchase feedback (audit #8): gold flash on the detail pane, wallet bump.
    srDetail.classList.remove("purchased");
    void srDetail.offsetWidth; // restart the animation
    srDetail.classList.add("purchased");
    srWallet.querySelector(".chip")?.classList.add("bump");
    // …plus the ACQUIRED stamp (V2 shop pass): a combine is the moment the
    // build clicks, so the pane says so out loud instead of quietly redrawing.
    if (entry) {
      shopStamp(entry.buildsFrom?.length ? "COMBINED" : "ACQUIRED", entry.name, TIER_COLOR[entry.tier]);
    }
    return;
  }
  // ---- Bench verbs (V2 §2.4). Both are sim calls; the host only asks. ----
  const refitBtn = el.closest("button[data-refit]") as HTMLButtonElement | null;
  if (refitBtn && !refitBtn.disabled) {
    const raw = refitBtn.dataset.refit!;
    const ref = /^\d+$/.test(raw) ? Number(raw) : (raw as ItemSlot);
    const before = shopSel?.kind === "bag" ? me(state).inventory[shopSel.idx]
      : shopSel?.kind === "equipped" ? me(state).equipment[shopSel.slot] : null;
    audio.play("buy");
    if (net) net.refit(raw);
    else {

      recAct("refit", ref);
      refitItem(state, me(state).id, ref);
      flushFeedback(state);
      persistRun(state);
    }
    renderSafeRoom(state);
    if (before) shopStamp("REFIT", `${before.name} — ${before.rarity.toUpperCase()}`, RARITY_TEXT[before.rarity]);
    return;
  }
  const scrapBtn = el.closest("button[data-dismantle]") as HTMLButtonElement | null;
  if (scrapBtn) {
    const idx = Number(scrapBtn.dataset.dismantle);
    const item = me(state).inventory[idx];
    const yield_ = item ? dismantleYield(item) : 0;
    audio.play("buy");
    if (net) net.dismantle(idx);
    else {

      recAct("dismantle", idx);
      dismantleItem(state, me(state).id, idx);
      flushFeedback(state);
      persistRun(state);
    }
    shopSel = null;
    renderSafeRoom(state);
    shopStamp("DISMANTLED", `+${yield_} refit shard${yield_ === 1 ? "" : "s"}`, "#8fb0d9");
    return;
  }
  const sellBtn = el.closest("button[data-sell]") as HTMLButtonElement | null;
  if (sellBtn) {
    const idx = Number(sellBtn.dataset.sell);
    if (net) net.sell(idx);
    else {

      recAct("sell", idx);
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

      recAct("equip", idx);
      equipFromInventory(state, me(state).id, idx);
      flushFeedback(state);
      persistRun(state);
    }
    shopSel = null;
    renderSafeRoom(state);
    return;
  }
  const nav = el.closest(".itile[data-id], .dfeat[data-id]") as HTMLElement | null;
  if (nav) {
    shopSel = { kind: "catalog", id: nav.dataset.id! };
    renderSafeRoom(state);
  }
});

srEquipped.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-slot]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "equipped", slot: tile.dataset.slot as ItemSlot };
  shopFocusDetail();
  renderSafeRoom(state);
});

srBag.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-bag]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "bag", idx: Number(tile.dataset.bag) };
  shopFocusDetail();
  renderSafeRoom(state);
});

// SELL ALL: liquidate the bag in one click (equipped gear is safe by design).
document.getElementById("sr-sellall")!.addEventListener("click", () => {
  if (me(state).inventory.length === 0) return;
  audio.play("buy");
  if (net) net.sellAll();
  else {

    recAct("sellAll");
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
  const tc = itemColor(it);
  const into = it.catalogId ? buildsInto(it.catalogId) : [];
  const refit = refitCost(it);
  return (
    `<div class="tname" style="color:${tc}">${it.name}${qualityPipsHtml(it)}</div>` +
    `<div class="tmeta">${itemKindLine(it)}</div>` +
    (affixLines(it).map((l) => `<div class="taff">${l}</div>`).join("") || `<div class="taff">—</div>`) +
    (it.passive && it.catalogId ? `<div class="tpass">${CATALOG_BY_ID[it.catalogId].desc}</div>` : "") +
    (into.length ? `<div class="tbuild">component of: ${into.map((e) => e.name).join(", ")}</div>` : "") +
    (refit ? `<div class="tbuild">refits to ${refit.to} — ${refit.shards} shards + ${refit.gold}g</div>` : "") +
    `<div class="tsell">sells for ${sellValue(it)} gold · dismantles for ${dismantleYield(it)}</div>`
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
srTabChase.addEventListener("click", () => { shopView = "chase"; renderSafeRoom(state); });
srTabShop.addEventListener("click", () => { srTab = "shop"; renderSafeRoom(state); });
srTabAbil.addEventListener("click", () => { srTab = "abil"; renderSafeRoom(state); });
srTabAch.addEventListener("click", () => { srTab = "ach"; renderSafeRoom(state); });
srAbil.addEventListener("click", (e) => handleSlotClick(e, renderSafeRoom));
// The loadout bar's socket wells and the glyph bench share one dispatcher.
srLoadout.addEventListener("click", handleGlyphClick);
srGlyphs.addEventListener("click", handleGlyphClick);

// Glyph tooltips ride the same cursor layer as item cards (#itemtip, z 30):
// hovering a socket or a bench chip prints the composed behavior — what the
// glyph does, and what the ability does WITH it (numbers off the sheet).
function glyphIdUnder(el: HTMLElement): { id: GlyphId; slotIdx: number | null; dormant: boolean } | null {
  const sock = el.closest(".sock[data-glyph]") as HTMLElement | null;
  if (sock) {
    return {
      id: sock.dataset.glyph as GlyphId,
      slotIdx: Number(sock.dataset.slot),
      dormant: sock.classList.contains("dormant"),
    };
  }
  const chip = el.closest(".gchip[data-glyph]") as HTMLElement | null;
  if (chip) return { id: chip.dataset.glyph as GlyphId, slotIdx: null, dormant: false };
  return null;
}
for (const container of [srLoadout, srGlyphs, srAbil]) {
  container.addEventListener("mouseover", (e) => {
    const hit = glyphIdUnder(e.target as HTMLElement);
    // A LOCKED empty socket still owes an explanation.
    const lock = (e.target as HTMLElement).closest(".sock.locked") as HTMLElement | null;
    if (!hit && !lock) { itemTipEl.style.display = "none"; return; }
    itemTipEl.innerHTML = hit
      ? glyphTipHtml(state, hit.id, hit.slotIdx, hit.dormant)
      : `<div class="tname" style="color:#6f6757">SEALED SOCKET</div>` +
        `<div class="taff">${esc(lock!.title)}. Sockets belong to the slot — every active slot opens one at ` +
        `level ${CONFIG.glyphSocket1Level}, and their second sockets open one at a time ` +
        `(levels ${CONFIG.glyphSocket2Levels.join(", ")}) so you always have a stone for the next one.</div>`;
    itemTipEl.style.display = "block";
    moveItemTip(e as MouseEvent);
  });
  container.addEventListener("mousemove", (e) => {
    if (itemTipEl.style.display === "block") moveItemTip(e as MouseEvent);
  });
  container.addEventListener("mouseleave", () => { itemTipEl.style.display = "none"; });
}

srDescend.addEventListener("click", () => {
  // Settlement outfitter: the button is an exit, not a descent.
  if (!state.safeRoom) {
    settlementShopOpen = false;
    hideOverlay(srEl);
    return;
  }
  if (net) {
    net.ready(); // modal stays until the whole party is ready (snapshot clears it)
    return;
  }

  recAct("ready");
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

/**
 * Hotbar chip labels. The default is the name's LAST word (which is why the
 * bar reads "Barrage", "Cables", "Double" and that is right), but ABILITIES-V2
 * renamed two ultimates into last words that carry no meaning on their own:
 * Fault Line became "Line" and Bullet Time became "Time". The chip is ~58px,
 * so the fix is a distinctive short word per exception, not a wider chip.
 */
const CHIP_LABEL: Partial<Record<AbilityId, string>> = {
  cataclysm: "Fault",
  bullettime: "Bullet",
  injunction: "Stay", // what the ability IS; "Injunction" does not fit the chip
};

const chipLabel = (id: AbilityId): string =>
  CHIP_LABEL[id] ?? ABILITY_INFO[id].name.split(" ").pop()!;

function updateSkills(s: GameState): void {
  const p = me(s);
  const slotActions = ["slot1", "slot2", "slot3", "slot4", "ultimate"] as const;
  const entries: { ability: AbilityId | null; ult: boolean }[] = [
    ...p.abilities.slots.map((a) => ({ ability: a, ult: false })),
    { ability: p.abilities.ultimate, ult: true },
  ];
  // Socketed glyphs are part of the chip's identity (V2 §3): the bar rebuilds
  // when firmware changes, exactly as it does when the loadout does.
  const glyphKey = [...(p.glyphs?.slots ?? []).map((a) => a.join(",")), (p.glyphs?.ultimate ?? []).join(",")]
    .join("|") + `|L${glyphSocketCount(p.level)}`;
  // Drafted RANKS ride the key too, now that the chip's tooltip states the
  // composed behavior: a bar that never rebuilds after a draft would keep
  // describing the ability you had two levels ago.
  let rankSum = 0;
  for (const v of Object.values(p.abilities.ranks)) rankSum += v;
  const key = entries.map((e) => e.ability ?? "-").join("|") +
    `|d${p.dashCharges}|f${p.flaskCharges}.${p.flaskKillProgress}|s${p.stance}|o${p.overcharged ? 1 : 0}|${glyphKey}|r${rankSum}`;
  if (key !== skillBarKey) {
    skillBarKey = key;
    // Charge pip rows (r2): banked charges read as gold gem pips seated in
    // the frame's bottom edge — Dash ×2, Slurp ×3 — not a "×N" text tag.
    const pipRow = (have: number, max: number): string =>
      `<span class="cpips">` +
      Array.from({ length: max }, (_, i) => `<i class="cpip${i < have ? " on" : ""}"></i>`).join("") +
      `</span>`;
    skillsEl.innerHTML = entries
      .map((e, i) => {
        const bind = bindingLabel(bindings, slotActions[i]).split(" / ")[0];
        const label = e.ability
          ? (e.ability === "dash"
            ? "Dash" // charges read on the pip row below
            : e.ability === "stance"
              ? (p.stance === "melee" ? "Brawler" : "Deadeye") // the chip IS the stance indicator
              : e.ability === "overcharge" && p.overcharged
                ? "CHARGED" // banked and waiting for the next attack
                : chipLabel(e.ability))
          : "";
        const pips = e.ability === "dash" ? pipRow(p.dashCharges, CONFIG.dashCharges) : "";
        // GLYPH PIPS (V2 §3): tiny seated gems on the chip's top edge, one per
        // socket this slot has open. A live glyph shows its painted stone; a
        // DORMANT one (wrong tags for the ability now in the slot) sits dark,
        // so a bad re-slot is visible from the cockpit, not just the panel.
        const gv = socketViews(p, i === ABILITY_SLOTS ? ULT_SLOT : i).filter((v) => !v.locked || v.glyph);
        const gpips = gv.length
          ? `<span class="gpips">` + gv.map((v) =>
            `<i class="gpip${v.glyph ? (v.dormant ? " dormant" : " on") : ""}">` +
            `${v.glyph ? glyphIconHtml(v.glyph) : ""}</i>`).join("") + `</span>`
          : "";
        const cls = `skill${e.ult ? " ult" : ""}${e.ability ? "" : " empty"}`;
        // Icon by convention: /icons/<abilityId>.svg (game-icons.net, tinted via CSS mask).
        const icon = e.ability
          ? `<i class="icon" style="mask-image:url(/icons/${e.ability}.svg);-webkit-mask-image:url(/icons/${e.ability}.svg)"></i>`
          : `<i class="icon"></i>`;
        // The COMPOSED read, on the chip itself. A player mid-run should not
        // have to open a panel to answer "what is this key doing right now,
        // with the ranks I drafted and the stones I seated".
        const tip = e.ability
          ? ` title="${esc(`${ABILITY_INFO[e.ability].name} — ${composedText(s, e.ability)}`)}"`
          : "";
        return `<div class="${cls}" data-i="${i}"${tip}><span class="key">${bind}</span>${gpips}${icon}` +
          `<span class="label">${label}</span>${pips}<span class="sweep"></span><span class="flashfx"></span></div>`;
      })
      .join("") +
      // Flask chip (cockpit-style): charges on the pip row; the radial
      // sweep shows progress toward the next charge (kills refill it).
      (CONFIG.flaskEnabled
        ? `<div class="skill${p.flaskCharges > 0 ? " ready" : " empty"}" id="flask-chip" ` +
          `style="--cd:${p.flaskCharges >= CONFIG.flaskMaxCharges ? 0 : (1 - p.flaskKillProgress / CONFIG.flaskKillsPerCharge).toFixed(3)}">` +
          `<span class="key">${bindingLabel(bindings, "flask").split(" / ")[0]}</span>` +
          `<i class="icon" style="mask-image:url(/icons/flask.svg);-webkit-mask-image:url(/icons/flask.svg)"></i>` +
          `<span class="label">Slurp</span>${pipRow(p.flaskCharges, CONFIG.flaskMaxCharges)}` +
          `<span class="sweep"></span><span class="flashfx"></span>` +
          `</div>`
        : "");
    // The rebuild replaced every chip ELEMENT, so the zone table's placement
    // went with them; an unplaced chip collapses into the top-left corner.
    // Re-measure too, or the router keeps hit-testing against dead rects.
    hud.placeCluster();
    touchShell.measureChips();
  }
  syncIngame();
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
    // Ready-flash (audit #4): the moment a REAL cooldown completes, the chip
    // blooms once. "armed" only while a sweep is actually running, so loadout
    // rebuilds and already-ready chips never flash spuriously.
    const wasReady = chip.dataset.rdy === "1";
    if (frac > 0.02) chip.dataset.armed = "1";
    if (ready && !wasReady && chip.dataset.armed === "1") {
      chip.dataset.armed = "0";
      chip.classList.remove("flash");
      void chip.offsetWidth; // restart the animation
      chip.classList.add("flash");
    }
    chip.dataset.rdy = ready ? "1" : "0";
  });
  // THE FLASK MUST SHOUT WHEN IT MATTERS (MOBILE.md §2.7).
  //
  // Driven at 30-35% HP on three devices, `#flask-chip` still read
  // `class="skill ready"` with `animation-name: none`. On a 342px-tall phone
  // the flask is the one chip that has to reach you through a boss's
  // particles, and "the same as every other chip" is not a state. Two signals,
  // both cheap: the chip pulses while you are in the danger band with a charge
  // in hand, and a refilled charge fires a haptic — the one event a player
  // wants to feel without looking, because looking costs a dodge.
  const flaskEl = document.getElementById("flask-chip");
  if (flaskEl) {
    const low = p.maxHp > 0 && p.hp / p.maxHp <= LOW_HP_FRAC;
    flaskEl.classList.toggle("lowhp", low && p.flaskCharges > 0);
    // Dry AND dying is its own state: pulsing a chip that cannot fire would be
    // a lie, so it gets the danger tint without the invitation to press.
    flaskEl.classList.toggle("lowhp-dry", low && p.flaskCharges === 0);
    if (p.flaskCharges > lastFlaskCharges && lastFlaskCharges >= 0) haptics.fire("potion");
    lastFlaskCharges = p.flaskCharges;
  }
  // XP strip (health lives in the top-left HUD).
  xpFill.style.width = `${Math.max(0, Math.min(1, p.xp / p.xpToNext)) * 100}%`;
}

/** The band the flask chip starts asking to be pressed in. */
const LOW_HP_FRAC = 0.38;
let lastFlaskCharges = -1;

// ---- LOOT, ACKNOWLEDGED (MOBILE.md §2.7) ---------------------------------
//
// Measured on all four devices with a live drop on the floor: NO renderer key
// matching `pickup|lootring|magnet`, and NO DOM node matching
// `pickup|lootstrip`. Collection was a silent state change — the strongest
// dopamine beat in an ARPG, delivered as nothing at all on a phone.
//
// Two signals, and neither invents a rule. The ground ring paints the sim's
// own `CONFIG.pickupRadius` while there is something in range to take; the
// strip names what was taken, read off deltas in the crawler's own numbers so
// the sim needs no new event type.
const pickStrip = (() => {
  const el = document.createElement("div");
  el.id = "pickstrip";
  document.body.appendChild(el);
  return el;
})();

let lastGold = -1;
let lastBagN = -1;
let lastMatN = -1;

function pushPickup(text: string, color: string, qty = ""): void {
  const row = document.createElement("div");
  row.className = "pickrow";
  row.style.setProperty("--pc", color);
  row.innerHTML = `<b>${esc(text)}</b>${qty ? `<span class="pq">${esc(qty)}</span>` : ""}`;
  pickStrip.appendChild(row);
  // A monotonic count, because the rows themselves live ~1.8 s and a harness
  // running at SwiftShader's 1-3 fps will measure long after they are gone.
  pickStrip.dataset.picks = String((Number(pickStrip.dataset.picks) || 0) + 1);
  // Three rows is the whole budget: a pack death drops five things at once and
  // a phone has no room to list them.
  while (pickStrip.childElementCount > 3) pickStrip.firstElementChild!.remove();
  requestAnimationFrame(() => row.classList.add("on"));
  window.setTimeout(() => {
    row.classList.remove("on");
    window.setTimeout(() => row.remove(), 220);
  }, 1600);
  renderer.pulsePickup();
  haptics.fire("pickup");
}

function syncPickupFeedback(): void {
  const p = me(state);
  if (!p) return;
  // The ring: the sim's radius, painted, while anything is close enough to be
  // worth walking to. `null` while the floor is clear, so it never becomes
  // permanent chrome the eye stops seeing.
  let near: number | null = null;
  for (const l of state.loot) {
    const d = Math.hypot(l.pos.x - p.pos.x, l.pos.y - p.pos.y);
    if (near === null || d < near) near = d;
  }
  renderer.setPickupRing(near !== null && near <= 3.2 ? p.pos : null, CONFIG.pickupRadius);

  const bagN = p.inventory.length;
  const matN = Object.values(p.materials).reduce((a, b) => a + (b ?? 0), 0);
  if (lastGold >= 0 && p.gold > lastGold) {
    pushPickup(`+${p.gold - lastGold} gold`, "#f2c14e");
  }
  if (lastBagN >= 0 && bagN > lastBagN) {
    const it = p.inventory[bagN - 1];
    if (it) pushPickup(it.name, RARITY_TEXT[it.rarity] ?? "#c9a24b", it.slot.toUpperCase());
  }
  if (lastMatN >= 0 && matN > lastMatN) {
    pushPickup(`+${matN - lastMatN} materials`, "#8fb0d9");
  }
  lastGold = p.gold; lastBagN = bagN; lastMatN = matN;
}

// Top-down minimap (audit r2): a surveyor's chart, not a raw pixel dump. The
// view auto-frames the EXPLORED region (fog-of-war reveal fills the frame as
// you map the floor), rooms get warm parchment fills with drawn bronze
// outlines, and the static geometry renders once per reveal onto an offscreen
// cache — the per-frame cost is one drawImage + a handful of dots.
const mmView = { s: 0, ox: 0, oy: 0 }; // world tile -> canvas px transform
const mmStatic = document.createElement("canvas");
const mmStaticCtx = mmStatic.getContext("2d")!;
let mmKey = "";

function rebuildMinimapStatic(s: GameState, minX: number, minY: number, maxX: number, maxY: number): void {
  const map = s.map;
  const W = minimap.width, H = minimap.height, pad = 12;
  mmStatic.width = W;
  mmStatic.height = H;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  // Uniform scale, capped LOW so a barely-explored floor renders as a drawn
  // chart, never giant solid slabs (r3 minor: one minimap material spec at
  // every zoom — parchment fill, stroked walls, fixed-size actor marks).
  const sc = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 8);
  mmView.s = sc;
  mmView.ox = (W - bw * sc) / 2 - minX * sc;
  mmView.oy = (H - bh * sc) / 2 - minY * sc;
  const g = mmStaticCtx;
  g.clearRect(0, 0, W, H);
  // ONE CHART SPEC AT EVERY STATE (r6 major: "gold-speckle noise background…
  // near-zero contrast"): the canvas lays its own opaque dark neutral ground
  // first, so the chart never inherits the bezel's textured backing — rooms
  // then sit on it at a high-contrast parchment value.
  g.fillStyle = "#15100b";
  g.fillRect(0, 0, W, H);
  const X = (x: number): number => mmView.ox + x * sc;
  const Y = (y: number): number => mmView.oy + y * sc;
  const walkable = (i: number): boolean => !!s.explored[i] && map.tiles[i] !== Tile.Wall;
  const wallAt = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= map.w || y >= map.h || map.tiles[y * map.w + x] === Tile.Wall;
  // Pass 1: floor fills — flat high-contrast parchment (the r5 hash-speckle
  // read as compression noise at 1x); corridors a step darker so passages
  // read as passages, plus a faint survey grid.
  const ROOM = "#97794a";
  const CORRIDOR = "#6b5530";
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * map.w + x;
      if (!walkable(i)) continue;
      const t = map.tiles[i];
      const corridor =
        (wallAt(x - 1, y) && wallAt(x + 1, y)) || (wallAt(x, y - 1) && wallAt(x, y + 1));
      g.fillStyle =
        t === Tile.StairsDown ? "#e8b84f" :
        t === Tile.DoorLocked ? "#f2c14e" :
        corridor ? CORRIDOR : ROOM;
      g.fillRect(X(x), Y(y), sc + 0.5, sc + 0.5);
      if (t !== Tile.StairsDown && t !== Tile.DoorLocked) {
        g.fillStyle = "rgba(20,14,8,0.12)"; // engraved survey grid
        g.fillRect(X(x + 1) - 0.5, Y(y), 0.5, sc);
        g.fillRect(X(x), Y(y + 1) - 0.5, sc, 0.5);
      }
    }
  }
  // Pass 1b: DOORWAY thresholds — where a corridor mouth meets a room, ink a
  // short bronze lintel across the passage so the chart shows doorways, not
  // just an undifferentiated tan blob.
  g.fillStyle = "rgba(201,162,75,0.55)";
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * map.w + x;
      if (!walkable(i)) continue;
      const nsWalls = wallAt(x - 1, y) && wallAt(x + 1, y);
      const ewWalls = wallAt(x, y - 1) && wallAt(x, y + 1);
      if (!nsWalls && !ewWalls) continue;
      // A corridor tile adjacent to an open (room) tile = a threshold.
      const roomward = (nx: number, ny: number): boolean => {
        const ni = ny * map.w + nx;
        return !wallAt(nx, ny) && !!s.explored[ni] &&
          !((wallAt(nx - 1, ny) && wallAt(nx + 1, ny)) || (wallAt(nx, ny - 1) && wallAt(nx, ny + 1)));
      };
      if (nsWalls && roomward(x, y - 1)) g.fillRect(X(x), Y(y) - 0.6, sc, 1.2);
      if (nsWalls && roomward(x, y + 1)) g.fillRect(X(x), Y(y + 1) - 0.6, sc, 1.2);
      if (ewWalls && roomward(x - 1, y)) g.fillRect(X(x) - 0.6, Y(y), 1.2, sc);
      if (ewWalls && roomward(x + 1, y)) g.fillRect(X(x + 1) - 0.6, Y(y), 1.2, sc);
    }
  }
  // Pass 2: drawn room outlines — an inked bronze rule wherever explored
  // floor meets wall, and a soft FEATHERED fog edge (shadow-blurred stroke,
  // never a hard slice) where the chart trails into the unexplored dark.
  g.lineWidth = 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * map.w + x;
      if (!walkable(i)) continue;
      const edges: [number, number, number, number, boolean][] = [];
      const check = (nx: number, ny: number, x1: number, y1: number, x2: number, y2: number): void => {
        const out = nx < 0 || ny < 0 || nx >= map.w || ny >= map.h;
        const ni = ny * map.w + nx;
        if (out || map.tiles[ni] === Tile.Wall) edges.push([x1, y1, x2, y2, true]);
        else if (!s.explored[ni]) edges.push([x1, y1, x2, y2, false]);
      };
      check(x, y - 1, X(x), Y(y), X(x + 1), Y(y));
      check(x, y + 1, X(x), Y(y + 1), X(x + 1), Y(y + 1));
      check(x - 1, y, X(x), Y(y), X(x), Y(y + 1));
      check(x + 1, y, X(x + 1), Y(y), X(x + 1), Y(y + 1));
      for (const [x1, y1, x2, y2, isWall] of edges) {
        g.save();
        if (isWall) {
          // Crisp 1px gold wall rule on the dark ground (r6 chart spec).
          g.strokeStyle = "rgba(233,197,104,0.95)";
          g.lineWidth = 1;
          g.shadowColor = "rgba(0,0,0,0.8)";
          g.shadowBlur = 1.5;
        } else {
          g.strokeStyle = "rgba(8,5,3,0.85)";
          g.lineWidth = 2;
          g.shadowColor = "rgba(8,5,3,0.9)";
          g.shadowBlur = 5; // the fog FEATHERS over the vellum
        }
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.restore();
        g.lineWidth = 1;
      }
    }
  }
}

function drawMinimap(s: GameState): void {
  const map = s.map;
  // Explored bbox scan (cheap: one pass over the tile grid). The count keys
  // the static cache — a new reveal or a new floor triggers one rebuild.
  let minX = map.w, minY = map.h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const i = y * map.w + x;
      if (!s.explored[i] || map.tiles[i] === Tile.Wall) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const W = minimap.width, H = minimap.height;
  if (maxX < 0) { mmCtx.clearRect(0, 0, W, H); return; }
  // Location Scout marks the stairs through fog — keep them inside the frame.
  const scout = hasPassive(me(s), "pathfinder");
  if (scout) {
    minX = Math.min(minX, Math.floor(s.map.stairs.x));
    maxX = Math.max(maxX, Math.floor(s.map.stairs.x));
    minY = Math.min(minY, Math.floor(s.map.stairs.y));
    maxY = Math.max(maxY, Math.floor(s.map.stairs.y));
  }
  const key = `${s.floor}:${map.w}x${map.h}:${count}:${scout ? 1 : 0}`;
  if (key !== mmKey) {
    mmKey = key;
    rebuildMinimapStatic(s, minX, minY, maxX, maxY);
  }
  mmCtx.clearRect(0, 0, W, H);
  mmCtx.drawImage(mmStatic, 0, 0);
  const X = (x: number): number => mmView.ox + x * mmView.s;
  const Y = (y: number): number => mmView.oy + y * mmView.s;
  const vis2 = CONFIG.fogVisionRadius * CONFIG.fogVisionRadius;
  // Enemies as EMBER GLYPHS, not raw red squares (r4 major): small rotated
  // diamonds with a warm halo and an ink keyline — chart marks, not debug
  // pixels. Bosses burn bigger with a ring.
  mmCtx.save();
  mmCtx.shadowBlur = 4;
  for (const m of s.monsters) {
    const dx = m.pos.x - me(s).pos.x, dy = m.pos.y - me(s).pos.y;
    if (dx * dx + dy * dy > vis2) continue;
    const boss = m.kind === "boss";
    const cx = X(m.pos.x), cy = Y(m.pos.y);
    const r = boss ? 3.6 : 2.1;
    mmCtx.shadowColor = boss ? "rgba(255,110,70,0.9)" : "rgba(224,110,60,0.7)";
    mmCtx.fillStyle = boss ? "#ff7a4d" : "#e0703f";
    mmCtx.strokeStyle = "rgba(10,7,4,0.85)";
    mmCtx.lineWidth = 0.8;
    mmCtx.beginPath();
    mmCtx.moveTo(cx, cy - r);
    mmCtx.lineTo(cx + r, cy);
    mmCtx.lineTo(cx, cy + r);
    mmCtx.lineTo(cx - r, cy);
    mmCtx.closePath();
    mmCtx.fill();
    mmCtx.stroke();
    if (boss) {
      mmCtx.beginPath();
      mmCtx.arc(cx, cy, r + 2.2, 0, Math.PI * 2);
      mmCtx.strokeStyle = "rgba(255,122,77,0.6)";
      mmCtx.stroke();
    }
  }
  mmCtx.restore();
  for (const pl of s.players) {
    if (!pl.alive) {
      // Downed crawler: a hollow red ring — go stand inside it.
      mmCtx.strokeStyle = "#c0392f";
      mmCtx.lineWidth = 1.5;
      mmCtx.beginPath();
      mmCtx.arc(X(pl.pos.x), Y(pl.pos.y), 4, 0, Math.PI * 2);
      mmCtx.stroke();
      continue;
    }
    const isMe = pl.id === me(s).id;
    if (isMe) {
      // YOU are a glowing gold chevron pointing where you face — the D2R/LoL
      // player-arrow read, not an anonymous dot (AAA r2 minor).
      const ang = Math.atan2(pl.facing.y, pl.facing.x);
      mmCtx.save();
      mmCtx.translate(X(pl.pos.x), Y(pl.pos.y));
      mmCtx.rotate(ang + Math.PI / 2);
      mmCtx.shadowColor = "rgba(242,193,78,0.9)";
      mmCtx.shadowBlur = 7;
      mmCtx.fillStyle = "#ffedb8";
      mmCtx.strokeStyle = "rgba(10,7,4,0.9)";
      mmCtx.lineWidth = 1;
      mmCtx.beginPath();
      mmCtx.moveTo(0, -4.8);
      mmCtx.lineTo(3.5, 3.9);
      mmCtx.lineTo(0, 1.9);
      mmCtx.lineTo(-3.5, 3.9);
      mmCtx.closePath();
      mmCtx.fill();
      mmCtx.stroke();
      mmCtx.restore();
      continue;
    }
    mmCtx.fillStyle = "#86b86a";
    mmCtx.strokeStyle = "rgba(10,7,4,0.9)";
    mmCtx.lineWidth = 1;
    mmCtx.beginPath();
    mmCtx.arc(X(pl.pos.x), Y(pl.pos.y), 2.6, 0, Math.PI * 2);
    mmCtx.fill();
    mmCtx.stroke();
  }

  // THE GHOST on the chart: a hollow desaturated ring where the rival was at
  // this tick, drawn only while they are on YOUR floor. It is a trajectory,
  // never a shared world - no collision, no loot, no damage.
  if (ghost) {
    const at = social.ghostAt(ghost, runTicks);
    if (at && at.floor === s.floor) {
      mmCtx.save();
      mmCtx.strokeStyle = "rgba(232,221,200,0.75)";
      mmCtx.setLineDash([2, 2]);
      mmCtx.lineWidth = 1.4;
      mmCtx.beginPath();
      mmCtx.arc(X(at.x), Y(at.y), 3.4, 0, Math.PI * 2);
      mmCtx.stroke();
      mmCtx.restore();
    }
  }
  // Party pings: gold pulses (they pierce fog — that's the point of a ping).
  for (const pg of s.pings) {
    const cycle = 1 - ((pg.t * 1.6) % 1);
    mmCtx.strokeStyle = "#f2c14e";
    mmCtx.lineWidth = 1.5;
    mmCtx.globalAlpha = 0.9 - cycle * 0.6;
    mmCtx.beginPath();
    mmCtx.arc(X(pg.pos.x), Y(pg.pos.y), 2 + cycle * 4, 0, Math.PI * 2);
    mmCtx.stroke();
    mmCtx.globalAlpha = 1;
  }
  // Roam: settlement pennants + active-contract pins, in the same engraved
  // chart language as the rest of the surveyor's minimap.
  if (s.runKind === "roam") drawRoamPins(s, X, Y);
  // Location Scout (chase legendary): the stairs are marked from the moment
  // you arrive — a pulsing gold diamond, fog or no fog.
  if (hasPassive(me(s), "pathfinder")) {
    const cx = X(s.map.stairs.x), cy = Y(s.map.stairs.y);
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

// ============================ ROAM PRESENTATION ============================
// Host side of src/sim/npc.ts: the settlement conversation cut, the contract
// ledger, arrival plaques, resident nameplates, and minimap chart pins.
// Dialogue rides state.dialogue (its OWN channel — never the System's
// announcer surfaces) and renders ONLY for the interacting player.

let settlementShopOpen = false; // the in-map outfitter (reuses #saferoom)

const dlgEl = document.getElementById("dialogue")!;
const dlgPortraitImg = document.getElementById("dlg-portrait") as HTMLImageElement;
const dlgNameEl = document.getElementById("dlg-name")!;
const dlgRoleEl = document.getElementById("dlg-role")!;
const dlgKickerEl = document.getElementById("dlg-kicker")!;
const dlgTextEl = document.getElementById("dlg-text")!;
const dlgChoicesEl = document.getElementById("dlg-choices")!;
const mmFrameEl = document.getElementById("minimap-frame")!;

// Painted portrait per archetype (public/icons/portraits/): the sim's
// portraitId is the file key; unknown ids fall back to the elder.
const PORTRAIT_IDS = new Set(["mordecai", "trader", "quartermaster", "rumor", "elder"]);
const NPC_ROLE_LABEL: Record<string, string> = {
  guide: "Guide", trader: "Trader", quartermaster: "Quartermaster",
  rumor: "Rumor-Monger", elder: "Elder",
};

let dlgOpen = false;
let dlgSessionId = -1;
let dlgLinesKey = "";
let dlgFullText: string[] = [];
let dlgShown = 0; // characters revealed so far, across every line
let dlgTypeTimer = 0;

function dlgTotalChars(): number {
  return dlgFullText.reduce((n, l) => n + l.length, 0);
}

function dlgRenderText(): void {
  let budget = dlgShown;
  let html = "";
  for (const line of dlgFullText) {
    if (budget <= 0) break;
    const take = Math.min(line.length, budget);
    budget -= take;
    html += `<div class="dlg-line">${esc(line.slice(0, take))}</div>`;
  }
  dlgTextEl.innerHTML = html;
  dlgTextEl.classList.toggle("typing", dlgShown < dlgTotalChars());
}

/** Classic RPG typewriter — click / Space / Enter skips to the full text. */
function dlgStartType(lines: string[]): void {
  dlgFullText = lines;
  dlgShown = 1;
  window.clearInterval(dlgTypeTimer);
  dlgTypeTimer = window.setInterval(() => {
    dlgShown += 2;
    dlgRenderText();
    if (dlgShown >= dlgTotalChars()) window.clearInterval(dlgTypeTimer);
  }, 16);
  dlgRenderText();
}

function dlgFinishType(): void {
  window.clearInterval(dlgTypeTimer);
  dlgShown = dlgTotalChars();
  dlgRenderText();
}

function dlgRenderChoices(session: DialogueSession): void {
  dlgChoicesEl.innerHTML = session.choices.map((c, i) => {
    const cls = [
      "dlg-choice",
      c.effect === "farewell" ? "bye" : "",
      c.effect === "acceptQuest" || c.effect === "turnIn" ? "quest" : "",
    ].filter(Boolean).join(" ");
    const cost = c.price ? `<span class="dcost">${coin}${c.price}</span>` : "";
    return (
      `<button class="${cls}" data-choice="${esc(c.id)}">` +
      `<span class="dnum">${i + 1}</span><span class="dlabel">${esc(c.label)}</span>${cost}</button>`
    );
  }).join("");
}

function openDialogueUi(session: DialogueSession, s: GameState): void {
  dlgOpen = true;
  dlgSessionId = session.id;
  const guide = session.portraitId === "mordecai";
  dlgEl.classList.toggle("guide", guide);
  const pid = PORTRAIT_IDS.has(session.portraitId) ? session.portraitId : "elder";
  dlgPortraitImg.src = `/icons/portraits/${pid}.svg`;
  dlgNameEl.textContent = session.npcName;
  const npc = npcsOf(s).find((n) => n.id === session.npcId);
  dlgRoleEl.textContent = NPC_ROLE_LABEL[npc?.role ?? "elder"] ?? "Resident";
  const st = (s.settlements ?? []).find((x) => x.id === session.settlementId);
  dlgKickerEl.textContent = guide
    ? "◆ THE GUIDE ◆"
    : `◆ ${(st?.name ?? "the camp").toUpperCase()} — SETTLEMENT CHANNEL ◆`;
  input.captureMode = true; // digits answer, not cast, while the panel is up
  dlgEl.style.display = "flex";
  requestAnimationFrame(() => dlgEl.classList.add("show"));
}

function closeDialogueUi(): void {
  if (!dlgOpen) return;
  dlgOpen = false;
  dlgSessionId = -1;
  dlgLinesKey = "";
  window.clearInterval(dlgTypeTimer);
  dlgEl.classList.remove("show");
  window.setTimeout(() => { if (!dlgOpen) dlgEl.style.display = "none"; }, 220);
  if (!menuOpen && !kbOpen) input.captureMode = false;
}

/** Answer a dialogue choice (local sim only — Roam is solo-first). */
function answerDialogue(choiceId: string): void {
  if (net) return; // no wire message for dialogue answers yet
  const session = state.dialogue;
  if (!session) return;
  const before = state.exploredVersion;
  chooseDialogue(state, session.playerId, choiceId);
  flushFeedback(state);
  persistRun(state);
  // Guide moment: an orientation / rumor just painted the chart — pulse the
  // minimap bezel so the reveal lands as a visible gift. Deferred: the modal
  // scrim hides the minimap right now; the pulse fires as the panel closes.
  if (state.exploredVersion !== before) mmFlashPending = true;
}
let mmFlashPending = false;

dlgChoicesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".dlg-choice") as HTMLElement | null;
  if (btn?.dataset.choice) answerDialogue(btn.dataset.choice);
});
dlgTextEl.addEventListener("click", () => dlgFinishType());
// The dialogue owns the keyboard while open (captureMode holds game binds):
// 1-9 answer, Space/Enter skip the typewriter, Esc is a polite farewell.
window.addEventListener("keydown", (e) => {
  if (!dlgOpen) return;
  if (e.key === "Escape") {
    if (!net && state.dialogue) closeDialogue(state, state.dialogue.playerId);
    closeDialogueUi();
    e.stopImmediatePropagation();
    return;
  }
  if ((e.key === " " || e.key === "Enter") && dlgShown < dlgTotalChars()) {
    dlgFinishType();
    return;
  }
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    (dlgChoicesEl.children[n - 1] as HTMLButtonElement | undefined)?.click();
  }
}, true);

/** Per-frame dialogue sync: the sim session is the truth, the panel follows. */
function updateDialogueUi(s: GameState): void {
  const session = s.runKind === "roam" ? s.dialogue ?? null : null;
  if (!session || session.playerId !== me(s).id || session.done) {
    if (dlgOpen) closeDialogueUi();
    return;
  }
  // Host signals: a choice asked for the shop / the loadout bench — trade the
  // conversation for the panel (the settlement outfitter reuses #saferoom).
  if (session.open) {
    const page = session.open;
    if (!net) {
      closeDialogue(s, session.playerId);
      closeDialogueUi();
      srTab = page === "reslot" ? "abil" : "shop";
      shopView = "stock";
      shopSel = null;
      settlementShopOpen = true;
    }
    return;
  }
  const key =
    `${session.id}:${session.lines.map((l) => l.text).join("¦")}:` +
    session.choices.map((c) => c.id).join(",");
  if (key === dlgLinesKey) return;
  const fresh = session.id !== dlgSessionId;
  dlgLinesKey = key;
  if (fresh) openDialogueUi(session, s);
  dlgStartType(session.lines.map((l) => l.text));
  dlgRenderChoices(session);
}

// ---- Contract ledger (right rail, collapsible) ----
const questsEl = document.getElementById("quests")!;
const qListEl = document.getElementById("q-list")!;
const qNEl = document.getElementById("q-n")!;
const Q_COLLAPSE_KEY = "dcc:quests:v1";
try { if (localStorage.getItem(Q_COLLAPSE_KEY) === "1") questsEl.classList.add("collapsed"); } catch { /* default open */ }
document.getElementById("q-head")!.addEventListener("click", () => {
  const c = questsEl.classList.toggle("collapsed");
  try { localStorage.setItem(Q_COLLAPSE_KEY, c ? "1" : "0"); } catch { /* best-effort */ }
});
let questTrackerKey = "";

/** Display-only progress read of a quest objective (no rules live here). */
function questProgress(s: GameState, q: Quest): { text: string; done: boolean; ticks?: [number, number] } {
  const o = q.objective;
  switch (o.kind) {
    case "killTribe": {
      const k = Math.min(o.killed, o.target);
      return { text: `${k} / ${o.target} culled`, done: k >= o.target, ticks: [k, o.target] };
    }
    case "clearStronghold":
      return s.strongholdCleared
        ? { text: `${o.leaderName} evicted`, done: true }
        : { text: `${o.leaderName} still holds the camp`, done: false };
    case "cache":
      return o.recovered
        ? { text: "cache in hand", done: true }
        : { text: "recover the cache from the vault", done: false };
    case "delivery":
      return o.delivered
        ? { text: "delivered, signed, witnessed", done: true }
        : { text: `deliver to ${o.toName}`, done: false };
    case "beacons": {
      const lit = o.spots.filter((x) => x.lit).length;
      return { text: `${lit} / ${o.spots.length} beacons lit`, done: lit >= o.spots.length, ticks: [lit, o.spots.length] };
    }
  }
}

function updateQuestTracker(s: GameState): void {
  const show = s.runKind === "roam" && s.status === "playing" && !menuOpen && (s.quests?.length ?? 0) > 0;
  questsEl.style.display = show ? "block" : "none";
  if (!show) { questTrackerKey = ""; return; }
  const key = s.quests.map((q) => `${q.key ?? q.id}:${q.state}:${questProgress(s, q).text}`).join("|");
  if (key === questTrackerKey) return;
  questTrackerKey = key;
  const active = s.quests.filter((q) => q.state === "active");
  const offered = s.quests.filter((q) => q.state === "offered");
  const done = s.quests.filter((q) => q.state === "complete");
  qNEl.textContent = active.length > 0 ? `· ${active.length} open` : "";
  const giverName = (q: Quest): string =>
    npcsOf(s).find((n) => n.id === q.giverNpcId)?.name ?? "a resident";
  const ticksHtml = (a: number, b: number): string =>
    b <= 10
      ? `<span class="q-ticks">${Array.from({ length: b }, (_v, i) => `<i class="${i < a ? "on" : ""}"></i>`).join("")}</span>`
      : "";
  qListEl.innerHTML =
    active.map((q) => {
      const pr = questProgress(s, q);
      const line = pr.done && q.objective.kind !== "delivery"
        ? `${pr.text} — see ${giverName(q)}`
        : pr.text;
      return (
        `<div class="q-row${pr.done ? " done" : ""}">` +
        `<div class="q-title">${esc(q.title ?? q.key ?? "the work")}</div>` +
        `<div class="q-prog">${pr.ticks ? ticksHtml(pr.ticks[0], pr.ticks[1]) : ""}<span>${esc(line)}</span></div>` +
        `</div>`
      );
    }).join("") +
    offered.map((q) =>
      `<div class="q-row offered"><div class="q-title">${esc(q.title ?? "posted work")}</div>` +
      `<div class="q-prog"><span>ask ${esc(giverName(q))}</span></div></div>`).join("") +
    (done.length > 0
      ? `<div class="q-row done"><div class="q-prog"><span>${done.length} contract${done.length === 1 ? "" : "s"} settled this floor</span></div></div>`
      : "");
}

// Contract beats: accept / settle each get one pass through the headline zone
// in the settlement ledger's voice (.ann.quest — distinct from the System).
// They fire INSIDE the dialogue modal (which suppresses #headline), so beats
// buffer here and land the moment the conversation / reward draft clears.
const questStateMem = new Map<string, Quest["state"]>();
const pendingQuestBeats: { a: Announcement; cls: string }[] = [];
function watchQuestBeats(s: GameState): void {
  if (s.runKind !== "roam") return;
  for (const q of s.quests ?? []) {
    const k = `${s.seed}:${s.floor}:${q.key ?? q.id}`;
    const prevSt = questStateMem.get(k);
    if (prevSt !== q.state) {
      questStateMem.set(k, q.state);
      if (prevSt === undefined) continue; // first sight (build / restore): no beat
      if (q.state === "active") {
        pendingQuestBeats.push({
          a: { text: q.title ?? "the work", kind: "progress", priority: "high" },
          cls: "ann banner quest accepted",
        });
      } else if (q.state === "complete") {
        pendingQuestBeats.push({
          a: { text: `${q.title ?? "the job"} — the payout draft is yours`, kind: "progress", priority: "high" },
          cls: "ann banner quest",
        });
      }
    }
  }
  if (pendingQuestBeats.length > 0 && !document.body.classList.contains("modal")) {
    for (const b of pendingQuestBeats.splice(0)) showBanner(b.a, b.cls);
  }
}

// ---- Settlement presence: the arrival plaque ----
const plaqueEl = document.getElementById("settle-plaque")!;
const spNameEl = document.getElementById("sp-name")!;
const spSubEl = document.getElementById("sp-sub")!;
let plaqueSettlementId = -1;
let plaqueTimer = 0;
const plaqueLastShown = new Map<number, number>();

function updateSettlementPresence(s: GameState): void {
  const p = me(s);
  const st = s.runKind === "roam" && s.status === "playing" && p.alive
    ? settlementAt(s, p.pos)
    : null;
  const id = st?.id ?? -1;
  if (id === plaqueSettlementId) return;
  plaqueSettlementId = id;
  if (!st) { plaqueEl.classList.remove("show"); return; }
  // Boundary-hover guard: crossing the wall twice in a minute isn't two arrivals.
  const last = plaqueLastShown.get(id) ?? -1e9;
  if (performance.now() - last < 45000) return;
  plaqueLastShown.set(id, performance.now());
  spNameEl.textContent = st.name.toUpperCase();
  spSubEl.textContent = `pop. ${st.npcIds.length} · no-aggro ground`;
  plaqueEl.classList.add("show");
  window.clearTimeout(plaqueTimer);
  plaqueTimer = window.setTimeout(() => plaqueEl.classList.remove("show"), 3800);
}

// ---- Resident nameplates: name/role float on approach, talk hint in reach ----
const npcPlatesLayer = document.createElement("div");
npcPlatesLayer.id = "npcplates";
document.getElementById("fx")!.before(npcPlatesLayer); // numbers stay on top
type NpcPlateEl = { root: HTMLDivElement; name: HTMLDivElement; role: HTMLDivElement; talk: HTMLDivElement; cls: string; forId: number };
const npcPlatePool: NpcPlateEl[] = [];
const npcPlateLive = new Map<number, NpcPlateEl>();

function makeNpcPlate(): NpcPlateEl {
  const root = document.createElement("div");
  root.className = "nplate";
  const name = document.createElement("div");
  name.className = "nname";
  const role = document.createElement("div");
  role.className = "nrole";
  const talk = document.createElement("div");
  talk.className = "ntalk";
  root.append(name, role, talk);
  npcPlatesLayer.appendChild(root);
  return { root, name, role, talk, cls: "nplate", forId: -1 };
}

function updateNpcPlates(s: GameState): void {
  const seen = new Set<number>();
  if (s.runKind === "roam" && s.status === "playing" && !dlgOpen) {
    const p = me(s);
    // Gather first: residents cluster, so plates need a de-overlap pass and
    // only the NEAREST one in reach gets the talk hint (one E, one target).
    const cands: { n: ReturnType<typeof npcsOf>[number]; d: number; x: number; y: number }[] = [];
    for (const n of npcsOf(s)) {
      const d = Math.hypot(n.pos.x - p.pos.x, n.pos.y - p.pos.y);
      if (d > 7) continue;
      const sp = renderer.worldToScreen(n.pos.x, 2.15, n.pos.y);
      if (!sp.visible) continue;
      cands.push({ n, d, x: sp.x, y: sp.y });
    }
    let talkId = -1;
    let talkD = 1.6;
    for (const c of cands) if (c.d <= talkD) { talkD = c.d; talkId = c.n.id; }
    // Colliding plates fan upward, chart-label style (top-most stays put).
    cands.sort((a, b) => a.y - b.y);
    const placed: { x: number; y: number }[] = [];
    for (const c of cands) {
      for (const q of placed) {
        if (Math.abs(q.x - c.x) < 120 && Math.abs(q.y - c.y) < 44) c.y = q.y - 46;
      }
      placed.push({ x: c.x, y: c.y });
    }
    for (const c of cands) {
      const n = c.n;
      let plate = npcPlateLive.get(n.id);
      if (!plate) {
        plate = npcPlatePool.pop() ?? makeNpcPlate();
        npcPlateLive.set(n.id, plate);
        plate.root.style.display = "block";
      }
      seen.add(n.id);
      if (plate.forId !== n.id) {
        plate.forId = n.id;
        plate.name.textContent = n.name;
        plate.role.textContent = NPC_ROLE_LABEL[n.role ?? "elder"] ?? "Resident";
        plate.talk.innerHTML = `<kbd>${esc(bindingLabel(bindings, "stairs").toUpperCase())}</kbd> talk`;
      }
      const cls = `nplate${n.role === "guide" ? " guide" : ""}${n.id === talkId ? " reach" : ""}`;
      if (plate.cls !== cls) {
        plate.cls = cls;
        plate.root.className = cls;
      }
      plate.root.style.left = `${c.x}px`;
      plate.root.style.top = `${c.y}px`;
      plate.root.style.opacity = c.d > 6 ? Math.max(0, 1 - (c.d - 6)).toFixed(2) : "1";
    }
  }
  for (const [id, plate] of npcPlateLive) {
    if (seen.has(id)) continue;
    plate.root.style.display = "none";
    plate.cls = "";
    plate.forId = -1;
    npcPlateLive.delete(id);
    npcPlatePool.push(plate);
  }
}

// ---- Minimap chart pins: settlements + active-contract targets ----
function drawRoamPins(s: GameState, X: (x: number) => number, Y: (y: number) => number): void {
  const roomCenterOf = (idx: number): Vec2 | null => {
    const r = s.map.rooms[idx];
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
  };
  const exploredAt = (v: Vec2): boolean =>
    !!s.explored[Math.floor(v.y) * s.map.w + Math.floor(v.x)];
  const ring = (cx: number, cy: number, color: string): void => {
    const pulse = 5 + Math.sin(performance.now() / 300) * 1.4;
    mmCtx.strokeStyle = color;
    mmCtx.lineWidth = 1.4;
    mmCtx.beginPath();
    mmCtx.arc(cx, cy, pulse, 0, Math.PI * 2);
    mmCtx.stroke();
  };
  // Settlements: verdant rooftop pennants — sanctuary at a glance.
  for (const st of s.settlements ?? []) {
    const c = roomCenterOf(st.roomIdx);
    if (!c || !exploredAt(c)) continue;
    const cx = X(c.x), cy = Y(c.y);
    mmCtx.save();
    mmCtx.shadowColor = "rgba(134,184,106,0.8)";
    mmCtx.shadowBlur = 4;
    mmCtx.fillStyle = "#a8d18a";
    mmCtx.strokeStyle = "rgba(10,7,4,0.9)";
    mmCtx.lineWidth = 1;
    mmCtx.beginPath();
    mmCtx.moveTo(cx, cy - 4.6);
    mmCtx.lineTo(cx + 4.2, cy - 0.6);
    mmCtx.lineTo(cx + 2.6, cy - 0.6);
    mmCtx.lineTo(cx + 2.6, cy + 3.4);
    mmCtx.lineTo(cx - 2.6, cy + 3.4);
    mmCtx.lineTo(cx - 2.6, cy - 0.6);
    mmCtx.lineTo(cx - 4.2, cy - 0.6);
    mmCtx.closePath();
    mmCtx.fill();
    mmCtx.stroke();
    mmCtx.restore();
  }
  for (const q of s.quests ?? []) {
    if (q.state !== "active") continue;
    const o = q.objective;
    if (o.kind === "beacons") {
      // Unlit: hollow amber diamonds. Lit: filled gold with a warm halo.
      for (const spot of o.spots) {
        const cx = X(spot.x), cy = Y(spot.y);
        mmCtx.save();
        if (spot.lit) {
          mmCtx.shadowColor = "rgba(242,193,78,0.9)";
          mmCtx.shadowBlur = 5;
          mmCtx.fillStyle = "#ffd76e";
        }
        mmCtx.strokeStyle = spot.lit ? "rgba(20,12,4,0.9)" : "#d9a94a";
        mmCtx.lineWidth = 1.3;
        mmCtx.beginPath();
        mmCtx.moveTo(cx, cy - 3.6);
        mmCtx.lineTo(cx + 3.6, cy);
        mmCtx.lineTo(cx, cy + 3.6);
        mmCtx.lineTo(cx - 3.6, cy);
        mmCtx.closePath();
        if (spot.lit) mmCtx.fill();
        mmCtx.stroke();
        mmCtx.restore();
      }
    } else if (o.kind === "cache" && !o.recovered) {
      // The quartermaster gave directions — the vault is marked through fog.
      const c = roomCenterOf(o.roomIdx);
      if (c) ring(X(c.x), Y(c.y), "#f2c14e");
    } else if (o.kind === "delivery" && !o.delivered) {
      const st = (s.settlements ?? []).find((x) => x.id === o.toSettlementId);
      const c = st ? roomCenterOf(st.roomIdx) : null;
      if (c) ring(X(c.x), Y(c.y), "#f2c14e");
    } else if (o.kind === "clearStronghold" && !s.strongholdCleared && s.map.strongholdRoomIdx >= 0) {
      const c = roomCenterOf(s.map.strongholdRoomIdx);
      if (c && exploredAt(c)) ring(X(c.x), Y(c.y), "#e0703f");
    }
  }
}

/** One per-frame entry point for everything Roam (called after drawMinimap). */
function updateRoamUi(s: GameState): void {
  updateDialogueUi(s);
  updateQuestTracker(s);
  watchQuestBeats(s);
  updateSettlementPresence(s);
  updateNpcPlates(s);
  if (mmFlashPending && !document.body.classList.contains("modal")) {
    mmFlashPending = false;
    mmFrameEl.classList.remove("mm-flash");
    void (mmFrameEl as HTMLElement).offsetWidth;
    mmFrameEl.classList.add("mm-flash");
  }
}

const HIT_COLORS: Record<HitEvent["kind"], string> = {
  // Warm parchment-gold for ordinary hits (r5 minor: the old white face went
  // mid-gray through the bevel shading on dark ground); crits stay a hotter,
  // deeper gold so the magnitude ramp survives the shared warm family.
  enemy: "#ffd36a", crit: "#ffc93c", player: "#ff5240",
  heal: "#8fd06f", gold: "#f2c14e", weapon: "#c9a3f5",
  chain: "#c8d0da", // iron links; zero-amount events never become numbers anyway
};

// Floating combat numbers (critic r2 blocker rework): pooled DOM elements +
// Web Animations, now with AGGREGATION and COLLISION AVOIDANCE. Same-kind
// ticks landing on the same spot within ~half a second merge into ONE rolling
// counter that re-pops as it grows (the LoL treatment); distinct numbers that
// would overlap fan out on golden-angle radial slots instead of piling into
// an unreadable clump. Numbers anchor ABOVE the impact (y≈1.2) so they ride
// over the blast core instead of sitting inside it.
const dmgPool: HTMLDivElement[] = [];
const DMG_POOL_MAX = 48;
// Readability cap (audit r2): past ~16 simultaneous numbers the screen is
// confetti — ordinary enemy ticks are dropped first; crits, kills, player
// damage, heals, and gold always land.
const DMG_MAX_ACTIVE = 16;
interface DmgLive {
  el: HTMLDivElement;
  key: string; // kind|school|effect — only like merges with like
  wx: number; wz: number; // world anchor: aggregation radius test
  sx: number; sy: number; // screen anchor: collision-fan test
  total: number;
  merges: number;
  born: number; // ms clock
  crit: boolean;
  color: string; // numeral face hex — merges repaint with the same palette
  stagger: number; // ms pop delay: simultaneous hits drum-roll, never clump
}
const dmgLive: DmgLive[] = [];
const DMG_AGG_MS = 520; // rolling-counter window
const DMG_AGG_R2 = 0.9 * 0.9; // world-units² — same-target ticks merge
const DMG_FAN_PX = 56; // min screen spacing before fanning out

function dmgText(rec: DmgLive, sign: string): string {
  return rec.crit ? `${rec.total}!` : `${sign}${rec.total}`;
}

// BESPOKE DISPLAY NUMERALS (final pass, issue #5): canvas-rendered glyphs —
// chunky ultra-black face, slight italic skew, chiseled bevel (dark underlay
// + vertical face gradient + top sheen), heavy rounded ink outline, soft
// color glow. Crits add a chromatic red/cyan flash under the ink. One draw
// per spawn/merge (a few per second) — zero per-frame cost; the WAAPI
// transform animation moves the finished bitmap.
const DMG_FONT = `900 %PX%px "Arial Black", "Segoe UI Black", "Arial", sans-serif`;
function dmgShade(hex: string, k: number): string {
  // k > 0 lightens toward white, k < 0 darkens toward black.
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number =>
    Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
function paintNumeral(el: HTMLDivElement, text: string, color: string, crit: boolean): void {
  let canvas = el.firstElementChild as HTMLCanvasElement | null;
  if (!canvas || canvas.tagName !== "CANVAS") {
    canvas = document.createElement("canvas");
    canvas.style.display = "block";
    el.prepend(canvas);
  }
  const px = crit ? 58 : 38; // non-crit floor raised (r5: 34px thinned to fog)
  const pad = crit ? 30 : 18;
  const ctx = canvas.getContext("2d");
  if (!ctx) { el.textContent = text; return; }
  ctx.font = DMG_FONT.replace("%PX%", String(px));
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = tw + pad * 2 + Math.ceil(px * 0.14);
  const h = px + pad * 2;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.transform(1, 0, -0.14, 1, 0, 0); // the slight italic lean
  ctx.font = DMG_FONT.replace("%PX%", String(px));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  if (crit) {
    // Chromatic flash under the ink: hot red left, cold cyan right.
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#ff3b30";
    ctx.fillText(text, -3.5, 0);
    ctx.fillStyle = "#4fd8ff";
    ctx.fillText(text, 3.5, 0);
    ctx.globalAlpha = 1;
  }
  // Heavy ink: a dropped dark stroke for weight, then the main outline.
  ctx.strokeStyle = "rgba(6,3,1,0.85)";
  ctx.lineWidth = crit ? 11 : 8;
  ctx.strokeText(text, 0, 2.5);
  ctx.strokeStyle = "rgba(12,6,2,0.97)";
  ctx.lineWidth = crit ? 9 : 6.5;
  ctx.strokeText(text, 0, 0);
  // Chiseled bevel: dark underlay, then the vertical face gradient with a
  // soft color glow, then a top sheen. Face floor raised (r5 minor): the old
  // -0.28 bottom stop dragged small numerals to mid-gray over dark ground —
  // every number now keeps the crit treatment's warm luminous face.
  ctx.fillStyle = dmgShade(color, -0.4);
  ctx.fillText(text, 0, 2.2);
  const face = ctx.createLinearGradient(0, -px / 2, 0, px / 2);
  face.addColorStop(0, dmgShade(color, 0.78));
  face.addColorStop(0.42, color);
  face.addColorStop(1, dmgShade(color, -0.12));
  ctx.shadowColor = color;
  ctx.shadowBlur = crit ? 20 : 15;
  ctx.fillStyle = face;
  ctx.fillText(text, 0, 0);
  ctx.shadowBlur = 0;
  const sheen = ctx.createLinearGradient(0, -px / 2, 0, 0);
  sheen.addColorStop(0, "rgba(255,255,255,0.5)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillText(text, 0, -0.8);
}

/** (Re)run the pop-drift-fade animation for a live number. Merges re-pop with
 * a slightly bigger punch each stack so a rolling counter visibly GROWS. */
/** Scale-in + ARC-OUT (issue #5): the number pops in, lobs up along its
 * drift, crests just past mid-life and settles slightly on the way out — a
 * thrown-coin arc, not a linear float. Merges re-pop with a bigger punch. */
function dmgAnimate(rec: DmgLive): void {
  const { el, crit } = rec;
  const grow = Math.min(1 + rec.merges * 0.07, 1.42);
  // LATERAL-DOMINANT ARC (r6 major): simultaneous hits fan OUT of the fight
  // sideways — drift now outweighs rise, so a burst reads as a spray of
  // coins, never a vertical pile climbing the back wall.
  const dir = Math.random() < 0.5 ? -1 : 1;
  const drift = dir * (0.45 + Math.random() * 0.55) * (crit ? 132 : 96);
  const rise = (crit ? 64 : 50) * (rec.merges > 0 ? 0.85 : 1);
  const pop = (crit ? 1.6 : 1.18) * grow; // crits POP visibly harder (r4)
  const tilt = crit ? (Math.random() - 0.5) * 12 : 0;
  // r7 blocker root cause (ghost numbers in EVERY combat frame): the old
  // options-level `easing` is EFFECT-level in WAAPI — the entire keyframe
  // timeline got remapped through the aggressive ease-out, so a number hit
  // 88% keyframe progress (deep in its fade) at just 35% of real time and
  // spent most of its life translucent. Easing now rides the KEYFRAMES: hard
  // pop-in, gliding arc, full ink held to 80%, then a quick clean exit.
  const anim = el.animate(
    [
      { transform: `translate(-50%, -50%) scale(${crit ? 0.25 : 0.5}) rotate(${tilt}deg)`, opacity: 0.9, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      { transform: `translate(calc(-50% + ${(drift * 0.22).toFixed(1)}px), calc(-50% - ${(rise * 0.44).toFixed(1)}px)) scale(${pop.toFixed(2)}) rotate(${tilt}deg)`, opacity: 1, offset: 0.14, easing: "cubic-bezier(0.33, 1, 0.68, 1)" },
      { transform: `translate(calc(-50% + ${(drift * 0.62).toFixed(1)}px), calc(-50% - ${rise.toFixed(1)}px)) scale(${grow.toFixed(2)})`, opacity: 1, offset: 0.58, easing: "linear" },
      { opacity: 1, offset: 0.8, easing: "ease-in" },
      { transform: `translate(calc(-50% + ${drift.toFixed(1)}px), calc(-50% - ${(rise * 0.86).toFixed(1)}px)) scale(${(crit ? 0.98 : 0.9) * grow})`, opacity: 0 },
    ],
    // Per-number stagger (r6 major: simultaneous hits stacked into one
    // unreadable pile): later numbers in a burst hold their pop a few frames
    // so a flurry reads as a drum-roll, not a single clump. fill:backwards
    // keeps the pre-pop keyframe applied during the delay.
    { duration: crit ? 920 : 780, delay: rec.merges > 0 ? 0 : rec.stagger, fill: "backwards" },
  );
  anim.onfinish = () => {
    const i = dmgLive.indexOf(rec);
    if (i >= 0) dmgLive.splice(i, 1);
    el.style.visibility = "hidden";
    if (dmgPool.length < DMG_POOL_MAX) dmgPool.push(el);
    else el.remove();
  };
}

function spawnDamageNumber(h: HitEvent): void {
  // THE KILL BEAT OWNS THE FRAME (r3 blocker). Combat numerals stand down for
  // the boss payoff so the last image is the corpse, the sweeps and the loot.
  // Player-side feedback (damage taken, heals, gold) still reads — it is only
  // the enemy-damage confetti that was burying the moment.
  if (hudNow < killBeatUntil && (h.kind === "enemy" || h.kind === "crit")) return;
  // A numeral that rounds to zero says nothing and costs a slot. Eight of them
  // reading "0!" over a corpse is what the kill captures actually showed.
  if (h.amount < 0.5 && h.kind !== "heal" && h.kind !== "gold") return;
  const crit = h.kind === "crit";
  // Anchor at HEAD height, not sky height (r6 major: numbers climbed the
  // arena wall and jumbled at the top of the frame): they pop at the
  // silhouette's crown and the arc carries them OUT (lateral drift dominates
  // vertical rise), never up onto the wall geometry behind the fight.
  const s = renderer.worldToScreen(h.pos.x, crit ? 1.55 : 1.3, h.pos.y);
  if (!s.visible) return;
  const sign = h.kind === "heal" || h.kind === "gold" || h.kind === "weapon" ? "+" : "";
  const key = `${h.kind}|${h.school ?? ""}|${h.effect ?? ""}${h.resisted ? "|r" : ""}`;
  const now = performance.now();

  // ROLLING COUNTER: a same-kind hit on the same spot inside the window
  // grows the existing number and re-pops it instead of stacking a twin.
  // (Resisted numbers carry an icon child, so they never merge.) Runs BEFORE
  // the saturation gate: a mergeable tick always lands somewhere readable.
  if (!h.resisted && !h.killed) {
    for (const rec of dmgLive) {
      if (rec.key !== key || now - rec.born > DMG_AGG_MS) continue;
      const dx = rec.wx - h.pos.x, dz = rec.wz - h.pos.y;
      if (dx * dx + dz * dz > DMG_AGG_R2) continue;
      rec.total += h.amount;
      rec.merges++;
      rec.wx = h.pos.x; rec.wz = h.pos.y;
      rec.el.getAnimations().forEach((a) => a.cancel());
      paintNumeral(rec.el, dmgText(rec, sign), rec.color, rec.crit);
      dmgAnimate(rec);
      return;
    }
  }
  const important = h.kind !== "enemy" || h.killed === true;
  if (dmgLive.length >= DMG_MAX_ACTIVE && !important) return;

  let el = dmgPool.pop();
  if (!el) {
    el = document.createElement("div");
    fxLayer.appendChild(el);
  }
  el.className = crit ? "dmg crit" : "dmg";
  el.style.opacity = "";
  // Numeral palette. School tint (DESIGN 5.8): magic reads arcane-purple so
  // a mixed build can SEE which school each number came from. Status DoT
  // ticks (5.11): burn ember-orange, poison toxin-green. Resists mute.
  let color = HIT_COLORS[h.kind];
  if (h.school === "magic" && (h.kind === "enemy" || h.kind === "crit")) {
    color = crit ? "#d9c2ff" : "#d2b5ff"; // bright arcane, still inked
  }
  if (h.effect === "burn") color = "#ff7a2f";
  else if (h.effect === "poison") color = "#7ed957";
  if (h.resisted) color = "#c0ad83"; // muted but never mid-gray (r5 minor)
  el.style.color = color; // the crit starburst ::before keys off currentColor
  // COLLISION FAN: if this number would land on an active one, walk
  // golden-angle radial slots until the spot is clear — no more clumps.
  // A pinch of spawn scatter first (r6 major): even same-tick hits on one
  // target never share an exact anchor pixel.
  let px = s.x + (Math.random() - 0.5) * 34, py = s.y + (Math.random() - 0.5) * 10;
  for (let slot = 0; slot < 8; slot++) {
    let clear = true;
    for (const rec of dmgLive) {
      const ddx = rec.sx - px, ddy = rec.sy - py;
      if (ddx * ddx + ddy * ddy < DMG_FAN_PX * DMG_FAN_PX) { clear = false; break; }
    }
    if (clear) break;
    const ang = -Math.PI / 2 + (slot + 1) * 2.39996; // golden angle
    const rad = 56 + slot * 12;
    px = s.x + Math.cos(ang) * rad;
    py = s.y + Math.sin(ang) * rad * 0.5; // squash hard: favor horizontal fan
  }
  el.style.left = `${px}px`;
  el.style.top = `${py}px`;
  const rec: DmgLive = {
    el, key, wx: h.pos.x, wz: h.pos.y, sx: px, sy: py,
    total: h.amount, merges: 0, born: now, crit, color,
    stagger: crit ? 0 : Math.min(dmgLive.length, 4) * 55,
  };
  // Drop any stale resist icon a pooled element carried, then paint.
  while (el.childElementCount > 1) el.lastElementChild!.remove();
  paintNumeral(el, dmgText(rec, sign), color, crit);
  // School resist (armored/warded): the number reads muted so the player
  // learns to swap schools without reading a tooltip.
  if (h.resisted) {
    el.style.opacity = "0.85";
    // Drawn shield mark, never a typed dingbat (some platforms emoji-fy ⛨).
    el.insertAdjacentHTML("beforeend",
      ` <i class="uic" style="mask-image:url(/icons/stats/armor.svg);-webkit-mask-image:url(/icons/stats/armor.svg)"></i>`);
  }
  el.style.visibility = "visible";
  dmgLive.push(rec);
  dmgAnimate(rec);
}

// ---- Enemy micro HP bars (AAA r3 blocker): D2R monster-health read —
// nothing at rest, loud on engagement. A thin dark-gold framed bar appears
// over a monster on its FIRST damage, tracks for 3s past the last hit, then
// fades out. Elites carry a nameplate tier (engraved gold name above the
// bar). Bosses are excluded — the top-center boss bar is their treatment.
// Pooled DOM, transform/width mutations only; no per-frame element churn.
const mobPlatesLayer = document.createElement("div");
mobPlatesLayer.id = "mobplates";
fxLayer.before(mobPlatesLayer); // damage numbers stay above the plates
type MobPlate = { root: HTMLDivElement; name: HTMLDivElement; fill: HTMLSpanElement; cls: string };
const mobPlatePool: MobPlate[] = [];
const mobPlateLive = new Map<number, MobPlate>();
const mobPlateMem = new Map<number, { hp: number; until: number }>();
const mobPlateSeen = new Set<number>();
const PLATE_HOLD_MS = 3000;
const PLATE_FADE_MS = 400;
const PLATE_MAX = 24; // past this the swarm is confetti, not information

function makeMobPlate(): MobPlate {
  const root = document.createElement("div");
  root.className = "mplate";
  const name = document.createElement("div");
  name.className = "mpname";
  const bar = document.createElement("div");
  bar.className = "mpbar";
  const fill = document.createElement("span");
  fill.className = "mpfill";
  bar.appendChild(fill);
  root.appendChild(name);
  root.appendChild(bar);
  mobPlatesLayer.appendChild(root);
  return { root, name, fill, cls: "mplate" };
}

function updateMobPlates(s: GameState): void {
  const now = performance.now();
  mobPlateSeen.clear();
  let shown = 0;
  for (const m of s.monsters) {
    if (m.hp <= 0) { mobPlateMem.delete(m.id); continue; }
    let mem = mobPlateMem.get(m.id);
    if (!mem) { mem = { hp: m.hp, until: 0 }; mobPlateMem.set(m.id, mem); }
    if (m.hp < mem.hp - 1e-6) mem.until = now + PLATE_HOLD_MS; // fresh damage
    mem.hp = m.hp;
    if (m.kind === "boss") continue; // the boss bar owns the menace read
    if (mem.until <= now || m.hp >= m.maxHp || shown >= PLATE_MAX) continue;
    const sp = renderer.worldToScreen(m.pos.x, m.elite ? 2.05 : 1.55, m.pos.y);
    if (!sp.visible) continue;
    let plate = mobPlateLive.get(m.id);
    if (!plate) {
      plate = mobPlatePool.pop() ?? makeMobPlate();
      mobPlateLive.set(m.id, plate);
      plate.root.style.display = "block";
    }
    shown++;
    mobPlateSeen.add(m.id);
    const cls = m.elite ? "mplate elite" : "mplate";
    if (plate.cls !== cls) {
      plate.cls = cls;
      plate.root.className = cls;
      if (m.elite) plate.name.textContent = m.eliteName ?? "ELITE";
    }
    plate.root.style.left = `${sp.x}px`;
    plate.root.style.top = `${sp.y}px`;
    plate.fill.style.width = `${Math.max(0, Math.min(1, m.hp / m.maxHp)) * 100}%`;
    const left = mem.until - now;
    plate.root.style.opacity = left < PLATE_FADE_MS ? (left / PLATE_FADE_MS).toFixed(2) : "1";
  }
  // Release plates whose monsters left the visible/damaged set this frame.
  for (const [id, plate] of mobPlateLive) {
    if (mobPlateSeen.has(id)) continue;
    plate.root.style.display = "none";
    plate.cls = "";
    mobPlateLive.delete(id);
    mobPlatePool.push(plate);
  }
}

// D4-style level-up: a floating "LEVEL {n}" over the crawler's head, paired
// with a world-space ring (renderer.emitLevelUp) instead of a toast — see the
// lastLevelByPid diff loop. Modeled on spawnDamageNumber but bigger, gold,
// and held longer (it's a rarer, bigger moment than a hit number).
function spawnLevelUpText(p: Player): void {
  const s = renderer.worldToScreen(p.pos.x, 1.7, p.pos.y);
  if (!s.visible) return;
  const el = document.createElement("div");
  el.className = "dmg levelup-text";
  el.style.left = `${s.x}px`;
  el.style.top = `${s.y}px`;
  el.textContent = `LEVEL ${p.level}`;
  fxLayer.appendChild(el);
  requestAnimationFrame(() => {
    el.style.transform = "translate(-50%, calc(-50% - 60px))";
    el.style.opacity = "0";
  });
  setTimeout(() => el.remove(), 1400);
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
  // Addressed lines (first-contact tips) are for ONE crawler — party members
  // who've already had that rule explained don't get the rerun.
  if (a.forPlayer !== undefined && a.forPlayer !== me(state).id) return;
  // ONE PRESENTATION PER MOMENT. While the ringside card is up it OWNS this
  // boss's System line; a capture caught the same sentence printed twice in
  // one frame — once in the top SYSTEM toast, once as the card's kicker.
  if (state.encounter?.line && a.text === state.encounter.line) return;
  if (a.priority === "high") {
    // One presentation per moment: the ringside TITLE CARD (updateBossBar)
    // already announces the intro — no duplicate center banner on top of it.
    if (a.kind === "boss" && a.text.includes("RINGSIDE INTRODUCTION")) return;
    showBanner(a);
    return;
  }
  // Level-ups get the world-space ring + floating text (see the
  // lastLevelByPid diff loop) instead of a toast — the line still reaches
  // the archive log via the separate state.events drain, nothing is lost.
  if (a.kind === "levelup") return;
  // First-contact tips (COURTESY EXPLANATIONs) get a dismissible card instead
  // of a toast — each one fires exactly once ever (Player.tipsSeen), so it
  // deserves an explicit acknowledgment rather than an auto-fade a player
  // could easily miss.
  if (a.kind === "tip") { if (!cleanMode) showTutorialCard(a); return; }
  if (!TICKER_KINDS[notifyLevel].includes(a.kind)) return; // HUD log still has it
  if (cleanMode) return; // ?clean=1: no toast chatter over showcase frames
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
const bannerQueue: { a: Announcement; cls: string }[] = [];
let bannerActive = false;

// `cls` lets the Roam contract beat ride the same one-at-a-time headline zone
// with its OWN voice (.ann.quest — settlement ledger, not the System's).
function showBanner(a: Announcement, cls = "ann banner"): void {
  if (bannerActive) { bannerQueue.push({ a, cls }); return; }
  bannerActive = true;
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = a.text;
  bannerLayer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
    bannerActive = false;
    const next = bannerQueue.shift();
    if (next) showBanner(next.a, next.cls);
  }, BANNER_HOLD_MS);
}

// Tutorial cards (kind:"tip"): D4-style dismissible explainer, one at a time.
// Each fires exactly once per crawler ever (Player.tipsSeen, sim-side), so
// the host needs no "seen" bookkeeping of its own — dismiss just advances
// the queue. Display-only text tweak: the ribbon header already says
// "COURTESY EXPLANATION," so the redundant lead-in is stripped from the body
// (the stored/logged announcement text is untouched — this is presentation).
const tutorialLayer = document.getElementById("tutorial")!;
const tutorialQueue: Announcement[] = [];
let tutorialActive = false;
let tutorialDismissActive: (() => void) | null = null;
let tutorialAutoTimer = 0;

function showTutorialCard(a: Announcement): void {
  if (tutorialActive) { tutorialQueue.push(a); return; }
  tutorialActive = true;
  // Strip the redundant lead-in (the ribbon header already says COURTESY
  // EXPLANATION) and re-capitalize so the body never reads as a truncated
  // sentence ("that unlock queued…" -> "That unlock queued…").
  const body = a.text
    .replace(/^COURTESY EXPLANATION:\s*/, "")
    .replace(/^[a-z]/, (c) => c.toUpperCase());
  const el = document.createElement("div");
  el.className = "tut";
  el.innerHTML =
    `<div class="tut-head">◆ SYSTEM — COURTESY EXPLANATION</div>` +
    `<div class="tut-body">${esc(body)}<button class="tut-dismiss">GOT IT</button></div>`;
  tutorialLayer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  // The WHOLE card dismisses, not just the button — a thumb on a phone gets
  // the full surface. Guarded: button + card both firing must not eat two
  // queue entries.
  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    window.clearTimeout(tutorialAutoTimer);
    tutorialDismissActive = null;
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
    tutorialActive = false;
    const next = tutorialQueue.shift();
    if (next) showTutorialCard(next);
  };
  el.addEventListener("click", dismiss);
  tutorialDismissActive = dismiss;
  tutorialShownAt = performance.now();
  // Auto-dismiss: a courtesy, not a squatter (r2: 6-8s, or any input).
  tutorialAutoTimer = window.setTimeout(dismiss, 7000);
}

// Any input clears the courtesy card (r2) — with a short grace so the key
// the player was already holding when it appeared can't insta-kill it.
let tutorialShownAt = 0;
function dismissTutorialOnInput(): void {
  if (tutorialDismissActive && performance.now() - tutorialShownAt > 1200) {
    tutorialDismissActive();
  }
}

window.addEventListener("keydown", dismissTutorialOnInput);

// HOLD TAB for the scoreboard and the splits. Binding the detail to a held key
// is not a compromise - it is the gesture LoL trained everyone to make, and it
// means the numbers are THERE for the player who argues about numbers and
// ABSENT for the player who just wants to press R (COMPETITIVE.md 6.1).
window.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || recapEl.style.display !== "flex") return;
  e.preventDefault();
  recapEl.classList.add("tabbed");
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Tab") recapEl.classList.remove("tabbed");
});
document.getElementById("m-standings")!.addEventListener("click", () => { void openLadder(); });
document.getElementById("m-careerset")!.addEventListener("click", () => { void openCareerSet(); });

// ACCEPT A CHALLENGE (8.2): ?c=<code> is a seed plus a claim in eighty
// characters. It re-dresses the DAILY tile into the challenge that was sent,
// and the seed it pins is the same dungeon the challenger actually crawled.
{
  const code = params.get("c");
  const ch = code ? social.decodeChallenge(code) : null;
  if (ch) {
    const tile = document.getElementById("m-daily")!;
    const feat = ch.won ? `cleared it in ${social.mmss(ch.timeSec)}`
      : ch.floor > 0 ? `reached floor ${ch.floor}` : "laid down a run";
    document.querySelector("#m-daily b")!.textContent = "ACCEPT CHALLENGE";
    document.getElementById("m-daily-sub")!.textContent =
      `${ch.by} ${feat} on this exact dungeon — level ${ch.level}, ${social.count(ch.kills, "kill")}. Same seed. Beat it.`;
    tile.addEventListener("click", () => { forcedSeed = ch.seed; }, { capture: true });
    if (ch.run) {
      // The code carried a run id: the challenge MAY come with a ghost. It
      // only does if the server stands behind that run. This used to check
      // `got.playable` (the era) and nothing else - never `run.state` - so a
      // stranger could race a proof the server had explicitly refused to
      // certify. And when the proof was refused for any reason at all, the
      // whole thing was swallowed by `.catch(() => null)` and nothing was
      // said: 2.6f is emphatic that a refusal is STATED, never silent.
      void (async () => {
        const era = RULES_HASH.slice(0, 7);
        let refusal = "the proof could not be reached";
        try {
          const row = (await competitive.run(ch.run!)) as social.BoardRun;
          const play = social.playability(row, era);
          if (!play.ok) {
            refusal = play.why;
          } else {
            const got = await competitive.proof(ch.run!);
            if (got.bytes && got.playable) {
              await armGhost(got.bytes, ch.by.toUpperCase(), ch.run);
              return;
            }
            refusal = got.reason ?? "no proof is retained for that run";
          }
        } catch { /* refusal already set */ }
        pushLogLine(`NO GHOST WITH THIS CHALLENGE — ${refusal}`);
        document.getElementById("m-daily-sub")!.textContent +=
          `  ·  NO GHOST: ${refusal}. The seed still is the seed.`;
      })();
    }
  }
}
window.addEventListener("pointerdown", dismissTutorialOnInput, { capture: true });

/** Slide the active card out NOW (floor transitions, boss intros). Queued
 *  cards wait a beat so nothing pops over the new moment. */
function dismissTutorialForTransition(): void {
  if (!tutorialDismissActive) return;
  const queued = tutorialQueue.splice(0);
  tutorialDismissActive();
  if (queued.length > 0) {
    setTimeout(() => {
      for (const q of queued) showTutorialCard(q);
    }, 5000);
  }
}

// ---- Run recap (backlog #12): the season report card ----
// Shown once per status edge: won = THE FINALE, wipe = IN MEMORIAM. All the
// data already lives on Player/GameState; this only formats it.
const recapEl = document.getElementById("recap")!;
let recapFor: GameState["status"] | null = null;

// THE VERDICT (COMPETITIVE.md 6). One job: convert the end of a run into the
// start of the next one, in under eight seconds of reading. Everything on the
// default face is (a) a grade, (b) the thing that killed you, or (c) a button;
// the numbers people argue about live behind a held TAB.
let runGrade: social.RunGrade | null = null;
let todaysBoard: social.BoardRun[] | null = null;
let earnedOpen = false;
/** What the server said about this run, resolving live under the player.
 *  `boards` is what the row actually HOLDS, straight from GET /runs/:id - the
 *  seal is weighted on that rather than on whichever board happened to load. */
let submitResult:
  | {
      state: string; runId?: string; reason?: string; attemptNo?: number;
      scoresCp?: boolean; boards?: string[]; needsIdentity?: boolean;
    }
  | null = null;

/**
 * A STATE THE VERIFIER REFUSED NEVER WEARS LADDER FURNITURE (6.2, stated as a
 * rule in capitals and implemented for test-chamber starts only).
 *
 * `renderLadderLine` and `renderEarned` never read `submitResult.state`, so a
 * REFUSED run showed a red "The replay did not produce the run you claimed"
 * block with "this run still holds its board row and its splits" 120px above
 * it and "NEW PB — DEEPEST FLOOR 1" in gold 70px below it. On a product whose
 * entire thesis is that its numbers are certified, the screen contradicting
 * its own certifier in the default state is the worst failure available.
 */
function verdictRefused(): boolean {
  return submitResult?.state === "rejected";
}

/** Where this crawler stands on the season ladder. Fetched at run end and
 *  again the moment a seal lands, so the CP line on the verdict screen can show
 *  what THIS run actually moved instead of a stale total. */
let myStanding: social.Standing | null = null;
let cpBeforeRun: number | null = null;

async function loadStanding(): Promise<void> {
  try {
    const token = await accountToken();
    const prof = (await competitive.myProfile(token)) as social.ProfileView;
    myStanding = prof.standing ?? null;
    // ...and the name this account wears on a board row, which is what the YOU
    // tag matches on now that the wire no longer hands out the token.
    if (prof.publicId) myPublicId = prof.publicId;
  } catch {
    myStanding = null; // offline: the line says so rather than inventing a rank
  }
}

/**
 * IS THIS RUN EVEN RANKABLE? The verifier refuses any proof whose start was not
 * FRESH (competitiveApi: "a test-mode start is never eligible for a board"), so
 * a screen that dresses a test-chamber drop-in in ladder furniture is claiming
 * an authority the server would decline. The second clause catches the same
 * state from the inside: a run standing on floor 13 that only ever ENTERED one
 * floor did not walk twelve of them, and no clock it prints is a real time.
 */
function runIsRankable(s: GameState): boolean {
  if (testMode) return false;
  const entered = floorEntryTicks.filter((t) => t >= 0).length;
  return entered >= s.floor;
}

/** Today contract board, cached per run end. It feeds THREE things: the grade
 *  percentile, the scoreboard comparison column, and RACE THE LEADER. */
async function loadTodaysBoard(): Promise<void> {
  try {
    const page = (await competitive.board("deepest", { event: "daily", limit: 50 })) as social.BoardPage;
    todaysBoard = page.entries;
  } catch {
    todaysBoard = null; // offline: the grade falls back and SAYS it fell back
  }
}

/** The four grade meters. Each names its own raw number, so the letter is
 *  auditable rather than an oracle. */
function verdictPartsHtml(g: social.RunGrade): string {
  const weakest = [...g.parts].sort((a, b) => a.score - b.score)[0];
  return g.parts.map((part) =>
    `<div class="vpart${part === weakest && part.score < 50 ? " weak" : ""}">` +
    `<div class="pk">${part.key}<i>${part.score}</i></div>` +
    `<div class="pbar"><i style="width:${Math.max(2, part.score)}%"></i></div>` +
    `<div class="pd" title="${esc(part.detail)}">${esc(part.detail)}</div></div>`,
  ).join("");
}

/** THE SCOREBOARD: YOU / THE GHOST YOU RACED / TODAY'S #1, sharing rows.
 *  Comparison is what makes a number mean anything, and the old recap had
 *  none of it. */
function scoreboardHtml(s: GameState): string {
  const p = me(s);
  // ONE DEFINITION OF "#1", SHARED WITH THE MARK (blocker 5). This took
  // `todaysBoard[0]` - the first row of a page that includes UNPROVEN claims
  // and may be the player's own row - and headed the column "#1 — KATIA" while
  // THE STANDINGS, which ranks sealed rows only, showed Katia at rank 2.
  const top = social.boardLeader(todaysBoard, myPublicId);
  const leader = top?.row ?? null;
  const num = (v: number): string | null => (v > 0 ? Math.round(v).toLocaleString() : null);
  const cols: { head: string; cells: (string | null)[] }[] = [
    {
      head: "YOU",
      cells: [
        s.status === "won" ? "CLEAR" : `floor ${s.floor}`,
        // ONE CLOCK, AT ONE PRECISION, ON A SURFACE SELLING EXACTNESS
        // (blocker 15). The same run printed 0:07.76 in the header, 0:07 in
        // this cell and 0:07.86 in the rival's, because three helpers were in
        // use on one table. Splits are exact tick counts; centiseconds cost
        // nothing and they are what decides an order.
        social.mmssc(s.elapsed), String(p.kills), Math.round(p.damageTaken).toLocaleString(),
        Math.round(p.damageDealt).toLocaleString(), p.goldSpent.toLocaleString(), String(p.level),
      ],
    },
  ];
  // THE GHOST YOU RACED - THE MIDDLE COLUMN 6.2 Beat 2 SPECIFIES (blocker 14).
  // It used to answer two of seven rows and dash the rest, because the ghost
  // TRACK carries a trajectory and nothing else - so the one run where the
  // comparison is worth the most, a RUN IT BACK against yourself, printed five
  // em-dashes. Every ghost has a source that knows the rest (a sealed board row
  // carries the verifier's own numbers; RUN IT BACK is this browser's last
  // run), and `armGhost` now carries it through.
  if (ghost) {
    const f = ghost.facts ?? null;
    const endFloor = f?.floor ?? ghost.track.floor[ghost.track.floor.length - 1] ?? 1;
    cols.push({
      head: ghost.label.toUpperCase(),
      cells: [
        f?.won ? "CLEAR" : `floor ${endFloor}`,
        social.ticksClock(ghost.ticks),
        f && f.kills !== null ? f.kills.toLocaleString() : null,
        f && f.damageTaken !== null ? num(f.damageTaken) : null,
        f && f.damageDealt !== null ? num(f.damageDealt) : null,
        f && f.goldSpent !== null ? num(f.goldSpent) : null,
        f && f.level !== null ? String(f.level) : null,
      ],
    });
  }
  // ...and the leader column is filled from the VERIFIER'S OWN NUMBERS. Damage
  // dealt, damage taken and gold spent are derived during the replay and stored
  // on the row; printing a dash next to a figure the server demonstrably knows
  // is how a scoreboard reads unfinished.
  cols.push({
    // When the top sealed row IS the player's, the column says so instead of
    // printing their own name opposite their own numbers.
    head: !leader ? "TODAY'S #1"
      : top!.mine ? `#1 — YOU`
        : `#${top!.rank} — ${leader.name.toUpperCase()}`,
    cells: leader
      ? [
          leader.won ? "CLEAR" : `floor ${leader.floor}`, social.ticksClock(leader.ticks),
          String(leader.kills), num(leader.damageTaken), num(leader.damageDealt),
          num(leader.goldSpent), String(leader.level),
        ]
      : [null, null, null, null, null, null, null],
  });
  const rows = ["RESULT", "TIME", "KILLS", "DAMAGE TAKEN", "DAMAGE DEALT", "GOLD SPENT", "LEVEL"];
  let html = `<tr><th>&nbsp;</th>${cols.map((c) => `<th>${esc(c.head)}</th>`).join("")}</tr>`;
  rows.forEach((label, i) => {
    html += `<tr><td>${label}</td>` + cols.map((c, ci) => {
      const v = c.cells[i];
      if (v === null) return `<td class="none">—</td>`;
      return `<td class="${ci === 0 ? "you" : ""}${v === "CLEAR" ? " win" : ""}">${esc(v)}</td>`;
    }).join("") + `</tr>`;
  });
  return html;
}

/** THE SPLITS: your time per band against your PB and the board leader, with
 *  the band where you lost it named. This is what gives the next run a plan
 *  instead of a vibe. */

function splitsHtml(): string {
  const ticks = social.bandSplitsFrom(floorEntryTicks, runTicks);
  // Compare against the bests as they stood BEFORE this run banked its own,
  // or every split proudly reports a delta of zero against itself.
  const pb = recapPrevBests;
  // THE THIRD BAR IS REAL NOW. `leaderTicks` was hardcoded null, so the sheet
  // printed a legend entry ("| the board leader") for a mark with no data path
  // behind it, and worstBand's LOST HERE could only ever be measured against
  // yourself. The verifier derives every band split as it replays and stores
  // it on the row, so the leader's splits are already on the board page this
  // screen has loaded - two thirds of Beat 4 were a rendering omission.
  const lead = social.leaderSplits(todaysBoard, RULES_HASH.slice(0, 7));
  const splits: social.BandSplit[] = ticks.map((t, i) => ({
    band: i, name: social.bandName(i), ticks: t,
    pbTicks: pb[i] ?? null, leaderTicks: lead[i] ?? null,
  }));
  const lost = social.worstBand(splits);
  const scale = Math.max(60, ...splits.map(
    (sp) => Math.max(sp.ticks, sp.pbTicks ?? 0, sp.leaderTicks ?? 0)));
  // The legend names only the marks this sheet actually drew.
  const key: string[] = [];
  if (splits.some((sp) => sp.pbTicks)) key.push(`<i class="pbk">|</i> your personal best`);
  if (splits.some((sp) => sp.leaderTicks)) key.push(`<i class="leadk">|</i> the board leader`);
  document.getElementById("recap-splitkey")!.innerHTML = key.length
    ? key.join(" · ")
    : "no personal best and no sealed leader on this contract yet — these splits are the first entry in the ledger";
  return splits.map((sp) => {
    if (sp.ticks <= 0) {
      return `<div class="splitrow empty"><span class="sname">${sp.name}</span>` +
        `<span class="strack"></span><span class="stime">—</span></div>`;
    }

    const pct = (sp.ticks / scale) * 100;
    const cleared = bandCleared(sp.band);
    const pbMark = sp.pbTicks ? `<i class="spb" style="left:${(sp.pbTicks / scale) * 100}%"></i>` : "";
    const leadMark = sp.leaderTicks
      ? `<i class="slead" style="left:${(sp.leaderTicks / scale) * 100}%" ` +
        `title="the board leader ran this band in ${social.ticksClock(sp.leaderTicks)}"></i>`
      : "";
    // A partial band gets no delta: comparing an unfinished split against a
    // finished one is the same lie as ranking it.
    const delta = cleared && sp.pbTicks
      ? ` <span style="color:${sp.ticks <= sp.pbTicks ? "#6da356" : "#c0392f"}">` +
        `${social.signedTime((sp.ticks - sp.pbTicks) / 60)}</span>`
      : cleared ? "" : ` <span style="color:#6f6757">partial</span>`;
    return `<div class="splitrow${sp.band === lost ? " lost" : ""}">` +
      `<span class="sname">${sp.name}${sp.band === lost ? " — LOST HERE" : ""}</span>` +
      `<span class="strack"><i class="sfill" style="width:${Math.min(99, pct)}%"></i>${pbMark}${leadMark}</span>` +
      `<span class="stime">${social.mmss(sp.ticks / 60)}${delta}</span></div>`;
  }).join("");
}

/**
 * Did this run actually CLEAR a band, or did it just die inside one? The band
 * boards are "fastest clear of the band three floors", and a run that dies
 * eight seconds into floor 1 has not set an eight-second UNDERCROFT split - it
 * has an unfinished one. Banking that as a personal best puts a lie at the top
 * of a board, so a partial band is shown and never ranked.
 */
function bandCleared(band: number): boolean {
  if (state.status === "won" && band === FLOOR_BANDS.length - 1) return true;
  const nextBandFirstFloor = (band + 1) * 3 + 1;
  if (nextBandFirstFloor > CONFIG.finalFloor) return state.status === "won";
  return (floorEntryTicks[nextBandFirstFloor - 1] ?? -1) >= 0;
}

const BAND_BEST_KEY = "dcc:bandbests:v1";

/**
 * THE BAND LEDGER IS A CACHE, NOT AN AUTHORITY (blocker: two sources of truth).
 *
 * This browser used to hold its own band personal bests under its own
 * completeness rule, while the band BOARD read the server's run_bands under a
 * different one - so the career panel and the board could print different
 * records for the same crawler and the same band, and both looked official.
 * The server's verified rows are now the record; this key only exists so an
 * offline crawler still sees something, and the server response overwrites it
 * on every load.
 */
function storeBandBests(ticks: readonly (number | null)[]): void {
  try { localStorage.setItem(BAND_BEST_KEY, JSON.stringify(ticks)); } catch { /* cache is a bonus */ }
}

function loadBandBests(): (number | null)[] {
  try {
    const v = JSON.parse(localStorage.getItem(BAND_BEST_KEY) ?? "null") as (number | null)[] | null;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
/** Returns the bands that just became personal bests - the headline earning. */
function commitBandBests(): number[] {
  const ticks = social.bandSplitsFrom(floorEntryTicks, runTicks);
  const best = loadBandBests();
  const beaten: number[] = [];

  ticks.forEach((t, i) => {
    if (t <= 0 || !bandCleared(i)) return;
    const cur = best[i];
    if (cur == null || t < cur) { beaten.push(i); best[i] = t; }
  });
  storeBandBests(best); // an offline cache; the server response overwrites it
  return beaten;
}

/** THE ONE CLOCK THIS RUN HAS. Built from the tick count the proof and the
 *  board row are both built from, so no two surfaces can round it differently. */
function runClock(s: GameState): string {
  // ...AND IN THE SAME FORMAT. Rounding a tick count to the whole second here
  // while the board row prints centiseconds is still two different numbers for
  // the same run: 2:06 on the headline against 2:05.73 one screen away. The
  // data was always exact; both surfaces print it exactly.
  return runTicks > 0 ? social.ticksClock(runTicks) : fmt(s.elapsed);
}

function renderRecap(s: GameState): void {
  const p = me(s);
  const won = s.status === "won";
  // THE WIN IS NOT THE DEATH SCREEN WITH DIFFERENT WORDS. An eighteen-floor
  // clear used to differ from a floor-3 death by a colour token on the title;
  // `#recap.won` is what lets the stylesheet give the rarest outcome in the
  // game its own key light, its own border and its own plate.
  recapEl.classList.toggle("won", won);
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
      `THE RACE IS OVER · run time ${runClock(s)} · ${standings}`;
  } else {
    title.textContent = won ? "YOU ESCAPED THE DUNGEON" : "IN MEMORIAM";
    title.className = won ? "win" : "wipe";
    // ONE CLOCK, FROM THE TICK COUNT THE ROW IS BUILT FROM. The headline read
    // `fmt(s.elapsed)` and the board row read `ticksClock(ticks)`, so the same
    // run printed "run time 2:05" here and "2:06" one screen away - on the
    // product whose whole pitch is that its numbers agree with each other.
    document.getElementById("recap-sub")!.textContent = won
      ? `THE FINALE · all ${CONFIG.finalFloor} floors cleared · run time ${runClock(s)} · ${p.name}, Crawler`
      : `Episode canceled on floor ${s.floor} · run time ${runClock(s)} · the crowd demands a rerun`;
  }
  // THE WIN IS NOT A HUE. The victory plate carries the result itself, so an
  // eighteen-floor clear and a floor-1 idle death stop differing by a headline
  // string and a colour token.
  document.getElementById("recap-plate-sub")!.textContent = won
    ? `${CONFIG.finalFloor} FLOORS · ${runClock(s)} · ${p.kills.toLocaleString()} KILLS · `
      + "THE NETWORK IS BROADCASTING THIS ONE AGAIN"
    : "THE NETWORK IS BROADCASTING THIS ONE AGAIN";
  // THE SCOREBOARD OWNS THE FIVE NUMBERS. FINAL STATS printed LEVEL, KILLS,
  // DAMAGE DEALT, DAMAGE TAKEN and GOLD SPENT as tiles 300px to the right of a
  // scoreboard column printing the same five - the half of the report card 6.3
  // said to cut, surviving beside the thing that replaced it. Only GOLD BANKED
  // was unique, and it belongs with the other things this run walked away with.
  document.getElementById("recap-show")!.innerHTML =
    `<div class="rstat"><b>${coinIcon} ${p.gold.toLocaleString()}</b><small>GOLD BANKED</small></div>` +
    `<div class="rstat viewers"><b>${Math.round(p.viewers).toLocaleString()}</b><small>VIEWERS</small></div>` +
    `<div class="rstat favorites"><b>${Math.floor(p.favorites).toLocaleString()}</b><small>FAVORITES</small></div>` +
    `<div class="rstat sponsors"><b>${p.sponsors}</b><small>SPONSORS</small></div>`;
  const ach = p.achievements
    .map((id) => ACHIEVEMENTS.find((a) => a.id === id)?.title)
    .filter((t): t is string => !!t);
  document.getElementById("recap-ach")!.innerHTML = ach.length
    ? `${uic("star")} ${ach.map(esc).join(` · ${uic("star")} `)}`
    : "None recorded. The System pretends not to judge.";
  // Six rows of "no X equipped" is a third of the column spent saying nothing.
  // One line says the same thing and tells you WHY.
  const anyGear = EQUIP_SLOTS.some((slot) => p.equipment[slot]);
  document.getElementById("recap-gear")!.innerHTML = anyGear
    ? EQUIP_SLOTS.map((slot) => gearRowHtml(slot, p.equipment[slot])).join("")
    : `<div class="gear-row none rar-common">nothing equipped — ${
      s.status === "won" ? "you walked out in what you arrived in" : "the run ended before the first drop"}</div>`;
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
    : "";
  document.getElementById("recap-again")!.style.display = net ? "none" : "";

  // ---- Beat 1: THE GRADE ------------------------------------------------
  // A test-chamber start is HANDED its depth; it did not earn it, and the
  // verifier would reject the proof for exactly that reason. This used to
  // rewrite the DEPTH tile's DETAIL STRING and leave its SCORE untouched, so
  // the meter filled to 100/100 in gold directly above a red banner saying the
  // depth was handed to you - two elements 40px apart asserting opposite
  // things about the same number, on a grade that is supposed to be
  // auditable. The flag now reaches the arithmetic (src/ui/social.ts).
  runGrade = social.gradeRun(
    {

      floor: s.floor, won, elapsedSec: s.elapsed, kills: p.kills, level: p.level,
      damageTaken: p.damageTaken, draftsClaimed, draftsOffered,
      floorsCleared: Math.max(0, floorEntryTicks.filter((t) => t >= 0).length - 1),
      startedAtDepth: !runIsRankable(s),
    },
    loadHistory(), todaysBoard, p.maxHp,
  );
  const medal = document.getElementById("recap-medal")!;
  medal.className = `vmedal g-${runGrade.letter}`;

  document.getElementById("recap-letter")!.textContent = runGrade.letter;
  document.getElementById("recap-score")!.textContent = String(runGrade.score);
  // THE BASIS, IN A CONTAINER AND AT A SIZE SOMEBODY IS MEANT TO READ. The
  // ceiling clause is a chip rather than a trailing " · CAPPED BY DEPTH" that
  // pushed the line to three wraps of 11px --ink-faint under the medal.
  const capped = runGrade.basis.includes("CAPPED BY DEPTH");
  document.getElementById("recap-basis-set")!.textContent =
    runGrade.basis.replace(" · CAPPED BY DEPTH", "").replace(/^vs /, "");
  document.getElementById("recap-basis-cap")!.toggleAttribute("hidden", !capped);
  medal.title = runGrade.basis;
  document.getElementById("recap-line")!.textContent = runGrade.line;
  document.getElementById("recap-parts")!.innerHTML = verdictPartsHtml(runGrade);

  // ---- Beat 3: THE DEATH, NAMED ----------------------------------------
  // Straight off Player.lastHitSrc, which the sim records at the
  // damagePlayerHit funnel. No heuristic, no correlation, no guessing in a
  // crowd - and the verifier derives the same field when it seals the row.
  const deathEl = document.getElementById("recap-death")!;
  const src = p.lastHitSrc ?? null;
  if (won) {
    deathEl.className = "death clear";
    document.getElementById("recap-death-head")!.textContent =
      `${CONFIG.finalFloor} FLOORS. NOTHING DOWN THERE KEPT YOU.`;
    document.getElementById("recap-death-ctx")!.textContent =
      "The dungeon has your measurements now. So does the network.";
  } else {
    deathEl.className = "death";
    const held: AbilityId[] = [
      ...p.abilities.slots.filter((a): a is AbilityId => a !== null),
      ...(p.abilities.ultimate ? [p.abilities.ultimate] : []),
    ];
    const ready = held.filter((a) => !(p.cd[a] && p.cd[a]! > 0)).map((a) => ABILITY_INFO[a].name);
    document.getElementById("recap-death-head")!.innerHTML = src
      ? `${uic("skull")} ${esc(social.deathHeadline(src))}`
      : `${uic("skull")} THE COLLAPSE TOOK YOU — no killing blow, just the clock.`;
    document.getElementById("recap-death-ctx")!.textContent = social.deathContext({
      ready: ready.slice(0, 3),
      flasks: p.flaskCharges,
      unclaimedDrafts: p.pendingRewards.length + p.pendingUpgrades.length + p.upgradeDraftsOwed,
    });
  }

  // ---- Beat 2 + 4 (behind TAB) -----------------------------------------
  document.getElementById("recap-scoreboard")!.innerHTML = scoreboardHtml(s);
  document.getElementById("recap-splits")!.innerHTML = splitsHtml();

  // ---- Beat 5: WHAT YOU EARNED, and the seal resolving live -------------
  renderLadderLine(s);
  renderMark(s);
  renderEarned(s); // ...which draws the banked ledger and the seal beneath it
  // ---- Beat 6: the buttons that make sense for THIS run -----------------
  document.getElementById("recap-race")!.style.display =
    !net && (todaysBoard ?? []).some((r) => social.playability(r, RULES_HASH.slice(0, 7)).ok) ? "" : "none";
  document.getElementById("recap-share")!.style.display = net ? "none" : "";
  // The CTA is RUN IT BACK either way - Beat 6 is explicit about the order -
  // but a clear and a death are running it back for opposite reasons, and the
  // sub-line is what stops the win screen reading as the death screen's
  // button row.
  document.getElementById("recap-again-sub")!.textContent = won
    ? "same seed · beat the time you just set"
    : "same seed · your own ghost on the course";
}

/**
 * THE LP LINE (6 Beat 5). LoL puts your rank, your LP and the LP this game
 * moved on the post-game screen, permanently, in the default state - because it
 * is the reason you queue again. Ours lived inside a collapsed [SHOW THE MATH]
 * drawer AND only rendered for event runs, so an ordinary run showed no ladder
 * number at all and the screen had no answer to "what did that do for me".
 *
 * Now it is one permanent line beside the seal, and it never lies by omission:
 * a free seed says "+0 CP" out loud, because "the ladder did not move" is
 * information, and a blank space is not.
 */
function renderLadderLine(s: GameState): void {
  const el = document.getElementById("recap-ladder")!;
  if (net) { el.innerHTML = ""; el.className = "ladderline"; el.style.display = "none"; return; }
  el.style.display = "";
  if (!runIsRankable(s)) {
    el.className = "notranked";
    el.innerHTML = `<b>TEST CHAMBER — NOT RANKED.</b> This run started at depth instead of at the door. ` +
      `The verifier refuses any proof whose start was not fresh, so there is no seal, no contract points ` +
      `and no board row here — and the grade above is a rehearsal, not a result.`;
    return;
  }
  // THE VERIFIER'S REFUSAL OUTRANKS EVERY OTHER LINE ON THIS PLATE. A rejected
  // run holds no row, no split and no CP, so it is told that here rather than
  // being handed a ladder plate 120px above the block that refuses it. The
  // SEASON total survives - it belongs to earlier runs and it is still true.
  if (verdictRefused()) {
    const st = myStanding;
    el.className = "notranked";
    el.innerHTML = `<b>NO ROW, NO SPLIT, NO POINTS.</b> The System replayed this run and did not get ` +
      `the run you claimed, so nothing from it enters the ledger — not the board row, not the band ` +
      `splits, not a single contract point.` +
      (st ? ` Your season stands where the runs it was earned on left it: ` +
        `<b>${st.cp.toLocaleString()} CP</b>.` : "");
    return;
  }
  el.className = "ladderline";
  const st = myStanding;
  if (!st) {
    el.innerHTML = `<div class="lmain"><span class="lt">UNRANKED</span>` +
      `<span class="lcp">standing unread</span></div>` +
      `<div class="lstat"><span class="ldelta flat">OFFLINE</span></div>` +
      `<div class="lnote">the ladder is unreachable — your standing is on the server, and it will ` +
      `still be there when the signal is back</div>`;
    return;
  }
  // TIERS ARE SUPPRESSED BELOW A POPULATION FLOOR, and the reason is printed.
  // A BRONZE ENTRANT badge on the last-placed player of a four-account season
  // is a costume; CP and "rank 4 of 4" is the truth and just as motivating.
  const tier = st.tier
    ?? (st.placementRemaining > 0 ? `PLACEMENT — ${st.placementRemaining} TO GO` : "UNRANKED");
  const rank = st.entrants > 0 && st.rank > 0
    ? `rank ${st.rank} of ${st.entrants} this season`
    : "no ranked contract scored yet";
  // WHAT THIS RUN MOVED. CP scores the FIRST ticketed attempt on a contract and
  // nothing else, so most runs move it by zero - said plainly, with the reason.
  let chip: string;
  let note: string;
  if (!runEvent) {
    chip = `<span class="ldelta flat">+0 CP</span>`;
    // ...and if the run was on the DAY'S SEED it says so, because "free seed"
    // was flatly false about the dungeon the front door hands you.
    note = runContractNote
      ?? "a free seed — contract points come from contracts. The board row and the splits still stand.";
  } else if (!runEvent.scoresCp) {
    chip = `<span class="ldelta flat">+0 CP</span>`;
    // THE REASON HAS TO BE THE ACTUAL REASON. For an unlinked crawler this
    // branch printed "CP scores your FIRST ticketed attempt only" on ATTEMPT
    // ONE - the one sentence that cannot be true about the run in front of
    // them - because `scoresCp` folded two different noes into one flag.
    note = submitResult?.needsIdentity || runEvent.attemptNo === 1
      ? `attempt 1, and the System cannot put its name on it: an anonymous claim earns no seal `
        + `and no contract points. Link an identity and the next one scores.`
      : `attempt ${runEvent.attemptNo} on this contract — CP scores your FIRST ticketed attempt `
        + `only. The board row still updates, and so do the splits.`;
  } else if (cpBeforeRun !== null && st.cp > cpBeforeRun) {
    chip = `<span class="ldelta up">+${st.cp - cpBeforeRun} CP</span>`;
    note = "attempt 1 on this contract — the run the ladder scores. There is no second first impression.";
  } else {
    chip = `<span class="ldelta">CP PENDING</span>`;
    note = "attempt 1 — it lands when the seal does, because CP only ever moves on a run the server "
      + "re-executed.";
  }
  if (!st.tier && st.placementRemaining === 0 && st.entrants < st.tierFloor) {
    note += ` Tier names unlock at ${st.tierFloor} ranked crawlers — ${st.entrants} so far.`;
  }
  el.innerHTML =
    `<div class="lmain"><span class="lt">${esc(tier)}</span>` +
    `<span class="lcp">${st.cp.toLocaleString()} CP this season</span></div>` +
    `<div class="lstat">${chip}<span class="lrank">${esc(rank)}</span></div>` +
    `<div class="lnote">${esc(note)}</div>`;
}

/**
 * THE MARK (6 Beat 2, in the DEFAULT state). One row of the crawler at the top
 * of today's contract, permanently, beside the grade — because League's default
 * post-game IS the scoreboard, ours costs a held TAB, and the pointer to that
 * TAB was 11.5px of the least legible colour on the screen. A player who never
 * discovers the tab is a player the screen compared to nobody at all.
 */
function renderMark(s: GameState): void {
  const el = document.getElementById("recap-mark")!;
  if (net) { el.style.display = "none"; return; }
  const b = social.benchmark(
    { floor: s.floor, won: s.status === "won", elapsedSec: s.elapsed },
    // ...AND IT KNOWS WHICH ROWS ARE MINE (blocker 5). Without this the screen
    // named the player as their own rival: "CARL / FLOOR 1 / level with the
    // leader", on the player's own row, on the one comparison the default
    // post-run state makes.
    todaysBoard, recapPrevCareer?.bestFloor ?? 0, myPublicId,
  );
  if (!b) {
    el.style.display = "";
    el.innerHTML = `<div class="mk">◆ THE MARK ◆</div>` +
      `<div class="mwho">NOBODY HAS SET ONE</div>` +
      `<div class="mwhat">no sealed row on today's contract, and nothing in this browser's ledger</div>` +
      `<div class="msrc">the first crawler to finish today sets the mark everyone else reads</div>`;
    return;
  }
  el.style.display = "";
  el.innerHTML =
    `<div class="mk">◆ THE MARK ◆</div>` +
    `<div class="mwho">${esc(b.who)}</div>` +
    `<div class="mwhat">${esc(b.what)}</div>` +
    `<div class="mgap${b.ahead ? "" : " behind"}">${esc(b.gap)}</div>` +
    `<div class="msrc">${esc(b.source)}</div>`;
}

/**
 * WHAT THE RUN BANKED, WHATEVER ELSE IT DID (6 Beat 5).
 *
 * A floor-3 death produced "+0 CP", a hairline seal reading "It ranks nowhere",
 * and "no personal bests this run — the ledger is unmoved": three of the four
 * informational blocks saying nothing happened. Honest, and exactly why a
 * player closes the tab. None of this is a claim about the ladder — it is this
 * browser's own ledger, counted — so it costs nothing against the verification
 * spine and it changes what the ten seconds feel like.
 */
function renderBanked(s: GameState): void {
  const el = document.getElementById("recap-banked")!;
  // A rehearsal banks nothing and a refused run banks nothing. Both say so
  // elsewhere on the screen; neither gets a ledger strip.
  if (net || !runIsRankable(s) || verdictRefused()) { el.style.display = "none"; return; }
  el.style.display = "";
  const p = me(s);
  const history = loadHistory();
  const ticks = social.bankedTicks(history, episodeCount(), {
    kills: p.kills, timeSec: Math.round(s.elapsed), floor: s.floor,
  });
  // The NEXT target is read off the ledger INCLUDING this run - it is the only
  // number on the screen that is supposed to already know what just happened.
  const next = social.nextMilestone(careerBests(history)?.bestFloor ?? 0, s.status === "won");
  el.innerHTML = ticks.map((t) =>
    `<div class="btick"><span class="bl">${esc(t.label)}</span>` +
    `<span class="bv">${esc(t.value)}</span>` +
    (t.delta ? `<span class="bd">${esc(t.delta)}</span>` : "") + `</div>`).join("")
    + `<div class="bnext">NEXT: <b>${esc(next.title)}</b> — ${esc(next.detail)}</div>`;
}

/**
 * Beat 5. In the default state this is ONE line and a chip; the detail is one
 * click away. Two states it must handle without lying: an unlinked identity
 * (no seal, said in the System voice) and a rejection (said plainly and
 * immediately - a rejection with no explanation is how honest players conclude
 * the ladder is rigged).
 */
function renderEarned(s: GameState): void {
  const line = document.getElementById("recap-earned")!;
  const detail = document.getElementById("recap-earned-detail")!;
  const beaten = recapBandPbs;
  const bests = recapPrevCareer; // the ledger this run found, not the one it joined
  const rows: string[] = [];

  // ...AND IT POINTS AT THE LEDGER THAT IS ACTUALLY THERE. The strip this
  // sentence refers to (EPISODE / TIME IN THE DUNGEON) sits ABOVE this line in
  // the DOM, and the copy said "below".
  let headline = "no personal bests this run — the ledger above is what it moved";
  // A rehearsal banks nothing, and the headline must not claim otherwise. This
  // used to print "THE CLEAR IS ON THE BOARD" on a test-chamber win, directly
  // under the screen's own TEST CHAMBER — NOT RANKED banner.
  if (!runIsRankable(s)) {
    headline = "nothing banked — a run that started at depth moves no ledger";
  } else if (verdictRefused()) {
    // ...and neither does a run the verifier refused. This used to print
    // "NEW PB — DEEPEST FLOOR 1" in gold, seventy pixels under the block
    // saying the replay did not produce the run at all.
    headline = "nothing banked — the System refused the recording, so no record stands on it";
  } else if (beaten.length > 0) {
    headline = `<b>NEW PB — ${social.bandName(beaten[0])} SPLIT</b>`;
  } else if (bests && bests.bestFloor > 0 && s.floor > bests.bestFloor && s.status !== "won") {
    // `s.floor >= bests.bestFloor` printed "NEW PB — DEEPEST FLOOR 1" on a
    // two-second floor-1 death against an empty ledger. A personal best has to
    // beat something, and a hollow one spends the word.
    headline = `<b>NEW PB — DEEPEST FLOOR ${s.floor}</b>`;
  } else if (s.status === "won") {
    headline = `<b>THE CLEAR IS ON THE BOARD</b>`;
  }
  if (!verdictRefused()) {
    for (const b of beaten) rows.push(`<div class="erow"><span class="pb">NEW PB</span><b>${social.bandName(b)}</b> split</div>`);
  }
  if (runEvent) {
    rows.push(
      `<div class="erow"><b>ATTEMPT ${runEvent.attemptNo}</b> on this contract — ` +
      (runEvent.scoresCp
        ? "your FIRST ticketed attempt, so this is the one the ladder scores."
        : "the board row updates; CP is unchanged, because CP scores attempt 1 only.") +
      `</div>`,
    );
    rows.push(
      `<div class="cpmath">CP = 40 for finishing + round(1000 · (1 − rank/entrants)^1.5). ` +
      `Your season score is the sum of your best 10 event results — no decay, ever.</div>`,
    );
  }
  if (submitResult?.reason) rows.push(`<div class="erow">${esc(submitResult.reason)}</div>`);
  if (recBlocked) rows.push(`<div class="erow">${esc(recBlocked)}</div>`);

  line.innerHTML = `${headline}<span class="caret">${earnedOpen ? "[ HIDE THE MATH ]" : "[ SHOW THE MATH ]"}</span>`;
  detail.innerHTML = rows.join("") || `<div class="erow">Nothing banked. The System is not impressed, but it is watching.</div>`;
  detail.style.display = earnedOpen ? "" : "none";
  renderBanked(s);
  renderSeal();
}

/** The word on the block last time we drew it, so a state change is detected
 *  once - on the transition into a terminal state, not on every re-render. */
let sealWordShown = "";

/**
 * THE SEAL STATE HAS TO BE READABLE ON SCREEN (blocker 6). Instrumented on the
 * shipping build: at t+0 the block carried `vseal pending`, and by t+900ms it
 * already read `vseal verified ranked`. The pending state was never visible for
 * a single painted frame, so the player could not tell that the server had done
 * anything at all.
 *
 * `verdictVisibleAt` is when the card actually reaches the screen, and a
 * terminal verdict that arrives before the pending block has had its floor is
 * HELD rather than dropped, so the sequence a player sees is always
 * VERIFYING -> SEALED and never a single frame of either. That is legibility,
 * not staging: nothing animates, the words simply stay put long enough to read.
 */
let verdictVisibleAt = 0;
/** When the currently-shown non-terminal block became visible. */
let sealPendingSince = 0;
let sealHoldTimer: number | null = null;

/**
 * THE SEAL (6 Beat 5). A block rather than a 10.5px chip, because the reason a
 * submission was refused has to be readable on the default face rather than
 * parked in a title=. One kicker, one word, one sentence of System voice.
 */
function renderSeal(): void {
  const el = document.getElementById("recap-seal")!;
  const era = RULES_HASH.slice(0, 7);
  // THE ONE SERVER-AUTHORITATIVE SCORE IN THE PRODUCT WAS THE ONE THE PLAYER
  // NEVER SAW EARNED. A won RIVALS contract writes a SEALED, era-stamped
  // contracts row server-side (gameServer, insertServerVouched) — and this
  // function opened with `if (net) { display = "none"; return; }`, so the
  // winner's own verdict screen showed no seal at all, minutes after
  // `recBlocked` told them "party runs are hosted by the server — the solo
  // descent is what carries a proof". The board and the verdict disagreed
  // about the same run.
  if (net) {
    const iWon = state.mode === "rivals" && state.status === "won"
      && state.winnerId === me(state).id;
    if (!iWon) { el.style.display = "none"; return; }
    el.style.display = "";
    paintSeal(el, social.verdictSeal("vouched", era));
    return;
  }
  el.style.display = "";
  // A run HOLDING a board position gets the trophy treatment; a run the
  // server replayed and certified that ranks nowhere gets the same truth
  // without the gold flood. Printing them identically spends the scarcity.
  //
  // ...AND IT ASKS THE SERVER WHICH BOARDS, not one board it happened to load.
  // `ranked` used to be "is my run id in `todaysBoard`", and `todaysBoard` is
  // the DAILY CONTRACT deepest board - so a free-seed run taking rank 1
  // all-time got the plain hairline and the line "It ranks nowhere, and it is
  // still true", which is false about the run that most deserved the gold.
  const held = submitResult?.boards ?? null;
  const ranked = !!submitResult?.runId && (
    (held !== null && held.length > 0)
    || (held === null && (todaysBoard ?? []).some((r) => r.id === submitResult!.runId))
  );
  const v = recBlocked
    ? social.verdictSeal("blocked", null, false, false, recBlocked)
    : !submitResult
      ? social.verdictSeal(runProof ? "unsubmitted" : "blocked", null, false, false,
          runProof ? null : "no proof was recorded for this run, so there is nothing to certify")
      : social.verdictSeal(
          (submitResult.state as social.RunState) ?? "claimed",
          submitResult.state === "verified" ? era : null,
          submitVisibility === "private", ranked, submitResult.reason ?? null, held,
          // THE REFUSAL ARRIVES WITH THE CONTROL (6.2 Beat 5). Typed off the
          // submit outcome rather than matched out of the prose, so a copy edit
          // cannot silently take the button away again.
          !!submitResult.needsIdentity && signInAvailable(),
        );
  paintSeal(el, v);
}

/** Is there anything the LINK AN IDENTITY button could actually do? A button
 *  that goes nowhere is worse than the sentence it replaced. */
function signInAvailable(): boolean {
  return authProviders.length > 0 && !loadSignin();
}

/** Draw the seal block, changing state exactly once — on the transition INTO a
 *  terminal state, never on a re-render. */
function paintSeal(el: HTMLElement, v: social.VerdictSeal): void {
  // THE FLOOR UNDER THE PENDING STATE (blocker 6). A terminal verdict that
  // arrives before the pending block has been visible for SEAL_MIN_PENDING_MS
  // is held - never dropped - and re-issued the moment the floor expires. Only
  // the FIRST paint is exempt: a screen that opens on an already-terminal
  // verdict (a refused run, a rehearsal) has no pending state to honour.
  const hold = social.sealHoldMs(
    performance.now(), verdictVisibleAt, sealPendingSince, v.terminal, sealWordShown !== "",
  );
  if (hold > 0) {
    if (sealHoldTimer !== null) window.clearTimeout(sealHoldTimer);
    sealHoldTimer = window.setTimeout(() => { sealHoldTimer = null; paintSeal(el, v); }, hold);
    return;
  }
  const actionHtml = v.action && signInAvailable()
    ? `<div class="vact"><button id="recap-link" class="vlink">${esc(v.action.label)}</button>` +
      `<span class="vactnote">${esc(v.action.note)}</span></div>`
    : "";
  if (v.word === sealWordShown) {
    // Same state, re-rendered (the board arrived, a PB landed): update the
    // copy without restaging the strike.
    el.className = v.cls;
    el.querySelector(".vl")!.textContent = v.line;
    const act = el.querySelector(".vact");
    if (!!actionHtml !== !!act) { sealWordShown = ""; paintSeal(el, v); }
    return;
  }
  const first = sealWordShown === "";
  sealWordShown = v.word;
  // A new NON-terminal state restarts the dwell: VERIFYING replacing READY TO
  // SUBMIT is itself a beat, and it gets its own screen time.
  if (!v.terminal) {
    sealPendingSince = Math.max(performance.now(), verdictVisibleAt + social.SEAL_CASCADE_MS);
  }
  el.className = v.cls;
  el.innerHTML =
    `<div class="vk">${esc(v.kicker)}</div>` +
    `<div class="vw">${esc(v.word)}</div>` +
    `<div class="vl">${esc(v.line)}</div>` + actionHtml;
  const link = el.querySelector("#recap-link");
  if (link) {
    link.addEventListener("click", () => beginSignIn(authProviders[0]));
  }
  // The verdict ARRIVING is worth a sound - it is the one moment on this screen
  // the player did not already know about. The 1.9s scale/flood/ring "strike"
  // that used to ride along with it is gone: the block changes state, plainly.
  if (!first && v.terminal) {
    audio.play(v.cls.includes("rejected") ? "warning" : "achievement");
  }
}

/** Seal the recording against the world it produced, then offer it. The offer
 *  is a CHOICE (8.1): the disclosure card runs once, before the first submit
 *  this browser ever makes, and two of its three buttons call submitProof. */
function sealRun(s: GameState): void {
  if (!rec) return;
  if (rec.truncated) {
    recBlocked = "this run outgrew the artifact ceiling — six hours is the limit, and you found it";
    rec = null;
    return;
  }
  try {
    runProof = rec.finish(s, me(s).id);
  } catch {
    recBlocked = "the recording could not be sealed";
  }
  rec = null;
}

/** Bands that just became personal bests, committed once per run end, and the
 *  ledger as it stood before this run touched it. */
let recapBandPbs: number[] = [];
let recapPrevBests: (number | null)[] = [];
/** The career bests as they stood BEFORE this run was written to the ledger. */
let recapPrevCareer: ReturnType<typeof careerBests> = null;
let submitVisibility: "public" | "private" = "public";

/**
 * NO BEAT 0. An elevation round staged the run's end as a cinematic: a 0.6s
 * hit-stop, `body.cine` to pull the entire HUD out of frame, the boss-intro
 * letterbox, and a 520ms grayscale/dim lens held on the canvas for as long as
 * the card was up. Between the lens and a radial scrim the dungeon behind the
 * verdict went to near-black, and the player sat through ~760ms of directed
 * nothing before the screen they came for arrived.
 *
 * It is reverted. The run ends, the card comes up on the same short timer it
 * always did, and the world stays visible behind it. The letterbox, the
 * screen grade and `body.cine` still belong to the boss beat that authored
 * them — the verdict simply stopped borrowing them.
 */

/** Show the recap when the run ends; re-arm when a new run starts. */
function maybeShowRecap(s: GameState): void {
  if (s.status === "playing") { recapFor = null; return; }
  if (recapFor === s.status) return;
  recapFor = s.status;

  recapPrevBests = loadBandBests();
  // A REHEARSAL DOES NOT BANK A RECORD. `bandCleared` returns true for the
  // final band on any win, with no rankability check, so `?test&floor=18` plus
  // a boss kill wrote a real THE APPROACH split into the offline ledger the
  // career panel reads - and the screen printed "NEW PB — THE APPROACH SPLIT"
  // directly above its own TEST CHAMBER — NOT RANKED banner. That ledger is
  // the fallback PERSONAL BESTS reads under a heading that says "sealed
  // traversals only": exactly the two-sources-of-truth hazard 3.3 closes.
  recapBandPbs = net || !runIsRankable(s) ? [] : commitBandBests();
  submitResult = null;
  earnedOpen = false;
  sealWordShown = "";
  verdictVisibleAt = 0;
  sealPendingSince = 0;
  if (sealHoldTimer !== null) { window.clearTimeout(sealHoldTimer); sealHoldTimer = null; }
  renderRecap(s);
  // One short beat between the killing blow and the card — enough that the
  // verdict does not land on top of the hit that caused it, and no more.
  window.setTimeout(() => {
    if (recapFor !== s.status) return; // a fast R already started the next run
    recapEl.style.display = "flex";
    recapEl.classList.remove("tabbed");
    // THE CLOCK ON THE SEAL BEAT STARTS HERE - when the card is on screen, not
    // when the run ended (blocker 6).
    verdictVisibleAt = performance.now();
    sealPendingSince = verdictVisibleAt + social.SEAL_CASCADE_MS;
  }, 620);
  // The board arrives a moment later and upgrades the grade, the scoreboard
  // and RACE THE LEADER from "the house curve" to a real field.
  cpBeforeRun = myStanding?.cp ?? null;
  void Promise.all([loadTodaysBoard(), loadStanding()]).then(() => {
    if (recapFor === s.status) renderRecap(s);
  });
  // ...and the proof is OFFERED, never silently sent (8.1).

  // ...and the proof is OFFERED, never silently sent. If the crawler already
  // slammed R, the offer is dropped rather than thrown over the next run.
  if (!net) {
    window.setTimeout(() => { if (recapFor === s.status) offerProof(); }, 900);
  }
}

document.getElementById("recap-dismiss")!.addEventListener("click", () => {
  recapEl.style.display = "none"; // spectate the arena; R still restarts
});
document.getElementById("recap-earned")!.addEventListener("click", () => {
  earnedOpen = !earnedOpen;
  renderEarned(state);
});
document.getElementById("recap-new")!.addEventListener("click", () => {
  forcedSeed = null;
  ghost = null;
  startRun({ kind: "random" }, "race");
  recapEl.style.display = "none";
});
document.getElementById("recap-standings")!.addEventListener("click", () => { void openLadder(); });
// RUN IT BACK: the same seed, with THIS run as your ghost. The strongest urge
// a roguelike death produces is "I know this dungeon now", and this button is
// the only thing on the screen that answers it.
document.getElementById("recap-again")!.addEventListener("click", () => { void runItBack(); });
document.getElementById("recap-race")!.addEventListener("click", () => { void raceTheLeader(); });
// ---- The run card (launch polish #4): the recap as a shareable artifact ----
// A 1200x630 canvas (link-preview dims) in the Torchlit palette. Cinzel and
// Alegreya are document fonts, so the canvas can use them directly.
function composeRunCard(s: GameState): HTMLCanvasElement {
  const p = me(s);
  const won = s.status === "won";
  const cv = document.createElement("canvas");
  cv.width = 1200; cv.height = 630;
  const g = cv.getContext("2d")!;
  // Slab ground + double frame.
  g.fillStyle = "#0e0b09"; g.fillRect(0, 0, 1200, 630);
  g.strokeStyle = "#6e5533"; g.lineWidth = 3; g.strokeRect(14, 14, 1172, 602);
  g.strokeStyle = "rgba(0,0,0,0.6)"; g.strokeRect(18, 18, 1164, 594);
  const center = (t: string, y: number, font: string, color: string) => {
    g.font = font; g.fillStyle = color; g.textAlign = "center"; g.fillText(t, 600, y);
  };
  center("◆ DUNGEON CRAWLER CLAUDE ◆", 78, "700 24px Cinzel, serif", "#c9a24b");
  center(won ? "THE FINALE" : "IN MEMORIAM", 168, "700 72px Cinzel, serif", won ? "#f2c14e" : "#c0392f");
  // "EPISODE", not "season". 5.2 settled the vocabulary and the screen above
  // this card already uses it: a single run is an EPISODE, a season is the
  // ladder period. The card was the last place still saying the other thing.
  center(
    won
      ? `${p.name} cleared all ${CONFIG.finalFloor} floors in ${fmt(s.elapsed)}`
      : `${p.name} · Episode canceled on floor ${s.floor} · ${fmt(s.elapsed)}`,
    216, "26px 'Alegreya Sans', sans-serif", "#e8ddc8",
  );
  // Gold rule.
  g.strokeStyle = "rgba(201,162,75,0.55)"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(180, 252); g.lineTo(1020, 252); g.stroke();
  // Stat ledger, two rows of three.
  const stats: [string, string][] = [
    [String(p.level), "LEVEL"], [p.kills.toLocaleString(), "KILLS"],
    [Math.round(p.damageDealt).toLocaleString(), "DAMAGE"],
    [Math.round(p.viewers).toLocaleString(), "VIEWERS"],
    [Math.floor(p.favorites).toLocaleString(), "FAVORITES"], [String(p.sponsors), "SPONSORS"],
  ];
  stats.forEach(([v, l], i) => {
    const x = 260 + (i % 3) * 340;
    const y = 330 + Math.floor(i / 3) * 120;
    g.font = "700 46px Cinzel, serif"; g.fillStyle = "#f2c14e"; g.textAlign = "center";
    g.fillText(v, x, y);
    g.font = "16px 'Alegreya Sans', sans-serif"; g.fillStyle = "#6f6757";
    g.fillText(l, x, y + 28);
  });

  // THE GRADE, struck into the corner - the card is the artifact people paste
  // into a chat window, and a report card without its grade is a receipt.
  if (runGrade) {
    g.save();
    g.beginPath();
    g.arc(112, 112, 54, 0, Math.PI * 2);
    g.fillStyle = "#14100c";
    g.fill();
    g.strokeStyle = "#6e5533"; g.lineWidth = 2; g.stroke();
    g.font = "700 54px Cinzel, serif";
    g.fillStyle = runGrade.letter === "S" || runGrade.letter === "A" ? "#f2c14e" : "#b9b2a4";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(runGrade.letter, 112, 116);
    g.restore();
  }
  // THE DEATH, NAMED - the line worth more than every stat tile beside it.
  // y=516, not 500: the second stat row's labels sit at 478, and 22px of
  // clearance had the named death colliding with the word FAVORITES.
  if (!won && p.lastHitSrc) {
    center(social.deathHeadline(p.lastHitSrc), 516, "22px 'Alegreya Sans', sans-serif", "#e2857a");
  }
  // The build: The Five + the weapon in hand.
  const build = [
    ...p.abilities.slots.filter((a): a is AbilityId => a !== null).map((id) => ABILITY_INFO[id].name),
    ...(p.abilities.ultimate ? [`${ABILITY_INFO[p.abilities.ultimate].name} (ULT)`] : []),
  ].join(" · ");
  center(build || "bare hands and bad intentions", 550, "20px 'Alegreya Sans', sans-serif", "#a99f8c");
  if (p.equipment.weapon) center(`wielding ${p.equipment.weapon.name}`, 578, "italic 18px 'Alegreya Sans', sans-serif", "#9a6bd0");
  // THE SEAL TRAVELS WITH THE CARD. This 1200x630 is the object that actually
  // reaches strangers, and it carried the grade, six stats, the death, the
  // build and a URL - and no seal, no rules era, no run id. Zero evidence of
  // the one thing that makes this product different from every other
  // screenshot in the channel it lands in.
  {
    const st = submitResult?.state ?? (recBlocked ? "blocked" : runProof ? "unsubmitted" : "claimed");
    const sealed = st === "verified";
    const label = sealed
      ? (submitVisibility === "private" ? "SEALED · PRIVATE" : "SEALED BY THE SYSTEM")
      : st === "rejected" ? "REFUSED ON VERIFICATION"
        : st === "verifying" ? "VERIFICATION PENDING" : "UNSEALED CLAIM";
    const col = sealed ? "#f2c14e" : st === "rejected" ? "#c0392f" : "#6f6757";
    g.save();
    g.textAlign = "right"; g.textBaseline = "alphabetic";
    g.font = "700 20px Cinzel, serif"; g.fillStyle = col;
    g.fillText(label, 1120, 104);
    g.font = "14px 'Alegreya Sans', sans-serif"; g.fillStyle = "#6f6757";
    g.fillText(
      sealed
        ? `the server re-executed this run · rules era ${RULES_HASH.slice(0, 7)}`
        : "the server has not re-executed this run",
      1120, 126,
    );
    if (submitResult?.runId) g.fillText(`run ${submitResult.runId}`, 1120, 146);
    // A struck rule under the seal so it reads as a stamp, not a caption.
    g.strokeStyle = col; g.globalAlpha = 0.5; g.lineWidth = 1;
    g.beginPath(); g.moveTo(870, 114); g.lineTo(1128, 114); g.stroke();
    g.restore();
  }
  const footer = runMode.kind === "daily" && runMode.day
    ? `DAILY CRAWL ${runMode.day} · dungeon-crawler-claude.fly.dev`
    : `dungeon-crawler-claude.fly.dev`;
  center(footer, 604, "15px 'Alegreya Sans', sans-serif", "#6f6757");
  return cv;
}

function saveRunCard(): void {
  const cv = composeRunCard(state);
  cv.toBlob(async (blob) => {
    if (!blob) return;
    const name = `dcc-${state.status === "won" ? "finale" : "memoriam"}-${dayFromMs(Date.now())}.png`;
    const file = new File([blob], name, { type: "image/png" });
    // The mobile path is the OS share sheet; desktop falls back to a download.
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Dungeon Crawler Claude" }); return; } catch { /* fall through */ }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, "image/png");
}

// COPY BUILD CODE (8.2, the receipt half). Derived from the run that actually
// happened - a shared build here is permanently attached to evidence that it
// worked, where LoL build sites can only offer an aggregate guess.
document.getElementById("recap-buildcode")!.addEventListener("click", async () => {
  const p = me(state);
  const code = social.encodeBuild({
    level: p.level,
    ultimate: p.abilities.ultimate,
    slots: [...p.abilities.slots],
    ranks: { ...p.abilities.ranks },
    glyphs: p.glyphs
      ? { slots: p.glyphs.slots.map((s) => [...s]), ultimate: [...p.glyphs.ultimate] }
      : null,
    gear: EQUIP_SLOTS.flatMap((slot) => {
      const it = p.equipment[slot];
      return it ? [{ slot, name: it.name, rarity: it.rarity }] : [];
    }),
    revisions: [...(p.revisions ?? [])],
  });
  const btn = document.getElementById("recap-buildcode")!;
  const label = btn.textContent;
  btn.textContent = (await copyText(code)) ? "BUILD CODE COPIED" : "COPY FAILED";
  setTimeout(() => { btn.textContent = label; }, 1600);
});

// SHARE (COMPETITIVE.md 8.2): a seed plus a claim is about eighty characters,
// and it reproduces the whole dungeon - because the dungeon IS the seed. The
// link carries the same code, so one copy serves chat and browser both.
/**
 * THE SHARE SHEET (8.2) — one surface, both artifacts, and the artifact is
 * SHOWN before anything is copied.
 *
 * SHARE used to write a URL to the clipboard with the only feedback being the
 * button label flipping to CHALLENGE COPIED for 1.6 seconds: no preview, no
 * card, no confirmation of what a recipient would actually see. SAVE CARD was
 * a second, separate path that never combined with it. The two are the same
 * act.
 */
const shareEl = document.getElementById("sharesheet")!;
let shareUrl = "";

function openShareSheet(): void {
  const p = me(state);
  // A CHALLENGE CODE ONLY CARRIES A RUN ID THE SERVER WOULD STAND BEHIND.
  // The id used to be embedded unconditionally, including for runs in state
  // `claimed` or `rejected`, and the receiving side checked only the era - so
  // a stranger could be handed a ghost the server had explicitly refused to
  // certify.
  const sealed = submitResult?.state === "verified" && !!submitResult.runId
    && submitVisibility === "public";
  shareUrl = `${location.origin}${location.pathname}?c=${social.encodeChallenge({
    seed: state.seed,
    ev: runEvent?.eventId,
    by: p.name,
    floor: state.floor,
    won: state.status === "won",
    timeSec: Math.round(state.elapsed),
    kills: p.kills,
    level: p.level,
    ult: p.abilities.ultimate,
    run: sealed ? submitResult!.runId : undefined,
  })}`;
  // Draw the real card into the preview, at whatever size the sheet is.
  const cv = composeRunCard(state);
  const dst = document.getElementById("share-preview") as HTMLCanvasElement;
  dst.getContext("2d")!.drawImage(cv, 0, 0);
  document.getElementById("share-link")!.textContent = shareUrl;
  document.getElementById("share-note")!.textContent = sealed
    ? "The link carries the seed AND the sealed run, so whoever opens it gets this exact dungeon with your ghost already on the course."
    : submitResult?.state === "rejected"
      ? "The link carries the seed only. The System refused to certify this run, so it is not handed out as a ghost — a refused proof is not a rival."
      : submitVisibility === "private"
        ? "The link carries the seed only. This run is private: it ranks, and it is never distributed."
        : "The link carries the seed only. A ghost needs a run the server has re-executed, and this one is not sealed.";
  shareEl.classList.add("on");
}

document.getElementById("recap-share")!.addEventListener("click", openShareSheet);
document.getElementById("share-close")!.addEventListener("click", () => shareEl.classList.remove("on"));
document.getElementById("share-save")!.addEventListener("click", saveRunCard);
document.getElementById("share-copy")!.addEventListener("click", async () => {
  const btn = document.getElementById("share-copy")!;
  const label = btn.textContent;
  btn.textContent = (await copyText(shareUrl)) ? "CHALLENGE COPIED" : "COPY FAILED";
  setTimeout(() => { btn.textContent = label; }, 1600);
});

// ===================== THE COMPETITIVE SURFACE =====================
// COMPETITIVE.md 4, 5, 6 Beat 5, and 8. Everything below is host-side: the
// sim owns the codec, the server owns the verdict, and this file owns the
// screens plus the one honest sentence each state deserves.

const CONSENT_KEY = "dcc:consent:v1";
const consentEl = document.getElementById("consent")!;

/** The account id the boards key on. An existing token wins - it is the one a
 *  Discord identity is linked to, and submitting under a fresh id would quietly
 *  strand a signed-in crawler outside their own career. A browser that has
 *  never had one asks the SERVER to mint it (2.7.2), because a token the
 *  client invents is not a rate-limiting subject. */
async function accountToken(): Promise<string> {
  const existing = loadToken();
  if (existing) return existing;
  try {
    const minted = await competitive.anonToken();
    storeToken(minted);
    return minted;
  } catch {
    return ensureToken(); // offline: a local id still runs the local career
  }
}

/** Offer the proof. Once per browser this is a disclosure card with three
 *  buttons; after that it honours the standing choice. Defaulting to public is
 *  fine - defaulting SILENTLY to public is not. */
function offerProof(): void {
  if (!runProof || net) return;
  let choice: string | null = null;
  try { choice = localStorage.getItem(CONSENT_KEY); } catch { /* private mode */ }
  if (choice === "public" || choice === "private") {
    submitVisibility = choice;
    void submitProof(choice);
    return;
  }
  if (choice === "no") return;
  consentEl.classList.add("on");
  recapEl.classList.add("consenting"); // the verdict lifts clear of the card
  // ...by the card's MEASURED height. A hardcoded 236px was smaller than the
  // card actually is, so on the one run per browser where this appears the
  // verdict's top border went above y=0 and the grade medal was clipped by the
  // viewport edge - during the exact ten seconds this screen exists for.
  requestAnimationFrame(() => {
    const h = Math.ceil(consentEl.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty("--consent-h", h + "px");
  });
}

for (const [id, choice] of [
  ["consent-public", "public"], ["consent-private", "private"], ["consent-no", "no"],
] as const) {
  document.getElementById(id)!.addEventListener("click", () => {
    try { localStorage.setItem(CONSENT_KEY, choice); } catch { /* best-effort */ }
    consentEl.classList.remove("on");
    recapEl.classList.remove("consenting");
    renderConsentToggle(); // the settings row is the same standing choice
    if (choice === "no") {
      recBlocked = "not submitted — your choice, and it stays your choice until you change it";
      renderEarned(state);
      return;
    }
    submitVisibility = choice;
    void submitProof(choice);
  });
}

/**
 * THE CHOICE IS REVERSIBLE, AND THERE IS A PLACE TO REVERSE IT (8.1:
 * "toggleable afterwards from your own profile").
 *
 * `dcc:consent:v1` was written once at the disclosure card and never read
 * anywhere except offerProof - no settings row, no menu entry, no way back -
 * and `competitiveClient.setPrivate()` shipped with zero callers, so the
 * per-run private flag had no surface at all. This row is both: it cycles the
 * standing choice, and flipping PUBLIC/PRIVATE also retargets the run
 * currently on the verdict screen, which is the run the player is looking at
 * when they change their mind.
 */
const CONSENT_CYCLE = ["public", "private", "no"] as const;
const CONSENT_LABEL: Record<string, string> = {
  public: "PUBLIC", private: "PRIVATE — RANKS, NEVER SHARED", no: "DO NOT SUBMIT",
};
const kbConsent = document.getElementById("kb-consent")!;
function renderConsentToggle(): void {
  let choice: string | null = null;
  try { choice = localStorage.getItem(CONSENT_KEY); } catch { /* private mode */ }
  kbConsent.textContent = choice ? CONSENT_LABEL[choice] ?? "PUBLIC" : "NOT YET ASKED";
}
kbConsent.addEventListener("click", () => {
  let choice: string | null = null;
  try { choice = localStorage.getItem(CONSENT_KEY); } catch { /* private mode */ }
  const next = CONSENT_CYCLE[(CONSENT_CYCLE.indexOf(choice as "public") + 1) % CONSENT_CYCLE.length];
  try { localStorage.setItem(CONSENT_KEY, next); } catch { /* best-effort */ }
  renderConsentToggle();
  // Retarget the run on screen, if there is one and the server still has it.
  if (next !== "no" && submitResult?.runId && next !== submitVisibility) {
    submitVisibility = next;
    void (async () => {
      try {
        await competitive.setPrivate(submitResult!.runId!, await accountToken(), next === "private");
        pushLogLine(next === "private"
          ? "THIS RUN IS NOW PRIVATE. It still ranks. Nobody else gets the film."
          : "THIS RUN IS NOW PUBLIC. Anyone can race your ghost.");
        renderSeal();
      } catch { /* the standing choice still changed */ }
    })();
  }
});
renderConsentToggle();

/**
 * Submit, then WATCH THE SEAL LAND. The seconds between VERIFYING and a gold
 * seal are the moment the trust model stops being a paragraph in a design
 * document and becomes something the player can feel.
 */
async function submitProof(visibility: "public" | "private"): Promise<void> {
  const proof = runProof;
  if (!proof) return;
  try {
    const token = await accountToken();
    const res = await competitive.submitRun(proof, token, crawlerName(), visibility);
    submitResult = {
      state: res.state, runId: res.runId, reason: res.reason,
      attemptNo: res.attemptNo, scoresCp: res.scoresCp,
      needsIdentity: res.needsIdentity,
    };
    renderEarned(state);
    if (!res.queued) return;
    // Poll the row until the verdict lands: a handful of small GETs against a
    // box that already knows the answer within a few seconds.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 900));
      const row = (await competitive.run(res.runId, token)) as social.BoardRun & { boards?: string[] };
      if (row.state !== "verifying" && row.state !== "claimed") {
        submitResult = {
          state: row.state, runId: res.runId, reason: row.reason ?? undefined,
          boards: row.boards ?? [],
        };
        if (row.state === "verified") {
          // CP and the board position only exist AFTER certification, so the
          // ladder line is re-read here rather than guessed at run end.
          await Promise.all([loadStanding(), loadTodaysBoard()]);
          pushLogLine("THE SYSTEM RE-RAN YOUR CRAWL. It agrees with you. Sealed.");
        }
        // A REFUSED RUN UN-BANKS WHAT IT PROVISIONALLY BANKED. The band PBs are
        // committed to the local ledger at the status edge, minutes before the
        // verdict arrives; leaving them there would let a run the server would
        // not certify hold a record in the panel that reads "sealed traversals
        // only". The ledger goes back to exactly where this run found it.
        if (row.state === "rejected") {
          storeBandBests(recapPrevBests);
          recapBandPbs = [];
          pushLogLine("THE SYSTEM DISAGREES. The row is gone and the ledger is back where it was.");
        }
        renderLadderLine(state);
        renderMark(state);
        renderEarned(state);
        return;
      }
      if (row.state !== submitResult.state) {
        submitResult = { ...submitResult, state: row.state };
        renderEarned(state);
      }
    }
  } catch (err) {
    submitResult = { state: "claimed", reason: `the board is unreachable (${(err as Error).message})` };
    renderEarned(state);
  }
}

// ---- GHOSTS (4.1) ---------------------------------------------------------
// A stored proof plus the same seed is a rival playing beside you, live and
// offline. It never runs on the main thread: the worker replays at 150-250x
// realtime and streams back a keyframe track, so the frame cost is an array
// index and a lerp. This project has no spare 4% of a frame for a second sim.
let ghost: social.GhostState | null = null;
let ghostNote = "";

/** Load a proof through the era gate and precompute its track. */
async function armGhost(
  bytes: Uint8Array, label: string, runId?: string,
  // WHAT THE GHOST DID, from whatever armed it (blocker 14). The track knows
  // where they were; only the caller knows what they scored.
  facts?: social.GhostState["facts"],
): Promise<boolean> {
  const reply = await precomputeGhost({ bytes, ghostHz: 10, eras: [RULES_HASH] });
  if (!reply.ok) {
    // NEVER step a foreign proof into the current sim to see what happens: it
    // does not throw, it quietly renders a wrong ghost with a wrong delta, and
    // the player has no way to detect it.

    ghost = null;
    ghostNote = reply.reason;
    // Stated, not silently disabled. A ghost that quietly fails to appear is
    // how a player concludes the feature is broken; a named era is how they
    // conclude the game is honest.
    pushLogLine(`GHOST REFUSED — ${reply.reason}`);
    showAnnouncement({
      text: `NO GHOST. ${reply.reason}`,
      kind: "flavor", priority: "high",
    });
    return false;
  }
  ghost = {
    label: label || reply.label, track: reply.track,
    floorEntryTicks: reply.floorEntryTicks, ticks: reply.ticks, runId, facts,
  };
  ghostNote = "";
  return true;
}

/** RUN IT BACK: the same seed, with the run you just played as your ghost.
 *  The strongest urge a roguelike death produces is "I know this dungeon now",
 *  and this is the only button on the screen that answers it. */
async function runItBack(): Promise<void> {
  const seed = state.seed;
  const proof = runProof;
  recapEl.style.display = "none";
  recapEl.classList.remove("tabbed");
  consentEl.classList.remove("on"); // the offer does not outlive the screen
  recapEl.classList.remove("consenting");
  shareEl.classList.remove("on");
  if (invOpen) toggleInventory();
  if (abilOpen) toggleAbilities();
  document.getElementById("saferoom")!.style.display = "none";
  document.getElementById("draft")!.style.display = "none";
  ghost = null;
  if (proof) {
    const { encodeProof } = await import("./sim/replay");
    // The run you are about to race is the one this browser just filed, so the
    // scoreboard's ghost column is a full column rather than two numbers.
    const last = loadHistory()[0] ?? null;
    await armGhost(encodeProof(proof), "YOUR LAST RUN", undefined, last ? {
      won: last.won, floor: last.floor, kills: last.kills, level: last.level,
      damageDealt: last.damageDealt, damageTaken: last.damageTaken, goldSpent: null,
    } : undefined);
  }
  forcedSeed = seed;
  // A RERUN OF TODAY'S CONTRACT IS ANOTHER ATTEMPT ON IT, and an attempt the
  // server did not observe is exactly the hole tickets exist to close. So R on
  // a daily signs again (attempt 2, 3, ...) instead of quietly dropping off the
  // contract onto the same seed.
  if (runMode.kind === "daily" && runMode.day === dayFromMs(Date.now()) && !net && !testMode) {
    const armed = ghost;
    await enterDailyContract(runMode.day);
    ghost = armed; // the sign-in must not throw away the ghost we just built
  } else {
    startRun(runMode, currentRunKind);
  }
  if (ghost) {
    showAnnouncement({
      text: "SAME DUNGEON. Your own ghost is on the course with you. Beat yourself.",
      kind: "flavor", priority: "high",
    });
  }
}

/** RACE THE LEADER: today's number one as your ghost, on today's seed. */
async function raceTheLeader(): Promise<void> {
  const era = RULES_HASH.slice(0, 7);
  const leader = (todaysBoard ?? []).find((r) => social.playability(r, era).ok);
  if (!leader) return;
  await raceRun(leader.id, leader.name, leader);
}

/** Download a sealed run and start the same seed beside it. */
async function raceRun(runId: string, label: string, row?: social.BoardRun): Promise<void> {
  const token = await accountToken();
  const got = await competitive.proof(runId, token);
  if (!got.bytes || !got.playable) {

    ghostNote = got.reason ?? "no proof retained for that row";
    pushLogLine(`GHOST REFUSED — ${ghostNote}`);
    showAnnouncement({ text: `NO GHOST. ${ghostNote}`, kind: "flavor", priority: "high" });
    return;
  }
  // The verifier derived damage, gold and level as it replayed and wrote them
  // onto the row, so racing a sealed run fills every cell of the ghost column.
  const facts = row ? {
    won: row.won, floor: row.floor, kills: row.kills, level: row.level,
    damageDealt: row.damageDealt || null, damageTaken: row.damageTaken || null,
    goldSpent: row.goldSpent || null,
  } : undefined;
  if (!(await armGhost(got.bytes, label, runId, facts))) return;
  closeSets();
  recapEl.style.display = "none";
  forcedSeed = null;
  startRun({ kind: "daily", day: dayFromMs(Date.now()) }, "race");
  showAnnouncement({
    text: `RACING ${label.toUpperCase()}. Same dungeon, same seed. The split is live in the corner.`,
    kind: "flavor", priority: "high",
  });
}

// The rail chip. The ghost collapses to a split delta whenever it is not on
// your floor, because a rival two floors down is information, not a marker.
const ghostEl = document.getElementById("ghost")!;
function updateGhostHud(s: GameState): void {
  if (!ghost || s.status !== "playing" || net) { ghostEl.classList.remove("on"); return; }
  ghostEl.classList.add("on");
  const at = social.ghostAt(ghost, runTicks);
  const theirFloor = at?.floor ?? ghost.track.floor[ghost.track.floor.length - 1] ?? 1;
  // THE CHIP IS TITLED BY WHO YOU ARE RACING. "YOUR LAST RUN" is only true for
  // one of the three ghost sources; a rival's name is the whole reason the
  // number on this chip matters.
  document.getElementById("ghost-name")!.textContent = ghost.label;
  document.getElementById("ghost-where")!.textContent = at ? `· FLOOR ${theirFloor}` : "· RUN OVER";

  // THE LIVE SPLIT. A speedrun clock, not a post-hoc comparison: while you are
  // still on this floor the number counts UP toward the tick the ghost left it,
  // green until you pass their exit and red the instant you do. The entry
  // delta is the fallback for the floors they never reached.
  //
  // AND IT STAYS DARK UNTIL THERE IS A SPLIT TO SHOW. On floor 1, before
  // either of you has left it, there is no prior split on either side - the old
  // chip printed an unsigned, uncoloured "0.0s" with the caption "you took time
  // entering floor 1", which is both meaningless and untrue. Until the first
  // transition the chip shows the TARGET instead: the tick your rival leaves
  // this floor. That is the number you are actually racing.
  const theirExit = ghost.floorEntryTicks[s.floor] ?? -1; // they entered floor+1 here
  const myEntry = floorEntryTicks[s.floor - 1] ?? -1;
  const entryDelta = s.floor > 1 ? social.splitDelta(ghost, s.floor, myEntry) : null;
  const live = theirExit >= 0 ? (runTicks - theirExit) / 60 : null;
  // THE MODAL CASE HAD NO NUMBER AT ALL. RUN IT BACK races your last run, and
  // the most common last run died on floor 1 - precisely when the urge to
  // re-run is strongest. `floorEntryTicks[1]` is then -1, so the chip showed
  // "NO SPLIT YET / YOUR LAST RUN has not left floor 1" in grey with eighteen
  // empty pips, for the entire race. A rival who DIED on this floor is not a
  // missing split: their run END is the target, and outliving it is the race.
  const theyEndedHere = theirExit < 0 && theirFloor <= s.floor && ghost.ticks > 0;
  const endRace = theyEndedHere ? (runTicks - ghost.ticks) / 60 : null;
  const delta = live ?? endRace ?? entryDelta;
  const dEl = document.getElementById("ghost-delta")!;
  const sub = document.getElementById("ghost-sub")!;
  ghostEl.classList.toggle("racing", delta !== null);
  if (delta === null) {
    dEl.className = "gdelta pending";
    if (theirFloor < s.floor) {
      dEl.textContent = "PAST THEIR DEPTH";
      sub.textContent = `they never got below floor ${theirFloor}`;
    } else {
      dEl.textContent = "NO SPLIT YET";
      sub.textContent = `${ghost.label} has not left floor ${s.floor}`;
    }
  } else if (endRace !== null) {
    // Signed against their whole run: negative until you outlive them.
    dEl.className = `gdelta ${endRace > 0 ? "ahead" : "behind"}`;
    dEl.textContent = social.signedTime(endRace);
    sub.textContent = endRace > 0
      ? `you have outlived ${ghost.label.toUpperCase()} — they ended here at ${social.mmss(ghost.ticks / 60)}`
      : `${ghost.label.toUpperCase()} ended on this floor at ${social.mmss(ghost.ticks / 60)}. Get past it.`;
  } else {
    // Signed AND coloured, both directions. Red is losing time, green is taking
    // it: a split delta that does not commit to a sign and a colour is a
    // decoration, not a race.
    dEl.className = `gdelta ${delta > 0 ? "behind" : "ahead"}`;
    dEl.textContent = social.signedTime(delta);
    const who = ghost.label.toUpperCase();
    sub.textContent = live !== null
      ? (live > 0
        ? `past ${who}'s floor ${s.floor} exit`
        : `${who} leaves floor ${s.floor} at ${social.mmss(theirExit / 60)}`)
      : delta > 0
        ? `you entered floor ${s.floor} behind ${who}`
        : `you entered floor ${s.floor} ahead of ${who}`;
  }
  // One pip per floor: green where you took time, red where you gave it back.
  let pips = "";
  for (let f = 1; f <= CONFIG.finalFloor; f++) {
    const d = social.splitDelta(ghost, f, floorEntryTicks[f - 1] ?? -1);
    const cls = d === null ? "" : d > 0 ? "behind" : "ahead";
    pips += `<i class="${cls}${f === s.floor ? " now" : ""}"></i>`;
  }
  document.getElementById("ghost-splits")!.innerHTML = pips;
}

/**
 * THE GHOST IS A BODY, NOT A LIGHTING ARTIFACT (4.1: "a race you cannot see is
 * a number"). The mesh renders at 45% opacity, desaturated cold, with no
 * shadow and no contribution to lighting - which is correct for a rival you
 * cannot hit and hopeless as an IDENTIFICATION. In capture it was genuinely
 * hard to tell from a torch flicker, and the only other cue in the world was a
 * 3.4px dashed ring on the minimap. One projected nameplate, on the same
 * worldToScreen the mob plates already use, is the whole fix.
 */
const ghostPlateLayer = document.createElement("div");
ghostPlateLayer.id = "ghostplate";
ghostPlateLayer.innerHTML = `<div class="gp"></div>`;
document.body.appendChild(ghostPlateLayer);
const ghostPlateEl = ghostPlateLayer.firstElementChild as HTMLElement;
function updateGhostPlate(s: GameState): void {
  const at = ghost && s.status === "playing" && !net ? social.ghostAt(ghost, runTicks) : null;
  if (!at || !ghost || at.floor !== s.floor) { ghostPlateLayer.classList.remove("on"); return; }
  const sp = renderer.worldToScreen(at.x, 2.05, at.y);
  if (!sp.visible) { ghostPlateLayer.classList.remove("on"); return; }
  ghostPlateLayer.classList.add("on");
  ghostPlateEl.style.left = `${sp.x}px`;
  ghostPlateEl.style.top = `${sp.y}px`;
  if (ghostPlateEl.textContent !== ghost.label) ghostPlateEl.textContent = ghost.label;
}

// ---- THE STANDINGS (3) ----------------------------------------------------
const ladderEl = document.getElementById("ladder")!;
const careerEl = document.getElementById("career")!;
let ladderTab: "contracts" | "alltime" | "bands" | "rivals" = "contracts";
let alltimeTab = "deepest";

/** The bearer token. It goes UP the wire, in a query string, and it never
 *  comes back down: the server projects a derived public id instead, because
 *  this string is the credential POST /runs authenticates on. */
let myAccount = "";
/** ...and the public name that same account wears on a board row, which is
 *  the only thing the YOU tag ever needed. */
let myPublicId = "";
/** Crawlers the System has pointed you at, plus anyone you follow, BY PUBLIC
 *  ID. They light up on every board, because a ladder is only contested if you
 *  can find the person you are contesting it WITH. */
const rivalAccounts = new Set<string>();
let events: social.EventsView | null = null;
const ERA = RULES_HASH.slice(0, 7);

function closeSets(): void {
  ladderEl.classList.remove("on");
  careerEl.classList.remove("on");
}

/**
 * THE NO-SCROLLBAR RULE NEEDS AN AFFORDANCE IN ITS PLACE.
 *
 * `#ladder, #career { overflow: auto; scrollbar-width: none }` is the right
 * house rule - a gilt document does not get a grey elevator down its side -
 * but it shipped with nothing standing in for the bar it removed. At 1600x900
 * the BANDS tab cut THE IRONWORKS and THE APPROACH mid-row and the career
 * panel cut MILESTONES mid-entry, with no gradient, no chevron and no hint
 * that anything was below: two of the four competitive screens read as
 * TRUNCATED rather than scrollable on a standard desktop viewport.
 */
function wireScrollHint(panel: HTMLElement, hint: HTMLElement): void {
  const sync = (): void => {
    const more = panel.scrollHeight - panel.scrollTop - panel.clientHeight > 24;
    hint.classList.toggle("on", more && panel.classList.contains("on"));
  };
  panel.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  // Content arrives asynchronously (a board fetch, a profile fetch), so the
  // hint cannot be decided once at open time.
  new MutationObserver(sync).observe(panel, { childList: true, subtree: true, attributes: true });
  sync();
}
wireScrollHint(ladderEl, document.getElementById("ladder-more")!);
wireScrollHint(careerEl, document.getElementById("career-more")!);

/** Result column per board - each board brags differently. */

function boardResult(kind: string, r: social.BoardRun): string {
  // EXACT CLOCKS WHERE THE ORDER DEPENDS ON THEM. Splits and clear times are
  // stored as tick counts; printing them to the whole second throws that
  // precision away at the exact moment it decides a rank, and four crawlers
  // printing "1:45" at the top of a band board makes the order look arbitrary
  // because to the reader it is. Centiseconds cost nothing - the data was
  // always this precise.
  if (kind === "band") return r.bandTicks ? social.ticksClock(r.bandTicks) : "—";
  if (kind === "kills") return social.count(r.kills, "kill");
  if (kind === "fastest" || kind === "contracts") {
    return r.won ? `CLEAR · ${social.ticksClock(r.ticks)}` : `floor ${r.floor}`;
  }
  // ...INCLUDING THE UNFINISHED RUNS. `fmt(r.timeSec)` rounded the tick count to
  // the whole second, so the DEEPEST row read "2:06" beside a splits panel
  // reading 2:05.73 for the same run, on the same screen.
  return r.won ? `CLEAR · ${social.ticksClock(r.ticks)}` : `floor ${r.floor} · ${social.ticksClock(r.ticks)}`;
}

/** The key for the row colours, plus whatever tiebreak this board sorts on.
 *  A competitive board that colour-codes rows without a legend teaches players
 *  to guess, and one that will not say how it broke a tie is asking them to
 *  assume it did not. */
function rowKeyHtml(tiebreak = ""): string {
  return `<div class="rowkey"><i class="kyou">YOU</i><i class="kriv">YOUR RIVAL</i>` +
    (tiebreak ? `<i class="ktie">ties broken by ${esc(tiebreak)}</i>` : "") + `</div>`;
}

/**
 * One board row. It carries the seal AND the era, and when a run is not
 * raceable it says WHY on the button instead of greying out - a silent disable
 * is how a player concludes the ladder is broken.
 */
/**
 * THE VERIFIER-DERIVED DETAIL, RENDERED (COMPETITIVE.md 0: "match history where
 * every row carries verifier-derived detail — splits, build, cause of death").
 *
 * `GET /boards/:kind` already returns, per row: the full build (gear with
 * rarities, ability ranks, glyph sockets), bandSplits, damageDealt,
 * damageTaken, goldSpent, level and ultimate. All of it was derived during the
 * replay, written onto the row at certification, put on the wire — and thrown
 * away at render, so a board row printed name / era / attempt / chip / result.
 * None of this costs a request; it is already in the response object.
 */
function verifierDetailHtml(r: social.BoardRun): string {
  if (r.state !== "verified") return "";
  const cells: string[] = [];
  const splits = (r.bandSplits ?? []).map((t, i) => t > 0
    ? `<i><b>${esc(social.bandName(i))}</b>${social.ticksClock(t)}</i>` : "").join("");
  if (splits) cells.push(`<div class="dgrp"><span class="dlab">SPLITS</span><div class="dsplits">${splits}</div></div>`);
  const b = r.build;
  if (b) {
    const ranks = Object.values(b.ranks ?? {}).reduce((a, n) => a + (n || 0), 0);
    const glyphs = b.glyphs
      ? b.glyphs.slots.flat().filter(Boolean).length + b.glyphs.ultimate.filter(Boolean).length : 0;
    const gear = (b.gear ?? []).map((g) =>
      `<i class="rar-${esc(String(g.rarity))}">${esc(String(g.name ?? g.slot))}</i>`).join("");
    const kit = [
      b.ultimate ? `${ABILITY_INFO[b.ultimate as AbilityId]?.name ?? b.ultimate} · ULT` : null,
      ...(b.slots ?? []).filter(Boolean).map((s) => ABILITY_INFO[s as AbilityId]?.name ?? String(s)),
    ].filter(Boolean).join(" · ");
    cells.push(`<div class="dgrp"><span class="dlab">THE BUILD</span>` +
      `<div class="dbuild">${esc(kit || "bare hands")}` +
      `<span class="dmeta">${ranks} rank${ranks === 1 ? "" : "s"}` +
      (glyphs ? ` · ${glyphs} glyph${glyphs === 1 ? "" : "s"} socketed` : "") + `</span>` +
      (gear ? `<div class="dgear">${gear}</div>` : "") + `</div></div>`);
  }
  const death = r.death;
  if (death) {
    cells.push(`<div class="dgrp"><span class="dlab">WHAT ENDED IT</span>` +
      `<div class="ddeath">${esc(social.deathHeadline(death))}</div></div>`);
  } else if (r.won) {
    cells.push(`<div class="dgrp"><span class="dlab">WHAT ENDED IT</span>` +
      `<div class="ddeath clear">nothing — they walked out</div></div>`);
  }
  const nums: [string, string][] = [
    ["DAMAGE DEALT", r.damageDealt > 0 ? Math.round(r.damageDealt).toLocaleString() : "—"],
    ["DAMAGE TAKEN", r.damageTaken > 0 ? Math.round(r.damageTaken).toLocaleString() : "—"],
    ["GOLD SPENT", r.goldSpent > 0 ? Math.round(r.goldSpent).toLocaleString() : "—"],
    ["LEVEL", String(r.level)],
  ];
  cells.push(`<div class="dgrp"><span class="dlab">THE NUMBERS</span><div class="dnums">` +
    nums.map(([l, v]) => `<i><b>${l}</b>${esc(v)}</i>`).join("") + `</div></div>`);
  return `<div class="rdet" hidden>${cells.join("")}` +
    `<div class="dfoot">Every figure here was derived by the verifier while it re-executed this run. ` +
    `The crawler asserted none of it.</div></div>`;
}

function boardRowHtml(
  r: social.BoardRun, i: number, kind: string, extra = "",
  weight: social.SealWeight = "ranked",
): string {
  // HOW THIS ROW GOT ITS SEAL (blocker 11). A server-vouched RIVALS contract is
  // `verified` with no film, and the chip used to promise a re-execution that
  // never happened for it.
  const chip = social.sealChip(r.state, r.rulesEra, r.private, weight, social.provenanceOf(r));
  const play = social.playability(r, ERA);

  const mine = !!r.publicId && r.publicId === myPublicId;
  const rival = !mine && !!r.publicId && rivalAccounts.has(r.publicId);
  const sub = [
    // "unstamped" reads as a missing field. Nothing is missing: an unproven
    // row has no era because it was never certified, and saying that is the
    // whole point of the chip beside it.
    r.rulesEra ? `era ${r.rulesEra}` : "no era — never certified",
    // WHICH GAME, NOT JUST WHICH NUMBERS (blocker 11). `mode` and `runKind`
    // have been on the wire since the roam gate shipped and nothing rendered
    // either, so a ruleset with no permadeath was indistinguishable on the
    // board from the descent every other row is. Null for the plain descent.
    social.rulesetLabel(r),
    // "SIGNED attempt N", not "attempt N". The number comes off the event
    // ticket, so it counts the attempts the server was asked to OBSERVE - it
    // is not, and cannot be, a count of how many times this dungeon was
    // played. The ticket is stamped and single-use now, so the number means
    // something; it still is not an observed total, and the word says which.
    r.attemptNo ? `signed attempt ${r.attemptNo}` : null,
    r.ultimate ? ABILITY_INFO[r.ultimate as AbilityId]?.name ?? r.ultimate : null,
    // "party of N" IS SERVER-COUNTED NOW, never self-reported (blocker 15): a
    // proof attests to one crawler's inputs, so a proof-verified row is always
    // solo and only the server-vouched rivals path can say otherwise.
    r.partySize > 1 ? `party of ${r.partySize} · counted by the server` : null,
    extra || null,
  ].filter(Boolean).join(" · ");
  const detail = verifierDetailHtml(r);
  const acts = (detail
    ? `<button class="rmore" data-more="1" title="splits, build and cause of death, all derived by the verifier">DETAIL</button>`
    : "")
    + (play.ok
      ? `<button data-race="${esc(r.id)}" data-label="${esc(r.name)}">RACE</button>`
      : `<button disabled title="${esc(play.why)}">RACE</button>`);

  // The colour is backed up by a word: a legend under the tab bar answers it
  // once, and the tag answers it on the row itself.
  const tag = mine ? `<span class="rtag you">YOU</span>`
    : rival ? `<span class="rtag rival">RIVAL</span>` : "";
  // A DISCRIMINATOR, BECAUSE TWO CRAWLERS SHARE A NAME ON A FOUR-ROW BOARD.
  // Keying moved to account_id; the DISPLAY did not, so a live capture had rank
  // 2 "Carl" (a different account, SEALED) directly above an unproven "Carl"
  // wearing the YOU chip, with nothing between them. The derived public id is
  // already on every row and is exactly the stable, one-way, non-credential
  // handle this needs.
  const hash = r.publicId ? `<span class="rhash">#${esc(r.publicId.slice(0, 4).toUpperCase())}</span>` : "";
  // A NEGATIVE INDEX MEANS "THIS ROW HOLDS NO POSITION". Unproven claims are
  // shown - the board still fills on day one - but they are never handed a
  // rank ordinal, because an ordinal IS the claim that the board endorses it.
  const ranked = i >= 0;
  return `<li class="brow${mine ? " you" : ""}${rival ? " rival" : ""}` +
    `${ranked && i < 3 ? ` top${i + 1}` : ""}">` +
    `<span class="rank">${ranked ? i + 1 : "—"}</span>` +
    `<span class="who"><b>${esc(r.name)}${hash}${tag}</b><span class="sub">${esc(sub)}</span></span>` +
    `<span class="${chip.cls}" title="${esc(chip.title)}">${chip.label}</span>` +
    `<span class="res${r.won ? " win" : ""}">${boardResult(kind, r)}</span>` +
    `<span class="acts">${acts}</span>${detail}</li>`;
}

/**
 * THE RANKED LIST, AND THE UNPROVEN SHELF UNDER IT (COMPETITIVE.md 3.2B:
 * "Verified-only for the top 10; `claimed` rows may appear below with a
 * visible marker").
 *
 * Neither half was implemented. `GET /boards/:kind` sorts `claimed` rows into
 * the ranked ordering beside verified ones, and this renderer gave them the
 * identical rank ordinal, the identical green `.res.win` CLEAR treatment and
 * the identical row chrome - only a 10.5px chip differed. Live, an unverified
 * CLAIMED run held rank 6 all-time under five sealed 13-15 minute clears and
 * printed "CLEAR · 0:09.81" in green, so a reader scanning THE STANDINGS saw
 * six clears. That is the exact failure the whole document exists to prevent,
 * living in the presentation layer instead of the spine.
 *
 * The rank ordering is now verified-only, end to end. Claims are not deleted -
 * they are moved below the board, stripped of their ordinal and their result
 * colour, under a heading that says what they are.
 */
function boardListHtml(
  page: { entries: readonly social.BoardRun[]; unproven?: readonly social.BoardRun[] },
  kind: string, empty: string,
  extraFor?: (r: social.BoardRun) => string,
): string {
  // THE SPLIT NOW ARRIVES ALREADY MADE. `GET /boards/:kind` returns proofs in
  // `entries` and claims in `unproven`, so this renderer no longer has to be
  // the only thing in the product that knows the difference - it just has to
  // draw it. The filters stay as a belt for an older server or a band board
  // that still answers with one mixed array.
  const sealed = (page.unproven ? page.entries : page.entries.filter((r) => r.state === "verified"))
    .filter((r) => r.state === "verified");
  const unproven = page.unproven ?? page.entries.filter((r) => r.state !== "verified");
  const extra = (r: social.BoardRun): string => extraFor?.(r) ?? "";
  let html = `<ul class="board">${
    sealed.map((r, i) => boardRowHtml(r, i, kind, extra(r))).join("")
    || `<li class="none">${empty}</li>`}</ul>`;
  if (unproven.length > 0) {
    // ONE LINE, NOT TWO SENTENCES OF RATIONALE. League never explains itself on
    // a ranked surface; the copy was good and there was three times too much
    // of it, loudest exactly where the board was emptiest.
    // ...AND IT NAMES BOTH POPULATIONS (blocker 11). `unverifiable` rows are on
    // this shelf now - 2.6d promises the row "keeps whatever it earned" and the
    // verdict screen says so in as many words, while the board predicate used
    // to drop them off every surface in the product. A row the System could not
    // run is not a row a client made up, and one heading cannot call them the
    // same thing.
    const aged = unproven.filter((r) => r.state === "unverifiable").length;
    html += `<div class="unproven">` +
      `<div class="uhead">BELOW THE BOARD — NO RANK, NO RESULT</div>` +
      `<div class="usub">Never re-executed${aged > 0
        ? `, or recorded under rules this build can no longer run (${aged}). Kept, not ranked.`
        : ". No rank, no result."}</div>` +
      `<ul class="board">${unproven.map(
        (r, i) => boardRowHtml(r, -1 - i, kind, extra(r), "plain")).join("")}</ul></div>`;
  }
  return html;
}

function contractCardHtml(e: social.EventView, kind: "daily" | "weekly"): string {

  const label = kind === "daily" ? "TODAY'S CONTRACT" : "THE WEEKLY CONTRACT";
  const blurb = kind === "daily"
    ? "One dungeon. Every crawler. Unlimited attempts — but the ladder scores your FIRST."
    : "A harder fixed seed, open all week. The Clash analogue, minus the five friends free at 8pm.";
  return `<div class="contract${kind === "weekly" ? " weekly" : ""}">` +
    `<div class="ctag">◆ ${kind === "daily" ? "DAILY" : "WEEKLY"} · SEASON ${esc(events?.season ?? "")} ◆</div>` +
    `<h3>${label}</h3>` +
    `<div class="cmeta">seed <b>${e.seed}</b> · <b>${e.entrants}</b> entrant${e.entrants === 1 ? "" : "s"}` +
    ` · closes in <b>${social.untilText(e.closesAt)}</b></div>` +
    `<div class="crule">${blurb}</div>` +
    (e.frozen
      ? `<div class="cfrozen">PATCH DAY. This contract is closed early. The lawyers apologize.</div>` +
        `<button class="cgo" disabled>CLOSED</button>`
      : `<button class="cgo" data-enter="${esc(e.id)}">ENTER THE CONTRACT ▶</button>`) +
    `</div>`;
}

/**
 * THE OTHER MUSEUMS, ONE LINE EACH. The ALL-TIME tab drew one board and then
 * stopped, leaving 42% of a 1600x900 viewport as empty black - on a screen with
 * four boards behind a tab strip and no indication of what was on the other
 * three. Each line is the current leader of a board you are not looking at,
 * which is both the missing content and the reason to look.
 */
async function otherBoardsStripHtml(current: string): Promise<string> {
  const kinds = ["deepest", "fastest", "kills", "contracts"].filter((k) => k !== current);
  const pages = await Promise.all(kinds.map((k) =>
    competitive.board(k, { limit: 1, verified: true }).catch(() => ({ entries: [] }))));
  const rows = kinds.map((k, i) => {
    const top = ((pages[i] as social.BoardPage).entries ?? [])[0] ?? null;
    return `<button class="obrow" data-ab="${esc(k)}">` +
      `<span class="obk">${k.toUpperCase()}</span>` +
      (top
        ? `<span class="obwho">${esc(top.name)}</span>` +
          `<span class="obres">${esc(boardResult(k, top))}</span>`
        : `<span class="obwho none">unclaimed</span><span class="obres none">—</span>`) +
      `<span class="obgo">OPEN ▸</span></button>`;
  }).join("");
  return `<div class="rsec" style="margin-top:20px;color:var(--gold);font-family:var(--display);` +
    `font-variant:small-caps;letter-spacing:2px">THE OTHER MUSEUMS</div>` +
    `<div class="otherboards">${rows}</div>`;
}

async function renderLadder(): Promise<void> {
  const body = document.getElementById("ladder-body")!;
  document.getElementById("ladder-sub")!.textContent =
    `rules era ${ERA} — every ranked row is a proof the server re-executed, not a number it was told`;
  body.innerHTML = `<ul class="board"><li class="none">the network is counting…</li></ul>`;
  try {
    if (!events) events = (await competitive.events()) as social.EventsView;
  } catch {
    body.innerHTML = `<ul class="board"><li class="none">the board is offline — the server keeps the ` +
      `score, and it will still be there when the signal is back</li></ul>`;
    return;
  }
  if (ladderTab === "contracts") {
    const page = (await competitive.board("deepest", { event: "daily", limit: 25 })
      .catch(() => ({ entries: [] }))) as social.BoardPage;
    body.innerHTML =
      `<div class="contracts">${contractCardHtml(events.daily, "daily")}` +
      `${contractCardHtml(events.weekly, "weekly")}</div>` +
      `<div class="rsec" style="margin-top:18px;color:var(--gold);letter-spacing:2px;` +

      `font-family:var(--display);font-variant:small-caps">TODAY'S STANDINGS — ${esc(events.daily.day)}</div>` +
      rowKeyHtml("depth, then the faster run, then the earlier submission") +
      boardListHtml(
        { entries: page.entries.slice(0, 12), unproven: page.unproven?.slice(0, 12) }, "deepest",
        "nobody has signed today's contract yet. Be the name at the top.");
    return;
  }
  if (ladderTab === "alltime") {
    const page = (await competitive.board(alltimeTab, { limit: 25 })
      .catch(() => ({ entries: [] }))) as social.BoardPage;
    body.innerHTML =
      `<div class="settabs" style="justify-content:flex-start;gap:18px;border:0;margin-bottom:8px">` +
      ["deepest", "fastest", "kills", "contracts"].map((k) =>
        `<button class="settab${k === alltimeTab ? " active" : ""}" data-ab="${k}">${k.toUpperCase()}</button>`).join("") +
      `</div>` +
      rowKeyHtml(alltimeTab === "kills"
        ? "kill count, then the earlier submission"
        : "the exact tick count, then the earlier submission") +
      boardListHtml(page, alltimeTab,
        "this museum is empty. The first exhibit is yours to donate.") +
      // ONE LINE. The paragraph that used to live here explained era chipping
      // at length under a board with four rows on it.
      `<div class="gate">Never reset — <b>era-chipped</b> instead. A row stamped <b>era ${esc(ERA)}</b> ` +
      `was earned under the numbers you are playing now; an older stamp says so on its face.</div>` +
      // ...AND THE FRAME FILLS. At 1600x900 the all-time board bottomed out
      // around y=520 with 42% of the viewport empty near-black under it. The
      // filler is the OTHER three museums, one line each, so the empty space
      // becomes navigation instead of padding.
      await otherBoardsStripHtml(alltimeTab);
    return;
  }
  if (ladderTab === "bands") {
    const boards = await Promise.all([0, 1, 2, 3, 4, 5].map((b) =>
      competitive.bandBoard(b, 5).catch(() => ({ entries: [] }))));
    // A SPLIT BOARD WITH NO ROWS COLLAPSES (COMPETITIVE.md 3.4). Six empty
    // headers, each carrying a subtitle and the word "none", is the exact
    // "reads as abandoned" failure the entrant gate exists to prevent - and the
    // design already solved it: below the gate a split collapses into its
    // parent and the System says out loud what unlocks it.
    const live = boards.map((raw, b) => ({ b, rows: (raw as { entries: social.BoardRun[] }).entries }))
      .filter((x) => x.rows.length > 0);
    const dark = [0, 1, 2, 3, 4, 5].filter((b) => !live.some((x) => x.b === b));
    body.innerHTML =
      rowKeyHtml("the exact tick count, then the earlier certification") +
      // ONE LINE where a 90-word essay used to sit, and it sat loudest on the
      // emptiest tab in the product.
      `<div class="gate">Fastest sealed <b>TRAVERSAL</b> of a band: every floor in it entered, and the ` +
      `last one left behind. A band you died inside is on your splits and is never a record.</div>` +
      (live.length > 0
        ? `<div class="bandgrid">` + live.map(({ b, rows }) => {
          const last = Math.min(CONFIG.finalFloor, b * 3 + 3);
          return `<div><h4>${social.bandName(b)}</h4>` +
            `<div class="bandsub">floors ${b * 3 + 1}–${last} · ${rows.length} sealed ` +
            `traversal${rows.length === 1 ? "" : "s"}</div>` +
            boardListHtml({ entries: rows }, "band", "no sealed traversals here yet",
              (r) => (r.won ? "full clear" : `ran on to F${r.floor}`)) + `</div>`;
        }).join("") + `</div>`
        : "") +
      (dark.length > 0
        ? `<div class="rsec" style="margin-top:16px;color:var(--gold);font-family:var(--display);` +
          `font-variant:small-caps;letter-spacing:2px">UNCLAIMED SPLITS</div>` +
          `<div class="darkbands">` + dark.map((b) => {
            const last = Math.min(CONFIG.finalFloor, b * 3 + 3);
            return `<button class="dband" data-enter="${esc(events?.daily.id ?? "")}">` +
              `<b>${social.bandName(b)}</b><span>floors ${b * 3 + 1}–${last}</span>` +
              `<i>NOBODY HAS WALKED OUT OF IT YET — TAKE IT ▸</i></button>`;
          }).join("") + `</div>`
          + `<div class="gate">${dark.length === 6 ? "All six" : `${dark.length} of the six`} still ` +
          `unclaimed. These are the most winnable boards in the game: every run passes through several ` +
          `bands, and the first crawler out of one holds it.</div>`
        : "");
    return;
  }
  const token = await accountToken();
  const rc = (await competitive.rivalContract(token).catch(() => null)) as social.RivalContract | null;
  if (!rc || !rc.rival) {
    // ONE CARD AND ONE LINE. The three-heading essay (THE PAIRING / THE STAKE /
    // WHAT DECIDES IT) outweighed the data by area on a tab whose data was
    // "nothing yet".
    body.innerHTML = `<div class="contract"><div class="ctag">◆ NO CONTRACT ISSUED ◆</div>` +
      `<h3>NOBODY TO PAIR YOU WITH</h3>` +
      `<div class="crule">Seal a run on a contract and the System puts you against the nearest crawler ` +
      `on contract points, on today's seed. No queue, no lobby, nobody has to be online.</div>` +
      `<button class="cgo" data-enter="${esc(events?.daily.id ?? "")}">SIGN TODAY'S CONTRACT ▶</button></div>` +
      `<div class="gate">Decided by the better <b>SEALED</b> run. No CP changes hands.</div>`;
    return;
  }
  const theirs = rc.rivalRun;
  const them = rc.rival.name ?? "A RIVAL CRAWLER";
  const h = rc.head;
  // THE LEDGER. A pairing with no memory is not a rivalry, and the season-long
  // head-to-head against a NAMED opponent is a thing LoL has never shown you:
  // its match history knows who was in the lobby, never who you keep losing to.
  const ledger = h && h.played > 0
    ? `<div class="rsec" style="margin-top:18px;color:var(--gold);font-family:var(--display);` +
      `font-variant:small-caps;letter-spacing:2px">HEAD TO HEAD — ${esc(them.toUpperCase())}</div>` +
      `<div class="h2h">` +
        `<div class="h2hc win"><b>${h.mine}</b><small>YOU</small></div>` +
        `<div class="h2hc draw"><b>${h.drawn}</b><small>DRAWN</small></div>` +
        `<div class="h2hc loss"><b>${h.theirs}</b><small>THEM</small></div>` +
      `</div>` +
      `<div class="h2hlist">` + h.recent.map((r) =>
        `<div class="h2hrow ${r.result}"><span class="ev">${esc(r.eventId)}</span>` +
        `<span class="sc">F${r.mineFloor} · ${social.ticksClock(r.mineTicks)} ` +
        `&nbsp;vs&nbsp; F${r.theirFloor} · ${social.ticksClock(r.theirTicks)}</span>` +
        `<span class="vd">${r.result === "won" ? "YOU TOOK IT" : r.result === "lost" ? "THEY TOOK IT" : "DEAD HEAT"}</span></div>`,
      ).join("") + `</div>` +
      `<div class="cnamesub" style="margin-top:8px">Contested contracts only — a walkover is not a win.</div>`
    : `<div class="gate" style="margin-top:18px">NO HISTORY YET. The ledger fills the first time you ` +
      `both seal a run on the same contract.</div>`;
  body.innerHTML =
    `<div class="contract"><div class="ctag">◆ CONTRACT ISSUED ◆</div>` +
    `<h3>${esc(them)}</h3>` +
    `<div class="cmeta">their season score <b>${rc.rival.cp}</b> CP · yours <b>${rc.myCp}</b> CP ` +
    `· resolves in <b>${social.untilText(rc.resolvesAt)}</b></div>` +
    `<div class="crule">You both play today's seed whenever you like. The better SEALED run takes the ` +
    `contract. No lobby, no queue, nobody has to be online at the same time as anybody.</div>` +
    (theirs
      ? `<button class="cgo" data-race="${esc(theirs.id)}" data-label="${esc(theirs.name)}">RACE THEIR GHOST ▶</button>`
      : `<button class="cgo" data-enter="${esc(rc.eventId)}">TAKE THE CONTRACT ▶</button>`) +
    `</div>` +
    (theirs
      ? `<div class="rsec" style="margin-top:16px;color:var(--gold);font-family:var(--display);` +
        `font-variant:small-caps;letter-spacing:2px">THEIR RUN SO FAR</div>` +
        rowKeyHtml() +
        // -1: this is one crawler's run, not a board position. Passing 0 gave
        // a single row the podium hero treatment for a rank it never held.
        `<ul class="board">${boardRowHtml(theirs, -1, "deepest")}</ul>`
      : "") +
    ledger +
    // THE STAKE AND THE PAIRING RULE, still stated — a competitive surface that
    // leaves either as folklore gets folklore back — but as one line, not two
    // paragraphs sitting under a two-row ledger.
    `<div class="gate" style="margin-top:16px">Paired on nearest season CP, recomputed daily. ` +
    `Decided by the better <b>SEALED</b> run. No CP changes hands.</div>`;
}

/** Who lights up. Cheap enough to refresh whenever a set opens: one query the
 *  server answers off a sorted array, plus the follow list on the profile. */
async function refreshRivals(): Promise<void> {
  try {
    const rc = (await competitive.rivalContract(myAccount)) as social.RivalContract;
    if (rc.rival) rivalAccounts.add(rc.rival.publicId);
    const prof = (await competitive.myProfile(myAccount)) as social.ProfileView;
    myPublicId = prof.publicId ?? myPublicId;
    for (const id of prof.following ?? []) rivalAccounts.add(id);
  } catch { /* no rivals is a state, not an error */ }
}

async function openLadder(): Promise<void> {
  myAccount = await accountToken();
  await refreshRivals();
  closeSets();
  recapEl.style.display = "none";
  ladderEl.classList.add("on");
  await renderLadder();
}

document.getElementById("ladder-close")!.addEventListener("click", closeSets);
document.getElementById("career-close")!.addEventListener("click", closeSets);
ladderEl.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const tab = el.closest("[data-lt]") as HTMLElement | null;
  if (tab) {
    ladderTab = (tab.dataset.lt ?? "contracts") as typeof ladderTab;
    ladderEl.querySelectorAll("[data-lt]").forEach((b) => b.classList.toggle("active", b === tab));
    void renderLadder();
    return;
  }
  const ab = el.closest("[data-ab]") as HTMLElement | null;
  if (ab) { alltimeTab = ab.dataset.ab ?? "deepest"; void renderLadder(); return; }
  const race = el.closest("[data-race]") as HTMLElement | null;
  if (race) { void raceRun(race.dataset.race!, race.dataset.label ?? "RIVAL"); return; }
  if (toggleRowDetail(el)) return;
  const enter = el.closest("[data-enter]") as HTMLElement | null;
  if (enter) void enterContract(enter.dataset.enter!);
});

/** DETAIL opens the verifier's own record of a row: splits, build, cause of
 *  death, and the four numbers it derived while replaying. Returns true when
 *  the click was ours. */
function toggleRowDetail(el: HTMLElement): boolean {
  const more = el.closest("[data-more]") as HTMLElement | null;
  if (!more) return false;
  const det = more.closest(".brow")?.querySelector(".rdet") as HTMLElement | null;
  if (!det) return true;
  const open = det.hasAttribute("hidden");
  det.toggleAttribute("hidden", !open);
  more.textContent = open ? "HIDE" : "DETAIL";
  return true;
}

/**
 * THE GATE BELONGS AT THE DOOR (6.2 Beat 5, blocker 2).
 *
 * The start endpoint used to answer `scoresCp: attemptNo === 1` with no idea
 * whether the account could ever be sealed, so the front door sold a fresh
 * anonymous crawler a CP-scoring contract and the exit told them, in a dead
 * sentence with no control beside it, that the System does not put its name on
 * an anonymous claim. It answers `linked` now; this is where the player hears
 * about it, in time to act on it, and the note rides through to the verdict.
 */
type SignedContract = {
  attemptNo: number; scoresCp: boolean; linked?: boolean; unlinkedReason?: string | null;
};

/** Called BEFORE startRun, because beginRecording consumes the note. */
function contractNoteFor(t: SignedContract): string | null {
  return t.linked === false
    ? `today's contract, signed as attempt ${t.attemptNo} and UNSEALABLE: ${t.unlinkedReason
      ?? "an anonymous claim earns no seal and no contract points"}`
    : null;
}

function contractSigned(t: SignedContract): void {
  showAnnouncement({
    text: t.linked === false
      ? `CONTRACT SIGNED, UNSEALED. Attempt ${t.attemptNo}. Nobody has told the System who you are, so `
        + "this one cannot be certified and cannot score. The run still counts for you."
      : t.scoresCp
        ? "CONTRACT SIGNED. Attempt one — this is the run the ladder scores. There is no second first impression."
        : `CONTRACT SIGNED. Attempt ${t.attemptNo}. The board row is live; contract points are not.`,
    kind: "flavor", priority: "high",
  });
}

/** ENTER THE CONTRACT. The START is observed, which is what makes an attempt
 *  count honest and closes practise-offline-then-submit-the-winner (3.2A). */
async function enterContract(eventId: string): Promise<void> {
  try {
    const token = await accountToken();
    const t = await competitive.startEvent(eventId, token);
    pendingTicket = { eventId: t.eventId, ticket: t.ticket, attemptNo: t.attemptNo, scoresCp: t.scoresCp };
    pendingContractNote = contractNoteFor(t);
    closeSets();
    closeMenu();
    ghost = null;
    forcedSeed = t.seed;
    startRun({ kind: "daily", day: events?.daily.day ?? dayFromMs(Date.now()) }, "race");
    contractSigned(t);
  } catch (err) {
    pushLogLine(`CONTRACT REFUSED — ${(err as Error).message}`);
    showAnnouncement({
      text: `THE CONTRACT WAS REFUSED. ${(err as Error).message}`,
      kind: "flavor", priority: "high",
    });
  }
}

/**
 * THE DAILY CRAWL TILE, AND EVERY OTHER WAY INTO TODAY'S SEED.
 *
 * `dailySeed(day)` is the server's daily-contract seed. A run that plays it
 * without a ticket is not "a free seed" - it is TODAY'S CONTRACT, played
 * unranked, and the verdict screen used to state the opposite. So this is the
 * single entry point: it signs for the contract first and starts the run
 * either way, and the two cases it cannot sign are named rather than silently
 * flattened into "free seed".
 *
 *  - A CHALLENGE LINK for another day is a rerun of a closed dungeon. There is
 *    no open contract to sign and there never was one for that day.
 *  - OFFLINE, or a refused signature, is the honest unranked case, and the
 *    screen says which contract went unsigned instead of pretending the seed
 *    was arbitrary.
 */
async function enterDailyContract(day: string | null): Promise<void> {
  const today = dayFromMs(Date.now());
  if (day && day !== today) {
    pendingTicket = null;
    pendingContractNote = `a challenge on the ${day} dungeon — that contract has closed, so this is `
      + `a rerun of it. The board row and the splits still stand; contract points do not.`;
    ghost = null;
    startRun({ kind: "daily", day }, "race");
    return;
  }
  try {
    if (!events) events = (await competitive.events()) as social.EventsView;
    const token = await accountToken();
    const t = await competitive.startEvent(events.daily.id, token);
    pendingTicket = { eventId: t.eventId, ticket: t.ticket, attemptNo: t.attemptNo, scoresCp: t.scoresCp };
    pendingContractNote = contractNoteFor(t);
    forcedSeed = t.seed;
    ghost = null;
    startRun({ kind: "daily", day: events.daily.day }, "race");
    contractSigned(t);
  } catch (err) {
    // The dungeon is identical either way - the seed is the day - so the run
    // starts. What changes is that the screen at the end knows the difference.
    pendingTicket = null;
    pendingContractNote = `today's contract dungeon, played UNSIGNED — the System could not issue an `
      + `attempt ticket (${(err as Error).message}). Same seed, same board row, no contract points.`;
    ghost = null;
    startRun({ kind: "daily", day: today }, "race");
    pushLogLine("THE CONTRACT WENT UNSIGNED. Same dungeon; the ladder is not watching this one.");
  }
}

// ---- THE CRAWLER (5.2) ----------------------------------------------------
// The numbers worth staring at. The histogram is the most interesting chart
// this game can draw: a whole career in one glance, and the answer to the only
// question a roguelike player actually asks about themselves.

const ULT_LANES: AbilityId[] = ["airstrike", "cataclysm", "bullettime"];

function histogramHtml(byFloor: number[]): string {
  const max = Math.max(1, ...byFloor);
  let bars = "";
  let axis = "";
  for (let f = 1; f <= CONFIG.finalFloor; f++) {
    const n = byFloor[f - 1] ?? 0;
    const h = n === 0 ? 2 : Math.max(6, Math.round((n / max) * 118));
    bars += `<div class="hb${n === 0 ? " none" : f > 12 ? " deep" : ""}" style="height:${h}px" ` +
      `title="${n} run${n === 1 ? "" : "s"} ended on floor ${f}">${n > 0 ? `<i>${n}</i>` : ""}</div>`;
    axis += `<span>${f}</span>`;
  }
  return `<div class="histo">${bars}</div><div class="histax">${axis}</div>` +
    `<div class="bandstrip">${[0, 1, 2, 3, 4, 5].map((b) => `<span>${social.bandName(b)}</span>`).join("")}</div>`;
}

function masteryHtml(rows: { ultimate: string; xp: number }[]): string {
  const byId = new Map(rows.map((r) => [r.ultimate, r.xp]));
  return ULT_LANES.map((id) => {
    const m = social.masteryLevel(byId.get(id) ?? 0);
    const info = ABILITY_INFO[id];
    return `<div class="mrow">` +
      `<i class="mic" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>` +
      `<div><div class="mname">${esc(info?.name ?? id)}</div>` +
      `<div class="mbar"><i style="width:${Math.round((m.into / m.need) * 100)}%"></i></div></div>` +
      `<div class="mlvl">LVL ${m.level}<small>${m.into} / ${m.need}</small></div></div>`;
  }).join("");
}

/**
 * YOUR LAST RUNS IS A SHELF, NOT A BOARD (5.2).
 *
 * It reused `boardRowHtml`, which renders `i + 1` into `.rank` and applies the
 * podium gold of `.top1/.top2/.top3` - on a list sorted by TIME, not by
 * result. So a chronological ledger printed fake rank ordinals, dressed your
 * three most RECENT runs as a podium, tagged all ten YOU on your own profile,
 * printed `unstamped` where the era chip goes (which reads as a data bug), and
 * left a REJECTED row displaying its refused claim as a green "CLEAR · 0:10.01"
 * - the ladder showing the lie and labelling it, rather than presenting the
 * refusal.
 */
function recentRowHtml(r: social.BoardRun): string {
  const chip = social.sealChip(r.state, r.rulesEra, r.private, "plain");
  const play = social.playability(r, ERA);
  const refused = r.state === "rejected";
  const sub = [
    r.eventId ? "contract" : "free seed",
    r.attemptNo ? `attempt ${r.attemptNo}` : null,
    r.ultimate ? ABILITY_INFO[r.ultimate as AbilityId]?.name ?? r.ultimate : null,
    r.partySize > 1 ? `party of ${r.partySize}` : null,
    // "unstamped" for a row that was never certified reads as a missing field.
    // It is not missing; there is simply no era to stamp on a claim.
    r.rulesEra ? `era ${r.rulesEra}` : "no era — never certified",
  ].filter(Boolean).join(" · ");
  const result = refused
    // A refusal is presented as a refusal. The claim it made is not reprinted
    // in green with a small grey chip beside it.
    ? `<span class="res">CLAIM REFUSED</span>`
    : `<span class="res${r.won ? " win" : ""}">${boardResult("deepest", r)}</span>`;
  // An unproven row's result is an assertion, and it is never printed in the
  // green the server's own verdict earns.
  return `<li class="crow${refused ? " rejected" : r.state === "verified" ? "" : " unsealed"}">` +
    `<span class="when">${esc(social.ago(r.at))}</span>` +
    `<span class="what"><b>${refused ? "the System did not agree" : r.won ? "escaped the dungeon" : `died on floor ${r.floor}`}</b>` +
    `<span class="sub">${esc(sub)}</span></span>` +
    `<span class="${chip.cls}" title="${esc(chip.title)}">${chip.label}</span>` +
    result +
    `<span class="acts">${play.ok
      ? `<button data-race="${esc(r.id)}" data-label="YOUR RUN">RACE</button>`
      : `<button disabled title="${esc(play.why)}">RACE</button>`}</span></li>`;
}

function ledgerHtml(rows: [string, string][]): string {
  return `<table class="ledger">` + rows.map(([k, v]) =>
    `<tr><td class="lk">${k}</td><td class="ld"><i></i></td><td class="lv">${v}</td></tr>`).join("") + `</table>`;
}

/**
 * TWO LEDGERS, TWO HEADINGS (COMPETITIVE.md 3.3: "Two sources of truth with
 * different rules for the same record is one too many for anything
 * competitive").
 *
 * THE NUMBERS interleaved them row by row with no per-row attribution: RUNS
 * FINISHED / ESCAPES / FASTEST CLEAR / MOST KILLS / PEAK VIEWERS / TIME IN THE
 * DUNGEON came from the localStorage `bests`, DEEPEST FLOOR from max(server,
 * local), CAREER KILLS from the server. On a signed-in account in a fresh
 * browser that printed "RUNS FINISHED 0 · ESCAPES 0 · FASTEST CLEAR —" directly
 * beside "DEEPEST FLOOR 18 · CAREER KILLS 2,089" under a "6 SEALS" headline.
 * Every number was true; the list was not. The histogram got a boundary
 * sentence, the band splits got one, and the one list that actually mixes the
 * ledgers row by row got none.
 */
function ledgerGroupHtml(title: string, note: string, rows: [string, string][]): string {
  return `<div class="lgroup"><div class="lgtitle">${esc(title)}</div>` +
    `<div class="lgnote">${esc(note)}</div>` + ledgerHtml(rows) + `</div>`;
}

async function renderCareerSet(): Promise<void> {
  const body = document.getElementById("career-body")!;
  const history = loadHistory();
  const bests = careerBests(history);
  const token = await accountToken();
  let prof: social.ProfileView | null = null;
  try { prof = (await competitive.myProfile(token)) as social.ProfileView; } catch { /* offline */ }

  // The histogram takes whichever ledger has more runs in it and SAYS WHICH.
  // The server sees every device but only sealed runs; this browser sees every
  // run but only this browser. Silently picking one and labelling it "your
  // career" would be the same lie the whole design is built to avoid.
  const local = new Array<number>(CONFIG.finalFloor).fill(0);
  for (const r of history) if (r.floor >= 1 && r.floor <= CONFIG.finalFloor) local[r.floor - 1]++;
  const localN = local.reduce((a, b) => a + b, 0);
  // THE CHART AND THE LEDGER UNDER IT COUNT THE SAME POPULATION NOW.
  //
  // `serverN` summed `profile.deathsByFloor`, which the server builds from
  // `runsByAccount(...)` — ALL rows — while `seals` on the same response is
  // `runs.filter(state === 'verified').length`. Live: the chart read "4 sealed
  // runs, every device" and THE SEALED RECORD three hundred pixels below read
  // SEALS 0 / DEEPEST FLOOR 0 / CAREER KILLS 0, because all four of those runs
  // were REFUSED. The panel whose stated purpose is "the numbers a board row
  // can be checked against" was counting refused runs as certified, on its
  // headline chart, contradicted on the same screen.
  const sealedByFloor = prof?.sealedDeathsByFloor ?? [];
  const sealedN = sealedByFloor.reduce((a, b) => a + b, 0);
  const submittedN = (prof?.deathsByFloor ?? []).reduce((a, b) => a + b, 0);
  const useServer = sealedN > localN;
  const byFloor = useServer ? sealedByFloor : local;
  const refusedN = prof?.refused ?? 0;
  const histoSource = useServer
    ? `${sealedN} SEALED run${sealedN === 1 ? "" : "s"}, every device`
      + (submittedN > sealedN
        ? ` — ${submittedN - sealedN} more reached the server unproven${refusedN > 0 ? `, ${refusedN} refused` : ""} and are not on this chart`
        : "")
    : `${localN} run${localN === 1 ? "" : "s"} recorded in this browser`;
  const st = prof?.standing;
  const tier = st?.tier
    ?? (st && st.placementRemaining > 0 ? `PLACEMENT — ${st.placementRemaining} TO GO` : "UNRANKED");
  const rankLine = st && st.entrants > 0 && st.rank > 0
    ? `rank ${st.rank} of ${st.entrants} this season`
    : "no ranked contract scored yet";
  // TIER NAMES NEED A POPULATION. Below the floor the chip reads UNRANKED and
  // the System says what unlocks the names, because "BRONZE ENTRANT, rank 4 of
  // 4" is a costume worn by a season with four people in it.
  const tierNote = st && !st.tier && st.placementRemaining === 0 && st.entrants < st.tierFloor
    ? ` · tier names unlock at ${st.tierFloor} ranked crawlers (${st.entrants} so far)`
    : "";

  // BAND PERSONAL BESTS COME FROM THE SERVER - the same verified rows, under
  // the same traversal predicate, as the band board. The local ledger is only
  // the offline fallback, and it is overwritten by the server on every load.
  let bandBests = loadBandBests();
  let bandBestsNote = "from this browser only — the server career is offline, so these are unsealed.";
  if (prof?.bandBests) {
    bandBests = prof.bandBests;
    storeBandBests(bandBests);
    bandBestsNote = "sealed traversals only — every floor in the band entered and the last one left. "
      + "The same rows, and the same rule, as the BANDS board.";
  }

  document.getElementById("career-sub")!.textContent = prof
    ? `season ${prof.season} · rules era ${ERA}`
    : `this browser ledger only — the server career is offline`;

  const totalSec = history.reduce((a, r) => a + r.timeSec, 0);
  body.innerHTML =
    `<div class="cheadline">` +
      `<div class="ctier"><b>${esc(tier)}</b><small>${esc(rankLine)}</small></div>` +
      `<div><div class="cname">${esc(prof?.name ?? crawlerName())}</div>` +
      `<div class="cnamesub">${st ? `${st.cp} contract points · best 10 events count · no decay, ever${tierNote}` : "contract points arrive with your first sealed contract"}</div></div>` +
      `<div class="cseals"><b>${prof?.seals ?? 0}</b><small>SEALS</small></div>` +
    `</div>` +
    `<div class="rsec" style="margin:18px 0 4px;color:var(--gold);font-family:var(--display);` +
    `font-variant:small-caps;letter-spacing:2px">WHERE YOU DIE</div>` +

    // TWO LEDGERS, ONE BOUNDARY, SAID OUT LOUD. The header prints tier, CP,
    // rank-of-entrants and the seal count — all from the SERVER — directly
    // above a histogram that may be counting runs from THIS BROWSER. Both
    // numbers are true; a reader with no boundary marked assumes one
    // population. And the gold bars had no legend at all.
    `<div class="cnamesub" style="margin-bottom:16px">Eighteen floors, one bar each — ${esc(histoSource)}. ` +
    `<b style="color:var(--gold)">Gold bars are floors 13+</b> — THE IRONWORKS and THE APPROACH, where a ` +
    `death costs the most. ${useServer
      ? "Certified rows only, so this chart and THE SEALED RECORD below it count the same runs."
      : "Counted from this browser alone — the tier, contract points and seal count above come from the server, which only ever sees sealed runs."}</div>` +
    histogramHtml(byFloor) +
    `<div class="tcols" style="display:grid;grid-template-columns:1fr 1fr;gap:26px;margin-top:22px">` +
      `<div><div class="rsec" style="color:var(--gold);font-family:var(--display);font-variant:small-caps;` +
      `letter-spacing:2px">THE LEDGERS</div>` +
      // THE SEALED RECORD first, because it is the one the boards agree with.
      ledgerGroupHtml(
        "THE SEALED RECORD",
        prof
          ? "runs the server re-executed and certified, across every device you have ever signed in on. "
            + "These are the numbers a board row can be checked against."
          : "the server career is offline, so there is nothing sealed to show — these arrive with the signal.",
        [
          ["SEALS", String(prof?.seals ?? 0)],
          ["DEEPEST FLOOR", prof ? String(prof.deepest) : "—"],
          ["CAREER KILLS", prof ? (prof.career?.kills ?? 0).toLocaleString() : "—"],
          ["ESCAPES", prof ? String(prof.career?.wins ?? 0) : "—"],
          ["FASTEST SEALED CLEAR", prof?.fastestClear
            ? social.ticksClock(prof.fastestClear.ticks) : "—"],
        ],
      ) +
      // ...then THIS BROWSER'S, which counts every run including the ones
      // nobody certified, and says so instead of standing beside the other one
      // pretending to be the same population.
      ledgerGroupHtml(
        "THIS BROWSER'S LEDGER",
        "every run this device finished, sealed or not, signed in or not — capped at the last 60. "
        + "It counts more runs than the record above and proves fewer of them.",
        [
          ["EPISODES FILED", String(episodeCount())],
          ["RUNS ON THE LEDGER", String(bests?.runs ?? 0)],
          ["ESCAPES", String(bests?.wins ?? 0)],
          ["DEEPEST FLOOR", String(bests?.bestFloor ?? 0)],
          ["FASTEST CLEAR", bests?.fastestClearSec != null ? fmt(bests.fastestClearSec) : "—"],
          ["MOST KILLS IN A RUN", (bests?.mostKills ?? 0).toLocaleString()],
          ["PEAK VIEWERS", (bests?.peakViewers ?? 0).toLocaleString()],
          ["TIME IN THE DUNGEON", `${Math.round(totalSec / 60)} min`],
        ],
      ) +
      `<div class="rsec" style="margin-top:18px;color:var(--gold);font-family:var(--display);` +
      `font-variant:small-caps;letter-spacing:2px">MASTERY</div>` +
      `<div class="cnamesub" style="margin-bottom:6px">One level per ultimate, from SEALED runs, ` +
      `weighted by depth. Every point of it is backed by a replayable proof.</div>` +
      masteryHtml(prof?.mastery ?? []) + `</div>` +
      `<div><div class="rsec" style="color:var(--gold);font-family:var(--display);font-variant:small-caps;` +
      `letter-spacing:2px">PERSONAL BESTS — BAND SPLITS</div>` +
      `<div class="cnamesub" style="margin-bottom:6px">${bandBestsNote}</div>` +
      // THE BARS ARE TIME, AND THE HEADING SAYS "BESTS", so the chart read
      // backwards: THE APPROACH at 6:32.68 filled the track under a heading
      // that made a full bar look like an achievement, while a 0:52.78
      // UNDERCROFT was a stub. The grammar stays time-proportional - the
      // verdict's splits use the identical markup and there longer
      // legitimately means slower - and the axis now SAYS so, with the
      // fastest band struck in gold so the eye has something to reward.
      `<div class="cnamesub" style="margin-bottom:6px;color:var(--ink-faint)">` +
      `bars are TIME IN THE BAND — <b style="color:var(--gold-hi)">shorter is better</b>, ` +
      `and your quickest traversal is the gold one</div>` +
      `<div>${(() => {
        const scale = Math.max(1, ...bandBests.map((x) => x ?? 0));
        const timed = bandBests.filter((x): x is number => !!x);
        const fastest = timed.length > 0 ? Math.min(...timed) : -1;
        return bandBests.map((t, i) =>
          `<div class="splitrow${t ? "" : " empty"}${t && t === fastest ? " best" : ""}">` +
          `<span class="sname">${social.bandName(i)}</span>` +
          `<span class="strack"><i class="sfill" style="width:${t ? Math.min(99, (t / scale) * 100) : 0}%"></i></span>` +
          `<span class="stime">${t ? social.ticksClock(t) : "—"}</span></div>`).join("");
      })()}</div>` +
      `<div class="rsec" style="margin-top:18px;color:var(--gold);font-family:var(--display);` +
      `font-variant:small-caps;letter-spacing:2px">MILESTONES</div>` +
      (social.milestonesFrom(history).map((m) =>
        `<div class="mstone"><div class="mdate">${new Date(m.at).toISOString().slice(0, 10)}</div>` +
        `<div><div class="mtitle">${esc(m.title)}</div><div class="mdetail">${esc(m.detail)}</div></div></div>`,
      ).join("") || `<div class="cnamesub">nothing engraved yet — finish a run and the timeline starts</div>`) +
      `</div>` +
    `</div>` +
    (prof && prof.recent.length
      ? `<div class="rsec" style="margin-top:20px;color:var(--gold);font-family:var(--display);` +
        `font-variant:small-caps;letter-spacing:2px">YOUR LAST RUNS — KEPT PLAYABLE REGARDLESS OF BOARD POSITION</div>` +
        `<div class="cnamesub" style="margin-bottom:6px">Newest first. This is a shelf, not a ladder: ` +
        `no ranks, no podium — it is sorted by when it happened.</div>` +
        `<ul class="board">${prof.recent.map(recentRowHtml).join("")}</ul>`
      : "");
}

async function openCareerSet(): Promise<void> {
  myAccount = await accountToken();
  await refreshRivals();
  closeSets();
  recapEl.style.display = "none";
  careerEl.classList.add("on");
  await renderCareerSet();
}
careerEl.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const race = el.closest("[data-race]") as HTMLElement | null;
  if (race) { void raceRun(race.dataset.race!, race.dataset.label ?? "YOUR RUN"); return; }
  toggleRowDetail(el);
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

// ---- Cockpit HUD (top strip, audit #1/#5) ----
// Structured plaques built ONCE; per-frame updates mutate text and bar widths
// only — no innerHTML churn, no layout thrash. Colors ride iso.html tokens
// through semantic classes instead of inline hex. The HP bar is the cockpit
// anchor: gold-bezel frame, segment ticks, a damage-lag ghost trail, and a
// readout that ticks toward the true value.
hudTL.innerHTML =
  `<div class="hh-row"><span class="hh-label">Floor</span>` +
  `<span class="hh-big" id="hh-floor"></span>` +
  `<span class="hh-dim" id="hh-floor-cap">/ ${CONFIG.finalFloor}</span></div>` +
  `<div class="hh-row" id="hh-collapse-row"><span class="hh-label">Collapse</span>` +
  `<span class="hh-num" id="hh-time"></span>` +
  `<span class="hh-phase" id="hh-phase"></span></div>` +
  `<div class="bar hh-collapse" id="hh-collapse"><i id="hh-collapse-fill"></i>` +
  `<s class="fcap l"></s><s class="fcap r"></s>` +
  `<s class="ftick" style="left:25%"></s><s class="ftick" style="left:50%"></s>` +
  `<s class="ftick" style="left:75%"></s></div>`;
hudTR.innerHTML =
  `<div class="hh-row"><span class="hh-label">Level</span><span class="hh-big" id="hh-level"></span>` +
  `<span class="hh-sep"></span><span class="hh-num gold">${coinIcon}<span id="hh-gold"></span></span>` +
  `<span class="hh-sep"></span><span class="hh-stat" id="hh-atk" title="attack power (tinted by weapon rarity)">${mic("stats/attack")}<span id="hh-atk-v"></span></span>` +
  `<span class="hh-stat" id="hh-mag" title="spell power (tinted by weapon rarity)">${mic("stats/spell")}<span id="hh-mag-v"></span></span></div>` +
  `<div class="hpframe"><div class="hpbar">` +
  `<i class="hp-ghost" id="hh-hpghost"></i><i class="hp-fill" id="hh-hpfill"></i>` +
  `<span class="hp-ticks"></span><span class="hp-num" id="hh-hpnum"></span></div></div>` +
  `<div class="hh-xp" title="experience"><i id="hh-xpfill"></i></div>` +
  `<div class="hh-status" id="hh-status" style="display:none"></div>`;
const hh = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const hhFloor = hh("hh-floor"), hhTime = hh("hh-time"), hhPhase = hh("hh-phase"),
  hhCollapse = hh("hh-collapse"), hhCollapseFill = hh("hh-collapse-fill"),
  hhLevel = hh("hh-level"), hhGold = hh("hh-gold"), hhAtk = hh("hh-atk"), hhMag = hh("hh-mag"),
  hhAtkV = hh("hh-atk-v"), hhMagV = hh("hh-mag-v"),
  hhHpGhost = hh("hh-hpghost"), hhHpFill = hh("hh-hpfill"), hhHpNum = hh("hh-hpnum"),
  hhXpFill = hh("hh-xpfill"), hhStatus = hh("hh-status");
const hudCache: Record<string, string> = {};
const setHudText = (el: HTMLElement, key: string, v: string): void => {
  if (hudCache[key] !== v) { hudCache[key] = v; el.textContent = v; }
};
let hudGhost = 1;
let hudGhostHold = 0;
let hudPrevHpFrac = 1;
let hudDispHp = -1;
let hudLastNow = 0;

function updateHud(s: GameState): void {
  const now = performance.now();
  const dt = hudLastNow > 0 ? Math.min(0.1, (now - hudLastNow) / 1000) : 0.016;
  hudLastNow = now;
  const p = me(s);
  // Floor transition: a stale courtesy card must not ride into the new floor.
  if (hudCache.tutFloor !== String(s.floor)) {
    if (hudCache.tutFloor !== undefined) dismissTutorialForTransition();
    hudCache.tutFloor = String(s.floor);
  }
  // Roam has no collapse sprint and no floor 18: the clock row and the depth
  // cap leave the cockpit entirely rather than reading as a stuck timer.
  if (hudCache.runKind !== s.runKind) {
    hudCache.runKind = s.runKind;
    const roam = s.runKind === "roam";
    hh("hh-floor-cap").style.display = roam ? "none" : "";
    hh("hh-collapse-row").style.display = roam ? "none" : "";
    hhCollapse.style.display = roam ? "none" : "";
  }
  // Top-left: floor + the collapse clock (phase color via semantic classes).
  setHudText(hhFloor, "floor", String(s.floor));

  setHudText(hhTime, "time", fmt(s.timeRemaining));
  // INJUNCTION (V2 N3): while the stay holds, the clock says so and says what
  // it will cost. The freeze is the visible half of the button; the DEBT is
  // the half the crawler forgets, so it rides on the same row.
  const stayT = p.injunctionT ?? 0;
  const phaseKey = stayT > 0 ? "stayed" : s.phase;
  setHudText(
    hhPhase, "phase",
    stayT > 0 ? `STAYED ${stayT.toFixed(1)}s · OWES ${Math.round(p.injunctionDebt ?? 0)}s` : s.phase.toUpperCase(),
  );
  if (hudCache.phaseCls !== phaseKey) {
    hudCache.phaseCls = phaseKey;
    hhPhase.className = `hh-phase ${phaseKey}`;
    hhCollapse.className = `bar hh-collapse ${phaseKey}`;
  }
  const tf = Math.max(0, Math.min(1, s.timeRemaining / s.timeBudget));
  hhCollapseFill.style.width = `${tf * 100}%`;
  // Top-right: level · gold · schools (weapon-rarity tinted), then the bar.
  setHudText(hhLevel, "level", String(p.level));
  setHudText(hhGold, "gold", p.gold.toLocaleString());
  setHudText(hhAtkV, "atk", String(p.attackPower));
  setHudText(hhMagV, "mag", String(p.spellPower));
  if (hudCache.rar !== p.weaponRarity) {
    hudCache.rar = p.weaponRarity;
    hhAtk.className = `hh-stat rtx-${p.weaponRarity}`;
    hhMag.className = `hh-stat rtx-${p.weaponRarity}`;
  }
  // HP: live fill + white damage-lag ghost (holds a beat, then chases) + a
  // readout that TICKS to the true value instead of teleporting.
  const maxHp = Math.max(1, p.maxHp);
  const frac = Math.max(0, Math.min(1, p.hp / maxHp));
  // First frame: the ghost SNAPS to the live fill. Initializing at 1 made a
  // damaged spawn (test chambers, reconnects) read as a flat pale remainder
  // across the whole empty track while the ghost slow-chased down (r3 major).
  if (hudDispHp < 0) { hudGhost = frac; hudPrevHpFrac = frac; }
  if (frac < hudPrevHpFrac - 1e-4) hudGhostHold = 0.3;
  hudPrevHpFrac = frac;
  if (hudGhost > frac + 1e-4) {
    if (hudGhostHold > 0) hudGhostHold -= dt;
    else hudGhost = Math.max(frac, hudGhost - dt * (0.35 + (hudGhost - frac) * 3));
  } else {
    hudGhost = frac; // heals snap the ghost up with the fill
  }
  hhHpFill.style.width = `${frac * 100}%`;
  hhHpGhost.style.width = `${hudGhost * 100}%`;
  const hp = Math.max(0, p.hp);
  if (hudDispHp < 0) hudDispHp = hp;
  hudDispHp += (hp - hudDispHp) * Math.min(1, dt * 14);
  if (Math.abs(hudDispHp - hp) < 0.6) hudDispHp = hp;
  setHudText(hhHpNum, "hp", `${Math.ceil(hudDispHp)} / ${maxHp}`);
  const low = frac < 0.3 && p.alive;
  if (hudCache.low !== String(low)) {
    hudCache.low = String(low);
    hudTR.classList.toggle("low-hp", low);
  }
  hhXpFill.style.width = `${Math.max(0, Math.min(1, p.xp / p.xpToNext)) * 100}%`;
  // Debuff row (5.11): re-rendered only when the status set changes.
  const stKey = (p.statuses ?? []).map((e) => `${e.kind}${e.stacks}${Math.ceil(e.remaining)}`).join("|");
  if (hudCache.st !== stKey) {
    hudCache.st = stKey;
    hhStatus.style.display = stKey ? "" : "none";
    hhStatus.innerHTML = statusChips(p.statuses);
  }
  // The feed itself (hudLogFeed) is driven event-by-event via pushLogLine, not
  // re-rendered every frame — only this persistent status blurb gets redrawn,
  // and only when it actually changes.
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
  if (hudCache.status !== status) {
    hudCache.status = status;
    hudLogStatus.innerHTML = status;
    updateLogChrome();
  }
  // Overhead enemy plates ride the same frame cadence as the cockpit (the
  // camera is already positioned — updateHud runs after renderer.render).
  updateMobPlates(s);
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
      // The competitive standing of the run currently on screen: whether it is
      // riding an event ticket, and what the server said about it. Read-only,
      // and the only way an acceptance harness can check that the front door
      // and THE STANDINGS really are the same door.
      runEvent,
      runContractNote,
      submitResult,
      addPlayer: (name: string) => addPlayer(state, name),
      step: (intents: Parameters<typeof step>[1], dt: number) => step(state, intents, dt),
      equip: (item: Item) => equipItem(me(state), item), // stage gear for UI tests
      // Full hit path for staged FX shots: world FX + the DOM damage number
      // (renderer.emitHits alone skips the number layer real hits get).
      hit: (h: HitEvent) => { renderer.emitHits([h]); spawnDamageNumber(h); },
      // Full boss-beat path for staged capture (tools/bossshot.mjs): world FX
      // + the HUD's live line + the ringside payoff, exactly what the frame
      // loop does with state.bossEvents. Needed because those are per-step
      // transients — the next sim step wipes anything pushed between frames.
      bossBeat: (e: BossEvent) => {
        renderer.bossEvents([e]);
        applyBossEvents([e]);
        stageBossPayoff(state, [e]);
      },
      // Freeze whatever beat is currently up for `seconds` of frame time, so a
      // slow shutter photographs the beat instead of its aftermath.
      hold: (seconds = 10) => {
        const until = hudNow + seconds * 1000;
        captureHold = until;
        if (bossCallUntil > 0) bossCallUntil = until;
        if (bossBeatUntil > 0) bossBeatUntil = until;
        if (killBeatUntil > 0) killBeatUntil = until;
        if (payoffAt) payoffAt.until = until;
        renderer.holdBossBeats(seconds);
      },
      release: () => { captureHold = 0; },
      // Touch layer, for the device harness: the live zone table, the routing
      // decision for a point, and the lock/pref state the battery asserts on.
      touch: {
        zones: touch.zones,
        prefs: touchPrefs,
        route: (x: number, y: number) => touch.debugRoute(x, y),
        // Which chip a point claims, or null. The world zone runs UNDER the
        // cluster (chips win at pointerdown), so a harness that wants clear
        // ground has to ask rather than assume a fraction of the zone is free.
        controlAt: (x: number, y: number) => touch.controlAt(x, y),
        suspendReasons: () => touch.suspendReasons(),
        // Every chip press writes its verdict down (input/touch.ts CastVerdict):
        // a refusal, a queue expiry, a deaf modal gate, a re-entrant pointerId
        // and a cancel all look like silence from outside, and one aimed cast
        // in four was reported as silence on an iPhone 13. The battery drives
        // 40 identical casts per slot and reads this; below 100% is a bug.
        // Measured: 80 of 80, all verdicts `aimed`.
        verdicts: () => touch.verdicts(),
        clearVerdicts: () => touch.clearVerdicts(),
        lastWorldTap,
        clickMoveTarget: clickMove.target,
        lockedTargetId,
        stickyLock,
        relayout: () => touchShell.relayout(),
      },
    }),
  });
}

let lastFloor = state.floor;
let lastStatus = state.status;
// Level-up VFX (D4-style ring + floating text, no toast): a per-player level
// watermark, diffed every frame. Host-local, not sim state — every crawler in
// the party is watched, so a teammate's level-up is visible too.
const lastLevelByPid = new Map<number, number>();
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
// BOSSES V2 §7.4: the typed boss channel, relayed by the server exactly like
// hits and announcements so a coop client stages the same beats.
const netBoss: BossEvent[] = [];
let netIntentAcc = 0;
let srRefreshAcc = 0;
const partyChip = document.getElementById("party")!;

/** Sample input and aim it at the mouse (screen -> iso ground -> sim coords). */

/** The slot holding dash, or -1. Gestures cast a SLOT; they never add a rule. */
function dashSlot(p: Player): number {
  const i = p.abilities.slots.indexOf("dash");
  if (i >= 0) return i;
  return p.abilities.ultimate === "dash" ? ABILITY_SLOTS : -1;
}

/**
 * Smart cast: no explicit aim means "the target I most likely meant", not
 * "whatever is nearest". Locked > damaged in the last 3 s > lowest HP fraction
 * inside the ability REAL range, with a facing-cone weight. Dormant ambushers
 * are excluded — the old autoAimDir aimed at furniture that had not woken up.
 */
function smartAim(slot: number): Vec2 | null {
  const p = me(state);
  const ab = abilityInSlot(p, slot);
  const t = pickTarget(state.monsters, {
    from: p.pos, facing: p.facing,
    range: Math.max(2.5, castRange(ab, p)),
    lockedId: lockedTargetId,
    lastDamagedId,
    lastDamagedAge: performance.now() / 1000 - lastDamagedAt,
  });
  if (!t) return null;
  // WHAT THE SMART CAST CHOSE IS DRAWN, not left to be inferred from where the
  // damage landed. The renderer flashes a transient reticle here for 420 ms;
  // the persistent bracket belongs to the LOCK, and they are deliberately
  // different shapes (renderer3d.setTargetMarkers).
  smartTarget = { x: t.pos.x, y: t.pos.y };
  smartTargetAt = performance.now() / 1000;
  return { x: t.pos.x - p.pos.x, y: t.pos.y - p.pos.y };
}

/** The last smart-cast pick, and when — read once per frame by the markers. */
let smartTarget: Vec2 | null = null;
let smartTargetAt = -Infinity;
let smartTargetShown = -Infinity;

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
const touchEdges = createTouchEdges();
// Target lock lives in the HOST, not the sim: it changes which direction an
// ordinary Intent.aim points, and nothing else.
let lockedTargetId: number | null = null;
let stickyLock = touchPrefs.stickyLock;
let lastDamagedId: number | null = null;
let lastDamagedAt = -Infinity;
/** Bag size last frame: growth is a pickup, and a pickup gets a tick. */
let lastBagCount = 0;
/** Harness/debug only: what the last world tap resolved to. */
let lastWorldTap: { x: number; y: number; long: boolean; ground: Vec2 | null } | null = null;

function pollTouch(): void {
  // `not-playing` is the one suspend reason that is a SIM fact rather than a
  // DOM event (MOBILE.md 2.9a): death, win and floor transitions swallow
  // intents sim-side while the touch FSM happily keeps its state. Hit-stop and
  // sim freezes are deliberately NOT reasons — a press during a frozen sim
  // must still look alive, which is what the edge buffer is for.
  if (state.status === "playing") touch.resume("not-playing");
  else touch.suspend("not-playing");
  touchHeld = touchMode ? touch.sample(performance.now() / 1000) : null;
  if (!touchHeld) return;
  // Edges ACCUMULATE (input/touchIntent.ts): a tap taken while a panel has
  // the sim paused must still land when the world thaws.
  accumulateTouch(touchEdges, touchHeld);
  if (touchHeld.lockToggleEdge) {
    // The LOCK chip is a sticky-lock toggle: on for a boss fight, off for a
    // pack. Clearing it drops whatever was held.
    stickyLock = !stickyLock;
    if (!stickyLock) lockedTargetId = null;
    touchPrefs.stickyLock = stickyLock;
    saveTouchPrefs(touchPrefs);
    touchShell.setLocked(stickyLock);
    haptics.fire("lock");
  }
  if (touchHeld.mapEdge) toggleMinimapExpand();
  // World-zone taps: the host owns the raycast, so the sim stays screen-blind.
  for (const tap of touchHeld.worldTaps) {
    const g = renderer.screenToGround(tap.x, tap.y);
    lastWorldTap = { x: tap.x, y: tap.y, long: tap.long, ground: g };
    if (!g) continue;
    if (tap.long) { touchEdges.ping = g; continue; }
    // Which monster did that finger mean? The GROUND point under a tap is not
    // the monster it landed on: a body is drawn about 0.8 units up, so the ray
    // through its chest hits the floor a tile or two BEHIND its feet. Ask the
    // screen first (nearest projected body inside a thumb radius), and keep the
    // ground-plane test as the fallback for anything the camera cannot project.
    const mob = screenTapTarget(tap.x, tap.y) ?? tapTarget(state.monsters, g, 1.0);
    if (mob) {
      // Tap a monster: lock it AND swing at it (Wild Rift tap-to-attack).
      lockedTargetId = lockedTargetId === mob.id && !stickyLock ? null : mob.id;
      touchEdges.attack = true;
      haptics.fire("lock");
    } else if (touchPrefs.tapToMove) {
      // Tap empty ground: Diablo walk-to-point, through the click-move path
      // that already exists and is already tested.
      clickMove.target = { x: g.x, y: g.y };
      clickMove.holding = false;
      clickMove.stall = 0;
      if (!stickyLock) lockedTargetId = null;
    }
  }
  // The controller reuses its buffers; release them now that they are copied.
  touch.endFrame();
}

/** Thumb radius (CSS px) around a tap that still counts as "on that monster". */
const TAP_BODY_RADIUS = 46;

/** Nearest living monster whose body projects within a thumb of (x, y). */
function screenTapTarget(x: number, y: number): { id: number } | null {
  let best: { id: number } | null = null;
  let bestD = TAP_BODY_RADIUS * TAP_BODY_RADIUS;
  for (const m of state.monsters) {
    if (m.hp <= 0 || m.dormant) continue;
    const p = renderer.worldToScreen(m.pos.x, 0.8, m.pos.y);
    if (!p.visible) continue;
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

/**
 * THE MAP CHIP'S DESTINATION.
 *
 * On a phone the minimap puck is not drawn at all: 114px of a 342px-tall
 * screen is a third of the height for a chart you glance at between fights,
 * and the old puck sat inside the movement thumb's arc anyway (MOBILE.md 1.2).
 * The chip in the cluster — inside `comfortable` — opens this instead.
 *
 * The chart is a canvas, so blowing it up with a transform would turn a floor
 * plan to mush. The BACKING STORE is resized and the static cache invalidated,
 * and the next frame redraws the chart at the new resolution.
 */
function toggleMinimapExpand(): void {
  const on = !document.body.classList.contains("mapbig");
  document.body.classList.toggle("mapbig", on);
  const side = on
    ? Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.74)
    : 150;
  if (minimap.width !== side) {
    minimap.width = side;
    minimap.height = side;
    minimap.style.width = `${side}px`;
    minimap.style.height = `${side}px`;
    mmKey = ""; // force the static layer to rebuild at the new resolution
  }
}
// Anywhere on the expanded chart closes it — there is nothing else to press.
for (const id of ["mapbig-scrim", "minimap-frame"]) {
  document.getElementById(id)?.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("mapbig")) return;
    e.preventDefault();
    toggleMinimapExpand();
  });
}

// ---- TOUCH-FIRST PANELS (MOBILE.md 4.5) ----------------------------------
// Every one of these measured ZERO close controls and tap-outside-closes
// false: on a phone with no keyboard, opening one ended the session. They now
// close three ways, and all three call the SAME close the keyboard calls, so
// Escape, the ✕ and a swipe can never drift apart.
//
// Deliberately NOT wired: the safe room and the recap. Their exit is a game
// decision (DESCEND, NEW SEASON), not a dismissal, and a ✕ on a shop would
// read as "leave without descending", which is not a thing you can do. Their
// buttons are held to the same 44px floor in CSS instead.
// A panel closing takes its derivation sheet with it: a sheet left standing
// over the dungeon would be a modal nothing can dismiss.
attachPanel(invEl, { close: () => { hideSheet(); if (invOpen) toggleInventory(); } });
attachPanel(abilEl, { close: () => { hideSheet(); if (abilOpen) toggleAbilities(); } });
attachPanel(sheetEl, { close: () => { hideSheet(); if (sheetOpen) toggleSheet(); } });
attachPanel(keysEl, { close: () => { hideSheet(); if (kbOpen) toggleKeybinds(); } });
// A draft is dismissible — the picks bank behind the badge — so its bar says
// so rather than pretending the choice went away.
attachPanel(draftEl, {
  close: () => { if (draftEl.style.display === "flex") dismissDraftModal(); },
  done: "BANK IT FOR LATER",
});

/**
 * HOVER BECOMES A TAP SHEET.
 *
 * The crawler profile says "hover anything for the math"; touch has no hover,
 * so on a phone the entire derivation layer was invisible (MOBILE.md 1.3).
 * Every one of those derivations is already a `title` attribute, so one
 * delegated handler converts the whole layer at once — the stat ledger, the
 * damage table's crit and DPS columns, item tooltips, socket reasons — with no
 * per-site work and nothing for a future row to forget.
 */
for (const panel of [sheetEl, invEl, abilEl, srEl]) {
  panel.addEventListener("click", (e) => {
    if (!document.body.classList.contains("touch")) return;
    const t = (e.target as HTMLElement).closest("[title]") as HTMLElement | null;
    const tip = t?.getAttribute("title");
    if (!t || !tip) return;
    // Anything with its own verb keeps it: a tooltip must never eat a button.
    if (t.closest("button, .tab, .itile, .sock, .gchip, .acard .nrow")) return;
    e.preventDefault();
    const label = (t.querySelector(".lab") ?? t.querySelector("small") ?? t).textContent ?? "";
    showSheet(label.trim().slice(0, 40) || "THE MATH", `<div class="tsrow">${tip}</div>`);
  });
}

/**
 * body.ingame — the landscape gate's real scope.
 *
 * The rotate card used to cover the campfire menu, the leaderboard, the recap
 * and the shop, all of which read BETTER in portrait; a phone player's first
 * screen was a rotate card over a menu they could not reach (MOBILE.md 4.4).
 * Gameplay is the only thing that needs the widescreen twin-thumb layout.
 * Cached, because this runs once a frame from updateSkills.
 */
let ingameFlag = false;
function syncIngame(): void {
  const b = document.body;
  const on = state.status === "playing" &&
    !b.classList.contains("modal") && !b.classList.contains("checkin");
  if (on === ingameFlag) return;
  ingameFlag = on;
  b.classList.toggle("ingame", on);
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
  // brings its own aim; a tap leaves aim null for the smart cast below.
  const touchCastAim = applyTouchEdges(intent, touchHeld, touchEdges, {
    isoRotate, dashSlot: dashSlot(me(state)),
  });
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
  // Smart cast: casting without an explicit aim resolves at the prioritised
  // target (input/targeting.ts). Facing still covers whiffs.
  if ((padRecent || touchRecent) && !intent.aim && intent.cast?.some(Boolean)) {
    const snap = smartAim(intent.cast.findIndex(Boolean));
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
  // Touch tap-to-move rides the SAME autopilot, with no cursor and no button:
  // the tap set clickMove.target, and stick input clears it through the
  // keyboardMove flag below — direct control always wins, with no blending.
  if (mouseClickMove || (touchMode && touchPrefs.tapToMove)) {
    const p = me(state);
    const g = mouseClickMove && input.mouse ? renderer.screenToGround(input.mouse.x, input.mouse.y) : null;
    const hover = !!g && state.monsters.some(
      (m) => m.hp > 0 && (m.pos.x - g.x) ** 2 + (m.pos.y - g.y) ** 2 <= 0.55 * 0.55,
    );
    const out = stepClickMove(clickMove, {
      playerPos: p.pos, cursorWorld: g, lmbHeld: mouseClickMove ? input.lmbHeld : false, hoverMonster: hover,
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
  // from the first paint); here we feed it real progress while the FULL
  // manifest front-loads — every GLB, every sound clip, all six band
  // environments, and a shader-precompile pass — so the running game never
  // mid-streams assets or stalls on a first-cast program build. Longer
  // up-front load is the accepted trade (perf round). The System narrates
  // its own load — the rotating line is flavor on a timer, the bar is the
  // information: a weighted sum of three phases, each tracked loaded/total.
  const loadingEl = document.getElementById("loading") as HTMLDivElement;
  const loadingFill = document.getElementById("loading-fill") as HTMLElement;
  const loadingCount = document.getElementById("loading-count") as HTMLElement;
  const loadingFlavor = document.getElementById("loading-flavor") as HTMLElement;
  const loadingPhase = document.getElementById("loading-phase") as HTMLElement;
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
  // Real progress, weighted by phase (models are the bulk of the bytes).
  const phaseFrac = { models: 0, audio: 0, warm: 0 };
  const setBar = (): void => {
    const p = phaseFrac.models * 0.72 + phaseFrac.audio * 0.2 + phaseFrac.warm * 0.08;
    loadingFill.style.width = `${Math.round(p * 100)}%`;
  };
  loadingPhase.textContent = "RECEIVING THE DUNGEON";
  await renderer.init((loaded, total) => {
    phaseFrac.models = loaded / total;
    setBar();
    loadingCount.textContent = `${loaded} / ${total} MODELS`;
  }, { full: true });
  loadingPhase.textContent = "TUNING THE ANNOUNCER'S MICROPHONE";
  await audio.load((loaded, total) => {
    phaseFrac.audio = loaded / total;
    setBar();
    loadingCount.textContent = `${loaded} / ${total} SOUNDS`;
  });
  // Shader precompile + FX pool pre-allocation + all-band environment bake:
  // everything the first combat frame would otherwise hitch on.
  loadingPhase.textContent = "CALIBRATING THE CAMERAS";
  await renderer.prewarm(state, (done, total) => {
    phaseFrac.warm = done / total;
    setBar();
    loadingCount.textContent = `WARMUP ${done} / ${total}`;
  });
  window.clearInterval(flavorTimer);
  loadingEl.classList.add("done");
  window.setTimeout(() => { loadingEl.style.display = "none"; }, 500);

  if (net) {
    try {
      state = await net.connect(serverUrl, joinCode!, playerName, rivalsMode, roamMode, publicMode);
    } catch (err) {
      hudLog.innerHTML = `<b style="color:#c0392f">${(err as Error).message}</b><br>` +
        `Start it with <b>npm run server</b>, or check ?server=.`;
      return;
    }
    localId = net.playerId;
    renderer.localPlayerId = localId;
    rememberParty(); // the menu offers one-tap REJOIN next visit
    pushLogLine(`Joined party ${joinCode} as ${playerName}. SYSTEM menu copies an invite link.`);
    net.onEvents = (batch) => {
      netHits.push(...batch.hits);
      netAnns.push(...batch.announcements);
      if (batch.bossEvents) netBoss.push(...batch.bossEvents);
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
      showAnnouncement({ text: "SIGNAL RESTORED. The dungeon kept your seat.", kind: "flavor", priority: "high" });
    };
    partyChip.style.display = "";
  }

  // Feedback buffers reused across frames (GC sweep: no per-frame arrays).
  const frameHits: typeof state.hits = [];
  const frameAnns: Announcement[] = [];
  // Boss beats are per-STEP transients (cleared exactly like state.hits), so
  // they have to be drained inside the sub-step loop or a phase edge that
  // lands on a non-final sub-step is silently lost.
  const frameBoss: BossEvent[] = [];
  function frame(now: number): void {
    hudNow = now; // the boss beat line + the call-out expire on the frame clock
    let dt = (now - prev) / 1000;
    prev = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    acc += dt;
    pollPad(); // frame-level: panel buttons stay live while a panel pauses the sim
    pollTouch();

    // Buffer feedback across every sub-step (step() clears these each call).
    frameHits.length = 0;
    frameAnns.length = 0;
    frameBoss.length = 0;

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
      frameBoss.push(...netBoss.splice(0));
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

    // EXECUTION, half of it: count what the System OFFERED, so the post-run
    // grade can hold you to what you left unclaimed.
    if (rewardN > prevRewardN) draftsOffered += rewardN - prevRewardN;
    if (upgradeN > prevUpgradeN) draftsOffered += upgradeN - prevUpgradeN;
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
        showAnnouncement({ text: "NOTICE: you have unclaimed evolutions. They do not accrue interest.", kind: "progress", priority: "normal" });
      }
    } else {
      draftBadge.style.display = "none";
      draftIdleSec = 0;
    }
    // Settlement outfitter (Roam): opened by a dialogue choice, closed by its
    // exit button or by leaving the walls. Reuses the #saferoom panel wholesale.
    if (settlementShopOpen && (inSafeRoom || !!net || !settlementShopFor(state, lp))) {
      settlementShopOpen = false;
    }
    if (srEl.style.display !== "flex" && inSafeRoom && !draftPending) {
      srTab = "shop"; // every safe room opens on today's shelf
      shopView = "stock";
      shopSel = null;
      renderSafeRoom(state);
      srEl.style.display = "flex";
    }
    if (srEl.style.display !== "flex" && settlementShopOpen && !draftPending) {
      renderSafeRoom(state); // tab already chosen by the dialogue signal
      srEl.style.display = "flex";
    }
    if (srEl.style.display === "flex" && !inSafeRoom && !settlementShopOpen) srEl.style.display = "none";

    if (!net) {
      // Local sim. Panels, an OPEN draft modal, and the safe room pause it (a
      // host UX choice — the networked world never pauses); drop accumulated
      // time. Banked drafts deliberately do NOT pause: the badge flow means
      // the world keeps running until the crawler chooses their moment.
      if (menuOpen || invOpen || abilOpen || sheetOpen || kbOpen || draftEl.style.display === "flex" || inSafeRoom
        || dlgOpen || settlementShopOpen) acc = 0; // Roam: conversation + outfitter pause like the safe room
      if (hitStop > 0) { hitStop = Math.max(0, hitStop - dt); acc = 0; } // kill pop

      while (acc >= SIM_DT) {
        // THE RECORDING SEAM (COMPETITIVE.md MUST-3). The intent goes through
        // the wire format BEFORE the sim sees it, whether or not a recorder is
        // armed - canonicalIntent is the identical round trip with no tape. So
        // the sim consumes byte-identical values in both cases and recording
        // cannot change what happens, by construction rather than by care.
        // A ping is free-position input that cannot survive an 8-bit heading,
        // so it rides the action list and is re-attached here, exactly the way
        // ReplaySession re-attaches it on the far side.
        const rawIntent = sampleIntent(SIM_DT);
        const intent = rec ? rec.record(rawIntent) : canonicalIntent(rawIntent);
        if (rawIntent.ping) intent.ping = rawIntent.ping;
        step(state, intent, REPLAY_DT);
        runTicks++;
        for (const e of state.events) pushLogLine(e);
        frameHits.push(...state.hits);
        frameAnns.push(...state.announcements);
        if (state.bossEvents) frameBoss.push(...state.bossEvents);
        acc -= SIM_DT;
        if (state.floor !== lastFloor) {
          lastFloor = state.floor;
          // The split ledger, live: the tick a floor was entered is the whole
          // basis of the band boards and of the ghost delta.
          if (state.floor >= 1 && floorEntryTicks[state.floor - 1] === -1) {
            floorEntryTicks[state.floor - 1] = runTicks;
          }
          persistRun(state);
        }
        if (state.status !== lastStatus) {
          lastStatus = state.status;
          persistRun(state);
          if (state.status !== "playing") {
            // THE LEDGER AS IT STOOD BEFORE THIS RUN. Every "is this a personal
            // best" question on the verdict screen has to be asked against the
            // ledger this run found, not the one it just joined - the band
            // splits already knew that; the DEEPEST FLOOR check and THE MARK
            // did not, so a run compared itself to itself and reported that it
            // had matched its own record.
            recapPrevCareer = careerBests(loadHistory());
            noteDailyStreak(state); // a local nudge; boards are earned by proof
            submitTelemetry(state); // the build goes to the balance record
            if (!testMode) recordRun(state, runMode, Date.now()); // the career ledger
            sealRun(state); // ...and the proof goes to the verifier
          }
        }
      }
      // Killing blows schedule the next freeze: crits pop hardest, player deaths
      // hang for drama, ordinary kills get a couple of frames. Non-kill CRITS
      // get a single-frame tick (the accumulator cap keeps flurries sane), and
      // OVERKILL blows hang longest — deleting something should feel like it.
      for (const h of frameHits) {
        if (h.overkill) { hitStop = Math.min(0.14, hitStop + 0.1); continue; }
        if (!h.killed) {
          if (h.kind === "crit") hitStop = Math.min(0.12, hitStop + 0.022);
          continue;
        }
        hitStop = Math.min(0.12, hitStop + (h.kind === "crit" ? 0.06 : h.kind === "player" ? 0.09 : 0.035));
      }

      saveAcc += dt;
      if (saveAcc > 3 && state.status === "playing") { saveAcc = 0; persistRun(state); }
    }

    // Level-up VFX: every player in the party is watched (not just the local
    // one), so a teammate's level-up is visible too — matches D4's
    // shared-world halo. Runs regardless of net/local mode since `state` is
    // current either way by this point in the frame.
    for (const p of state.players) {
      const last = lastLevelByPid.get(p.id);
      if (last !== undefined && p.level > last) {
        renderer.emitLevelUp(p.pos.x, p.pos.y);
        spawnLevelUpText(p);
      }
      lastLevelByPid.set(p.id, p.level);
    }

    syncPickupFeedback();

    // Touch feedback: the drag-aim ground telegraph + the contextual descend
    // chip (shown only while standing on the stairs tile).
    if (touchMode) {
      const p = me(state);
      // THE INDICATOR APPEARS ON POINTERDOWN, in the same frame — not after
      // the drag slop. On press you see the ability REAL reach (from its own
      // params, so glyphs and ranks change the drawn shape); the drag only
      // changes its direction. While the gesture sits in its CANCEL state the
      // telegraph goes away, which is the one unambiguous "this will not fire"
      // signal available before the renderer grows a dashed form.
      const liveSlot = touchHeld
        ? (touchHeld.aimingSlot >= 0 ? touchHeld.aimingSlot : touchHeld.pressedSlot)
        : -1;
      if (liveSlot >= 0 && !(touchHeld && touchHeld.aimCancel)) {
        const spec = aimSpecFor(abilityInSlot(p, liveSlot), p);
        // ROTATE BEFORE YOU SCALE (MOBILE.md 2.4b). The screen vector goes
        // through isoRotate FIRST and only then does its magnitude mean a
        // world distance, so an up-screen and a sideways drag of equal thumb
        // travel mean equal world distance despite the iso basis
        // foreshortening the up-screen axis 2.5:1.
        //
        // ...and it is rotated ONLY. `aimDir` is the raw PIXEL drag vector, so
        // the rotation's output carries a ~110-175 magnitude while the
        // `p.facing` fallback is unit. Multiplying a tile distance by that put
        // nova 455 world units out and cataclysm 1050 — six of ten abilities,
        // both ultimates, 0% of the telegraph on the glass. Direction and
        // anchor are therefore derived together, in aimAnchor(), which
        // normalises before either is used and is held by
        // test/aimTelegraph.test.ts projecting the box onto a phone frame.
        const anchor = aimAnchor(
          spec, p.pos,
          touchHeld && touchHeld.aimDir ? isoRotate(touchHeld.aimDir) : null,
          touchHeld ? touchHeld.aimFrac : 0, p.facing,
        );
        const dir = anchor.dir;
        // ...and the drag's LENGTH only means something for a shape the drag
        // PLACES. A line, a cone and a chain fly their full derived reach
        // whatever the throw; reading `frac` for them would be a game rule in
        // the input layer (aimPlacement returns 0 for those).
        const at = anchor.at;
        // THE SPEC GOES THROUGH WHOLE. The renderer used to take three shapes
        // and no numbers, so the host folded six shapes down to three and
        // every AoE drew the same 2.0-2.2 ring whatever its real radius —
        // nova at 2.6 and cataclysm at 6 were pixel-identical (MOBILE.md
        // §1.6). Passing `range`/`radius`/`arc` is what makes the telegraph
        // teach itemisation: a glyph that grows the nova grows the circle.
        renderer.setAimIndicator(spec.shape, at, dir, spec.range, spec.radius, spec.arc);
        // ...and the camera LEADS the aim, because a 14.4-tile bolt does not
        // fit in the 8.5 tiles a phone shows above the crawler: measured, 8.1%
        // of the line's vertices were on the glass. Presentation only.
        renderer.setAimLead(dir, Math.max(spec.range, anchor.distance + spec.radius));
      } else {
        renderer.setAimIndicator(null);
        renderer.setAimLead(null, 0);
      }
      // TARGET SELECTION IS DRAWN. `lockedTargetId` steered `pickTarget` and
      // lit the LOCK chip for four rounds while nothing appeared on the
      // monster itself; a lock a player cannot see is a lock they cannot use.
      const lockedMob = lockedTargetId !== null
        ? state.monsters.find((m) => m.id === lockedTargetId && m.hp > 0)
        : undefined;
      // Handed over ONCE, on the frame the pick happened: the renderer owns the
      // fade, and re-sending the same pick every frame would restart it.
      const fresh = smartTargetAt > smartTargetShown ? smartTarget : null;
      smartTargetShown = smartTargetAt;
      renderer.setTargetMarkers(
        lockedMob ? { x: lockedMob.pos.x, y: lockedMob.pos.y } : null, fresh,
      );
      const ti = Math.floor(p.pos.y) * state.map.w + Math.floor(p.pos.x);
      // Roam: the same interact chip talks to a resident in reach (the sim's
      // useStairs seam routes to startDialogue when an NPC is closer).
      const nearNpc = state.runKind === "roam" &&
        npcsOf(state).some((n) => Math.hypot(n.pos.x - p.pos.x, n.pos.y - p.pos.y) <= 1.6);
      if (tStairsEl.textContent !== (nearNpc ? "Talk" : "Descend")) {
        tStairsEl.textContent = nearNpc ? "Talk" : "Descend";
      }
      tStairsEl.classList.toggle("on", nearNpc || state.map.tiles[ti] === Tile.StairsDown);
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

    // Touch haptics ride the same per-frame feedback buffers the rumble does,
    // rate-limited to one pulse per 60 ms inside Haptics. The same loop keeps
    // the "last thing I damaged" note that feeds smart cast priority: hits
    // carry a position, not a monster id, so the nearest body to the impact is
    // the credit — good enough to make finishing a kill feel intentional.
    if (touchMode && frameHits.length > 0) {
      const p = me(state);
      let ev: "hurt" | "kill" | null = null;
      for (const h of frameHits) {
        if (h.kind === "player") {
          if (h.amount > p.maxHp * 0.12) ev = "hurt";
          continue;
        }
        const hitMob = tapTarget(state.monsters, h.pos, 0.9);
        if (hitMob) { lastDamagedId = hitMob.id; lastDamagedAt = performance.now() / 1000; }
        if (h.killed && ev !== "hurt") ev = "kill";
      }
      if (ev) haptics.fire(ev);
      // A locked target that died stops being a target.
      if (lockedTargetId !== null && !state.monsters.some((m) => m.id === lockedTargetId && m.hp > 0)) {
        lockedTargetId = null;
      }
    }
    if (touchMode && frameAnns.length > 0) {
      for (const a of frameAnns) {
        if (a.kind === "levelup") { haptics.fire("levelup"); break; }
      }
    }
    // Loot needs no input — the sim collects inside pickupRadius. What it
    // needed was an ACKNOWLEDGEMENT: a thumb covering half a phone screen
    // cannot see a small pickup toast behind it.
    if (touchMode) {
      const bag = me(state).inventory.length;
      if (bag > lastBagCount) haptics.fire("pickup");
      lastBagCount = bag;
    }

    // Particles + shake use world space, so they can fire before the camera moves.
    renderer.emitHits(frameHits);
    // BOSSES V2 §5: the encounter's beats. The renderer stages the world FX
    // and takes its camera intent from them; the HUD says the WORD; the audio
    // director fires the stinger. One buffer, three consumers, no re-derivation.
    if (frameBoss.length > 0) {
      renderer.bossEvents(frameBoss);
      applyBossEvents(frameBoss);
    }
    // EVERY frame, not only the ones carrying a beat (r3 blocker). The DEFEATED
    // record arrives on the frame the boss dies; the drops it pays out land on
    // LATER frames, and those frames carry no boss events at all — so gating
    // this call on `frameBoss.length` meant the arcs were staged for exactly
    // the loot that already existed, i.e. none of it.
    stageBossPayoff(state, frameBoss);
    // §5.5/§5.7 — brief slow-mo on a phase break and the kill. Rides the same
    // hitStop the kill pop already uses, so it composes with combat feel
    // instead of fighting it. Solo only: the networked world never pauses.
    if (!net && renderer.bossSlowmo > 0) hitStop = Math.max(hitStop, Math.min(0.4, renderer.bossSlowmo));
    audioDirector.frame(state, frameHits, frameAnns, localId, frameBoss);
    updateBulletTimeGrade(state);
    if (menuOpen && charSelect) {
      // Checked in at the campfire: the select scene owns the canvas; the
      // frozen backdrop world stays un-rendered until the menu closes.
      charSelect.frame(now / 1000);
    } else {
      // THE GHOST, IN THE ROOM (4.1). One array index and a lerp - the track
      // was precomputed off-thread, so a visible rival costs nothing per frame.
      // It shows only while it shares your floor; the rail chip carries it the
      // rest of the time.
      if (ghost && state.status === "playing" && !net) {
        const at = social.ghostAt(ghost, runTicks);
        renderer.setGhost(at ? { x: at.x, y: at.y, onFloor: at.floor === state.floor } : null);
      } else {
        renderer.setGhost(null);
      }
      renderer.update(state, now / 1000);
      renderer.render();
    }
    // Damage numbers need the camera positioned (done in update) to project.
    for (const h of frameHits) spawnDamageNumber(h);
    for (const a of frameAnns) showAnnouncement(a);
    updateDowned(state);
    maybeShowRecap(state);
    updateHud(state);
    updateSkills(state);
    updateGhostHud(state);
    updateGhostPlate(state);
    updateShowHud(state);
    updateBossBar(state);
    drawMinimap(state);
    updateRoamUi(state);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
