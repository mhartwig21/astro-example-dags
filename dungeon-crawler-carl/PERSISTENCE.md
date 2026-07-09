# Persistence — SQLite on the Fly volume (accounts, saves, hibernating instances)

Server-side persistence: character saves, party instances that survive deploys
and idle weeks, and the identity needed for Roam campaigns played across many
sessions over up to a month. **P1 (identity + character saves) is SHIPPED**;
this doc keeps the rationale and the remaining phases. Delete sections as they
ship.

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

## What's live (P1)

- `src/server/db.ts` — `better-sqlite3` (WAL, `synchronous=NORMAL`), file from
  `DB_FILE` (prod `/data/dcc.sqlite` on the `dcc_data` volume, set in
  fly.toml; local default `dcc.sqlite`, gitignored). If the native module or
  file is unusable the server logs loudly and runs without persistence rather
  than crashing. Tables: `meta` (schema_version), `accounts`, `parties`
  (mode + run_kind + floor + expiry), `party_members` (seat + `save_json` in
  the `SaveData` shape), and `instance_snapshots` (created now, written by P2).
- **Identity**: `join` carries an optional bearer `token`; the server mints a
  UUID for tokenless joins and echoes it in `welcome`; the client keeps it in
  `dcc:token:v1` (netClient.ts). Anonymous, friends-scale trust (like the
  leaderboard); stored plain — hash it when strangers arrive. Real accounts
  can attach credentials to the same row later.
- **Seat reclamation**: a returning token gets ITS seat back on a live
  instance, or its character reloaded (`applySavedPlayer`) into a regenerated
  one. Same token twice = second seat plays as a guest and never writes the
  save. Corrupt/incompatible `save_json` degrades to a fresh character, never
  a crash.
- **Checkpoints** (one transaction: party floor + every bound member's save):
  on disconnect, on floor transition, every ~60s of active play
  (`CHECKPOINT_EVERY`), and on shutdown — `close()` flushes all instances and
  SIGTERM/SIGINT trigger it (fly.toml `kill_timeout = "30s"` gives it room).
- **Party fallback restore**: an empty instance is dropped from memory; on the
  next join it regenerates from seed, fast-forwards to the stored floor
  (`buildFloor`), remembers its stored mode/run_kind over the joiner's flags,
  and reloads characters from saves as members arrive. Multiplayer Roam
  parties start via `?roam=1&join=CODE`.
- **Expiry**: race-style parties sweep ~7 days after last activity; roam
  campaigns ~45 days. Sweep runs at boot.
- Tests: `test/persistence.test.ts` — DB unit tests plus the full protocol
  loop (join with token → stage progression → drop → rejoin restores it;
  strangers don't inherit it; floor/run_kind survive).

Deploy note: `better-sqlite3` ships prebuilt binaries; if a container build
ever fails on it, add `python3 make g++` to the Dockerfile stage as fallback.

## P2 — hibernate/restore (the world itself survives)

Characters survive today; the WORLD regenerates. P2 stores the live sim so
mid-floor state (cleared packs, opened chests, monster positions) survives
drops and deploys:

- Write `serialize(state)` into `instance_snapshots` at the existing
  checkpoint seams; restore via `deserialize()` in `getOrCreateInstance`
  before falling back to the seed+floor+saves path that exists today (announce
  the fallback in-game: the System "renovated" the floor).
- `SNAPSHOT_VERSION` (new const in `snapshot.ts`, starts at 1): bump ONLY on a
  change optional-with-defaults can't absorb (removed/retyped field, mapgen
  change invalidating stored tiles). Version mismatch never corrupts — the
  fallback path keeps characters because `save_json` is small and stable.
- The month-long-run discipline this depends on: keep the existing convention
  (`types.ts`: new fields "optional so old snapshots/tests stay valid") for
  everything reachable from GameState.
- Golden test: check in a fixture snapshot (real serialized mid-run state);
  assert `deserialize` + 100 `step`s doesn't throw and stays deterministic.
  Regenerate on version bumps — the test failing tells a PR it needs
  optional-field treatment or a bump.
- **Client auto-reconnect** (netClient.ts): on `onclose` mid-run, retry join
  with the same code/token/name. With P2 this makes deploys invisible to
  players; it also makes Cloud Run's 60-min stream cap irrelevant if we ever
  migrate. After both land, the "check /health is idle before deploying"
  ritual in CLAUDE.md is obsolete — update it.

## P3 — Roam scale + consolidation

- `MAX_PARTY_SIZE_ROAM = 10` (base cap stays 6). Bandwidth: 10 clients × 28KB
  × 15/s ≈ 4 MB/s for one party — within measured comfort (16 players fine),
  but two concurrent Roam parties put snapshot deltas + WS compression
  (DEPLOY.md roadmap) next in line.
- leaderboard.json → the same SQLite file (same shape, drops the hand-rolled
  file handling).
- Litestream replication of `/data/dcc.sqlite` to Tigris — continuous offsite
  backup for pennies; Fly's daily volume snapshots already cover the basics.
