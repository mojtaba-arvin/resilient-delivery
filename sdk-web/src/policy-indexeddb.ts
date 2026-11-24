import type { PolicyVersionStore } from "./policy.js";

export interface IndexedDBPolicyVersionStoreOptions {
  databaseName?: string;
  objectStoreName?: string;
  /** Injectable IndexedDB factory for tests and alternate browser realms. */
  factory?: IDBFactory;
}

/**
 * Durable PolicyVersionStore backed by IndexedDB.
 *
 * The read and conditional write happen in one readwrite transaction. IndexedDB
 * serializes overlapping readwrite transactions for the same object store.
 * Calls resolve only after transaction completion (commit), never merely after
 * an individual put request succeeds.
 */
export class IndexedDBPolicyVersionStore implements PolicyVersionStore {
  private readonly databaseName: string;
  private readonly objectStoreName: string;
  private readonly factory: IDBFactory | undefined;
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDBPolicyVersionStoreOptions = {}) {
    this.databaseName = options.databaseName ?? "resilient-delivery";
    this.objectStoreName = options.objectStoreName ?? "policy-version";
    this.factory = options.factory;
    if (!this.databaseName.trim()) throw new TypeError("IndexedDB databaseName must be non-empty");
    if (!this.objectStoreName.trim()) throw new TypeError("IndexedDB objectStoreName must be non-empty");
  }

  async advanceIfNewer(version: number): Promise<boolean> {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError("Policy version must be a positive safe integer");
    }

    const database = await this.openDatabase();
    return new Promise<boolean>((resolve, reject) => {
      let accepted = false;
      let settled = false;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(this.objectStoreName, "readwrite");
      } catch (error) {
        reject(error);
        return;
      }

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error("IndexedDB policy version transaction failed"));
      };

      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(accepted);
      };
      transaction.onerror = () => fail(transaction.error ?? new Error("IndexedDB transaction failed"));
      transaction.onabort = () => fail(transaction.error ?? new Error("IndexedDB transaction aborted"));

      try {
        const store = transaction.objectStore(this.objectStoreName);
        const read = store.get("highest");
        read.onerror = () => {
          try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
        };
        read.onsuccess = () => {
          const record = read.result as { id?: unknown; version?: unknown } | undefined;
          if (record !== undefined &&
              (record.id !== "highest" || !Number.isSafeInteger(record.version) || (record.version as number) < 1)) {
            try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
            fail(new TypeError("Stored policy version record is invalid"));
            return;
          }
          if (version > (record?.version as number ?? 0)) {
            accepted = true;
            store.put({ id: "highest", version });
          }
        };
      } catch (error) {
        try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
        fail(error);
      }
    });
  }

  /** Close this instance's connection. A later operation will reopen it. */
  async close(): Promise<void> {
    const pending = this.databasePromise;
    this.databasePromise = undefined;
    if (pending) {
      try {
        (await pending).close();
      } catch {
        // A failed open has no live connection to close.
      }
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const factory = this.factory ?? globalThis.indexedDB;
    if (!factory) return Promise.reject(new Error("IndexedDB is unavailable in this runtime"));

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.databaseName, 1);
      } catch (error) {
        reject(error);
        return;
      }
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.objectStoreName)) {
          database.createObjectStore(this.objectStoreName, { keyPath: "id" });
        }
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error("IndexedDB open was blocked by another connection"));
      };
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) {
          database.close();
          return;
        }
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
