// BOSS KIT TRACE: park a crawler in front of each band boss, drive the sim
// deterministically for 90 sim-seconds, and count what the boss actually DOES —
// which windups it commits, which hazards it lays, phases, adds. Empirical
// answer to "what does this fight ask the player to do".
import { chromium } from "playwright";

const PORT = 5360;
const FLOORS = [3, 6, 9, 12, 15, 18];

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

for (const floor of FLOORS) {
  const url = `http://localhost:${PORT}/iso.html?test&debug=1&clean=1&floor=${floor}&level=${Math.min(20, floor + 4)}&abilities=all&seed=11&eagerassets`;
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.step, null, { timeout: 120000 });
  const out = await page.evaluate(() => {
    const dcc = window.__dcc;
    const st = dcc.state;
    const p = st.players[0];
    const boss = st.monsters.find((m) => m.kind === "boss");
    if (!boss) return null;
    // Park the crawler at melee-ish range; keep every OTHER monster out of the
    // way so we measure the BOSS's kit, not the crowd's.
    for (const m of st.monsters) if (m !== boss) { m.pos.x = boss.pos.x + 60; m.pos.y = boss.pos.y + 60; m.dormant = true; }
    p.pos.x = boss.pos.x + 2.2; p.pos.y = boss.pos.y;
    boss.introduced = true;
    const windups = {}, hazards = {}, phases = [];
    let adds = 0, dmgTaken = 0, lastWindup = null, lastPhase = boss.phase ?? 0;
    let seenHaz = new Set(st.hazards.map((h) => h.id));
    let seenMon = new Set(st.monsters.map((m) => m.id));
    const dt = 1 / 60;
    for (let i = 0; i < 90 * 60; i++) {
      p.hp = p.maxHp; // immortal observer: we want the boss's full rotation
      boss.hp = Math.max(boss.maxHp * 0.05, boss.hp); // never let it die
      // Drive it down through the phase gates on a schedule so phase kit shows.
      if (i === 20 * 60) boss.hp = boss.maxHp * 0.65;
      if (i === 50 * 60) boss.hp = boss.maxHp * 0.30;
      const before = p.hp;
      dcc.step([{ playerId: p.id, move: { x: 0, y: 0 } }], dt);
      dmgTaken += Math.max(0, before - p.hp);
      if (boss.windupKind && boss.windupKind !== lastWindup) {
        windups[boss.windupKind] = (windups[boss.windupKind] ?? 0) + 1;
      }
      lastWindup = boss.windupKind ?? null;
      for (const h of st.hazards) if (!seenHaz.has(h.id)) { seenHaz.add(h.id); hazards[h.kind] = (hazards[h.kind] ?? 0) + 1; }
      for (const m of st.monsters) if (!seenMon.has(m.id)) { seenMon.add(m.id); adds++; }
      if ((boss.phase ?? 0) !== lastPhase) { phases.push({ t: +(i / 60).toFixed(1), phase: boss.phase }); lastPhase = boss.phase ?? 0; }
    }
    return {
      name: boss.eliteName ?? "THE BOSS", tier: boss.bossTier ?? 0, sig: boss.signature ?? null,
      windups, hazards, adds, phases, projectiles: st.projectiles.length,
      dmgTakenPer10s: +(dmgTaken / 9).toFixed(0), playerMaxHp: p.maxHp,
    };
  });
  if (!out) { console.log(`floor ${floor}: no boss`); continue; }
  console.log(`\n--- floor ${floor}: ${out.name} (tier ${out.tier}, sig ${out.sig}) ---`);
  console.log(`  windups committed (90s): ${JSON.stringify(out.windups)}`);
  console.log(`  hazards spawned:         ${JSON.stringify(out.hazards)}`);
  console.log(`  adds spawned: ${out.adds} | phases: ${JSON.stringify(out.phases)}`);
  console.log(`  dmg to a STATIONARY crawler: ${out.dmgTakenPer10s}/10s (player maxHp ${out.playerMaxHp})`);
}
await browser.close();
