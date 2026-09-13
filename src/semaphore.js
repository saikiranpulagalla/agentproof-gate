export class Semaphore {
  #limit;
  #active = 0;
  #queue = [];

  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be >= 1");
    this.#limit = limit;
  }

  get active() { return this.#active; }
  get queued() { return this.#queue.length; }
  get limit() { return this.#limit; }

  async acquire(signal) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#releaseFactory();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.#queue.indexOf(waiter);
          if (idx >= 0) this.#queue.splice(idx, 1);
          reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  #releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#queue.shift();
      if (waiter) {
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.#releaseFactory());
      } else {
        this.#active -= 1;
      }
    };
  }

  async run(fn, signal) {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
