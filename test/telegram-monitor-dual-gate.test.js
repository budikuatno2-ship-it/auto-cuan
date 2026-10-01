'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const delivery = require('../lib/telegram-delivery');

test('isSilentMonitorSource correctly identifies silent daytrade sources', () => {
  assert.equal(delivery.isSilentMonitorSource({ monitor_source: 'daytrade' }), true);
  assert.equal(delivery.isSilentMonitorSource({ monitor_source: 'day_trade' }), true);
  assert.equal(delivery.isSilentMonitorSource({ category: 'Day Trade' }), true);
  assert.equal(delivery.isSilentMonitorSource({ raw_payload: { monitor_source: 'daytrade' } }), true);

  assert.equal(delivery.isSilentMonitorSource({ monitor_source: 'daytrade_signal' }), false);
  assert.equal(delivery.isSilentMonitorSource({ monitor_source: 'swing_konglo' }), false);
  assert.equal(delivery.isSilentMonitorSource({ monitor_source: 'swing_nk' }), false);
  assert.equal(delivery.isSilentMonitorSource({ monitor_source: 'daily_top5' }), false);
  assert.equal(delivery.isSilentMonitorSource(null), false);
});

test('monitorRowIsTrackable allows silent daytrade rows but blocks pending delivery rows', () => {
  const silentDaytradeRow = {
    id: 1,
    ticker: 'BBRI',
    monitor_source: 'daytrade',
    status: 'WAITING',
    first_sent_at: null
  };
  assert.equal(delivery.monitorRowIsTrackable(silentDaytradeRow), true);

  const deliveredPublicRow = {
    id: 2,
    ticker: 'ASII',
    monitor_source: 'swing_konglo',
    status: 'WAITING',
    first_sent_at: '2026-08-10T08:00:00.000Z'
  };
  assert.equal(delivery.monitorRowIsTrackable(deliveredPublicRow), true);

  const pendingRow = {
    id: 3,
    ticker: 'TLKM',
    monitor_source: 'daily_top5',
    status: 'DELIVERY_IN_PROGRESS',
    first_sent_at: null
  };
  assert.equal(delivery.monitorRowIsTrackable(pendingRow), false);

  const unsentLockRow = {
    id: 4,
    ticker: 'BMRI',
    monitor_source: 'daily_top5',
    status: 'WAITING',
    first_sent_at: null,
    raw_payload: {
      lock_source: 'telegram-daily-picks.lock_only'
    }
  };
  assert.equal(delivery.monitorRowIsTrackable(unsentLockRow), false);
});

test('monitorRowIsPublicNotificationEligible blocks silent daytrade rows from public alerts', () => {
  const silentDaytradeRow = {
    id: 1,
    ticker: 'BBRI',
    monitor_source: 'daytrade',
    status: 'WAITING',
    first_sent_at: null
  };
  assert.equal(delivery.monitorRowIsTrackable(silentDaytradeRow), true);
  assert.equal(delivery.monitorRowIsPublicNotificationEligible(silentDaytradeRow), false);

  const deliveredPublicRow = {
    id: 2,
    ticker: 'ASII',
    monitor_source: 'daytrade_signal',
    status: 'WAITING',
    first_sent_at: '2026-08-10T08:00:00.000Z'
  };
  assert.equal(delivery.monitorRowIsTrackable(deliveredPublicRow), true);
  assert.equal(delivery.monitorRowIsPublicNotificationEligible(deliveredPublicRow), true);

  const unsentLockRow = {
    id: 4,
    ticker: 'BMRI',
    monitor_source: 'daily_top5',
    status: 'WAITING',
    first_sent_at: null,
    raw_payload: {
      lock_source: 'telegram-daily-picks.lock_only'
    }
  };
  assert.equal(delivery.monitorRowIsTrackable(unsentLockRow), false);
  assert.equal(delivery.monitorRowIsPublicNotificationEligible(unsentLockRow), false);
});

test('handleWebTop5History and handleTelegramMonitorPicks use explicit dual gates', () => {
  const sectorHotSrc = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'sector-hot.js'), 'utf-8');

  assert.ok(
    sectorHotSrc.indexOf('telegramDelivery.monitorRowIsPublicNotificationEligible(r)') >= 0,
    'handleWebTop5History must call monitorRowIsPublicNotificationEligible'
  );

  assert.ok(
    sectorHotSrc.indexOf('telegramDelivery.monitorRowIsTrackable(r)') >= 0,
    'handleTelegramMonitorPicks must call monitorRowIsTrackable for activeRows filter'
  );

  assert.ok(
    sectorHotSrc.indexOf('var isPublicAlertEligible = telegramDelivery.monitorRowIsPublicNotificationEligible(pck);') >= 0,
    'handleTelegramMonitorPicks must gate public alerts with monitorRowIsPublicNotificationEligible'
  );

  assert.equal(delivery.monitorRowIsEligible, undefined);
});
