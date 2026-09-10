'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const backtest = require('../public/track-record-backtest.js');

test('calculateExecutionEntry computes arithmetic average of entry1 and entry2', () => {
  // Both entries valid
  const s1 = { entry1: 1000, entry2: 900 };
  assert.equal(backtest.calculateExecutionEntry(s1), 950);

  // Inverted order (entry1 lower, entry2 higher)
  const s2 = { entry1: 900, entry2: 1000 };
  assert.equal(backtest.calculateExecutionEntry(s2), 950);

  // Only entry1 valid
  const s3 = { entry1: 1200, entry2: null };
  assert.equal(backtest.calculateExecutionEntry(s3), 1200);

  // Only entry2 valid
  const s4 = { entry1: null, entry2: 850 };
  assert.equal(backtest.calculateExecutionEntry(s4), 850);

  // Missing or zero entries
  assert.equal(backtest.calculateExecutionEntry({}), null);
  assert.equal(backtest.calculateExecutionEntry({ entry1: 0, entry2: 0 }), null);
});

test('calculateSignalRr correctly derives Risk to Reward ratio from average entry', () => {
  // entry = (1000 + 900) / 2 = 950
  // tp1 = 1100 -> reward = 150
  // sl = 875 -> risk = 75
  // rr = 150 / 75 = 2.0
  const s = { entry1: 1000, entry2: 900, tp1: 1100, sl: 875 };
  assert.equal(backtest.calculateSignalRr(s), 2.0);

  // Invalid SL above entry or TP below entry returns null
  assert.equal(backtest.calculateSignalRr({ entry1: 1000, entry2: 1000, tp1: 900, sl: 800 }), null);
  assert.equal(backtest.calculateSignalRr({ entry1: 1000, entry2: 1000, tp1: 1200, sl: 1100 }), null);
});

test('runBacktestSimulation computes metrics, win rate, and equity curve deterministically', () => {
  const mockSignals = [
    {
      ticker: 'BBCA',
      date: '2026-08-01',
      source: 'daytrade',
      category: 'Day Trade',
      entry1: 1000,
      entry2: 900, // avg entry 950
      tp1: 1045,   // +10%
      tp2: 1140,   // +20%
      sl: 902.5,   // -5%
      outcome: 'TP1_HIT',
      duration_text: '2 jam'
    },
    {
      ticker: 'ASII',
      date: '2026-08-02',
      source: 'daytrade',
      category: 'Day Trade',
      entry1: 1000,
      entry2: 1000, // avg entry 1000
      tp1: 1100,    // +10%
      tp2: 1200,    // +20%
      sl: 950,      // -5%
      outcome: 'SL_HIT',
      duration_text: '1 hari'
    },
    {
      ticker: 'TLKM',
      date: '2026-08-03',
      source: 'swing_konglo',
      category: 'Swing Konglo',
      entry1: 1000,
      entry2: 1000, // avg entry 1000
      tp1: 1100,    // +10%
      tp2: 1200,    // +20%
      sl: 950,      // -5%
      outcome: 'TP2_HIT',
      duration_text: '3 hari'
    },
    {
      ticker: 'UNVR',
      date: '2026-08-04',
      source: 'daytrade',
      category: 'Day Trade',
      entry1: 1000,
      entry2: 1000,
      tp1: 1100,
      tp2: 1200,
      sl: 950,
      outcome: 'WAITING' // Should be skipped in finished trades
    }
  ];

  const result = backtest.runBacktestSimulation(mockSignals, {
    initialCapital: 10000000,
    sizingMode: 'fixed_amount',
    positionAmount: 10000000, // 100% fixed 10 Jt per trade
    targetStrategy: 'max_tp'
  });

  const m = result.metrics;
  assert.equal(m.totalTrades, 3);
  assert.equal(m.winCount, 2);
  assert.equal(m.lossCount, 1);
  assert.equal(m.winRatePct, 66.7);
  assert.equal(m.skippedCount, 1);

  // Trade 1: +10% of 10M = +1M (capital = 11M)
  // Trade 2: -5% of 10M = -500k (capital = 10.5M)
  // Trade 3: +20% of 10M = +2M (capital = 12.5M)
  assert.equal(m.endingCapital, 12500000);
  assert.equal(m.netProfitRp, 2500000);
  assert.equal(m.totalReturnPct, 25.0);
  assert.equal(m.grossProfitRp, 3000000);
  assert.equal(m.grossLossRp, 500000);
  assert.equal(m.profitFactor, 6.0);

  // Equity curve has 4 points (START + 3 trades)
  assert.equal(result.equityCurve.length, 4);
  assert.equal(result.equityCurve[0].capital, 10000000);
  assert.equal(result.equityCurve[3].capital, 12500000);
});

test('runBacktestSimulation filter by category and min R:R functions accurately', () => {
  const signals = [
    {
      ticker: 'DT1',
      date: '2026-08-01',
      source: 'daytrade',
      entry1: 1000,
      entry2: 1000,
      tp1: 1100, // reward 100
      sl: 950,   // risk 50 -> rr = 2.0
      outcome: 'TP1_HIT'
    },
    {
      ticker: 'DT2',
      date: '2026-08-02',
      source: 'daytrade',
      entry1: 1000,
      entry2: 1000,
      tp1: 1050, // reward 50
      sl: 950,   // risk 50 -> rr = 1.0
      outcome: 'TP1_HIT'
    },
    {
      ticker: 'SW1',
      date: '2026-08-03',
      source: 'swing_konglo',
      entry1: 1000,
      entry2: 1000,
      tp1: 1200, // reward 200
      sl: 900,   // risk 100 -> rr = 2.0
      outcome: 'TP1_HIT'
    }
  ];

  // Filter category = daytrade only
  const dtRes = backtest.runBacktestSimulation(signals, { category: 'daytrade' });
  assert.equal(dtRes.metrics.totalTrades, 2);

  // Filter minRr = 1.5 (should exclude DT2 with rr = 1.0)
  const rrRes = backtest.runBacktestSimulation(signals, { minRr: 1.5 });
  assert.equal(rrRes.metrics.totalTrades, 2);
  assert.equal(rrRes.trades.some(t => t.ticker === 'DT2'), false);
});

test('runBacktestSimulation supports flexible outcomes (WIN, LOSS, pnl_pct) and fallback benchmark dataset', () => {
  // 1. Fallback benchmark dataset when empty
  const emptyRes = backtest.runBacktestSimulation([]);
  assert.ok(emptyRes.metrics.totalTrades >= 5, 'Fallback benchmark dataset should yield >= 5 trades');
  assert.ok(emptyRes.metrics.winRatePct > 0);

  // 2. Flexible outcomes (WIN, LOSS, pnl_pct)
  const flexSignals = [
    { ticker: 'W1', date: '2026-08-01', entry: 1000, outcome: 'WIN', pnl_pct: 12.5 },
    { ticker: 'L1', date: '2026-08-02', entry: 2000, outcome: 'LOSS', pnl_pct: -4.0 },
    { ticker: 'W2', date: '2026-08-03', buy_price: 500, outcome: 'PROFIT', tp1: 550, sl: 480 }
  ];
  const flexRes = backtest.runBacktestSimulation(flexSignals, {
    initialCapital: 10000000,
    sizingMode: 'fixed_amount',
    positionAmount: 2000000
  });

  assert.equal(flexRes.metrics.totalTrades, 3);
  assert.equal(flexRes.metrics.winCount, 2);
  assert.equal(flexRes.metrics.lossCount, 1);
  assert.ok(flexRes.metrics.netProfitRp > 0);
});

test('renderBacktestTradeTable outputs detailed 10-column table format', () => {
  const domTbody = { innerHTML: '' };
  const domEmpty = { classList: { add: () => {}, remove: () => {} } };
  global.document = {
    getElementById: function (id) {
      if (id === 'trBacktestTradesBody') return domTbody;
      if (id === 'trBacktestEmptyState') return domEmpty;
      return null;
    }
  };

  const trades = [
    {
      tradeNum: 1,
      date: '2026-08-10',
      ticker: 'BBCA',
      category: 'Swing Konglo',
      entry: 10000,
      exitPrice: 10800,
      rr: 2.5,
      finalTarget: 'TP1',
      gainPct: 8.0,
      pnlRp: 160000,
      endingCapital: 10160000
    }
  ];

  backtest.renderBacktestTradeTable(trades);
  assert.ok(domTbody.innerHTML.includes('BBCA'));
  assert.ok(domTbody.innerHTML.includes('Swing Konglo'));
  assert.ok(domTbody.innerHTML.includes('Rp 10.000'));
  assert.ok(domTbody.innerHTML.includes('Rp 10.800'));
  assert.ok(domTbody.innerHTML.includes('2.5x'));
  assert.ok(domTbody.innerHTML.includes('TP1'));
  assert.ok(domTbody.innerHTML.includes('+8.0%'));
  assert.ok(domTbody.innerHTML.includes('+Rp 160.000'));
  assert.ok(domTbody.innerHTML.includes('Rp 10.160.000'));
});

test('API endpoint count remains exactly 12', () => {
  const apiDir = path.resolve(__dirname, '..', 'api');
  const files = fs.readdirSync(apiDir).filter(f => f.endsWith('.js'));
  assert.equal(files.length, 12, 'api/ must contain exactly 12 endpoints');
});
