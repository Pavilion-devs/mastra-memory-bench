import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIGS, type ConfigName } from './configs.js';
import type { IngestStats } from './ingest.js';
import { AGENT_MODEL_ID, EMBED_MODEL_ID, JUDGE_MODEL_ID } from './models.js';
import { costUsd, emptyUsage } from './usage.js';

const dir = process.argv[2] ?? 'results/main';
const readJsonl = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

// keep the latest record per (question, config, run): retried errors are superseded by successes
const latest = new Map<string, any>();
for (const r of readJsonl(join(dir, 'answers.jsonl'))) latest.set(`${r.questionId}|${r.config}|${r.runId}`, r);
const rows = [...latest.values()];
// latest stats per (question, kind)
const ingestMap = new Map<string, IngestStats>();
for (const s of readJsonl(join(dir, 'ingest.jsonl')) as IngestStats[]) ingestMap.set(`${s.questionId}|${s.kind}`, s);
const embedStats = [...ingestMap.values()].filter((s): s is Extract<IngestStats, { kind: 'embed' }> => s.kind === 'embed');
const wmStats = [...ingestMap.values()].filter((s): s is Extract<IngestStats, { kind: 'wm' }> => s.kind === 'wm');
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));

const TYPES = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'multi-session', 'temporal-reasoning', 'knowledge-update'];
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
/** 95% Wilson score interval */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96, p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

const embedCost = (s: (typeof embedStats)[number]) => costUsd(s.model, { ...emptyUsage(), inputTokens: s.tokens });
const wmCost = (s: (typeof wmStats)[number]) => costUsd(s.model, s.usage);
const embedCostPerQ = mean(embedStats.map(embedCost));
const wmCostPerQ = mean(wmStats.map(wmCost));
const wmMinutesPerQ = mean(wmStats.map(s => s.ms / 60000));
const embedMinutesPerQ = mean(embedStats.map(s => s.ms / 60000));
const usesSR = (c: ConfigName) => (CONFIGS[c].options as any).semanticRecall !== false;
const usesWM = (c: ConfigName) => (CONFIGS[c].options as any).workingMemory?.enabled === true;

interface Summary {
  config: ConfigName;
  runId: string;
  n: number;
  errors: number;
  pooled: number;
  pooledCI: [number, number];
  taskAveraged: number;
  byType: Record<string, { correct: number; total: number; acc: number }>;
  abstention: { correct: number; total: number };
  answerInputTokensMean: number;
  answerOutputTokensMean: number;
  answerCostPerQ: number;
  memoryBuildCostPerQ: number;
  judgeCostPerQ: number;
  latencyP50: number;
  latencyP95: number;
}

function summarize(subset: any[]): Summary[] {
  const groups = new Map<string, any[]>();
  for (const r of subset) {
    const k = `${r.config}|${r.runId}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Summary[] = [];
  for (const [k, rs] of groups) {
    const [config, runId] = k.split('|') as [ConfigName, string];
    const ok = rs.filter(r => !r.error);
    const byType: Summary['byType'] = {};
    for (const t of TYPES) {
      const tr = ok.filter(r => r.type === t);
      const c = tr.filter(r => r.correct).length;
      if (tr.length) byType[t] = { correct: c, total: tr.length, acc: c / tr.length };
    }
    const correct = ok.filter(r => r.correct).length;
    const abs = ok.filter(r => r.abstention);
    out.push({
      config,
      runId,
      n: ok.length,
      errors: rs.length - ok.length,
      pooled: correct / ok.length,
      pooledCI: wilson(correct, ok.length),
      taskAveraged: mean(Object.values(byType).map(t => t.acc)),
      byType,
      abstention: { correct: abs.filter(r => r.correct).length, total: abs.length },
      answerInputTokensMean: mean(ok.map(r => r.answerUsage.inputTokens)),
      answerOutputTokensMean: mean(ok.map(r => r.answerUsage.outputTokens)),
      answerCostPerQ: mean(ok.map(r => costUsd(AGENT_MODEL_ID, r.answerUsage))),
      memoryBuildCostPerQ: (usesSR(config) ? embedCostPerQ : 0) + (usesWM(config) ? wmCostPerQ : 0),
      judgeCostPerQ: mean(ok.map(r => costUsd(JUDGE_MODEL_ID, r.judgeUsage))),
      latencyP50: quantile(ok.map(r => r.latencyMs), 0.5),
      latencyP95: quantile(ok.map(r => r.latencyMs), 0.95),
    });
  }
  const order = Object.keys(CONFIGS);
  return out.sort((a, b) => order.indexOf(a.config) - order.indexOf(b.config) || a.runId.localeCompare(b.runId));
}

const short: Record<string, string> = {
  'single-session-user': 'SS-user',
  'single-session-assistant': 'SS-asst',
  'single-session-preference': 'SS-pref',
  'multi-session': 'Multi',
  'temporal-reasoning': 'Temporal',
  'knowledge-update': 'KU',
};
function table(summaries: Summary[]): string {
  const lines = [
    `| Config | Run | n | Accuracy (pooled, 95% CI) | Task-avg* | ${TYPES.map(t => short[t]).join(' | ')} | Abstention | Answer input tokens | Memory build $/q | Answer $/q | p50 / p95 latency |`,
    `|---|---|---|---|---|${TYPES.map(() => '---').join('|')}|---|---|---|---|---|`,
  ];
  for (const s of summaries) {
    lines.push(
      `| ${CONFIGS[s.config].label} | ${s.runId} | ${s.n}${s.errors ? ` (+${s.errors} err)` : ''} | **${pct(s.pooled)}** (${pct(s.pooledCI[0])}–${pct(s.pooledCI[1])}) | ${pct(s.taskAveraged)} | ${TYPES.map(t => (s.byType[t] ? `${s.byType[t].correct}/${s.byType[t].total}` : '–')).join(' | ')} | ${s.abstention.correct}/${s.abstention.total} | ${Math.round(s.answerInputTokensMean).toLocaleString()} | $${s.memoryBuildCostPerQ.toFixed(3)} | $${s.answerCostPerQ.toFixed(4)} | ${(s.latencyP50 / 1000).toFixed(1)}s / ${(s.latencyP95 / 1000).toFixed(1)}s |`,
    );
  }
  return lines.join('\n');
}

const all = summarize(rows);
// matched subset: questions answered (run1, no error) by every config present in run1
const run1Configs = [...new Set(rows.filter(r => r.runId === 'run1').map(r => r.config))];
const qids = [...new Set(rows.map(r => r.questionId))].filter(qid =>
  run1Configs.every(c => rows.some(r => r.questionId === qid && r.config === c && r.runId === 'run1' && !r.error)),
);
const matched = summarize(rows.filter(r => qids.includes(r.questionId) && r.runId === 'run1'));

// money actually spent: every ingestion record (including superseded rebuilds), every answer line
// (including retried ones) and the discarded attempts, not just the rows used in the tables
const answerSpend = (r: any) => (r.error ? 0 : costUsd(AGENT_MODEL_ID, r.answerUsage) + costUsd(JUDGE_MODEL_ID, r.judgeUsage ?? emptyUsage()));
const totalSpend =
  (readJsonl(join(dir, 'ingest.jsonl')) as IngestStats[]).reduce(
    (s, x) => s + (x.kind === 'embed' ? costUsd(x.model, { ...emptyUsage(), inputTokens: x.tokens }) : costUsd(x.model, x.usage)),
    0,
  ) +
  readJsonl(join(dir, 'answers.jsonl')).reduce((s, r) => s + answerSpend(r), 0) +
  readJsonl(join(dir, 'discarded-attempts.answers.jsonl')).reduce((s, r) => s + answerSpend(r), 0);

const md = `<!-- generated by src/report.ts from ${dir} -->
### All answered questions

${table(all)}

### Matched subset: the ${qids.length} questions every config answered (run1)

${table(matched)}

\\* Task-avg = unweighted mean of the per-type accuracies, the way Mastra reports its LongMemEval "overall" score. Pooled = correct / n.

- Sampling: ${meta.sampling}. Agent ${meta.agentModel}, judge ${meta.judgeModel}, embeddings ${meta.embedModel}, temperature 0.
- Memory build per question (paid once, shared by every config that uses it): embeddings $${embedCostPerQ.toFixed(4)} (${embedMinutesPerQ.toFixed(1)} min, n=${embedStats.length}); working-memory ingestion $${wmCostPerQ.toFixed(3)} (${wmMinutesPerQ.toFixed(1)} min, ${Math.round(mean(wmStats.map(s => s.usage.inputTokens))).toLocaleString()} input / ${Math.round(mean(wmStats.map(s => s.usage.outputTokens))).toLocaleString()} output tokens, n=${wmStats.length}).
- Working-memory ingestion sessions that failed: ${wmStats.reduce((s, x) => s + x.failedSessions, 0)} of ${wmStats.reduce((s, x) => s + x.sessions, 0)}. Answer errors (after retries): ${rows.filter(r => r.error).length}.
- Judge cost: $${mean(all.map(s => s.judgeCostPerQ)).toFixed(4)} per answer. Estimated total spend recorded in this directory: **$${totalSpend.toFixed(2)}**.
`;
writeFileSync(join(dir, 'summary.md'), md);
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ meta, embedCostPerQ, wmCostPerQ, totalSpend, matchedQuestionIds: qids, summaries: all, matched }, null, 2));

// ---- chart (dependency-free SVG): pooled accuracy with 95% CI per config/run; n and $/question as labels ----
const W = 820, rowH = 46, top = 64, left = 270, plotW = 400;
const H = top + all.length * rowH + 50;
const x = (v: number) => left + v * plotW;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="20" y="28" font-size="17" font-weight="600" fill="#111">Mastra Memory on LongMemEval-S (stratified subset)</text>
<text x="20" y="48" font-size="12" fill="#555">Accuracy with 95% Wilson CI · agent Claude Haiku 4.5 · judge Claude Sonnet 4.6 (official prompts) · label: n, cost per question</text>`;
for (let t = 0; t <= 10; t += 2) {
  svg += `<line x1="${x(t / 10)}" y1="${top}" x2="${x(t / 10)}" y2="${H - 40}" stroke="#e5e5e5"/><text x="${x(t / 10)}" y="${H - 24}" font-size="11" text-anchor="middle" fill="#666">${t * 10}%</text>`;
}
all.forEach((s, i) => {
  const y = top + i * rowH + 10;
  const label = `${CONFIGS[s.config].label}${all.filter(o => o.config === s.config).length > 1 ? ` (${s.runId})` : ''}`;
  svg += `<text x="${left - 10}" y="${y + 15}" font-size="12.5" text-anchor="end" fill="#111">${label}</text>`;
  svg += `<rect x="${left}" y="${y}" width="${Math.max(1, s.pooled * plotW)}" height="22" rx="3" fill="${usesWM(s.config) ? '#d9822b' : '#2f6fde'}"/>`;
  svg += `<line x1="${x(s.pooledCI[0])}" y1="${y + 11}" x2="${x(s.pooledCI[1])}" y2="${y + 11}" stroke="#111" stroke-width="1.5"/>`;
  svg += `<line x1="${x(s.pooledCI[0])}" y1="${y + 5}" x2="${x(s.pooledCI[0])}" y2="${y + 17}" stroke="#111" stroke-width="1.5"/><line x1="${x(s.pooledCI[1])}" y1="${y + 5}" x2="${x(s.pooledCI[1])}" y2="${y + 17}" stroke="#111" stroke-width="1.5"/>`;
  svg += `<text x="${Math.max(x(s.pooledCI[1]), x(s.pooled)) + 8}" y="${y + 15}" font-size="12" fill="#111">${pct(s.pooled)} · n=${s.n} · $${(s.memoryBuildCostPerQ + s.answerCostPerQ).toFixed(3)}/q</text>`;
});
svg += `</svg>\n`;
writeFileSync(join(dir, 'chart.svg'), svg);
console.log(md);
