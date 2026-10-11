'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const marketHoursGuard = require('../lib/market-hours-guard');
const volumePace = require('../lib/intraday-volume-pace');
const fastWatcherLive = require('../lib/intraday-fast-watcher-live');
const fastWatcherPublisher = require('../lib/intraday-fast-watcher-publisher');
const fastWatcherRadarPublisher = require('../lib/intraday-fast-watcher-radar-publisher');

test('BATCH 1 - B1: Regular session boundaries (Mon-Thu vs Friday)', () => {
  // Senin (2026-10-12):
  // 08:59: Pre-market
  const monPre = marketHoursGuard.getMarketSessionStatus('2026-10-12 08:59:00');
  assert.equal(monPre.isOpen, false);
  assert.equal(monPre.session, 'PRE');

  // 09:00: Sesi 1 buka
  const monS1 = marketHoursGuard.getMarketSessionStatus('2026-10-12 09:00:00');
  assert.equal(monS1.isOpen, true);
  assert.equal(monS1.session, 'SESSION_1');
  assert.equal(monS1.broadcast_allowed, true);

  // 11:58: Broadcast S1 tutup (buffer 2 menit)
  const monS1Buffer = marketHoursGuard.getMarketSessionStatus('2026-10-12 11:58:00');
  assert.equal(monS1Buffer.session, 'SESSION_1');
  // At 11:58:00 totalMinutes = 718 => isMarketOpen is true at 11:58:00, but at 11:58:01+ broadcast is closed
  const monS1PostBuffer = marketHoursGuard.getMarketSessionStatus('2026-10-12 11:59:00');
  assert.equal(monS1PostBuffer.session, 'SESSION_1');
  assert.equal(monS1PostBuffer.broadcast_allowed, false, '11:59 Mon-Thu broadcast must be blocked by buffer');

  // 12:00: Sesi 1 reguler selesai, Istirahat (12:00 - 13:30)
  const monBreak = marketHoursGuard.getMarketSessionStatus('2026-10-12 12:30:00');
  assert.equal(monBreak.isOpen, false);
  assert.equal(monBreak.session, 'BREAK');
  assert.equal(monBreak.broadcast_allowed, false);

  // 13:30: Sesi 2 buka
  const monS2 = marketHoursGuard.getMarketSessionStatus('2026-10-12 13:30:00');
  assert.equal(monS2.isOpen, true);
  assert.equal(monS2.session, 'SESSION_2');
  assert.equal(monS2.broadcast_allowed, true);

  // 15:45: Sesi reguler aktif, broadcast S2 masih diizinkan
  const monS2BroadcastEnd = marketHoursGuard.getMarketSessionStatus('2026-10-12 15:45:00');
  assert.equal(monS2BroadcastEnd.isOpen, true, '15:45 Mon-Thu regular session must be open');
  assert.equal(monS2BroadcastEnd.session, 'SESSION_2');
  assert.equal(monS2BroadcastEnd.status, 'LIVE_MARKET');
  assert.equal(monS2BroadcastEnd.broadcast_allowed, true, '15:45 Mon-Thu broadcast must be allowed');

  // 15:46: Sesi reguler aktif, broadcast sudah diblokir
  const monS2PostBuffer = marketHoursGuard.getMarketSessionStatus('2026-10-12 15:46:00');
  assert.equal(monS2PostBuffer.isOpen, true, '15:46 Mon-Thu regular session must remain active');
  assert.equal(monS2PostBuffer.session, 'SESSION_2');
  assert.equal(monS2PostBuffer.status, 'LIVE_MARKET');
  assert.equal(monS2PostBuffer.broadcast_allowed, false, '15:46 Mon-Thu broadcast must be blocked');

  // 15:49:59: Sesi reguler masih aktif, broadcast tetap diblokir
  const monS2PreClose = marketHoursGuard.getMarketSessionStatus('2026-10-12 15:49:59');
  assert.equal(monS2PreClose.isOpen, true, '15:49:59 Mon-Thu regular session must remain active');
  assert.equal(monS2PreClose.session, 'SESSION_2');
  assert.equal(monS2PreClose.status, 'LIVE_MARKET');
  assert.equal(monS2PreClose.broadcast_allowed, false, '15:49:59 Mon-Thu broadcast must remain blocked');

  // 15:50:00+: Sesi reguler resmi selesai (CLOSED / after_close)
  const monAfterClose = marketHoursGuard.getMarketSessionStatus('2026-10-12 15:50:00');
  assert.equal(monAfterClose.isOpen, false);
  assert.equal(monAfterClose.session, 'CLOSED');
  assert.equal(monAfterClose.status, 'OUTSIDE_MARKET');
  assert.equal(monAfterClose.broadcast_allowed, false);
  assert.equal(monAfterClose.reason, 'after_close');

  // Jumat (2026-10-16):
  // 11:28: Broadcast buffer S1 Jumat
  const friBuffer = marketHoursGuard.getMarketSessionStatus('2026-10-16 11:29:00');
  assert.equal(friBuffer.session, 'SESSION_1');
  assert.equal(friBuffer.broadcast_allowed, false, '11:29 Friday broadcast must be blocked');

  // 11:30 - 14:00: Istirahat Sholat Jumat
  const friBreak = marketHoursGuard.getMarketSessionStatus('2026-10-16 12:30:00');
  assert.equal(friBreak.isOpen, false);
  assert.equal(friBreak.session, 'BREAK');
  assert.equal(friBreak.reason, 'friday_break');

  // 14:00: Sesi 2 Jumat buka
  const friS2 = marketHoursGuard.getMarketSessionStatus('2026-10-16 14:00:00');
  assert.equal(friS2.isOpen, true);
  assert.equal(friS2.session, 'SESSION_2');
  assert.equal(friS2.broadcast_allowed, true);

  // 15:45: Sesi 2 Jumat aktif, broadcast diizinkan
  const friS2BroadcastEnd = marketHoursGuard.getMarketSessionStatus('2026-10-16 15:45:00');
  assert.equal(friS2BroadcastEnd.isOpen, true, '15:45 Friday regular session must be open');
  assert.equal(friS2BroadcastEnd.session, 'SESSION_2');
  assert.equal(friS2BroadcastEnd.status, 'LIVE_MARKET');
  assert.equal(friS2BroadcastEnd.broadcast_allowed, true, '15:45 Friday broadcast must be allowed');

  // 15:46: Sesi 2 Jumat aktif, broadcast diblokir
  const friS2PostBuffer = marketHoursGuard.getMarketSessionStatus('2026-10-16 15:46:00');
  assert.equal(friS2PostBuffer.isOpen, true, '15:46 Friday regular session must remain active');
  assert.equal(friS2PostBuffer.session, 'SESSION_2');
  assert.equal(friS2PostBuffer.status, 'LIVE_MARKET');
  assert.equal(friS2PostBuffer.broadcast_allowed, false, '15:46 Friday broadcast must be blocked');

  // 15:49:59: Sesi 2 Jumat aktif, broadcast diblokir
  const friS2PreClose = marketHoursGuard.getMarketSessionStatus('2026-10-16 15:49:59');
  assert.equal(friS2PreClose.isOpen, true, '15:49:59 Friday regular session must remain active');
  assert.equal(friS2PreClose.session, 'SESSION_2');
  assert.equal(friS2PreClose.status, 'LIVE_MARKET');
  assert.equal(friS2PreClose.broadcast_allowed, false, '15:49:59 Friday broadcast must remain blocked');

  // 15:50:00: Sesi 2 Jumat selesai
  const friAfterClose = marketHoursGuard.getMarketSessionStatus('2026-10-16 15:50:00');
  assert.equal(friAfterClose.isOpen, false);
  assert.equal(friAfterClose.session, 'CLOSED');
  assert.equal(friAfterClose.status, 'OUTSIDE_MARKET');
  assert.equal(friAfterClose.broadcast_allowed, false);
  assert.equal(friAfterClose.reason, 'after_close');
});

test('BATCH 1 - B2: Weekend and Exchange Holiday handling (fail-closed)', () => {
  // Sabtu (2026-10-17)
  const sat = marketHoursGuard.getMarketSessionStatus('2026-10-17 10:00:00');
  assert.equal(sat.isOpen, false);
  assert.equal(sat.session, 'CLOSED');
  assert.equal(sat.reason, 'weekend');

  // Libur bursa 2026 (misal Tahun Baru 2026-01-01)
  const holiday = marketHoursGuard.getMarketSessionStatus('2026-01-01 10:00:00');
  assert.equal(holiday.isOpen, false);
  assert.equal(holiday.session, 'CLOSED');
  assert.equal(holiday.reason, 'holiday');
});

test('BATCH 1 - B3: volumePace regular tradingSchedule, sessionProgress, and holiday handling', () => {
  // Full day schedule remains intact for volume baseline math (330 and 270)
  const monSched = volumePace.tradingSchedule('2026-10-12');
  assert.equal(monSched.total, 330, 'Full day trading schedule must be 330 minutes');
  assert.equal(monSched.windows[1].end, 960, 'S2 window covers through closing auction');

  const friSched = volumePace.tradingSchedule('2026-10-16');
  assert.equal(friSched.total, 270, 'Friday full day schedule must be 270 minutes');

  // is_regular_session distinguishes regular active session vs pre-closing/auction
  const p1545 = volumePace.sessionProgress('2026-10-12', '15:45');
  assert.equal(p1545.is_regular_session, true, '15:45 must be regular session');

  const p1550 = volumePace.sessionProgress('2026-10-12', '15:50');
  assert.equal(p1550.is_regular_session, false, '15:50 must not be regular active session');

  const p1555 = volumePace.sessionProgress('2026-10-12', '15:55');
  assert.equal(p1555.is_regular_session, false, '15:55 must not be regular active session');

  // Exchange Holiday in volumePace must be NON_TRADING_DAY
  const pHoliday = volumePace.sessionProgress('2026-01-01', '10:00');
  assert.equal(pHoliday.market_state, 'NON_TRADING_DAY');
});

test('BATCH 1 - B4: FastWatcher runModeForTime terminates after 15:49:59 (returns null)', () => {
  // 15:40: within session 2 => AFTERNOON_EXIT
  assert.equal(fastWatcherLive.runModeForTime('15:40', '2026-10-12'), 'AFTERNOON_EXIT');

  // 15:45: within session 2 => AFTERNOON_EXIT
  assert.equal(fastWatcherLive.runModeForTime('15:45', '2026-10-12'), 'AFTERNOON_EXIT');

  // 15:50: after regular session close => null (must NOT run as active regular session)
  assert.equal(fastWatcherLive.runModeForTime('15:50', '2026-10-12'), null);

  // 15:55: after regular session close => null
  assert.equal(fastWatcherLive.runModeForTime('15:55', '2026-10-12'), null);

  // 16:00: after close => null
  assert.equal(fastWatcherLive.runModeForTime('16:00', '2026-10-12'), null);

  // Jumat break 12:30 => null
  assert.equal(fastWatcherLive.runModeForTime('12:30', '2026-10-16'), null);

  // Single-arg backwards compatibility for flat test runner
  assert.equal(fastWatcherLive.runModeForTime('16:00'), 'AFTERNOON_EXIT');
  assert.equal(fastWatcherLive.runModeForTime('16:01'), null);
});

test('BATCH 1 - B5: Day Trade Radar cutoff strictly enforced at 14:30 WIB', () => {
  // 14:30:00 WIB: allowed (last minute of entry window)
  const at1430 = marketHoursGuard.evaluateDayTradeRadarWindow('2026-10-12 14:30:00');
  assert.equal(at1430.allowed, true);

  // 14:31:00 WIB: rejected
  const at1431 = marketHoursGuard.evaluateDayTradeRadarWindow('2026-10-12 14:31:00');
  assert.equal(at1431.allowed, false);
  assert.equal(at1431.reason, 'after_1430_wib_cutoff');

  // 15:37:00 WIB: rejected
  const at1537 = marketHoursGuard.evaluateDayTradeRadarWindow('2026-10-12 15:37:00');
  assert.equal(at1537.allowed, false);
  assert.equal(at1537.reason, 'after_1430_wib_cutoff');
});

test('BATCH 1 - B6: FastWatcher publishConfirmed blocks broadcast when market is closed for broadcast', async () => {
  let telegramSent = false;
  const mockNotifyFn = async () => {
    telegramSent = true;
    return { sent: true };
  };

  const item = {
    ticker: 'BBCA',
    setup_id: 'test-setup-bbca',
    watch_score: 90,
    publish_score: 90,
    observation: {
      ticker: 'BBCA',
      current_price: 1000,
      entry_high: 1000,
      entry_low: 980,
      stop_loss: 900,
      tp1: 1200,
      risk_reward: 2.0,
      relative_volume: 2.5
    }
  };

  // Attempting publish at 15:50 (after broadcast cutoff 15:45 and session close)
  const res = await fastWatcherPublisher.publishConfirmed({
    publishable: [item],
    sampleDate: '2026-10-12',
    scheduledTime: '15:50',
    env: { FAST_WATCHER_LIVE_ENABLED: '1', FAST_WATCHER_PUBLISH_ENABLED: '1', FAST_WATCHER_TELEGRAM_ENABLED: '1' },
    notifyFn: mockNotifyFn,
    publishedDir: 'd:/auto-cuan-2/data/test-published-tmp'
  });

  assert.equal(telegramSent, false, 'Broadcast at 15:50 must be blocked');
  assert.equal(res.telegram_sent, 0);
  assert.equal(res.reason, 'market_closed_broadcast_blocked');
});
