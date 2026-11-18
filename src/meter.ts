import { AsyncLocalStorage } from 'node:async_hooks';
import { type Usage, emptyUsage } from './usage.js';

/**
 * Provider-level usage meter.
 *
 * Mastra's per-call `usage` / `totalUsage` turned out to be unreliable when several agents
 * run concurrently in one process (missing or mis-attributed counts), so every model call
 * is metered here instead: the wrapped model records the usage the provider returns for each
 * actual API request (each step of a tool loop included) into the bucket of the task that
 * made it. Buckets are scoped with AsyncLocalStorage.
 */
const scope = new AsyncLocalStorage<{ usage: Usage }>();

export async function metered<T>(fn: () => Promise<T>): Promise<{ result: T; usage: Usage }> {
  const bucket = { usage: emptyUsage() };
  const result = await scope.run(bucket, fn);
  return { result, usage: bucket.usage };
}

const num = (v: any): number => (typeof v === 'number' ? v : typeof v?.total === 'number' ? v.total : 0);

function record(bucket: { usage: Usage } | undefined, u: any) {
  if (!bucket || !u) return;
  const cacheRead = u.inputTokens?.cacheRead ?? u.cachedInputTokens ?? 0;
  const cacheWrite = u.inputTokens?.cacheWrite ?? 0;
  bucket.usage = {
    inputTokens: bucket.usage.inputTokens + num(u.inputTokens),
    outputTokens: bucket.usage.outputTokens + num(u.outputTokens),
    cacheReadTokens: bucket.usage.cacheReadTokens + (cacheRead || 0),
    cacheWriteTokens: bucket.usage.cacheWriteTokens + (cacheWrite || 0),
    calls: bucket.usage.calls + 1,
  };
}

/** Wrap an AI SDK language model so every doGenerate / doStream call is metered. */
export function meterModel<M extends object>(model: M): M {
  return new Proxy(model, {
    get(target: any, prop, receiver) {
      if (prop === 'doGenerate') {
        return async (opts: any) => {
          const bucket = scope.getStore();
          const res = await target.doGenerate(opts);
          record(bucket, res.usage);
          return res;
        };
      }
      if (prop === 'doStream') {
        return async (opts: any) => {
          const bucket = scope.getStore(); // captured at call time, not when the stream is consumed
          const res = await target.doStream(opts);
          const tap = new TransformStream({
            transform(chunk: any, controller) {
              if (chunk?.type === 'finish') record(bucket, chunk.usage);
              controller.enqueue(chunk);
            },
          });
          return { ...res, stream: res.stream.pipeThrough(tap) };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
