'use strict';

/**
 * Radar publisher — Telegram contract.
 *
 * STAGE 2 CONTRACT (confirmed-only publication): the Day Trade Telegram
 * channel must never receive raw pre-confirmation watch signals. Radar
 * candidates with 0/2 (EARLY WATCH) or 1/2 (RADAR PRIORITAS) confirmations
 * are recorded in the radar ledger for observability but are NOT sent. Only
 * a candidate that has reached full confirmation — `ready_streak >= 2`
 * (2/2 Terkonfirmasi) or a confirmed pool status (READY_CONFIRMED /
 * A_PLUS_SETUP / TRADE_CANDIDATE / READY_BREAKOUT) — may be published.
 *
 * The fixtures below therefore carry `ready_streak: 2`; the dedicated
 * pre-confirmation tests at the bottom of this file assert the block.
 */

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
    ready_streak: 2,
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
  assert.equal(
    selected[0].status,
    'RADAR PRIORITAS — 1/2 KONFIRMASI'
  );
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
  assert.match(
    message,
    /Setup masih menarik\. Tunggu pullback/
  );
  assert.match(
    message,
    /Radar dapat bergerak lebih dulu/
  );
  assert.doesNotMatch(
    message,
    /Fast Watcher|Technical Context|Pattern \/ Setup|Trading Plan/
  );
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

// ---------------------------------------------------------------------------
// STAGE 2: confirmed-only Telegram publication
// ---------------------------------------------------------------------------

test('STAGE2: EARLY WATCH (0/2) radar is recorded but never sent to Telegram', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-radar-0of2-'));
  const messages = [];
  const item = radar.selectRadarCandidates({ tickers: { KPIG: tickerState({ ready_streak: 0 }) } })[0];
  const result = await radar.publishRadar({
    sampleDate: '2026-07-31',
    scheduledTime: '10:10',
    radarDir: root,
    candidates: [item],
    env: {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_RADAR_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_CHAT_ID: '-1001'
    },
    notifyFn: async message => { messages.push(message); return { sent: true }; }
  });
  assert.equal(result.telegram_sent, 0);
  assert.equal(result.reason, 'preconfirmation_radar_blocked');
  assert.equal(messages.length, 0, '0/2 EARLY WATCH must not reach the channel');
  assert.equal(result.preconfirmation_blocked.length, 1);
  assert.equal(result.preconfirmation_blocked[0].ticker, 'KPIG');
  // Observability preserved: the ledger still records the observation.
  const ledger = JSON.parse(await fsp.readFile(path.join(root, '2026-07-31.json'), 'utf8'));
  assert.ok(ledger.tickers.KPIG);
  assert.equal(ledger.tickers.KPIG.telegram_suppressed_reason, 'preconfirmation_radar_blocked');
  assert.equal(ledger.tickers.KPIG.sent_at, undefined);
});

test('STAGE2: RADAR PRIORITAS (1/2) radar is recorded but never sent to Telegram', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-radar-1of2-'));
  const messages = [];
  const item = radar.selectRadarCandidates({ tickers: { KPIG: tickerState({ ready_streak: 1 }) } })[0];
  const result = await radar.publishRadar({
    sampleDate: '2026-07-31',
    scheduledTime: '10:10',
    radarDir: root,
    candidates: [item],
    env: {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_RADAR_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_CHAT_ID: '-1001'
    },
    notifyFn: async message => { messages.push(message); return { sent: true }; }
  });
  assert.equal(result.telegram_sent, 0);
  assert.equal(result.reason, 'preconfirmation_radar_blocked');
  assert.equal(messages.length, 0, '1/2 RADAR PRIORITAS must not reach the channel');
});

test('STAGE2: confirmation helpers classify 0/2, 1/2 and 2/2 correctly', () => {
  assert.equal(radar.isPreConfirmationItem({ status: 'WATCHING', ready_streak: 0 }), true);
  assert.equal(radar.isPreConfirmationItem({ status: 'READY_PENDING', ready_streak: 1 }), true);
  assert.equal(radar.isFullyConfirmedItem({ status: 'READY_PENDING', ready_streak: 2 }), true);
  assert.equal(radar.isPreConfirmationItem({ status: 'READY_PENDING', ready_streak: 2 }), false);
  assert.equal(radar.isFullyConfirmedItem({ status: 'READY_CONFIRMED', ready_streak: 3 }), true);
  assert.equal(radar.isFullyConfirmedItem({ status: 'A_PLUS_SETUP', ready_streak: 0 }), true);
  assert.equal(radar.confirmationCountOf({ ready_streak: 2 }), 2);
});

// ---------------------------------------------------------------------------
// STAGE 2: hard cut-off 14:30 WIB (AFTERNOON_EXIT rule)
// ---------------------------------------------------------------------------

test('STAGE2: no new radar after 14:30 WIB — the 15:37 WIB pre-close send is blocked', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-radar-cutoff-'));
  const messages = [];
  const item = radar.selectRadarCandidates({ tickers: { KPIG: tickerState() } })[0];
  const result = await radar.publishRadar({
    sampleDate: '2026-07-31',
    scheduledTime: '15:37',
    radarDir: root,
    candidates: [item],
    env: {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_RADAR_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_CHAT_ID: '-1001'
    },
    notifyFn: async message => { messages.push(message); return { sent: true }; }
  });
  assert.equal(result.telegram_sent, 0);
  assert.equal(result.reason, 'after_1430_wib_cutoff');
  assert.equal(messages.length, 0, 'no radar may be sent at 15:37 WIB');
  assert.deepEqual(result.radar_candidates_suppressed, ['KPIG']);
});

test('STAGE2: 14:30 WIB itself is still inside the radar window (cut-off is strictly after)', () => {
  assert.equal(radar.evaluateRadarTimeWindow('14:30').allowed, true);
  assert.equal(radar.evaluateRadarTimeWindow('14:31').allowed, false);
  assert.equal(radar.evaluateRadarTimeWindow('14:31').reason, 'after_1430_wib_cutoff');
  assert.equal(radar.evaluateRadarTimeWindow('15:37').allowed, false);
  assert.equal(radar.evaluateRadarTimeWindow('09:15').allowed, true);
});

test('STAGE2: pre-confirmation override is default OFF and opt-in only', async () => {
  assert.equal(radar.PRECONFIRMATION_OVERRIDE_ENV, 'FAST_WATCHER_RADAR_ALLOW_PRECONFIRMATION_TELEGRAM');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-radar-override-'));
  const messages = [];
  const item = radar.selectRadarCandidates({ tickers: { KPIG: tickerState({ ready_streak: 0 }) } })[0];
  const result = await radar.publishRadar({
    sampleDate: '2026-07-31',
    scheduledTime: '10:10',
    radarDir: root,
    candidates: [item],
    env: {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_RADAR_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_CHAT_ID: '-1001',
      FAST_WATCHER_RADAR_ALLOW_PRECONFIRMATION_TELEGRAM: '1'
    },
    notifyFn: async message => { messages.push(message); return { sent: true }; }
  });
  assert.equal(result.telegram_sent, 1, 'the explicit override must still work');
  assert.equal(messages.length, 1);
});
