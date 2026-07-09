# Persistence — SQLite on the Fly volume (accounts, saves, hibernating instances)

Server-side persistence: character saves, party instances that survive deploys
and idle weeks, and the identity needed for Roam campaigns played across many
sessions over up to a month. **P1 (identity + character saves) and P2 (world
hibernate/restore + client auto-reconnect) are SHIPPED**; this doc keeps the
rationale and the remaining phase. Delete sections as they ship.

## Why SQLite, and when it stops being the answer

The server is deliberately **one stateful process on one machine** (party
state in memory; DEPLOY.md: "exactly 1 machine is load-bearing"). That is the
shape where SQLite is the correct database, not a compromise: no network hop,
no pool, transactional writes in microseconds, and the DB is a single file on
a volume we already mount and snapshot daily.

SQLite stops being the answer only when parties shard across **multiple
machines** — then saves need a networked Postgres (Fly unmanaged ~$2–5/mo, or
Managed at $38/mo+). The schema ports 1:1; nothing here needs rework. GCP
remains a non-event: SQLite-on-volume moves to a GCE persistent disk unchanged
(DEPLOY.md's container contract).

## What's live (P1 + P2)

- `src/server/db.ts` — `better-sqlite3` (WAL, `synchronous=NORMAL`), file from
  `DB_FILE` (prod `/data/dcc.sqlite` on the `dcc_data` volume, set in
  fly.toml; local default `dcc.sqlite`, gitignored). If the native module or
  file is unusable the server logs loudly and runs without persistence rather
  than crashing. Tables: `meta` (schema_version), `accounts`, `parties`
  (mode + run_kind + floor + expiry), `party_members` (seat + `save_json` in
  the `SaveData` shape), and `instance_snapshots` (the hibernated world:
  versioned `serialize(state)` verbatim).
- **Identity**: `join` carries an optional bearer `token`; the server mints a
  UUID for tokenless joins and echoes it in `welcome`; the client keeps it in
  `dcc:token:v1` (netClient.ts). Anonymous, friends-scale trust (like the
  leaderboard); stored plain — hash it when strangers arrive. Real accounts
  can attach credentials to the same row later.
- **Seat reclamation**: a returning token gets ITS seat back — as-is on a
  live/restored world, or reloaded from `save_json` (`applySavedPlayer`) into
  a regenerated one. Seats owned by other accounts (even offline) are
  off-limits to drop-in strangers. Same token twice = the second seat plays as
  a guest and never writes the save. Corrupt/incompatible `save_json`
  degrades to a fresh character, never a crash.
- **World hibernate/restore**: coop/roam instances write the full
  `serialize(state)` (stamped `SNAPSHOT_VERSION`) at every checkpoint; an
  empty instance unloads from memory, and the next join deserializes the
  world back — monsters, loot, timers, everyone's parked character. Rivals
  states nest per-floor worlds whose typed arrays don't survive `serialize`,
  so rivals persist characters only.
- **Fallback restore**: if the stored snapshot's version mismatches (or won't
  parse), the world regenerates from seed, fast-forwards to the stored floor
  (`buildFloor`), reloads characters from saves as members arrive, and the
  System announces the floor was "renovated". A finished run (won/wiped)
  clears the campaign so the next join under that code starts fresh.
- **Checkpoints** (one transaction: party floor + member saves + world
  snapshot): on disconnect, on floor transition, every ~60s of active play
  (`CHECKPOINT_EVERY`), and on shutdown — `close()` flushes all instances and
  SIGTERM/SIGINT trigger it (fly.toml `kill_timeout = "30s"` gives it room).
- **Client auto-reconnect** (netClient.ts): an unexpected close mid-run
  retries the join with the same code/token — 1/2/4/8s then 10s, giving up
  after ~3 minutes. `onReconnect` tells the host to re-read `playerId`.
  Deploys are now a few seconds of "SIGNAL RESTORED" instead of a dropped
  run; it also makes Cloud Run's 60-min stream cap irrelevant if we ever
  migrate.
- **Expiry**: race-style parties sweep ~7 days after last activity; roam
  campaigns ~45 days. Sweep runs at boot.
- **`SNAPSHOT_VERSION`** (snapshot.ts, currently 1): bump ONLY on a change
  optional-with-defaults can't absorb (removed/retyped field, mapgen change
  invalidating stored tiles) — the codebase convention (`types.ts`: new
  fields "optional so old snapshots/tests stay valid") covers everything
  else, and must keep covering everything reachable from GameState. After a
  bump, regenerate the golden fixture: `npx tsx scripts/makeSnapshotFixture.ts`.
- Tests: `test/persistence.test.ts` — DB unit tests; the full protocol loop
  (join with token → stage progression → drop → rejoin restores character AND
  world; strangers inherit neither; version-mismatch falls back with
  characters kept; finished runs reset); and the golden fixture (a checked-in
  serialized world must deserialize + step deterministically under today's
  sim — if it fails, the PR needs optional-field treatment or a version bump).

Deploy note: `better-sqlite3` ships prebuilt binaries; if a container build
ever fails on it, add `python3 make g++` to the Dockerfile stage as fallback.

## P3 — Roam scale + consolidation

- `MAX_PARTY_SIZE_ROAM = 10` (base cap stays 6). Bandwidth: 10 clients × 28KB
  × 15/s ≈ 4 MB/s for one party — within measured comfort (16 players fine),
  but two concurrent Roam parties put snapshot deltas + WS compression
  (DEPLOY.md roadmap) next in line.
- leaderboard.json → the same SQLite file (same shape, drops the hand-rolled
  file handling).
- Litestream replication of `/data/dcc.sqlite` to Tigris — continuous offsite
  backup for pennies; Fly's daily volume snapshots already cover the basics.
