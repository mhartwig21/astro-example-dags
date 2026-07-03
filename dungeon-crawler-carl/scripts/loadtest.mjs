// Bot load test: N parties x M players against the prod server, all moving and
// casting. Reports server /health telemetry + client-side snapshot jitter.
import WebSocket from "ws";

const HOST = "dungeon-crawler-claude.fly.dev";
const PARTIES = Number(process.argv[2] ?? 4);
const PER_PARTY = Number(process.argv[3] ?? 4);
const SECONDS = Number(process.argv[4] ?? 25);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gaps = []; // snapshot inter-arrival ms across all sockets

function bot(code, name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://${HOST}`);
    let lastSnap = 0;
    let timer = null;
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", code, name })));
    ws.on("message", (m) => {
      const d = JSON.parse(m);
      if (d.t === "welcome") {
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
        const now = performance.now();
        if (lastSnap) gaps.push(now - lastSnap);
        lastSnap = now;
      }
    });
    ws.on("error", () => {});
    setTimeout(() => { if (timer) clearInterval(timer); ws.close(); resolve(); }, SECONDS * 1000);
  });
}

async function health() {
  const res = await fetch(`https://${HOST}/health`);
  return res.json();
}

console.log(`load: ${PARTIES} parties x ${PER_PARTY} players for ${SECONDS}s`);
console.log("before:", JSON.stringify(await health()));
const bots = [];
for (let p = 0; p < PARTIES; p++) {
  for (let i = 0; i < PER_PARTY; i++) bots.push(bot(`LOAD${p}`, `Bot${p}_${i}`));
  await sleep(120);
}
const sampler = setInterval(async () => console.log("during:", JSON.stringify(await health())), 6000);
await Promise.all(bots);
clearInterval(sampler);
gaps.sort((a, b) => a - b);
const pct = (q) => Math.round(gaps[Math.floor(gaps.length * q)]);
console.log(`snapshot gaps ms (expect ~67): p50=${pct(0.5)} p95=${pct(0.95)} p99=${pct(0.99)} n=${gaps.length}`);
console.log("after:", JSON.stringify(await health()));
