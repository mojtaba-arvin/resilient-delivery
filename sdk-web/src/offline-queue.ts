export interface OfflineQueueOptions {
  databaseName?: string;
  objectStoreName?: string;
  maxItems?: number;
  maxAgeMs?: number;
  maxPayloadBytes?: number;
  now?: () => number;
  factory?: IDBFactory;
}

interface QueueRecord {
  id: string;
  payload: string;
  createdAt: number;
  attempts: number;
}

export interface OfflineFlushResult {
  delivered: number;
  expired: number;
  remaining: number;
}

export type OfflinePayloadSender = (payload: string, idempotencyKey: string) => Promise<boolean>;

export class OfflineQueueFullError extends Error {
  constructor() {
    super("Offline delivery queue is full");
    this.name = "OfflineQueueFullError";
  }
}

/**
 * A bounded, durable browser queue. Payloads are application-defined strings;
 * callers must enqueue only consented, minimized observations, never secrets.
 * A payload is removed only after the sender confirms successful delivery.
 */
export class IndexedDBOfflineQueue {
  private readonly databaseName: string;
  private readonly objectStoreName: string;
  private readonly maxItems: number;
  private readonly maxAgeMs: number;
  private readonly maxPayloadBytes: number;
  private readonly now: () => number;
  private readonly factory: IDBFactory | undefined;
  private databasePromise: Promise<IDBDatabase> | undefined;
  private flushing: Promise<OfflineFlushResult> | undefined;

  constructor(options: OfflineQueueOptions = {}) {
    this.databaseName = options.databaseName ?? "resilient-delivery-offline";
    this.objectStoreName = options.objectStoreName ?? "offline-observations";
    this.maxItems = options.maxItems ?? 1000;
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024;
    this.now = options.now ?? Date.now;
    this.factory = options.factory;
    if (!this.databaseName.trim() || !this.objectStoreName.trim()) {
      throw new TypeError("IndexedDB names must be non-empty");
    }
    if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 1) {
      throw new RangeError("maxItems must be a positive safe integer");
    }
    if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs < 1) {
      throw new RangeError("maxAgeMs must be positive and finite");
    }
    if (!Number.isSafeInteger(this.maxPayloadBytes) || this.maxPayloadBytes < 1) {
      throw new RangeError("maxPayloadBytes must be a positive safe integer");
    }
  }

  async enqueue(payload: string): Promise<void> {
    if (typeof payload !== "string" || payload.length === 0) {
      throw new TypeError("Offline payload must be a non-empty string");
    }
    if (new TextEncoder().encode(payload).byteLength > this.maxPayloadBytes) {
      throw new RangeError("Offline payload exceeds maxPayloadBytes");
    }
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(this.objectStoreName, "readwrite");
      const store = transaction.objectStore(this.objectStoreName);
      const read = store.getAll();
      let failure: unknown;
      read.onsuccess = () => {
        const now = this.now();
        const records = read.result as QueueRecord[];
        for (const record of records) {
          if (now - record.createdAt > this.maxAgeMs) store.delete(record.id);
        }
        const liveCount = records.filter(record => now - record.createdAt <= this.maxAgeMs).length;
        if (liveCount >= this.maxItems) {
          failure = new OfflineQueueFullError();
          transaction.abort();
          return;
        }
        const id = typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${now}-${Math.random().toString(36).slice(2)}`;
        store.put({ id, payload, createdAt: now, attempts: 0 } satisfies QueueRecord);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Offline queue transaction failed"));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Offline queue transaction aborted"));
    });
  }

  flush(sender: OfflinePayloadSender): Promise<OfflineFlushResult> {
    if (this.flushing) return this.flushing;
    const pending = this.flushInternal(sender).finally(() => {
      if (this.flushing === pending) this.flushing = undefined;
    });
    this.flushing = pending;
    return pending;
  }

  async count(): Promise<number> {
    const database = await this.openDatabase();
    return new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(this.objectStoreName, "readonly");
      const request = transaction.objectStore(this.objectStoreName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to count offline queue"));
    });
  }

  async close(): Promise<void> {
    const pending = this.databasePromise;
    this.databasePromise = undefined;
    if (pending) {
      try { (await pending).close(); } catch { /* No connection exists after a failed open. */ }
    }
  }

  private async flushInternal(sender: OfflinePayloadSender): Promise<OfflineFlushResult> {
    const database = await this.openDatabase();
    let delivered = 0;
    let expired = 0;
    while (true) {
      const record = await new Promise<QueueRecord | undefined>((resolve, reject) => {
        const transaction = database.transaction(this.objectStoreName, "readonly");
        const request = transaction.objectStore(this.objectStoreName).getAll();
        request.onsuccess = () => {
          const records = (request.result as QueueRecord[]).sort((a, b) => a.createdAt - b.createdAt);
          resolve(records[0]);
        };
        request.onerror = () => reject(request.error ?? new Error("Unable to read offline queue"));
      });
      if (!record) break;
      if (this.now() - record.createdAt > this.maxAgeMs) {
        await this.deleteRecord(database, record.id);
        expired++;
        continue;
      }
      let accepted = false;
      try { accepted = await sender(record.payload, record.id); } catch { accepted = false; }
      if (!accepted) {
        await this.updateAttempts(database, { ...record, attempts: record.attempts + 1 });
        break;
      }
      await this.deleteRecord(database, record.id);
      delivered++;
    }
    return { delivered, expired, remaining: await this.count() };
  }

  private deleteRecord(database: IDBDatabase, id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.objectStoreName, "readwrite");
      transaction.objectStore(this.objectStoreName).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to delete delivered offline item"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline queue delete aborted"));
    });
  }

  private updateAttempts(database: IDBDatabase, record: QueueRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(this.objectStoreName, "readwrite");
      transaction.objectStore(this.objectStoreName).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to update offline retry count"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline retry update aborted"));
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const factory = this.factory ?? globalThis.indexedDB;
    if (!factory) return Promise.reject(new Error("IndexedDB is unavailable in this runtime"));
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.objectStoreName)) {
          request.result.createObjectStore(this.objectStoreName, { keyPath: "id" });
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Unable to open offline queue"));
      request.onblocked = () => reject(new Error("Offline queue database open was blocked"));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          this.databasePromise = undefined;
        };
        resolve(database);
      };
    });
    const cached = opening.catch(error => {
      if (this.databasePromise === cached) this.databasePromise = undefined;
      throw error;
    });
    this.databasePromise = cached;
    return cached;
  }
}
