'use strict';

// C3 (22 Oct 2026) — READ-ONLY audit of Telegram members whose subscription
// period has EXPIRED.
//
// Finding (verified): no code path removes expired members from the Telegram
// group/channel — a search for member-removal calls finds nothing in
// lib/telegram-lifecycle.js or lib/telegram-verification.js, and the lifecycle
// runner (tools/run-telegram-lifecycle.js) only sends verification reminders and
// 30-day review requests. The lifecycle job is also absent from the crontab.
//
// This module deliberately has NO removal capability: it only CLASSIFIES who
// WOULD be a removal candidate, so the owner can approve a list before any
// removal is ever built. It performs SELECTs only.

const { getEntitlements } = require('./entitlements');

// Classify a single member from already-fetched rows. Pure and testable.
//  - admin/budi        -> keep (never removed)
//  - blocked account   -> out of scope (blocked is not an expiry)
//  - active entitlement-> keep
//  - expired entitlement (no active one) -> REMOVAL CANDIDATE
//  - never subscribed  -> out of scope (a free member is not "expired")
function classifyMember(account, entitlementRows, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const username = String((account && account.username) || '').trim().toLowerCase();
  if (username === 'budi') return { status: 'admin', removal_candidate: false };
  if (account && account.is_blocked === true) return { status: 'blocked', removal_candidate: false };

  const rows = Array.isArray(entitlementRows) ? entitlementRows : [];
  const resolved = getEntitlements({}, account, rows, now);
  if (resolved && resolved.premium === true) return { status: 'active', removal_candidate: false };

  // Was there ever an entitlement that has now passed its end?
  const nowMs2 = now;
  const expired = rows.filter((r) => {
    if (r && r.lifetime === true) return false; // lifetime never expires
    if (!r || !r.expires_at) return false;
    const end = new Date(r.expires_at).getTime();
    return Number.isFinite(end) && end <= nowMs2;
  });
  if (expired.length > 0) {
    const latest = expired.slice().sort((a, b) => new Date(b.expires_at) - new Date(a.expires_at))[0];
    return {
      status: 'expired',
      removal_candidate: true,
      expires_at: latest.expires_at ? new Date(latest.expires_at).toISOString() : null,
      plan_code: latest.plan_code || null,
      source: latest.source || null
    };
  }

  if (rows.length === 0) return { status: 'never_subscribed', removal_candidate: false };
  return { status: 'no_active_entitlement', removal_candidate: false };
}

function bucketEntitlements(rows) {
  const byUser = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.user_id) continue;
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  return byUser;
}

async function selectAll(table, columns, supabase) {
  const { data, error } = await supabase.from(table).select(columns);
  if (error) {
    const e = new Error('select_failed');
    e.table = table;
    throw e;
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Build the expired-member audit. READ-ONLY.
 * @returns {{scanned:number, candidates:Array, counts:object, generated_at:string}}
 */
async function runExpiredMemberAudit(deps, opts) {
  const d = deps || {};
  const supabase = d.supabase;
  if (!supabase || typeof supabase.from !== 'function') {
    return { scanned: 0, candidates: [], counts: {}, error: 'no_supabase', generated_at: new Date().toISOString() };
  }
  const nowMs = opts && opts.now ? new Date(opts.now).getTime() : Date.now();

  const members = await selectAll('app_user_telegram_verifications', 'user_id, telegram_user_id, telegram_private_chat_id, telegram_verified_at', supabase);
  const users = await selectAll('app_users', 'id, username, is_blocked, is_approved', supabase);
  let entitlements = [];
  try { entitlements = await selectAll('user_entitlements', 'user_id, plan_code, source, status, starts_at, expires_at, lifetime', supabase); } catch (_) { entitlements = []; }

  const userById = new Map(users.map((u) => [u.id, u]));
  const entByUser = bucketEntitlements(entitlements);

  const counts = {};
  const candidates = [];
  for (const m of members) {
    const account = userById.get(m.user_id);
    if (!account) { counts.orphan = (counts.orphan || 0) + 1; continue; }
    const verdict = classifyMember(account, entByUser.get(m.user_id) || [], nowMs);
    counts[verdict.status] = (counts[verdict.status] || 0) + 1;
    if (verdict.removal_candidate) {
      candidates.push({
        user_id: m.user_id,
        username: account.username || null,
        telegram_user_id: m.telegram_user_id != null ? String(m.telegram_user_id) : null,
        expires_at: verdict.expires_at || null,
        plan_code: verdict.plan_code || null,
        source: verdict.source || null
      });
    }
  }

  return { scanned: members.length, candidates, counts, generated_at: new Date().toISOString() };
}

module.exports = { classifyMember, bucketEntitlements, runExpiredMemberAudit };
