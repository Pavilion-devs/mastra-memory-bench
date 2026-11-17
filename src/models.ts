import 'dotenv/config';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

/** Bedrock provider authenticated with a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK). */
export const bedrock = createAmazonBedrock({
  region: process.env.AWS_REGION ?? 'us-east-1',
  apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
});

/** Fixed agent model for every config (ingestion + answering). */
export const AGENT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
/** Judge model (official LongMemEval prompts; the paper uses gpt-4o). */
export const JUDGE_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
/** Embedding model for semantic recall (Mastra's harness uses OpenAI text-embedding-3-small). */
export const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';

export const agentModel = bedrock(AGENT_MODEL_ID);
export const judgeModel = bedrock(JUDGE_MODEL_ID);
export const embedder = bedrock.embedding(EMBED_MODEL_ID);

/** USD per 1M tokens (Bedrock on-demand, us cross-region profiles; checked 2026-11-17). */
export const PRICES: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  [AGENT_MODEL_ID]: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  [JUDGE_MODEL_ID]: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  [EMBED_MODEL_ID]: { input: 0.02, output: 0 },
};
