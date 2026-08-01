// Bot load test: N parties x M players, all moving and casting. Reports server
// /health telemetry, client-side snapshot jitter, AND wire cost (snapshot +
// event bytes/s per client — the measured ceiling is bandwidth, see DEPLOY.md).
//
//   node scripts/loadtest.mjs <parties> <perParty> <seconds>
//   HOST=localhost:5288 node scripts/loadtest.mjs 4 4 25   # local server
//   ROAM=1 ...                                             # roam-mode parties
//
// Defaults to production. A host containing localhost/127. uses ws:// + http://.
import WebSocket from "ws";

const HOST = process.env.HOST ?? "dungeon-crawler-claude.fly.dev";
const LOCAL = /^(localhost|127\.)/.test(HOST);
const WS_URL = `${LOCAL ? "ws" : "wss"}://${HOST}`;
const HTTP_URL = `${LOCAL ? "http" : "https"}://${HOST}`;
const ROAM = process.env.ROAM === "1";
const PARTIES = Number(process.argv[2] ?? 4);
const PER_PARTY = Number(process.argv[3] ?? 4);
const SECONDS = Number(process.argv[4] ?? 25);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Unique codes per run: party codes persist server-side (mode + member seats),
// so reusing LOAD0 across runs rejects joiners ("party full") and pins mode.
const RUN = Math.random().toString(36).slice(2, 6).toUpperCase();
const gaps = []; // snapshot inter-arrival ms across all sockets
// Wire accounting across all sockets. snap/full/event bytes are DECOMPRESSED
// message sizes; socketBytes is what actually crossed the socket (counts
// permessage-deflate savings; on wss add TLS record overhead, a few %).
const wire = { snapBytes: 0, snapMsgs: 0, fullBytes: 0, fullMsgs: 0, eventBytes: 0, eventMsgs: 0, welcomeBytes: 0, clientSeconds: 0, socketBytes: 0 };

function bot(code, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let lastSnap = 0;
    let timer = null;
    const openedAt = performance.now();
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", code, name, roam: ROAM || undefined })));
    ws.on("message", (m) => {
      const bytes = m.length ?? String(m).length;
      const d = JSON.parse(m);
      if (d.t === "welcome") {
        wire.welcomeBytes += bytes;
        timer = setInterval(() => {
          const a = Math.random() * Math.PI * 2;
          ws.send(JSON.stringify({ t: "intent", intent: {
            move: { x: Math.cos(a), y: Math.sin(a) },
            cast: [Math.random() < 0.1, false, Math.random() < 0.2, false, false],
            aim: { x: Math.cos(a), y: Math.sin(a) },
            useStairs: false,
          }}));
        }, 50); // 20 intents/s
      } else if (d.t === "snap") {
        if (d.full) { wire.fullBytes += bytes; wire.fullMsgs++; }
        else { wire.snapBytes += bytes; wire.snapMsgs++; }
        const now = performance.now();
        if (lastSnap) gaps.push(now - lastSnap);
        lastSnap = now;
      } else if (d.t === "events") {
        wire.eventBytes += bytes;
        wire.eventMsgs++;
      }
    });
    ws.on("error", () => {});
    setTimeout(() => {
      if (timer) clearInterval(timer);
      wire.clientSeconds += (performance.now() - openedAt) / 1000;
      wire.socketBytes += ws._socket?.bytesRead ?? 0; // post-deflate wire truth
      ws.close();
      resolve();
    }, SECONDS * 1000);
  });
}

async function health() {
  const res = await fetch(`${HTTP_URL}/health`);
  return res.json();
}

console.log(`load: ${PARTIES} parties x ${PER_PARTY} players for ${SECONDS}s against ${HOST}${ROAM ? " (roam)" : ""}`);
console.log("before:", JSON.stringify(await health()));
const bots = [];
for (let p = 0; p < PARTIES; p++) {
  for (let i = 0; i < PER_PARTY; i++) bots.push(bot(`LOAD${RUN}${p}`, `Bot${p}_${i}`));
  await sleep(120);
}
const sampler = setInterval(async () => console.log("during:", JSON.stringify(await health())), 6000);
await Promise.all(bots);
clearInterval(sampler);
gaps.sort((a, b) => a - b);
const pct = (q) => Math.round(gaps[Math.floor(gaps.length * q)]);
console.log(`snapshot gaps ms (expect ~67): p50=${pct(0.5)} p95=${pct(0.95)} p99=${pct(0.99)} n=${gaps.length}`);
const cs = Math.max(1, wire.clientSeconds);
const kb = (b) => (b / 1024).toFixed(1);
console.log(`wire per client: dynamic snap ${kb(wire.snapBytes / Math.max(1, wire.snapMsgs))}KB avg x ${(wire.snapMsgs / cs).toFixed(1)}/s = ${kb(wire.snapBytes / cs)}KB/s; ` +
  `full ${kb(wire.fullBytes / Math.max(1, wire.fullMsgs))}KB avg (${(wire.fullMsgs / cs).toFixed(2)}/s); ` +
  `events ${kb(wire.eventBytes / cs)}KB/s; welcome ${kb(wire.welcomeBytes / Math.max(1, PARTIES * PER_PARTY))}KB`);
console.log(`wire per party of ${PER_PARTY}: ${kb((wire.snapBytes + wire.fullBytes + wire.eventBytes) / cs * PER_PARTY)}KB/s decompressed; ` +
  `server total at ${PARTIES} parties: ${kb((wire.snapBytes + wire.fullBytes + wire.eventBytes) / cs * PER_PARTY * PARTIES)}KB/s`);
console.log(`socket truth (post-deflate): ${kb(wire.socketBytes / cs)}KB/s per client; ` +
  `server total: ${kb(wire.socketBytes / cs * PARTIES * PER_PARTY)}KB/s; ` +
  `compression ${(1 - wire.socketBytes / Math.max(1, wire.snapBytes + wire.fullBytes + wire.eventBytes + wire.welcomeBytes)).toLocaleString(undefined, { style: "percent" })} saved`);
console.log("after:", JSON.stringify(await health()));
