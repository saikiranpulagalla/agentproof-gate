export class SlidingWindowRateLimiter {
  #limit;
  #windowMs;
  #entries = new Map();

  constructor({ limit = 24, windowMs = 60_000 } = {}) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  consume(key, now = Date.now()) {
    const cutoff = now - this.#windowMs;
    const existing = (this.#entries.get(key) ?? []).filter((ts) => ts > cutoff);
    if (existing.length >= this.#limit) {
      const retryAfterMs = Math.max(1, existing[0] + this.#windowMs - now);
      this.#entries.set(key, existing);
      return { allowed: false, retryAfterMs };
    }
    existing.push(now);
    this.#entries.set(key, existing);
    if (this.#entries.size > 2_000) {
      for (const [k, stamps] of this.#entries) {
        if (!stamps.some((ts) => ts > cutoff)) this.#entries.delete(k);
      }
    }
    return { allowed: true, remaining: this.#limit - existing.length };
  }
}
