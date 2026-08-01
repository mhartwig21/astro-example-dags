# Deploying Dungeon Crawler Claude

One Docker container serves everything: the built client (static files), the
`/health` endpoint, and the authoritative game WebSocket — all on one port.
The image is deliberately **platform-agnostic** (plain Node, no provider APIs),
which is the whole migration strategy: today it runs on Fly.io, later the same
image points at GCP.

## Architecture in production

```
browser ──https──▶ ┌──────────────────────────────┐
                   │  container (Node, port 8080)  │
browser ──wss───▶  │  static dist/ + /health + ws  │
                   │  in-memory party instances     │
                   └──────────────────────────────┘
```

- The client infers the server URL from its own origin (`wss://` on HTTPS), so
  a shared link is just `https://<app>/iso.html?join=CODE&name=You`.
- Party state ticks **in-memory** in this single process and **persists to
  SQLite** at `/data/dcc.sqlite` (PERSISTENCE.md): characters per account, and
  the full world snapshot for coop/roam parties. A restart/deploy checkpoints
  on SIGTERM; clients auto-reconnect and resume the same run.
- Hardening in `gameServer.ts`: sanitized intents, party cap 6 (Roam: 10),
  instance cap 200, 16KB WebSocket payload cap, path-traversal-safe static
  serving.

## Try the production build locally

```bash
npm run build
PORT=8080 STATIC_DIR=dist npm run server
# open http://localhost:8080/iso.html?join=TEST&name=You
```

The daily-crawl leaderboard persists to `LEADERBOARD_FILE` (default
`leaderboard.json` in the working directory). In production it lives on the
persistent volume `dcc_data` mounted at `/data` (`LEADERBOARD_FILE=
/data/leaderboard.json`, both set in fly.toml), so boards SURVIVE deploys and
restarts; Fly snapshots the volume daily (5 kept). The volume was created with
`fly volumes create dcc_data --region ord --size 1` — one volume, one machine,
same region; if the machine is ever recreated from scratch, make sure a
`dcc_data` volume exists in its region first. The same volume holds
`/data/dcc.sqlite` (`DB_FILE`): per-account character saves + hibernated
worlds for multiplayer parties — see PERSISTENCE.md. That file is ALSO
replicated offsite continuously by Litestream (Tigris bucket `dcc-backup`;
config in `litestream.yml`), and restored automatically at boot if the volume
is ever fresh — so even total volume loss costs seconds, not a day. Run
history / personal bests remain browser-local (`dcc:history:v1`).

Or the actual container, if Docker is installed:

```bash
docker build -t dcc .
docker run -p 8080:8080 dcc
```

## Fly.io (current target)

One-time setup (needs a Fly account; free allowance covers this footprint):

```bash
# install flyctl: https://fly.io/docs/flyctl/install/
fly auth login
cd dungeon-crawler-carl
fly launch --copy-config --no-deploy   # accepts fly.toml; pick app name/region
fly deploy
```

Then share `https://<app-name>.fly.dev/iso.html?join=YOURCODE&name=Carl`.

Notes:
- `fly.toml` pins **one always-on machine** (`min_machines_running = 1`,
  `auto_stop_machines = false`) — a game server must not scale to zero mid-run.
- 1GB shared-cpu-1x is generous (see the capacity table): the sim is a few
  MB per party and CPU sits under 10% at 48 players.
- Deploys restart the process → runs checkpoint on SIGTERM and clients
  auto-reconnect (a few seconds of pause). Deploying mid-boss is rude, not fatal.
- Custom domain later: `fly certs add game.yourdomain.com` + a CNAME.

## Observability

Two live surfaces, one durable record:

- **`/metrics`** — Prometheus exposition (server/metrics.ts), scraped by Fly
  (`fly.toml [metrics]`) into the managed Grafana at
  https://fly-metrics.net (also linked from the app's Monitoring tab).
  Series: `dcc_tick_ms_total`/`dcc_ticks_total` (rate÷rate = avg tick cost),
  `dcc_snapshot_bytes_total` (the wire-diet watchdog), `dcc_event_bytes_total`,
  `dcc_players_connected`, `dcc_instances`, `dcc_joins_total`/`dcc_leaves_total`,
  `dcc_floors_descended_total`, `dcc_runs_won_total`/`dcc_runs_lost_total`,
  `dcc_rss_bytes`. Fly's built-in machine dashboards (CPU/mem/net) live in the
  same Grafana.
- **`/health`** — the JSON spot-check the deploy runbook curls.
- **`usage_events`** (SQLite, litestream-replicated — PERSISTENCE.md): one
  append-only row per session start/end, floor reached, and run end, each
  carrying per-crawler BUILD summaries (slots/ultimate/weapon/power/kills/
  damage). This is the balance record: "what builds clear floor 12", "where
  do parties die", "how long is a session". Query with any sqlite client via
  `fly ssh console` + `sqlite3 /data/dcc.sqlite`, or `PersistDb.listEvents`.

## OAuth (Discord + Google sign-in)

Sign-in is code-complete and env-gated (`src/server/auth.ts`): providers whose
secrets aren't set simply don't exist, and the client hides the buttons. The
flow LINKS a provider identity to the browser's existing anonymous account
token — signing in never loses a crawler, and a known identity recovers its
account from any device.

To turn a provider on:

1. **Discord**: https://discord.com/developers/applications → New Application →
   OAuth2. Add redirect `https://dungeon-crawler-claude.fly.dev/auth/callback/discord`.
   Copy the Client ID + Client Secret.
2. **Google**: https://console.cloud.google.com/apis/credentials → Create
   OAuth client ID (Web application). Add the redirect
   `https://dungeon-crawler-claude.fly.dev/auth/callback/google`. Scopes used:
   `openid profile` (no email is requested or stored).
3. Set the secrets (each `fly secrets set` restarts the machine — deploy-grade
   disruption, do it once):

   ```
   fly secrets set \
     SESSION_SECRET=$(openssl rand -hex 32) \
     PUBLIC_URL=https://dungeon-crawler-claude.fly.dev \
     DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... \
     GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
   ```

4. Verify: `curl https://dungeon-crawler-claude.fly.dev/auth/providers` lists
   the configured providers, and the menu shows the SIGN IN buttons.

Privacy surface: we store the provider's user id + display name (nothing
else), career aggregates per account, and party saves. FORGET ME in the menu
calls `/auth/delete`, which erases the account row, identities, stats, and
party seats. Tokens are stored plain (friends-scale) — hash them before a
larger audience, as PERSISTENCE.md already notes.

## Capacity & sizing (measured 2026-08-01)

Evidence from bot load tests against a local build of the production server
(same code path; Windows timers cap the local snapshot rate at ~11/s vs the
15/s prod ideal — per-second figures below are normalized to 15/s where
noted). `/health` exposes live telemetry: `instances`, `players`,
`tickMsEma`/`tickMsMax` (per-instance sim tick cost; the whole Node thread
has a 33ms budget per 30Hz tick across ALL instances), `rssMb`, `uptimeMin`.

The 2026-08 wire diet (three changes, all measured):
1. **State slow split** (snapshot.ts `STATE_SLOW_FIELDS`): breakables + roam
   npcs/settlements/quests/dialogue ship only when they change — they were
   ~23% of a coop dynamic snapshot and ~32% of a roam one, re-sent 15/s.
2. **Player cold split extended** to derived stats (maxHp/armor/attack/
   spell/crit/bonus* — recompute-written, never per-tick) and transients
   (events/announcements/hits) dropped from snapshots — the dedicated
   `events` message already carried them; net hosts only render that channel.
3. **WebSocket permessage-deflate** (gameServer.ts): frame-to-frame snapshot
   JSON is highly repetitive, so deflate with context takeover acts as cheap
   delta encoding — **95% measured on the socket**. zlib runs on the libuv
   threadpool, off the tick thread; cost is ~150KB RSS per connection.

| Load (active combat, 4/party) | Tick cost (per instance) | RSS | Wire per client |
|---|---|---|---|
| idle | -- | 92 MB | -- |
| before diet: 16 players / 4 parties | 0.25ms avg | 105 MB | 8.0KB/snap, ~120KB/s at 15/s |
| after diet: 16 players / 4 parties | 0.25ms avg | 116 MB | 5.1KB/snap decompressed, **~4.5KB/s on the socket** |
| after diet: 48 players / 12 parties | 0.15ms avg, 6ms max | 155 MB | same per client; server egress ~200KB/s TOTAL, p95 gap nominal (was 500ms/degraded in 2026-07) |
| after diet: roam parties | +0.1ms | +5 MB/party | 4.7KB/snap decompressed (was ~11KB — settlements/npcs no longer re-ship) |

Findings:
- **The old ceiling (bandwidth) is gone.** 2026-07 measured ~28KB snapshots
  (~0.4 MB/s per client) degrading at 48 players. Post-diet a client costs
  ~4.5KB/s on the socket — ~90x less than 2026-07, ~28x less than pre-diet
  2026-08. Server egress at 48 players is ~200KB/s, nothing.
- **CPU is now the far-off ceiling**: ~7% of the tick budget at 48 players
  (tickMsEma × instances × 30). Straight-line that's ~300+ players of sim,
  though GC pauses and deflate threadpool contention will bite first.
- **Memory is the reason for the 1GB step**: RSS 155MB at 48 players, and
  deflate adds ~150KB/connection. 512MB was already fine, but an OOM restart
  wipes live parties — 1GB makes it unreachable at any plausible load.
- Single-player never touches this server (the sim runs in the browser).

Recommendations:
1. **`shared-cpu-1x` / 1GB** (fly.toml as of 2026-08). Comfortable well past
   ~20 simultaneous parties / 80+ players.
2. **Exactly 1 machine is load-bearing, not budgetary.** Party state lives
   in process memory; a second machine splits same-code joins into separate
   universes. Scaling out needs Postgres persistence + session affinity
   (see GCP plan below). Never let auto-HA add a machine.

### Scale-up runbook (when /health or Grafana says so)

Watch `tickMsEma × instances × 30 / 1000` (fraction of the sim thread in
use) and `rssMb`. Escalate in this order — each is one command, applied on
the next machine restart, live parties checkpoint + auto-reconnect through it:

```bash
fly scale memory 2048                  # RSS > ~700MB: more headroom, same CPU
fly scale vm performance-1x --memory 2048   # tick budget > ~50%: a dedicated fast core
                                            # (Node is single-threaded — one fast core
                                            # beats many shared ones; never -2x/-4x for this)
fly scale show                         # verify; count MUST read exactly 1
```

**Never** `fly scale count 2` (or let auto-HA do it) — see recommendation 2.
`fly.toml [[vm]]` should be updated to match whatever you scale to, or the
next `fly deploy` silently scales it back.

### Load shedding (if the box is ever saturated)

The server already sheds at the edges — know the knobs before an incident:
- `MAX_INSTANCES` (gameServer.ts, 200): new party codes beyond it get
  `server full` and a clean close; existing parties are untouched. Lower it
  if tick budget saturates before instance count does.
- `SNAPSHOT_EVERY` (gameServer.ts, 2 → 15/s): raising to 3 (10/s) cuts
  snapshot bandwidth + serialization CPU by a third; clients already lerp
  between snapshots, so 10/s stays playable (the 2D host runs fine on less).
- Party caps (6 co-op / 10 roam / 4 rivals) bound per-instance cost; the
  per-IP token bucket bounds leaderboard spam. Neither needs touching under
  load.
- A runaway single instance (sim bug) self-heals: its tick throw drops only
  that party (tickInstance try/catch), everyone else keeps playing.

Re-run the measurement anytime with `scripts/loadtest.mjs <parties>
<perParty> <seconds>` (spawns bot parties that move/cast and reports /health
telemetry, client snapshot-gap percentiles, and per-client wire cost both
decompressed and on the socket). `HOST=localhost:PORT` points it at a local
server (start one with `PORT=5288 npm run server`); `ROAM=1` makes the bot
parties roam campaigns — roam ships extra world state, so measure both.

## GCP migration plan (when the time comes)

The container contract (PORT env, `/health`, single stateful process) maps
directly onto GCP. Two sane landing zones, in order of preference:

1. **Cloud Run** — push the same image to Artifact Registry, deploy with
   `--min-instances=1 --max-instances=1 --session-affinity --timeout=3600
   --cpu-always-allocated`. Min=max=1 because party state is in-memory: every
   player must hit the same instance, and it must not scale to zero. Cloud Run
   supports WebSockets (up to a 60-min stream; the client should auto-reconnect
   — add that alongside persistence). This is the lowest-ops option.
2. **Compute Engine e2-micro** — free-tier VM running the container under
   systemd/Container-Optimized OS. No request timeouts, no affinity caveats;
   slightly more ops (TLS via a Caddy sidecar or a load balancer).

Migration steps (~an afternoon):
- `docker build` + push to Artifact Registry (`gcloud builds submit` works too).
- Deploy per the above; verify `/health`; point DNS at it. Done — no code changes.

What to do **before** GCP makes sense:
- **Persistence is NOT a reason to migrate** — it lands on Fly as SQLite on
  the existing volume (PERSISTENCE.md). GCP only enters the picture if
  parties ever shard across machines, and even then Fly Postgres is the
  nearer step.
- **Reconnect logic** in `netClient.ts` (auto-rejoin with the same seat) — also
  what makes Cloud Run's 60-minute stream cap a non-issue.
- If parties ever outgrow one process: shard instances across machines by party
  code (each party is fully independent — trivially shardable).

## Cost reality

- Fly.io: ~$6/mo at this footprint (one shared-cpu-1x 1GB machine).
- GCP: Cloud Run min-instances=1 ≈ $8–15/mo; e2-micro VM ≈ free tier.
- Static-egress note: the client bundle + 33MB of models per first visit;
  cached after. At friends-scale, negligible everywhere.
