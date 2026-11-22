# Benchmark Regression Gate

Run the collector benchmark against an isolated deployment and save its JSON output:

```sh
COLLECTOR_BEARER_TOKEN=<secret> node scripts/benchmark-collector.mjs --requests=1000 --concurrency=8 > current.json
node scripts/benchmark-regression.mjs baseline.json current.json --max-regression=20
```

The comparator fails if p95 latency rises or throughput falls by more than the configured percentage. Use a baseline captured on the same runner class, collector configuration, database state, and network path. Never compare results from different environments as if they were controlled measurements. Record the raw JSON artifact for every benchmark run.
