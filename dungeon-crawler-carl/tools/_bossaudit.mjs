// BOSS AUDIT (bosses-v2): boot every boss floor across three seeds and dump
// what the player actually MEETS — identity, kit, arena, adds — so the
// "how much repeats across three runs" math is measured, not guessed.
import { chromium } from "playwright";

const PORT = 5360;
const FLOORS = [3, 6, 9, 12, 15, 18];
const SEEDS = [11, 22, 33];

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));

const rows = [];
for (const seed of SEEDS) {
  for (const floor of FLOORS) {
    const url = `http://localhost:${PORT}/iso.html?test&debug=1&clean=1&floor=${floor}&level=${Math.min(20, floor + 4)}&abilities=all&seed=${seed}&eagerassets`;
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.__dcc && !!window.__dcc.state, null, { timeout: 120000 });
    const info = await page.evaluate(() => {
      const st = window.__dcc.state;
      const boss = st.monsters.find((m) => m.kind === "boss");
      const counts = {};
      for (const m of st.monsters) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
      const elites = st.monsters.filter((m) => m.elite).map((m) => ({
        name: m.eliteName, kind: m.kind, affix: m.affix ?? null,
      }));
      const rm = st.map.rooms.find((r) =>
        st.map.stairs.x >= r.x && st.map.stairs.x < r.x + r.w &&
        st.map.stairs.y >= r.y && st.map.stairs.y < r.y + r.h);
      return {
        boss: boss ? {
          name: boss.eliteName ?? null, hp: boss.maxHp, dmg: Math.round(boss.damage),
          tier: boss.bossTier ?? 0, sig: boss.signature ?? null, xp: boss.xp,
        } : null,
        arena: rm ? { w: rm.w, h: rm.h } : null,
        breakablesInArena: (st.breakables ?? []).filter((b) =>
          rm && b.pos.x >= rm.x && b.pos.x < rm.x + rm.w && b.pos.y >= rm.y && b.pos.y < rm.y + rm.h).length,
        monsterTotal: st.monsters.length,
        counts, elites,
      };
    });
    rows.push({ seed, floor, ...info });
    const b = info.boss;
    console.log(
      `seed ${seed} floor ${String(floor).padStart(2)} | ` +
      (b ? `${(b.name ?? "THE BOSS").padEnd(26)} sig=${String(b.sig).padEnd(11)} tier=${b.tier} hp=${String(b.hp).padStart(6)} dmg=${String(b.dmg).padStart(3)}` : "NO BOSS") +
      ` | arena ${info.arena ? info.arena.w + "x" + info.arena.h : "?"}` +
      ` breakables=${info.breakablesInArena} mobs=${info.monsterTotal}`);
  }
}

console.log("\n==== REPETITION ACROSS 3 RUNS ====");
for (const floor of FLOORS) {
  const r = rows.filter((x) => x.floor === floor);
  const names = new Set(r.map((x) => x.boss?.name ?? "THE BOSS"));
  const sigs = new Set(r.map((x) => String(x.boss?.sig)));
  const hps = new Set(r.map((x) => x.boss?.hp));
  const arenas = new Set(r.map((x) => x.arena ? `${x.arena.w}x${x.arena.h}` : "?"));
  console.log(
    `floor ${String(floor).padStart(2)}: names=${names.size} [${[...names].join(", ")}]` +
    ` | sigs=${sigs.size} [${[...sigs].join(", ")}]` +
    ` | HP variants=${hps.size} | arena sizes=${arenas.size} [${[...arenas].join(", ")}]`);
}
console.log("\n==== ELITES DRAWN ====");
for (const floor of FLOORS) {
  const r = rows.filter((x) => x.floor === floor);
  console.log(`floor ${floor}: ` + r.map((x) => `s${x.seed}=[${x.elites.map((e) => e.name + "/" + e.kind + (e.affix ? "/" + e.affix : "")).join(" ")}]`).join("  "));
}
await browser.close();
