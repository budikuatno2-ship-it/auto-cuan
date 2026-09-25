#!/usr/bin/env node
'use strict';

/**
 * Screener channel runner + diagnostic CLI.
 *
 * Purpose (Bagian 6 audit + repair):
 *  - Diagnose WHY the Daytrade / FastWatcher / Swing screener produced no
 *    signal in the Telegram channel.
 *  - Dry-run by default: read the latest local screener snapshot, apply the
 *    market/calendar gate, and report what WOULD be sent — without sending.
 *  - `--send` actually broadcasts the card via the canonical notifier.
 *
 * Root causes this tool is designed to surface:
 *  1. NO SCHEDULED PRODUCER — the VPS crontab has no entry that generates
 *     screener candidates. Only Top 5 is scheduled (Vercel cron). Without a
 *     producer the channel is silent no matter how healthy the sender is.
 *  2. MARKET GUARD — sendTelegramMessage() skips with `market_closed` outside
 *     IDX trading hours unless skip_market_guard is set. A producer that runs
 *     after 15:45 WIB without that flag is silently dropped.
 *
 * Exit codes: 0 ok, 2 no candidates / gate blocked, 1 configuration error.
 *
 * Usage:
 *   node tools/run-screener.js --mode=daytrade --dry-run
 *   node tools/run-screener.js --mode=daytrade --send
 *   node tools/run-screener.js --mode=swing --dry-run
 *   node tools/run-screener.js --mode=fastwatcher --dry-run
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const MODES = {
  daytrade: { key: 'daytrade', label: 'Day Trade', snapshotKeys: ['daytrade', 'dayTrade'] },
  swing: { key: 'swing', label: 'Swing', snapshotKeys: ['swing'] },
  fastwatcher: { key: 'fastwatcher', label: 'Fast Watcher', snapshotKeys: ['fastwatcher', 'fastWatcher', 'intraday'] },
  top5: { key: 'top5', label: 'Top 5', snapshotKeys: ['top5', 'fusion'] }
};

function loadEnvFiles(env, cwd) {
  const files = ['.env', '.env.intraday-runtime', '.env.local'];
  for (const file of files) {
    const filePath = path.join(cwd || ROOT, file);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (env[key] == null || env[key] === '') env[key] = value;
    }
  }
  return env;
}

function parseArgs(argv) {
  const opts = { mode: 'daytrade', dryRun: true, send: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--send') { opts.send = true; opts.dryRun = false; }
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--mode=')) opts.mode = String(a.slice(7)).toLowerCase();
  }
  return opts;
}

function screenerSnapshotPath(rootDir) {
  return path.join(rootDir || ROOT, 'data', 'screener-latest.json');
}

function loadSnapshot(rootDir) {
  const filePath = screenerSnapshotPath(rootDir);
  if (!fs.existsSync(filePath)) return { missing: true, updatedAt: null, data: null };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { missing: false, updatedAt: data.updated_at || data.updatedAt || null, data };
  } catch (_) {
    return { missing: false, updatedAt: null, data: null, corrupt: true };
  }
}

function candidatesFor(snapshot, mode) {
  if (!snapshot || !snapshot.data) return [];
  const def = MODES[mode] || MODES.daytrade;
  for (const key of def.snapshotKeys) {
    if (Array.isArray(snapshot.data[key]) && snapshot.data[key].length) return snapshot.data[key];
  }
  return [];
}

function formatCard(mode, candidates, updatedAt) {
  const def = MODES[mode] || MODES.daytrade;
  const lines = [
    '📊 Screener ' + def.label + ' (snapshot ' + (updatedAt || 'tidak diketahui') + ')',
    ''
  ];
  candidates.slice(0, 10).forEach((row, index) => {
    const ticker = row.ticker || row.symbol || '—';
    const score = row.score != null ? row.score : row.fusion_score;
    lines.push((index + 1) + '. ' + ticker + (score != null ? ' (score ' + score + ')' : ''));
  });
  return lines.join('\n');
}

/**
 * Market/calendar gate. Mirrors lib/market-hours-guard but only as a REPORT —
 * the runner never changes the guard, it surfaces its verdict.
 */
function marketStatus(now, holidaySet) {
  let guard;
  try { guard = require(path.join(ROOT, 'lib', 'market-hours-guard')); } catch (_) { guard = null; }
  try {
    const calendar = require(path.join(ROOT, 'lib', 'idx-trading-calendar'));
    if (!holidaySet && calendar) {
      try { holidaySet = calendar.getSeedHolidaySet(); } catch (_) {}
    }
  } catch (_) {}
  if (!guard) return { isOpen: null, status: 'UNKNOWN', reason: 'guard_unavailable' };
  const st = guard.getMarketSessionStatus(now, holidaySet);
  return {
    isOpen: st.isOpen,
    session: st.session,
    status: st.status,
    reason: st.reason,
    wib_date: st.wib_date,
    wib_time: st.wib_time,
    broadcast_allowed: st.broadcast_allowed
  };
}

function analyze(opts, deps) {
  const rootDir = (deps && deps.rootDir) || ROOT;
  const now = (deps && deps.now) || new Date();
  const mode = MODES[opts.mode] ? opts.mode : 'daytrade';
  const snapshot = loadSnapshot(rootDir);
  const candidates = candidatesFor(snapshot, mode);
  const market = marketStatus(now, deps && deps.holidaySet);
  const reasons = [];

  if (snapshot.missing) reasons.push('snapshot_missing: data/screener-latest.json belum ada (tidak ada producer yang jalan)');
  if (snapshot.corrupt) reasons.push('snapshot_corrupt: JSON screener tidak dapat dibaca');
  if (!snapshot.missing && !candidates.length) reasons.push('no_candidates: mode ' + mode + ' kosong di snapshot terakhir');
  if (market.isOpen === false && opts.send) reasons.push('market_closed: broadcast akan di-skip kecuali skip_market_guard');

  const hasTelegramToken = Boolean((((deps && deps.env) || process.env).TELEGRAM_BOT_TOKEN) || '');
  const hasChatId = Boolean((((deps && deps.env) || process.env).TELEGRAM_CHAT_ID) || '');
  if (opts.send && !hasTelegramToken) reasons.push('missing_token: TELEGRAM_BOT_TOKEN kosong');
  if (opts.send && !hasChatId) reasons.push('missing_chat_id: TELEGRAM_CHAT_ID kosong');

  return {
    mode,
    dry_run: opts.dryRun,
    updated_at: snapshot.updatedAt,
    snapshot_missing: snapshot.missing,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, 10),
    market,
    has_telegram_token: hasTelegramToken,
    has_chat_id: hasChatId,
    reasons,
    healthy: reasons.length === 0 && candidates.length > 0,
    message: formatCard(mode, candidates, snapshot.updatedAt)
  };
}

async function main(argv, deps) {
  const opts = parseArgs(argv || process.argv);
  const env = (deps && deps.env) || loadEnvFiles(process.env, ROOT);
  const report = analyze(opts, Object.assign({ env, rootDir: ROOT }, deps || {}));

  const log = (deps && deps.log) || console.log;
  if (opts.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    log('Mode: ' + report.mode + ' | ' + (opts.send ? 'SEND' : 'DRY-RUN'));
    log('Snapshot: ' + (report.snapshot_missing ? 'MISSING' : (report.updated_at || 'tanpa timestamp')));
    log('Kandidat: ' + report.candidate_count);
    log('Market: ' + report.market.status + ' (' + (report.market.reason || '-') + ') ' +
      (report.market.wib_date || '') + ' ' + (report.market.wib_time || ''));
    if (report.reasons.length) {
      log('Diagnosa:');
      for (const reason of report.reasons) log('  - ' + reason);
    } else {
      log('Diagnosa: sehat');
    }
    if (report.candidate_count) log('\n' + report.message);
  }

  if (!opts.send) return { exitCode: report.candidate_count ? 0 : 2, report };

  if (!report.candidate_count) return { exitCode: 2, report };
  const notifier = (deps && deps.notifier) || require(path.join(ROOT, 'lib', 'telegram-notifier'));
  const result = await notifier.sendTelegramMessage(report.message, {
    // A screener card is an after-session recap; skip the intraday-only guard.
    skip_market_guard: true,
    ticker: report.mode
  });
  const delivered = result && result.sent === true;
  log('Kirim: ' + (delivered ? 'terkirim' : ('gagal/' + (result && result.reason ? result.reason : 'unknown'))));
  return { exitCode: delivered ? 0 : 1, report, result };
}

if (require.main === module) {
  main().then((out) => { process.exitCode = out.exitCode; }).catch((err) => {
    console.error('screener runner error: ' + (err && err.message ? err.message : 'unknown'));
    process.exitCode = 1;
  });
}

module.exports = {
  MODES,
  parseArgs,
  loadEnvFiles,
  screenerSnapshotPath,
  loadSnapshot,
  candidatesFor,
  formatCard,
  marketStatus,
  analyze,
  main
};
