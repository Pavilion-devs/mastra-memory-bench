import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATASET_PATH } from './data.js';

/** SHA-256 of the longmemeval_s file this benchmark was run on (HF dataset xiaowu0162/longmemeval). */
const EXPECTED_SHA256 = '08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894';
const URL = 'https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s?download=true';

function hfToken(): string | undefined {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
  const p = join(homedir(), '.cache', 'huggingface', 'token');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined;
}

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

if (existsSync(DATASET_PATH) && sha(readFileSync(DATASET_PATH)) === EXPECTED_SHA256) {
  console.log(`${DATASET_PATH} already present (checksum OK)`);
  process.exit(0);
}
const token = hfToken();
if (!token) throw new Error('Set HF_TOKEN (or run `huggingface-cli login`) to download LongMemEval from Hugging Face.');
console.log('Downloading longmemeval_s (~278 MB)…');
const res = await fetch(URL, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = sha(buf);
if (got !== EXPECTED_SHA256) console.warn(`Warning: checksum ${got} differs from the one used for the published results.`);
mkdirSync('data', { recursive: true });
writeFileSync(DATASET_PATH, buf);
console.log(`Saved ${DATASET_PATH}`);
