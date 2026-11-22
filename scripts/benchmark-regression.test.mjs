import { test } from "node:test";
import assert from "node:assert/strict";
import { compareBenchmark } from "./benchmark-regression.mjs";

const baseline = { latency_ms: { p95: 100 }, requests_per_second: 1000 };

test("accepts benchmark results within the regression budget", () => {
  const result = compareBenchmark(baseline, { latency_ms: { p95: 115 }, requests_per_second: 900 }, 20);
  assert.equal(result.passed, true);
});

test("rejects p95 latency and throughput regressions above budget", () => {
  const result = compareBenchmark(baseline, { latency_ms: { p95: 140 }, requests_per_second: 700 }, 20);
  assert.equal(result.passed, false);
  assert.equal(result.p95RegressionPercent, 40);
  assert.equal(result.throughputRegressionPercent, 30);
});

test("rejects malformed or non-positive benchmark values", () => {
  assert.throws(() => compareBenchmark(baseline, { latency_ms: { p95: 0 }, requests_per_second: 1 }), /positive finite/);
  assert.throws(() => compareBenchmark(baseline, { latency_ms: { p95: 1 }, requests_per_second: 1 }, -1), /between 0 and 500/);
});
