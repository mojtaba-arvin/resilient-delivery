/* Minimal wake-up bridge. Delivery remains in the page so auth tokens are never
 * persisted in the Service Worker or IndexedDB queue. */
const FLUSH_TAG = "resilient-delivery-flush";

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("sync", event => {
  if (event.tag !== FLUSH_TAG) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: "RESILIENT_DELIVERY_FLUSH" });
  })());
});
