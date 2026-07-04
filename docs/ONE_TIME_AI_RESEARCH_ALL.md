# One-Time AI Research Runner for All IDX Tickers

Manual VPS runner that analyzes IDX tickers using multiple Shiteru AI chat models with detailed technical explanation per ticker/model, then saves all results locally as research files.

## Purpose

- **Research only** — NOT a production signal sender.
- Generates detailed AI-powered technical analysis for every IDX ticker.
- Uses multiple AI models for cross-comparison and disagreement detection.
- Saves structured results (JSONL, CSV, Markdown, run report) locally.
- Supports resume/checkpoint for long-running research sessions.

## Safety Constraints

- No Telegram notifications.
- No Supabase writes.
- No SQL / database migrations.
- No API endpoints created.
- No Dashboard changes.
- No Top 5 changes.
- No public signal routing.
- No paid service changes.
- No cron scheduling.
- API keys read from env only, never committed.


## Environment Setup

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHITERU_BASE_URL` | *(required)* | Base URL for AI API (OpenAI-compatible) |
| `SHITERU_API_KEY` | *(required)* | API key for AI service |
| `AI_RESEARCH_MODELS` | `qwen-3.7-max,gpt-5.5,glm-5.2,kimi-k2.7,deepseek-v4-pro,deepseek-v4-flash` | Comma-separated model list |
| `AI_RESEARCH_OUTPUT_DIR` | `./data/ai-research` | Output directory for results |
| `DAYTRADE_CACHE_DIR` | `./data/daytrade-ohlcv-cache` | Local OHLCV cache directory |
| `AI_RESEARCH_TIMEOUT_MS` | `60000` | Per-request timeout in ms |
| `AI_RESEARCH_MAX_OUTPUT_TOKENS` | `2200` | Max tokens for AI response |
| `AI_RESEARCH_TEMPERATURE` | `0.2` | AI temperature |
| `AI_RESEARCH_CONCURRENCY` | `1` | Concurrent API calls |

## Example .env (documentation only, never use real keys)

```env
SHITERU_BASE_URL=https://your-shiteru-base-url/v1
SHITERU_API_KEY=sk_live_xxx
AI_RESEARCH_MODELS=qwen-3.7-max,gpt-5.5,glm-5.2,kimi-k2.7,deepseek-v4-pro,deepseek-v4-flash
AI_RESEARCH_OUTPUT_DIR=./data/ai-research
DAYTRADE_CACHE_DIR=./data/daytrade-ohlcv-cache
AI_RESEARCH_TIMEOUT_MS=60000
AI_RESEARCH_MAX_OUTPUT_TOKENS=2200
AI_RESEARCH_TEMPERATURE=0.2
AI_RESEARCH_CONCURRENCY=1
```


## CLI Usage

```
node tools/one-time-ai-research-all.js [options]
```

### Options

| Flag | Description |
| --- | --- |
| `--mode observe` | Run mode (required, always `observe`) |
| `--tickers-file <path>` | Path to ticker list file |
| `--tickers <list>` | Comma-separated ticker list (inline) |
| `--models <list>` | Comma-separated model list (overrides env) |
| `--limit <n>` | Limit number of tickers to process |
| `--all` | Process all tickers (no limit) |
| `--concurrency <n>` | Number of concurrent API calls |
| `--force` | Ignore checkpoint, rerun all |
| `--dry-run` | Build payloads but skip API calls |
| `--include-raw-candles` | Include full 90D raw candles in AI payload (default: last 30 + notable events only) |
| `--max-output-tokens <n>` | Max AI output tokens |
| `--temperature <n>` | AI temperature |

### Ticker File Format

One ticker per line or comma-separated. Supports:
- Blank lines (ignored)
- Lines starting with `#` (comments, ignored)
- `.JK` suffix (stripped automatically)
- Mixed case (normalized to uppercase)
- Duplicates (removed, order preserved)

Example `data/daytrade-observe-tickers.txt`:
```
# IDX Blue Chips
BBCA
BBRI
BMRI, TLKM, ASII
GOTO.JK
# Skip below
# BUMI
```


## Command Examples

### Small test (20 tickers, 1 model)

```bash
node tools/one-time-ai-research-all.js \
  --mode observe \
  --tickers-file data/daytrade-observe-tickers.txt \
  --limit 20 \
  --models qwen-3.7-max \
  --concurrency 1
```

### 100 tickers, 1 model

```bash
node tools/one-time-ai-research-all.js \
  --mode observe \
  --tickers-file data/daytrade-observe-tickers.txt \
  --limit 100 \
  --models deepseek-v4-flash \
  --concurrency 1
```

### All tickers, all models (full research run)

```bash
node tools/one-time-ai-research-all.js \
  --mode observe \
  --tickers-file data/daytrade-observe-tickers.txt \
  --all \
  --models qwen-3.7-max,gpt-5.5,glm-5.2,kimi-k2.7,deepseek-v4-pro,deepseek-v4-flash \
  --concurrency 1 \
  --max-output-tokens 2200
```

### Resume after interruption

```bash
# Same command — checkpoint auto-skips completed ticker/model pairs
node tools/one-time-ai-research-all.js \
  --mode observe \
  --tickers-file data/daytrade-observe-tickers.txt \
  --all \
  --models qwen-3.7-max,gpt-5.5,glm-5.2,kimi-k2.7,deepseek-v4-pro,deepseek-v4-flash \
  --concurrency 1
```

### Force rerun (ignore checkpoint)

```bash
node tools/one-time-ai-research-all.js \
  --mode observe \
  --tickers-file data/daytrade-observe-tickers.txt \
  --all \
  --force \
  --models qwen-3.7-max
```

### Dry run (test payload without API calls)

```bash
node tools/one-time-ai-research-all.js \
  --mode observe \
  --tickers-file data/daytrade-observe-tickers.txt \
  --limit 5 \
  --dry-run
```

### Include full raw candle data

```bash
node tools/one-time-ai-research-all.js \
  --mode observe \
  --tickers-file data/daytrade-observe-tickers.txt \
  --limit 10 \
  --models deepseek-v4-pro \
  --include-raw-candles
```


## Output Structure

All output is saved under `data/ai-research/YYYY-MM-DD/`:

```
data/ai-research/2026-07-04/
  results.jsonl          # One JSON row per ticker/model job
  summary.csv            # Flat CSV of key fields
  summary.md             # Human-readable grouped summary
  run-report.json        # Run metadata and stats
  checkpoint.json        # Resume state for long runs
```

### JSONL Row Format

Each line in `results.jsonl`:
```json
{
  "ticker": "BBCA",
  "model": "qwen-3.7-max",
  "deterministic_summary": { ... },
  "ai_result": { ... },
  "raw_response_preview": "...",
  "usage": { "prompt_tokens": 1200, "completion_tokens": 800, "total_tokens": 2000 },
  "error": null,
  "started_at": "2026-07-04T10:00:00.000Z",
  "ended_at": "2026-07-04T10:00:05.000Z"
}
```

### Summary CSV Columns

ticker, model, bias, setup_type, quality_score, risk_level, final_verdict, entry1, entry2, stop_loss, tp1, tp2, major_demand, major_supply, poc, data_quality_status, error

### Summary MD Sections

1. Top quality scores (best AI quality_score overall)
2. Bullish / watchlist candidates
3. High-risk / avoid candidates
4. Per-model disagreement notes
5. Failed jobs / errors

### Run Report

```json
{
  "version": "one-time-ai-research-v1",
  "started_at": "...",
  "ended_at": "...",
  "duration_ms": 12345,
  "total_tickers": 200,
  "total_models": 6,
  "total_jobs": 1200,
  "completed_jobs": 1180,
  "failed_jobs": 20,
  "skipped_jobs": 0,
  "output_dir": "...",
  "models_used": ["qwen-3.7-max", "..."],
  "estimated_token_usage": 2400000,
  "per_model_stats": { "qwen-3.7-max": { "success": 200, "fail": 0 } }
}
```


## Data Flow

1. Load tickers from `--tickers-file` or `--tickers`
2. For each ticker:
   a. Read OHLCV from local cache (or fetch from Yahoo Finance if missing/stale)
   b. Build deterministic technical payload (price levels, indicators, patterns, zones)
   c. For each AI model:
      - Check checkpoint; skip if already done
      - Send structured payload to Shiteru AI API
      - Parse JSON response
      - Save to JSONL
      - Update checkpoint
3. Write summary CSV, MD, and run report

## Deterministic Payload Contents

Before calling AI, the runner builds a comprehensive technical payload per ticker:
- Ticker, board, candle count
- Last close, previous close
- Multi-window high/low (90D, 60D, 20D, 10D, 5D)
- Volume: latest, avg 5D/20D/60D, volume ratio
- Price changes: 1D, 5D, 20D
- MA20, MA50
- RSI14, ATR14
- Major demand/supply context (from detectMajorRespectZoneContext)
- Volume profile PoC (from detectVolumeProfilePoc)
- Fibonacci confluence
- Day Trade score, entry1, entry2, stop loss, tp1, tp2, risk/reward
- Signal action / verdict
- Candle notes (lower wick recovery, upper wick rejection, breakout, failed breakout, gap risk, consolidation, pullback, volume confirmation)
- Stale data warning
- Last 30 candles (compact) — recent price action context
- 90D Notable Events — key structure-defining candles extracted from full history:
  - 90D high/low candle
  - 60D high/low candle (if different from 90D)
  - Highest volume candle
  - Top 3 volume spike candles (>2x avg volume)
  - Major demand/supply touch candles (if zones detected)
  - Breakout candles (strong green + high volume + close near high)
  - Fakeout candles (new high but close below prev close)
  - Rejection candles (long upper wick + close in lower third)
- Full 90D candles (only if `--include-raw-candles`)

## Payload Design: Token Efficiency

By default the AI receives a **structured deterministic summary + last 30 candles + notable events** instead of all 90 raw candles. This gives the AI full 90D context while saving significant tokens:

- **Last 30 candles (compact)** — recent price action for trend/pattern reading.
- **Notable events** — key structure-defining candles extracted from the full 90D history (high/low, volume spikes, breakouts, fakeouts, rejections, demand/supply touches).
- **Deterministic indicators** — pre-computed MA, RSI, ATR, support/resistance, scoring, levels.

If you need the AI to see raw candle-by-candle data for all 90 days, pass `--include-raw-candles`. This is useful for deep research but significantly increases token usage per request.

## Resume / Checkpoint

- Each completed ticker+model pair is recorded in `checkpoint.json`
- On re-run, completed pairs are skipped automatically
- Use `--force` to ignore checkpoint and rerun everything
- Checkpoint is critical for long runs (200+ tickers x 6 models = 1200+ API calls)

## Error Handling

- If a model fails for a ticker, the error is saved in JSONL and the run continues
- Retry with exponential backoff (3 attempts per call)
- Circuit does NOT break the whole run — each ticker/model is independent
- Insufficient candle data logs error and moves to next ticker

## Warning

**This is a research-only tool. It does NOT:**
- Send Telegram signals
- Write to any database
- Create public API endpoints
- Affect the production dashboard or Top 5
- Run on a schedule (no cron)

Results are local research files only. Manual review is required before any action.
