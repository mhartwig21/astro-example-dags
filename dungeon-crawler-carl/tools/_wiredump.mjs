// Raw wire dump: create a DAILY race, then join a second seat and print every
// message type each seat receives (first ~4s), looking for the rule line.
import WebSocket from "ws";

const CODE = "DAILY-2026-08-04-WD" + Math.floor(Math.random() * 10000);

function seat(name, delay) {
  return new Promise((res) => {
    setTimeout(() => {
      const ws = new WebSocket("ws://localhost:5281");
      ws.on("open", () => ws.send(JSON.stringify({ t: "join", code: CODE, name: "X" + name, rivals: true })));
      const seen = [];
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (m.t === "events") {
          seen.push("events: " + JSON.stringify({ ann: m.announcements?.map((a) => a.text.slice(0, 60)), ev: m.events }));
        } else if (m.t === "gate") {
          if (!seen.some((s) => s.startsWith("gate"))) seen.push(`gate: seats=${m.seats?.length} msLeft=${m.msLeft}`);
        } else {
          seen.push(m.t);
        }
      });
      setTimeout(() => { ws.close(); res({ name, seen }); }, 4000);
    }, delay);
  });
}

const [a, b] = await Promise.all([seat("A", 0), seat("B", 1500)]);
for (const s of [a, b]) {
  console.log(`--- seat ${s.name} ---`);
  for (const line of s.seen) console.log(" ", line);
}
