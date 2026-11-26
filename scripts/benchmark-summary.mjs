export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

export function summarizeTrials(trials) {
  if (!Array.isArray(trials) || trials.length === 0) {
    throw new TypeError("at least one benchmark trial is required");
  }
  const latencies = trials.flatMap(trial => trial.latencies_ms);
  const statuses = {};
  for (const trial of trials) {
    for (const [status, count] of Object.entries(trial.statuses)) {
      statuses[status] = (statuses[status] ?? 0) + count;
    }
  }
  const requests = trials.reduce((sum, trial) => sum + trial.requests, 0);
  const elapsedMs = trials.reduce((sum, trial) => sum + trial.elapsed_ms, 0);
  const committedBatches = statuses["202"] ?? 0;
  // Every benchmark request contains exactly one event; collector 202 means committed.
  return {
    trials: trials.length,
    requests,
    concurrency: trials[0].concurrency,
    elapsed_ms: Number(elapsedMs.toFixed(2)),
    attempted_requests_per_second: Number((requests / (elapsedMs / 1000)).toFixed(2)),
    committed_batches: committedBatches,
    committed_events: committedBatches,
    requests_per_second: Number((committedBatches / (elapsedMs / 1000)).toFixed(2)),
    committed_events_per_second: Number((committedBatches / (elapsedMs / 1000)).toFixed(2)),
    latency_ms: {
      p50: Number(percentile(latencies, .50).toFixed(2)),
      p95: Number(percentile(latencies, .95).toFixed(2)),
      p99: Number(percentile(latencies, .99).toFixed(2)),
    },
    statuses,
    per_trial: trials.map((trial, index) => ({
      trial: index + 1,
      requests: trial.requests,
      elapsed_ms: Number(trial.elapsed_ms.toFixed(2)),
      attempted_requests_per_second: Number((trial.requests / (trial.elapsed_ms / 1000)).toFixed(2)),
      committed_batches: trial.statuses["202"] ?? 0,
      committed_events: trial.statuses["202"] ?? 0,
      committed_events_per_second: Number(((trial.statuses["202"] ?? 0) / (trial.elapsed_ms / 1000)).toFixed(2)),
      latency_ms: {
        p50: Number(percentile(trial.latencies_ms, .50).toFixed(2)),
        p95: Number(percentile(trial.latencies_ms, .95).toFixed(2)),
        p99: Number(percentile(trial.latencies_ms, .99).toFixed(2)),
      },
      statuses: trial.statuses,
    })),
    note: "Only HTTP 202 responses count as committed batches/events. Each request contains one event. Results include collector rate limiting (default burst 30, refill 2 requests/second); this is not a target-capacity certification."
  };
}
