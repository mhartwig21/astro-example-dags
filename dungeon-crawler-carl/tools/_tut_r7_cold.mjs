// TUTORIAL r7/r8 COLD-PROFILE BATTERY — one genuine first session per run.
//
// Usage: node tools/_tut_r7_cold.mjs <profileId> <playSeconds>
//
// Rules this instrument holds itself to:
//  * ONE chromium, one fresh context, storage cleared before boot — a real
//    first run, entered from the menu (DESCEND -> casting -> campfire).
//  * NO test mode, NO ?clean, NO gear/gold injection, NO teleports, NO writes
//    into sim state. `?debug=1` is used READ-ONLY, for two things only:
//      (a) measurement (floor, hp, mercy saves, shelf prices), and
//      (b) EYES — the direction to the stairs and the range to the nearest
//          monster, which a sighted player has from the screen + minimap.
//    The hands are deliberately bad: cardinal-only holds, 35% of decisions
//    thrown away as wrong turns, no kiting, no dash-escape, flask only when
//    the bar is already deep, attacks only at contact range.
//  * Everything the report claims is read from the GLASS (the HUD plaques,
//    the objectives card, Mordecai's strip, the feed) or from localStorage.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = "C:/Users/hartw/astro-example-dags/.claude/worktrees/tutorial-mordecai/dungeon-crawler-carl";
// A ROUND MAY NOT OVERWRITE THE ROUND THAT JUDGED IT (r9). The r7/r8 battery
// in tools/_shots/tut_r7 is the evidence the critic scored; a rerun that
// silently replaces it destroys the only before-picture. Set TUT_OUT per round.
const OUT = path.resolve(ROOT, process.env.TUT_OUT ?? "tools/_shots/tut_r7");
fs.mkdirSync(OUT, { recursive: true });

const ID = process.argv[2] ?? "A";

// THE HANDS, per profile. Four first-timers are not four copies of one bot, so
// the clumsiness is a declared dial and the report says which dial each profile
// ran on. A is the most capable ("has played an ARPG before"); C is the worst
// ("does not know what the buttons do"), which is the profile the tutorial has
// to carry. Everything here degrades the PLAYER, never the game.
const SKILL = {
  //        engage: tiles at which they notice a monster at all
  //        wrong:  fraction of movement decisions thrown away as a wrong turn
  //        stale:  they only re-read the route every Nth decision
  //        flask:  hp fraction at which they finally think about the flask
  A: { engage: 4.0, wrong: 0.20, stale: 1, flask: 0.32, swings: 3, dashP: 0.20, castP: 0.35 },
  B: { engage: 3.0, wrong: 0.32, stale: 2, flask: 0.28, swings: 2, dashP: 0.10, castP: 0.25 },
  C: { engage: 1.8, wrong: 0.45, stale: 3, flask: 0.20, swings: 2, dashP: 0.05, castP: 0.15 },
  D: { engage: 3.4, wrong: 0.28, stale: 2, flask: 0.30, swings: 3, dashP: 0.15, castP: 0.30 },
}[ID] ?? { engage: 4.0, wrong: 0.20, stale: 1, flask: 0.32, swings: 3, dashP: 0.2, castP: 0.35 };
const PLAY_MS = (Number(process.argv[3]) || 420) * 1000;
const URL = "http://localhost:5287/iso.html?debug=1";

// Deterministic-per-profile clumsiness, so a rerun of profile B is the same
// bad player twice.
let seed = [...`dcc-${ID}`].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 7);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1);
const flow = [];
const say = (msg) => { const l = `[${T()}s] ${msg}`; flow.push(l); console.log(l); };
const shots = [];

const browser = await chromium.launch({
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const errs = [];
// r9 — THE INSTRUMENT IS PART OF THE FINDING (critic, severity 5). Three
// defects in the previous revision, all of them the same mistake in different
// clothes: a SAMPLED observation reported as a MEASURED outcome.
//   1. `engagements` incremented once per DECISION TICK spent inside engage
//      range, so it counted per-frame proximity, not fights. B logged 433
//      engagements against 36 swings while A logged 52 against 93 — the two
//      numbers were not the same unit. It counts ENTRY EDGES now (out-of-range
//      -> in-range), with the dwell kept separately as `contactTicks`.
//   2. `stepStates[title].peak` never observed the completing frame, so "Get
//      Moving".peak was 2 in all five passes while obj.move ledgered every
//      time. Completion is now READ FROM THE LEDGER each tick, not inferred
//      from a peak the sampler happened to catch.
//   3. `reachedFive` was set true when the step ARMED (the card title changed),
//      which produced the inflated "4/4 reached THE FIVE" headline against an
//      actual 2/4 completion. Arming and completion are two fields now, and
//      the headline reports both.
const R = {
  id: ID,
  // ARMED = the card was observed carrying the step. COMPLETED = the ledger
  // holds its obj.* key. Never collapse these two into one number again.
  armedFive: false, completedFive: false, reachedFloor2: false, died: 0, knockdowns: 0,
  completedFirstStep: false, maxFloor: 1, steps: [], cycles: [], notes: [],
  shopSeen: null, heldClock: false, verdicts: 0, stepStates: {},
  engagements: 0, contactTicks: 0, swingAttempts: 0, killsPeak: 0, minNearSeen: 99, cardChanges: 0,
  ledgerAt: {}, ledgerSeen: [],
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

  // ---- COLD ---------------------------------------------------------------
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

  const shot = async (name) => {
    const f = path.join(OUT, `${ID}_${name}.png`);
    await page.screenshot({ path: f }).catch(() => {});
    shots.push(f);
    say(`shot ${name}`);
  };
  await shot("00_menu");

  // ---- ENTER THE GAME LIKE A PERSON --------------------------------------
  await page.evaluate(() => document.getElementById("m-solo")?.click());
  await page.waitForTimeout(1800);
  await shot("01_casting");
  await page.evaluate(() => {
    const g = document.getElementById("m-cast-go");
    if (g && g.getBoundingClientRect().width > 2) g.click();
  });
  await page.waitForTimeout(2600);

  // Campfire: a curious first-timer reads and takes the first answer each time.
  for (let i = 0; i < 8; i++) {
    const dlg = await page.evaluate(() => {
      const el = document.getElementById("dialogue");
      if (!el || getComputedStyle(el).display === "none") return null;
      return {
        who: document.getElementById("dlg-name")?.textContent ?? "",
        text: (document.getElementById("dlg-text")?.textContent ?? "").slice(0, 160),
        choices: [...document.querySelectorAll("#dlg-choices .dlg-choice")].map((b) => b.textContent.trim()),
      };
    });
    if (!dlg) break;
    if (i === 0) { say(`campfire: ${dlg.text}`); await shot("02_campfire"); }
    await page.keyboard.press("1");
    await page.waitForTimeout(1100);
  }
  await page.waitForTimeout(2500);
  await shot("03_floor1_start");

  // ---- THE READ -----------------------------------------------------------
  const READ = `(() => {
    const txt = (s) => (document.querySelector(s)?.textContent ?? "").trim();
    const open = (id) => { const e = document.getElementById(id);
      return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 2; };
    const s = window.__dcc?.state ?? null;
    const p = s?.players?.[0] ?? null;
    let stairs = null, near = 99, mobs = 0, nearDir = null;
    if (s && p) {
      stairs = { dx: s.map.stairs.x - p.pos.x, dy: s.map.stairs.y - p.pos.y };
      // MONSTERS HAVE NO alive FIELD (sim/types.ts Monster) — aliveness is
      // hp > 0. An earlier revision filtered on m.alive, which is undefined
      // for every monster in the game, so near was 99 forever, the combat
      // branch never ran, and the battery measured a player who never once
      // attacked. That is how a run can log dmg=0 while losing hp.
      for (const m of s.monsters ?? []) {
        if (!(m.hp > 0)) continue;
        const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
        if (d < near) { near = d; nearDir = { x: m.pos.x - p.pos.x, y: m.pos.y - p.pos.y }; }
        if (d < 12) mobs++;
      }
    }
    return {
      floor: txt("#hh-floor"), hp: txt("#hh-hpnum"), gold: txt("#hh-gold"),
      level: txt("#hh-level"), phase: txt("#hh-phase"), clock: txt("#hh-time"),
      objTitle: txt("#objectives .obj-title"),
      objItems: [...document.querySelectorAll("#objectives .obj-items li")]
        .map((li) => (li.classList.contains("done") ? "[x] " : "[ ] ") + li.textContent.trim()),
      strip: [...document.querySelectorAll("#tutorial .tut")].map((e) => e.textContent.trim().slice(0, 200)),
      dlg: open("dialogue"), draft: open("draft"), saferoom: open("saferoom"), recap: open("recap"),
      feed: [...document.querySelectorAll("#hud-log-feed .log-line")].map((e) => e.textContent.trim()),
      headline: txt("#headline"),
      alive: p ? p.alive : null, hpNum: p ? p.hp : null, mercy: p ? (p.mercySaves ?? 0) : 0,
      inSafe: p ? !!p.safeRoom : null, firstRun: s ? !!s.firstRun : null,
      simFloor: s ? s.floor : null, held: s ? !!s.firstRunClockHeld : null,
      stairs, near, mobs, nearDir, pos: p ? { x: p.pos.x, y: p.pos.y } : null,
      dmgDealt: p ? (p.damageDealt ?? 0) : 0, kills: p ? (p.kills ?? 0) : 0,
      // WHERE A PLAYER WOULD BE LOOKING. A person sees the room, the doorway
      // and the minimap; a cardinal-only bot sees a wall and hugs it forever
      // (measured: profile A spent six minutes inside a 2-tile radius, which
      // measured the instrument and not the game). So the route is solved the
      // way a sighted player's eyes solve it — shortest walk to the stairs,
      // or to the floor key when the stairs room is sealed, or to the far
      // side of what is reachable when neither is known yet. The HANDS stay
      // bad: the driver only ever gets the NEXT step of it, late, and throws
      // one in five away.
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
          // the sealed floor: the key is the thing on the ground worth walking to
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
        const path = [];
        for (let c = goal; c !== prev[c]; c = prev[c]) path.push(c);
        path.reverse();
        const step = path[Math.min(path.length - 1, 3)];
        if (step === undefined) return { why, len: 0, dx: 0, dy: 0 };
        return { why, len: path.length, dx: (step % W) + 0.5 - p.pos.x, dy: (((step / W) | 0) + 0.5) - p.pos.y };
      })(),
      flasks: p ? p.flasks ?? null : null,
      draftsBanked: p ? ((p.pendingUpgrades ?? []).length + (p.pendingRewards ?? []).length) : 0,
      // THE LEDGER, EVERY TICK, not once at the end (r9 instrument fix #2).
      // A step's completion is a WRITE to dcc:tips:v1; reading it live is the
      // only way to timestamp the completing frame, and it is what demotes the
      // sampled per-step peak from evidence to a footnote.
      ledger: localStorage.getItem("dcc:tips:v1") ?? "",
    };
  })()`;

  // The card TITLE each ledger key belongs to (src/ui/objectives.ts): the
  // ledger says obj.five, the glass says "Your Kit", and the report has to be
  // able to put a completion next to the card it was read off.
  const STEP_TITLE = {
    "obj.move": "Get Moving", "obj.five": "Your Kit", "obj.payday": "Payday",
    "obj.saferoom": "The Safe Room", "obj.show": "The Show",
  };
  const seenFeed = new Set();
  let lastStep = "";
  let inEngage = false;
  let stepPeak = {};
  let lastShotAt = 0;
  let lastPos = null, unstick = 0, unstickKey = "w", stairsTries = 0, lastRouteKey = null;
  const hold = async (k, ms) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k).catch(() => {}); };
  const KEYS = { up: "w", down: "s", left: "a", right: "d" };

  const play0 = Date.now();
  let tick = 0;
  while (Date.now() - play0 < PLAY_MS) {
    tick++;
    let st;
    try { st = await page.evaluate(READ); } catch { break; }

    // ---- record ----------------------------------------------------------
    const f = Number(st.floor) || st.simFloor || 1;
    if (f > R.maxFloor) {
      R.maxFloor = f;
      say(`>>> FLOOR ${f}`);
      if (f >= 2) { R.reachedFloor2 = true; await shot(`10_floor${f}`); }
    }
    if (st.held && !R.heldClock) {
      R.heldClock = true;
      say(`CLOCK HELD (phase=${st.phase} clock=${st.clock})`);
      await shot("60_clock_held");
    }
    R.killsPeak = Math.max(R.killsPeak, st.kills || 0);
    R.dmgPeak = Math.max(R.dmgPeak ?? 0, Math.round(st.dmgDealt || 0));
    if (typeof st.near === "number") R.minNearSeen = Math.min(R.minNearSeen, st.near);
    // The engagement edge closes wherever the tick ends up, including the ticks
    // that never reach the combat branch (a panel, the stairs, a draft).
    if (!(st.near < SKILL.engage)) inEngage = false;
    if ((st.mercy || 0) > R.knockdowns) {
      R.knockdowns = st.mercy;
      say(`KNOCKDOWN #${st.mercy} (floor ${st.floor}, hp ${st.hp}, firstRun=${st.firstRun})`);
      if (st.mercy === 1) await shot("61_knockdown");
    }
    if (R.firstRunFlag === undefined) R.firstRunFlag = st.firstRun;
    R.runFloor = f;
    for (const line of st.feed) {
      if (seenFeed.has(line)) continue;
      seenFeed.add(line);
      if (/debut edit|cuts to commercial/i.test(line)) say(`KNOCKDOWN: ${line}`);
      if (/production float|advanced against/i.test(line)) say(`FLOAT: ${line}`);
      if (/collapse|clock/i.test(line) && /hold|held/i.test(line)) say(`CLOCK: ${line}`);
    }
    if (st.objTitle && st.objTitle !== lastStep) {
      lastStep = st.objTitle;
      R.cardChanges++;
      R.steps.push({ t: Number(T()), title: st.objTitle, items: st.objItems });
      say(`STEP: ${st.objTitle} :: ${st.objItems.join(" | ")}`);
      // ARMING, and it is labelled as arming. The step taking the card is not
      // the step being learned — that is the ledger's word, below.
      if (/kit|five/i.test(st.objTitle) && !R.armedFive) {
        R.armedFive = true;
        say(`ARMED: "${st.objTitle}" took the card (arming is NOT completion)`);
        await shot("20_thefive");
      }
      if (Date.now() - lastShotAt > 45000) { lastShotAt = Date.now(); await shot(`step_${R.steps.length}`); }
    }
    // THE LEDGER IS THE COMPLETION RECORD, and it is polled every tick so the
    // completing frame gets a timestamp instead of being inferred from a peak
    // the sampler may never have caught (r9 instrument fix #2 and #3).
    for (const key of ["obj.move", "obj.five", "obj.payday", "obj.saferoom", "obj.show"]) {
      if (R.ledgerAt[key] !== undefined) continue;
      if (!new RegExp(key.replace(".", "\\.")).test(st.ledger || "")) continue;
      R.ledgerAt[key] = Number(T());
      R.ledgerSeen.push(key);
      say(`LEDGERED: ${key} @${T()}s (this — not the card arming — is completion)`);
      if (key === "obj.five") R.completedFive = true;
      if (key === "obj.move") R.completedFirstStep = true;
      const title = STEP_TITLE[key];
      if (title) {
        R.stepStates[title] = R.stepStates[title] ?? { peak: 0, resets: 0, ticks: 0, completed: false };
        R.stepStates[title].completed = true;
        R.stepStates[title].completedAt = Number(T());
      }
    }
    // step cycling / reset detection: the done-count of the LIVE step going down
    if (st.objTitle) {
      const done = st.objItems.filter((i) => i.startsWith("[x]")).length;
      const key = st.objTitle;
      R.stepStates[key] = R.stepStates[key] ?? { peak: 0, resets: 0, ticks: 0, completed: false };
      const s2 = R.stepStates[key];
      s2.ticks++;
      // `peak` is a SAMPLED number and is now labelled as one: it says what the
      // probe saw, and nothing about whether the step finished. The previous
      // revision reported peak 2 for "Get Moving" in all five passes while the
      // ledger held obj.move every time, and read that gap as a defect in the
      // game rather than in the sampling rate.
      if (done > s2.peak) s2.peak = done;
      else if (done < s2.peak) {
        s2.resets++;
        R.cycles.push(`${key}: ${s2.peak}/${st.objItems.length} -> ${done}/${st.objItems.length} @${T()}s`);
        say(`CYCLE/RESET on "${key}" ${s2.peak} -> ${done}`);
        s2.peak = done;
      }
      s2.items = st.objItems.length;
      // NOT "the card changed" — obj.saferoom PRE-EMPTS the card whenever the
      // crawler stands at a counter, so a card change is no evidence any step
      // was finished. Only the ledger above is completion.
    }

    // ---- panels ----------------------------------------------------------
    if (st.recap) {
      R.died++; R.verdicts++;
      R.runs = R.runs ?? [];
      R.runs.push({ n: R.runs.length + 1, t: Number(T()), floor: st.floor, firstRun: st.firstRun, step: st.objTitle, items: st.objItems, ledgerAtDeath: null });
      say(`!!! THE VERDICT (run over, run #${R.runs.length}) floor=${st.floor} firstRun=${st.firstRun} step="${st.objTitle}" — ${st.headline || ""}`);
      await shot(`30_verdict_${R.died}`);
      await page.waitForTimeout(2500);
      await page.evaluate(() => document.getElementById("recap-again")?.click());
      await page.waitForTimeout(4000);
      // a fresh campfire/dialogue may ride the restart
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
      say("DRAFT open — taking the first card");
      await shot(`40_draft`);
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
            locked: t.classList.contains("locked"),
            // r9: the tile state that answers "which of these is worth buying"
            // for a crawler wearing nothing.
            fits: t.classList.contains("fits"), title: t.getAttribute("title") ?? "",
          }));
          return {
            gold: p?.gold ?? null, wallet: document.getElementById("sr-wallet")?.textContent ?? "",
            lesson: document.getElementById("sr-tip")?.textContent ?? "",
            tiles, cheapest: Math.min(...tiles.filter((t) => t.price && !t.locked).map((t) => t.price)),
            ready: tiles.filter((t) => t.ready).length,
            fits: tiles.filter((t) => t.fits).length,
            emptySlots: [...document.querySelectorAll("#sr-equipped .itile.eslot")].length,
            bagEmptyCopy: document.querySelector("#sr-bag .bempty")?.textContent ?? "",
            // The affordance count the critic counted: visible sub-tabs.
            subTabs: [...document.querySelectorAll(".shop-subtabs .tab")]
              .filter((b) => getComputedStyle(b).display !== "none").map((b) => b.textContent.trim()),
          };
        });
        R.shopSeen = shop;
        say(`SHOP: gold=${shop.gold} cheapest=${shop.cheapest} readyTiles=${shop.ready} fitsTiles=${shop.fits} emptySlots=${shop.emptySlots} subTabs=[${shop.subTabs.join(", ")}]`);
        say(`SHOP lesson: ${shop.lesson}`);
        await shot("50_shop");
        // buy the cheapest thing that is actually buyable — the compliant read
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
        } else {
          say("SHOP: nothing on the shelf was buyable");
          R.shopSeen.bought = false;
        }
      }
      await page.waitForTimeout(1200);
      await page.evaluate(() => document.getElementById("sr-descend")?.click());
      await page.waitForTimeout(3000);
      continue;
    }

    // A COMPLIANT READER CLAIMS THE DRAFT. The card's item is "Claim a draft"
    // and the coach teaches V; a banked draft that nobody claims stalls Payday
    // forever. (Pass C's first run stalled exactly there because this probe
    // never pressed the key it had been taught.)
    if ((st.draftsBanked || 0) > 0) {
      await hold("v", 200);
      await page.waitForTimeout(900);
      continue;
    }

    // ---- the hands (deliberately clumsy) ---------------------------------
    const hpFrac = (() => {
      const m = /(\d+)\s*\/\s*(\d+)/.exec(st.hp || "");
      return m ? Number(m[1]) / Math.max(1, Number(m[2])) : 1;
    })();

    // NOTE ON THE HANDS: every game key is HELD, never `press`ed. `intent`
    // samples the held set once per frame (input.ts `held("slot1")`), so a
    // zero-delay press falls between frames and is simply never seen — an
    // earlier revision of this probe swung 8 minutes' worth of air and
    // measured damageDealt = 0.
    // flask, late and panicky
    if (hpFrac < SKILL.flask && rnd() < 0.55) await hold("x", 180);

    // stairs: hold E whenever they are close (the taught key)
    const sx = st.stairs?.dx ?? 0, sy = st.stairs?.dy ?? 0;
    const dist = Math.hypot(sx, sy);
    // tryDescend wants dist <= 1.0 of the stairs tile, so the last two tiles
    // are walked in small deliberate steps before the key is tried at all.
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

    // contact combat: walk INTO the thing (which is what sets facing) and
    // mash. No kiting, no dash-out, no repositioning — the dash gets pressed
    // occasionally and usually at the wrong moment.
    if (st.near < SKILL.engage && st.nearDir) {
      // AN ENGAGEMENT IS AN EDGE, NOT A FRAME (r9 instrument fix #1). The old
      // line incremented once per decision tick spent near something, which is
      // dwell, and then the report compared that dwell to a swing COUNT as if
      // the two shared a unit. Both numbers are kept, and neither is called
      // the other's name.
      if (!inEngage) { R.engagements++; inEngage = true; }
      R.contactTicks++;
      const nk = Math.abs(st.nearDir.x) > Math.abs(st.nearDir.y)
        ? (st.nearDir.x > 0 ? KEYS.right : KEYS.left)
        : (st.nearDir.y > 0 ? KEYS.down : KEYS.up);
      // Walk INTO it (that is what sets facing) until it is inside swing
      // range, then mash. Melee range is ~1.5 tiles, so an "attack at 3.4
      // tiles" bot swings air and never draws blood.
      if (st.near > 1.5) {
        await hold(nk, Math.min(420, Math.max(140, (st.near - 1.1) * 210)));
      } else {
        await hold(nk, 130);
        // ATTEMPTS, not landed swings — the name says which. Damage dealt and
        // kills are read from the sim and are the outcome numbers.
        R.swingAttempts += SKILL.swings;
        for (let i = 0; i < SKILL.swings; i++) await hold(" ", 260);
        if (rnd() < SKILL.castP) await hold("q", 200);     // the cast key, sometimes
        if (rnd() < SKILL.dashP) await hold("Shift", 180); // the dash, used badly (playwright wants "Shift")
      }
      continue;
    }

    // movement: mostly toward the stairs, sometimes a wrong turn, and — like a
    // person who can see the wall they just walked into — a change of plan when
    // the last hold bought no ground. Without that, a cardinal-only bot spends
    // the whole session flattened against geometry and the battery measures the
    // instrument instead of the game.
    const rx = st.route?.dx ?? sx, ry = st.route?.dy ?? sy;
    let k;
    // ROUTE STALENESS: a first-timer does not re-solve the room every step.
    // They commit to a direction and only look up every SKILL.stale decisions.
    if (rnd() < SKILL.wrong) k = [KEYS.up, KEYS.down, KEYS.left, KEYS.right][Math.floor(rnd() * 4)];
    else if (SKILL.stale > 1 && lastRouteKey && (tick % SKILL.stale) !== 0) k = lastRouteKey;
    else if (Math.abs(rx) > Math.abs(ry)) k = rx > 0 ? KEYS.right : KEYS.left;
    else k = ry > 0 ? KEYS.down : KEYS.up;
    lastRouteKey = k;
    lastPos = st.pos ?? null;
    await hold(k, 480 + Math.floor(rnd() * 380));

    if (tick % 30 === 0) say(`t+${T()}s floor=${st.floor} hp=${st.hp} gold=${st.gold} lvl=${st.level} phase=${st.phase} step="${st.objTitle}" mercy=${st.mercy} distStairs=${dist.toFixed(1)} route=${st.route?.why}/${st.route?.len} dmg=${Math.round(st.dmgDealt)} kills=${st.kills} items=${st.objItems.join(" | ")}`);
  }

  // ---- final read ---------------------------------------------------------
  const fin = await page.evaluate(READ).catch(() => null);
  if (fin) {
    say(`FINAL floor=${fin.floor} hp=${fin.hp} gold=${fin.gold} lvl=${fin.level} step="${fin.objTitle}" mercy=${fin.mercy} firstRun=${fin.firstRun}`);
    R.final = {
      floor: fin.floor, hp: fin.hp, gold: fin.gold, level: fin.level,
      step: fin.objTitle, items: fin.objItems, mercy: fin.mercy, firstRun: fin.firstRun,
      phase: fin.phase, clock: fin.clock,
    };
    R.knockdowns = Math.max(R.knockdowns, fin.mercy || 0);
  }
  const ledger = await page.evaluate(() => localStorage.getItem("dcc:tips:v1"));
  R.ledger = ledger;
  say(`LEDGER: ${ledger}`);
  // Completion is the ledger and only the ledger, here and in the loop above.
  R.completedFive = /obj\.five/.test(ledger ?? "");
  R.completedFirstStep = /obj\.move/.test(ledger ?? "");
  R.curriculumComplete = ["obj.move", "obj.five", "obj.payday", "obj.saferoom", "obj.show"]
    .every((k) => new RegExp(k.replace(".", "\\.")).test(ledger ?? ""));
  R.stepsCompleted = R.ledgerSeen.length;
  await shot("99_final");
  R.errs = errs.slice(0, 5);
} finally {
  await browser.close();
}

R.skill = SKILL;
R.flow = flow;
R.shots = shots;
fs.writeFileSync(path.join(OUT, `${ID}.json`), JSON.stringify(R, null, 2));
console.log("\n=== RESULT " + ID + " ===");
// THE HEADLINE REPORTS COMPLETION AND ARMING SEPARATELY. The previous
// revision's single `reachedFive` was set by the card arming, which is how a
// round with a 2/4 completion rate published "4/4 reached THE FIVE".
console.log(JSON.stringify({
  id: R.id,
  completedFirstStep: R.completedFirstStep,
  armedFive: R.armedFive, completedFive: R.completedFive,
  stepsCompleted: R.stepsCompleted, curriculumComplete: R.curriculumComplete,
  reachedFloor2: R.reachedFloor2, died: R.died, knockdowns: R.knockdowns,
  maxFloor: R.maxFloor, cycles: R.cycles.length, shop: R.shopSeen && {
    gold: R.shopSeen.gold, cheapest: R.shopSeen.cheapest, ready: R.shopSeen.ready,
    fits: R.shopSeen.fits, bought: R.shopSeen.bought,
  },
  engagements: R.engagements, contactTicks: R.contactTicks, swingAttempts: R.swingAttempts,
  killsPeak: R.killsPeak, dmgPeak: R.dmgPeak,
  heldClock: R.heldClock, ledgerAt: R.ledgerAt, ledger: R.ledger,
}, null, 2));
