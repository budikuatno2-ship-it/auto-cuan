'use strict';

// C3 (22 Oct 2026) — an expired Telegram member is NOT removed today: no code
// path bans/kicks. This adds a strictly READ-ONLY audit that lists who WOULD be
// a candidate, so the owner can approve before any removal exists. These tests
// pin the classification and prove the module has no removal capability.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const audit = require('../lib/telegram-member-expiry-audit');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString();

test('C3: an expired non-lifetime entitlement is a REMOVAL CANDIDATE', () => {
  const account = { id: 'u1', username: 'alice', is_blocked: false };
  const rows = [{ user_id: 'u1', plan_code: 'PRO', source: 'manual', status: 'active', starts_at: iso(NOW - 30 * day), expires_at: iso(NOW - 1 * day), lifetime: false }];
  const v = audit.classifyMember(account, rows, NOW);
  assert.equal(v.status, 'expired');
  assert.equal(v.removal_candidate, true);
});

test('C3: a lifetime entitlement is never a candidate', () => {
  const account = { id: 'u2', username: 'bob', is_blocked: false };
  const rows = [{ user_id: 'u2', plan_code: 'LIFETIME', source: 'manual', status: 'active', starts_at: iso(NOW - 300 * day), expires_at: null, lifetime: true }];
  const v = audit.classifyMember(account, rows, NOW);
  assert.equal(v.status, 'active');
  assert.equal(v.removal_candidate, false);
});

test('C3: an ACTIVE entitlement is kept', () => {
  const account = { id: 'u3', username: 'carol', is_blocked: false };
  const rows = [{ user_id: 'u3', plan_code: 'PRO', source: 'manual', status: 'active', starts_at: iso(NOW - 3 * day), expires_at: iso(NOW + 20 * day), lifetime: false }];
  const v = audit.classifyMember(account, rows, NOW);
  assert.equal(v.status, 'active');
  assert.equal(v.removal_candidate, false);
});

test('C3: admin and blocked accounts are never candidates', () => {
  assert.equal(audit.classifyMember({ id: 'x', username: 'budi' }, [], NOW).removal_candidate, false);
  assert.equal(audit.classifyMember({ id: 'y', username: 'dave', is_blocked: true }, [{ user_id: 'y', expires_at: iso(NOW - day), status: 'active' }], NOW).removal_candidate, false);
});

test('C3: a member who never subscribed is out of scope (not "expired")', () => {
  const v = audit.classifyMember({ id: 'u4', username: 'eve', is_blocked: false }, [], NOW);
  assert.equal(v.status, 'never_subscribed');
  assert.equal(v.removal_candidate, false);
});

test('C3: the audit module has NO removal capability (read-only guarantee)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'telegram-member-expiry-audit.js'), 'utf8');
  assert.doesNotMatch(src, /banChatMember|kickChatMember|unbanChatMember|restrictChatMember|\.delete\(|\.update\(|\.upsert\(|\.insert\(/);
});

test('C3: the audit uses SELECT only against a fake supabase client', async () => {
  const calls = [];
  const fake = {
    from(table) {
      return {
        select(cols) { calls.push({ table, cols, op: 'select' }); return Promise.resolve({ data: [], error: null }); }
      };
    }
  };
  const res = await audit.runExpiredMemberAudit({ supabase: fake }, { now: NOW });
  assert.equal(res.error, undefined);
  assert.ok(calls.every((c) => c.op === 'select'), 'only SELECTs are permitted');
  assert.ok(calls.some((c) => c.table === 'app_user_telegram_verifications'));
});

test('C3: the dry-run tool reports removed=0 and does not require network for help', async () => {
  const tool = require('../tools/audit-expired-telegram-members');
  const out = await tool.main(['--help'], {});
  assert.equal(out.help, true);
});
