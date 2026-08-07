// POST-CHAIN PIXEL GATE — how to prove a post-processing pass was fused
// without changing the picture. Written for opt r4 (the Grade ShaderPass
// folded into OutputPass); kept because the PATTERN is the reusable part, and
// because the obvious alternative does not work.
//
// Cross-build stills cannot gate this change: the world keeps evolving while
// the page loads, so two builds photograph two different sim states (the
// floor-10 boss beat was mid-sweep in one arm and not the other). What this
// does instead is compare THE TWO SHADER PATHS ON ONE FRAME, inside a single
// synchronous task on the shipped build:
//
//   A = render with the new fused OutputGradePass
//   B = restore three's stock OutputShader on that pass, insert the OLD grade
//       ShaderPass right behind it (verbatim source), render again
//
// Nothing between the two renders: no rAF, no sim step, frozen clock, same
// camera, same scene graph. Any delta IS the shader change and nothing else.
// Both frames are read straight off the default framebuffer with gl.readPixels
// before the compositor swaps.
//
// Usage: node tools/postchain_pixgate.mjs   (needs a preview build on :5288)
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { OutputShader } from "three/examples/jsm/shaders/OutputShader.js";

const PORT = 5288;
const TAG = "dcc-opt6gate-5288";
const BUNDLE = readFileSync(new URL("../dist/iso.html", import.meta.url), "utf8")
  .match(/iso-[A-Za-z0-9_-]+\.js/)[0];
const served = await (await fetch(`http://localhost:${PORT}/iso.html`)).text();
if (!served.includes(BUNDLE)) throw new Error(`fingerprint mismatch: :${PORT} does not serve ${BUNDLE}`);
console.log(`[gate] server fingerprint OK -> ${BUNDLE}`);

// The grade fragment EXACTLY as it shipped before this change (git show
// HEAD:src/render3d/renderer3d.ts). Not re-derived from the new one.
const LEGACY_GRADE_FRAG = `
    uniform sampler2D tDiffuse;
    uniform vec3 uShadow;
    uniform vec3 uHighlight;
    uniform float uSaturation;
    uniform float uVignette;
    uniform vec3 uVigColor;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb += uShadow * (1.0 - smoothstep(0.0, 0.3, l)) * 0.45;
      c.rgb *= mix(vec3(1.0), uHighlight, smoothstep(0.35, 1.0, l) * 0.4);
      c.rgb = mix(vec3(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))), c.rgb, uSaturation);
      float d = length(vUv - 0.5) * 1.4142;
      float vig = 1.0 - uVignette * smoothstep(0.84, 1.16, d);
      c.rgb = mix(uVigColor, c.rgb, vig);
      gl_FragColor = c;
    }`;
const LEGACY_GRADE_VERT = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

function vclock() {
  if (window.__vt) return;
  const raf = window.requestAnimationFrame.bind(window);
  let t = 1000000;
  window.__vt = { advance: (ms) => { t += ms; } };
  window.requestAnimationFrame = (cb) => raf(() => cb((t += 0.01)));
}

async function waitPlayable(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector("#loading");
    if (!el) return true;
    const cs = getComputedStyle(el);
    return el.classList.contains("done") || cs.display === "none" || +cs.opacity === 0;
  }, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, { timeout: 60000 });
}

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", `--${TAG}`],
});
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const out = { bundle: BUNDLE, scenes: {} };
try {
  for (const scene of [
    { id: "floor10_boss", url: `http://localhost:${PORT}/iso.html?test&floor=10&seed=42&eagerassets&debug=1` },
    { id: "floor4_calm", url: `http://localhost:${PORT}/iso.html?test&floor=4&seed=42&eagerassets&debug=1` },
    { id: "floor16_dense", url: `http://localhost:${PORT}/iso.html?test&floor=16&level=14&abilities=all&seed=42&eagerassets&debug=1` },
  ]) {
    console.log(`[gate] === ${scene.id}`);
    await page.goto(scene.url, { waitUntil: "load", timeout: 240000 });
    await page.mouse.move(590, 380);
    await waitPlayable(page);
    await page.evaluate(`(${vclock.toString()})()`);
    await page.waitForTimeout(600);

    const res = await page.evaluate(({ stockFrag, gradeFrag, gradeVert }) => {
      const R = window.__dcc.renderer;
      const renderer = R.renderer;
      const composer = R.composer;
      const gl = renderer.getContext();
      const passes = composer.passes;
      const outIdx = passes.findIndex((p) => p.material && typeof p.material.fragmentShader === "string"
        && p.material.fragmentShader.includes("uShadow"));
      if (outIdx < 0) return { error: "fused output pass not found — is this the new build?" };
      const outPass = passes[outIdx];
      const w = renderer.domElement.width, h = renderer.domElement.height;

      const grab = () => {
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };

      // ---- CONTROL: the shipped chain rendered twice, nothing changed.
      // Anything the renderer drives off the REAL clock (flame sprites, motes,
      // fog scroll) moves between two renders separated by a 7.6 MB readPixels,
      // so this is the noise floor the real comparison has to be read against.
      R.render();
      const C0 = grab();
      R.render();
      const C1 = grab();

      const fusedFrag = outPass.material.fragmentShader;
      const ShaderPass = composer.copyPass.constructor;
      const u = outPass.uniforms;
      const mkLegacy = () => new ShaderPass({
        uniforms: {
          tDiffuse: { value: null },
          uShadow: { value: u.uShadow.value.clone() },
          uHighlight: { value: u.uHighlight.value.clone() },
          uSaturation: { value: u.uSaturation.value },
          uVignette: { value: u.uVignette.value },
          uVigColor: { value: u.uVigColor.value.clone() },
        },
        vertexShader: gradeVert,
        fragmentShader: gradeFrag,
      });

      // A = fused, B = legacy (stock OutputPass + a separate grade ShaderPass).
      const arm = () => {
        R.render();
        const a = grab();
        outPass.material.fragmentShader = stockFrag;
        outPass.material.needsUpdate = true;
        const legacy = mkLegacy();
        composer.insertPass(legacy, outIdx + 1);
        R.render();
        const b = grab();
        composer.removePass(legacy);
        if (legacy.dispose) legacy.dispose();
        outPass.material.fragmentShader = fusedFrag;
        outPass.material.needsUpdate = true;
        R.render();
        return [a, b];
      };

      const [A, B] = arm();
      // Same comparison with SMAA off. SMAA is a THRESHOLDED edge classifier
      // reading the graded image, so a sub-LSB change anywhere near a decision
      // boundary flips one pixel's blend weight by a lot. Turning it off asks
      // the question the gate actually cares about: is the GRADE the same?
      const hadSmaa = R.smaa ? R.smaa.enabled : false;
      let A2 = null, B2 = null;
      if (R.smaa) {
        R.smaa.enabled = false;
        [A2, B2] = arm();
        R.smaa.enabled = hadSmaa;
        R.render();
      }

      // ---- compare ----
      const cmp = (X, Y) => {
        let max = 0, sum = 0, n = 0, mx = 0, my = 0;
        const buckets = [0, 0, 0, 0, 0]; // ==0, <=1, <=2, <=4, >4
        let worst = null;
        for (let i = 0; i < X.length; i += 4) {
          const d = Math.max(Math.abs(X[i] - Y[i]), Math.abs(X[i + 1] - Y[i + 1]), Math.abs(X[i + 2] - Y[i + 2]));
          if (d > max) { max = d; worst = { px: (i / 4) % w, py: Math.floor((i / 4) / w),
            a: [X[i], X[i + 1], X[i + 2]], b: [Y[i], Y[i + 1], Y[i + 2]] }; }
          sum += d; n++;
          mx += X[i] + X[i + 1] + X[i + 2];
          my += Y[i] + Y[i + 1] + Y[i + 2];
          if (d === 0) buckets[0]++; else if (d <= 1) buckets[1]++;
          else if (d <= 2) buckets[2]++; else if (d <= 4) buckets[3]++; else buckets[4]++;
        }
        return {
          maxChannelDelta: max,
          meanChannelDelta: +(sum / n).toFixed(5),
          pctIdentical: +((buckets[0] / n) * 100).toFixed(3),
          pctLE1: +(((buckets[0] + buckets[1]) / n) * 100).toFixed(3),
          pctGT4: +((buckets[4] / n) * 100).toFixed(5),
          pixelsGT4: buckets[4],
          meanLumaA: +(mx / n / 3).toFixed(4),
          meanLumaB: +(my / n / 3).toFixed(4),
          worstPixel: worst,
        };
      };
      // where the >4 pixels sit: clustered (a region changed) or scattered
      // (isolated pixels on FX edges)?
      const scatter = (X, Y) => {
        const pts = [];
        for (let i = 0; i < X.length && pts.length < 400; i += 4) {
          const d = Math.max(Math.abs(X[i] - Y[i]), Math.abs(X[i + 1] - Y[i + 1]), Math.abs(X[i + 2] - Y[i + 2]));
          if (d > 4) pts.push([(i / 4) % w, Math.floor((i / 4) / w)]);
        }
        // largest run of >4 pixels that are 8-connected on the same row
        let maxRun = 0, run = 0, prev = null;
        for (const p of pts) {
          if (prev && p[1] === prev[1] && p[0] === prev[0] + 1) run++; else run = 1;
          if (run > maxRun) maxRun = run;
          prev = p;
        }
        return { count: pts.length, longestHorizontalRun: maxRun, sample: pts.slice(0, 12) };
      };
      return {
        size: [w, h],
        passesBefore: passes.length,
        control_sameChainTwice: cmp(C0, C1),
        gate_fusedVsLegacy: cmp(A, B),
        gate_fusedVsLegacy_scatter: scatter(A, B),
        gate_noSmaa: A2 ? cmp(A2, B2) : null,
      };
    }, { stockFrag: OutputShader.fragmentShader, gradeFrag: LEGACY_GRADE_FRAG, gradeVert: LEGACY_GRADE_VERT });

    out.scenes[scene.id] = res;
    console.log(JSON.stringify(res));
    if (res.error) throw new Error(res.error);
  }
} finally {
  await browser.close();
}
writeFileSync(new URL("./postchain_pixgate.out.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("[gate] DONE");
