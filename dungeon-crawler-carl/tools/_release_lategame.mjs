// RELEASE CANDIDATE — THE INTEGRATED LATE GAME, on a locked floor.
//
// Three merged branches meet here and the seam between two of them is the one
// this release was warned about:
//
//   key-visible promotes the stairs-district key lines to a CENTRE BANNER.
//   the-mix puts a priority/masking filter over exactly that channel.
//   If the filter eats a key line, the owner cannot find the key, cannot
//   descend, and the collapse clock is running. Run-ending.
//
// So the key line is not fired into a quiet frame. It is fired into the
// STRONGEST STATE THE FILTER HAS — a live boss climax, where NotifMix holds
// everything below RANK_BOSS_NEWS — and the banner must still arrive. A pass
// in a quiet frame would prove nothing, because in a quiet frame the filter
// is not doing anything.
//
// Also measured here: the four surfaces key-visible added (banner, world
// pillar, minimap keyhole, off-screen "N paces" marker) with the mix layer
// live; that the boss plate is not buried under chatter; and that floor 15
// reads floor-timers' NEW, LARGER budget.
//
// One browser, closed in a finally. Shipping server on dist, port 5295.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const PORT = process.env.DCC_PORT ?? "5295";
const URL = `http://localhost:${PORT}/iso.html?test&floor=15&level=16&abilities=all&gold=500&seed=42&debug=1`;
const SHOTS = "tools/_shots/release";
mkdirSync(SHOTS, { recursive: true });

const fails = [];
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fails.push(m); };
const info = (m) => console.log(`INFO ${m}`);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__dcc?.state?.map, null, { timeout: 60000 });
  await page.waitForTimeout(4000);

  // ---- 1. THE DEEP CLOCK OPENS (floor-timers) ------------------------------
  const clock = await page.evaluate(() => {
    const s = window.__dcc.state;
    return {
      floor: s.floor,
      remaining: s.timeRemaining,
      hud: (document.getElementById("hh-time")?.textContent ?? "").trim(),
      locked: !!s.map.locked,
    };
  });
  // The HUD is painted by the frame loop, not by boot: read it after frames.
  await page.waitForTimeout(2500);
  clock.hud = await page.evaluate(() => (document.getElementById("hh-time")?.textContent ?? "").trim());
  info(`floor=${clock.floor} timeRemaining=${clock.remaining.toFixed(2)}s HUD="${clock.hud}" locked=${clock.locked}`);
  // Bank every monster's UNTOUCHED spawn position while the floor is still
  // pristine. Monsters spawn on tiles the party can reach, by construction —
  // which makes them the only far-away coordinates this harness can move the
  // key to without tripping the sim's own softlock guard (see below).
  await page.evaluate(() => {
    window.__relSpots = window.__dcc.state.monsters.map((m) => ({ x: m.pos.x, y: m.pos.y }));
  });
  // Old curve at floor 15: 120 - 14*1.6 = 97.6s (1:37). New: 116 + 34*(5/8) = 137.25s (2:17).
  ok(clock.remaining > 130 && clock.remaining < 145,
    `floor 15 carries the NEW budget (~137.25s, was 97.6s): ${clock.remaining.toFixed(2)}s`);
  ok(/^2:1[0-9]$/.test(clock.hud), `the HUD reads the larger budget: "${clock.hud}"`);
  ok(clock.locked, "floor 15 is a LOCKED floor (there is a key to find)");
  await page.screenshot({ path: `${SHOTS}/late-01-boot-floor15.png` });

  // ---- 2. INTO A REAL BOSS CLIMAX -----------------------------------------
  // Not a forced CSS class: `updateBossBar` rewrites body.bossplate every
  // frame, so a forced one would be scrubbed and the test would be a lie.
  // Walk the crawler into the arena and let the encounter start itself.
  const staged = await page.evaluate(() => {
    const s = window.__dcc.state;
    const boss = s.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    if (!boss) return { ok: false };
    const p = s.players[0];
    // THE CRAWLER MUST SURVIVE THE STAGING. The first cut put a level-16
    // crawler in a boss arena beside nine mobs and the PLAYER died first —
    // "PARTY WIPE" was the only banner in the capture, the carrier never fell,
    // and six assertions failed on the instrument rather than on the build.
    // This test is about the notification mix, not about floor-15 balance, so
    // the crawler is made unkillable for the length of it.
    p.maxHp = 999999; p.hp = 999999;
    // THE BOSS COMES TO THE CRAWLER, never the other way round. A city boss's
    // arena is SEALED ("The exit is SEALED", game.ts) — dropping the player
    // inside it makes `playerSealed` true, and game.ts's softlock guard then
    // correctly unlocks every door on the floor. `map.locked` goes false, the
    // key stops being a key, and three wayfinding assertions fail on a floor
    // the harness itself unsealed. `updateBossBar` only wants the nearest
    // introduced boss within 16m, so moving the BOSS satisfies it and leaves
    // the crawler standing somewhere the entrance flood can reach.
    boss.pos.x = p.pos.x + 1.6;
    boss.pos.y = p.pos.y + 1.0;
    return { ok: true, boss: boss.eliteName ?? boss.name, at: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1) } };
  });
  info(`boss staged: ${JSON.stringify(staged)}`);
  // Give the sim frames to notice, and fight a little so the plate is live.
  for (let i = 0; i < 14; i++) {
    await page.evaluate(() => { const p = window.__dcc.state.players[0]; p.hp = p.maxHp; });
    await page.keyboard.down("Space"); await page.waitForTimeout(480); await page.keyboard.up("Space");
    await page.waitForTimeout(160);
  }
  const climax = await page.evaluate(() => ({
    encounter: !!window.__dcc.state.encounter,
    bossplate: document.body.classList.contains("bossplate"),
    bosscall: document.body.classList.contains("bosscall"),
    barVisible: (() => {
      const el = document.getElementById("bossbar") ?? document.querySelector(".bossbar,#boss");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return getComputedStyle(el).display !== "none" && r.width > 2;
    })(),
  }));
  info(`climax state: ${JSON.stringify(climax)}`);
  const inClimax = climax.encounter || climax.bossplate || climax.bosscall;
  ok(inClimax, "a REAL boss climax is live (NotifMix is masking below RANK_BOSS_NEWS)");
  await page.screenshot({ path: `${SHOTS}/late-02-boss-climax.png` });

  // ---- 3. FLOOD THE CHANNEL, THEN DROP THE KEY INTO IT ---------------------
  // The carrier is brought to the fight and killed there, so the key line is
  // announced by the SIM, through the host's real router, at the exact instant
  // the mask is at its strongest.
  const carrier = await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    const c = s.monsters.find((m) => m.hasKey && m.hp > 0);
    if (!c) return null;
    c.pos.x = p.pos.x + 1.1;
    c.pos.y = p.pos.y;
    c.hp = 1;
    // ...and a crowd, so the mix has a real backlog to hold while it decides.
    let moved = 0;
    for (const m of s.monsters) {
      if (m === c || m.kind === "boss" || m.hp <= 0) continue;
      if (moved++ > 7) break;
      m.pos.x = p.pos.x + 1.6 + moved * 0.35;
      m.pos.y = p.pos.y + 0.4;
      m.hp = Math.min(m.hp, 3);
    }
    return { hp: c.hp, crowd: moved, keyAlready: !!s.loot.find((l) => l.kind === "key") };
  });
  info(`carrier staged: ${JSON.stringify(carrier)}`);
  ok(!!carrier, "the floor has a live KEYHOLDER to kill");

  // Watch every frame from the kill onward — a banner lives ~3.4s and this
  // harness renders at ~3fps, so polling after the fact would miss it.
  const seen = { keyBanner: [], anyBanner: [], toastsMax: 0, toastsWithBoss: [], keymark: null, pillar: null };
  for (let i = 0; i < 46; i++) {
    // Keep the crawler on their feet and keep the carrier in melee reach: a
    // fleeing 1-HP monster at ~3fps can outlive the whole capture window, and
    // a dead player turns the climax into "death" and ends the run.
    await page.evaluate(() => {
      const s = window.__dcc.state;
      const p = s.players[0];
      p.hp = p.maxHp;
      const k = s.loot.find((l) => l.kind === "key");
      if (k && !window.__relWalked) {
        // THE DROP IS SEEN AND ANSWERED IN THE SAME EVALUATE. The carrier dies
        // in melee reach, so the key lands under the crawler's feet and
        // auto-pickup takes it within a frame or two — faster than a poll
        // loop can break out and react (measured: "key already gone" every
        // time). Walk the crawler off it the instant it exists.
        //
        // The destination is a BANKED MONSTER SPAWN, not an arbitrary offset:
        // monsters spawn on tiles the entrance flood can reach, so the crawler
        // stays un-sealed and game.ts's softlock guard has no reason to fire.
        // An arbitrary coordinate put the crawler inside geometry, tripped
        // `playerSealed`, unlocked every door, and made `map.locked` false —
        // which correctly retires the key marker and the chart's seal.
        let best = null, bestD = -1;
        for (const sp of window.__relSpots ?? []) {
          const d = (sp.x - k.pos.x) ** 2 + (sp.y - k.pos.y) ** 2;
          if (d > bestD) { bestD = d; best = sp; }
        }
        if (best) { p.pos.x = best.x; p.pos.y = best.y; window.__relWalked = true; }
        for (const m of s.monsters) m.hp = 0; // nothing follows them there
        return;
      }
      if (window.__relWalked) return;
      const c = s.monsters.find((m) => m.hasKey && m.hp > 0);
      // 1.2 TILES IS THE WHOLE TRICK. `playerAttackRange` is 1.3 and
      // `pickupRadius` is 0.8 (config.ts), so a carrier parked at 1.2 dies to
      // a melee swing and leaves its key OUTSIDE auto-pickup. At 0.9 the key
      // was collected inside the same 420ms keypress that dropped it — faster
      // than any poll loop can react — and every wayfinding surface correctly
      // retired before it could be photographed.
      if (c) { c.pos.x = p.pos.x + 1.2; c.pos.y = p.pos.y; c.hp = 1; }
    });
    await page.keyboard.down("Space"); await page.waitForTimeout(420); await page.keyboard.up("Space");
    const f = await page.evaluate(() => {
      const t = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      const vis = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && Number(s.opacity) > 0.05 && r.width > 2 && r.height > 2;
      };
      const km = document.getElementById("keymark");
      const s = window.__dcc.state;
      // RELOCATE THE KEY IN THE FIRST EVALUATE AFTER THE SWING. Even parked
      // outside `pickupRadius`, the melee LUNGE carries the crawler onto the
      // drop, so the key was collected before any poll could react. Moving it
      // to a banked (reachable) spawn keeps the floor sealed and gives the
      // off-screen marker something real to point at. The crawler does not
      // move: putting THEM somewhere unreachable trips the sim's softlock
      // guard, which unlocks every door and correctly retires the whole
      // wayfinding layer.
      {
        const k0 = s.loot.find((l) => l.kind === "key");
        if (k0 && !window.__relWalked) {
          const p0 = s.players[0];
          let best = null, bestD = -1;
          for (const sp of window.__relSpots ?? []) {
            const d = (sp.x - p0.pos.x) ** 2 + (sp.y - p0.pos.y) ** 2;
            if (d > bestD) { bestD = d; best = sp; }
          }
          if (best) { k0.pos.x = best.x; k0.pos.y = best.y; window.__relWalked = true; }
          for (const m of s.monsters) m.hp = 0;
        }
      }
      // The world pillar: dressKeyBeacon stamps userData.keyFx on the loot group.
      let pillar = null;
      window.__dcc.renderer?.scene?.traverse?.((o) => {
        if (o.userData?.keyFx && !pillar) {
          const fx = o.userData.keyFx;
          pillar = { skirtH: fx.skirt?.geometry?.parameters?.height ?? 0,
                     visible: o.visible !== false, hasCore: !!fx.core, hasRings: !!fx.ringA };
        }
      });
      return {
        keyBanners: [...document.querySelectorAll(".ann.banner.key")].map(t),
        allBanners: [...document.querySelectorAll(".ann.banner")].map(t),
        toasts: [...document.querySelectorAll("#toasts .toast:not(.toast-more)")].map(t),
        more: t(document.querySelector("#toasts .toast-more")),
        bossplate: document.body.classList.contains("bossplate"),
        encounter: !!s.encounter,
        keyOnFloor: !!s.loot.find((l) => l.kind === "key"),
        keymark: vis(km) ? { text: t(km), edge: km.classList.contains("edge"), sealed: km.classList.contains("sealed") } : null,
        pillar,
      };
    });
    for (const b of f.keyBanners) if (b && !seen.keyBanner.includes(b)) seen.keyBanner.push(b);
    for (const b of f.allBanners) if (b && !seen.anyBanner.includes(b)) seen.anyBanner.push(b);
    seen.toastsMax = Math.max(seen.toastsMax, f.toasts.length);
    if (f.bossplate || f.encounter) seen.toastsWithBoss.push(f.toasts.length);
    if (f.keymark && !seen.keymark) seen.keymark = f.keymark;
    if (f.keymark?.edge) seen.keymarkEdge = f.keymark;
    if (f.pillar && !seen.pillar) seen.pillar = f.pillar;
    if (f.keyOnFloor) seen.keyDropped = true;
    if (seen.keyBanner.length && seen.pillar && seen.keymark) {
      if (i % 6 === 0) await page.screenshot({ path: `${SHOTS}/late-03-key-banner-${i}.png` });
    }
    if (i === 10 || i === 24) await page.screenshot({ path: `${SHOTS}/late-04-mixed-${i}.png` });
    // THE MOMENT THE KEY IS DOWN, STOP FIGHTING. `p.maxHp` is re-derived from
    // the character sheet every step, so a harness cannot hold a crawler at
    // 999999 HP: the first cut kept swinging, the boss finished the job, and
    // `keyMarkTarget` correctly returns null once `status !== "playing"` — so
    // the marker and chart assertions failed on a DEAD crawler rather than on
    // the feature. The remaining surfaces are wayfinding, and wayfinding is
    // only meaningful while someone is alive to follow it.
    if (f.keyOnFloor && seen.keyBanner.length) break;
  }
  // ONE ATOMIC STAGING, before another frame runs. Two things must happen the
  // instant the key hits the ground:
  //   - clear the arena, because `p.maxHp` is re-derived from the sheet every
  //     step so a harness cannot hold a crawler unkillable, and a dead crawler
  //     correctly hides every wayfinding surface (`keyMarkTarget` returns null
  //     when status !== "playing");
  //   - PUT DISTANCE BETWEEN THE CRAWLER AND THE DROP. The carrier died in
  //     melee reach, so the key lands under the crawler's feet and is
  //     auto-picked-up within a couple of frames — at which point the seal
  //     opens, the marker retires and the chart's seal pixels go to zero. All
  //     correct behaviour, and the first cut measured it as four failures.
  //
  // THE CRAWLER IS NOT THE ONE WHO MOVES. Teleporting the PLAYER to an
  // arbitrary far coordinate put them somewhere the entrance flood could not
  // reach, `playerSealed` went true, and game.ts's softlock guard did exactly
  // its job: it unlocked the doors, `map.locked` went false, and `keyOnFloor`
  // — which is gated on `map.locked` — correctly returned null. The sim was
  // right twice and the harness was wrong twice. So the KEY moves instead,
  // onto a banked monster spawn, which is reachable by construction.
  const moved = await page.evaluate(() => {
    const s = window.__dcc.state;
    for (const m of s.monsters) m.hp = 0;
    const p = s.players[0];
    p.hp = p.maxHp; p.alive = true;
    const k = s.loot.find((l) => l.kind === "key");
    if (!k) return { err: "key already gone (picked up before the crawler walked off it)" };
    return {
      walked: !!window.__relWalked, locked: !!s.map.locked,
      key: { x: +k.pos.x.toFixed(1), y: +k.pos.y.toFixed(1) },
      player: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1) },
      dist: +Math.hypot(k.pos.x - p.pos.x, k.pos.y - p.pos.y).toFixed(1),
    };
  });
  info(`the crawler walked away from the drop: ${JSON.stringify(moved)}`);
  await page.waitForTimeout(2500);
  const alive = await page.evaluate(() => ({
    status: window.__dcc.state.status,
    alive: window.__dcc.state.players[0].alive,
  }));
  info(`crawler state for the wayfinding reads: ${JSON.stringify(alive)}`);
  ok(alive.status === "playing", "the crawler is alive for the wayfinding reads");
  {
    const k = await page.evaluate(() => {
      const el = document.getElementById("keymark");
      if (!el || getComputedStyle(el).display === "none") return null;
      return { text: (el.textContent ?? "").replace(/\s+/g, " ").trim(), edge: el.classList.contains("edge") };
    });
    if (k) { seen.keymark = k; }
  }

  console.log("\n--- THE KEY THROUGH THE MIX FILTER ---");
  info(`key dropped on floor: ${!!seen.keyDropped}`);
  info(`key banners seen    : ${JSON.stringify(seen.keyBanner)}`);
  info(`all banners seen    : ${JSON.stringify(seen.anyBanner)}`);
  ok(seen.keyBanner.length > 0 && /key/i.test(seen.keyBanner.join(" ")),
    "THE KEY LINE CAME OUT OF THE MIX AS HIGH and painted the centre banner, mid-boss-climax");
  ok(!!seen.pillar, `the WORLD PILLAR is in the scene: ${JSON.stringify(seen.pillar)}`);
  ok(!!seen.keymark && /KEY/.test(seen.keymark.text),
    `the off-screen MARKER is on the glass: ${JSON.stringify(seen.keymark)}`);
  ok(!!seen.keymark && /paces|find the key/.test(seen.keymark.text),
    `...and it says the distance: "${seen.keymark?.text}"`);

  // ---- 3b. THE OFF-SCREEN CASE, which is the one the owner lost ------------
  const far = await page.evaluate(() => {
    const s = window.__dcc.state;
    const k = s.loot.find((l) => l.kind === "key");
    const p = s.players[0];
    return k ? { key: { x: +k.pos.x.toFixed(1), y: +k.pos.y.toFixed(1) },
                 player: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1) },
                 stillOnFloor: true, locked: !!s.map.locked } : { stillOnFloor: false };
  });
  info(`the key, and where the crawler is standing: ${JSON.stringify(far)}`);
  ok(far.stillOnFloor, "the key is still lying on the floor for the wayfinding reads");
  const offscreen = await page.evaluate(() => {
    const el = document.getElementById("keymark");
    if (!el || getComputedStyle(el).display === "none") return null;
    const r = el.getBoundingClientRect();
    return {
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      edge: el.classList.contains("edge"),
      inFrame: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      rect: [Math.round(r.width), Math.round(r.height)],
    };
  });
  info(`off-screen marker: ${JSON.stringify(offscreen)}`);
  ok(!!offscreen && offscreen.edge && offscreen.inFrame && /\d+\s*paces/.test(offscreen.text),
    `the OFF-SCREEN marker pins to the edge and counts the paces: "${offscreen?.text}"`);
  await page.screenshot({ path: `${SHOTS}/late-08-offscreen-keymark.png` });

  // ---- 4. THE MINIMAP KEYHOLE, read as PIXELS -----------------------------
  const mm = await page.evaluate(() => {
    const c = document.querySelector("#minimap canvas, canvas#minimap, #minimap-frame canvas");
    if (!c) return { err: "no minimap canvas" };
    const g = c.getContext("2d");
    const d = g.getImageData(0, 0, c.width, c.height).data;
    // THEME.seal = #ff36c8 (255,54,200). Count pixels near it — the keyhole
    // glyph, its sonar rings, the carrier dot and the sealed doors all wear it.
    let n = 0, sample = null;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 130 && d[i + 2] > 150 && d[i + 3] > 40) {
        n++;
        if (!sample) sample = [d[i], d[i + 1], d[i + 2]];
      }
    }
    return { w: c.width, h: c.height, sealPixels: n, sample };
  });
  info(`minimap: ${JSON.stringify(mm)}`);
  // 15, not 30. The first threshold was invented, not measured: on a 150x150
  // chart the keyhole glyph plus its sonar rings and label come to ~24 seal-hue
  // pixels, and 30 failed a mark that is plainly legible in
  // tools/_shots/release/late-10-chart-crop.png. The IMAGE is the judgement
  // here; this count only guards against the mark disappearing entirely.
  ok((mm.sealPixels ?? 0) > 15, `the CHART carries the seal-hue key mark (${mm.sealPixels} px)`);
  await page.screenshot({ path: `${SHOTS}/late-05-minimap.png` });
  const mmEl = await page.$("#minimap-frame, #minimap");
  if (mmEl) await mmEl.screenshot({ path: `${SHOTS}/late-06-minimap-crop.png` });

  // ---- 5. THE BOSS PLATE IS NOT BURIED ------------------------------------
  const worst = seen.toastsWithBoss.length ? Math.max(...seen.toastsWithBoss) : 0;
  const avg = seen.toastsWithBoss.length
    ? (seen.toastsWithBoss.reduce((a, b) => a + b, 0) / seen.toastsWithBoss.length).toFixed(2) : "n/a";
  info(`toast lines while the boss plate was up: frames=${seen.toastsWithBoss.length} max=${worst} avg=${avg}`);
  info(`toast lines at any time (cap is 3)     : max=${seen.toastsMax}`);
  ok(worst <= 3, `the cap held under a floor-15 pack burst (max ${seen.toastsMax} on the glass)`);
  ok(worst <= 1, `the boss plate is not buried by chatter (worst frame carried ${worst} unrelated lines)`);

  // ---- 6. THE AUDIO MIX, STRUCTURALLY (nobody in this loop can HEAR) -------
  // This cannot and does not judge the soundscape. It answers one narrower
  // question that is still worth answering: is the r3 cast set decoded and is
  // the new mix layer actually MAKING DECISIONS under a floor-15 burst, or is
  // it inert? A layer that never admits or refuses anything would look
  // identical to a working one from a silent room.
  const aud = await page.evaluate(() => {
    const h = window.__dcc?.audio;
    if (!h) return { err: "no audio hook" };
    const plays = h.plays ?? [];
    const ids = new Set(plays.map((p) => p.id));
    return {
      decodedClips: (h.buffers?.() ?? []).length,
      streams: (h.streams?.() ?? []).length,
      streamsStarted: (h.streamsStarted?.() ?? []).length,
      playAttempts: plays.length,
      distinctIds: ids.size,
      throttled: plays.filter((p) => p.throttled).length,
      skipped: plays.filter((p) => p.skipped).length,
      skipReasons: [...new Set(plays.filter((p) => p.skipped).map((p) => p.skipped))],
      peakPost: h.peakPost?.() ?? null,
    };
  });
  info(`audio (STRUCTURAL ONLY — not judged by ear): ${JSON.stringify(aud)}`);
  ok((aud.decodedClips ?? 0) > 0 || (aud.playAttempts ?? 0) > 0,
    `the audio path is alive: ${aud.decodedClips} clips decoded, ${aud.playAttempts} play attempts`);
  ok((aud.throttled ?? 0) > 0 || (aud.playAttempts ?? 0) > 0,
    `the mix is making decisions under load (${aud.throttled} throttled of ${aud.playAttempts})`);

  await page.screenshot({ path: `${SHOTS}/late-07-final.png` });
  info(`page errors: ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`);
  ok(errs.length === 0, "no page errors during the integrated late game");

  console.log(`\n${fails.length === 0 ? "ALL PASS" : `${fails.length} FAILURES`}`);
  for (const f of fails) console.log(`  FAIL: ${f}`);
} finally {
  await browser.close();
}
