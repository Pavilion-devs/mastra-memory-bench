import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { answerQuestion } from './answer.js';
import { CONFIGS, CONFIG_NAMES, type ConfigName } from './configs.js';
import { isAbstention, loadDataset, stratifiedSample } from './data.js';
import { type IngestStats, cleanupQuestion, ensureMessages, ensureWorkingMemory } from './ingest.js';
import { judge } from './judge.js';
import { AGENT_MODEL_ID, EMBED_MODEL_ID, JUDGE_MODEL_ID } from './models.js';
import { costUsd, emptyUsage } from './usage.js';

const { values: args } = parseArgs({
  options: {
    'per-type': { type: 'string', default: '5' },
    configs: { type: 'string', default: CONFIG_NAMES.join(',') },
    runs: { type: 'string', default: '1' },
    'run-id': { type: 'string' },
    out: { type: 'string', default: 'results/main' },
    cleanup: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    'max-usd': { type: 'string', default: '15' },
    limit: { type: 'string' },
  },
});

const perType = Number(args['per-type']);
const configs = args.configs!.split(',') as ConfigName[];
for (const c of configs) if (!CONFIG_NAMES.includes(c)) throw new Error(`Unknown config ${c}`);
const runIds = args['run-id'] ? [args['run-id']] : Array.from({ length: Number(args.runs) }, (_, i) => `run${i + 1}`);
const needWm = configs.some(c => (CONFIGS[c].options as any).workingMemory?.enabled);
const maxUsd = Number(args['max-usd']);

let questions = stratifiedSample(loadDataset(), perType);
if (args.limit) questions = questions.slice(0, Number(args.limit));

const outDir = args.out!;
mkdirSync(outDir, { recursive: true });
const answersPath = join(outDir, 'answers.jsonl');
const ingestPath = join(outDir, 'ingest.jsonl');
const logPath = join(outDir, 'run.log');
const log = (s: string) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  appendFileSync(logPath, line + '\n');
};

const readJsonl = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const done = new Set(readJsonl(answersPath).filter(r => !r.error).map(r => `${r.questionId}|${r.config}|${r.runId}`));

// running spend estimate (includes earlier, resumed work) for the budget guard
let spent = 0;
for (const r of readJsonl(ingestPath) as IngestStats[]) spent += ingestCost(r);
for (const r of readJsonl(answersPath)) spent += costUsd(AGENT_MODEL_ID, r.answerUsage ?? emptyUsage()) + costUsd(JUDGE_MODEL_ID, r.judgeUsage ?? emptyUsage());

function ingestCost(s: IngestStats) {
  return s.kind === 'embed' ? costUsd(EMBED_MODEL_ID, { ...emptyUsage(), inputTokens: s.tokens }) : costUsd(AGENT_MODEL_ID, s.usage);
}
function checkBudget() {
  if (spent > maxUsd) {
    log(`Budget guard: estimated spend $${spent.toFixed(2)} exceeds --max-usd ${maxUsd}. Stopping.`);
    process.exit(2);
  }
}

const metaPath = join(outDir, 'meta.json');
const prevMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : { invocations: [] };
writeFileSync(
  metaPath,
  JSON.stringify(
    {
      dataset: 'longmemeval_s',
      sampling: "first N per question_type after sorting by question_id (Mastra harness 'sample' method)",
      invocations: [...prevMeta.invocations, { at: new Date().toISOString(), perType, questions: questions.length, configs, runIds }],
      agentModel: AGENT_MODEL_ID,
      judgeModel: JUDGE_MODEL_ID,
      embedModel: EMBED_MODEL_ID,
      temperature: 0,
      packages: JSON.parse(readFileSync('package.json', 'utf8')).dependencies,
      node: process.version,
    },
    null,
    2,
  ),
);

log(`${questions.length} questions (${perType}/type) x ${configs.join(', ')} x ${runIds.join(', ')}; spend so far ~$${spent.toFixed(2)} (cap $${maxUsd})`);

async function processQuestion(q: (typeof questions)[number]) {
  checkBudget();
  const record = (stats: IngestStats | null) => {
    if (!stats) return;
    appendFileSync(ingestPath, JSON.stringify(stats) + '\n');
    spent += ingestCost(stats);
  };
  const pending = runIds
    .flatMap(runId => configs.map(config => ({ runId, config })))
    .filter(({ runId, config }) => !done.has(`${q.question_id}|${config}|${runId}`));
  if (!pending.length) return;
  record(await ensureMessages(q, log));
  if (needWm) {
    checkBudget();
    record(await ensureWorkingMemory(q, log));
  }
  for (const { runId, config } of pending) {
    checkBudget();
    const base = { questionId: q.question_id, type: q.question_type, abstention: isAbstention(q), config, runId };
    try {
      const a = await answerQuestion(q, config, runId);
      const j = await judge(q.question_type, q.question, String(q.answer), a.hypothesis, isAbstention(q));
      spent += costUsd(AGENT_MODEL_ID, a.usage) + costUsd(JUDGE_MODEL_ID, j.usage);
      appendFileSync(answersPath, JSON.stringify({ ...base, question: q.question, answer: q.answer, hypothesis: a.hypothesis, correct: j.correct, judgeRaw: j.raw, latencyMs: a.latencyMs, answerUsage: a.usage, judgeUsage: j.usage }) + '\n');
      log(`${q.question_id} [${q.question_type}] ${config}/${runId}: ${j.correct ? 'CORRECT' : 'wrong'} (${a.latencyMs} ms, ${a.usage.inputTokens} in) ~$${spent.toFixed(2)}`);
    } catch (e: any) {
      appendFileSync(answersPath, JSON.stringify({ ...base, error: String(e?.message ?? e).slice(0, 500) }) + '\n');
      log(`${q.question_id} ${config}/${runId}: ERROR ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  if (args.cleanup) cleanupQuestion(q.question_id);
}

// simple worker pool
const queue = [...questions];
const workers = Array.from({ length: Number(args.concurrency) }, async () => {
  while (queue.length) {
    const q = queue.shift()!;
    try {
      await processQuestion(q);
    } catch (e: any) {
      log(`${q.question_id}: FAILED ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
});
await Promise.all(workers);
log(`Done. Estimated total spend for ${outDir}: $${spent.toFixed(2)}`);
