export class Metrics {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.callsReceived = 0;
    this.requests = 0;
    this.success = 0;
    this.errors = 0;
    this.timeouts = 0;
    this.overloaded = 0;
    this.idempotentHits = 0;
    this.idempotencyConflicts = 0;
    this.degraded = 0;
    this.verdicts = Object.create(null);
    this.durations = [];
  }

  received() { this.callsReceived += 1; }

  record(result, durationMs) {
    this.requests += 1;
    this.durations.push(durationMs);
    if (this.durations.length > 1_000) this.durations.shift();
    if (result?.verdict === "ERROR") this.errors += 1;
    else this.success += 1;
    if (result?.degraded) this.degraded += 1;
    const verdict = result?.verdict ?? "UNKNOWN_RESULT";
    this.verdicts[verdict] = (this.verdicts[verdict] ?? 0) + 1;
  }

  snapshot(extra = {}) {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null;
    return {
      started_at: this.startedAt,
      calls_received: this.callsReceived,
      executions_recorded: this.requests,
      requests: this.requests,
      success: this.success,
      errors: this.errors,
      timeouts: this.timeouts,
      overloaded: this.overloaded,
      idempotent_hits: this.idempotentHits,
      idempotency_conflicts: this.idempotencyConflicts,
      degraded: this.degraded,
      verdicts: { ...this.verdicts },
      latency_ms: {
        p50: pct(0.5),
        p95: pct(0.95),
        max: sorted.length ? sorted.at(-1) : null,
      },
      ...extra,
    };
  }
}
