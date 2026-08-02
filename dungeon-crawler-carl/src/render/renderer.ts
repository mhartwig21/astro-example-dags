import { CONFIG, floorBand } from "../sim/config";
import { Tile, type GameState } from "../sim/types";

import {
  bulwarkParams, knows, novaParams, orbitBladePos, orbitHurlPoint, orbitParams,
} from "../sim/abilities";
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
  // ABILITIES-V2 parity palette. The 3D host owns fidelity; this host owns
  // TRUTH -- every one of these exists so a V2 ability reads as itself here
  // instead of reading as nothing (or, worse, as its opposite).
  pull: "#8b5cf0", // Collapse's gather
  pin: "#46d2c4", // Stage Cables (rigging teal)
  stay: "#e0402e", // Injunction (court crimson)
  brace: "#8fb6e8", // Bulwark (cold plate steel)
  fissure: "#c2683a", // Fault Line's broken ground
  barrage: "#f2c14e", // Sponsor Barrage's walking cursor
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

    if (hz.kind === "fissure") {
      // FAULT LINE (V2 U1): the GROUND is the ultimate, so it gets a tinted
      // floor RECT -- broken ground is an area you decide not to walk in, and
      // a rect reads as "this square is taken" faster than a soft blob does.
      // Chasm's blocking core gets a hard inner square (that part is a wall).
      const life = Math.min(1, hz.t / Math.max(hz.total, 1e-3));
      const r = hz.radius * T;
      const cx = offX + hz.pos.x * T, cy = offY + hz.pos.y * T;
      ctx.fillStyle = `rgba(194,104,58,${0.14 + life * 0.2})`;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.strokeStyle = `rgba(255,150,80,${0.35 + life * 0.4})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
      if (hz.blocks) {
        ctx.fillStyle = "rgba(12,8,6,0.75)";
        ctx.fillRect(cx - r * 0.4, cy - r * 0.4, r * 0.8, r * 0.8);
      }
      continue;
    }
    if (hz.kind === "cables" && hz.end) {
      // STAGE CABLES (V2 N2): "nothing crosses this line" is a LINE. Two taut
      // rigging cables at the field's half-width, plus the slow field behind
      // them, so the promise and its footprint are separable at a glance.
      const ax = offX + (hz.pos.x * 2 - hz.end.x) * T, ay = offY + (hz.pos.y * 2 - hz.end.y) * T;
      const bx = offX + hz.end.x * T, by = offY + hz.end.y * T;
      const nx = -(by - ay), ny = bx - ax;
      const nl = Math.hypot(nx, ny) || 1;
      const w = hz.radius * T;
      const ox = (nx / nl) * w, oy = (ny / nl) * w;
      ctx.fillStyle = "rgba(70,210,196,0.10)";
      ctx.beginPath();
      ctx.moveTo(ax + ox, ay + oy);
      ctx.lineTo(bx + ox, by + oy);
      ctx.lineTo(bx - ox, by - oy);
      ctx.lineTo(ax - ox, ay - oy);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(120,245,232,0.85)";
      ctx.lineWidth = 2;
      for (const s of [0.55, -0.55]) {
        ctx.beginPath();
        ctx.moveTo(ax + ox * s, ay + oy * s);
        ctx.lineTo(bx + ox * s, by + oy * s);
        ctx.stroke();
      }
      continue;
    }
    if (hz.kind === "puddle" || hz.kind === "sludge" || hz.kind === "roots" || hz.kind === "shards" || hz.kind === "consecrate") {
      const arming = (hz.arm ?? 0) > 0 && hz.total - hz.t < (hz.arm ?? 0);
      const life = Math.min(1, hz.t / Math.max(hz.total, 1e-3));
      const alpha = arming ? 0.08 + 0.14 * ((hz.total - hz.t) / Math.max(hz.arm ?? 1, 1e-3)) : 0.18 + life * 0.2;
      const rgb =
        hz.kind === "sludge" ? "95,112,32" :
        hz.kind === "roots" ? "46,139,87" :
        hz.kind === "shards" ? "184,176,160" :
        hz.kind === "consecrate" ? "232,201,106" : "127,184,50";
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

  // Extradition chains: this frame's "chain" hits as one-frame truth lines
  // (the 2D host draws no other hit feedback; this view is for debugging).
  for (const h of state.hits) {
    if (h.kind !== "chain" || !h.to) continue;
    ctx.strokeStyle = "rgba(170,178,189,0.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]); // dashed = links
    ctx.beginPath();
    ctx.moveTo(offX + h.pos.x * T, offY + h.pos.y * T);
    ctx.lineTo(offX + h.to.x * T, offY + h.to.y * T);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Projectiles.
  for (const pr of state.projectiles) {
    if (!inVision(pr.pos.x, pr.pos.y)) continue;
    ctx.fillStyle = pr.from === "player" ? "#6fe3ff" : "#ff8a3c";
    ctx.beginPath();
    ctx.arc(offX + pr.pos.x * T, offY + pr.pos.y * T, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Smashable dressing (phase 5): little brown crates on the truth view.
  for (const b of state.breakables ?? []) {
    if (!inVision(b.pos.x, b.pos.y)) continue;
    // Damaged blocking furniture reads darker (one hit from gone).
    ctx.fillStyle = b.footprint && b.hp === 1 ? "#6e4522" : "#a06a3a";
    const bs = b.footprint ? 8 : 4; // furniture fills more of its tile
    ctx.fillRect(offX + b.pos.x * T - bs, offY + b.pos.y * T - bs, bs * 2, bs * 2);
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
      l.kind === "service" ? "#c9a24b" :
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
    // INJUNCTION's enrage (V2 N3): the crawler bought twelve violent seconds,
    // so the bodies collecting on it are visibly the violent ones -- a crimson
    // wash over the whole body, on EVERY enraged monster, for the duration.
    if ((m.injRageT ?? 0) > 0) {
      ctx.fillStyle = "rgba(224,64,46,0.45)";
      ctx.beginPath();
      ctx.arc(px, py, T * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,224,216,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, T * 0.36, 0, Math.PI * 2);
      ctx.stroke();
    }
    // PINNED (Stage Cables): control you cannot see is control you cannot plan
    // around -- and this pin deliberately lets windups resolve, so the player
    // has to tell "pinned but winding up" from "free and closing" inside 0.2s.
    // A HARD SHACKLE (four bracket posts on a taut ring) is deliberately a
    // different shape from stagger's grey helpless body: the pin is control,
    // not a stun, and the two must not read the same.
    if ((m.pinnedT ?? 0) > 0) {
      const rr = T * 0.44;
      ctx.strokeStyle = COLORS.pin;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.stroke();
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const cxp = px + Math.cos(a) * rr, cyp = py + Math.sin(a) * rr;
        ctx.beginPath();
        ctx.moveTo(cxp - Math.cos(a) * 4, cyp - Math.sin(a) * 4);
        ctx.lineTo(cxp + Math.cos(a) * 4, cyp + Math.sin(a) * 4);
        ctx.stroke();
      }
    }
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
    // V2 R8: the double is MORTAL, so its remaining life is a SHRINKING PIP.
    // A decoy that can die but looks immortal is the roster's biggest lie
    // rendered as the truth it replaced. (Pre-rework decoys carry no hp and
    // keep the old solid fill -- they really are invulnerable.)
    const frac = dc.maxHp ? Math.max(0, (dc.hp ?? 0) / dc.maxHp) : 1;
    ctx.fillStyle = `rgba(234,246,255,${0.08 + 0.14 * frac})`;
    ctx.beginPath();
    ctx.arc(dpx, dpy, T * 0.32 * (dc.maxHp ? 0.35 + 0.65 * frac : 1), 0, Math.PI * 2);
    ctx.fill();
    if (dc.maxHp) {
      ctx.fillStyle = "#000";
      ctx.fillRect(dpx - 10, dpy - T * 0.5, 20, 3);
      ctx.fillStyle = "rgba(234,246,255,0.9)";
      ctx.fillRect(dpx - 10, dpy - T * 0.5, 20 * frac, 3);
    }
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

  // Orbit blades (auto ability). Positions shared with the sim's hit test --
  // and, since V2 R3, with the HURL: orbitBladePos returns the travelling saw
  // while the ring is away, so the space around the crawler reads empty for
  // exactly as long as the sim says the bodyguard is spent.
  if (knows(p, "orbit")) {
    const op = orbitParams(p);
    const hurl = orbitHurlPoint(p);
    if (hurl) {
      // The flight line: where the steel went, and that it is coming back.
      ctx.strokeStyle = hurl.back ? "rgba(216,246,255,0.75)" : "rgba(159,232,255,0.5)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(ppx, ppy);
      ctx.lineTo(offX + hurl.x * T, offY + hurl.y * T);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = hurl ? "#d8f6ff" : "#9fe8ff";
    for (let i = 0; i < op.blades; i++) {
      const bp = orbitBladePos(p, i);
      ctx.beginPath();
      ctx.arc(offX + bp.x * T, offY + bp.y * T, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // COLLAPSE's gather (V2 R1): a FLAT RING at the gather radius that closes
  // inward, drawn before the blast ring expands out of it. The whole point of
  // the rework is that the cast moves bodies first; a host that only draws the
  // blast is drawing the ability it replaced.
  if (p.novaFlash > 0) {
    const np = novaParams(p);
    const prog = 1 - p.novaFlash / 0.3;
    ctx.strokeStyle = `rgba(139,92,240,${0.85 * (1 - prog)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ppx, ppy, np.gatherRadius * (1 - prog * 0.75) * T, 0, Math.PI * 2);
    ctx.stroke();
    // Inward tick marks: the ring is PULLING, not just shrinking.
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const r0 = np.gatherRadius * (1 - prog * 0.75) * T;
      ctx.beginPath();
      ctx.moveTo(ppx + Math.cos(a) * r0, ppy + Math.sin(a) * r0);
      ctx.lineTo(ppx + Math.cos(a) * (r0 - 7), ppy + Math.sin(a) * (r0 - 7));
      ctx.stroke();
    }
    // ...then the blast.
    ctx.strokeStyle = `rgba(143,216,255,${1 - prog})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ppx, ppy, np.radius * prog * T, 0, Math.PI * 2);
    ctx.stroke();
  }
  // BULWARK (V2 N1): a brace arc in the facing direction while the plate is up.
  if ((p.bulwarkT ?? 0) > 0) {
    const bp2 = bulwarkParams(p);
    const ang = Math.atan2(p.facing.y, p.facing.x);
    ctx.strokeStyle = COLORS.brace;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(ppx, ppy, T * 0.55, ang - 0.9, ang + 0.9);
    ctx.stroke();
    if (bp2.allyRadius > 0) {
      ctx.strokeStyle = "rgba(143,182,232,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ppx, ppy, bp2.allyRadius * T, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // SPONSOR BARRAGE (V2 U2): a CURSOR DOT at the aim point, tethered to the
  // crawler. The channel is 3s of not-fighting at 70% move speed, so the one
  // thing the host owes the player is "here is what you are paying for."
  if ((p.barrageT ?? 0) > 0 && p.barrageAim) {
    const bx = offX + p.barrageAim.x * T, by = offY + p.barrageAim.y * T;
    ctx.strokeStyle = "rgba(242,193,78,0.45)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(ppx, ppy);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.barrage;
    ctx.beginPath();
    ctx.arc(bx, by, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.barrage;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, 11, 0, Math.PI * 2);
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

  // INJUNCTION (V2 N3): a clock that silently stops is a tell only for someone
  // already staring at it. While the stay holds, the clock says so -- and it
  // says what it will cost, because the debt is the other half of the button.
  const stay = p.injunctionT ?? 0;
  ctx.fillStyle = stay > 0 ? COLORS.stay : phaseColor(state);
  ctx.fillText(
    stay > 0
      ? `STAYED ${fmtTime(state.timeRemaining)}  [${stay.toFixed(1)}s · owes ${Math.round(p.injunctionDebt ?? 0)}s]`
      : `Collapse in ${fmtTime(state.timeRemaining)}  [${state.phase.toUpperCase()}]`,
    20, 70,
  );
  // Timer bar.
  const frac = Math.max(0, Math.min(1, state.timeRemaining / state.timeBudget));
  ctx.fillStyle = "#000";
  ctx.fillRect(20, 92, 200, 8);
  ctx.fillStyle = stay > 0 ? COLORS.stay : phaseColor(state);
  ctx.fillRect(20, 92, 200 * frac, 8);
  if (stay > 0) {
    // The debt, drawn as the slice of bar that is already spoken for.
    const debt = Math.max(0, Math.min(1, (p.injunctionDebt ?? 0) / Math.max(state.timeBudget, 1e-3)));
    ctx.fillStyle = "rgba(94,12,7,0.85)";
    ctx.fillRect(20 + 200 * Math.max(0, frac - debt), 92, 200 * Math.min(frac, debt), 8);
  }

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
