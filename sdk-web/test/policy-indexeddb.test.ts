import { afterEach, describe, expect, it } from "vitest";
import { IndexedDBPolicyVersionStore } from "../src/policy-indexeddb.js";

const databaseName = `resilient-delivery-test-${Date.now()}-${Math.random()}`;
const stores: IndexedDBPolicyVersionStore[] = [];

function createStore(): IndexedDBPolicyVersionStore {
  const store = new IndexedDBPolicyVersionStore({ databaseName });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test database deletion was blocked"));
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
