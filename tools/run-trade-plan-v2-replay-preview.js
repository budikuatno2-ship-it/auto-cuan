#!/usr/bin/env node
'use strict';

/**
 * CLI — Trade Plan V2 legacy-vs-V2 replay / preview (READ-ONLY)
 * ============================================================
 *
 * Compares the LEGACY trade plan against the canonical Trade Plan V2 for stored
 * screener candidate rows, and prints the comparison report as JSON to stdout.
 * It reads ONLY the provided input file and writes NOTHING (no Supabase, no
 * Telegram, no cron, no mutation, no public-output change). Deterministic.
 *
 * The public flag is FORCED off for this process so a preview can never leak the
 * V2 plan into public output.
 *
 * Input formats accepted (already-stored data exported to a file):
 *   - a JSON array of candidate rows:            [ {ticker,...}, ... ]
 *   - a JSON object with a `results` array:       { "results": [ ... ] }
 *   - JSONL (one candidate row object per line).
 *
 * Example:
 *
 *   TRADE_PLAN_V2_PUBLIC_ENABLED=false TELEGRAM_ENABLED=0 \
 *   node tools/run-trade-plan-v2-replay-preview.js \
 *     --input ./data/stored-daytrade-candidates.json \
 *     --screener-type DAY_TRADE
 */

const fs = require('node:fs');
const replay = require('../lib/trade-plan-v2-replay-preview');

function parseArgs(argv) {
  const args = {};
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const next = list[i + 1];
    if (a === '--input') { args.input = next; i++; }
    else if (a === '--screener-type') { args.screenerType = next; i++; }
    else if (a === '--mode') { args.mode = next; i++; }
  }
  return args;
}

/** Parse a stored-data file into an array of candidate rows (read-only). */
function loadCandidates(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Try whole-file JSON first (array or {results:[...]}).
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.results)) return parsed.results;
    if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch (e) { /* fall through to JSONL */ }
  // JSONL fallback.
  const rows = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e) { /* skip malformed line */ }
  }
  return rows;
}

function main() {
  const args = parseArgs(process.argv);
  // Force preview-safe env (downgrade only): never enable public output / Telegram.
  process.env.TRADE_PLAN_V2_PUBLIC_ENABLED = 'false';
  process.env.TELEGRAM_ENABLED = '0';

  if (!args.input) {
    process.stdout.write(JSON.stringify({ status: 'error', errors: ['missing required --input <file>'] }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }

  let candidates;
  try {
    candidates = loadCandidates(args.input);
  } catch (e) {
    process.stdout.write(JSON.stringify({ status: 'error', errors: ['failed to read input: ' + (e.message || String(e))] }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }

  const report = replay.replayCandidates({
    candidates,
    screener_type: args.screenerType,
    mode: args.mode
  });

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'success') process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, loadCandidates };
