'use strict';

const assert = require('assert');
const telegramVerification = require('../lib/telegram-verification');
const telegramTransient = require('../lib/telegram-transient-message');
const telegramLifecycle = require('../lib/telegram-lifecycle');
const telegramDailyRecap = require('../lib/telegram-daily-recap');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name);
    console.error('    Error:', e.message);
    failed++;
  }
}

(async function () {
  console.log('Menjalankan pembuktian bug Telegram Fase 6 Batch 2 (BUG-F6-006 s.d BUG-F6-010)...\n');

  // TEST 1: BUG-F6-006 - Premature Rejection & Pesan Penolakan pada Akun already_joined
  await runTest('BUG-F6-006: handleChatJoinRequest tidak boleh decline & kirim penolakan ke akun already_joined', async () => {
    process.env.TELEGRAM_VERIFY_CHANNEL_ID = '-1001234567890';

    let declineCalled = false;
    let sentMessages = [];

    const mockBot = {
      declineChatJoinRequest: async () => { declineCalled = true; },
      approveChatJoinRequest: async () => {},
      sendMessage: async (chatId, text) => { sentMessages.push({ chatId, text }); },
      editMessageText: async () => {}
    };

    const mockSupabase = {
      from: (table) => {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (table === 'app_user_telegram_verifications') {
                  return {
                    data: {
                      user_id: 'user_joined_1',
                      telegram_verified_at: '2025-01-01T00:00:00Z',
                      telegram_private_chat_id: 112233,
                      channel_joined_at: '2025-01-01T12:00:00Z',
                      dynamic_invite_link: 'https://t.me/+join123',
                      invite_expires_at: '2099-01-01T00:00:00Z',
                      invite_revoked_at: null,
                      invite_message_id: 555
                    },
                    error: null
                  };
                }
                if (table === 'app_users') {
                  return {
                    data: { id: 'user_joined_1', username: 'trader1', is_approved: true, is_blocked: false },
                    error: null
                  };
                }
                return { data: null, error: null };
              }
            })
          })
        };
      },
      rpc: async () => ({ data: null, error: null })
    };

    const cjr = {
      chat: { id: -1001234567890 },
      from: { id: 112233 },
      invite_link: { invite_link: 'https://t.me/+join123' }
    };

    await telegramVerification.handleChatJoinRequest(cjr, { supabase: mockSupabase, bot: mockBot });

    assert.strictEqual(declineCalled, false, 'declineChatJoinRequest dipanggil untuk akun yang sah (already_joined)');
    const declineMsg = sentMessages.find(m => m.text.includes('Permintaan bergabung tidak dapat disetujui'));
    assert.strictEqual(Boolean(declineMsg), false, 'Pesan penolakan terkirim ke pengguna yang sudah berstatus joined');
  });

  // TEST 2: BUG-F6-007 - creates_join_request hilang & salah nama parameter kadaluwarsa pada createChatInviteLink
  await runTest('BUG-F6-007: ensureJoinRequestInvite harus menyertakan creates_join_request: true & expire_date unix epoch', async () => {
    process.env.TELEGRAM_VERIFY_CHANNEL_ID = '-1001234567890';

    let capturedOptions = null;
    const mockBot = {
      createChatInviteLink: async (chId, opts) => {
        capturedOptions = opts;
        return 'https://t.me/+newlink';
      },
      revokeChatInviteLink: async () => {}
    };

    const mockSupabase = {
      rpc: async () => ({ data: null, error: null })
    };

    const ctx = {
      userId: 'user_test_2',
      dynamicInviteLink: null
    };

    await telegramVerification.ensureJoinRequestInvite({ supabase: mockSupabase, bot: mockBot }, ctx);

    assert.ok(capturedOptions, 'createChatInviteLink tidak dipanggil oleh ensureJoinRequestInvite');
    assert.strictEqual(capturedOptions.creates_join_request, true, 'creates_join_request bernilai undefined');
    assert.strictEqual(typeof capturedOptions.expire_date, 'number', 'expire_date harus berupa unix timestamp integer');
  });

  // TEST 3: BUG-F6-008 - deletePrevious menghapus referensi DB saat deleteMessage gagal
  await runTest('BUG-F6-008: deletePrevious tidak boleh memanggil forget() saat deleteMessage gagal', async () => {
    let memoryStore = [{ chat_id: 888999, scope: 'general_user', message_id: 42 }];

    const mockDb = {
      from: (table) => {
        let filter = {};
        const chain = {
          select: () => chain,
          delete: () => chain,
          eq: (col, val) => {
            filter[col] = val;
            return chain;
          },
          maybeSingle: async () => {
            const row = memoryStore.find(r => r.chat_id === filter.chat_id && r.scope === filter.scope);
            return { data: row ? { message_id: row.message_id } : null, error: null };
          },
          then: (resolve) => {
            memoryStore = memoryStore.filter(r => !(r.chat_id === filter.chat_id && r.scope === filter.scope));
            resolve({ data: null, error: null });
          }
        };
        return chain;
      }
    };

    const mockSender = {
      deleteMessage: async () => {
        throw new Error('HTTP 429: Too Many Requests retry_after: 30');
      }
    };

    await telegramTransient.deletePrevious(mockDb, mockSender, 888999, 'general_user');

    assert.strictEqual(memoryStore.length, 1, 'record di DB terhapus saat deleteMessage throw error');
  });

  // TEST 4: BUG-F6-009 - Premature Claim Locking pada sendLegacyChannelAnnouncement Memblokir Retry
  await runTest('BUG-F6-009: sendLegacyChannelAnnouncement harus mengizinkan retry dan tidak mengunci duplicate saat send gagal', async () => {
    let claimed = false;
    const mockSupabase = {
      rpc: async (name) => {
        if (name === 'claim_legacy_channel_announcement') {
          if (claimed) {
            return { data: [{ claimed: false }], error: null };
          }
          claimed = true;
          return { data: [{ claimed: true, legacy_notice_sent_at: new Date().toISOString() }], error: null };
        }
        return { data: null, error: null };
      }
    };

    let attempt = 0;
    const mockBot = {
      sendMessage: async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error('Network timeout / chat write permission error');
        }
        return { message_id: 101 };
      }
    };

    const firstRun = await telegramLifecycle.sendLegacyChannelAnnouncement(
      { supabase: mockSupabase, bot: mockBot },
      { channelId: '-100999888' }
    );
    assert.strictEqual(firstRun.status, 'failed', 'Panggilan pertama harus berstatus failed');

    const retryRun = await telegramLifecycle.sendLegacyChannelAnnouncement(
      { supabase: mockSupabase, bot: mockBot },
      { channelId: '-100999888' }
    );
    assert.strictEqual(retryRun.status, 'sent', 'pemanggilan ulang menghasilkan \'duplicate\'');
  });

  // TEST 5: BUG-F6-010 - Inkonsistensi Filter Sinyal Terarsip pada Daily Recap
  await runTest('BUG-F6-010: generateDailyAfternoonRecap harus mengecualikan sinyal terarsip dari total_signals & summary', async () => {
    const picksData = [
      {
        id: 1,
        ticker: 'BBRI',
        category: 'daytrade',
        action: 'BUY',
        entry_price: 4500,
        tp1_price: 4600,
        tp2_price: 4700,
        sl_price: 4400,
        final_outcome: 'TP1_HIT',
        status: 'TP1_HIT',
        date: '2025-01-15'
      },
      {
        id: 2,
        ticker: 'TEST_ARCHIVED',
        category: 'daytrade',
        action: 'BUY',
        entry_price: 1000,
        tp1_price: 1050,
        status: 'TP1_HIT',
        date: '2025-01-15',
        archived_at: '2025-01-15T12:00:00Z'
      }
    ];

    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: async () => ({
              data: picksData,
              error: null
            })
          })
        })
      })
    };

    const recap = await telegramDailyRecap.generateDailyAfternoonRecap(mockSupabase, '2025-01-15');

    assert.strictEqual(recap.total_signals, 1, 'recap.total_signals bernilai 2 bukan 1');
    assert.strictEqual(recap.summary.total_signals, 1, 'summary.total_signals bernilai 2 bukan 1');
  });

  console.log(`\nSelesai: ${passed} lolos, ${failed} gagal.`);
  if (failed > 0) {
    process.exit(1);
  }
})();
