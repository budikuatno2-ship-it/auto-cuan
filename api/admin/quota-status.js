'use strict';

const quotaManager = require('../../lib/quota-manager');

module.exports = async function handler(req, res) {
  const status = quotaManager.getQuotaStatus();
  // V6 (Subtask C): return REAL state only, with the canonical fail-closed
  // contract. `null` means UNKNOWN (never 0/18080); a legitimate zero is
  // preserved distinctly. `success` is derived from `status.ok`.
  const payload = {
    success: status.ok === true,
    ok: status.ok === true,
    status: status.ok === true ? 200 : 503,
    used: status.used,
    limit: status.limit,
    total: status.total,
    remaining: status.remaining,
    available_for_backfill: status.available_for_backfill,
    overage: status.overage,
    reserved: status.reserved,
    eligible_backfill: status.eligible_backfill,
    measuredZero: status.measuredZero === true,
    usageKnown: status.usageKnown === true,
    limitKnown: status.limitKnown === true,
    reset: status.reset_at ? '00:00 WIB' : '00:00 WIB',
    // dynamic policy knobs controlled via Admin Console
    concurrency: status.concurrency != null ? status.concurrency : 2,
    rateLimit: status.rateLimit != null ? status.rateLimit : 5,
    retryCount: status.retryCount != null ? status.retryCount : 3,
    backoffBaseMs: status.backoffBaseMs != null ? status.backoffBaseMs : 1000,
    priorityOrder: status.priorityOrder || ['broksum-ALL', 'broksum-Foreign', 'insider-tiered', 'candles', 'financial'],
    killSwitch: status.killSwitch === true,
    pausedServices: status.pausedServices || {},
    backfillBudget: status.backfillBudget != null ? status.backfillBudget : null,
    dailyReserveFloor: status.dailyReserveFloor != null ? status.dailyReserveFloor : status.reserved,
    backfillLocked: status.backfillLocked === true,
    lockReason: status.lockReason || null,
    policy: status.policy,
    // canonical fail-closed provider/effective fields
    provider_limit: status.provider_limit,
    provider_used: status.provider_used,
    provider_remaining: status.provider_remaining,
    configured_operating_cap: status.configured_operating_cap,
    effective_limit: status.effective_limit,
    usage_date: status.usage_date,
    reset_at: status.reset_at,
    package_expiry: status.package_expiry,
    source_checked_at: status.source_checked_at,
    verification_status: status.verification_status
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const code = payload.status;
  if (typeof res.status === 'function') {
    return res.status(code).json(payload);
  }
  res.writeHead(code);
  return res.end(JSON.stringify(payload));
};
