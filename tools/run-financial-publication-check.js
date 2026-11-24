#!/usr/bin/env node
'use strict';

/**
 * tools/run-financial-publication-check.js
 * ============================================================================
 * V6 W3 — SCHEDULER ENTRY POINT for the financial publication monitor.
 * ============================================================================
 * This is a FUNCTION the existing cron wrapper can call. It does NOT modify
 * crontab. It reads the local state, computes which issuer-periods are due,
 * and reports what it WOULD do.
 *
 * SAFETY: DRY MODE IS THE DEFAULT. In this task the tool NEVER calls a
 * provider. Even with a provider key present, `--dry-run` (the default) makes
 * zero network requests. A future live mode must be explicitly enabled and is
 * out of scope here.
 *
 * Usage:
 *   node tools/run-financial-publication-check.js            # dry-run (default)
 *   node tools/run-financial-publication-check.js --dry-run  # explicit
 *   node tools/run-financial-publication-check.js --json     # machine output
 * ============================================================================
 */

const monitor = require('../lib/financial-publication-monitor');

function flattenRecords(state) {
  const out = [];
  const issuers = (state && state.issuers) || {};
  for (const ticker of Object.keys(issuers)) {
    const byYear = issuers[ticker] || {};
    for (const year of Object.keys(byYear)) {
      const recs = byYear[year];
      if (Array.isArray(recs)) out.push.apply(out, recs);
    }
  }
  return out;
}

/**
 * Run one publication check pass.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true]
 * @param {string}  [options.now]
 * @param {string}  [options.statePath]
 * @param {boolean} [options.providerKeyPresent]
 * @returns {object} report
 */
function runPublicationCheck(options = {}) {
  const dryRun = options.dryRun !== false; // default true
  const now = options.now || new Date().toISOString().slice(0, 10);
  const loaded = monitor.loadState(options.statePath);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, dryRun, providerCalls: 0 };
  }
  const state = loaded.state;
  const records = flattenRecords(state);
  const due = monitor.computeDueItems(records, {
    now,
    retryIntervalDays: state.retryIntervalDays
  });

  const planned = due.map(function (item) {
    return {
      ticker: item.record.ticker,
      fiscal_year: item.record.fiscal_year,
      period: item.record.period,
      status: item.verdict.status,
      reason: item.verdict.reason,
      would_fetch: !dryRun,
      provider_call: false // never in this task
    };
  });

  return {
    ok: true,
    dryRun,
    now,
    providerKeyPresent: options.providerKeyPresent === true,
    totalRecords: records.length,
    dueCount: due.length,
    providerCalls: 0,
    planned
  };
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const dryRun = args.indexOf('--live') === -1; // live is not implemented; default dry
  const asJson = args.indexOf('--json') !== -1;
  const report = runPublicationCheck({ dryRun });
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write('[financial-publication] mode=' + (report.dryRun ? 'DRY-RUN' : 'LIVE') + '\n');
    process.stdout.write('  total records : ' + report.totalRecords + '\n');
    process.stdout.write('  due now       : ' + report.dueCount + '\n');
    process.stdout.write('  provider calls: ' + report.providerCalls + ' (this task never calls a provider)\n');
    for (const p of report.planned) {
      process.stdout.write('  - ' + p.ticker + ' ' + p.fiscal_year + ' ' + p.period +
        ' [' + p.status + '] reason=' + p.reason + ' would_fetch=' + p.would_fetch + '\n');
    }
  }
  return report;
}

if (require.main === module) {
  main();
}

module.exports = { runPublicationCheck, main, flattenRecords };
