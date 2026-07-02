import { createGame, restoreGame, step } from "./sim/game";
import type { GameState } from "./sim/types";
import { CONFIG } from "./sim/config";
import { InputController } from "./input/input";
import { Renderer3D } from "./render3d/renderer3d";
import { clearRun, loadRun, saveRun } from "./persist/save";

// 3D isometric host: runs the exact same deterministic sim as the 2D slice, but
// renders it through the Three.js isometric renderer. Proves the art direction and
// that rendering is fully decoupled from gameplay (same sim, two views).

const SIM_HZ = 60;
const SIM_DT = 1 / SIM_HZ;
const MAX_FRAME = 0.1;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer3D(canvas);

function resize(): void {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

function freshSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}
function startFresh(): GameState {
  clearRun();
  const g = createGame(freshSeed());
  saveRun(g);
  return g;
}
function boot(): GameState {
  const save = loadRun();
  if (save && save.status === "playing") return restoreGame(save);
  return startFresh();
}

let state = boot();
const log: string[] = [`Entered floor ${state.floor}. Descend to floor ${CONFIG.finalFloor}.`];

const input = new InputController(canvas);
input.onReset = () => {
  state = startFresh();
  log.length = 0;
  log.push(`New run. Descend to floor ${CONFIG.finalFloor}.`);
};

// HUD elements.
const hudTL = document.getElementById("hud-tl")!;
const hudTR = document.getElementById("hud-tr")!;
const hudLog = document.getElementById("hud-log")!;

function phaseColor(s: GameState): string {
  return s.phase === "safe" ? "#5fd08a" : s.phase === "warning" ? "#f2c14e" : "#e2574c";
}
function fmt(t: number): string {
  const c = Math.max(0, t);
  return `${Math.floor(c / 60)}:${Math.floor(c % 60).toString().padStart(2, "0")}`;
}
function updateHud(s: GameState): void {
  const p = s.player;
  const tf = Math.max(0, Math.min(1, s.timeRemaining / s.timeBudget));
  hudTL.innerHTML =
    `Floor ${s.floor} / ${CONFIG.finalFloor}<br>` +
    `<span style="color:${phaseColor(s)}">Collapse ${fmt(s.timeRemaining)} · ${s.phase.toUpperCase()}</span>` +
    `<div class="bar"><i style="width:${tf * 100}%;background:${phaseColor(s)}"></i></div>`;
  hudTR.innerHTML =
    `Level ${p.level} · ${p.gold} gold · DMG ${p.baseDamage}<br>` +
    `HP ${Math.ceil(p.hp)} / ${p.maxHp}` +
    `<div class="bar"><i style="width:${Math.max(0, (p.hp / p.maxHp) * 100)}%;background:#e2574c"></i></div>` +
    `<div class="bar"><i style="width:${(p.xp / p.xpToNext) * 100}%;background:#4fd1ff"></i></div>`;
  hudLog.innerHTML = log.slice(-5).join("<br>");
  if (s.status !== "playing") {
    hudLog.innerHTML +=
      `<br><b style="color:${s.status === "won" ? "#5fd08a" : "#e2574c"}">` +
      `${s.status === "won" ? "YOU ESCAPED" : "YOU DIED"} — press R for a new run</b>`;
  }
}

let lastFloor = state.floor;
let lastStatus = state.status;
let saveAcc = 0;
let prev = performance.now();
let acc = 0;

async function main(): Promise<void> {
  await renderer.init();

  function frame(now: number): void {
    let dt = (now - prev) / 1000;
    prev = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    acc += dt;

    // Player is centered by the follow-camera; attacks use movement facing (no
    // screen->iso aim mapping for the slice), so skip mouse aim here.
    const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    while (acc >= SIM_DT) {
      step(state, input.sample(center, false), SIM_DT);
      for (const e of state.events) log.push(e);
      acc -= SIM_DT;
      if (state.floor !== lastFloor) { lastFloor = state.floor; saveRun(state); }
      if (state.status !== lastStatus) { lastStatus = state.status; saveRun(state); }
    }

    saveAcc += dt;
    if (saveAcc > 3 && state.status === "playing") { saveAcc = 0; saveRun(state); }

    renderer.update(state, now / 1000);
    renderer.render();
    updateHud(state);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
