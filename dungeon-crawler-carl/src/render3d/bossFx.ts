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
    // ---- r5 BLOCKER: THIS RENDERED AS AN OPAQUE LOW-POLY EGG --------------
    // Claimed as "a fresnel shell that CRACKS"; captured as a hard-faceted
    // grey-white balloon with visible flat polygons, no gradient and no
    // cracks — the largest object in the finale's frame, with the boss
    // invisible inside it, and two overlapping copies of it hiding the arena
    // floor on the Permit Office.
    //
    // The shader was not the whole cause (the mesh was DoubleSide additive, so
    // every pixel was drawn twice and summed — see makeShieldMat) but it was
    // most of it: the FILL carried the read, so the middle of the dome was the
    // brightest part of it. A shell is a RIM. Inverted here:
    //   * the interior is nearly empty — the fresnel is sharper and the body
    //     term is gated ON it, so the boss's silhouette reads THROUGH the
    //     shell instead of being summed over,
    //   * the lattice is the second read, not the first, and
    //   * the CRACKS are unconditional and grow with damage, because a shell
    //     that cracks has to crack while it still exists rather than only
    //     across the cells it has already lost.
    float ndv = clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 3.4);
    float rimOnly = smoothstep(0.55, 0.95, 1.0 - ndv); // hard rim gate
    vec2 id;
    // The lattice DRIFTS around the body: a live field, never a decal.
    float d = hexCell(vec2(vUv.x * 22.0 + uTime * 0.35, vUv.y * 13.0), id);
    float wall = smoothstep(0.11, 0.0, d);
    float lit = shH(id * 0.31);
    // Cells die from the BOTTOM UP as the pool drains, so the crown stays
    // readable while the shield is nearly gone.
    float death = smoothstep(uFill + 0.14, uFill - 0.06, vUv.y * 0.72 + lit * 0.28);
    float alive = 1.0 - death;
    // STRESS FRACTURES. Present from the first chip, widening as the pool
    // drains: jagged meridian splits that run down the shell and brighten at
    // their edges, so "it is failing" is legible before it has failed.
    float dmg = clamp(1.0 - uFill, 0.0, 1.0);
    float seam = abs(fract(vUv.x * 7.0 + lit * 0.6 + sin(vUv.y * 5.0 + lit * 6.0) * 0.06) - 0.5);
    float split = smoothstep(0.045 + 0.05 * (1.0 - dmg), 0.0, seam)
                * smoothstep(0.02, 0.35, dmg)
                * smoothstep(0.05, 0.45, vUv.y);
    float crack = split * (0.55 + 0.45 * sin(uTime * 2.0 + lit * 6.28));
    float breathe = 0.72 + 0.28 * sin(uTime * 3.1 + lit * 6.28);
    // THE BODY IS A RIM. At full pool the middle of the dome is ~4% alpha:
    // enough to tint the boss, nowhere near enough to hide it.
    float body = fres * rimOnly * (0.2 + 0.22 * alive) * breathe + 0.035 * alive;
    float latt = wall * (0.05 + 0.26 * alive) * (0.35 + 0.65 * fres);
    float a = clamp(body + latt + crack * 0.42 + uHit * rimOnly * 0.45, 0.0, 0.44) * uDim;
    vec3 col = mix(uColor, uCore, clamp(latt * 1.2 + crack + uHit * 0.6, 0.0, 1.0))
             * (0.75 + 1.1 * latt + 1.4 * uHit + 0.9 * crack + 0.5 * fres);
    col = mix(col * 0.3, col, alive); // dead cells go to ash
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
    // FRONT FACE ONLY (r5 blocker). DoubleSide + additive drew every pixel of
    // the dome TWICE and summed them, which is half of why a shader whose
    // peak alpha was 0.86 photographed as a solid grey-white balloon: the far
    // hemisphere's rim added straight onto the near hemisphere's interior, so
    // the middle of the shell — the part that must stay clear for the boss to
    // read through it — was the brightest region on screen.
    side: THREE.FrontSide,
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
  // TELL vs WINDOW (r4). The same shaft says two things a beat apart: the
  // OVER-COMMIT telegraph ("a window is opening HERE") and the window itself.
  // The telegraph has ~1.3 seconds and has to be read in 0.2 of them, so it
  // runs hotter; the window stands for two full seconds over a boss and stays
  // at the shipped whisper. Same geometry, same motion, different volume.
  uniform float uGain;
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
    float a = clamp((chev * 0.26 + body * 0.07 + rail * 0.34) * (1.0 - drain) * uGain,
                    0.0, 0.4 * uGain) * uDim;
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
      uGain: { value: 1 },
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
  uniform float uGap;   // >0: THE SEAL OPENS — four arcs retreating, not a ring
  uniform float uTicks; // >0: THE THRESHOLD SEAL — this band's glyph count
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
    // THE SEAL OPENS (r5 major). The kill mark, the intermission sweep and the
    // arena warning all resolved to the same two-ring cream decal — one shape
    // wearing three sentences, which is the failure §5.9 spent a whole round
    // deleting elsewhere. The KILL is not a warning and not a sweep: it is a
    // seal COMING APART, so its ring is cut into four arcs by hard radial gaps
    // that WIDEN as it travels. Reduced to a mask it is a broken ring, and
    // nothing else in the game is broken.
    if (uGap > 0.0) {
      float g = abs(fract(ang / 1.5707963 + 0.5) - 0.5) * 2.0; // 0 at each gap
      float open = smoothstep(0.0, 0.16 + 0.34 * uProg, g);
      band *= open; edge *= open; chev *= open; swept *= open;
    }
    // THE THRESHOLD SEAL IS AUTHORED (r6 major). Across all eight bosses of
    // the last round the approach and intro seals were the same fat pure-white
    // ellipse: same stroke weight, same colour, no material, no glyphs, no tie
    // to the band or the ask — the single most-repeated element in the boss
    // presentation and the least authored. Two things fix it and both are
    // here. (1) GLYPHS: uTicks hard bars stand across the ring, one per BAND,
    // so the Undercroft's seal is a single mark and the Approach's is six —
    // countable, and the same count the floor plate shows. (2) The ring stops
    // going WHITE: with glyphs on, the core mix is halved and the gain comes
    // down, so the ASK's own hue survives the additive pass and a
    // break-the-shield threshold is visibly not a survive-the-storm one.
    float tick = 0.0;
    if (uTicks > 0.0) {
      float seg = 6.28318530718 / uTicks;
      float t = abs(fract(ang / seg + 0.5) - 0.5) * 2.0;   // 0 at each glyph
      float across = smoothstep(0.09, 0.0, t);
      float along = smoothstep(0.13, 0.0, abs(r - front)); // the bar's length
      tick = across * along;
    }
    float glyphed = step(0.5, uTicks);
    float fade = 1.0 - smoothstep(0.55, 1.0, uProg);
    // EXPOSURE BUDGET (capture review): at arena scale this disc covers most of
    // the screen, and it is ADDITIVE. The first cut filled its interior and
    // detonated the bloom pass — the intermission read as a lens flare with a
    // health bar on it. The beat is the travelling FRONT; everything behind it
    // is a whisper, so the arena stays legible while the board is re-dealt.
    float a = clamp((edge * mix(0.34, 0.2, glyphed) + band * 0.05 + chev * 0.14
                     + spoke * 0.3 + tick * 0.42) * fade, 0.0, 0.44) * uDim;
    vec3 col = mix(uColor, uCore, clamp(edge * mix(1.4, 0.55, glyphed) + chev + tick, 0.0, 1.0))
             * (mix(0.8, 0.7, glyphed) + mix(1.5, 0.6, glyphed) * edge + 0.8 * chev + 1.4 * tick);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makeArenaMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(ASK_PAL.arena.mid) },
      uCore: { value: new THREE.Color(ASK_PAL.arena.core) },
      uTime: { value: 0 }, uProg: { value: 0 }, uOut: { value: 0 },
      uSpoke: { value: 0 }, uGap: { value: 0 }, uTicks: { value: 0 }, uDim: { value: 1 },
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
// r7 MAJOR — "THE PERMIT OFFICE'S FOUR STAMPS ARE FOUR BLANK WHITE QUADS."
//
// The plate names them beautifully — STAMP: STRUCTURAL / ELEMENTAL / OCCUPANCY
// / VARIANCE, with schools, greying out the broken one — and the four objects
// in the WORLD carried no icon, no school hue and the same rectangle outline as
// the punish reticle and the loot beacons. Three separate defects in one quad:
//
//  * NO HUE. The renderer was already passing the school colour in `uColor` and
//    this shader spent it on `uColor * 0.09` — the near-black field — while
//    every lit pixel came from `uCore`, a fixed cream. So the two magic stamps
//    and the two physical stamps were the same colour as each other and as the
//    bare lockbox on floor 3.
//  * NO ICON. Four stamps whose whole mechanic is "these two want a different
//    school from those two" and nothing on the object said which was which.
//  * NO SILHOUETTE OF ITS OWN. A plain square outline, i.e. the shape §5.9
//    reserves for "aim here".
//
// So: a STAMP is a chamfered tablet (cut corners — not a rectangle), the bezel
// and rule carry the SCHOOL's hue, and each one wears a procedural glyph keyed
// off its index — wedge / bolt / arch / slash. Reduced to a mask, four
// different marks on four cut-cornered tablets.
const PLATE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uHp;     // 1 pristine -> 0 about to break
  uniform float uImmune; // 1 = this plate refuses a school (draw the bar)
  uniform float uGlyph;  // which mark this stamp wears (0..3)
  varying vec2 vUv;
  float plH(vec2 q) { return fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    vec2 a2 = abs(p);
    float r = max(a2.x, a2.y);
    // CHAMFERED: the corners are cut, so the outline is an octagon-ish tablet
    // and not the square the reticle and the beacons are built from.
    float cham = (a2.x + a2.y) * 0.72;
    float shape = max(r, cham);
    float bezel = smoothstep(0.82, 0.94, shape) * (1.0 - smoothstep(0.99, 1.0, shape));
    float rule = smoothstep(0.62, 0.66, shape) * (1.0 - smoothstep(0.7, 0.74, shape));
    float field = 1.0 - smoothstep(0.9, 1.0, shape);
    // ---- THE MARK. One procedural glyph per stamp, drawn in the dark field.
    vec2 q = p * 1.9;
    float g = 0.0;
    if (uGlyph < 0.5) {
      // WEDGE (structural): a load-bearing triangle.
      float tri = max(abs(q.x) * 0.87 + q.y * 0.5, -q.y * 0.5);
      g = smoothstep(0.44, 0.30, tri) * (1.0 - smoothstep(0.30, 0.16, tri));
    } else if (uGlyph < 1.5) {
      // BOLT (elemental): a lightning zig, two strokes.
      float z = abs(q.x - sign(q.y) * 0.26) - 0.10;
      g = smoothstep(0.10, 0.0, z) * step(abs(q.y), 0.52);
    } else if (uGlyph < 2.5) {
      // ARCH (occupancy): a doorway — two posts and a lintel.
      float post = smoothstep(0.11, 0.0, abs(a2.x - 0.34)) * step(q.y, 0.22) * step(-0.52, q.y);
      float lint = smoothstep(0.11, 0.0, abs(q.y - 0.30)) * step(a2.x, 0.45);
      g = max(post, lint);
    } else {
      // SLASH (variance): the exception, struck across the form.
      g = smoothstep(0.11, 0.0, abs(q.x - q.y) * 0.71) * step(max(a2.x, a2.y), 0.5);
    }
    g *= field;
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
    float a = clamp(field * 0.78 + bezel * 0.95 + rule * 0.5 + crack * 0.8
                    + bar * 0.8 + g * 0.85, 0.0, 0.96);
    // THE SCHOOL IS THE HUE (r7). The lit terms mix toward uColor — the school
    // tint the host has been passing all along — and only the CRACKS run to the
    // hot core, so "this one is nearly off" stays the brightest thing on it.
    vec3 lit = mix(uColor, uCore, clamp(crack * 1.4, 0.0, 1.0));
    vec3 col = mix(uColor * 0.09, lit,
                   clamp(bezel * 1.3 + rule * 0.6 + crack * 1.6 + bar + g, 0.0, 1.0))
             * (0.55 + 2.1 * bezel * pulse + 2.4 * crack + 0.8 * bar + 1.5 * g);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makePlateMat(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xd8c08a) },
      uCore: { value: new THREE.Color(0xfff2cc) },
      uTime: { value: 0 }, uHp: { value: 1 }, uImmune: { value: 0 },
      uGlyph: { value: 0 },
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
  uniform float uAng;  // the wedge the Showrunner is shooting (r7)
  uniform float uArc;  // its half-width; <= 0 = this beat has no wedge
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
    // ---- THE SHOT (r7 major) ---------------------------------------------
    //
    // "CAMERA MOVE has no safe-wedge language." The one beat in the game whose
    // read is the SAFE ground drew three flats in a corner and nothing on the
    // floor: showrunner-3fight.png probed shapes {set:3, props:1} and the
    // ground the player is being told to stand on had no treatment at all.
    // The flats are the SET; this is the CAMERA. uAng is the wedge the
    // Showrunner is shooting (the sim own number, straight off the beat) and
    // uArc its half-width. Inside the shot the floor carries a clean lit
    // wedge with a hard frame edge down each side and a lens vignette pulling
    // the eye into it; outside it the ground is HATCHED — the same language a
    // camera's own safe-area guides use, and nowhere else in this game.
    // uArc <= 0 means "this beat has no wedge" and the whole term drops out,
    // so every other set caster is unaffected.
    float shot = 0.0, frame = 0.0, off = 0.0;
    if (uArc > 0.001) {
      float ang = atan(p.y, p.x) - uAng;
      ang = mod(ang + 3.14159265, 6.2831853) - 3.14159265;
      float d = abs(ang);
      float inShot = 1.0 - smoothstep(uArc * 0.92, uArc, d);
      float r2 = length(p);
      shot = inShot * (1.0 - smoothstep(0.15, 1.0, r2)) * 0.55;
      // Two hard frame lines down the edges of the shot: the safe area's border.
      frame = smoothstep(0.045, 0.0, abs(d - uArc)) * step(0.06, r2);
      // Everything outside the shot is struck ground, hatched on the diagonal.
      off = (1.0 - inShot) * smoothstep(0.55, 0.98, sin((p.x - p.y) * 26.0))
          * (1.0 - smoothstep(0.85, 1.0, r2)) * 0.5;
    }
    float a = clamp((lip * 0.85 + batten * 0.3 + floorline + (inL + inR) * 0.12
                     + shot + frame * 0.9 + off) * fade, 0.0, 0.82) * uDim;
    vec3 col = mix(uColor, uCore, clamp(lip * 1.5 + frame * 1.4 + shot * 0.8, 0.0, 1.0))
             * (0.8 + 1.8 * lip + 0.6 * batten + 1.6 * frame + 0.7 * shot);
    // The struck ground is DARK hatching, not another bright layer: the shot
    // has to be the brightest thing in the frame or the read inverts.
    col = mix(col, uColor * 0.25, clamp(off * 1.6, 0.0, 1.0));
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

// ---------------------------------------------------------------------------
// BURROW (the PIT PULLS / the roots take hold / the grease rises). r4 blocker:
// this ask had NO geometry of its own — it called the shared contracting arena
// ring, which is also the arena warning, also the approach seal and (through
// OVER-COMMIT) also the punish telegraph every one of the eighteen bosses
// fires. Five different things wearing one shape is the exact failure the
// silhouette rule exists to prevent.
//
// Its own shape: a five-vaned PINWHEEL of spiral arms sweeping into a hard
// MOUTH that contracts as the beat runs, with material travelling INWARD down
// the vanes. Nothing else in the game curves. Reduced to a black-and-white
// mask it is a pinwheel with a hole in it — unmistakable next to a ring
// (concentric fronts), lanes (straight bars), cells (a grid) or props
// (brackets out at the walls).
// ---------------------------------------------------------------------------
const BURROW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    // THE SHEAR IS THE SHAPE: offsetting the angle by the radius turns five
    // straight vanes into five curved ones, and the curve is what says
    // "rotating inward" rather than "pointing outward".
    float sw = ang + r * 3.2 - uTime * 1.1;
    float vane = smoothstep(0.42, 0.9, sin(sw * 5.0));
    // The MOUTH closes over the beat: the hole is the countdown.
    float mouth = mix(0.44, 0.13, uProg);
    float rim = smoothstep(0.075, 0.0, abs(r - mouth));
    float lip = smoothstep(0.16, 0.02, abs(r - mouth));
    // Vanes live OUTSIDE the mouth only, and taper as they reach it, so the
    // eye is walked down them into the hole.
    float reach = smoothstep(mouth - 0.02, mouth + 0.16, r) * (1.0 - smoothstep(0.86, 1.0, r));
    float taper = smoothstep(1.0, mouth, r);
    // Material travelling IN, never out. The only inward-running fill in the
    // game apart from the arena warning's front, and that one has no vanes.
    float pulse = smoothstep(0.55, 1.0, fract(r * 2.6 + uTime * 1.5)) * vane * reach;
    float fade = 1.0 - smoothstep(0.72, 1.0, uProg);
    float a = clamp((vane * reach * (0.2 + 0.3 * taper) + rim * 0.6 + lip * 0.08 + pulse * 0.26)
                    * fade, 0.0, 0.72) * uDim;
    vec3 col = mix(uColor, uCore, clamp(rim * 1.5 + pulse, 0.0, 1.0))
             * (0.85 + 1.7 * rim + 1.1 * pulse);
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
  uniform float uGain;  // see PUNISH_FRAG: the TELL runs hotter than the window
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
    float alpha = clamp((line * 0.72 + glow * 0.3 + cross * 0.5) * pulse * uGain, 0.0, 0.95) * uDim;
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

// ---------------------------------------------------------------------------
// THE BAR WIPE (THE COMMERCIAL BREAK) — acceptance r5, major.
//
// The finding: the intermission sweep, the kill mark and the arena warning all
// resolved to the same two-ring cream decal. §5.9 reserved the spoked ring to
// one signature and then let the plain ring family absorb three sentences.
//
// The intermission is not a ring at all. It is a BROADCAST WIPE: a hard-edged
// bar crossing the arena along the camera diagonal with scanline ribs behind
// it and clean floor in front, which is exactly what the beat means — the
// board is being re-dealt, left to right, and everything the bar has passed is
// clear. Rectilinear and single-axis, so it cannot be confused with any ring,
// and it is the only full-arena beat that has a DIRECTION.
// ---------------------------------------------------------------------------
const WIPE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    if (length(p) > 1.0) discard;
    // Travels across the disc; the leading edge is the read.
    float front = -1.15 + uProg * 2.3;
    float d = p.x - front;
    float lip = smoothstep(0.08, 0.0, abs(d));
    // SCANLINE RIBS behind the bar: a wipe, not a fog front.
    float behind = step(d, 0.0);
    float ribs = smoothstep(0.45, 0.95, sin(p.y * 22.0 - uTime * 3.0)) * behind
               * smoothstep(-0.85, -0.05, d);
    // A thin trailing rail so the swept region has a floor line.
    float rail = smoothstep(0.02, 0.0, abs(p.y)) * behind * 0.5;
    float fade = 1.0 - smoothstep(0.74, 1.0, uProg);
    float a = clamp((lip * 0.8 + ribs * 0.2 + rail) * fade, 0.0, 0.58) * uDim;
    vec3 col = mix(uColor, uCore, clamp(lip * 1.6, 0.0, 1.0)) * (0.8 + 1.9 * lip + 0.5 * ribs);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

// ---------------------------------------------------------------------------
// SEED BED (BLOOM / SEED HEAD / GROUNDWATER BLOOM) — r6 BLOCKER.
//
// The finding: "THE POLLINATOR'S FIGHT BEAT DRAWS NOTHING." Its `-3fight`
// capture probed `shapes:{}` while the sim was emitting `telegraph:BLOOM` —
// because the `swarm` case in `telegraph()` was a particle burst and a ring of
// embers and NO GEOMETRY AT ALL. The one survive-the-storm boss in the set had
// no storm on screen: no armed pods, no spore silhouette, one thin green arc
// with half of it behind a tree. A named signature that resolves to zero
// shapes is the same failure as having no kit.
//
// Its own silhouette, and it is the one thing on the ground that is not a line
// or a front: a SCATTER of pods. The disc is cut into cells, each cell holds
// one hash-jittered pod, and every pod is the same object the hazard renderer
// already draws (makeSporeMat's language — petal SEAMS that spread as it arms
// over a core that swells), so the telegraph and the thing it telegraphs speak
// the same sentence. Reduced to a black-and-white mask it is a spatter of
// small round blobs across the arena: unmistakable next to chevroned bars
// (lanes), converging cords, a cracking dome, corner brackets at the walls
// (props), a lit grid (cells), a pinwheel (burrow) or a concentric front
// (ring). Nothing else in the game is DISCONTINUOUS.
// ---------------------------------------------------------------------------
const SEED_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;
  uniform float uDim;
  uniform float uN;     // pods across the disc (the sim's own count)
  varying vec2 vUv;
  float h21(vec2 p) {
    return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    // The bed grid. More pods = a finer grid, so "value" is legible as DENSITY.
    float g = clamp(uN, 3.0, 7.0);
    vec2 c = floor(p * g);
    vec2 f = p * g - c - 0.5;
    // Hash-jitter each pod inside its own cell; stable for the beat's life.
    vec2 j = vec2(h21(c), h21(c + 17.0)) - 0.5;
    vec2 d = f - j * 0.62;
    float pr = length(d);
    // Pods SWELL as the beat runs — the countdown is the silhouette.
    float rad = mix(0.16, 0.34, uProg);
    float body = smoothstep(rad, rad * 0.55, pr);
    float rim = smoothstep(0.05, 0.0, abs(pr - rad));
    // PETAL SEAMS: three cuts that open across the pod as it arms, exactly the
    // read makeSporeMat gives the live hazard.
    float ang = atan(d.y, d.x);
    float seam = smoothstep(0.86, 1.0, abs(sin(ang * 1.5 + h21(c + 3.0) * 6.28)))
               * body * smoothstep(0.15, 0.75, uProg);
    // A core that comes up late: the pod is about to go.
    float core = smoothstep(rad * 0.42, 0.0, pr) * smoothstep(0.35, 1.0, uProg);
    // Thin out toward the rim so the bed sits inside the arena, not on it.
    float bed = 1.0 - smoothstep(0.72, 1.0, r);
    float fade = 1.0 - smoothstep(0.78, 1.0, uProg);
    float a = clamp((body * 0.28 + rim * 0.6 + core * 0.5 - seam * 0.5)
                    * bed * fade, 0.0, 0.8) * uDim;
    vec3 col = mix(uColor, uCore, clamp(rim * 1.2 + core, 0.0, 1.0))
             * (0.85 + 1.6 * rim + 1.4 * core);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
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
export const makeSetMat = (): THREE.ShaderMaterial =>
  makeQuadMat(SET_FRAG, { uAng: { value: 0 }, uArc: { value: 0 } });
export const makeBurrowMat = (): THREE.ShaderMaterial => makeQuadMat(BURROW_FRAG, {});
export const makeWipeMat = (): THREE.ShaderMaterial => makeQuadMat(WIPE_FRAG, {});
export const makeSeedMat = (): THREE.ShaderMaterial => makeQuadMat(SEED_FRAG, { uN: { value: 5 } });
export const makeMarkMat = (): THREE.ShaderMaterial => {
  const m = makeQuadMat(MARK_FRAG, { uLeft: { value: 1 }, uGain: { value: 1 } });
  // DEPTH-TEST FREE, for exactly the reason the tether cords are (r5 blocker).
  // Six of twelve punish captures reported no punish geometry on screen at
  // all while the rig existed and was flagged visible — the reticle is a
  // ground quad at y ~0.11 competing with the boss's own ritual disc, the
  // arena decals and whatever the floor mesh does at that height, and losing.
  // "Aim HERE" is a HUD statement that happens to live in the world; a
  // reticle the floor can hide answers nothing.
  m.depthTest = false;
  return m;
};
export const makeAideMat = (): THREE.ShaderMaterial => makeQuadMat(AIDE_FRAG, {});

// ---------------------------------------------------------------------------
// THE LOOT BEACON — r7 BLOCKER: "the loot beacon and the punish reticle are the
// same silhouette."
//
// They were. The beacon borrowed `AIDE_FRAG` (a notched square seat = four
// corner brackets) in cream/gold, and MARK_FRAG is four corner brackets closing
// on a cross, also in cream/gold. Compare `marshal-6kill.png` with
// `sumpking-5punish.png` and the two ground marks are the same object. §5.9's
// own rule is that two beats a player can confuse at a glance mean the SHAPE is
// wrong — and this pair is the worst possible collision, because one of them
// means "commit here NOW, the boss cannot answer" and the other means "a sword
// fell here, pick it up whenever".
//
// The split is total and it is on the axis that reads first:
//   PUNISH  = OPEN corner brackets that CLOSE inward, plus a vertical shaft.
//             Nothing is filled; the middle is a cross of hairlines.
//   LOOT    = a SOLID chamfered diamond pad with a descending CARET stacked
//             over it. Filled, static, no corners, no verticals, no closing.
// Reduced to a black-and-white mask one is an outline and the other is a blob
// with an arrow on it. There is no glance at which they agree.
// ---------------------------------------------------------------------------
const LOOT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uProg;   // 0 landed -> 1 expiring
  uniform float uDim;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    // THE PAD: a filled diamond (L1 ball), chamfered, with a bright lip. Solid
    // is the whole point — every "aim" mark in this game is hollow.
    float dia = abs(p.x) + abs(p.y);
    float pad = smoothstep(0.62, 0.50, dia);
    float lip = smoothstep(0.07, 0.0, abs(dia - 0.60));
    // THE CARET: a chevron pointing DOWN at the pad, riding a slow bob. Read as
    // "the thing is here", the grammar of a map pin, and the only descending
    // arrow in the game.
    float bob = 0.30 + 0.05 * sin(uTime * 2.6);
    vec2 q = vec2(p.x, p.y + bob);
    float v = abs(q.x) - q.y;                 // 0 on the chevron's own vee
    float caret = smoothstep(0.075, 0.0, abs(v))
                * step(abs(q.x), 0.30) * step(-0.34, q.y);
    // A second, fainter caret above it: a stack, so the pin has height without
    // ever standing a column up (that silhouette belongs to the punish beat).
    vec2 q2 = vec2(p.x, p.y + bob + 0.26);
    float v2 = abs(q2.x) - q2.y;
    float caret2 = smoothstep(0.07, 0.0, abs(v2))
                 * step(abs(q2.x), 0.22) * step(-0.26, q2.y) * 0.45;
    // Settles as it lands, then fades out whole. No pulsing countdown: this
    // mark is not a clock, and a mark that ticks reads as a demand.
    float fade = (1.0 - smoothstep(0.72, 1.0, uProg)) * smoothstep(0.0, 0.10, uProg);
    float a = clamp((pad * 0.34 + lip * 0.85 + caret + caret2) * fade, 0.0, 0.9) * uDim;
    vec3 col = mix(uColor, uCore, clamp(lip + caret, 0.0, 1.0))
             * (0.9 + 1.5 * lip + 1.8 * caret);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;
export const makeLootMat = (): THREE.ShaderMaterial => makeQuadMat(LOOT_FRAG, {});

// ---------------------------------------------------------------------------
// SPORE POD (the Pollinator's new Hazard.kind, §7.4). Armed pods that bloom
// and seed children, so a pod must read as A THING THAT WILL OPEN, never as a
// puddle. Petal seams SPREAD as it arms and the core swells: the countdown is
// the pod's own silhouette, readable without a timer.
// ---------------------------------------------------------------------------
// r7 MAJOR — "BLOOM IS ~30 IDENTICAL GLOWING DONUTS." And it was, for two
// reasons that are both in this shader. (1) The read was a bright `rim` band at
// r 0.82-0.95 plus a bright `core` at r < 0.46 — which is a DONUT, drawn 22
// times at one size in one green, and §5.9 reserves the ring silhouette to a
// single signature. (2) Every pod was byte-identical: same seam count, same
// phase, same radius, same hue, so a bed of them read as a stamped pattern
// rather than as a thing growing.
//
// The pod is now an INDIVIDUAL and it is a BULB, not a ring: a filled body with
// petal seams cut through it, a bud that swells toward its own opening, and a
// per-pod seed (`uSeed`, the hazard's own id) that turns the seam count, the
// phase, the lean of the green and the body's size. A bed of twenty is twenty
// different plants at three sizes — discontinuous, which is the one thing
// nothing else on this floor is — and the ring is gone entirely.
const SPORE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uTime;
  uniform float uArm;  // 0 fresh -> 1 about to bloom
  uniform float uDry;  // 0 live -> 1 expiring
  uniform float uSeed; // 0..1 per-pod: seams, phase, size, hue lean
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    // PER-POD IDENTITY. Three plants, not thirty copies of one.
    float seams = 3.0 + floor(uSeed * 3.0);          // 3, 4 or 5 petals
    float turn = uSeed * 6.283;                      // its own facing
    float size = 0.66 + 0.30 * fract(uSeed * 7.13);  // its own body
    float ang = atan(p.y, p.x) + turn;
    // The BODY: a filled bulb that swells as it arms, cut by petal seams that
    // open across it. No ring anywhere — the outline is the petals' outline.
    float lobe = size * (0.62 + 0.30 * uArm) * (0.86 + 0.14 * cos(ang * seams));
    float body = smoothstep(lobe, lobe - 0.16, r);
    float seam = smoothstep(0.72, 1.0, abs(cos(ang * seams * 0.5)))
               * body * smoothstep(0.05, 0.7, uArm);
    // The BUD: it comes up late and hard, so "this one is about to go" is the
    // brightest thing about the pod that is about to go — and only that one.
    float bud = smoothstep(lobe * (0.34 - 0.16 * uArm), 0.0, r)
              * (0.28 + 1.5 * uArm * uArm);
    // A thin lit EDGE on the petals themselves (not a circle): it separates a
    // pod from the pod behind it without minting a second ring.
    float edge = smoothstep(0.10, 0.0, abs(r - lobe)) * body;
    float breathe = 0.82 + 0.18 * sin(uTime * (2.4 + 6.0 * uArm) + turn);
    float a = clamp((body * 0.30 + bud * 0.62 + edge * 0.45 - seam * 0.55)
                    * breathe * (1.0 - uDry * 0.75), 0.0, 0.86);
    // Per-pod hue lean: warm-gold buds among cool-green bodies, so a bed reads
    // as a population rather than as one colour repeated.
    vec3 base = mix(uColor, uCore, clamp(bud * 1.1 + edge * 0.4, 0.0, 1.0));
    base.r *= 0.9 + 0.35 * fract(uSeed * 3.31);
    base.b *= 1.1 - 0.3 * fract(uSeed * 3.31);
    vec3 col = base * (0.9 + 2.2 * bud + 1.1 * edge);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }`;

export function makeSporeMat(seed = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(ASK_PAL.storm.mid) },
      uCore: { value: new THREE.Color(ASK_PAL.storm.core) },
      uTime: { value: 0 }, uArm: { value: 0 }, uDry: { value: 0 },
      // Stable per-hazard: the pod keeps its own shape for its whole life.
      uSeed: { value: ((seed * 2654435761) % 1000) / 1000 },
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

interface ArenaBeat {
  mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; max: number;
  /** Pre-capture-hold span, so BossFx.release() can hand it back. */
  held?: number;
}

/** The ground-plane silhouettes, one pool per shape (§ THE ASK SILHOUETTES). */
type ShapeKind = "lanes" | "props" | "cells" | "set" | "burrow" | "wipe" | "seed";
const SHAPE_MAT: Record<ShapeKind, () => THREE.ShaderMaterial> = {
  lanes: makeLanesMat, props: makePropsMat, cells: makeCellsMat, set: makeSetMat,
  burrow: makeBurrowMat, wipe: makeWipeMat, seed: makeSeedMat,
};
interface ShapeBeat {
  mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; max: number; kind: ShapeKind;
  held?: number;
}
/** A transient converging cord (the ADDS silhouette), drawn like a tether. */
interface CordBeat {
  mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; max: number; held?: number;
}
/**
 * A transient SHAFT (the WINDOW silhouette — r4 blocker). `column` was the one
 * ask with no geometry at all: a particle gather, a 20-mote column, ten radial
 * streaks and an UNGOVERNED light of peak 9, all additive and all in gold. On
 * floors 3 and 6 — the first two bosses anyone meets — that took the whole
 * frame to a flat gold wash with the boss a pale ghost inside it.
 *
 * It now builds the same crossed shaft + closing reticle the punish window
 * wears, because they are the same sentence: the telegraph says "a window is
 * about to open HERE" and the window says "it is open, hit it". Sharing the
 * shape between the tell and the beat is the point, not an accident.
 */
interface ShaftBeat {
  group: THREE.Group; quads: THREE.Mesh[]; mark: THREE.Mesh;
  life: number; max: number; held?: number;
}

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
   * THE PUNISH WINDOW OWNS THE FRAME WHILE IT IS OPEN (r6 blocker).
   *
   * §5.5 pulls the camera back one step per phase, so by the time the window
   * arrives the shot has widened twice — and the capture review measured the
   * punish beat as the WIDEST camera of the six, with the whole encounter at
   * ~15% of a 1600x900 frame and the boss a featureless blown-white blob. §7.4
   * calls this "the one beat that most needs to read". It is an UNLOAD: it
   * pushes in past every phase pull-back, and holds that for the window's own
   * length so the next phase edge cannot take the frame back mid-beat.
   */
  private static readonly PUNISH_ZOOM = 0.72;
  private punishFrameT = 0;
  // Measured against a 1600x900 capture at the shipped ortho half-height: the
  // plate owns the top ~250px, a boss rig stands ~3 units, and this pair puts
  // its feet near 55% down the frame with its head clear of the panel by a
  // comfortable margin at every band.
  private static readonly ENC_BIAS = 0.5;
  private static readonly ENC_DROP = 6.8;
  /**
   * ...and the APPROACH gets a lighter version of the same pair (r5 blocker).
   * The approach owes the player a boss SILHOUETTE and had none in ten of ten
   * captures, because the camera was still framing the crawler alone. A third
   * of the way is enough to get the arena's mouth and whatever is standing in
   * it into the shot without stealing the reveal's push-in.
   */
  // Half-way, not a third: the encounter is raised at ~10 tiles and the
  // approach stages from 22, so anything less than the mid-point leaves the
  // boss off the top of the frame — which is exactly what ten of ten captures
  // showed. At 0.5 the crawler and the boss sit symmetrically about centre.
  private static readonly APR_BIAS = 0.5;
  private static readonly APR_DROP = 4.2;
  /**
   * The seal is a THRESHOLD, not the arena. At 6.5 it was a 13-tile circle
   * drawn on a boss the camera was not looking at, so what reached the frame
   * was one arc running off the top of the viewport across the HUD chips.
   */
  private static readonly SEAL_RADIUS = 4.2;
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
  /**
   * Never grip harder than this: past it the beat stops existing (r4).
   *
   * r5 BLOCKER — IT WAS NOT A FLOOR, IT WAS THE OPERATING POINT. Measured over
   * both capture runs: 24 of 45 probed frames reported exactly 0.45, and every
   * single fight / phase / punish / kill frame in the set was at 0.45. The
   * governor had stopped modulating and was simply clamping, so every boss beat
   * in the game rendered at 45% of its intended peak — which is most of why the
   * fight frames read dim and the FX read washed rather than hot.
   *
   * The cause was arithmetic, not policy: at `load * 1.9` a beat costing 0.5
   * plus a beat costing 0.7 inside the same second put the divisor past 2.2,
   * and with `load` decaying at 1.1/s a busy fight never came back up. Four
   * changes, all so the governor spends its time BETWEEN the rails:
   *   * the load coefficient comes down (a beat costs about half what it did),
   *   * the load itself is CAPPED, so a pile-up cannot drive it to the stop,
   *   * it unwinds twice as fast, and
   *   * the floor moves up to where a beat is still a beat.
   * The blow-out this exists to prevent is charged by the MEASURED term, which
   * is untouched — a genuinely clipping frame still gets gripped.
   */
  private static readonly EXPOSURE_FLOOR = 0.62;
  /** Past this the divisor stops growing: a governor that saturates is a clamp. */
  private static readonly LOAD_MAX = 1.2;
  /**
   * ...and below THIS it charges nothing at all (r6). A governor charges
   * OVERLAP: one beat firing on its own is the fight working, not a frame in
   * trouble. Sized so a single typical beat (cost 0.35-0.5) is free and the
   * second one inside the same half-second starts paying.
   */
  private static readonly LOAD_FREE = 0.5;
  /**
   * ...and the punish rig never goes below THIS. §7.4 calls the punish window
   * "the one beat that most needs to read", and it was subject to the governor
   * with no floor at all — i.e. the one beat that must survive a bright frame
   * was dimmed alongside everything that made the frame bright. It is a
   * reticle and a pair of hairline rails; it cannot blow anything out.
   */
  private static readonly PUNISH_DIM_FLOOR = 0.78;
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
  /**
   * THE KILL BEAT KEEPS THE FRAME (acceptance r5, blocker).
   *
   * The Showrunner's kill probe reported twelve live ringside beacons and the
   * frame contained one. They were not misplaced — the CAMERA left. Every
   * framing term in this file keys off a boss with `hp > 0`, so at the exact
   * instant the payoff fires the anchor snaps back to the crawler and the ring
   * the sim just threw around the corpse is off the edge of the shot. The
   * Furnace Marshal is the counter-example that proves it (its crawler
   * happened to be standing on the corpse), which is luck, not staging.
   *
   * So the corpse holds the frame for the length of the payoff: the renderer
   * biases toward THIS point rather than toward a live boss while it is set.
   */
  focus: { x: number; y: number } | null = null;
  private focusT = 0;
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
  private shafts: ShaftBeat[] = [];
  /** Ringside loot beacons (§5.7) — the arc has to LAND on something. */
  private lootMarks: {
    mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; max: number; held?: number;
  }[] = [];
  private marks = new Map<number, THREE.Mesh>();
  /** Per-boss reticle countdown: { t = seconds left, span = its full length }. */
  private marked = new Map<number, { t: number; span: number; held?: number; heldT?: number }>();
  private static readonly MARK_MIN_SPAN = 1.6;
  /** The council's aides, marked at the feet so they are never trash (r3). */
  private aides = new Map<number, THREE.Mesh>();
  private seenAides = new Set<number>();
  private sporeMats = new Map<number, THREE.ShaderMaterial>();
  private plateGeo = new THREE.PlaneGeometry(1, 1);
  // r5: 20x14 photographed as visible flat facets on a 3-unit dome. 32x20 is
  // ~1.2k tris for the ONE shell a fight ever wears — inside the perf round's
  // budget, and the difference between "a shell" and "a low-poly egg".
  private shieldGeo = new THREE.SphereGeometry(1, 32, 20);
  private tetherGeo = new THREE.PlaneGeometry(1, 1);
  private punishGeo = new THREE.PlaneGeometry(1, 1);
  private markGeo = new THREE.PlaneGeometry(1, 1);
  private aideGeo = new THREE.PlaneGeometry(1, 1);
  private cordGeo = new THREE.PlaneGeometry(1, 1);
  private shellGeo = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.56);
  private seenMarks = new Set<number>();
  private propTick = 0;
  /** §5.1 THE APPROACH, staged in the world rather than only in the mix. */
  private approachT = 0;
  private approachLight = 0;
  /** §5.1's threshold ring, carried ON the boss for the whole approach. */
  private seal: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null = null;
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
    this.load = Math.min(BossFx.LOAD_MAX, this.load + cost);
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
    // r4 MAJOR — THE GOVERNOR WAS FLOOR-BIASED, NOT BEAT-BIASED. Measured on
    // the real clock with a driven fight, floor 9 (THE GARDEN) ran a median
    // exposureScale of 0.61 against floor 3's 1.00 and floor 18's 0.89, driven
    // entirely by the luma term: the Garden's bright forest floor sits at
    // 0.63-0.83 against a 0.45 knee, so identical beats rendered at ~60%
    // brightness in one band for a reason that has nothing to do with the beat.
    // A governor is supposed to charge OVERLAP, not geography.
    //
    // Three changes, all about that: the knee moves up to where a lit arena
    // actually stops being legible, the coefficients come down so the room
    // costs less than a beat does, and saturation is charged only above a
    // deadband (a warm torch-lit floor is not a clipping frame). The `measSat`
    // hard clamp is gone — it fired on 2 frames in 234 and was never the
    // mechanism, but when it did fire it took a readable frame to 0.30.
    const over = Math.max(0, this.measLuma - 0.62) * 1.7
               + Math.max(0, this.measSat - 0.12) * 2.4;
    // r5: 1.9 -> 0.9. At 1.9 any two overlapping beats saturated the divisor
    // and the scale sat on its floor for the rest of the fight; the whole
    // fight/phase/punish/kill half of both capture runs measured 0.45 exactly.
    // The MEASURED term keeps its coefficients — a clipping frame is still a
    // clipping frame, and that is the case the governor was written for.
    // r6 MAJOR — IT WAS STILL SATURATED, JUST AT A HIGHER NUMBER. Across all
    // eight bosses of the last capture round the fight/phase/punish/kill
    // probes read 0.62, 0.62, 0.62, 0.62, 0.62, 0.63, 0.62, 0.65 — pinned at
    // the new floor on ~20 of 32 frames. r5 diagnosed "a governor that
    // saturates is a clamp" and then moved the floor 0.45 -> 0.62; the clamp
    // moved and did not go away, so every fight frame in the round ran at 62%
    // of authored brightness for a reason with nothing to do with the beat.
    //
    // The cause is arithmetic, not taste: at LOAD_MAX 1.5 and a coefficient of
    // 0.9 the load term alone reaches 1/(1+1.35) = 0.43, i.e. it dives THROUGH
    // the floor, so the floor becomes the operating point the moment two beats
    // overlap — which in a boss fight is most of the time.
    //
    // A governor charges OVERLAP. One beat is not an exposure problem, so the
    // first LOAD_FREE of load is free, the coefficient comes down, and the cap
    // comes down with it — the worst case the LOAD term can now produce is
    // 1/(1 + (1.2-0.5)*0.7) = 0.68, above the floor. The floor is therefore
    // reachable only through the MEASURED term, which is the case it exists
    // for: a genuinely clipping neighbourhood still gets gripped, hard.
    const charged = Math.max(0, Math.min(BossFx.LOAD_MAX, load) - BossFx.LOAD_FREE);
    const k = 1 / (1 + charged * 0.7 + over);
    // AND A FLOOR. The thing being scaled is how hard a beat may BURN, and a
    // beat scaled to a quarter is a beat the player does not see at all —
    // which is the failure mode the governor was written to fix, arriving from
    // the other side. Below this the read is gone and there is nothing left to
    // protect.
    return Math.max(BossFx.EXPOSURE_FLOOR, k);
  }

  /**
   * Capture hold. Extends every live rig's own countdown so a slow shutter
   * photographs the beat rather than its aftermath. Nothing is invented — a
   * beat that is not running does not start running because of this.
   */
  hold(seconds: number): void {
    for (const mk of this.marked.values()) {
      if (mk.held === undefined) { mk.held = mk.span; mk.heldT = mk.t; }
      mk.span = Math.max(mk.span, seconds);
      mk.t = Math.max(mk.t, seconds * 0.75);
    }
    for (const b of this.holdables()) {
      if (b.life >= b.max) continue;
      if (b.held === undefined) b.held = b.max;
      b.max = Math.max(b.max, seconds);
    }
  }

  /**
   * ...AND GIVE IT BACK (r4 blocker, the capture-honesty half).
   *
   * `hold()` shipped without an inverse: `__dcc.release()` cleared the host's
   * own captureHold flag and nothing here, so from the first capture onward
   * every live rig had its lifetime pinned to 600 SECONDS for the rest of the
   * run. Combined with a virtual clock that advances ~0.4ms per rendered frame
   * (a 2.6s arena ring needs ~108 real seconds to expire), the approach seal
   * and the intro seal were still standing in every later frame of every
   * fight — which is exactly how six different bosses came to look like they
   * shared one silhouette in a mask sheet. The harness was blamed for it; half
   * of it was here.
   *
   * Restoring the ORIGINAL span (rather than killing the beat) means a beat
   * that genuinely still had time left keeps it, and one that only existed
   * because of the hold expires on the next update.
   */
  release(): void {
    for (const mk of this.marked.values()) {
      if (mk.held === undefined) continue;
      mk.span = mk.held;
      mk.t = Math.min(mk.t, mk.heldT ?? mk.held);
      mk.held = undefined;
    }
    for (const b of this.holdables()) {
      if (b.held === undefined) continue;
      b.max = b.held;
      b.held = undefined;
    }
  }

  /** Every pooled transient whose lifetime a capture hold may borrow. */
  private holdables(): { life: number; max: number; held?: number }[] {
    return [
      ...this.beats, ...this.shapes, ...this.shells,
      ...this.cords, ...this.shafts, ...this.lootMarks,
    ];
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
    // r5 MAJOR — THE BOSS IS A THUMBNAIL IN ITS OWN INTRODUCTION. In eight of
    // ten intro captures the star of the card occupied 6-10% of frame height
    // (the Topiary Warden: a pink blob inside a bubble at ~7%). The two that
    // worked were the two with physically large models, which is the tell —
    // 0.78 is not a push-in at KayKit character scale, it is a nudge. §5.3
    // says the reveal pushes IN; this is what that costs on a 1.1-unit rig.
    //
    // The card is a LOWER third and `frameDrop` already slides the subject up
    // out of it, so the tighter shot does not put the boss under the plate.
    this.zoomWant = full ? 0.52 : 0.64;
    this.orbitWant = full ? 0.55 : 0.22;
    this.orbitHold = e.duration ?? 2.2;
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
    // The seal closing: contracting, and carrying this BAND's glyph count (r6
    // major) — the approach's threshold and the reveal's seal are the same
    // object, so they wear the same marks.
    this.arenaBeat(x, z, 6, pal, 1.5, 0, 0, 0,
      Math.max(1, Math.min(6, Math.round((this.world?.floor ?? 3) / 3))));
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
    // THE SEAL BELONGS TO THE REVEAL (r4). The approach seal and the intro seal
    // are both arena rings, and the capture probe caught one of them still
    // standing on the ground in the -3fight frame while a completely different
    // signature was committing — two arena-scale ground shapes at once, one of
    // which stopped being true a beat ago. A named signature that is not itself
    // an arena-state change now clears them: the room says one thing at a time.
    if (sig.shape !== "ring") {
      for (const b of this.beats) {
        if (b.life < b.max) { b.life = b.max; b.held = undefined; b.mesh.visible = false; }
      }
    }
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
            // ...AND THE GROUND EACH PROP JUST CLAIMED (r7 major). "SLUICE
            // GATE draws nothing in the world": the frame is filed correctly,
            // the probe reads `shapes:{props:1}`, and there is no gate, no
            // lane and no water in it. The brackets said WHICH objects the
            // beat is about and nothing said what they were DOING. The gates
            // vent a marching crescent toward the crawler, so each anchor gets
            // a lit run of ground from itself toward the middle: the read is
            // "it is coming from there, to here", which is the whole ask.
            this.deps.decals.spawn(
              x + p.x * 5.2, z + p.y * 5.2, 1.8, 0x0f1a1e, pal.mid, 7);
            this.deps.fxp.sparks(
              x + p.x * 6.4, 0.4, z + p.y * 6.4, pal.core, 4,
              { x: -p.x, y: -p.y });
          }
          // One lane bar per prop, laid along the prop -> middle heading. The
          // ask keeps its own silhouette (the brackets); this is the ground it
          // locked, exactly as the r6 beam rule already does for lanes a kit
          // laid as hazards.
          if (at.length > 0) {
            const lead = at[0];
            this.shapeBeat("lanes", x, z, 7.5, pal, 1.25, (mm) => {
              mm.uniforms.uN.value = Math.max(1, Math.min(6, at.length));
              mm.uniforms.uAng.value = Math.atan2(-lead.y, -lead.x);
              mm.uniforms.uW.value = 0.16;
            });
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
        // the only full-arena beat that is not a ring — plus, when the beat
        // carries a wedge (CAMERA MOVE does), the SHOT itself: lit safe ground
        // between two frame lines, with the struck ground hatched around it.
        this.shapeBeat("set", x, z, 9.5, pal, 1.5, (mm) => {
          mm.uniforms.uAng.value = e.angle ?? 0;
          mm.uniforms.uArc.value = e.arc ?? 0;
        });
        this.deps.fxp.dust(x, 0.3, z, 16, pal.rim);
        this.deps.light(x, z, pal.mid, 8 * k, 0.6, 1.4);
        break;
      case "column":
        // A SEIZURE: motes fall INTO the epicenter, then the SHAFT stands up
        // and a reticle closes on where it lands.
        //
        // r4 BLOCKER — this was the one ask with no geometry at all: a gather,
        // a 20-mote column, TEN radial streaks and an UNGOVERNED light of peak
        // 9, every part of it additive and every part of it in the window
        // family's #fff8dc/#ffcf3c. LATE FEE on floor 3 and the Grease Trap on
        // floor 6 — the first two bosses anyone meets — took the entire arena,
        // its props and the boss to a single flat gold wash with the boss a
        // pale ghost inside it, which is precisely the OVER-COMMIT tell §5.9
        // claimed to have closed.
        //
        // The read is now the shaft and the closing brackets, which are SHAPE,
        // so the light can come down to where it belongs: through the governor
        // like every other beat, at half the peak, with the streaks (the part
        // that actually made the wash) deleted outright.
        this.deps.fxp.gatherBurst(x, 1.1, z, pal.core);
        this.shaftBeat(x, z, pal, 1.35);
        this.deps.fxp.column(x, z, pal.mid, 9, 2.6);
        this.deps.light(x, z, pal.mid, 4.5 * k, 0.55, 1.3);
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
        // THE PIT PULLS: everything converges, and the floor is TURNING.
        //
        // r4 BLOCKER — this called `arenaBeat`, i.e. the same contracting ring
        // the arena warning draws, the approach seal breathes and (through
        // OVER-COMMIT, which every one of the eighteen bosses fires) the punish
        // telegraph used as well. Four separate sentences in one shape. It owns
        // a pinwheel now (see BURROW_FRAG): five curved vanes sweeping into a
        // mouth that closes, which is the only rotating geometry in the game.
        this.shapeBeat("burrow", x, z, 6.0, pal, 1.15);
        this.deps.fxp.vortex(x, z, pal.mid, 3.6);
        this.deps.fxp.smoke(x, 0.4, z, 8, pal.rim);
        this.deps.light(x, z, pal.mid, 5 * k, 0.45, 0.9);
        break;
      case "swarm":
        // BLOOM / SEED HEAD: pods are about to exist, and now you can SEE the
        // bed they are about to exist in.
        //
        // r6 BLOCKER — this case had no geometry at all. The Pollinator's own
        // headline frame probed `shapes:{}` with the sim emitting
        // `telegraph:BLOOM`: eighteen particles and a light, on the one
        // survive-the-storm boss in the roster. The SEED silhouette is a
        // scatter of swelling pods with petal seams — the same language
        // `makeSporeMat` gives the live hazard — so the telegraph and the
        // thing it telegraphs are one sentence, and the beat has a mask.
        this.shapeBeat("seed", x, z, 8.5, pal, 1.5, (m) => {
          m.uniforms.uN.value = Math.max(3, Math.min(7, 2 + n));
        });
        this.deps.fxp.burst(x, z, pal.mid, 12);
        for (let i = 0; i < Math.min(6, n); i++) {
          const a = (i / Math.max(1, Math.min(6, n))) * Math.PI * 2 + 0.4;
          this.deps.fxp.embers(x + Math.cos(a) * 3.2, z + Math.sin(a) * 3.2, pal.core, 3, 0.8);
        }
        this.deps.light(x, z, pal.mid, 6 * k, 0.5, 0.9);
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
    // ---- THE LANES THE SIM ACTUALLY LAID, WHATEVER THE ASK'S SHAPE IS ------
    //
    // r6 BLOCKER. The Permit Office's STOP-WORK ORDER is "one locked lane per
    // unbroken stamp, so breaking a stamp deletes a lane" (§5.9) — the whole
    // point of the boss — and its `-3fight` probe read
    // `shapes:{shell,column,reticle,shaft,plate:4}` with no `lanes` entry at
    // all. The ask silhouette was drawing (it is a break-the-shield boss, so
    // it wears the dome) and the mechanic was not, because the ask table has
    // exactly one shape per label and this beat is genuinely two things.
    //
    // So: if the sim laid BEAM hazards on this frame and the ask's own shape
    // is not already lanes, the lanes are drawn too, in the ask's own hue.
    // This is not a special case for one boss — it is the rule that a
    // telegraph must show the ground it locked, and it applies to every kit
    // that fires beams from behind another ask's silhouette.
    if (sig.shape !== "lanes") {
      const beams = this.beamsNear(x, z);
      if (beams.n > 0) {
        this.shapeBeat("lanes", x, z, 8.5, pal, 1.1, (mm) => {
          mm.uniforms.uN.value = Math.max(1, Math.min(8, beams.n));
          mm.uniforms.uAng.value = beams.heading;
          mm.uniforms.uW.value = beams.n >= 5 ? 0.1 : 0.14;
        });
      }
    }
    if (sig.trauma) this.deps.trauma(sig.trauma);
  }

  /** Beam hazards the sim laid around this beat: how many, and which way. */
  private beamsNear(x: number, z: number): { n: number; heading: number } {
    const s = this.world;
    if (!s) return { n: 0, heading: 0 };
    let n = 0, heading = 0, bestD = 8.5;
    for (const h of s.hazards) {
      if (h.kind !== "beam" || !h.end) continue;
      // Only FRESH ones: a beam past its arm is a lane that already fired.
      if (h.arm !== undefined && h.t < h.arm * 0.35) continue;
      const d = Math.hypot(h.pos.x - x, h.pos.y - z);
      if (d > bestD + 4) continue;
      n++;
      if (d <= bestD) {
        bestD = d;
        heading = Math.atan2(h.end.y - h.pos.y, h.end.x - h.pos.x);
      }
    }
    return { n, heading };
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
    // ---- THE INTERMISSION RETIRES THE PUNISH RIG (r7 BLOCKER) --------------
    //
    // "The punish rig and its call-out own the PHASE beat too, so two of the
    // six beats are the same picture." `sumpking-4phase.png` and
    // `sumpking-5punish.png` were indistinguishable: reticle + shaft in both,
    // UNLOAD in the call-out of both. §5.12 claims the rig "belongs to the
    // WINDOW alone (marked)" and that is true of who WRITES it — but nothing
    // ever took it away, and `marked` holds for MARK_MIN_SPAN whatever else
    // the fight does. An intermission crossing inside that span left the
    // window's silhouette standing over a beat that is its exact opposite.
    //
    // It is not a composition problem, it is a LIE: during the commercial
    // break the boss is untargetable (`invulnT`), so "commit here now, it
    // cannot answer" is false — there is nothing to commit to. A beat that
    // changes the state retires the sentence that described the old one,
    // which is the rule §5.11 already applies to a stale banner. The gate in
    // update() (`invulnT > 0`) keeps it retired for the whole break; this
    // clears the held span so it does not simply resume afterwards.
    this.marked.delete(e.monsterId);
    // ...AND SO DOES THE CREAM RING (r7 major, "the cream ellipse is still
    // doing four jobs"). `sumpking-4phase` probed `shapes:{ring:1, wipe:1}`:
    // the intermission's own single-axis BAR WIPE was drawing underneath an
    // arena ring left over from the beat before it, so the frame read as a
    // ring after all — which is the exact confusion §5.11 gave the wipe its
    // own silhouette to end. One beat, one shape.
    for (const b of this.beats) {
      if (b.life < b.max) { b.life = b.max; b.held = undefined; b.mesh.visible = false; }
    }
    const rig = this.punish.get(e.monsterId);
    if (rig) rig.visible = false;
    const mk = this.marks.get(e.monsterId);
    if (mk) mk.visible = false;
    for (const sf of this.shafts) {
      sf.life = sf.max; sf.group.visible = false; sf.mark.visible = false;
    }
    this.zoomWant = 0.88;
    // ...and it takes the frame back off the window's push-in, or the phase
    // beat is shot at PUNISH_ZOOM on the boss's chest with no arena in it.
    this.punishFrameT = 0;
    this.slowmo = Math.max(this.slowmo, 0.2);
    // THE BAR WIPE, not a fourth cream ring (r5 major). This beat now owns the
    // only single-axis, directional full-arena silhouette in the game.
    this.shapeBeat("wipe", x, z, 8.5, ASK_PAL.window, 1.1);
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
    // THE WINDOW OUTRANKS THE TELEGRAPH THAT PRECEDED IT (r5 blocker). The
    // Topiary Warden's capture has the punish window firing UNDERNEATH a
    // transient shield dome that covers it completely. A dome is a sentence
    // about the last beat; this is the sentence about this one.
    for (const sh of this.shells) { sh.life = sh.max; sh.mesh.visible = false; }
    // ...AND SO DOES THE TELL IT ANSWERS (r6 blocker). The punish TELL draws
    // the window family's shaft at the boss's position one beat earlier; the
    // window's own rig follows the BODY. A boss that walked in between left
    // the two anchored ~12 tiles apart, so "the shape converges on the core"
    // converged on nothing, in the frame §7.4 calls the one that most needs to
    // read. The window retires the tell's shaft: one beat, one anchor.
    for (const sf of this.shafts) { sf.life = sf.max; sf.group.visible = false; }
    const pal = ASK_PAL.window;
    const k = this.budget(0.35);
    // THE WINDOW TAKES THE FRAME BACK (r6 blocker). §5.5's "pull back one step
    // per phase" had by the punish beat pulled back twice, so the widest
    // camera in the encounter was the beat that most needs to read: the whole
    // fight occupied ~15% of a 1600x900 frame and the boss was a featureless
    // blob. The window is an UNLOAD — it pushes in, hard, and it holds the
    // anchor on the boss for its own duration.
    this.zoomWant = BossFx.PUNISH_ZOOM;
    this.punishFrameT = Math.max(this.punishFrameT, span);
    this.deps.fxp.impactFlash(x, 1.2, z, pal.core, 0.9);
    // THE LIGHT SITS ON THE GROUND, NOT ON THE BODY (r5 major). At peak 5.5,
    // 1.7 units up and centred on the boss, this was the light that took The
    // Showrunner's red demon to a flat pale-pink silhouette in the one frame
    // whose entire job is to sell that silhouette. It lights the RETICLE now.
    this.deps.light(x, z, pal.core, 3.2 * k, 0.5, 0.35);
    this.flash(0.1, 0.25);
    this.slowmo = Math.max(this.slowmo, 0.12);
  }

  /** A plate broke: armour comes OFF, in pieces, and the floor keeps a mark. */
  private plateBreak(x: number, z: number, e: BossEvent): void {
    this.deps.fxp.gibs(x, z, 0xd8c08a, 14);
    this.deps.fxp.sparks(x, 1.2, z, 0xfff2cc, 12);
    this.deps.fxp.impactFlash(x, 1.2, z, 0xfff2cc, 1.7);
    this.deps.shocks.spawn(x, z, 0xffd98a, 3.0, 0.4);
    // Governed like every other peak (r4): the un-governed lights were the
    // other half of the gold wash, and a plate breaking three times inside a
    // second is a normal thing for this fight to do.
    this.deps.light(x, z, 0xffd98a, 10 * this.budget(0.3), 0.5, 1.3);
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
    this.deps.light(x, z, pal.core, 8 * this.budget(0.3), 0.7, 1.5);
    this.deps.trauma(0.34);
    this.flash(0.3, 0.5);
    this.slowmo = Math.max(this.slowmo, 0.12);
  }

  /** The System loses patience with the slot. Reads as HEAT, never as HP. */
  private enrage(x: number, z: number, e: BossEvent): void {
    const stacks = e.value ?? 1;
    this.deps.fxp.embers(x, z, 0xff4a1e, 10 + stacks * 3, 1.8);
    this.deps.fxp.column(x, z, 0xff6a2a, 14, 2.6);
    this.deps.light(x, z, 0xff4a1e, (8 + stacks) * this.budget(0.35), 0.8, 1.4);
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
    this.deps.light(x, z, pal.mid, 9 * this.budget(0.3), 0.6, 1.1);
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
    // ...and the corpse OWNS the frame for the length of the payoff (r5).
    this.focus = { x, y: z };
    this.focusT = 5.0;
    this.slowmo = Math.max(this.slowmo, 0.45);
    this.zoomWant = 0.9; // push IN on the corpse: the body is the subject now
    this.orbitWant = 0.18;
    this.orbitHold = 2.4;
    this.deps.trauma(0.62);
    this.flash(0.45, 0.6);
    this.deps.shocks.spawn(x, z, 0xfff2cc, 9, 0.85);
    this.deps.shocks.spawn(x, z, 0xffb457, 14, 1.15);
    // ---- THE BODY IS THE SUBJECT, NOT THE CONFETTI (r7 blocker) -----------
    // 34 column motes + 28 radial streaks of near-white gold, all additive,
    // all centred on the corpse, is what made every `-6kill` frame "a gold
    // glitter cloud". The kill's spectacle now lives in the two SWEEPS and the
    // opening seal (shape), the particles are cut by two thirds and pushed
    // OUTWARD off the body, and the light comes down so the thing lying on the
    // floor is lit rather than erased. §5.7's promise is a kill and a haul in
    // one frame; both of them are objects, and objects need to be visible.
    this.deps.fxp.column(x, z, 0xffd98a, 12, 3.2);
    this.deps.fxp.radialStreaks(x, 0.5, z, 0xfff8dc, 10, 5.4);
    this.deps.fxp.gibs(x, z, 0xc0552e, 18);
    this.deps.fxp.smoke(x, 0.9, z, 10, 0x4b3a2e);
    this.deps.decals.spawn(x, z, 2.6, 0x140807, 0xc03024, 16);
    const k = this.budget(1.1);
    // ...and the pool it throws on the floor is not the picture either: at
    // peak 11 (then 6.5) the kill frame's dominant shape was a beige ellipse of
    // LIGHT with the corpse and the ringside beacons inside it. The body is lit
    // by a tighter, lower key; the spectacle is the two sweeps and the seal.
    this.deps.light(x, z, 0xffd98a, 4.2 * k, 1.4, 1.5);
    // THE SEAL OPENS, and it is the only ring in the game that comes APART
    // (r5 major — the kill mark, the intermission sweep and the arena warning
    // were one decal in three places).
    this.arenaBeat(x, z, 11, ASK_PAL.window, 1.6, 1, 0, 1);
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
    // ...and the transient WINDOW shafts, for exactly the same reason.
    for (const sf of this.shafts) {
      sf.life = sf.max; sf.group.visible = false; sf.mark.visible = false;
    }
  }

  /**
   * §5.7 — the loot payoff lands RINGSIDE in a readable arc, not under the
   * body where it is missed. The sim drops at the corpse; this draws the arc
   * the eye follows out to it and lights the ground where it comes to rest.
   */
  lootArc(fromX: number, fromZ: number, toX: number, toZ: number, hex: number): void {
    const span = Math.hypot(toX - fromX, toZ - fromZ);
    // r4 BLOCKER, half two. The sim now throws the payout RINGSIDE (see
    // dropBossBonus), so the arc finally has somewhere to go — but the arc
    // itself was 7x3 sparks, one impactFlash, one shockwave and a one-frame
    // point light, i.e. NOTHING PERSISTENT. A frame after the kill there was
    // no payoff on screen at all, which is why two capture runs counted two
    // loot glows and zero arcs over a fifty-item drop. The arc is now sampled
    // by DISTANCE (a 3-tile throw and a 9-tile throw both read as an arc), and
    // it lands on a BEACON that stands for four seconds — long enough that the
    // player looks up from the corpse and sees where the haul went.
    const steps = Math.max(6, Math.min(16, Math.round(span * 2.2)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = fromX + (toX - fromX) * t;
      const pz = fromZ + (toZ - fromZ) * t;
      const py = 0.5 + Math.sin(t * Math.PI) * (1.2 + span * 0.28); // the apex
      this.deps.fxp.sparks(px, py, pz, hex, 2);
    }
    this.deps.fxp.impactFlash(toX, 0.4, toZ, hex, 1.3);
    this.deps.shocks.spawn(toX, toZ, hex, 2.2, 0.55);
    this.deps.light(toX, toZ, hex, 7 * this.budget(0.12), 1.0, 0.8);
    this.lootBeacon(toX, toZ, hex);
  }

  /**
   * Where a payout came to rest: a rarity-coloured seat that breathes for four
   * seconds. Rectilinear, feet-level and NOT a ring — it borrows the aide
   * collar's shape language ("that thing on the floor is yours") rather than
   * minting a sixth circle.
   */
  private lootBeacon(x: number, z: number, hex: number): void {
    let slot = this.lootMarks.find((b) => b.life >= b.max);
    if (!slot) {
      if (this.lootMarks.length >= 14) {
        slot = this.lootMarks[0];
        for (const b of this.lootMarks) if (b.life / b.max > slot.life / slot.max) slot = b;
      } else {
        const mat = makeLootMat();
        const mesh = new THREE.Mesh(this.aideGeo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 8;
        mesh.userData.noAO = true;
        // Same reason the reticle is depth-test free: a payoff pin the arena's
        // own floor detail can swallow answers nothing, and the kill frame is
        // shot from above a body that is lying on top of half of them.
        mat.depthTest = false;
        this.group.add(mesh);
        slot = { mesh, mat, life: 1, max: 1 };
        this.lootMarks.push(slot);
      }
    }
    slot.life = 0;
    // 4s -> 7s. r7 blocker: the payoff frame is shot ~1.8s after the boss hits
    // zero (the corpse has to fall first) and the drops land over the second
    // after that, so at four seconds the FIRST beacons were already fading
    // while the LAST ones had not been thrown. Every beacon in the haul is now
    // still standing when the one frame the short-session loop lives on opens.
    slot.max = 7;
    slot.held = undefined;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, 0.1, z);
    // 1.1 -> 1.7. At a tile and a bit across, a rarity seat photographed as a
    // faint scratch on the floor; the kill frame is the one moment nothing
    // else is competing for the eye, so the payoff may take the room.
    // 1.7 -> 2.4 (r7 blocker). Measured on the kill captures: 8-14 beacons
    // live and ~2 readable in frame. At the payoff camera (zoom 0.9, the corpse
    // filling the middle) a 1.7-unit pad is about 40px across and it is sitting
    // on the cream of the opening seal — the haul was there and unreadable.
    slot.mesh.scale.setScalar(2.4);
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(hex);
    (slot.mat.uniforms.uCore.value as THREE.Color).setHex(0xfff2cc);
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
    // TETHERED BODIES ARE PROPS TOO, for this beat's purposes (r5). The Zoning
    // Board's SETBACK REQUIRED condemns the ground around each seated member,
    // so the brackets have to clamp on the SEATS — "that body's ground" is a
    // place, and the props silhouette is the only one that draws on places.
    for (const m of s.monsters) {
      if (m.hp <= 0 || m.tetherId === undefined) continue;
      const dx = (m.pos.x - x) / radius, dz = (m.pos.y - z) / radius;
      if (dx * dx + dz * dz > 0.86) continue;
      out.push(new THREE.Vector2(dx, dz));
      if (out.length >= 8) return out;
    }
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
    slot.held = undefined; // a re-armed slot carries no stale capture hold
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
    slot.held = undefined;
    slot.mesh.visible = true;
    slot.mesh.position.set(fx + dx / 2, 1.35, fz + dz / 2);
    slot.mesh.scale.set(len, 0.42, 1);
    slot.mesh.rotation.set(-Math.PI / 2, 0, -Math.atan2(dz, dx));
    slot.mat.uniforms.uLen.value = len;
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
    (slot.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
  }

  /**
   * Pooled transient SHAFT (the WINDOW silhouette). A crossed pair of punish
   * quads plus the closing reticle, run off the beat's own clock: the shaft
   * stands UP over the first third and drains from the top down over the rest
   * while the brackets close on the spot, so the tell is a countdown you read
   * without a number — and it is the same sentence the punish window itself
   * speaks, one beat earlier.
   */
  private shaftBeat(x: number, z: number, pal: BossPalette, dur: number): void {
    let slot = this.shafts.find((s) => s.life >= s.max);
    if (!slot) {
      if (this.shafts.length >= 3) {
        slot = this.shafts[0];
        for (const s of this.shafts) if (s.life / s.max > slot.life / slot.max) slot = s;
      } else {
        const group = new THREE.Group();
        const quads: THREE.Mesh[] = [];
        for (let i = 0; i < 2; i++) {
          const q = new THREE.Mesh(this.punishGeo, makePunishMat());
          q.rotation.y = (i * Math.PI) / 2; // a crossed pair reads from any yaw
          q.renderOrder = 10;
          q.userData.noAO = true;
          group.add(q);
          quads.push(q);
        }
        const mark = new THREE.Mesh(this.markGeo, makeMarkMat());
        mark.rotation.x = -Math.PI / 2;
        mark.renderOrder = 10;
        mark.userData.noAO = true;
        this.group.add(mark);
        this.group.add(group);
        slot = { group, quads, mark, life: 1, max: 1 };
        this.shafts.push(slot);
      }
    }
    slot.life = 0;
    slot.max = dur;
    slot.held = undefined;
    // Tall and narrow: a COLUMN, not a box. The first cut at 2.6 x 4.2 read as
    // a pale rectangle standing next to the boss rather than as a shaft
    // standing ON it.
    const h = 5.4;
    slot.group.position.set(x, h / 2, z);
    slot.group.visible = true;
    for (const q of slot.quads) {
      q.scale.set(1.9, h, 1);
      (q.material as THREE.ShaderMaterial).uniforms.uGain.value = 2.0;
      (q.material as THREE.ShaderMaterial).uniforms.uColor.value = new THREE.Color(pal.mid);
      (q.material as THREE.ShaderMaterial).uniforms.uCore.value = new THREE.Color(pal.core);
    }
    slot.mark.position.set(x, 0.115, z);
    slot.mark.scale.setScalar(3.2);
    slot.mark.visible = true;
    const mm = slot.mark.material as THREE.ShaderMaterial;
    mm.uniforms.uGain.value = 1.5;
    (mm.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
    (mm.uniforms.uCore.value as THREE.Color).setHex(pal.core);
  }

  /** Pooled transient shell (the SHIELD silhouette) — the dome, cracking. */
  private shellBeat(x: number, z: number, pal: BossPalette, dur: number): void {
    // ONE DOME AT A TIME (r5 blocker). The pool held three, and the Permit
    // Office's STOP-WORK ORDER comes round every few seconds — so the capture
    // caught TWO overlapping domes occluding the arena floor and every monster
    // behind them. A shell is a statement about one body; two is a fog bank.
    // Re-arming the live one instead of stacking is also what the beat means:
    // the shell did not appear twice, it was struck twice.
    const live = this.shells.find((b) => b.life < b.max);
    if (live) {
      live.life = 0;
      live.max = dur;
      live.held = undefined;
      live.mesh.position.set(x, 0.1, z);
      (live.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
      (live.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
      live.mat.uniforms.uHit.value = 1;
      return;
    }
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
    slot.held = undefined; // a re-armed slot carries no stale capture hold
    slot.mesh.visible = true;
    slot.mesh.position.set(x, 0.1, z);
    // 2.6 -> 2.05: at the old radius the transient dome was wider than the
    // boss's own arena disc and swallowed the punish window firing underneath
    // it (captured on the Topiary Warden).
    slot.mesh.scale.setScalar(2.05);
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
    (slot.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
    slot.mat.uniforms.uHit.value = 1;
  }

  /** Pooled arena ring (contracting warning / expanding sweep). */
  private arenaBeat(
    x: number, z: number, radius: number, pal: BossPalette, dur: number, out: 0 | 1,
    spoke: 0 | 1 = 0, gap: 0 | 1 = 0, ticks = 0,
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
    slot.held = undefined; // a re-armed slot carries no stale capture hold
    slot.mesh.visible = true;
    slot.mesh.position.set(x, 0.08, z);
    slot.mesh.scale.setScalar(radius);
    (slot.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
    (slot.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
    slot.mat.uniforms.uOut.value = out;
    slot.mat.uniforms.uProg.value = 0;
    slot.mat.uniforms.uSpoke.value = spoke;
    slot.mat.uniforms.uGap.value = gap;
    slot.mat.uniforms.uTicks.value = ticks;
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
    // Unwinds in about half a second now, not a whole one (r5): the beats a
    // boss fight fires are 1-2s apart, so a one-second memory meant the fight
    // never stopped paying for the last beat while committing the next.
    this.load = Math.max(0, this.load - dt * 2.4);
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
    const star = state.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    // The kill beat's held frame runs down here; while it is up the corpse is
    // the subject and the camera is not allowed to walk away from the payoff.
    if (this.focusT > 0) {
      this.focusT = Math.max(0, this.focusT - dt);
      if (this.focusT <= 0) this.focus = null;
    }
    // The punish window's push-in outranks every phase pull-back for as long
    // as the window is open (r6 blocker) — see PUNISH_ZOOM.
    if (this.punishFrameT > 0) {
      this.punishFrameT = Math.max(0, this.punishFrameT - dt);
      this.zoomWant = BossFx.PUNISH_ZOOM;
    }
    // Where the renderer takes its luminance sample (see measureBossExposure).
    this.starPos = star ? { x: star.pos.x, y: star.pos.y } : this.focus;
    if (!star && !this.focus) this.zoomWant = 1;
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
    // THE APPROACH IS A SHOT TOO (r5 blocker). Un-introduced, alive, and close
    // enough that §5.1's staging has begun: the frame owes the player a boss
    // silhouette, and it cannot deliver one while it is framing the crawler
    // alone in a corridor. Lighter than the encounter framing on purpose —
    // this is the wide shot, the reveal keeps the push-in.
    const approach = !!star && !star.introduced && !!p &&
      Math.hypot(star.pos.x - p.pos.x, star.pos.y - p.pos.y) < 22;
    const holding = this.focusT > 0; // the kill beat's held frame
    const wantBias = engaged || revealing || holding ? BossFx.ENC_BIAS
      : approach ? BossFx.APR_BIAS : 0;
    let wantDrop = engaged || revealing || holding ? BossFx.ENC_DROP
      : approach ? BossFx.APR_DROP : 0;
    // ...and the WINDOW centres its subject (r6 blocker). The drop exists to
    // get the fight out from under the health plate, which is a problem at the
    // fight's normal zoom; at the window's push-in it instead pushed the boss
    // into the ability bar at the bottom of the frame. The one beat that has
    // to read gets the middle of the picture.
    if (this.punishFrameT > 0) wantDrop *= 0.42;
    // ...AND SO DOES THE PAYOFF (r7 blocker). `frameDrop` exists to clear the
    // HEALTH PLATE, and at the kill beat there is no health plate — the boss is
    // dead and `#bossbar` is already down. Carrying the full 6.8 into the
    // aftermath slid a corpse plus a four-tile loot ring down the frame until
    // its lower arc was underneath the ability bar: `marshal-6kill.png` has
    // two beacons behind the HUD and one in the corner. The payoff is a RING
    // and it has to be photographed whole, so the aftermath frames the middle.
    if (holding) wantDrop *= 0.3;
    // §5.2 asks the approach to PULL BACK on arena entry, and it never did.
    if (approach && !revealing) this.zoomWant = 1.12;
    // Eased, and slowly: the frame settling is not a beat, it is the shot.
    // The APPROACH settles faster than the fight does — it is a shot being
    // set up rather than a frame being borrowed mid-combat, and at the fight's
    // rate it was still a third of the way there when the arena came into view.
    const settle = approach && !engaged && !revealing ? 3.2 : 1.6;
    this.frameBias += (wantBias - this.frameBias) * Math.min(1, dt * settle);
    this.frameDrop += (wantDrop - this.frameDrop) * Math.min(1, dt * settle);

    // The governor's grip, applied to every live additive primitive. Shape is
    // never touched — only how hard it is allowed to burn.
    const dim = this.exposureScale;
    this.silhouetteLive =
      this.shapes.some((b) => b.life < b.max) ||
      this.cords.some((c) => c.life < c.max) ||
      this.shafts.some((sf) => sf.life < sf.max) ||
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
    // r5 BLOCKER — THE APPROACH WAS A RENDERING ARTIFACT, 10/10 CAPTURES.
    // The seal drew as a screen-sized ring clipped by the top of the viewport,
    // sitting across the HUD chips, with NO BOSS ANYWHERE IN FRAME and the
    // crawler parked in a black corner. Two independent causes, both here:
    //
    //   1. The ring was drawn on the BOSS at radius 6.5 while the camera was
    //      still anchored on the CRAWLER a dozen tiles away, so what reached
    //      the frame was one arc of a huge circle running off the top edge.
    //      It is bounded by the ARENA now (a threshold ring, not an arena-wide
    //      one) and — much more importantly —
    //   2. the approach takes a FRAMING of its own. §5.2 asks the approach to
    //      pull back on arena entry; it never did, so the beat that owes the
    //      player a silhouette had no subject in it. The anchor now slides a
    //      third of the way to the boss and the shot widens a step, which is
    //      what "you can see what is waiting in there" actually costs.
    if (star && !star.introduced && p &&
        Math.hypot(star.pos.x - p.pos.x, star.pos.y - p.pos.y) < 34) {
      const pal = ASK_PAL[bossFamily(star.bossId)];
      this.approachT += dt;
      this.approachLight -= dt;
      if (this.approachLight <= 0) {
        this.approachLight = 0.12;
        // A slow BREATH, never a pulse: this is a room being lit, not a beat.
        // Ungoverned floor of its own: the whole job of this light is that a
        // SILHOUETTE exists in the frame, and a silhouette dimmed to nothing
        // is the exact failure the capture found.
        const breath = 0.55 + 0.45 * Math.sin(this.approachT * 1.1);
        // LOW AND SMALL. At peak 3.8 and 2.6 units up this lit the FOG BANK
        // (translucent planes at y 0.55/1.35) instead of the body, and the
        // beat photographed as a glowing orange orb with nothing inside it.
        // The fog comes off the threshold in the sim now, so this only has to
        // pick the silhouette out — from below, at torch strength.
        // ON THE FLOOR, BEHIND THE BODY. Anything at body height blows the
        // rig out into a warm smear at this range (the bloom pass lifts it and
        // the boss stops having edges) — which is the SAME failure as lighting
        // the fog, one layer down. A silhouette needs a lit BACKGROUND, not a
        // lit subject, so the lamp sits at ankle height and stays weak.
        // BACKLIT, NOT LIT (r5, third cut). A lamp AT the boss lights the
        // boss, and at this range the bloom pass turns a 3-unit rig into a
        // warm smear with no edges — the same failure as lighting the fog
        // bank, one layer down. A silhouette needs a lit BACKGROUND: the lamp
        // sits up-screen of the body along the fixed iso diagonal, so the
        // threshold floor glows and the shape standing on it stays dark.
        const k = 2.6; // tiles up-screen, on the fixed iso heading
        this.deps.light(star.pos.x - k, star.pos.y - k, pal.rim,
          (1.7 + 1.1 * breath) * Math.max(dim, 0.8), 0.5, 0.7);
      }
      if (Math.random() < dt * 2.5) this.deps.fxp.embers(star.pos.x, star.pos.y, pal.mid, 1, 1.7);
      // The seal, at a whisper, and at THRESHOLD scale. It is the only ring in
      // the game that CONTRACTS, so it says "something in here closes behind
      // you" before anything moves — but it has to fit inside the shot to say
      // anything at all.
      // THE SEAL IS A RIG, NOT A STAMP (r5 blocker, third cut). Fired as a
      // transient it was drawn where the boss HAD been — and a boss that is
      // walking toward you leaves its own threshold behind within a second,
      // so the frame showed a lit ring with nothing in the middle of it,
      // which is exactly the "reads as a bug, not as dread" verdict. It is a
      // single mesh carried ON the boss now: wherever the shape in the dark
      // is, the ring is around it.
      if (!this.seal) {
        const mat = makeArenaMat();
        const mesh = new THREE.Mesh(TELEGRAPH_GEO, mat);
        mesh.renderOrder = 7;
        mesh.userData.noAO = true;
        this.group.add(mesh);
        this.seal = { mesh, mat };
      }
      this.seal.mesh.visible = true;
      this.seal.mesh.position.set(star.pos.x, 0.08, star.pos.y);
      this.seal.mesh.scale.setScalar(BossFx.SEAL_RADIUS);
      (this.seal.mat.uniforms.uColor.value as THREE.Color).setHex(pal.mid);
      (this.seal.mat.uniforms.uCore.value as THREE.Color).setHex(pal.core);
      this.seal.mat.uniforms.uTime.value = time;
      this.seal.mat.uniforms.uDim.value = Math.max(dim, 0.8);
      // ONE GLYPH PER BAND (r6 major): the Undercroft's threshold carries a
      // single mark, THE APPROACH's carries six. Countable, and the same
      // number the floor plate is showing.
      this.seal.mat.uniforms.uTicks.value =
        Math.max(1, Math.min(6, Math.round(state.floor / 3)));
      // A slow CONTRACT-and-reset: the only ring in the game that closes, on
      // a breath rather than on a beat.
      this.seal.mat.uniforms.uProg.value = (this.approachT % 2.6) / 2.6;
    } else {
      if (this.seal) this.seal.mesh.visible = false;
      if (this.approachT !== 0) this.approachT = 0;
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
    // The WINDOW silhouette: stands up over the first third, then drains from
    // the top down while the brackets close (see shaftBeat). Held at the
    // punish floor for the same reason the live rig is — this is the tell for
    // the beat §7.4 says most needs to read.
    const punishDim = Math.max(dim, BossFx.PUNISH_DIM_FLOOR);
    for (const sf of this.shafts) {
      if (sf.life >= sf.max) { sf.group.visible = false; sf.mark.visible = false; continue; }
      sf.life += dt;
      const prog = Math.min(1, sf.life / sf.max);
      const left = prog < 0.32 ? prog / 0.32 : 1 - (prog - 0.32) / 0.68;
      for (const q of sf.quads) {
        const qm = q.material as THREE.ShaderMaterial;
        qm.uniforms.uTime.value = time;
        qm.uniforms.uDim.value = punishDim;
        qm.uniforms.uLeft.value = Math.max(0, left);
      }
      const smm = sf.mark.material as THREE.ShaderMaterial;
      smm.uniforms.uTime.value = time;
      smm.uniforms.uDim.value = punishDim;
      smm.uniforms.uLeft.value = Math.max(0, left);
      if (sf.life >= sf.max) { sf.group.visible = false; sf.mark.visible = false; }
    }
    for (const b of this.lootMarks) {
      if (b.life >= b.max) { b.mesh.visible = false; continue; }
      b.life += dt;
      const t = Math.min(1, b.life / b.max);
      b.mat.uniforms.uTime.value = time;
      b.mat.uniforms.uProg.value = t;
      // Ungoverned on purpose and deliberately small: this is the one beat
      // that fires when the fight is OVER, so there is nothing left to blow.
      // The FADE is the shader's job now (LOOT_FRAG's uProg), so this stays
      // flat for most of the beacon's life instead of dimming from the moment
      // it lands — the pin has to be at full value when the shutter opens.
      b.mat.uniforms.uDim.value = 1;
      if (b.life >= b.max) b.mesh.visible = false;
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
        // Sized to the BODY, not to the arena (r5): at 1.25x boss scale this
        // was the largest object in the finale's frame and the Permit Office
        // wore two of them over the floor. It wraps the rig now.
        shell.position.set(m.pos.x, 0.78 * scale, m.pos.y);
        shell.scale.set(1.02 * scale, 1.16 * scale, 1.02 * scale);
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
        let plateIx = -1;
        for (const pl of m.plates) {
          plateIx++;
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
          // ITS OWN MARK (r7 major). Four stamps whose entire mechanic is "two
          // of us want the other school" carried no icon at all, so the world
          // objects were four interchangeable quads next to a plate that names
          // them individually. The glyph is the plate's INDEX on the body, so
          // STRUCTURAL / ELEMENTAL / OCCUPANCY / VARIANCE are wedge / bolt /
          // arch / slash, in that order, and the boss's own layout teaches it.
          pm.uniforms.uGlyph.value = plateIx % 4;
          const hex = pl.school === "magic" ? 0xa46bff : pl.school === "physical" ? 0xffb057 : 0xd8c08a;
          (pm.uniforms.uColor.value as THREE.Color).setHex(hex);
          mesh.visible = visible(m);
        }
      }

      // ---- PUNISH BEACON (V4). The boss is helpless; this beat owns vertical
      // space nothing else in the game uses, so it can never be missed.
      //
      // ...AND IT IS EXCLUSIVE TO IT (r6 blocker). Shipped, the condition was
      // `m.stagger > 0 || windupKind === "punish" || held` — and `m.stagger`
      // is set by a PLATE BREAK (1.2s), a SHIELD BREAK (1.6s), a poise
      // interrupt and a floodgate. So the probe found `shaft`+`reticle`
      // drawing in the -3fight frames of four bosses and the -4phase frames of
      // five: the one silhouette in the game that means "the window is open"
      // was on screen during three of the six beats, identifying nothing. r4
      // moved OVER-COMMIT onto this shape precisely so the tell and the window
      // would speak one sentence a beat apart; a shape that speaks it
      // constantly is not speaking. The rig is now the WINDOW's alone —
      // `marked` is written by `punishOpen` and by nothing else — plus the
      // punish TELL's own windup, which is the same sentence one beat earlier.
      // ...AND IT IS OFF WHILE THE BOARD IS BEING RE-DEALT (r7 blocker). An
      // untargetable boss cannot be unloaded into, so the one silhouette that
      // means "unload into this" may not be on screen while `invulnT` runs.
      // This is the gate; `intermission()` clears the held span so the rig
      // does not simply reappear when the break ends.
      const held = (m.invulnT ?? 0) > 0 ? undefined : this.marked.get(m.id);
      if ((m.invulnT ?? 0) <= 0 &&
          ((m.windupKind === "punish" && m.windup > 0) || held)) {
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
          qm.uniforms.uDim.value = punishDim;
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
        // THE ONE BEAT WITH A FLOOR (r4 major). Everything else in this file
        // pays the governor without argument; the punish reticle does not,
        // because the beat that must survive a bright frame cannot be the beat
        // dimmed by how bright the frame is.
        mm.uniforms.uDim.value = punishDim;
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

  /**
   * WHAT IS ACTUALLY ON THE GROUND RIGHT NOW, by silhouette.
   *
   * The capture harness has to be able to assert that a frame contains the
   * beat it claims, and "the sim emitted a telegraph" is not that assertion —
   * a stale seal held open by a capture hold looks identical to a live one in
   * a still. This is the ground truth: which shapes are drawing, this frame.
   */
  liveShapes(): Record<string, number> {
    const out: Record<string, number> = {};
    const bump = (k: string): void => { out[k] = (out[k] ?? 0) + 1; };
    for (const b of this.beats) if (b.life < b.max) bump("ring");
    for (const b of this.shapes) if (b.life < b.max) bump(b.kind);
    for (const c of this.cords) if (c.life < c.max) bump("cords");
    for (const sh of this.shells) if (sh.life < sh.max) bump("shell");
    for (const sf of this.shafts) if (sf.life < sf.max) bump("column");
    for (const b of this.lootMarks) if (b.life < b.max) bump("loot");
    // ...AND THE PERSISTENT RIGS (r5 blocker, the honesty half). Six of twelve
    // punish captures reported `shapes {}` — read as "zero boss FX geometry on
    // the beat that most needs to read" — while `marks:1` said the reticle rig
    // existed. Both were true: this method only ever reported the POOLED
    // transients, so the one rig the punish beat actually wears was invisible
    // to the probe. A probe that cannot see the beat cannot certify the frame.
    for (const mesh of this.marks.values()) if (mesh.visible) bump("reticle");
    for (const rig of this.punish.values()) if (rig.visible) bump("shaft");
    for (const mesh of this.shields.values()) if (mesh.visible) bump("shieldrig");
    for (const mesh of this.tethers.values()) if (mesh.visible) bump("tether");
    for (const mesh of this.plates.values()) if (mesh.visible) bump("plate");
    return out;
  }

  /** Per-hazard spore material (the Pollinator's pods), pooled by hazard id. */
  sporeMat(id: number): THREE.ShaderMaterial {
    let m = this.sporeMats.get(id);
    if (!m) { m = makeSporeMat(id); this.sporeMats.set(id, m); }
    return m;
  }

  releaseSpore(id: number): void {
    const m = this.sporeMats.get(id);
    if (m) { m.dispose(); this.sporeMats.delete(id); }
  }
}
