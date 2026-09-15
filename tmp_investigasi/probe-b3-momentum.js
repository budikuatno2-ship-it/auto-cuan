'use strict';
const m = require('../lib/intraday-fast-watcher-momentum');

function mk(rvol) {
  return {
    ticker: 'BBRI', scheduled_time: '10:05', sample_date: '2026-08-13',
    current_price: 101.5, open: 100, high: 102.5, low: 99.5,
    entry_low: 100, entry_high: 102, tp1: 110, tp2: 118, stop_loss: 98,
    risk_reward: 2.6, relative_volume: rvol, volume_ratio_20d: rvol,
    volume: 1200, average_volume: 1000,
    momentum_component: 16, liquidity_component: 18,
    board: 'UTAMA', current_status: 'READY_BREAKOUT',
    freshness: { is_stale: false }, delta_turnover: 500000000
  };
}

const tracker = { last_price: 100, last_volume: 600, last_observation_minute: 600, last_volume_rate: 10, in_latest_shortlist: true };
for (const rv of [0.9, 1.1, 1.3, 1.5, 2.0]) {
  const r = m.evaluate(mk(rv), tracker);
  console.log('rvol', rv, '| passes', r.passes, '| status', r.status, '| entry_eligible', r.entry_eligible,
    '| vstrong', r.volume_strong, '| mstrong', r.momentum_strong, '| reasons', JSON.stringify(r.reasons));
}
