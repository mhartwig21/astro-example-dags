#!/usr/bin/env node
// tools/audio/probe-beds.mjs — Music r1's in-game verification (SOUNDPLAN §5:
// nobody in this loop can hear, so the beds are verified FIRING, not "sounding
// great"). One Chromium, one run, asserts with numbers:
//
//   1. MENU BED      — the real check-in screen (non-test load) raises
//                      music_menu once the context unlocks.
//   2. BAND BED      — floor 3 ambience is music_band_undercroft (the band
//                      routing, live, with the real decoded files).
//   3. APPROACH DUCK — parked in the corridor of an un-introduced boss, the
//                      music bus rides to ~0.22; the boss dying releases it
//                      (BOSSES V2 §5.1 over the new beds). While the corridor
//                      holds the room, the §2.3 TIE RULE is asserted too: an
//                      announcer stinger must NOT stack a second duck on top.
//   4. ANNOUNCER DUCK— ident_high over the LIVE floor-4 band bed (no boss
//                      holding the room): music duck gain down >= 4dB within
//                      150ms, released within 1.5s of the clip end (§2.3).
//   5. THE DESCENT   — player teleported to the stairs, REAL 'e' keypress,
//                      REAL #sr-descend click: safe room raises music_safe,
//                      floor 4 raises music_band_sewers. The 3→4 band
//                      transition is a bed swap you can watch in the ring.
//   6. NO HARD CLIP  — compressor output < 1.0 across the whole session.
//
// Usage: node tools/audio/probe-beds.mjs [--headless]
// MACHINE LIMIT: exactly one Chromium; launch, use, CLOSE.

import { chromium } from "playwright";

const headed = !process.argv.includes("--headless");
const BASE = "http://localhost:5282/iso.html";
const TEST_URL = `${BASE}?test&floor=3&level=12&abilities=all&seed=7&debug=1&noassets`;
const MENU_URL = `${BASE}?debug=1&noassets`;

const fail = [];
const report = {};

const browser = await chromium.launch({
  headless: !headed,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    ...(headed ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] : []),
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.addInitScript(() => localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 })));

  const bootGate = async () => {
    await page.waitForFunction(() => {
      const el = document.getElementById("loading");
      if (!el) return true;
      const cs = getComputedStyle(el);
      return el.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, { timeout: 90000 });
    await page.waitForTimeout(1500);
  };
  const waitMusic = async (want, timeout = 25000) => {
    try {
      await page.waitForFunction(
        (w) => window.__dcc?.audio?.currentMusic() === w, want, { timeout },
      );
      return true;
    } catch {
      return false;
    }
  };

  // ---- 1. MENU BED: the real check-in screen --------------------------------
  await page.goto(MENU_URL, { waitUntil: "domcontentloaded" });
  await bootGate();
  await page.keyboard.press("]"); // any keydown unlocks the AudioContext
  await page.waitForTimeout(400);
  report.menu = {
    ctx: await page.evaluate(() => window.__dcc.audio.ctxState()),
    menuVisible: await page.evaluate(() => document.getElementById("menu")?.style.display === "flex"),
    bedRaised: await waitMusic("music_menu"),
    music: null,
  };
  report.menu.music = await page.evaluate(() => window.__dcc.audio.currentMusic());
  if (!report.menu.menuVisible) fail.push("menu probe: check-in screen not visible on a fresh load");
  if (!report.menu.bedRaised) fail.push(`menu bed: expected music_menu, got ${report.menu.music}`);

  // ---- 2. BAND BED on floor 3 ----------------------------------------------
  await page.goto(TEST_URL, { waitUntil: "domcontentloaded" });
  await bootGate();
  await page.mouse.click(640, 400);
  await page.waitForTimeout(300);
  const ctxState = await page.evaluate(() => window.__dcc.audio.ctxState());
  if (ctxState !== "running") { fail.push(`AudioContext ${ctxState} (need running)`); throw new Error("no ctx"); }
  await page.evaluate(() => window.__dcc.audio.resetPeaks());
  report.floor3 = {
    bedRaised: await waitMusic("music_band_undercroft"),
    music: await page.evaluate(() => window.__dcc.audio.currentMusic()),
    decodedBeds: await page.evaluate(() =>
      window.__dcc.audio.buffers().filter((b) => b.startsWith("music_")).sort()),
  };
  if (!report.floor3.bedRaised) fail.push(`floor-3 bed: expected music_band_undercroft, got ${report.floor3.music}`);

  // ---- 3. APPROACH DUCK: the corridor, then the boss falls -------------------
  // Pin the scene (HARNESS rule 6): the boss HUNTS — a one-shot teleport
  // measured 0.932 (boss walked inside BOSS_EARSHOT and cancelled the
  // corridor). Re-pin the player to 30 tiles from the boss's CURRENT position
  // every 200ms: inside APPROACH_RANGE (34), outside BOSS_EARSHOT (26).
  const staged = await page.evaluate(() => {
    const s = window.__dcc.state;
    const boss = s.monsters.find((m) => m.kind === "boss");
    if (!boss) return null;
    window.__pin = setInterval(() => {
      const st = window.__dcc.state;
      const b = st.monsters.find((m) => m.kind === "boss");
      const p = st.players[0];
      if (!b || !p) return;
      p.maxHp = 999999; p.hp = 999999; // the corridor must not kill the probe
      const dx = p.pos.x - b.pos.x, dy = p.pos.y - b.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      p.pos.x = b.pos.x + (dx / d) * 30;
      p.pos.y = b.pos.y + (dy / d) * 30;
    }, 200);
    return { bossAt: { ...boss.pos }, introduced: !!boss.introduced, dist: 30 };
  });
  if (!staged) fail.push("approach: no boss on floor 3 (staging failed)");
  else {
    await page.waitForTimeout(3000); // duck() timeConstant 0.5s → settled ~99%
    const inCorridor = await page.evaluate(() => window.__dcc.audio.musicBusGain());
    // §2.3 TIE RULE, live: while the approach duck holds the music bus under
    // 0.5, an announcer stinger must NOT stack its sidechain on top.
    const tie = await page.evaluate(async () => {
      const a = window.__dcc.audio;
      a.trigger("ident_high", { force: true });
      await new Promise((r) => setTimeout(r, 150));
      return a.musicDuckGain();
    });
    await page.waitForTimeout(3000); // let the stinger tail out of the room
    await page.evaluate(() => {
      clearInterval(window.__pin);
      const s = window.__dcc.state;
      for (const m of s.monsters) if (m.kind === "boss") { m.hp = 0; m.maxHp = Math.max(1, m.maxHp); }
    });
    await page.waitForTimeout(3500); // reap + release
    const released = await page.evaluate(() => window.__dcc.audio.musicBusGain());
    report.approach = {
      introduced: staged.introduced,
      inCorridor: Number(inCorridor.toFixed(3)),
      tieRuleSidechain: Number(tie.toFixed(3)),
      released: Number(released.toFixed(3)),
    };
    if (staged.introduced) fail.push("approach: boss already introduced at spawn — corridor never staged");
    if (inCorridor > 0.5) fail.push(`approach duck: music bus at ${inCorridor.toFixed(3)} in the corridor (want ~0.22, <0.5)`);
    if (tie < 0.9) fail.push(`tie rule broken: sidechain stacked to ${tie.toFixed(3)} over the approach duck`);
    if (released < 0.8) fail.push(`approach duck stuck: music bus ${released.toFixed(3)} after the boss fell (want >0.8)`);
  }

  // ---- 5. THE DESCENT: stairs key, safe room bed, floor-4 band bed -----------
  const sealed = await page.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y;
    // tryDescend's actual gate: any boss still in the list seals the exit.
    return s.monsters.some((m) => m.kind === "boss");
  });
  if (sealed) fail.push("descent: the boss is still in the monster list — exit sealed");
  await page.waitForTimeout(300);
  await page.keyboard.press("e"); // the real stairs bind
  try {
    await page.waitForFunction(() => window.__dcc.state.safeRoom !== null, { timeout: 5000 });
  } catch {
    fail.push("descent: pressing 'e' on the stairs did not open the safe room");
  }
  report.safeRoom = {
    opened: await page.evaluate(() => window.__dcc.state.safeRoom !== null),
    bedRaised: await waitMusic("music_safe", 8000),
  };
  if (report.safeRoom.opened && !report.safeRoom.bedRaised)
    fail.push(`safe room bed: expected music_safe, got ${await page.evaluate(() => window.__dcc.audio.currentMusic())}`);

  await page.click("#sr-descend");
  try {
    await page.waitForFunction(() => window.__dcc.state.floor === 4, { timeout: 5000 });
  } catch {
    fail.push("descent: DESCEND click did not land the party on floor 4");
  }
  // The descent sponsor draft PAUSES the sim (main3d gates stepping on the
  // overlay), which pins the battle linger forever — dismiss it the way a
  // player can (Escape banks the picks behind the badge).
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => document.getElementById("draft")?.style.display === "flex");
    if (!open) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
  report.draftDismissed = await page.evaluate(() => document.getElementById("draft")?.style.display !== "flex");
  // Pin the scene (HARNESS rule 6): a spawn-camping pack would raise the
  // battle bed and confound the AMBIENCE assertion — push everything out of
  // aggro range so floor 4's resting state is what gets measured.
  await page.evaluate(() => {
    const s = window.__dcc.state;
    for (const m of s.monsters) { m.pos.x += 200; m.pos.y += 200; }
  });
  report.floor4 = {
    floor: await page.evaluate(() => window.__dcc.state.floor),
    bedRaised: await waitMusic("music_band_sewers", 15000),
    music: await page.evaluate(() => window.__dcc.audio.currentMusic()),
    // The ring's own record of the swap (the engine logged the request):
    musicSwaps: await page.evaluate(() =>
      window.__dcc.audio.plays.filter((p) => p.id.startsWith("music:")).map((p) => p.id)),
  };
  if (!report.floor4.bedRaised)
    fail.push(`band transition: floor 4 bed is ${report.floor4.music}, expected music_band_sewers`);

  // ---- 4 (deferred). ANNOUNCER DUCK over the live floor-4 band bed -----------
  // Floor 4 has no boss, so no approach duck holds the room and the §2.3
  // sidechain is free to engage — the honest place to measure it.
  report.duck = await page.evaluate(async () => {
    const a = window.__dcc.audio;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && a.musicDuckGain() < 0.98; i++) await sleep(100);
    const baseline = a.musicDuckGain();
    a.trigger("ident_high", { force: true });
    await sleep(150);
    const at150 = a.musicDuckGain();
    const sfxAt150 = a.sfxDuckGain();
    await sleep(1400 + 1500);
    return { baseline, at150, sfxAt150, released: a.musicDuckGain() };
  });
  report.duck.at150Db = Number((20 * Math.log10(report.duck.at150 / Math.max(1e-6, report.duck.baseline))).toFixed(1));
  if (report.duck.at150 > report.duck.baseline * 0.63)
    fail.push(`announcer duck only ${report.duck.at150.toFixed(3)} at 150ms (need >=4dB below ${report.duck.baseline.toFixed(3)})`);
  if (report.duck.released < 0.9) fail.push(`announcer duck release incomplete (${report.duck.released.toFixed(3)})`);

  // ---- 6. headroom across the whole session ---------------------------------
  report.headroom = await page.evaluate(() => ({
    peakCompressorIn: Number(window.__dcc.audio.peakPre().toFixed(3)),
    peakCompressorOut: Number(window.__dcc.audio.peakPost().toFixed(3)),
  }));
  if (report.headroom.peakCompressorOut >= 1.0)
    fail.push(`hard clip: compressor output ${report.headroom.peakCompressorOut}`);
} finally {
  await browser.close().catch(() => {});
}

console.log(JSON.stringify(report, null, 2));
if (fail.length) {
  console.error("\nPROBE FAIL:\n- " + fail.join("\n- "));
  process.exit(1);
}
console.error("\nPROBE PASS");
