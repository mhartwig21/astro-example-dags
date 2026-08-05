#!/usr/bin/env node
// tools/audio/verify-r2-casts.mjs — the cast-roster half of the r2 final
// verification, run alone and with RETRIES. The first pass (verify-r2.mjs)
// drove all 16 abilities once each and two of them — melee and dash, the two
// cast FIRST, while the floor-9 boss intro was on screen — never reached
// doPlayerAttack/doDash at all (cooldown still 0 after the step, dashCharges
// unspent). A cue that cannot fire because the CAST did not happen is a
// staging failure, not an audio failure, and the honest way to tell them apart
// is to retry until the sim confirms the cast, then read the ring.
//
// MACHINE LIMIT: one chromium, launched here, closed here.
// Usage: node tools/audio/verify-r2-casts.mjs [--port 5287]

import { chromium } from "playwright";

const portArg = process.argv.indexOf("--port");
const PORT = portArg >= 0 ? process.argv[portArg + 1] : "5287";
const URL = `http://localhost:${PORT}/iso.html?test&floor=9&level=12&abilities=all&seed=42&debug=1&noassets`;

const ROSTER = [
  "melee", "dash", "bolt", "nova", "orbit", "stance", "overcharge",
  "cutto", "crowdsurf", "stuntdouble", "bulwark", "cables",
  "airstrike", "cataclysm", "bullettime", "injunction",
];
const EXPECT = {
  melee: "swing", dash: "cast_dash", bolt: "bolt", nova: "nova",
  orbit: "cast_orbit", stance: "cast_stance", overcharge: "cast_overcharge",
  cutto: "cast_cutto", crowdsurf: "cast_crowdsurf", stuntdouble: "cast_stuntdouble",
  bulwark: "cast_bulwark", cables: "cast_cables", airstrike: "cast_airstrike",
  cataclysm: "cast_cataclysm", bullettime: "cast_bullettime", injunction: "cast_injunction",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=d3d11", "--force_high_performance_gpu", "--autoplay-policy=no-user-gesture-required"],
});
const out = { rows: [], monsters: null };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.addInitScript(() =>
    localStorage.setItem("dcc:audio:v1", JSON.stringify({ muted: false, volume: 0.8 })));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el) return true;
    const cs = getComputedStyle(el);
    return el.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, { timeout: 180000 });
  await page.mouse.click(640, 400);
  await page.keyboard.press("]");
  await page.waitForFunction(() => window.__dcc?.audio?.ctxState() === "running", { timeout: 60000 });
  // Let the boss intro / opening announcements clear before the first cast.
  await sleep(12000);

  for (const ab of ROSTER) {
    let row = null;
    for (let attempt = 1; attempt <= 4 && (!row || !row.fired); attempt++) {
      row = await page.evaluate(async ([ability, expected]) => {
        const nap = (ms) => new Promise((r) => setTimeout(r, ms));
        const a = window.__dcc.audio;
        const s = window.__dcc.state;
        const p = s.players[0];
        p.alive = true; p.maxHp = Math.max(p.maxHp, 99999); p.hp = p.maxHp;
        p.downedT = 0; p.barrageT = 0; p.rootT = 0; p.dashTime = 0;
        p.stagger = 0; p.channelT = 0;
        p.facing = { x: 1, y: 0 };
        p.abilities.ranks[ability] = Math.max(1, p.abilities.ranks[ability] ?? 0);
        p.abilities.slots[0] = ability;
        p.cd[ability] = 0;
        p.dashCharges = Math.max(2, p.dashCharges ?? 2);
        if (p.cutCharges !== undefined) p.cutCharges = Math.max(2, p.cutCharges);
        // Targeted casts (Blindside, Extradition) return early without a body
        // along the aim: put three live monsters 4 tiles ahead.
        const near = s.monsters.filter((m) => m.hp > 0).slice(0, 3);
        near.forEach((m, i) => {
          m.pos.x = p.pos.x + 4 + i * 0.6; m.pos.y = p.pos.y + i * 0.4;
          m.hp = Math.max(m.hp, 2000); m.maxHp = Math.max(m.maxHp, 2000);
          m.stagger = 0;
        });
        const before = { cd: p.cd[ability] ?? 0, dash: p.dashCharges, cut: p.cutCharges, swing: p.attackSwing };
        const mark = performance.now();
        window.__dcc.step({ [p.id]: {
          move: { x: 0, y: 0 }, useStairs: false, aim: { x: 1, y: 0 },
          cast: [true, false, false, false, false],
        } }, 0.016);
        const after = { cd: p.cd[ability] ?? 0, dash: p.dashCharges, cut: p.cutCharges, swing: p.attackSwing };
        // Did the SIM cast? (cooldown armed, a charge spent, or a swing started)
        const simCast = after.cd > before.cd + 1e-6 || after.dash < before.dash ||
          (after.cut !== undefined && before.cut !== undefined && after.cut < before.cut) ||
          after.swing > before.swing + 1e-6;
        await nap(1800);
        const fresh = a.plays.filter((r) => r.at >= mark);
        const ring = fresh.map((r) => ({ id: r.id, gain: Number(r.gain.toFixed(3)),
          throttled: !!r.throttled, skipped: r.skipped ?? null }));
        const hit = ring.find((r) => r.id === expected && !r.throttled && !r.skipped);
        const any = ring.find((r) => r.id === expected);
        return {
          ability, expected, simCast, before, after,
          monstersInRange: near.length,
          ring, fired: !!hit,
          note: hit ? "" : any ? (any.throttled ? "throttled" : `skipped:${any.skipped}`)
              : simCast ? "sim cast but NO CUE" : "sim did not cast",
        };
      }, [ab, EXPECT[ab]]);
      row.attempt = attempt;
      if (row.fired) break;
      await sleep(1200);
    }
    out.rows.push(row);
    await sleep(400);
  }
  out.headroom = await page.evaluate(() => ({
    peakCompressorIn: Number(window.__dcc.audio.peakPre().toFixed(3)),
    peakCompressorOut: Number(window.__dcc.audio.peakPost().toFixed(3)),
  }));
  out.decodedCastClips = await page.evaluate(() =>
    window.__dcc.audio.buffers().filter((b) => b.startsWith("cast_") || b === "swing" ||
      b === "bolt" || b === "nova" || b === "chain_line" || b === "weapon_flash" || b === "level_up").sort());
} finally {
  await browser.close().catch(() => {});
}
console.log(JSON.stringify(out, null, 2));
