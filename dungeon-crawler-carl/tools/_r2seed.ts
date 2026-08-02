/**
 * Put a REAL sealed row on today's contract board, through the real wire, so
 * the client surfaces that read a board (THE MARK, RACE THE LEADER, the
 * standings) are exercised against evidence rather than against an empty set.
 *
 * It also demonstrates the round's ticket rule from the outside: the /start is
 * observed, and the submit has to wait out the run it claims to be.
 */
import { encodeProof } from "../src/sim/replay";
import { recordBotRun } from "./replaycheck";

const API = "http://localhost:5439";
const TOKEN = "R2-LEADER-TOKEN-01";

const evt = (await (await fetch(`${API}/events/current`)).json()).daily as { id: string; seed: number };
console.log("daily", evt.id, "seed", evt.seed);

const { proof } = recordBotRun(evt.seed, 3);
const runMs = Math.round(proof.header.ticks / 60 * 1000);
console.log("bot run:", proof.header.ticks, "ticks =", (runMs / 1000).toFixed(1), "s of play");

const start = await (await fetch(`${API}/events/${evt.id}/start?token=${TOKEN}`, { method: "POST" })).json();
console.log("ticket:", start.attemptNo, "scoresCp", start.scoresCp, "graceMs", start.graceMs);
proof.header.eventId = evt.id;
proof.header.ticket = start.ticket;

// The ticket cannot back a run that has not been played yet. Wait it out.
console.log("waiting out the run the ticket claims...");
await new Promise((r) => setTimeout(r, runMs + 1500));

const res = await (await fetch(`${API}/runs?token=${TOKEN}&name=DONUT%20HOLES`, {
  method: "POST", headers: { "content-type": "application/octet-stream" },
  body: encodeProof(proof),
})).json();
console.log("submit:", JSON.stringify(res));

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const row = await (await fetch(`${API}/runs/${res.runId}`)).json();
  if (row.state !== "verifying" && row.state !== "claimed") {
    console.log("VERDICT:", row.state, "| era", row.rulesEra, "| boards", JSON.stringify(row.boards),
      "| accountId leaked?", JSON.stringify(row).includes("accountId"), "| publicId", row.publicId);
    break;
  }
}
const board = await (await fetch(`${API}/boards/deepest?event=daily`)).json();
console.log("board entries", board.entries.length, "unproven", board.unproven.length,
  board.entries[0] ? `| #1 ${board.entries[0].name} floor ${board.entries[0].floor}` : "");
