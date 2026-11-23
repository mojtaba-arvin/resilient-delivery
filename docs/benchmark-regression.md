# Benchmark Regression Gate

Run the collector benchmark against an isolated deployment and save its JSON output:

```sh
COLLECTOR_BEARER_TOKEN=<secret> node scripts/benchmark-collector.mjs --requests=1000 --concurrency=8 > current.json
node scripts/benchmark-regression.mjs baseline.json current.json --max-regression=20
```

The comparator fails if p95 latency rises or throughput falls by more than the configured percentage. Use a baseline captured on the same runner class, collector configuration, database state, and network path. Never compare results from different environments as if they were controlled measurements. Record the raw JSON artifact for every benchmark run.

## CI measurement scope

The pull-request CI benchmark starts a fresh local collector with the benchmark-only rate-limit override (`10000` burst and `10000` requests/second), then runs 100 warm-up requests followed by 1000 measured requests at concurrency 32. The uploaded `collector-benchmark` JSON is a reproducible smoke/capacity sample for that GitHub-hosted runner and commit; it is not a production SLO, a cross-runner baseline, or proof of sustained multi-hour capacity. Preserve the artifact with its commit SHA and runner context before making performance claims. A stable regression comparison still requires a baseline and current result captured on equivalent hardware and configuration.
