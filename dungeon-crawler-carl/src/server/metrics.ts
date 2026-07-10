// Prometheus exposition for the game server — hand-rolled (the text format
// is three line shapes; a client library would be the only new dependency).
// Fly scrapes /metrics (fly.toml [metrics]) into its managed Grafana at
// fly-metrics.net, so every series below gets history + graphs for free.
//
// Two kinds only:
// - counters: monotonic totals (rate() them in Grafana). Counting happens at
//   the call site via count().
// - gauges: lazy thunks read at scrape time (instances, EMA, rss) — the
//   server never spends a cycle on them between scrapes.

const HELP: Record<string, string> = {
  dcc_ticks_total: "Sim ticks stepped across all instances",
  dcc_tick_ms_total: "Milliseconds spent stepping ticks (rate/rate vs dcc_ticks_total = avg tick cost)",
  dcc_snapshot_bytes_total: "Snapshot bytes sent to clients (the wire-diet watchdog)",
  dcc_snapshot_messages_total: "Snapshot messages sent to clients",
  dcc_event_bytes_total: "Transient event/announcement/hit bytes sent to clients",
  dcc_ws_messages_in_total: "WebSocket messages received from clients",
  dcc_joins_total: "Party joins accepted (a session starts)",
  dcc_leaves_total: "Client disconnects (a session ends)",
  dcc_floors_descended_total: "Floor transitions ticked by live instances",
  dcc_runs_won_total: "Runs that reached the win screen",
  dcc_runs_lost_total: "Runs that ended in a wipe",
  dcc_instances: "Live party instances",
  dcc_players_connected: "Connected clients across all instances",
  dcc_tick_ms_ema: "Exponential moving average of per-instance tick cost (ms)",
  dcc_tick_ms_max: "Max single-tick cost since boot (ms)",
  dcc_rss_bytes: "Resident set size of the server process",
  dcc_uptime_seconds: "Seconds since the server booted",
};

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number>();

  count(name: keyof typeof HELP & string, n = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  /** Register a gauge read lazily at scrape time. */
  gauge(name: keyof typeof HELP & string, read: () => number): void {
    this.gauges.set(name, read);
  }

  render(): string {
    const lines: string[] = [];
    const emit = (name: string, value: number, type: "counter" | "gauge") => {
      lines.push(`# HELP ${name} ${HELP[name] ?? name}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${Number.isFinite(value) ? value : 0}`);
    };
    // Counters render even at zero so dashboards see the series immediately.
    for (const name of Object.keys(HELP)) {
      if (this.gauges.has(name)) emit(name, this.gauges.get(name)!(), "gauge");
      else if (!name.endsWith("_total")) continue;
      else emit(name, this.counters.get(name) ?? 0, "counter");
    }
    return lines.join("\n") + "\n";
  }
}
