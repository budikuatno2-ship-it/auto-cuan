'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const recap = require('../lib/telegram-daily-recap');

test('getTodayWibDateStr formats current date in WIB correctly', () => {
  const customDate = new Date('2026-08-27T09:15:00Z'); // 16:15 WIB
  const wibStr = recap.getTodayWibDateStr(customDate);
  assert.equal(wibStr, '2026-08-27');
});

test('formatWibHumanDate formats YYYY-MM-DD into human-readable Indonesian date', () => {
  const human = recap.formatWibHumanDate('2026-08-27');
  assert.equal(human, 'Kamis, 27 Agustus 2026');
});

test('formatDailyAfternoonRecapMessage returns polite fallback on empty/holiday picks', () => {
  const msg = recap.formatDailyAfternoonRecapMessage([], '2026-08-27');
  assert.match(msg, /REKAP SORE PERFORMA SINYAL AUTO-CUAN/);
  assert.match(msg, /Kamis, 27 Agustus 2026/);
  assert.match(msg, /Tidak ada sinyal rekomendasi aktif yang dirilis/);
  assert.match(msg, /Disclaimer:/);
});

test('formatDailyAfternoonRecapMessage renders summary, categories, and highlights correctly', () => {
  const fixturePicks = [
    {
      id: 101,
      ticker: 'BBCA',
      date: '2026-08-27',
      category: 'Day Trade',
      monitor_source: 'daytrade_signal',
      entry1: 10000,
      tp1: 10400,
      tp2: 10800,
      sl: 9800,
      status: 'TP2_HIT',
      first_sent_at: '2026-08-27T02:00:00Z',
      hit_entry_at: '2026-08-27T02:15:00Z',
      hit_tp1_at: '2026-08-27T02:45:00Z',
      hit_tp2_at: '2026-08-27T03:30:00Z'
    },
    {
      id: 102,
      ticker: 'BMRI',
      date: '2026-08-27',
      category: 'Swing Konglo',
      monitor_source: 'swing_konglo',
      entry1: 6500,
      tp1: 6850,
      tp2: 7200,
      sl: 6300,
      status: 'TP1_HIT',
      first_sent_at: '2026-08-27T01:30:00Z',
      hit_entry_at: '2026-08-27T02:00:00Z',
      hit_tp1_at: '2026-08-27T05:00:00Z'
    },
    {
      id: 103,
      ticker: 'BRIS',
      date: '2026-08-27',
      category: 'Day Trade',
      monitor_source: 'daytrade_signal',
      entry1: 3000,
      tp1: 3200,
      tp2: 3400,
      sl: 2900,
      status: 'SL_HIT',
      first_sent_at: '2026-08-27T02:00:00Z',
      hit_entry_at: '2026-08-27T02:30:00Z',
      hit_sl_at: '2026-08-27T03:00:00Z'
    },
    {
      id: 104,
      ticker: 'ASII',
      date: '2026-08-27',
      category: 'Top 5',
      monitor_source: 'top5',
      entry1: 5000,
      tp1: 5300,
      tp2: 5600,
      sl: 4850,
      status: 'RUNNING',
      first_sent_at: '2026-08-27T01:00:00Z',
      hit_entry_at: '2026-08-27T02:00:00Z'
    }
  ];

  const msg = recap.formatDailyAfternoonRecapMessage(fixturePicks, '2026-08-27');

  // Verify Header & Summary
  assert.match(msg, /Total Sinyal: 4 Saham/);
  assert.match(msg, /Win Rate \(TP1\/TP2\): 50\.0% \(2\/4\)/);
  assert.match(msg, /Target Maks \(TP2\): 25\.0% \(1\/4\)/);
  assert.match(msg, /Stop Loss Hit: 25\.0% \(1\/4\)/);
  assert.match(msg, /Masih Berjalan \/ Floating: 1 Saham/);

  // Verify Category breakdown
  assert.match(msg, /Day Trade: 2 Sinyal/);
  assert.match(msg, /Swing Konglo: 1 Sinyal/);
  assert.match(msg, /Top 5 Radar: 1 Sinyal/);

  // Verify Highlights
  assert.match(msg, /TARGET TERCAPAI/);
  assert.match(msg, /BBCA .* TP2 Hit \(\+8\.0%\)/);
  assert.match(msg, /BMRI .* TP1 Hit \(\+5\.4%\)/);
  assert.match(msg, /STOP LOSS HIT/);
  assert.match(msg, /BRIS .* SL Hit \(-3\.3%\)/);
  assert.match(msg, /MASIH DALAM PANTAUAN \/ FLOATING/);
  assert.match(msg, /ASII .* Running/);
});

test('generateDailyAfternoonRecap queries mock supabase and returns structured result', async () => {
  const mockRows = [
    {
      id: 201,
      ticker: 'TLKM',
      date: '2026-08-27',
      category: 'Swing Non-Konglo',
      monitor_source: 'swing_nk',
      entry1: 3000,
      tp1: 3200,
      tp2: 3400,
      sl: 2900,
      status: 'TP1_HIT',
      first_sent_at: '2026-08-27T02:00:00Z',
      hit_tp1_at: '2026-08-27T04:00:00Z'
    }
  ];

  const mockSupabase = {
    from(table) {
      assert.equal(table, 'telegram_daily_picks');
      return {
        select() {
          return {
            eq(col, val) {
              assert.equal(col, 'date');
              assert.equal(val, '2026-08-27');
              return {
                order() {
                  return Promise.resolve({ data: mockRows, error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const res = await recap.generateDailyAfternoonRecap(mockSupabase, '2026-08-27');
  assert.equal(res.date, '2026-08-27');
  assert.equal(res.total_signals, 1);
  assert.equal(res.summary.win_rate_tp1, '100.0%');
  assert.match(res.message, /TLKM/);
});

test('sendDailyAfternoonRecap respects dryRun option', async () => {
  const mockSupabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                order() {
                  return Promise.resolve({ data: [], error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  const res = await recap.sendDailyAfternoonRecap(mockSupabase, {
    date: '2026-08-27',
    dryRun: true
  });

  assert.equal(res.dry_run, true);
  assert.equal(res.sent, false);
  assert.match(res.message, /REKAP SORE PERFORMA SINYAL AUTO-CUAN/);
});

function requireSectorHotWithStub() {
  const origLoad = Module._load;
  const abs = require.resolve('../api/sector-hot');
  delete require.cache[abs];
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') {
      return {
        createClient: function () {
          return {};
        }
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../api/sector-hot');
  } finally {
    Module._load = origLoad;
  }
}

test('handleTelegramDailyRecap blocks unauthorized requests and executes with valid cron secret', async () => {
  const sectorHot = requireSectorHotWithStub();
  const handler = sectorHot.__test && sectorHot.__test.handleTelegramDailyRecap;
  assert.equal(typeof handler, 'function');

  // Test 1: Unauthorized (no cron secret)
  let statusCode = 0;
  let jsonResult = null;
  const mockReq1 = {
    query: { action: 'telegram-daily-recap' },
    headers: {}
  };
  const mockRes1 = {
    status(c) { statusCode = c; return this; },
    json(obj) { jsonResult = obj; return this; }
  };
  await handler(mockReq1, mockRes1, {});
  assert.equal(statusCode, 401);
  assert.equal(jsonResult.success, false);

  // Test 2: Authorized with CRON_SECRET
  process.env.CRON_SECRET = 'test-recap-cron-secret';
  const mockReq2 = {
    query: { action: 'telegram-daily-recap', dry_run: '1', date: '2026-08-27' },
    headers: { authorization: 'Bearer test-recap-cron-secret' }
  };
  const mockRes2 = {
    status(c) { statusCode = c; return this; },
    json(obj) { jsonResult = obj; return this; }
  };
  const mockSupabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                order() {
                  return Promise.resolve({ data: [], error: null });
                }
              };
            }
          };
        }
      };
    }
  };

  await handler(mockReq2, mockRes2, mockSupabase);
  assert.equal(statusCode, 200);
  assert.equal(jsonResult.success, true);
  assert.equal(jsonResult.result.dry_run, true);
  assert.equal(jsonResult.result.date, '2026-08-27');
});
