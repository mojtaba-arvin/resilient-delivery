# Network Resilience Lab

The lab uses an isolated Toxiproxy instance; it does not discover or alter application origins. Keep the admin API and proxy listener bound to loopback outside disposable CI containers.

## Start

Run Toxiproxy locally:

```sh
docker run --rm --name resilient-toxiproxy \
  -p 127.0.0.1:8474:8474 -p 127.0.0.1:18080:18080 \
  ghcr.io/shopify/toxiproxy:2.12.0
```

Configure `TOXIPROXY_UPSTREAM` to the collector address reachable from the Toxiproxy container, then:

```sh
node scripts/network-resilience-lab.mjs latency
node scripts/network-resilience-lab.mjs report
node scripts/network-resilience-lab.mjs clear
```

Modes:
- `latency`: 750 ms latency with 150 ms jitter.
- `partition`: downstream timeout (no response).
- `reset`: reset the downstream peer.
- `clear`: remove all toxics.
- `report`: emit a timestamped JSON snapshot.

## Packet loss

Toxiproxy does not provide a true packet-loss toxic. On a disposable Linux network namespace, use Linux `tc netem` rather than mislabeling latency or slicing as packet loss:

```sh
sudo tc qdisc add dev <isolated-interface> root netem loss 5%
sudo tc qdisc del dev <isolated-interface> root
```

Never apply netem to a production interface. Each experiment should record configured fault, request count, accepted count, replay count, and recovery time. A successful experiment must prove that a retry after recovery uses the original idempotency key.
