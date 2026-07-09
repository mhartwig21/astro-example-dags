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
- Hardening in `gameServer.ts`: sanitized intents, party cap 6, instance cap
  200, 16KB WebSocket payload cap, path-traversal-safe static serving.

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
`/data/dcc.sqlite` (`DB_FILE`): per-account character saves for multiplayer
parties — see PERSISTENCE.md. Run history / personal bests remain
browser-local (`dcc:history:v1`).

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
- 512MB shared-cpu-1x is generous; the sim is a few KB per party.
- Deploys restart the process → runs checkpoint on SIGTERM and clients
  auto-reconnect (a few seconds of pause). Deploying mid-boss is rude, not fatal.
- Custom domain later: `fly certs add game.yourdomain.com` + a CNAME.

## Capacity & sizing (measured 2026-07-03)

Evidence from a bot load test against production (`shared-cpu-1x`, 512MB,
1 machine, ord). `/health` exposes live telemetry: `instances`, `players`,
`tickMsEma`/`tickMsMax` (per-instance sim tick cost; the whole Node thread
has a 33ms budget per 30Hz tick across ALL instances), `rssMb`, `uptimeMin`.

| Load | Tick cost (per instance) | RSS | Client snapshot delivery |
|---|---|---|---|
| idle | -- | 84 MB | -- |
| 16 players / 4 parties | 0.65ms avg, 12ms max | 100 MB | p50 63ms (67 ideal), p95 115ms |
| 48 players / 12 parties | 0.5ms avg, 22ms max | 101 MB | p50 108ms, p95 500ms — degraded |

Findings:
- **CPU and memory are nowhere near the limit.** At 48 players the sim uses
  ~18% of the tick budget; RSS is ~100MB of 512.
- **The ceiling is BANDWIDTH, not the machine.** Snapshots are ~28KB of JSON
  at 15/s per client (~0.4 MB/s each; ~10 MB/s at 24 players). Degraded
  delivery at 48 players comes from the wire, and no machine size fixes it.
- Single-player never touches this server (the sim runs in the browser).

Recommendations:
1. **Stay on `shared-cpu-1x` / 512MB.** Comfortable to ~6-8 simultaneous
   parties (~25-30 players). Upgrading buys nothing measurable today.
2. **Exactly 1 machine is load-bearing, not budgetary.** Party state lives
   in process memory; a second machine splits same-code joins into separate
   universes. Scaling out needs Postgres persistence + session affinity
   (see GCP plan below). Never let auto-HA add a machine.
3. Optional cheap insurance once strangers play: bump memory to 1GB so an
   OOM restart (which wipes live parties) stays impossible.
4. When sustained 30+ concurrent players arrive, the FIRST fix is snapshot
   deltas + WebSocket compression (~5-10x bandwidth cut), THEN
   `performance-1x` if tick cost ever climbs — Node is single-threaded, so
   one fast core beats many shared ones.

Re-run the measurement anytime with `scripts/loadtest.mjs <parties>
<perParty> <seconds>` (spawns bot parties that move/cast and reports
/health telemetry + client snapshot-gap percentiles).

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

- Fly.io: ~$0–5/mo at this footprint (one shared-cpu 512MB machine).
- GCP: Cloud Run min-instances=1 ≈ $8–15/mo; e2-micro VM ≈ free tier.
- Static-egress note: the client bundle + 33MB of models per first visit;
  cached after. At friends-scale, negligible everywhere.
