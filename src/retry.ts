/**
 * Retry throttling / transient provider errors with exponential backoff.
 * SDK-level retries are disabled (maxRetries: 0) so that every retry happens here: usage is then
 * always reported by the successful call, and latency can be timed on that attempt alone.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 12): Promise<T> {
  let delay = 5000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = e?.statusCode ?? e?.status ?? e?.cause?.statusCode ?? e?.lastError?.statusCode;
      const transient =
        status === 429 || (status >= 500 && status < 600) || /throttl|too many requests|timeout|ECONNRESET|overloaded|ServiceUnavailable/i.test(msg);
      if (!transient || i >= attempts) throw e;
      await new Promise(r => setTimeout(r, delay + Math.random() * 2000));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

/** Minimal async semaphore. */
export class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>(r => this.queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}
