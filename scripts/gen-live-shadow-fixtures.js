'use strict';

/**
 * One-off generator for the live shadow-scoring test fixtures.
 * Produces deterministic candidates.jsonl / runs.jsonl / summary.json /
 * lifecycle.json under test/fixtures/intraday-shadow-scoring-live/2026-07-21/.
 *
 * The data is designed to exercise:
 *   - confirmation after two CONSECUTIVE appearances (CONS)
 *   - 2-of-last-3 confirmation with a gap (GAPS)
 *   - an ATLA-style ONE-snapshot candidate that is high-scoring yet stays
 *     provisional and is filtered from the confirmed Top 5 (ATLA)
 *   - forward-return HIT / MISS / NEUTRAL cases (WINR rising, LOSR falling, FLAT)
 *   - +15/+30/+60 offsets on a 15-min grid plus an EOD (16:00) snapshot
 *
 * Run: node scripts/gen-live-shadow-fixtures.js
 */

const fs = require('node:fs');
const path = require('node:path');

const DATE = '2026-07-21';
const OUT_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'intraday-shadow-scoring-live', DATE);

// Snapshot times (15-min grid) + EOD final snapshot.
const TIMES = ['09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '16:00'];

// Per-ticker plan: strength S (flat component value) and per-time price.
// A ticker is present at a time only if a price is listed for that time.
const PLAN = {
  // Rising winner — present every snapshot -> confirmed; forward returns HIT.
  WINR: { s: 90, prices: { '09:15': 1000, '09:30': 1010, '09:45': 1020, '10:00': 1035, '10:15': 1050, '10:30': 1060, '16:00': 1100 } },
  // Falling loser — present every snapshot -> confirmed; forward returns MISS.
  LOSR: { s: 85, prices: { '09:15': 1000, '09:30': 990, '09:45': 980, '10:00': 970, '10:15': 960, '10:30': 950, '16:00': 900 } },
  // Flat — present every snapshot -> confirmed; forward returns NEUTRAL.
  FLAT: { s: 80, prices: { '09:15': 1000, '09:30': 1000, '09:45': 1000, '10:00': 1000, '10:15': 1000, '10:30': 1000, '16:00': 1000 } },
  // Two consecutive then gone -> confirmed at 09:30 via TWO_CONSECUTIVE.
  CONS: { s: 78, prices: { '09:15': 500, '09:30': 505 } },
  // Gap pattern: 09:15, (skip 09:30), 09:45, (skip 10:00), 10:15 -> confirmed at
  // 09:45 via TWO_OF_LAST_THREE (not consecutive).
  GAPS: { s: 76, prices: { '09:15': 800, '09:45': 810, '10:15': 820 } },
  // Filler present every snapshot so Top 5 has >5 members.
  MIDD: { s: 70, prices: { '09:15': 200, '09:30': 200, '09:45': 200, '10:00': 200, '10:15': 200, '10:30': 200, '16:00': 200 } },
  // ATLA-style: appears in EXACTLY ONE snapshot, with a very high score so it
  // would top the PROVISIONAL Top 5 — but must never enter the CONFIRMED Top 5.
  ATLA: { s: 95, prices: { '10:15': 3000 } }
};

function candidateRecord(ticker, time, price, strength, rank) {
  return {
    ticker,
    sample_timestamp: DATE + 'T' + time + ':03.000Z',
    scheduled_time: time,
    rank,
    score: strength,
    execution_grade: 'B',
    candidate_type: 'READY_BREAKOUT',
    current_status: 'READY_BREAKOUT',
    risk_level: 'MEDIUM',
    current_price: price,
    open: price,
    high: price,
    low: price,
    previous_close: price,
    volume: 1500000,
    average_volume: 900000,
    relative_volume: 1.4,
    entry_low: price,
    entry_high: price,
    reference_entry_price: price,
    tp1: price + 10,
    tp2: price + 20,
    sl: price - 10,
    liquidity_component: strength,
    pre_spike_component: strength,
    momentum_component: strength,
    risk_reward_component: strength,
    trend_component: strength,
    penalty_component: 0,
    reason_codes: [],
    data_quality_status: 'OK',
    data_quality_note: null,
    freshness: { provider: 'yahoo_chart_1d', is_stale: false, network_fetch: true, cache_hit: false }
  };
}

function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const candidateLines = [];
  const runLines = [];

  for (const time of TIMES) {
    // Determine which tickers are present at this time, ordered by strength desc
    // (so the collector-style rank field is sensible/deterministic).
    const present = Object.keys(PLAN)
      .filter((t) => PLAN[t].prices[time] !== undefined)
      .sort((a, b) => PLAN[b].s - PLAN[a].s || a.localeCompare(b));

    present.forEach((ticker, i) => {
      const price = PLAN[ticker].prices[time];
      candidateLines.push(JSON.stringify(candidateRecord(ticker, time, price, PLAN[ticker].s, i + 1)));
    });

    runLines.push(JSON.stringify({
      type: 'sample_run',
      version: 'intraday-sample-collector-v2.0',
      sample_date: DATE,
      timezone: 'Asia/Jakarta',
      scheduled_time: time,
      actual_start: DATE + 'T' + time + ':00.000Z',
      actual_finish: DATE + 'T' + time + ':05.000Z',
      duration_ms: 5000,
      market_session: time === '16:00' ? 'FINAL' : (time < '12:00' ? 'MORNING' : 'AFTERNOON'),
      status: 'success',
      candidate_count: present.length
    }));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'candidates.jsonl'), candidateLines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'runs.jsonl'), runLines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({
    version: 'intraday-sample-collector-v2.0',
    sample_date: DATE,
    timezone: 'Asia/Jakarta',
    total_snapshots: TIMES.length,
    note: 'Synthetic fixture for live shadow-scoring tests (context only; never rewritten).'
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'lifecycle.json'), JSON.stringify({
    sample_date: DATE,
    snapshots: TIMES,
    note: 'Synthetic fixture lifecycle (context only).'
  }, null, 2) + '\n');

  process.stdout.write('Wrote fixtures to ' + OUT_DIR + '\n');
  process.stdout.write('  candidates: ' + candidateLines.length + ' rows across ' + TIMES.length + ' snapshots\n');
}

build();
