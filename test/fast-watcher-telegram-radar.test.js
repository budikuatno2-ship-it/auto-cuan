'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const radar = require('../lib/intraday-fast-watcher-radar-publisher');

function tickerState(extra) {
  return {
    active: true,
    status: 'WATCHING',
    source_status: 'WAIT_PULLBACK',
    last_watch_score: 70,
    last_publish_score: 62,
    last_reasons: ['relative_volume_support'],
    last_observation: {
      current_price: 116,
      entry_low: 105,
      entry_high: 110,
      tp1: 118,
      tp2: 124,
      stop_loss: 102,
      risk_reward: 1.8,
      relative_volume: 1.8
    },
    last_metrics: {},
    ...(extra || {})
  };
}

test('radar keeps only safe top three and prioritizes first confirmation', () => {
  const state = {
    tickers: {
      WATCH: tickerState({ last_watch_score: 76 }),
      PEND: tickerState({ status: 'READY_PENDING', last_watch_score: 60 }),
      LOW: tickerState({ last_watch_score: 54 }),
      CHASE: tickerState({ last_watch_score: 90, last_reasons: ['above_adaptive_entry_tolerance'] }),
      FOUR: tickerState({ last_watch_score: 72 }),
      FIVE: tickerState({ last_watch_score: 68 })
    }
  };
  const selected = radar.selectRadarCandidates(state);
  assert.equal(selected.length, 3);
  assert.equal(selected[0].ticker, 'PEND');
  assert.equal(selected[0].status, 'KONFIRMASI 1/2');
  assert.deepEqual(selected.slice(1).map(item => item.ticker), ['WATCH', 'FOUR']);
  assert.ok(!selected.some(item => item.ticker === 'LOW'));
  assert.ok(!selected.some(item => item.ticker === 'CHASE'));
});

test('Telegram radar copy is compact and keeps entry TP and SL', () => {
  const item = radar.selectRadarCandidates({ tickers: { KPIG: tickerState() } })[0];
  const message = radar.buildRadarTelegramMessage([item], '2026-07-31', '11:10');
  assert.match(message, /📡 AUTO-CUAN DAY TRADE RADAR/);
  assert.match(message, /Pantauan, belum sinyal beli/);
  assert.match(message, /Entry Rp105–Rp110/);
  assert.match(message, /TP Rp118 \/ Rp124 \| SL Rp102/);
  assert.match(message, /jangan chase/);
  assert.match(message, /Entry hanya setelah konfirmasi Fast Watcher/);
  assert.doesNotMatch(message, /Technical Context|Pattern \/ Setup|Trading Plan/);
  assert.ok(message.length < 700);
});

test('radar is deduplicated and resends only after meaningful improvement', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-radar-'));
  const item = radar.selectRadarCandidates({ tickers: { KPIG: tickerState() } })[0];
  const messages = [];
  const common = {
    sampleDate: '2026-07-31',
    scheduledTime: '11:10',
    radarDir: root,
    candidates: [item],
    env: {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_RADAR_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_CHAT_ID: '-1001'
    },
    notifyFn: async message => {
      messages.push(message);
      return { sent: true };
    }
  };

  const first = await radar.publishRadar(common);
  assert.equal(first.telegram_sent, 1);
  assert.equal(first.radar_items_sent, 1);

  const duplicate = await radar.publishRadar({ ...common, scheduledTime: '11:13' });
  assert.equal(duplicate.telegram_sent, 0);
  assert.equal(duplicate.reason, 'radar_unchanged');

  const improved = { ...item, watch_score: item.watch_score + 8 };
  const third = await radar.publishRadar({ ...common, scheduledTime: '11:22', candidates: [improved] });
  assert.equal(third.telegram_sent, 1);
  assert.equal(messages.length, 2);
});

test('radar has a separate default-off kill switch', async () => {
  const result = await radar.publishRadar({
    sampleDate: '2026-07-31',
    scheduledTime: '11:10',
    candidates: [],
    env: {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1'
    }
  });
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'radar_kill_switch_off');
});
