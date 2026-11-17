/** Retry throttling / transient provider errors with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let delay = 2000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = e?.statusCode ?? e?.status ?? e?.cause?.statusCode;
      const transient =
        status === 429 || (status >= 500 && status < 600) || /throttl|too many requests|timeout|ECONNRESET|overloaded|ServiceUnavailable/i.test(msg);
      if (!transient || i >= attempts) throw e;
      await new Promise(r => setTimeout(r, delay + Math.random() * 1000));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}
