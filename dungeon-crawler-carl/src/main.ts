import { createGame, restoreGame, step, chooseReward, chooseUpgrade, buyShopItem, leaveSafeRoom } from "./sim/game";
import type { GameState } from "./sim/types";
import { CONFIG } from "./sim/config";
import { InputController } from "./input/input";
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

function startFresh(): GameState {
  clearRun();
  const g = createGame(freshSeed());
  saveRun(g);
  return g;
}

// Log on/off: resume a saved run if one exists and isn't already finished.
function boot(): GameState {
  const save = loadRun();
  if (save && save.status === "playing") {
    return restoreGame(save);
  }
  return startFresh();
}

let state = boot();
const cam: Camera = { x: state.player.pos.x, y: state.player.pos.y };
const log: string[] = [`Entered floor ${state.floor}. Descend to floor ${CONFIG.finalFloor}.`];

const input = new InputController(canvas);
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
  if (n >= 1 && n <= 9) {
    if (state.pendingRewards.length > 0) chooseReward(state, n - 1);
    else if (state.pendingUpgrades.length > 0) chooseUpgrade(state, n - 1);
    else if (state.safeRoom) buyShopItem(state, n - 1);
    for (const ev of state.events) log.push(ev);
    state.events = [];
  } else if (e.key === "Enter" && state.safeRoom) {
    leaveSafeRoom(state);
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
    x: viewW / 2 + (state.player.pos.x - cam.x) * CONFIG.tile,
    y: viewH / 2 + (state.player.pos.y - cam.y) * CONFIG.tile,
  };

  // Log a one-time hint whenever a pause (draft / safe room) begins.
  const paused = state.pendingRewards.length > 0 || state.pendingUpgrades.length > 0 || !!state.safeRoom;
  if (paused && !pausePrompted) {
    pausePrompted = true;
    if (state.safeRoom) {
      log.push(`SAFE ROOM — ${state.safeRoom.tip}`);
      state.safeRoom.stock.forEach((s, i) => log.push(`  [${i + 1}] ${s.title} — ${s.desc} (${s.price}g)`));
      log.push("  Press 1-9 to buy, Enter to descend.");
    } else {
      const offers = state.pendingRewards.length > 0 ? state.pendingRewards : state.pendingUpgrades;
      offers.forEach((o, i) => log.push(`  [${i + 1}] ${o.title} — ${o.desc}`));
      log.push("  Press 1-9 to choose.");
    }
  }
  if (!paused) pausePrompted = false;

  // Fixed-timestep sim updates; render interpolation is not needed at 60 Hz here.
  while (acc >= SIM_DT) {
    const intent = input.sample(playerScreen);
    step(state, intent, SIM_DT);
    for (const e of state.events) log.push(e);
    acc -= SIM_DT;

    // Persist on floor change and status change (the meaningful save points).
    if (state.floor !== lastFloor) {
      lastFloor = state.floor;
      saveRun(state);
    }
    if (state.status !== lastStatus) {
      lastStatus = state.status;
      saveRun(state);
    }
  }

  // Periodic autosave (~every 3s) so a refresh mid-floor resumes cleanly.
  saveAccumulator += dt;
  if (saveAccumulator > 3 && state.status === "playing") {
    saveAccumulator = 0;
    saveRun(state);
  }

  updateCamera(cam, state, viewW, viewH);
  render(ctx, state, cam, viewW, viewH, log);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
