/**
 * Build (or rebuild) the per-question memory stores without answering anything:
 *   npx tsx src/prepare.ts --per-type 20 [--wm-per-type 2]
 * Embeddings are local (fastembed), so this step has no API cost. Working memory is only
 * (re)inserted for questions whose build is already cached; it never calls the LLM here.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadDataset, stratifiedSample } from './data.js';
import { ensureMessages, ensureWorkingMemory } from './ingest.js';

const { values: args } = parseArgs({
  options: {
    'per-type': { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '3' },
    out: { type: 'string', default: 'results/main' },
  },
});
const questions = stratifiedSample(loadDataset(), Number(args['per-type']));
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
const ingestPath = join(args.out!, 'ingest.jsonl');

const queue = [...questions];
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    while (queue.length) {
      const q = queue.shift()!;
      const stats = await ensureMessages(q, log);
      if (stats) appendFileSync(ingestPath, JSON.stringify(stats) + '\n');
      if (existsSync(join('.cache', 'stats', `${q.question_id}.wm.json`))) await ensureWorkingMemory(q, log);
    }
  }),
);
log(`prepared ${questions.length} questions`);
