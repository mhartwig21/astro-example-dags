// TUTORIAL COLD-PROFILE COHORT BATTERY (r11 build under test).
//
// Usage: node tools/_tut_r12_cohort.mjs [playSeconds] [profiles]
//   e.g. node tools/_tut_r12_cohort.mjs 450 A,B,C,D
//
// ONE chromium for the whole cohort; one FRESH CONTEXT per profile with
// localStorage/sessionStorage cleared before boot, so every session is a
// genuine cold first run entered from the menu (DESCEND -> casting ->
// campfire). No test mode, no ?clean, no gear/gold injection, no teleports,
// no writes into sim state. `?debug=1` is READ-ONLY and only for
//   (a) measurement, and
//   (b) EYES — the route to the stairs and the range to the nearest monster,
//       which a sighted player has from the screen, the beacon and the chart.
//
// WHAT THIS ROUND MEASURES, and why it is written down here: the previous
// headline ("4/4 reached THE FIVE") measured the step ARMING. Arming is not
// learning. Every outcome field below is read from the LEDGER (dcc:tips:v1)
// or from the glass, never from "the card changed".
//
//   curriculumComplete  all five obj.* keys on the ledger
//   learnedKit          obj.five ON THE LEDGER (armedFive is reported beside
//                       it, and they are never collapsed into one number)
//   strandedSeconds     THE STRANDING MEASURE: the longest wall-clock stretch
//                       with NO step progress at all — no item checked, no
//                       step completed, no new step armed. A session that ends
//                       at level 1 / floor 1 / step 2 of 5 shows up here as a
//                       single enormous number, which is the finding.
//   deathCause          combat vs collapse-timer, read off the sim phase and
//                       the death line at the frame the run ended.
//   unclaimedDrafts     drafts still banked at the final read.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/tutorial-mordecai/dungeon-crawler-carl";
const OUT = path.resolve(ROOT, process.env.TUT_OUT ?? "tools/_shots/tut_r9");
fs.mkdirSync(OUT, { recursive: true });
// A round may not overwrite the battery that judged it (TUTORIAL r9): this
// cohort writes under its own prefix inside the shared shots directory.
const PFX = process.env.TUT_PFX ?? "r12";

const PLAY_MS = (Number(process.argv[2]) || 450) * 1000;
const IDS = (process.argv[3] ?? "A,B,C,D").split(",").map((s) => s.trim()).filter(Boolean);
const URL = "http://localhost:5287/iso.html?debug=1";

// THE HANDS, per profile. Four first-timers are not four copies of one expert.
//   engage: tiles at which they notice a monster at all
//   wrong:  fraction of movement decisions thrown away as a wrong turn
//   stale:  they only re-read the route every Nth decision
//   flask:  hp fraction at which they finally think about the flask
//   read:   probability, per decision, that they ACT on an instruction that is
//           on the glass in front of them. This is the dial that makes the
//           cohort a test of TEACHING rather than of a compliant robot: the
//           driver never presses a key the game has not named, and the bad
//           hands often ignore it even after it has.
//   lag:    decisions they let pass before an instruction registers at all.
const SKILLS = {
  // A — "has played an ARPG before". Reads the strip, mostly does as told.
  A: { engage: 4.0, wrong: 0.20, stale: 1, flask: 0.32, swings: 3, dashP: 0.20, castP: 0.35, read: 0.85, lag: 1 },
  // B — average. Notices things late, follows about half of them.
  B: { engage: 3.0, wrong: 0.32, stale: 2, flask: 0.28, swings: 2, dashP: 0.10, castP: 0.25, read: 0.55, lag: 3 },
  // C — THE POOR HANDS. Does not know what the buttons do, walks into walls,
  // engages only at contact, drinks the flask far too late, and acts on a
  // written instruction about one time in five. This is the profile the
  // tutorial exists to carry; if it strands anybody it strands this one.
  C: { engage: 1.8, wrong: 0.45, stale: 3, flask: 0.20, swings: 2, dashP: 0.05, castP: 0.15, read: 0.22, lag: 6 },
  // D — competent-but-impatient: good hands, skims the prose.
  D: { engage: 3.4, wrong: 0.28, stale: 2, flask: 0.30, swings: 3, dashP: 0.15, castP: 0.30, read: 0.45, lag: 2 },
};

const OBJ_KEYS = ["obj.move", "obj.five", "obj.payday", "obj.saferoom", "obj.show"];
const STEP_TITLE = {
  "obj.move": "Get Moving", "obj.five": "Your Kit", "obj.payday": "Payday",
  "obj.saferoom": "The Safe Room", "obj.show": "The Show",
};

const READ = `(() => {
  const txt = (s) => (document.querySelector(s)?.textContent ?? "").trim();
  const open = (id) => { const e = document.getElementById(id);
    return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 2; };
  const s = window.__dcc?.state ?? null;
  const p = s?.players?.[0] ?? null;
  let stairs = null, near = 99, mobs = 0, nearDir = null;
  if (s && p) {
    stairs = { dx: s.map.stairs.x - p.pos.x, dy: s.map.stairs.y - p.pos.y };
    for (const m of s.monsters ?? []) {
      if (!(m.hp > 0)) continue;
      const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
      if (d < near) { near = d; nearDir = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y }; }
      if (d < 12) mobs++;
    }
  }
  const exitEl = document.getElementById("exitmark");
  const exitR = exitEl ? exitEl.getBoundingClientRect() : null;
  return {
    floor: txt("#hh-floor"), hp: txt("#hh-hpnum"), gold: txt("#hh-gold"),
    level: txt("#hh-level"), phase: txt("#hh-phase"), clock: txt("#hh-time"),
    viewers: txt("#stat-viewers"), favorites: txt("#stat-favorites"), sponsors: txt("#stat-sponsors"),
    objTitle: txt("#objectives .obj-title"),
    ask: txt("#objectives .obj-ask"),
    objItems: [...document.querySelectorAll("#objectives .obj-items li")]
      .map((li) => (li.classList.contains("done") ? "[x] " : "[ ] ") + li.textContent.trim()),
    strip: [...document.querySelectorAll("#tutorial .tut")].map((e) => e.textContent.trim().slice(0, 240)),
    dlg: open("dialogue"), draft: open("draft"), saferoom: open("saferoom"), recap: open("recap"),
    feed: [...document.querySelectorAll("#hud-log-feed .log-line")].map((e) => e.textContent.trim()),
    headline: txt("#headline"),
    // THE EXIT BEACON (r11) — painted, and where.
    exit: exitEl && getComputedStyle(exitEl).display !== "none" && exitR.width > 2
      ? { w: Math.round(exitR.width), h: Math.round(exitR.height), x: Math.round(exitR.x), y: Math.round(exitR.y),
          text: exitEl.textContent.trim(), edge: exitEl.classList.contains("edge") }
      : null,
    alive: p ? p.alive : null, hpNum: p ? p.hp : null, hpMax: p ? p.hpMax ?? null : null,
    mercy: p ? (p.mercySaves ?? 0) : 0,
    inSafe: p ? !!p.safeRoom : null, firstRun: s ? !!s.firstRun : null,
    simFloor: s ? s.floor : null, held: s ? !!s.firstRunClockHeld : null,
    simPhase: s ? s.phase : null, timeRemaining: s ? Math.round(s.timeRemaining ?? 0) : null,
    hype: p ? Math.round(p.hype ?? 0) : null, favs: p ? (p.favorites ?? 0) : null,
    stairs, near, mobs, nearDir, pos: p ? { x: p.pos.x, y: p.pos.y } : null,
    dmgDealt: p ? (p.damageDealt ?? 0) : 0, kills: p ? (p.kills ?? 0) : 0,
    goldNum: p ? Math.round(p.gold ?? 0) : null, levelNum: p ? (p.level ?? null) : null,
    route: (() => {
      if (!s || !p) return null;
      const m = s.map, W = m.w, H = m.h;
      const walk = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        const t = m.tiles[y * W + x];
        if (t === 0 || t === 3) return false;
        return !(m.blocked && m.blocked[y * W + x]);
      };
      const sx0 = Math.floor(p.pos.x), sy0 = Math.floor(p.pos.y);
      const prev = new Int32Array(W * H).fill(-1);
      const q = [sy0 * W + sx0];
      prev[sy0 * W + sx0] = sy0 * W + sx0;
      let head = 0, last = sy0 * W + sx0;
      while (head < q.length) {
        const cur = q[head++]; last = cur;
        const cx = cur % W, cy = (cur / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (!walk(nx, ny)) continue;
          const ni = ny * W + nx;
          if (prev[ni] !== -1) continue;
          prev[ni] = cur; q.push(ni);
        }
      }
      const reach = (tx, ty) => (tx >= 0 && ty >= 0 && tx < W && ty < H && prev[(ty | 0) * W + (tx | 0)] !== -1);
      let goal = -1, why = "";
      const stx = Math.floor(m.stairs.x), sty = Math.floor(m.stairs.y);
      if (reach(stx, sty)) { goal = sty * W + stx; why = "stairs"; }
      if (goal < 0) {
        let best = -1, bd = 1e9;
        for (const l of s.loot ?? []) {
          if (l.taken) continue;
          const lx = Math.floor(l.pos.x), ly = Math.floor(l.pos.y);
          if (!reach(lx, ly)) continue;
          const d = Math.hypot(lx - sx0, ly - sy0);
          if (d < bd) { bd = d; best = ly * W + lx; }
        }
        if (best >= 0) { goal = best; why = "loot/key"; }
      }
      if (goal < 0) { goal = last; why = "explore"; }
      const pth = [];
      for (let c = goal; c !== prev[c]; c = prev[c]) pth.push(c);
      pth.reverse();
      const step = pth[Math.min(pth.length - 1, 3)];
      if (step === undefined) return { why, len: 0, dx: 0, dy: 0 };
      return { why, len: pth.length, dx: (step % W) + 0.5 - p.pos.x, dy: (((step / W) | 0) + 0.5) - p.pos.y };
    })(),
    flasks: p ? p.flasks ?? null : null,
    draftsBanked: p ? ((p.pendingUpgrades ?? []).length + (p.pendingRewards ?? []).length) : 0,
    ledger: localStorage.getItem("dcc:tips:v1") ?? "",
  };
})()`;

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const cohort = [];
const allFlow = [];
const allShots = [];

try {
  for (const ID of IDS) {
    const SKILL = SKILLS[ID] ?? SKILLS.A;
    let seed = [...`dcc-${ID}`].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 7);
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    const t0 = Date.now();
    const T = () => ((Date.now() - t0) / 1000).toFixed(1);
    const flow = [];
    const shots = [];
    const say = (msg) => { const l = `[${ID} ${T()}s] ${msg}`; flow.push(l); allFlow.push(l); console.log(l); };
    const errs = [];

    const R = {
      id: ID, skill: SKILL,
      armedFive: false, completedFive: false, reachedFloor2: false,
      died: 0, deaths: [], knockdowns: 0, escorted: false,
      completedFirstStep: false, maxFloor: 1, steps: [], cycles: [], notes: [],
      shopSeen: null, heldClock: false, stepStates: {},
      engagements: 0, contactTicks: 0, swingAttempts: 0, killsPeak: 0, dmgPeak: 0,
      ledgerAt: {}, ledgerSeen: [],
      // THE STRANDING MEASURE
      progressAt: [], strandedSeconds: 0, strandedWindow: null,
      exitSeen: null, exitFrames: 0, askEscalations: [], asksSeen: [],
    };

    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

    const shot = async (name) => {
      const f = path.join(OUT, `${PFX}_${ID}_${name}.png`);
      await page.screenshot({ path: f }).catch(() => {});
      shots.push(f); allShots.push(f);
      say(`shot ${name}`);
    };

    try {
      // ---- COLD ------------------------------------------------------------
      await page.goto("http://localhost:5287/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.goto(URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(6000);
      const cold = await page.evaluate(() => ({
        hist: localStorage.getItem("dcc:history:v1"),
        save: localStorage.getItem("dcc:save:v1"),
        tips: localStorage.getItem("dcc:tips:v1"),
      }));
      say(`cold check: history=${cold.hist} save=${cold.save} tips=${cold.tips}`);
      if (cold.hist || cold.save) R.notes.push("PROFILE WAS NOT COLD");
      await shot("00_menu");

      // ---- ENTER LIKE A PERSON --------------------------------------------
      await page.evaluate(() => document.getElementById("m-solo")?.click());
      await page.waitForTimeout(1800);
      await page.evaluate(() => {
        const g = document.getElementById("m-cast-go");
        if (g && g.getBoundingClientRect().width > 2) g.click();
      });
      await page.waitForTimeout(2600);
      for (let i = 0; i < 8; i++) {
        const dlg = await page.evaluate(() => {
          const el = document.getElementById("dialogue");
          if (!el || getComputedStyle(el).display === "none") return null;
          return { text: (document.getElementById("dlg-text")?.textContent ?? "").slice(0, 160) };
        });
        if (!dlg) break;
        if (i === 0) { say(`campfire: ${dlg.text}`); await shot("02_campfire"); }
        await page.keyboard.press("1");
        await page.waitForTimeout(1100);
      }
      await page.waitForTimeout(2500);
      await shot("03_floor1_start");

      // ---- PLAY ------------------------------------------------------------
      const seenFeed = new Set();
      let lastStep = "", lastAsk = "";
      let inEngage = false, lastShotAt = 0, stairsTries = 0, lastRouteKey = null;
      let approachBest = Infinity, approachStuck = 0, giveUpUntil = -1;
      const hold = async (k, ms) => {
        await page.keyboard.down(k); await page.waitForTimeout(ms);
        await page.keyboard.up(k).catch(() => {});
      };
      const KEYS = { up: "w", down: "s", left: "a", right: "d" };

      // THE STRANDING CLOCK. Any of: an item newly checked, a step completed
      // (ledger write), a new step armed. Nothing else counts — walking,
      // killing and looting are not curriculum progress, and a player who does
      // all three for four minutes without ticking a box is stranded.
      const play0 = Date.now();
      let lastProgress = play0;
      let strandStart = play0;
      const progress = (why) => {
        const now = Date.now();
        const gap = (now - lastProgress) / 1000;
        if (gap > R.strandedSeconds) {
          R.strandedSeconds = Number(gap.toFixed(1));
          R.strandedWindow = { fromS: Number(((lastProgress - play0) / 1000).toFixed(1)), toS: Number(((now - play0) / 1000).toFixed(1)), endedBy: why };
        }
        lastProgress = now;
        R.progressAt.push({ t: Number(T()), why });
      };

      // instruction compliance: the driver never presses a key the glass has
      // not named, and even then only when the profile's `read` dial says so.
      let draftTaught = false, draftLag = 0;

      let tick = 0;
      while (Date.now() - play0 < PLAY_MS) {
        tick++;
        let st;
        try { st = await page.evaluate(READ); } catch { break; }

        // ---- record -------------------------------------------------------
        const f = Number(st.floor) || st.simFloor || 1;
        if (f > R.maxFloor) {
          R.maxFloor = f;
          say(`>>> FLOOR ${f}`);
          if (f >= 2) { R.reachedFloor2 = true; await shot(`10_floor${f}`); }
        }
        if (st.held && !R.heldClock) {
          R.heldClock = true;
          say(`CLOCK HELD (phase=${st.phase} clock=${st.clock})`);
        }
        if (st.exit) {
          R.exitFrames++;
          if (!R.exitSeen) { R.exitSeen = { ...st.exit, atS: Number(T()) }; say(`EXIT BEACON: ${JSON.stringify(st.exit)}`); await shot("70_exitbeacon"); }
        }
        R.killsPeak = Math.max(R.killsPeak, st.kills || 0);
        R.dmgPeak = Math.max(R.dmgPeak, Math.round(st.dmgDealt || 0));
        if (!(st.near < SKILL.engage)) inEngage = false;
        if ((st.mercy || 0) > R.knockdowns) {
          R.knockdowns = st.mercy;
          say(`KNOCKDOWN #${st.mercy} (floor ${st.floor}, hp ${st.hp}, phase=${st.simPhase})`);
          if (st.mercy >= 3) { R.escorted = true; await shot(`62_escort`); }
          else if (st.mercy === 1) await shot("61_knockdown");
        }
        for (const line of st.feed) {
          if (seenFeed.has(line)) continue;
          seenFeed.add(line);
          if (/collapsing floor claimed/i.test(line)) say(`DEATHLINE(collapse): ${line}`);
          else if (/debut edit|cuts to commercial|production has walked/i.test(line)) say(`MERCY: ${line}`);
          if (/production float|advanced against/i.test(line)) say(`FLOAT: ${line}`);
        }
        // step arming
        if (st.objTitle && st.objTitle !== lastStep) {
          const fresh = !R.stepStates[st.objTitle];
          lastStep = st.objTitle;
          R.steps.push({ t: Number(T()), title: st.objTitle, items: st.objItems });
          say(`STEP ARMED: ${st.objTitle} :: ${st.objItems.join(" | ")}`);
          if (fresh) progress(`step armed: ${st.objTitle}`);
          if (/kit|five/i.test(st.objTitle) && !R.armedFive) {
            R.armedFive = true;
            say(`ARMED THE FIVE (arming is NOT completion)`);
            await shot("20_thefive");
          }
          if (Date.now() - lastShotAt > 60000) { lastShotAt = Date.now(); await shot(`step_${R.steps.length}`); }
        }
        // ask + escalation (r10/r11 teaching channel)
        if (st.ask && st.ask !== lastAsk) {
          if (lastAsk && st.ask.length > lastAsk.length * 1.6 && st.objTitle === lastStep) {
            R.askEscalations.push({ t: Number(T()), from: lastAsk.slice(0, 90), to: st.ask.slice(0, 160) });
            say(`ASK ESCALATED: "${st.ask.slice(0, 140)}"`);
          }
          lastAsk = st.ask;
          if (!R.asksSeen.some((a) => a.text === st.ask)) R.asksSeen.push({ t: Number(T()), text: st.ask.slice(0, 200) });
        }
        // THE LEDGER IS COMPLETION
        for (const key of OBJ_KEYS) {
          if (R.ledgerAt[key] !== undefined) continue;
          if (!new RegExp(key.replace(".", "\\.")).test(st.ledger || "")) continue;
          R.ledgerAt[key] = Number(T());
          R.ledgerSeen.push(key);
          say(`LEDGERED: ${key} @${T()}s  <-- COMPLETION (not arming)`);
          progress(`completed ${key}`);
          if (key === "obj.five") R.completedFive = true;
          if (key === "obj.move") R.completedFirstStep = true;
        }
        // item checks + reset detection
        if (st.objTitle) {
          const done = st.objItems.filter((i) => i.startsWith("[x]")).length;
          const key = st.objTitle;
          R.stepStates[key] = R.stepStates[key] ?? { peak: 0, resets: 0, ticks: 0 };
          const s2 = R.stepStates[key];
          s2.ticks++;
          if (done > s2.peak) { s2.peak = done; progress(`item checked on "${key}" -> ${done}/${st.objItems.length}`); say(`ITEM CHECKED on "${key}": ${done}/${st.objItems.length}`); }
          else if (done < s2.peak) {
            s2.resets++;
            R.cycles.push(`${key}: ${s2.peak} -> ${done} @${T()}s`);
            say(`CYCLE/RESET on "${key}" ${s2.peak} -> ${done}`);
            s2.peak = done;
          }
          s2.items = st.objItems.length;
        }

        // ---- panels --------------------------------------------------------
        if (st.recap) {
          // TRUE CAUSE OF DEATH: the sim phase at the ending frame plus the
          // death line the System filed. A collapse execution and a lost fight
          // are two different verdicts on the tutorial.
          const collapseLine = st.feed.find((l) => /collapsing floor claimed/i.test(l));
          const cause = collapseLine || st.simPhase === "collapse" ? "collapse-timer" : "combat";
          R.died++;
          R.deaths.push({
            n: R.died, t: Number(T()), floor: st.floor, cause,
            simPhase: st.simPhase, timeRemaining: st.timeRemaining,
            headline: st.headline || "", line: collapseLine || (st.feed.slice(-1)[0] ?? ""),
            step: st.objTitle, items: st.objItems, level: st.level, gold: st.gold,
          });
          say(`!!! THE VERDICT #${R.died}: cause=${cause} floor=${st.floor} phase=${st.simPhase} step="${st.objTitle}" — ${st.headline || ""}`);
          await shot(`30_verdict_${R.died}`);
          await page.waitForTimeout(2500);
          await page.evaluate(() => document.getElementById("recap-again")?.click());
          await page.waitForTimeout(4000);
          for (let i = 0; i < 4; i++) {
            const d = await page.evaluate(() => {
              const el = document.getElementById("dialogue");
              return !!el && getComputedStyle(el).display !== "none";
            });
            if (!d) break;
            await page.keyboard.press("1"); await page.waitForTimeout(900);
          }
          continue;
        }
        if (st.dlg) { await page.keyboard.press("1"); await page.waitForTimeout(900); continue; }
        if (st.draft) {
          say("DRAFT PANEL open — taking the first card");
          if (!R.draftShot) { R.draftShot = true; await shot("40_draft"); }
          await page.evaluate(() => document.querySelector("#draft-cards .dcard, #draft-cards [data-idx]")?.click());
          await page.waitForTimeout(1600);
          continue;
        }
        if (st.saferoom) {
          if (!R.shopSeen) {
            const shop = await page.evaluate(() => {
              const s = window.__dcc?.state; const p = s?.players?.[0];
              const tiles = [...document.querySelectorAll("#sr-shelf .itile")].map((t) => ({
                id: t.dataset.id, price: Number((t.querySelector(".iprice")?.textContent ?? "").replace(/\D+/g, "")) || null,
                broke: t.classList.contains("broke"), ready: t.classList.contains("ready"),
                locked: t.classList.contains("locked"), fits: t.classList.contains("fits"),
                title: t.getAttribute("title") ?? "",
              }));
              return {
                gold: p?.gold ?? null, wallet: document.getElementById("sr-wallet")?.textContent ?? "",
                lesson: document.getElementById("sr-tip")?.textContent ?? "",
                cheapest: Math.min(...tiles.filter((t) => t.price && !t.locked).map((t) => t.price)),
                ready: tiles.filter((t) => t.ready).length,
                fits: tiles.filter((t) => t.fits).length,
                tiles: tiles.length,
                emptySlots: [...document.querySelectorAll("#sr-equipped .itile.eslot")].length,
                subTabs: [...document.querySelectorAll(".shop-subtabs .tab")]
                  .filter((b) => getComputedStyle(b).display !== "none").map((b) => b.textContent.trim()),
              };
            });
            R.shopSeen = shop;
            say(`SHOP: gold=${shop.gold} cheapest=${shop.cheapest} ready=${shop.ready} fits=${shop.fits} emptySlots=${shop.emptySlots} subTabs=[${shop.subTabs.join(", ")}]`);
            say(`SHOP lesson: ${shop.lesson}`);
            await shot("50_shop");
            // Buying is an instruction the panel gives; the poor hands may
            // simply not act on it.
            if (rnd() < Math.max(0.3, SKILL.read)) {
              const bought = await page.evaluate(() => {
                const tiles = [...document.querySelectorAll("#sr-shelf .itile.ready")];
                tiles.sort((a, b) => (Number((a.querySelector(".iprice")?.textContent ?? "").replace(/\D+/g, "")) || 1e9)
                  - (Number((b.querySelector(".iprice")?.textContent ?? "").replace(/\D+/g, "")) || 1e9));
                const t = tiles[0];
                if (!t) return null;
                t.click();
                return t.getAttribute("title");
              });
              if (bought) {
                await page.waitForTimeout(1400);
                const done = await page.evaluate(() => {
                  const b = document.querySelector("#sr-detail button[data-buy]:not([disabled])");
                  if (!b) return null; b.click(); return b.textContent;
                });
                say(`SHOP buy: tile="${bought}" button=${done}`);
                R.shopSeen.bought = !!done;
                await page.waitForTimeout(1200);
                await shot("51_shop_bought");
              } else { say("SHOP: nothing on the shelf was buyable"); R.shopSeen.bought = false; }
            } else { say("SHOP: this crawler did not act on the shelf lesson"); R.shopSeen.bought = false; }
          }
          await page.waitForTimeout(1200);
          await page.evaluate(() => document.getElementById("sr-descend")?.click());
          await page.waitForTimeout(3000);
          continue;
        }

        // ---- COMPLIANCE: only press keys the glass has named ---------------
        const glass = [st.ask, ...(st.strip || []), ...(st.objItems || [])].join(" ").toLowerCase();
        if (/draft|evolution/.test(glass) && /\bv\b/i.test([st.ask, ...(st.strip || []), ...(st.objItems || [])].join(" "))) {
          if (!draftTaught) { draftTaught = true; say(`DRAFT KEY TAUGHT on the glass @${T()}s`); }
        }
        if ((st.draftsBanked || 0) > 0) {
          if (!draftTaught) {
            if (tick % 40 === 0) say(`carrying ${st.draftsBanked} unclaimed draft(s) — nothing on the glass has named the key`);
          } else if (draftLag++ < SKILL.lag) {
            // it has been said; this crawler has not acted on it yet
          } else if (rnd() < SKILL.read) {
            await hold("v", 200);
            await page.waitForTimeout(900);
            continue;
          }
        }

        // ---- the hands ----------------------------------------------------
        const hpFrac = (() => {
          const m = /(\d+)\s*\/\s*(\d+)/.exec(st.hp || "");
          return m ? Number(m[1]) / Math.max(1, Number(m[2])) : 1;
        })();
        if (hpFrac < SKILL.flask && rnd() < 0.55) await hold("x", 180);

        const sx = st.stairs?.dx ?? 0, sy = st.stairs?.dy ?? 0;
        const dist = Math.hypot(sx, sy);
        if (dist < 0.95) {
          await hold("e", 300);
          await page.waitForTimeout(1400);
          stairsTries++;
          if (stairsTries % 6 === 0) say(`at the stairs, E pressed ${stairsTries}x, dist=${dist.toFixed(2)}, still floor ${st.floor}`);
          continue;
        }
        if (dist < 3.2) {
          const k2 = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? KEYS.right : KEYS.left) : (sy > 0 ? KEYS.down : KEYS.up);
          await hold(k2, 170);
          continue;
        }

        // A PERSON GIVES UP ON A MONSTER THEY CANNOT REACH. The first pass of
        // this battery measured profile D at 2353 of 2397 decision ticks inside
        // engage range against SIX swings: the driver had locked onto something
        // behind a wall and walked into that wall for seven minutes, then the
        // report called the result "the game stranded a player". It did not —
        // the instrument stranded it. The approach now has to BUY GROUND, and
        // an approach that does not is abandoned, exactly as a sighted player
        // abandons a monster across a chasm.
        if (st.near < SKILL.engage && st.nearDir && tick > giveUpUntil) {
          if (!inEngage) { R.engagements++; inEngage = true; approachBest = Infinity; approachStuck = 0; }
          R.contactTicks++;
          const nk = Math.abs(st.nearDir.x) > Math.abs(st.nearDir.y)
            ? (st.nearDir.x > 0 ? KEYS.right : KEYS.left)
            : (st.nearDir.y > 0 ? KEYS.down : KEYS.up);
          if (st.near > 1.5) {
            if (st.near < approachBest - 0.15) { approachBest = st.near; approachStuck = 0; }
            else if (++approachStuck >= 4) {
              giveUpUntil = tick + 25;
              R.approachAbandons = (R.approachAbandons ?? 0) + 1;
              say(`gave up on an unreachable monster at ${st.near.toFixed(1)} tiles — walking away`);
              inEngage = false;
              continue;
            }
            await hold(nk, Math.min(420, Math.max(140, (st.near - 1.1) * 210)));
          } else {
            await hold(nk, 130);
            R.swingAttempts += SKILL.swings;
            for (let i = 0; i < SKILL.swings; i++) await hold(" ", 260);
            if (rnd() < SKILL.castP) await hold("q", 200);
            if (rnd() < SKILL.dashP) await hold("Shift", 180);
          }
          continue;
        }

        const rx = st.route?.dx ?? sx, ry = st.route?.dy ?? sy;
        let k;
        if (rnd() < SKILL.wrong) k = [KEYS.up, KEYS.down, KEYS.left, KEYS.right][Math.floor(rnd() * 4)];
        else if (SKILL.stale > 1 && lastRouteKey && (tick % SKILL.stale) !== 0) k = lastRouteKey;
        else if (Math.abs(rx) > Math.abs(ry)) k = rx > 0 ? KEYS.right : KEYS.left;
        else k = ry > 0 ? KEYS.down : KEYS.up;
        lastRouteKey = k;
        await hold(k, 480 + Math.floor(rnd() * 380));

        if (tick % 30 === 0) {
          say(`t+${T()}s floor=${st.floor} hp=${st.hp} gold=${st.gold} lvl=${st.level} phase=${st.phase} clock=${st.clock} step="${st.objTitle}" mercy=${st.mercy} drafts=${st.draftsBanked} hype=${st.hype} distStairs=${dist.toFixed(1)} route=${st.route?.why}/${st.route?.len} kills=${st.kills} items=${st.objItems.join(" | ")}`);
          say(`  ask: ${(st.ask || "(none)").slice(0, 150)}`);
        }
      }

      // close the stranding window at the end of the session
      {
        const gap = (Date.now() - lastProgress) / 1000;
        if (gap > R.strandedSeconds) {
          R.strandedSeconds = Number(gap.toFixed(1));
          R.strandedWindow = { fromS: Number(((lastProgress - play0) / 1000).toFixed(1)), toS: Number(((Date.now() - play0) / 1000).toFixed(1)), endedBy: "session ended (still stranded)" };
        }
      }

      // ---- FINAL READ -----------------------------------------------------
      const fin = await page.evaluate(READ).catch(() => null);
      if (fin) {
        R.final = {
          floorHud: fin.floor, simFloor: fin.simFloor, hp: fin.hp, gold: fin.goldNum ?? fin.gold,
          goldHud: fin.gold, level: fin.levelNum ?? fin.level, levelHud: fin.level,
          step: fin.objTitle, items: fin.objItems, ask: fin.ask, mercy: fin.mercy,
          firstRun: fin.firstRun, phase: fin.phase, clock: fin.clock,
          unclaimedDrafts: fin.draftsBanked, hype: fin.hype, favorites: fin.favs,
          viewers: fin.viewers, kills: fin.kills, exitLit: !!fin.exit,
        };
        R.knockdowns = Math.max(R.knockdowns, fin.mercy || 0);
        say(`FINAL floor=${fin.floor} lvl=${fin.levelNum} gold=${fin.goldNum} hp=${fin.hp} step="${fin.objTitle}" drafts=${fin.draftsBanked} mercy=${fin.mercy}`);
      }
      const ledger = await page.evaluate(() => localStorage.getItem("dcc:tips:v1"));
      R.ledger = ledger;
      R.completedFive = /obj\.five/.test(ledger ?? "");
      R.completedFirstStep = /obj\.move/.test(ledger ?? "");
      R.curriculumComplete = OBJ_KEYS.every((k) => new RegExp(k.replace(".", "\\.")).test(ledger ?? ""));
      R.stepsCompleted = OBJ_KEYS.filter((k) => new RegExp(k.replace(".", "\\.")).test(ledger ?? "")).length;
      say(`LEDGER: ${ledger}`);
      await shot("99_final");
      R.errs = errs.slice(0, 5);
    } finally {
      await ctx.close().catch(() => {});
    }

    R.flow = flow;
    R.shots = shots;
    cohort.push(R);
    fs.writeFileSync(path.join(OUT, `${PFX}_${ID}.json`), JSON.stringify(R, null, 2));
    console.log(`\n=== ${ID} === ` + JSON.stringify({
      curriculumComplete: R.curriculumComplete, stepsCompleted: R.stepsCompleted,
      armedFive: R.armedFive, learnedKit: R.completedFive,
      reachedFloor2: R.reachedFloor2, maxFloor: R.maxFloor,
      endLevel: R.final?.level, endGold: R.final?.gold, endStep: R.final?.step,
      deaths: R.died, causes: R.deaths.map((d) => d.cause),
      knockdowns: R.knockdowns, escorted: R.escorted,
      unclaimedDrafts: R.final?.unclaimedDrafts, strandedSeconds: R.strandedSeconds,
    }, null, 2));
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, `${PFX}_cohort.json`), JSON.stringify({
  playSeconds: PLAY_MS / 1000, profiles: cohort, flow: allFlow, shots: allShots,
}, null, 2));
console.log("\n===== COHORT =====");
console.table(cohort.map((r) => ({
  id: r.id, curriculum: r.curriculumComplete, steps: `${r.stepsCompleted}/5`,
  armedFive: r.armedFive, learnedKit: r.completedFive,
  floor2: r.reachedFloor2, maxFloor: r.maxFloor,
  lvl: r.final?.level, gold: r.final?.gold, step: r.final?.step,
  deaths: r.died, causes: r.deaths.map((d) => d.cause).join("/"),
  knockdowns: r.knockdowns, drafts: r.final?.unclaimedDrafts, strandedS: r.strandedSeconds,
})));
