# Persistence — SQLite on the Fly volume (accounts, saves, hibernating instances)

Plan for server-side persistence: character saves, party instances that
survive deploys and idle weeks, and the identity needed for Roam (a ~10-player
party mode played across many sessions over up to a month). Verdict up front:
**SQLite (`better-sqlite3`) on the existing `dcc_data` volume. No new infra,
no provider change, ~$0/mo.** Delete sections as they ship.

## Why SQLite, and when it stops being the answer

The server is deliberately **one stateful process on one machine** (party
state in memory; DEPLOY.md: "exactly 1 machine is load-bearing"). That is the
shape where SQLite is the correct database, not a compromise: no network hop,
no pool, transactional writes in microseconds, and the DB is a single file on
a volume we already mount and snapshot daily.

Measured context (DEPLOY.md): a full instance snapshot is ~28KB of JSON; the
sim uses ~18% of the tick budget at 48 players. Checkpoint writes at the
cadence below are noise.

SQLite stops being the answer only when parties shard across **multiple
machines** — then saves need a networked Postgres (Fly unmanaged ~$2–5/mo, or
Managed at $38/mo+). The schema below ports 1:1; nothing here needs rework.
GCP remains a non-event: SQLite-on-volume moves to a GCE persistent disk
unchanged (DEPLOY.md's container contract).

## Storage layer

- Dependency: `better-sqlite3` (sync API — correct here: checkpoint writes are
  rare and tiny, and the tick loop stays single-threaded). It ships prebuilt
  binaries; verify the Docker build stage gets one (node:XX-slim may need
  `apt-get install -y python3 make g++` as a fallback — check at build time).
- File: `/data/dcc.sqlite`, env `DB_FILE` (default `dcc.sqlite` in cwd for
  local dev), set alongside `LEADERBOARD_FILE` in fly.toml.
- Pragmas at open: `journal_mode=WAL`, `synchronous=NORMAL`,
  `busy_timeout=5000`.
- New module `src/server/db.ts`: opens the DB, runs migrations (a `meta`
  table with `schema_version`; migrations are `ALTER`/`CREATE IF NOT EXISTS`
  run at boot), and exposes typed accessors. The GameServer constructor takes
  the path like it takes `leaderboardFile` today.

## Schema

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

-- Identity: an anonymous bearer token minted by the client (UUID in
-- localStorage), sent on join. No login UI; real accounts/passkeys can layer
-- on later by attaching credentials to the same row. Friends-scale trust
-- model (like the leaderboard's): the token is a bearer secret, stored plain
-- in v1; hash it when strangers arrive.
CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,      -- client token
  name         TEXT,                  -- last-used display name
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE parties (
  code        TEXT PRIMARY KEY,       -- invite code (party code IS the dungeon)
  mode        TEXT NOT NULL,          -- "coop" | "rivals" | "roam"
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL        -- sweep expired rows at boot + daily
);

-- Seat binding + per-character fallback save. The instance snapshot already
-- contains every player, so this row exists for two other reasons:
-- (1) a returning token reclaims ITS seat (player_id), not "first free seat";
-- (2) if a snapshot can't be restored after a sim change, characters survive:
--     regenerate the floor from seed and reload progression from save_json.
CREATE TABLE party_members (
  party_code TEXT NOT NULL REFERENCES parties(code) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  player_id  INTEGER NOT NULL,        -- sim seat
  save_json  TEXT NOT NULL,           -- the SaveData shape (src/persist/save.ts)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (party_code, account_id)
);

-- The hibernated world: serialize(state) verbatim (src/sim/snapshot.ts).
CREATE TABLE instance_snapshots (
  party_code TEXT PRIMARY KEY REFERENCES parties(code) ON DELETE CASCADE,
  version    INTEGER NOT NULL,        -- SNAPSHOT_VERSION at write time
  snapshot   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Leaderboard rows migrate here from leaderboard.json (P3; same shape).
```

Expiry: `coop`/`rivals` parties expire ~7 days after `updated_at`; `roam`
~45 days (a month-long campaign plus slack). Touch `updated_at` on every
checkpoint.

## Protocol change (one message)

`join` gains a token: `{ t: "join", code, name, token?, mode? }`
(`netClient.ts:35`; `mode` subsumes the current `rivals: true` flag, kept
accepted for old clients). `welcome` echoes `{ token }` back — the server
mints one if the client sent none; the client stores it (`dcc:token:v1`).
Unknown fields are already ignored by both sides, so this is
backward-compatible in both directions.

## Checkpoint seams (all in `gameServer.ts`)

Checkpoint = one transaction: upsert `parties.updated_at`, every seated
member's `save_json`, and the `instance_snapshots` row.

| Seam | Today | Change |
|---|---|---|
| join handler | seat = first seatless player | resolve token → account; if a `party_members` row exists, reclaim that `player_id`; else seat as today and insert the row. Roam cap 10 (see below) |
| `ws.on("close")` | empty instance → `clearInterval` + delete (the comment says "persistence comes later" — this is later) | checkpoint, then unload from memory. **Hibernation is the core mechanic**: a month-long Roam party is mostly nobody-playing; empty instances must cost nothing |
| `getOrCreateInstance` | always `createGame(seedFromCode(code))` | first check `instance_snapshots`: restore via `deserialize()` if `version` matches; on mismatch, fall back to fresh floor + reload characters from `party_members.save_json` (announce it in-game: the System "renovated" the floor) |
| `tickInstance` | — | periodic checkpoint every ~60s of active play (tick counter), plus on floor transition (cheap: watch `state.floor` change) |
| `close()` + signals | flushes leaderboard only | wire `SIGTERM`/`SIGINT` → checkpoint every live instance, then exit. Add `kill_timeout = 30` to fly.toml so Fly's stop grace covers the flush (default is 5s) |

Timers: `setInterval` per instance already exists; hibernation just means
`clearInterval` + `instances.delete()` after checkpoint (the close handler
already does the memory part).

## Snapshot compatibility across a month of deploys

The real risk is schema drift, not storage: a Roam snapshot written in week 1
must load in week 4. Rules:

- Keep the existing convention (`types.ts`: new fields "optional so old
  snapshots/tests stay valid"; `save.ts`: default missing fields on load) for
  **everything reachable from GameState**.
- `SNAPSHOT_VERSION` (new const in `snapshot.ts`, starts at 1): bump ONLY on a
  change that optional-with-default can't absorb (removed/retyped field,
  mapgen change that invalidates stored tile arrays). Version mismatch never
  corrupts: the fallback path (fresh floor, characters kept) always works
  because `save_json` is small and stable.
- Golden test: check in a fixture snapshot (a real serialized mid-run state);
  assert `deserialize` + 100 `step`s doesn't throw and stays deterministic.
  Regenerate the fixture on version bumps — the test failing is the signal
  that a PR needs either optional-field treatment or a version bump.

## Roam-mode hooks (persistence side only — game rules are out of scope here)

- `MAX_PARTY_SIZE_ROAM = 10` (base cap stays 6). Bandwidth note: 10 clients ×
  28KB × 15/s ≈ 4 MB/s for one party — within measured comfort (16 players
  fine), but two concurrent Roam parties put snapshot deltas + WS compression
  (DEPLOY.md roadmap) next in line.
- `mode: "roam"` flows client → join → `createGame` like `rivals` does today.
- Reconnect (`netClient.ts`): on `onclose` while in a run, retry join with the
  same code/token/name and re-enter — this is also what makes Cloud Run's
  60-min stream cap irrelevant if we ever migrate, and what makes deploys
  invisible to players mid-session.

## Phases

**P1 — storage + identity.** `db.ts`, schema, token handshake, seat
reclamation, per-member `save_json` written on the checkpoint events. Ships
alone: characters survive deploys even before world state does.
**P2 — hibernate/restore.** Instance snapshots, the four checkpoint seams,
SIGTERM flush + `kill_timeout`, version fallback, golden fixture test, client
auto-reconnect. After this, the "check /health is idle before deploying"
ritual in CLAUDE.md is obsolete — update it.
**P3 — Roam enablement + consolidation.** Cap 10 + mode plumbing (lands with
the Roam design, whatever it is), leaderboard.json → SQLite, Litestream
replication of `/data/dcc.sqlite` to Tigris (continuous offsite backup for
pennies; volume daily snapshots already cover the basics).

## Testing

- `db.ts` unit tests against a temp file (better-sqlite3 needs no server).
- Server tests (existing `test/server` harness): join with token → disconnect
  → rejoin reclaims the same seat with progression intact; last-disconnect →
  hibernate → rejoin restores the same world (assert monster positions match);
  version-mismatch path keeps the character, regenerates the floor.
- The golden fixture test above.
