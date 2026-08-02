/**
 * Session-only board seeder for VISUAL VERIFICATION of the competitive screens.
 * Populates dcc.sqlite with a realistic ladder: sealed rows with verifier-derived
 * splits and named deaths, unproven rows, an aged-era row, a private row, plus a
 * career for the crawler the screenshot browser signs in as.
 *
 * NOT production code and never imported by the app. Delete after the shots.
 *   node --import tsx tools/_seed.ts
 */
import Database from "better-sqlite3";
import { openDb } from "../src/server/db";
import { CompetitiveStore } from "../src/server/competitive";
import { dailyEvent, weeklyEvent, seasonIdFor, cpFor } from "../src/server/season";
import { RULES_HASH } from "../src/sim/rulesHash";
import { REPLAY_DT, encodeProof, replayProof } from "../src/sim/replay";
import { recordBotRun } from "./replaycheck";
import { gzipSync } from "node:zlib";

const ME = "SHOTCRAWLER";
const now = Date.now();
const DB_FILE = process.env.DB_FILE ?? "dcc.sqlite";
const db = new Database(DB_FILE);
const pdb = openDb(DB_FILE);
const store = new CompetitiveStore(db);
const daily = dailyEvent(now);
const weekly = weeklyEvent(now);
store.upsertEvent({ ...daily, rulesHash: RULES_HASH });
store.upsertEvent({ ...weekly, rulesHash: RULES_HASH });
const season = seasonIdFor(now);

// Three REAL proofs, recorded through the shipping codec and replayed here so
// every sealed row carries splits and a death the verifier actually derived.
const proofs = [11, 47, 101].map((seed) => {
  const { proof } = recordBotRun(seed, 18, 120000);
  const { summary } = replayProof(proof);
  const id = "p-seed-" + seed;
  store.putProof({
    id, accountId: ME, rulesHash: RULES_HASH, seed, eventId: null,
    ticks: proof.header.ticks, bytes: gzipSync(Buffer.from(encodeProof(proof))), now,
  });
  console.log("proof", seed, "floor", summary.floor, summary.status, summary.ticks, "ticks");
  return { id, summary, seed };
});

const NAMES = [
  "Donut Holes", "Mordecai", "Katia", "Prince Maestro", "Signet", "Ferdinand",
  "Elle Blue", "The Quartermaster", "Vespa", "Gnaw", "Odette Vance", "Bautista",
];
let n = 0;
function addRun(o: {
  name: string; account: string; floor: number; won: boolean; timeSec: number; kills: number;
  level: number; ult: string | null; state: "verified" | "claimed" | "unverifiable";
  eventId?: string | null; attempt?: number | null; priv?: boolean; ageDays?: number;
  proofIdx?: number; era?: string | null;
}): string {
  const id = `seed-${++n}`;
  const created = now - (o.ageDays ?? 0) * 86400_000 - n * 60_000;
  const p = o.proofIdx != null ? proofs[o.proofIdx] : null;
  store.insertRun({
    id, accountId: o.account, displayName: o.name, eventId: o.eventId ?? null,
    seed: o.eventId ? daily.seed : 1000 + n, rulesHash: null, mode: "solo", partySize: 1,
    won: o.won, floor: o.floor, timeTicks: Math.round(o.timeSec / REPLAY_DT), kills: o.kills,
    level: o.level, ultimate: o.ult, attemptNo: o.attempt ?? null, private: !!o.priv,
    state: "claimed", proofId: p ? p.id : null, createdAt: created,
  });
  if (o.state === "verified" && p) {
    store.certify(id, {
      won: o.won, floor: o.floor, timeTicks: Math.round(o.timeSec / REPLAY_DT), kills: o.kills,
      level: o.level, ultimate: o.ult,
      bandSplits: scaleSplits(p.summary.bandSplitTicks, o.floor, o.name),
      // Only bands the run WALKED OUT OF are records - the same predicate the
      // verifier applies, so the seeded board looks like a real one.
      bandComplete: bandsComplete(o.floor, o.won),
      deathCause: o.won ? null : p.summary.death, finalBuild: p.summary.build,
      damageDealt: Math.round(o.kills * 168 + o.floor * 940),
      damageTaken: Math.round(o.floor * 262 + o.kills * 3.1),
      goldSpent: Math.round(o.floor * 137 + o.level * 44),
      rulesHash: o.era ?? RULES_HASH,
    }, created + 4000);
  } else if (o.state !== "claimed") {
    store.setState(id, "unverifiable",
      "recorded under rules era 4e19c02 - this build runs " + RULES_HASH.slice(0, 7));
  }
  return id;
}

/** Stretch a real split vector out to the claimed depth so the band boards and
 *  the profile ledger read like runs of that length rather than clones. */
function scaleSplits(base: number[], floor: number, who = ""): number[] {
  const bands = Math.min(6, Math.ceil(floor / 3));
  const out = new Array<number>(6).fill(0);
  // A per-crawler jitter, so two seeded rows built from the same proof do not
  // print the same split to the tick. Real boards tie occasionally; a board
  // where the top four rows are the same number is a fixture, and it hides
  // exactly the tie-break question the design has to answer.
  let h = 2166136261;
  for (const c of who) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  for (let b = 0; b < bands; b++) {
    const jitter = 0.88 + (((h >>> (b * 4)) & 0xff) / 255) * 0.3;
    out[b] = Math.round((base[b] || base[0] || 6000) * (0.8 + b * 0.28) * jitter);
  }
  return out;
}

/** Which bands did a run of this depth actually TRAVERSE? A band counts only
 *  when every floor in it was entered and its last floor was left behind. */
function bandsComplete(floor: number, won: boolean): boolean[] {
  return [0, 1, 2, 3, 4, 5].map((b) => {
    const last = Math.min(18, b * 3 + 3);
    if (floor < last) return false;
    if (floor > last) return true;
    return won; // ended ON the band's last floor: only a clear got out
  });
}

// ---- the day contract: a real field, with the honest mix of states ----
const FIELD: [string, number, boolean, number, number, number, string, number][] = [
  ["Donut Holes", 18, true, 902, 641, 34, "airstrike", 1],
  ["Mordecai", 18, true, 1044, 588, 33, "cataclysm", 2],
  ["Katia", 16, false, 1310, 502, 30, "bullettime", 1],
  ["Prince Maestro", 15, false, 1188, 471, 29, "airstrike", 5],
  ["Signet", 14, false, 1096, 402, 27, "cataclysm", 3],
  ["Ferdinand", 12, false, 998, 361, 25, "airstrike", 1],
  ["Elle Blue", 11, false, 947, 318, 24, "bullettime", 8],
  ["Vespa", 9, false, 812, 260, 21, "cataclysm", 2],
  ["Gnaw", 7, false, 690, 198, 18, "airstrike", 1],
  ["Bautista", 5, false, 512, 132, 14, "bullettime", 4],
];
FIELD.forEach(([name, floor, won, t, kills, level, ult, attempt], i) => {
  addRun({
    name, account: "acct-" + name.replace(/\W/g, ""), floor, won, timeSec: t, kills, level,
    ult, eventId: daily.id, attempt,
    state: i < 7 ? "verified" : i === 7 ? "claimed" : i === 8 ? "unverifiable" : "verified",
    era: i === 8 ? "4e19c02" : null,
    proofIdx: floor >= 14 ? 0 : floor >= 9 ? 1 : 2,
    priv: name === "Signet",
  });
});
// ...and YOU, mid-table, on attempt three.
addRun({
  name: "Carl", account: ME, floor: 13, won: false, timeSec: 1042, kills: 388, level: 26,
  ult: "cataclysm", eventId: daily.id, attempt: 3, state: "verified", proofIdx: 1,
});

// ---- the museum: all-time rows, some from older eras ----
const ALLTIME: [string, number, boolean, number, number, number, string, number][] = [
  ["The Quartermaster", 18, true, 838, 712, 35, "airstrike", 3],
  ["Odette Vance", 18, true, 871, 690, 35, "cataclysm", 11],
  ["Donut Holes", 18, true, 902, 933, 34, "airstrike", 0],
  ["Katia", 17, false, 1402, 604, 32, "bullettime", 6],
  ["Mordecai", 16, false, 1290, 1240, 31, "cataclysm", 19],
  ["Ferdinand", 15, false, 1180, 522, 29, "airstrike", 2],
];
ALLTIME.forEach(([name, floor, won, t, kills, level, ult, age], i) => {
  addRun({
    name, account: "acct-" + name.replace(/\W/g, ""), floor, won, timeSec: t, kills, level, ult,
    ageDays: age, state: i === 4 ? "unverifiable" : "verified", era: i === 4 ? "4e19c02" : null,
    proofIdx: i % 3,
  });
});
// Your museum rows, so the profile has a recent-runs shelf worth looking at.
[[15, false, 1155, 470, 29, "cataclysm", 1], [12, false, 1010, 352, 25, "airstrike", 4],
 [18, true, 1120, 655, 34, "cataclysm", 9], [8, false, 742, 224, 20, "bullettime", 12],
 [6, false, 601, 168, 17, "cataclysm", 16]]
  .forEach(([floor, won, t, kills, level, ult, age]) => {
    addRun({
      name: "Carl", account: ME, floor: floor as number, won: won as boolean,
      timeSec: t as number, kills: kills as number, level: level as number,
      ult: ult as string, ageDays: age as number, state: "verified", proofIdx: 1,
    });
  });

// ---- season standing, mastery, career ----
for (const [acct, cp] of [[ME, 0], ["acct-DonutHoles", 0], ["acct-Mordecai", 0], ["acct-Katia", 0]] as const) {
  void cp;
  [1, 2, 3, 4].forEach((k) => {
    store.recordCp(acct, season, "daily-seed-" + acct + "-" + k,
      cpFor(k + (acct === ME ? 2 : 0), 14), "seed-cp-" + acct + "-" + k, now - k * 86400_000);
  });
}
store.bumpMastery(ME, "cataclysm", 1180, now);
store.bumpMastery(ME, "airstrike", 430, now);
store.bumpMastery(ME, "bullettime", 90, now);
// Real per-run sums, not a round number five times over: a career total that
// lands on exactly 2,000 reads as a placeholder or a cap, and a reader is right
// to distrust it.
for (const r of [[18, 1, 655, 1120], [15, 0, 470, 1155], [13, 0, 388, 1042],
  [12, 0, 352, 1010], [8, 0, 224, 742]] as const) {
  pdb.bumpAccountStats(ME, { won: r[1] === 1, floor: r[0], kills: r[2], timeSec: r[3] }, now);
}
db.prepare(
  `INSERT OR IGNORE INTO account_identities (provider, provider_id, account_id, display, created_at)
   VALUES ('discord', 'seed-shotcrawler', ?, 'Carl', ?)`,
).run(ME, now);


console.log("seeded", n, "runs, season", season, "era", RULES_HASH.slice(0, 7));
db.close();
pdb.close();
