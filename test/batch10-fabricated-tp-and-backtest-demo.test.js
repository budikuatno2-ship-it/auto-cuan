'use strict';

var test = require('node:test');
var assert = require('node:assert');

var telegramTemplates = require('../lib/telegram-templates');
var backtest = require('../public/track-record-backtest');

// ============================================================
// F-065: Telegram Templates — Hapus TP Karangan & Label Dinamis
// ============================================================

test('F-065: formatSignalCard daytrade tanpa tp1/tp2 tidak memuat angka rekaan', function () {
  var payload = {
    ticker: 'TEST',
    entry_low: 1000,
    entry_high: 1000,
    tp1: null,
    tp2: null,
    stop_loss: 950,
    last_price: 1000,
    status: 'READY_BREAKOUT'
  };
  var msg = telegramTemplates.formatSignalCard(payload, 1, 'daytrade');
  // Tidak boleh ada angka hasil perkalian 1.045 / 1.075
  assert.ok(!msg.includes('1045'), 'Tidak boleh ada TP1 karangan 1045');
  assert.ok(!msg.includes('1075'), 'Tidak boleh ada TP2 karangan 1075');
  // Harus ada strip "—" untuk TP yang kosong
  assert.ok(msg.includes('Target Profit 1: —'), 'TP1 kosong harus tampil strip');
  // TP2 kosong tidak ditampilkan (bukan strip) karena baris TP2 di-omit
  assert.ok(!msg.includes('Target Profit 2'), 'TP2 kosong harus di-omit');
});

test('F-065: formatSignalCard swing tanpa tp1/tp2 tidak memuat angka rekaan', function () {
  var payload = {
    ticker: 'TEST',
    entry_low: 1000,
    entry_high: 1000,
    tp1: null,
    tp2: null,
    stop_loss: 950,
    last_price: 1000,
    status: 'READY_BREAKOUT'
  };
  var msg = telegramTemplates.formatSignalCard(payload, 1, 'swing');
  // Tidak boleh ada angka hasil perkalian 1.055
  assert.ok(!msg.includes('1055'), 'Tidak boleh ada TP1 swing karangan 1055');
  assert.ok(msg.includes('Target Profit 1 (Partial TP 50%): —'), 'TP1 swing kosong harus tampil strip');
});

test('F-065: label persentase TP dihitung dinamis dari selisih entry', function () {
  var payload = {
    ticker: 'TEST',
    entry_low: 1000,
    entry_high: 1000,
    tp1: 1050,
    tp2: 1100,
    stop_loss: 950,
    last_price: 1000,
    status: 'READY_BREAKOUT'
  };
  var msg = telegramTemplates.formatSignalCard(payload, 1, 'daytrade');
  // (1050/1000 - 1) * 100 = 5%
  assert.ok(msg.includes('Target Profit 1 (+5%)'), 'Label TP1 harus dinamis +5%');
  // (1100/1000 - 1) * 100 = 10%
  assert.ok(msg.includes('Target Profit 2 (+10%)'), 'Label TP2 harus dinamis +10%');
});

test('F-065: label persentase swing dihitung dinamis dari selisih entry', function () {
  var payload = {
    ticker: 'TEST',
    entry_low: 1000,
    entry_high: 1000,
    tp1: 1060,
    tp2: 1120,
    stop_loss: 950,
    last_price: 1000,
    status: 'READY_BREAKOUT'
  };
  var msg = telegramTemplates.formatSignalCard(payload, 1, 'swing');
  // (1060/1000 - 1) * 100 = 6%
  assert.ok(msg.includes('Target Profit 1 (+6% Partial TP 50%)'), 'Label TP1 swing harus dinamis +6%');
});

// ============================================================
// F-085: Track Record Backtest — Tidak Ada Benchmark Palsu
// ============================================================

test('F-085: runBacktestSimulation dengan sinyal kosong mengembalikan status eksplisit', function () {
  var result = backtest.runBacktestSimulation([], {});
  assert.strictEqual(result.status, 'NO_SIGNALS', 'Status harus NO_SIGNALS');
  assert.strictEqual(result.message, 'Belum ada sinyal untuk disimulasikan', 'Pesan harus eksplisit');
  assert.strictEqual(result.metrics.totalTrades, 0, 'Total trades harus 0');
  assert.strictEqual(result.trades.length, 0, 'Trades harus kosong');
});

test('F-085: runBacktestSimulation dengan sinyal valid tidak mengembalikan status NO_SIGNALS', function () {
  var signals = [
    { ticker: 'BBCA', date: '2026-08-05', source: 'swing_konglo', category: 'Swing Konglo', entry1: 9900, entry2: 9800, tp1: 10400, tp2: 10800, sl: 9600, outcome: 'TP1_HIT', duration_text: '4 hari' }
  ];
  var result = backtest.runBacktestSimulation(signals, {});
  assert.strictEqual(result.status, undefined, 'Status tidak boleh NO_SIGNALS untuk data valid');
  assert.strictEqual(result.metrics.totalTrades, 1, 'Total trades harus 1');
});
