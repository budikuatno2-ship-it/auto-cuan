'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTrackRecordData,
  formatWibTime,
  calculateGainPct
} = require('../lib/track-record-service');
const telegramNotifier = require('../lib/telegram-notifier');
const {
  classifyTelegramResult,
  rowWasDelivered
} = require('../lib/telegram-delivery');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('Batch 4: Floating and waiting signals are never counted as TP or SL outcomes', () => {
  const rows = [
    { ticker: 'BBCA', entry1: 10000, tp1: 10500, sl: 9800, outcome: 'WAITING', category: 'Day Trade' },
    { ticker: 'BBRI', entry1: 5000, tp1: 5200, sl: 4900, outcome: 'RUNNING', category: 'Day Trade' },
    { ticker: 'BMRI', entry1: 6500, tp1: 6800, sl: 6300, outcome: 'TP1_HIT', category: 'Day Trade' },
    { ticker: 'BBNI', entry1: 5200, tp1: 5400, sl: 5000, outcome: 'SL_HIT', category: 'Day Trade' },
    { ticker: 'TLKM', entry1: 3000, tp1: 3200, sl: 2900, outcome: 'EXPIRED', category: 'Day Trade' }
  ];

  const data = buildTrackRecordData(rows);
  const sum = data.summary;

  assert.equal(sum.total_signals, 5);
  assert.equal(sum.tp1_hits, 1, 'Only BMRI hit TP1');
  assert.equal(sum.sl_hits, 1, 'Only BBNI hit SL');
  assert.equal(sum.running_signals, 1, 'BBRI is running');
  assert.equal(sum.waiting_signals, 1, 'BBCA is waiting');
  assert.equal(sum.expired_signals, 1, 'TLKM is expired');

  // Resolved count: TP1 (1) + SL (1) + EXPIRED (1) = 3
  assert.equal(sum.total_resolved, 3);

  // Overall Win Rate from total: 1/5 = 20.0%
  assert.equal(sum.win_rate_tp1, '20.0%');
  // Resolved Win Rate from resolved: 1/3 = 33.3%
  assert.equal(sum.resolved_win_rate, '33.3%');
  // SL rate from total: 1/5 = 20.0%
  assert.equal(sum.sl_rate, '20.0%');
});

test('Batch 4: Signals in WAITING state are ineligible for best_gain or realized gain', () => {
  const rows = [
    {
      ticker: 'BBCA',
      entry1: 10000,
      tp1: 11000,
      sl: 9500,
      high: 11500, // High reached on day, but signal is WAITING (entry not hit yet)
      outcome: 'WAITING',
      category: 'Day Trade'
    },
    {
      ticker: 'MEDC',
      entry1: 1200,
      tp1: 1300,
      sl: 1150,
      high: 1260,
      outcome: 'TP1_HIT',
      category: 'Day Trade'
    }
  ];

  const data = buildTrackRecordData(rows);

  // Best gain should be MEDC (TP1_HIT), NOT BBCA (WAITING)
  assert.ok(data.summary.best_gain, 'best_gain should exist');
  assert.equal(data.summary.best_gain.ticker, 'MEDC');
  assert.equal(data.signals[0].gain_pct, null, 'BBCA WAITING signal must have null gain_pct');
});

test('Batch 4: WIB time formatting is consistent and valid', () => {
  const iso = '2026-10-09T02:30:00.000Z'; // 09:30 WIB
  const formatted = formatWibTime(iso);
  assert.equal(formatted, '09:30 WIB');
  assert.equal(formatWibTime(null), '—');
  assert.equal(formatWibTime('invalid-date'), '—');
});

test('Batch 4: Telegram dry-run guard prevents all network requests', async () => {
  // Test both option casings
  const res1 = await telegramNotifier.sendTelegramMessage('Test alert', { dry_run: true });
  assert.equal(res1.sent, false);
  assert.equal(res1.skipped, true);
  assert.equal(res1.reason, 'dry_run');

  const res2 = await telegramNotifier.sendTelegramMessage('Test alert', { dryRun: true });
  assert.equal(res2.sent, false);
  assert.equal(res2.skipped, true);
  assert.equal(res2.reason, 'dry_run');
});

test('Batch 4: Telegram kill switch stops broadcast when disabled', async () => {
  const oldEnv = process.env.TELEGRAM_ENABLED;
  try {
    process.env.TELEGRAM_ENABLED = '0';
    const res = await telegramNotifier.sendTelegramMessage('Test alert', { skip_market_guard: true });
    assert.equal(res.sent, false);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'telegram_disabled');
  } finally {
    process.env.TELEGRAM_ENABLED = oldEnv;
  }
});

test('Batch 4: classifyTelegramResult and rowWasDelivered prevent duplicate delivery retry', () => {
  const deliveredResult = { sent: true, chunks_sent: 1, chunks_total: 1 };
  const classified = classifyTelegramResult(deliveredResult);
  assert.equal(classified.delivered, true);
  assert.equal(classified.retryable, false);

  const rowDelivered = { first_sent_at: '2026-10-09T09:00:00Z' };
  assert.equal(rowWasDelivered(rowDelivered), true);

  const rowDeliveredStatus = { raw_payload: { telegram_delivery_status: 'DELIVERED' } };
  assert.equal(rowWasDelivered(rowDeliveredStatus), true);

  const rowDeliveredSent = { raw_payload: { telegram_sent_at: '2026-10-09T09:00:00Z' } };
  assert.equal(rowWasDelivered(rowDeliveredSent), true);
});

test('Batch 4: Track Record table header alignment and fixed table layout', () => {
  const indexHtml = read('public/index.html');
  const css = read('public/ui-theme.css');

  assert.match(indexHtml, /<table[^>]*class="[^"]*min-w-\[960px\][^"]*table-fixed[^"]*"/);
  assert.match(indexHtml, /<th[^>]*w-\[110px\][^>]*>Ticker<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[95px\][^>]*>Kategori<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[125px\][^>]*>Waktu Sinyal<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[110px\][^>]*>Entry<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[90px\][^>]*>Target 1<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[90px\][^>]*>Target 2<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[90px\][^>]*>Stop Loss<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[140px\][^>]*>Status \/ Eksekusi<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[90px\][^>]*>Gain \/ Loss<\/th>/);
  assert.match(indexHtml, /<th[^>]*w-\[90px\][^>]*>Durasi<\/th>/);

  assert.match(css, /#trTableWrap table\s*\{[^}]*table-layout:\s*fixed/);
});
