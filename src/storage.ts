/** Where the SDK keeps what the page and its service worker both need. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key that starts with `prefix`, in order. */
  keys(prefix: string): Promise<string[]>;
}

export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    return value === undefined ? undefined : (structuredCloneSafe(value) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredCloneSafe(value));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

const structuredCloneSafe = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/**
 * IndexedDB, which a page and its service worker share (local storage is not visible to a service worker). If it is not
 * available, for example in a private window on some browsers, reads and writes fall back to memory for the life of the page.
 */
export class IdbStore implements KeyValueStore {
  private opened?: Promise<IDBDatabase | null>;
  private readonly fallback = new MemoryStore();

  constructor(
    private readonly factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
    private readonly name = 'zapiack-push',
  ) {}

  private open(): Promise<IDBDatabase | null> {
    if (!this.factory) return Promise.resolve(null);
    this.opened ??= new Promise((resolve) => {
      try {
        const request = this.factory!.open(this.name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.opened;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const request = fn(db.transaction('kv', mode).objectStore('kv'));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!(await this.open())) return this.fallback.get<T>(key);
    return (await this.run('readonly', (s) => s.get(key))) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!(await this.open())) return this.fallback.set(key, value);
    await this.run('readwrite', (s) => s.put(value, key));
  }

  async delete(key: string): Promise<void> {
    if (!(await this.open())) return this.fallback.delete(key);
    await this.run('readwrite', (s) => s.delete(key));
  }

  async keys(prefix: string): Promise<string[]> {
    if (!(await this.open())) return this.fallback.keys(prefix);
    const all = (await this.run('readonly', (s) => s.getAllKeys())) ?? [];
    return (all as IDBValidKey[]).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix)).sort();
  }
}
