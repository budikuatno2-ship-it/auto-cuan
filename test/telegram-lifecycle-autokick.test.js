'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const lifecycle = require('../lib/telegram-lifecycle');
const verifyBot = require('../lib/telegram-verify-bot');

const NOW = Date.parse('2026-10-24T00:00:00Z');
const day = 86400000;
function iso(ms) { return new Date(ms).toISOString(); }

// Fake supabase that answers the expiry-audit SELECTs.
function fakeSupabase(members, users, entitlements) {
  const tables = {
    app_user_telegram_verifications: members,
    app_users: users,
    user_entitlements: entitlements
  };
  return {
    from(table) {
      return {
        select() { return Promise.resolve({ data: tables[table] || [], error: null }); }
      };
    }
  };
}

test('BUG-05/BUG-13: Telegram member lifecycle auto-kick', async (t) => {
  await t.test('1. kickChatMember bans then immediately unbans (no permanent blacklist)', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const method = String(url).split('/').pop();
      calls.push({ method, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    };
    process.env.TELEGRAM_VERIFY_BOT_TOKEN = 'test-token';
    try {
      const result = await verifyBot.kickChatMember('-100123', '555');
      assert.equal(result, true);
      assert.equal(calls.length, 2, 'must call ban then unban');
      assert.equal(calls[0].method, 'banChatMember');
      assert.equal(calls[0].body.chat_id, '-100123');
      assert.equal(calls[0].body.user_id, '555');
      assert.equal(calls[1].method, 'unbanChatMember');
      assert.equal(calls[1].body.only_if_banned, true);
    } finally {
      global.fetch = originalFetch;
      delete process.env.TELEGRAM_VERIFY_BOT_TOKEN;
    }
  });

  await t.test('2. runExpiredMemberKick dry-run reports candidates without removing anyone', async () => {
    const members = [
      { user_id: 'u1', telegram_user_id: '111', telegram_private_chat_id: '111' },
      { user_id: 'u2', telegram_user_id: '222', telegram_private_chat_id: '222' }
    ];
    const users = [
      { id: 'u1', username: 'alice', is_blocked: false },
      { id: 'u2', username: 'bob', is_blocked: false }
    ];
    const entitlements = [
      { user_id: 'u1', expires_at: iso(NOW - day), status: 'active', plan_code: 'pro' },
      { user_id: 'u2', expires_at: iso(NOW + day), status: 'active', plan_code: 'pro' }
    ];
    const supabase = fakeSupabase(members, users, entitlements);

    let kicked = 0;
    const bot = { kickChatMember: async () => { kicked += 1; return true; } };

    const summary = await lifecycle.runExpiredMemberKick(
      { supabase, bot },
      { dryRun: true, channelId: '-100123', now: NOW }
    );
    assert.equal(summary.candidates, 1, 'only u1 is expired');
    assert.equal(summary.kicked, 0, 'dry-run must not kick');
    assert.equal(kicked, 0);
  });

  await t.test('3. runExpiredMemberKick removes only expired members when executing', async () => {
    const members = [
      { user_id: 'u1', telegram_user_id: '111', telegram_private_chat_id: '111' },
      { user_id: 'u2', telegram_user_id: '222', telegram_private_chat_id: '222' },
      { user_id: 'u3', telegram_user_id: '333', telegram_private_chat_id: '333' }
    ];
    const users = [
      { id: 'u1', username: 'alice', is_blocked: false },
      { id: 'u2', username: 'bob', is_blocked: false },
      { id: 'u3', username: 'budi', is_blocked: false }
    ];
    const entitlements = [
      { user_id: 'u1', expires_at: iso(NOW - day), status: 'active', plan_code: 'pro' },
      { user_id: 'u2', expires_at: iso(NOW + day), status: 'active', plan_code: 'pro' },
      { user_id: 'u3', expires_at: iso(NOW - day), status: 'active', plan_code: 'pro' }
    ];
    const supabase = fakeSupabase(members, users, entitlements);

    const kickedIds = [];
    const bot = { kickChatMember: async (chatId, userId) => { kickedIds.push(userId); return true; } };

    const summary = await lifecycle.runExpiredMemberKick(
      { supabase, bot },
      { dryRun: false, channelId: '-100123', now: NOW }
    );
    assert.equal(summary.candidates, 1, 'only u1 is an expired non-admin candidate');
    assert.equal(summary.kicked, 1);
    assert.deepEqual(kickedIds, ['111'], 'only the expired member is kicked');
  });

  await t.test('4. runExpiredMemberKick fails soft without a channel id', async () => {
    const supabase = fakeSupabase(
      [{ user_id: 'u1', telegram_user_id: '111' }],
      [{ id: 'u1', username: 'alice', is_blocked: false }],
      [{ user_id: 'u1', expires_at: iso(NOW - day), status: 'active' }]
    );
    const bot = { kickChatMember: async () => true };
    const summary = await lifecycle.runExpiredMemberKick(
      { supabase, bot },
      { dryRun: false, channelId: null, now: NOW }
    );
    assert.equal(summary.kicked, 0);
    assert.equal(summary.error, 'missing_channel_id');
  });

  await t.test('5. the wrapper script exists and schedules a daily 02:15 WIB run', () => {
    const wrapper = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'vps', 'run-telegram-lifecycle.sh'), 'utf8');
    assert.match(wrapper, /run-telegram-lifecycle\.js/);
    assert.match(wrapper, /15 2 \* \* \*/);
    assert.match(wrapper, /flock/);
    assert.match(wrapper, /--kick-expired/);
  });
});
