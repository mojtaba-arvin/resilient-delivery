import { readFile } from "node:fs/promises";

export function compareBenchmark(baseline, current, maxRegressionPercent = 20) {
  if (!Number.isFinite(maxRegressionPercent) || maxRegressionPercent < 0 || maxRegressionPercent > 500) {
    throw new RangeError("max regression percent must be between 0 and 500");
  }
  const beforeP95 = baseline?.latency_ms?.p95;
  const afterP95 = current?.latency_ms?.p95;
  const beforeThroughput = baseline?.requests_per_second;
  const afterThroughput = current?.requests_per_second;
  for (const [label, value] of [["baseline p95", beforeP95], ["current p95", afterP95], ["baseline throughput", beforeThroughput], ["current throughput", afterThroughput]]) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a positive finite number`);
  }
  const p95RegressionPercent = ((afterP95 - beforeP95) / beforeP95) * 100;
  const throughputRegressionPercent = ((beforeThroughput - afterThroughput) / beforeThroughput) * 100;
  return {
    passed: p95RegressionPercent <= maxRegressionPercent && throughputRegressionPercent <= maxRegressionPercent,
    maxRegressionPercent,
    p95RegressionPercent: Number(p95RegressionPercent.toFixed(2)),
    throughputRegressionPercent: Number(throughputRegressionPercent.toFixed(2)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [baselinePath, currentPath, ...flags] = process.argv.slice(2);
  if (!baselinePath || !currentPath) {
    process.stderr.write("Usage: node scripts/benchmark-regression.mjs <baseline.json> <current.json> [--max-regression=20]\n");
    process.exitCode = 2;
  } else {
    const threshold = Number(flags.find(value => value.startsWith("--max-regression="))?.split("=")[1] ?? 20);
    try {
      const [baseline, current] = await Promise.all([
        readFile(baselinePath, "utf8").then(JSON.parse),
        readFile(currentPath, "utf8").then(JSON.parse),
      ]);
      const result = compareBenchmark(baseline, current, threshold);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (!result.passed) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
