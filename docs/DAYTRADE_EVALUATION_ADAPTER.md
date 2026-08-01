# Disabled Day Trade evaluation adapter (Phase B0.1)

## Execution and response inventory

The trusted VPS runner calls the existing Vercel `GET /api/sector-hot?action=daytrade-screener-run` route with `Authorization: Bearer CRON_SECRET`. Vercel calculates a slice of 50 tickers (75 in fast mode) in `runDayTradeBatch`; it cannot write the VPS evaluation directory. Each successfully calculated candidate exists in `batchResult.results` before the production `score >= 50` persistence filter. Fetch/no-history/analysis failures exist separately in `batchResult.failed` and have no engine status or scored candidate, so the adapter reports their omission provenance rather than inventing records.

A non-final response is a JSON progress object containing run/mode/date, zero-based batch index, batch/universe/scanned/failed/passed counts, next batch, diagnostics, save error and up to ten failed tickers. A final response is the existing publication/Telegram diagnostic object. Normal full batches are approximately 50 candidates and fast batches at most 75; the current response has no calculated candidates.

At calculation time, the engine genuinely has current/so-far OHLCV, raw volume ratio, score components, uncapped pre-cap score, capped/current display score, exact classification and final normalized levels. It does not expose a provider/source timestamp, seasonal RVOL, data lag, or the pre-normalization levels after all refinements. Those fields remain null with explicit provenance; no later daily candle is consulted.

## Disabled transport

Only a CRON-secret-authorized request can reach the run action. An envelope additionally requires both `DAYTRADE_EVALUATION_ADAPTER_ENABLED=true` on Vercel **and** `evaluation_capture=1` on that request. Neither is set or activated by this change. Without both, response construction follows the pre-existing path with no evaluation key. Each envelope carries only the current calculation batch, is capped at 75 records and 512 KiB serialized, and passes the strict sensitive-data/schema validator. Any mapping/count/size error omits records and adds only a bounded evaluation diagnostic; scan behavior remains fail-open.

The inactive VPS one-shot harness validates the entire envelope before creating files, then uses the existing local gzip/manifest logger under a caller-supplied root. It requires `--execute`, existing URL/secret, root and market date; it requests deferred Fast Watcher delivery. It prints record count, compressed bytes, checksum and omitted-field provenance. Do not run it against production without a separately approved operational canary.

Synthetic sizing tests should measure the exact JSON. The hard ceiling is 524,288 serialized envelope bytes (plus a small response wrapper); 75 typical records are expected to be well below it. Compressed size is measured by the VPS manifest rather than estimated from final candles.
