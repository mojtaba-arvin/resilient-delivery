import { test } from "node:test";
import assert from "node:assert/strict";
import { toxicFor } from "./network-resilience-lab.mjs";

test("latency toxic has bounded deterministic delay and jitter", () => {
  assert.deepEqual(toxicFor("latency"), {
    name: "delivery-latency", type: "latency", stream: "downstream", toxicity: 1,
    attributes: { latency: 750, jitter: 150 },
  });
});

test("partition toxic represents a full downstream timeout", () => {
  const toxic = toxicFor("partition");
  assert.equal(toxic.type, "timeout");
  assert.equal(toxic.attributes.timeout, 0);
});

test("reset toxic closes the peer connection", () => {
  assert.equal(toxicFor("reset").type, "reset_peer");
});

test("unknown fault modes fail closed", () => {
  assert.throws(() => toxicFor("silent-data-corruption"), /Unsupported fault mode/);
});
