import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, summarizeTrials } from "./benchmark-summary.mjs";

test("percentile handles empty and sorted samples without mutating input", () => {
  const values = [9, 1, 5, 3];
  assert.equal(percentile([], .95), 0);
  assert.equal(percentile(values, .50), 3);
  assert.equal(percentile(values, .95), 9);
  assert.deepEqual(values, [9, 1, 5, 3]);
});

test("aggregates trials and counts only committed 202 responses as throughput", () => {
  const result = summarizeTrials([
    { requests: 4, concurrency: 2, elapsed_ms: 1000, latencies_ms: [10, 20, 30, 40], statuses: { "202": 2, "429": 1, network_error: 1 } },
    { requests: 3, concurrency: 2, elapsed_ms: 2000, latencies_ms: [50, 60, 70], statuses: { "202": 1, "503": 2 } },
  ]);
  assert.equal(result.trials, 2);
  assert.equal(result.requests, 7);
  assert.equal(result.committed_batches, 3);
  assert.equal(result.committed_events, 3);
  assert.equal(result.requests_per_second, 1);
  assert.equal(result.attempted_requests_per_second, 2.33);
  assert.deepEqual(result.statuses, { "202": 3, "429": 1, network_error: 1, "503": 2 });
  assert.equal(result.per_trial[0].committed_events_per_second, 2);
});

test("requires at least one trial", () => {
  assert.throws(() => summarizeTrials([]), /at least one/);
});
