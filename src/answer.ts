import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { Agent } from '@mastra/core/agent';
import { AGENT_INSTRUCTIONS, CONFIGS, type ConfigName } from './configs.js';
import type { LongMemEvalQuestion } from './data.js';
import { openMemory, questionDir } from './ingest.js';
import { agentModel } from './models.js';
import { metered } from './meter.js';
import { withRetry } from './retry.js';
import { type Usage, fromSdkUsage } from './usage.js';

/** Message count and working memory of a question's store, used to prove answering left it untouched. */
async function snapshot(qid: string) {
  const db = createClient({ url: `file:${join(questionDir(qid), 'memory.db')}` });
  try {
    const messages = Number((await db.execute('select count(*) as n from mastra_messages')).rows[0].n);
    const wm = await db.execute({ sql: 'select workingMemory from mastra_resources where id = ?', args: [qid] });
    return { messages, workingMemory: String(wm.rows[0]?.workingMemory ?? '') };
  } finally {
    db.close();
  }
}

/**
 * Ask the question in a fresh thread for the question's resource, using one memory config.
 * Memory is read-only so answering never changes what the next config sees.
 * The date line follows the official LongMemEval format ("Current Date: …\nQuestion: …").
 */
export async function answerQuestion(
  q: LongMemEvalQuestion,
  config: ConfigName,
  runId: string,
): Promise<{ hypothesis: string; usage: Usage; mastraReportedUsage: Usage; latencyMs: number }> {
  const memory = openMemory(q.question_id, { ...CONFIGS[config].options, readOnly: true });
  const agent = new Agent({ id: `answer-${config}`, name: `answer-${config}`, instructions: AGENT_INSTRUCTIONS, model: agentModel, memory });
  const prompt = `Current Date: ${q.question_date}\nQuestion: ${q.question}`;
  const threadId = `${q.question_id}:eval:${config}:${runId}`;
  const before = await snapshot(q.question_id);
  let latencyMs = 0;
  const { result: r, usage } = await withRetry(async () => {
    const t0 = Date.now(); // timed per attempt: throttling back-off is not counted as latency
    const out = await metered(() =>
      agent.generate(prompt, {
        // readOnly is also passed per call: set only on the Memory constructor it did not stop
        // answers being saved into the store (found and fixed during this benchmark)
        memory: { thread: threadId, resource: q.question_id, options: { ...CONFIGS[config].options, readOnly: true } as any },
        modelSettings: { temperature: 0, maxRetries: 0 },
      }),
    );
    latencyMs = Date.now() - t0;
    return out;
  });
  if (!usage.inputTokens) throw new Error('No token usage metered for the answer call');
  const after = await snapshot(q.question_id);
  if (after.messages !== before.messages || after.workingMemory !== before.workingMemory) {
    throw new Error(
      `Isolation violated: answering changed memory (messages ${before.messages} -> ${after.messages}, working memory changed: ${after.workingMemory !== before.workingMemory})`,
    );
  }
  const anyR = r as any;
  return { hypothesis: String(anyR.text ?? ''), usage, mastraReportedUsage: fromSdkUsage(anyR.totalUsage ?? anyR.usage), latencyMs };
}
