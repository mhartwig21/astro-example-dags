// Give the acceptance tokens a linked provider identity — the price of the
// verify queue (COMPETITIVE.md 2.7.1). Without it every submission is stored
// `claimed` and never replayed, so the REFUSED path cannot be reached at all.
import { openDb } from "../src/server/db";
const db = openDb("tools/_r2.sqlite")!;
for (const t of ["R2-DAILY-TOKEN-0001", "R2-REFUSE-TOKEN-0001", "R2-LEADER-TOKEN-01", "R2-SEALED-TOKEN-01", "CONSENT-PROBE-01", "PROBE-TOKEN-0001"]) {
  db.linkIdentity("discord", "d-" + t, t, "Carl", Date.now());
  console.log("linked", t);
}
db.close();
