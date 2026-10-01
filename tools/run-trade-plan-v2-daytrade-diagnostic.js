#!/usr/bin/env node
'use strict';

/**
 * CLI — Trade Plan V2 three-day Day-Trade shadow diagnostic (READ-ONLY)
 * =====================================================================
 *
 * Replays the deduplicated CONFIRMED rank-1 (shadow_score >= min) candidate
 * signals from the already-collected intraday datasets against the Trade Plan V2
 * SL / TP1 / trailing parameter grid, and prints the diagnostic summary as JSON
 * to stdout. It reads ONLY the source roots and writes NOTHING (no Supabase, no
 * Telegram, no cron, no mutation, no public output). Deterministic.
 *
 * Example VPS shadow validation command:
 *
 *   TRADE_PLAN_V2_SHADOW_ENABLED=true TRADE_PLAN_V2_PUBLIC_ENABLED=false \
 *   DAYTRADE_INTRADAY_SCORE_ENABLED=false DAYTRADE_WORKER_ALLOW_MUTATION=false TELEGRAM_ENABLED=0 \
 *   node tools/run-trade-plan-v2-daytrade-diagnostic.js \
 *     --shadow-root /home/ubuntu/auto-cuan/data/intraday-shadow-scoring-live \
 *     --sample-root /home/ubuntu/auto-cuan/data/intraday-samples \
 *     --dates 2026-07-20,2026-07-21,2026-07-22 \
 *     --min-score 16
 */

const diag = require('../lib/trade-plan-v2-daytrade-diagnostic');

function parseArgs(argv) {
  const args = { dates: [], minScore: 16 };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const next = list[i + 1];
    if (a === '--shadow-root') { args.shadowRoot = next; i++; }
    else if (a === '--sample-root') { args.sampleRoot = next; i++; }
    else if (a === '--dates') { args.dates = String(next || '').split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (a === '--min-score') { args.minScore = Number(next); i++; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  // Enforce shadow-safe env for this process (downgrade only).
  process.env.DAYTRADE_INTRADAY_SCORE_ENABLED = 'false';
  process.env.DAYTRADE_WORKER_ALLOW_MUTATION = 'false';
  process.env.TELEGRAM_ENABLED = '0';

  const result = await diag.runDaytradeDiagnostic({
    shadowRoot: args.shadowRoot,
    sampleRoot: args.sampleRoot,
    dates: args.dates,
    minScore: args.minScore,
    env: process.env
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'success') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
}

module.exports = { parseArgs };
