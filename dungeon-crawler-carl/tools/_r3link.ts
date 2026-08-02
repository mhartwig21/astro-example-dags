import { openDb } from "../src/server/db";
const db = openDb("tools/_r3.sqlite")!;
for (const t of ["R3-DAILY-TOKEN-0001", "R3-REFUSE-TOKEN-0001"]) {
  db.linkIdentity("discord", "d-" + t, t, "Carl", Date.now());
  console.log("linked", t);
}
db.close();
