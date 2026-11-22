import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBPolicyVersionStore } from "../src/policy-indexeddb.js";

type StoreData = Map<IDBValidKey, unknown>;
type Operation = () => void;

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((this: IDBRequest<T>, event: Event) => unknown) | null = null;
  onerror: ((this: IDBRequest<T>, event: Event) => unknown) | null = null;

  succeed(): void {
    this.onsuccess?.call(this as unknown as IDBRequest<T>, new Event("success"));
  }
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  private readonly operations: Operation[] = [];
  private aborted = false;

  constructor(private readonly database: FakeDatabase, private readonly storeName: string) {
    database.enqueue(this);
  }

  objectStore(name: string): IDBObjectStore {
    if (name !== this.storeName) throw new Error("Unknown object store");
    return new FakeObjectStore(this, this.database.data(name)) as unknown as IDBObjectStore;
  }

  add(operation: Operation): void {
    this.operations.push(operation);
  }

  abort(): void {
    this.aborted = true;
  }

  execute(done: () => void): void {
    if (this.aborted) {
      this.onabort?.call(this as unknown as IDBTransaction, new Event("abort"));
      done();
      return;
    }
    let index = 0;
    while (index < this.operations.length && !this.aborted) this.operations[index++]?.();
    if (this.aborted) this.onabort?.call(this as unknown as IDBTransaction, new Event("abort"));
    else this.oncomplete?.call(this as unknown as IDBTransaction, new Event("complete"));
    done();
  }
}

class FakeObjectStore {
  constructor(private readonly transaction: FakeTransaction, private readonly data: StoreData) {}

  get(key: IDBValidKey): IDBRequest {
    const request = new FakeRequest<unknown>();
    this.transaction.add(() => {
      request.result = this.data.get(key);
      request.succeed();
    });
    return request as unknown as IDBRequest;
  }

  put(value: { id: IDBValidKey }): IDBRequest {
    const request = new FakeRequest<IDBValidKey>();
    this.transaction.add(() => {
      this.data.set(value.id, value);
      request.result = value.id;
      request.succeed();
    });
    return request as unknown as IDBRequest;
  }
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  onversionchange: ((this: IDBDatabase, event: Event) => unknown) | null = null;
  private readonly stores = new Map<string, StoreData>();
  private tail: Promise<void> = Promise.resolve();

  createObjectStore(name: string): IDBObjectStore {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return {} as IDBObjectStore;
  }

  data(name: string): StoreData {
    const store = this.stores.get(name);
    if (!store) throw new Error("Object store does not exist");
    return store;
  }

  transaction(name: string): IDBTransaction {
    if (!this.stores.has(name)) throw new Error("Object store does not exist");
    return new FakeTransaction(this, name) as unknown as IDBTransaction;
  }

  enqueue(transaction: FakeTransaction): void {
    this.tail = this.tail.then(() => new Promise<void>(resolve => {
      queueMicrotask(() => transaction.execute(resolve));
    }));
  }

  close(): void {}
}

class FakeIndexedDBFactory {
  private readonly databases = new Map<string, FakeDatabase>();

  open(name: string): IDBOpenDBRequest {
    const request = new FakeRequest<IDBDatabase>() as FakeRequest<IDBDatabase> & {
      onupgradeneeded: ((this: IDBOpenDBRequest, event: IDBVersionChangeEvent) => unknown) | null;
      onblocked: ((this: IDBOpenDBRequest, event: Event) => unknown) | null;
    };
    request.onupgradeneeded = null;
    request.onblocked = null;
    queueMicrotask(() => {
      let database = this.databases.get(name);
      const isNew = database === undefined;
      if (!database) {
        database = new FakeDatabase();
        this.databases.set(name, database);
      }
      request.result = database as unknown as IDBDatabase;
      if (isNew) request.onupgradeneeded?.call(request as unknown as IDBOpenDBRequest, new Event("upgradeneeded") as IDBVersionChangeEvent);
      request.succeed();
    });
    return request as unknown as IDBOpenDBRequest;
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    const request = new FakeRequest<IDBDatabase>();
    queueMicrotask(() => {
      this.databases.delete(name);
      request.succeed();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

const databaseName = "resilient-delivery-policy-version-tests";
const factory = new FakeIndexedDBFactory();
const stores: IndexedDBPolicyVersionStore[] = [];

function createStore(): IndexedDBPolicyVersionStore {
  const store = new IndexedDBPolicyVersionStore({ databaseName, factory: factory as unknown as IDBFactory });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await new Promise<void>(resolve => {
    const request = factory.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
  });
});

describe("IndexedDBPolicyVersionStore", () => {
  it("persists the highest accepted version across store instances", async () => {
    const first = createStore();
    expect(await first.advanceIfNewer(7)).toBe(true);
    expect(await first.advanceIfNewer(7)).toBe(false);
    expect(await first.advanceIfNewer(6)).toBe(false);

    const second = createStore();
    expect(await second.advanceIfNewer(8)).toBe(true);
    expect(await second.advanceIfNewer(7)).toBe(false);
  });

  it("serializes concurrent advances without accepting a stale version", async () => {
    const store = createStore();
    const results = await Promise.all([
      store.advanceIfNewer(11),
      store.advanceIfNewer(9),
      store.advanceIfNewer(10),
      store.advanceIfNewer(12),
      store.advanceIfNewer(12),
    ]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await store.advanceIfNewer(11)).toBe(false);
    expect(await store.advanceIfNewer(12)).toBe(false);
    expect(await store.advanceIfNewer(13)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid policy version %s",
    async version => {
      const store = createStore();
      await expect(store.advanceIfNewer(version)).rejects.toThrow("positive safe integer");
    },
  );
});
