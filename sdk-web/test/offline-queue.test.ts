import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBOfflineQueue, OfflineQueueFullError } from "../src/offline-queue.js";

type RecordValue = { id: string; payload: string; createdAt: number; attempts: number };
class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((this: IDBRequest<T>, event: Event) => unknown) | null = null;
  onerror: ((this: IDBRequest<T>, event: Event) => unknown) | null = null;
  succeed(): void { this.onsuccess?.call(this as unknown as IDBRequest<T>, new Event("success")); }
}
class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  private operations: Array<() => void> = [];
  private aborted = false;
  constructor(private readonly data: Map<string, RecordValue>) {}
  objectStore(): IDBObjectStore { return new FakeObjectStore(this, this.data) as unknown as IDBObjectStore; }
  add(operation: () => void): void { this.operations.push(operation); }
  abort(): void { this.aborted = true; }
  execute(): void {
    if (this.aborted) { this.onabort?.call(this as unknown as IDBTransaction, new Event("abort")); return; }
    for (let index = 0; index < this.operations.length && !this.aborted; index++) this.operations[index]?.();
    if (this.aborted) this.onabort?.call(this as unknown as IDBTransaction, new Event("abort"));
    else this.oncomplete?.call(this as unknown as IDBTransaction, new Event("complete"));
  }
}
class FakeObjectStore {
  constructor(private readonly transaction: FakeTransaction, private readonly data: Map<string, RecordValue>) {}
  getAll(): IDBRequest {
    const request = new FakeRequest<RecordValue[]>();
    this.transaction.add(() => { request.result = [...this.data.values()]; request.succeed(); });
    return request as unknown as IDBRequest;
  }
  count(): IDBRequest<number> {
    const request = new FakeRequest<number>();
    this.transaction.add(() => { request.result = this.data.size; request.succeed(); });
    return request as unknown as IDBRequest<number>;
  }
  put(value: RecordValue): IDBRequest {
    const request = new FakeRequest<IDBValidKey>();
    this.transaction.add(() => { this.data.set(value.id, value); request.result = value.id; request.succeed(); });
    return request as unknown as IDBRequest;
  }
  delete(key: IDBValidKey): IDBRequest {
    const request = new FakeRequest<undefined>();
    this.transaction.add(() => { this.data.delete(String(key)); request.result = undefined; request.succeed(); });
    return request as unknown as IDBRequest;
  }
}
class FakeDatabase {
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  onversionchange: ((this: IDBDatabase, event: Event) => unknown) | null = null;
  private stores = new Map<string, Map<string, RecordValue>>();
  createObjectStore(name: string): IDBObjectStore {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return {} as IDBObjectStore;
  }
  transaction(name: string): IDBTransaction {
    const data = this.stores.get(name);
    if (!data) throw new Error("Object store does not exist");
    const transaction = new FakeTransaction(data);
    queueMicrotask(() => transaction.execute());
    return transaction as unknown as IDBTransaction;
  }
  close(): void {}
}
class FakeFactory {
  private databases = new Map<string, FakeDatabase>();
  open(name: string): IDBOpenDBRequest {
    const request = new FakeRequest<IDBDatabase>() as FakeRequest<IDBDatabase> & {
      onupgradeneeded: ((this: IDBOpenDBRequest, event: IDBVersionChangeEvent) => unknown) | null;
      onblocked: ((this: IDBOpenDBRequest, event: Event) => unknown) | null;
    };
    request.onupgradeneeded = null;
    request.onblocked = null;
    queueMicrotask(() => {
      let database = this.databases.get(name);
      const fresh = !database;
      if (!database) { database = new FakeDatabase(); this.databases.set(name, database); }
      request.result = database as unknown as IDBDatabase;
      if (fresh) request.onupgradeneeded?.call(request as unknown as IDBOpenDBRequest, new Event("upgradeneeded") as IDBVersionChangeEvent);
      request.succeed();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}
let clock = 1000;
const factory = new FakeFactory();
const queues: IndexedDBOfflineQueue[] = [];
function createQueue(options: { maxItems?: number; maxAgeMs?: number; maxPayloadBytes?: number } = {}) {
  const queue = new IndexedDBOfflineQueue({
    databaseName: "offline-queue-tests",
    factory: factory as unknown as IDBFactory,
    now: () => clock,
    ...options,
  });
  queues.push(queue);
  return queue;
}
afterEach(async () => {
  await Promise.all(queues.splice(0).map(queue => queue.close()));
  clock = 1000;
});

describe("IndexedDBOfflineQueue", () => {
  it("retains payloads until the sender confirms delivery", async () => {
    const queue = createQueue();
    await queue.enqueue('{"event":1}');
    expect(await queue.count()).toBe(1);
    const failedKeys: string[] = [];
    const failed = await queue.flush(async (_payload, key) => { failedKeys.push(key); return false; });
    expect(failed).toEqual({ delivered: 0, expired: 0, remaining: 1 });
    const sent: string[] = [];
    const retryKeys: string[] = [];
    const delivered = await queue.flush(async (payload, key) => {
      sent.push(payload);
      retryKeys.push(key);
      return true;
    });
    expect(sent).toEqual(['{"event":1}']);
    expect(retryKeys).toEqual(failedKeys);
    expect(delivered).toEqual({ delivered: 1, expired: 0, remaining: 0 });
  });

  it("expires old payloads and enforces the configured capacity", async () => {
    const queue = createQueue({ maxItems: 1, maxAgeMs: 100 });
    await queue.enqueue("first");
    await expect(queue.enqueue("second")).rejects.toBeInstanceOf(OfflineQueueFullError);
    clock += 101;
    expect(await queue.flush(async () => true)).toEqual({ delivered: 0, expired: 1, remaining: 0 });
    await queue.enqueue("second");
    expect(await queue.count()).toBe(1);
  });

  it("rejects empty and oversized payloads before opening IndexedDB", async () => {
    const queue = createQueue({ maxPayloadBytes: 3 });
    await expect(queue.enqueue("")).rejects.toThrow("non-empty");
    await expect(queue.enqueue("four")).rejects.toThrow("maxPayloadBytes");
  });

  it("validates queue limits", () => {
    expect(() => createQueue({ maxItems: 0 })).toThrow(RangeError);
    expect(() => createQueue({ maxAgeMs: 0 })).toThrow(RangeError);
    expect(() => createQueue({ maxPayloadBytes: 0 })).toThrow(RangeError);
  });
});
