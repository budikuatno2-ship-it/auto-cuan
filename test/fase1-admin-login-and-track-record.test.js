'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adminDeviceApproval = require('../lib/admin-device-approval');
const sectorHot = require('../api/sector-hot');
const { evaluateMonitorStatus } = sectorHot.__test;

test('adminDeviceApproval: createDeviceApprovalRequest creates challenge with 2 minute expiry and telegram buttons', async () => {
  adminDeviceApproval.clearMemoryStoreForTesting();
  const mockSent = [];
  const mockBot = {
    sendMessage: async (chatId, text, opts) => {
      mockSent.push({ chatId, text, opts });
      return { message_id: 12345 };
    }
  };

  const req = await adminDeviceApproval.createDeviceApprovalRequest(
    { bot: mockBot },
    { userId: 'user-budi-id', username: 'budi', deviceId: 'dev_new_4', userAgent: 'Chrome' }
  );

  assert.ok(req.token);
  assert.equal(req.expiresInSeconds, 120);

  process.env.ADMIN_TELEGRAM_ID = '999888';
  try {
    const req2 = await adminDeviceApproval.createDeviceApprovalRequest(
      { bot: mockBot },
      { userId: 'user-budi-id', username: 'budi', deviceId: 'dev_new_4', userAgent: 'Chrome' }
    );
    assert.equal(mockSent.length, 1);
    assert.equal(mockSent[0].chatId, '999888');
    assert.ok(mockSent[0].opts.reply_markup.inline_keyboard[0].some(b => b.text.includes('Izinkan')));
    assert.ok(mockSent[0].opts.reply_markup.inline_keyboard[0].some(b => b.text.includes('Tolak')));

    const statusPending = adminDeviceApproval.checkDeviceApprovalStatus(req2.token);
    assert.equal(statusPending.status, 'pending');

    const denyRes = await adminDeviceApproval.handleDeviceApprovalCallback(
      {
        id: 'cb_1',
        data: 'dev_deny_' + req2.token,
        from: { id: 999888 },
        message: { message_id: 12345, chat: { id: 999888 } }
      },
      { bot: mockBot }
    );
    assert.equal(denyRes, 'device_approval_denied');

    const statusDenied = adminDeviceApproval.checkDeviceApprovalStatus(req2.token);
    assert.equal(statusDenied.status, 'denied');
  } finally {
    delete process.env.ADMIN_TELEGRAM_ID;
  }
});

test('adminDeviceApproval: approval kicks oldest device and issues session cookie', async () => {
  adminDeviceApproval.clearMemoryStoreForTesting();
  const mockUpdates = [];
  const mockSupabase = {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'user-budi-id', username: 'budi', devices: ['old_dev_1', 'old_dev_2', 'old_dev_3'] }
          })
        })
      }),
      update: (payload) => {
        mockUpdates.push({ table, payload });
        return { eq: async () => ({ error: null }) };
      }
    })
  };

  const mockBot = {
    answerCallbackQuery: async () => {},
    editMessageText: async () => {}
  };

  process.env.SESSION_SECRET = 'unit-test-secret-for-device-approval';
  try {
    const req = await adminDeviceApproval.createDeviceApprovalRequest(
      { supabase: mockSupabase, bot: mockBot },
      { userId: 'user-budi-id', username: 'budi', deviceId: 'new_dev_4', userAgent: 'Chrome' }
    );

    const approveRes = await adminDeviceApproval.handleDeviceApprovalCallback(
      {
        id: 'cb_2',
        data: 'dev_appr_' + req.token,
        from: { id: 999888 },
        message: { message_id: 12345, chat: { id: 999888 } }
      },
      { supabase: mockSupabase, bot: mockBot }
    );
    assert.equal(approveRes, 'device_approval_approved');

    const userUpdate = mockUpdates.find(u => u.table === 'app_users');
    assert.ok(userUpdate);
    assert.deepEqual(userUpdate.payload.devices, ['old_dev_2', 'old_dev_3', 'new_dev_4']);

    const mockRes = {
      headers: {},
      setHeader: (k, v) => { mockRes.headers[k] = v; }
    };
    const statusApproved = adminDeviceApproval.checkDeviceApprovalStatus(req.token, mockRes);
    assert.equal(statusApproved.status, 'approved');
    assert.equal(statusApproved.success, true);
    assert.equal(statusApproved.isAdmin, true);
    assert.match(mockRes.headers['Set-Cookie'], /ac_sess=/);
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

test('TP/SL Bug Fix: evaluateMonitorStatus does NOT overwrite TP1_HIT with SL_HIT when hit_tp1_at is already set', () => {
  const pick = {
    ticker: 'TEST',
    status: 'TP1_HIT',
    entry1: 1000,
    entry2: 980,
    tp1: 1050,
    tp2: 1100,
    sl: 950,
    hit_entry_at: '2026-08-20T02:00:00Z',
    hit_tp1_at: '2026-08-20T02:30:00Z',
    monitor_source: 'daytrade_signal'
  };

  const pxDropToSl = {
    last: 940,
    high: 1040,
    low: 940,
    at: '2026-08-20T04:00:00Z',
    bestEffort: false,
    source: 'intraday'
  };

  const ev = evaluateMonitorStatus(pick, pxDropToSl);
  assert.equal(ev.status, 'TP1_HIT');
  assert.equal(ev.isFinal, true);
  assert.match(ev.note, /TP1/i);

  const pxReachTp2 = {
    last: 1100,
    high: 1105,
    low: 1040,
    at: '2026-08-20T04:00:00Z',
    bestEffort: false,
    source: 'intraday'
  };

  const evTp2 = evaluateMonitorStatus(pick, pxReachTp2);
  assert.equal(evTp2.status, 'TP2_HIT');
  assert.equal(evTp2.isFinal, true);
});

test('TP/SL Bug Fix: evaluateMonitorStatus prioritizes TP2 over SL when active candle touches both', () => {
  const activePick = {
    ticker: 'TEST',
    status: 'RUNNING',
    entry1: 1000,
    entry2: 980,
    tp1: 1050,
    tp2: 1100,
    sl: 950,
    hit_entry_at: '2026-08-20T02:00:00Z',
    monitor_source: 'daytrade_signal'
  };

  const pxVolatile = {
    last: 1080,
    high: 1110,
    low: 940,
    at: '2026-08-20T04:00:00Z',
    bestEffort: false,
    source: 'intraday'
  };

  const ev = evaluateMonitorStatus(activePick, pxVolatile);
  assert.equal(ev.status, 'TP2_HIT');
});
