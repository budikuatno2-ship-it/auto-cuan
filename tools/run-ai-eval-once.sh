#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${AUTO_CUAN_ROOT:-/home/ubuntu/auto-cuan}"
NODE_BIN="${NODE_BIN:-/home/ubuntu/.local/node-v22/bin/node}"
WORK_DIR="${AI_EVAL_WORK_DIR:-/home/ubuntu/auto-cuan-ai-eval}"
DATASET_GZ="${AI_EVAL_DATASET_GZ:-$WORK_DIR/dataset-1m.jsonl.gz}"
OUTPUT_DIR="${AI_EVAL_OUTPUT_DIR:-$WORK_DIR/output}"
ENV_FILE="${AI_EVAL_ENV_FILE:-/home/ubuntu/auto-cuan/.env.ai-eval-once}"
RUN_ID="${AI_EVAL_RUN_ID:-}"

for arg in "$@"; do
  case "$arg" in
    --run-id=*) RUN_ID="${arg#*=}" ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "AI_EVAL_ENV_NOT_FOUND=$ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${AI_EVAL_API_KEY:?AI_EVAL_API_KEY wajib ada di env VPS}"
: "${SUPABASE_URL:?SUPABASE_URL wajib ada di env VPS}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY wajib ada di env VPS}"
: "${RUN_ID:?AI_EVAL_RUN_ID atau --run-id wajib diisi}"

AI_EVAL_BASE_URL="${AI_EVAL_BASE_URL:-https://openagentic.id/api/v1}"
AI_EVAL_MODEL="${AI_EVAL_MODEL:-claude-sonnet-4.6}"
AI_EVAL_STORAGE_BUCKET="${AI_EVAL_STORAGE_BUCKET:-ai-eval-private}"
RUN_OUTPUT="$OUTPUT_DIR/$RUN_ID"
DONE_FILE="$RUN_OUTPUT/WORKER_DONE"

mkdir -p "$WORK_DIR" "$RUN_OUTPUT"
rm -f "$DONE_FILE"
cd "$ROOT_DIR"

if [ ! -f "$DATASET_GZ" ]; then
  echo "Generating one-time 1,000,000-case compressed dataset..."
  "$NODE_BIN" tools/generate-ai-eval-dataset.js \
    --count=1000000 \
    --stock-ratio=60 \
    --seed=20260803 \
    --output="$DATASET_GZ"
fi

FIFO="$WORK_DIR/dataset-${RUN_ID}.jsonl.pipe"
rm -f "$FIFO"
mkfifo -m 600 "$FIFO"
DECOMPRESS_PID=""
UPLOADER_PID=""
WORKER_PID=""
cleanup() {
  if [ -n "$WORKER_PID" ]; then kill "$WORKER_PID" 2>/dev/null || true; fi
  if [ -n "$DECOMPRESS_PID" ]; then kill "$DECOMPRESS_PID" 2>/dev/null || true; fi
  if [ -n "$UPLOADER_PID" ]; then kill "$UPLOADER_PID" 2>/dev/null || true; fi
  rm -f "$FIFO"
}
trap cleanup EXIT INT TERM

gzip -dc "$DATASET_GZ" > "$FIFO" &
DECOMPRESS_PID=$!

export AI_EVAL_BASE_URL AI_EVAL_MODEL AI_EVAL_RUN_ID="$RUN_ID" AI_EVAL_STORAGE_BUCKET

"$NODE_BIN" tools/upload-ai-eval-shards.js \
  --watch \
  --run-id="$RUN_ID" \
  --output-dir="$RUN_OUTPUT" \
  --done-file="$DONE_FILE" \
  --storage-bucket="$AI_EVAL_STORAGE_BUCKET" \
  --index-sample-every=100 &
UPLOADER_PID=$!

"$NODE_BIN" tools/run-ai-eval-cloud.js \
  --execute \
  --dataset="$FIFO" \
  --output-dir="$RUN_OUTPUT" \
  --state-file="$RUN_OUTPUT/state.json" \
  --stop-file="$RUN_OUTPUT/STOP" \
  --run-id="$RUN_ID" \
  --base-url="$AI_EVAL_BASE_URL" \
  --model="$AI_EVAL_MODEL" \
  --rpm=30 \
  --concurrency=4 \
  --max-total-tokens=50000000 \
  --max-output-tokens=380 \
  --judge-mode=all \
  --judge-max-tokens=220 \
  --min-judge-score=85 \
  --min-style-score=80 \
  --shard-rows=250 \
  --storage-bucket="$AI_EVAL_STORAGE_BUCKET" \
  --index-sample-every=100 &
WORKER_PID=$!

set +e
wait "$WORKER_PID"
WORKER_STATUS=$?
set -e
WORKER_PID=""

touch "$DONE_FILE"
wait "$UPLOADER_PID" || {
  echo "AI_EVAL_UPLOADER_FAILED=1" >&2
  if [ "$WORKER_STATUS" -eq 0 ]; then WORKER_STATUS=3; fi
}
UPLOADER_PID=""
exit "$WORKER_STATUS"
