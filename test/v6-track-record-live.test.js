'use strict';

/**
 * test/v6-track-record-live.test.js
 * ============================================================================
 * Independent Live Signal Ledger Track Record — Remediasi V6 (Subtask H)
 * ============================================================================
 * Verifies that the track record is derived from the REAL persisted signal
 * ledger (telegram_daily_picks shape), not fabricated backtest statistics:
 *   - UNREADABLE ledger fails honestly (success:false, errorCode).
 *   - WAITING / ENTERED / TP1 / TP2 / SL / EXPIRED / NEVER_ENTERED lifecycle.
 *   - 2–5 market-day holding horizon is stated and exports lifecycle states.
 *   - no-entry is NOT a loss (denominator excludes WAITING/NEVER_ENTERED).
 *   - same-bar TP+SL is AMBIGUOUS and never counted as a win.
 *   - slippage + fee costs are applied; gross and net are both reported.
 *   - immutable snapshot_id changes when the ledger changes.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const liveLedger = require('../lib/track-record-live-ledger');

function tempLedger(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-live-ledger-'));
  const file = path.join(dir, 'live-signal-ledger.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return file;
}

const baseRows = [
  { id: 1, date: '2026-11-04', ticker: 'BBCA', monitor_source: 'swing_konglo', entry1: 10000, tp1: 10400, tp2: 11000, sl: 9700, status: 'WAITING' },
  { id: 2, date: '2026-11-05', ticker: 'BBRI', monitor_source: 'swing_nk', entry1: 5000, tp1: 5200, tp2: 5400, sl: 4800, status: 'ENTERED', hit_entry_at: '2026-11-05T09:30:00Z' },
  { id: 3, date: '2026-11-06', ticker: 'BMRI', monitor_source: 'top5', entry1: 7000, tp1: 7350, tp2: 7600, sl: 6800, status: 'TP1_HIT', hit_entry_at: '2026-11-06T09:00:00Z', hit_tp1_at: '2026-11-06T10:00:00Z' },
  { id: 4, date: '2026-11-06', ticker: 'TLKM', monitor_source: 'daytrade', entry1: 3000, tp1: 3150, tp2: 3300, sl: 2950, status: 'TP2_HIT', hit_entry_at: '2026-11-06T09:00:00Z', hit_tp1_at: '2026-11-06T09:30:00Z', hit_tp2_at: '2026-11-06T10:00:00Z' },
  { id: 5, date: '2026-11-06', ticker: 'ASII', monitor_source: 'swing_konglo', entry1: 5100, tp1: 5350, tp2: 5600, sl: 4950, status: 'SL_HIT', hit_entry_at: '2026-11-07T09:00:00Z', hit_sl_at: '2026-11-07T10:00:00Z' }
];

test('V6-LIVE-1: loadLiveLedger reads array shape and reports success', () => {
  const file = tempLedger(baseRows);
  const res = liveLedger.loadLiveLedger(file);
  assert.equal(res.success, true);
  assert.equal(res.data.length, 5);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('V6-LIVE-2: loadLiveLedger fails honestly when file is missing (ENOENT)', () => {
  const res = liveLedger.loadLiveLedger(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.json'));
  assert.equal(res.success, false);
  assert.equal(res.errorCode, 'ENOENT');
  assert.equal(res.error, 'LIVE_LEDGER_NOT_FOUND');
  assert.equal(res.data, null);
});

test('V6-LIVE-3: loadLiveLedger fails honestly when the ledger is corrupt JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-live-ledger-'));
  const file = path.join(dir, 'live-signal-ledger.json');
  fs.writeFileSync(file, '{ this is not valid json', 'utf8');
  const res = liveLedger.loadLiveLedger(file);
  assert.equal(res.success, false);
  assert.equal(res.errorCode, 'JSON_SYNTAX_ERROR');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('V6-LIVE-4: buildLiveTrackRecord aggregates lifecycle and keeps no-entry out of loss denominator', () => {
  const rec = liveLedger.buildLiveTrackRecord(baseRows);
  const s = rec.summary;
  assert.equal(s.total_signals, 5);
  assert.equal(s.tp1_hits, 1);
  assert.equal(s.tp2_hits, 1);
  assert.equal(s.sl_hits, 1);
  assert.equal(s.waiting, 1);
  assert.equal(s.entered, 1);
  // Denominator discipline: resolved = wins + losses only.
  assert.equal(s.total_resolved, 3);
  assert.equal(s.win_rate_on_resolved_pct, Number(((2 / 3) * 100).toFixed(2)));
});

test('V6-LIVE-5: same-bar TP+SL is AMBIGUOUS and never counted as a win', () => {
  const rows = [
    { id: 1, date: '2026-11-06', ticker: 'X', entry1: 1000, tp1: 1100, sl: 900, status: 'ENTERED', hit_entry_at: '2026-11-06T09:00:00Z', hit_tp1_at: '2026-11-06T10:00:00Z', hit_sl_at: '2026-11-06T10:00:00Z' }
  ];
  const rec = liveLedger.buildLiveTrackRecord(rows);
  assert.equal(rec.summary.ambiguous_same_bar, 1);
  assert.equal(rec.summary.tp1_hits, 0);
  assert.equal(rec.summary.sl_hits, 0);
  assert.equal(rec.signals[0].outcome, 'AMBIGUOUS');
});

test('V6-LIVE-6: TP timestamp strictly before SL timestamp resolves as a win, SL before TP as a loss', () => {
  const rows = [
    { id: 1, date: '2026-11-06', ticker: 'WIN', entry1: 1000, tp1: 1100, sl: 900, hit_tp1_at: '2026-11-06T09:30:00Z', hit_sl_at: '2026-11-06T14:00:00Z' },
    { id: 2, date: '2026-11-06', ticker: 'LOSS', entry1: 1000, tp1: 1100, sl: 900, hit_tp1_at: '2026-11-06T14:00:00Z', hit_sl_at: '2026-11-06T09:30:00Z' }
  ];
  const rec = liveLedger.buildLiveTrackRecord(rows);
  assert.equal(rec.signals.find((s) => s.ticker === 'WIN').outcome, 'TP1_HIT');
  assert.equal(rec.signals.find((s) => s.ticker === 'LOSS').outcome, 'SL_HIT');
});

test('V6-LIVE-7: slippage + fee costs applied, gross and net both reported', () => {
  const rows = [{ id: 1, date: '2026-11-06', ticker: 'Y', entry1: 1000, tp1: 1100, sl: 900, status: 'TP1_HIT', hit_tp1_at: '2026-11-06T10:00:00Z' }];
  const rec = liveLedger.buildLiveTrackRecord(rows, { slippagePct: 0.25, feePct: 0.10 });
  const sig = rec.signals[0];
  assert.equal(sig.gross_gain_pct, 10);
  assert.equal(sig.net_gain_pct, Number((10 - 0.35).toFixed(4)));
});

test('V6-LIVE-8: immutable snapshot_id changes when ledger changes', () => {
  const a = liveLedger.buildLiveTrackRecord(baseRows).snapshot_id;
  const b = liveLedger.buildLiveTrackRecord(baseRows.concat([{ id: 99, date: '2026-11-07', ticker: 'ZZZZ', entry1: 1, sl: 0.9, tp1: 1.2, status: 'WAITING' }])).snapshot_id;
  assert.notEqual(a, b);
});

test('V6-LIVE-9: snapshot_id is deterministic for identical ledger content', () => {
  const a = liveLedger.buildLiveTrackRecord(baseRows).snapshot_id;
  const b = liveLedger.buildLiveTrackRecord(JSON.parse(JSON.stringify(baseRows))).snapshot_id;
  assert.equal(a, b);
});

test('V6-LIVE-10: INVALIDATED_BEFORE_ENTRY and TIME_EXIT are recognized (not collapsed)', () => {
  const rows = [
    { id: 1, date: '2026-11-06', ticker: 'INV', entry1: 1000, tp1: 1100, sl: 900, status: 'INVALIDATED_BEFORE_ENTRY' },
    { id: 2, date: '2026-11-06', ticker: 'TE', entry1: 1000, tp1: 1100, sl: 900, status: 'TIME_EXIT' }
  ];
  const rec = liveLedger.buildLiveTrackRecord(rows);
  assert.equal(rec.signals.find((s) => s.ticker === 'INV').outcome, 'INVALIDATED');
  assert.equal(rec.signals.find((s) => s.ticker === 'TE').outcome, 'TIME_EXIT');
  // Neither counts toward win/loss denominator.
  assert.equal(rec.summary.total_resolved, 0);
  assert.equal(rec.summary.invalidated, 1);
  assert.equal(rec.summary.time_exit, 1);
  assert.equal(rec.summary.floating_open, 0);
  assert.equal(rec.summary.closed_without_outcome, 2);
  assert.equal(rec.summary.accounted_total, 2);
});

test('V6-LIVE-11: AMBIGUOUS_SAME_BAR (lifecycle output) maps to AMBIGUOUS, never a win', () => {
  const rows = [
    { id: 1, date: '2026-11-06', ticker: 'AMB', entry1: 1000, tp1: 1100, sl: 900, status: 'AMBIGUOUS_SAME_BAR' }
  ];
  const rec = liveLedger.buildLiveTrackRecord(rows);
  assert.equal(rec.signals[0].outcome, 'AMBIGUOUS');
  assert.equal(rec.summary.tp1_hits, 0);
  assert.equal(rec.summary.sl_hits, 0);
  assert.equal(rec.summary.ambiguous_same_bar, 1);
  assert.equal(rec.summary.total_resolved, 0);
});

test('V6-LIVE-12: cost model is explicit per-side with round-trip total (default single-side, configurable)', () => {
  const single = liveLedger.resolveCostModel();
  assert.equal(single.slippage_pct_per_side, 0.25);
  assert.equal(single.fee_pct_per_side, 0.10);
  assert.equal(single.sides, 1);
  assert.equal(single.round_trip_cost_pct, 0.35, 'default contract keeps one-side drag (0.25+0.10)');
  const roundTrip = liveLedger.resolveCostModel({ sides: 2 });
  assert.equal(roundTrip.sides, 2);
  assert.equal(roundTrip.round_trip_cost_pct, 0.70, 'round-trip drag is (0.25+0.10)x2');
});

test('V6-LIVE-13: conservative entry basis uses max(entry1, entry2), never the lower bound', () => {
  const rec = liveLedger.buildLiveTrackRecord([
    { id: 1, date: '2026-11-06', ticker: 'Z', entry1: 1000, entry2: 1010, tp1: 1100, sl: 900, status: 'TP1_HIT', hit_tp1_at: '2026-11-06T10:00:00Z' }
  ]);
  assert.equal(rec.signals[0].entry, 1010, 'entry basis = max(entry1, entry2)');
  assert.equal(rec.signals[0].gross_gain_pct, Number(((1100 - 1010) / 1010 * 100).toFixed(4)));
});