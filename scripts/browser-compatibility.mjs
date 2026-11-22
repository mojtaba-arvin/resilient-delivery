import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const root = resolve("sdk-web");
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><html><head><meta charset='utf-8'></head><body>Resilient Delivery browser compatibility smoke</body></html>");
    return;
  }
  const relative = path === "/sw.js" ? "public/resilient-delivery-sw.js" : path.replace(/^\//, "");
  const file = resolve(root, relative);
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": extname(file) === ".js" ? "text/javascript" : "text/html" });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
const url = `http://127.0.0.1:${address.port}`;
const results = [];
try {
  for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const result = await page.evaluate(async () => {
        const { IndexedDBOfflineQueue } = await import("/dist/offline-queue.js");
        const queue = new IndexedDBOfflineQueue({ databaseName: `compat-${crypto.randomUUID()}` });
        await queue.enqueue("minimized-test-observation");
        const flush = await queue.flush(async (payload, key) => payload === "minimized-test-observation" && key.length > 0);
        const registration = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
        await queue.close();
        return {
          indexedDb: flush.delivered === 1 && flush.remaining === 0,
          serviceWorker: Boolean(registration.active),
          backgroundSync: "sync" in registration,
        };
      });
      if (!result.indexedDb || !result.serviceWorker) throw new Error(`${name} failed browser storage/service-worker checks: ${JSON.stringify(result)}`);
      results.push({ browser: name, ...result, status: "passed" });
    } finally { await browser.close(); }
  }
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n");
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
}
