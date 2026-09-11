'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const insiderNetwork = require('../lib/insider-network-service');
const bandarmologi = require('../lib/bandarmologi-service');
const live = require('../lib/intraday-fast-watcher-live');
const publisher = require('../lib/intraday-fast-watcher-publisher');
const radarPublisher = require('../lib/intraday-fast-watcher-radar-publisher');
const earlyWatch = require('../lib/intraday-fast-watcher-early-watch');

test('FIX MUTASI INSIDER: only BUY or PURCHASE counts toward total_bought and net_shares_change', () => {
  const items = [
    {
      ticker: 'BBCA',
      name: 'Direktur A',
      action_type: 'BUY',
      shares_change: 100000,
      shares_after: 500000,
      date: '2026-09-01'
    },
    {
      ticker: 'BBCA',
      name: 'Direktur A',
      action_type: 'PURCHASE',
      shares_change: 50000,
      shares_after: 550000,
      date: '2026-09-02'
    },
    {
      ticker: 'BBCA',
      name: 'Direktur A',
      action_type: 'TRANSFER',
      shares_change: 200000,
      shares_after: 750000,
      date: '2026-09-03'
    },
    {
      ticker: 'BBCA',
      name: 'Direktur A',
      action_type: 'HIBAH',
      shares_change: 300000,
      shares_after: 1050000,
      date: '2026-09-04'
    },
    {
      ticker: 'BBCA',
      name: 'Direktur A',
      action_type: 'WARIS',
      shares_change: 100000,
      shares_after: 1150000,
      date: '2026-09-05'
    },
    {
      ticker: 'BBCA',
      name: 'Direktur A',
      action_type: 'BONUS',
      shares_change: 50000,
      shares_after: 1200000,
      date: '2026-09-06'
    },
    {
      ticker: 'BBCA',
      name: 'Direktur A',
      action_type: 'RIGHTS',
      shares_change: 80000,
      shares_after: 1280000,
      date: '2026-09-07'
    },
    {
      ticker: 'BBCA',
      name: 'Direktur A',
      action_type: 'SELL',
      shares_change: 30000,
      shares_after: 1250000,
      date: '2026-09-08'
    }
  ];

  const aggregated = insiderNetwork.aggregateInsiderHoldings(items);
  assert.equal(aggregated.length, 1);
  const holding = aggregated[0].holdings.find(h => h.ticker === 'BBCA');
  assert.ok(holding);

  // Only BUY (100,000) and PURCHASE (50,000) count into total_bought = 150,000
  assert.equal(holding.total_bought, 150000);
  // SELL (30,000)
  assert.equal(holding.total_sold, 30000);
  // Net shares change: 150,000 - 30,000 = 120,000 (TRANSFER, HIBAH, WARIS, BONUS, RIGHTS ignored)
  assert.equal(holding.net_shares_change, 120000);
});

test('FIX HISTORI TANGGAL INSIDER: prioritizes transaction_date over date', () => {
  const rawItems = [
    {
      date: '2026-09-10', // OJK reporting date
      transaction_date: '2026-09-08', // Real execution date
      name: 'Owner X',
      action: 'BUY',
      shares: 1000000,
      shares_after: 5000000
    },
    {
      date: '2026-09-10',
      tanggal_transaksi: '2026-09-07', // Alternative field name
      name: 'Owner Y',
      action: 'BUY',
      shares: 500000
    },
    {
      date: '2026-09-09', // Fallback to OJK date when transaction_date missing
      name: 'Owner Z',
      action: 'SELL',
      shares: 200000
    }
  ];

  const normalized = bandarmologi.normalizeInsiders(rawItems);
  assert.equal(normalized[0].date, '2026-09-08', 'should prioritize transaction_date');
  assert.equal(normalized[1].date, '2026-09-07', 'should prioritize tanggal_transaksi');
  assert.equal(normalized[2].date, '2026-09-09', 'should fallback to date');
});

test('FIX WATCHER SESI JUMAT: locks Friday market break window (11:30 - 14:00 WIB)', () => {
  const FRIDAY = '2026-09-11';
  const THURSDAY = '2026-09-10';

  // Friday trading hours:
  assert.equal(live.runModeForTime('10:00', FRIDAY), 'MORNING_SCOUT');
  assert.equal(live.runModeForTime('11:29', FRIDAY), 'MIDDAY_CHECK');
  assert.equal(live.runModeForTime('11:30', FRIDAY), null, '11:30 on Friday is market break');
  assert.equal(live.runModeForTime('12:00', FRIDAY), null, '12:00 on Friday is market break');
  assert.equal(live.runModeForTime('13:30', FRIDAY), null, '13:30 on Friday is market break');
  assert.equal(live.runModeForTime('13:59', FRIDAY), null, '13:59 on Friday is market break');
  assert.equal(live.runModeForTime('14:00', FRIDAY), 'AFTERNOON_EXIT', '14:00 on Friday is active afternoon session');
  assert.equal(live.runModeForTime('15:00', FRIDAY), 'AFTERNOON_EXIT');

  // Thursday comparison:
  assert.equal(live.runModeForTime('11:30', THURSDAY), 'MIDDAY_CHECK', 'Thursday 11:30 is still trading');
  assert.equal(live.runModeForTime('12:00', THURSDAY), null, 'Thursday 12:00 is lunch break');
  assert.equal(live.runModeForTime('13:31', THURSDAY), 'AFTERNOON_EXIT', 'Thursday 13:31 is active afternoon session');
});

test('DEDUPLICATION: publishConfirmed allows new Session 2 breakout alert even if published in Session 1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-pub-test-'));
  try {
    const mockStore = {
      from: () => ({
        upsert: () => ({
          select: () => Promise.resolve({ error: null, data: [{ ticker: 'BBCA' }] })
        })
      })
    };

    const sentMessages = [];
    const mockNotify = async (msg) => {
      sentMessages.push(msg);
      return { sent: true };
    };

    const env = {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      TELEGRAM_CHAT_ID: '123'
    };

    const item = {
      ticker: 'BBCA',
      setup_id: 'setup-bbca-1',
      publish_score: 85,
      observation: { current_price: 10000, entry_low: 9900, entry_high: 10000, tp1: 10500, stop_loss: 9700 }
    };

    // 1. Publish in Session 1 (09:30)
    const res1 = await publisher.publishConfirmed({
      publishable: [item],
      sampleDate: '2026-09-11',
      scheduledTime: '09:30',
      publishedDir: tmpDir,
      storeClient: mockStore,
      notifyFn: mockNotify,
      env
    });
    assert.equal(res1.system_published, 1);
    assert.equal(res1.telegram_sent, 1);
    assert.equal(sentMessages.length, 1);

    // 2. Immediate re-run in Session 1 (09:33) -> dedup blocks duplicate in same session
    const res2 = await publisher.publishConfirmed({
      publishable: [item],
      sampleDate: '2026-09-11',
      scheduledTime: '09:33',
      publishedDir: tmpDir,
      storeClient: mockStore,
      notifyFn: mockNotify,
      env
    });
    assert.equal(res2.system_published, 0);
    assert.equal(res2.telegram_sent, 0);
    assert.equal(sentMessages.length, 1);

    // 3. New breakout in Session 2 (14:15) -> session-aware dedup allows new alert
    const res3 = await publisher.publishConfirmed({
      publishable: [item],
      sampleDate: '2026-09-11',
      scheduledTime: '14:15',
      publishedDir: tmpDir,
      storeClient: mockStore,
      notifyFn: mockNotify,
      env
    });
    assert.equal(res3.system_published, 1, 'Session 2 breakout must be published');
    assert.equal(res3.telegram_sent, 1, 'Session 2 breakout alert must be sent to Telegram');
    assert.equal(sentMessages.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DEDUPLICATION: publishRadar allows sending in Session 2 even if candidate was on Radar in Session 1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-radar-test-'));
  try {
    const sentMessages = [];
    const mockNotify = async (msg) => {
      sentMessages.push(msg);
      return { sent: true };
    };

    const env = {
      FAST_WATCHER_LIVE_ENABLED: '1',
      FAST_WATCHER_PUBLISH_ENABLED: '1',
      FAST_WATCHER_TELEGRAM_ENABLED: '1',
      FAST_WATCHER_RADAR_TELEGRAM_ENABLED: '1',
      TELEGRAM_CHAT_ID: '123'
    };

    const candidate = {
      ticker: 'GOTO',
      status: 'RADAR AKTIF — PANTAU',
      internal_status: 'READY_PENDING',
      source_status: 'RADAR',
      current_price: 80,
      entry_low: 78,
      entry_high: 80,
      tp1: 86,
      stop_loss: 76,
      risk_reward: 3.0,
      relative_volume: 2.5,
      watch_score: 65,
      reasons: []
    };

    // 1. Publish Radar in Session 1 (10:10)
    const res1 = await radarPublisher.publishRadar({
      candidates: [candidate],
      sampleDate: '2026-09-11',
      scheduledTime: '10:10',
      radarDir: tmpDir,
      notifyFn: mockNotify,
      env
    });
    assert.equal(res1.telegram_sent, 1);
    assert.equal(sentMessages.length, 1);

    // 2. Immediate re-run in Session 1 (10:13) without +8 score increase -> blocked
    const res2 = await radarPublisher.publishRadar({
      candidates: [candidate],
      sampleDate: '2026-09-11',
      scheduledTime: '10:13',
      radarDir: tmpDir,
      notifyFn: mockNotify,
      env
    });
    assert.equal(res2.telegram_sent, 0);
    assert.equal(res2.reason, 'radar_unchanged');
    assert.equal(sentMessages.length, 1);

    // 3. Radar in Session 2 (14:30) -> session-aware dedup allows re-alerting for afternoon session
    const res3 = await radarPublisher.publishRadar({
      candidates: [candidate],
      sampleDate: '2026-09-11',
      scheduledTime: '14:30',
      radarDir: tmpDir,
      notifyFn: mockNotify,
      env
    });
    assert.equal(res3.telegram_sent, 1, 'Session 2 Radar alert must be sent');
    assert.equal(sentMessages.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('EARLY WATCH: flagTrue accepts "1", "true", "yes", "on" safely', () => {
  assert.equal(earlyWatch.isEnabled({ FAST_WATCHER_EARLY_WATCH_ENABLED: 'true' }), true);
  assert.equal(earlyWatch.isEnabled({ FAST_WATCHER_EARLY_WATCH_ENABLED: '1' }), true);
  assert.equal(earlyWatch.isEnabled({ FAST_WATCHER_EARLY_WATCH_ENABLED: 'yes' }), true);
  assert.equal(earlyWatch.isEnabled({ FAST_WATCHER_EARLY_WATCH_ENABLED: 'on' }), true);
  assert.equal(earlyWatch.isEnabled({ FAST_WATCHER_EARLY_WATCH_ENABLED: '0' }), false);
  assert.equal(earlyWatch.isEnabled({ FAST_WATCHER_EARLY_WATCH_ENABLED: 'false' }), false);
  assert.equal(earlyWatch.isEnabled({}), false);
});
