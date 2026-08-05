#!/usr/bin/env node
// mk-audition.mjs — builds _r2_sheets/audition.html, the one page the owner
// opens to judge audio r2 by ear (SOUNDPLAN §9 is the prose version; this is
// the version with the sounds actually in it).
//
// SELF-CONTAINED BY CONSTRUCTION. The page is published behind a CSP that
// blocks every external host, so every ogg and every spectrogram is inlined as
// a base64 data: URI, both bundled fonts are inlined as @font-face data: URIs,
// and all CSS/JS is inline. Every run re-reads the file it just wrote and EXITS
// NONZERO if any src/href/url() points anywhere but `data:`, if an <audio>
// element lacks one, or if the page exceeds the 16MB artifact ceiling — the
// self-containment claim is asserted against the built bytes, not promised.
//
// Inputs, all committed receipts from tools/audio/contactsheet.mjs:
//   _r2_sheets/casts/descriptors.json   the 13 cast measurements + spectrograms
//   _r2_sheets/ref/descriptors.json     the 9 shipped house sounds to A/B against
//   _r2_sheets/negref/descriptors.json  level_up (the owner's second verdict)
// Display names and roles come from src/sim/abilities.ts ABILITY_INFO — the
// ROSTER, not the director's mappings. Walking the director's mappings instead
// of the roster is the bug this whole round exists to close (§1.4 row E-21), so
// this sheet is generated from the roster and fails loud if an id is missing.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SHEETS = join(HERE, "_r2_sheets");
const OUT = join(SHEETS, "audition.html");

// ---------------------------------------------------------------- inputs --
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const b64 = (p) => readFileSync(p).toString("base64");
const dataUri = (p, mime) => `data:${mime};base64,${b64(p)}`;

const castsDesc = readJson(join(SHEETS, "casts", "descriptors.json"));
const refDesc = readJson(join(SHEETS, "ref", "descriptors.json"));
const negrefDesc = readJson(join(SHEETS, "negref", "descriptors.json"));

const byId = (desc) => Object.fromEntries(desc.clips.map((c) => [c.id, c]));
const CASTS = byId(castsDesc);
const REFS = byId(refDesc);
const NEGREF = byId(negrefDesc);

/** ABILITY_INFO name + role, parsed from the roster itself. */
function readRoster() {
  const src = readFileSync(join(REPO, "src", "sim", "abilities.ts"), "utf8");
  const block = src.slice(src.indexOf("export const ABILITY_INFO"));
  const out = {};
  const re = /^\s{2}(\w+):\s*\{\s*name:\s*"([^"]+)"[\s\S]*?tier:\s*"(\w+)",\s*role:\s*"(\w+)"/gm;
  let m;
  while ((m = re.exec(block))) out[m[1]] = { name: m[2], tier: m[3], role: m[4] };
  return out;
}
const ROSTER = readRoster();

/** manifest volume per clip id — the multiplier between the FILE and the MIX. */
function readVolumes() {
  const src = readFileSync(join(REPO, "src", "audio", "manifest.ts"), "utf8");
  const out = {};
  const re = /^\s{2}(\w+):\s*\{\s*url:\s*"[^"]+"[^}]*?\}/gm;
  let m;
  while ((m = re.exec(src))) {
    const vol = /volume:\s*([\d.]+)/.exec(m[0]);
    const thr = /throttleMs:\s*(\d+)/.exec(m[0]);
    out[m[1]] = { volume: vol ? +vol[1] : 1, throttleMs: thr ? +thr[1] : 0 };
  }
  return out;
}
const VOL = readVolumes();

// ------------------------------------------------------------- the briefs --
// One line of INTENT per cue, lifted from the sonic brief in gen-sfx-casts.mjs
// (the comment above each render IS the brief), and one WRONG line per cue in
// the §6-§8 house style: what a failure sounds like, so a verdict is actionable.
const BRIEF = {
  cast_dash: {
    intent: "The body leaves. Air displaced at the front, the mass falling away behind it — energy at the start, gone in 0.2s, almost no tail on purpose.",
    wrong: "Anything swishy. Anything cute. A cartoon whoosh with a thump in it, or a cue you have stopped noticing by floor 3. The clip you rejected is the last row of THE HOUSE VOICE below — if this one lands anywhere near it, it failed.",
  },
  cast_crowdsurf: {
    intent: "A winch paying out. Chain-link grains thinning as the line travels, ending in ONE load-bearing clank as it goes taut.",
    wrong: "No clank, or a clank at the front — then it is rattle with no verdict, and it stops being a thing that MOVES. It must not blur into Stage Cables: same steel, opposite gesture.",
  },
  cast_overcharge: {
    intent: "A breaker thrown. Relay clack, then a capacitor whine up a fifth that CUTS OFF DEAD at the top — the power is banked, so the sound stops instead of resolving.",
    wrong: "The whine resolves, fades, or discharges outward — that is Bolt's job, and it would say Breaker already spent. On the spend (same file, pitched up, pulled back) wrong = it reads as a different ability instead of the same one paying out.",
  },
  cast_cables: {
    intent: "Two stage pins fired into the deck 30ms apart — pneumatic, dull, no ring — and a cable tensioning UP into a taut hum that sings.",
    wrong: "It rumbles instead of sings, or the hum outlives the field it stands for. Cables PLANT where Extradition TRAVELS; if you cannot tell which of the two you pressed, say which one moved.",
  },
  cast_airstrike: {
    intent: "The call goes in. A hard key-up transient, telephone-narrow comms body, two clipped syllables, a descending whistle handing off to shells that already sound.",
    wrong: "A melody. A jingle. Anything a sponsor would licence — the house line is dry menace, never a laugh track. Also wrong if it reads as an ordinary ability instead of an event.",
  },
  cast_bullettime: {
    intent: "The projector jams at t=0, then the room exhales behind it — pitch-smeared downward, fluttering. Everything under 700Hz on purpose, so it survives the master low-pass that closes on the same frame.",
    wrong: "The sound still feels LATE against the screen (the grade snaps in one frame), or the tail outlasts the effect. Any whoosh at all means it is still wearing the dash it used to borrow.",
  },
  cast_injunction: {
    intent: "The gavel, swallowed. A hard front with no reverb of its own, inhaled by a reverse swell over a low institutional tone — ending on a faint tick that STOPS on the beat a third tick would land on.",
    wrong: "It just sounds like the file got cut off. Or it reads like a boss dying rather than a ruling being handed down — this is the loudest cast in the game and it still has to stay under a kill.",
  },
  cast_cataclysm: {
    intent: "The floor gives. A sub-drop to ~40Hz under a long stone tear, settling into debris that carries the reverb of a much bigger room than the one you are standing in.",
    wrong: "Bright, gold, outward, airy — that is Collapse's voice, and Fault Line is downward and geological. Second failure, on the other axis: it vanishes entirely on a laptop (it is a sub-drop; it is meant to lose weight there, not disappear).",
  },
  cast_stance: {
    intent: "A selector detent. One damped hardwood-on-steel chock and nothing after it — the shortest and quietest cue in the game, because a Flow build presses this every 1.8s.",
    wrong: "Two failures, opposite directions, and this is the bet: you still NOTICE it after a minute of a Flow build, or you cannot tell your stance changed at all. Say which side it falls on.",
  },
  cast_cutto: {
    intent: "Two transients with a hole between them. A compressed-air thup as the body leaves, ~90ms of near-silence where you were, then a hard knife-edge tick at the ARRIVAL.",
    wrong: "One continuous sound — then it is a dash, and a teleport with no arrival is a lie about what happened. The hole is the whole point; if you cannot hear it, it closed.",
  },
  cast_orbit: {
    intent: "The ring un-ships. Inharmonic blade partials at 1.6–2.2kHz sliding down together as they leave the body, over a fine grind — pitched and RECEDING where the swing is broadband and arriving.",
    wrong: "A flat band of hiss held at one level (no gesture), or a sound that arrives instead of departing. It is also the brightest cue in the family — wrong if it sits on top of the mix instead of inside it.",
  },
  cast_bulwark: {
    intent: "A plate planted, and then the dome. Steel-and-oak thunk with its ring damped at once, and a hollow shell that swells under it and HOLDS for the length of the clip.",
    wrong: "It lands like a death — a low thump with a wash on it. A brace that sits in the acoustic slot the game uses for a kill is the failure this render was rebuilt to fix; if something sounds like it died when you braced, that is the one.",
  },
  cast_stuntdouble: {
    intent: "The professional clocks in. A dry film-slate clack, broadcast, no room — then a DOUBLED body-weight thud landing ~190ms behind it as the stand-in arrives.",
    wrong: "One event instead of two. Or any bell or chime anywhere in it — that is `equip`, the clip it used to borrow, and it reads as picking something up rather than someone showing up.",
  },
};

// Reference clips: what each one is the reference FOR.
const REFNOTE = {
  hit: "THE REFERENCE. Every active cast above is specified against this clip and plays 1.8–3.7dB under it, so the consequence out-punches the act.",
  crit: "The consequence at its loudest ordinary. Fault Line used to borrow this clip on cast — that is what it is doing here.",
  kill: "The ceiling. An ultimate must read as an event and still sit under a death; if any of the four matches this, the cast is lying about what it did.",
  tell: "The enemy windup — the game's other \"something is about to happen\" cue. A cast that could be mistaken for a tell is a cast that reads as a threat to you.",
  ident: "The System's ordinary voice, and the duck SOURCE: the show talks over the dungeon, never the reverse.",
  ident_high: "The headline voice — boss down, new band, the daily rule. The loudest register the game owns.",
  boss_down: "The deepest object in the game (93Hz centroid, 2.2s). This is what a real ending sounds like here; Injunction has to stay clearly below it.",
  smash_wood: "The house's physical-transient reference — what a dry, real, breakable object sounds like in this dungeon.",
  dash_old: "THE NEGATIVE REFERENCE — the Kenney clip you rejected by name. Its sound arrived 120ms after the key and then plateaued for 0.47s. Nothing in the new set should land here.",
};

// -------------------------------------------------------------- grouping --
// By ROLE, not alphabetically: sounds that fight each other are sounds that
// fire in the same situations. Bands with siblings come first, because a pair
// can only be judged against its own sibling, back to back.
const BANDS = [
  { role: "mobility", ids: ["dash", "crowdsurf"], note: "Two ways to stop being where you were standing. One departs, one hauls. If they blur, the game has one movement sound with two cooldowns." },
  { role: "control", ids: ["overcharge", "cables"], note: "Two ways to take a fight's tempo away — one banked in your hands, one nailed to the floor. They fire in the same moments, so they are judged against each other." },
  { role: "ultimate", ids: ["airstrike", "bullettime", "injunction"], note: "Three events. Each must read as ABOVE an ordinary hit and still UNDER a kill (§2.2a), and each must be nameable with your eyes shut." },
  { role: "zone", ids: ["cataclysm"], note: "Tier-ultimate, but its own role: the floor itself becomes the weapon. Placed next to the ultimates on purpose — it is the fourth thing that fires in that moment." },
  { role: "beat", ids: ["stance"], note: "The rhythm cue. Pressed more often than anything else in the family, which makes it the only one whose failure mode is fatigue. Melee shares this role and has no row here on purpose: `swing` is its cast cue and always was — a documented absence, not a hole." },
  { role: "burst", ids: ["cutto"], note: "A gesture with a hole in it: the only cue in the set whose shape is two events and a silence." },
  { role: "clear", ids: ["orbit"], note: "The ring leaving the body. The one pitched, receding cue in the set." },
  { role: "sustain", ids: ["bulwark"], note: "Taking the hit on purpose. It has to sound like a decision, not like damage." },
  { role: "summon", ids: ["stuntdouble"], note: "Somebody else arrives. The only cue in the set where the second event is another body." },
];

const REF_ORDER = ["hit", "crit", "kill", "smash_wood", "tell", "ident", "ident_high", "boss_down", "dash_old"];

// --------------------------------------------------------------- assembly --
const audioPath = (id) =>
  id === "dash_old"
    ? join(SHEETS, "_src", "dash_old.ogg")
    : join(REPO, "public", "audio", "sfx", `${id}.ogg`);

const specPath = (id, dir) => join(SHEETS, dir, `spec_${id}.png`);

const asPlayed = (momDb, volume) => momDb + 20 * Math.log10(volume);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let seq = 0;
const clips = []; // {key, uri} for the audio elements

function strip(o) {
  const key = `c${++seq}`;
  clips.push({ key, uri: dataUri(o.audio, "audio/ogg") });
  const ledger = o.stats
    .map((s) => `<div class="cell"><span class="k">${esc(s[0])}</span><span class="v">${esc(s[1])}</span></div>`)
    .join("");
  return `
<article class="strip" id="s-${key}" data-key="${key}" data-dur="${o.sec}">
  <div class="body">
    <header class="head">
      <button class="play" type="button" data-play="${key}" aria-label="Play ${esc(o.title)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><polygon class="tri" points="8,5 19,12 8,19"></polygon><g class="sq"><rect x="7" y="7" width="10" height="10"></rect></g></svg>
      </button>
      <div class="names">
        <h3>${esc(o.title)}</h3>
        <p class="slug">${esc(o.slug)}</p>
      </div>
      ${o.tag ? `<span class="tag ${o.tagClass || ""}">${esc(o.tag)}</span>` : ""}
    </header>
    <p class="intent">${o.intent}</p>
    <p class="wrong"><span class="wl">Wrong sounds like</span>${o.wrong}</p>
  </div>
  <div class="aside">
    <div class="film" data-film="${key}">
      <img src="${dataUri(o.spec, "image/png")}" alt="Spectrogram of ${esc(o.title)}" width="640" height="260">
      <span class="needle"></span>
    </div>
    <div class="ledger">${ledger}</div>
  </div>
</article>`;
}

function castStrip(id) {
  const cid = `cast_${id}`;
  const d = CASTS[cid];
  const info = ROSTER[id];
  if (!d) throw new Error(`no measurement for ${cid} — regenerate contactsheet`);
  if (!info) throw new Error(`${id} is not in ABILITY_INFO — the roster is the source of truth`);
  const v = VOL[cid] || { volume: 1, throttleMs: 0 };
  const played = asPlayed(d.momDb, v.volume);
  return strip({
    title: info.name,
    slug: `${id} · ${cid}.ogg`,
    tag: info.tier === "ultimate" ? "ultimate" : null,
    tagClass: "ult",
    intent: BRIEF[cid].intent,
    wrong: BRIEF[cid].wrong,
    audio: audioPath(cid),
    spec: specPath(cid, "casts"),
    sec: d.sec,
    stats: [
      ["dur", `${d.sec.toFixed(2)}s`],
      ["LUFS mom", `${d.momDb.toFixed(1)}`],
      ["as played", `${played.toFixed(1)}`],
      ["on a laptop", `${d.hp250MomDb.toFixed(1)}`],
      ["onset", `${d.t10Ms.toFixed(1)}ms`],
      ["peak at", `${Math.round(d.attackMs)}ms`],
      ["centroid", `${d.centroidHz}Hz`],
      ["repeat gate", `${v.throttleMs}ms`],
    ],
  });
}

function refStrip(id) {
  const d = REFS[id];
  const v = VOL[id] || { volume: 1, throttleMs: 0 };
  const isNeg = id === "dash_old";
  return strip({
    title: id,
    slug: isNeg ? "retired · the clip you rejected" : `shipped · volume ${v.volume.toFixed(2)}`,
    tag: isNeg ? "negative reference" : null,
    tagClass: "neg",
    intent: REFNOTE[id],
    wrong: isNeg
      ? "Nothing — this one is here to be matched AGAINST. Any new cue that reminds you of this row is the failure."
      : "This row is the yardstick, not the candidate. If a cast above sits level with it or over it, that is the finding.",
    audio: audioPath(id),
    spec: specPath(id, "ref"),
    sec: d.sec,
    stats: [
      ["dur", `${d.sec.toFixed(2)}s`],
      ["LUFS mom", `${d.momDb.toFixed(1)}`],
      ["as played", isNeg ? "—" : `${asPlayed(d.momDb, v.volume).toFixed(1)}`],
      ["on a laptop", `${d.hp250MomDb.toFixed(1)}`],
      ["onset", `${d.t10Ms.toFixed(1)}ms`],
      ["peak at", `${Math.round(d.attackMs)}ms`],
      ["centroid", `${d.centroidHz}Hz`],
      ["repeat gate", v.throttleMs ? `${v.throttleMs}ms` : "none"],
    ],
  });
}

function levelUpStrip() {
  const d = NEGREF["level_up"];
  const v = VOL["level_up"] || { volume: 1, throttleMs: 0 };
  return strip({
    title: "LEVEL UP",
    slug: "level_up.ogg · fires on every level gained",
    intent:
      "The System FILES A PROMOTION: a stamp, then two notes a fourth apart stepping up (G5→C6) in the house bell timbre, over in a third of a second before it can become a jingle. It also plays 6.0dB quieter than the clip it replaces, because it fires constantly.",
    wrong:
      "Still a jingle. Still celebratory. Still a slot machine paying out. Or — the real risk of this trade, and the one I cannot judge — now so small that you cannot tell you levelled at all.",
    audio: audioPath("level_up"),
    spec: specPath("level_up", "negref"),
    sec: d.sec,
    stats: [
      ["dur", `${d.sec.toFixed(2)}s`],
      ["LUFS mom", `${d.momDb.toFixed(1)}`],
      ["as played", `${asPlayed(d.momDb, v.volume).toFixed(1)}`],
      ["on a laptop", `${d.hp250MomDb.toFixed(1)}`],
      ["onset", `${d.t10Ms.toFixed(1)}ms`],
      ["peak at", `${Math.round(d.attackMs)}ms`],
      ["centroid", `${d.centroidHz}Hz`],
      ["repeat gate", "none"],
    ],
  });
}

// bands
const bandHtml = BANDS.map((b) => {
  const keysStart = seq + 1;
  const strips = b.ids.map(castStrip).join("\n");
  const keys = b.ids.map((_, i) => `c${keysStart + i}`).join(",");
  const names = b.ids.map((id) => ROSTER[id].name).join(" · ");
  return `
<section class="band">
  <div class="bandbar">
    <h2>${esc(b.role)}</h2>
    <span class="bandnames">${esc(names)}</span>
    <button class="run" type="button" data-seq="${keys}">play band</button>
  </div>
  <p class="bandnote">${esc(b.note)}</p>
  ${strips}
</section>`;
}).join("\n");
const CAST_KEYS = clips.map((c) => c.key).join(",");

const refStartKey = seq + 1;
const refHtml = REF_ORDER.map(refStrip).join("\n");
const REF_KEYS = REF_ORDER.map((_, i) => `c${refStartKey + i}`).join(",");

const levelHtml = levelUpStrip();

const audioEls = clips
  .map((c) => `<audio id="a-${c.key}" preload="auto" src="${c.uri}"></audio>`)
  .join("\n");

const FONT_DISPLAY = dataUri(join(REPO, "public", "fonts", "Cinzel.ttf"), "font/ttf");
const FONT_BODY = dataUri(join(REPO, "public", "fonts", "AlegreyaSans-Regular.ttf"), "font/ttf");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>THE ACT — audio r2 audition sheet</title>
<style>
@font-face { font-family: "Cinzel"; src: url("${FONT_DISPLAY}") format("truetype"); font-weight: 400 700; font-display: block; }
@font-face { font-family: "Alegreya Sans"; src: url("${FONT_BODY}") format("truetype"); font-weight: 400; font-display: block; }

/* The Torchlit Broadcast (STYLEGUIDE.md). Deliberately single-theme: this is a
   set, not a document — the dungeon is lit by torch and the Show is lit by
   money, and neither of them has a light mode. */
:root {
  --void: #0e0b09; --stone: #171310; --raised: #221b15; --hover: #2c241b;
  --bronze: #6e5533; --bronze-hi: #a8854f;
  --gold: #c9a24b; --gold-hi: #f2c14e;
  --ink: #e8ddc8; --ink-dim: #a99f8c; --ink-faint: #6f6757;
  --blood: #c0392f;
  --serif: "Cinzel", Georgia, serif;
  --sans: "Alegreya Sans", "Segoe UI", system-ui, sans-serif;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { background: var(--void); }
body {
  margin: 0; background: var(--void); color: var(--ink);
  font-family: var(--sans); font-size: 16px; line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 0 20px 96px; }

/* ---- masthead ---- */
.mast { padding: 56px 0 28px; border-bottom: 1px solid rgba(110,85,51,.7); box-shadow: 0 1px 0 rgba(0,0,0,.55); }
.eyebrow {
  font-family: var(--serif); font-size: 11px; letter-spacing: .28em; text-transform: uppercase;
  color: var(--bronze-hi); margin: 0 0 14px;
}
.mast h1 {
  font-family: var(--serif); font-weight: 700; font-size: clamp(30px, 5.2vw, 52px);
  letter-spacing: .1em; margin: 0; color: var(--gold-hi); text-wrap: balance;
}
.mast .sub { font-family: var(--serif); font-size: clamp(13px, 1.7vw, 16px); letter-spacing: .18em; color: var(--ink-dim); margin: 10px 0 0; text-transform: uppercase; }
.lede { max-width: 62ch; margin: 22px 0 0; color: var(--ink-dim); font-size: 16.5px; }
.lede strong { color: var(--ink); font-weight: 400; }
.lede em { color: var(--gold); font-style: normal; }

/* ---- transport ---- */
.transport {
  position: sticky; top: 0; z-index: 20;
  display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
  margin: 0 -20px; padding: 12px 20px;
  background: linear-gradient(180deg, rgba(14,11,9,.97), rgba(14,11,9,.88));
  border-bottom: 1px solid rgba(110,85,51,.55);
  backdrop-filter: blur(4px);
}
.runall {
  font-family: var(--serif); font-size: 13px; letter-spacing: .14em; text-transform: uppercase;
  color: #241a08; padding: 10px 20px; border: 1px solid #5c4726; border-radius: 3px; cursor: pointer;
  background: linear-gradient(180deg, var(--gold-hi), var(--gold) 45%, #8a6d3b);
  box-shadow: inset 0 1px 0 rgba(255,240,200,.55);
  transition: filter 120ms ease-out;
}
.runall:hover { filter: brightness(1.09); }
.runall[data-on="1"] { background: linear-gradient(180deg, #7a3a33, #5e2a24 45%, #3d1c18); color: var(--ink); border-color: #6b3129; box-shadow: none; }
.status { font-family: var(--serif); font-size: 11.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--ink-faint); }
.status b { color: var(--gold); font-weight: 400; }

/* ---- band ---- */
.band { margin-top: 52px; }
.bandbar { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
.bandbar h2 {
  font-family: var(--serif); font-size: 15px; letter-spacing: .3em; text-transform: uppercase;
  color: var(--gold); margin: 0; white-space: nowrap;
}
.bandnames { font-family: var(--serif); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-faint); flex: 1 1 auto; }
.run {
  font-family: var(--serif); font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase;
  color: var(--ink-dim); background: var(--raised); border: 1px solid var(--bronze); border-radius: 3px;
  padding: 6px 12px; cursor: pointer; transition: color 120ms ease-out, border-color 120ms ease-out;
}
.run:hover { color: var(--gold-hi); border-color: var(--bronze-hi); }
.run[data-on="1"] { color: var(--ink); background: #43201b; border-color: #6b3129; }
.bandnote { max-width: 66ch; color: var(--ink-dim); font-size: 15px; margin: 10px 0 18px; padding-top: 10px; border-top: 1px solid rgba(110,85,51,.55); }

/* ---- strip ---- */
.strip {
  display: grid; grid-template-columns: minmax(0,1fr) 300px; gap: 26px;
  background: linear-gradient(180deg, var(--raised), var(--stone) 42%);
  border: 1px solid var(--bronze); box-shadow: inset 0 0 0 1px rgba(0,0,0,.55);
  border-radius: 3px; padding: 20px 22px; margin-bottom: 14px;
  transition: border-color 120ms ease-out;
}
.strip.on { border-color: var(--gold); }
.head { display: flex; align-items: center; gap: 14px; }
.play {
  flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%; cursor: pointer;
  background: var(--void); border: 1px solid var(--bronze-hi);
  display: grid; place-items: center; transition: background 120ms ease-out, border-color 120ms ease-out;
}
.play:hover { background: var(--hover); }
.play svg { width: 20px; height: 20px; fill: var(--gold); margin-left: 2px; }
.play .sq { display: none; }
.strip.on .play { border-color: var(--gold); background: #2a1f11; }
.strip.on .play svg { fill: var(--gold-hi); margin-left: 0; }
.strip.on .play .tri { display: none; }
.strip.on .play .sq { display: block; }
.names { min-width: 0; }
.names h3 { font-family: var(--serif); font-size: 21px; letter-spacing: .06em; color: var(--ink); margin: 0; font-weight: 700; }
.strip.on .names h3 { color: var(--gold-hi); }
.slug { font-size: 12.5px; letter-spacing: .04em; color: var(--ink-faint); margin: 2px 0 0; }
.tag {
  margin-left: auto; font-family: var(--serif); font-size: 9.5px; letter-spacing: .2em; text-transform: uppercase;
  color: var(--gold); border: 1px solid var(--bronze); padding: 4px 9px; border-radius: 2px; white-space: nowrap;
}
.tag.neg { color: var(--blood); border-color: #59261f; }
.intent { margin: 15px 0 0; max-width: 60ch; font-size: 16px; }
.wrong { margin: 12px 0 0; max-width: 60ch; font-size: 14.5px; color: var(--ink-dim); border-left: 2px solid var(--blood); padding-left: 12px; }
.wl { display: block; font-family: var(--serif); font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--blood); margin-bottom: 3px; }

/* ---- picture + numbers ---- */
.aside { min-width: 0; }
.film { position: relative; border: 1px solid var(--bronze); background: #000; line-height: 0; overflow: hidden; }
.film img {
  width: 100%; height: auto; display: block; opacity: .92;
  filter: sepia(.6) saturate(1.5) hue-rotate(-14deg) contrast(1.06) brightness(1.02);
}
.needle { position: absolute; top: 0; bottom: 0; left: 0; width: 1px; background: var(--gold-hi); box-shadow: 0 0 6px rgba(242,193,78,.85); opacity: 0; }
.strip.on .needle { opacity: 1; }
.ledger { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.cell { display: flex; align-items: baseline; gap: 5px; font-size: 11.5px; line-height: 1.85; color: var(--ink-faint); }
.cell .k { white-space: nowrap; }
.cell::after {
  content: ""; flex: 1 1 auto; height: 1em; min-width: 6px;
  background-image: radial-gradient(circle, rgba(110,85,51,.75) .5px, transparent .6px);
  background-size: 4px 4px; background-position: bottom left; background-repeat: repeat-x;
  order: 1;
}
.cell .v { order: 2; color: var(--ink-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* ---- section rules ---- */
.rule { display: flex; align-items: center; gap: 18px; margin: 76px 0 0; }
.rule::before, .rule::after { content: ""; flex: 1 1 auto; border-top: 1px solid var(--bronze); border-bottom: 1px solid rgba(0,0,0,.55); }
.rule h2 { font-family: var(--serif); font-size: 16px; letter-spacing: .3em; text-transform: uppercase; color: var(--gold); margin: 0; white-space: nowrap; }
.sectnote { max-width: 66ch; margin: 16px auto 26px; color: var(--ink-dim); text-align: center; font-size: 15.5px; }
.sectnote .runall { margin-top: 14px; display: inline-block; }

.foot { margin-top: 72px; padding-top: 20px; border-top: 1px solid rgba(110,85,51,.7); box-shadow: 0 -1px 0 rgba(0,0,0,.55) inset; color: var(--ink-faint); font-size: 13.5px; max-width: 72ch; }
.foot b { font-family: var(--serif); font-weight: 400; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-dim); font-size: 11px; display: block; margin-bottom: 6px; }
.foot p { margin: 0 0 10px; }

:focus-visible { outline: 2px solid var(--gold-hi); outline-offset: 2px; }
audio { display: none; }

@media (max-width: 820px) {
  .strip { grid-template-columns: minmax(0,1fr); gap: 18px; }
  .aside { max-width: 420px; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
  .needle { display: none; }
}
</style>
</head>
<body>
<div class="wrap">

<header class="mast">
  <p class="eyebrow">Audio r2 · SOUNDPLAN §9 · nothing here has been heard</p>
  <h1>THE ACT</h1>
  <p class="sub">Thirteen cast cues, one ear that counts</p>
  <p class="lede">
    You hear the <em>consequence</em> when a hit lands. Until this round you never heard the
    <em>act</em>. Thirteen of sixteen abilities cast without a voice of their own — eleven of them
    borrowing someone else's clip, two of them silent — and the inventory that was supposed to
    catch that had been built by walking the director's mappings instead of the roster.
    <strong>Everything below is measured; nothing below is a claim that anything sounds good.</strong>
    That part is yours. Every clip plays from a file embedded in this page — no network, no server,
    works offline.
  </p>
</header>

<div class="transport">
  <button class="runall" type="button" id="runall" data-seq="${CAST_KEYS}">Play all thirteen in sequence</button>
  <span class="status" id="status">Idle — the real question is whether the set coheres, and that is only audible back to back.</span>
</div>

${bandHtml}

<div class="rule"><h2>The house voice</h2></div>
<p class="sectnote">
  Nine sounds already in the game, so the new set can be judged against the one it has to live in
  rather than against itself. The last row is the clip you rejected by name.
  <br><button class="runall" type="button" data-seq="${REF_KEYS}">Play the nine references</button>
</p>
${refHtml}

<div class="rule"><h2>The second verdict</h2></div>
<p class="sectnote">
  "Can we also change the level up sound, it's annoying as shit." It fires on one of the most-pressed
  edges in the game, so it was rewritten short and dry rather than long and celebratory.
</p>
${levelHtml}

<footer class="foot">
  <p><b>How to give a verdict I can act on</b>
  Name the clip and which failure it hit — every row above states its own. "Cut To and Dash blur"
  is actionable; "I don't like it" is not. Two rows are honest bets rather than finished work:
  Battle Stance can fail by being noticeable OR by being invisible, and Injunction ends on a rest
  that either lands or reads as the file getting cut off.</p>
  <p><b>What the numbers mean</b>
  <em>LUFS mom</em> is the file. <em>As played</em> is the file times its manifest volume — the level
  that actually leaves the speaker, and the number the mix contract is written against (actives sit
  1.8–3.7dB under <em>hit</em>; ultimates sit above a hit and under a kill). <em>On a laptop</em> is
  the same clip through a 250Hz highpass, i.e. what survives without a subwoofer. <em>Onset</em> is
  time to 10% — how fast the sound acknowledges the button. The needle over each spectrogram is the
  real playhead, so you can see which part of the picture you are hearing.</p>
  <p><b>What is not verified</b>
  No browser was run in this round, so no cue here has been heard firing in the game — each is
  verified by unit test against the real sim and by measurement of the file. In-game, the fastest
  way to hear the family as a family is <em>?test&amp;floor=6&amp;level=30&amp;abilities=all</em> on
  /iso.html, which puts every ability on the bar at once.</p>
</footer>

</div>
${audioEls}
<script>
(function () {
  var strips = {};
  document.querySelectorAll(".strip").forEach(function (s) { strips[s.dataset.key] = s; });

  var queue = [], qi = -1, cur = null, raf = 0, runner = null;
  var status = document.getElementById("status");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function el(k) { return document.getElementById("a-" + k); }
  function label(k) {
    var h = strips[k] && strips[k].querySelector("h3");
    return h ? h.textContent : k;
  }

  function tick() {
    if (!cur) return;
    var a = el(cur), s = strips[cur];
    if (a && s && a.duration) {
      var n = s.querySelector(".needle");
      if (n) n.style.left = Math.min(100, (a.currentTime / a.duration) * 100) + "%";
    }
    raf = requestAnimationFrame(tick);
  }

  function clear() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (cur) {
      var a = el(cur), s = strips[cur];
      if (a) { a.pause(); a.currentTime = 0; }
      if (s) s.classList.remove("on");
      cur = null;
    }
  }

  function stopAll(msg) {
    if (runner) { clearTimeout(runner); runner = null; }
    clear();
    queue = []; qi = -1;
    document.querySelectorAll("[data-seq][data-on]").forEach(function (b) {
      b.removeAttribute("data-on");
      b.textContent = b.dataset.label || b.textContent;
    });
    status.textContent = msg || "Idle.";
  }

  function start(k, then) {
    clear();
    var a = el(k), s = strips[k];
    if (!a) return;
    cur = k;
    if (s) s.classList.add("on");
    a.currentTime = 0;
    a.onended = function () {
      a.onended = null;
      if (cur === k) clear();
      if (then) then();
    };
    var p = a.play();
    if (p && p.catch) p.catch(function () { if (then) then(); });
    if (!reduce) raf = requestAnimationFrame(tick);
    if (s) {
      var top = s.getBoundingClientRect().top;
      if (queue.length > 1 && (top < 80 || top > window.innerHeight - 120)) {
        s.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      }
    }
  }

  function step() {
    qi++;
    if (qi >= queue.length) { stopAll("Done — that was the set, in order."); return; }
    var k = queue[qi];
    status.innerHTML = "Playing <b>" + label(k) + "</b> — " + (qi + 1) + " of " + queue.length;
    start(k, function () {
      runner = setTimeout(step, 380);
    });
  }

  document.querySelectorAll("[data-play]").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.dataset.play;
      var playing = cur === k;
      stopAll(playing ? "Idle." : null);
      if (playing) return;
      status.innerHTML = "Playing <b>" + label(k) + "</b>";
      queue = [k]; qi = 0;
      start(k, function () { status.textContent = "Idle."; });
    });
  });

  document.querySelectorAll("[data-seq]").forEach(function (b) {
    b.dataset.label = b.textContent;
    b.addEventListener("click", function () {
      var on = b.getAttribute("data-on") === "1";
      stopAll();
      if (on) return;
      b.setAttribute("data-on", "1");
      b.textContent = "Stop";
      queue = b.dataset.seq.split(","); qi = -1;
      step();
    });
  });
})();
</script>
</body>
</html>
`;

writeFileSync(OUT, html);
const bytes = statSync(OUT).size;

// ------------------------------------------------------------- self-check --
// The page is published behind a CSP that blocks every external host, so the
// only acceptable resource scheme is data:. Assert it rather than claim it.
const built = readFileSync(OUT, "utf8");
const refs = [...built.matchAll(/(?:src|href)="([^"]*)"|url\(("?)([^)"]*)\2\)/g)].map(
  (m) => m[1] ?? m[3],
);
const external = refs.filter((u) => !u.startsWith("data:"));
const audioCount = (built.match(/<audio /g) || []).length;
const dataAudio = (built.match(/src="data:audio\/ogg;base64,/g) || []).length;
const dataImg = (built.match(/src="data:image\/png;base64,/g) || []).length;

console.log(`audition.html  ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MB)`);
console.log(`  audio elements: ${audioCount}  (data: URIs ${dataAudio})`);
console.log(`  spectrograms:   ${dataImg} data: URIs`);
console.log(`  fonts:          2 data: URIs (Cinzel, Alegreya Sans)`);
console.log(`  external refs:  ${external.length}${external.length ? " -> " + external.join(", ") : " (none)"}`);
if (external.length || audioCount !== dataAudio) {
  console.error("FAIL: page is not self-contained");
  process.exit(1);
}
if (bytes > 16 * 1024 * 1024) {
  console.error("FAIL: page exceeds the 16MB artifact ceiling");
  process.exit(1);
}
