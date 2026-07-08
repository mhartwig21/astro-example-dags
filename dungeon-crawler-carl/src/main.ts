import {
  createGame, createTestGame, restoreGame, step, chooseReward, chooseUpgrade, buyCatalogItem,
  effectivePrice, setReady, type TestSetup,
} from "./sim/game";
import { ABILITY_INFO, type AbilityId } from "./sim/abilities";
import { CATALOG_BY_ID } from "./sim/catalog";
import type { GameState } from "./sim/types";
import { CONFIG } from "./sim/config";
import { InputController } from "./input/input";
import { createClickMove, stepClickMove } from "./input/clickMove";
import { loadMouseMove } from "./input/bindings";
import { render, updateCamera, type Camera } from "./render/renderer";
import { clearRun, loadRun, saveRun } from "./persist/save";

const SIM_HZ = 60;
const SIM_DT = 1 / SIM_HZ;
const MAX_FRAME = 0.1; // clamp huge frame gaps (tab switch) so we don't spiral

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let viewW = 0;
let viewH = 0;

function resize(): void {
  viewW = Math.min(window.innerWidth, 1100);
  viewH = Math.min(window.innerHeight - 4, 720);
  canvas.width = viewW;
  canvas.height = viewH;
}
window.addEventListener("resize", resize);
resize();

// A fresh seed for brand-new runs. Uses wall-clock ONLY here in the host, never
// inside the sim — the sim receives the resulting number as a fixed seed.
function freshSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

// Test mode (?test[&floor=&level=&abilities=&gold=&seed=]): jump straight to a
// dungeon stage; nothing is loaded or saved, so the real run is untouched.
const params = new URLSearchParams(location.search);
const testMode = params.has("test");
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
function persistRun(g: GameState): void {
  if (!testMode) saveRun(g);
}

function startFresh(): GameState {
  if (testMode) {
    const s = testSetup();
    if (!params.has("seed")) s.seed = freshSeed(); // R rerolls unless pinned
    return createTestGame(s);
  }
  clearRun();
  const g = createGame(freshSeed());
  saveRun(g);
  return g;
}

// Log on/off: resume a saved run if one exists and isn't already finished.
function boot(): GameState {
  if (testMode) return createTestGame(testSetup());
  const save = loadRun();
  if (save && save.status === "playing") {
    return restoreGame(save);
  }
  return startFresh();
}

let state = boot();
const cam: Camera = { x: state.players[0].pos.x, y: state.players[0].pos.y };
const log: string[] = [`Entered floor ${state.floor}. Descend to floor ${CONFIG.finalFloor}.`];

const input = new InputController(canvas);
// Diablo-style mouse movement shares the 3D host's preference (K panel there).
const mouseClickMove = loadMouseMove();
input.mouseMoveMode = mouseClickMove;
const clickMove = createClickMove();
input.onReset = () => {
  state = startFresh();
  log.length = 0;
  log.push(`New run. Descend to floor ${CONFIG.finalFloor}.`);
};

// The 2D slice has no modal UI, so pauses (drafts / safe room) are keyboard-driven:
// 1-9 picks a draft card or buys a shop item; Enter leaves the safe room.
let pausePrompted = false;
window.addEventListener("keydown", (e) => {
  const n = Number(e.key);
  const me = state.players[0];
  if (n >= 1 && n <= 9) {
    if (me.pendingRewards.length > 0) chooseReward(state, me.id, n - 1);
    else if (me.pendingUpgrades.length > 0) chooseUpgrade(state, me.id, n - 1);
    else if (state.safeRoom) {
      const id = state.safeRoom.available[n - 1];
      if (id) buyCatalogItem(state, me.id, id);
    }
    for (const ev of state.events) log.push(ev);
    state.events = [];
  } else if (e.key === "Enter" && state.safeRoom) {
    setReady(state, me.id);
    for (const ev of state.events) log.push(ev);
    state.events = [];
  }
});

let lastFloor = state.floor;
let lastStatus = state.status;
let saveAccumulator = 0;

let prev = performance.now();
let acc = 0;

function frame(now: number): void {
  let dt = (now - prev) / 1000;
  prev = now;
  if (dt > MAX_FRAME) dt = MAX_FRAME;
  acc += dt;

  const playerScreen = {
    x: viewW / 2 + (state.players[0].pos.x - cam.x) * CONFIG.tile,
    y: viewH / 2 + (state.players[0].pos.y - cam.y) * CONFIG.tile,
  };

  // Log a one-time hint whenever a pause (draft / safe room) begins.
  const lp = state.players[0];
  const paused = lp.pendingRewards.length > 0 || lp.pendingUpgrades.length > 0 || !!state.safeRoom;
  if (paused && !pausePrompted) {
    pausePrompted = true;
    if (state.safeRoom) {
      const room = state.safeRoom;
      log.push(`SAFE ROOM — ${room.tip}`);
      room.available.slice(0, 9).forEach((id, i) => {
        const e = CATALOG_BY_ID[id];
        log.push(`  [${i + 1}] ${e.name} — ${e.desc} (${effectivePrice(lp, id, room.nextFloor)}g)`);
      });
      log.push("  Press 1-9 to buy, Enter to descend.");
    } else {
      const offers: { title: string; desc: string; overrank?: boolean }[] =
        lp.pendingRewards.length > 0 ? lp.pendingRewards : lp.pendingUpgrades;
      offers.forEach((o, i) => log.push(`  [${i + 1}] ${o.overrank ? "⭑ OVERRANK " : ""}${o.title} — ${o.desc}`));
      log.push("  Press 1-9 to choose.");
    }
  }
  if (!paused) pausePrompted = false;

  // Fixed-timestep sim updates; render interpolation is not needed at 60 Hz here.
  while (acc >= SIM_DT) {
    const intent = input.sample(playerScreen);
    // Click-to-move (opt-in, toggled in the 3D host's K panel): map the cursor
    // through the camera to world tiles, then steer like the 3D host does.
    if (mouseClickMove && input.mouse) {
      const g = {
        x: cam.x + (input.mouse.x - viewW / 2) / CONFIG.tile,
        y: cam.y + (input.mouse.y - viewH / 2) / CONFIG.tile,
      };
      const p = state.players[0];
      const hover = state.monsters.some(
        (m) => m.hp > 0 && (m.pos.x - g.x) ** 2 + (m.pos.y - g.y) ** 2 <= 0.55 * 0.55,
      );
      const out = stepClickMove(clickMove, {
        playerPos: p.pos, cursorWorld: g, lmbHeld: input.lmbHeld, hoverMonster: hover,
        keyboardMove: intent.move.x !== 0 || intent.move.y !== 0, dt: SIM_DT,
      });
      if (out.move) intent.move = out.move;
      if (out.attack && intent.cast) intent.cast[0] = true;
    }
    step(state, intent, SIM_DT);
    for (const e of state.events) log.push(e);
    acc -= SIM_DT;

    // Persist on floor change and status change (the meaningful save points).
    if (state.floor !== lastFloor) {
      lastFloor = state.floor;
      persistRun(state);
    }
    if (state.status !== lastStatus) {
      lastStatus = state.status;
      persistRun(state);
    }
  }

  // Periodic autosave (~every 3s) so a refresh mid-floor resumes cleanly.
  saveAccumulator += dt;
  if (saveAccumulator > 3 && state.status === "playing") {
    saveAccumulator = 0;
    persistRun(state);
  }

  updateCamera(cam, state, viewW, viewH);
  render(ctx, state, cam, viewW, viewH, log);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
