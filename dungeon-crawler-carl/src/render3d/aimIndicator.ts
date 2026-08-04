import * as THREE from "three";

/**
 * THE AIM TELEGRAPH (MOBILE.md §3.1) — the single read a touch ARPG lives on.
 *
 * What this replaces, measured in §1.6: three hardcoded meshes inside
 * `renderer3d.setAimIndicator` — a `PlaneGeometry(4.2, 0.2)`, a
 * `RingGeometry(2.0, 2.2)` and a 0.34 arrow — painted gold `#c9a24b` at 0.42
 * with no outline and no second pass. Nova (radius 2.6) and cataclysm
 * (radius 6) therefore drew the PIXEL-IDENTICAL ring; bolt drew a 4.2-unit
 * stub whatever its derived reach; `cone`, `scatter` and `chain` did not exist
 * and were folded into line/ring by the host. The frame diff inside the
 * indicator's own projected box came back AT OR BELOW the scene's churn
 * between two consecutive frames: the thing carried no signal the torchlight
 * did not already carry.
 *
 * Pure geometry — shape name plus the ability's own numbers in, meshes out. It
 * lives outside the renderer so the six shapes read as one table rather than
 * as branches in a 40-line method, and so a test can build them with no GL.
 */

/** Six shapes, matching `src/input/aimSpec.ts` one for one. */
export type AimIndicatorShape =
  | "line" | "ring" | "arrow" | "cone" | "scatter" | "chain" | "none";

/**
 * Minimum stroke width in CSS px at dpr 1 (§3.1). The old line was a
 * 0.2-world-unit plane, which at the iso zoom a phone actually runs is barely
 * over one pixel — that is what made it vanish.
 */
export const AIM_STROKE_PX = 3;
/**
 * No indicator may project smaller than this box. Measured, the dash arrow
 * projected 71x28 CSS px — under the floor in BOTH axes.
 */
export const AIM_MIN_FOOTPRINT_PX = 96;

/**
 * COLOUR THE WORLD DOES NOT OWN. Gold `#c9a24b` is the HUD, the chips, the
 * torchlight and the loot glow; red/orange is the ENEMY ground telegraph. The
 * player's own indicator is cyan fill under a white core stroke, over a dark
 * outline — so "gold = valid, red = cancel" stops painting our valid state in
 * the HUD's colour and our cancel state in the enemy's.
 */
export const AIM_FILL = 0x39c8e8;
export const AIM_CORE = 0xeaf9ff;
export const AIM_OUTLINE = 0x08131a;

/**
 * MATERIALS ARE SHARED SINGLETONS AND ARE NEVER DISPOSED. A drag rebuilds the
 * telegraph every time its key changes (the camera's aim-lead ease changes the
 * stroke width per frame), and each rebuild used to mint 5-10 fresh materials
 * and dispose the old ones — which (a) made the late shader-catcher re-compile
 * mid-aim, and (b) could destroy a material the catcher's in-flight poll still
 * held, three's `reading 'isReady'` crash. The parameters are constants; one
 * material per role for the life of the app is the correct shape.
 */
const MATS: { fill?: THREE.MeshBasicMaterial; fillFade?: THREE.MeshBasicMaterial;
  core?: THREE.MeshBasicMaterial; outline?: THREE.MeshBasicMaterial;
  rangeFill?: THREE.MeshBasicMaterial; rangeEdge?: THREE.MeshBasicMaterial } = {};

function fillMat(): THREE.MeshBasicMaterial {
  return MATS.fill ??= new THREE.MeshBasicMaterial({
    color: AIM_FILL, transparent: true, opacity: 0.30,
    side: THREE.DoubleSide, depthWrite: false,
  });
}

/** The faded ribbon needs vertexColors, which must not leak onto the shared fill. */
function fillFadeMat(): THREE.MeshBasicMaterial {
  return MATS.fillFade ??= new THREE.MeshBasicMaterial({
    color: AIM_FILL, transparent: true, opacity: 0.30,
    side: THREE.DoubleSide, depthWrite: false, vertexColors: true,
  });
}

/**
 * The core stroke ignores depth on purpose: a pack of sprites standing on the
 * telegraph used to swallow it, which is the failure `r5/crop-aim-line.png`
 * photographed. `depthWrite` stays off either way so the ground plane cannot
 * z-fight.
 */
function coreMat(): THREE.MeshBasicMaterial {
  return MATS.core ??= new THREE.MeshBasicMaterial({
    color: AIM_CORE, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide, depthWrite: false, depthTest: false,
  });
}

function outlineMat(): THREE.MeshBasicMaterial {
  return MATS.outline ??= new THREE.MeshBasicMaterial({
    color: AIM_OUTLINE, transparent: true, opacity: 0.7,
    side: THREE.DoubleSide, depthWrite: false, depthTest: false,
  });
}

/** Flat on the ground, at a height that cannot z-fight the floor. */
function ground(
  geo: THREE.BufferGeometry, mat: THREE.Material, y: number, order: number,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  m.renderOrder = order;
  return m;
}

/**
 * One stroke = an outline plate plus a core plate, the outline wider on every
 * side. Two draws of a handful of triangles, which is cheaper than a shader
 * outline on a flat ribbon and does not need a second render target.
 */
function strokePair(
  make: (w: number) => THREE.BufferGeometry, stroke: number, outline: number,
): THREE.Mesh[] {
  return [
    ground(make(stroke + outline * 2), outlineMat(), 0.004, 3998),
    ground(make(stroke), coreMat(), 0.006, 4000),
  ];
}

/**
 * GEOMETRY FROM THE ABILITY. `range`, `radius` and `arc` arrive from the
 * `AimSpec` the host computes off the crawler's own params, so glyphs and
 * ranks change the drawn shape — something Wild Rift structurally cannot do,
 * because its indicators are per-ability art.
 *
 * `stroke` and `minSpan` arrive already converted to WORLD units from the CSS
 * floors above, because only the renderer knows the live camera scale.
 */
export function buildAimShape(
  kind: AimIndicatorShape, range: number, radius: number, arc: number,
  stroke: number, minSpan: number,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const ol = stroke * 0.34; // the 1 CSS px outline, in the same world units
  switch (kind) {
    case "line":
    case "chain": {
      // THE FOOTPRINT FLOOR APPLIES TO THE READABLE PART, NOT TO THE REACH. A
      // skillshot's reach is a game number and must never be inflated to suit
      // a screen (that would be a game rule invented in presentation). What
      // gets the floor is the terminal disc — the part that carries the
      // information, and the part the thumb is not covering.
      const len = Math.max(0.6, range);
      const disc = Math.max(radius, minSpan * 0.28);
      out.push(...strokePair(
        (w) => new THREE.PlaneGeometry(len, w).translate(len / 2, 0, 0), stroke, ol,
      ));
      // The near 40% fades toward the origin (§3.1, occlusion): on a 342 px
      // phone the drag puts the thumb over the crawler and over the near half
      // of its own indicator, so the contrast belongs at the far end.
      const fill = ground(
        new THREE.PlaneGeometry(len, disc * 2).translate(len / 2, 0, 0),
        fillMat(), 0.002, 3990,
      );
      fadeNear(fill, len);
      out.push(fill);
      out.push(ground(
        new THREE.RingGeometry(disc * 0.72, disc, 30).translate(len, 0, 0),
        coreMat(), 0.006, 4000,
      ));
      if (kind === "chain") {
        // A chain BOUNCES. Two shrinking discs beyond the first say so, where
        // the old ring lied about the shape outright.
        for (let i = 1; i <= 2; i++) {
          const r2 = disc * (1 - i * 0.22);
          out.push(ground(
            new THREE.RingGeometry(r2 * 0.7, r2, 22).translate(len * (1 + i * 0.34), 0, 0),
            fillMat(), 0.003, 3992,
          ));
        }
      }
      break;
    }
    case "ring": {
      const r = Math.max(radius, minSpan / 2);
      out.push(ground(new THREE.CircleGeometry(r, 48), fillMat(), 0.002, 3990));
      out.push(...strokePair(
        (w) => new THREE.RingGeometry(Math.max(0.01, r - w / 2), r + w / 2, 56), stroke, ol,
      ));
      break;
    }
    case "cone": {
      // NEW SHAPE. A melee sweep used to draw as a line, which described
      // neither its reach nor the half-arc it actually covers.
      const half = arc > 0 ? arc : Math.PI / 6;
      const r = Math.max(range, minSpan * 0.5);
      out.push(ground(
        new THREE.CircleGeometry(r, 40, -half, half * 2), fillMat(), 0.002, 3990,
      ));
      out.push(...strokePair(
        (w) => new THREE.RingGeometry(Math.max(0.01, r - w / 2), r + w / 2, 40, 1, -half, half * 2),
        stroke, ol,
      ));
      // The two flanks, so a sweep reads as a WEDGE and not a curved bar.
      for (const s of [-1, 1]) {
        out.push(...strokePair(
          (w) => new THREE.PlaneGeometry(r, w).translate(r / 2, 0, 0).rotateZ(s * half),
          stroke, ol,
        ));
      }
      break;
    }
    case "arrow": {
      const len = Math.max(range, 0.6);
      const foot = Math.max(radius, minSpan * 0.24);
      out.push(...strokePair(
        (w) => new THREE.PlaneGeometry(len, w).translate(len / 2, 0, 0), stroke, ol,
      ));
      // The LANDING FOOTPRINT is the information, so it is always at the far
      // end and never smaller than the floor.
      out.push(ground(
        new THREE.CircleGeometry(foot, 30).translate(len, 0, 0), fillMat(), 0.002, 3990,
      ));
      out.push(...strokePair(
        (w) => new THREE.RingGeometry(Math.max(0.01, foot - w / 2), foot + w / 2, 34)
          .translate(len, 0, 0),
        stroke, ol,
      ));
      break;
    }
    case "scatter": {
      // NEW SHAPE. An airstrike does not detonate in one circle, it PEPPERS a
      // spread — so the boundary is dashed and the impact points are drawn.
      const r = Math.max(radius, minSpan / 2);
      out.push(ground(new THREE.CircleGeometry(r, 44), fillMat(), 0.002, 3990));
      const seg = 18;
      for (let i = 0; i < seg; i += 2) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        out.push(...strokePair(
          (w) => new THREE.RingGeometry(Math.max(0.01, r - w / 2), r + w / 2, 6, 1, a0, a1 - a0),
          stroke, ol,
        ));
      }
      // Deterministic sample points — a telegraph that shimmers per frame is a
      // telegraph nobody can read.
      for (let i = 0; i < 5; i++) {
        const a = (i * 2.399963) % (Math.PI * 2);
        const rr = r * (0.24 + 0.62 * ((i * 0.37) % 1));
        out.push(ground(
          new THREE.CircleGeometry(Math.max(stroke, r * 0.12), 14)
            .translate(Math.cos(a) * rr, Math.sin(a) * rr, 0),
          coreMat(), 0.006, 4000,
        ));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * THE MAX-RANGE RING (wr_04): while an aim is live, Wild Rift draws the cast's
 * reach as a world-space circle around the champion, so committing a throw is
 * a decision about a visible boundary rather than a guess. Ours: a translucent
 * cyan boundary stroke centred on the CRAWLER (the shape itself stays at the
 * aim anchor), with a whisper of fill on close ranges only — a 14-tile bolt
 * disc would wash the scene the fill is supposed to sit under.
 */
export function buildRangeRing(r: number, stroke: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  if (r <= 8) {
    MATS.rangeFill ??= new THREE.MeshBasicMaterial({
      color: AIM_FILL, transparent: true, opacity: 0.07,
      side: THREE.DoubleSide, depthWrite: false,
    });
    out.push(ground(new THREE.CircleGeometry(r, 72), MATS.rangeFill, 0.001, 3970));
  }
  MATS.rangeEdge ??= new THREE.MeshBasicMaterial({
    color: AIM_FILL, transparent: true, opacity: 0.4,
    side: THREE.DoubleSide, depthWrite: false,
  });
  out.push(ground(
    new THREE.RingGeometry(Math.max(0.01, r - stroke / 2), r + stroke / 2, 96),
    MATS.rangeEdge, 0.003, 3972,
  ));
  return out;
}

/**
 * Fade the near 40% of a ribbon toward its origin. Vertex colours, so it costs
 * no extra draw and no custom shader.
 */
function fadeNear(mesh: THREE.Mesh, len: number): void {
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getX(i) / Math.max(1e-3, len)));
    const a = 0.15 + 0.85 * Math.min(1, t / 0.4);
    col[i * 3] = a; col[i * 3 + 1] = a; col[i * 3 + 2] = a;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  mesh.material = fillFadeMat();
}

/**
 * Free the GEOMETRY of a discarded telegraph. Materials are the shared
 * singletons above and live for the app — disposing them released programs
 * the shader-catcher was still polling (see MATS).
 */
export function disposeAimShape(o: THREE.Object3D): void {
  o.traverse((n) => {
    (n as THREE.Mesh).geometry?.dispose?.();
  });
}
