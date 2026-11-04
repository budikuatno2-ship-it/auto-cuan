#!/usr/bin/env node
'use strict';

/**
 * FASE 10B helper — verify every path referenced by the new cron schedule
 * actually exists on the VPS, so the installed crontab cannot silently fail.
 */

const fs = require('fs');
const path = require('path');
const { ssh } = require('../tools/fase7-ssh');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'fase10');

const PATHS = [
  '/home/ubuntu/auto-cuan/scripts/idx-sync/sync_stock_summary_dates.ts',
  '/home/ubuntu/auto-cuan/deploy/vps/run-idx-suspension-guard.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-fastwatcher.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-daytrade-producer.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-sector-hot.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-daily-candles.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-lifecycle-evaluator.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-ihsg-candle.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-daily-market-context-collector.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-broker-accumulation.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-broker-hunter-indexer.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-screeners-preflight.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-screeners.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-daily-afternoon-recap.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-catchup-missing-dates.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-fundamental-refresh.sh',
  '/home/ubuntu/auto-cuan/deploy/vps/run-insider-tiered.sh',
  '/home/ubuntu/auto-cuan/tools/build-domestic-broksum-and-accum.js',
  '/home/ubuntu/auto-cuan/tools/refresh-broker-hunter-indexes.js',
  '/home/ubuntu/auto-cuan/tools/build-bandarmologi-intel.js',
  '/home/ubuntu/auto-cuan/tools/direct-refresh-landing.js',
  '/home/ubuntu/auto-cuan/tools/catchup-missing-dates.js',
  '/home/ubuntu/auto-cuan/tools/run-fundamental-refresh.js',
  '/home/ubuntu/auto-cuan/tools/run-daytrade-intraday-producer.js',
  '/home/ubuntu/auto-cuan/tools/refresh-idx-suspensions.js',
  '/home/ubuntu/auto-cuan/lib/insider-tiered-scheduler.js',
  '/home/ubuntu/auto-cuan/scripts/refresh-sector-hot.js',
  '/home/ubuntu/auto-cuan/scripts/collect-daily-market-context.js'
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const probe = PATHS.map((p) => `[ -e ${p} ] && echo "OK   ${p}" || echo "MISS ${p}"`).join('; ');
  const out = ssh(probe);
  console.log(out);

  const lines = out.trimEnd().split(/\r?\n/);
  const missing = lines.filter((l) => l.startsWith('MISS')).map((l) => l.replace(/^MISS\s+/, ''));
  const ok = lines.filter((l) => l.startsWith('OK')).map((l) => l.replace(/^OK\s+/, ''));

  const summary = [
    '=== FASE 10B — INVENTARIS PATH CRON BARU DI VPS ===',
    'Dibuat: ' + new Date().toISOString(),
    'Total path diperiksa: ' + PATHS.length,
    'ADA   : ' + ok.length,
    'HILANG: ' + missing.length,
    ''
  ];
  if (missing.length) {
    summary.push('PATH HILANG (harus dibikin/di-deploy sebelum crontab dipasang):');
    missing.forEach((m) => summary.push('  - ' + m));
  } else {
    summary.push('SEMUA PATH ADA — crontab aman dipasang.');
  }
  summary.push('');

  fs.writeFileSync(path.join(OUT_DIR, 'inventaris-path-cron.txt'), summary.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'inventaris-path-cron.json'), JSON.stringify({ checked: PATHS.length, ok, missing }, null, 2));

  console.log(summary.join('\n'));
}

main();
