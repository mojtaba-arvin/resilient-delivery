import type { IndexedDBOfflineQueue, OfflinePayloadSender } from "./offline-queue.js";

export const OFFLINE_FLUSH_MESSAGE = "RESILIENT_DELIVERY_FLUSH";
export const OFFLINE_FLUSH_TAG = "resilient-delivery-flush";

type BackgroundSyncRegistration = ServiceWorkerRegistration & {
  sync?: { register(tag: string): Promise<void> };
};

/** Register the optional wake-up worker. The page remains responsible for delivery. */
export async function registerOfflineDeliveryServiceWorker(
  scriptUrl = "/resilient-delivery-sw.js",
  scope?: string,
): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Workers are unavailable in this runtime");
  }
  return navigator.serviceWorker.register(scriptUrl, scope ? { scope } : undefined);
}

/** Ask Background Sync to wake a controlled page when connectivity returns. */
export async function requestOfflineFlush(registration: ServiceWorkerRegistration): Promise<boolean> {
  const sync = (registration as BackgroundSyncRegistration).sync;
  if (!sync) return false;
  await sync.register(OFFLINE_FLUSH_TAG);
  return true;
}

/**
 * Connect the worker's wake-up message to the durable queue. The sender should
 * use the application's normal authenticated collector client and return true
 * only after a successful 2xx response.
 */
export function handleOfflineFlushMessages(
  queue: IndexedDBOfflineQueue,
  sender: OfflinePayloadSender,
): () => void {
  const listener = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== "object" || event.data === null ||
        (event.data as { type?: unknown }).type !== OFFLINE_FLUSH_MESSAGE) return;
    void queue.flush(sender).catch(() => {
      // Queue contents remain durable; the application may request another flush.
    });
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

/**
 * Flush on initial page startup and whenever the browser reports connectivity.
 * This fallback works when Background Sync is unavailable or no worker message
 * is delivered; the application's authenticated sender remains in the page.
 */
export function installOnlineFlushHandler(
  queue: IndexedDBOfflineQueue,
  sender: OfflinePayloadSender,
): () => void {
  const flush = (): void => {
    if (typeof navigator !== "undefined" && navigator.onLine) {
      void queue.flush(sender).catch(() => {
        // Failed sends remain queued and can be retried on the next online event.
      });
    }
  };
  window.addEventListener("online", flush);
  flush();
  return () => window.removeEventListener("online", flush);
}
