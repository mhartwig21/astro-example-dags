import { CONFIG, floorBand } from "../sim/config";
import { Tile, type GameState } from "../sim/types";
import { knows, novaParams, orbitBladePos, orbitParams } from "../sim/abilities";
import { tileableFogNoise } from "./fogNoise";

const T = CONFIG.tile;

// ---- Fog of war: unknown space is a rolling fog bank, not raw void ----
// A tileable noise pattern (band-tinted) drifts in two parallax layers under
// the map; explored tiles paint over it, and frontier tiles get a translucent
// wash so the boundary reads as haze instead of a hard tile edge.
const FOG_PAT_SIZE = 192;
const FOG_BASE = "#07080d";
// Murk tint per floor band (matches BAND_PALETTES below).
const FOG_TINTS: [number, number, number][] = [
  [86, 93, 122], // undercroft
  [76, 100, 80], // sewers
  [104, 98, 68], // garden
  [108, 88, 70], // ruins
  [76, 92, 118], // ironworks
  [112, 74, 82], // approach
];
let fogNoise: Float32Array | null = null;
const fogPatterns = new Map<number, CanvasPattern>();

function fogPattern(ctx: CanvasRenderingContext2D, band: number): CanvasPattern | null {
  const cached = fogPatterns.get(band);
  if (cached) return cached;
  fogNoise ??= tileableFogNoise(FOG_PAT_SIZE, 0xf09b17);
  const c = document.createElement("canvas");
  c.width = c.height = FOG_PAT_SIZE;
  const g = c.getContext("2d");
  if (!g) return null;
  const img = g.createImageData(FOG_PAT_SIZE, FOG_PAT_SIZE);
  const [r, gr, b] = FOG_TINTS[band];
  for (let i = 0; i < fogNoise.length; i++) {
    const n = fogNoise[i];
    const depth = 0.5 + 0.5 * n; // darker in the troughs, brighter billow crests
    img.data[i * 4] = Math.round(r * depth);
    img.data[i * 4 + 1] = Math.round(gr * depth);
    img.data[i * 4 + 2] = Math.round(b * depth);
    img.data[i * 4 + 3] = Math.round(255 * (0.35 + 0.6 * n));
  }
  g.putImageData(img, 0, 0);
  const pat = ctx.createPattern(c, "repeat");
  if (pat) fogPatterns.set(band, pat);
  return pat;
}

/** One drifting, world-anchored fog layer over the whole viewport. */
function drawFogLayer(
  ctx: CanvasRenderingContext2D,
  pat: CanvasPattern,
  tx: number,
  ty: number,
  scale: number,
  alpha: number,
  w: number,
  h: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(tx, ty);
  ctx.scale(scale, scale);
  ctx.fillStyle = pat;
  ctx.fillRect(-tx / scale, -ty / scale, w / scale, h / scale);
  ctx.restore();
}

// Per-band palettes (bands shift every 3 floors; see FLOOR_BANDS in config).
const BAND_PALETTES = [
  { floor: "#22222f", floorAlt: "#26263a", wall: "#12121c", wallEdge: "#1e1e2e" }, // undercroft
  { floor: "#1e2a1c", floorAlt: "#243524", wall: "#101a10", wallEdge: "#1c2c1c" }, // sewers
  { floor: "#262c16", floorAlt: "#2e361a", wall: "#171410", wallEdge: "#26221a" }, // garden
  { floor: "#2e2218", floorAlt: "#382a1c", wall: "#1a120c", wallEdge: "#2c1e14" }, // ruins
  { floor: "#1c2432", floorAlt: "#202c3e", wall: "#10141e", wallEdge: "#1c2432" }, // ironworks
  { floor: "#2e1a1c", floorAlt: "#382024", wall: "#1a0e10", wallEdge: "#2c181c" }, // approach
];

const COLORS = {
  wall: "#12121c",
  wallEdge: "#1e1e2e",
  floor: "#22222f",
  floorAlt: "#26263a",
  stairs: "#c9a24b",
  door: "#d4af37",
  player: "#4fd1ff",
  playerSwing: "#eaf6ff",
  monster: "#e2574c",
  monsterFlash: "#ffd2cd",
  monsterWindup: "#ff9a3c", // committed to an attack (telegraph)
  monsterStagger: "#8a8aa0", // interrupted and helpless
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
  const p = state.players[0].pos;
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
  const offX = viewW / 2 - cam.x * T;
  const offY = viewH / 2 - cam.y * T;

  const { map } = state;

  // Fog bank first; explored tiles paint over it below. Offsets include the
  // camera so the fog is world-locked, plus a slow time drift so it rolls.
  const band = floorBand(state.floor);
  ctx.fillStyle = FOG_BASE;
  ctx.fillRect(0, 0, viewW, viewH);
  const fogPat = fogPattern(ctx, band);
  if (fogPat) {
    const ft = performance.now() / 1000;
    drawFogLayer(ctx, fogPat, offX + ft * 4.5, offY + ft * 2.8, 1, 0.55, viewW, viewH);
    drawFogLayer(ctx, fogPat, offX - ft * 6.5, offY + ft * 3.8, 1.9, 0.4, viewW, viewH);
  }

  // Visible tile range.
  const minX = Math.max(0, Math.floor(cam.x - viewW / 2 / T) - 1);
  const maxX = Math.min(map.w - 1, Math.ceil(cam.x + viewW / 2 / T) + 1);
  const minY = Math.max(0, Math.floor(cam.y - viewH / 2 / T) - 1);
  const maxY = Math.min(map.h - 1, Math.ceil(cam.y + viewH / 2 / T) + 1);

  const vis2 = CONFIG.fogVisionRadius * CONFIG.fogVisionRadius;
  const inVision = (wx: number, wy: number): boolean => {
    for (const pl of state.players) {
      if (!pl.alive) continue;
      const dx = wx - pl.pos.x, dy = wy - pl.pos.y;
      if (dx * dx + dy * dy <= vis2) return true;
    }
    return false;
  };

  const pal = BAND_PALETTES[band];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!state.explored[y * map.w + x]) continue; // fog of war
      const t = map.tiles[y * map.w + x] as Tile;
      const px = Math.round(offX + x * T);
      const py = Math.round(offY + y * T);
      if (t === Tile.Wall) {
        ctx.fillStyle = pal.wall;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = pal.wallEdge;
        ctx.fillRect(px, py, T, 3);
      } else if (t === Tile.StairsDown) {
        ctx.fillStyle = COLORS.stairs;
        ctx.fillRect(px + 3, py + 3, T - 6, T - 6);
        ctx.fillStyle = "#0a0a0f";
        for (let i = 0; i < 3; i++) ctx.fillRect(px + 6, py + 8 + i * 6, T - 12, 3);
      } else if (t === Tile.DoorLocked) {
        // Locked door: gold slab with a dark keyhole.
        ctx.fillStyle = COLORS.wall;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = COLORS.door;
        ctx.fillRect(px + 2, py + 1, T - 4, T - 2);
        ctx.fillStyle = "#0a0a0f";
        ctx.fillRect(px + T / 2 - 2, py + T / 2 - 4, 4, 4);
        ctx.fillRect(px + T / 2 - 1, py + T / 2, 2, 5);
      } else {
        ctx.fillStyle = (x + y) % 2 === 0 ? pal.floor : pal.floorAlt;
        ctx.fillRect(px, py, T, T);
      }
    }
  }

  // Frontier haze: explored tiles that border fog get a translucent wash so
  // the reveal boundary bleeds instead of snapping at tile edges.
  const [fr, fg, fb] = FOG_TINTS[band];
  ctx.fillStyle = `rgba(${fr},${fg},${fb},0.28)`;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * map.w + x;
      if (!state.explored[i]) continue;
      const foggy =
        (x > 0 && !state.explored[i - 1]) || (x < map.w - 1 && !state.explored[i + 1]) ||
        (y > 0 && !state.explored[i - map.w]) || (y < map.h - 1 && !state.explored[i + map.w]);
      if (foggy) ctx.fillRect(Math.round(offX + x * T), Math.round(offY + y * T), T, T);
    }
  }

  // Ground hazards: volatile blast rings brighten toward detonation; spitter
  // acid puddles render filled and fade as they dry; boss sludge/roots zones
  // ghost through their arming telegraph, then snap solid when live.
  for (const hz of state.hazards) {
    if (!inVision(hz.pos.x, hz.pos.y)) continue;
    if (hz.kind === "beam" && hz.end) {
      // Beam: a line pos->end — faint while arming, hot for the firing flash.
      const alpha = hz.fired
        ? Math.min(1, 0.4 + hz.t / Math.max(hz.total, 1e-3))
        : 0.15 + 0.35 * ((hz.total - hz.t) / Math.max(hz.arm ?? 1, 1e-3));
      ctx.strokeStyle = `rgba(255,90,60,${alpha})`;
      ctx.lineWidth = Math.max(2, hz.radius * 2 * T * (hz.fired ? 1 : 0.4));
      ctx.beginPath();
      ctx.moveTo(offX + hz.pos.x * T, offY + hz.pos.y * T);
      ctx.lineTo(offX + hz.end.x * T, offY + hz.end.y * T);
      ctx.stroke();
      continue;
    }
    if (hz.kind === "puddle" || hz.kind === "sludge" || hz.kind === "roots") {
      const arming = (hz.arm ?? 0) > 0 && hz.total - hz.t < (hz.arm ?? 0);
      const life = Math.min(1, hz.t / Math.max(hz.total, 1e-3));
      const alpha = arming ? 0.08 + 0.14 * ((hz.total - hz.t) / Math.max(hz.arm ?? 1, 1e-3)) : 0.18 + life * 0.2;
      const rgb = hz.kind === "sludge" ? "95,112,32" : hz.kind === "roots" ? "46,139,87" : "127,184,50";
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.beginPath();
      ctx.arc(offX + hz.pos.x * T, offY + hz.pos.y * T, hz.radius * T, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const prog = 1 - hz.t / Math.max(hz.total, 1e-3);
    ctx.strokeStyle = `rgba(255,70,40,${0.3 + prog * 0.6})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(offX + hz.pos.x * T, offY + hz.pos.y * T, hz.radius * T, 0, Math.PI * 2);
    ctx.stroke();
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
      l.kind === "key" ? "#ffd23e" :
      l.kind === "shrine" ? "#c58cff" :
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
    // Attack telegraph: a committed monster shows its reach, brightening as the
    // strike approaches (bomber fuse = blast radius; ranged aim = a small dot ring).
    if (m.windup > 0) {
      const prog = 1 - m.windup / Math.max(m.windupTotal, 1e-3);
      const r =
        m.windupKind === "fuse" ? CONFIG.bomberExplodeRadius :
        m.windupKind === "shot" || m.windupKind === "spit" ? 0.5 :
        m.windupKind === "raise" ? 0.7 :
        m.windupKind === "charge" ? 0.9 : m.attackRange + CONFIG.monsterStrikeGrace;
      ctx.strokeStyle = `rgba(255,110,60,${0.25 + prog * 0.6})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, r * T, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle =
      m.hitFlash > 0 ? COLORS.monsterFlash :
      m.stagger > 0 ? COLORS.monsterStagger :
      m.windup > 0 ? COLORS.monsterWindup : COLORS.monster;
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

  // Stunt doubles: a ghost outline of a crawler holding its mark.
  for (const dc of state.decoys ?? []) {
    const dpx = offX + dc.pos.x * T;
    const dpy = offY + dc.pos.y * T;
    ctx.strokeStyle = "rgba(234,246,255,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(dpx, dpy, T * 0.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(234,246,255,0.2)";
    ctx.beginPath();
    ctx.arc(dpx, dpy, T * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }

  // Players (whole party; players[0] is the local one).
  for (const p of state.players) {
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
  // Orbit blades (auto ability). Positions shared with the sim's hit test.
  if (knows(p, "orbit")) {
    const op = orbitParams(p);
    ctx.fillStyle = "#9fe8ff";
    for (let i = 0; i < op.blades; i++) {
      const bp = orbitBladePos(p, i);
      ctx.beginPath();
      ctx.arc(ppx + (bp.x - p.pos.x) * T, ppy + (bp.y - p.pos.y) * T, 4, 0, Math.PI * 2);
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
  }

  drawHud(ctx, state, viewW, viewH, log);
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  viewW: number,
  viewH: number,
  log: string[],
): void {
  const p = state.players[0];
  ctx.textBaseline = "top";
  ctx.font = "14px ui-monospace, monospace";

  // Boss health bar (top center): the nearest introduced, living boss/elite.
  let boss: GameState["monsters"][number] | null = null;
  let bossD = 16;
  for (const m of state.monsters) {
    if ((m.kind !== "boss" && !m.elite) || !m.introduced || m.hp <= 0) continue;
    const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
    if (d < bossD) { bossD = d; boss = m; }
  }
  if (boss) {
    const w = Math.min(420, viewW - 240);
    const x = viewW / 2 - w / 2;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 8, 8, w + 16, 34);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd9c9";
    ctx.fillText(
      `${boss.kind === "boss" ? "☠" : "◆"} ${boss.eliteName ?? "THE FLOOR BOSS"}` +
        (boss.affix ? ` [${boss.affix.toUpperCase()}]` : ""),
      viewW / 2, 12,
    );
    ctx.textAlign = "left";
    ctx.fillStyle = "#000";
    ctx.fillRect(x, 30, w, 8);
    ctx.fillStyle = COLORS.monster;
    ctx.fillRect(x, 30, w * Math.max(0, boss.hp / boss.maxHp), 8);
  }

  // Ringside introduction splash (the sim is frozen while this shows).
  if (state.encounter) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, viewH * 0.3, viewW, 90);
    ctx.textAlign = "center";
    ctx.fillStyle = "#c9a24b";
    ctx.fillText("◆ RINGSIDE INTRODUCTION ◆", viewW / 2, viewH * 0.3 + 12);
    ctx.font = "28px ui-monospace, monospace";
    ctx.fillStyle = "#ffe9c4";
    ctx.fillText(state.encounter.name, viewW / 2, viewH * 0.3 + 34);
    ctx.font = "14px ui-monospace, monospace";
    if (state.encounter.affix) {
      ctx.fillStyle = "#e2574c";
      ctx.fillText(state.encounter.affix.toUpperCase(), viewW / 2, viewH * 0.3 + 68);
    }
    ctx.textAlign = "left";
  }

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
  ctx.fillText(`ATK ${p.attackPower} · MAG ${p.spellPower}`, rx, 70);
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
