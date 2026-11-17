import { PRICES } from './models.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 });

/** Normalise an AI SDK / Mastra usage object (totalUsage across all steps of a generate call). */
export function fromSdkUsage(u: any): Usage {
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cachedInputTokens ?? 0,
    cacheWriteTokens: u?.cacheCreationInputTokens ?? 0,
    calls: 1,
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    calls: a.calls + b.calls,
  };
}

/** USD cost. AI SDK reports inputTokens inclusive of cache reads/writes; price those separately. */
export function costUsd(modelId: string, u: Usage): number {
  const p = PRICES[modelId];
  if (!p) throw new Error(`No price for ${modelId}`);
  const plainInput = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens);
  return (
    (plainInput * p.input +
      u.cacheReadTokens * (p.cacheRead ?? p.input) +
      u.cacheWriteTokens * (p.cacheWrite ?? p.input) +
      u.outputTokens * p.output) /
    1e6
  );
}
