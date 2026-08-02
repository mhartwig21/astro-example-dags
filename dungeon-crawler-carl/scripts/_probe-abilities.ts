/* Throwaway audit probe for ABILITIES-V2. Not shipped. */
import { CONFIG } from "../src/sim/config";
import { createTestGame } from "../src/sim/game";
import {
  meleeParams, boltParams, novaParams, orbitParams, dashParams, overchargeParams,
  cutToParams, crowdSurfParams, stuntDoubleParams, airstrikeParams, cataclysmParams,
  bulletTimeParams, stanceMult, UPGRADES,
} from "../src/sim/abilities";

function report(floor: number, level: number, seed: number) {
  const g = createTestGame({ seed, floor, level, abilities: "all" });
  const p = g.players[0];
  const ap = p.attackPower, sp = p.spellPower;
  const mp = meleeParams(p), bp = boltParams(p), np = novaParams(p), op = orbitParams(p);
  const dp = dashParams(p), ocp = overchargeParams(p), cp = cutToParams(p);
  const csp = crowdSurfParams(p), sdp = stuntDoubleParams(p);
  const asp = airstrikeParams(p), cap = cataclysmParams(p), btp = bulletTimeParams(p);
  const meleeHit = ap * mp.damageMult;
  const rows: [string, number, number, string][] = [
    ["melee", meleeHit, mp.cooldown, "arc " + (mp.arc * 180 / Math.PI).toFixed(0) + "deg rng " + mp.range.toFixed(2)],
    ["bolt", bp.dmg * bp.count, bp.cooldown, "n=" + bp.count + " pierce=" + bp.pierce + " chill=" + bp.chill],
    ["nova", sp * np.damageMult, np.cooldown, "r=" + np.radius.toFixed(2) + " (x N targets)"],
    ["orbit", ap * op.damageMult * op.blades, op.tickSeconds, "blades=" + op.blades + " r=" + op.radius],
    ["dash(shock)", sp * dp.shockMult, dp.cooldown, "dist=" + dp.distance.toFixed(2)],
    ["cutto", ap * cp.dmgMult, cp.cooldown, "range=" + cp.range.toFixed(1)],
    ["crowdsurf", ap * csp.diveFrac, csp.cooldown, "range=" + csp.range.toFixed(1) + " stagger=" + csp.stagger],
    ["stuntdouble", ap * sdp.mirrorFrac, sdp.cooldown, "contract=" + sdp.contract + "s taunt=" + sdp.tauntRadius.toFixed(1)],
    ["overcharge", meleeHit * ocp.mult, ocp.cooldown, "mult=" + ocp.mult.toFixed(2) + " echo=" + ocp.echoFrac],
    ["ULT airstrike", ap * asp.dmgMult * asp.shells, asp.cooldown, "shells=" + asp.shells + " spread=" + asp.spread.toFixed(2)],
    ["ULT cataclysm", sp * cap.dmgMult, cap.cooldown, "r=" + cap.radius.toFixed(1) + " echo=" + cap.echoFrac],
    ["ULT bullettime", 0, btp.cooldown, "dur=" + btp.duration + "s crit+" + btp.critBonus],
  ];
  console.log("\n=== floor " + floor + " level " + level + " seed " + seed + " | AP " + ap.toFixed(0) + " SP " + sp.toFixed(0) + " maxHp " + p.maxHp + " ===");
  console.log("slots: " + JSON.stringify(p.abilities.slots) + " ult=" + p.abilities.ultimate + " bench=" + p.abilities.bench.join(","));
  console.log("stanceMult(melee)=" + stanceMult(p, "melee").toFixed(2) + " glyphs=" + JSON.stringify(p.glyphs?.slots) + " ultglyph=" + JSON.stringify(p.glyphs?.ultimate));
  const gruntHp = g.monsters.find((m) => m.kind === "grunt" && !m.elite && !m.veteran)?.maxHp ?? 0;
  console.log("plain grunt hp on this floor: " + gruntHp);
  for (const [name, hit, cd, note] of rows) {
    const dps = cd > 0 ? hit / cd : hit;
    console.log("  " + name.padEnd(15) + " hit=" + hit.toFixed(0).padStart(6) + " cd=" + cd.toFixed(2).padStart(6) + " dps=" + dps.toFixed(0).padStart(6) +
      " hitsToKillGrunt=" + (gruntHp && hit > 0 ? Math.ceil(gruntHp / hit) : "-") + "  " + note);
  }
  const ranks = Object.entries(p.abilities.ranks).filter(([, r]) => r > 0);
  console.log("  ranks(" + ranks.length + "): " + ranks.map(([k, v]) => k + ":" + v).join(" "));
}

function nodeReach(level: number, floor: number, n: number) {
  const counts: Record<string, number> = {};
  for (const u of UPGRADES) counts[u.id] = 0;
  for (let seed = 1; seed <= n; seed++) {
    const g = createTestGame({ seed, floor, level, abilities: "all", gear: false });
    for (const [id, r] of Object.entries(g.players[0].abilities.ranks)) if (r > 0) counts[id] = (counts[id] ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => a[1] - b[1]);
  console.log("\n=== node reach across " + n + " seeded crawlers (level " + level + ", floor " + floor + ") ===");
  for (const [id, c] of sorted) console.log("  " + id.padEnd(22) + ((c / n) * 100).toFixed(0).padStart(3) + "%");
}

function slotUse(level: number, floor: number, n: number) {
  const counts: Record<string, number> = {};
  for (let seed = 1; seed <= n; seed++) {
    const g = createTestGame({ seed, floor, level, abilities: "all", gear: false });
    const p = g.players[0];
    for (const s of p.abilities.slots) if (s) counts[s] = (counts[s] ?? 0) + 1;
    if (p.abilities.ultimate) counts["ULT:" + p.abilities.ultimate] = (counts["ULT:" + p.abilities.ultimate] ?? 0) + 1;
  }
  console.log("\n=== slot occupancy, " + n + " seeds ===");
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log("  " + k.padEnd(18) + v + "/" + n);
}

console.log("cdrCap=" + CONFIG.cdrCap + " ultimateMinFloor=" + CONFIG.ultimateMinFloor);
report(4, 7, 3);
report(8, 13, 3);
report(12, 18, 3);
nodeReach(18, 12, 40);
slotUse(18, 12, 20);
