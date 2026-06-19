// Minimal promisified IndexedDB wrapper for local project/asset persistence.
// No external deps — matches the repo's hand-rolled, built-in-state approach.
//
// Layout (DB "photo-editor", v1):
//   projects  keyPath "id"  -> { id, doc, assetIds, updatedAt, thumbnail? }
//   assets    keyPath "id"  -> { id, blob }   (image bytes; PNG to keep alpha)
//   meta      keyPath "key" -> { key, value } (e.g. lastProjectId)
//
// The Doc is bitmap-free (see lib/doc/types.ts), so it serializes as plain JSON;
// heavy bitmaps live in the `assets` store keyed by the same `assetId` the Doc
// references. This is the "drop-in" persistence the model was designed for.

const DB_NAME = "photo-editor";
const DB_VERSION = 1;

export type StoreName = "projects" | "assets" | "meta";

let dbPromise: Promise<IDBDatabase> | null = null;

function isAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

// Opens (and on first run, creates) the database. Memoized so the upgrade runs
// once and every caller shares one connection.
export function openDB(): Promise<IDBDatabase> {
  if (!isAvailable()) {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });

  // Don't cache a rejected promise — let the next call retry.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

// Wrap a single-request transaction in a promise that resolves with `result`
// only after the transaction itself completes (so writes are durable).
function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        let result: T;
        req.onsuccess = () => {
          result = req.result as T;
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
      })
  );
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return run<T | undefined>(store, "readonly", (s) => s.get(key));
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, "readonly", (s) => s.getAll());
}

export function idbPut(store: StoreName, value: unknown): Promise<void> {
  return run<void>(store, "readwrite", (s) => s.put(value as never)).then(() => undefined);
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  return run<void>(store, "readwrite", (s) => s.delete(key)).then(() => undefined);
}
