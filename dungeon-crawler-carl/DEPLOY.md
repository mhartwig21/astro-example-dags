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
- Party state is **in-memory** in this single process. That is fine (and cheap)
  at friends-scale; a restart/deploy drops live runs. Character persistence is
  the next milestone (see GCP notes below).
- Hardening in `gameServer.ts`: sanitized intents, party cap 6, instance cap
  200, 16KB WebSocket payload cap, path-traversal-safe static serving.

## Try the production build locally

```bash
npm run build
PORT=8080 STATIC_DIR=dist npm run server
# open http://localhost:8080/iso.html?join=TEST&name=You
```

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
- Deploys restart the process → live runs drop. Deploy when nobody's crawling.
- Custom domain later: `fly certs add game.yourdomain.com` + a CNAME.

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
- **Persistence** (the real reason to migrate): move character saves +
  instance snapshots into **Cloud SQL (Postgres)** or Firestore, so deploys and
  restarts stop dropping runs and drop-in/drop-out survives the process. The
  save shape already exists (`SavedProgress` / `serialize()`).
- **Reconnect logic** in `netClient.ts` (auto-rejoin with the same seat) — also
  what makes Cloud Run's 60-minute stream cap a non-issue.
- If parties ever outgrow one process: shard instances across machines by party
  code (each party is fully independent — trivially shardable).

## Cost reality

- Fly.io: ~$0–5/mo at this footprint (one shared-cpu 512MB machine).
- GCP: Cloud Run min-instances=1 ≈ $8–15/mo; e2-micro VM ≈ free tier.
- Static-egress note: the client bundle + 33MB of models per first visit;
  cached after. At friends-scale, negligible everywhere.
