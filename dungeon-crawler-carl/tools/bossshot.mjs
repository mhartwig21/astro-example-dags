// BOSSES V2 capture harness — one REAL fight per named boss, six beats each.
//
// The previous cut staged every beat by pushing synthetic BossEvent records
// into state.bossEvents. The acceptance review's verdict was fair: that proves
// the FX layer renders when poked, not that the FIGHT produces the moment. Its
// kill shot had the boss standing at 100% with the player at full health.
//
// So this one fights. For every boss in the pool it boots that boss's seed,
// walks the crawler in until the SIM fires its own ringside encounter, and then
// drives a real fight — real intents, real swings, real casts — until the sim
// emits each beat on its own:
//   1 approach  : parked down the hall, boss alive and un-introduced
//   2 intro     : the encounter the sim raised when the crawler closed
//   3 fight     : the boss's own named signature, the frame it commits
//   4 phase     : a real phase edge + the intermission that re-deals the board
//   5 punish    : the over-commit window the boss earned by over-committing
//   6 kill      : the boss at ZERO, corpse down, loot ringside
//
// Nothing below invents an event. Every capture is triggered BY a record the
// sim wrote, and the boss health plate tells the fight's arc across the chain
// because the health is real.
//
// TIME. SwiftShader composites seconds after staging, so a beat staged on the
// real clock is cold before the shutter opens. The repo's answer
// (tools/combatshot.mjs) is a virtual clock: patch the rAF timestamp to advance
// ~0.4ms/frame, which freezes BOTH the host's sim accumulator and every FX
// lifetime. The fight is then driven by hand through __dcc.step, and the frame
// is aged deliberately with __vt.advance(ms) just before each capture.
//
// Usage: node tools/bossshot.mjs --base=http://localhost:5410 --out=tools/_bossN [--only=id,id] [--swiftshader]
//
// --base and --out are REQUIRED and explicit on purpose. The previous cut
// hardcoded a port from a dead dev server and defaulted its output into a
// directory another session had already filled, so a run that captured nothing
// still "produced" a full set of frames. Both are now stated by the caller.
//
// GPU: real ANGLE/d3d11 by default (see tools/gpuprobe.mjs). SwiftShader
// composites seconds after staging and eats any beat shorter than that, so it
// is opt-in via --swiftshader and should only be used where no GPU exists.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const flag = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : def;
};
const BASE = (flag("base", process.env.DCC_BASE) || "").replace(/\/+$/, "");
const OUT = flag("out", process.env.DCC_OUT);
if (!BASE || !OUT) {
  console.error("usage: node tools/bossshot.mjs --base=http://localhost:PORT --out=DIR [--only=id,id] [--swiftshader]");
  process.exit(2);
}
const ONLY = (flag("only", "") || "").split(",").filter(Boolean);
const SWIFT = process.argv.includes("--swiftshader");
mkdirSync(OUT, { recursive: true });
console.log("base=" + BASE + " out=" + OUT + " gl=" + (SWIFT ? "swiftshader" : "angle/d3d11"));

const BANDS = { 1: 3, 2: 6, 3: 9, 4: 12, 5: 15, 6: 18 };

const browser = await chromium.launch({
  headless: SWIFT, // headless-new still routes through SwiftShader on many boxes
  args: SWIFT
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"]
    : ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

function url(seed, floor) {
  const lvl = Math.min(30, 6 + floor);
  return BASE + "/iso.html?test&debug=1&clean=1&floor=" + floor +
    "&level=" + lvl + "&abilities=all&gold=4000&seed=" + seed + "&eagerassets";
}

async function boot(seed, floor) {
  let last = null;
  for (let i = 0; i < 5; i++) {
    try {
      await page.goto(url(seed, floor), { waitUntil: "load", timeout: 240000 });
      await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
      await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.renderer, null, { timeout: 120000 });
      // The SIGNAL ACQUISITION card fades on a class and only sets display:none
      // half a second later — wait it out, or the first capture is the card.
      await page.waitForFunction(() => {
        const el = document.getElementById("loading");
        return !el || el.style.display === "none" || el.classList.contains("done");
      }, null, { timeout: 120000 });
      await page.waitForTimeout(700);
      return;
    } catch (e) {
      last = e;
      console.error("  boot attempt " + (i + 1) + ": " + String(e.message).split("\n")[0]);
      await page.waitForTimeout(3000);
    }
  }
  throw last;
}

// ---- Which seed serves which boss? Ask the shipping module. ----------------
await boot(1, 3);
const plan = await page.evaluate(async (bands) => {
  const m = await import("/src/sim/bosses.ts");
  const out = {};
  for (const band of Object.keys(bands)) {
    for (let seed = 1; seed < 4000; seed++) {
      const def = m.pickBandBoss(seed, Number(band));
      if (out[def.id]) continue;
      out[def.id] = { seed, floor: bands[band], band: Number(band), name: def.name, ask: def.ask };
    }
  }
  return out;
}, BANDS);
const roster = Object.entries(plan).filter((e) => ONLY.length === 0 || ONLY.includes(e[0]));
console.log("roster: " + roster.length + " bosses");

// ---------------------------------------------------------------------------
// THE IN-PAGE FIGHT DRIVER. Installed once per boot; everything below runs
// inside the page, so a fight is thousands of sim steps and not thousands of
// CDP round trips.
// ---------------------------------------------------------------------------
const DRIVER = String.raw`
(function () {
  if (window.__bf && window.__bf.ready) return;
  // Virtual clock: freeze the rAF timestamp so the host stops accumulating sim
  // time AND every FX lifetime stalls. __vt.advance(ms) ages the frame on
  // purpose, which is the only way a SwiftShader capture ever sees a 300ms beat.
  if (!window.__vt) {
    const raf = window.requestAnimationFrame.bind(window);
    let t = performance.now();
    window.__vt = { advance: function (ms) { t += ms; } };
    window.requestAnimationFrame = function (cb) { return raf(function () { cb(t += 0.4); }); };
  }
  var bf = window.__bf = window.__bf || {};
  bf.ready = true;
  bf.log = [];
  bf.i = 0;
  bf.boss = function () {
    var ms = window.__dcc.state.monsters;
    return ms.find(function (m) { return m.kind === "boss" && m.hp > 0; })
      || ms.find(function (m) { return m.kind === "boss"; });
  };

  // Route one manual step's feedback through the SAME host paths the frame
  // loop uses. Necessary because the frozen clock means the host loop is no
  // longer stepping (and therefore no longer draining) — but every record
  // pumped here was written by the sim, never by the harness.
  //
  // STAGING IS EXPENSIVE, AND THE CLOCK IS FROZEN. Every staged hit and beat
  // spawns particles, decals and shockwaves whose lifetimes advance with the
  // virtual clock — which is stopped. Staging all of them across a
  // thousand-step fight therefore ACCUMULATES without bound and the page
  // grinds to a halt (measured: the harness stalled entirely). So the fight
  // runs SILENT and only the frame that matters is staged.
  bf.pump = function (stage) {
    var st = window.__dcc.state;
    var evs = st.bossEvents || [];
    for (var j = 0; j < evs.length; j++) {
      bf.log.push(evs[j].kind + (evs[j].label ? ":" + evs[j].label : ""));
    }
    if (!stage) return evs;
    var hits = st.hits || [];
    for (var i = 0; i < hits.length; i++) window.__dcc.hit(hits[i]);
    for (var k = 0; k < evs.length; k++) window.__dcc.bossBeat(evs[k]);
    return evs;
  };
})()`;

// The fight itself, in the page. Split from DRIVER only to keep each block
// readable; both are evaluated back to back after every boot.
const DRIVER2 = String.raw`
(function () {
  var bf = window.__bf;

  // One sim step of a genuine fight: close, orbit, swing, rotate the kit.
  bf.tick = function (i, opts) {
    opts = opts || {};
    var st = window.__dcc.state;
    var p = st.players[0];
    var b = bf.boss();
    if (!b) return null;
    var dx = b.pos.x - p.pos.x, dy = b.pos.y - p.pos.y;
    var d = Math.hypot(dx, dy) || 1;
    var to = { x: dx / d, y: dy / d };
    // Close to swinging range, then STRAFE. A crawler who stands still on a
    // boss floor dies in about two seconds (BOSSES-V2 §6.1), and a capture of
    // a corpse is not a capture of a fight.
    var move = d > (opts.reach || 2.6)
      ? to
      : { x: -to.y * 0.9, y: to.x * 0.9 };
    var cast = [true, i % 42 === 0, i % 67 === 0, i % 101 === 0, i % 173 === 0];
    window.__dcc.step({ move: move, aim: to, attack: true, cast: cast, useStairs: false }, 1 / 60);
    // The crawler is kept on their feet, and ONLY that: health still falls, the
    // plate still tells the story, and a downed crawler would freeze the world
    // (step() early-returns) and silently end the fight.
    if (p.hp < p.maxHp * 0.3) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.5);
    p.alive = true; p.downedT = 0;
    if (st.status !== "playing") st.status = "playing";
    return bf.pump(!!opts.fx);
  };

  // Keep the world turning with the boss gone (the aftermath: corpse settling,
  // loot landing, the ringside arc flying).
  bf.idle = function (n) {
    for (var i = 0; i < n; i++) {
      window.__dcc.step({ move: { x: 0, y: 0 }, useStairs: false }, 1 / 60);
      bf.pump(true);
    }
  };

  // Fight until the sim emits one of \`want\`, or until the boss falls.
  //
  // opts.holdHp pins the boss's health at whatever it was when the hunt
  // started. The punish window is HEAT-driven, not HP-driven — it arrives on
  // the boss's own count of committed signatures — so without this a
  // well-armed crawler burns straight through the health gates and the segment
  // ends before the beat it exists to photograph. It changes only WHEN the
  // fight ends, never what the boss does, and it leaves the health gates for
  // the phase segment, which is where they belong in the chain.
  bf.until = function (want, maxSteps, opts) {
    opts = opts || {};
    var hold = -1;
    if (opts.holdHp) { var hb0 = bf.boss(); hold = hb0 ? hb0.hp : -1; }
    for (var i = 0; i < maxSteps; i++) {
      // The last stretch before a beat can land runs WITH staging on, so the
      // capture has live impact FX around it rather than a sterile frame. The
      // window is short by design (see bf.pump).
      opts.fx = i > 0 && i % 400 > 385;
      var evs = bf.tick(bf.i += 1, opts);
      if (hold > 0) {
        var hb = bf.boss();
        if (hb && hb.hp > 0 && hb.hp < hold) hb.hp = hold;
      }
      // A FLOOR, not a pin (r4 blocker). The phase hunt cannot pin the health
      // (the intermission is HP-gated, so a pinned boss never reaches it), and
      // the crawler is handed bonusDamage = 60 + floor*26 at the approach — so
      // three bosses in the last run died DURING the phase hunt and nine of a
      // hundred and eight frames were a corpse filed as a live beat. A floor
      // just above the last phase gate lets every gate land and stops the boss
      // dying while the harness is waiting for one.
      if (opts.floorHp > 0) {
        var fb = bf.boss();
        if (fb && fb.hp > 0 && fb.hp < fb.maxHp * opts.floorHp) {
          fb.hp = fb.maxHp * opts.floorHp;
        }
      }
      if (!evs) return { done: "noboss" };
      for (var j = 0; j < evs.length; j++) {
        var e = evs[j];
        if (want.indexOf(e.kind) < 0) continue;
        if (opts.label && !e.label) continue;
        if (opts.prefer && e.label !== opts.prefer) continue;
        // THE frame that matters: stage this beat and the hits beside it
        // through the host's own paths, then stop the fight here.
        if (!opts.fx) {
          var hh = window.__dcc.state.hits || [];
          for (var q = 0; q < hh.length; q++) window.__dcc.hit(hh[q]);
          for (var r = 0; r < evs.length; r++) window.__dcc.bossBeat(evs[r]);
        }
        var bb = bf.boss();
        return {
          done: "event", kind: e.kind, label: e.label || "",
          hp: bb ? bb.hp / bb.maxHp : 0, steps: i,
        };
      }
      var b = bf.boss();
      if (!b || b.hp <= 0) {
        // The kill frame is a beat like any other: stage it (DEFEATED, the
        // corpse's hits, the ringside payoff) through the host's own paths.
        if (!opts.fx) {
          var kh = window.__dcc.state.hits || [];
          for (var s = 0; s < kh.length; s++) window.__dcc.hit(kh[s]);
          for (var t = 0; t < evs.length; t++) window.__dcc.bossBeat(evs[t]);
        }
        return { done: "dead", hp: 0, steps: i };
      }
    }
    var last = bf.boss();
    return { done: "timeout", hp: last ? last.hp / last.maxHp : 0, steps: maxSteps };
  };
})()`;

// A vite full-reload (another agent saving a file on this checkout, or HMR on
// this one) wipes the page mid-fight: __bf goes, the fight state goes, and the
// harness happily ships a screenshot of the loading card. Every boot stamps a
// token; every capture checks it and aborts the boss so the outer loop can
// start that fight over from the top.
let bootToken = 0;
async function guard(opts = {}) {
  const st = await page.evaluate((tok) => {
    const el = document.getElementById("loading");
    // THE PLAYFIELD MUST BE UNOBSTRUCTED (r4 blocker). Reading
    // `state.status !== "playing"` was not enough on its own, because bf.tick
    // FORCE-WRITES st.status back to "playing" on every step — so the sim
    // looked alive to the guard while the host had already opened THE VERDICT
    // and every subsequent frame was that modal. This measures the SCREEN
    // instead: any fixed overlay actually covering the middle of the viewport
    // is a frame that does not contain its beat, whatever the sim says.
    const vw = window.innerWidth, vh = window.innerHeight;
    let blocker = null;
    const named = ["recap", "menu", "draft", "saferoom", "inv", "abil", "sheet", "keys", "dialogue"];
    for (const id of named) {
      const e = document.getElementById(id);
      if (!e) continue;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) continue;
      const r = e.getBoundingClientRect();
      if (r.width * r.height > vw * vh * 0.25) { blocker = id; break; }
    }
    // ...and whatever the DOM says, ask the compositor what is actually on top
    // of the middle of the frame. A future overlay nobody remembered to name
    // still gets caught.
    if (!blocker) {
      const top = document.elementFromPoint(vw / 2, vh / 2);
      for (let e = top; e; e = e.parentElement) {
        if (e.id && named.includes(e.id)) { blocker = e.id + "@center"; break; }
      }
    }
    const b = window.__dcc && window.__dcc.state.monsters.find((m) => m.kind === "boss");
    return {
      bf: !!window.__bf, tok: window.__bfBoot, want: tok,
      loading: !!el && el.style.display !== "none" && !el.classList.contains("done"),
      dead: !!window.__dcc && window.__dcc.state.status !== "playing",
      modal: blocker || document.body.classList.contains("modal") ? (blocker || "body.modal") : null,
      bossHp: b ? b.hp : -1,
    };
  }, bootToken);
  if (!st.bf || st.tok !== st.want || st.loading) {
    throw new Error("RELOAD " + JSON.stringify(st));
  }
  // THE CAPTURE HONESTY RULE, mechanised. A run that has ended puts THE VERDICT
  // over the whole screen; every pixel of the beat is behind it. The old
  // harness had no idea and saved the panel under the beat's filename.
  if (st.dead) throw new Error("RUN ENDED — refusing to shoot " + JSON.stringify(st));
  if (st.modal) throw new Error("PLAYFIELD OBSCURED by " + st.modal + " — refusing to shoot");
  // A LIVE BEAT NEEDS A LIVE BOSS. The harness hands the crawler
  // `bonusDamage = 60 + floor*26` at the approach, and three bosses died during
  // the phase hunt in the last run — so nine of a hundred and eight frames were
  // a corpse filed as -4phase / -5punish / -6kill. A shot that claims a beat
  // the boss has to be alive for now refuses to save rather than lying.
  if (opts.bossAlive && !(st.bossHp > 0)) {
    throw new Error("BOSS IS DEAD — refusing to shoot a corpse as a live beat");
  }
}

/** Age the frozen frame by `ms` so a just-fired beat is at its peak, then shoot. */
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + "s";

/**
 * Fight until the sim emits one of `want`, in SLICES. One evaluate carrying
 * fourteen thousand sim steps is unobservable and unrecoverable — a run wedged
 * inside one for twenty minutes with an empty log is what made this necessary.
 * Slicing gives the harness a wall clock and the retry loop something to catch.
 */
async function hunt(want, maxSteps, opts, budgetMs = 240000) {
  const slice = 1200;
  const start = Date.now();
  let done = { done: "timeout", hp: 0, steps: 0 };
  for (let spent = 0; spent < maxSteps; spent += slice) {
    if (Date.now() - start > budgetMs) return { done: "stalled", hp: 0, steps: spent };
    const r = await page.evaluate(
      ([w, n, o]) => window.__bf.until(w, n, o), [want, Math.min(slice, maxSteps - spent), opts]);
    if (r.done !== "timeout") return r;
    done = r;
  }
  return done;
}
async function shoot(name, ageMs = 260, opts = {}) {
  await guard(opts);
  const path = OUT + "/" + name + ".png";
  console.log("    [" + el() + "] shooting " + name);
  await page.evaluate((ms) => {
    // Aged in slices across real frames: one big jump would run every FX
    // lifetime to its end inside a single update instead of playing it.
    let left = ms;
    const step = () => {
      if (left <= 0) return;
      window.__vt.advance(Math.min(16, left));
      left -= 16;
      requestAnimationFrame(step);
    };
    step();
  }, ageMs);
  await page.waitForTimeout(420);
  await guard(opts);
  // FREEZE THE BEAT (r3 blocker 1). Every boss beat now expires on the FRAME
  // clock, which this harness has stopped; __dcc.hold pushes every live
  // deadline out past the shutter as well, and a self-re-arming rAF keeps it
  // pushed while playwright composites (12-21s of wall time per frame). The
  // old cut re-fired the card's CSS animation and lost the race anyway.
  // Nothing here invents a beat: a beat that is not running does not start.
  const probe = await page.evaluate(() => {
    window.__dcc.hold(600);
    if (!window.__bfHold) {
      window.__bfHold = true;
      const tick = () => {
        if (window.__dcc && window.__bfHold) window.__dcc.hold(600);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    const css = (sel, prop) => {
      const e = document.querySelector(sel);
      return e ? getComputedStyle(e)[prop] : null;
    };
    const fx = window.__dcc.renderer.bossFx;
    const st = window.__dcc.state;
    const boss = st.monsters.find((m) => m.kind === "boss");
    return {
      card: css("#bossintro", "display") === "block"
        ? Number(css("#bossintro", "opacity")).toFixed(2) : "off",
      call: (document.getElementById("bc-word") || {}).textContent || "",
      callOn: css("#bosscall", "opacity"),
      marks: fx.marks ? fx.marks.size : -1,
      shells: fx.shields ? fx.shields.size : -1,
      plates: fx.plates ? fx.plates.size : -1,
      cords: fx.tethers ? fx.tethers.size : -1,
      aides: fx.aides ? fx.aides.size : -1,
      exposure: Number(fx.exposureScale || 1).toFixed(2),
      // THE CAPTURE HONESTY RULE, mechanised harder (r4). "The sim emitted a
      // telegraph" is not evidence that the frame contains it: a stale seal
      // held open by a capture hold is indistinguishable from a live beat in a
      // still. This is what is actually drawing, by silhouette, this frame.
      shapes: fx.liveShapes ? fx.liveShapes() : null,
      loot: st.loot.length,
      hp: boss ? Math.round((boss.hp / boss.maxHp) * 100) : -1,
    };
  });
  console.log("      on-screen " + JSON.stringify(probe));
  await page.screenshot({ path, timeout: 240000 });
  // DISARM THE HOLD, then FLUSH (recon fix). Two harness defects, one cause:
  //   1. `__bfHold` armed a self-re-arming rAF that was never set false, so
  //      from the first capture onward every live rig had its lifetime pinned
  //      to 600s for the rest of the boss run.
  //   2. The virtual clock advances ~0.4ms per rendered frame, so a 2.6s arena
  //      ring needs ~108 real seconds to expire on its own.
  // Together they meant the approach seal and the intro seal were STILL ON
  // SCREEN in every later frame of the fight — which is exactly how six
  // different bosses came to share one silhouette in the mask sheet. The beats
  // are the sim's; only their expiry was broken. Nothing here removes a beat
  // that is genuinely still running: the flush advances the same clock the
  // renderer already uses.
  await page.evaluate(() => { window.__bfHold = false; window.__dcc.release(); });
  console.log("    [" + el() + "] saved " + path);
  return probe;
}
/**
 * Age the frame clock so beats that ended actually stop being drawn.
 *
 * The clock the host renders on is also the clock it STEPS on, so a naive
 * flush hands the sim four seconds in which the crawler stands still and does
 * nothing — and a stationary crawler dies in about two seconds on a boss floor
 * (BOSSES-V2 §6.1). The first cut of this did exactly that and shipped six
 * IN MEMORIAM screens filed as punish captures. The crawler is therefore kept
 * on their feet across the flush, the same way bf.tick already keeps them.
 */
async function flush(ms = 4000) {
  await page.evaluate((n) => {
    window.__bfHold = false;
    let left = n;
    const step = () => {
      const st = window.__dcc.state;
      const p = st.players[0];
      if (p) { p.hp = p.maxHp; p.alive = true; p.downedT = 0; }
      if (st.status !== "playing") st.status = "playing";
      if (left <= 0) return;
      window.__vt.advance(Math.min(24, left));
      left -= 24;
      requestAnimationFrame(step);
    };
    step();
  }, ms);
  await page.waitForTimeout(Math.min(2500, ms / 24 * 16 + 200));
  // Assert the flush did not end the run — a capture taken behind THE VERDICT
  // is not a capture of a boss beat.
  const alive = await page.evaluate(() => window.__dcc.state.status === "playing");
  if (!alive) throw new Error("flush ended the run");
}

/** The signature each fight is ABOUT, where it is not simply the first fired. */
const HEADLINE = {
  sumpking: "SLUICE GATE",          // the floodgates, not the shipped surge
  marshal: "FLAME SWEEP",           // its own wall of fire, not a borrowed one
  showrunner: "SET: FLOOD",         // the set change, not the set it changed to
  greasetrap: "THE PIT PULLS",
  topiary: "ENTANGLING ROOTS",
  standards: "MOTION CARRIED",
  sponsor: "BRAND: PHYSICAL",
  permitoffice: "STOP-WORK ORDER",
  concierge: "RING FOR SERVICE",
  architect: "DEBRIS RAIN",
};

const report = [];

async function captureBoss(id, info) {
  await boot(info.seed, info.floor);
  bootToken = Date.now();
  const got = await page.evaluate((tok) => {
    window.__bfBoot = tok;
    const b = window.__dcc.state.monsters.find((m) => m.kind === "boss");
    return b ? b.bossId : null;
  }, bootToken);
  if (got !== id) throw new Error("drew " + got + ", wanted " + id);
  await page.evaluate(DRIVER);
  await page.evaluate(DRIVER2);
  const row = { id, name: info.name, beats: {} };

  // 1) APPROACH. The boss exists, has not been met, the bed has ducked to a
  //    drone, and the camera has NOT yet taken the encounter framing.
  await page.evaluate(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    const b = window.__bf.boss();
    b.introduced = false;
    st.encounter = null;
    // A fully-kitted crawler: this is a boss capture, not a difficulty test,
    // and every band has to reach its own kill beat inside one run.
    p.bonusDamage = Math.max(p.bonusDamage || 0, 60 + st.floor * 26);
    p.hp = p.maxHp;
    p.pos.x = b.pos.x + 9.5; p.pos.y = b.pos.y + 9.5;
    p.facing.x = -0.7; p.facing.y = -0.7;
  });
  await shoot(id + "-1approach", 500);
  row.beats.approach = true;

  // 2) INTRO. Walk in and let the SIM raise its own encounter. The ringside
  //    freeze holds by itself here: the clock is frozen, so timeLeft only ever
  //    ticks on a step we choose to take.
  console.log("  [" + el() + "] walking in...");
  // Chunked, with a wall clock. A single evaluate that runs the whole walk-in
  // has no way to report progress and no way to fail: one run wedged inside it
  // for twenty minutes with nothing in the log. Chunking makes a stall visible
  // AND recoverable (the retry loop can start the boss over).
  let intro = { ok: false };
  const introStart = Date.now();
  for (let chunk = 0; chunk < 12 && !intro.ok; chunk++) {
    if (Date.now() - introStart > 120000) throw new Error("intro walk-in stalled");
    if (chunk === 4) {
      // Some arenas cannot be walked into from the corridor the approach shot
      // was staged in (the Grease Trap is a FIXTURE behind its own cover, and
      // the crawler simply grinds on a blocker). Close the distance by hand and
      // let the SIM raise the encounter itself — the reveal is still the sim's,
      // only the walk is the harness's.
      await page.evaluate(() => {
        const st = window.__dcc.state;
        const p = st.players[0];
        const b = window.__bf.boss();
        p.pos.x = b.pos.x + 4.2; p.pos.y = b.pos.y + 4.2;
      });
    }
    intro = await page.evaluate(() => {
      const st = window.__dcc.state;
      for (let i = 0; i < 100; i++) {
        window.__bf.tick(i, { reach: 3.0 });
        if (st.encounter) {
        // The reveal is a beat: the arena lift, the mote column and the
        // contracting seal ring all ride the sim's own `intro` record, so
        // stage the frame it landed on.
          for (const e of (st.bossEvents || [])) window.__dcc.bossBeat(e);
          return { ok: true, name: st.encounter.name, i };
        }
      }
      return { ok: false };
    });
  }
  console.log("  intro: " + JSON.stringify(intro));
  // The card lives on the SIM's own ringside clock now (encounter.timeLeft),
  // which this harness has frozen, and shoot() holds every deadline across the
  // shutter. There is no animation to restart and no race left to lose.
  const introShot = await shoot(id + "-2intro", 420);
  row.beats.intro = intro.ok;
  row.card = introShot.card;

  // Let the ringside freeze run out on its own, then the fight is live.
  await page.evaluate(() => {
    const st = window.__dcc.state;
    for (let i = 0; i < 400 && st.encounter; i++) window.__bf.tick(i, {});
  });

  // 3) THE FIGHT. Captured on the frame the boss commits ITS OWN named
  //    signature — whatever that boss's kit actually emits, never a label the
  //    harness picked.
  // THE FIGHT BEAT photographs the verb this boss is ABOUT. Several bosses
  // commit more than one named signature (a band signature plus their own kit's),
  // and "whatever fired first" is not the same thing as "what this fight is" —
  // the Sump King opens on the shipped FLOOD SURGE, but the beat worth a frame
  // is the SLUICE, because the gates are its whole ask. Where the two differ,
  // this names which one. Everything else takes the first named signature it
  // commits, and the fallback below means the shot is never faked.
  // THE COUNCIL FORMAT (r3 major). The Zoning Board is one body plus tethered
  // aides, and its fight capture had no cords in it at all. The aides are the
  // sim's; this only refuses to photograph the fight AFTER the crawler has
  // cleared the board, because a cleared board is not the fight.
  if (["zoningboard", "standards", "concierge", "greasetrap"].includes(id)) {
    await page.evaluate(() => {
      const st = window.__dcc.state;
      const b = window.__bf.boss();
      for (const a of st.monsters) if (a.tetherId === b.id && a.hp > 0) a.hp = a.maxHp;
    });
  }
  await flush();
  let tele = HEADLINE[id]
    ? await hunt(["telegraph"], 3600, { label: true, prefer: HEADLINE[id], holdHp: true, floorHp: 0.5 })
    : { done: "timeout" };
  // Waiting for a NAMED verb must never be what ends the fight — the Grease
  // Trap died mid-wait in one run and took its whole beat chain with it, so
  // the health is pinned while the harness waits, exactly as for the punish.
  if (tele.done !== "event") {
    tele = await hunt(["telegraph"], 2400, { label: true, holdHp: true, floorHp: 0.5 });
  }
  console.log("  fight: " + JSON.stringify(tele));
  await shoot(id + "-3fight", 300, { bossAlive: true });
  row.beats.fight = tele.done === "event" ? tele.label : tele.done;
  row.fightHp = tele.hp;

  // 4) THE PHASE EDGE + the intermission that re-deals the board. Reached by
  //    fighting: whichever trigger this boss owns (a health gate, or the
  //    mechanic edge its own kit fires) lands first, and the plate is at a
  //    real value when it does.
  await flush();
  // NO holdHp: the intermission is HP-gated, so pinning the health means the
  // gate never comes and the segment times out (measured: 4 of 6). The risk is
  // the opposite one — a fully-kitted crawler killing the boss during the wait
  // and the harness shooting the CORPSE under a `-4phase` filename, which is
  // what produced three frames of one dead Topiary Warden filed as phase,
  // punish and kill. `row.beats.phase` records which happened; read it before
  // believing the frame.
  // 0.30 sits just under the 1/3 gate, so both HP phases still land and the
  // boss cannot die inside the hunt (see bf.until's floorHp).
  const phase = await hunt(["intermission"], 9000, { floorHp: 0.30 });
  console.log("  phase: " + JSON.stringify(phase));
  await shoot(id + "-4phase", 240, { bossAlive: true });
  row.beats.phase = phase.done;
  row.phaseHp = phase.hp;

  // 5) THE PUNISH WINDOW. It arrives on the boss's own count of committed
  //    signatures, not on its health, so the segment PINS the health while it
  //    waits — otherwise a well-armed crawler ends the fight before the boss's
  //    count comes round, which is how the previous round lost this beat.
  await flush();
  const punish = await hunt(["punish"], 9000, { holdHp: true, floorHp: 0.30 });
  console.log("  punish: " + JSON.stringify(punish));
  // Aged into the MIDDLE of the window: the reticle opens wide and CLOSES on
  // the core, so a frame from its first instant shows the brackets at their
  // widest, which is where they read least.
  const punishShot = await shoot(id + "-5punish", 620, { bossAlive: true });
  row.marks = punishShot.marks;
  row.beats.punish = punish.done;
  row.punishHp = punish.hp;

  // 6) THE KILL. Fight it to zero. Nothing is pushed: the DEFEATED beat, the
  //    corpse, the sigil and the ringside loot arc are all the sim's.
  await page.evaluate(() => {
    const p = window.__dcc.state.players[0];
    // Finish the segment inside the capture budget — the fight's arc up to
    // here is already on record in the previous four frames.
    p.bonusDamage = (p.bonusDamage || 0) * 3 + 400;
  });
  await flush();
  const killed = await hunt(["__never__"], 14000, {}); // runs to "dead"
  const kill = await page.evaluate((d) => {
    const st = window.__dcc.state;
    const b = st.monsters.find((m) => m.kind === "boss");
    return { done: d, bossHp: b ? b.hp : -1, loot: st.loot.length };
  }, killed.done);
  console.log("  kill: " + JSON.stringify(kill));
  // A moment of the aftermath so the corpse settles, the drops LAND, and the
  // ringside arcs fly out to them. 24 frames was 0.4 sim-seconds — barely
  // enough for the loot to exist, let alone to throw an arc at it.
  await page.evaluate(() => window.__bf.idle(70));
  if (kill.done !== "dead" || kill.bossHp > 0) {
    throw new Error("KILL BEAT NOT REACHED (" + kill.done + ", hp " + kill.bossHp + ")");
  }
  const killShot = await shoot(id + "-6kill", 420);
  row.killShells = killShot.shells;
  row.killPlates = killShot.plates;
  row.killLoot = killShot.loot;
  row.beats.kill = kill.done === "dead" && kill.bossHp <= 0;
  row.killHp = kill.bossHp;
  row.loot = kill.loot;

  row.events = [...new Set(await page.evaluate(() => window.__bf.log.slice(0, 600)))];
  return row;
}

for (const [id, info] of roster) {
  console.log("\n=== " + info.name + " (" + id + ") — floor " + info.floor + ", seed " + info.seed + " ===");
  let row = null;
  for (let attempt = 1; attempt <= 3 && !row; attempt++) {
    try {
      row = await captureBoss(id, info);
    } catch (e) {
      console.error("  attempt " + attempt + " failed: " + String(e.message).split("\n")[0]);
      await page.waitForTimeout(2500);
    }
  }
  if (row) report.push(row);
  else report.push({ id, name: info.name, beats: { failed: true }, events: [] });
}

await browser.close();
console.log("\n==== BEAT REPORT ====");
for (const r of report) {
  console.log(`${r.id.padEnd(15)} card=${String(r.card).padEnd(5)} ` +
    `marks=${r.marks} killShell=${r.killShells} killLoot=${r.killLoot}`);
  console.log(`${r.id.padEnd(15)} fight=${String(r.beats.fight).padEnd(22)} ` +
    `phase=${String(r.beats.phase).padEnd(9)} punish=${String(r.beats.punish).padEnd(9)} ` +
    `kill=${r.beats.kill} loot=${r.loot} | hp ` +
    `${(r.fightHp ?? 0).toFixed(2)} -> ${(r.phaseHp ?? 0).toFixed(2)} -> ` +
    `${(r.punishHp ?? 0).toFixed(2)} -> 0`);
  console.log("                 " + (r.events || []).join(", "));
}
