# ADR 0003: Isolated network fault lab

- Status: Accepted
- Decision: use Toxiproxy for deterministic latency, timeout/partition, and peer-reset scenarios; use Linux netem in a disposable network namespace for actual packet loss.
- Rationale: Toxiproxy exposes a stable HTTP control API and avoids modifying host networking for routine tests. Packet loss is not claimed unless netem is used.
- Safety: admin and proxy ports bind to loopback; no production origins or credentials are discovered or persisted.
- Validation: configuration unit tests plus a real Toxiproxy CI toxic lifecycle and an operator-run end-to-end experiment.
