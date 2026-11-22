#!/usr/bin/env node
import http from "node:http";
import https from "node:https";

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "true"];
}));
const target = new URL(args.target ?? "http://127.0.0.1:8080");
const port = Number(args.port ?? 9080);
const delayMs = Number(args.delayMs ?? 0);
const failEvery = Number(args.failEvery ?? 0);
const dropEvery = Number(args.dropEvery ?? 0);
const statusOverride = Number(args.status ?? 0);
if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    !Number.isFinite(delayMs) || delayMs < 0 ||
    !Number.isSafeInteger(failEvery) || failEvery < 0 ||
    !Number.isSafeInteger(dropEvery) || dropEvery < 0) {
  throw new RangeError("Invalid proxy configuration");
}
let requests = 0;
const server = http.createServer((incoming, outgoing) => {
  const sequence = ++requests;
  if (dropEvery > 0 && sequence % dropEvery === 0) {
    outgoing.destroy();
    return;
  }
  if (failEvery > 0 && sequence % failEvery === 0) {
    outgoing.writeHead(statusOverride || 503, { "content-type": "text/plain", "cache-control": "no-store" });
    outgoing.end("injected failure");
    return;
  }
  const forward = () => {
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: incoming.method,
      path: new URL(incoming.url, target).pathname + new URL(incoming.url, target).search,
      headers: { ...incoming.headers, host: target.host },
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  };
  setTimeout(forward, delayMs);
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Fault proxy listening on http://127.0.0.1:${port} -> ${target.origin}\n`);
});
