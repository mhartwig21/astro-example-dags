import { CONFIG } from "../sim/config";
import { Tile, type GameState } from "../sim/types";
import { knows, novaParams, orbitParams } from "../sim/abilities";

const T = CONFIG.tile;

const COLORS = {
  wall: "#12121c",
  wallEdge: "#1e1e2e",
  floor: "#22222f",
  floorAlt: "#26263a",
  stairs: "#c9a24b",
  player: "#4fd1ff",
  playerSwing: "#eaf6ff",
  monster: "#e2574c",
  monsterFlash: "#ffd2cd",
  gold: "#f2c14e",
  heal: "#5fd08a",
  weapon: "#b98bff",
};

export interface Camera {
  x: number;
  y: number;
}

/** Center the camera on the player, clamped to the map bounds. */
export function updateCamera(cam: Camera, state: GameState, viewW: number, viewH: number): void {
  const p = state.player.pos;
  const halfW = viewW / 2 / T;
  const halfH = viewH / 2 / T;
  cam.x = Math.max(halfW, Math.min(state.map.w - halfW, p.x));
  cam.y = Math.max(halfH, Math.min(state.map.h - halfH, p.y));
}

function phaseColor(state: GameState): string {
  switch (state.phase) {
    case "safe":
      return "#5fd08a";
    case "warning":
      return "#f2c14e";
    case "collapse":
      return "#e2574c";
  }
}

function fmtTime(s: number): string {
  const clamped = Math.max(0, s);
  const m = Math.floor(clamped / 60);
  const sec = Math.floor(clamped % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function render(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  cam: Camera,
  viewW: number,
  viewH: number,
  log: string[],
): void {
  ctx.clearRect(0, 0, viewW, viewH);

  const offX = viewW / 2 - cam.x * T;
  const offY = viewH / 2 - cam.y * T;

  const { map } = state;

  // Visible tile range.
  const minX = Math.max(0, Math.floor(cam.x - viewW / 2 / T) - 1);
  const maxX = Math.min(map.w - 1, Math.ceil(cam.x + viewW / 2 / T) + 1);
  const minY = Math.max(0, Math.floor(cam.y - viewH / 2 / T) - 1);
  const maxY = Math.min(map.h - 1, Math.ceil(cam.y + viewH / 2 / T) + 1);

  const vis2 = CONFIG.fogVisionRadius * CONFIG.fogVisionRadius;
  const inVision = (wx: number, wy: number): boolean => {
    const dx = wx - state.player.pos.x, dy = wy - state.player.pos.y;
    return dx * dx + dy * dy <= vis2;
  };

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!state.explored[y * map.w + x]) continue; // fog of war
      const t = map.tiles[y * map.w + x] as Tile;
      const px = Math.round(offX + x * T);
      const py = Math.round(offY + y * T);
      if (t === Tile.Wall) {
        ctx.fillStyle = COLORS.wall;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = COLORS.wallEdge;
        ctx.fillRect(px, py, T, 3);
      } else if (t === Tile.StairsDown) {
        ctx.fillStyle = COLORS.stairs;
        ctx.fillRect(px + 3, py + 3, T - 6, T - 6);
        ctx.fillStyle = "#0a0a0f";
        for (let i = 0; i < 3; i++) ctx.fillRect(px + 6, py + 8 + i * 6, T - 12, 3);
      } else {
        ctx.fillStyle = (x + y) % 2 === 0 ? COLORS.floor : COLORS.floorAlt;
        ctx.fillRect(px, py, T, T);
      }
    }
  }

  // Projectiles.
  for (const pr of state.projectiles) {
    if (!inVision(pr.pos.x, pr.pos.y)) continue;
    ctx.fillStyle = pr.from === "player" ? "#6fe3ff" : "#ff8a3c";
    ctx.beginPath();
    ctx.arc(offX + pr.pos.x * T, offY + pr.pos.y * T, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Loot.
  for (const l of state.loot) {
    if (!inVision(l.pos.x, l.pos.y)) continue;
    const px = offX + l.pos.x * T;
    const py = offY + l.pos.y * T;
    ctx.fillStyle =
      l.kind === "tome" ? "#66f0c8" :
      l.kind === "gold" ? COLORS.gold : l.kind === "heal" ? COLORS.heal : COLORS.weapon;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Monsters.
  for (const m of state.monsters) {
    if (!inVision(m.pos.x, m.pos.y)) continue;
    const px = offX + m.pos.x * T;
    const py = offY + m.pos.y * T;
    ctx.fillStyle = m.hitFlash > 0 ? COLORS.monsterFlash : COLORS.monster;
    ctx.beginPath();
    ctx.arc(px, py, T * 0.32, 0, Math.PI * 2);
    ctx.fill();
    // HP bar.
    const frac = Math.max(0, m.hp / m.maxHp);
    ctx.fillStyle = "#000";
    ctx.fillRect(px - 12, py - T * 0.5, 24, 4);
    ctx.fillStyle = COLORS.monster;
    ctx.fillRect(px - 12, py - T * 0.5, 24 * frac, 4);
  }

  // Player.
  const p = state.player;
  const ppx = offX + p.pos.x * T;
  const ppy = offY + p.pos.y * T;
  // Attack swing indicator (arc in facing direction).
  if (p.attackSwing > 0) {
    const ang = Math.atan2(p.facing.y, p.facing.x);
    const arc = CONFIG.playerAttackArc;
    ctx.fillStyle = "rgba(234,246,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(ppx, ppy);
    ctx.arc(ppx, ppy, CONFIG.playerAttackRange * T, ang - arc / 2, ang + arc / 2);
    ctx.closePath();
    ctx.fill();
  }
  // Orbit blades (auto ability).
  if (knows(p, "orbit")) {
    const op = orbitParams(p);
    ctx.fillStyle = "#9fe8ff";
    for (let i = 0; i < op.blades; i++) {
      const a = p.orbitAngle + (i * Math.PI * 2) / op.blades;
      ctx.beginPath();
      ctx.arc(ppx + Math.cos(a) * op.radius * T, ppy + Math.sin(a) * op.radius * T, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Nova ring.
  if (p.novaFlash > 0) {
    const np = novaParams(p);
    const prog = 1 - p.novaFlash / 0.3;
    ctx.strokeStyle = `rgba(143,216,255,${1 - prog})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ppx, ppy, np.radius * prog * T, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = p.alive ? COLORS.player : "#555";
  ctx.beginPath();
  ctx.arc(ppx, ppy, T * 0.34, 0, Math.PI * 2);
  ctx.fill();
  // Facing tick.
  ctx.strokeStyle = COLORS.playerSwing;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ppx, ppy);
  ctx.lineTo(ppx + p.facing.x * T * 0.5, ppy + p.facing.y * T * 0.5);
  ctx.stroke();

  drawHud(ctx, state, viewW, viewH, log);
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewW: number,
  viewH: number,
  log: string[],
): void {
  const p = state.player;
  ctx.textBaseline = "top";
  ctx.font = "14px ui-monospace, monospace";

  // Top-left: floor + timer.
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(10, 40, 220, 74);
  ctx.fillStyle = "#e6e6ec";
  ctx.fillText(`Floor ${state.floor} / ${CONFIG.finalFloor}`, 20, 48);
  ctx.fillStyle = phaseColor(state);
  ctx.fillText(`Collapse in ${fmtTime(state.timeRemaining)}  [${state.phase.toUpperCase()}]`, 20, 70);
  // Timer bar.
  const frac = Math.max(0, Math.min(1, state.timeRemaining / state.timeBudget));
  ctx.fillStyle = "#000";
  ctx.fillRect(20, 92, 200, 8);
  ctx.fillStyle = phaseColor(state);
  ctx.fillRect(20, 92, 200 * frac, 8);

  // Top-right: character stats.
  const rx = viewW - 210;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(rx - 10, 40, 210, 92);
  ctx.fillStyle = "#e6e6ec";
  ctx.fillText(`Level ${p.level}   ${p.gold} gold`, rx, 48);
  ctx.fillText(`DMG ${p.baseDamage}`, rx, 70);
  // HP bar.
  ctx.fillStyle = "#000";
  ctx.fillRect(rx, 92, 190, 10);
  ctx.fillStyle = "#e2574c";
  ctx.fillRect(rx, 92, 190 * Math.max(0, p.hp / p.maxHp), 10);
  ctx.fillStyle = "#fff";
  ctx.fillText(`${Math.ceil(p.hp)} / ${p.maxHp}`, rx + 4, 104);
  // XP bar.
  ctx.fillStyle = "#000";
  ctx.fillRect(rx, 120, 190, 5);
  ctx.fillStyle = "#4fd1ff";
  ctx.fillRect(rx, 120, 190 * Math.max(0, p.xp / p.xpToNext), 5);

  // Event log (bottom-left).
  ctx.font = "13px ui-monospace, monospace";
  const shown = log.slice(-5);
  for (let i = 0; i < shown.length; i++) {
    const alpha = 0.4 + (i / shown.length) * 0.6;
    ctx.fillStyle = `rgba(230,230,236,${alpha})`;
    ctx.fillText(shown[i], 20, viewH - 20 - (shown.length - i) * 18);
  }

  // Game-over / win overlay.
  if (state.status !== "playing") {
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.textAlign = "center";
    ctx.font = "34px ui-monospace, monospace";
    ctx.fillStyle = state.status === "won" ? "#5fd08a" : "#e2574c";
    const title = state.status === "won" ? "YOU ESCAPED THE DUNGEON" : "YOU DIED";
    ctx.fillText(title, viewW / 2, viewH / 2 - 30);
    ctx.font = "16px ui-monospace, monospace";
    ctx.fillStyle = "#e6e6ec";
    ctx.fillText(`Reached floor ${state.floor} · level ${p.level} · ${p.gold} gold`, viewW / 2, viewH / 2 + 10);
    ctx.fillText("Press R to start a new run", viewW / 2, viewH / 2 + 36);
    ctx.textAlign = "left";
  }
}
