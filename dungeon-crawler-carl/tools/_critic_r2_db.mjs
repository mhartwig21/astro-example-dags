import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const Database = req("better-sqlite3");
const db = new Database("tools/_critic_r2.sqlite", { readonly: true });
const rows = db.prepare("SELECT kind, party_code, account_id IS NOT NULL AS hasAcct, data FROM usage_events ORDER BY ts").all();
console.log("rows:", rows.length);
for (const r of rows) console.log(r.kind, "|", r.party_code, "| acct:" + r.hasAcct, "|", String(r.data).slice(0, 160));
