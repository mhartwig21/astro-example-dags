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
import { mkdirSync, rmSync } from "node:fs";

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
// SEED override. The plan below picks the FIRST seed that draws each boss,
// which pins every capture to one arena + one mutator roll — fine for "does
// this boss have a beat", useless for "does the SAME boss differ across runs".
// --seed=N forces the run seed (use with --only= and a seed you have checked
// actually draws that boss), and --tag=x suffixes the filenames so two runs of
// the same boss do not overwrite each other.
const SEED = Number(flag("seed", "0")) || 0;
const TAG = flag("tag", "") || "";
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
// Every boss's own word for its punish window, straight off the shipping table.
// The harness needs it to ASSERT the -5punish frame contains that boss's beat
// (r7 blocker: `wantBeat` was passed on exactly one of six captures).
const PUNISH_CORE = await page.evaluate(async () => {
  const m = await import("/src/sim/bosses.ts");
  const out = {};
  for (const [id, rule] of Object.entries(m.BOSS_PUNISH)) out[id] = rule.core;
  return out;
});
const roster = Object.entries(plan).filter((e) => ONLY.length === 0 || ONLY.includes(e[0]));
if (SEED) for (const [, info] of roster) info.seed = SEED;
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
  // The crawler is kept on their feet across the aftermath for exactly the
  // reason bf.tick and flush() already do it: a stationary crawler dies in
  // about two seconds on a boss floor (BOSSES-V2 6.1), and on floors 9+ the
  // surviving trash killed the crawler DURING the 70-step settle — so the
  // kill beat was lost behind THE VERDICT three attempts running (topiary,
  // this run). Nothing here revives the BOSS or invents a drop: the corpse,
  // the sigil and the ringside arc are all still the sim's.
  bf.idle = function (n) {
    for (var i = 0; i < n; i++) {
      var st = window.__dcc.state;
      var p = st.players[0];
      if (p) { p.hp = p.maxHp; p.alive = true; p.downedT = 0; }
      if (st.status !== "playing") st.status = "playing";
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
    // LAID OUT AND ON SCREEN, but deliberately NOT opacity-gated: the beat
    // line's entrance keyframe starts at opacity 0, and a getComputedStyle
    // taken while that 0.32s animation is at 0% reports 0 for a line that is
    // about to be perfectly visible. Rects catch the only thing that matters
    // here — an element inside a display:none panel has none.
    const txt = (id) => {
      const e = document.getElementById(id);
      if (!e || e.getClientRects().length === 0) return "";
      return (e.textContent || "").trim();
    };
    return {
      bf: !!window.__bf, tok: window.__bfBoot, want: tok,
      loading: !!el && el.style.display !== "none" && !el.classList.contains("done"),
      dead: !!window.__dcc && window.__dcc.state.status !== "playing",
      modal: blocker || document.body.classList.contains("modal") ? (blocker || "body.modal") : null,
      bossHp: b ? b.hp : -1,
      // THE CAPTURE HONESTY RULE, MECHANISED THIRD (r6). What the SCREEN says
      // this beat is — the plate's live line and the call-out layer, read at
      // the moment the shutter opens. `wantBeat` below asserts the frame
      // contains the beat its filename claims, which is the check that would
      // have caught `permitoffice-3fight` (filed as STOP-WORK ORDER, pixels
      // reading THE COMMERCIAL BREAK / YOU DID THAT) and
      // `zoningboard-3fight` (filed as SETBACK REQUIRED, same intermission).
      beat: txt("bb-beat"),
      callWord: txt("bc-word"),
      callSub: txt("bc-sub"),
      // ...and the two surfaces that carry a beat's name OUTSIDE the plate and
      // the call-out (r7): the ringside NAME CARD owns the intro beat, and the
      // plate's own title is what a fight/phase/punish frame is a frame OF.
      card: txt("bi-name"),
      plateName: txt("bb-name"),
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
  // ...AND THE FRAME MUST CONTAIN THE BEAT ITS FILENAME CLAIMS (r6 major).
  //
  // `permitoffice-3fight.png` was filed as STOP-WORK ORDER and its pixels read
  // THE COMMERCIAL BREAK / THE BOARD IS BEING RE-DEALT / YOU DID THAT;
  // `zoningboard-3fight.png` was filed as SETBACK REQUIRED and showed the same
  // intermission. In both cases the SIM had emitted the claimed telegraph — the
  // hunt was honest — and then an intermission crossed in the frames between
  // the hunt returning and the shutter opening, and took the HUD with it. A
  // capture is evidence about a FRAME, not about a step, so the guard reads
  // the screen: the plate's live beat line or the call-out has to still be the
  // beat being claimed.
  if (opts.wantBeat) {
    const want = String(opts.wantBeat).toUpperCase();
    const on = `${st.beat} | ${st.callWord} | ${st.callSub} | ${st.card} | ${st.plateName}`
      .toUpperCase();
    if (!on.includes(want)) {
      throw new Error(
        `BEAT MISMATCH — claims "${want}", screen reads "${st.beat}" / "${st.callWord}"` +
        ` / card "${st.card}"`);
    }
  }
  return st;
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
  // THE BEAT IS ASSERTED ON THE FRAME THAT WILL BE SHOT, NOT BEFORE IT (r7).
  // This first guard runs BEFORE the frame is aged, and several beats do not
  // exist yet at that instant — the ringside card is aged into over 420ms, and
  // the punish window is aged 620ms into its own span. Asserting here filed
  // `topiary-2intro` as a MISS for a card that was perfectly present in the
  // saved pixels. So this pass checks only what is true whenever it runs (the
  // page is alive, the run has not ended, nothing is covering the playfield)
  // and the assertion moves to the post-ageing pass below.
  await guard({ ...opts, wantBeat: undefined });
  const path = OUT + "/" + name + TAG + ".png";
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
  // THE AGEING NEEDS WALL TIME TO HAPPEN IN (r5). The stepper above advances
  // the virtual clock 16ms per PRESENTED frame, so a 1,600ms age needs ~100
  // real frames — and this used to wait a flat 420ms, i.e. ~25 frames on the
  // GPU path. Every ageMs above ~400 was silently truncated, which is why the
  // approach's own camera move was a third applied in every capture and why
  // the kill frame's topple had not started. One frame of slack per step.
  await page.waitForTimeout(Math.min(20000, Math.max(420, (ageMs / 16) * 18 + 250)));
  const before = await guard(opts);
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
  // ---- THE PROBE IS RE-READ AFTER THE SHUTTER (r6 blocker) -----------------
  //
  // `rentcollector-6kill.png`'s probe reported `call:"THE RENT COLLECTOR",
  // callOn:"1"` and the band of pixels it names contains nothing — the probe
  // described a moment that was true when it ran and false by the time the
  // compositor got there (a screenshot costs 3-20 seconds of wall time, and
  // the HUD's own deadlines are not frozen by the virtual clock the way the
  // renderer's rigs are). A probe taken only BEFORE the shutter is a claim
  // about a frame nobody saved. This one brackets it, and any disagreement is
  // printed loudly rather than silently filed as evidence.
  const after = await page.evaluate(() => {
    const css = (sel, prop) => {
      const e = document.querySelector(sel);
      return e ? getComputedStyle(e)[prop] : null;
    };
    const fx = window.__dcc.renderer.bossFx;
    return {
      call: (document.getElementById("bc-word") || {}).textContent || "",
      callOn: css("#bosscall", "opacity"),
      beat: (document.getElementById("bb-beat") || {}).textContent || "",
      card: css("#bossintro", "display") === "block"
        ? Number(css("#bossintro", "opacity")).toFixed(2) : "off",
      // The two extra name surfaces the beat assertion reads (r7), re-read
      // AFTER the shutter so a drifted frame can be re-checked against them.
      name: (document.getElementById("bi-name") || {}).textContent || "",
      plateName: (document.getElementById("bb-name") || {}).textContent || "",
      shapes: fx.liveShapes ? fx.liveShapes() : null,
    };
  });
  const drifted = after.call !== probe.call || after.callOn !== probe.callOn ||
    JSON.stringify(after.shapes) !== JSON.stringify(probe.shapes);
  if (drifted) {
    console.log("      !! DRIFT ACROSS THE SHUTTER — the saved frame is the AFTER column");
    console.log("      after     " + JSON.stringify(after));
  }
  probe.after = after;
  probe.drifted = drifted;
  // ---- AND THE AFTER COLUMN IS WHAT WAS SAVED (r7 blocker) -----------------
  //
  // "Print-and-keep is not honest enough." DRIFT fired five times in the last
  // run and every drifted frame was still filed under the beat's clean name:
  // `rentcollector-3fight.png` is labelled LATE FEE and its saved pixels are
  // the OVERDRAWN punish tell. A loud log line beside a correctly-named file
  // is not a correction — the file outlives the log, and the file is the
  // evidence. So the assertion is re-run against the AFTER column, which is
  // the frame that actually reached the compositor, and a frame whose claimed
  // beat is no longer on screen is REJECTED. The caller re-hunts; if it will
  // genuinely not hold still, it is filed under `-MISSED`.
  if (opts.wantBeat && drifted) {
    const want = String(opts.wantBeat).toUpperCase();
    const on = `${after.beat} | ${after.call} | ${after.name} | ${after.plateName}`
      .toUpperCase();
    if (!on.includes(want)) {
      probe.lost = `DRIFTED OFF BEAT — claims "${want}", saved frame reads ` +
        `"${after.beat}" / "${after.call}"`;
    }
  }
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
  // A REJECTED FRAME DOES NOT STAY ON DISK (r7). The screenshot is written
  // before the after-shutter assertion can run, so a frame that drifted off its
  // beat was being left behind under the CLEAN filename while the retry saved
  // the honest one beside it — the exact "a frame that does not visibly contain
  // the beat it claims is not evidence" failure, reintroduced by the fix for
  // it. The file goes with the verdict.
  if (probe.lost) {
    try { rmSync(path); } catch { /* never written */ }
    console.log("    [" + el() + "] DISCARDED " + path);
    throw new Error("BEAT MISMATCH — " + probe.lost);
  }
  console.log("    [" + el() + "] saved " + path);
  return probe;
}

/**
 * THE CAPTURE HONESTY RULE, MECHANISED FOR ALL SIX BEATS (r7 blocker).
 *
 * Shipped, `wantBeat` was passed on exactly one of the six captures, and only
 * when the hunt had returned `done === "event"` — so a TIMED-OUT hunt saved
 * under the clean `-3fight` name with no assertion at all, and `-1approach`,
 * `-2intro`, `-4phase`, `-5punish` and `-6kill` were never asserted in the
 * first place. Both defects shipped dishonest frames in the last run:
 * `concierge-3fight.png` is a hunt that timed out after two BEAT MISMATCHes
 * and whose own probe reads `call:"UNLOAD"` — a PUNISH frame filed as the
 * fight beat — and `topiary-4phase.png` is `phase:{done:"timeout"}` with no
 * wipe and no call-out in the probe: there is no intermission in the frame
 * filed as the phase beat.
 *
 * Every beat now names what its pixels must contain, a hunt that did not land
 * its event is a MISS whatever the frame looks like, and a frame that cannot
 * be made to contain its beat is filed under `-MISSED` rather than under the
 * name of a beat it does not have.
 */
async function shootBeat(name, ageMs, opts, rehunt) {
  const attempts = rehunt ? 3 : 1;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await flush(1200);
      const again = await rehunt(i);
      console.log("  " + name + " (retry " + i + "): " + JSON.stringify(again));
      if (again && again.done !== "event") {
        // The beat did not happen. Say so; do not photograph something else.
        lastErr = new Error("BEAT NEVER FIRED (" + again.done + ")");
        continue;
      }
    }
    try {
      return { shot: await shoot(name, ageMs, opts), missed: false };
    } catch (e) {
      if (!String(e.message).startsWith("BEAT MISMATCH")) throw e;
      console.error("  " + e.message);
      lastErr = e;
    }
  }
  void lastErr;
  // Honest filename, no assertion on the beat (there is nothing to assert):
  // the frame is filed as a MISS so nothing downstream can read it as evidence.
  const shot = await shoot(name + "-MISSED", ageMs, { bossAlive: opts.bossAlive });
  return { shot, missed: true };
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
// r5: one row for EVERY boss. Without them "whatever fired first" is often the
// PUNISH TELL — every boss has one, it comes round on its own clock, and it
// already gets its own frame at -5punish. A -3fight frame showing the punish
// telegraph is a frame of the wrong beat, which is what made the last round
// score The Safety Officer as "no fight of its own" when it has a lattice.
const HEADLINE = {
  concierge: "RING FOR SERVICE",
  rentcollector: "LATE FEE",
  temp: "OVERREACH",
  sumpking: "SLUICE GATE",          // the floodgates, not the shipped surge
  inspector: "CITATION",
  greasetrap: "THE PIT PULLS",
  topiary: "HEDGE REGROWTH",        // its OWN verb, not the band's roots
  zoningboard: "SETBACK REQUIRED",
  pollinator: "BLOOM",
  architect: "DEBRIS RAIN",
  permitoffice: "STOP-WORK ORDER",
  foundation: "FISSURE",
  marshal: "FLAME SWEEP",           // its own wall of fire, not a borrowed one
  linesupervisor: "PRODUCTION QUOTA",
  safetyofficer: "COMPLIANCE LATTICE",
  showrunner: "CAMERA MOVE",        // the beat on the clock, not the phase edge
  standards: "MOTION CARRIED",
  sponsor: "CROSS-PROMOTION",
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
  // Aged past the approach's own framing move (r5): the anchor slides half
  // the way to the boss and the shot widens a step, and at 500ms of a frozen
  // clock the camera was still in the corridor when the shutter opened.
  await shoot(id + "-1approach", 1600);
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
  // The intro frame's whole job is the NAME CARD, so it asserts the name (r7).
  const introBeat = await shootBeat(id + "-2intro", 420, { wantBeat: info.name });
  const introShot = introBeat.shot;
  row.beats.intro = intro.ok && !introBeat.missed;
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
  // ...and the frame has to still BE that beat when the shutter opens.
  //
  // A MISMATCH RE-HUNTS; IT DOES NOT ABANDON THE BOSS (r6). The Sump King's
  // SLUICE GATE and the punish tell come round within a beat of each other, so
  // the beat-assertion fired on all three attempts and cost the run every
  // sumpking frame — the honesty rule working correctly and the harness
  // handling it badly. The hunt is cheap; re-hunt the headline and try again,
  // and only if it will genuinely not hold still does the frame get filed
  // under its own honest name (`-3fight-MISSED`) so nothing is mis-labelled.
  // A TIMED-OUT HUNT IS A MISS (r7 blocker). Shipped, `wantBeat` was only
  // passed when `tele.done === "event"` — so a hunt that never found the boss's
  // named verb saved under the clean `-3fight` name with NO assertion, which is
  // how `concierge-3fight.png` (probe: `call:"UNLOAD"`, shapes cords+reticle+
  // shaft) came to be filed as the fight beat while showing the punish window.
  const fightWant = tele.done === "event" ? tele.label : " never";
  const fight = await shootBeat(id + "-3fight", 220,
    { bossAlive: true, wantBeat: fightWant },
    async () => (HEADLINE[id]
      ? hunt(["telegraph"], 2400, { label: true, prefer: HEADLINE[id], holdHp: true, floorHp: 0.5 })
      : hunt(["telegraph"], 2400, { label: true, holdHp: true, floorHp: 0.5 })));
  row.beats.fight = fight.missed
    ? "MISSED:" + (tele.label || tele.done)
    : (tele.done === "event" ? tele.label : tele.done);
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
  // THE PHASE FRAME MUST CONTAIN THE INTERMISSION (r7 blocker). `topiary-4phase
  // .png` was `phase:{done:"timeout"}` with `shapes:{shell:1}` and no call-out
  // — no intermission anywhere in the frame filed as the phase beat — and
  // sumpking/permitoffice/standards filed the PUNISH rig under this name.
  const phaseShot = await shootBeat(id + "-4phase", 240,
    { bossAlive: true, wantBeat: phase.done === "event" ? "COMMERCIAL BREAK" : " never" },
    async () => hunt(["intermission"], 4000, { floorHp: 0.30 }));
  row.beats.phase = phaseShot.missed ? "MISSED:" + phase.done : phase.done;
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
  // ...and it must contain THIS BOSS'S window, by its own name (r7 blocker):
  // `#bc-word` now carries `BOSS_PUNISH[id].core`, so the assertion is per-boss
  // rather than "something said UNLOAD".
  const punishBeat = await shootBeat(id + "-5punish", 620,
    {
      bossAlive: true,
      wantBeat: punish.done === "event" ? (PUNISH_CORE[id] || "UNLOAD") : " never",
    },
    async () => hunt(["punish"], 4000, { holdHp: true, floorHp: 0.30 }));
  row.marks = punishBeat.shot.marks;
  row.beats.punish = punishBeat.missed ? "MISSED:" + punish.done : punish.done;
  row.punishHp = punish.hp;

  // 6) THE KILL. Fight it to zero. Nothing is pushed: the DEFEATED beat, the
  //    corpse, the sigil and the ringside loot arc are all the sim's.
  await page.evaluate(() => {
    const st = window.__dcc.state;
    const p = st.players[0];
    // Finish the segment inside the capture budget — the fight's arc up to
    // here is already on record in the previous four frames.
    //
    // SCALED TO THE POOL IN FRONT OF IT (r7 blocker). A flat `x3 + 400` is a
    // floor-3 number: The Standards and Practices Board timed out at 24,105 HP
    // on all three attempts in the last run, so one of the three FINALES has no
    // `-6kill.png` at all. The budget is ~14,000 sim steps of a driver that
    // lands maybe a third of its swings, so the damage has to be a function of
    // what is left rather than of what the previous segment needed. This
    // changes only how the HARNESS fights — the DEFEATED beat, the corpse, the
    // sigil and the ringside arcs are all still the sim's.
    const b = st.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    const want = b ? b.hp / 90 : 0; // ~90 landed hits to zero, whatever the pool
    p.bonusDamage = Math.max((p.bonusDamage || 0) * 3 + 400, want);
    // ...and the aides that shield a COUNCIL body are part of the pool. The
    // Board's five are the fight (kill order IS the fight) and they have been
    // photographed at -3fight; the kill segment is allowed to finish.
    for (const a of st.monsters) {
      if (b && a.tetherId === b.id && a.hp > 0) a.hp = Math.min(a.hp, a.maxHp * 0.25);
    }
  });
  await flush();
  // `reach: 1.6` — the driver strafes at 2.6 tiles, which is outside melee
  // range on the big finale rigs, so a boss whose shield taxes everything
  // except a landed swing (The Sponsor) took ~300 damage in 230 sim-seconds
  // while the real bot kills the same boss in 103s. The kill segment closes
  // properly. It changes how the harness FIGHTS, never what the boss does.
  const killed = await hunt(["__never__"], 14000, { reach: 1.6 }); // runs to "dead"
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
  // AGED PAST THE TOPPLE (r5 blocker, the harness half). The boss's death is
  // staged on the RENDER clock — the topple runs over 0.75s and the dissolve
  // starts at 0.12s and takes 1.5s — and this harness advances that clock by
  // ~0.4ms per presented frame. At 420ms the shutter opened 0.4 seconds into a
  // 2-second beat, which is most of why every kill capture in the last round
  // showed a live mesh standing upright: the corpse had not had time to fall.
  // 1800ms puts the frame at the moment the body is DOWN and burning.
  // ...and the KILL frame must contain the kill card, which names the boss
  // (r7 blocker: `-6kill` never took an assertion either, and the card lands on
  // its own clock).
  const killBeat = await shootBeat(id + "-6kill", 1800, { wantBeat: info.name });
  const killShot = killBeat.shot;
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
