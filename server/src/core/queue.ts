/** Runs tasks one at a time per key (e.g. per Telegram chat) to keep replies in order. */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();
  private pending = 0;

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.pending++;
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.finally(() => {
      this.pending--;
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  get size(): number {
    return this.pending;
  }

  /** Resolves once every queued task has finished (or the timeout elapses). */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending > 0 && Date.now() < deadline) {
      await Promise.race([Promise.all([...this.tails.values()]), new Promise((r) => setTimeout(r, 100))]);
    }
  }
}

/** Collapses bursts of calls per key into one call after `delayMs` of quiet. */
export class Debouncer {
  private timers = new Map<string, { timer: NodeJS.Timeout; fn: () => void }>();

  constructor(private readonly delayMs: number) {}

  schedule(key: string, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing.timer);
    if (this.delayMs <= 0) {
      this.timers.delete(key);
      fn();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(key, { timer, fn });
  }

  /** Runs every pending callback immediately (used on shutdown). */
  flush(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const { timer, fn } of pending) {
      clearTimeout(timer);
      fn();
    }
  }
}

/** Fixed-window rate limiter kept in memory. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true when the call is allowed. */
  hit(key: string, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 50_000) this.prune(now);
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }

  private prune(now: number) {
    for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
  }
}

/** Small TTL cache. */
export class TtlCache<V> {
  private items = new Map<string, { value: V; expires: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expires < Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key: string, value: V): void {
    this.items.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.items.delete(key);
  }
}
