import * as THREE from "three";

import type { BossEvent, GameState, Monster } from "../sim/types";
import {
  ASK_PAL, bossFamily, signatureFor,
  type BossPalette,
} from "./bossSignatures";
import { GroundDecals, Shockwaves, TELEGRAPH_GEO } from "./fx";
import { FxParticles } from "./fxParticles";

// ===========================================================================
// BOSSES V2 §5 — the ENCOUNTER as an event, on the presentation side.
//
// The sim ships DATA (state.bossEvents, Monster.plates/shieldHp/tetherId/...).
// This module is the only place that turns that data into spectacle, so the
// 7k-line renderer keeps owning the world and this owns the fight.
//
// The signature TABLE (which hue, which primitive, which pitch per boss) lives
// next door in bossSignatures.ts, which imports nothing but types — the audio
// director needs the same table and must not pull three.js in to get it.
// Everything below is the part that needs a GPU.
//
// THE READABILITY CONTRACT, which outranks every other rule in this file:
//   1. Every telegraph parses in 0.2s. That means SHAPE first (a lane is a
//      lane, a shield is a shell, a punish is a vertical column), hue second.
//   2. Nothing here is a recolored nova. The nova is a ground ring that
//      EXPANDS. Every primitive below moves differently on purpose: the
//      shield is a fresnel shell that cracks, the tether is a cord with a
//      travelling feed pulse, the punish beacon is a converging COLUMN, and
//      the arena warning is a ring that CONTRACTS. If a player can confuse
//      two of them at a glance, the shape is wrong — not the color.
//   3. Nothing here borrows a floor hue. Every emissive runs 1.4-3x over
//      white at its peak so the bloom pass lifts it off any biome palette.
//   4. Exposure is part of readability. These are ADDITIVE, arena-scale, and
//      they stack with a boss that already carries its own light — every beat
//      below has a stated brightness budget, and the read comes from motion.
// ===========================================================================

// Re-exported so callers that only want the shaders keep one import.
export * from "./bossSignatures";

// ===========================================================================
// SHADERS. Five new primitives, each with a MOTION no other primitive in the
// game uses — that is what buys the 0.2s read, not the palette.
// ===========================================================================

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const VERT_WORLD = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

// ---------------------------------------------------------------------------
// SHIELD SHELL (V2 — break-the-shield). A fresnel-lit hexagonal lattice
// wrapped on the boss. NOT a ring and NOT a bubble of flat alpha: the cells
// are visible, the rim burns, and as the pool drains the cells GO DARK from
// the equator up while stress cracks open — so "how much shield is left" is
// legible from the shell itself, not only from the plate at the top of the
// screen. The lattice hue tracks `shieldSchool` for The Sponsor's school
// lock, whose entire ask is "which school works right now".
// ---------------------------------------------------------------------------
const SHIELD_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uFill;   // 1 full pool -> 0 empty
  uniform float uHit;    // 0..1 recent-damage flash
  uniform float uDim;    // MEASURED exposure governor (see BossFx.exposureScale)
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vView;
  float shH(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
  float hexCell(vec2 p, out vec2 id) {
    vec2 s = vec2(1.0, 1.7320508);
    vec2 a = mod(p, s) - s * 0.5;
    vec2 b = mod(p - s * 0.5, s) - s * 0.5;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    id = p - g;
    return 0.5 - max(abs(g.x) * 0.866 + g.y * 0.5, -g.y);
  }
  void main() {
    float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0), 2.2);
    vec2 id;
    // The lattice DRIFTS around the body: a live field, never a decal.
    float d = hexCell(vec2(vUv.x * 22.0 + uTime * 0.35, vUv.y * 13.0), id);
    float wall = smoothstep(0.14, 0.0, d);
    float lit = shH(id * 0.31);
    // Cells die from the BOTTOM UP as the pool drains, so the crown stays
    // readable while the shield is nearly gone.
    float death = smoothstep(uFill + 0.14, uFill - 0.06, vUv.y * 0.72 + lit * 0.28);
    float alive = 1.0 - death;
    float crack = smoothstep(0.42, 0.5, abs(fract(lit * 9.0 + uTime * 0.2) - 0.5)) * death;
    float breathe = 0.72 + 0.28 * sin(uTime * 3.1 + lit * 6.28);
    float body = fres * (0.16 + 0.2 * alive) * breathe;
    float latt = wall * (0.1 + 0.6 * alive) * (0.7 + 0.5 * fres);
    float a = clamp(body + latt + crack * 0.35 + uHit * fres * 0.7, 0.0, 0.86) * uDim;
    vec3 col = mix(uColor, uCore, clamp(latt * 1.6 + uHit, 0.0, 1.0))
             * (1.1 + 1.9 * latt + 2.4 * uHit + 0.7 * fres);
    col = mix(col * 0.25, col, alive); // dead cells go to ash
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makeShieldMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(ASK_PAL.shield.mid) },
      uCore: { value: new THREE.Color(ASK_PAL.shield.core) },
      uTime: { value: 0 }, uFill: { value: 1 }, uHit: { value: 0 },
      uDim: { value: 1 },
    },
    vertexShader: VERT_WORLD,
    fragmentShader: SHIELD_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// TETHER CORD (V8 — adds with a JOB). A strip between an add and the boss
// with pulses that TRAVEL TOWARD THE BOSS, so the direction of the theft is
// visible: the wave moving up the cord is the boss's health bar refilling. A
// static line would read as decoration; the motion IS the mechanic.
// ---------------------------------------------------------------------------
const TETHER_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uLen;
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    float cross = abs(vUv.y - 0.5) * 2.0;
    float core = smoothstep(0.55, 0.0, cross);
    float sheath = smoothstep(1.0, 0.25, cross);
    // FEED PULSES travelling add -> boss (uv.x 0 at the add, 1 at the boss).
    float travel = fract(vUv.x * max(uLen, 1.0) * 0.5 - uTime * 1.15);
    float pulse = smoothstep(0.86, 1.0, travel) * smoothstep(0.4, 0.0, cross);
    float wob = 0.82 + 0.18 * sin(vUv.x * 9.0 - uTime * 4.0);
    float a = clamp((core * 0.55 + sheath * 0.16 + pulse * 0.9) * wob, 0.0, 0.9) * uDim;
    vec3 col = mix(uColor, uCore, clamp(core * 0.6 + pulse, 0.0, 1.0))
             * (1.2 + 2.6 * pulse + 1.1 * core);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makeTetherMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(ASK_PAL.adds.mid) },
      uCore: { value: new THREE.Color(ASK_PAL.adds.core) },
      uTime: { value: 0 }, uLen: { value: 4 }, uDim: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: TETHER_FRAG,
    transparent: true,
    depthWrite: false,
    // Draws OVER the crowd on purpose. A feed cord is a kill-order indicator
    // (LoL/D4 tether rules): the whole reason it exists is that four bodies
    // are stacked on the boss and the player has to pick which ones matter —
    // a cord the bodies occlude answers nothing.
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// PUNISH BEACON (V4 — "the one beat that most needs to read", §7.4). The boss
// over-commits and is briefly helpless. A vertical COLUMN with chevrons
// marching DOWNWARD onto the exposed core: the only downward-converging
// motion in the game, so it can never be confused with a nova, a slam or a
// hazard. Gold, because gold is already this game's "this is yours to take"
// (crit, loot, hype).
// ---------------------------------------------------------------------------
const PUNISH_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uLeft;   // 1 window just opened -> 0 closing
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    float cross = abs(vUv.x - 0.5) * 2.0;
    float up = vUv.y;                       // 0 at the boss's feet, 1 overhead
    // CHEVRONS MARCHING DOWN, accelerating as the window closes.
    float march = fract(up * 3.0 + uTime * (1.1 + 1.5 * (1.0 - uLeft)));
    float chev = smoothstep(0.55, 0.98, march) * smoothstep(1.0, 0.25, cross);
    // Body: hottest at the FOOT — that is where you are meant to hit.
    float body = smoothstep(1.0, 0.18, cross) * smoothstep(1.0, 0.0, up) * 0.5;
    // Hard vertical rails, so the column has WALLS and reads as a shaft.
    float rail = smoothstep(0.86, 0.98, cross) * (1.0 - smoothstep(0.99, 1.0, cross));
    // The window running out drains the column FROM THE TOP DOWN, so the
    // shaft is a countdown you read without a number. (First cut had the
    // smoothstep edges the wrong way round, which made the beacon vanish
    // completely at uLeft = 1 — i.e. at the exact instant the window opened,
    // the one frame it exists to sell. Caught in capture review.)
    float drain = smoothstep(uLeft - 0.06, uLeft + 0.04, up);
    // BRIGHTNESS BUDGET (capture review): this is an ADDITIVE shaft, drawn as
    // a crossed pair, standing over a boss that already carries its own light
    // and a ritual circle. At the first tuning it detonated the bloom pass and
    // whited out the whole frame — a beat nobody can see through is not a
    // beat. The read now comes from the chevrons and the rails, which are
    // SHAPE, not from raw exposure.
    // Round 2: even at 0.6 the crossed pair plus the boss's own light plus the
    // ritual circle it stands on was going to white in capture. The chevrons
    // and the rails carry the read; the body is nearly gone.
    float a = clamp((chev * 0.26 + body * 0.07 + rail * 0.34) * (1.0 - drain), 0.0, 0.4) * uDim;
    vec3 col = mix(uColor, uCore, clamp(chev + rail * 0.5, 0.0, 1.0))
             * (0.85 + 1.5 * chev + 1.0 * rail);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makePunishMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(ASK_PAL.window.mid) },
      uCore: { value: new THREE.Color(ASK_PAL.window.core) },
      uTime: { value: 0 }, uLeft: { value: 1 }, uDim: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: PUNISH_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// ARENA BEAT (arena-wide telegraphs + the intermission sweep). A ground ring
// that CONTRACTS toward the center carrying an inward-pointing chevron band.
// Every other ring in this game expands; this one closes, which is exactly
// what "the arena is about to change state" means. Run with uOut = 1 it
// becomes THE COMMERCIAL BREAK's board-clearing sweep instead.
// ---------------------------------------------------------------------------
const ARENA_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;  // 0 -> 1 across the beat
  uniform float uOut;   // 0 contracting warning, 1 expanding sweep
  uniform float uSpoke; // radial spokes: RESERVED, see below
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float front = mix(1.0 - uProg, uProg, uOut);
    float band = smoothstep(0.16, 0.0, abs(r - front));
    float edge = smoothstep(0.045, 0.0, abs(r - front));
    float chev = smoothstep(0.3, 0.95, sin(ang * 24.0 + uTime * 6.0 * mix(-1.0, 1.0, uOut))) * band;
    float swept = mix(smoothstep(front + 0.05, front - 0.35, r),
                      smoothstep(front - 0.05, front + 0.35, r), uOut);
    // THE SPOKES ARE RESERVED (capture review, round 2). A white radial-spoke
    // ring was showing up under the arena, window, shield, storm AND adds asks,
    // which made five different fights read as one fight in five hues. Exactly
    // ONE signature is allowed to draw them now (the Sump King's FLOOD SURGE:
    // the room is changing state, and nothing else may say that). Every other
    // caller passes uSpoke = 0 and gets the travelling front alone.
    float spoke = uSpoke * smoothstep(0.55, 1.0, sin(ang * 12.0 + uTime * 0.6)) * band * 0.35;
    float fade = 1.0 - smoothstep(0.55, 1.0, uProg);
    // EXPOSURE BUDGET (capture review): at arena scale this disc covers most of
    // the screen, and it is ADDITIVE. The first cut filled its interior and
    // detonated the bloom pass — the intermission read as a lens flare with a
    // health bar on it. The beat is the travelling FRONT; everything behind it
    // is a whisper, so the arena stays legible while the board is re-dealt.
    float a = clamp((edge * 0.34 + band * 0.05 + chev * 0.14 + spoke * 0.3) * fade, 0.0, 0.44) * uDim;
    vec3 col = mix(uColor, uCore, clamp(edge * 1.4 + chev, 0.0, 1.0)) * (0.8 + 1.5 * edge + 0.8 * chev);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makeArenaMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(ASK_PAL.arena.mid) },
      uCore: { value: new THREE.Color(ASK_PAL.arena.core) },
      uTime: { value: 0 }, uProg: { value: 0 }, uOut: { value: 0 },
      uSpoke: { value: 0 }, uDim: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: ARENA_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

// ===========================================================================
// THE ASK SILHOUETTES (capture review, round 2).
//
// The finding: seven named signatures spanning the arena, window, shield,
// storm and adds asks all resolved to the same concentric ring plus white
// radial spokes. They differed by HUE. A player cannot learn a fight from a
// hue — §2.3 promises a 0.2s read, and 0.2s is a SHAPE.
//
// So every ask now owns a silhouette that survives being reduced to a black
// and white mask. All five below are ground-plane quads over TELEGRAPH_GEO
// (one draw each, pooled) except the cords and the shell, which are the two
// beats that must own vertical space to say what they say.
// ===========================================================================

// ---------------------------------------------------------------------------
// LANES (the DODGE-THE-LANE ask). Hard chevroned RECTANGLES, uN of them, at
// evenly spaced angles from uAng. Not spokes: a spoke is a hairline that
// starts at the middle, a lane is a bar with WALLS and a marching interior,
// and the whole read is "this strip of floor, not that one".
// ---------------------------------------------------------------------------
const LANES_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;
  uniform float uN;     // lane count
  uniform float uAng;   // first lane's heading
  uniform float uW;     // half width, in disc units
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x) - uAng;
    float seg = 6.28318530718 / max(uN, 1.0);
    // Fold into the nearest lane and measure the PERPENDICULAR distance: that
    // is what makes it a bar of constant width rather than a wedge.
    float k = floor((ang + seg * 0.5) / seg);
    float rel = ang - k * seg;
    float across = abs(sin(rel)) * r;
    float along = cos(rel) * r;
    if (along < 0.0) discard;
    float body = smoothstep(uW, uW * 0.72, across);
    float wall = smoothstep(uW, uW * 0.9, across) * (1.0 - smoothstep(uW * 0.88, uW * 0.74, across));
    // CHEVRONS marching outward down the bar, so the direction is unambiguous.
    float chev = smoothstep(0.4, 0.98,
      fract(along * 2.6 - uTime * 1.9 + abs(across / max(uW, 1e-3)) * 0.55)) * body;
    // The bar EXTENDS as the tell runs: length is the countdown. It reaches the
    // rim by a THIRD of the way through — a lane that is still growing when the
    // hazard lands has not told the player anything (capture review round 2:
    // the first cut was still 2.5 tiles long at the moment of the shot).
    float reach = smoothstep(uProg * 3.2 + 0.1, uProg * 3.2 - 0.14, along);
    float fade = 1.0 - smoothstep(0.66, 1.0, uProg);
    // THE HUB IS CUT OUT (r3 minor). Folding by angle makes every bar's
    // perpendicular distance collapse to zero at the middle, so N lanes merged
    // into one soft star exactly where the eye lands — the shape doc calls for
    // chevroned RECTANGLES and the mask was reading as an X. Punching the hub
    // out separates the bars and the rectangles come back.
    float hub = smoothstep(0.09, 0.24, r);
    float a = clamp((body * 0.3 + wall * 0.9 + chev * 0.55) * reach * fade * hub, 0.0, 0.82) * uDim;
    vec3 col = mix(uColor, uCore, clamp(wall * 1.3 + chev, 0.0, 1.0)) * (0.85 + 1.4 * wall + 1.1 * chev);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

// ---------------------------------------------------------------------------
// PROPS (the USE-THE-ARENA ask). Square brackets clamped around the arena
// objects that matter this beat, with a feed line running out to each from the
// epicenter. Nothing is drawn at the middle at all — the eye is sent to the
// ROOM, which is the entire point of the ask, and the shape is rectangular so
// it cannot be mistaken for any ring in the game.
// ---------------------------------------------------------------------------
const PROPS_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;
  uniform float uCount;
  uniform vec2 uAt[8];   // prop offsets, in disc units
  uniform float uDim;
  varying vec2 vUv;
  float bracket(vec2 q, float s) {
    vec2 a = abs(q);
    float box = max(a.x, a.y);
    // A thick bracket rail: the first cut was a 12px hairline and simply did
    // not survive a lit arena floor (capture review round 2).
    float edge = smoothstep(s * 1.06, s * 0.92, box) * (1.0 - smoothstep(s * 0.9, s * 0.62, box));
    // Corners only: a bracket, never a closed frame.
    float corner = 1.0 - smoothstep(s * 0.34, s * 0.62, min(a.x, a.y));
    return edge * clamp(corner + 0.2, 0.0, 1.0);
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    if (length(p) > 1.0) discard;
    float acc = 0.0;
    float hot = 0.0;
    int n = int(min(uCount, 8.0));
    for (int i = 0; i < 8; i++) {
      if (i >= n) break;
      vec2 at = uAt[i];
      // The bracket CLAMPS shut as the tell runs.
      float s = mix(0.26, 0.13, uProg);
      float b = bracket(p - at, s);
      acc += b;
      // Feed line epicenter -> prop, with a pulse travelling OUT to it.
      vec2 d = at;
      float len = max(length(d), 1e-3);
      vec2 dir = d / len;
      float along = dot(p, dir);
      float across = abs(dot(p, vec2(-dir.y, dir.x)));
      // Kept THIN and dim on purpose: the brackets are the read, and a fat
      // feed line would turn this beat back into the radial starburst the
      // whole round exists to delete.
      float on = step(0.0, along) * step(along, len) * smoothstep(0.022, 0.0, across);
      float pulse = smoothstep(0.68, 1.0, fract(along / len - uTime * 0.9));
      hot += on * (0.18 + 0.9 * pulse);
    }
    float fade = 1.0 - smoothstep(0.7, 1.0, uProg);
    float a = clamp((acc * 0.85 + hot * 0.22) * fade, 0.0, 0.8) * uDim;
    vec3 col = mix(uColor, uCore, clamp(acc * 1.2 + hot, 0.0, 1.0)) * (0.9 + 1.6 * acc + 0.9 * hot);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

// ---------------------------------------------------------------------------
// PLATE (V1 — breakable weak point). A hanging armour panel with a school
// bar. It is a MESH ON THE BOSS, not a HUD element, because "shoot the stamp"
// only works if the stamp is a thing in the world. Damage opens fracture
// lines across it; the diagonal bar tells a mono-school build this one is not
// theirs BEFORE they waste a rotation on it.
// ---------------------------------------------------------------------------
const PLATE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uHp;     // 1 pristine -> 0 about to break
  uniform float uImmune; // 1 = this plate refuses a school (draw the bar)
  varying vec2 vUv;
  float plH(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = max(abs(p.x), abs(p.y));
    float bezel = smoothstep(0.82, 0.94, r) * (1.0 - smoothstep(0.99, 1.0, r));
    float rule = smoothstep(0.62, 0.66, r) * (1.0 - smoothstep(0.7, 0.74, r));
    float field = 1.0 - smoothstep(0.9, 1.0, r);
    // FRACTURES open as the plate is worked: chunky, KayKit-scaled.
    float dmg = 1.0 - uHp;
    float crackN = plH(floor(p * 7.0 + 0.5));
    float crack = smoothstep(1.0 - dmg, 1.0 - dmg - 0.22, crackN) * step(0.3, dmg)
                * smoothstep(0.5, 0.46, abs(fract(p.x * 3.0 + p.y * 2.0 + crackN) - 0.5));
    float bar = uImmune * smoothstep(0.1, 0.03, abs(p.x + p.y)) * field;
    float pulse = 0.75 + 0.25 * sin(uTime * 4.0);
    // The panel is ARMOUR: a dark field inside a hot bezel. First cut had a
    // bright field, which read as a blank white card floating next to the
    // boss instead of a plate bolted to it (capture review).
    float a = clamp(field * 0.78 + bezel * 0.95 + rule * 0.5 + crack * 0.8 + bar * 0.8, 0.0, 0.96);
    vec3 col = mix(uColor * 0.09, uCore, clamp(bezel * 1.3 + rule * 0.6 + crack * 1.6 + bar, 0.0, 1.0))
             * (0.55 + 2.1 * bezel * pulse + 2.4 * crack + 0.8 * bar);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makePlateMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xd8c08a) },
      uCore: { value: new THREE.Color(0xfff2cc) },
      uTime: { value: 0 }, uHp: { value: 1 }, uImmune: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: PLATE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// CELLS (the SURVIVE-THE-STORM ask). A grid of square cells lighting IN
// SEQUENCE. The Compliance Lattice is a timing puzzle of moving safe squares,
// so the telegraph is literally the squares: a player reads "that one, then
// that one, then that one" and walks the gap. Rectilinear, so it can never be
// confused with a ring, and sparse, so the arena stays visible through it.
// ---------------------------------------------------------------------------
const CELLS_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;
  uniform float uN;    // cells across the arena
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    vec2 g = p * uN * 0.5;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    // The sequence: a diagonal wavefront, so the order is legible at a glance.
    float order = (id.x + id.y) * 0.5;
    float front = uProg * (uN + 2.0) - uN * 0.5;
    float live = smoothstep(front + 0.9, front, order) * smoothstep(front - 2.2, front - 1.2, order);
    float box = max(abs(f.x), abs(f.y));
    float edge = smoothstep(0.5, 0.42, box) * (1.0 - smoothstep(0.4, 0.3, box));
    float fill = smoothstep(0.42, 0.0, box) * 0.16;
    float tick = 0.7 + 0.3 * sin(uTime * 7.0 + order * 1.7);
    float fade = 1.0 - smoothstep(0.7, 1.0, uProg);
    float a = clamp((edge * 0.62 + fill) * live * tick * fade, 0.0, 0.58) * uDim;
    vec3 col = mix(uColor, uCore, clamp(edge * 1.4, 0.0, 1.0)) * (0.85 + 1.7 * edge);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

// ---------------------------------------------------------------------------
// SET (the Showrunner's set change, and nothing else). Two FLATS slide in from
// opposite wings and meet on a hard vertical seam. It is the only rectangular
// full-arena beat in the game — which is the whole reason it exists: the
// capture round found the Showrunner and the Sponsor sharing one disc, so the
// two finales were indistinguishable in a still.
// ---------------------------------------------------------------------------
const SET_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    if (length(p) > 1.0) discard;
    // Two flats travelling in from the wings. They start ALREADY on stage —
    // the first cut began them outside the clipped disc, so the beat was two
    // slivers in the far corners and nothing else (capture review round 2).
    float close = clamp(uProg * 1.6, 0.0, 1.0);
    float lft = -0.92 + close * 0.78;
    float rgt = 0.92 - close * 0.78;
    float inL = step(p.x, lft);
    float inR = step(rgt, p.x);
    float lip = smoothstep(0.075, 0.0, abs(p.x - lft)) + smoothstep(0.075, 0.0, abs(p.x - rgt));
    // BATTENS: vertical ribs on the flats, so they read as scenery, not fog.
    float batten = smoothstep(0.55, 0.98, sin(p.y * 14.0 + 1.5)) * (inL + inR);
    float floorline = smoothstep(0.04, 0.0, abs(p.y)) * (inL + inR) * 0.5;
    float fade = 1.0 - smoothstep(0.78, 1.0, uProg);
    float a = clamp((lip * 0.85 + batten * 0.3 + floorline + (inL + inR) * 0.12) * fade, 0.0, 0.78) * uDim;
    vec3 col = mix(uColor, uCore, clamp(lip * 1.5, 0.0, 1.0)) * (0.8 + 1.8 * lip + 0.6 * batten);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

// ---------------------------------------------------------------------------
// PUNISH MARK (V4). §7.4 calls the punish window "the one beat that most needs
// to read", and the capture round found it wearing the same white starburst as
// every routine telegraph. It now owns a shape nothing else in the game uses:
// four CORNER BRACKETS closing inward on the exposed core, on the ground,
// under the beacon shaft. A reticle, not a blast — the grammar of "aim here".
// ---------------------------------------------------------------------------
const MARK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uLeft;  // 1 window open -> 0 closing
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    vec2 a = abs(p);
    // The brackets CLOSE as the window runs out: distance is the countdown.
    //
    // r3 BLOCKER — the reticle appeared in NONE of the seven punish captures.
    // It was drawing: at 0.045 of a disc unit the rails were a ~10cm hairline
    // in world scale, sitting near the rim of a 4.6-unit quad over a blown-out
    // floor. Nobody was ever going to see it. Two fixes, both about SURVIVING
    // A LIT ARENA rather than about being brighter: the rails are five times
    // thicker with a soft outer glow so they hold up against floor detail, and
    // the travel is pulled in (0.34 -> 0.80 instead of 0.42 -> 0.94) so the
    // brackets close ON the boss rather than out at the edge of the frame.
    float s = mix(0.34, 0.80, uLeft);
    float arm = 0.42;
    float rail = 0.055;
    float line = min(
      smoothstep(rail, rail * 0.25, abs(a.x - s)) * step(a.y, s) * step(s - arm, a.y),
      1.0) + min(
      smoothstep(rail, rail * 0.25, abs(a.y - s)) * step(a.x, s) * step(s - arm, a.x),
      1.0);
    // A soft shoulder either side of each rail. Pure hairlines alias to
    // nothing at iso scale; the shoulder is what makes the shape read.
    float glow = min(
      smoothstep(rail * 3.2, 0.0, abs(a.x - s)) * step(a.y, s + 0.05) * step(s - arm, a.y),
      1.0) + min(
      smoothstep(rail * 3.2, 0.0, abs(a.y - s)) * step(a.x, s + 0.05) * step(s - arm, a.x),
      1.0);
    // A hard cross at the middle: the aim point, nothing more.
    float cross = (smoothstep(0.03, 0.0, a.x) + smoothstep(0.03, 0.0, a.y))
                * step(max(a.x, a.y), 0.2);
    float pulse = 0.72 + 0.28 * sin(uTime * 9.0);
    float alpha = clamp((line * 0.72 + glow * 0.3 + cross * 0.5) * pulse, 0.0, 0.85) * uDim;
    vec3 col = mix(uColor, uCore, clamp(line, 0.0, 1.0)) * (1.0 + 1.6 * line + 0.5 * glow);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }`;

// ---------------------------------------------------------------------------
// AIDE COLLAR (the COUNCIL format — r3 major). The Zoning Board is one body
// plus three tethered aides that shield it and bequeath their verb on death,
// so the KILL ORDER is the fight — and in play it read as a boss standing in
// a crowd. The cords were being LOD-culled and the aides were silhouetted
// exactly like trash.
//
// This is the aides' own mark: a square SEAT plate at the feet, rotating a
// quarter-turn, with a notch in each side. Rectilinear on purpose — every
// other feet-level mark in this game is a circle, so "that body is on the
// board" is answerable from the shape alone at a glance.
// ---------------------------------------------------------------------------
const AIDE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    // A slow quarter-turn: alive, and unmistakably not a nova.
    float a0 = uTime * 0.5;
    vec2 q = vec2(p.x * cos(a0) - p.y * sin(a0), p.x * sin(a0) + p.y * cos(a0));
    vec2 aq = abs(q);
    float box = max(aq.x, aq.y);
    float ring = smoothstep(0.86, 0.72, box) * (1.0 - smoothstep(0.7, 0.56, box));
    // NOTCHES: the seat is broken at the mid-point of each side, so the plate
    // reads as four brackets rather than a solid square.
    float notch = 1.0 - smoothstep(0.16, 0.06, min(aq.x, aq.y));
    float tick = 0.68 + 0.32 * sin(uTime * 3.4);
    float alpha = clamp(ring * notch * 0.8 * tick, 0.0, 0.72) * uDim;
    vec3 col = mix(uColor, uCore, ring) * (1.1 + 1.7 * ring);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }`;

function makeQuadMat(frag: string, extra: Record<string, { value: unknown }>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uCore: { value: new THREE.Color(0xffffff) },
      uTime: { value: 0 }, uProg: { value: 0 }, uDim: { value: 1 },
      ...extra,
    },
    vertexShader: VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

export const makeLanesMat = (): THREE.ShaderMaterial =>
  makeQuadMat(LANES_FRAG, { uN: { value: 3 }, uAng: { value: 0 }, uW: { value: 0.13 } });
export const makePropsMat = (): THREE.ShaderMaterial =>
  makeQuadMat(PROPS_FRAG, {
    uCount: { value: 0 },
    uAt: { value: Array.from({ length: 8 }, () => new THREE.Vector2()) },
  });
export const makeCellsMat = (): THREE.ShaderMaterial =>
  makeQuadMat(CELLS_FRAG, { uN: { value: 7 } });
export const makeSetMat = (): THREE.ShaderMaterial => makeQuadMat(SET_FRAG, {});
export const makeMarkMat = (): THREE.ShaderMaterial =>
  makeQuadMat(MARK_FRAG, { uLeft: { value: 1 } });
export const makeAideMat = (): THREE.ShaderMaterial => makeQuadMat(AIDE_FRAG, {});

// ---------------------------------------------------------------------------
// SPORE POD (the Pollinator's new Hazard.kind, §7.4). Armed pods that bloom
// and seed children, so a pod must read as A THING THAT WILL OPEN, never as a
// puddle. Petal seams SPREAD as it arms and the core swells: the countdown is
// the pod's own silhouette, readable without a timer.
// ---------------------------------------------------------------------------
const SPORE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uArm;  // 0 fresh -> 1 about to bloom
  uniform float uDry;  // 0 live -> 1 expiring
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float seam = abs(sin(ang * 2.5 + uTime * 0.4));
    float split = smoothstep(0.9 - uArm * 0.55, 1.0, seam);
    float pod = smoothstep(0.95, 0.35, r) * (1.0 - split * (0.35 + 0.5 * uArm));
    float coreR = 0.16 + 0.3 * uArm;
    float core = smoothstep(coreR, 0.0, r) * (0.5 + 1.4 * uArm);
    float rim = smoothstep(0.82, 0.95, r) * (1.0 - smoothstep(0.97, 1.0, r));
    float breathe = 0.8 + 0.2 * sin(uTime * (3.0 + 7.0 * uArm));
    float a = clamp((pod * 0.5 + core * 0.7 + rim * 0.8) * breathe * (1.0 - uDry * 0.75), 0.0, 0.92);
    vec3 col = mix(uColor, uCore, clamp(core * 1.2 + rim * 0.6, 0.0, 1.0))
             * (1.0 + 2.6 * core + 1.5 * rim);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makeSporeMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(ASK_PAL.storm.mid) },
      uCore: { value: new THREE.Color(ASK_PAL.storm.core) },
      uTime: { value: 0 }, uArm: { value: 0 }, uDry: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: SPORE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ===========================================================================
// THE STAGE MANAGER. One instance, owned by Renderer3D.
// ===========================================================================

/** What BossFx borrows from the renderer to make noise in the world. */
export interface BossFxDeps {
  fxp: FxParticles;
  shocks: Shockwaves;
  decals: GroundDecals;
  light(x: number, z: number, hex: number, peak?: number, max?: number, y?: number): void;
  trauma(a: number): void;
  bloom(a: number): void;
}

interface ArenaBeat { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; max: number }

/** The ground-plane silhouettes, one pool per shape (§ THE ASK SILHOUETTES). */
type ShapeKind = "lanes" | "props" | "cells" | "set";
const SHAPE_MAT: Record<ShapeKind, () => THREE.ShaderMaterial> = {
  lanes: makeLanesMat, props: makePropsMat, cells: makeCellsMat, set: makeSetMat,
};
interface ShapeBeat {
  mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; max: number; kind: ShapeKind;
}
/** A transient converging cord (the ADDS silhouette), drawn like a tether. */
interface CordBeat { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; max: number }

export class BossFx {
  readonly group = new THREE.Group();

  /**
   * Camera intent for the host this frame (§5.5): pull back one step per phase
   * transition (the arena is more dangerous — show more of it), snap IN on the
   * intermission, orbit during the reveal. Everything else is neutral, because
   * there is NO camera work during normal combat — readability beats
   * cinematography every single time.
   */
  zoom = 1; // multiplies the ortho half-height (>1 = wider)
  orbit = 0; // radians of camera yaw offset (reveal + kill only)
  /** Seconds of hit-stop the host should apply (phase break / kill moment). */
  slowmo = 0;
  /**
   * ENCOUNTER FRAMING (capture review, round 2 — a blocker). The health plate
   * lives at the top of the screen and the boss stands UP-SCREEN of the
   * crawler, so every fight shot had the star of the fight sitting behind its
   * own UI panel: bodies fully occluded, heads clipped, one boss reduced to a
   * pair of legs. The plate is the wrong thing to shrink (it is the read on
   * shields, plates, mutators and the beat line), so the CAMERA moves.
   *
   * Two scalars, applied by the host (which owns camDir, so the screen-space
   * maths stays in one place):
   *   frameBias — 0..1, how far the anchor slides from the crawler toward the
   *               boss, so the PAIR is the subject instead of the crawler.
   *   frameDrop — world units the anchor is pushed along SCREEN-UP, which
   *               slides the whole framing down the screen and out from under
   *               the panel.
   * Both are zero outside a boss fight: normal combat gets no camera work.
   */
  frameBias = 0;
  frameDrop = 0;

  private zoomWant = 1;
  private orbitWant = 0;
  private orbitHold = 0;
  /**
   * How long a PUSH-IN (zoomWant < 1) may hold the frame (owner bug: "it zooms
   * in on a boss ... you can't see your character"). The reveal set 0.78 and
   * nothing ever set it back — zoomWant was only reset when the boss DIED, so
   * the whole fight played 22% zoomed in, which is the opposite of §5.5's rule
   * that a beat BORROWS the frame. Pull-backs (zoomWant >= 1) are not beats,
   * they are the phase's standing wide shot, so only push-ins ride this timer.
   */
  private zoomHold = 0;
  // Measured against a 1600x900 capture at the shipped ortho half-height: the
  // plate owns the top ~250px, a boss rig stands ~3 units, and this pair puts
  // its feet near 55% down the frame with its head clear of the panel by a
  // comfortable margin at every band.
  private static readonly ENC_BIAS = 0.5;
  private static readonly ENC_DROP = 6.8;
  /**
   * EXPOSURE BUDGET, round 2. §5 already gave every beat its own brightness
   * budget, and the finale still blew out: the case that broke was two beats
   * OVERLAPPING (an arena tint plus a signature plus a ring, all additive, all
   * arena-scale, inside the same half second). A per-beat budget cannot see
   * that. This is the shared governor: every beat declares a cost, the load
   * decays over about a second, and while it is high the bloom kicks and light
   * peaks that follow are scaled down. Shapes are never scaled — the read comes
   * from geometry, so dimming an overlap costs nothing that matters.
   */
  private load = 0;
  /**
   * THE MEASURED HALF (r3 blocker). §5.9's governor added up a DECLARED cost
   * per beat, which cannot see the thing that actually broke: the arena floor.
   * The Topiary Warden's reveal on floor 9's bright forest was a solid white
   * ellipse and its combat frame an unreadable white sphere, while the exact
   * same budget held on the dark brick arenas — because a budget of BEATS has
   * no idea how bright the room already is.
   *
   * The renderer now reads back an 8x8 block of the FINAL, display-referred
   * frame around the boss and hands us its mean luma plus its saturated-pixel
   * fraction. Both feed the same scale the beats already pay, so a bright floor
   * costs exactly what another beat costs. Shapes are still never scaled: what
   * comes down is bloom, light peaks and additive rig ALPHA (uDim).
   */
  private measLuma = 0;
  private measSat = 0;
  /** 0..1 — the grip on bloom / light peaks / additive alpha this frame. */
  exposureScale = 1;
  /**
   * True while an ASK silhouette (lanes / cords / shell / props / cells / set)
   * is on the ground. The renderer demotes the shared telegraph disc while it
   * is, so the shape that says WHICH FIGHT THIS IS is the brightest element.
   */
  silhouetteLive = false;
  /** Where the marquee boss is standing, for the renderer's readback. */
  starPos: { x: number; y: number } | null = null;
  /** The last state the host handed us — beats need the world, not just a point. */
  private world: GameState | null = null;

  private deps: BossFxDeps;
  private plates = new Map<string, THREE.Mesh>(); // `${monsterId}:${plateKey}`
  private shields = new Map<number, THREE.Mesh>();
  private tethers = new Map<number, THREE.Mesh>(); // keyed by the ADD's id
  private punish = new Map<number, THREE.Group>();
  private beats: ArenaBeat[] = [];
  private shapes: ShapeBeat[] = [];
  private cords: CordBeat[] = [];
  private shells: ArenaBeat[] = [];
  private marks = new Map<number, THREE.Mesh>();
  /** Per-boss reticle countdown: { t = seconds left, span = its full length }. */
  private marked = new Map<number, { t: number; span: number }>();
  private static readonly MARK_MIN_SPAN = 1.6;
  /** The council's aides, marked at the feet so they are never trash (r3). */
  private aides = new Map<number, THREE.Mesh>();
  private seenAides = new Set<number>();
  private sporeMats = new Map<number, THREE.ShaderMaterial>();
  private plateGeo = new THREE.PlaneGeometry(1, 1);
  private shieldGeo = new THREE.SphereGeometry(1, 20, 14);
  private tetherGeo = new THREE.PlaneGeometry(1, 1);
  private punishGeo = new THREE.PlaneGeometry(1, 1);
  private markGeo = new THREE.PlaneGeometry(1, 1);
  private aideGeo = new THREE.PlaneGeometry(1, 1);
  private cordGeo = new THREE.PlaneGeometry(1, 1);
  private shellGeo = new THREE.SphereGeometry(1, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.56);
  private seenMarks = new Set<number>();
  private propTick = 0;
  /** §5.1 THE APPROACH, staged in the world rather than only in the mix. */
  private approachT = 0;
  private approachLight = 0;
  private approachRing = -9;
  private prevShieldFrac = new Map<number, number>();
  /** Tethered adds already greeted — §2.5 wave arrivals fire exactly once. */
  private greeted = new Set<number>();
  // Reconciliation scratch. Hoisted and cleared rather than minted per frame:
  // this runs every frame next to a boss fight, and the renderer's GC sweep
  // rule is that the hot path allocates nothing.
  private seenPlates = new Set<string>();
  private seenShields = new Set<number>();
  private seenTethers = new Set<number>();
  private seenPunish = new Set<number>();

  constructor(deps: BossFxDeps) {
    this.deps = deps;
    this.group.name = "bossFx";
  }

  // -------------------------------------------------------------------------
  // BEATS. One method per BossEvent kind; the host routes and this stages.
  // -------------------------------------------------------------------------

  /**
   * The exposure governor (§ EXPOSURE BUDGET). `cost` is roughly "how much of
   * the frame does this beat light up"; the returned multiplier is what the
   * caller should scale its bloom kick and light peaks by. One beat alone pays
   * nothing; three inside a second pay most of it back.
   */
  private budget(cost: number): number {
    const k = this.exposureScale;
    this.load += cost;
    // Re-fold immediately: three beats inside ONE frame never see an update()
    // between them, and that pile-up is exactly what §5.9 was built for.
    this.exposureScale = this.scaleFor(this.load);
    return k;
  }

  /**
   * The governor's curve. Below the knee a dark arena pays NOTHING — this is
   * deliberately identical to the shipped behaviour there, because the dark
   * brick arenas were never the problem. Above it, measured brightness is
   * charged like any other beat, and a genuinely clipping neighbourhood gets a
   * hard clamp so the boss's silhouette comes back out of the white.
   */
  private scaleFor(load: number): number {
    const over = Math.max(0, this.measLuma - 0.45) * 3.2 + this.measSat * 4;
    const k = 1 / (1 + load * 1.9 + over);
    return this.measSat > 0.22 ? Math.min(k, 0.3) : k;
  }

  /**
   * Capture hold. Extends every live rig's own countdown so a slow shutter
   * photographs the beat rather than its aftermath. Nothing is invented — a
   * beat that is not running does not start running because of this.
   */
  hold(seconds: number): void {
    for (const mk of this.marked.values()) {
      mk.span = Math.max(mk.span, seconds);
      mk.t = Math.max(mk.t, seconds * 0.75);
    }
    for (const b of [...this.beats, ...this.shapes, ...this.shells]) {
      if (b.life < b.max) { b.max = Math.max(b.max, seconds); }
    }
    for (const c of this.cords) if (c.life < c.max) c.max = Math.max(c.max, seconds);
  }

  /** The renderer's measurement of the boss's own neighbourhood (0..1 each). */
  setMeasuredLuma(luma: number, sat: number): void {
    // Eased: the readback runs every 4th frame, and a governor that snaps is a
    // governor the player watches working.
    this.measLuma += (luma - this.measLuma) * 0.45;
    this.measSat += (sat - this.measSat) * 0.45;
  }

  /** Bloom, through the governor. Never call deps.bloom directly from a beat. */
  private flash(amount: number, cost = amount): void {
    this.deps.bloom(amount * this.budget(cost));
  }

  /** Stage one typed sim beat (§7.4). */
  beat(e: BossEvent): void {
    const x = e.pos?.x ?? 0, z = e.pos?.y ?? 0;
    switch (e.kind) {
      case "intro": return this.intro(x, z, e);
      case "telegraph": return this.telegraph(x, z, e);
      case "phase": return this.phase(x, z, e);
      case "intermission": return this.intermission(x, z, e);
      case "punish": return this.punishOpen(x, z, e);
      case "plate": return this.plateBreak(x, z, e);
      case "shieldbreak": return this.shieldBreak(x, z);
      case "enrage": return this.enrage(x, z, e);
      case "prop": return this.prop(x, z, e);
    }
  }

  /**
   * §5.2/§5.3 — THE REVEAL, then the card. Two beats, not one: the camera
   * pulls back and orbits onto the silhouette while the arena lights lift,
   * and the host's name card lands ON TOP of that, not instead of it.
   */
  private intro(x: number, z: number, e: BossEvent): void {
    const pal = ASK_PAL[bossFamily(e.bossId)];
    const full = (e.value ?? 0) === 0; // a rematch gets the beat, not the ceremony
    // The reveal PUSHES IN. §5.2 asks for a pull-back on arena entry and §5.3
    // wants the intro to end on the boss's SILHOUETTE — and those are two
    // different beats. Pulling back during the card shrank the star of the
    // introduction to a thumbnail, which is the opposite of an entrance, so
    // the wide shot belongs to the approach and the card gets the close-up.
    this.zoomWant = full ? 0.78 : 0.88;
    this.orbitWant = full ? 0.55 : 0.22;
    this.orbitHold = e.duration ?? 2.2;
    this.zoomHold = this.orbitHold + 0.6; // the card's close-up ends WITH the card
    // The arena lights RAISE: a warm lift under the star of the introduction
    // plus a column of motes climbing it, so the silhouette is lit from below
    // like a ring entrance instead of reading as a dark blob.
    // The lift sits ABOVE head height and stays modest: the reveal has to
    // silhouette the boss, and a floor-level flood just erased its legs.
    // Through the governor (r3 blocker): the reveal is the one beat that MUST
    // leave a readable silhouette, and on a bright arena an un-governed lift
    // plus the DOM key light is precisely what erased the Topiary Warden.
    const k = this.budget(0.4);
    this.deps.light(x, z, pal.mid, 5 * k, 1.4, 2.4);
    this.deps.fxp.column(x, z, pal.mid, 18, 3.4);
    this.deps.fxp.vortex(x, z, pal.core, 3.0);
    this.arenaBeat(x, z, 6, pal, 1.5, 0); // the seal closing: contracting
    this.deps.bloom(0.22 * k);
  }

  /**
   * §7.4 — a named signature commits. The per-boss identity beat, and the one
   * with the hardest deadline: unmistakable inside 0.2s, which is why the
   * SHAPE carries it and the color only confirms.
   */
  private telegraph(x: number, z: number, e: BossEvent): void {
    const sig = signatureFor(e.label, e.bossId);
    const pal = ASK_PAL[sig.family];
    const n = Math.max(1, Math.min(12, Math.round(e.value ?? 1)));
    const k = this.budget(0.5);
    switch (sig.shape) {
      case "lanes": {
        // DODGE-THE-LANE: chevroned rectangles. The heading comes from the
        // hazards the sim just laid, so the bars sit ON the lanes rather than
        // near them; with none found (fissure fans lay blasts, not beams) it
        // falls back to an even fan, which is what those casts are anyway.
        const head = this.laneHeading(x, z);
        this.shapeBeat("lanes", x, z, 7.5, pal, 1.1, (m) => {
          m.uniforms.uN.value = n;
          m.uniforms.uAng.value = head;
          m.uniforms.uW.value = n >= 6 ? 0.1 : 0.14;
        });
        this.deps.fxp.sparks(x, 0.5, z, pal.core, 5, { x: Math.cos(head), y: Math.sin(head) });
        this.deps.light(x, z, pal.mid, 7 * k, 0.45, 1.0);
        break;
      }
      case "cords": {
        // KILL-THE-ADDS: cords converging on the boss from the bodies that
        // matter, pulses travelling INWARD. Horizontal, at chest height, and
        // anchored on real monsters — a wave you can count and pick from.
        const from = this.addAnchors(x, z, n);
        for (const a of from) this.cordBeat(a.x, a.z, x, z, pal, 1.25);
        this.deps.fxp.gatherBurst(x, 1.2, z, pal.core);
        this.deps.light(x, z, pal.mid, 7 * k, 0.55, 1.3);
        break;
      }
      case "shell": {
        // BREAK-THE-SHIELD: the dome, cracking. A PROPERTY of the boss, so it
        // wraps the body and never touches the floor.
        this.shellBeat(x, z, pal, 1.15);
        this.deps.fxp.impactFlash(x, 1.5, z, pal.core, 1.5);
        this.deps.light(x, z, pal.core, 7 * k, 0.5, 1.6);
        this.flash(0.16, 0.4);
        break;
      }
      case "props": {
        // USE-THE-ARENA: brackets clamped on the props/cover this beat is
        // about, with a feed line out to each. Nothing at the middle at all.
        const at = this.propAnchors(x, z, 7.5);
        // Nothing standing in reach (the boss ate its cover, or the beat fired
        // on open ground): the brackets clamp the CORNERS of the arena instead,
        // which is still the arena answering rather than the boss glowing.
        if (at.length === 0) {
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            at.push(new THREE.Vector2(Math.cos(a) * 0.62, Math.sin(a) * 0.62));
          }
        }
        {
          this.shapeBeat("props", x, z, 7.5, pal, 1.25, (m) => {
            const arr = m.uniforms.uAt.value as THREE.Vector2[];
            for (let i = 0; i < arr.length; i++) {
              arr[i].set(at[i]?.x ?? 0, at[i]?.y ?? 0);
            }
            m.uniforms.uCount.value = at.length;
          });
          for (const p of at) {
            this.deps.fxp.dust(x + p.x * 7.5, 0.3, z + p.y * 7.5, 6, pal.rim);
          }
        }
        this.deps.fxp.gibs(x, z, pal.rim, 8);
        this.deps.decals.spawn(x, z, 1.4, 0x140d08, pal.mid, 8);
        this.deps.light(x, z, pal.mid, 7 * k, 0.5, 1.0);
        break;
      }
      case "cells":
        // SURVIVE-THE-STORM: the safe squares, in order.
        this.shapeBeat("cells", x, z, 8, pal, 1.5, (m) => {
          m.uniforms.uN.value = Math.max(5, Math.min(11, n + 3));
        });
        this.deps.light(x, z, pal.mid, 6 * k, 0.4, 0.9);
        break;
      case "set":
        // THE SET CHANGES: flats sliding in from the wings. Rectangular, and
        // the only full-arena beat that is not a ring.
        this.shapeBeat("set", x, z, 9.5, pal, 1.5);
        this.deps.fxp.dust(x, 0.3, z, 16, pal.rim);
        this.deps.light(x, z, pal.mid, 8 * k, 0.6, 1.4);
        break;
      case "column":
        // A SEIZURE: motes fall INTO the epicenter, then the shaft stands up.
        this.deps.fxp.gatherBurst(x, 1.1, z, pal.core);
        this.deps.fxp.column(x, z, pal.mid, 20, 3.0);
        this.deps.fxp.radialStreaks(x, 0.5, z, pal.core, 10, 2.2);
        this.deps.light(x, z, pal.mid, 9, 0.7, 1.3);
        break;
      case "ring":
        // THE ROOM IS CHANGING. A contracting arena ring — the only inward
        // ring in the game, and now the ONLY beat allowed radial spokes (see
        // ARENA_FRAG). Sized to the ARENA, not the screen: at radius 9 it
        // swallowed a floor-6 room and the fight stopped being readable.
        this.arenaBeat(x, z, 6.5, pal, 1.35, 0, 1);
        this.deps.fxp.dust(x, 0.3, z, 10, pal.rim);
        break;
      case "burrow":
        // THE PIT PULLS: everything converges. A vortex plus an inward ring
        // (spokeless — those belong to FLOOD SURGE alone), which is the
        // grammar of "you are the one being moved".
        this.deps.fxp.vortex(x, z, pal.mid, 3.6);
        this.arenaBeat(x, z, 5.5, pal, 1.0, 0);
        this.deps.fxp.smoke(x, 0.4, z, 8, pal.rim);
        break;
      case "swarm":
        // BLOOM / QUOTA: bodies or pods are about to exist. Scatter outward,
        // low and wide, so the eye goes to the GROUND where they will land.
        this.deps.fxp.burst(x, z, pal.mid, 18);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + 0.4;
          this.deps.fxp.embers(x + Math.cos(a) * 1.6, z + Math.sin(a) * 1.6, pal.core, 3, 0.8);
        }
        this.deps.light(x, z, pal.mid, 6, 0.5, 0.9);
        break;
      case "brand":
        // A RULE CHANGED (Brand Integration / the Clause). No ground work at
        // all: a hard flash at chest height and a tight halo, because this
        // beat is about a PROPERTY of the boss, not about a piece of floor.
        this.deps.fxp.impactFlash(x, 1.4, z, pal.core, 2.1);
        this.deps.fxp.radialStreaks(x, 1.4, z, pal.mid, 14, 2.6);
        this.deps.shocks.spawn(x, z, pal.core, 3.2, 0.42);
        this.deps.light(x, z, pal.core, 7 * k, 0.5, 1.5);
        this.flash(0.2, 0.4);
        break;
      case "quake":
        // FISSURES / OVERREACH: the floor itself. Dust, masonry gibs and a
        // scorch the arena KEEPS — the ground took the hit.
        this.deps.fxp.dust(x, 0.25, z, 20, pal.rim);
        this.deps.fxp.gibs(x, z, pal.rim, 10);
        this.deps.decals.spawn(x, z, 1.5, 0x140d08, pal.mid, 9);
        this.deps.shocks.spawn(x, z, pal.mid, 4.2, 0.5);
        break;
      default:
        this.deps.shocks.spawn(x, z, pal.mid, 3.4, 0.45);
        this.deps.fxp.burst(x, z, pal.mid, 12);
    }
    if (sig.trauma) this.deps.trauma(sig.trauma);
  }

  /**
   * §5.5/§5.6 — a phase edge. A `mechanic` reason means the PLAYER caused it,
   * and per §7.4 that must read LOUDER than an HP gate: the player's own play
   * moving the story is the best feeling this fight has to offer.
   */
  private phase(x: number, z: number, e: BossEvent): void {
    if (e.label === "DEFEATED") return this.defeat(x, z);
    const pal = ASK_PAL[bossFamily(e.bossId)];
    const caused = e.reason === "mechanic";
    // Pull back one step per phase: the arena is getting more dangerous, so
    // show more of it. Capped so the camera never leaves the fight behind.
    this.zoomWant = Math.min(1.3, 1 + 0.09 * ((e.phase ?? 1) + (caused ? 1 : 0)));
    this.slowmo = Math.max(this.slowmo, caused ? 0.22 : 0.13);
    this.deps.shocks.spawn(x, z, caused ? ASK_PAL.window.core : pal.core, caused ? 7 : 5, 0.62);
    this.deps.fxp.column(x, z, caused ? ASK_PAL.window.mid : pal.mid, caused ? 26 : 18, 3.4);
    this.deps.fxp.radialStreaks(x, 1.0, z, pal.core, caused ? 20 : 12, 3.2);
    const k = this.budget(caused ? 0.7 : 0.5);
    this.deps.light(x, z, caused ? ASK_PAL.window.core : pal.mid, (caused ? 8 : 6) * k, 0.9, 1.6);
    this.deps.trauma(caused ? 0.45 : 0.3);
    this.deps.bloom((caused ? 0.34 : 0.22) * k);
  }

  /**
   * §5.6 — THE COMMERCIAL BREAK. The boss goes briefly untargetable and a
   * shockwave CLEARS live hazards, so the board is re-dealt rather than
   * compounded. That is the point of the beat, so it must be visible: the
   * sweep runs outward through every hazard on the floor and the camera snaps
   * IN, because for two seconds there is nothing to dodge.
   */
  private intermission(x: number, z: number, e: BossEvent): void {
    const swept = e.value ?? 0;
    this.zoomWant = 0.88;
    this.zoomHold = e.duration ?? 2.2; // snap IN for the sweep, then give it back
    this.slowmo = Math.max(this.slowmo, 0.2);
    this.arenaBeat(x, z, 8.5, ASK_PAL.window, 1.1, 1); // outward: the sweep
    this.deps.shocks.spawn(x, z, 0xfff2cc, 10, 0.75);
    this.deps.fxp.radialStreaks(x, 0.6, z, 0xfff8dc, 20, 5.0);
    this.deps.fxp.dust(x, 0.3, z, Math.min(40, 12 + swept * 4), 0x8a7f6a);
    // The intermission lands ON TOP of whatever the boss was mid-way through,
    // which is exactly the overlap that blew the finale out. Through the
    // governor it stays a sweep instead of a white card.
    const k = this.budget(0.9);
    this.deps.light(x, z, 0xfff2cc, 9 * k, 1.1, 2.0);
    this.deps.trauma(0.35);
    this.deps.bloom(0.36 * k);
  }

  /**
   * §7.4 — the punish window opens: "the one beat that most needs to read".
   *
   * The capture round found it reading as a white radial starburst, i.e. as
   * the same thing as every routine telegraph in the game, only brighter. The
   * shockwave and the gather are gone. What is left is a shape nothing else
   * owns: the ground RETICLE (four corner brackets closing on the core, rigged
   * in update() off m.stagger) under the beacon shaft, plus a single hard
   * flash at chest height to catch the eye. No ring, no spokes, no nova.
   */
  private punishOpen(x: number, z: number, e: BossEvent): void {
    // THE RETICLE HOLDS (r3 blocker). The window's own length is the sim's
    // business; how long the beat is READABLE is ours. A span shorter than
    // MARK_MIN_SPAN is a beat the player blinked past, and this is the beat
    // §7.4 says most needs to read — so the mark opens wide, closes over at
    // least this long, and does it whether the sim's window agrees or not.
    const span = Math.max(BossFx.MARK_MIN_SPAN, e.duration ?? 2.2);
    this.marked.set(e.monsterId, { t: span, span });
    const pal = ASK_PAL.window;
    const k = this.budget(0.5);
    this.deps.fxp.impactFlash(x, 1.2, z, pal.core, 0.9);
    this.deps.light(x, z, pal.core, 5.5 * k, 0.55, 1.7);
    this.flash(0.12, 0.35);
    this.slowmo = Math.max(this.slowmo, 0.12);
  }

  /** A plate broke: armour comes OFF, in pieces, and the floor keeps a mark. */
  private plateBreak(x: number, z: number, e: BossEvent): void {
    this.deps.fxp.gibs(x, z, 0xd8c08a, 14);
    this.deps.fxp.sparks(x, 1.2, z, 0xfff2cc, 12);
    this.deps.fxp.impactFlash(x, 1.2, z, 0xfff2cc, 1.7);
    this.deps.shocks.spawn(x, z, 0xffd98a, 3.0, 0.4);
    this.deps.light(x, z, 0xffd98a, 10, 0.5, 1.3);
    this.deps.trauma(0.26);
    // The LAST plate is a bigger moment than the first — it is a phase edge.
    if ((e.value ?? 1) === 0) { this.flash(0.5, 0.6); this.slowmo = Math.max(this.slowmo, 0.14); }
  }

  /** The absorb pool emptied: the shell SHATTERS outward in cell-sized shards. */
  private shieldBreak(x: number, z: number): void {
    const pal = ASK_PAL.shield;
    this.deps.fxp.burst(x, z, pal.mid, 26);
    this.deps.fxp.gibs(x, z, pal.core, 16);
    this.deps.fxp.radialStreaks(x, 1.1, z, pal.core, 18, 3.0);
    this.deps.shocks.spawn(x, z, pal.core, 5.2, 0.5);
    this.deps.light(x, z, pal.core, 8, 0.7, 1.5);
    this.deps.trauma(0.34);
    this.flash(0.3, 0.5);
    this.slowmo = Math.max(this.slowmo, 0.12);
  }

  /** The System loses patience with the slot. Reads as HEAT, never as HP. */
  private enrage(x: number, z: number, e: BossEvent): void {
    const stacks = e.value ?? 1;
    this.deps.fxp.embers(x, z, 0xff4a1e, 10 + stacks * 3, 1.8);
    this.deps.fxp.column(x, z, 0xff6a2a, 14, 2.6);
    this.deps.light(x, z, 0xff4a1e, 8 + stacks, 0.8, 1.4);
    this.deps.trauma(0.2);
  }

  /** An interactive arena prop fired — the ROOM answered, so mark the room. */
  private prop(x: number, z: number, e: BossEvent): void {
    const label = e.label ?? "";
    const pal = label.includes("VENT") ? ASK_PAL.window
      : label.includes("CONVEYOR") || label.includes("SHUTDOWN") ? ASK_PAL.adds
      : label.includes("FLOODGATE") || label.includes("DRAIN") ? ASK_PAL.shield
      : ASK_PAL.arena;
    this.deps.fxp.burst(x, z, pal.mid, 16);
    this.deps.fxp.smoke(x, 0.5, z, 10, pal.rim);
    this.deps.shocks.spawn(x, z, pal.core, 3.8, 0.48);
    this.deps.decals.spawn(x, z, 1.2, 0x140d08, pal.mid, 8);
    this.deps.light(x, z, pal.mid, 9, 0.6, 1.1);
    this.deps.trauma(0.22);
  }

  /**
   * §5.7 — THE KILL MOMENT. Final-blow slow-mo, the seal opens, and the payoff
   * gets a beat to BREATHE before the collapse timer resumes. The corpse
   * landing is the renderer's own big-death beat; this is the room's answer.
   */
  private defeat(x: number, z: number): void {
    // THE ARMOUR COMES OFF WITH THE BOSS (r3 blocker). Two kill captures — both
    // BREAK-THE-SHIELD fights — showed the hex-lattice dome still fully drawn
    // over the word DEFEATED, which is the worst possible last image of a fight
    // whose whole ask was to break it. The rigs were reaped by RECONCILIATION
    // (the dead boss stops being seen), and reconciliation is a frame behind
    // the beat and a frame is the entire kill moment. So the beat tears them
    // down itself, and the reconciler keeps doing its job underneath.
    this.dropRigs();
    this.slowmo = Math.max(this.slowmo, 0.45);
    this.zoomWant = 0.9; // push IN on the corpse: the body is the subject now
    this.zoomHold = 2.4;
    this.orbitWant = 0.18;
    this.orbitHold = 2.4;
    this.deps.trauma(0.62);
    this.flash(0.45, 0.6);
    this.deps.shocks.spawn(x, z, 0xfff2cc, 9, 0.85);
    this.deps.shocks.spawn(x, z, 0xffb457, 14, 1.15);
    this.deps.fxp.column(x, z, 0xffd98a, 34, 4.4);
    this.deps.fxp.radialStreaks(x, 1.2, z, 0xfff8dc, 28, 5.0);
    this.deps.fxp.gibs(x, z, 0xc0552e, 18);
    this.deps.decals.spawn(x, z, 2.6, 0x140807, 0xc03024, 16);
    const k = this.budget(1.1);
    this.deps.light(x, z, 0xffd98a, 11 * k, 1.6, 2.2);
    this.arenaBeat(x, z, 11, ASK_PAL.window, 1.6, 1);
  }

  /** Every worn rig off, now: shields, plates, punish shafts, reticles. */
  private dropRigs(): void {
    for (const [k, mesh] of this.shields) { this.group.remove(mesh); this.shields.delete(k); }
    for (const [k, mesh] of this.plates) { this.group.remove(mesh); this.plates.delete(k); }
    for (const [k, rig] of this.punish) { this.group.remove(rig); this.punish.delete(k); }
    for (const [k, mesh] of this.marks) { this.group.remove(mesh); this.marks.delete(k); }
    this.marked.clear();
    this.prevShieldFrac.clear();
    // ...and the transient shell beats, which is the OTHER dome that could be
    // standing over the corpse when the shutter opens.
    for (const sh of this.shells) { sh.life = sh.max; sh.mesh.visible = false; }
  }

  /**
   * §5.7 — the loot payoff lands RINGSIDE in a readable arc, not under the
   * body where it is missed. The sim drops at the corpse; this draws the arc
   * the eye follows out to it and lights the ground where it comes to rest.
   */
  lootArc(fromX: number, fromZ: number, toX: number, toZ: number, hex: number): void {
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = fromX + (toX - fromX) * t;
      const pz = fromZ + (toZ - fromZ) * t;
      const py = 0.5 + Math.sin(t * Math.PI) * 2.1; // the arc's apex
      this.deps.fxp.sparks(px, py, pz, hex, 3);
    }
    this.deps.fxp.impactFlash(toX, 0.4, toZ, hex, 1.3);
    this.deps.shocks.spawn(toX, toZ, hex, 2.2, 0.55);
    this.deps.light(toX, toZ, hex, 7, 1.0, 0.8);
  }

  // -------------------------------------------------------------------------
  // ANCHORS. The silhouettes are only worth building if they sit on the things
  // the fight is actually about, so all three read the live world.
  // -------------------------------------------------------------------------

  /** The heading of whatever lane the sim just laid, or the crawler's bearing. */
  private laneHeading(x: number, z: number): number {
    const s = this.world;
    if (s) {
      let best: number | null = null;
      let bestD = 6.5;
      for (const h of s.hazards) {
        if (h.kind !== "beam" || !h.end) continue;
        const d = Math.hypot(h.pos.x - x, h.pos.y - z);
        if (d > bestD) continue;
        bestD = d;
        best = Math.atan2(h.end.y - h.pos.y, h.end.x - h.pos.x);
      }
      if (best !== null) return best;
      const p = s.players[0];
      if (p) return Math.atan2(p.pos.y - z, p.pos.x - x);
    }
    return 0;
  }

  /** Where the bodies that matter are standing (tethered adds first). */
  private addAnchors(x: number, z: number, want: number): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    const s = this.world;
    if (s) {
      for (const m of s.monsters) {
        if (m.hp <= 0 || m.kind === "boss") continue;
        const d = Math.hypot(m.pos.x - x, m.pos.y - z);
        if (d > 11 || d < 0.6) continue;
        out.push({ x: m.pos.x, z: m.pos.y });
        if (out.length >= Math.max(want, 3)) break;
      }
    }
    // No wave on the floor yet: the cords come out of the dark instead, which
    // is the same promise (bodies are arriving) one beat earlier.
    if (out.length === 0) {
      const n = Math.max(3, Math.min(6, want));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.35;
        out.push({ x: x + Math.cos(a) * 6.5, z: z + Math.sin(a) * 6.5 });
      }
    }
    return out;
  }

  /** Arena props and cover near the beat, as offsets in disc units. */
  private propAnchors(x: number, z: number, radius: number): THREE.Vector2[] {
    const out: THREE.Vector2[] = [];
    const s = this.world;
    if (!s) return out;
    // Interactive props first (they are the counterplay), then plain cover.
    const list = [...(s.breakables ?? [])].sort(
      (a, b) => (b.onBreak ? 1 : 0) - (a.onBreak ? 1 : 0));
    for (const b of list) {
      if (b.hp <= 0) continue;
      const dx = (b.pos.x - x) / radius, dz = (b.pos.y - z) / radius;
      if (dx * dx + dz * dz > 0.86) continue;
      out.push(new THREE.Vector2(dx, dz));
      if (out.length >= 8) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // POOLED SILHOUETTES.
  // -------------------------------------------------------------------------

  /** Pooled ground-plane silhouette (lanes / props / cells / set). */
  private shapeBeat(
    kind: ShapeKind, x: number, z: number, radius: number, pal: BossPalette,
    dur: number, tune?: (m: THREE.ShaderMaterial) => void,
  ): void {
    let slot = this.shapes.find((b) => b.kind === kind && b.life >= b.max);
    if (!slot) {
      if (this.shapes.length >= 10) {
        slot = this.shapes[0];
        for (const b of this.shapes) if (b.life / b.max > slot.life / slot.max) slot = b;
        if (slot.kind !== kind) {
          slot.mat.dispose();
          slot.mat = SHAPE_MAT[kind]();
          slot.mesh.material = slot.mat;
          slot.kind = kind;
        }
      } else {
        const mat = SHAPE_MAT[kind]();
        const mesh = new THREE.Mesh(TELEGRAPH_GEO, mat);
        mesh.renderOrder = 7;
        mesh.userData.noAO = true;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1, kind };
        this.shapes.push(slot);
      }
    }
    slot.life = 0;
    slot.max = dur;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, 0.09, z);
    slot.mesh.scale.setScalar(radius);
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
    (slot.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
    slot.mat.uniforms.uProg.value = 0;
    tune?.(slot.mat);
  }

  /** Pooled converging cord (the ADDS silhouette), add -> boss, chest height. */
  private cordBeat(
    fx: number, fz: number, tx: number, tz: number, pal: BossPalette, dur: number,
  ): void {
    let slot = this.cords.find((c) => c.life >= c.max);
    if (!slot) {
      if (this.cords.length >= 8) {
        slot = this.cords[0];
        for (const c of this.cords) if (c.life / c.max > slot.life / slot.max) slot = c;
      } else {
        const mat = makeTetherMat();
        const mesh = new THREE.Mesh(this.cordGeo, mat);
        mesh.renderOrder = 8;
        mesh.userData.noAO = true;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1 };
        this.cords.push(slot);
      }
    }
    const dx = tx - fx, dz = tz - fz;
    const len = Math.max(Math.hypot(dx, dz), 1e-3);
    slot.life = 0;
    slot.max = dur;
    slot.mesh.visible = true;
    slot.mesh.position.set(fx + dx / 2, 1.35, fz + dz / 2);
    slot.mesh.scale.set(len, 0.42, 1);
    slot.mesh.rotation.set(-Math.PI / 2, 0, -Math.atan2(dz, dx));
    slot.mat.uniforms.uLen.value = len;
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
    (slot.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
  }

  /** Pooled transient shell (the SHIELD silhouette) — the dome, cracking. */
  private shellBeat(x: number, z: number, pal: BossPalette, dur: number): void {
    let slot = this.shells.find((b) => b.life >= b.max);
    if (!slot) {
      if (this.shells.length >= 3) {
        slot = this.shells[0];
        for (const b of this.shells) if (b.life / b.max > slot.life / slot.max) slot = b;
      } else {
        const mat = makeShieldMat();
        const mesh = new THREE.Mesh(this.shellGeo, mat);
        mesh.renderOrder = 9;
        mesh.userData.noAO = true;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1 };
        this.shells.push(slot);
      }
    }
    slot.life = 0;
    slot.max = dur;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, 0.1, z);
    slot.mesh.scale.setScalar(2.6);
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
    (slot.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
    slot.mat.uniforms.uHit.value = 1;
  }

  /** Pooled arena ring (contracting warning / expanding sweep). */
  private arenaBeat(
    x: number, z: number, radius: number, pal: BossPalette, dur: number, out: 0 | 1,
    spoke: 0 | 1 = 0,
  ): void {
    let slot = this.beats.find((b) => b.life >= b.max);
    if (!slot) {
      if (this.beats.length >= 6) {
        slot = this.beats[0];
        for (const b of this.beats) if (b.life / b.max > slot.life / slot.max) slot = b;
      } else {
        const mat = makeArenaMat();
        const mesh = new THREE.Mesh(TELEGRAPH_GEO, mat);
        mesh.renderOrder = 7;
        mesh.userData.noAO = true;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1 };
        this.beats.push(slot);
      }
    }
    slot.life = 0;
    slot.max = dur;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, 0.08, z);
    slot.mesh.scale.setScalar(radius);
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
    (slot.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
    slot.mat.uniforms.uOut.value = out;
    slot.mat.uniforms.uProg.value = 0;
    slot.mat.uniforms.uSpoke.value = spoke;
  }

  // -------------------------------------------------------------------------
  // PERSISTENT RIGS. Plates, shield shells, tether cords, punish beacons —
  // reconciled by id every frame, the same discipline the renderer already
  // uses for telegraphs and hazards.
  // -------------------------------------------------------------------------

  update(state: GameState, dt: number, time: number, visible: (m: Monster) => boolean): void {
    this.world = state;
    // The exposure governor unwinds over about a second, so a single beat pays
    // nothing and a pile-up pays most of it back (§ EXPOSURE BUDGET) — and the
    // MEASURED term (the arena's own brightness) is folded in at the same time.
    this.load = Math.max(0, this.load - dt * 1.1);
    this.exposureScale = this.scaleFor(this.load);
    // The reticle's own countdown, independent of the sim's window length.
    for (const [id, mk] of this.marked) {
      mk.t -= dt;
      if (mk.t <= 0) this.marked.delete(id);
    }
    // Camera intent decays back to neutral: a beat BORROWS the frame, it does
    // not keep it. Normal combat always returns to the readable default.
    this.orbitHold = Math.max(0, this.orbitHold - dt);
    if (this.orbitHold <= 0) this.orbitWant = 0;
    // A push-in is a BEAT and beats end. Without this, the reveal's 0.78 held
    // for the entire fight (measured: zoom 0.78 four+ seconds after the card,
    // tools/_bugcam_before.json) and helped run the crawler off the screen.
    this.zoomHold = Math.max(0, this.zoomHold - dt);
    if (this.zoomHold <= 0 && this.zoomWant < 1) this.zoomWant = 1;
    const star = state.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    // Where the renderer takes its luminance sample (see measureBossExposure).
    this.starPos = star ? { x: star.pos.x, y: star.pos.y } : null;
    if (!star) this.zoomWant = 1;
    this.zoom += (this.zoomWant - this.zoom) * Math.min(1, dt * 2.6);
    this.orbit += (this.orbitWant - this.orbit) * Math.min(1, dt * 1.8);
    this.slowmo = Math.max(0, this.slowmo - dt);
    // ENCOUNTER FRAMING. Engaged means introduced, alive and actually close —
    // a boss across the floor must not yank the camera off the crawler.
    const p = state.players[0];
    const engaged = !!star && !!star.introduced && !!p &&
      Math.hypot(star.pos.x - p.pos.x, star.pos.y - p.pos.y) < 18;
    // The ringside reveal takes the framing too: the card is a LOWER-third, so
    // the star of the introduction has to be up out of it and clear of the
    // top-strip chips, which is the same pair of moves the fight uses.
    const revealing = !!state.encounter;
    const wantBias = engaged || revealing ? BossFx.ENC_BIAS : 0;
    const wantDrop = engaged || revealing ? BossFx.ENC_DROP : 0;
    // Eased, and slowly: the frame settling is not a beat, it is the shot.
    this.frameBias += (wantBias - this.frameBias) * Math.min(1, dt * 1.6);
    this.frameDrop += (wantDrop - this.frameDrop) * Math.min(1, dt * 1.6);

    // The governor's grip, applied to every live additive primitive. Shape is
    // never touched — only how hard it is allowed to burn.
    const dim = this.exposureScale;
    this.silhouetteLive =
      this.shapes.some((b) => b.life < b.max) ||
      this.cords.some((c) => c.life < c.max) ||
      this.shells.some((sh) => sh.life < sh.max);

    // ---- §5.1 THE APPROACH, IN THE WORLD (r3 minor).
    // The approach shipped as an audio beat only — the music bus ducking to a
    // drone — so the first frame of a six-beat chain was a dark empty room with
    // a tiny crawler in it. Diablo stages the approach in the WORLD: you read
    // the Butcher's room before the fight starts. This is that, cheaply, and it
    // is strictly ambient — no event, no camera, no card, no card-stealing
    // brightness. The boss carries a low-key rim so a silhouette exists in the
    // frame at all, embers drift off it, and the seal breathes at the
    // threshold. Everything here stops the instant the reveal takes the beat.
    if (star && !star.introduced && p &&
        Math.hypot(star.pos.x - p.pos.x, star.pos.y - p.pos.y) < 34) {
      const pal = ASK_PAL[bossFamily(star.bossId)];
      this.approachT += dt;
      this.approachLight -= dt;
      if (this.approachLight <= 0) {
        this.approachLight = 0.12;
        // A slow BREATH, never a pulse: this is a room being lit, not a beat.
        const breath = 0.55 + 0.45 * Math.sin(this.approachT * 1.1);
        this.deps.light(star.pos.x, star.pos.y, pal.rim, (1.5 + 1.3 * breath) * dim, 0.5, 2.4);
      }
      if (Math.random() < dt * 2.5) this.deps.fxp.embers(star.pos.x, star.pos.y, pal.mid, 1, 1.7);
      // The seal, at a whisper. It is the only ring in the game that CONTRACTS,
      // so it says "something in here closes behind you" before anything moves.
      if (this.approachT - this.approachRing > 3.4) {
        this.approachRing = this.approachT;
        this.arenaBeat(star.pos.x, star.pos.y, 6.5, pal, 2.6, 0);
      }
    } else if (this.approachT !== 0) {
      this.approachT = 0;
      this.approachRing = -9;
    }
    for (const b of this.beats) {
      if (b.life >= b.max) { b.mesh.visible = false; continue; }
      b.life += dt;
      b.mat.uniforms.uDim.value = dim;
      b.mat.uniforms.uTime.value = time;
      b.mat.uniforms.uProg.value = Math.min(1, b.life / b.max);
      if (b.life >= b.max) b.mesh.visible = false;
    }
    for (const b of this.shapes) {
      if (b.life >= b.max) { b.mesh.visible = false; continue; }
      b.life += dt;
      b.mat.uniforms.uDim.value = dim;
      b.mat.uniforms.uTime.value = time;
      b.mat.uniforms.uProg.value = Math.min(1, b.life / b.max);
      if (b.life >= b.max) b.mesh.visible = false;
    }
    for (const c of this.cords) {
      if (c.life >= c.max) { c.mesh.visible = false; continue; }
      c.life += dt;
      c.mat.uniforms.uDim.value = dim;
      c.mat.uniforms.uTime.value = time;
      if (c.life >= c.max) c.mesh.visible = false;
    }
    for (const s of this.shells) {
      if (s.life >= s.max) { s.mesh.visible = false; continue; }
      s.life += dt;
      const t = Math.min(1, s.life / s.max);
      s.mat.uniforms.uDim.value = dim;
      s.mat.uniforms.uTime.value = time;
      // The dome DRAINS bottom-up over the beat, which is what makes it read
      // as a shell failing rather than as a bubble appearing.
      s.mat.uniforms.uFill.value = 1 - t;
      s.mat.uniforms.uHit.value = Math.max(0, 1 - t * 2.4);
      if (s.life >= s.max) s.mesh.visible = false;
    }

    const plateSeen = this.seenPlates; plateSeen.clear();
    const shieldSeen = this.seenShields; shieldSeen.clear();
    const tetherSeen = this.seenTethers; tetherSeen.clear();
    const punishSeen = this.seenPunish; punishSeen.clear();
    this.seenMarks.clear();
    this.seenAides.clear();

    for (const m of state.monsters) {
      // ---- TETHER CORDS (V8). Drawn from the ADD, because the add is the
      // thing the player has to decide about. An untethered wave is chaff; a
      // cord turns it into a kill order.
      if (m.tetherId !== undefined && m.hp > 0) {
        const boss = state.monsters.find((o) => o.id === m.tetherId && o.hp > 0);
        if (boss) {
          tetherSeen.add(m.id);
          // §2.5 — THE ARRIVAL. An add wave that just appears is chaff; a wave
          // that ARRIVES is a decision. Each tethered body gets one burst and
          // one short column as it lands, in the adds hue, so the eye is
          // pulled to the new bodies rather than discovering them by damage.
          if (!this.greeted.has(m.id)) {
            this.greeted.add(m.id);
            if (visible(m)) {
              const ap = ASK_PAL.adds;
              this.deps.fxp.burst(m.pos.x, m.pos.y, ap.mid, 12);
              this.deps.fxp.column(m.pos.x, m.pos.y, ap.core, 8, 1.4);
              this.deps.shocks.spawn(m.pos.x, m.pos.y, ap.mid, 1.6, 0.36);
              this.deps.light(m.pos.x, m.pos.y, ap.mid, 4, 0.4, 0.9);
            }
          }
          let cord = this.tethers.get(m.id);
          if (!cord) {
            cord = new THREE.Mesh(this.tetherGeo, makeTetherMat());
            cord.renderOrder = 8;
            cord.userData.noAO = true;
            this.group.add(cord);
            this.tethers.set(m.id, cord);
          }
          const dx = boss.pos.x - m.pos.x, dz = boss.pos.y - m.pos.y;
          const len = Math.hypot(dx, dz);
          cord.position.set(m.pos.x + dx / 2, 1.3, m.pos.y + dz / 2);
          cord.scale.set(Math.max(len, 1e-3), 0.5, 1);
          cord.rotation.set(-Math.PI / 2, 0, -Math.atan2(dz, dx));
          const tm = cord.material as THREE.ShaderMaterial;
          tm.uniforms.uTime.value = time;
          tm.uniforms.uLen.value = len;
          tm.uniforms.uDim.value = dim;
          // FORCED ON (r3 major). The COUNCIL format is one body plus tethered
          // aides that shield it and hand over their verb on death, so the KILL
          // ORDER is the whole fight — and the capture of that fight had no
          // cords in it at all, because the rig was gated on the fog/LOD
          // predicate the world geometry uses. A feed cord is not scenery: it
          // is the answer to "which of these bodies matters", and the material
          // already draws depth-test-free for exactly that reason. If a boss
          // fight is on screen, its cords are on screen.
          cord.visible = true;

          // ...and the aide itself gets a mark, so it is not silhouetted like
          // trash. Rectilinear (see AIDE_FRAG) — every other feet-level mark in
          // the game is a circle, so "that one is on the board" reads at a
          // glance without reading a health bar.
          this.seenAides.add(m.id);
          let seat = this.aides.get(m.id);
          if (!seat) {
            seat = new THREE.Mesh(this.aideGeo, makeAideMat());
            seat.rotation.x = -Math.PI / 2;
            seat.renderOrder = 8;
            seat.userData.noAO = true;
            this.group.add(seat);
            this.aides.set(m.id, seat);
          }
          seat.position.set(m.pos.x, 0.1, m.pos.y);
          seat.scale.setScalar(1.5);
          const am = seat.material as THREE.ShaderMaterial;
          am.uniforms.uTime.value = time;
          am.uniforms.uDim.value = dim;
          (am.uniforms.uColor.value as THREE.Color).setHex(ASK_PAL.adds.mid);
          (am.uniforms.uCore.value as THREE.Color).setHex(ASK_PAL.adds.core);
          seat.visible = true;
        }
      }

      if (m.kind !== "boss" || m.hp <= 0) continue;
      const scale = 1.5; // boss rigs stand ~3x a crawler; the rigs hang off that

      // ---- SHIELD SHELL (V2).
      if ((m.shieldMax ?? 0) > 0 && (m.shieldHp ?? 0) > 0) {
        shieldSeen.add(m.id);
        let shell = this.shields.get(m.id);
        if (!shell) {
          shell = new THREE.Mesh(this.shieldGeo, makeShieldMat());
          shell.renderOrder = 9;
          shell.userData.noAO = true;
          this.group.add(shell);
          this.shields.set(m.id, shell);
        }
        const frac = Math.max(0, Math.min(1, (m.shieldHp ?? 0) / (m.shieldMax ?? 1)));
        shell.position.set(m.pos.x, 0.84 * scale, m.pos.y);
        shell.scale.setScalar(1.25 * scale);
        const sm = shell.material as THREE.ShaderMaterial;
        sm.uniforms.uTime.value = time;
        // The measured governor's hard clamp lives here more than anywhere:
        // a fresnel dome wrapped on the boss is what turned the Topiary Warden
        // into a white sphere with no shield and no body inside it.
        sm.uniforms.uDim.value = dim;
        sm.uniforms.uFill.value = frac;
        // The SCHOOL LOCK is the whole ask on The Sponsor: the lattice takes
        // the school's hue so "which one works" is answerable from the shell.
        const hex = m.shieldSchool === "magic" ? 0xa46bff
          : m.shieldSchool === "physical" ? 0xffb057 : ASK_PAL.shield.mid;
        (sm.uniforms.uColor.value as THREE.Color).setHex(hex);
        // Recent damage flashes the shell: chipping it must feel like progress.
        const prev = this.prevShieldFrac.get(m.id) ?? frac;
        sm.uniforms.uHit.value = Math.max(0, (sm.uniforms.uHit.value as number) - dt * 3.5);
        if (frac < prev - 1e-4) sm.uniforms.uHit.value = 1;
        this.prevShieldFrac.set(m.id, frac);
        shell.visible = visible(m);
      }

      // ---- PLATES (V1). Hung around the body at their authored angle.
      if (m.plates) {
        for (const pl of m.plates) {
          if (pl.broken) continue;
          const key = `${m.id}:${pl.key}`;
          plateSeen.add(key);
          let mesh = this.plates.get(key);
          if (!mesh) {
            mesh = new THREE.Mesh(this.plateGeo, makePlateMat());
            mesh.renderOrder = 9;
            mesh.userData.noAO = true;
            this.group.add(mesh);
            this.plates.set(key, mesh);
          }
          const r = 1.05 * scale;
          mesh.position.set(
            m.pos.x + Math.cos(pl.angle) * r,
            0.8 * scale + Math.sin(time * 1.6 + pl.angle) * 0.06,
            m.pos.y + Math.sin(pl.angle) * r,
          );
          mesh.scale.setScalar(0.82 * scale);
          // Faces outward from the body, so the panel reads from the fixed iso
          // camera and never vanishes edge-on.
          mesh.rotation.set(0, -pl.angle + Math.PI / 2, 0);
          const pm = mesh.material as THREE.ShaderMaterial;
          pm.uniforms.uTime.value = time + pl.angle;
          pm.uniforms.uHp.value = Math.max(0, Math.min(1, pl.hp / Math.max(1, pl.maxHp)));
          pm.uniforms.uImmune.value = pl.school ? 1 : 0;
          const hex = pl.school === "magic" ? 0xa46bff : pl.school === "physical" ? 0xffb057 : 0xd8c08a;
          (pm.uniforms.uColor.value as THREE.Color).setHex(hex);
          mesh.visible = visible(m);
        }
      }

      // ---- PUNISH BEACON (V4). The boss is helpless; this beat owns vertical
      // space nothing else in the game uses, so it can never be missed.
      const held = this.marked.get(m.id);
      if ((m.stagger ?? 0) > 0 || (m.windupKind === "punish" && m.windup > 0) || held) {
        punishSeen.add(m.id);
        let rig = this.punish.get(m.id);
        if (!rig) {
          rig = new THREE.Group();
          for (let i = 0; i < 2; i++) {
            const q = new THREE.Mesh(this.punishGeo, makePunishMat());
            q.rotation.y = (i * Math.PI) / 2; // a crossed pair reads from any yaw
            q.renderOrder = 10;
            q.userData.noAO = true;
            rig.add(q);
          }
          this.group.add(rig);
          this.punish.set(m.id, rig);
        }
        const h = 3.0 * scale;
        rig.position.set(m.pos.x, h / 2, m.pos.y);
        // Normalised against the punish window itself, so the shaft's drain IS
        // the seconds remaining (CONFIG.bossPunishWindow is 2.2s).
        // The countdown the shaft drains and the brackets close on. The HELD
        // span wins when it is longer than the sim's window: a two-second
        // stagger on a client presenting a frame every few hundred ms is a
        // beat nobody sees, and this is the beat that most needs to read.
        const left = held
          ? Math.max(0, Math.min(1, held.t / held.span))
          : (m.stagger ?? 0) > 0
            ? Math.min(1, (m.stagger ?? 0) / 2.2)
            : Math.min(1, m.windup / Math.max(m.windupTotal, 1e-3));
        for (const child of rig.children) {
          const q = child as THREE.Mesh;
          q.scale.set(1.9 * scale, h, 1);
          const qm = q.material as THREE.ShaderMaterial;
          qm.uniforms.uTime.value = time;
          qm.uniforms.uDim.value = dim;
          qm.uniforms.uLeft.value = left;
        }
        // Forced on for the same reason the cords are: this is the beat the
        // whole rhythm is built around, and it lasts about two seconds.
        rig.visible = true;
        // THE RETICLE (capture review, round 2). The shaft alone was losing
        // the beat against a busy floor, and the burst that used to sell it
        // was a starburst indistinguishable from a routine telegraph. The
        // brackets are the fix: four corners closing on the core, on the
        // ground, at a rate that IS the countdown. Nothing else in the game
        // draws a reticle, so this beat can never be read as anything else.
        let mark = this.marks.get(m.id);
        if (!mark) {
          mark = new THREE.Mesh(this.markGeo, makeMarkMat());
          mark.rotation.x = -Math.PI / 2;
          mark.renderOrder = 10;
          mark.userData.noAO = true;
          this.group.add(mark);
          this.marks.set(m.id, mark);
        }
        this.seenMarks.add(m.id);
        mark.position.set(m.pos.x, 0.11, m.pos.y);
        // Pulled in from 3.1: at the old radius the brackets closed from
        // outside the readable frame, which is half of why no capture ever
        // caught them. They now open just clear of the rig and close ON it.
        mark.scale.setScalar(2.3 * scale);
        const mm = mark.material as THREE.ShaderMaterial;
        mm.uniforms.uTime.value = time;
        mm.uniforms.uDim.value = dim;
        mm.uniforms.uLeft.value = left;
        (mm.uniforms.uColor.value as THREE.Color).setHex(ASK_PAL.window.mid);
        (mm.uniforms.uCore.value as THREE.Color).setHex(ASK_PAL.window.core);
        mark.visible = rig.visible;
        // Motes fall INTO the exposed core on a tick — an invitation, not
        // chaff. Deliberately sparse: this beat can stay open for two seconds
        // and a dense additive gather turns the arena into a white card.
        if (rig.visible && Math.random() < dt * 5) {
          this.deps.fxp.gather(m.pos.x, 1.2 * scale, m.pos.y, ASK_PAL.window.core, 0.85);
        }
      }

      // ---- ENRAGE HEAT: permanent for the rest of the fight, so ambient.
      if ((m.enrageStacks ?? 0) > 0 && visible(m) && Math.random() < dt * 5 * (m.enrageStacks ?? 1)) {
        this.deps.fxp.embers(m.pos.x, m.pos.y, 0xff4a1e, 2, 1.3 * scale);
      }
      // ---- INTERMISSION: untargetable reads as the boss being LIFTED out of
      // the fight — a cool gather and no hit response, never just "invisible".
      if ((m.invulnT ?? 0) > 0 && visible(m) && Math.random() < dt * 4) {
        this.deps.fxp.gather(m.pos.x, 1.4 * scale, m.pos.y, 0xbfe4ff, 0.7);
      }
    }

    // ---- INTERACTIVE PROPS AS THINGS IN THE WORLD (V3). A floodgate the
    // player is supposed to break has to look POWERED, or "use the arena" is
    // a sentence in a tooltip. One prop per frame, round-robin, so this stays
    // O(1) next to a fight; the hue is the counterplay's own family, so the
    // props colour-match the beat that will point at them.
    const props = state.breakables ?? [];
    if (star && props.length > 0) {
      this.propTick = (this.propTick + 1) % props.length;
      const b = props[this.propTick];
      if (b.onBreak && b.hp > 0) {
        const pal = b.onBreak === "vent" ? ASK_PAL.window
          : b.onBreak === "shutdown" ? ASK_PAL.adds
          : b.onBreak === "drain" ? ASK_PAL.shield
          : ASK_PAL.arena;
        this.deps.light(b.pos.x, b.pos.y, pal.mid, 3.2, 0.34, 0.7);
        if (Math.random() < 0.4) this.deps.fxp.embers(b.pos.x, b.pos.y, pal.core, 2, 0.9);
      }
    }

    // Reap.
    for (const [k, mesh] of this.plates) {
      if (!plateSeen.has(k)) { this.group.remove(mesh); this.plates.delete(k); }
    }
    for (const [k, mesh] of this.shields) {
      if (!shieldSeen.has(k)) {
        this.group.remove(mesh); this.shields.delete(k); this.prevShieldFrac.delete(k);
      }
    }
    for (const [k, mesh] of this.tethers) {
      if (!tetherSeen.has(k)) {
        this.group.remove(mesh);
        this.tethers.delete(k);
        this.greeted.delete(k);
      }
    }
    for (const [k, rig] of this.punish) {
      if (!punishSeen.has(k)) { this.group.remove(rig); this.punish.delete(k); }
    }
    for (const [k, mesh] of this.marks) {
      if (!this.seenMarks.has(k)) { this.group.remove(mesh); this.marks.delete(k); }
    }
    for (const [k, mesh] of this.aides) {
      if (!this.seenAides.has(k)) { this.group.remove(mesh); this.aides.delete(k); }
    }
  }

  /** Per-hazard spore material (the Pollinator's pods), pooled by hazard id. */
  sporeMat(id: number): THREE.ShaderMaterial {
    let m = this.sporeMats.get(id);
    if (!m) { m = makeSporeMat(); this.sporeMats.set(id, m); }
    return m;
  }

  releaseSpore(id: number): void {
    const m = this.sporeMats.get(id);
    if (m) { m.dispose(); this.sporeMats.delete(id); }
  }
}
