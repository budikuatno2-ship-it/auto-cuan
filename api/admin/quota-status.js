'use strict';

const quotaManager = require('../../lib/quota-manager');

module.exports = async function handler(req, res) {
  const status = quotaManager.getQuotaStatus();
  // P0-B: return REAL state only. No fabricated `used`, no hardcoded total,
  // no baked-in version string. `remaining`/`used` are null when the limit or
  // usage cannot be verified (fail-closed).
  const payload = {
    success: status.ok === true,
    status: status.ok === true ? 200 : 503,
    used: status.used,
    limit: status.limit,
    total: status.total,
    remaining: status.remaining,
    overage: status.overage,
    measuredZero: status.measuredZero === true,
    usageKnown: status.usageKnown === true,
    limitKnown: status.limitKnown === true,
    reset: status.reset,
    source: status.config && status.config.source ? status.config.source : undefined
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const code = payload.status;
  if (typeof res.status === 'function') {
    return res.status(code).json(payload);
  }
  res.writeHead(code);
  return res.end(JSON.stringify(payload));
};
