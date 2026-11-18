import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { Agent } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { Memory } from '@mastra/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { AGENT_INSTRUCTIONS, CONFIGS } from './configs.js';
import { type LongMemEvalQuestion, sessionsChronological } from './data.js';
import { AGENT_MODEL_ID, EMBED_MODEL_ID, agentModel, embedder } from './models.js';
import { type Usage, addUsage, emptyUsage, fromSdkUsage } from './usage.js';
import { Semaphore, withRetry } from './retry.js';
import { metered } from './meter.js';

export const questionDir = (qid: string) => join('.cache', 'q', qid);

/** Memory over the question's main store: raw haystack messages + embeddings + working memory. */
export function openMemory(qid: string, options: any) {
  const url = `file:${join(questionDir(qid), 'memory.db')}`;
  return new Memory({
    storage: new LibSQLStore({ id: `store-${qid}`, url }),
    vector: new LibSQLVector({ id: `vector-${qid}`, url }),
    embedder,
    options,
  });
}

export interface EmbedStats {
  kind: 'embed';
  questionId: string;
  sessions: number;
  messages: number;
  model: string;
  tokens: number;
  ms: number;
}
export interface WorkingMemoryStats {
  kind: 'wm';
  questionId: string;
  sessions: number;
  model: string;
  usage: Usage;
  /** what Mastra's generate() result reported, kept to compare with the provider-level meter */
  mastraReportedUsage?: Usage;
  ms: number;
  failedSessions: number;
  chars: number;
}
export type IngestStats = EmbedStats | WorkingMemoryStats;

/** Stats and the final working memory live outside the per-question DB folder, so they survive cleanup. */
const statsDir = join('.cache', 'stats');
const statsPath = (qid: string, kind: string) => join(statsDir, `${qid}.${kind}.json`);
const wmTextPath = (qid: string) => join(statsDir, `${qid}.working-memory.md`);
const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

function threadIdFor(qid: string, sessionId: string, i: number) {
  return `${qid}:${i}:${sessionId}`;
}

function toDbMessages(qid: string, threadId: string, date: Date, turns: { role: string; content: string }[]): MastraDBMessage[] {
  return turns
    .filter(t => t.content)
    .map((t, j) => ({
      id: `${threadId}:${j}`,
      role: t.role === 'assistant' ? 'assistant' : 'user',
      // keep turn order inside a session: 5 seconds apart, as in Mastra's harness
      createdAt: new Date(date.getTime() + j * 5000),
      threadId,
      resourceId: qid,
      content: { format: 2, parts: [{ type: 'text', text: t.content }], content: t.content },
    }));
}

async function checkpoint(qid: string) {
  // fold the write-ahead log back into the database file to save disk (libSQL's vector index is large)
  const client = createClient({ url: `file:${join(questionDir(qid), 'memory.db')}` });
  await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  client.close();
}

/**
 * Step 1 (no LLM): save every haystack message with its original timestamp into the question's
 * main store and embed it for semantic recall. Returns stats only when work was done.
 */
export async function ensureMessages(q: LongMemEvalQuestion, log: (s: string) => void): Promise<EmbedStats | null> {
  const qid = q.question_id;
  const dir = questionDir(qid);
  if (existsSync(join(dir, 'messages.done'))) return null;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(statsDir, { recursive: true });
  const sessions = sessionsChronological(q);
  const memory = openMemory(qid, CONFIGS['semantic-recall'].options);
  let tokens = 0;
  let messages = 0;
  const t0 = Date.now();
  for (const [i, s] of sessions.entries()) {
    const threadId = threadIdFor(qid, s.id, i);
    await memory.createThread({ threadId, resourceId: qid, title: `session ${i}` });
    const msgs = toDbMessages(qid, threadId, s.date, s.turns);
    if (!msgs.length) continue;
    const res = await withRetry(() => memory.saveMessages({ messages: msgs, memoryConfig: CONFIGS['semantic-recall'].options }));
    tokens += res.usage?.tokens ?? 0;
    messages += msgs.length;
  }
  await checkpoint(qid);
  const stats: EmbedStats = { kind: 'embed', questionId: qid, sessions: sessions.length, messages, model: EMBED_MODEL_ID, tokens, ms: Date.now() - t0 };
  writeFileSync(statsPath(qid, 'embed'), JSON.stringify(stats, null, 2));
  writeFileSync(join(dir, 'messages.done'), '');
  log(`${qid}: saved ${messages} messages, ${tokens} embedding tokens (${(stats.ms / 60000).toFixed(1)} min)`);
  return stats;
}

/**
 * Step 2 (LLM): replay each session, oldest first, through an agent with working memory enabled, so
 * the agent model reads the conversation and updates its scratchpad as in Mastra's harness. The final
 * working memory is then written into the question's main store. Expensive, so it runs only for
 * configs that use working memory, and its result is cached.
 */
export async function ensureWorkingMemory(q: LongMemEvalQuestion, log: (s: string) => void): Promise<WorkingMemoryStats | null> {
  const qid = q.question_id;
  const dir = questionDir(qid);
  const sessions = sessionsChronological(q);
  const anyThread = threadIdFor(qid, sessions[0].id, 0);
  const memory = openMemory(qid, CONFIGS['working-memory'].options);
  if (existsSync(join(dir, 'wm.done'))) return null;

  let stats: WorkingMemoryStats | null = null;
  if (!readJson(statsPath(qid, 'wm'))) stats = await wmSemaphore.run(() => buildWorkingMemory(q, log));
  await memory.updateWorkingMemory({
    threadId: anyThread,
    resourceId: qid,
    workingMemory: readFileSync(wmTextPath(qid), 'utf8'),
    memoryConfig: CONFIGS['working-memory'].options,
  });
  await checkpoint(qid);
  writeFileSync(join(dir, 'wm.done'), '');
  return stats;
}

/** Working-memory ingestion is the throttling-sensitive step, so it has its own concurrency limit. */
let wmSemaphore = new Semaphore(2);
export const setWorkingMemoryConcurrency = (n: number) => (wmSemaphore = new Semaphore(n));

async function buildWorkingMemory(q: LongMemEvalQuestion, log: (s: string) => void): Promise<WorkingMemoryStats> {
  const qid = q.question_id;
  const dir = questionDir(qid);
  const sessions = sessionsChronological(q);
  const anyThread = threadIdFor(qid, sessions[0].id, 0);
  {
    // start from an empty scratchpad: never resume a half-built working memory from an interrupted run
    for (const f of ['wm-ingest.db', 'wm-ingest.db-wal', 'wm-ingest.db-shm']) rmSync(join(dir, f), { force: true });
    const wmUrl = `file:${join(dir, 'wm-ingest.db')}`;
    const wmMemory = new Memory({ storage: new LibSQLStore({ id: `wm-${qid}`, url: wmUrl }), options: CONFIGS['working-memory'].options });
    const wmAgent = new Agent({ id: 'wm-ingest', name: 'wm-ingest', instructions: AGENT_INSTRUCTIONS, model: agentModel, memory: wmMemory });
    let usage = emptyUsage();
    let mastraReported = emptyUsage();
    const failed = 0; // a session that still fails after all retries aborts the question (no partial working memory)
    const t0 = Date.now();
    log(`${qid}: building working memory over ${sessions.length} sessions`);
    for (const [i, s] of sessions.entries()) {
      const msgs = s.turns
        .filter(t => t.content)
        .map((t, j) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.content, createdAt: new Date(s.date.getTime() + j * 5000) }));
      if (!msgs.length) continue;
      try {
        const { result: r, usage: u } = await withRetry(() =>
          metered(() =>
            wmAgent.generate(msgs as any, {
              memory: { thread: threadIdFor(qid, s.id, i), resource: qid },
              modelSettings: { temperature: 0, maxRetries: 0 },
            }),
          ),
        );
        usage = addUsage(usage, u);
        mastraReported = addUsage(mastraReported, fromSdkUsage((r as any).totalUsage ?? (r as any).usage));
      } catch (e: any) {
        log(`${qid}: working-memory ingestion aborted on session ${i} after retries (${usage.inputTokens} in / ${usage.outputTokens} out tokens spent): ${String(e?.message ?? e).slice(0, 200)}`);
        throw e;
      }
    }
    const wm = (await wmMemory.getWorkingMemory({ threadId: anyThread, resourceId: qid })) ?? '';
    for (const f of ['wm-ingest.db', 'wm-ingest.db-wal', 'wm-ingest.db-shm']) rmSync(join(dir, f), { force: true });
    writeFileSync(wmTextPath(qid), wm);
    const stats: WorkingMemoryStats = { kind: 'wm', questionId: qid, sessions: sessions.length, model: AGENT_MODEL_ID, usage, mastraReportedUsage: mastraReported, ms: Date.now() - t0, failedSessions: failed, chars: wm.length };
    writeFileSync(statsPath(qid, 'wm'), JSON.stringify(stats, null, 2));
    log(`${qid}: working memory ${wm.length} chars, ${usage.inputTokens} in / ${usage.outputTokens} out tokens (${(stats.ms / 60000).toFixed(1)} min)`);
    return stats;
  }
}

/** Delete a question's databases (stats and working-memory text are kept). */
export function cleanupQuestion(qid: string) {
  rmSync(questionDir(qid), { recursive: true, force: true });
}
