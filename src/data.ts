import { readFileSync } from 'node:fs';

export type QuestionType =
  | 'single-session-user'
  | 'single-session-assistant'
  | 'single-session-preference'
  | 'multi-session'
  | 'temporal-reasoning'
  | 'knowledge-update';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question_type: QuestionType;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

export const DATASET_PATH = 'data/longmemeval_s.json';

export function loadDataset(path = DATASET_PATH): LongMemEvalQuestion[] {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const isAbstention = (q: { question_id: string }) => q.question_id.endsWith('_abs');

/**
 * Stratified sample identical to Mastra's harness (`applyStratifiedSampling` in
 * explorations/longmemeval/src/config.ts): sort by question_id, group by
 * question_type, take the first N of each type. Deterministic, no seed needed.
 */
export function stratifiedSample(questions: LongMemEvalQuestion[], perType: number): LongMemEvalQuestion[] {
  const sorted = [...questions].sort((a, b) => a.question_id.localeCompare(b.question_id));
  const byType = new Map<string, LongMemEvalQuestion[]>();
  for (const q of sorted) {
    const list = byType.get(q.question_type) ?? [];
    list.push(q);
    byType.set(q.question_type, list);
  }
  return [...byType.values()].flatMap(list => list.slice(0, perType));
}

/** Parse LongMemEval dates like "2023/05/20 (Sat) 02:21" as UTC. */
export function parseLmeDate(s: string): Date {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})(?:\s*\([A-Za-z]+\))?\s*(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Unparseable LongMemEval date: ${s}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

export interface Session {
  id: string;
  date: Date;
  turns: Turn[];
}

/** Haystack sessions in chronological order (oldest first), as Mastra's harness ingests them. */
export function sessionsChronological(q: LongMemEvalQuestion): Session[] {
  return q.haystack_sessions
    .map((turns, i) => ({ id: q.haystack_session_ids[i], date: parseLmeDate(q.haystack_dates[i]), turns }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
