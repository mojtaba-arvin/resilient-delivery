import { test } from "node:test";
import assert from "node:assert/strict";
import { convertOtlp, decodeOtlpJson } from "./otlp-json-convert.mjs";
import { gzipSync } from "node:zlib";

const attribute = (key, value) => ({ key, value });
const record = () => ({
  body: { stringValue: "sensitive log body must be discarded" },
  attributes: [
    attribute("resilient.route_index", { intValue: "3" }),
    attribute("resilient.duration_ms", { intValue: "42" }),
    attribute("resilient.outcome", { stringValue: "http_error" }),
    attribute("http.response.status_code", { intValue: "503" }),
    attribute("customer.email", { stringValue: "must-not-be-forwarded" }),
  ],
});
const request = logs => ({ resourceLogs: [{ resource: { attributes: [attribute("host.name", { stringValue: "private-host" })] }, scopeLogs: [{ logRecords: logs }] }] });

test("maps only minimized delivery attributes and discards other OTLP data", () => {
  assert.deepEqual(convertOtlp(request([record()])), {
    schemaVersion: 1,
    events: [{ schemaVersion: 1, routeIndex: 3, outcome: "http_error", durationMs: 42, status: 503 }],
  });
});

test("rejects missing required attributes and invalid values", () => {
  assert.throws(() => convertOtlp(request([{ attributes: [] }])), /must include valid/);
  const invalid = record();
  invalid.attributes[0] = attribute("resilient.route_index", { intValue: "32" });
  assert.throws(() => convertOtlp(request([invalid])), /must include valid/);
});

test("rejects empty batches and batches over the collector event limit", () => {
  assert.throws(() => convertOtlp(request([])), /no supported/);
  assert.throws(() => convertOtlp(request(Array.from({ length: 101 }, record))), /100-event/);
});

test("decodes identity and gzip OTLP JSON with a bounded decoded size", () => {
  const input = request([record()]);
  const expected = {
    schemaVersion: 1,
    events: [{ schemaVersion: 1, routeIndex: 3, outcome: "http_error", durationMs: 42, status: 503 }],
  };
  const json = Buffer.from(JSON.stringify(input));
  assert.deepEqual(convertOtlp(decodeOtlpJson(json)), expected);
  assert.deepEqual(convertOtlp(decodeOtlpJson(gzipSync(json), "gzip")), expected);
  assert.throws(() => decodeOtlpJson(json, "br"), /Unsupported OTLP content-encoding/);
  assert.throws(
    () => decodeOtlpJson(gzipSync(Buffer.alloc(64 * 1024 + 1)), "gzip"),
    /larger|buffer|output|length/i,
  );
});
