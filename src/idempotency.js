export class IdempotencyCache {
  #ttlMs;
  #maxEntries;
  #entries = new Map();

  constructor({ ttlMs = 600_000, maxEntries = 500 } = {}) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  #prune() {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.lifecycleSettled && entry.expiresAt <= now) this.#entries.delete(key);
    }
    if (this.#entries.size <= this.#maxEntries) return;
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxEntries) break;
      if (entry.lifecycleSettled) this.#entries.delete(key);
    }
  }

  get(key) {
    this.#prune();
    return this.#entries.get(key);
  }

  /**
   * publicPromise is what retries observe. lifecyclePromise tracks the actual
   * underlying work, which may outlive a caller-facing timeout if an adapter
   * ignores cancellation. The key stays occupied until lifecyclePromise ends.
   */
  put(key, fingerprint, publicPromise, { lifecyclePromise = publicPromise } = {}) {
    this.#prune();
    const entry = {
      fingerprint,
      promise: publicPromise,
      lifecyclePromise,
      lifecycleSettled: false,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.#entries.set(key, entry);
    Promise.resolve(lifecyclePromise).finally(() => {
      if (this.#entries.get(key) === entry) {
        entry.lifecycleSettled = true;
        entry.expiresAt = Date.now() + this.#ttlMs;
        this.#prune();
      }
    });
    this.#prune();
    return entry;
  }

  delete(key) {
    this.#entries.delete(key);
  }

  deleteIfLifecycleSettled(key) {
    const entry = this.#entries.get(key);
    if (entry?.lifecycleSettled) this.#entries.delete(key);
  }

  get size() {
    this.#prune();
    return this.#entries.size;
  }
}
