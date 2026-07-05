# Repo guide

Two unrelated things live here:

- **`dungeon-crawler-carl/` — the active project.** A Diablo-like multiplayer
  ARPG (Dungeon Crawler Carl-inspired) with a pure deterministic sim core and
  2D/3D/server hosts. **Start at `dungeon-crawler-carl/CLAUDE.md`** — it's the
  onboarding map (architecture, codebase tour, workflows, deploy runbook).
  Nearly all work happens there.
- `dags/`, `tests/`, `Dockerfile`, `requirements.txt` at the root — a legacy
  Astronomer/Airflow example scaffold this repo started from. Rarely touched;
  leave it alone unless asked.

Git: branch from `origin/main`, PR to main. Multiple agent sessions often run
in parallel — expect main to move while you work; merge `origin/main` into
your branch and re-test before merging a PR.
