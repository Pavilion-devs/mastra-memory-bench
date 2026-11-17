import { Agent } from '@mastra/core/agent';
import { AGENT_INSTRUCTIONS, CONFIGS, type ConfigName } from './configs.js';
import type { LongMemEvalQuestion } from './data.js';
import { openMemory } from './ingest.js';
import { agentModel } from './models.js';
import { withRetry } from './retry.js';
import { type Usage, fromSdkUsage } from './usage.js';

/**
 * Ask the question in a fresh thread for the question's resource, using one memory config.
 * Memory is read-only so answering never changes what the next config sees.
 * The date line follows the official LongMemEval format ("Current Date: …\nQuestion: …").
 */
export async function answerQuestion(
  q: LongMemEvalQuestion,
  config: ConfigName,
  runId: string,
): Promise<{ hypothesis: string; usage: Usage; latencyMs: number }> {
  const memory = openMemory(q.question_id, { ...CONFIGS[config].options, readOnly: true });
  const agent = new Agent({ id: `answer-${config}`, name: `answer-${config}`, instructions: AGENT_INSTRUCTIONS, model: agentModel, memory });
  const prompt = `Current Date: ${q.question_date}\nQuestion: ${q.question}`;
  const threadId = `${q.question_id}:eval:${config}:${runId}`;
  const t0 = Date.now();
  const r: any = await withRetry(() =>
    agent.generate(prompt, { memory: { thread: threadId, resource: q.question_id }, modelSettings: { temperature: 0 } }),
  );
  return { hypothesis: String(r.text ?? ''), usage: fromSdkUsage(r.totalUsage ?? r.usage), latencyMs: Date.now() - t0 };
}
