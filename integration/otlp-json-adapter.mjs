#!/usr/bin/env node
import http from "node:http";
import { convertOtlp } from "./otlp-json-convert.mjs";

const listenPort = Number(process.env.OTLP_ADAPTER_PORT ?? 4319);
const collectorUrl = new URL(process.env.COLLECTOR_URL ?? "http://127.0.0.1:8080/v1/telemetry/batches");
const collectorToken = process.env.COLLECTOR_BEARER_TOKEN;
const maxBodyBytes = 64 * 1024;
if (!collectorToken || collectorToken.length < 32) throw new Error("COLLECTOR_BEARER_TOKEN must contain at least 32 characters");
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new RangeError("Invalid OTLP_ADAPTER_PORT");


const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/logs") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  let payload;
  try {
    payload = convertOtlp(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_otlp_payload";
    process.stderr.write(`Rejected OTLP JSON logs payload: ${message}\n`);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: message }));
    return;
  }
  try {
    const upstream = await fetch(collectorUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${collectorToken}` },
      body: JSON.stringify(payload),
    });
    if (upstream.status === 202) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const retryable = upstream.status === 429 || upstream.status >= 500;
    const upstreamBody = (await upstream.text()).slice(0, 256);
    process.stderr.write(`Collector rejected converted OTLP batch (HTTP ${upstream.status}): ${upstreamBody}\n`);
    response.writeHead(retryable ? 503 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: "collector_rejected_batch",
      rejectedLogRecords: String(payload.events.length),
      upstreamStatus: upstream.status,
    }));
  } catch {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "collector_unavailable" }));
  }
});

const bindAddress = process.env.OTLP_ADAPTER_BIND ?? "127.0.0.1";
server.listen(listenPort, bindAddress, () => {
  process.stdout.write(`OTLP JSON Logs adapter listening on ${bindAddress}:${listenPort}/v1/logs\n`);
});
