import type { MemoryConfig } from '@mastra/core/memory';

/**
 * Memory configurations under test. Values mirror Mastra's own LongMemEval harness
 * (explorations/longmemeval/src/config.ts): lastMessages 10, semantic recall
 * topK 10 / messageRange 2 / resource scope, resource-scoped working memory.
 *
 * Every question is asked in a fresh thread (as Mastra's harness does), so
 * `lastMessages` alone sees none of the haystack history: config A is the
 * "no cross-conversation memory" floor.
 */
export const CONFIGS = {
  'recent-only': {
    label: 'Recent messages only',
    options: { lastMessages: 10, semanticRecall: false, workingMemory: { enabled: false } },
  },
  'semantic-recall': {
    label: 'Semantic recall',
    options: {
      lastMessages: 10,
      semanticRecall: { topK: 10, messageRange: 2, scope: 'resource' },
      workingMemory: { enabled: false },
    },
  },
  'working-memory': {
    label: 'Working memory',
    options: { lastMessages: 10, semanticRecall: false, workingMemory: { enabled: true, scope: 'resource' } },
  },
  combined: {
    label: 'Semantic recall + working memory',
    options: {
      lastMessages: 10,
      semanticRecall: { topK: 10, messageRange: 2, scope: 'resource' },
      workingMemory: { enabled: true, scope: 'resource' },
    },
  },
} satisfies Record<string, { label: string; options: MemoryConfig }>;

export type ConfigName = keyof typeof CONFIGS;
export const CONFIG_NAMES = Object.keys(CONFIGS) as ConfigName[];

/** Agent instructions copied from Mastra's harness (explorations/longmemeval/src/commands/run.ts). */
export const AGENT_INSTRUCTIONS = `You are a helpful assistant with access to extensive conversation history.
When answering questions, carefully review the conversation history to identify and use any relevant user preferences, interests, or specific details they have mentioned.`;
