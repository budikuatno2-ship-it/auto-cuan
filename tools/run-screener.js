#!/usr/bin/env node
'use strict';

/**
 * Screener channel runner + diagnostic CLI — 4 Pilar (Daytrade, FastWatcher, Swing Konglo, Swing Non-Konglo).
 *
 * Purpose (Bagian 6 audit + repair + Bagian 2 restorasi 4 pilar):
 *  - Diagnose WHY the Daytrade / FastWatcher / Swing Konglo / Swing Non-Konglo screener produced no
 *    signal in the Telegram channel.
 *  - Dry-run by default: read the latest local screener snapshot, apply the
 *    market/calendar gate, and report what WOULD be sent — without sending.
 *  - `--send` actually broadcasts the card via the canonical notifier (skip_market_guard=true).
 *  - Supports 4 canonical modes required by master task:
 *      --mode=daytrade
 *      --mode=fastwatcher
 *      --mode=swing-konglo
 *      --mode=swing-non-konglo
 *    Aliases are normalized (swing_konglo, konglo, swing, nk, non-konglo, etc.) for backward compat.
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
 *   node tools/run-screener.js --mode=fastwatcher --dry-run
 *   node tools/run-screener.js --mode=fastwatcher --send
 *   node tools/run-screener.js --mode=swing-konglo --dry-run
 *   node tools/run-screener.js --mode=swing-konglo --send
 *   node tools/run-screener.js --mode=swing-non-konglo --dry-run
 *   node tools/run-screener.js --mode=swing-non-konglo --send
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Canonical 4-pilar modes + aliases. All aliases resolve to canonical key via normalizeMode().
const MODES = {
  daytrade: { key: 'daytrade', label: 'Day Trade', snapshotKeys: ['daytrade', 'dayTrade', 'day_trade'] },
  fastwatcher: { key: 'fastwatcher', label: 'Fast Watcher', snapshotKeys: ['fastwatcher', 'fastWatcher', 'fast_watcher', 'intraday', 'intraday_fast_watcher'] },
  'swing-konglo': { key: 'swing-konglo', label: 'Swing Konglo', snapshotKeys: ['swing_konglo', 'swingKonglo', 'swing-konglo', 'konglo', 'swing', 'swingKongloLatest'] },
  'swing-non-konglo': { key: 'swing-non-konglo', label: 'Swing Non-Konglo', snapshotKeys: ['swing_non_konglo', 'swingNonKonglo', 'swing-non-konglo', 'swing_nk', 'swingNk', 'nonKonglo', 'non_konglo', 'nk', 'non-konglo'] },
  // Backward compat aliases (not canonical but kept for existing tests/crons)
  swing: { key: 'swing-konglo', label: 'Swing Konglo', snapshotKeys: ['swing_konglo', 'swingKonglo', 'swing-konglo', 'konglo', 'swing', 'swingKongloLatest'] },
  top5: { key: 'top5', label: 'Top 5', snapshotKeys: ['top5', 'fusion'] }
};

// Alias map: normalized input -> canonical key
const MODE_ALIASES = {
  daytrade: 'daytrade',
  'day-trade': 'daytrade',
  day_trade: 'daytrade',
  fastwatcher: 'fastwatcher',
  'fast-watcher': 'fastwatcher',
  fast_watcher: 'fastwatcher',
  intraday: 'fastwatcher',
  'swing-konglo': 'swing-konglo',
  swing_konglo: 'swing-konglo',
  konglo: 'swing-konglo',
  swing: 'swing-konglo',
  'swing-non-konglo': 'swing-non-konglo',
  swing_non_konglo: 'swing-non-konglo',
  'non-konglo': 'swing-non-konglo',
  non_konglo: 'swing-non-konglo',
  nk: 'swing-non-konglo',
  swing_nk: 'swing-non-konglo',
  'swing-nk': 'swing-non-konglo',
  top5: 'top5',
  fusion: 'top5'
};

function normalizeMode(raw) {
  if (!raw) return 'daytrade';
  const lower = String(raw).trim().toLowerCase().replace(/_/g, '-');
  if (MODE_ALIASES[lower]) return MODE_ALIASES[lower];
  const alt = String(raw).trim().toLowerCase();
  if (MODE_ALIASES[alt]) return MODE_ALIASES[alt];
  if (lower.includes('non') && lower.includes('konglo')) return 'swing-non-konglo';
  if (lower.includes('konglo')) return 'swing-konglo';
  if (lower.includes('fast')) return 'fastwatcher';
  if (lower.includes('daytrade') || lower.includes('day-trade')) return 'daytrade';
  return lower;
}

function loadEnvFiles(env, cwd) {
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  const files = [
    path.join(cwd || ROOT, '.env'),
    path.join(cwd || ROOT, '.env.intraday-runtime'),
    path.join(cwd || ROOT, '.env.local'),
    path.join(runnerDir, '.env')
  ];
  for (const filePath of files) {
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
      if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
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
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--mode=')) opts.mode = normalizeMode(String(a.slice(7)).toLowerCase());
    else if (a === '--mode' && argv[i + 1]) { opts.mode = normalizeMode(String(argv[++i]).toLowerCase()); }
  }
  // Ensure mode is always normalized
  opts.mode = normalizeMode(opts.mode);
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
  const canonical = normalizeMode(mode);
  const def = MODES[canonical] || MODES[mode] || MODES.daytrade;
  for (const key of def.snapshotKeys) {
    if (Array.isArray(snapshot.data[key]) && snapshot.data[key].length) return snapshot.data[key];
  }
  // Fallback: try all snapshotKeys across all modes if canonical not found
  // This helps when snapshot uses different naming (e.g., swing vs swing_konglo)
  if (canonical === 'swing-konglo' || canonical === 'swing-non-konglo') {
    for (const m of [MODES['swing-konglo'], MODES['swing-non-konglo']]) {
      for (const key of m.snapshotKeys) {
        if (Array.isArray(snapshot.data[key]) && snapshot.data[key].length) return snapshot.data[key];
      }
    }
  }
  return [];
}

function formatCard(mode, candidates, updatedAt) {
  const canonical = normalizeMode(mode);
  const def = MODES[canonical] || MODES[mode] || MODES.daytrade;

  // Use rich canonical Telegram templates when rich candidate data is present
  let templates;
  try { templates = require(path.join(ROOT, 'lib', 'telegram-templates')); } catch (_) { templates = null; }

  if (templates && Array.isArray(candidates) && candidates.length > 0 && candidates[0].unified_score != null) {
    const topCandidates = candidates.slice(0, 5);
    if (canonical === 'swing-konglo') {
      return templates.formatSwingKongloSignalMessage(topCandidates, { updatedAt });
    }
    if (canonical === 'swing-non-konglo') {
      return templates.formatSwingNonKongloSignalMessage(topCandidates, { updatedAt });
    }
    if (canonical === 'daytrade') {
      return templates.formatDayTradeSignalMessage(topCandidates, { updatedAt });
    }
  }

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
  const mode = normalizeMode(opts.mode) || 'daytrade';
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
  if (opts.help) {
    const help = [
      'Usage: node tools/run-screener.js --mode=<mode> [--dry-run|--send] [--json]',
      '',
      'Modes (4 pilar):',
      '  --mode=daytrade            Day Trade momentum screener',
      '  --mode=fastwatcher         FastWatcher live volume spike (intraday)',
      '  --mode=swing-konglo        Swing Konglomerat (Barito/Salim/Astra/Bakrie/Sinarmas/Panin/MNC)',
      '  --mode=swing-non-konglo    Swing Non-Konglomerat (UTAMA/PENGEMBANGAN ex-konglo)',
      '',
      'Aliases: swing, konglo, nk, non-konglo, fast_watcher, intraday, day_trade',
      'Flags:',
      '  --dry-run   Hanya kalkulasi dan log kandidat (default)',
      '  --send      Broadcast ke Telegram channel (skip_market_guard=true)',
      '  --json      Output JSON',
      '  --help      Tampilkan bantuan'
    ].join('\n');
    const log = (deps && deps.log) || console.log;
    log(help);
    return { exitCode: 0, report: null };
  }
  const env = (deps && deps.env) || loadEnvFiles(Object.assign({}, process.env), ROOT);
  if (deps && deps.env) {
    for (const [k, v] of Object.entries(deps.env)) {
      if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
    }
  }
  let report = analyze(opts, Object.assign({ env, rootDir: ROOT }, deps || {}));

  if (report.snapshot_missing && !(deps && deps.skipAutoSnapshot) && !(deps && deps.rootDir)) {
    try {
      const { main: buildSnapshot } = require(path.join(ROOT, 'tools', 'build-screener-snapshot.js'));
      const snapRes = await buildSnapshot({ dryRun: false, print: false }, { env, rootDir: ROOT });
      if (snapRes && snapRes.ok) {
        report = analyze(opts, Object.assign({ env, rootDir: ROOT }, deps || {}));
      }
    } catch (_) {}
  }

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
  MODE_ALIASES,
  normalizeMode,
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
