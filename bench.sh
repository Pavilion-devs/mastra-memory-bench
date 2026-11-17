#!/usr/bin/env bash
# One command: download LongMemEval-S, run all four Mastra memory configs on the
# stratified subset, re-run the best config, and regenerate the report.
#
#   PER_TYPE=5 MAX_USD=15 ./bench.sh
#
# Needs AWS_BEARER_TOKEN_BEDROCK (Bedrock API key) in .env and a Hugging Face token.
# Resumable: re-running skips questions and answers that already finished.
set -euo pipefail
cd "$(dirname "$0")"

PER_TYPE="${PER_TYPE:-5}"
MAX_USD="${MAX_USD:-15}"
CONCURRENCY="${CONCURRENCY:-4}"
OUT="results/per-type-${PER_TYPE}"

npm ci --silent
npx tsx src/download.ts
npx tsx src/run.ts --per-type "$PER_TYPE" --run-id run1 --concurrency "$CONCURRENCY" --max-usd "$MAX_USD"

# variance: answer + judge the best run1 config a second time (same ingested memory)
npx tsx src/report.ts "$OUT" >/dev/null
BEST=$(node -e "const s=require('./$OUT/summary.json').summaries.filter(x=>x.runId==='run1').sort((a,b)=>b.pooled-a.pooled)[0];console.log(s.config)")
echo "Best config in run1: $BEST — running it again for variance"
npx tsx src/run.ts --per-type "$PER_TYPE" --run-id run2 --configs "$BEST" --concurrency "$CONCURRENCY" --max-usd "$MAX_USD"

npx tsx src/report.ts "$OUT"
