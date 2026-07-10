#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/auto-cuan}"
BRANCH="${BRANCH:-feat/daytrade-screener-v1}"
LIMIT="${LIMIT:-957}"
SAMPLES="${SAMPLES:-3}"
SLEEP_SECONDS="${SLEEP_SECONDS:-900}"
REPORTS_DIR="${REPORTS_DIR:-data/reports}"
LOG_DIR="${LOG_DIR:-logs/daytrade-full-universe-intraday-validation}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/$RUN_ID.log}"
PID_FILE="${PID_FILE:-$LOG_DIR/latest.pid}"
LOG_PATH_FILE="${LOG_PATH_FILE:-$LOG_DIR/latest.logpath}"
SUMMARY_JSON="$REPORTS_DIR/daytrade-full-universe-intraday-validation-$RUN_ID.json"
SUMMARY_MD="$REPORTS_DIR/daytrade-full-universe-intraday-validation-$RUN_ID.md"

export TELEGRAM_ENABLED=0
export DAYTRADE_INTRADAY_SCORE_ENABLED=false

usage() {
  cat <<USAGE
Usage:
  $0 --start-once       Start detached with nohup and return immediately.
  $0 --run              Run validation in the current shell (used by --start-once).
  $0 --status           Show latest background process and log tail.
  $0 --summary          Print latest final JSON summary with jq.
  $0 --confirm-guard    Confirm DAYTRADE_INTRADAY_SCORE_ENABLED is false in shell/.env/.env.local (if present).
USAGE
}

confirm_guard() {
  local env_value="${DAYTRADE_INTRADAY_SCORE_ENABLED:-false}"
  if [[ "$env_value" != "false" && "$env_value" != "0" ]]; then
    echo "DAYTRADE_INTRADAY_SCORE_ENABLED must remain false/0, got: $env_value" >&2
    return 1
  fi
  local env_file
  for env_file in .env .env.local; do
    if [[ -f "$env_file" ]] && grep -Eq '^DAYTRADE_INTRADAY_SCORE_ENABLED=(true|1)' "$env_file"; then
      echo "$env_file enables DAYTRADE_INTRADAY_SCORE_ENABLED; refusing to run." >&2
      return 1
    fi
  done
  echo "DAYTRADE_INTRADAY_SCORE_ENABLED remains false (process=${env_value})."
}

api_count() {
  find api -maxdepth 1 -type f -name '*.js' | wc -l | tr -d ' '
}

latest_json() {
  local prefix="$1"
  find "$REPORTS_DIR" -maxdepth 1 -type f -name "$prefix*.json" -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR==1{print $2}'
}

run_sample() {
  local n="$1"
  echo "=== sample $n/$SAMPLES $(date -u +%FT%TZ) ==="
  confirm_guard
  node tools/run-daytrade-intraday-validation-bundle.js --limit "$LIMIT" --reports-dir "$REPORTS_DIR" --json --archive-session
  confirm_guard

  local bundle
  bundle="$(latest_json daytrade-intraday-validation-bundle-session-)"
  if [[ -z "$bundle" ]]; then
    echo "No session bundle JSON was generated." >&2
    return 1
  fi

  local needs_retry
  needs_retry="$(node - "$bundle" <<'NODE'
const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const dq=r.data_quality_counts||{}; const missing=Number(r.provider_missing_count||0);
const bad=missing+Number(dq.NO_INTRADAY_DATA||0)+Number(dq.INCOMPLETE_INTRADAY||0);
process.stdout.write(bad>0?'yes':'no');
NODE
)"
  if [[ "$needs_retry" == "yes" ]]; then
    echo "Missing/incomplete intraday data detected; retrying once through existing provider/cache fetch path."
    node tools/run-daytrade-intraday-validation-bundle.js --limit "$LIMIT" --reports-dir "$REPORTS_DIR" --json --archive-session
    confirm_guard
  fi
}

write_final_summary() {
  node - "$REPORTS_DIR" "$RUN_ID" "$SUMMARY_JSON" "$SUMMARY_MD" "$LIMIT" "$SAMPLES" <<'NODE'
const fs=require('fs'); const path=require('path');
const [reportsDir, runId, summaryJson, summaryMd, requestedLimitRaw, samplesRaw]=process.argv.slice(2);
const files=fs.readdirSync(reportsDir).filter(f=>f.endsWith('.json')).map(f=>path.join(reportsDir,f));
function byNewest(prefix){return files.filter(f=>path.basename(f).startsWith(prefix)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)}
function newest(prefix){return byNewest(prefix)[0]||null}
function read(f){return f?JSON.parse(fs.readFileSync(f,'utf8')):null}
function arr(v){return Array.isArray(v)?v:[]}
function tickers(rows,p){return [...new Set(arr(rows).filter(p).map(r=>String(r.ticker||'').toUpperCase()).filter(Boolean))].sort()}
const requestedLimit=Number(requestedLimitRaw||0);
const samples=Number(samplesRaw||0);
const sessionFiles=byNewest('daytrade-intraday-validation-bundle-session-').slice(0, Number.isFinite(samples)&&samples>0?samples:undefined);
const latestBundlePath=sessionFiles[0]||newest('daytrade-intraday-validation-bundle-');
const latestBundle=read(latestBundlePath)||{};
const rows=arr(latestBundle.rows);
const latestBundleRowsCount=rows.length;
const sessionRowsCounts=sessionFiles.map(f=>({ path:f, rows_count:arr((read(f)||{}).rows).length }));
const maxSessionRowsCount=sessionRowsCounts.reduce((max,s)=>Math.max(max,s.rows_count),0);
const sessionCount=sessionRowsCounts.length;
const evidenceScope=(requestedLimit>0 && maxSessionRowsCount>=requestedLimit)?'full_universe':'candidate_level';
const evidenceWarning='Runner requested full limit, but validation bundle emitted candidate rows only; treat this as candidate-level dry-run evidence.';
const q=read(newest('daytrade-intraday-provider-cache-quality-'))||{};
const agg=read(newest('daytrade-intraday-validation-aggregate-'))||{};
const policy=read(newest('daytrade-intraday-policy-'))||{};
const gate=read(newest('daytrade-intraday-dry-run-gate-'))||{};
const byHint=h=>tickers(q.ticker_records,r=>arr(r.remediation_hints).includes(h));
const summary={
  run_id:runId, generated_at:new Date().toISOString(), guard:{TELEGRAM_ENABLED:process.env.TELEGRAM_ENABLED, DAYTRADE_INTRADAY_SCORE_ENABLED:process.env.DAYTRADE_INTRADAY_SCORE_ENABLED},
  requested_limit: requestedLimit, latest_bundle_rows_count: latestBundleRowsCount, max_session_rows_count: maxSessionRowsCount, session_count: sessionCount, evidence_scope: evidenceScope, evidence_warning: evidenceScope==='candidate_level'?evidenceWarning:null, candidate_count: Number(latestBundle.intraday_candidates_count ?? rows.length), ok_count: tickers(rows,r=>r.data_quality==='OK').length,
  quarantined_repeated_blockers: arr(q.intraday_quarantine_tickers).map(r=>r.ticker||r).sort(),
  provider_missing_after_retry: tickers(rows,r=>r.data_quality==='NO_INTRADAY_DATA'),
  incomplete_intraday_after_retry: tickers(rows,r=>r.data_quality==='INCOMPLETE_INTRADAY'),
  intraday_unknown: tickers(rows,r=>r.intraday_priority_label==='INTRADAY_UNKNOWN'||r.intraday_confirmation_label==='INTRADAY_UNKNOWN'),
  daily_only_excluded: arr(q.daily_score_only_tickers).sort(),
  stale_sparse_zero_ohlc_zero_volume: { stale:byHint('stale cache'), sparse:byHint('sparse candles'), zero_ohlc:byHint('zero OHLC'), zero_volume:byHint('zero volume') },
  statuses:{ provider_cache_quality:q.quality_status||null, aggregate:agg.aggregate_status||agg.validation_status||null, policy:policy.policy_status||null, dry_run_gate:gate.gate_status||gate.dry_run_gate_status||null },
  session_rows_counts: sessionRowsCounts,
  report_paths:{ latest_bundle:latestBundlePath, provider_cache_quality:newest('daytrade-intraday-provider-cache-quality-'), aggregate:newest('daytrade-intraday-validation-aggregate-'), policy:newest('daytrade-intraday-policy-'), dry_run_gate:newest('daytrade-intraday-dry-run-gate-'), summary_json:summaryJson, summary_markdown:summaryMd }
};
fs.writeFileSync(summaryJson, JSON.stringify(summary,null,2)+'\n');
const md=['# Auto-Cuan Full-Limit Intraday Dry-Run Validation',`Generated at: ${summary.generated_at}`,'','## Evidence Scope',`- requested_limit: ${summary.requested_limit}`,`- latest_bundle_rows_count: ${summary.latest_bundle_rows_count}`,`- max_session_rows_count: ${summary.max_session_rows_count}`,`- session_count: ${summary.session_count}`,`- evidence_scope: ${summary.evidence_scope}`,...(summary.evidence_warning?[`- warning: ${summary.evidence_warning}`]:[]),'','## Counts',`- candidate count: ${summary.candidate_count}`,`- OK count: ${summary.ok_count}`,'','## Problem Lists',`- quarantined repeated blockers: ${summary.quarantined_repeated_blockers.join(', ')||'none'}`,`- provider missing after retry: ${summary.provider_missing_after_retry.join(', ')||'none'}`,`- incomplete intraday after retry: ${summary.incomplete_intraday_after_retry.join(', ')||'none'}`,`- intraday unknown: ${summary.intraday_unknown.join(', ')||'none'}`,`- daily-only/excluded: ${summary.daily_only_excluded.join(', ')||'none'}`,`- stale: ${summary.stale_sparse_zero_ohlc_zero_volume.stale.join(', ')||'none'}`,`- sparse: ${summary.stale_sparse_zero_ohlc_zero_volume.sparse.join(', ')||'none'}`,`- zero OHLC: ${summary.stale_sparse_zero_ohlc_zero_volume.zero_ohlc.join(', ')||'none'}`,`- zero volume: ${summary.stale_sparse_zero_ohlc_zero_volume.zero_volume.join(', ')||'none'}`,'','## Guard','- DAYTRADE_INTRADAY_SCORE_ENABLED remained false for this one-shot wrapper; do not enable production intraday scoring.','- TELEGRAM_ENABLED=0.'].join('\n')+'\n';
fs.writeFileSync(summaryMd, md);
console.log(summaryJson); console.log(summaryMd);
NODE
}

run_all() {
  cd "$APP_DIR"
  mkdir -p "$LOG_DIR" "$REPORTS_DIR"
  echo "Run ID: $RUN_ID"
  echo "Pulling latest $BRANCH in $APP_DIR"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
  local endpoints
  endpoints="$(api_count)"
  echo "API endpoint count: $endpoints"
  [[ "$endpoints" == "12" ]] || { echo "Expected 12 API endpoints, got $endpoints" >&2; exit 1; }
  confirm_guard
  for i in $(seq 1 "$SAMPLES"); do
    run_sample "$i"
    if [[ "$i" -lt "$SAMPLES" ]]; then
      echo "Sleeping $SLEEP_SECONDS seconds before next sample."
      sleep "$SLEEP_SECONDS"
    fi
  done
  node tools/report-daytrade-intraday-provider-cache-quality.js --reports-dir "$REPORTS_DIR" --samples "$SAMPLES" --json
  node tools/report-daytrade-intraday-validation-aggregate.js --reports-dir "$REPORTS_DIR" --include-session-archives --samples "$SAMPLES" --min-session-gap-minutes 15 --min-session-span-minutes 30 --json
  node tools/report-daytrade-intraday-policy.js --reports-dir "$REPORTS_DIR" --json
  node tools/report-daytrade-intraday-dry-run-gate.js --reports-dir "$REPORTS_DIR" --json
  write_final_summary
  confirm_guard
  echo "Done. Final summary: $SUMMARY_JSON"
}

case "${1:-}" in
  --start-once)
    cd "$APP_DIR"
    mkdir -p "$LOG_DIR"
    echo "$LOG_FILE" > "$LOG_PATH_FILE"
    nohup "$0" --run > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Started PID $(cat "$PID_FILE"). Log: $LOG_FILE"
    ;;
  --run) run_all ;;
  --status)
    cd "$APP_DIR"; log_path="$(cat "$LOG_PATH_FILE" 2>/dev/null || true)"; [[ -f "$PID_FILE" ]] && ps -fp "$(cat "$PID_FILE")" || true; [[ -n "$log_path" ]] && tail -n 80 "$log_path" 2>/dev/null || true ;;
  --summary)
    cd "$APP_DIR"; latest="$(latest_json daytrade-full-universe-intraday-validation-)"; [[ -n "$latest" ]] && jq . "$latest" || { echo "No final summary JSON found." >&2; exit 1; } ;;
  --confirm-guard) cd "$APP_DIR"; confirm_guard ;;
  *) usage; exit 2 ;;
esac
