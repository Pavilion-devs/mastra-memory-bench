#!/usr/bin/env bash
# One command to reproduce the published results:
#
#   ./bench.sh            # or: npm run bench
#
# Plan (fits a ~$15 budget on Bedrock):
#   1. All four memory configs on 12 questions (2 per question type). Working-memory
#      ingestion is the expensive part: Claude Haiku 4.5 re-reads every past session.
#   2. Recent-only and semantic recall on 120 questions (20 per type); the best config
#      (semantic recall) is answered and judged a second time (run2) to measure
#      run-to-run variance. Databases are deleted per question afterwards to save disk.
#   3. Regenerate results/main/summary.md, summary.json and chart.svg.
#
# Needs AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key) in .env and a Hugging Face token
# (HF_TOKEN or ~/.cache/huggingface/token). Resumable: re-running skips finished work.
# The --max-usd guard counts everything already recorded in results/main.
set -euo pipefail
cd "$(dirname "$0")"

MAX_USD="${MAX_USD:-15}"
WM_PER_TYPE="${WM_PER_TYPE:-2}"
CHEAP_PER_TYPE="${CHEAP_PER_TYPE:-20}"

npm ci --silent
npx tsx src/download.ts

npx tsx src/run.ts --per-type "$WM_PER_TYPE" --configs recent-only,semantic-recall,working-memory,combined \
  --runs 1 --concurrency 3 --wm-concurrency 2 --max-usd "$MAX_USD"

npx tsx src/run.ts --per-type "$CHEAP_PER_TYPE" --configs recent-only,semantic-recall \
  --run-id run1 --concurrency 3 --max-usd "$MAX_USD"
# variance: answer + judge the best config (semantic recall) a second time on the same memory
npx tsx src/run.ts --per-type "$CHEAP_PER_TYPE" --configs semantic-recall \
  --run-id run2 --concurrency 3 --cleanup --max-usd "$MAX_USD"

npx tsx src/report.ts results/main
